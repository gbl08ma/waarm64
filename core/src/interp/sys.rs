//! EL1 system level: system registers (MRS/MSR), SYS (cache and TLB
//! maintenance), WFI/WFE traps, ERET and exception entry. The generic timer
//! and `ISR_EL1` depend on virtual time and the GIC, so their accesses exit to
//! the VM run loop ([`Exit::Platform`]), which completes them with [`platform`].
//!
//! At EL0 only op1 = 3 encodings exist (the `_EL0` registers and EL0 cache
//! maintenance); everything else there is UNDEFINED. Unknown registers are
//! UNDEFINED at EL1 too, except the ID space, which reads as zero.

use super::{Exit, R, bit, bits, debug};
use crate::cpu::{
    Cpu, DAIF, FPCR_MASK, FPSR_MASK, M_EL0T, M_EL1H, M_EL1T, PSTATE_I, PSTATE_SS, SPSR_IL, sctlr,
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
pub(crate) const MIDR: u64 = 0x000f_0000;
/// EL0 and EL1 AArch64 only; FP and AdvSIMD 0 (present, no FP16); GIC 0 (no
/// system register interface; 1 with `FEATURE_GICV3`, `pfr0`). CSV2 and CSV3:
/// the interpreter and JIT don't speculate, and saying so spares the guest
/// Spectre mitigations and KPTI.
const ID_AA64PFR0: u64 = 1 << 60 | 1 << 56 | 1 << 4 | 1;

/// ID_AA64PFR0_EL1 for a vCPU with `features`.
pub fn pfr0(features: u64) -> u64 {
    ID_AA64PFR0 | ((features & crate::cpu::FEATURE_GICV3 != 0) as u64) << 24
}

/// The GICv3 CPU interface register an MSR/MRS key (bits 20:5) names, if
/// the vCPU has one (`FEATURE_GICV3`). Its accesses complete in the VM run
/// loop (`Exit::Platform`), at EL1 (op1 = 0: UNDEFINED at EL0).
pub fn icc(features: u64, key: u32) -> Option<crate::gicv3::Icc> {
    if features & crate::cpu::FEATURE_GICV3 == 0 || key >> 11 != 0b11_000 {
        return None;
    }
    crate::gicv3::Icc::decode(key >> 7 & 0xf, key >> 3 & 0xf, key & 7)
}
/// DebugVer v8.0, 2 breakpoints, 2 watchpoints, 1 context comparator (the
/// architectural minimum), no PMU. Self-hosted debug is `debug`'s.
const ID_AA64DFR0: u64 = 1 << 20 | 1 << 12 | 6;
/// LSE atomics (2) and CRC32; nothing past v8.1. AES (2: with PMULL), SHA1
/// and SHA2 with `FEATURE_CRYPTO`, SHA2 = 2 (SHA512) and SHA3 with it and
/// `FEATURE_SHA3`, RNDR with `FEATURE_RNG` (`isar0`).
const ID_AA64ISAR0: u64 = 2 << 20 | 1 << 16;
const ISAR0_CRYPTO: u64 = 1 << 12 | 1 << 8 | 2 << 4;
const ISAR0_SHA3: u64 = 2 << 12 | 1 << 32;
const ISAR0_RNDR: u64 = 1 << 60;

/// ID_AA64ISAR0_EL1 for a vCPU with `features`.
pub fn isar0(features: u64) -> u64 {
    let has = |f: u64, v: u64| if features & f != 0 { v } else { 0 };
    let r = ID_AA64ISAR0
        | has(crate::cpu::FEATURE_CRYPTO, ISAR0_CRYPTO)
        | has(crate::cpu::FEATURE_RNG, ISAR0_RNDR);
    if crate::cpu::has_sha3(features) {
        r & !(0xf << 12) | ISAR0_SHA3
    } else {
        r
    }
}
/// 4K granule only (TGran64 = 0xf, TGran16 = 0), 16-bit ASIDs, 40-bit PA.
const ID_AA64MMFR0: u64 = 0xf << 24 | 2 << 4 | 2;

/// ID_AA64MMFR2_EL1 for a vCPU with `features`: E0PD with `FEATURE_E0PD`, else nothing.
pub fn mmfr2(features: u64) -> u64 {
    ((features & crate::cpu::FEATURE_E0PD != 0) as u64) << 60
}
/// DIC = 0 (guests issue IC IVAU; docs/jit.md), IDC = 1 (no data cache to clean),
/// CWG, ERG, DminLine = 64 bytes, PIPT I-cache, IminLine = 2 KiB (the largest
/// line there is: an IC drops the whole page whatever the line, so a guest that
/// steps by it issues 2 a page instead of 64; docs/jit.md "Invalidation and the stale-code checker").
const CTR_EL0: u64 = 1 << 31 | 1 << 28 | 4 << 24 | 4 << 20 | 4 << 16 | 3 << 14 | 9;
/// DC ZVA block: BS = 4 (64 bytes, as on the M4).
pub const DCZID_BS: u64 = 4;
/// OSLSR_EL1.OSLM = 0b10: the OS lock is implemented (v8.0 requires it); it
/// disables the debug exceptions (`debug`) while set.
const OSLM: u64 = 0b1000;

const NZCV: u32 = sr(3, 3, 4, 2, 0);
const DAIF_R: u32 = sr(3, 3, 4, 2, 1);
const FPCR: u32 = sr(3, 3, 4, 4, 0);
const FPSR: u32 = sr(3, 3, 4, 4, 1);
const CTR: u32 = sr(3, 3, 0, 0, 1);
const DCZID: u32 = sr(3, 3, 0, 0, 7);
const TPIDR_EL0: u32 = sr(3, 3, 13, 0, 2);
const TPIDRRO_EL0: u32 = sr(3, 3, 13, 0, 3);
/// FEAT_RNG: a random number, and one from a reseeded source (ours are one stream).
const RNDR: u32 = sr(3, 3, 2, 4, 0);
const RNDRRS: u32 = sr(3, 3, 2, 4, 1);
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
const MMFR2: u32 = sr(3, 0, 0, 7, 2);
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
pub(crate) const CNTVCT: u32 = sr(3, 3, 14, 0, 2);
const CNTP_TVAL: u32 = sr(3, 3, 14, 2, 0);
const CNTP_CTL: u32 = sr(3, 3, 14, 2, 1);
const CNTP_CVAL: u32 = sr(3, 3, 14, 2, 2);
const CNTV_TVAL: u32 = sr(3, 3, 14, 3, 0);
const CNTV_CTL: u32 = sr(3, 3, 14, 3, 1);
const CNTV_CVAL: u32 = sr(3, 3, 14, 3, 2);

/// Registers that read as zero and ignore writes: IMPLEMENTATION DEFINED ones
/// with nothing to control (ACTLR, AMAIR, AFSR0/1), CSSELR (CLIDR reports no
/// caches), and the debug registers but the comparators, MDSCR_EL1 and the OS
/// lock: the OS double lock, save/restore and debug communications channel ones.
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
    )
}

