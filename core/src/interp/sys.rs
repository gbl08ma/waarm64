//! EL1 system level: system registers (MRS/MSR), SYS (cache and TLB
//! maintenance), WFI/WFE traps, ERET and exception entry.
//!
//! At EL0 only op1 = 3 encodings exist (the `_EL0` registers and EL0 cache
//! maintenance); everything else there is UNDEFINED. Unknown registers are
//! UNDEFINED at EL1 too, except the ID space, which reads as zero.

use super::{Exit, R, bits};
use crate::cpu::{Cpu, DAIF, FPCR_MASK, FPSR_MASK, M_EL0T, M_EL1H, M_EL1T, SPSR_IL, sctlr};
use crate::decode::Op;
use crate::mem::{Fault, Mem};

/// ISS CV = 1, COND = 0xE (AL): the condition fields for trapped AArch64
/// instructions, as QEMU reports them (Linux ignores them).
pub(super) const ISS_COND_AL: u32 = 1 << 24 | 0xe << 20;

/// System register encoding op0:op1:CRn:CRm:op2, as in instruction bits 20:5.
const fn sr(op0: u32, op1: u32, crn: u32, crm: u32, op2: u32) -> u32 {
    op0 << 14 | op1 << 11 | crn << 7 | crm << 3 | op2
}

// Identification. Everything here describes exactly what the core implements.
/// Implementer 0 (reserved for software use), architecture 0xf (see the ID registers).
const MIDR: u64 = 0x000f_0000;
/// Aff0 = 0, U = 0. M7 gives each vCPU its own.
const MPIDR: u64 = 1 << 31;
/// EL0 and EL1 AArch64 only; FP and AdvSIMD 0 (present, no FP16); GIC 0 (no
/// system register interface). CSV2 and CSV3: the interpreter and JIT don't
/// speculate, and saying so spares the guest Spectre mitigations and KPTI.
const ID_AA64PFR0: u64 = 1 << 60 | 1 << 56 | 1 << 4 | 1;
/// DebugVer v8.0, 2 breakpoints, 2 watchpoints, 1 context comparator (the
/// architectural minimum), no PMU.
// ponytail: the debug registers are RAZ/WI and no debug exceptions are raised
// (breakpoints, watchpoints, MDSCR_EL1.SS); M9 lists it.
const ID_AA64DFR0: u64 = 1 << 20 | 1 << 12 | 6;
/// LSE atomics (2) and CRC32. No AES/PMULL/SHA until M6.5, nothing past v8.1.
const ID_AA64ISAR0: u64 = 2 << 20 | 1 << 16;
/// 4K granule only (TGran64 = 0xf, TGran16 = 0), 16-bit ASIDs, 40-bit PA.
const ID_AA64MMFR0: u64 = 0xf << 24 | 2 << 4 | 2;
/// DIC = 0 (guests issue IC IVAU; PLAN.md §2), IDC = 1 (no data cache to clean),
/// CWG, ERG, DminLine = 64 bytes, PIPT I-cache, IminLine = 64 bytes.
const CTR_EL0: u64 = 1 << 31 | 1 << 28 | 4 << 24 | 4 << 20 | 4 << 16 | 3 << 14 | 4;
/// DC ZVA block: BS = 4 (64 bytes, as on the M4).
const DCZID_BS: u64 = 4;
/// OSLSR_EL1: the OS lock is implemented (OSLM = 0b10) and unlocked.
// ponytail: OSLAR_EL1 writes are ignored, so OSLK always reads 0.
const OSLSR: u64 = 0b1000;

