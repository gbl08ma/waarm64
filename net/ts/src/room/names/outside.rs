//! What a server asks outside the room (room-names.md "Servers": "Outside the room"; the redesign's R2): the page
//! fetches, the module decides. Members ask nothing (decision 4 as amended covers servers only).
//!
//! - **Renewals finished.** A renewal the server holds with a signed pending anchor is asked of that anchor's calendar
//!   (named by its compiled index, never by a URL from a record) for the finished proof, then of an explorer for the
//!   block at the proof's height and that block's header (2 GETs, the other explorer when one fails or serves a header
//!   that isn't the anchor's). It is first asked [`Params::finish_after`] after the server first held it, then decided
//!   once a slot of [`Params::finish_slot`]: in a slot, a server asks when a hash of the entry, its own key and the
//!   slot falls under a chance of about one over the room's servers (as its last question counted them), halved for
//!   each 12 hours the entry has waited, to an eighth. So a room's servers together ask about once a slot for an entry,
//!   whatever their number. The anchor finished goes into the registry as anything put does: checked, settled, stored,
//!   told to the servers it syncs with.
//! - **Blocks checked.** Each distinct block the registry's anchors are in is asked of an explorer once, by its hash
//!   (`block/<hash>/header`: the hash is what the header proves; the height an anchor carries is trusted for nothing, so
//!   a check by height would let anyone who relays an honest entry with another height have its block refused). The
//!   same header: checked. Not found at both explorers: the block is refused, every anchor in it dropped (their entries
//!   count for nothing until another anchor comes), and remembered for a day, as an anchor in it offered meanwhile is
//!   refused. One explorer's word for it is enough; one that denies it while the other can't be reached is asked again
//!   later. Until a block is checked its anchors count on their header's work, as a member's do, so names work with
//!   the explorers down. One check every [`Params::check_every_ms`] at most, newest arrivals first: a new server's
//!   first sync brings hundreds; a new arrival is checked within seconds. Checks run from the module's ticks, never on
//!   a lookup's path, and are stored under the block's hash ([`BLOCK_RECORD`]) and loaded back at the start.

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use blake2::{Blake2s256, Digest};

use super::{Cmd, Item, Job, Server, WireEntry};
use crate::room::names::{
    anchor::{Anchor, Calendar, EXPLORERS, Pending},
    header::Header,
};

/// A block's check, as stored (the record's version byte; a server's name records are 1, a member's 2).
pub const BLOCK_RECORD: u8 = 3;
/// A fetch the page hasn't answered in this long counts as failed.
pub const FETCH_WAIT: Duration = Duration::from_secs(30);
/// Fetches out at once.
const FETCHES_MAX: usize = 4;
/// A refused block is remembered this long (seconds).
const REFUSED_FOR: u64 = 24 * 3600;
/// A block neither explorer answered for is asked again after this, doubling to [`CHECK_AGAIN_MAX`] (seconds).
const CHECK_AGAIN: u64 = 5 * 60;
const CHECK_AGAIN_MAX: u64 = 6 * 3600;
/// The chance halves for each this long a renewal has waited (seconds), [`FINISH_HALVINGS`] times at most.
const FINISH_HALVE: u64 = 12 * 3600;
const FINISH_HALVINGS: u64 = 3;
/// The most servers a question's answers are taken to stand for.
const SERVERS_MAX: u32 = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    /// Not asked yet, or asked again from `next` (Unix seconds).
    Unchecked {
        next: u64,
        tries: u32,
    },
    /// Asked, `tries` times before without an answer (review 3, finding 7: kept here, so the wait doubles).
    Checking {
        tries: u32,
    },
    Checked,
    Refused,
}

#[derive(Debug, Clone)]
struct Block {
    state: State,
    /// When it came (newest are checked first), or when its verdict was (Unix seconds).
    at: u64,
    /// The header held, to compare with the explorer's (none for a check loaded back).
    header: Option<Header>,
}

