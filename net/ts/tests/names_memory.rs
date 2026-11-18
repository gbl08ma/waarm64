//! What a server holds a name costs in memory (NAMES loop 6b, bench/net/REPORT.md "NAMES loop 6b": a server's heap was
//! ~4x its registry's bytes). A test crate of its own, for its counting allocator.

use std::{
    alloc::{GlobalAlloc, Layout, System},
    sync::atomic::{AtomicUsize, Ordering::Relaxed},
};

use waarm64_ts::room::names::{
    anchor::{Anchor, Op},
    chain::Name,
    entry::{Anchored, Entry, Kind, Stamped},
    header::Header,
};

struct Counting;
static LIVE: AtomicUsize = AtomicUsize::new(0);

// SAFETY: every call goes to the system allocator with the same layout; the counter is only arithmetic beside it.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        LIVE.fetch_add(l.size(), Relaxed);
        // SAFETY: the caller's layout, passed on.
        unsafe { System.alloc(l) }
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        LIVE.fetch_sub(l.size(), Relaxed);
        // SAFETY: `p` was allocated by `alloc` with `l`.
        unsafe { System.dealloc(p, l) }
    }
}

#[global_allocator]
static A: Counting = Counting;

/// An entry with an anchor of a calendar's depth (30 levels: 62 operations, as real anchors weigh ~1.2 KB).
fn entry(name: [u8; 32], k: u64, prev: [u8; 32]) -> Stamped {
    let e = Entry {
        kind: if prev == [0; 32] {
            Kind::Claim
        } else {
            Kind::Renew
        },
        room: [1; 5],
        name,
        owner: [2; 32],
        prev,
        nonce: k,
        sig: [3; 64],
    };
    let mut ops = vec![Op::Append(vec![4; 16]), Op::Sha256];
    for l in 0..30u8 {
        ops.push(if l % 2 == 0 {
            Op::Prepend(vec![l; 32])
        } else {
            Op::Append(vec![l; 32])
        });
        ops.push(Op::Sha256);
    }
    let anchor = Anchored {
        anchor: Anchor {
            ops,
            height: 900_000,
        },
        header: Header([5; 80]),
    };
    Stamped::trusted(e, Some(anchor), None)
}

/// A name of two entries (a claim and its renewal) held: its entries and their anchors, and no more than a few hundred
/// bytes around them. A map whose every node holds 11 entries of ~400 bytes cost ~4 KB more a name; a `Vec` grown as
/// usual, four entries for two, ~800 bytes.
#[test]
fn a_name_held_costs_its_entries_not_a_maps_empty_slots() {
    let anchors_only = {
        let before = LIVE.load(Relaxed);
        let v: Vec<Stamped> = (0..2000u64)
            .map(|k| entry([k as u8; 32], k, [0; 32]))
            .collect();
        let per = (LIVE.load(Relaxed) - before) / 2000;
        drop(v);
        per
    };
    let before = LIVE.load(Relaxed);
    let mut names = Vec::with_capacity(1000);
    let reserve = LIVE.load(Relaxed) - before;
    for k in 0..1000u64 {
        let mut id = [0u8; 32];
        id[..8].copy_from_slice(&k.to_le_bytes());
        let mut n = Name::new(id);
        let claim = entry(id, k, [0; 32]);
        let cid = claim.id();
        n.insert(claim);
        n.insert(entry(id, k + 1_000_000, cid));
        names.push(n);
    }
    let per_name = (LIVE.load(Relaxed) - before - reserve) / 1000;
    let over = per_name.saturating_sub(2 * anchors_only);
    eprintln!(
        "an entry with its anchor {anchors_only} bytes; a name of two {per_name} bytes, {over} past its entries"
    );
    assert!(
        over <= 256,
        "a name of two entries costs {per_name} bytes, {over} past its two entries ({anchors_only} each)"
    );
}
