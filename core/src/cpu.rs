//! Per-vCPU architectural state. Everything a vCPU owns lives here, behind the
//! pointer the host hands to the core: no globals.

use crate::snapshot::{self, Reader, Writer};

/// Register files, PC, flags, the local exclusive monitor and the EL1 system
/// registers. The host reads PC at offset 256 and NZCV at 264; new fields go at the end.
///
/// `Default` is a Linux user process at EL0 (see [`Cpu::default`]); [`Cpu::reset`]
/// is the EL1 state a kernel boots in.
#[repr(C)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Cpu {
    /// X0–X30, then the current SP in slot 31 (SP_EL0 or SP_EL1, by `pstate`).
    pub x: [u64; 32],
    pub pc: u64,
    /// N, Z, C, V in bits 31..28, laid out as the NZCV system register.
    pub nzcv: u64,
    pub monitor: Monitor,
    /// V0–V31 (offset 304). Element `e` of an `esize`-bit vector is bits
    /// `e*esize..(e+1)*esize`, as the ARM `Elem[]` accessor has it.
    pub v: [u128; 32],
    /// FPCR (offset 816): only the v8.0 bits AHP, DN, FZ and RMode hold values.
    pub fpcr: u64,
    /// FPSR (offset 824): QC and the cumulative exception flags.
    pub fpsr: u64,
    /// The rest of PSTATE, laid out as in SPSR: M[3:0] (EL in 3:2, SPSel in 0) and
    /// DAIF (9:6). NZCV lives in `nzcv`; IL is only ever set in a saved SPSR.
    pub pstate: u64,
    /// The stack pointer that isn't in `x[31]`: SP_EL1 while SP_EL0 is selected, and vice versa.
    pub sp_other: u64,
    pub elr_el1: u64,
    pub spsr_el1: u64,
    pub esr_el1: u64,
    pub far_el1: u64,
    pub vbar_el1: u64,
    pub sctlr_el1: u64,
    /// Only FPEN (21:20) holds a value.
    pub cpacr_el1: u64,
    pub tcr_el1: u64,
    pub ttbr0_el1: u64,
    pub ttbr1_el1: u64,
    pub mair_el1: u64,
    pub amair_el1: u64,
    pub par_el1: u64,
    pub afsr0_el1: u64,
    pub afsr1_el1: u64,
    pub contextidr_el1: u64,
    pub tpidr_el0: u64,
    pub tpidrro_el0: u64,
    pub tpidr_el1: u64,
    pub mdscr_el1: u64,
    /// OSLSR_EL1.OSLK (bit 1), set and cleared through OSLAR_EL1.
    pub os_lock: u64,
    /// Generic timer: EL0 access controls, and each timer's ENABLE/IMASK
    /// (ISTATUS is computed) and compare value. There's no CNTVOFF (no EL2),
    /// so the virtual and physical counts are the same.
    pub cntkctl_el1: u64,
    pub cntp_ctl_el0: u64,
    pub cntp_cval_el0: u64,
    pub cntv_ctl_el0: u64,
    pub cntv_cval_el0: u64,
    /// The optional features this vCPU implements (`FEATURE_*`, ABI 19): a VM's
    /// come from `VmConfig.features`, a user-mode vCPU (`Default`) has them all.
    pub features: u64,
    /// MPIDR_EL1 (M7: each vCPU its own, `gicv3::mpidr`; 1 << 31 for one CPU).
    pub mpidr: u64,
    /// Self-hosted debug (docs/cpu.md "Self-hosted debug"): the breakpoint and
    /// watchpoint value and control registers, 2 of each (`ID_AA64DFR0_EL1`);
    /// breakpoint 1 is the context-aware one.
    pub dbgbvr: [u64; 2],
    pub dbgbcr: [u64; 2],
    pub dbgwvr: [u64; 2],
    pub dbgwcr: [u64; 2],
    /// The Software Step exception's ISV and EX bits for the instruction just
    /// stepped (0 when the step is pending from an ERET).
    pub step_syn: u64,
    /// Per EL (0, 1), why the JIT's dispatcher leaves it to an interpreter:
    /// [`INTERP_ALIGN`], [`INTERP_DEBUG`]. Derived ([`crate::interp::debug::arm`]), not saved.
    pub interp_only: [u8; 2],
    /// What the JIT's dispatcher tests, for the current EL: [`DISPATCH_INTERP`]
    /// and [`DISPATCH_MMU`]. One byte at a fixed offset, two bit tests, as
    /// SCTLR_EL1's A and M were. Derived (`debug::arm`, [`Cpu::set_pstate`]), not saved.
    pub dispatch: u8,
    pub reserved: [u8; 5],
    /// Always 0, not saved: where the block interpreter reads XZR without a
    /// compare (`interp::block::ZERO`). Two to leave no padding.
    pub zero: [u64; 2],
}

