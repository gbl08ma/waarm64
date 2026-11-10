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
        // `hot`'s rich copy.
        FMOV_float_imm,
        FMOV_float,
        FCSEL_float,
        FCMP_float,
        FCMPE_float,
        FMUL_float,
        FDIV_float,
        FADD_float,
        FSUB_float,
        MOVI,
        FMOV_2,
        FMOV_float_gen,
        AND_asimd,
        BIC_asimd_reg,
        ORR_asimd_reg,
        ORN_asimd,
        EOR_asimd,
        ADD_vector,
        DUP_gen,
        SCVTF_float_int,
        UCVTF_float_int,
        FABS_float,
        FNEG_float,
        FCVT_float,
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
        // Half the time, FP values whose results stay normal (the fast paths).
        let f =
            |r: &mut Rng| (r.below(1 << 20) as f64 - (1 << 19) as f64) / (1 + r.below(4096)) as f64;
        // And edge values: products near the smallest normal, NaNs, infinities, zeros, denormals.
        let edge = |r: &mut Rng, dbl: bool| {
            let (bias, man) = if dbl { (1023u64, 52) } else { (127, 23) };
            let frac = r.next() & ((1 << man) - 1);
            let sign = r.below(2) << (man + if dbl { 11 } else { 8 });
            let exp = match r.below(6) {
                0 => bias / 2 + r.below(24) - 12,
                1 => 0,
                2 => (2 * bias + 1) * (frac & 1),
                3 => 2 * bias + 1,
                _ => 1 + r.below(3),
            };
            sign | exp << man | if exp == 0 && r.below(2) == 0 { 0 } else { frac }
        };
        match r.below(6) {
            0 => *v = *v & !(u64::MAX as u128) | f(r).to_bits() as u128,
            1 => *v = *v & !(u32::MAX as u128) | (f(r) as f32).to_bits() as u128,
            2 => *v = *v & !(u64::MAX as u128) | edge(r, true) as u128,
            3 => *v = *v & !(u32::MAX as u128) | edge(r, false) as u128,
            _ => {}
        }
    }
    // FPCR mostly round-to-nearest with FZ and DN clear; FPSR.IXC set half the time.
    c.fpcr = match r.below(8) {
        0 => r.below(4) << 22,
        1 => 1 << 24,
        2 => 1 << 25,
        _ => 0,
    };
    c.fpsr = if r.below(2) == 0 { 1 << 4 } else { 0 };
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
    for k in (0..=K::LdLit as usize).chain(K::VImm as usize..=K::Fcvt as usize) {
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
/// [`hot`] reads them inline as the words around them (`mem::load_misaligned`):
/// single registers, pairs and SIMD&FP registers.
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
        // LDP X0, X3 and W0, W3, LDPSW, [X1]; LDP X0, X3, [X1, #16]! (pre-index)
        // and [X1], #16 (post-index): `pair_h`.
        (0xa940_0c20, 8, 0),
        (0x2940_0c20, 4, 0),
        (0x6940_0c20, 4, 0),
        (0xa9c1_0c20, 8, 16),
        (0xa8c1_0c20, 8, 0),
        // LDR Q0, D0, S0, H0, [X1]; LDUR Q0, [X1, #3]; LDP Q0, Q3 and D0, D3, [X1]:
        // `hot`'s Fp.
        (0x3dc0_0020, 16, 0),
        (0xfd40_0020, 8, 0),
        (0xbd40_0020, 4, 0),
        (0x7d40_0020, 2, 0),
        (0x3cc0_3020, 16, 3),
        (0xad40_0c20, 16, 0),
        (0x6d40_0c20, 8, 0),
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
    assert!(ran > 600, "{ran}");
}

