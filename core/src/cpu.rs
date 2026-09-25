//! Per-vCPU architectural state. Everything a vCPU owns lives here, behind the
//! pointer the host hands to the core: no globals.

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
    pub csselr_el1: u64,
}

/// PSTATE.M values (with M[4] = 0, AArch64): EL0t, EL1t, EL1h.
pub const M_EL0T: u64 = 0b0000;
pub const M_EL1T: u64 = 0b0100;
pub const M_EL1H: u64 = 0b0101;
/// PSTATE.{D,A,I,F}.
pub const DAIF: u64 = 0x3c0;
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
            ..Cpu::zeroed()
        }
    }

    /// PSTATE.EL.
    #[inline]
    pub fn el(&self) -> u64 {
        (self.pstate >> 2) & 3
    }

    /// Sets PSTATE (M and DAIF) and swaps the stack pointers when the selected one changes.
    pub fn set_pstate(&mut self, p: u64) {
        let el1h = |p: u64| p & 0xf == M_EL1H;
        if el1h(p) != el1h(self.pstate) {
            core::mem::swap(&mut self.x[31], &mut self.sp_other);
        }
        self.pstate = p;
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