/// `Cpu::interp_only`: `SCTLR_EL1.A` is set (the JIT doesn't check alignment).
pub const INTERP_ALIGN: u8 = 1;
/// `Cpu::interp_only`: debug is armed for the EL (the debug interpreter runs it).
pub const INTERP_DEBUG: u8 = 2;
/// `Cpu::dispatch`: the current EL's `interp_only` isn't 0.
pub const DISPATCH_INTERP: u8 = 1;
/// `Cpu::dispatch`: `SCTLR_EL1.M`.
pub const DISPATCH_MMU: u8 = 2;
/// PSTATE.SS (bit 21, as in SPSR) and PSTATE.D.
pub const PSTATE_SS: u64 = 1 << 21;
/// PSTATE.DIT (FEAT_DIT), at its SPSR position.
pub const PSTATE_DIT: u64 = 1 << 24;
pub const PSTATE_D: u64 = 1 << 9;

/// FEAT_AES (with PMULL), FEAT_SHA1 and FEAT_SHA256 (M6.5): advertised in
/// ID_AA64ISAR0_EL1, and UNDEFINED without it.
pub const FEATURE_CRYPTO: u64 = 1;
/// FEAT_RNG (ABI 35): `RNDR` and `RNDRRS`, advertised in ID_AA64ISAR0_EL1 and
/// UNDEFINED without it. The run loop reads them from the vCPU's stream (`rng`).
pub const FEATURE_RNG: u64 = 2;
/// FEAT_E0PD (ABI 35): `TCR_EL1.E0PD0`/`E0PD1` make an EL0 access to that half
/// of the address space a level 0 translation fault (`mmu::e0pd`), advertised in
/// ID_AA64MMFR2_EL1. Linux then keeps KPTI off under KASLR (`kaslr_requires_kpti`).
pub const FEATURE_E0PD: u64 = 4;
/// FEAT_SHA512 and FEAT_SHA3 (ABI 51): `SHA512H`/`H2`/`SU0`/`SU1` and `EOR3`,
/// `RAX1`, `XAR`, `BCAX`, advertised in ID_AA64ISAR0_EL1 and UNDEFINED without
/// it. Only with `FEATURE_CRYPTO` (SHA512 needs SHA256): alone it is nothing.
pub const FEATURE_SHA3: u64 = 8;
/// FEAT_JSCVT (ABI 59): `FJCVTZS`, JavaScript's ToInt32 of a double (rounded
/// toward zero, modulo 2^32, Z set when exact), advertised in ID_AA64ISAR1_EL1
/// and UNDEFINED without it.
pub const FEATURE_JSCVT: u64 = 16;
/// FEAT_LRCPC (ABI 59): `LDAPR`, `LDAPRB`, `LDAPRH`, run as `LDAR` (stronger
/// ordering than RCpc asks is allowed), advertised in ID_AA64ISAR1_EL1.
pub const FEATURE_RCPC: u64 = 32;
/// FEAT_SB (ABI 59): `SB`, a NOP (nothing speculates), advertised in ID_AA64ISAR1_EL1.
pub const FEATURE_SB: u64 = 64;
/// FEAT_FlagM and FEAT_FlagM2 (ABI 59): `CFINV`, `RMIF`, `SETF8`, `SETF16`,
/// `XAFLAG`, `AXFLAG`, advertised in ID_AA64ISAR0_EL1 (TS = 2).
pub const FEATURE_FLAGM: u64 = 128;
/// FEAT_DIT (ABI 59): PSTATE.DIT (`MSR DIT`, `MRS DIT`, kept through SPSR and
/// unchanged by exception entry), advertised in ID_AA64PFR0_EL1. Nothing's
/// timing depends on data any less with it set.
pub const FEATURE_DIT: u64 = 256;
/// FEAT_FRINTTS (ABI 59): `FRINT32Z`, `FRINT32X`, `FRINT64Z`, `FRINT64X`,
/// scalar and vector, advertised in ID_AA64ISAR1_EL1.
pub const FEATURE_FRINTTS: u64 = 512;
/// FEAT_DotProd (ABI 60): `SDOT` and `UDOT`, vector and by element, advertised
/// in ID_AA64ISAR0_EL1.
pub const FEATURE_DOTPROD: u64 = 1024;
/// Every feature bit the core knows.
pub const FEATURES: u64 = FEATURE_CRYPTO
    | FEATURE_RNG
    | FEATURE_E0PD
    | FEATURE_SHA3
    | FEATURE_JSCVT
    | FEATURE_RCPC
    | FEATURE_SB
    | FEATURE_FLAGM
    | FEATURE_DIT
    | FEATURE_FRINTTS
    | FEATURE_DOTPROD;