/// A renewal waiting for its anchor, as this server decides when to ask for it.
#[derive(Debug, Clone)]
struct Finish {
    name: [u8; 32],
    pending: Pending,
    /// When this server first held it (Unix seconds).
    seen: u64,
    /// The last slot decided.
    slot: Option<u64>,
    busy: bool,
}

#[derive(Debug, Clone)]
enum Fetch {
    /// A block's header by its hash at explorer `explorer`; `denied` and `tried`: a bit an explorer.
    Block {
        hash: [u8; 32],
        explorer: usize,
        denied: u8,
        tried: u8,
    },
    /// Entry `eid`'s finished proof at its pending anchor's calendar.
    Proof { eid: [u8; 32] },
    /// The hash of the block at the anchor's height, then that block's header (`hash` set).
    Height {
        eid: [u8; 32],
        anchor: Anchor,
        explorer: usize,
        tried: u8,
        hash: Option<String>,
    },
}

/// What a server asks outside the room, and what came of it.
#[derive(Default)]
pub(super) struct Outside {
    blocks: BTreeMap<[u8; 32], Block>,
    finishing: BTreeMap<[u8; 32], Finish>,
    fetches: BTreeMap<u32, (Fetch, Instant)>,
    next_id: u32,
    /// The next block check may go out then.
    next_check: Option<Instant>,
    /// About how many servers the room has, from this server's questions (itself counted): 1 until one is answered.
    servers: Option<u32>,
}

pub(super) fn hex(b: &[u8]) -> String {
    b.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) || !s.is_ascii() {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}

/// A block's hash as explorers show it: reversed, in hex.
fn shown(hash: &[u8; 32]) -> String {
    let mut h = *hash;
    h.reverse();
    hex(&h)
}

/// The draw that decides whether a server asks for entry `eid` in `slot`: 8 bytes of BLAKE2s over them and its key.
pub(super) fn finish_draw(eid: &[u8; 32], key: &[u8; 32], slot: u64) -> u64 {
    let mut h = Blake2s256::new();
    h.update(b"waarm64/names/finish");
    h.update(eid);
    h.update(key);
    h.update(slot.to_le_bytes());
    u64::from_le_bytes(h.finalize()[..8].try_into().unwrap())
}

/// Under what a draw must fall for a server to ask, in a room of about `servers`, for an entry that has waited `age`
/// seconds since it was first asked for.
pub(super) fn finish_chance(servers: u32, age: u64) -> u64 {
    (u64::MAX / servers.max(1) as u64) >> (age / FINISH_HALVE).min(FINISH_HALVINGS)
}

impl Outside {
    /// Whether a block was refused (both explorers denied it) in the last day.
    pub fn refused(&self, hash: &[u8; 32]) -> bool {
        self.blocks
            .get(hash)
            .is_some_and(|b| b.state == State::Refused)
    }

    /// What this server's question heard: `answers` answers in a round of `spread`. The room's servers, about.
    pub fn heard(&mut self, answers: usize, spread: u8) {
        let n = ((answers as u64) << spread).saturating_add(1);
        let n = n.min(SERVERS_MAX as u64) as u32;
        self.servers = Some(match self.servers {
            None => n,
            Some(o) => (3 * o + n).div_ceil(4),
        });
    }

    /// The transport went: what was out is forgotten (its answers, if they come, are ignored).
    pub fn stop(&mut self) {
        self.fetches.clear();
        self.next_check = None;
        for b in self.blocks.values_mut() {
            if let State::Checking { tries } = b.state {
                b.state = State::Unchecked { next: 0, tries };
            }
        }
        for f in self.finishing.values_mut() {
            f.busy = false;
        }
    }

    fn due_block(&self, unix: u64) -> Option<[u8; 32]> {
        (self.blocks.iter())
            .filter(|(_, b)| matches!(b.state, State::Unchecked { next, .. } if next <= unix))
            .filter(|(_, b)| b.header.is_some())
            .max_by_key(|(h, b)| (b.at, **h))
            .map(|(h, _)| *h)
    }
}

