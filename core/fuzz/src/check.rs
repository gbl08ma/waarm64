//! One A64 word through our decoder and interpreter and through Capstone.
//! Shared by the libFuzzer target and the sweep.

use capstone::prelude::*;
use webpc_core::cpu::Cpu;
use webpc_core::decode::{Op, decode};
use webpc_core::interp::{Exit, step};
use webpc_core::mem::Mem;

const RAM: usize = 0x10000;
const PC: u64 = 0x1000;

pub struct Checker {
    cs: Capstone,
    _buf: Vec<u128>,
    mem: Mem,
}

/// A disagreement: `key` groups it (our class vs Capstone's mnemonic), `detail` shows one instance.
pub struct Mismatch {
    pub key: String,
    pub detail: String,
}

impl Checker {
    pub fn new() -> Self {
        let cs = Capstone::new()
            .arm64()
            .mode(arch::arm64::ArchMode::Arm)
            .build()
            .unwrap();
        let mut buf = vec![0u128; RAM / 16];
        // SAFETY: buf is 16-byte aligned, RAM bytes long, and lives as long as mem.
        let mem = unsafe { Mem::new(buf.as_mut_ptr() as *mut u8, RAM as u64) };
        Checker { cs, _buf: buf, mem }
    }

    /// Executes `w` on a scratch vCPU at EL0 (it must not panic) and compares
    /// "valid instruction" with Capstone. The system space goes to `check_sys`.
    pub fn check(&mut self, w: u32) -> Option<Mismatch> {
        if w & 0xffc0_0000 == 0xd500_0000 {
            return self.check_sys(w);
        }
        self.mem.write(PC, 4, w as u64).unwrap();
        let mut cpu = Cpu {
            pc: PC,
            ..Cpu::default()
        };
        cpu.x = [0x8000; 32];
        let r = step(&mut cpu, &self.mem);
        if matches!(r, Err(Exit::Unimplemented(_))) || unpredictable(w) {
            return None;
        }
        let ours = !matches!(r, Err(Exit::Undefined));
        let insns = self.cs.disasm_count(&w.to_le_bytes(), PC, 1).ok();
        let cs = insns.as_ref().and_then(|i| i.iter().next()).map(|i| {
            (
                i.mnemonic().unwrap_or("").to_string(),
                i.op_str().unwrap_or("").to_string(),
            )
        });

        // The hint space (PAC and BTI included) is ours: those run as NOPs.
        let hint = w & 0xffff_f01f == 0xd503_201f;
        let theirs = cs.as_ref().is_some_and(|(m, o)| hint || !not_ours(m, o));
        if ours == theirs {
            return None;
        }
        let op = decode(w);
        let class = if ours {
            format!("{op:?}")
        } else {
            format!("Undefined({op:?})")
        };
        let (m, o) = cs.unwrap_or(("invalid".into(), String::new()));
        Some(Mismatch {
            key: format!("{class} / {m}"),
            detail: format!("{w:#010x}: ours {class} {r:?}, capstone {m} {o}"),
        })
    }
}

