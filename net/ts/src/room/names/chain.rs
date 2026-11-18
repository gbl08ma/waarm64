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

use std::{cmp::Ordering, collections::BTreeSet};

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
    /// The run's first entry is a claim: its seniority is the title's, not a renewal's seen alone.
    pub claimed: bool,
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
    entries: Entries,
}

/// A name's entries by id, in order: a sorted `Vec` of exactly their number, not a `BTreeMap` (NAMES loop 6b: a map's
/// node holds 11 entries of ~400 bytes whatever it holds, and a name has two or three, so ~4 KB a name went to empty
/// slots, a third of a server's memory).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct Entries(Vec<Stamped>);

impl Entries {
    fn at(&self, id: &[u8; 32]) -> Result<usize, usize> {
        self.0.binary_search_by(|s| s.id().cmp(id))
    }

    fn get(&self, id: &[u8; 32]) -> Option<&Stamped> {
        self.at(id).ok().map(|i| &self.0[i])
    }

    fn get_mut(&mut self, id: &[u8; 32]) -> Option<&mut Stamped> {
        self.at(id).ok().map(|i| &mut self.0[i])
    }

    fn contains_key(&self, id: &[u8; 32]) -> bool {
        self.at(id).is_ok()
    }

    /// A new entry (one held is merged by the caller).
    fn insert(&mut self, s: Stamped) {
        if let Err(i) = self.at(&s.id()) {
            // Exactly one more: a Vec's growth would hold four for one entry, at ~400 bytes each.
            self.0.reserve_exact(1);
            self.0.insert(i, s);
        }
    }

    fn retain(&mut self, mut keep: impl FnMut(&[u8; 32], &Stamped) -> bool) {
        self.0.retain(|s| keep(&s.id(), s));
        if self.0.capacity() > self.0.len() + 1 {
            self.0.shrink_to_fit();
        }
    }

