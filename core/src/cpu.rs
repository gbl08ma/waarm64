//! Per-vCPU architectural state. Everything a vCPU owns lives here, behind the
//! pointer the host hands to the core: no globals.

/// Register files, PC, flags and the local exclusive monitor. The host reads PC
/// at offset 256 and NZCV at 264; new fields go at the end.
#[repr(C)]
#[derive(Clone, Default, Debug, PartialEq, Eq)]
pub struct Cpu {
    /// X0–X30, then SP in slot 31. M1 runs at EL0 only, so SP is SP_EL0.
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
}