/// DBGBVR<n>_EL1, DBGBCR<n>_EL1, DBGWVR<n>_EL1, DBGWCR<n>_EL1 (n = 0, 1): the
/// register, in the order of op2 (4 to 7), and n.
fn comparator(key: u32) -> Option<(u32, usize)> {
    (key & !0b1011 == sr(2, 0, 0, 0, 4)).then_some((key & 3, (key >> 3 & 1) as usize))
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
            // WFE completes at once with one vCPU (nothing to wait for); with
            // more, the run loop decides what it does.
            if op == WFI {
                return Err(Exit::Wfi);
            }
            if c.features & crate::cpu::FEATURE_SMP != 0 {
                return Err(Exit::Wfe);
            }
        }
        // An ERET that unmasks IRQs ends the chunk as MSR does, so a pending
        // IRQ is taken right after it (M6: before, it waited for the chunk's
        // end, which made the chunk size visible to guests).
        // In parallel SMP every ERET ends the chunk (context synchronization:
        // `cpu::FEATURE_PARALLEL`).
        ERET if !el0 => {
            let before = c.pstate;
            eret(c);
            if c.features & crate::cpu::FEATURE_PARALLEL != 0 {
                return Err(Exit::Resync);
            }
            return unmasked(before, c);
        }
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
            // Normal memory only: on what isn't RAM, an alignment fault, as on
            // hardware (never the run loop's `io`, which would store to a device).
            let a = c.reg(rt) & !63;
            for k in 0..8 {
                m.write(c, a + 8 * k, 8, 0).map_err(|f| match f.kind {
                    FaultKind::Bus => Fault {
                        kind: FaultKind::Align,
                        ..f
                    },
                    _ => f,
                })?;
            }
        }
        // No caches to maintain, but the address must translate (and, from
        // EL0, be readable) like a data access. IC IVAU and IALLU invalidate
        // JIT blocks (`Exit::Invalidate`).
        DC_CVAC | DC_CVAU | DC_CIVAC | IC_IVAU => {
            if el0 && c.sctlr_el1 & sctlr::UCI == 0 {
                return Err(trap_sys(i));
            }
            let pa = m.maint(c, c.reg(rt), false)?;
            if let (IC_IVAU, Some(pa)) = (op, pa) {
                return Err(Exit::Invalidate(pa));
            }
        }
        DC_IVAC => {
            m.maint(c, c.reg(rt), true)?;
        }
        DC_ISW | DC_CSW | DC_CISW => {}
        IC_IALLU | IC_IALLUIS => return Err(Exit::Invalidate(u64::MAX)),
        SYS => match (
            bits(i, 18, 16),
            bits(i, 15, 12),
            bits(i, 11, 8),
            bits(i, 7, 5),
        ) {
            // TLBI VMALLE1 and ASIDE1, and their IS forms (CRm 3; with more
            // than one vCPU the run loop does those on the others too). The
            // TLB holds only the current ASID's nG entries, so ASIDE1 drops
            // them whatever its ASID (over-invalidating).
            (0, 8, crm @ (3 | 7), op2 @ (0 | 2 | 1 | 3 | 5 | 7)) => {
                match op2 {
                    0 => m.flush_all(),
                    2 => m.flush_ng(),
                    // VAE1, VAAE1, VALE1, VAALE1: Xt[43:0] is VA[55:12].
                    _ => m.flush_va(c.reg(rt) << 12),
                }
                if crm == 3 && c.features & crate::cpu::FEATURE_SMP != 0 {
                    return Err(Exit::TlbiIs(i, c.reg(rt)));
                }
            }
            // IC IALLU(IS) with Rt != 31 (should-be-ones): as with 31.
            (0, 7, 5 | 1, 0) => return Err(Exit::Invalidate(u64::MAX)),
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
        // At EL0 too (no EL3 to trap them); the run loop reads the vCPU's stream (`rndr`).
        RNDR | RNDRRS if c.features & crate::cpu::FEATURE_RNG != 0 => {
            return Err(Exit::Platform(i));
        }
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
        MPIDR_R => c.mpidr,
        REVIDR => 0,
        PFR0 => pfr0(c.features),
        DFR0 => ID_AA64DFR0,
        ISAR0 => isar0(c.features),
        k if icc(c.features, k).is_some_and(|r| r.readable()) => return Err(Exit::Platform(i)),
        MMFR0 => ID_AA64MMFR0,
        MMFR2 => mmfr2(c.features),
        // The rest of the ID space (op1 = 0, CRn = 0, CRm = 1..7) is RAZ: the
        // AArch32 ID registers (no AArch32) and everything past v8.0 we don't have.
        k if k >> 7 == MIDR_R >> 7 && (1..=7).contains(&((k >> 3) & 0xf)) => 0,
        CCSIDR | CLIDR => 0, // no caches
        AIDR => 0,
        k if raz_wi(k) => 0,
        k if comparator(k).is_some() => {
            let (r, n) = comparator(k).expect("a comparator");
            [c.dbgbvr, c.dbgbcr, c.dbgwvr, c.dbgwcr][r as usize][n]
        }
        // Read-only: no debug ROM (MDRAR.Valid = 0), no debug authentication
        // signals, no DCC traffic; RVBAR (EL1 is the highest EL) is IMPLEMENTATION
        // DEFINED; RMR's AA64 is RAO (AArch64 only).
        MDRAR | DBGAUTHSTATUS | MDCCSR | RVBAR => 0,
        RMR => 1,
        _ => return Err(Exit::Undefined),
    })
}

