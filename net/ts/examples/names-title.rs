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

use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use waarm64_ts::room::names::{
    entry::Kind,
    testkit::{Bitcoin, DAY},
    zone::Zone,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Spec {
    room: String,
    titles: Vec<TitleSpec>,
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

fn main() {
    let arg = std::env::args().nth(1).expect("a spec, as JSON");
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
        let mut run = vec![b.at(
            Kind::Claim,
            &key,
            &t.name,
            [0; 32],
            now - t.claim_days_ago * DAY,
        )];
        for d in &t.renew_days_ago {
            let prev = run.last().unwrap().id();
            run.push(b.at(Kind::Renew, &key, &t.name, prev, now - d * DAY));
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
