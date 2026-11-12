//! The kept node (docs/networking/tailnet.md "Tailscale"): the Go client's `ipn.StateStore` as the page
//! keeps it, read and written in Go's own format, so a node made by either client is the same
//! node in the other. Checked against tailscale.com v1.102.5 (`ipn/store.go`, `ipn/prefs.go`,
//! `ipn/ipnlocal/profiles.go`, `types/persist`, `types/key`) and against what that client wrote
//! (tests/ts-tailnet.test.ts):
//!
//! - `_machinekey`: text, `privkey:<hex>`.
//! - `_current-profile`: the current profile's state key, `profile-<4 hex>`.
//! - `_profiles`: JSON, profile ID → `ipn.LoginProfile` (ID, Name, NetworkProfile, Key, UserProfile,
//!   NodeID, LocalUserID, ControlURL, Created).
//! - `profile-<id>`: JSON `ipn.Prefs`, whose `Config` is `persist.Persist`: `PrivateNodeKey` and
//!   `OldPrivateNodeKey` (`privkey:<hex>`, zero when unused), `UserProfile`, `NetworkLockKey`
//!   (`nlpriv:<hex>` of an ed25519 private key, 64 bytes: seed then public key), `NodeID`.
//!
//! Entries this client doesn't use are left as they are; fields of the ones it rewrites that it
//! doesn't know are kept.

use std::collections::BTreeMap;

use serde_json::{Value, json};

const MACHINE: &str = "_machinekey";
const CURRENT: &str = "_current-profile";
const PROFILES: &str = "_profiles";

/// What a new profile's prefs hold besides `ControlURL`, `Hostname` and `Config`: Go's
/// `ipn.NewPrefs()` as v1.102.5 writes it (the Go client takes its prefs from its config at
/// every start anyway, keeping only `Config`).
const NEW_PREFS: &str = r#"{"RouteAll": false, "ExitNodeID": "", "ExitNodeIP": "", "InternalExitNodePrior": "",
 "ExitNodeAllowLANAccess": false, "CorpDNS": true, "RunSSH": false, "RunWebClient": false, "WantRunning": true,
 "LoggedOut": false, "ShieldsUp": false, "AdvertiseTags": null, "NotepadURLs": false, "AdvertiseRoutes": null,
 "AdvertiseServices": null, "Sync": null, "NoSNAT": false, "NoStatefulFiltering": true, "NetfilterMode": 2,
 "AutoUpdate": {"Check": true, "Apply": null}, "AppConnector": {"Advertise": false}, "PostureChecking": false,
 "NetfilterKind": "", "RemoteConfig": false, "DriveShares": null}"#;

fn hex(b: &[u8]) -> String {
    b.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex<const N: usize>(s: &str, prefix: &str) -> Option<[u8; N]> {
    let s = s.strip_prefix(prefix)?;
    if s.len() != 2 * N {
        return None;
    }
    let mut out = [0u8; N];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).ok()?;
    }
    Some(out)
}

fn random<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    getrandom::fill(&mut b).expect("randomness");
    b
}

/// A fresh network-lock key in Go's form: the ed25519 seed, then its public key.
fn new_nl_key() -> [u8; 64] {
    let seed: [u8; 32] = random();
    let public = ed25519_dalek::SigningKey::from_bytes(&seed).verifying_key();
    let mut k = [0u8; 64];
    k[..32].copy_from_slice(&seed);
    k[32..].copy_from_slice(public.as_bytes());
    k
}

/// What the node is, from the store.
#[derive(Debug, Clone, PartialEq)]
pub struct Kept {
    pub machine: [u8; 32],
    /// The node key, once the node is registered.
    pub node: Option<[u8; 32]>,
    pub old_node: Option<[u8; 32]>,
    pub nl: [u8; 64],
    /// The control server's stable ID of the node, once known.
    pub node_id: String,
}

impl Kept {
    /// The network-lock public key (an ed25519 key's public half).
    pub fn nl_public(&self) -> [u8; 32] {
        self.nl[32..].try_into().unwrap()
    }
}

