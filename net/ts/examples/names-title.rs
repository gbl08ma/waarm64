//! Titles for the page tests (tests/page-room.test.ts), on the tests' pretend Bitcoin (room/names/testkit.rs: easy
//! headers, cheap proof of work), until the names agent (N4) makes real ones. Only a module built with the
//! `test-params` feature (target/net/ts-test.wasm) takes them; the shipped one refuses their headers (under its floor)
//! and their proof of work.
//!
//! `cargo run -q -p waarm64_ts --features test-params --example names-title -- '<spec>'`, the spec as JSON:
//! `{"room": "<room ID>", "titles": [{"name": "test123", "secret": 1, "claimDaysAgo": 20, "renewDaysAgo": [4],
//! "zones": [{"seq": 1, "points": [{"label": null, "key": "<node key, 64 hex digits>"}, {"label": "git", "key": …}]}]}]}`.
//! Prints, for each title, its owner key (64 hex digits) and an item (hex, room/names/wire.rs) for each zone: the same
//! chain with each zone in turn (a zone change), as the module's config takes titles (`room.names.titles`).
//!
//! `@<file>` in place of the JSON reads the spec from that file (bench/net/names-public.ts: thousands of titles, past
//! an argument's limit). `"levels": n` in the spec gives each anchor a calendar's depth of `n` levels (a 32-byte sibling
//! a level, as real anchors' ~1.2 KB have: bench/net/REPORT.md "NAMES loop 0b"), where the default is two.
//!
//! For a registry at scale (bench/net/room-scale.ts `names`): `"spread": s` moves each title's times back by a draw in
//! `[0, s)` seconds, and `"blockSecs": b` anchors the entries whose times fall in one `b`-second slot in one block (a
//! Merkle tree over their commitments under one header, as a calendar's transaction and a block carry many), where
//! the default gives each entry a block of its own. Each title's output then also lists its entries' block headers
//! (`headers`, hex), for the pretend explorer to adopt.

use std::time::{SystemTime, UNIX_EPOCH};

use k256::schnorr::SigningKey;
use serde::Deserialize;
use waarm64_ts::room::names::{
    anchor::{Anchor, Op, apply},
    entry::{Kind, Stamped},
    testkit::{Bitcoin, DAY, EASY, LATE, header},
    zone::Zone,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Spec {
    room: String,
    titles: Vec<TitleSpec>,
    #[serde(default)]
    levels: usize,
    #[serde(default)]
    spread: u32,
    #[serde(default)]
    block_secs: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TitleSpec {
    name: String,
    secret: u8,
    claim_days_ago: u32,
    #[serde(default)]
    renew_days_ago: Vec<u32>,
    zones: Vec<ZoneSpec>,
}

#[derive(Deserialize)]
struct ZoneSpec {
    seq: u64,
    points: Vec<Point>,
}

#[derive(Deserialize)]
struct Point {
    label: Option<String>,
    key: String,
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|b| format!("{b:02x}")).collect()
}

fn key32(s: &str) -> [u8; 32] {
    assert_eq!(s.len(), 64, "a node key is 64 hex digits");
    let mut k = [0u8; 32];
    for (i, b) in k.iter_mut().enumerate() {
        *b = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).expect("hex");
    }
    k
}

/// An entry anchored at `time`, its anchor `levels` deep (`Bitcoin::at`'s with a calendar's depth).
fn at(
    b: &mut Bitcoin,
    levels: usize,
    kind: Kind,
    key: &SigningKey,
    name: &str,
    prev: [u8; 32],
    time: u32,
) -> Stamped {
    if levels == 0 {
        return b.at(kind, key, name, prev, time);
    }
    let mut s = b.entry(kind, key, name, prev);
    let mut ops = vec![Op::Append(b.rng.bytes::<16>().to_vec()), Op::Sha256];
    for k in 0..levels {
        let sib = b.rng.bytes::<32>().to_vec();
        ops.push(if k % 2 == 0 {
            Op::Prepend(sib)
        } else {
            Op::Append(sib)
        });
        ops.push(Op::Sha256);
    }
    let root: [u8; 32] = apply(&ops, &s.id()).unwrap().try_into().unwrap();
    let h = header(&mut b.rng, time, root, EASY);
    let a = Anchor {
        ops,
        height: 900_000,
    };
    assert_eq!(s.offer_anchor(a, h, &b.params, LATE), Ok(true));
    s
}

fn main() {
    let arg = std::env::args().nth(1).expect("a spec, as JSON");
    let arg = match arg.strip_prefix('@') {
        Some(path) => std::fs::read_to_string(path).expect("the spec's file"),
        None => arg,
    };
    let spec: Spec = serde_json::from_str(&arg).expect("the spec");
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as u32;
    let seed = now as u64 ^ spec.room.len() as u64;
    let mut b = Bitcoin::new(&spec.room, seed);
    if spec.block_secs > 0 {
        return shared_blocks(&spec, &mut b, now);
    }
    let mut out = Vec::new();
    for t in &spec.titles {
        let key = b.key(t.secret, &t.name);
        let mut run = vec![at(
            &mut b,
            spec.levels,
            Kind::Claim,
            &key,
            &t.name,
            [0; 32],
            now - t.claim_days_ago * DAY,
        )];
        for d in &t.renew_days_ago {
            let prev = run.last().unwrap().id();
            run.push(at(
                &mut b,
                spec.levels,
                Kind::Renew,
                &key,
                &t.name,
                prev,
                now - d * DAY,
            ));
        }
        let items: Vec<String> = t
            .zones
            .iter()
            .map(|z| {
                let points: Vec<(Option<&str>, [u8; 32])> = z
                    .points
                    .iter()
                    .map(|p| (p.label.as_deref(), key32(&p.key)))
                    .collect();
                let zone =
                    Zone::seal(&b.names, &key, &t.name, z.seq, &points, false).expect("a zone");
                hex(&b.item(&t.name, &run, Some(zone)).encode())
            })
            .collect();
        out.push(serde_json::json!({
            "name": t.name,
            "key": hex(&key.to_bytes()),
            "items": items,
        }));
    }
    println!("{}", serde_json::Value::Array(out));
}

