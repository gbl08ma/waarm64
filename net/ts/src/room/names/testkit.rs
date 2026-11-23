//! A pretend Bitcoin for the registry's tests (and the room's, room/tests/names.rs): easy headers
//! mined to their own target, anchors made up to a header's Merkle root, cheap proof of work, and
//! titles made of them; and [`Services`], pretend calendars and explorers on a pretend chain (as
//! tests/net/ots-calendar.ts is for Node), for what servers ask outside the room.

use std::collections::{BTreeMap, BTreeSet};

use k256::schnorr::SigningKey;
use sha2::{Digest, Sha256};

use super::{
    Params,
    anchor::{Anchor, Calendar, EXPLORERS, Op, Pending, apply},
    entry::{Entry, Kind, Pow, Stamped},
    header::{Header, target},
    id::{RoomNames, owner_key},
    wire::{Item, WireEntry},
    zone::Zone,
};

pub const HOUR: u32 = 3600;
pub const DAY: u32 = 24 * HOUR;
/// Regtest's target: half of all hashes are under it.
pub const EASY: u32 = 0x207f_ffff;

/// The spec's clock with cheap proof of work and a floor any pretend header meets.
pub fn params() -> Params {
    Params::TEST
}

/// SplitMix64: the tests' only randomness.
pub struct Rng(pub u64);

impl Rng {
    #[allow(clippy::should_implement_trait)] // never ends: not an iterator
    pub fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    pub fn bytes<const N: usize>(&mut self) -> [u8; N] {
        let mut b = [0u8; N];
        for c in b.chunks_mut(8) {
            c.copy_from_slice(&self.next().to_le_bytes()[..c.len()]);
        }
        b
    }
}

/// A header at `time` over `root`, mined to its own `bits`, after a made-up block.
pub fn header(rng: &mut Rng, time: u32, root: [u8; 32], bits: u32) -> Header {
    let prev = rng.bytes::<32>();
    let t = target(bits).unwrap();
    let mut h = [0u8; 80];
    h[..4].copy_from_slice(&0x2000_0000u32.to_le_bytes());
    h[4..36].copy_from_slice(&prev);
    h[36..68].copy_from_slice(&root);
    h[68..72].copy_from_slice(&time.to_le_bytes());
    h[72..76].copy_from_slice(&bits.to_le_bytes());
    for nonce in 0u32.. {
        h[76..].copy_from_slice(&nonce.to_le_bytes());
        let mut x = Header(h).hash();
        x.reverse();
        if x <= t {
            break;
        }
    }
    Header(h)
}

/// A clock past every pretend time, for checks that don't test the future.
pub const LATE: u64 = u32::MAX as u64;

pub struct Bitcoin {
    pub rng: Rng,
    pub params: Params,
    pub names: RoomNames,
    pub pow: Pow,
}

impl Bitcoin {
    pub fn new(room: &str, seed: u64) -> Bitcoin {
        let params = params();
        Bitcoin {
            rng: Rng(seed),
            pow: Pow::new(&params),
            params,
            names: RoomNames::derive(room),
        }
    }

    pub fn key(&self, secret: u8, name: &str) -> SigningKey {
        owner_key(&[secret; 32], &self.names, name)
    }

    /// An entry worked and signed; no anchor.
    pub fn entry(&mut self, kind: Kind, key: &SigningKey, name: &str, prev: [u8; 32]) -> Stamped {
        let owner = key.verifying_key().to_bytes().into();
        let mut e = Entry::new(&self.names, kind, self.names.name_id(name), owner, prev);
        e.nonce = self.rng.next();
        assert!(self.pow.mine(&mut e, 1 << 20));
        e.sign(key, &self.names);
        Stamped::check(e, &self.names, &mut self.pow).unwrap()
    }

    /// An anchor for `id` in a block at `time`: a calendar's kind of path to a made-up root.
    pub fn anchor(&mut self, id: &[u8; 32], time: u32) -> (Anchor, Header) {
        let ops = vec![
            Op::Append(self.rng.bytes::<16>().to_vec()),
            Op::Sha256,
            Op::Prepend(self.rng.bytes::<32>().to_vec()),
            Op::Sha256,
        ];
        let root: [u8; 32] = apply(&ops, id).unwrap().try_into().unwrap();
        (
            Anchor {
                ops,
                height: 900_000,
            },
            header(&mut self.rng, time, root, EASY),
        )
    }

    /// An entry anchored at `time`.
    pub fn at(
        &mut self,
        kind: Kind,
        key: &SigningKey,
        name: &str,
        prev: [u8; 32],
        time: u32,
    ) -> Stamped {
        let mut s = self.entry(kind, key, name, prev);
        let (a, h) = self.anchor(&s.id(), time);
        assert_eq!(s.offer_anchor(a, h, &self.params, LATE), Ok(true));
        s
    }

