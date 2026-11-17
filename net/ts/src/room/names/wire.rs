//! What the registry sends (room-names.md "The registry"): binary, integers little-endian.
//!
//! - **An item**: a name's record as a server holds and sends it: its id, the headers its entries'
//!   anchors need (once each), its entries (each with its anchor and its block's header, or a
//!   pending anchor) and its zone. Also what a server stores, one record a name.
//! - **The question**, "who serves the registry?": a lookup's body (the names client's key, its
//!   region, the time, a nonce) and one byte more, `spread`, sealed and MAC'd as a lookup to a bare
//!   address is (lookup.rs) under the room's names tag.
//! - **Transfers**: registry messages are UDP datagrams of at most [`DATAGRAM`] bytes between two
//!   names clients' room addresses on [`NAMES_PORT`]. A message longer than one datagram goes in
//!   numbered parts; every part is acknowledged, resent at 0.5, 1 and 2 s, and at most
//!   [`IN_FLIGHT`] of a peer's are unacknowledged at once (a derper queues 32 packets a client and
//!   drops the oldest).
//! - **Messages**: a type byte, the transfer it answers (0: none), a body ([`Msg`]).

use std::collections::BTreeMap;

use super::{
    Invalid,
    anchor::{Anchor, MAX_ANCHOR, Pending},
    arr,
    entry::{Anchored, ENTRY_LEN, Entry, Stamped},
    header::{HEADER_LEN, Header},
    zone::Zone,
};

/// The UDP port registry messages use between two names clients' addresses, both ends. Never the
/// node's address: the node's key carries none of it.
pub const NAMES_PORT: u16 = 2;
/// The most a registry datagram carries.
pub const DATAGRAM: usize = 1200;
/// A part's head: kind, transfer, part, parts.
const PART_HEAD: usize = 1 + 4 + 2 + 2;
pub const PART_DATA: usize = DATAGRAM - PART_HEAD;
/// The most parts of a peer's that are unacknowledged at once.
pub const IN_FLIGHT: usize = 8;
/// The longest message: 1 MiB (an item of a name held for years, or a listing).
pub const MAX_MESSAGE: usize = 1 << 20;
/// The most entries an item may carry.
pub const MAX_ENTRIES: usize = 1024;
/// 4: entries without `ref` (version 2), an anchor with its block's header alone.
const ITEM_VERSION: u8 = 4;

/// A little-endian reader that fails on short input.
pub(super) struct Rd<'a> {
    b: &'a [u8],
    i: usize,
}

impl<'a> Rd<'a> {
    pub fn new(b: &'a [u8]) -> Rd<'a> {
        Rd { b, i: 0 }
    }

    pub fn take(&mut self, n: usize) -> Result<&'a [u8], Invalid> {
        let s = self
            .b
            .get(self.i..self.i.checked_add(n).ok_or(Invalid::Encoding)?)
            .ok_or(Invalid::Encoding)?;
        self.i += n;
        Ok(s)
    }

    pub fn u8(&mut self) -> Result<u8, Invalid> {
        Ok(self.take(1)?[0])
    }

    pub fn u16(&mut self) -> Result<u16, Invalid> {
        Ok(u16::from_le_bytes(arr(self.take(2)?, 0)))
    }

    pub fn u32(&mut self) -> Result<u32, Invalid> {
        Ok(u32::from_le_bytes(arr(self.take(4)?, 0)))
    }

    pub fn u64(&mut self) -> Result<u64, Invalid> {
        Ok(u64::from_le_bytes(arr(self.take(8)?, 0)))
    }

    pub fn a<const N: usize>(&mut self) -> Result<[u8; N], Invalid> {
        Ok(arr(self.take(N)?, 0))
    }

    pub fn rest(&mut self) -> &'a [u8] {
        let r = &self.b[self.i..];
        self.i = self.b.len();
        r
    }

    pub fn end(&self) -> Result<(), Invalid> {
        (self.i == self.b.len())
            .then_some(())
            .ok_or(Invalid::Encoding)
    }
}