impl Server {
    /// About how many servers the room has (the tests; the page's details may show it).
    pub fn room_servers(&self) -> u32 {
        self.out.servers.unwrap_or(1)
    }

    /// Notes what item `id` holds that the server asks about: its blocks (arrived at `since`) and its pending renewals.
    pub(super) fn note(&mut self, id: &[u8; 32], since: u64) {
        let Some(h) = self.reg.get(id) else { return };
        let unix = self.last_unix;
        for e in h.name.entries() {
            if let Some(a) = e.anchor() {
                self.out
                    .blocks
                    .entry(a.header.hash())
                    .or_insert_with(|| Block {
                        state: State::Unchecked { next: 0, tries: 0 },
                        at: since,
                        header: Some(a.header),
                    });
            } else if let Some(p) = e.pending() {
                self.out.finishing.entry(e.id()).or_insert_with(|| Finish {
                    name: *id,
                    pending: p.clone(),
                    seen: unix,
                    slot: None,
                    busy: false,
                });
            }
        }
    }

    /// The registry as it is now (every minute): blocks no anchor is in any more forgotten (a refused one after a
    /// day), new ones noted; renewals anchored or gone no longer asked for.
    pub(super) fn outside_scan(&mut self, unix: u64) {
        let mut blocks: BTreeMap<[u8; 32], Header> = BTreeMap::new();
        let mut pending: BTreeMap<[u8; 32], ([u8; 32], Pending)> = BTreeMap::new();
        for (id, h) in &self.reg.items {
            for e in h.name.entries() {
                if let Some(a) = e.anchor() {
                    blocks.insert(a.header.hash(), a.header);
                } else if let Some(p) = e.pending() {
                    pending.insert(e.id(), (*id, p.clone()));
                }
            }
        }
        let mut forget = Vec::new();
        self.out.blocks.retain(|hash, b| {
            let keep = match b.state {
                State::Refused => unix < b.at + REFUSED_FOR,
                _ => blocks.contains_key(hash),
            };
            if !keep && matches!(b.state, State::Checked | State::Refused) {
                forget.push(*hash);
            }
            keep
        });
        for hash in forget {
            self.cmds.push_back(Cmd::Store {
                id: hash,
                record: None,
            });
        }
        for (hash, header) in blocks {
            let b = self.out.blocks.entry(hash).or_insert(Block {
                state: State::Unchecked { next: 0, tries: 0 },
                at: unix,
                header: Some(header),
            });
            b.header.get_or_insert(header);
        }
        self.out
            .finishing
            .retain(|eid, f| pending.get(eid).is_some_and(|(_, p)| *p == f.pending));
        for (eid, (name, p)) in pending {
            self.out.finishing.entry(eid).or_insert(Finish {
                name,
                pending: p,
                seen: unix,
                slot: None,
                busy: false,
            });
        }
    }

    fn at_unix(&self, t: u64) -> Instant {
        self.now + Duration::from_secs(t.saturating_sub(self.last_unix))
    }

    pub(super) fn outside_deadline(&self) -> Option<Instant> {
        self.key?;
        let fetches = self.out.fetches.values().map(|(_, t)| *t).min();
        let unix = self.last_unix;
        let blocks = (self.out.blocks.values())
            .filter_map(|b| match b.state {
                State::Unchecked { next, .. } if b.header.is_some() => Some(next),
                _ => None,
            })
            .min()
            // Out of room for fetches: when one comes back (or times out, which `fetches` counts).
            .filter(|_| self.out.fetches.len() < FETCHES_MAX)
            .map(|next| {
                let t = self.at_unix(next);
                self.out.next_check.map_or(t, |c| t.max(c))
            });
        let slot = self.params.finish_slot.max(1) as u64;
        let finish = (self.out.finishing.values())
            .filter(|f| !f.busy && self.out.fetches.len() < FETCHES_MAX)
            .map(|f| {
                let start = f.seen + self.params.finish_after as u64;
                if unix < start {
                    start
                } else if f.slot == Some(unix / slot) {
                    (unix / slot + 1) * slot
                } else {
                    unix
                }
            })
            .min()
            .map(|t| self.at_unix(t));
        [fetches, blocks, finish].into_iter().flatten().min()
    }