const NZCV: u32 = sr(3, 3, 4, 2, 0);
const DAIF_R: u32 = sr(3, 3, 4, 2, 1);
const FPCR: u32 = sr(3, 3, 4, 4, 0);
const FPSR: u32 = sr(3, 3, 4, 4, 1);
const CTR: u32 = sr(3, 3, 0, 0, 1);
const DCZID: u32 = sr(3, 3, 0, 0, 7);
const TPIDR_EL0: u32 = sr(3, 3, 13, 0, 2);
const TPIDRRO_EL0: u32 = sr(3, 3, 13, 0, 3);
const SPSR_EL1: u32 = sr(3, 0, 4, 0, 0);
const ELR_EL1: u32 = sr(3, 0, 4, 0, 1);
const SP_EL0: u32 = sr(3, 0, 4, 1, 0);
const SPSEL: u32 = sr(3, 0, 4, 2, 0);
const CURRENT_EL: u32 = sr(3, 0, 4, 2, 2);
const SCTLR: u32 = sr(3, 0, 1, 0, 0);
const CPACR: u32 = sr(3, 0, 1, 0, 2);
const TTBR0: u32 = sr(3, 0, 2, 0, 0);
const TTBR1: u32 = sr(3, 0, 2, 0, 1);
const TCR: u32 = sr(3, 0, 2, 0, 2);
const ESR: u32 = sr(3, 0, 5, 2, 0);
const FAR: u32 = sr(3, 0, 6, 0, 0);
const PAR: u32 = sr(3, 0, 7, 4, 0);
const MAIR: u32 = sr(3, 0, 10, 2, 0);
const VBAR: u32 = sr(3, 0, 12, 0, 0);
const ISR: u32 = sr(3, 0, 12, 1, 0);
const CONTEXTIDR: u32 = sr(3, 0, 13, 0, 1);
const TPIDR_EL1: u32 = sr(3, 0, 13, 0, 4);
const MDSCR: u32 = sr(2, 0, 0, 2, 2);
const OSLAR: u32 = sr(2, 0, 1, 0, 4);
const OSLSR_R: u32 = sr(2, 0, 1, 1, 4);
const MIDR_R: u32 = sr(3, 0, 0, 0, 0);
const MPIDR_R: u32 = sr(3, 0, 0, 0, 5);
const REVIDR: u32 = sr(3, 0, 0, 0, 6);
const PFR0: u32 = sr(3, 0, 0, 4, 0);
const DFR0: u32 = sr(3, 0, 0, 5, 0);
const ISAR0: u32 = sr(3, 0, 0, 6, 0);
const MMFR0: u32 = sr(3, 0, 0, 7, 0);
const CCSIDR: u32 = sr(3, 1, 0, 0, 0);
const CLIDR: u32 = sr(3, 1, 0, 0, 1);
const AIDR: u32 = sr(3, 1, 0, 0, 7);
const AMAIR: u32 = sr(3, 0, 10, 3, 0);
const AFSR0: u32 = sr(3, 0, 5, 1, 0);
const AFSR1: u32 = sr(3, 0, 5, 1, 1);
const CSSELR: u32 = sr(3, 2, 0, 0, 0);
const MDCCINT: u32 = sr(2, 0, 0, 2, 0);
const OSDLR: u32 = sr(2, 0, 1, 3, 4);
const DBGPRCR: u32 = sr(2, 0, 1, 4, 4);
const DBGCLAIMSET: u32 = sr(2, 0, 7, 8, 6);
const DBGCLAIMCLR: u32 = sr(2, 0, 7, 9, 6);

/// Registers that read as zero and ignore writes: IMPLEMENTATION DEFINED ones
/// with nothing to control (AMAIR, AFSR0/1), CSSELR (CLIDR reports no caches),
/// and the debug registers (see `ID_AA64DFR0`).
fn raz_wi(key: u32) -> bool {
    matches!(
        key,
        AMAIR | AFSR0 | AFSR1 | CSSELR | MDCCINT | OSDLR | DBGPRCR | DBGCLAIMSET | DBGCLAIMCLR
    ) || key & !0b1011 == sr(2, 0, 0, 0, 4) // DBGB{V,C}R<n>, DBGW{V,C}R<n>, n = 0, 1
}