/// A system register read the JIT does inline (M6 loop 1): what [`read`]
/// returns for a key at an EL without a trap, an exception or the platform
/// (the timers and `ISR_EL1` stay helper calls). `plain_matches_read` checks
/// the two agree.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Plain {
    /// The u64 at this offset in the `Cpu`.
    Field(usize),
    Const(u64),
    /// `pstate & mask`.
    Pstate(u64),
    /// NZCV, the flags made current in the `Cpu`.
    Nzcv,
    /// SP_EL0 at EL1: `sp_other` while SPSel is 1; UNDEFINED otherwise (the
    /// helper raises it).
    SpEl0,
    /// DCZID_EL0 at EL0: DZP set unless SCTLR_EL1.DZE lets EL0 use DC ZVA.
    Dczid0,
}

/// How [`read`] returns system register `key` (bits 20:5 of an MRS) at EL1
/// (`el1`) or EL0, if the JIT can do it inline.
pub fn plain(key: u32, el1: bool) -> Option<Plain> {
    use Plain::*;
    use core::mem::offset_of;
    let f = |off: usize| Some(Field(off));
    match key {
        NZCV => Some(Nzcv),
        TPIDR_EL0 => f(offset_of!(Cpu, tpidr_el0)),
        TPIDRRO_EL0 => f(offset_of!(Cpu, tpidrro_el0)),
        DCZID if el1 => Some(Const(DCZID_BS)),
        DCZID => Some(Dczid0),
        // EL0 from here on: traps (DAIF, CTR, FP registers) or, with op1 ≠ 3, UNDEFINED.
        _ if !el1 => None,
        DAIF_R => Some(Pstate(DAIF)),
        CTR => Some(Const(CTR_EL0)),
        SPSR_EL1 => f(offset_of!(Cpu, spsr_el1)),
        ELR_EL1 => f(offset_of!(Cpu, elr_el1)),
        SP_EL0 => Some(SpEl0),
        SPSEL => Some(Pstate(1)),
        CURRENT_EL => Some(Const(4)),
        SCTLR => f(offset_of!(Cpu, sctlr_el1)),
        CPACR => f(offset_of!(Cpu, cpacr_el1)),
        TTBR0 => f(offset_of!(Cpu, ttbr0_el1)),
        TTBR1 => f(offset_of!(Cpu, ttbr1_el1)),
        TCR => f(offset_of!(Cpu, tcr_el1)),
        ESR => f(offset_of!(Cpu, esr_el1)),
        FAR => f(offset_of!(Cpu, far_el1)),
        PAR => f(offset_of!(Cpu, par_el1)),
        MAIR => f(offset_of!(Cpu, mair_el1)),
        VBAR => f(offset_of!(Cpu, vbar_el1)),
        CNTKCTL => f(offset_of!(Cpu, cntkctl_el1)),
        CONTEXTIDR => f(offset_of!(Cpu, contextidr_el1)),
        TPIDR_EL1 => f(offset_of!(Cpu, tpidr_el1)),
        MDSCR => f(offset_of!(Cpu, mdscr_el1)),
        MIDR_R => Some(Const(MIDR)),
        MPIDR_R => f(offset_of!(Cpu, mpidr)),
        DFR0 => Some(Const(ID_AA64DFR0)),
        MMFR0 => Some(Const(ID_AA64MMFR0)),
        _ => None,
    }
}

