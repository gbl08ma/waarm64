//! A server's registry (room-names.md "Servers"): per name, the entries it keeps, its zone, when
//! it was last asked for, and what range sync compares.
//!
//! **What is kept of a name** is a function of the entries held and the time, the same on every
//! server ([`Held::settle`]): the owning chain's whole run (chain.rs, from every entry held, so the
//! order entries arrived in can't matter), the unanchored renewals that continue it (at most
//! [`MAX_PENDING`], the lowest ids), and released chains still kept as tombstones that would beat
//! the owner without their release (at most [`MAX_TOMBSTONES`]); the zone only if the owner signed
//! it. Everything else is dropped: a worse chain offered is refused. Two servers that exchange
//! what they lack and settle hold the same: a run that one holds cut short (a last anchor
//! missing, so it looked dead) is only ever worse than the whole run the other sends.

use std::collections::{BTreeMap, BTreeSet};

use blake2::{Blake2s256, Digest};
use sha2::Sha256;

use super::{
    Params,
    chain::{Chain, Name, order},
    entry::{Kind, Stamped},
    wire::{Fp, Held as HeldTag, Item, Range, Rd, WireEntry},
    zone::Zone,
};

/// Unanchored renewals kept on the owning chain's last entry (a fork of a title renewed in two
/// browsers at once makes two).
pub const MAX_PENDING: usize = 2;
pub const MAX_TOMBSTONES: usize = 2;
/// A server takes a new zone for a name at most this often (room-names.md "Records").
pub const ZONE_EVERY: u64 = 600;
const RECORD_VERSION: u8 = 1;

/// 4 bytes of an entry's anchor's digest (its block, its operations, the six headers after the block; zeros:
/// unanchored): what a `get` says it holds.
pub fn anchor_tag(s: &Stamped) -> [u8; 4] {
    match s.anchor() {
        Some(a) => {
            let mut h = Sha256::new();
            h.update(a.run.block.hash());
            h.update(a.anchor.encode());
            for f in a.run.next_hashes() {
                h.update(f);
            }
            h.finalize()[..4].try_into().unwrap()
        }
        None => [0; 4],
    }
}

pub fn zone_tag(z: Option<&Zone>) -> (u64, [u8; 4]) {
    match z {
        Some(z) => (z.seq, Sha256::digest(z.encode())[..4].try_into().unwrap()),
        None => (0, [0; 4]),
    }
}

/// One name as a server holds it.
#[derive(Debug, Clone)]
pub struct Held {
    pub name: Name,
    pub zone: Option<Zone>,
    /// When the zone was taken (Unix seconds).
    zone_at: u64,
    /// The owning chain, as of the last settle.
    pub owner: Option<Chain>,
    /// What range sync compares: 8 bytes over the entries kept, their anchors and the zone.
    pub version: [u8; 8],
    /// Its encoded size.
    pub bytes: usize,
    /// When it was last asked for by a member, or came (Unix seconds): the bound drops the
    /// longest unasked first.
    pub asked: u64,
    /// When time alone may next change what is kept.
    next_change: u64,
}

impl Held {
    pub fn new(id: [u8; 32], now: u64) -> Held {
        Held {
            name: Name::new(id),
            zone: None,
            zone_at: 0,
            owner: None,
            version: [0; 8],
            bytes: 0,
            asked: now,
            next_change: u64::MAX,
        }
    }

    pub fn id(&self) -> [u8; 32] {
        self.name.id
    }

    pub fn is_empty(&self) -> bool {
        self.name.is_empty()
    }

