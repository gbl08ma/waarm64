//! Golden-corpus comparator: runs every test in tests/corpus/*.txt on the
//! interpreter and checks registers, NZCV, memory and how it stopped against the
//! oracle's results. Format and seed expansion: tools/corpus/corpus.ts.

use std::collections::HashMap;
use webpc_core::cpu::Cpu;
use webpc_core::interp::{Exit, run};
use webpc_core::mem::{Fault, Mem};

const CODE: u64 = 0x100000;
const DATA: u64 = 0x200000;
const DATA_SIZE: usize = 8192;
const RAM: usize = (DATA as usize) + DATA_SIZE;
const BRK_END: u64 = 0xd420_0000;

struct Test {
    name: String,
    code: Vec<u32>,
    seed: u64,
    inp: Vec<(usize, u64)>,
    out: Vec<(usize, u64)>,
    mem: Vec<(u64, Vec<u8>)>,
    exit: String,
}

fn reg_index(name: &str) -> usize {
    match name {
        "sp" => 31,
        "nzcv" => 32,
        _ => name
            .strip_prefix('x')
            .and_then(|n| n.parse().ok())
            .filter(|&n| n < 31)
            .unwrap_or_else(|| panic!("register {name}")),
    }
}

fn num(s: &str) -> u64 {
    u64::from_str_radix(s.trim_start_matches("0x"), 16).unwrap_or_else(|_| panic!("number {s}"))
}

fn regs(words: &[&str]) -> Vec<(usize, u64)> {
    words
        .iter()
        .map(|w| {
            let (k, v) = w.split_once('=').unwrap();
            (reg_index(k), num(v))
        })
        .collect()
}

fn parse(text: &str) -> Vec<Test> {
    let mut lines = text.lines().filter(|l| !l.trim().is_empty());
    assert_eq!(lines.next(), Some("webpc-corpus 1"));
    let mut tests: Vec<Test> = Vec::new();
    for line in lines {
        let mut w = line.split(' ');
        let key = w.next().unwrap();
        let w: Vec<&str> = w.collect();
        if key == "oracle" {
            continue;
        }
        if key == "test" {
            tests.push(Test {
                name: w[0].into(),
                code: vec![],
                seed: 0,
                inp: vec![],
                out: vec![],
                mem: vec![],
                exit: String::new(),
            });
            continue;
        }
        let t = tests.last_mut().expect("key before any test");
        match key {
            "code" => {
                t.code = w
                    .iter()
                    .map(|x| u32::from_str_radix(x, 16).unwrap())
                    .collect()
            }
            "seed" => t.seed = num(w[0]),
            "in" => t.inp = regs(&w),
            "out" => t.out = regs(&w),
            "mem" => {
                t.mem = w
                    .iter()
                    .map(|x| {
                        let (a, b) = x.split_once('=').unwrap();
                        let bytes = (0..b.len())
                            .step_by(2)
                            .map(|i| u8::from_str_radix(&b[i..i + 2], 16).unwrap())
                            .collect();
                        (num(a), bytes)
                    })
                    .collect()
            }
            "exit" => t.exit = w.join(" "),
            "note" => {}
            _ => panic!("unknown key {key}"),
        }
    }
    tests
}

struct SplitMix(u64);

impl SplitMix {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }
}

/// Seed expansion: x0..x30, sp, nzcv (top 4 bits), then the data region; then overrides.
fn initial(t: &Test) -> ([u64; 33], Vec<u8>) {
    let mut g = SplitMix(t.seed);
    let mut r = [0u64; 33];
    for v in r.iter_mut() {
        *v = g.next();
    }
    r[32] &= 0xf000_0000;
    let mem: Vec<u8> = (0..DATA_SIZE / 8)
        .flat_map(|_| g.next().to_le_bytes())
        .collect();
    for &(i, v) in &t.inp {
        r[i] = v;
    }
    (r, mem)
}

fn exit_string(r: Result<(), Exit>, pc: u64, end: u64) -> String {
    let off = pc - CODE;
    match r {
        Ok(()) => "no exit after 1000 instructions".into(),
        Err(Exit::Brk(_)) if pc == end => "end".into(),
        Err(Exit::Brk(_)) => format!("sigtrap pc=+{off} code=1"),
        Err(Exit::Undefined) => format!("sigill pc=+{off} code=1"),
        Err(Exit::Fault(Fault::Align { addr })) => {
            format!("sigbus pc=+{off} code=1 addr={addr:#x}")
        }
        Err(Exit::Fault(Fault::Bus { addr })) => format!("sigsegv pc=+{off} code=1 addr={addr:#x}"),
        Err(e) => format!("{e:?} pc=+{off}"),
    }
}