pub(super) fn exec(c: &mut Cpu, m: &Mem, i: u32, op: Op) -> R {
    use Op::*;
    let el0 = c.el() == 0;
    let rt = bits(i, 4, 0);
    let key = bits(i, 20, 5);
    match op {
        WFI | WFE => {
            let allowed = if op == WFI { sctlr::NTWI } else { sctlr::NTWE };
            if el0 && c.sctlr_el1 & allowed == 0 {
                return Err(Exit::Trap(0x01 << 26 | ISS_COND_AL | (op == WFE) as u32));
            }
            // ponytail: completes at once; step 4 gives WFI wake-up semantics.
        }
        ERET if !el0 => eret(c),
        HVC if !el0 => return Err(Exit::Hvc(bits(i, 20, 5) as u16)),
        // No EL2/EL3, no halting or external debug.
        ERET | HVC | SMC | HLT | DCPS1 | DCPS2 | DCPS3 | DRPS | SYSL => {
            return Err(Exit::Undefined);
        }
        _ if el0 && bits(i, 18, 16) != 3 => return Err(Exit::Undefined),
        MRS => {
            let v = read(c, i, key)?;
            c.set_reg(rt, v);
        }
        MSR_reg => write(c, i, key, c.reg(rt))?,
        MSR_imm => {
            let (op1, op2, crm) = (bits(i, 18, 16), bits(i, 7, 5), bits(i, 11, 8) as u64);
            match (op1, op2) {
                (3, 6 | 7) => {
                    if el0 && c.sctlr_el1 & sctlr::UMA == 0 {
                        return Err(trap_sys(i));
                    }
                    let d = crm << 6;
                    c.pstate = if op2 == 6 {
                        c.pstate | d
                    } else {
                        c.pstate & !d
                    };
                }
                (0, 5) => c.set_pstate(c.pstate & !1 | crm & 1), // SPSel
                _ => return Err(Exit::Undefined), // PAN, UAO, DIT, SSBS, TCO: not implemented
            }
        }
        DC_ZVA => {
            if el0 && c.sctlr_el1 & sctlr::DZE == 0 {
                return Err(trap_sys(i));
            }
            let a = c.reg(rt) & !63;
            for k in 0..8 {
                m.write(a + 8 * k, 8, 0)?;
            }
        }
        // No caches to maintain. M5 hooks JIT invalidation into IC IVAU and IALLU.
        // ponytail: no MMU permission/translation checks yet (step 3).
        DC_CVAC | DC_CVAU | DC_CIVAC | IC_IVAU => {
            if el0 && c.sctlr_el1 & sctlr::UCI == 0 {
                return Err(trap_sys(i));
            }
        }
        DC_IVAC | DC_ISW | DC_CSW | DC_CISW | IC_IALLU | IC_IALLUIS => {}
        SYS => match (
            bits(i, 18, 16),
            bits(i, 15, 12),
            bits(i, 11, 8),
            bits(i, 7, 5),
        ) {
            // TLBI VMALLE1, VAE1, ASIDE1, VAAE1, VALE1, VAALE1 and their IS forms.
            // ponytail: no TLB until step 3, so there's nothing to invalidate.
            (0, 8, 3 | 7, 0 | 1 | 2 | 3 | 5 | 7) => {}
            // AT S1E1R/W, S1E0R/W: step 3.
            (0, 7, 8, 0..=3) => return Err(Exit::Unimplemented(op)),
            _ => return Err(Exit::Undefined),
        },
        _ => unreachable!("{op:?} isn't a system instruction"),
    }
    Ok(())
}

/// EC 0x18: a trapped MSR, MRS or SYS, with the ISS the architecture defines
/// (op0, op2, op1, CRn, Rt, CRm, direction), straight from the encoding.
fn trap_sys(i: u32) -> Exit {
    Exit::Trap(
        0x18 << 26
            | bits(i, 20, 19) << 20
            | bits(i, 7, 5) << 17
            | bits(i, 18, 16) << 14
            | bits(i, 15, 12) << 10
            | bits(i, 4, 0) << 5
            | bits(i, 11, 8) << 1
            | bits(i, 21, 21),
    )
}

