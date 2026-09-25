//! EL1 system level: system registers (MRS/MSR), SYS (cache and TLB
//! maintenance), WFI/WFE traps, ERET and exception entry. The generic timer
//! and `ISR_EL1` depend on virtual time and the GIC, so their accesses exit to
//! the VM run loop ([`Exit::Platform`]), which completes them with [`platform`].
//!
//! At EL0 only op1 = 3 encodings exist (the `_EL0` registers and EL0 cache
//! maintenance); everything else there is UNDEFINED. Unknown registers are
//! UNDEFINED at EL1 too, except the ID space, which reads as zero.

use super::{Exit, R, bit, bits};
use crate::cpu::{
    Cpu, DAIF, FPCR_MASK, FPSR_MASK, M_EL0T, M_EL1H, M_EL1T, PSTATE_I, SPSR_IL, sctlr,
};
use crate::decode::Op;
use crate::mem::{Access, Fault, FaultKind};
use crate::mmu::{self, Bus, Use};

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
/// OSLSR_EL1.OSLM = 0b10: the OS lock is implemented (v8.0 requires it). It
/// only gates debug exceptions, which we don't raise, so it's just state.
const OSLM: u64 = 0b1000;

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
const ACTLR: u32 = sr(3, 0, 1, 0, 1);
const OSDTRRX: u32 = sr(2, 0, 0, 0, 2);
const OSDTRTX: u32 = sr(2, 0, 0, 3, 2);
const OSECCR: u32 = sr(2, 0, 0, 6, 2);
const MDRAR: u32 = sr(2, 0, 1, 0, 0);
const DBGAUTHSTATUS: u32 = sr(2, 0, 7, 14, 6);
const MDCCSR: u32 = sr(2, 3, 0, 1, 0);
const DBGDTR: u32 = sr(2, 3, 0, 4, 0);
/// DBGDTRRX_EL0 when read, DBGDTRTX_EL0 when written.
const DBGDTRRXTX: u32 = sr(2, 3, 0, 5, 0);
const RVBAR: u32 = sr(3, 0, 12, 0, 1);
const RMR: u32 = sr(3, 0, 12, 0, 2);
const CNTKCTL: u32 = sr(3, 0, 14, 1, 0);
const CNTFRQ: u32 = sr(3, 3, 14, 0, 0);
const CNTPCT: u32 = sr(3, 3, 14, 0, 1);
const CNTVCT: u32 = sr(3, 3, 14, 0, 2);
const CNTP_TVAL: u32 = sr(3, 3, 14, 2, 0);
const CNTP_CTL: u32 = sr(3, 3, 14, 2, 1);
const CNTP_CVAL: u32 = sr(3, 3, 14, 2, 2);
const CNTV_TVAL: u32 = sr(3, 3, 14, 3, 0);
const CNTV_CTL: u32 = sr(3, 3, 14, 3, 1);
const CNTV_CVAL: u32 = sr(3, 3, 14, 3, 2);

/// Registers that read as zero and ignore writes: IMPLEMENTATION DEFINED ones
/// with nothing to control (ACTLR, AMAIR, AFSR0/1), CSSELR (CLIDR reports no
/// caches), and the debug registers (see `ID_AA64DFR0`), including the OS
/// save/restore and debug communications channel ones.
fn raz_wi(key: u32) -> bool {
    matches!(
        key,
        ACTLR
            | AMAIR
            | AFSR0
            | AFSR1
            | CSSELR
            | MDCCINT
            | OSDLR
            | DBGPRCR
            | DBGCLAIMSET
            | DBGCLAIMCLR
            | OSDTRRX
            | OSDTRTX
            | OSECCR
            | DBGDTR
            | DBGDTRRXTX
    ) || key & !0b1011 == sr(2, 0, 0, 0, 4) // DBGB{V,C}R<n>, DBGW{V,C}R<n>, n = 0, 1
}

