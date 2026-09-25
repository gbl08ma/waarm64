//! Tallies disagreements with Capstone by class, over the whole encoding space or a sample.
//!   cargo run --release --bin sweep              every 32-bit word, all cores (a few minutes)
//!   cargo run --release --bin sweep -- <count>   <count> random words

use std::collections::HashMap;

mod check;

type Tally = HashMap<String, (u64, String)>;

fn tally(words: impl Iterator<Item = u32>) -> Tally {
    let mut c = check::Checker::new();
    let mut seen = Tally::new();
    for w in words {
        if let Some(m) = c.check(w) {
            seen.entry(m.key).or_insert((0, m.detail)).0 += 1;
        }
    }
    seen
}

fn main() {
    let count: Option<u64> = std::env::args().nth(1).map(|a| a.parse().unwrap());
    let seen = match count {
        Some(n) => {
            let mut s = 0x9e37_79b9_7f4a_7c15u64;
            tally((0..n).map(move |_| {
                s ^= s << 13;
                s ^= s >> 7;
                s ^= s << 17;
                s as u32
            }))
        }
        None => {
            let threads = std::thread::available_parallelism().map_or(4, |n| n.get()) as u64;
            let chunk = (1u64 << 32).div_ceil(threads);
            let hs: Vec<_> = (0..threads)
                .map(|k| {
                    let (lo, hi) = (k * chunk, ((k + 1) * chunk).min(1 << 32));
                    std::thread::spawn(move || tally((lo..hi).map(|w| w as u32)))
                })
                .collect();
            let mut all = Tally::new();
            for h in hs {
                for (k, (n, d)) in h.join().unwrap() {
                    all.entry(k).or_insert((0, d)).0 += n;
                }
            }
            all
        }
    };
    let mut v: Vec<_> = seen.into_iter().collect();
    v.sort_by(|a, b| b.1.0.cmp(&a.1.0));
    for (k, (n, d)) in &v {
        println!("{n:>10}  {k}    e.g. {d}");
    }
    println!("{} mismatch classes", v.len());
}