    /// Asks the page to GET `url`, one of the compiled services' (never one from a record).
    fn fetch(&mut self, url: String, f: Fetch, now: Instant) {
        self.out.next_id = self.out.next_id.wrapping_add(1);
        let id = self.out.next_id;
        self.out.fetches.insert(id, (f, now + FETCH_WAIT));
        self.stats.fetches += 1;
        self.cmds.push_back(Cmd::Fetch { id, url });
    }

    pub(super) fn outside_tick(&mut self, now: Instant, unix: u64) {
        let late: Vec<u32> = (self.out.fetches.iter())
            .filter(|(_, (_, t))| *t <= now)
            .map(|(id, _)| *id)
            .collect();
        for id in late {
            self.fetched(id, 0, &[], now, unix);
        }
        let Some(key) = self.key else { return };
        // A block, at the pace.
        if self.out.fetches.len() < FETCHES_MAX
            && self.out.next_check.is_none_or(|t| now >= t)
            && let Some(hash) = self.out.due_block(unix)
        {
            self.out.next_check =
                Some(now + Duration::from_millis(self.params.check_every_ms as u64));
            let b = self.out.blocks.get_mut(&hash).unwrap();
            let tries = match b.state {
                State::Unchecked { tries, .. } => tries,
                _ => 0,
            };
            b.state = State::Checking { tries };
            self.check_at(hash, 0, 0, 0, now);
        }
        // Renewals: one decision a slot each.
        let slot_len = self.params.finish_slot.max(1) as u64;
        let slot = unix / slot_len;
        let servers = self.room_servers();
        let mut ask = Vec::new();
        for (eid, f) in self.out.finishing.iter_mut() {
            let start = f.seen + self.params.finish_after as u64;
            if f.busy || unix < start || f.slot == Some(slot) {
                continue;
            }
            f.slot = Some(slot);
            if finish_draw(eid, &key, slot) < finish_chance(servers, unix - start) {
                ask.push((*eid, f.pending.clone()));
            }
        }
        for (eid, p) in ask {
            if self.out.fetches.len() >= FETCHES_MAX {
                // Out of room: decided again next slot.
                self.out.finishing.get_mut(&eid).unwrap().slot = None;
                continue;
            }
            let Some(c) = p.commitment(&eid) else {
                continue;
            };
            self.out.finishing.get_mut(&eid).unwrap().busy = true;
            let url = format!("{}/timestamp/{}", Calendar::url(p.calendar), hex(&c));
            self.fetch(url, Fetch::Proof { eid }, now);
        }
    }

    fn check_at(&mut self, hash: [u8; 32], explorer: usize, denied: u8, tried: u8, now: Instant) {
        let url = format!("{}/block/{}/header", EXPLORERS[explorer], shown(&hash));
        let f = Fetch::Block {
            hash,
            explorer,
            denied,
            tried: tried | 1 << explorer,
        };
        self.fetch(url, f, now);
    }