    /// Applies the rule of what is kept at `now`; true when the version changed.
    pub fn settle(&mut self, params: &Params, now: u64) -> bool {
        let chains = self.name.chains(params);
        let owner = chains
            .iter()
            .filter(|c| c.covers(now))
            .min_by(|a, b| order(a, b));
        let mut keep: BTreeSet<[u8; 32]> = BTreeSet::new();
        let mut next = u64::MAX;
        if let Some(o) = owner {
            keep.extend(o.ids.iter().copied());
            next = next.min(o.cover_end);
            // Renewals on its last entry waiting for their anchors.
            let mut pending: Vec<&Stamped> = self
                .name
                .entries()
                .filter(|e| {
                    e.time().is_none()
                        && e.entry.kind != Kind::Claim
                        && e.entry.prev == o.last()
                        && e.entry.owner == o.owner
                        && !e.pending_stale(params, now)
                })
                .collect();
            pending.sort_by_key(|e| e.id());
            for e in pending.into_iter().take(MAX_PENDING) {
                keep.insert(e.id());
                next = next.min(e.window(params).1 + params.pending_slack as u64 + 1);
            }
        }
        // Tombstones: released chains, until their cover would have ended, that would beat the
        // owner without the release (or there is none).
        let mut tombs: Vec<&Chain> = chains
            .iter()
            .filter(|c| {
                c.released
                    && c.keep_until > now
                    && owner.is_none_or(|o| (c.seniority, c.tie) < (o.seniority, o.tie))
            })
            .collect();
        tombs.sort_by(|a, b| order(a, b));
        for t in tombs.into_iter().take(MAX_TOMBSTONES) {
            keep.extend(t.ids.iter().copied());
            next = next.min(t.keep_until);
        }
        // A chain whose cover is still ahead may own later (none passed a header check, which allows `drift`).
        for c in &chains {
            if c.cover_start > now {
                next = next.min(c.cover_start);
            }
        }
        self.name.retain(|id, _| keep.contains(id));
        self.owner = owner.cloned();
        if self
            .zone
            .as_ref()
            .is_some_and(|z| self.owner.as_ref().is_none_or(|o| o.owner != z.owner))
        {
            self.zone = None;
        }
        self.next_change = next;
        let v = self.compute_version();
        let changed = v != self.version;
        self.version = v;
        self.bytes = self.item().encode().len();
        changed
    }

    /// Whether time alone may have changed what is kept since the last settle.
    pub fn stale(&self, now: u64) -> bool {
        now >= self.next_change
    }

    fn compute_version(&self) -> [u8; 8] {
        let mut h = Sha256::new();
        for e in self.name.entries() {
            h.update(e.id());
            h.update(anchor_tag(e));
        }
        if let Some(z) = &self.zone {
            h.update(Sha256::digest(z.encode()));
        }
        h.finalize()[..8].try_into().unwrap()
    }

    /// A zone offered (its signature checked): taken if the owner signed it, it beats the one
    /// held, and (`limit`: one from outside) none was taken in the last [`ZONE_EVERY`] seconds.
    /// True when taken.
    pub fn offer_zone(&mut self, z: Zone, now: u64, limit: bool) -> bool {
        let Some(o) = &self.owner else { return false };
        if z.owner != o.owner || z.name != self.id() {
            return false;
        }
        if let Some(h) = &self.zone
            && (!z.beats(h) || limit && now < self.zone_at + ZONE_EVERY)
        {
            return false;
        }
        self.zone = Some(z);
        self.zone_at = now;
        true
    }

    /// The whole item, as sent and stored.
    pub fn item(&self) -> Item {
        Item {
            id: self.id(),
            entries: self.name.entries().map(WireEntry::of).collect(),
            zone: self.zone.clone(),
        }
    }

    /// What a holder of `held` (and of a zone tagged `zone`) lacks: entries it hasn't, those whose
    /// anchor differs, the zone if ours differs.
    pub fn lacking(&self, held: &[HeldTag], zone: (u64, [u8; 4])) -> Item {
        let theirs: BTreeMap<[u8; 8], [u8; 4]> = held.iter().copied().collect();
        let entries = self
            .name
            .entries()
            .filter(|e| {
                let k: [u8; 8] = e.id()[..8].try_into().unwrap();
                theirs
                    .get(&k)
                    .is_none_or(|a| *a != anchor_tag(e) && e.anchor().is_some())
            })
            .map(WireEntry::of)
            .collect();
        Item {
            id: self.id(),
            entries,
            zone: self.zone.clone().filter(|z| zone_tag(Some(z)) != zone),
        }
    }