impl Checker {
    /// The system instruction space (MRS, MSR, SYS, SYSL and their aliases),
    /// executed at EL1 with FP enabled. Capstone decodes every MRS/MSR
    /// encoding, naming the registers it knows (others print as
    /// `s<op0>_<op1>_c<n>_c<m>_<op2>`), and names the SYS operations it knows
    /// (`tlbi`, `dc`, `ic`, `at`, …; others print as `sys`). A named one should
    /// work, unless its feature is one we leave out (`sys_not_ours`); an unnamed
    /// one should be UNDEFINED, except in the ID space, which reads as zero.
    fn check_sys(&mut self, w: u32) -> Option<Mismatch> {
        self.mem.write(PC, 4, w as u64).unwrap();
        // A VM's vCPU with a GICv3 (its ICC_* registers; M7).
        let mut cpu = Cpu {
            pc: PC,
            cpacr_el1: 3 << 20,
            features: webpc_core::cpu::FEATURES | webpc_core::cpu::FEATURE_GICV3,
            ..Cpu::reset()
        };
        cpu.x = [0x8000; 32];
        let r = step(&mut cpu, &self.mem);
        let ours = !matches!(r, Err(Exit::Undefined));
        let insns = self.cs.disasm_count(&w.to_le_bytes(), PC, 1).ok();
        let (m, o) = insns
            .as_ref()
            .and_then(|i| i.iter().next())
            .map(|i| {
                (
                    i.mnemonic().unwrap_or("").to_string(),
                    i.op_str().unwrap_or("").to_string(),
                )
            })
            .unwrap_or(("invalid".into(), String::new()));
        let theirs = sys_named(&m, &o) && !sys_not_ours(&m, &o);
        let id_space =
            w & 0xfff8_0000 == 0xd518_0000 && (w >> 12) & 0xf == 0 && (w >> 8) & 0xf != 0
                || w & 0xfff8_0000 == 0xd538_0000 && (w >> 12) & 0xf == 0; // op0 3, op1 0, CRn 0
        // The hint space (PAC and BTI included) runs as NOPs, as in `check`.
        let hint = w & 0xffff_f01f == 0xd503_201f;
        if ours == theirs || hint || (ours && id_space && m == "mrs") {
            return None;
        }
        let what = sys_name(&m, &o);
        Some(Mismatch {
            key: format!("{} {m} {what}", if ours { "ours" } else { "UNDEFINED" }),
            detail: format!("{w:#010x}: {r:?}, capstone {m} {o}"),
        })
    }
}

/// The register or operation an MRS/MSR/SYS names, without the Xt operand.
fn sys_name<'a>(m: &str, o: &'a str) -> &'a str {
    let parts: Vec<&str> = o.split(", ").collect();
    match m {
        "mrs" => parts.get(1).copied().unwrap_or(""),
        _ => parts.first().copied().unwrap_or(""),
    }
}

/// Whether Capstone knows the register or operation (not the generic form).
fn sys_named(m: &str, o: &str) -> bool {
    let n = sys_name(m, o);
    let generic = n.starts_with('s') && n.contains("_c") && n.split('_').count() == 5;
    !matches!(m, "sys" | "sysl" | "invalid") && !generic
}

/// Named system registers and operations of features we don't have: EL2/EL3,
/// AArch32, the GICv3 CPU interface registers past 5 priority bits and NMIs, PMU, SPE, AMU, trace, RAS, SVE/SME, MTE,
/// PAuth, and the post-v8.0 PSTATE fields and maintenance operations.
fn sys_not_ours(m: &str, o: &str) -> bool {
    let n = sys_name(m, o);
    let el2_el3 = ["e2", "e3", "_el2", "_el3", "_el12", "_el02"].iter().any(|s| n.ends_with(s))
        || n.starts_with("s12e") // stage 1+2 AT
        || n.contains("e2os") || n.contains("e3os") || n.contains("e2is") || n.contains("e3is");
    not_ours(m, o)
        || el2_el3
        || SYS_NOT_OURS.iter().any(|p| n.starts_with(p))
        || SYS_NOT_OURS_OPS.iter().any(|s| n.ends_with(s))
        || matches!(m, "smstart" | "smstop" | "brb")
        || debug_beyond_two(n)
}

/// DBG{B,W}{C,V}R<n>_EL1 for n >= 2: we advertise two breakpoints and two watchpoints.
fn debug_beyond_two(n: &str) -> bool {
    ["dbgbcr", "dbgbvr", "dbgwcr", "dbgwvr"].iter().any(|p| {
        n.strip_prefix(p)
            .and_then(|r| r.strip_suffix("_el1"))
            .and_then(|k| k.parse::<u32>().ok())
            .is_some_and(|k| k >= 2)
    })
}