/// Whether a vCPU with `features` has FEAT_SHA512 and FEAT_SHA3.
#[inline]
pub fn has_sha3(features: u64) -> bool {
    features & (FEATURE_CRYPTO | FEATURE_SHA3) == FEATURE_CRYPTO | FEATURE_SHA3
}
/// The GICv3 system-register CPU interface (`ICC_*_EL1`, ID_AA64PFR0_EL1.GIC
/// = 1). Not a `VmConfig.features` bit: a VM sets it from `VmConfig.gic`; a
/// user-mode vCPU doesn't have it.
pub const FEATURE_GICV3: u64 = 1 << 32;
/// More than one vCPU (internal, like `FEATURE_GICV3`: a VM sets it when
/// `VmConfig.ncpus` > 1): WFE, SEV and SEVL leave the interpreter for the run
/// loop, and the TLBI IS forms are broadcast to the other vCPUs. Without it
/// they're NOPs and local, as on one CPU.
pub const FEATURE_SMP: u64 = 1 << 33;
/// Parallel SMP (internal: a VM sets it with `VmConfig.smp` = 1): DSB, ISB and
/// ERET end the chunk (`Exit::Resync`) in both tiers, so the run loop applies
/// the maintenance other vCPUs queued (context synchronization) and completes
/// this vCPU's TLBI IS broadcasts before anything after its DSB runs.
pub const FEATURE_PARALLEL: u64 = 1 << 34;
/// MPIDR_EL1 of a single CPU: Aff0 = 0, U = 0.
pub const MPIDR_UP: u64 = 1 << 31;

/// PSTATE.M values (with M[4] = 0, AArch64): EL0t, EL1t, EL1h.
pub const M_EL0T: u64 = 0b0000;
pub const M_EL1T: u64 = 0b0100;
pub const M_EL1H: u64 = 0b0101;
/// PSTATE.{D,A,I,F}, and I alone.
pub const DAIF: u64 = 0x3c0;
pub const PSTATE_I: u64 = 0x80;
/// SPSR.IL: an illegal exception return happened.
pub const SPSR_IL: u64 = 1 << 20;

/// SCTLR_EL1 bits the core interprets.
pub mod sctlr {
    pub const M: u64 = 1 << 0;
    pub const A: u64 = 1 << 1;
    pub const C: u64 = 1 << 2;
    pub const SA: u64 = 1 << 3;
    pub const SA0: u64 = 1 << 4;
    pub const UMA: u64 = 1 << 9;
    pub const I: u64 = 1 << 12;
    pub const DZE: u64 = 1 << 14;
    pub const UCT: u64 = 1 << 15;
    pub const NTWI: u64 = 1 << 16;
    pub const NTWE: u64 = 1 << 18;
    pub const WXN: u64 = 1 << 19;
    /// EE and E0E: RES0, we implement little-endian only.
    pub const ENDIAN: u64 = 3 << 24;
    pub const UCI: u64 = 1 << 26;
    /// The v8.0 RES1 bits: 29, 28, 23, 22, 20, 11.
    pub const RES1: u64 = 0x30d0_0800;
}

