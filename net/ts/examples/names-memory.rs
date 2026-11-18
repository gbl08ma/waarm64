//! Where a server's memory goes (NAMES loop 6b, bench/net/REPORT.md "NAMES loop 6b"): N0c and N6a measured a server's
//! linear memory at ~3.5 to 4x its registry's bytes. This counts the heap natively (a counting allocator) for a registry
//! of titles made by `names-title` (`"levels": 30`, as real anchors weigh): the items' bytes, the items decoded, a server
//! holding them (from its records), and a second server syncing them all from the first over a bus (its live heap after,
//! and the peak while it synced).
//!
//! `cargo run -q --release -p waarm64_ts --features test-params --example names-memory -- <titles.json>`, the titles
//! as `names-title` prints them (an array of `{key, items}`); prints JSON.

use std::{
    alloc::{GlobalAlloc, Layout, System},
    sync::atomic::{AtomicUsize, Ordering::Relaxed},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::Deserialize;
use waarm64_ts::room::names::{
    server::{Cmd, Config, Input, MAX_BYTES, MAX_NAMES, Server, Title},
    store::Held,
    testkit::params,
    wire::{Item, Question},
};

struct Counting;
static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);
static BLOCKS: AtomicUsize = AtomicUsize::new(0);

// SAFETY: every call goes to the system allocator with the same layout; the counters are only arithmetic beside it.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        // SAFETY: the caller's layout, passed on.
        let p = unsafe { System.alloc(l) };
        if !p.is_null() {
            let now = LIVE.fetch_add(l.size(), Relaxed) + l.size();
            PEAK.fetch_max(now, Relaxed);
            BLOCKS.fetch_add(1, Relaxed);
        }
        p
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        // SAFETY: `p` was allocated by `alloc` with `l`.
        unsafe { System.dealloc(p, l) };
        LIVE.fetch_sub(l.size(), Relaxed);
        BLOCKS.fetch_sub(1, Relaxed);
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, new: usize) -> *mut u8 {
        // SAFETY: `p` was allocated by `alloc` with `l`.
        let q = unsafe { System.realloc(p, l, new) };
        if !q.is_null() {
            if new >= l.size() {
                let now = LIVE.fetch_add(new - l.size(), Relaxed) + new - l.size();
                PEAK.fetch_max(now, Relaxed);
            } else {
                LIVE.fetch_sub(l.size() - new, Relaxed);
            }
        }
        q
    }
}

#[global_allocator]
static A: Counting = Counting;

#[derive(Deserialize)]
struct Made {
    key: String,
    items: Vec<String>,
}

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len() / 2)
        .map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap())
        .collect()
}

fn mb(b: usize) -> f64 {
    (b as f64 / 1e4).round() / 100.0
}

const ROOM_FROM_SPEC: &str = "names-memory";