/// Register and operation name prefixes of features we leave out.
const SYS_NOT_OURS: &[&str] = &[
    // Secure state and AArch32: the secure physical timer, the AArch32 banked SPSRs,
    // ThumbEE; SP_EL1 is only reachable from EL2.
    "cntps_",
    "spsr_abt",
    "spsr_fiq",
    "spsr_irq",
    "spsr_und",
    "teecr",
    "teehbr",
    "sp_el1",
    // Debug state only (DLR, DSPSR).
    "dlr_",
    "dspsr_",
    // The GICv3 CPU interface's active-priority registers past 5 priority bits
    // (gicv3.rs), its NMI acknowledge (v8.8); PMU, SPE, AMU, trace (ETE/TRBE),
    // RAS, BRBE, MPAM, v8-R MPU.
    "icc_ap0r1",
    "icc_ap0r2",
    "icc_ap0r3",
    "icc_ap1r1",
    "icc_ap1r2",
    "icc_ap1r3",
    "icc_nmiar1",
    "pm",
    "trc",
    "trb",
    "trfcr",
    "amc",
    "ame",
    "amu",
    "disr",
    "err",
    "erx",
    "brb",
    "mpam",
    "mpuir",
    "prbar",
    "prlar",
    "prenr",
    "prselr",
    // SVE, SME, MTE, PAuth keys, LOR, LS64, CSV2_2 context numbers, RNG, v8.6 self-synchronized counters.
    "zcr",
    "smcr",
    "smidr",
    "smpri",
    "svcr",
    "tpidr2",
    "gcr",
    "gmid",
    "rgsr",
    "tfsr",
    "tco",
    "ap",
    "lor",
    "accdata",
    "scxtnum",
    "cntpctss",
    "cntvctss",
    "ccsidr2",
    // PSTATE fields after v8.0: PAN, UAO, SSBS (DIT is ours since ABI 59).
    "pan",
    "uao",
    "ssbs",
    // EL2 maintenance (TLBI ALLE1, VMALLS12E1, IPAS2*, AT S1E2*/S1E3*) and RME's TLBI PAALL.
    "alle1",
    "vmalls12e1",
    "ipas2",
    "s1e2",
    "s1e3",
    "paall",
    // Maintenance after v8.0: range and outer-shareable TLBI (v8.4), AT with PAN (v8.2),
    // DC to the point of persistence and the MTE tag operations.
    "rva",
    "ripa",
    "rpa",
    "cvap",
    "cvadp",
    "gva",
    "gzva",
    "cg",
    "cig",
    "ig",
];

/// Operation name suffixes of features we leave out: outer-shareable TLBI (v8.4).
const SYS_NOT_OURS_OPS: &[&str] = &["os", "e1rp", "e1wp"];

/// Encodings where we follow the M4 rather than Capstone: CONSTRAINED
/// UNPREDICTABLE ones Capstone rejects and we execute, relaxed should-be-one
/// fields, and one Capstone quirk (it rejects LDTR* with Rn == Rt).
fn unpredictable(w: u32) -> bool {
    let (t, n, t2) = (w & 31, (w >> 5) & 31, (w >> 10) & 31);
    let load = (w >> 22) & 1 == 1;
    use Op::*;
    match decode(w) {
        STP_LDP_gen | STNP_LDNP_gen => {
            let wb = decode(w) == STP_LDP_gen && matches!((w >> 23) & 3, 1 | 3);
            (load && t == t2) || (wb && n != 31 && (n == t || n == t2))
        }
        STRx_LDRx_imm_1 => n != 31 && n == t,
        STP_LDP_fpsimd | STNP_LDNP_fpsimd => load && t == t2,
        LDXP | LDAXP => t == t2 || (w >> 16) & 31 != 31,
        // Should-be-one fields relaxed in core/build.rs to match the M4; Capstone is strict.
        LDXR | LDAXR | LDAR | STLR => (w >> 16) & 31 != 31 || t2 != 31,
        SMULH | UMULH => t2 != 31,
        LDTRB | LDTRSB | LDTRH | LDTRSH | LDTR | LDTRSW | STTRB | STTRH | STTR => n == t,
        _ => false,
    }
}

