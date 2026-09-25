//! Per-vCPU architectural state. Everything a vCPU owns lives here, behind the
//! pointer the host hands to the core: no globals.

/// Integer register file, PC, flags and the local exclusive monitor.
#[repr(C)]
#[derive(Clone, Default, Debug, PartialEq, Eq)]
pub struct Cpu {
    /// X0–X30, then SP in slot 31. M1 runs at EL0 only, so SP is SP_EL0.
    pub x: [u64; 32],
    pub pc: u64,
    /// N, Z, C, V in bits 31..28, laid out as the NZCV system register.
    pub nzcv: u64,
    pub monitor: Monitor,
}

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
}