    /// A member's `get`: the owning chain's last entry (`history`: its whole run) and the zone, those the asker lacks;
    /// None when no chain owns the name now (the member hears "none"). Unless the member's last entry (in `held`) is
    /// on a released chain kept as a tombstone, off the owning one: then the release and what leads to it from that
    /// entry, so that the member ends what it keeps (review 2: a kept chain without its release covers for weeks, and
    /// the member refuses the next owner meanwhile).
    pub fn owner_answer(
        &self,
        held: &[HeldTag],
        zone: (u64, [u8; 4]),
        history: bool,
        params: &Params,
    ) -> Option<Item> {
        let mut it = Item {
            id: self.id(),
            ..Item::default()
        };
        let has = |id: &[u8; 32]| {
            let k: [u8; 8] = id[..8].try_into().unwrap();
            let e = self.name.get(id);
            held.iter()
                .any(|(i, a)| *i == k && e.is_some_and(|e| *a == anchor_tag(e)))
        };
        if !history {
            let on_owner = |id: &[u8; 32]| self.owner.as_ref().is_some_and(|o| o.ids.contains(id));
            let tomb = (self.name.chains(params).into_iter())
                .filter(|c| c.released)
                .find_map(|c| {
                    let at = c.ids.iter().position(|id| has(id) && !on_owner(id))?;
                    Some(c.ids[at + 1..].to_vec())
                });
            if let Some(ids) = tomb {
                it.entries = ids
                    .iter()
                    .filter_map(|id| self.name.get(id))
                    .map(WireEntry::of)
                    .collect();
                return Some(it);
            }
        }
        let o = self.owner.as_ref()?;
        let ids = if history {
            &o.ids[..]
        } else {
            &o.ids[o.ids.len() - 1..]
        };
        for id in ids {
            let e = self.name.get(id)?;
            if !has(id) {
                it.entries.push(WireEntry::of(e));
            }
        }
        it.zone = self.zone.clone().filter(|z| zone_tag(Some(z)) != zone);
        Some(it)
    }

    /// What this server holds of the name, for its own `get`s.
    pub fn held_tags(&self) -> Vec<HeldTag> {
        self.name
            .entries()
            .map(|e| (e.id()[..8].try_into().unwrap(), anchor_tag(e)))
            .collect()
    }

    /// The stored record: its version byte, when it was last asked for, the item.
    pub fn record(&self) -> Vec<u8> {
        let mut r = vec![RECORD_VERSION];
        r.extend_from_slice(&self.asked.to_le_bytes());
        r.extend(self.item().encode());
        r
    }
}

/// A stored record read back: when it was asked for, and its item (verified when it was taken).
pub fn read_record(b: &[u8]) -> Option<(u64, Item)> {
    let mut r = Rd::new(b);
    if r.u8().ok()? != RECORD_VERSION {
        return None;
    }
    let asked = r.u64().ok()?;
    Some((asked, Item::decode(r.rest()).ok()?))
}

/// A range's summary piece of one item.
fn fp_of(id: &[u8; 32], version: &[u8; 8]) -> [u8; 8] {
    let mut h = Blake2s256::new();
    h.update(id);
    h.update(version);
    h.finalize()[..8].try_into().unwrap()
}

/// Every name a server holds.
#[derive(Default)]
pub struct Registry {
    pub items: BTreeMap<[u8; 32], Held>,
    /// The sum of the items' sizes.
    pub bytes: usize,
}