/// How [`write`] sets system register `key` (bits 20:5 of an MSR) at EL1
/// (`el1`) or EL0, if the JIT can do it inline without ending its block
/// (M6 loop 7; [`msr_continues`] names the MSRs that don't end one).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlainWrite {
    /// The u64 at this offset in the `Cpu`, the whole value.
    Field(usize),
    /// SP_EL0 at EL1: `sp_other` while SPSel is 1; UNDEFINED otherwise.
    SpEl0,
    /// DAIF at EL1: PSTATE's DAIF bits; one that unmasks IRQs leaves through
    /// `Exit::Resync`, so the JIT runs that case through the helper.
    Daif,
}

pub fn plain_write(key: u32, el1: bool) -> Option<PlainWrite> {
    use PlainWrite::*;
    use core::mem::offset_of;
    match key {
        TPIDR_EL0 => Some(Field(offset_of!(Cpu, tpidr_el0))),
        _ if !el1 => None,
        TPIDRRO_EL0 => Some(Field(offset_of!(Cpu, tpidrro_el0))),
        SPSR_EL1 => Some(Field(offset_of!(Cpu, spsr_el1))),
        ELR_EL1 => Some(Field(offset_of!(Cpu, elr_el1))),
        TPIDR_EL1 => Some(Field(offset_of!(Cpu, tpidr_el1))),
        SP_EL0 => Some(SpEl0),
        DAIF_R => Some(Daif),
        _ => None,
    }
}

