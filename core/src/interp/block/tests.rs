//! The block interpreter against the interpreter: random blocks of the
//! classes it has handlers for (and some it runs generically), from random
//! states, must retire the same instructions, exit the same way and leave
//! the same registers and memory.

use super::*;
use crate::cpu::Cpu;
use crate::interp;
use crate::mem::tests::TestRam;
use crate::mmu::Flat;

const RAM: usize = 0x4000;
/// Registers point below this; the code is in the page above it.
const DATA: u64 = 0x2000;
const CODE: u64 = 0x3000;

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

/// The classes the generator draws from.
fn classes() -> Vec<(u32, u32, Op)> {
    use Op::*;
    let ops = [
        ADR,
        ADRP,
        ADD_imm,
        ADDS_imm,
        SUB_imm,
        SUBS_imm,
        ADD_shift,
        ADDS_shift,
        SUB_shift,
        SUBS_shift,
        ADD_ext,
        ADDS_ext,
        SUB_ext,
        SUBS_ext,
        AND_imm,
        ORR_imm,
        EOR_imm,
        ANDS_imm,
        AND_shift,
        BIC_shift,
        ORR_shift,
        ORN_shift,
        EOR_shift,
        EON,
        ANDS_shift,
        BICS,
        MOVN,
        MOVZ,
        MOVK,
        SBFM,
        UBFM,
        BFM,
        ASR_1,
        ASR_2,
        SXTB_1,
        SXTB_2,
        SXTH_1,
        SXTH_2,
        SXTW,
        LSLV,
        LSRV,
        ASRV,
        RORV,
        CSEL,
        CSINC,
        CSINV,
        CSNEG,
        CCMN_reg,
        CCMP_reg,
        CCMN_imm,
        CCMP_imm,
        MADD,
        MSUB,
        B_uncond,
        BL,
        B_cond,
        CBZ,
        CBNZ,
        TBZ,
        TBNZ,
        BR,
        RET,
        BLR,
        NOP,
        HINT,
        PRFM_imm,
        PRFM_unscaled_imm,
        PRFM_lit,
        LDR_lit_gen,
        LDRSW_lit,
        STRx_LDRx_imm_2,
        STURx_LDURx,
        STRx_LDRx_imm_1,
        STRx_reg,
        LDRx_reg,
        STP_LDP_gen,
        STNP_LDNP_gen,
        EXTR,
        UDIV,
        CLZ_int,
        LDXR,
        STXR,
        LDTR,
        CAS,
        LDADD,
    ];
    let p: Vec<_> = crate::decode::patterns()
        .iter()
        .copied()
        .filter(|p| ops.contains(&p.2))
        .collect();
    assert!(p.len() >= ops.len());
    p
}

fn word(r: &mut Rng, classes: &[(u32, u32, Op)]) -> u32 {
    let (mask, value, _) = classes[r.below(classes.len() as u64) as usize];
    let mut w = value | (r.next() as u32 & !mask);
    // Registers 31 (SP or ZR) more often than one in 32, and small register
    // numbers (the ones holding pointers) too.
    for lo in [0, 5, 10, 16] {
        let f = 31 << lo;
        if mask & f == 0 {
            match r.below(4) {
                0 => w |= f,
                1 => w &= !f | (r.below(4) as u32) << lo,
                _ => {}
            }
        }
    }
    // Keep the result in the class (the extra bits may have made another).
    if crate::decode::decode(w) == crate::decode::decode(value | (w & !mask)) {
        w
    } else {
        value
    }
}

fn state(r: &mut Rng) -> Cpu {
    let mut c = Cpu {
        pc: CODE,
        nzcv: r.below(16) << 28,
        ..Cpu::default()
    };
    for x in &mut c.x {
        *x = match r.below(5) {
            0 => r.next(),
            1 => r.below(64),
            2 => r.below(DATA) & !7,
            _ => r.below(DATA),
        };
    }
    c.x[31] = if r.below(8) == 0 {
        r.below(DATA)
    } else {
        r.below(DATA) & !15
    };
    c
}

