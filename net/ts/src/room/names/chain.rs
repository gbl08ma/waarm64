//! Who owns a name (room-names.md "Who owns a name"): chains, their cover and seniority, the owner
//! now as a total order, and what a member keeps.
//!
//! A [`Name`] holds every entry a node has of one name id, each with its one anchor: the entries
//! form a tree by `prev`. An unbroken run is a path in it whose every step is a valid link (the
//! same owner key and name, the entry before named, a time not before that entry's and at most its
//! `t + TERM + GRACE`, nothing after a release); a chain is such a run to a leaf. Entries without
//! an anchor count for nothing (a run through one breaks there). The owner is computed from all
//! the entries held, so nodes that hold the same entries with the same anchors agree, whatever
//! order they got them in.

use std::{
    cmp::Ordering,
    collections::{BTreeMap, BTreeSet},
};

use sha2::{Digest, Sha256};

use super::{
    Params,
    entry::{Kind, Stamped},
};

/// An unbroken run to a leaf, as a node holds it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chain {
    /// The entries' ids, first to last.
    pub ids: Vec<[u8; 32]>,
    pub owner: [u8; 32],
    /// The time of the first entry of the run.
    pub seniority: u32,
    /// The cover's start: the seniority less `drift`, as a block's time may run that far ahead of a node's clock (a
    /// chain anchored in such a block is alive as soon as it can be checked).
    pub cover_start: u64,
    /// SHA-256 of the first entry's anchor block's hash and its id: the tie-break.
    pub tie: [u8; 32],
    /// The cover's end: the last entry's `t + TERM + GRACE`, or a release's own time.
    pub cover_end: u64,
    /// The last renewal's (or claim's) `t + TERM`: the name resolves before it.
    pub resolve_end: u64,
    /// Until when a node keeps the chain: a released one, as a tombstone, until its cover would
    /// have ended without the release.
    pub keep_until: u64,
    pub released: bool,
}

impl Chain {
    pub fn first(&self) -> [u8; 32] {
        self.ids[0]
    }

    pub fn last(&self) -> [u8; 32] {
        *self.ids.last().unwrap()
    }

    pub fn covers(&self, now: u64) -> bool {
        self.cover_start <= now && now < self.cover_end
    }

    /// Whether the name resolves to this chain's zone at `now` (the chain owning it): in the
    /// grace after the last term it resolves for nobody.
    pub fn resolves(&self, now: u64) -> bool {
        self.covers(now) && now < self.resolve_end
    }

    /// Whether `self` is `other` with a release after it.
    fn releases(&self, other: &Chain) -> bool {
        self.released && self.ids.len() == other.ids.len() + 1 && self.ids.starts_with(&other.ids)
    }
}

/// The order of chains, best first: the earlier seniority; equal, the lower tie hash. The same
/// first entry (a fork, or one a longer copy of the other): a chain with a release beats the same
/// chain without it; else the cover that ends later, then the lower last id. A total order.
pub fn order(a: &Chain, b: &Chain) -> Ordering {
    a.seniority
        .cmp(&b.seniority)
        .then(a.tie.cmp(&b.tie))
        .then_with(|| {
            if a.releases(b) {
                Ordering::Less
            } else if b.releases(a) {
                Ordering::Greater
            } else {
                b.cover_end.cmp(&a.cover_end).then(a.last().cmp(&b.last()))
            }
        })
}

/// Every entry a node holds of one name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Name {
    pub id: [u8; 32],
    entries: BTreeMap<[u8; 32], Stamped>,
}

impl Name {
    pub fn new(id: [u8; 32]) -> Name {
        Name {
            id,
            entries: BTreeMap::new(),
        }
    }

    /// Adds an entry checked elsewhere, or merges it into the copy held (its anchor if earlier,
    /// its pending). False when it is another name's or adds nothing.
    pub fn insert(&mut self, s: Stamped, params: &Params, now: u64) -> bool {
        if s.entry.name != self.id {
            return false;
        }
        match self.entries.get_mut(&s.id()) {
            Some(held) => held.merge(s, params, now),
            None => {
                self.entries.insert(s.id(), s);
                true
            }
        }
    }

    /// Keeps only the entries `keep` says (a server's one chain a name: store.rs).
    pub fn retain(&mut self, mut keep: impl FnMut(&[u8; 32], &Stamped) -> bool) {
        self.entries.retain(|id, s| keep(id, s));
    }

    pub fn get(&self, id: &[u8; 32]) -> Option<&Stamped> {
        self.entries.get(id)
    }

    pub fn get_mut(&mut self, id: &[u8; 32]) -> Option<&mut Stamped> {
        self.entries.get_mut(id)
    }