impl Default for Cpu {
    /// A Linux user process: EL0, FP/AdvSIMD enabled, and the EL0 cache,
    /// CTR_EL0, DC ZVA and WFE permissions Linux grants (WFI still traps, as there).
    /// The golden corpus, the fuzzer and the MIPS benchmark run in this state.
    fn default() -> Self {
        use sctlr::*;
        Cpu {
            sctlr_el1: RES1 | C | SA | SA0 | I | DZE | UCT | NTWE | UCI,
            cpacr_el1: 3 << 20,
            features: FEATURES,
            mpidr: MPIDR_UP,
            ..Cpu::zeroed()
        }
    }
}

/// FPCR bits that hold values: AHP (26), DN (25), FZ (24), RMode (23:22). The
/// trap enables are RAZ/WI (no trapping, as on the M4); FZ16 and the FEAT_AFP bits aren't implemented.
pub const FPCR_MASK: u64 = 0x07c0_0000;
/// FPSR bits that hold values: QC (27), IDC (7), IXC, UFC, OFC, DZC, IOC (4:0).
pub const FPSR_MASK: u64 = 0x0800_009f;

/// Local exclusive monitor, armed by LDXR/LDAXR/LDXP and consumed by STXR/STXP/CLREX.
/// The store-exclusive compares memory against `val` with a real atomic
/// compare-and-swap, so it stays correct when other vCPUs share the memory.
#[repr(C)]
#[derive(Clone, Copy, Default, Debug, PartialEq, Eq)]
pub struct Monitor {
    pub addr: u64,
    /// Bytes covered: 0 when open, else the access size (a pair covers both registers).
    pub size: u64,
    pub val: [u64; 2],
}

impl Cpu {
    fn zeroed() -> Self {
        // SAFETY: Cpu is plain integers all the way down; all-zero is a valid value
        // (EL0t, every register 0).
        unsafe { core::mem::zeroed() }
    }

    /// Reset into EL1h with DAIF masked, the MMU off and FP/AdvSIMD trapped
    /// (CPACR_EL1 resets UNKNOWN; kernels and bare-metal tests enable FP themselves).
    pub fn reset() -> Self {
        Cpu {
            pstate: M_EL1H | DAIF,
            sctlr_el1: sctlr::RES1,
            mpidr: MPIDR_UP,
            ..Cpu::zeroed()
        }
    }

    /// Saves the registers (a snapshot's form: every field but `features` and
    /// `mpidr`, which are the VM's).
    pub fn save(&self, w: &mut Writer) {
        self.x.iter().for_each(|&x| w.u64(x));
        w.u64(self.pc);
        w.u64(self.nzcv);
        let m = &self.monitor;
        for v in [m.addr, m.size, m.val[0], m.val[1]] {
            w.u64(v);
        }
        self.v.iter().for_each(|&v| w.u128(v));
        self.system().into_iter().for_each(|v| w.u64(v));
        self.debug().into_iter().for_each(|v| w.u64(v));
    }

    /// The debug registers, in order (snapshot version 2).
    fn debug(&self) -> [u64; 9] {
        let [b0, b1, w0, w1] = [self.dbgbvr, self.dbgbcr, self.dbgwvr, self.dbgwcr];
        [
            b0[0],
            b0[1],
            b1[0],
            b1[1],
            w0[0],
            w0[1],
            w1[0],
            w1[1],
            self.step_syn,
        ]
    }

    /// The fields after `v`, in order (but `features` and `mpidr`).
    fn system(&self) -> [u64; 30] {
        [
            self.fpcr,
            self.fpsr,
            self.pstate,
            self.sp_other,
            self.elr_el1,
            self.spsr_el1,
            self.esr_el1,
            self.far_el1,
            self.vbar_el1,
            self.sctlr_el1,
            self.cpacr_el1,
            self.tcr_el1,
            self.ttbr0_el1,
            self.ttbr1_el1,
            self.mair_el1,
            self.amair_el1,
            self.par_el1,
            self.afsr0_el1,
            self.afsr1_el1,
            self.contextidr_el1,
            self.tpidr_el0,
            self.tpidrro_el0,
            self.tpidr_el1,
            self.mdscr_el1,
            self.os_lock,
            self.cntkctl_el1,
            self.cntp_ctl_el0,
            self.cntp_cval_el0,
            self.cntv_ctl_el0,
            self.cntv_cval_el0,
        ]
    }

