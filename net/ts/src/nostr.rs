//! What a room's member says to Nostr relays (NIP-01), sans I/O: events signed with BIP-340
//! Schnorr signatures on secp256k1 (`k256`), subscriptions by kind and `#x` tag, and the relay's
//! messages read back. A room uses ephemeral events only (kinds 20000–29999), which relays forward
//! to subscribers and keep nowhere (docs/networking/rooms.md "Finding a peer").

use k256::schnorr::SigningKey;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

fn hex(b: &[u8]) -> String {
    b.iter().map(|b| format!("{b:02x}")).collect()
}

/// A signing identity: random per session, never derived from the node key, so a relay can't
/// link a node's sessions by author.
pub struct Author {
    key: SigningKey,
    pubkey: String,
}

impl Author {
    pub fn random() -> Result<Author, String> {
        loop {
            let mut b = [0u8; 32];
            getrandom::fill(&mut b).map_err(|e| format!("no randomness: {e}"))?;
            if let Ok(key) = SigningKey::from_bytes(&b) {
                return Ok(Author::from_key(key));
            }
        }
    }

    fn from_key(key: SigningKey) -> Author {
        let pubkey = hex(&key.verifying_key().to_bytes());
        Author { key, pubkey }
    }

    pub fn pubkey(&self) -> &str {
        &self.pubkey
    }

    /// An event of `kind` with tag `["x", x]` and `content`, at `created_at` (Unix seconds):
    /// its JSON object, id and signature filled in.
    pub fn event(&self, kind: u32, x: &str, content: &str, created_at: u64) -> Value {
        let tags = json!([["x", x]]);
        let id: [u8; 32] = Sha256::digest(
            json!([0, self.pubkey, created_at, kind, tags, content])
                .to_string()
                .as_bytes(),
        )
        .into();
        let mut aux = [0u8; 32];
        let _ = getrandom::fill(&mut aux); // BIP-340's aux randomness is hardening only
        let sig = self
            .key
            .sign_prehash_with_aux_rand(&id, &aux)
            .expect("a valid key signs");
        json!({
            "id": hex(&id), "pubkey": self.pubkey, "created_at": created_at, "kind": kind,
            "tags": tags, "content": content, "sig": hex(&sig.to_bytes()),
        })
    }
}

/// `["EVENT", event]`: a client publishes.
pub fn publish(event: &Value) -> String {
    json!(["EVENT", event]).to_string()
}

/// `["REQ", sub, filter]`: events of `kind` tagged with one of `xs`, from now on (`limit` 0: a
/// relay sends nothing it stored, and ephemeral events it never stores).
pub fn subscribe(sub: &str, kind: u32, xs: &[String]) -> String {
    json!(["REQ", sub, { "kinds": [kind], "#x": xs, "limit": 0 }]).to_string()
}

pub fn unsubscribe(sub: &str) -> String {
    json!(["CLOSE", sub]).to_string()
}

/// What a relay says.
#[derive(Debug, PartialEq)]
pub enum FromRelay {
    /// An event of subscription `sub`: its kind, `x` tag and content.
    Event {
        sub: String,
        kind: u32,
        x: String,
        content: String,
    },
    /// `EOSE`: the relay answered subscription `sub`.
    Eose(String),
    /// `CLOSED`: the relay ended subscription `sub`, and why.
    Closed(String, String),
    /// `OK` false (a refused event), `NOTICE` and `AUTH`: the words, for the log.
    Said(String),
    /// `OK` true: the relay took an event we published.
    Accepted,
    /// What isn't understood.
    Other,
}