/// Runs one test; returns a description of every mismatch.
fn check(t: &Test, mem: &Mem, ram: &mut [u8]) -> Vec<String> {
    let (regs, data) = initial(t);
    ram[CODE as usize..CODE as usize + 4096].fill(0);
    let end = CODE + 4 * t.code.len() as u64;
    for (k, w) in t.code.iter().chain(&[BRK_END as u32]).enumerate() {
        ram[CODE as usize + 4 * k..][..4].copy_from_slice(&w.to_le_bytes());
    }
    ram[DATA as usize..].copy_from_slice(&data);

    let mut cpu = Cpu {
        pc: CODE,
        nzcv: regs[32],
        ..Cpu::default()
    };
    cpu.x.copy_from_slice(&regs[..32]);
    let (_, r) = run(&mut cpu, mem, 1000);

    let mut want = regs;
    for &(i, v) in &t.out {
        want[i] = v;
    }
    let mut want_mem = data;
    for (a, b) in &t.mem {
        want_mem[(a - DATA) as usize..][..b.len()].copy_from_slice(b);
    }
    let mut errs = Vec::new();
    let got_exit = exit_string(r, cpu.pc, end);
    if got_exit != t.exit {
        errs.push(format!("exit: got {got_exit}, want {}", t.exit));
    }
    let names = |i: usize| match i {
        31 => "sp".to_string(),
        32 => "nzcv".to_string(),
        _ => format!("x{i}"),
    };
    let got: Vec<u64> = cpu.x.iter().copied().chain([cpu.nzcv]).collect();
    for i in 0..33 {
        if got[i] != want[i] {
            errs.push(format!(
                "{}: got {:#x}, want {:#x}",
                names(i),
                got[i],
                want[i]
            ));
        }
    }
    if let Some(i) = (0..DATA_SIZE).find(|&i| ram[DATA as usize + i] != want_mem[i]) {
        errs.push(format!(
            "mem {:#x}: got {:#04x}, want {:#04x}",
            DATA + i as u64,
            ram[DATA as usize + i],
            want_mem[i]
        ));
    }
    errs
}

#[test]
fn golden_corpus() {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/corpus");
    let mut files: Vec<_> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    files.sort();
    assert!(!files.is_empty(), "no corpus files in {dir}");

    let mut buf = vec![0u128; RAM.div_ceil(16)];
    // SAFETY: buf is 16-byte aligned, RAM bytes long, and outlives mem; only mem and
    // the `ram` view below touch it, and never at the same time.
    let mem = unsafe { Mem::new(buf.as_mut_ptr() as *mut u8, RAM as u64) };
    // SAFETY: the same allocation viewed as bytes, used only between runs.
    let ram = unsafe { std::slice::from_raw_parts_mut(buf.as_mut_ptr() as *mut u8, RAM) };

    let mut failures = Vec::new();
    let mut per_form: HashMap<String, (usize, usize)> = HashMap::new();
    for f in &files {
        for t in parse(&std::fs::read_to_string(f).unwrap()) {
            let form = t.name.rsplit_once('.').unwrap().0.to_string();
            let errs = check(&t, &mem, ram);
            let e = per_form.entry(form).or_default();
            e.0 += 1;
            if !errs.is_empty() {
                e.1 += 1;
                failures.push(format!(
                    "{} ({}): {}",
                    t.name,
                    t.code
                        .iter()
                        .map(|w| format!("{w:08x}"))
                        .collect::<Vec<_>>()
                        .join(" "),
                    errs.join("; ")
                ));
            }
        }
    }
    if !failures.is_empty() {
        let mut forms: Vec<_> = per_form.iter().filter(|(_, v)| v.1 > 0).collect();
        forms.sort();
        for (k, (n, bad)) in forms {
            eprintln!("{k}: {bad}/{n} failed");
        }
        for f in failures.iter().take(40) {
            eprintln!("{f}");
        }
        panic!(
            "{} of {} corpus tests failed",
            failures.len(),
            per_form.values().map(|v| v.0).sum::<usize>()
        );
    }
}