/// One entry of an item as it travels, not yet checked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WireEntry {
    pub entry: Entry,
    pub anchor: Option<(Anchor, Header)>,
    pub pending: Option<Pending>,
}

impl WireEntry {
    pub fn of(s: &Stamped) -> WireEntry {
        WireEntry {
            entry: s.entry.clone(),
            anchor: s.anchor().map(|a| (a.anchor.clone(), a.header)),
            pending: s.pending().cloned(),
        }
    }

    /// As this node stored it: verified when first taken.
    pub fn trusted(self) -> Stamped {
        Stamped::trusted(
            self.entry,
            self.anchor
                .map(|(anchor, header)| Anchored { anchor, header }),
            self.pending,
        )
    }
}

/// A name's record: what a server holds, sends and stores.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Item {
    pub id: [u8; 32],
    pub entries: Vec<WireEntry>,
    pub zone: Option<Zone>,
}

impl Item {
    pub fn encode(&self) -> Vec<u8> {
        let mut headers: Vec<Header> = Vec::new();
        let index = |h: &Header, headers: &mut Vec<Header>| -> u16 {
            match headers.iter().position(|x| x == h) {
                Some(i) => i as u16,
                None => {
                    headers.push(*h);
                    (headers.len() - 1) as u16
                }
            }
        };
        let mut es = Vec::new();
        for e in &self.entries {
            es.extend_from_slice(&e.entry.encode());
            match &e.anchor {
                Some((a, h)) => {
                    let b = a.encode();
                    es.extend_from_slice(&(b.len() as u16).to_le_bytes());
                    es.extend_from_slice(&b);
                    es.extend_from_slice(&index(h, &mut headers).to_le_bytes());
                }
                None => es.extend_from_slice(&0u16.to_le_bytes()),
            }
            let p = e.pending.as_ref().map(Pending::encode).unwrap_or_default();
            es.extend_from_slice(&(p.len() as u16).to_le_bytes());
            es.extend_from_slice(&p);
        }
        let mut out = vec![ITEM_VERSION];
        out.extend_from_slice(&self.id);
        out.extend_from_slice(&(headers.len() as u16).to_le_bytes());
        for h in &headers {
            out.extend_from_slice(&h.0);
        }
        out.extend_from_slice(&(self.entries.len() as u16).to_le_bytes());
        out.extend(es);
        let z = self.zone.as_ref().map(Zone::encode).unwrap_or_default();
        out.extend_from_slice(&(z.len() as u16).to_le_bytes());
        out.extend(z);
        out
    }

    pub fn decode(b: &[u8]) -> Result<Item, Invalid> {
        let mut r = Rd::new(b);
        let it = Item::read(&mut r)?;
        r.end()?;
        Ok(it)
    }

    pub(super) fn read(r: &mut Rd) -> Result<Item, Invalid> {
        if r.u8()? != ITEM_VERSION {
            return Err(Invalid::Encoding);
        }
        let id = r.a::<32>()?;
        let nh = r.u16()? as usize;
        let headers = (0..nh)
            .map(|_| Ok(Header(r.a::<HEADER_LEN>()?)))
            .collect::<Result<Vec<_>, Invalid>>()?;
        let hdr = |i: u16| headers.get(i as usize).copied().ok_or(Invalid::Encoding);
        let ne = r.u16()? as usize;
        if ne > MAX_ENTRIES {
            return Err(Invalid::Encoding);
        }
        let mut entries = Vec::with_capacity(ne);
        for _ in 0..ne {
            let entry = Entry::decode(r.take(ENTRY_LEN)?)?;
            let al = r.u16()? as usize;
            let anchor = match al {
                0 => None,
                n if n <= MAX_ANCHOR => {
                    let a = Anchor::decode(r.take(n)?).map_err(|_| Invalid::AnchorFormat)?;
                    Some((a, hdr(r.u16()?)?))
                }
                _ => return Err(Invalid::AnchorFormat),
            };
            let pl = r.u16()? as usize;
            let pending = match pl {
                0 => None,
                n => Some(Pending::decode(r.take(n)?)?),
            };
            entries.push(WireEntry {
                entry,
                anchor,
                pending,
            });
        }
        let zl = r.u16()? as usize;
        let zone = match zl {
            0 => None,
            n => Some(Zone::decode(r.take(n)?)?),
        };
        Ok(Item { id, entries, zone })
    }
}