pub fn parse(text: &[u8]) -> FromRelay {
    let Ok(Value::Array(m)) = serde_json::from_slice::<Value>(text) else {
        return FromRelay::Other;
    };
    let s = |i: usize| m.get(i).and_then(Value::as_str).unwrap_or_default();
    match s(0) {
        "EVENT" => {
            let e = &m.get(2).cloned().unwrap_or_default();
            let x = e["tags"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|t| t[0] == "x")
                .and_then(|t| t[1].as_str());
            match (e["kind"].as_u64(), x, e["content"].as_str()) {
                (Some(kind), Some(x), Some(content)) => FromRelay::Event {
                    sub: s(1).into(),
                    kind: kind as u32,
                    x: x.into(),
                    content: content.into(),
                },
                _ => FromRelay::Other,
            }
        }
        "OK" if m.get(2) == Some(&Value::Bool(false)) => {
            FromRelay::Said(format!("refused an event: {}", s(3)))
        }
        "OK" if m.get(2) == Some(&Value::Bool(true)) => FromRelay::Accepted,
        "NOTICE" => FromRelay::Said(format!("notice: {}", s(1))),
        "EOSE" => FromRelay::Eose(s(1).into()),
        "CLOSED" => FromRelay::Closed(s(1).into(), s(2).into()),
        "AUTH" => FromRelay::Said("asks for authentication (NIP-42), which rooms don't do".into()),
        _ => FromRelay::Other,
    }
}

#[cfg(test)]
mod tests {
    use k256::schnorr::{Signature, VerifyingKey};

    use super::*;

    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len() / 2)
            .map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap())
            .collect()
    }

    #[test]
    fn bip340s_first_vector() {
        // BIP-340's test vector 0: secret key 3, aux randomness zero, message zero.
        let mut sk = [0u8; 32];
        sk[31] = 3;
        let key = SigningKey::from_bytes(&sk).unwrap();
        let sig = key.sign_prehash_with_aux_rand(&[0; 32], &[0; 32]).unwrap();
        assert_eq!(
            hex(&key.verifying_key().to_bytes()),
            "f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9"
        );
        assert_eq!(
            hex(&sig.to_bytes()).to_uppercase(),
            "E907831F80848D1069A5371B402410364BDF1C5F8307B0084C55F1CE2DCA8215\
             25F66A4A85EA8B71E482A74F382D2CE5EBEEE8FDB2172F477DF4900D310536C0"
        );
    }

    #[test]
    fn an_event_verifies_and_reads_back() {
        let a = Author::random().unwrap();
        let e = a.event(26354, "abc", "hello", 1_700_000_000);
        // The id is NIP-01's: SHA-256 of the serialized array.
        let ser = format!(
            r#"[0,"{}",1700000000,26354,[["x","abc"]],"hello"]"#,
            a.pubkey()
        );
        let id = Sha256::digest(ser.as_bytes());
        assert_eq!(e["id"], hex(&id));
        let vk = VerifyingKey::from_bytes(&unhex(a.pubkey())).unwrap();
        let sig = Signature::try_from(&unhex(e["sig"].as_str().unwrap())[..]).unwrap();
        vk.verify_raw(&id, &sig).unwrap();
        let relayed = json!(["EVENT", "s1", e]).to_string();
        assert_eq!(
            parse(relayed.as_bytes()),
            FromRelay::Event {
                sub: "s1".into(),
                kind: 26354,
                x: "abc".into(),
                content: "hello".into()
            }
        );
        assert_ne!(Author::random().unwrap().pubkey(), a.pubkey(), "random");
    }

    #[test]
    fn a_relays_other_words() {
        assert_eq!(parse(br#"["EOSE","s1"]"#), FromRelay::Eose("s1".into()));
        assert_eq!(
            parse(br#"["CLOSED","s1","rate-limited"]"#),
            FromRelay::Closed("s1".into(), "rate-limited".into())
        );
        assert_eq!(parse(br#"["OK","ab",true,""]"#), FromRelay::Accepted);
        assert!(matches!(
            parse(br#"["OK","ab",false,"rate-limited: slow down"]"#),
            FromRelay::Said(s) if s.contains("rate-limited")
        ));
        assert!(matches!(parse(br#"["NOTICE","hi"]"#), FromRelay::Said(_)));
        assert_eq!(parse(b"not json"), FromRelay::Other);
        assert_eq!(
            subscribe("s", 1, &["a".into()]),
            r##"["REQ","s",{"#x":["a"],"kinds":[1],"limit":0}]"##
        );
    }
}