/// Whether MSR `i` (register or immediate form) leaves everything a JIT block
/// assumes as it was, at any EL: no regime, SP selection, FP control or flags
/// change, and an IRQ it unmasks leaves through `Exit::Resync` (mid-block, as
/// any helper's exit does). Those don't end a block: DAIFSet (it only masks),
/// and MSR of DAIF and the registers [`plain_write`] names.
pub fn msr_continues(i: u32) -> bool {
    if bit(i, 21) {
        return false; // MRS
    }
    if bits(i, 20, 19) == 0 {
        // MSR (immediate): DAIFSet.
        return (bits(i, 18, 16), bits(i, 7, 5)) == (3, 6);
    }
    matches!(
        bits(i, 20, 5),
        TPIDR_EL0 | TPIDRRO_EL0 | SPSR_EL1 | ELR_EL1 | TPIDR_EL1 | SP_EL0 | DAIF_R
    )
}

fn write(c: &mut Cpu, m: &mut impl Bus, i: u32, key: u32, v: u64) -> R {
    let el0 = c.el() == 0;
    // The TLB holds only the current ASID's nG entries and doesn't hold the MMU
    // enable: drop those when the ASID changes, everything when the MMU does.
    let (asid, copy, pstate) = (mmu::asid(c), c.sctlr_el1 & (sctlr::M | sctlr::A), c.pstate);
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
        SCTLR => {
            c.sctlr_el1 = (v | sctlr::RES1) & !sctlr::ENDIAN;
            debug::arm(c);
        }
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
        MDSCR => {
            c.mdscr_el1 = v;
            return rearm(c);
        }
        OSLAR => {
            c.os_lock = (v & 1) << 1;
            return rearm(c);
        }
        k if comparator(k).is_some() => {
            let (r, n) = comparator(k).expect("a comparator");
            match r {
                0 => c.dbgbvr[n] = v,
                1 => c.dbgbcr[n] = v & debug::BCR_MASK,
                2 => c.dbgwvr[n] = v,
                _ => c.dbgwcr[n] = v & debug::WCR_MASK,
            }
            return rearm(c);
        }
        k if raz_wi(k) => {}
        RMR => {} // a warm reset request (RR) isn't honored
        k if icc(c.features, k).is_some_and(|r| r.writable()) => return Err(Exit::Platform(i)),
        _ => return Err(Exit::Undefined),
    }
    if (c.sctlr_el1 ^ copy) & sctlr::M != 0 {
        m.flush_all();
    } else if mmu::asid(c) != asid {
        m.flush_ng();
    }
    if c.sctlr_el1 & (sctlr::M | sctlr::A) != copy {
        return Err(Exit::Resync); // retired; the run loop switches interpreter copy
    }
    unmasked(pstate, c)
}