    /// Restores what [`Cpu::save`] wrote; `features` and `mpidr` stay. A
    /// snapshot is a file a user chose: a register holds only what a guest's
    /// write could have left in it (the masks of `interp::sys`), and a PSTATE
    /// or monitor no instruction leaves behind is refused.
    pub fn restore(&mut self, r: &mut Reader) -> snapshot::Result<()> {
        for x in &mut self.x {
            *x = r.u64()?;
        }
        self.pc = r.u64()?;
        self.nzcv = r.u64()? & 0xf000_0000;
        self.monitor = Monitor {
            addr: r.u64()?,
            size: r.u64()?,
            val: [r.u64()?, r.u64()?],
        };
        for v in &mut self.v {
            *v = r.u128()?;
        }
        let mut s = [0; 30];
        for v in &mut s {
            *v = r.u64()?;
        }
        let mut d = [0; 9];
        for v in &mut d {
            *v = r.u64()?;
        }
        let [bv0, bv1, bc0, bc1, wv0, wv1, wc0, wc1, step_syn] = d;
        let [
            fpcr,
            fpsr,
            pstate,
            sp_other,
            elr_el1,
            spsr_el1,
            esr_el1,
            far_el1,
            vbar_el1,
            sctlr_el1,
            cpacr_el1,
            tcr_el1,
            ttbr0_el1,
            ttbr1_el1,
            mair_el1,
            amair_el1,
            par_el1,
            afsr0_el1,
            afsr1_el1,
            contextidr_el1,
            tpidr_el0,
            tpidrro_el0,
            tpidr_el1,
            mdscr_el1,
            os_lock,
            cntkctl_el1,
            cntp_ctl_el0,
            cntp_cval_el0,
            cntv_ctl_el0,
            cntv_cval_el0,
        ] = s;
        if !matches!(
            pstate & !(DAIF | PSTATE_SS | PSTATE_DIT),
            M_EL0T | M_EL1T | M_EL1H
        ) || pstate & PSTATE_DIT != 0 && self.features & FEATURE_DIT == 0
            || !matches!(self.monitor.size, 0 | 1 | 2 | 4 | 8 | 16)
        {
            return Err(snapshot::Error::Corrupt);
        }
        *self = Cpu {
            fpcr: fpcr & FPCR_MASK,
            fpsr: fpsr & FPSR_MASK,
            pstate,
            sp_other,
            elr_el1,
            spsr_el1,
            esr_el1: esr_el1 as u32 as u64,
            far_el1,
            vbar_el1: vbar_el1 & !0x7ff,
            sctlr_el1: (sctlr_el1 | sctlr::RES1) & !sctlr::ENDIAN,
            cpacr_el1: cpacr_el1 & 3 << 20,
            tcr_el1,
            ttbr0_el1,
            ttbr1_el1,
            mair_el1,
            amair_el1,
            par_el1,
            afsr0_el1,
            afsr1_el1,
            contextidr_el1: contextidr_el1 as u32 as u64,
            tpidr_el0,
            tpidrro_el0,
            tpidr_el1,
            mdscr_el1,
            os_lock: os_lock & 2,
            cntkctl_el1: cntkctl_el1 & 0x3ff,
            cntp_ctl_el0: cntp_ctl_el0 & 3,
            cntp_cval_el0,
            cntv_ctl_el0: cntv_ctl_el0 & 3,
            cntv_cval_el0,
            dbgbvr: [bv0, bv1],
            dbgbcr: [bc0, bc1].map(|v| v & crate::interp::debug::BCR_MASK),
            dbgwvr: [wv0, wv1],
            dbgwcr: [wc0, wc1].map(|v| v & crate::interp::debug::WCR_MASK),
            step_syn: step_syn & crate::interp::debug::STEP_SYN,
            ..self.clone()
        };
        crate::interp::debug::arm(self);
        Ok(())
    }

    /// PSTATE.EL.
    #[inline]
    pub fn el(&self) -> u64 {
        (self.pstate >> 2) & 3
    }

