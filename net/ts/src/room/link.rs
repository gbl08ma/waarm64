//! A room's link (docs/plans/networking-p2p.md §1): the room's ID and where its members meet, its
//! Nostr relays and its DERP regions. Members with the same link find each other; a lookup's home
//! region is an index into the link's list, so every member reads it the same way.
//!
//! `webpc-room:<id>?nostr=<wss URL>&…&derp=<region>&…`, each part percent-encoded: a `derp` is a
//! region ID of the DERP map (0: the map's first region) or a derper inline (`host[:port]`).
//! Anything without the scheme is a bare ID, which gets the defaults.

use crate::tailcat::{self, DerpNode};

pub const SCHEME: &str = "webpc-room:";
/// The default Nostr relays: those that carried every case of R4's measurements (bench/net/REPORT.md
/// "Rooms on public servers"; the user's choice, 2026-11-11).
pub const DEFAULT_NOSTR: [&str; 6] = [
    "wss://relay.primal.net",
    "wss://relay.novospes.com",
    "wss://relay.routstr.com",
    "wss://nostr.rblb.it",
    "wss://relay.degmods.com",
    "wss://relay.nostrmap.net",
];
pub const MAX_RELAYS: usize = 8;
const MAX_ID: usize = 256;

#[derive(Debug, Clone, PartialEq)]
pub enum Region {
    /// A region of the DERP map by ID (0: its first).
    Map(i64),
    /// A derper of the room's own.
    Inline(DerpNode),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Link {
    pub id: String,
    pub nostr: Vec<String>,
    pub derp: Vec<Region>,
    /// `nostr` and `derp` are the defaults, not the link's: [`Link::encode`] leaves them out, so
    /// a link handed out follows the defaults as they change.
    pub default_nostr: bool,
    pub default_derp: bool,
}

fn decode(s: &str) -> Result<String, String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let h = s
                .get(i + 1..i + 3)
                .and_then(|h| u8::from_str_radix(h, 16).ok())
                .ok_or_else(|| format!("a bad escape in {s}"))?;
            out.push(h);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| format!("not UTF-8: {s}"))
}

fn encode(s: &str) -> String {
    s.bytes()
        .map(|c| match c {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                (c as char).to_string()
            }
            c => format!("%{c:02X}"),
        })
        .collect()
}

fn region_text(r: &Region) -> String {
    match r {
        Region::Map(id) => id.to_string(),
        Region::Inline(n) => match n.derp_port {
            0 | 443 if n.host_name.contains(':') => format!("[{}]", n.host_name),
            0 | 443 => n.host_name.clone(),
            p if n.host_name.contains(':') => format!("[{}]:{p}", n.host_name),
            p => format!("{}:{p}", n.host_name),
        },
    }
}

impl Link {
    pub fn parse(s: &str) -> Result<Link, String> {
        let s = s.trim();
        let Some(rest) = s.strip_prefix(SCHEME) else {
            return Link::bare(s);
        };
        let (id, query) = rest.split_once('?').unwrap_or((rest, ""));
        let mut l = Link {
            id: decode(id)?,
            nostr: Vec::new(),
            derp: Vec::new(),
            default_nostr: false,
            default_derp: false,
        };
        for part in query.split('&').filter(|p| !p.is_empty()) {
            let (k, v) = part.split_once('=').unwrap_or((part, ""));
            let v = decode(v)?;
            match k {
                "nostr" => {
                    if !(v.starts_with("wss://") || v.starts_with("ws://")) {
                        return Err(format!("a Nostr relay is a ws:// or wss:// URL: {v}"));
                    }
                    l.nostr.push(v);
                }
                "derp" => l.derp.push(match v.parse::<i64>() {
                    Ok(id) if id >= 0 => Region::Map(id),
                    Ok(_) => return Err(format!("not a region: {v}")),
                    Err(_) => Region::Inline(tailcat::parse_relay(&v)?),
                }),
                _ => {} // a later version's: ignored
            }
        }
        if l.nostr.is_empty() {
            l.nostr = DEFAULT_NOSTR.map(String::from).to_vec();
            l.default_nostr = true;
        }
        if l.derp.is_empty() {
            l.derp = vec![Region::Map(0)];
            l.default_derp = true;
        }
        l.check()
    }