/// What a login tells the store about the node.
pub struct Login<'a> {
    pub control_url: &'a str,
    pub hostname: &'a str,
    pub node_id: &'a str,
    /// The node's user: ID, login name, display name.
    pub user: (i64, &'a str, &'a str),
    /// The tailnet's MagicDNS suffix and the netmap's domain.
    pub magic_dns: &'a str,
    pub domain: &'a str,
    /// Now, RFC 3339 (a new profile's `Created`).
    pub now: String,
}

pub struct Store {
    entries: BTreeMap<String, Vec<u8>>,
    /// Writes for the host to carry out, in order.
    writes: Vec<(String, Vec<u8>)>,
}

impl Store {
    /// The store's entries (`<StateKey>` → the bytes Go wrote).
    pub fn new(entries: BTreeMap<String, Vec<u8>>) -> Self {
        Store {
            entries,
            writes: Vec::new(),
        }
    }

    fn get_str(&self, k: &str) -> Option<&str> {
        std::str::from_utf8(self.entries.get(k)?).ok()
    }

    fn get_json(&self, k: &str) -> Option<Value> {
        serde_json::from_slice(self.entries.get(k)?).ok()
    }

    /// Writes `v` at `k` unless it's there already (as JSON, in any form: Go indents its prefs).
    fn put(&mut self, k: &str, v: Vec<u8>) {
        let same = self.entries.get(k).is_some_and(|old| {
            *old == v
                || serde_json::from_slice::<Value>(old)
                    .ok()
                    .zip(serde_json::from_slice::<Value>(&v).ok())
                    .is_some_and(|(a, b)| a == b)
        });
        if !same {
            self.entries.insert(k.to_string(), v.clone());
            self.writes.push((k.to_string(), v));
        }
    }

    pub fn take_writes(&mut self) -> Vec<(String, Vec<u8>)> {
        std::mem::take(&mut self.writes)
    }

    /// The current profile's state key and prefs, if there is one.
    fn current(&self) -> Option<(String, Value)> {
        let key = self.get_str(CURRENT)?.to_string();
        let prefs = self.get_json(&key)?;
        Some((key, prefs))
    }

    /// The node as kept: the machine key (made and written now if there's none) and, if a
    /// profile is current, its node key and network-lock key.
    pub fn load(&mut self) -> Kept {
        let machine = match self
            .get_str(MACHINE)
            .and_then(|s| unhex::<32>(s.trim(), "privkey:"))
        {
            Some(k) if k != [0; 32] => k,
            _ => {
                let k = random();
                self.put(MACHINE, format!("privkey:{}", hex(&k)).into_bytes());
                k
            }
        };
        let persist = self
            .current()
            .map(|(_, p)| p["Config"].clone())
            .unwrap_or(Value::Null);
        let key = |name: &str, prefix: &str| {
            persist[name]
                .as_str()
                .and_then(|s| unhex::<32>(s, prefix))
                .filter(|k| *k != [0; 32])
        };
        Kept {
            machine,
            node: key("PrivateNodeKey", "privkey:"),
            old_node: key("OldPrivateNodeKey", "privkey:"),
            nl: persist["NetworkLockKey"]
                .as_str()
                .and_then(|s| unhex::<64>(s, "nlpriv:"))
                .filter(|k| *k != [0; 64])
                .unwrap_or_else(new_nl_key),
            node_id: persist["NodeID"].as_str().unwrap_or_default().to_string(),
        }
    }

