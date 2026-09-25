//! Generates the A64 decoder from `src/a64/a64.inc` (dynarmic's pattern table).
//!
//! Matching order and the fast lookup follow dynarmic's `a64.h`: patterns with
//! more fixed bits come first, with a few SIMD modified-immediate exceptions, and
//! candidates are bucketed by instruction bits 29:22 and 13:10.

use std::fmt::Write;

const TABLE: &str = "src/a64/a64.inc";
const COMES_FIRST: [&str; 3] = [
    "MOVI, MVNI, ORR, BIC (vector, immediate)",
    "FMOV (vector, immediate)",
    "Unallocated SIMD modified immediate",
];

fn lookup_index(x: u32) -> usize {
    (((x >> 10) & 0x00f) | ((x >> 18) & 0xff0)) as usize
}

struct Pattern {
    id: String,
    name: String,
    mask: u32,
    value: u32,
}

fn main() {
    println!("cargo::rerun-if-changed={TABLE}");
    let src = std::fs::read_to_string(TABLE).unwrap();
    let mut pats = Vec::new();
    for line in src.lines() {
        let Some(rest) = line.trim_start_matches("//").trim().strip_prefix("INST(") else {
            continue;
        };
        // INST(id, "name", "bits"); names contain commas, so split on quotes.
        let q: Vec<&str> = rest.split('"').collect();
        let id = q[0].trim().trim_end_matches(',');
        let (name, bits) = (q[1].to_string(), q[3]);
        assert_eq!(bits.len(), 32, "{line}");
        let (mut mask, mut value) = (0u32, 0u32);
        for c in bits.chars() {
            mask = mask << 1 | matches!(c, '0' | '1') as u32;
            value = value << 1 | (c == '1') as u32;
        }
        pats.push(Pattern {
            id: id.to_string(),
            name,
            mask,
            value,
        });
    }
    pats.sort_by_key(|p| std::cmp::Reverse(p.mask.count_ones())); // stable
    let (first, rest): (Vec<_>, Vec<_>) = pats
        .into_iter()
        .partition(|p| COMES_FIRST.contains(&p.name.as_str()));
    let pats: Vec<Pattern> = first.into_iter().chain(rest).collect();

    let mut ids: Vec<&str> = Vec::new();
    for p in &pats {
        if !ids.contains(&p.id.as_str()) {
            ids.push(&p.id);
        }
    }
    ids.sort();

    let mut out = String::new();
    let o = &mut out;
    writeln!(
        o,
        "/// A64 instruction class, named as in dynarmic's `a64.inc`."
    )
    .unwrap();
    writeln!(o, "#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]").unwrap();
    writeln!(
        o,
        "#[allow(non_camel_case_types)]\n#[repr(u16)]\npub enum Op {{"
    )
    .unwrap();
    for id in &ids {
        writeln!(o, "    {id},").unwrap();
    }
    writeln!(
        o,
        "}}\n\nimpl Op {{\n    pub const ALL: [Op; {}] = [",
        ids.len()
    )
    .unwrap();
    for id in &ids {
        writeln!(o, "        Op::{id},").unwrap();
    }
    writeln!(o, "    ];\n}}\n").unwrap();

    // (mask, value, op) in match order.
    writeln!(o, "static PATTERNS: [(u32, u32, Op); {}] = [", pats.len()).unwrap();
    for p in &pats {
        writeln!(
            o,
            "    ({:#010x}, {:#010x}, Op::{}),",
            p.mask, p.value, p.id
        )
        .unwrap();
    }
    writeln!(o, "];\n").unwrap();

    // Bucket i holds CANDIDATES[BUCKETS[i]..BUCKETS[i + 1]].
    let (mut buckets, mut cands) = (vec![0u32], Vec::new());
    for i in 0..0x1000 {
        for (n, p) in pats.iter().enumerate() {
            if i & lookup_index(p.mask) == lookup_index(p.value) {
                cands.push(n as u16);
            }
        }
        buckets.push(cands.len() as u32);
    }
    writeln!(o, "static BUCKETS: [u32; {}] = {buckets:?};", buckets.len()).unwrap();
    writeln!(o, "static CANDIDATES: [u16; {}] = {cands:?};", cands.len()).unwrap();

    let dest = std::path::Path::new(&std::env::var("OUT_DIR").unwrap()).join("a64_decode.rs");
    std::fs::write(dest, out).unwrap();
}