    /// A bare ID: the default relays and the DERP map's first region.
    pub fn bare(id: &str) -> Result<Link, String> {
        Link {
            id: id.trim().into(),
            nostr: DEFAULT_NOSTR.map(String::from).to_vec(),
            derp: vec![Region::Map(0)],
            default_nostr: true,
            default_derp: true,
        }
        .check()
    }

    fn check(self) -> Result<Link, String> {
        if self.id.trim().is_empty() {
            return Err("a room needs an ID".into());
        }
        if self.id.len() > MAX_ID {
            return Err(format!("a room's ID is at most {MAX_ID} bytes"));
        }
        if self.nostr.len() > MAX_RELAYS || self.derp.len() > MAX_RELAYS {
            return Err(format!(
                "a room's link names at most {MAX_RELAYS} Nostr relays and {MAX_RELAYS} DERP regions"
            ));
        }
        Ok(self)
    }

    /// The link's text, which [`Link::parse`] reads back.
    pub fn encode(&self) -> String {
        let mut s = format!("{SCHEME}{}", encode(&self.id));
        let nostr: &[String] = if self.default_nostr { &[] } else { &self.nostr };
        let derp: &[Region] = if self.default_derp { &[] } else { &self.derp };
        let parts = nostr.iter().map(|n| format!("nostr={}", encode(n))).chain(
            derp.iter()
                .map(|r| format!("derp={}", encode(&region_text(r)))),
        );
        for (i, p) in parts.enumerate() {
            s.push(if i == 0 { '?' } else { '&' });
            s.push_str(&p);
        }
        s
    }

    /// Whether a region must come from the DERP map.
    pub fn needs_map(&self) -> bool {
        self.derp.iter().any(|r| matches!(r, Region::Map(_)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_link_reads_back() {
        let l = Link::parse(
            "webpc-room:gabriel%20lan?nostr=wss%3A%2F%2Frelay.example&derp=900&derp=derp.example%3A8443&x=later",
        )
        .unwrap();
        assert_eq!(l.id, "gabriel lan");
        assert_eq!(l.nostr, ["wss://relay.example"]);
        assert_eq!(l.derp[0], Region::Map(900));
        assert!(
            matches!(&l.derp[1], Region::Inline(n) if n.host_name == "derp.example" && n.derp_port == 8443)
        );
        assert_eq!(Link::parse(&l.encode()).unwrap(), l);
        let v6 = Link::parse("webpc-room:a?derp=%5B%3A%3A1%5D%3A3340").unwrap();
        assert_eq!(Link::parse(&v6.encode()).unwrap(), v6);
        assert!(!v6.needs_map() && v6.nostr.len() == DEFAULT_NOSTR.len());
    }

    #[test]
    fn a_bare_id_gets_the_defaults() {
        let l = Link::parse("  gabriel-lan ").unwrap();
        assert_eq!(l.id, "gabriel-lan");
        assert_eq!(l.derp, [Region::Map(0)]);
        assert_eq!(l.nostr.len(), DEFAULT_NOSTR.len());
        assert_eq!(Link::parse(&l.encode()).unwrap(), l);
    }

    #[test]
    fn the_defaults_arent_written_into_a_link() {
        for s in ["webpc-room:abc", "abc"] {
            assert_eq!(Link::parse(s).unwrap().encode(), "webpc-room:abc", "{s}");
        }
        let only = Link::parse("webpc-room:abc?derp=900").unwrap();
        assert_eq!(only.nostr.len(), DEFAULT_NOSTR.len());
        assert_eq!(only.encode(), "webpc-room:abc?derp=900");
    }

    #[test]
    fn bad_links() {
        for bad in [
            "",
            "webpc-room:",
            "webpc-room:a?nostr=https%3A%2F%2Fx",
            "webpc-room:a?derp=-1",
            "webpc-room:a?derp=a%2Fb",
            "webpc-room:a%zz",
            &format!("webpc-room:{}", "a".repeat(300)),
            &format!("webpc-room:a?{}", "derp=1&".repeat(9)),
        ] {
            assert!(Link::parse(bad).is_err(), "{bad}");
        }
    }
}