pub(super) fn exec(c: &mut Cpu, m: &mut impl Bus, i: u32, op: Op) -> R {
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
            // WFE completes at once: one vCPU, so nothing to wait for (M7).
            if op == WFI {
                return Err(Exit::Wfi);
            }
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
        MSR_reg => write(c, m, i, key, c.reg(rt))?,
        MSR_imm => {
            let (op1, op2, crm) = (bits(i, 18, 16), bits(i, 7, 5), bits(i, 11, 8) as u64);
            match (op1, op2) {
                (3, 6 | 7) => {
                    if el0 && c.sctlr_el1 & sctlr::UMA == 0 {
                        return Err(trap_sys(i));
                    }
                    let (d, before) = (crm << 6, c.pstate);
                    c.pstate = if op2 == 6 {
                        c.pstate | d
                    } else {
                        c.pstate & !d
                    };
                    return unmasked(before, c);
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
                m.write(c, a + 8 * k, 8, 0)?;
            }
        }
        // No caches to maintain, but the address must translate (and, from
        // EL0, be readable) like a data access. M5 hooks JIT invalidation into
        // IC IVAU and IALLU.
        DC_CVAC | DC_CVAU | DC_CIVAC | IC_IVAU => {
            if el0 && c.sctlr_el1 & sctlr::UCI == 0 {
                return Err(trap_sys(i));
            }
            m.maint(c, c.reg(rt), false)?;
        }
        DC_IVAC => m.maint(c, c.reg(rt), true)?,
        DC_ISW | DC_CSW | DC_CISW | IC_IALLU | IC_IALLUIS => {}
        SYS => match (
            bits(i, 18, 16),
            bits(i, 15, 12),
            bits(i, 11, 8),
            bits(i, 7, 5),
        ) {
            // TLBI VMALLE1 and ASIDE1 (the TLB holds no ASIDs), and their IS
            // forms. One vCPU until M7, so IS is local.
            (0, 8, 3 | 7, 0 | 2) => m.flush_all(),
            // IC IALLU(IS) with Rt != 31 (should-be-ones): as with 31.
            (0, 7, 5 | 1, 0) => {}
            // TLBI VAE1, VAAE1, VALE1, VAALE1 (IS): Xt[43:0] is VA[55:12].
            (0, 8, 3 | 7, 1 | 3 | 5 | 7) => m.flush_va(c.reg(rt) << 12),
            // AT S1E1R, S1E1W, S1E0R, S1E0W.
            (0, 7, 8, op2 @ 0..=3) => {
                let u = if op2 & 1 == 1 { Use::Write } else { Use::Read };
                c.par_el1 = mmu::at(c, m.mem(), c.reg(rt), (op2 < 2) as u64, u);
            }
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
        CNTFRQ | CNTPCT | CNTVCT | CNTP_TVAL | CNTP_CTL | CNTP_CVAL | CNTV_TVAL | CNTV_CTL
        | CNTV_CVAL => return timer(c, i, key),
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
        ISR => return Err(Exit::Platform(i)),
        CNTKCTL => c.cntkctl_el1,
        CONTEXTIDR => c.contextidr_el1,
        TPIDR_EL1 => c.tpidr_el1,
        MDSCR => c.mdscr_el1,
        OSLSR_R => OSLM | c.os_lock,
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
        // Read-only: no debug ROM (MDRAR.Valid = 0), no debug authentication
        // signals, no DCC traffic; RVBAR (EL1 is the highest EL) is IMPLEMENTATION
        // DEFINED; RMR's AA64 is RAO (AArch64 only).
        MDRAR | DBGAUTHSTATUS | MDCCSR | RVBAR => 0,
        RMR => 1,
        _ => return Err(Exit::Undefined),
    })
}