    /// A title: a claim at `claim` and a renewal at each of `renewals`, all anchored, and a zone
    /// pointing the name at `node`.
    pub fn title(
        &mut self,
        secret: u8,
        name: &str,
        claim: u32,
        renewals: &[u32],
        node: [u8; 32],
    ) -> ([u8; 32], Item) {
        let key = self.key(secret, name);
        let mut run = vec![self.at(Kind::Claim, &key, name, [0; 32], claim)];
        for t in renewals {
            let prev = run.last().unwrap().id();
            run.push(self.at(Kind::Renew, &key, name, prev, *t));
        }
        let zone = Zone::seal(&self.names, &key, name, 1, &[(None, node)], false).unwrap();
        (key.to_bytes().into(), self.item(name, &run, Some(zone)))
    }

    pub fn item(&self, name: &str, entries: &[Stamped], zone: Option<Zone>) -> Item {
        Item {
            id: self.names.name_id(name),
            entries: entries.iter().map(WireEntry::of).collect(),
            zone,
        }
    }
}

/// The tests' pretend calendars and explorers over one pretend chain: what servers fetch (names.md "Servers",
/// server/outside.rs), answered at the compiled URLs as the real services answer. A calendar's
/// `/timestamp/<commitment>` is 404 while pending (as a page sees it), then the proof once its block is [`depth`] deep;
/// an explorer's `block-height/<h>` is its block's hash as explorers show it, `block/<hash>/header` its header in hex,
/// 404 for a block it doesn't know (or [`denied`]). Every URL asked is kept, and those of no compiled service apart.
///
/// [`depth`]: Services::depth
/// [`denied`]: Services::denied
pub struct Services {
    pub rng: Rng,
    /// The chain, genesis first.
    pub blocks: Vec<Header>,
    /// Commitment → its block's height and its path to the root, once mined.
    commits: BTreeMap<Vec<u8>, Option<(usize, Vec<Op>)>>,
    waiting: Vec<Vec<u8>>,
    pub depth: usize,
    /// Blocks each explorer says it doesn't know, by hash.
    pub denied: [BTreeSet<[u8; 32]>; 2],
    /// Explorers that can't be reached (no answer).
    pub explorers_down: [bool; 2],
    /// Every URL asked, in order; those of no compiled service.
    pub asked: Vec<String>,
    pub foreign: Vec<String>,
}

fn sha256(b: &[u8]) -> Vec<u8> {
    Sha256::digest(b).to_vec()
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len() / 2)
        .filter_map(|i| {
            s.get(2 * i..2 * i + 2)
                .and_then(|x| u8::from_str_radix(x, 16).ok())
        })
        .collect()
}

/// A block's hash as explorers show it.
pub fn shown(h: &Header) -> String {
    let mut x = h.hash();
    x.reverse();
    hex(&x)
}

impl Services {
    pub fn new(seed: u64) -> Services {
        let mut s = Services {
            rng: Rng(seed),
            blocks: Vec::new(),
            commits: BTreeMap::new(),
            waiting: Vec::new(),
            depth: 6,
            denied: Default::default(),
            explorers_down: [false; 2],
            asked: Vec::new(),
            foreign: Vec::new(),
        };
        s.mine(1, 1_500_000_000);
        s
    }

    /// Entry `id` stamped at `calendar`: the receipt's pending anchor (unsigned: the owner signs it).
    pub fn stamp(&mut self, id: &[u8; 32], calendar: Calendar) -> Pending {
        let ops = vec![Op::Append(self.rng.bytes::<16>().to_vec()), Op::Sha256];
        let c = apply(&ops, id).unwrap();
        self.commits.insert(c.clone(), None);
        self.waiting.push(c);
        Pending {
            calendar,
            ops,
            sig: [0; 64],
        }
    }