    /// The PC a branch to `va` sets (`AArch64.BranchAddr`): with TBI for `va`'s
    /// half (TCR_EL1.TBI0 or TBI1, by bit 55), the top byte is bit 55's sign
    /// extension. Without TBI a non-canonical address stays, and its fetch
    /// faults. (No PAuth, so no TBID.)
    #[inline(always)]
    pub fn branch_addr(&self, va: u64) -> u64 {
        let canon = ((va << 8) as i64 >> 8) as u64;
        if canon == va {
            return va;
        }
        self.untag_pc(va, canon)
    }

    #[inline(never)]
    #[cold]
    fn untag_pc(&self, va: u64, canon: u64) -> u64 {
        if self.tcr_el1 >> (37 + (va >> 55 & 1)) & 1 == 1 {
            canon
        } else {
            va
        }
    }

    /// Sets PSTATE (M and DAIF) and swaps the stack pointers when the selected
    /// one changes; `dispatch` follows the EL.
    pub fn set_pstate(&mut self, p: u64) {
        let el1h = |p: u64| p & 0xf == M_EL1H;
        if el1h(p) != el1h(self.pstate) {
            core::mem::swap(&mut self.x[31], &mut self.sp_other);
        }
        self.pstate = p;
        let interp = (self.interp_only[(p >> 2 & 1) as usize] != 0) as u8;
        self.dispatch = self.dispatch & DISPATCH_MMU | interp;
    }

    /// Register `n` where 31 encodes XZR.
    #[inline]
    pub fn reg(&self, n: u32) -> u64 {
        if n == 31 { 0 } else { self.x[n as usize] }
    }

    /// Writes register `n` where 31 encodes XZR (the write is discarded).
    #[inline]
    pub fn set_reg(&mut self, n: u32, v: u64) {
        if n != 31 {
            self.x[n as usize] = v;
        }
    }

    /// Register `n` where 31 encodes SP.
    #[inline]
    pub fn reg_sp(&self, n: u32) -> u64 {
        self.x[n as usize]
    }