#[test]
fn blocks_run_as_the_interpreter_runs_them() {
    let classes = classes();
    let mut r = Rng(0x9e37_79b9_7f4a_7c15);
    let (mut ran, mut kinds) = (0, [0u64; 32]);
    for _ in 0..30_000 {
        let n = 1 + r.below(8) as usize;
        let words: Vec<u32> = (0..n).map(|_| word(&mut r, &classes)).collect();
        let c0 = state(&mut r);
        let (a, b) = (TestRam::new(RAM), TestRam::new(RAM));
        for t in [&a, &b] {
            for k in 0..DATA / 8 {
                t.mem
                    .write(8 * k, 8, k.wrapping_mul(0x0101_0101_9e37_79b9))
                    .unwrap();
            }
            for (k, &w) in words.iter().enumerate() {
                t.mem.write(CODE + 4 * k as u64, 4, w as u64).unwrap();
            }
        }
        let block = crate::jit::block::form(&b.mem, CODE);
        if block.is_empty() {
            continue;
        }
        let uops: Vec<Uop> = block.iter().map(|&w| uop(w)).collect();
        let left = 1 + r.below(block.len() as u64) as usize;
        let left = if r.below(2) == 0 { block.len() } else { left };

        let mut c1 = c0.clone();
        let want = interp::steps(&mut c1, &a.mem, None, left as u64);
        // A store into the block's own code: the interpreter runs the new
        // words, a decoded block the old ones (without an IC, either is right).
        if (0..block.len() as u64)
            .any(|k| a.mem.read(CODE + 4 * k, 4).unwrap() as u32 != block[k as usize])
        {
            continue;
        }
        let mut c2 = c0.clone();
        let got = run(&mut c2, &mut Flat(&b.mem), &uops[..left], CODE);
        let ctx = || {
            let dis: Vec<String> = block
                .iter()
                .map(|w| format!("{w:#010x} {:?}", crate::decode::decode(*w)))
                .collect();
            format!("block {dis:#?}, left {left}, from {c0:#x?}")
        };
        assert_eq!(got, want, "{}", ctx());
        assert_eq!(c2, c1, "{}", ctx());
        for k in 0..RAM as u64 / 8 {
            let (x, y) = (a.mem.read(8 * k, 8).unwrap(), b.mem.read(8 * k, 8).unwrap());
            assert!(
                x == y,
                "memory at {:#x}: {y:#x}, not {x:#x}; {}",
                8 * k,
                ctx()
            );
        }
        ran += 1;
        for u in &uops[..left] {
            kinds[u.k as usize] += 1;
        }
    }
    // Every kind ran (the generator still reaches them).
    assert!(ran > 20_000, "{ran}");
    for k in 0..=K::LdLit as usize {
        assert!(kinds[k] > 0, "kind {k} never ran: {kinds:?}");
    }
}

#[test]
fn the_cache_drops_and_starts_over() {
    let t = TestRam::new(RAM);
    // add x0, x0, #1; b .-4
    t.mem.write(CODE, 4, 0x9100_0400).unwrap();
    t.mem.write(CODE + 4, 4, 0x17ff_ffff).unwrap();
    let mut c = Cache::new(MAX_BUDGET);
    assert_eq!(c.get(CODE, &t.mem).map(<[Uop]>::len), Some(2));
    // Changed without an IC: the cache keeps the words it decoded.
    t.mem.write(CODE, 4, 0xd503_201f).unwrap();
    assert_eq!(c.get(CODE, &t.mem).unwrap()[0].k, K::AddI64);
    c.drop_page(CODE >> 12);
    assert_eq!(c.get(CODE, &t.mem).unwrap()[0].k, K::Nop);
    assert_eq!(c.decoded, 2);
    // No instructions (an SVC first): no block.
    t.mem.write(CODE + 8, 4, 0xd400_0001).unwrap();
    assert!(c.get(CODE + 8, &t.mem).is_none());
    c.clear();
    assert_eq!(c.get(CODE + 4, &t.mem).map(<[Uop]>::len), Some(1));
}

#[test]
fn the_tables_share_the_budget() {
    let m = |n| budget(n) >> 20;
    assert_eq!([0, 1, 2, 4, 8, 123].map(m), [8, 8, 8, 4, 2, 0]);
    assert!(budget(123) * 123 <= BUDGET && budget(123) > 1 << 16);
}