    fn values(&self) -> std::slice::Iter<'_, Stamped> {
        self.0.iter()
    }

    fn values_mut(&mut self) -> std::slice::IterMut<'_, Stamped> {
        self.0.iter_mut()
    }

    fn len(&self) -> usize {
        self.0.len()
    }

    fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl Name {
    pub fn new(id: [u8; 32]) -> Name {
        Name {
            id,
            entries: Entries::default(),
        }
    }

    /// Adds an entry checked elsewhere, or merges it into the copy held (its anchor if earlier,
    /// its pending). False when it is another name's or adds nothing.
    pub fn insert(&mut self, s: Stamped) -> bool {
        if s.entry.name != self.id {
            return false;
        }
        match self.entries.get_mut(&s.id()) {
            Some(held) => held.merge(s),
            None => {
                self.entries.insert(s);
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

    /// The entries a release ends: every other entry of the owner's that follows an entry an anchored release validly
    /// follows, and everything of the owner's after those. **A release beats any sibling branch at its parent**, whatever
    /// the times (the final review's finding 4: a renewal the servers held and finished after Let it go was pressed,
    /// made on the same entry as the release, outlived it by a term). Only the owner key signs a release, so only it
    /// can end its branches. Releases themselves are never ended (two releases at one entry both stand).
    fn released_past(&self, params: &Params) -> BTreeSet<[u8; 32]> {
        let mut ended: BTreeSet<[u8; 32]> = BTreeSet::new();
        let let_go: BTreeSet<[u8; 32]> = (self.entries.values())
            .filter(|r| r.entry.kind == Kind::Release)
            .filter_map(|r| self.parent(r, params))
            .map(Stamped::id)
            .collect();
        if let_go.is_empty() {
            return ended;
        }
        let owners = |e: &Stamped| {
            (self.entries.get(&e.entry.prev)).is_some_and(|p| p.entry.owner == e.entry.owner)
        };
        // The release's siblings, then everything after them (a release on an ended branch too).
        let mut from: BTreeSet<[u8; 32]> = (self.entries.values())
            .filter(|e| {
                e.entry.kind != Kind::Release && let_go.contains(&e.entry.prev) && owners(e)
            })
            .map(Stamped::id)
            .collect();
        while !from.is_empty() {
            ended.extend(from.iter().copied());
            from = (self.entries.values())
                .filter(|e| from.contains(&e.entry.prev) && !ended.contains(&e.id()) && owners(e))
                .map(Stamped::id)
                .collect();
        }
        ended
    }

    /// Every chain held: each unbroken run to a leaf (an entry no valid step follows). An entry a release ended
    /// ([`Name::released_past`]) is on none.
    pub fn chains(&self, params: &Params) -> Vec<Chain> {
        let ended = self.released_past(params);
        let mut inner = BTreeSet::new();
        for c in self.entries.values() {
            if c.time().is_some()
                && !ended.contains(&c.id())
                && let Some(p) = self.parent(c, params)
            {
                inner.insert(p.id());
            }
        }
        let mut out = Vec::new();
        for leaf in self.entries.values() {
            if leaf.time().is_none() || inner.contains(&leaf.id()) || ended.contains(&leaf.id()) {
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

    /// Until when unanchored entry `s` could still link: the entry before it's `t + TERM + GRACE`, when that entry is
    /// held and anchored. None for a claim (an anchor at any time makes it a claim then), or while the entry before
    /// isn't known.
    pub fn link_end(&self, s: &Stamped, params: &Params) -> Option<u64> {
        if s.entry.kind == Kind::Claim {
            return None;
        }
        let t = self.entries.get(&s.entry.prev)?.time()?;
        Some(t as u64 + params.term as u64 + params.grace as u64)
    }

    /// Whether unanchored entry `s` can no longer link at `now`: past [`Name::link_end`] (room-names.md "Records": a
    /// pending anchor is dropped then). An anchor in a block timed before it, collected late, still links.
    pub fn stale(&self, s: &Stamped, params: &Params, now: u64) -> bool {
        self.link_end(s, params).is_some_and(|end| now > end)
    }

    /// Drops what can no longer change an answer: the entries of chains that are dead at `now`
    /// (a released one kept as a tombstone until its cover would have ended), unanchored entries
    /// that can no longer link ([`Name::stale`], or the entry before is gone), and pending anchors that aren't on a chain's
    /// last entry or whose entry can no longer link. A chain dead as held comes back only with a
    /// later renewal, which arrives with its run (the owner's title carries it).
    pub fn prune(&mut self, params: &Params, now: u64) {
        let chains = self.chains(params);
        let live: BTreeSet<[u8; 32]> = chains
            .iter()
            .filter(|c| c.keep_until > now)
            .flat_map(|c| c.ids.iter().copied())
            .collect();
        let lasts: BTreeSet<[u8; 32]> = chains.iter().map(Chain::last).collect();
        // An unanchored renewal whose entry before is gone (dead, dropped by an earlier prune) can't link here either.
        let stale: BTreeSet<[u8; 32]> = (self.entries.values())
            .filter(|e| {
                e.time().is_none()
                    && (self.stale(e, params, now)
                        || e.entry.kind != Kind::Claim && !self.entries.contains_key(&e.entry.prev))
            })
            .map(Stamped::id)
            .collect();
        self.entries.retain(|id, e| {
            if e.time().is_some() {
                live.contains(id)
            } else {
                !stale.contains(id)
            }
        });
        // An unanchored entry is its run's last as long as nothing anchored follows it.
        let followed: BTreeSet<[u8; 32]> = self.entries.values().map(|e| e.entry.prev).collect();
        for e in self.entries.values_mut() {
            let id = &e.id();
            let last = if e.time().is_some() {
                lasts.contains(id)
            } else {
                !followed.contains(id)
            };
            if !last {
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
    tie.update(first.anchor().unwrap().header.hash());
    tie.update(first.id());
    Chain {
        ids: run.iter().map(|s| s.id()).collect(),
        owner: first.entry.owner,
        seniority: t(first) as u32,
        claimed: first.entry.kind == Kind::Claim,
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
    /// `earliest` is a claim's time (a run from its claim was verified), not a renewal's seen alone.
    pub whole: bool,
}

impl Kept {
    pub fn new(chain: Chain) -> Kept {
        Kept {
            earliest: chain.seniority,
            whole: chain.claimed,
            chain,
        }
    }

    /// A chain shown for the name (verified, covering now): taken when it continues the one kept
    /// (it holds the kept last entry; the earliest time stays the lower), or replaces it: the kept
    /// chain no longer covers now, the shown run starts earlier than the kept title's claim (while
    /// no claim of it was seen, only a run of the same key does), or it is another branch of the
    /// same title (the same owner key) starting no later. True when
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
            self.whole |= c.claimed;
            self.chain = c.clone();
            return true;
        }
        // Another key's run starting earlier wins only against an earliest time that is a claim's: a renewal seen alone
        // (a first lookup keeps the last entry) is no title's start, and a back-order claimed after the title's claim
        // but before that renewal would look older (review 3, finding 1).
        let replace = !self.chain.covers(now)
            || c.seniority < self.earliest && (self.whole || c.owner == self.chain.owner)
            || c.owner == self.chain.owner && c.seniority <= self.earliest;
        if replace {
            *self = Kept::new(c.clone());
        }
        replace
    }
}