/// Titles whose entries share blocks: every entry made first, then each `block_secs` slot's entries anchored under one
/// header over a Merkle tree of their commitments (each leaf a calendar's depth below it, the tree's levels counted in).
fn shared_blocks(spec: &Spec, b: &mut Bitcoin, now: u32) {
    struct Made {
        key: SigningKey,
        run: Vec<(Stamped, u32)>,
    }
    let mut made = Vec::new();
    for t in &spec.titles {
        let back = if spec.spread > 0 {
            (b.rng.next() % spec.spread as u64) as u32
        } else {
            0
        };
        let key = b.key(t.secret, &t.name);
        let claim = now - t.claim_days_ago * DAY - back;
        let mut run = vec![(b.entry(Kind::Claim, &key, &t.name, [0; 32]), claim)];
        for d in &t.renew_days_ago {
            let prev = run.last().unwrap().0.id();
            let e = b.entry(Kind::Renew, &key, &t.name, prev);
            run.push((e, now - d * DAY - back));
        }
        made.push(Made { key, run });
    }
    // Each slot's entries: (title, entry).
    let mut slots: std::collections::BTreeMap<u32, Vec<(usize, usize)>> = Default::default();
    for (ti, m) in made.iter().enumerate() {
        for (ei, (_, time)) in m.run.iter().enumerate() {
            slots
                .entry(time / spec.block_secs)
                .or_default()
                .push((ti, ei));
        }
    }
    let mut headers: Vec<Vec<String>> = vec![Vec::new(); made.len()];
    for (slot, who) in &slots {
        // Leaves: a nonce appended and hashed, then a calendar's depth of siblings, less the tree's own levels.
        let tree = (usize::BITS - (who.len().max(1) - 1).leading_zeros()) as usize;
        let mut paths: Vec<Vec<Op>> = Vec::new();
        let mut level: Vec<([u8; 32], Vec<usize>)> = Vec::new();
        for (k, &(ti, ei)) in who.iter().enumerate() {
            let mut ops = vec![Op::Append(b.rng.bytes::<16>().to_vec()), Op::Sha256];
            for d in 0..spec.levels.saturating_sub(tree) {
                let sib = b.rng.bytes::<32>().to_vec();
                ops.push(if d % 2 == 0 {
                    Op::Prepend(sib)
                } else {
                    Op::Append(sib)
                });
                ops.push(Op::Sha256);
            }
            let leaf: [u8; 32] = apply(&ops, &made[ti].run[ei].0.id())
                .unwrap()
                .try_into()
                .unwrap();
            paths.push(ops);
            level.push((leaf, vec![k]));
        }
        while level.len() > 1 {
            let mut next = Vec::new();
            for pair in level.chunks(2) {
                let (l, r) = (&pair[0], pair.get(1).unwrap_or(&pair[0]));
                for &w in &l.1 {
                    paths[w].push(Op::Append(r.0.to_vec()));
                    paths[w].push(Op::Sha256);
                }
                if pair.len() == 2 {
                    for &w in &r.1 {
                        paths[w].push(Op::Prepend(l.0.to_vec()));
                        paths[w].push(Op::Sha256);
                    }
                }
                let root: [u8; 32] = apply(&[Op::Append(r.0.to_vec()), Op::Sha256], &l.0)
                    .unwrap()
                    .try_into()
                    .unwrap();
                let mut who = l.1.clone();
                if pair.len() == 2 {
                    who.extend(&r.1);
                }
                next.push((root, who));
            }
            level = next;
        }
        let time = slot * spec.block_secs + spec.block_secs / 2;
        let h = header(&mut b.rng, time.min(now), level[0].0, EASY);
        let hex_h = hex(&h.0);
        for (k, &(ti, ei)) in who.iter().enumerate() {
            let a = Anchor {
                ops: paths[k].clone(),
                height: 900_000,
            };
            let (s, _) = &mut made[ti].run[ei];
            assert_eq!(s.offer_anchor(a, h, &b.params, LATE), Ok(true));
            if !headers[ti].contains(&hex_h) {
                headers[ti].push(hex_h.clone());
            }
        }
    }
    let mut out = Vec::new();
    for ((t, m), hs) in spec.titles.iter().zip(&made).zip(headers) {
        let run: Vec<Stamped> = m.run.iter().map(|(s, _)| s.clone()).collect();
        let items: Vec<String> = t
            .zones
            .iter()
            .map(|z| {
                let points: Vec<(Option<&str>, [u8; 32])> = z
                    .points
                    .iter()
                    .map(|p| (p.label.as_deref(), key32(&p.key)))
                    .collect();
                let zone =
                    Zone::seal(&b.names, &m.key, &t.name, z.seq, &points, false).expect("a zone");
                hex(&b.item(&t.name, &run, Some(zone)).encode())
            })
            .collect();
        out.push(serde_json::json!({
            "name": t.name,
            "key": hex(&m.key.to_bytes()),
            "items": items,
            "headers": hs,
        }));
    }
    println!("{}", serde_json::Value::Array(out));
}