/// Instructions Capstone decodes that we treat as UNDEFINED on purpose: SVE/SME
/// and the other features docs/cpu.md leaves out or we don't advertise.
fn not_ours(m: &str, ops: &str) -> bool {
    // SVE/SME operands: z0-z31, p0-p15, za tiles.
    let sve = ops.split(|c: char| !c.is_ascii_alphanumeric()).any(|w| {
        let (h, t) = w.split_at(w.len().min(1));
        (matches!(h, "z" | "p") && !t.is_empty() && t.bytes().all(|b| b.is_ascii_digit()))
            || w.starts_with("za")
    });
    // FEAT_DPB, FEAT_DPB2
    let dpb = m == "dc" && (ops.starts_with("cvap") || ops.starts_with("cvadp"));
    // FEAT_XS
    let xs = m == "dsb" && ops.ends_with("nxs");
    sve || dpb
        || xs
        || fp16(m, ops)
        || NOT_OURS.contains(&m)
        || NOT_OURS_PREFIX.iter().any(|p| m.starts_with(p))
}

/// FEAT_FP16: floating-point arithmetic, moves and conversions on half precision
/// (scalar hN or .2h/.4h/.8h lanes). FCVT, FCVTN and FCVTL to and from half are v8.0.
fn fp16(m: &str, ops: &str) -> bool {
    let fp = m.starts_with('f') || matches!(m, "scvtf" | "ucvtf");
    let half = ops
        .split(|c: char| !c.is_ascii_alphanumeric() && c != '.')
        .any(|w| {
            (w.len() >= 2 && w.starts_with('h') && w[1..].bytes().all(|b| b.is_ascii_digit()))
                || w.ends_with(".2h")
                || w.ends_with(".4h")
                || w.ends_with(".8h")
        });
    fp && half && !matches!(m, "fcvt" | "fcvtn" | "fcvtn2" | "fcvtl" | "fcvtl2")
}

const NOT_OURS: &[&str] = &[
    // FEAT_MTE
    "addg", "subg", "irg", "gmi", "subp", "subps", "cmpp", "stg", "stzg", "st2g", "stz2g", "stgp",
    "ldg", "ldgm", "stgm", "stzgm",
    // FEAT_LOR, FEAT_WFxT, FEAT_LS64 (FlagM, FlagM2 and SB are ours since ABI 59)
    "wfet", "wfit", "ld64b", "st64b", "st64bv", "st64bv0",
    // FP/AdvSIMD beyond v8.0: FEAT_FHM, FEAT_RDM, FEAT_I8MM, FEAT_FCMA, FEAT_SM3, FEAT_SM4
    // (FEAT_JSCVT and FEAT_FRINTTS are ours since ABI 59, FEAT_DotProd since 60).
    "fmlal", "fmlal2", "fmlsl", "fmlsl2",
    "sqrdmlah", "sqrdmlsh", "usdot", "sudot", "smmla", "ummla", "usmmla", "fcmla",
    "fcadd",
    // At EL0, where `check` runs: HVC and ERET are EL1-only; no EL3 (SMC), no
    // halting or external debug (HLT, DCPS1-3, DRPS).
    "hvc", "eret", "smc", "hlt", "dcps1", "dcps2", "dcps3", "drps",
    // UDF is allocated but always UNDEFINED. TME, SVE scalar forms.
    "udf", "zero", "tstart", "tcommit", "tcancel", "ttest", "addvl", "addpl", "rdvl", "addsvl",
    "addspl", "rdsvl",
];
const NOT_OURS_PREFIX: &[&str] = &[
    // FEAT_SM3/SM4, FEAT_BF16 (AES, SHA1 and SHA256 are ours since M6.5, SHA512 and SHA3 since ABI 51)
    "sm3", "sm4", "bfcvt", "bfdot", "bfmlal", "bfmmla", // FEAT_PAuth
    "pac", "aut", "xpac", "braa", "brab", "blraa", "blrab", "retaa", "retab", "eretaa", "eretab",
    "ldraa", "ldrab", // FEAT_LRCPC2, FEAT_LOR (FEAT_LRCPC's LDAPR is ours since ABI 59)
    "ldapur", "stlur", "ldlar", "stllr",
    // FEAT_HBC, FEAT_MOPS, SVE element counts
    "bc.", "cpy", "setp", "setm", "sete", "setg", "sqinc", "sqdec", "uqinc", "uqdec", "incb",
    "inch", "incw", "incd", "cterm", "setffr", "decb", "dech", "decw", "decd", "cntb", "cnth",
    "cntw", "cntd",
];