/// "Who serves the registry?": what the asker's names client says under the room's names tag.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Question {
    /// The asker's names client's key (made new each session).
    pub key: [u8; 32],
    /// The asker's home region, as lookups name one (room.rs `INLINE_REGION`).
    pub region: u16,
    /// Unix seconds.
    pub time: u64,
    pub nonce: [u8; 16],
    /// The share of servers asked: those whose `BLAKE2s(nonce, key)` has its top `spread` bits
    /// zero (6: 1/64, 3: 1/8, 0: everyone).
    pub spread: u8,
}

pub const QUESTION_PLAIN: usize = 32 + 2 + 8 + 16 + 1;
/// A question's bytes: as a bare lookup's (lookup.rs `seal_bare`), one byte longer.
pub const QUESTION_SIZE: usize = 32 + QUESTION_PLAIN + 16 + 16;

impl Question {
    pub fn plain(&self) -> Vec<u8> {
        let mut p = Vec::with_capacity(QUESTION_PLAIN);
        p.extend_from_slice(&self.key);
        p.extend_from_slice(&self.region.to_be_bytes());
        p.extend_from_slice(&self.time.to_be_bytes());
        p.extend_from_slice(&self.nonce);
        p.push(self.spread);
        p
    }

    pub fn from_plain(p: &[u8]) -> Option<Question> {
        (p.len() == QUESTION_PLAIN).then(|| Question {
            key: p[..32].try_into().unwrap(),
            region: u16::from_be_bytes([p[32], p[33]]),
            time: u64::from_be_bytes(p[34..42].try_into().unwrap()),
            nonce: p[42..58].try_into().unwrap(),
            spread: p[58],
        })
    }
}

/// An entry's place in a `get`'s list of what the asker holds: 8 bytes of its id and 4 of its
/// anchor's digest (zeros: unanchored).
pub type Held = ([u8; 8], [u8; 4]);

/// What a `get` asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GetMode {
    /// A member's: the owning chain's last entry and the zone, if the asker lacks them; none (an empty `items`) when
    /// the server has no live chain of the name. Counts as asked.
    Owner = 0,
    /// A server's: everything held that the asker lacks.
    All = 1,
    /// A member's when answers disagree or contest what it keeps: the owning chain's whole unbroken run and the zone.
    /// Counts as asked.
    History = 2,
    /// The dialog's check (room-names.md "A member resolving a name"): every id held whose first byte is the `id`
    /// given (one byte), so the server can't tell which id is about to be claimed. Answered with [`Msg::Ids`]; not
    /// counted as asked.
    Ids = 3,
}

/// A range of name ids: those that start with `depth` nibbles of `prefix`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Range {
    pub depth: u8,
    pub prefix: [u8; 32],
}

impl Range {
    pub const ALL: Range = Range {
        depth: 0,
        prefix: [0; 32],
    };

    /// Its ids, lowest and highest.
    pub fn bounds(&self) -> ([u8; 32], [u8; 32]) {
        let (mut lo, mut hi) = (self.prefix, self.prefix);
        let d = self.depth as usize;
        for n in d..64 {
            let (b, high) = (n / 2, n % 2 == 0);
            let mask = if high { 0xf0 } else { 0x0f };
            lo[b] &= !mask;
            hi[b] |= mask;
        }
        (lo, hi)
    }

    /// Its `k`th sixteenth. A range of all 64 nibbles is one id and has none: itself.
    pub fn child(&self, k: u8) -> Range {
        let mut p = self.bounds().0;
        let d = self.depth as usize;
        if d >= 64 {
            return *self;
        }
        let b = d / 2;
        p[b] |= if d.is_multiple_of(2) {
            k << 4
        } else {
            k & 0x0f
        };
        Range {
            depth: self.depth + 1,
            prefix: p,
        }
    }