fn write(c: &mut Cpu, m: &mut impl Bus, i: u32, key: u32, v: u64) -> R {
    let el0 = c.el() == 0;
    // The TLB holds neither ASIDs nor the MMU enable: flush when either changes.
    let regime = |c: &Cpu| (mmu::asid(c), c.sctlr_el1 & sctlr::M);
    let (before, copy, pstate) = (regime(c), c.sctlr_el1 & (sctlr::M | sctlr::A), c.pstate);
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
        // CNTFRQ_EL0 is writable only at the highest EL, which is EL1 here; the
        // frequency is the VM's, so the write is ignored.
        CNTFRQ if !el0 => {}
        CNTP_TVAL | CNTP_CTL | CNTP_CVAL | CNTV_TVAL | CNTV_CTL | CNTV_CVAL => {
            timer(c, i, key)?;
        }
        CNTKCTL => c.cntkctl_el1 = v & 0x3ff,
        SPSR_EL1 => c.spsr_el1 = v,
        ELR_EL1 => c.elr_el1 = v,
        SP_EL0 if c.pstate & 1 == 1 => c.sp_other = v,
        SPSEL => c.set_pstate(c.pstate & !1 | v & 1),
        SCTLR => c.sctlr_el1 = (v | sctlr::RES1) & !sctlr::ENDIAN,
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
        OSLAR => c.os_lock = (v & 1) << 1,
        k if raz_wi(k) => {}
        RMR => {} // a warm reset request (RR) isn't honored
        _ => return Err(Exit::Undefined),
    }
    if regime(c) != before {
        m.flush_all();
    }
    if c.sctlr_el1 & (sctlr::M | sctlr::A) != copy {
        return Err(Exit::Resync); // retired; the run loop switches interpreter copy
    }
    unmasked(pstate, c)
}

/// After a DAIF write: if it cleared PSTATE.I, `Exit::Resync` (retired) makes
/// the VM run loop check for a pending IRQ before the next instruction.
fn unmasked(before: u64, c: &Cpu) -> R {
    if before & !c.pstate & PSTATE_I != 0 {
        return Err(Exit::Resync);
    }
    Ok(())
}

/// A generic timer register access: the EL0 checks from CNTKCTL_EL1 (EL0PCTEN,
/// EL0VCTEN, EL0VTEN, EL0PTEN; CNTFRQ needs either counter enable), then the
/// run loop completes it. A read-only register written is UNDEFINED.
fn timer(c: &Cpu, i: u32, key: u32) -> R<u64> {
    let read = bit(i, 21);
    let need = match key {
        CNTPCT | CNTVCT if !read => return Err(Exit::Undefined),
        CNTFRQ => 0b11,
        CNTPCT => 1 << 0,
        CNTVCT => 1 << 1,
        CNTV_TVAL | CNTV_CTL | CNTV_CVAL => 1 << 8,
        _ => 1 << 9,
    };
    if c.el() == 0 && c.cntkctl_el1 & need == 0 {
        return Err(trap_sys(i));
    }
    Err(Exit::Platform(i))
}

/// Whether a timer's interrupt condition is met: enabled, not masked, and the
/// count has reached the compare value.
pub fn timer_fires(ctl: u64, cval: u64, now: u64) -> bool {
    ctl & 3 == 1 && now >= cval
}