/// ADDS and SUBS (immediate and shifted register, W and X) at the operands
/// where C and V turn, run as the interpreter runs them: [`hot`] computes
/// each kind's carry with its own compare (`AddsI`, `SubsI`, `SubsR`).
#[test]
fn flag_setters_at_their_edges_run_as_the_interpreter_runs_them() {
    let mut r = Rng(0x3c6e_f372_fe94_f82b);
    let t = TestRam::new(RAM);
    let edges = [
        0u64,
        1,
        2,
        0xfff,
        0x7fff_ffff,
        0x8000_0000,
        0xffff_ffff,
        0x1_0000_0000,
        0x7fff_ffff_ffff_ffff,
        0x8000_0000_0000_0000,
        u64::MAX,
        u64::MAX - 1,
    ];
    let mut ran = 0;
    // ADDS, SUBS X0, X1, #imm and W; ADDS, SUBS X0, X1, X2 and W.
    for base in [0xb100_0020u32, 0x3100_0020, 0xf100_0020, 0x7100_0020] {
        for imm in [0u32, 1, 2, 0xfff] {
            for &x in &edges {
                ran += edge_case(&t, &mut r, base | imm << 10, x, 0);
            }
        }
    }
    for w in [0xab02_0020u32, 0x2b02_0020, 0xeb02_0020, 0x6b02_0020] {
        for &x in &edges {
            for &y in &edges {
                ran += edge_case(&t, &mut r, w, x, y);
            }
        }
    }
    assert!(ran > 700, "{ran}");
}

