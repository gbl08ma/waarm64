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

/// A block's words as the cache holds them: packed at 0, its constants after it.
fn packed(words: &[u32]) -> Vec<Uop> {
    let mut wide: Vec<Wide> = words.iter().map(|&w| uop(w)).collect();
    mov_runs(&mut wide);
    pack(&wide)
}

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
        STR_imm_fpsimd_2,
        LDR_imm_fpsimd_2,
        STUR_fpsimd,
        LDUR_fpsimd,
        STR_imm_fpsimd_1,
        LDR_imm_fpsimd_1,
        STP_LDP_fpsimd,
        STNP_LDNP_fpsimd,
        EXTR,
        UDIV,
        CLZ_int,
        RBIT_int,
        REV16_int,
        REV32_int,
        REV,
        UMADDL,
        SMADDL,
        UMSUBL,
        SMSUBL,
        LDXR,
        STXR,
        LDAXR,
        STLXR,
        LDAR,
        STLR,
        DMB,
        DC_ZVA,
        LDTR,
        CAS,
        ADC,
        ADCS,
        SBC,
        SBCS,
        SDIV,
        UMULH,
        SMULH,
        LDADD,
        LDCLR,
        LDEOR,
        LDSET,
        LDSMAX,
        LDSMIN,
        LDUMAX,
        LDUMIN,
        SWP,
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
    // FP enabled mostly (the SIMD&FP loads and stores' inline path), not always.
    c.cpacr_el1 = if r.below(4) == 0 { 0 } else { 3 << 20 };
    // DC ZVA at EL0 mostly allowed.
    c.sctlr_el1 = if r.below(4) == 0 { 0 } else { sctlr::DZE };
    for v in &mut c.v {
        *v = (r.next() as u128) << 64 | r.next() as u128;
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
    let (mut ran, mut kinds) = (0, [0u64; 64]);
    for _ in 0..30_000 {
        let n = 1 + r.below(8) as usize;
        let words: Vec<u32> = (0..n).map(|_| word(&mut r, &classes)).collect();
        let c0 = state(&mut r);
        let (a, b, h) = (TestRam::new(RAM), TestRam::new(RAM), TestRam::new(RAM));
        for t in [&a, &b, &h] {
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
        // The monitor armed half the time, on what a register points at
        // (what it holds there, so a store-exclusive may succeed).
        let mut c0 = c0;
        if r.below(2) == 0 {
            let size = 1 << r.below(4);
            let addr = c0.x[r.below(32) as usize] & (DATA - 1) & !(size - 1);
            c0.monitor = crate::cpu::Monitor {
                addr,
                size,
                val: [a.mem.read(addr, size as u32).unwrap(), 0],
            };
        }
        let uops = packed(&block);
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
        let got = run(&mut c2, &mut Flat(&b.mem), &uops, left, CODE);
        let ctx = || {
            let dis: Vec<String> = block
                .iter()
                .map(|w| format!("{w:#010x} {:?}", crate::decode::decode(*w)))
                .collect();
            format!("block {dis:#?}, left {left}, from {c0:#x?}")
        };
        assert_eq!(got, want, "{}", ctx());
        assert_eq!(c2, c1, "{}", ctx());
        // The same through the call-free loop and its slow paths (`jit::interpret`'s).
        let mut c3 = c0.clone();
        let got = run_hot(&mut c3, &mut Flat(&h.mem), &uops, left, CODE);
        assert_eq!(got, want, "hot: {}", ctx());
        assert_eq!(c3, c1, "hot: {}", ctx());
        for k in 0..RAM as u64 / 8 {
            let x = a.mem.read(8 * k, 8).unwrap();
            for (y, what) in [
                (b.mem.read(8 * k, 8).unwrap(), "run"),
                (h.mem.read(8 * k, 8).unwrap(), "hot"),
            ] {
                assert!(
                    x == y,
                    "{what}: memory at {:#x}: {y:#x}, not {x:#x}; {}",
                    8 * k,
                    ctx()
                );
            }
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

/// An MRS that `sys::plain` knows runs as the interpreter runs it, at EL0 and
/// EL1, for every such key.
#[test]
fn an_mrs_runs_as_the_interpreter_runs_it() {
    let mut r = Rng(0x2545_f491_4f6c_dd1d);
    let t = TestRam::new(RAM);
    let mut ran = 0;
    for key in 0..1u32 << 16 {
        // Each a few times: the states' choices (SPSel) matter to some.
        for el1 in [false, true, false, true, false, true, false, true] {
            if crate::interp::sys::plain(key, el1).is_none() {
                continue;
            }
            let w = 0xd530_0000 | key << 5 | r.below(32) as u32;
            let u = uop_el(w, crate::decode::decode(w), el1);
            if u.k != K::Mrs {
                continue;
            }
            t.mem.write(CODE, 4, w as u64).unwrap();
            let mut c0 = state(&mut r);
            // EL1h or EL1t (SP_EL0 is UNDEFINED with SPSel 0).
            c0.pstate = if el1 { 0b0100 | r.below(2) } else { 0 } | (r.next() & 0x3c0);
            c0.sp_other = r.next();
            c0.nzcv = r.below(16) << 28;
            (c0.tpidr_el0, c0.tpidrro_el0, c0.sctlr_el1, c0.ttbr0_el1) =
                (r.next(), r.next(), r.next() & !1, r.next());
            (c0.tcr_el1, c0.esr_el1, c0.vbar_el1, c0.tpidr_el1) =
                (r.next(), r.next(), r.next(), r.next());
            (c0.spsr_el1, c0.elr_el1, c0.mair_el1, c0.mpidr) =
                (r.next(), r.next(), r.next(), r.next());
            let mut c1 = c0.clone();
            let want = interp::steps(&mut c1, &t.mem, None, 1);
            let mut c2 = c0.clone();
            let got = run_hot(&mut c2, &mut Flat(&t.mem), &pack(&[u]), 1, CODE);
            assert_eq!(got, want, "{w:#010x} el1 {el1}");
            assert_eq!(c2, c1, "{w:#010x} el1 {el1}");
            ran += 1;
        }
    }
    assert!(ran > 25, "{ran}");
}

/// Misaligned loads of every size, at every offset in an aligned word, at a
/// page's start and up to its last byte, run as the interpreter runs them:
/// [`hot`] reads them inline as the words around them (`mem::load_misaligned`).
#[test]
fn misaligned_loads_run_as_the_interpreter_runs_them() {
    let mut r = Rng(0x6a09_e667_f3bc_c909);
    let t = TestRam::new(RAM);
    for a in (0..RAM as u64).step_by(8) {
        t.mem.write(a, 8, r.next()).unwrap();
    }
    // LDR X, W (LdO); LDRH, LDRSH, LDRSW, LDUR X #3 and LDR X by register (Ld):
    // [X1] or [X1, #3] or [X1, X2], into X0; (word, bytes, its offset).
    let loads = [
        (0xf940_0020u32, 8, 0),
        (0xb940_0020, 4, 0),
        (0x7940_0020, 2, 0),
        (0x7980_0020, 2, 0),
        (0xb980_0020, 4, 0),
        (0xf840_3020, 8, 3),
        (0xf862_6820, 8, 5),
    ];
    let mut ran = 0;
    for (w, bytes, off) in loads {
        let u = uop(w);
        for page in [0u64, 0x1000] {
            for at in (0..16).chain(0x1000 - 16..0x1000 - bytes as u64 + 1) {
                let addr = page + at;
                if addr % bytes as u64 == 0 || addr < off {
                    continue;
                }
                t.mem.write(CODE, 4, w as u64).unwrap();
                let mut c0 = state(&mut r);
                (c0.x[1], c0.x[2]) = (addr - off, off);
                let mut c1 = c0.clone();
                let want = interp::steps(&mut c1, &t.mem, None, 1);
                let mut c2 = c0.clone();
                let got = run_hot(&mut c2, &mut Flat(&t.mem), &pack(&[u]), 1, CODE);
                assert_eq!(got, want, "{w:#010x} at {addr:#x}");
                assert_eq!(c2, c1, "{w:#010x} at {addr:#x}");
                ran += 1;
            }
        }
    }
    assert!(ran > 250, "{ran}");
}

/// An MSR that `sys::plain_write` knows, and DAIFSet, run as the interpreter
/// runs them, at EL0 and EL1 (SPSel either way, IRQs masked or not).
#[test]
fn an_msr_runs_as_the_interpreter_runs_it() {
    let mut r = Rng(0x9e37_79b9_7f4a_7c15);
    let t = TestRam::new(RAM);
    let mut words = vec![];
    for key in 0..1u32 << 16 {
        if crate::interp::sys::plain_write(key, true).is_some() {
            words.push(0xd500_0000 | key << 5);
        }
    }
    words.extend((0..16).map(|crm| 0xd503_40df | crm << 8));
    let mut ran = 0;
    for &w0 in &words {
        for el1 in [false, true] {
            for _ in 0..8 {
                let w = w0 | if w0 & 31 == 31 { 0 } else { r.below(32) as u32 };
                let u = uop_el(w, crate::decode::decode(w), el1);
                if u.k != K::Msr {
                    continue;
                }
                t.mem.write(CODE, 4, w as u64).unwrap();
                let mut c0 = state(&mut r);
                c0.pstate = if el1 { 0b0100 | r.below(2) } else { 0 } | (r.next() & 0x3c0);
                (c0.sp_other, c0.tpidr_el0, c0.spsr_el1, c0.elr_el1) =
                    (r.next(), r.next(), r.next(), r.next());
                let mut c1 = c0.clone();
                let want = interp::steps(&mut c1, &t.mem, None, 1);
                let mut c2 = c0.clone();
                let got = run_hot(&mut c2, &mut Flat(&t.mem), &pack(&[u]), 1, CODE);
                assert_eq!(got, want, "{w:#010x} el1 {el1}");
                assert_eq!(c2, c1, "{w:#010x} el1 {el1}");
                ran += 1;
            }
        }
    }
    assert!(ran > 100, "{ran}");
}

/// A pair of LdOs and StOs ([`mov_runs`]) stops at the prefix's end, as the steps left say.
#[test]
fn a_store_pair_stops_at_the_prefix() {
    // str w1, [x0]; str w2, [x0, #4]; ret
    let uops = packed(&[0xb900_0001, 0xb900_0402, 0xd65f_03c0]);
    assert_eq!((uops[0].kind(), uops[0].w >> 15 & 1), (K::StO, 1));
    for left in 1..=2 {
        let t = TestRam::new(RAM);
        let mut c = Cpu::default();
        (c.x[0], c.x[1], c.x[2]) = (DATA, 0x11, 0x22);
        assert_eq!(
            run_hot(&mut c, &mut Flat(&t.mem), &uops, left, CODE),
            (left as u64, None)
        );
        assert_eq!(t.mem.read(DATA, 4), Ok(0x11));
        assert_eq!(
            t.mem.read(DATA + 4, 4),
            Ok(if left == 2 { 0x22 } else { 0 })
        );
        assert_eq!(c.pc, CODE + 4 * left as u64);
    }
}

/// A compare or a TST and its B.cond ([`mov_runs`]) stop at the prefix's end, as the steps left say.
#[test]
fn a_compare_and_branch_stops_at_the_prefix() {
    // cmp x0, #1; b.eq .+8; cmp x0, x1; b.ne .+8; tst x0, #1; b.ne .+8; tst x0, x1; b.eq .+8
    for (words, x, nzcv) in [
        ([0xf100_041f, 0x5400_0040], 4, 0b0110),
        ([0xeb01_001f, 0x5400_0041], 1 << 11, 0b1000),
        ([0xf240_001f, 0x5400_0041], 8, 0b0000),
        ([0xea01_001f, 0x5400_0040], 1 << 12, 0b0100),
    ] {
        let uops = packed(&words);
        assert_eq!(Uop::wide(&uops, 0).x & x, x);
        let t = TestRam::new(RAM);
        for left in 1..=2 {
            let mut c = Cpu::default();
            (c.x[0], c.x[1]) = (1, 2);
            assert_eq!(
                run_hot(&mut c, &mut Flat(&t.mem), &uops, left, CODE),
                (left as u64, None)
            );
            assert_eq!(c.nzcv >> 28, nzcv);
            // Both taken.
            assert_eq!(c.pc, CODE + if left == 2 { 12 } else { 4 });
        }
    }
}

/// A run of MOVs ([`mov_runs`]) stops at the prefix's end, as the steps left say.
#[test]
fn a_mov_run_stops_at_the_prefix() {
    // movz x0, #1; movz x1, #2; movz x2, #3; ret
    let uops = packed(&[0xd280_0020, 0xd280_0041, 0xd280_0062, 0xd65f_03c0]);
    let t = TestRam::new(RAM);
    for left in 1..=3 {
        let mut c = Cpu::default();
        assert_eq!(
            run_hot(&mut c, &mut Flat(&t.mem), &uops, left, CODE),
            (left as u64, None)
        );
        assert_eq!(
            c.x[..3],
            [1, 2, 3].map(|v| if v <= left as u64 { v } else { 0 })
        );
        assert_eq!(c.pc, CODE + 4 * left as u64);
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
    assert_eq!(c.get(CODE, &t.mem).unwrap()[0].kind(), K::AddI64);
    c.drop_page(CODE >> 12);
    assert_eq!(c.get(CODE, &t.mem).unwrap()[0].kind(), K::Nop);
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

/// A block put out of its slot by another keeps the quota it had left: put
/// back, it counts on without reporting (a report takes the JIT cache's lock).
#[test]
fn a_block_out_of_its_slot_keeps_its_quota() {
    let t = TestRam::new(0x2000 + 4 * SLOTS);
    // Two blocks in one slot: add x0, x0, #1; ret.
    let (a, b) = (0x1000, 0x1000 + 4 * SLOTS as u64);
    for k in [a, b] {
        t.mem.write(k, 4, 0x9100_0400).unwrap();
        t.mem.write(k + 4, 4, 0xd65f_03c0).unwrap();
    }
    let mut c = Cache::new(MAX_BUDGET);
    assert_eq!(c.decode(a, &t.mem), Some(2));
    c.quota(a, REPORT);
    for _ in 0..5 {
        assert!(c.count(a));
    }
    assert_eq!(c.decode(b, &t.mem), Some(2)); // a goes out of the slot
    assert!(!c.slotted(a));
    // A quota set while a block is out of its slot counts too.
    c.quota(a, REPORT);
    assert!(c.count(a), "a counts on, back in the slot");
    c.quota(b, 3);
    for _ in 6..REPORT {
        assert!(c.count(a));
    }
    assert!(!c.count(a), "until its quota is counted");
    assert!(c.count(b) && c.count(b) && c.count(b) && !c.count(b));
    assert_eq!(c.counted(a), REPORT);
    assert_eq!(c.counted(b), 3);
}

/// A key with no instructions is remembered (the JIT asks its cache about it
/// once), until an IC names its page.
#[test]
fn an_empty_block_is_remembered_until_its_page_goes() {
    let t = TestRam::new(RAM);
    t.mem.write(CODE, 4, 0xd400_0001).unwrap(); // svc #0
    let mut c = Cache::new(MAX_BUDGET);
    assert!(!c.empty(CODE));
    assert_eq!(c.decode(CODE, &t.mem), Some(0));
    assert!(c.empty(CODE) && c.get(CODE, &t.mem).is_none() && !c.count(CODE));
    assert_eq!(c.decode(CODE, &t.mem), None, "decoded before");
    // A quota doesn't make it a block to run (the dispatcher would run no
    // instructions, forever).
    c.quota(CODE, REPORT);
    assert!(!c.count(CODE) && c.get(CODE, &t.mem).is_none());
    t.mem.write(CODE, 4, 0x9100_0400).unwrap(); // add x0, x0, #1
    t.mem.write(CODE + 4, 4, 0xd65f_03c0).unwrap(); // ret
    c.drop_page(CODE >> 12);
    assert!(!c.empty(CODE));
    assert_eq!(c.get(CODE, &t.mem).map(<[Uop]>::len), Some(2));
    assert_eq!(c.decoded, 1);
}

/// What decoding costs (bench/interp/REPORT.md "The block interpreter on the Mac, loop 4"): every
/// 16th word of the guest kernel's first 4 MiB decoded as a block start, ns a block.
/// `cargo test --release -p webpc-core decode_speed -- --ignored --nocapture`
#[test]
#[ignore]
fn decode_speed() {
    let img = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../target/images/linux/Image"
    ))
    .expect("images/build.sh linux");
    let n = img.len().min(4 << 20) & !7;
    let t = TestRam::new(n);
    for (i, w) in img[..n].as_chunks::<8>().0.iter().enumerate() {
        t.mem
            .write(8 * i as u64, 8, u64::from_le_bytes(*w))
            .unwrap();
    }
    let mut best = f64::MAX;
    let (mut blocks, mut uops) = (0, 0);
    let passes = std::env::var("DECODE_PASSES").map_or(5, |v| v.parse().unwrap());
    for _ in 0..passes {
        let mut c = Cache::new(MAX_BUDGET);
        let t0 = std::time::Instant::now();
        (blocks, uops) = (0, 0);
        for key in (0..n as u64).step_by(64) {
            if let Some(len) = c.decode(key, &t.mem) {
                blocks += 1;
                uops += len as u64;
            }
        }
        best = best.min(t0.elapsed().as_nanos() as f64 / blocks as f64);
    }
    println!(
        "decode_speed: {blocks} blocks, {:.2} micro-ops each, {best:.1} ns a block",
        uops as f64 / blocks as f64
    );
}
