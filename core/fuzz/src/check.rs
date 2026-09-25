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
        let cs = Capstone::new().arm64().mode(arch::arm64::ArchMode::Arm).build().unwrap();
        let mut buf = vec![0u128; RAM / 16];
        // SAFETY: buf is 16-byte aligned, RAM bytes long, and lives as long as mem.
        let mem = unsafe { Mem::new(buf.as_mut_ptr() as *mut u8, RAM as u64) };
        Checker { cs, _buf: buf, mem }
    }

    /// Executes `w` on a scratch vCPU (it must not panic) and compares
    /// "valid instruction" with Capstone. FP/AdvSIMD and EL1 system encodings
    /// (Unimplemented until M2/M3) are only executed, not compared.
    pub fn check(&mut self, w: u32) -> Option<Mismatch> {
        self.mem.write(PC, 4, w as u64).unwrap();
        let mut cpu = Cpu { pc: PC, ..Cpu::default() };
        cpu.x = [0x8000; 32];
        let r = step(&mut cpu, &self.mem);
        if matches!(r, Err(Exit::Unimplemented(_))) || unpredictable(w) {
            return None;
        }
        let ours = !matches!(r, Err(Exit::Undefined));
        let insns = self.cs.disasm_count(&w.to_le_bytes(), PC, 1).ok();
        let cs = insns.as_ref().and_then(|i| i.iter().next()).map(|i| {
            (i.mnemonic().unwrap_or("").to_string(), i.op_str().unwrap_or("").to_string())
        });
        // System registers and SYS/SYSL are EL1 system level (M3): not compared yet.
        if cs.as_ref().is_some_and(|(m, _)| matches!(m.as_str(), "mrs" | "msr" | "sys" | "sysl")) {
            return None;
        }
        // The hint space (PAC and BTI included) is ours: those run as NOPs.
        let hint = w & 0xffff_f01f == 0xd503_201f;
        let theirs = cs.as_ref().is_some_and(|(m, o)| hint || !not_ours(m, o));
        if ours == theirs {
            return None;
        }
        let op = decode(w);
        let class = if ours { format!("{op:?}") } else { format!("Undefined({op:?})") };
        let (m, o) = cs.unwrap_or(("invalid".into(), String::new()));
        Some(Mismatch { key: format!("{class} / {m}"), detail: format!("{w:#010x}: ours {class} {r:?}, capstone {m} {o}") })
    }
}

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
        LDXP | LDAXP => t == t2 || (w >> 16) & 31 != 31,
        // Should-be-one fields relaxed in core/build.rs to match the M4; Capstone is strict.
        LDXR | LDAXR | LDAR | STLR => (w >> 16) & 31 != 31 || t2 != 31,
        SMULH | UMULH => t2 != 31,
        LDTRB | LDTRSB | LDTRH | LDTRSH | LDTR | LDTRSW | STTRB | STTRH | STTR => n == t,
        _ => false,
    }
}

/// Instructions Capstone decodes that we treat as UNDEFINED on purpose: SVE/SME
/// and the other features PLAN.md §1 leaves out or we don't advertise.
fn not_ours(m: &str, ops: &str) -> bool {
    // SVE/SME operands: z0-z31, p0-p15, za tiles.
    let sve = ops.split(|c: char| !c.is_ascii_alphanumeric()).any(|w| {
        let (h, t) = w.split_at(w.len().min(1));
        (matches!(h, "z" | "p") && !t.is_empty() && t.bytes().all(|b| b.is_ascii_digit())) || w.starts_with("za")
    });
    // FEAT_DPB, FEAT_DPB2
    let dpb = m == "dc" && (ops.starts_with("cvap") || ops.starts_with("cvadp"));
    // FEAT_XS
    let xs = m == "dsb" && ops.ends_with("nxs");
    sve || dpb || xs || NOT_OURS.contains(&m) || NOT_OURS_PREFIX.iter().any(|p| m.starts_with(p))
}

const NOT_OURS: &[&str] = &[
    // FEAT_MTE
    "addg", "subg", "irg", "gmi", "subp", "subps", "cmpp", "stg", "stzg", "st2g", "stz2g", "stgp", "ldg",
    "ldgm", "stgm", "stzgm",
    // FEAT_FlagM, FEAT_FlagM2, FEAT_SB, FEAT_LOR, FEAT_WFxT, FEAT_LS64
    "cfinv", "rmif", "setf8", "setf16", "xaflag", "axflag", "sb", "wfet", "wfit", "ld64b", "st64b", "st64bv",
    "st64bv0",
    // UDF is allocated but always UNDEFINED. TME, SVE scalar forms.
    "udf", "zero", "tstart", "tcommit", "tcancel", "ttest", "addvl", "addpl", "rdvl", "addsvl", "addspl", "rdsvl",
];
const NOT_OURS_PREFIX: &[&str] = &[
    // FEAT_PAuth
    "pac", "aut", "xpac", "braa", "brab", "blraa", "blrab", "retaa", "retab", "eretaa", "eretab", "ldraa", "ldrab",
    // FEAT_LRCPC, FEAT_LRCPC2, FEAT_LOR
    "ldapr", "ldapur", "stlur", "ldlar", "stllr",
    // FEAT_HBC, FEAT_MOPS, SVE element counts
    "bc.", "cpy", "setp", "setm", "sete", "setg", "sqinc", "sqdec", "uqinc", "uqdec", "incb", "inch", "incw",
    "incd", "cterm", "setffr", "decb", "dech", "decw", "decd", "cntb", "cnth", "cntw", "cntd",
];