    /// The page's answer to fetch `id`.
    pub(super) fn fetched(&mut self, id: u32, status: u16, body: &[u8], now: Instant, unix: u64) {
        let Some((f, _)) = self.out.fetches.remove(&id) else {
            return;
        };
        let text = std::str::from_utf8(body).unwrap_or("").trim();
        match f {
            Fetch::Block {
                hash,
                explorer,
                mut denied,
                tried,
            } => {
                let Some(b) = self.out.blocks.get(&hash) else {
                    return;
                };
                if !matches!(b.state, State::Checking { .. }) {
                    return;
                }
                let ours = b.header.map(|h| hex(&h.0));
                if status == 200 && ours.is_some_and(|h| text.eq_ignore_ascii_case(&h)) {
                    return self.block_verdict(hash, State::Checked, unix);
                }
                if status == 404 {
                    denied |= 1 << explorer;
                }
                if let Some(other) = (0..EXPLORERS.len()).find(|e| tried & 1 << e == 0) {
                    return self.check_at(hash, other, denied, tried, now);
                }
                if denied == (1 << EXPLORERS.len()) - 1 {
                    return self.block_verdict(hash, State::Refused, unix);
                }
                // One that couldn't be reached: asked again later.
                let b = self.out.blocks.get_mut(&hash).unwrap();
                let tries = match b.state {
                    State::Checking { tries } => tries,
                    _ => 0,
                };
                let wait = (CHECK_AGAIN << tries.min(10)).min(CHECK_AGAIN_MAX);
                b.state = State::Unchecked {
                    next: unix + wait,
                    tries: tries + 1,
                };
            }
            Fetch::Proof { eid } => {
                let Some(fin) = self.out.finishing.get_mut(&eid) else {
                    return;
                };
                fin.busy = false;
                if status != 200 {
                    return; // pending (a 404), or no answer: the next slot decides again
                }
                let anchors = match fin.pending.finish(&eid, body) {
                    Ok(a) => a,
                    Err(e) => return self.log(format!("a calendar's proof refused: {e:?}")),
                };
                let Some(anchor) = anchors.into_iter().next() else {
                    return self.log("a calendar's proof with no Bitcoin attestation".into());
                };
                fin.busy = true;
                self.height_at(eid, anchor, 0, 0, now);
            }
            Fetch::Height {
                eid,
                anchor,
                explorer,
                tried,
                hash,
            } => {
                let done = |s: &mut Server, why: &str| {
                    if let Some(f) = s.out.finishing.get_mut(&eid) {
                        f.busy = false;
                    }
                    if !why.is_empty() {
                        s.log(format!("a renewal not finished: {why}"));
                    }
                };
                let other = (0..EXPLORERS.len()).find(|e| tried & 1 << e == 0);
                let next = |s: &mut Server, why: &str| match other {
                    Some(e) => s.height_at(eid, anchor.clone(), e, tried, now),
                    None => done(s, why),
                };
                if status != 200 {
                    return next(self, "");
                }
                let Some(hash) = hash else {
                    // The block's hash at the height: its header next, at the same explorer.
                    if text.len() != 64 || unhex(text).is_none() {
                        return next(self, "an explorer's block hash isn't one");
                    }
                    let url = format!(
                        "{}/block/{}/header",
                        EXPLORERS[explorer],
                        text.to_ascii_lowercase()
                    );
                    let f = Fetch::Height {
                        eid,
                        anchor,
                        explorer,
                        tried,
                        hash: Some(text.to_ascii_lowercase()),
                    };
                    return self.fetch(url, f, now);
                };
                let header = unhex(text).and_then(|b| Header::from_bytes(&b));
                let Some(header) = header else {
                    return next(self, "an explorer's header isn't one");
                };
                if shown(&header.hash()) != hash || anchor.root(&eid) != Some(header.merkle_root())
                {
                    return next(self, "the explorer's block there isn't the anchor's");
                }
                done(self, "");
                let Some(fin) = self.out.finishing.get(&eid) else {
                    return;
                };
                let name = fin.name;
                let Some(e) = self.reg.get(&name).and_then(|h| h.name.get(&eid)) else {
                    return;
                };
                let w = WireEntry {
                    entry: e.entry.clone(),
                    anchor: Some((anchor, header)),
                    pending: None,
                };
                self.stats.finished += 1;
                self.log(format!("a renewal finished: {}", hex(&eid[..4])));
                // The explorer gave the header for that height, and it is the anchor's: the block is checked too.
                let b = self.out.blocks.entry(header.hash()).or_insert(Block {
                    state: State::Checking { tries: 0 },
                    at: unix,
                    header: Some(header),
                });
                if b.state != State::Refused {
                    b.state = State::Checking { tries: 0 };
                    self.block_verdict(header.hash(), State::Checked, unix);
                }
                // Checked and kept as anything put is: stored, and told to the servers it syncs with.
                self.puts.push_back(Job::new(
                    None,
                    Item {
                        id: name,
                        entries: vec![w],
                        zone: None,
                    },
                ));
            }
        }
    }