    /// Writes register `n` where 31 encodes SP.
    #[inline]
    pub fn set_reg_sp(&mut self, n: u32, v: u64) {
        self.x[n as usize] = v;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reg31_is_zr_or_sp() {
        let mut c = Cpu::default();
        c.set_reg_sp(31, 0x1000);
        c.set_reg(31, 5);
        assert_eq!(c.reg(31), 0);
        assert_eq!(c.reg_sp(31), 0x1000);
        c.set_reg(3, 7);
        assert_eq!((c.reg(3), c.reg_sp(3)), (7, 7));
    }

    #[test]
    fn host_abi_offsets() {
        let c = Cpu::default();
        let off = |p: *const u8| p as usize - &c as *const Cpu as usize;
        assert_eq!(off(&c.pc as *const u64 as *const u8), 256);
        assert_eq!(off(&c.nzcv as *const u64 as *const u8), 264);
        assert_eq!(off(c.v.as_ptr() as *const u8), 304);
        assert_eq!(off(&c.fpcr as *const u64 as *const u8), 816);
        assert_eq!(off(&c.fpsr as *const u64 as *const u8), 824);
    }

    #[test]
    fn save_and_restore_keep_every_register_but_the_vms() {
        // Every byte of the struct distinct, then what a guest couldn't have written fixed up.
        let mut c = Cpu::reset();
        // SAFETY: `Cpu` is plain integers without padding (1168 bytes of u64s, u128s and bytes).
        let b = unsafe {
            core::slice::from_raw_parts_mut(&mut c as *mut Cpu as *mut u8, size_of::<Cpu>())
        };
        b.iter_mut()
            .enumerate()
            .for_each(|(k, b)| *b = (k * 7 + k / 256) as u8 | 1);
        c.nzcv &= 0xf000_0000;
        (c.fpcr, c.fpsr) = (c.fpcr & FPCR_MASK, c.fpsr & FPSR_MASK);
        c.pstate = M_EL1T | 0x140;
        c.monitor.size = 8;
        (c.esr_el1, c.contextidr_el1) = (c.esr_el1 as u32 as u64, c.contextidr_el1 as u32 as u64);
        c.vbar_el1 &= !0x7ff;
        c.sctlr_el1 = (c.sctlr_el1 | sctlr::RES1) & !sctlr::ENDIAN;
        c.cpacr_el1 &= 3 << 20;
        (c.os_lock, c.cntkctl_el1) = (2, c.cntkctl_el1 & 0x3ff);
        (c.cntp_ctl_el0, c.cntv_ctl_el0) = (1, 3);
        c.dbgbcr = c.dbgbcr.map(|v| v & crate::interp::debug::BCR_MASK);
        c.dbgwcr = c.dbgwcr.map(|v| v & crate::interp::debug::WCR_MASK);
        c.step_syn &= crate::interp::debug::STEP_SYN;
        (c.reserved, c.zero) = ([0; 5], [0; 2]);
        crate::interp::debug::arm(&mut c);
        let mut w = Writer::default();
        c.save(&mut w);
        // 32 X, PC, NZCV, the monitor, 32 V, 30 system and 9 debug registers.
        assert_eq!(w.0.len(), 8 * (32 + 2 + 4 + 30 + 9) + 16 * 32);
        let mut d = Cpu {
            features: 5,
            mpidr: 9,
            ..Cpu::reset()
        };
        let mut r = Reader(&w.0);
        d.restore(&mut r).unwrap();
        assert_eq!(r.end(), Ok(()));
        (c.features, c.mpidr) = (5, 9);
        assert_eq!(d, c);
        // What no guest leaves behind is refused or masked, never kept.
        let refused = |f: &dyn Fn(&mut Cpu)| {
            let mut bad = c.clone();
            f(&mut bad);
            let mut w = Writer::default();
            bad.save(&mut w);
            Cpu::reset().restore(&mut Reader(&w.0))
        };
        let corrupt = Err(snapshot::Error::Corrupt);
        assert_eq!(refused(&|c| c.pstate = 0b1001), corrupt, "EL2h");
        assert_eq!(refused(&|c| c.pstate = 0b0001), corrupt, "EL0h");
        assert_eq!(refused(&|c| c.pstate = M_EL1H | 1 << 4), corrupt, "AArch32");
        assert_eq!(refused(&|c| c.pstate = M_EL0T | PSTATE_SS), Ok(()), "SS");
        // DIT only on a vCPU that has it (exception entry would copy it into SPSR).
        let mut w = Writer::default();
        Cpu {
            pstate: M_EL0T | PSTATE_DIT,
            ..c.clone()
        }
        .save(&mut w);
        let mut no_dit = Cpu {
            features: FEATURES & !FEATURE_DIT,
            ..Cpu::reset()
        };
        assert_eq!(
            no_dit.restore(&mut Reader(&w.0)),
            corrupt,
            "DIT without FEAT_DIT"
        );
        let mut dit = Cpu {
            features: FEATURES,
            ..Cpu::reset()
        };
        assert_eq!(dit.restore(&mut Reader(&w.0)), Ok(()), "DIT with FEAT_DIT");
        assert_eq!(dit.pstate, M_EL0T | PSTATE_DIT);
        assert_eq!(refused(&|c| c.monitor.size = 3), corrupt);
        assert_eq!(refused(&|c| c.cntv_ctl_el0 = 7), Ok(()));
        assert_eq!(
            Cpu::reset().restore(&mut Reader(&w.0[..w.0.len() - 1])),
            corrupt
        );
        let mut bad = c.clone();
        (bad.cntv_ctl_el0, bad.nzcv, bad.sctlr_el1) = (7, u64::MAX, 0);
        let mut w = Writer::default();
        bad.save(&mut w);
        let mut d = Cpu::reset();
        d.restore(&mut Reader(&w.0)).unwrap();
        assert_eq!(
            (d.cntv_ctl_el0, d.nzcv, d.sctlr_el1),
            (3, 0xf000_0000, sctlr::RES1)
        );
    }

    #[test]
    fn sp_banking() {
        let mut c = Cpu::reset();
        c.x[31] = 0x1000; // SP_EL1
        c.set_pstate(M_EL0T);
        assert_eq!((c.x[31], c.sp_other), (0, 0x1000));
        c.x[31] = 0x2000; // SP_EL0
        c.set_pstate(M_EL1T); // still SP_EL0
        assert_eq!(c.x[31], 0x2000);
        c.set_pstate(M_EL1H | DAIF);
        assert_eq!((c.x[31], c.sp_other, c.el()), (0x1000, 0x2000, 1));
    }
}