fn main() {
    let path = std::env::args().nth(1).expect("the titles' file");
    let room = std::env::args()
        .nth(2)
        .unwrap_or_else(|| ROOM_FROM_SPEC.into());
    let made: Vec<Made> =
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).expect("titles");
    let raw: Vec<(Vec<u8>, [u8; 32])> = made
        .iter()
        .map(|m| (unhex(&m.items[0]), unhex(&m.key).try_into().unwrap()))
        .collect();
    let bytes: usize = raw.iter().map(|r| r.0.len()).sum();
    let names = raw.len();

    // The items decoded, alone.
    let (l0, b0) = (LIVE.load(Relaxed), BLOCKS.load(Relaxed));
    let items: Vec<Item> = raw.iter().map(|r| Item::decode(&r.0).unwrap()).collect();
    let decoded = LIVE.load(Relaxed) - l0;
    let decoded_blocks = BLOCKS.load(Relaxed) - b0;
    let ops: usize = items
        .iter()
        .flat_map(|i| &i.entries)
        .filter_map(|e| e.anchor.as_ref())
        .map(|a| a.0.ops.len())
        .sum();
    let entries: usize = items.iter().map(|i| i.entries.len()).sum();
    drop(items);

    let unix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();

    // What the store keeps a name (`Held`: its entries by id, the zone, the owning chain), settled, outside a server.
    let l0 = LIVE.load(Relaxed);
    let mut store: Vec<Held> = Vec::with_capacity(names);
    let alone = LIVE.load(Relaxed) - l0;
    for (r, _) in &raw {
        let item = Item::decode(r).unwrap();
        let mut h = Held::new(item.id, unix);
        for e in item.entries {
            h.name.insert(e.trusted());
        }
        if let Some(z) = item.zone {
            h.offer_zone(z, unix, false);
        }
        h.settle(&params(), unix);
        store.push(h);
    }
    let store_held = LIVE.load(Relaxed) - l0 - alone;
    drop(store);
    let cfg = |t: Vec<Title>| Config {
        params: params(),
        titles: t,
        max_names: MAX_NAMES,
        max_bytes: MAX_BYTES,
    };
    let title = |k: usize| Title {
        key: raw[k].1,
        item: Item::decode(&raw[k].0).unwrap(),
    };

    // A server holding them: its own title and the rest from records (trusted, as at a page's load).
    let l1 = LIVE.load(Relaxed);
    let mut a = Server::new(&room, cfg(vec![title(0)]), unix);
    for (r, _) in &raw[2..] {
        let mut rec = vec![1];
        rec.extend_from_slice(&unix.to_le_bytes());
        rec.extend_from_slice(r);
        assert!(a.load(&rec, unix));
    }
    let held = LIVE.load(Relaxed) - l1;
    let reg_bytes = a.reg.bytes;

    // A second server syncing everything from it, over a bus that carries datagrams and questions at once.
    let l2 = LIVE.load(Relaxed);
    PEAK.store(l2, Relaxed);
    let mut b = Server::new(&room, cfg(vec![title(1)]), unix);
    let keys = [[0xa1u8; 32], [0xb2u8; 32]];
    let t0 = Instant::now();
    let mut now = t0;
    let mut sub = [false; 2];
    a.start(keys[0], now);
    b.start(keys[1], now);
    let mut s = [a, b];
    let started = Instant::now();
    let mut synced_at = None;
    while now < t0 + Duration::from_secs(3600) {
        let unix_now = unix + now.duration_since(t0).as_secs();
        loop {
            let mut any = false;
            for i in 0..2 {
                while let Some(c) = s[i].poll() {
                    any = true;
                    let (from, j) = (keys[i], 1 - i);
                    match c {
                        Cmd::Send { to, data } if to == keys[j] => {
                            s[j].input(Input::Datagram { from, data }, now, unix_now)
                        }
                        Cmd::Publish { nonce, spread } if sub[j] => {
                            let q = Question {
                                key: from,
                                region: 0,
                                time: unix_now,
                                nonce,
                                spread,
                            };
                            s[j].input(Input::Question { q, region: 0 }, now, unix_now)
                        }
                        Cmd::Subscribe(on) => sub[i] = on,
                        Cmd::Forget(k) => s[i].input(Input::Gone(k), now, unix_now),
                        Cmd::Fetch { id, .. } => s[i].input(
                            Input::Fetched {
                                id,
                                status: 0,
                                body: Vec::new(),
                            },
                            now,
                            unix_now,
                        ),
                        _ => {}
                    }
                }
            }
            if !any {
                break;
            }
        }
        if s[1].reg.items.len() >= names && synced_at.is_none() {
            synced_at = Some(now);
        }
        if synced_at.is_some_and(|t| now >= t + Duration::from_secs(20)) {
            break;
        }
        let next = s.iter().filter_map(Server::deadline).min();
        now = next.map_or(now + Duration::from_millis(100), |d| {
            d.max(now + Duration::from_millis(1))
        });
        for x in &mut s {
            if x.deadline().is_some_and(|d| d <= now) {
                x.tick(now, unix + now.duration_since(t0).as_secs());
            }
        }
    }
    let after = LIVE.load(Relaxed) - l2;
    let peak = PEAK.load(Relaxed) - l2;
    let [a, b] = s;
    let b_names = b.reg.items.len();
    drop(b);
    let b_live = after - (LIVE.load(Relaxed) - l2);
    // What's left of A's side once B is gone (A's transfers, caches grown by the sync).
    let a_after = LIVE.load(Relaxed) - l1;
    drop(a);
    let out = serde_json::json!({
        "names": names,
        "entries": entries,
        "anchorOps": ops,
        "itemsMB": mb(bytes),
        "registryBytesMB": mb(reg_bytes),
        "decodedMB": mb(decoded),
        "decodedAllocations": decoded_blocks,
        "decodedPerItemBytes": decoded / names,
        "storeHeldMB": mb(store_held),
        "serverHeldMB": mb(held),
        "serverHeldOverItems": (held as f64 / bytes as f64 * 100.0).round() / 100.0,
        "syncSeconds": synced_at.map(|t| (t - t0).as_secs()),
        "syncedNames": b_names,
        "syncingServerLiveMB": mb(b_live),
        "syncPeakMB": mb(peak),
        "syncPeakOverItems": (peak as f64 / bytes as f64 * 100.0).round() / 100.0,
        "sourceServerAfterMB": mb(a_after),
        "wallSeconds": started.elapsed().as_secs(),
        "sizes": {
            "Stamped": std::mem::size_of::<waarm64_ts::room::names::entry::Stamped>(),
            "Entry": std::mem::size_of::<waarm64_ts::room::names::entry::Entry>(),
            "Anchored": std::mem::size_of::<waarm64_ts::room::names::entry::Anchored>(),
            "Pending": std::mem::size_of::<waarm64_ts::room::names::anchor::Pending>(),
            "Op": std::mem::size_of::<waarm64_ts::room::names::anchor::Op>(),
            "Held": std::mem::size_of::<Held>(),
            "Zone": std::mem::size_of::<waarm64_ts::room::names::zone::Zone>(),
        },
    });
    println!("{out}");
}