    /// Records a login: the node's keys and identity in the current profile's prefs (a new
    /// profile, current, when there's none), as Go's profile manager writes them.
    pub fn save(&mut self, kept: &Kept, l: &Login) {
        let node = kept.node.expect("a registered node has a key");
        let user = json!({ "ID": l.user.0, "LoginName": l.user.1, "DisplayName": l.user.2 });
        let mut profiles = self
            .get_json(PROFILES)
            .filter(Value::is_object)
            .unwrap_or(json!({}));
        let (key, mut prefs) = match self.current() {
            Some(c) => c,
            None => {
                let id = loop {
                    let id = hex(&random::<2>());
                    if profiles.get(&id).is_none() {
                        break id;
                    }
                };
                let mut prefs: Value = serde_json::from_str(NEW_PREFS).unwrap();
                prefs["ControlURL"] = json!(l.control_url);
                prefs["Hostname"] = json!(l.hostname);
                profiles[&id] = json!({
                    "ID": id, "Name": l.user.1,
                    "NetworkProfile": { "MagicDNSName": l.magic_dns, "DomainName": l.domain, "DisplayName": "" },
                    "Key": format!("profile-{id}"), "UserProfile": user, "NodeID": l.node_id,
                    "LocalUserID": "", "ControlURL": l.control_url, "Created": l.now,
                });
                (format!("profile-{id}"), prefs)
            }
        };
        let zero = format!("privkey:{}", hex(&[0; 32]));
        let config = &mut prefs["Config"];
        if !config.is_object() {
            *config = json!({});
        }
        config["PrivateNodeKey"] = json!(format!("privkey:{}", hex(&node)));
        config["OldPrivateNodeKey"] = json!(
            kept.old_node
                .map_or(zero, |k| format!("privkey:{}", hex(&k)))
        );
        config["UserProfile"] = user.clone();
        config["NetworkLockKey"] = json!(format!("nlpriv:{}", hex(&kept.nl)));
        config["NodeID"] = json!(l.node_id);
        // The profile follows the node, as Go's `SetPrefs` keeps it.
        if let Some(p) = profiles
            .as_object_mut()
            .and_then(|m| m.values_mut().find(|p| p["Key"] == json!(key)))
        {
            p["NodeID"] = json!(l.node_id);
            p["UserProfile"] = user;
            p["Name"] = json!(l.user.1);
        }
        let p = serde_json::to_vec_pretty(&prefs).unwrap();
        self.put(&key, p);
        self.put(PROFILES, serde_json::to_vec(&profiles).unwrap());
        self.put(CURRENT, key.into_bytes());
    }

    /// Forgets the node (after a logout): the current profile's keys, as Go's logout clears its
    /// `Persist`. The machine key stays.
    pub fn forget(&mut self) {
        if let Some((key, mut prefs)) = self.current() {
            prefs["Config"] = Value::Null;
            prefs["LoggedOut"] = json!(true);
            self.put(&key, serde_json::to_vec_pretty(&prefs).unwrap());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What the Go client (v1.102.5, in Node) wrote after logging in, trimmed of nothing it reads.
    fn go_store() -> BTreeMap<String, Vec<u8>> {
        let prefs = r#"{"ControlURL": "https://127.0.0.1:8443", "CorpDNS": true, "WantRunning": true,
          "Hostname": "gonode", "NetfilterMode": 2, "AutoUpdate": {"Check": true, "Apply": null},
          "Config": {
            "PrivateNodeKey": "privkey:b89d4dcea11ba185411451e27356929ff205c508b25281589103650569110b41",
            "OldPrivateNodeKey": "privkey:0000000000000000000000000000000000000000000000000000000000000000",
            "UserProfile": {"ID": 1, "LoginName": "tailnet", "DisplayName": "tailnet"},
            "NetworkLockKey": "nlpriv:ab4145710dd174c327f04d3d78660b427cacf1c9a2627a6eb126c6b99f3925c6a59b0c6d9f56d89e42159d7479da1492c5a7e6a7e2319802809457fa657ac71c",
            "NodeID": "3"}}"#;
        let profiles = r#"{"3787":{"ID":"3787","Name":"tailnet","NetworkProfile":{"MagicDNSName":"tail.test","DomainName":"127.0.0.1","DisplayName":""},"Key":"profile-3787","UserProfile":{"ID":1,"LoginName":"tailnet","DisplayName":"tailnet"},"NodeID":"3","LocalUserID":"","ControlURL":"https://127.0.0.1:8443","Created":"2026-10-16T21:33:54.584Z"}}"#;
        [
            (
                MACHINE,
                "privkey:f805b1efccea3eae7915b9abb3f9d53ba77e019848c2fa6504ed3340b69c9752",
            ),
            (CURRENT, "profile-3787"),
            (PROFILES, profiles),
            ("profile-3787", prefs),
            ("_daemon", "untouched"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.as_bytes().to_vec()))
        .collect()
    }

    fn login(node_id: &str) -> Login<'_> {
        Login {
            control_url: "https://127.0.0.1:8443",
            hostname: "guest",
            node_id,
            user: (1, "tailnet", "tailnet"),
            magic_dns: "tail.test",
            domain: "127.0.0.1",
            now: "2026-10-16T22:00:00Z".into(),
        }
    }