    /// Mines `n` blocks at `time`, the commitments waiting in the first.
    pub fn mine(&mut self, n: usize, time: u32) {
        for _ in 0..n {
            let leaves = std::mem::take(&mut self.waiting);
            let mut paths: Vec<Vec<Op>> = vec![Vec::new(); leaves.len()];
            let mut level: Vec<(Vec<u8>, Vec<usize>)> = if leaves.is_empty() {
                vec![(self.rng.bytes::<32>().to_vec(), Vec::new())]
            } else {
                leaves
                    .iter()
                    .enumerate()
                    .map(|(i, l)| (l.clone(), vec![i]))
                    .collect()
            };
            if leaves.len() == 1 {
                paths[0].extend([Op::Append(Vec::new()), Op::Sha256]);
                level = vec![(sha256(&leaves[0]), vec![0])];
            }
            while level.len() > 1 {
                let mut next = Vec::new();
                for i in (0..level.len()).step_by(2) {
                    let l = level[i].clone();
                    let r = level.get(i + 1).cloned().unwrap_or(l.clone());
                    for &w in &l.1 {
                        paths[w].extend([Op::Append(r.0.clone()), Op::Sha256]);
                    }
                    if i + 1 < level.len() {
                        for &w in &r.1 {
                            paths[w].extend([Op::Prepend(l.0.clone()), Op::Sha256]);
                        }
                    }
                    let who = if i + 1 < level.len() {
                        [l.1.clone(), r.1].concat()
                    } else {
                        l.1.clone()
                    };
                    next.push((sha256(&[l.0, r.0].concat()), who));
                }
                level = next;
            }
            let root: [u8; 32] = level[0].0.clone().try_into().unwrap();
            let prev = self.blocks.last().map(Header::hash).unwrap_or([0; 32]);
            let t = target(EASY).unwrap();
            let mut h = [0u8; 80];
            h[..4].copy_from_slice(&0x2000_0000u32.to_le_bytes());
            h[4..36].copy_from_slice(&prev);
            h[36..68].copy_from_slice(&root);
            h[68..72].copy_from_slice(&time.to_le_bytes());
            h[72..76].copy_from_slice(&EASY.to_le_bytes());
            for nonce in 0u32.. {
                h[76..].copy_from_slice(&nonce.to_le_bytes());
                let mut x = Header(h).hash();
                x.reverse();
                if x <= t {
                    break;
                }
            }
            let height = self.blocks.len();
            self.blocks.push(Header(h));
            for (c, path) in leaves.into_iter().zip(paths) {
                self.commits.insert(c, Some((height, path)));
            }
        }
    }

    /// The finished anchor of pending `p` of entry `id` and its block's header, once its block is deep enough (what an
    /// owner's agent collects).
    pub fn anchor_of(&self, id: &[u8; 32], p: &Pending) -> Option<(Anchor, Header)> {
        let c = p.commitment(id)?;
        let (height, path) = self.commits.get(&c)?.clone()?;
        if self.blocks.len() - height < self.depth {
            return None;
        }
        let a = Anchor {
            ops: [p.ops.clone(), path].concat(),
            height: height as u64,
        };
        Some((a, self.blocks[height]))
    }

    /// A GET of `url`: the status (0: no answer) and the body.
    pub fn get(&mut self, url: &str) -> (u16, Vec<u8>) {
        self.asked.push(url.to_string());
        for c in Calendar::ALL {
            if let Some(rest) = url.strip_prefix(&format!("{}/timestamp/", c.url())) {
                let Some(Some((height, path))) = self.commits.get(&unhex(rest)).cloned() else {
                    return (404, b"Pending confirmation in Bitcoin blockchain".to_vec());
                };
                if self.blocks.len() - height < self.depth {
                    return (404, b"Pending confirmation in Bitcoin blockchain".to_vec());
                }
                // The proof: the commitment's path to the root, then the Bitcoin attestation.
                let proof = Anchor {
                    ops: path,
                    height: height as u64,
                };
                return (200, proof.encode());
            }
        }
        for (e, base) in EXPLORERS.iter().enumerate() {
            let Some(rest) = url.strip_prefix(&format!("{base}/")) else {
                continue;
            };
            if self.explorers_down[e] {
                return (0, Vec::new());
            }
            if let Some(h) = rest.strip_prefix("block-height/") {
                return match h.parse::<usize>().ok().and_then(|h| self.blocks.get(h)) {
                    Some(b) => (200, shown(b).into_bytes()),
                    None => (404, b"Block not found".to_vec()),
                };
            }
            if let Some(h) = rest
                .strip_prefix("block/")
                .and_then(|r| r.strip_suffix("/header"))
            {
                let b = self.blocks.iter().find(|b| shown(b) == h);
                return match b {
                    Some(b) if !self.denied[e].contains(&b.hash()) => (200, hex(&b.0).into_bytes()),
                    _ => (404, b"Block not found".to_vec()),
                };
            }
            return (404, Vec::new());
        }
        self.foreign.push(url.to_string());
        (0, Vec::new())
    }

    /// Requests asked of the calendars (`timestamp`) and of the explorers.
    pub fn counts(&self) -> (usize, usize) {
        let cal = self
            .asked
            .iter()
            .filter(|u| u.contains("/timestamp/"))
            .count();
        (cal, self.asked.len() - cal)
    }
}
