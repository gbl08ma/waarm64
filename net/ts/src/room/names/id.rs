//! A name's rules and its id (room-names.md "Names", "Names nobody lists"): what the room's ID
//! derives for names, a name's id (BLAKE2s keyed with a key of the room's), the label syntax and
//! the reserved list (enforced where names are still words: the resolver and the dialog), and an
//! owner key per name.

use blake2::{
    Blake2sMac256,
    digest::{KeyInit, Mac},
};
use k256::schnorr::SigningKey;

use crate::room::{Room, hash};

/// What a room's ID derives for names: every member derives the same.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoomNames {
    /// The room's 40 prefix bits (its /48 after `fd`), which every record starts with.
    pub room: [u8; 5],
    /// A value from the whole ID that every signed hash takes, so that a record of one room means
    /// nothing in another, even one whose prefix was made to collide.
    pub value: [u8; 32],
    /// The key of name ids.
    id_key: [u8; 32],
    /// The key zones are sealed under (with the full name and `seq`: zone.rs).
    pub(super) seal: [u8; 32],
}

/// BLAKE2s in its keyed mode over `parts`, each length-prefixed so none runs into the next.
pub(super) fn keyed(key: &[u8; 32], parts: &[&[u8]]) -> [u8; 32] {
    let mut m = <Blake2sMac256 as KeyInit>::new_from_slice(key).expect("a 32-byte key");
    for p in parts {
        m.update(&(p.len() as u32).to_le_bytes());
        m.update(p);
    }
    m.finalize().into_bytes().into()
}

impl RoomNames {
    pub fn derive(id: &str) -> RoomNames {
        let room = Room::derive(id).prefix[1..].try_into().unwrap();
        RoomNames {
            room,
            value: hash("waarm64 room names value v1", id),
            id_key: hash("waarm64 room names id key v1", id),
            seal: hash("waarm64 room names seal v1", id),
        }
    }

    /// A name's id: what stands for it in every record and message. `name` is the registered
    /// label (lower case), not a label under it.
    pub fn name_id(&self, name: &str) -> [u8; 32] {
        keyed(&self.id_key, &[name.as_bytes()])
    }
}

/// An owner key: one per name, from the owners' secret (made at the first registration and kept
/// beside the node key), so one owner's names can't be told to be one owner's.
pub fn owner_key(secret: &[u8; 32], names: &RoomNames, name: &str) -> SigningKey {
    for n in 0u32.. {
        let k = keyed(
            secret,
            &[
                b"waarm64 room names owner v1",
                &names.value,
                name.as_bytes(),
                &n.to_le_bytes(),
            ],
        );
        if let Ok(key) = SigningKey::from_bytes(&k) {
            return key;
        }
    }
    unreachable!()
}

/// `[a-z0-9]` and inner `-`, `max` characters at most, no `--` in the third and fourth places
/// (punycode's `xn--` and its kind).
fn label_ok(s: &str, max: usize) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= max
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
        && b[0] != b'-'
        && b[b.len() - 1] != b'-'
        && !(b.len() >= 4 && &b[2..4] == b"--")
}

/// The longest name: a key name is 52 characters, so the two never collide.
pub const MAX_NAME: usize = 32;

/// Names a guest asks for unprompted or trusts by habit, and labels that are top-level domains
/// or look like one (whoever held `com` would answer `example.com.<tag>.p2p.internal`, which a
/// guest's search list asks for). Every two-letter label is reserved too (the country codes, and
/// those still to come). Sorted: the test checks.
const RESERVED: &[&str] = &[
    "aero",
    "alt",
    "arpa",
    "asia",
    "biz",
    "broadcasthost",
    "cat",
    "com",
    "coop",
    "corp",
    "edu",
    "example",
    "gateway",
    "gov",
    "home",
    "info",
    "int",
    "internal",
    "intranet",
    "invalid",
    "ip6-allhosts",
    "ip6-allnodes",
    "ip6-allrouters",
    "ip6-localhost",
    "ip6-localnet",
    "ip6-loopback",
    "ip6-mcastprefix",
    "isatap",
    "jobs",
    "lan",
    "local",
    "localdomain",
    "localhost",
    "mil",
    "mobi",
    "museum",
    "name",
    "net",
    "onion",
    "org",
    "p2p",
    "post",
    "private",
    "pro",
    "router",
    "tel",
    "test",
    "travel",
    "wpad",
    "xxx",
];

