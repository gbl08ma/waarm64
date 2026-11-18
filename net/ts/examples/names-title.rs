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