fn read(c: &Cpu, i: u32, key: u32) -> R<u64> {
    let el0 = c.el() == 0;
    Ok(match key {
        NZCV => c.nzcv,
        DAIF_R if el0 && c.sctlr_el1 & sctlr::UMA == 0 => return Err(trap_sys(i)),
        DAIF_R => c.pstate & DAIF,
        FPCR => {
            super::fp_enabled(c)?;
            c.fpcr
        }
        FPSR => {
            super::fp_enabled(c)?;
            c.fpsr
        }
        CTR if el0 && c.sctlr_el1 & sctlr::UCT == 0 => return Err(trap_sys(i)),
        CTR => CTR_EL0,
        DCZID => DCZID_BS | ((el0 && c.sctlr_el1 & sctlr::DZE == 0) as u64) << 4,
        TPIDR_EL0 => c.tpidr_el0,
        TPIDRRO_EL0 => c.tpidrro_el0,
        // EL1 from here on: exec has rejected op1 != 3 at EL0.
        SPSR_EL1 => c.spsr_el1,
        ELR_EL1 => c.elr_el1,
        SP_EL0 if c.pstate & 1 == 1 => c.sp_other,
        SPSEL => c.pstate & 1,
        CURRENT_EL => c.pstate & 0b1100,
        SCTLR => c.sctlr_el1,
        CPACR => c.cpacr_el1,
        TTBR0 => c.ttbr0_el1,
        TTBR1 => c.ttbr1_el1,
        TCR => c.tcr_el1,
        ESR => c.esr_el1,
        FAR => c.far_el1,
        PAR => c.par_el1,
        MAIR => c.mair_el1,
        VBAR => c.vbar_el1,
        // ponytail: no interrupt sources until step 4.
        ISR => 0,
        CONTEXTIDR => c.contextidr_el1,
        TPIDR_EL1 => c.tpidr_el1,
        MDSCR => c.mdscr_el1,
        OSLSR_R => OSLSR,
        MIDR_R => MIDR,
        MPIDR_R => MPIDR,
        REVIDR => 0,
        PFR0 => ID_AA64PFR0,
        DFR0 => ID_AA64DFR0,
        ISAR0 => ID_AA64ISAR0,
        MMFR0 => ID_AA64MMFR0,
        // The rest of the ID space (op1 = 0, CRn = 0, CRm = 1..7) is RAZ: the
        // AArch32 ID registers (no AArch32) and everything past v8.0 we don't have.
        k if k >> 7 == MIDR_R >> 7 && (1..=7).contains(&((k >> 3) & 0xf)) => 0,
        CCSIDR | CLIDR => 0, // no caches
        AIDR => 0,
        k if raz_wi(k) => 0,
        _ => return Err(Exit::Undefined),
    })
}

fn write(c: &mut Cpu, i: u32, key: u32, v: u64) -> R {
    let el0 = c.el() == 0;
    match key {
        NZCV => c.nzcv = v & 0xf000_0000,
        DAIF_R if el0 && c.sctlr_el1 & sctlr::UMA == 0 => return Err(trap_sys(i)),
        DAIF_R => c.pstate = c.pstate & !DAIF | v & DAIF,
        FPCR => {
            super::fp_enabled(c)?;
            c.fpcr = v & FPCR_MASK;
        }
        FPSR => {
            super::fp_enabled(c)?;
            c.fpsr = v & FPSR_MASK;
        }
        TPIDR_EL0 => c.tpidr_el0 = v,
        TPIDRRO_EL0 if !el0 => c.tpidrro_el0 = v,
        SPSR_EL1 => c.spsr_el1 = v,
        ELR_EL1 => c.elr_el1 = v,
        SP_EL0 if c.pstate & 1 == 1 => c.sp_other = v,
        SPSEL => c.set_pstate(c.pstate & !1 | v & 1),
        SCTLR => c.sctlr_el1 = v & !sctlr::ENDIAN,
        CPACR => c.cpacr_el1 = v & 3 << 20,
        TTBR0 => c.ttbr0_el1 = v,
        TTBR1 => c.ttbr1_el1 = v,
        TCR => c.tcr_el1 = v,
        ESR => c.esr_el1 = v as u32 as u64,
        FAR => c.far_el1 = v,
        PAR => c.par_el1 = v,
        MAIR => c.mair_el1 = v,
        VBAR => c.vbar_el1 = v & !0x7ff,
        CONTEXTIDR => c.contextidr_el1 = v as u32 as u64,
        TPIDR_EL1 => c.tpidr_el1 = v,
        MDSCR => c.mdscr_el1 = v,
        OSLAR => {}
        k if raz_wi(k) => {}
        _ => return Err(Exit::Undefined),
    }
    Ok(())
}