/// Completes an [`Exit::Platform`] access (the MRS or MSR `i`) at counter value
/// `now`, with frequency `frq` and `irq` the GIC's IRQ signal (for `ISR_EL1`).
/// The caller retires the instruction.
pub fn platform(c: &mut Cpu, i: u32, now: u64, frq: u64, irq: bool) {
    let (key, rt, read) = (bits(i, 20, 5), bits(i, 4, 0), bit(i, 21));
    let v = c.reg(rt);
    let (ctl, cval) = match key {
        CNTP_TVAL | CNTP_CTL | CNTP_CVAL => (&mut c.cntp_ctl_el0, &mut c.cntp_cval_el0),
        _ => (&mut c.cntv_ctl_el0, &mut c.cntv_cval_el0),
    };
    let r = match key {
        CNTFRQ => frq,
        CNTPCT | CNTVCT => now,
        ISR => (irq as u64) << 7,
        // ISTATUS: the condition is met (reported only while enabled).
        CNTP_CTL | CNTV_CTL if read => *ctl | ((*ctl & 1 == 1 && now >= *cval) as u64) << 2,
        CNTP_CTL | CNTV_CTL => {
            *ctl = v & 3;
            return;
        }
        CNTP_CVAL | CNTV_CVAL if read => *cval,
        CNTP_CVAL | CNTV_CVAL => {
            *cval = v;
            return;
        }
        // TVAL: a signed 32-bit view of CVAL - count.
        _ if read => cval.wrapping_sub(now) as u32 as u64,
        _ => {
            *cval = now.wrapping_add(v as i32 as u64);
            return;
        }
    };
    c.set_reg(rt, r);
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
/// On `Exit::Hvc` and `Exit::Unimplemented`, which are for the host, and `Exit::Resync`.
pub fn take_exception(c: &mut Cpu, e: Exit) {
    let pc = c.pc;
    let lower = c.el() == 0;
    // Instruction abort 0x20, data abort 0x24; +1 when taken from EL1. ISS:
    // CM (8), WnR (6), and the fault status.
    let abort = |ec: u32, f: Fault| {
        let (wnr, cm) = match f.access {
            Access::Read => (0, 0),
            Access::Write => (1, 0),
            Access::Maint => (1, 1),
        };
        (ec + !lower as u32) << 26 | cm << 8 | wnr << 6 | f.kind.fsc()
    };
    let (esr, far, ret) = match e {
        Exit::Undefined => (0, None, pc),
        Exit::Svc(imm) => (0x15 << 26 | imm as u32, None, pc.wrapping_add(4)),
        Exit::Brk(imm) => (0x3c << 26 | imm as u32, None, pc),
        Exit::Trap(esr) => (esr, None, pc),
        Exit::Fault(f) => (abort(0x24, f), Some(f.addr), pc),
        Exit::Fetch(Fault {
            kind: FaultKind::Align,
            ..
        }) => (0x22 << 26, Some(pc), pc),
        Exit::Fetch(f) => (abort(0x20, f), Some(f.addr), pc),
        Exit::Hvc(_) | Exit::Unimplemented(_) | Exit::Resync | Exit::Wfi | Exit::Platform(_) => {
            panic!("{e:?} is no exception")
        }
    };
    enter(c, esr, far, ret, 0);
}

/// Takes an IRQ into EL1 before the instruction at `c.pc` (vector +0x80; ESR
/// and FAR are left alone).
pub fn take_irq(c: &mut Cpu) {
    vector(c, c.pc, 0, 0x80);
}

/// Synchronous exception entry to EL1h: ESR (IL = 1, all our instructions are
/// 32-bit), FAR if the class sets it, then [`vector`].
fn enter(c: &mut Cpu, esr: u32, far: Option<u64>, ret: u64, spsr_extra: u64) {
    c.esr_el1 = (esr | 1 << 25) as u64;
    if let Some(a) = far {
        c.far_el1 = a;
    }
    vector(c, ret, spsr_extra, 0);
}

/// Exception entry: ELR, SPSR (plus `spsr_extra`), DAIF masked, EL1h, and the
/// PC at the vector for the exception's origin plus `kind` (0 synchronous, 0x80 IRQ).
fn vector(c: &mut Cpu, ret: u64, spsr_extra: u64, kind: u64) {
    let base = match (c.el(), c.pstate & 1) {
        (0, _) => 0x400, // lower EL, AArch64
        (_, 1) => 0x200, // current EL with SP_EL1
        _ => 0,          // current EL with SP_EL0
    };
    c.elr_el1 = ret;
    c.spsr_el1 = c.nzcv | c.pstate | spsr_extra;
    c.monitor.size = 0;
    c.set_pstate(M_EL1H | DAIF);
    c.pc = c.vbar_el1.wrapping_add(base + kind);
}