pub fn reserved(name: &str) -> bool {
    name.len() == 2 || RESERVED.binary_search(&name).is_ok()
}

/// Whether `name` may be registered and resolved: one label of the rules, not reserved.
pub fn acceptable(name: &str) -> bool {
    label_ok(name, MAX_NAME) && !reserved(name)
}

/// A name asked for, relative to the room's domain (`test123`, or `git.test123` for a label under
/// it), as its label under the name, if any, and the name. None unless both pass the rules (a
/// label under a name is a DNS label: up to 63 characters).
pub fn split(full: &str) -> Option<(Option<&str>, &str)> {
    let (sub, name) = match full.split_once('.') {
        Some((s, n)) => (Some(s), n),
        None => (None, full),
    };
    (acceptable(name) && sub.is_none_or(|s| label_ok(s, 63))).then_some((sub, name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_rules() {
        for ok in [
            "test123",
            "a1",
            "abc",
            "x-y",
            "0abc",
            &"a".repeat(32),
            "ab-c",
        ] {
            assert!(acceptable(ok) || ok.len() == 2, "{ok}");
        }
        for bad in [
            "",
            "-ab",
            "ab-",
            "Abc",
            "a_b",
            "a.b",
            "xn--abc",
            "ab--c",
            "é",
            &"a".repeat(33),
            "a b",
        ] {
            assert!(!acceptable(bad), "{bad}");
        }
        // Inner `--` elsewhere is fine.
        assert!(acceptable("abc--d"));
        assert_eq!(split("git.test123"), Some((Some("git"), "test123")));
        assert_eq!(split("test123"), Some((None, "test123")));
        assert_eq!(split("a.b.test123"), None, "one label under a name");
        assert_eq!(split("git.wpad"), None);
        assert_eq!(split("-x.test123"), None);
    }

    #[test]
    fn the_reserved_list() {
        assert!(
            RESERVED.windows(2).all(|w| w[0] < w[1]),
            "sorted, no repeats"
        );
        for r in [
            "wpad",
            "isatap",
            "localhost",
            "gateway",
            "router",
            "broadcasthost",
            "com",
            "net",
        ] {
            assert!(!acceptable(r), "{r}");
        }
        for r in ["org", "local", "lan", "home", "internal", "de", "io", "uk"] {
            assert!(reserved(r), "{r}");
        }
        assert!(RESERVED.iter().all(|r| label_ok(r, MAX_NAME)));
        assert!(acceptable("comet") && acceptable("wpad2") && acceptable("abc"));
    }

    #[test]
    fn ids_and_owner_keys() {
        let a = RoomNames::derive("room a");
        let b = RoomNames::derive("room b");
        assert_ne!(
            a.name_id("test123"),
            b.name_id("test123"),
            "keyed by the room"
        );
        assert_ne!(a.name_id("test123"), a.name_id("test124"));
        assert_eq!(a.name_id("x"), RoomNames::derive("room a").name_id("x"));
        assert_eq!(a.room, Room::derive("room a").prefix[1..]);
        assert_ne!(a.value, b.value);
        let s = [7u8; 32];
        let k1 = owner_key(&s, &a, "test123").verifying_key().to_bytes();
        let k2 = owner_key(&s, &a, "test124").verifying_key().to_bytes();
        let k3 = owner_key(&s, &b, "test123").verifying_key().to_bytes();
        assert!(k1 != k2 && k1 != k3, "one key a name and a room");
        assert_eq!(k1, owner_key(&s, &a, "test123").verifying_key().to_bytes());
    }
}