    fn height_at(
        &mut self,
        eid: [u8; 32],
        anchor: Anchor,
        explorer: usize,
        tried: u8,
        now: Instant,
    ) {
        let url = format!("{}/block-height/{}", EXPLORERS[explorer], anchor.height);
        let f = Fetch::Height {
            eid,
            anchor,
            explorer,
            tried: tried | 1 << explorer,
            hash: None,
        };
        self.fetch(url, f, now);
    }

    fn block_record(hash: &[u8; 32], state: State, at: u64) -> Vec<u8> {
        let mut r = vec![BLOCK_RECORD, if state == State::Refused { 2 } else { 1 }];
        r.extend_from_slice(&at.to_le_bytes());
        r.extend_from_slice(hash);
        r
    }

    /// Block `hash` checked, or refused with every anchor in it.
    fn block_verdict(&mut self, hash: [u8; 32], state: State, unix: u64) {
        let Some(b) = self.out.blocks.get_mut(&hash) else {
            return;
        };
        b.state = state;
        b.at = unix;
        self.cmds.push_back(Cmd::Store {
            id: hash,
            record: Some(Self::block_record(&hash, state, unix)),
        });
        if state == State::Refused {
            self.stats.blocks_refused += 1;
            self.log(format!("a block both explorers denied: {}", shown(&hash)));
            self.drop_anchors_in(&hash, unix);
        } else {
            self.stats.blocks_checked += 1;
        }
    }

    /// Every anchor in block `hash` dropped from the registry: their entries count for nothing until another comes.
    fn drop_anchors_in(&mut self, hash: &[u8; 32], unix: u64) {
        let ids: Vec<[u8; 32]> = (self.reg.items.iter())
            .filter(|(_, h)| {
                (h.name.entries()).any(|e| e.anchor().is_some_and(|a| a.header.hash() == *hash))
            })
            .map(|(id, _)| *id)
            .collect();
        for id in ids {
            let h = self.reg.items.get_mut(&id).unwrap();
            let eids: Vec<[u8; 32]> = (h.name.entries())
                .filter(|e| e.anchor().is_some_and(|a| a.header.hash() == *hash))
                .map(|e| e.id())
                .collect();
            for e in eids {
                h.name.get_mut(&e).unwrap().drop_anchor();
            }
            self.reg.settle(&id, &self.params, unix);
            self.stored(&id);
            self.tell(id, None);
        }
    }

    /// A block's check, stored ([`BLOCK_RECORD`]): taken back unless a refusal has lapsed.
    pub(super) fn load_block(&mut self, r: &[u8], unix: u64) -> bool {
        if r.len() != 42 || !matches!(r[1], 1 | 2) {
            return false;
        }
        let at = u64::from_le_bytes(r[2..10].try_into().unwrap());
        let hash: [u8; 32] = r[10..].try_into().unwrap();
        let state = if r[1] == 2 {
            State::Refused
        } else {
            State::Checked
        };
        if state == State::Refused && unix >= at + REFUSED_FOR {
            return false;
        }
        let header = self.out.blocks.get(&hash).and_then(|b| b.header);
        self.out.blocks.insert(hash, Block { state, at, header });
        if state == State::Refused {
            self.drop_anchors_in(&hash, unix);
        }
        true
    }
}