    pub fn contains(&self, id: &[u8; 32]) -> bool {
        let (lo, hi) = self.bounds();
        lo <= *id && *id <= hi
    }
}

/// A range's summary: XOR of 8 bytes of each item's `BLAKE2s(id, version)`, and how many.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Fp {
    pub hash: [u8; 8],
    pub count: u32,
}

/// A server's proof to another that it holds a live name (room-names.md "Servers"): one entry of a live name's owning
/// chain, with its anchor and headers, and that entry's owner key's signature over both names clients' keys. Only a
/// server that proved itself so is answered `sync`, `have` and `get` of every kind but a member's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Proof {
    pub entry: WireEntry,
    pub sig: [u8; 64],
}

/// What a `sync` is answered with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncAnswer {
    Same,
    /// The sixteen sub-ranges' summaries.
    Children([Fp; 16]),
    /// Every item of the range: 8 bytes of its id and its version.
    Listing(Vec<([u8; 8], [u8; 8])>),
}

/// A registry message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Msg {
    /// A server answering a question: the last entry of a live name's owning chain (one entry, with its anchor and
    /// header) and the owner key's signature over the asker's nonce and the server's names key.
    Serve {
        nonce: [u8; 16],
        entries: Vec<WireEntry>,
        sig: [u8; 64],
    },
    /// The ids `id` (a prefix of 8 or 32 bytes) asked for, with what the asker holds.
    Get {
        mode: GetMode,
        id: Vec<u8>,
        /// The asker's zone's `seq` and 4 bytes of its hash (zeros: none).
        zone: (u64, [u8; 4]),
        held: Vec<Held>,
    },
    /// A `get`'s answer: what the asker lacks of each item asked (none: an empty list).
    Items(Vec<Item>),
    /// An item offered (an owner's agent, or a member that holds a better chain).
    Put(Item),
    /// A `put`'s answer: taken, or the server's better item.
    Taken,
    Better(Item),
    /// Items that changed: the receiver `get`s what it lacks.
    Have(Vec<[u8; 32]>),
    /// A `get` in [`GetMode::Ids`]'s answer: the ids held under its first byte, each with until when its owning chain
    /// resolves (Unix seconds; 0: no chain owns it now), so the dialog can say "taken until about" without a `get` that
    /// names the id.
    Ids(Vec<([u8; 32], u64)>),
    Sync {
        range: Range,
        fp: Fp,
        /// A run's first `sync` carries the asker's proof that it serves.
        proof: Option<Box<Proof>>,
    },
    SyncAnswer(SyncAnswer),
}

fn w16(o: &mut Vec<u8>, v: usize) {
    o.extend_from_slice(&(v as u16).to_le_bytes());
}

fn w32(o: &mut Vec<u8>, v: u32) {
    o.extend_from_slice(&v.to_le_bytes());
}

fn write_fp(o: &mut Vec<u8>, f: &Fp) {
    o.extend_from_slice(&f.hash);
    w32(o, f.count);
}

fn read_fp(r: &mut Rd) -> Result<Fp, Invalid> {
    Ok(Fp {
        hash: r.a()?,
        count: r.u32()?,
    })
}