impl Registry {
    pub fn get(&self, id: &[u8; 32]) -> Option<&Held> {
        self.items.get(id)
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    /// Settles item `id` (after a change, or because time moved it) and keeps the byte count;
    /// an item left with nothing goes. True when its version changed.
    pub fn settle(&mut self, id: &[u8; 32], params: &Params, now: u64) -> bool {
        let Some(h) = self.items.get_mut(id) else {
            return false;
        };
        let before = h.bytes;
        let changed = h.settle(params, now);
        self.bytes = self.bytes - before + h.bytes;
        if h.is_empty() {
            self.bytes -= h.bytes;
            self.items.remove(id);
            return true;
        }
        changed
    }

    /// Settles every item time may have moved (lazily: before a range is summarized or an item
    /// served). The ids whose version changed.
    pub fn settle_due(&mut self, range: &Range, params: &Params, now: u64) -> Vec<[u8; 32]> {
        let (lo, hi) = range.bounds();
        let due: Vec<[u8; 32]> = self
            .items
            .range(lo..=hi)
            .filter(|(_, h)| h.stale(now))
            .map(|(id, _)| *id)
            .collect();
        due.into_iter()
            .filter(|id| self.settle(id, params, now))
            .collect()
    }

    /// The summary of `range`.
    pub fn fp(&self, range: &Range) -> Fp {
        let (lo, hi) = range.bounds();
        let mut f = Fp::default();
        for (id, h) in self.items.range(lo..=hi) {
            let x = fp_of(id, &h.version);
            for (a, b) in f.hash.iter_mut().zip(x) {
                *a ^= b;
            }
            f.count += 1;
        }
        f
    }

    /// Its sixteen sub-ranges' summaries.
    pub fn children(&self, range: &Range) -> [Fp; 16] {
        let mut c = [Fp::default(); 16];
        for (k, f) in c.iter_mut().enumerate() {
            *f = self.fp(&range.child(k as u8));
        }
        c
    }

    pub fn listing(&self, range: &Range) -> Vec<([u8; 8], [u8; 8])> {
        let (lo, hi) = range.bounds();
        self.items
            .range(lo..=hi)
            .map(|(id, h)| (id[..8].try_into().unwrap(), h.version))
            .collect()
    }

    /// The items whose id starts with `prefix` (8 or 32 bytes).
    pub fn matching(&self, prefix: &[u8]) -> Vec<[u8; 32]> {
        let mut lo = [0u8; 32];
        let mut hi = [0xffu8; 32];
        lo[..prefix.len()].copy_from_slice(prefix);
        hi[..prefix.len()].copy_from_slice(prefix);
        self.items.range(lo..=hi).map(|(id, _)| *id).collect()
    }

    /// The bound: past `max_names` or `max_bytes`, the names nobody asked for longest go first,
    /// never one in `own`. The ids dropped.
    pub fn bound(
        &mut self,
        max_names: usize,
        max_bytes: usize,
        own: &BTreeSet<[u8; 32]>,
    ) -> Vec<[u8; 32]> {
        if self.items.len() <= max_names && self.bytes <= max_bytes {
            return Vec::new();
        }
        let mut order: Vec<(u64, [u8; 32])> = self
            .items
            .iter()
            .filter(|(id, _)| !own.contains(*id))
            .map(|(id, h)| (h.asked, *id))
            .collect();
        order.sort();
        let mut dropped = Vec::new();
        for (_, id) in order {
            if self.items.len() <= max_names && self.bytes <= max_bytes {
                break;
            }
            let h = self.items.remove(&id).unwrap();
            self.bytes -= h.bytes;
            dropped.push(id);
        }
        dropped
    }

    /// Puts `h` in (replacing what was held under its id), keeping the byte count.
    pub fn put(&mut self, h: Held) {
        self.bytes += h.bytes;
        if let Some(old) = self.items.insert(h.id(), h) {
            self.bytes -= old.bytes;
        }
    }

    pub fn take(&mut self, id: &[u8; 32]) -> Option<Held> {
        let h = self.items.remove(id)?;
        self.bytes -= h.bytes;
        Some(h)
    }
}