    pub fn entries(&self) -> impl Iterator<Item = &Stamped> {
        self.entries.values()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// The entry `c` follows on an unbroken run, if `c`'s `prev` is held and the step is valid.
    fn parent(&self, c: &Stamped, params: &Params) -> Option<&Stamped> {
        let p = self.entries.get(&c.entry.prev)?;
        link(p, c, params).then_some(p)
    }

    /// Every chain held: each unbroken run to a leaf (an entry no valid step follows).
    pub fn chains(&self, params: &Params) -> Vec<Chain> {
        let mut inner = BTreeSet::new();
        for c in self.entries.values() {
            if c.time().is_some()
                && let Some(p) = self.parent(c, params)
            {
                inner.insert(p.id());
            }
        }
        let mut out = Vec::new();
        for leaf in self.entries.values() {
            if leaf.time().is_none() || inner.contains(&leaf.id()) {
                continue;
            }
            let mut run = vec![leaf];
            while let Some(p) = self.parent(run.last().unwrap(), params) {
                run.push(p);
            }
            run.reverse();
            out.push(chain(&run, params));
        }
        out
    }

    /// The owning chain at `now`: of the chains that cover now, the best by [`order`].
    pub fn owner(&self, params: &Params, now: u64) -> Option<Chain> {
        self.chains(params)
            .into_iter()
            .filter(|c| c.covers(now))
            .min_by(order)
    }

    /// The unbroken run ending at `last` (what `history` answers), first to last.
    pub fn run(&self, last: &[u8; 32], params: &Params) -> Vec<&Stamped> {
        let Some(mut e) = self.entries.get(last).filter(|e| e.time().is_some()) else {
            return Vec::new();
        };
        let mut run = vec![e];
        while let Some(p) = self.parent(e, params) {
            run.push(p);
            e = p;
        }
        run.reverse();
        run
    }

    /// Drops what can no longer change an answer: the entries of chains that are dead at `now`
    /// (a released one kept as a tombstone until its cover would have ended), unanchored entries
    /// that can no longer be anchored in their window, and pending anchors that aren't on a
    /// chain's last entry or can no longer finish. A chain dead as held comes back only with a
    /// later renewal, which arrives with its run (the owner's title carries it).
    pub fn prune(&mut self, params: &Params, now: u64) {
        let chains = self.chains(params);
        let live: BTreeSet<[u8; 32]> = chains
            .iter()
            .filter(|c| c.keep_until > now)
            .flat_map(|c| c.ids.iter().copied())
            .collect();
        let lasts: BTreeSet<[u8; 32]> = chains.iter().map(Chain::last).collect();
        self.entries.retain(|id, e| {
            if e.time().is_some() {
                live.contains(id)
            } else {
                !e.pending_stale(params, now)
            }
        });
        // An unanchored entry is its run's last as long as nothing anchored follows it.
        let followed: BTreeSet<[u8; 32]> = self.entries.values().map(|e| e.entry.prev).collect();
        for (id, e) in self.entries.iter_mut() {
            let last = if e.time().is_some() {
                lasts.contains(id)
            } else {
                !followed.contains(id)
            };
            if !last || e.pending_stale(params, now) {
                e.drop_pending();
            }
        }
    }
}

/// Whether `c` validly follows `p` on an unbroken run. Both need anchors.
fn link(p: &Stamped, c: &Stamped, params: &Params) -> bool {
    let (Some(tp), Some(tc)) = (p.time(), c.time()) else {
        return false;
    };
    c.entry.kind != Kind::Claim
        && p.entry.kind != Kind::Release
        && c.entry.prev == p.id()
        && c.entry.owner == p.entry.owner
        && c.entry.name == p.entry.name
        && tc >= tp
        && tc as u64 <= tp as u64 + params.term as u64 + params.grace as u64
}

/// A run, first to last, all anchored, as a [`Chain`].
fn chain(run: &[&Stamped], params: &Params) -> Chain {
    let first = run[0];
    let last = run[run.len() - 1];
    let (term, grace) = (params.term as u64, params.grace as u64);
    let t = |s: &Stamped| s.time().unwrap() as u64;
    let released = last.entry.kind == Kind::Release;
    // The last entry that holds the name (not a release), if any.
    let held = run.iter().rev().find(|s| s.entry.kind != Kind::Release);
    let (cover_end, resolve_end, keep_until) = if released {
        let r = t(last);
        let kept = held.map_or(r, |h| t(h) + term + grace);
        (r, held.map_or(r, |h| (t(h) + term).min(r)), kept)
    } else {
        let end = t(last) + term + grace;
        (end, t(last) + term, end)
    };
    let mut tie = Sha256::new();
    tie.update(first.anchor().unwrap().run.block.hash());
    tie.update(first.id());
    Chain {
        ids: run.iter().map(|s| s.id()).collect(),
        owner: first.entry.owner,
        seniority: t(first) as u32,
        cover_start: t(first).saturating_sub(params.drift as u64),
        tie: tie.finalize().into(),
        cover_end,
        resolve_end,
        keep_until,
        released,
    }
}

/// What a member keeps of a name it resolved (room-names.md "A member resolving a name"): the
/// chain it took, and the earliest entry time it ever verified for that chain. While that chain
/// covers now, another replaces it only by showing a run that starts earlier, so a member that
/// knew a name refuses an impersonator after a reset.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Kept {
    pub chain: Chain,
    pub earliest: u32,
}

impl Kept {
    pub fn new(chain: Chain) -> Kept {
        Kept {
            earliest: chain.seniority,
            chain,
        }
    }

    /// A chain shown for the name (verified, covering now): taken when it continues the one kept
    /// (it holds the kept last entry; the earliest time stays the lower), or replaces it: the kept
    /// chain no longer covers now, the shown run starts earlier than anything verified for it, or
    /// it is another branch of the same title (the same owner key) starting no later. True when
    /// taken. A run that holds neither (a renewal shown alone, as a server answers `get`) is
    /// refused while the kept chain covers: the member asks for `history` and offers the run.
    pub fn offer(&mut self, c: &Chain, now: u64) -> bool {
        // A copy of what is kept, cut short (a stale copy without the release, say): nothing new.
        if !c.covers(now)
            || self.chain.ids.contains(&c.last()) && c.ids.len() < self.chain.ids.len()
        {
            return false;
        }
        if c.ids.contains(&self.chain.last()) {
            self.earliest = self.earliest.min(c.seniority);
            self.chain = c.clone();
            return true;
        }
        let replace = !self.chain.covers(now)
            || c.seniority < self.earliest
            || c.owner == self.chain.owner && c.seniority <= self.earliest;
        if replace {
            *self = Kept::new(c.clone());
        }
        replace
    }
}