impl Msg {
    /// The message as a transfer's payload: its type, the transfer it answers, its body.
    pub fn encode(&self, reply: u32) -> Vec<u8> {
        let mut o = Vec::new();
        let ty = match self {
            Msg::Serve { .. } => 1,
            Msg::Get { .. } => 2,
            Msg::Items(_) => 3,
            Msg::Put(_) => 4,
            Msg::Taken => 5,
            Msg::Better(_) => 6,
            Msg::Have(_) => 7,
            Msg::Sync { .. } => 8,
            Msg::SyncAnswer(_) => 9,
            Msg::Ids(_) => 10,
        };
        o.push(ty);
        w32(&mut o, reply);
        match self {
            Msg::Serve {
                nonce,
                entries,
                sig,
            } => {
                o.extend_from_slice(nonce);
                let it = Item {
                    id: entries.first().map_or([0; 32], |e| e.entry.name),
                    entries: entries.clone(),
                    zone: None,
                };
                o.extend(it.encode());
                o.extend_from_slice(sig);
            }
            Msg::Get {
                mode,
                id,
                zone,
                held,
            } => {
                o.push(*mode as u8);
                o.push(id.len() as u8);
                o.extend_from_slice(id);
                o.extend_from_slice(&zone.0.to_le_bytes());
                o.extend_from_slice(&zone.1);
                w16(&mut o, held.len());
                for (i, a) in held {
                    o.extend_from_slice(i);
                    o.extend_from_slice(a);
                }
            }
            Msg::Items(items) => {
                w16(&mut o, items.len());
                for it in items {
                    let b = it.encode();
                    w32(&mut o, b.len() as u32);
                    o.extend(b);
                }
            }
            Msg::Put(it) | Msg::Better(it) => o.extend(it.encode()),
            Msg::Taken => {}
            Msg::Have(ids) => {
                w16(&mut o, ids.len());
                for i in ids {
                    o.extend_from_slice(i);
                }
            }
            Msg::Ids(ids) => {
                w16(&mut o, ids.len());
                for (i, until) in ids {
                    o.extend_from_slice(i);
                    o.extend_from_slice(&until.to_le_bytes());
                }
            }
            Msg::Sync { range, fp, proof } => {
                o.push(range.depth);
                o.extend_from_slice(&range.prefix);
                write_fp(&mut o, fp);
                match proof {
                    None => o.push(0),
                    Some(p) => {
                        o.push(1);
                        let it = Item {
                            id: p.entry.entry.name,
                            entries: vec![p.entry.clone()],
                            zone: None,
                        };
                        o.extend(it.encode());
                        o.extend_from_slice(&p.sig);
                    }
                }
            }
            Msg::SyncAnswer(a) => match a {
                SyncAnswer::Same => o.push(0),
                SyncAnswer::Children(c) => {
                    o.push(1);
                    for f in c {
                        write_fp(&mut o, f);
                    }
                }
                SyncAnswer::Listing(l) => {
                    o.push(2);
                    w32(&mut o, l.len() as u32);
                    for (i, v) in l {
                        o.extend_from_slice(i);
                        o.extend_from_slice(v);
                    }
                }
            },
        }
        o
    }