fn edge_case(t: &TestRam, r: &mut Rng, w: u32, x: u64, y: u64) -> u32 {
    t.mem.write(CODE, 4, w as u64).unwrap();
    let mut c0 = state(r);
    (c0.x[1], c0.x[2]) = (x, y);
    let mut c1 = c0.clone();
    let want = interp::steps(&mut c1, &t.mem, None, 1);
    let mut c2 = c0.clone();
    let got = run_hot(&mut c2, &mut Flat(&t.mem), &pack(&[uop(w)]), 1, CODE);
    assert_eq!(got, want, "{w:#010x} {x:#x} {y:#x}");
    assert_eq!(c2, c1, "{w:#010x} {x:#x} {y:#x}");
    1
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

// PERF loop 20: a block's start is 25 bits of `Known::at`; a cache's budget
// keeps every start under that, whatever it is asked.
#[test]
fn a_cache_budget_fits_the_start_field() {
    for asked in [MAX_BUDGET, 1 << 26, usize::MAX] {
        assert!(Cache::new(asked).budget <= START_LIMIT, "budget {asked}");
    }
    let k = Known::new(START_LIMIT as u32 - 1, 63, 0, true);
    assert_eq!((k.start(), k.rich()), (START_LIMIT as u32 - 1, true));
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

/// PRFM (register) is a hint the block interpreter skips (`K::Nop`), as the
/// interpreter does, with no SP alignment check; the pre- and post-index
/// encodings where it would be are unallocated, and stay the interpreter's.
#[test]
fn prfm_runs_as_the_interpreter_runs_it() {
    let t = TestRam::new(RAM);
    // PRFM PLDL1KEEP, [X1, X2, LSL #3]; [SP, X2]; the size 3, opc 2 pre- and
    // post-index words (unallocated).
    for (w, nop) in [
        (0xf8a2_7820u32, true),
        (0xf8a2_6be0, true),
        (0xf880_0c20, false),
        (0xf880_0420, false),
    ] {
        assert_eq!(uop(w).k == K::Nop, nop, "{w:#010x}");
        t.mem.write(CODE, 4, w as u64).unwrap();
        let mut c0 = Cpu {
            pc: CODE,
            ..Cpu::default()
        };
        (c0.x[1], c0.x[2], c0.x[31]) = (DATA, 3, DATA + 4);
        let mut want = c0.clone();
        let w1 = interp::steps(&mut want, &t.mem, None, 1);
        let mut got = c0.clone();
        let w2 = run_hot(&mut got, &mut Flat(&t.mem), &pack(&[uop(w)]), 1, CODE);
        assert_eq!(w2, w1, "{w:#010x}");
        assert_eq!(got, want, "{w:#010x}");
    }
}

/// A product that rounds up to the smallest normal is tiny before rounding
/// (UFC): the rich copy's result check must leave the smallest binade to the
/// slow path, which random operands rarely reach.
#[test]
fn a_result_rounded_up_to_the_smallest_normal_underflows() {
    // FMUL d0, d1, d2 and FMUL s0, s1, s2.
    for (w, x, y) in [
        (
            0x1e62_0820u32,
            (1.0f64 - f64::EPSILON / 2.0).to_bits(),
            f64::MIN_POSITIVE.to_bits(),
        ),
        (
            0x1e22_0820,
            (1.0f32 - f32::EPSILON / 2.0).to_bits() as u64,
            f32::MIN_POSITIVE.to_bits() as u64,
        ),
    ] {
        let t = TestRam::new(RAM);
        t.mem.write(CODE, 4, w as u64).unwrap();
        let mut c0 = Cpu {
            pc: CODE,
            cpacr_el1: 3 << 20,
            fpsr: 1 << 4,
            ..Cpu::default()
        };
        (c0.v[1], c0.v[2]) = (x as u128, y as u128);
        let mut want = c0.clone();
        interp::steps(&mut want, &t.mem, None, 1);
        assert_ne!(want.fpsr & 8, 0, "the interpreter's UFC");
        let mut got = c0.clone();
        run_hot(&mut got, &mut Flat(&t.mem), &pack(&[uop(w)]), 1, CODE);
        assert_eq!(got, want, "{w:#x}");
    }
}

/// SCVTF/UCVTF of W and X to S and D, and FCVT between S and D, at their edges
/// (negative and unsigned extremes, values that round, denormals and NaNs, FZ,
/// the rounding modes, IXC clear or set), run as the interpreter runs them:
/// the rich copy's fast paths and the cases they leave to the slow path.
#[test]
fn fp_conversions_run_as_the_interpreter_runs_them() {
    let t = TestRam::new(RAM);
    let ints = [
        0u64,
        1,
        u64::MAX,
        i32::MIN as u32 as u64,
        i32::MIN as i64 as u64,
        i64::MIN as u64,
        u32::MAX as u64,
        (1 << 53) + 1,
        (1 << 24) + 1,
        0x8000_0000_0000_0401,
        0xdead_beef_cafe_f00d,
        // Rounded twice (through a double) they'd tie and go to even: a single directly rounds up.
        0x8000_0080_0000_0001,
        0x4000_0040_0000_0001,
    ];
    let floats = [
        0u64,
        1.5f64.to_bits(),
        (-3.25f32).to_bits() as u64,
        1,           // a single's (and a double's) smallest denormal
        0x0080_0000, // the smallest normal single
        f64::MIN_POSITIVE.to_bits(),
        0x3810_0000_0000_0001, // a double just above a single's smallest normal, inexact
        0x3800_0000_0000_0000, // a single's denormal range
        0x47f0_0000_0000_0000, // past a single's largest
        0x7f80_0001,           // a signalling NaN (single)
        0x7ff0_0000_0000_0001, // a signalling NaN (double)
        f64::INFINITY.to_bits(),
        0x3ff0_0000_1000_0000, // a double that rounds to a single
    ];
    let mut ran = 0;
    for w in [
        0x9e62_0020u32,
        0x9e63_0020,
        0x1e22_0020,
        0x1e23_0020,
        0x9e22_0020,
        0x1e62_0020,
        0x9e23_0020,
        0x1e63_0020,
        0x1e22_c020,
        0x1e62_4020,
    ] {
        t.mem.write(CODE, 4, w as u64).unwrap();
        for (i, f) in ints
            .iter()
            .zip(floats.iter().cycle())
            .chain(floats.iter().zip(ints.iter().cycle()).map(|(f, i)| (i, f)))
        {
            for fpcr in [0, 1 << 24, 1 << 22, 3 << 22] {
                for fpsr in [0, 1 << 4] {
                    let mut c0 = Cpu {
                        pc: CODE,
                        cpacr_el1: 3 << 20,
                        fpcr,
                        fpsr,
                        ..Cpu::default()
                    };
                    c0.x[1] = *i;
                    c0.v[1] = *f as u128 | 0x5555 << 64;
                    c0.v[0] = u128::MAX;
                    let mut want = c0.clone();
                    interp::steps(&mut want, &t.mem, None, 1);
                    let mut got = c0.clone();
                    run_hot(&mut got, &mut Flat(&t.mem), &pack(&[uop(w)]), 1, CODE);
                    assert_eq!(
                        got, want,
                        "{w:#010x} x1 {i:#x} v1 {f:#x} fpcr {fpcr:#x} fpsr {fpsr:#x}"
                    );
                    ran += 1;
                }
            }
        }
    }
    assert!(ran > 1000, "{ran}");
}

/// Chaining enters each block in the copy of `hot` that runs it (`Cache::rich`):
/// an integer block, one with an FADD, another integer one, round and round,
/// switching copies at each FP block's start and end, as `jit::interpret` does.
#[test]
fn blocks_chain_into_the_copy_of_hot_that_runs_them() {
    let t = TestRam::new(RAM);
    let b = |from: u64, to: u64| 0x1400_0000 | ((to.wrapping_sub(from) >> 2) as u32 & 0x03ff_ffff);
    let (a, f, z) = (CODE, CODE + 0x100, CODE + 0x200);
    // add x0, x0, #1; fadd d0, d0, d1; add x0, x0, #2: each then a B to the next.
    for (k, w, to) in [
        (a, 0x9100_0400, f),
        (f, 0x1e61_2800, z),
        (z, 0x9100_0800, a),
    ] {
        t.mem.write(k, 4, w).unwrap();
        t.mem.write(k + 4, 4, b(k + 4, to) as u64).unwrap();
    }
    let mut dec = Cache::new(MAX_BUDGET);
    for k in [a, f, z] {
        dec.decode(k, &t.mem);
        dec.quota(k, REPORT_IDLE);
    }
    let mut c0 = Cpu {
        pc: a,
        cpacr_el1: 3 << 20,
        // IXC set: the FADD's fast path.
        fpsr: 1 << 4,
        ..Cpu::default()
    };
    c0.v[1] = 1.5f64.to_bits() as u128;
    let n = 60;
    let mut want = c0.clone();
    assert_eq!(interp::steps(&mut want, &t.mem, None, n).0, n);
    let mut got = c0;
    let mut r = Run::new(n);
    r.enter(dec.get(a, &t.mem).unwrap(), a, a);
    let mut rich = dec.rich(a);
    assert!(!rich && dec.rich(f) && !dec.rich(z));
    let (mut switches, mut slow) = (0, 0);
    let m = &mut Flat(&t.mem);
    loop {
        let s = if rich {
            hot::<_, true>(&mut got, m, &mut dec, |_| false, &mut r)
        } else {
            hot::<_, false>(&mut got, m, &mut dec, |_| false, &mut r)
        };
        match s {
            SWITCH => {
                switches += 1;
                rich = !rich;
            }
            SLOW => {
                slow += 1;
                let (k, _, last) = r.stretch();
                let (_, e) = run(&mut got, m, &dec.arena()[r.at(dec.arena())..], k, r.pc);
                assert!(e.is_none() && !last);
                r.step(k);
            }
            s => {
                assert_eq!(s, STOP);
                break;
            }
        }
    }
    assert_eq!(r.done, n);
    assert_eq!(got, want);
    // Into the FP block and out of it, each time round.
    assert_eq!((switches, slow), (2 * (n / 6), 0));
}