    #[test]
    fn reads_the_go_clients_store_and_writes_nothing_when_nothing_changed() {
        let mut s = Store::new(go_store());
        let k = s.load();
        assert_eq!(k.machine[..2], [0xf8, 0x05]);
        assert_eq!(k.node.unwrap()[..2], [0xb8, 0x9d]);
        assert_eq!((k.old_node, k.node_id.as_str()), (None, "3"));
        assert_eq!(k.nl[..2], [0xab, 0x41]);
        assert!(s.take_writes().is_empty(), "nothing to write on load");
        s.save(&k, &login("3"));
        let w: Vec<String> = s.take_writes().into_iter().map(|(k, _)| k).collect();
        assert!(w.is_empty(), "the same node: nothing changes ({w:?})");
        // A new node key (a re-registration) is written in Go's form; the rest stands.
        let mut k2 = k.clone();
        k2.node = Some([1; 32]);
        s.save(&k2, &login("3"));
        let w = s.take_writes();
        assert_eq!(w.len(), 1);
        let prefs: Value = serde_json::from_slice(&w[0].1).unwrap();
        let mut go: Value = serde_json::from_slice(&go_store()["profile-3787"]).unwrap();
        go["Config"]["PrivateNodeKey"] = json!(format!("privkey:{}", hex(&[1; 32])));
        assert_eq!(prefs, go);
    }

    #[test]
    fn a_fresh_store_gets_what_go_would_write() {
        let mut s = Store::new(BTreeMap::new());
        let mut k = s.load();
        assert_eq!(k.node, None);
        let w = s.take_writes();
        assert_eq!(w.len(), 1);
        assert_eq!(w[0].0, MACHINE);
        assert!(
            std::str::from_utf8(&w[0].1)
                .unwrap()
                .starts_with("privkey:")
        );
        // The ed25519 key's halves agree.
        let seed: [u8; 32] = k.nl[..32].try_into().unwrap();
        let public = ed25519_dalek::SigningKey::from_bytes(&seed).verifying_key();
        assert_eq!(&k.nl_public(), public.as_bytes());
        k.node = Some([5; 32]);
        s.save(&k, &login("7"));
        k.node_id = "7".into();
        let w: BTreeMap<String, Vec<u8>> = s.take_writes().into_iter().collect();
        let current = std::str::from_utf8(&w[CURRENT]).unwrap();
        assert!(current.starts_with("profile-") && current.len() == 12);
        let prefs: Value = serde_json::from_slice(&w[current]).unwrap();
        assert_eq!(
            prefs["Config"]["PrivateNodeKey"],
            json!(format!("privkey:{}", hex(&[5; 32])))
        );
        assert_eq!(prefs["Config"]["NodeID"], json!("7"));
        assert_eq!(prefs["CorpDNS"], json!(true));
        assert_eq!(prefs["Hostname"], json!("guest"));
        let profiles: Value = serde_json::from_slice(&w[PROFILES]).unwrap();
        let p = profiles.as_object().unwrap().values().next().unwrap();
        assert_eq!(p["Key"], json!(current));
        assert_eq!(p["NodeID"], json!("7"));
        // Read back, it is the same node.
        let mut again = Store::new(s.entries.clone());
        assert_eq!(again.load(), k);
        assert!(again.take_writes().is_empty());
    }

    #[test]
    fn forgetting_keeps_the_machine_key() {
        let mut s = Store::new(go_store());
        let machine = s.load().machine;
        s.forget();
        let k = s.load();
        assert_eq!((k.machine, k.node), (machine, None));
        assert_eq!(s.entries["_daemon"], b"untouched");
    }
}