    /// A transfer's payload read back: the message and the transfer it answers.
    pub fn decode(b: &[u8]) -> Result<(Msg, u32), Invalid> {
        let mut r = Rd::new(b);
        let ty = r.u8()?;
        let reply = r.u32()?;
        let m = match ty {
            1 => {
                let nonce = r.a()?;
                let it = Item::read(&mut r)?;
                let sig = r.a()?;
                if it.entries.len() != 1 {
                    return Err(Invalid::Encoding);
                }
                Msg::Serve {
                    nonce,
                    entries: it.entries,
                    sig,
                }
            }
            2 => {
                let mode = match r.u8()? {
                    0 => GetMode::Owner,
                    1 => GetMode::All,
                    2 => GetMode::History,
                    3 => GetMode::Ids,
                    _ => return Err(Invalid::Encoding),
                };
                let n = r.u8()? as usize;
                let ok = match mode {
                    GetMode::Ids => n == 1, // one first byte: never every id, never the id
                    GetMode::All => n == 8 || n == 32,
                    GetMode::Owner | GetMode::History => n == 32,
                };
                if !ok {
                    return Err(Invalid::Encoding);
                }
                let id = r.take(n)?.to_vec();
                let zone = (r.u64()?, r.a()?);
                let k = r.u16()? as usize;
                let held = (0..k)
                    .map(|_| Ok((r.a()?, r.a()?)))
                    .collect::<Result<_, Invalid>>()?;
                Msg::Get {
                    mode,
                    id,
                    zone,
                    held,
                }
            }
            3 => {
                let n = r.u16()? as usize;
                let mut items = Vec::new();
                for _ in 0..n {
                    let len = r.u32()? as usize;
                    items.push(Item::decode(r.take(len)?)?);
                }
                Msg::Items(items)
            }
            4 => Msg::Put(Item::read(&mut r)?),
            5 => Msg::Taken,
            6 => Msg::Better(Item::read(&mut r)?),
            7 => {
                let n = r.u16()? as usize;
                Msg::Have((0..n).map(|_| r.a()).collect::<Result<_, _>>()?)
            }
            10 => {
                let n = r.u16()? as usize;
                Msg::Ids(
                    (0..n)
                        .map(|_| Ok((r.a()?, r.u64()?)))
                        .collect::<Result<_, _>>()?,
                )
            }
            8 => {
                let range = Range {
                    depth: r.u8()?,
                    prefix: r.a()?,
                };
                let fp = read_fp(&mut r)?;
                let proof = match r.u8()? {
                    0 => None,
                    1 => {
                        let it = Item::read(&mut r)?;
                        let [entry]: [WireEntry; 1] =
                            it.entries.try_into().map_err(|_| Invalid::Encoding)?;
                        Some(Box::new(Proof { entry, sig: r.a()? }))
                    }
                    _ => return Err(Invalid::Encoding),
                };
                Msg::Sync { range, fp, proof }
            }
            9 => Msg::SyncAnswer(match r.u8()? {
                0 => SyncAnswer::Same,
                1 => {
                    let mut c = [Fp::default(); 16];
                    for f in &mut c {
                        *f = read_fp(&mut r)?;
                    }
                    SyncAnswer::Children(c)
                }
                2 => {
                    let n = r.u32()? as usize;
                    if n > MAX_MESSAGE / 16 {
                        return Err(Invalid::Encoding);
                    }
                    SyncAnswer::Listing(
                        (0..n)
                            .map(|_| Ok((r.a()?, r.a()?)))
                            .collect::<Result<_, Invalid>>()?,
                    )
                }
                _ => return Err(Invalid::Encoding),
            }),
            _ => return Err(Invalid::Encoding),
        };
        if let Msg::Sync { range, .. } = &m
            && range.depth > 64
        {
            return Err(Invalid::Encoding);
        }
        r.end()?;
        Ok((m, reply))
    }
}

// ---- Transfers ----

/// A part's state: not sent yet, or in flight until `at` (when it is resent, `tries` left).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Part {
    Unsent,
    Flying { at: std::time::Instant, tries: u8 },
    Acked,
}

/// Resends of an unacknowledged part, after these waits (the spec's 0.5, 1 and 2 s); then the
/// transfer fails.
const RESENDS: [u64; 3] = [500, 1000, 2000];

struct Out {
    id: u32,
    parts: Vec<Vec<u8>>,
    state: Vec<Part>,
}

struct In {
    parts: Vec<Option<Vec<u8>>>,
    got: usize,
    /// When its last new part came: an incomplete transfer is dropped [`INBOUND_IDLE`] after it.
    last: std::time::Instant,
}

/// A peer's transfers both ways.
#[derive(Default)]
struct Peer {
    out: Vec<Out>,
    inbound: BTreeMap<u32, In>,
    /// Transfers received whole lately (a resent part is acknowledged again, nothing more).
    done: std::collections::VecDeque<u32>,
    /// Bytes of incomplete inbound transfers.
    buffered: usize,
}

/// The most transfers of a peer's held incomplete, and their bytes (every new part counts).
const MAX_INBOUND: usize = 16;
pub const MAX_BUFFERED: usize = 2 * MAX_MESSAGE;
/// An incomplete transfer that got no new part this long is dropped (its sender gives up a part after 5.5 s).
const INBOUND_IDLE: std::time::Duration = std::time::Duration::from_secs(10);
const DONE_KEPT: usize = 256;