/// After a write to a debug register: `Exit::Resync` (retired) if it armed or
/// disarmed an EL (`debug::arm`), so a run loop without a JIT changes
/// interpreter at once (with one, the MSR has ended its block already).
fn rearm(c: &mut Cpu) -> R {
    let before = c.interp_only;
    debug::arm(c);
    if c.interp_only != before {
        return Err(Exit::Resync);
    }
    Ok(())
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

/// Whether the [`Exit::Platform`] access `i` is an `RNDR` or `RNDRRS` read,
/// which the run loop completes with [`rndr`], not [`platform`].
pub fn is_rndr(i: u32) -> bool {
    matches!(bits(i, 20, 5), RNDR | RNDRRS)
}

/// Whether the [`Exit::Platform`] access `i` reads CNTVCT_EL0 or CNTPCT_EL0
/// (parallel SMP's run loop lets the JIT's helpers complete it in place).
pub fn is_counter_read(i: u32) -> bool {
    bit(i, 21) && matches!(bits(i, 20, 5), CNTVCT | CNTPCT)
}

/// Whether the word `w` is an MRS of CNTVCT_EL0 or CNTPCT_EL0 (the JIT
/// compiles those as reads of the host clock in parallel SMP).
pub fn is_counter_mrs(w: u32) -> bool {
    w & 0xfff0_0000 == 0xd530_0000 && is_counter_read(w)
}

/// Whether the [`Exit::Platform`] access `i` can show a timer's interrupt
/// state (its ISTATUS, ISR_EL1, the GIC's registers): everything but the
/// counter reads and CNTFRQ_EL0.
pub fn shows_timers(i: u32) -> bool {
    !is_counter_read(i) && bits(i, 20, 5) != CNTFRQ
}

/// Whether `i` writes DAIF: MSR DAIFSet or DAIFClr, or MSR DAIF, Xt (the
/// writes whose `Exit::Resync` only asks the run loop to look for an IRQ).
pub fn is_daif_write(i: u32) -> bool {
    if bit(i, 21) {
        return false; // MRS
    }
    if bits(i, 20, 19) == 0 {
        return bits(i, 18, 16) == 3 && matches!(bits(i, 7, 5), 6 | 7);
    }
    bits(i, 20, 5) == DAIF_R
}

/// Completes an `RNDR` or `RNDRRS` read (`i`) with `value`: it never fails,
/// so NZCV is 0000 (a failure would set Z). The caller retires the instruction.
pub fn rndr(c: &mut Cpu, i: u32, value: u64) {
    c.set_reg(bits(i, 4, 0), value);
    c.nzcv = 0;
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
    let mut p = if legal { m } else { c.pstate & 0xf } | spsr & DAIF;
    // PSTATE.SS comes back only while software step is on at the target; the
    // step it leaves pending reports no ISV.
    if c.mdscr_el1 & debug::MDSCR_SS != 0 && legal && debug::enabled_for(c, p) {
        p |= spsr & PSTATE_SS;
        c.step_syn = 0;
    }
    c.set_pstate(p);
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
    // A stepped instruction's external abort (the run loop's MMIO shares
    // `FaultKind::Bus`, which completes it) leaves it to run again, as
    // `debug::step` does for the other aborts.
    if let Exit::Fault(Fault {
        kind: FaultKind::Bus,
        ..
    }) = e
        && debug::stepping(c)
    {
        c.pstate |= PSTATE_SS;
    }
    let (esr, far, ret) = match e {
        Exit::Undefined => (0, None, pc),
        Exit::Svc(imm) => (0x15 << 26 | imm as u32, None, pc.wrapping_add(4)),
        Exit::Brk(imm) => (0x3c << 26 | imm as u32, None, pc),
        Exit::Trap(esr) => (esr, None, pc),
        Exit::Fault(f) if f.kind == FaultKind::Watch => (abort(0x34, f), Some(f.addr), pc),
        Exit::Fault(f) => (abort(0x24, f), Some(f.addr), pc),
        Exit::Fetch(Fault {
            kind: FaultKind::Align,
            ..
        }) => (0x22 << 26, Some(pc), pc),
        Exit::Fetch(f) => (abort(0x20, f), Some(f.addr), pc),
        Exit::Hvc(_)
        | Exit::Unimplemented(_)
        | Exit::Resync
        | Exit::Invalidate(_)
        | Exit::Wfi
        | Exit::Wfe
        | Exit::Sev(_)
        | Exit::TlbiIs(..)
        | Exit::Platform(_) => {
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

#[cfg(test)]
mod tests {
    use super::*;

    /// [`plain`] gives what [`read`] returns, for every key it claims, at
    /// both ELs and over random register state.
    #[test]
    fn plain_matches_read() {
        let mut seed = 0x9e37_79b9_7f4a_7c15u64;
        let mut rnd = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        let mut claimed = 0;
        for key in 0..1u32 << 16 {
            for el1 in [false, true] {
                let Some(p) = plain(key, el1) else { continue };
                claimed += 1;
                for _ in 0..16 {
                    let mut c = Cpu::default();
                    for f in [
                        &mut c.tpidr_el0,
                        &mut c.tpidrro_el0,
                        &mut c.spsr_el1,
                        &mut c.elr_el1,
                        &mut c.sp_other,
                        &mut c.sctlr_el1,
                        &mut c.cpacr_el1,
                        &mut c.ttbr0_el1,
                        &mut c.ttbr1_el1,
                        &mut c.tcr_el1,
                        &mut c.esr_el1,
                        &mut c.far_el1,
                        &mut c.par_el1,
                        &mut c.mair_el1,
                        &mut c.vbar_el1,
                        &mut c.cntkctl_el1,
                        &mut c.contextidr_el1,
                        &mut c.tpidr_el1,
                        &mut c.mdscr_el1,
                        &mut c.mpidr,
                    ] {
                        *f = rnd();
                    }
                    c.nzcv = rnd() & 0xf000_0000;
                    c.pstate = rnd() & (DAIF | 1) | if el1 { 4 } else { 0 };
                    let i = 0xd520_0003 | 1 << 21 | key << 5; // MRS x3, <key>
                    let want = read(&c, i, key);
                    let got = match p {
                        // SAFETY: `off` is a u64 field's offset in `c` (offset_of!).
                        Plain::Field(off) => unsafe {
                            (&raw const c).cast::<u8>().add(off).cast::<u64>().read()
                        },
                        Plain::Const(v) => v,
                        Plain::Pstate(m) => c.pstate & m,
                        Plain::Nzcv => c.nzcv,
                        Plain::SpEl0 if c.pstate & 1 == 1 => c.sp_other,
                        Plain::SpEl0 => {
                            assert!(want.is_err(), "SP_EL0 with SPSel 0");
                            continue;
                        }
                        Plain::Dczid0 => DCZID_BS | ((c.sctlr_el1 & sctlr::DZE == 0) as u64) << 4,
                    };
                    assert_eq!(want.ok(), Some(got), "key {key:#x}, EL1 {el1}");
                }
            }
        }
        // At EL0 and EL1. ID_AA64ISAR0_EL1 (M6.5) and ID_AA64PFR0_EL1 (M7) are
        // helpers: they depend on Cpu.features.
        assert_eq!(claimed, 4 + 29);
    }

    /// CTR_EL0's IminLine reads 9 (2 KiB lines: Linux and libgcc step their
    /// `IC IVAU`s by it, 2 a page), and the rest stays 64 bytes, DIC 0, IDC 1.
    #[test]
    fn ctr_el0_has_2k_icache_lines() {
        let c = Cpu {
            pstate: 4, // EL1
            ..Default::default()
        };
        let v = read(&c, 0xd520_0003 | 1 << 21 | CTR << 5, CTR).unwrap();
        assert_eq!(v & 0xf, 9, "IminLine: 4 << 9 = 2 KiB");
        assert_eq!(4 << (v & 0xf), 2048);
        assert_eq!(v >> 16 & 0xf, 4, "DminLine stays 64 bytes");
        assert_eq!(v >> 24 & 0xf, 4, "CWG stays 64 bytes");
        assert_eq!(v >> 20 & 0xf, 4, "ERG stays 64 bytes");
        assert_eq!((v >> 28 & 1, v >> 29 & 1), (1, 0), "IDC 1, DIC 0");
    }

    /// The `Cpu` offsets `tests/jit-diff.test.ts` randomizes (SYSREG_FIELDS,
    /// PSTATE, SCTLR): update both together.
    #[test]
    fn jit_diff_offsets() {
        use core::mem::offset_of;
        let fields = [
            offset_of!(Cpu, tpidr_el0),
            offset_of!(Cpu, tpidrro_el0),
            offset_of!(Cpu, tpidr_el1),
            offset_of!(Cpu, sp_other),
            offset_of!(Cpu, elr_el1),
            offset_of!(Cpu, spsr_el1),
            offset_of!(Cpu, esr_el1),
            offset_of!(Cpu, far_el1),
            offset_of!(Cpu, cpacr_el1),
            offset_of!(Cpu, tcr_el1),
            offset_of!(Cpu, ttbr0_el1),
            offset_of!(Cpu, ttbr1_el1),
            offset_of!(Cpu, mair_el1),
            offset_of!(Cpu, par_el1),
            offset_of!(Cpu, contextidr_el1),
            offset_of!(Cpu, vbar_el1),
            offset_of!(Cpu, cntkctl_el1),
            offset_of!(Cpu, mdscr_el1),
        ];
        assert_eq!(
            fields,
            [
                976, 984, 992, 840, 848, 856, 864, 872, 896, 904, 912, 920, 928, 944, 968, 880,
                1016, 1000
            ]
        );
        assert_eq!(
            (
                offset_of!(Cpu, pstate),
                offset_of!(Cpu, sctlr_el1),
                offset_of!(Cpu, monitor)
            ),
            (832, 888, 272)
        );
        assert_eq!(size_of::<Cpu>(), 1168);
    }
}