/// ERET from EL1. An illegal return (to EL2/EL3, AArch32 or "EL0h") stays at
/// EL1 and restores only NZCV and DAIF; that, or SPSR.IL set, makes the next
/// instruction take an Illegal Execution State exception, which is taken right
/// here with the return target as its preferred return address.
fn eret(c: &mut Cpu) {
    let (spsr, target) = (c.spsr_el1, c.elr_el1);
    let m = spsr & 0x1f;
    let legal = matches!(m, M_EL0T | M_EL1T | M_EL1H);
    c.nzcv = spsr & 0xf000_0000;
    c.monitor.size = 0;
    c.set_pstate(if legal { m } else { c.pstate & 0xf } | spsr & DAIF);
    c.pc = target;
    if !legal || spsr & SPSR_IL != 0 {
        enter(c, 0x0e << 26, None, target, SPSR_IL);
    }
}

/// Takes the synchronous exception `e`, raised by the instruction at `c.pc`, into EL1.
///
/// # Panics
/// On `Exit::Hvc` and `Exit::Unimplemented`, which are for the host.
pub fn take_exception(c: &mut Cpu, e: Exit) {
    let pc = c.pc;
    let lower = c.el() == 0;
    // Instruction abort 0x20, data abort 0x24; +1 when taken from EL1.
    let abort = |ec: u32, f: Fault| {
        let (fsc, write) = match f {
            Fault::Bus { write, .. } => (0x10, write), // synchronous external abort
            Fault::Align { write, .. } => (0x21, write),
        };
        (ec + !lower as u32) << 26 | (write as u32) << 6 | fsc
    };
    let addr = |f: Fault| match f {
        Fault::Bus { addr, .. } | Fault::Align { addr, .. } => addr,
    };
    let (esr, far, ret) = match e {
        Exit::Undefined => (0, None, pc),
        Exit::Svc(imm) => (0x15 << 26 | imm as u32, None, pc.wrapping_add(4)),
        Exit::Brk(imm) => (0x3c << 26 | imm as u32, None, pc),
        Exit::Trap(esr) => (esr, None, pc),
        Exit::Fault(f) => (abort(0x24, f), Some(addr(f)), pc),
        Exit::Fetch(Fault::Align { .. }) => (0x22 << 26, Some(pc), pc),
        Exit::Fetch(f) => (abort(0x20, f), Some(addr(f)), pc),
        Exit::Hvc(_) | Exit::Unimplemented(_) => panic!("{e:?} is a host exit"),
    };
    enter(c, esr, far, ret, 0);
}

/// Exception entry to EL1h: ESR (IL = 1, all our instructions are 32-bit), FAR
/// if the class sets it, ELR, SPSR (plus `spsr_extra`), DAIF masked, the vector.
fn enter(c: &mut Cpu, esr: u32, far: Option<u64>, ret: u64, spsr_extra: u64) {
    let vector = match (c.el(), c.pstate & 1) {
        (0, _) => 0x400, // lower EL, AArch64
        (_, 1) => 0x200, // current EL with SP_EL1
        _ => 0,          // current EL with SP_EL0
    };
    c.esr_el1 = (esr | 1 << 25) as u64;
    if let Some(a) = far {
        c.far_el1 = a;
    }
    c.elr_el1 = ret;
    c.spsr_el1 = c.nzcv | c.pstate | spsr_extra;
    c.monitor.size = 0;
    c.set_pstate(M_EL1H | DAIF);
    c.pc = c.vbar_el1.wrapping_add(vector);
}