/// Every peer's transfers: messages in, datagrams out.
#[derive(Default)]
pub struct Transfers {
    peers: BTreeMap<[u8; 32], Peer>,
    /// The last transfer's id, across peers: a peer forgotten and met again (its session ended on our side only) gets
    /// new ids, not ones it remembers as done and would drop.
    next: u32,
    /// Datagrams to send: (peer, bytes).
    pub out: Vec<([u8; 32], Vec<u8>)>,
    /// Sends there was no room for: failed at the next tick (the time it was refused).
    refused: Vec<([u8; 32], u32)>,
    refused_at: Option<std::time::Instant>,
}

/// The most bytes of messages queued to one peer and not yet acknowledged whole: past it a send fails (a peer that
/// asks much and acknowledges nothing can't make us hold all we would answer).
pub const MAX_QUEUED: usize = 8 * MAX_MESSAGE;

impl Transfers {
    /// Sends `payload` to `to`: its transfer's id.
    pub fn send(&mut self, to: [u8; 32], payload: &[u8], now: std::time::Instant) -> u32 {
        self.next = self.next.wrapping_add(1).max(1);
        let id = self.next;
        let p = self.peers.entry(to).or_default();
        let queued: usize = p.out.iter().flat_map(|o| &o.parts).map(Vec::len).sum();
        if queued + payload.len() > MAX_QUEUED {
            self.refused.push((to, id));
            self.refused_at.get_or_insert(now);
            return id;
        }
        let chunks: Vec<&[u8]> = if payload.is_empty() {
            vec![&[]]
        } else {
            payload.chunks(PART_DATA).collect()
        };
        let n = chunks.len();
        let parts = chunks
            .iter()
            .enumerate()
            .map(|(k, c)| {
                let mut d = Vec::with_capacity(PART_HEAD + c.len());
                d.push(0);
                d.extend_from_slice(&id.to_le_bytes());
                d.extend_from_slice(&(k as u16).to_le_bytes());
                d.extend_from_slice(&(n as u16).to_le_bytes());
                d.extend_from_slice(c);
                d
            })
            .collect();
        p.out.push(Out {
            id,
            parts,
            state: vec![Part::Unsent; n],
        });
        self.pump(to, now);
        id
    }

    /// Sends what the window allows to `to`.
    fn pump(&mut self, to: [u8; 32], now: std::time::Instant) {
        let Some(p) = self.peers.get_mut(&to) else {
            return;
        };
        let mut flying = p
            .out
            .iter()
            .flat_map(|o| &o.state)
            .filter(|s| matches!(s, Part::Flying { .. }))
            .count();
        for o in &mut p.out {
            for (k, s) in o.state.iter_mut().enumerate() {
                if flying >= IN_FLIGHT {
                    return;
                }
                if *s == Part::Unsent {
                    *s = Part::Flying {
                        at: now + std::time::Duration::from_millis(RESENDS[0]),
                        tries: RESENDS.len() as u8,
                    };
                    flying += 1;
                    self.out.push((to, o.parts[k].clone()));
                }
            }
        }
    }

    /// A datagram from `from`: a message when it completes one (its transfer's id and payload).
    pub fn input(
        &mut self,
        from: [u8; 32],
        d: &[u8],
        now: std::time::Instant,
    ) -> Option<(u32, Vec<u8>)> {
        let mut r = Rd::new(d);
        let kind = r.u8().ok()?;
        let id = r.u32().ok()?;
        let part = r.u16().ok()? as usize;
        if kind == 1 {
            let p = self.peers.get_mut(&from)?;
            for o in &mut p.out {
                if o.id == id
                    && let Some(s) = o.state.get_mut(part)
                {
                    *s = Part::Acked;
                }
            }
            p.out.retain(|o| o.state.iter().any(|s| *s != Part::Acked));
            self.pump(from, now);
            return None;
        }
        let n = r.u16().ok()? as usize;
        let data = r.rest();
        if kind != 0 || n == 0 || part >= n || n * PART_DATA > MAX_MESSAGE + PART_DATA {
            return None;
        }
        let p = self.peers.entry(from).or_default();
        let mut ack = vec![1];
        ack.extend_from_slice(&id.to_le_bytes());
        ack.extend_from_slice(&(part as u16).to_le_bytes());
        if p.done.contains(&id) {
            self.out.push((from, ack));
            return None;
        }
        let new = p
            .inbound
            .get(&id)
            .is_none_or(|t| t.parts.get(part).is_some_and(Option::is_none));
        if new
            && ((!p.inbound.contains_key(&id) && p.inbound.len() >= MAX_INBOUND)
                || p.buffered + data.len() > MAX_BUFFERED)
        {
            return None; // no room: unacknowledged, so it comes again
        }
        let t = p.inbound.entry(id).or_insert_with(|| In {
            parts: vec![None; n],
            got: 0,
            last: now,
        });
        if t.parts.len() != n {
            return None;
        }
        if t.parts[part].is_none() {
            t.parts[part] = Some(data.to_vec());
            t.got += 1;
            t.last = now;
            p.buffered += data.len();
        }
        self.out.push((from, ack));
        let p = self.peers.get_mut(&from).unwrap();
        if p.inbound[&id].got < n {
            return None;
        }
        let t = p.inbound.remove(&id).unwrap();
        let msg: Vec<u8> = t.parts.into_iter().flatten().flatten().collect();
        p.buffered -= msg.len();
        p.done.push_back(id);
        if p.done.len() > DONE_KEPT {
            p.done.pop_front();
        }
        Some((id, msg))
    }

    /// Resends what's due; the transfers that failed (no acknowledgement after the last resend):
    /// (peer, transfer id).
    pub fn tick(&mut self, now: std::time::Instant) -> Vec<([u8; 32], u32)> {
        let mut failed = std::mem::take(&mut self.refused);
        self.refused_at = None;
        let keys: Vec<[u8; 32]> = self.peers.keys().copied().collect();
        for k in keys {
            let p = self.peers.get_mut(&k).unwrap();
            let buffered = &mut p.buffered;
            p.inbound.retain(|_, t| {
                let keep = now.saturating_duration_since(t.last) < INBOUND_IDLE;
                if !keep {
                    *buffered -= t.parts.iter().flatten().map(Vec::len).sum::<usize>();
                }
                keep
            });
            for o in &mut p.out {
                let mut lost = false;
                for (i, s) in o.state.iter_mut().enumerate() {
                    if let Part::Flying { at, tries } = *s
                        && at <= now
                    {
                        if tries == 0 {
                            lost = true;
                        } else {
                            // As signalling's: resent after 0.5, 1 and 2 s, then a last 2 s.
                            let t = tries - 1;
                            let wait = RESENDS[RESENDS.len() - (t as usize).max(1)];
                            *s = Part::Flying {
                                at: now + std::time::Duration::from_millis(wait),
                                tries: t,
                            };
                            self.out.push((k, o.parts[i].clone()));
                        }
                    }
                }
                if lost {
                    failed.push((k, o.id));
                    o.state.clear();
                }
            }
            p.out.retain(|o| !o.state.is_empty());
            self.pump(k, now);
        }
        failed
    }

    pub fn deadline(&self) -> Option<std::time::Instant> {
        if let Some(t) = self.refused_at {
            return Some(t);
        }
        let out = self
            .peers
            .values()
            .flat_map(|p| &p.out)
            .flat_map(|o| &o.state)
            .filter_map(|s| match s {
                Part::Flying { at, .. } => Some(*at),
                _ => None,
            });
        let stale = self
            .peers
            .values()
            .flat_map(|p| p.inbound.values())
            .map(|t| t.last + INBOUND_IDLE);
        out.chain(stale).min()
    }

    /// The bytes of messages queued to `to` and not yet acknowledged whole.
    pub fn queued(&self, to: &[u8; 32]) -> usize {
        self.peers.get(to).map_or(0, |p| {
            p.out.iter().flat_map(|o| &o.parts).map(Vec::len).sum()
        })
    }

    /// Forgets a peer (its session ended).
    pub fn forget(&mut self, key: &[u8; 32]) -> Vec<u32> {
        self.peers
            .remove(key)
            .map(|p| p.out.iter().map(|o| o.id).collect())
            .unwrap_or_default()
    }
}
