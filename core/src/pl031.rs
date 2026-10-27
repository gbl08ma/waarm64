//! PL031 real-time clock (the registers Linux's `rtc-pl031` driver uses),
//! written from the PL031 TRM (DDI 0224). The counter is the host's wall clock
//! (Unix seconds), taken once when the VM is created and advanced by the
//! realtime clock; a guest's load (LR) moves it by an offset. The match
//! interrupt never fires (no alarm): RIS stays clear.

use crate::snapshot::{self, Reader, Writer};

const DR: u64 = 0x00;
const MR: u64 = 0x04;
const LR: u64 = 0x08;
const CR: u64 = 0x0c;
const IMSC: u64 = 0x10;
const RIS: u64 = 0x14;
const MIS: u64 = 0x18;
const ICR: u64 = 0x1c;

/// PeriphID0–3 (part 0x031, designer 0x41, revision 1) and PrimeCell ID0–3, at 0xfe0.
const ID: [u8; 8] = [0x31, 0x10, 0x14, 0x00, 0x0d, 0xf0, 0x05, 0xb1];

#[derive(Debug)]
pub struct Pl031 {
    /// Unix time in ms when the realtime clock read 0.
    base_ms: u64,
    /// Seconds a guest's LR writes added to the wall clock (wrapping).
    offset: u32,
    mr: u32,
    lr: u32,
    imsc: u32,
}

impl Pl031 {
    pub fn new(base_ms: u64) -> Pl031 {
        let mut r = Pl031 {
            base_ms,
            offset: 0,
            mr: 0,
            lr: 0,
            imsc: 0,
        };
        r.lr = r.now(0);
        r
    }

    /// Keeps it on the host's time when the realtime clock moves on by `ms`
    /// that didn't pass on the host (`Vm::clock_skip`).
    pub fn shift(&mut self, ms: u64) {
        self.base_ms = self.base_ms.wrapping_sub(ms);
    }

    /// Saves the clock's base and the registers.
    pub fn save(&self, w: &mut Writer) {
        w.u64(self.base_ms);
        for v in [self.offset, self.mr, self.lr, self.imsc] {
            w.u32(v);
        }
    }

    /// Restores what [`Pl031::save`] wrote. With `host` (realtime mode: the
    /// host's Unix time in ms now, and the restored clock's ns now), the
    /// counter shows the host's time, plus what the guest's loads added;
    /// without, it continues from the saved base (virtual time).
    pub fn restore(&mut self, r: &mut Reader, host: Option<(u64, u64)>) -> snapshot::Result<()> {
        let base_ms = r.u64()?;
        self.base_ms = match host {
            Some((now_ms, ns)) => now_ms.saturating_sub(ns / 1_000_000),
            None => base_ms,
        };
        self.offset = r.u32()?;
        self.mr = r.u32()?;
        self.lr = r.u32()?;
        self.imsc = r.u32()? & 1;
        Ok(())
    }

    /// The counter (DR) when the realtime clock reads `ns`.
    fn now(&self, ns: u64) -> u32 {
        let s = self.base_ms.wrapping_add(ns / 1_000_000) / 1000;
        (s as u32).wrapping_add(self.offset)
    }

    /// A 32-bit register read at `off`; `ns` is the realtime clock. None: no register there.
    pub fn read(&self, off: u64, ns: u64) -> Option<u32> {
        Some(match off {
            DR => self.now(ns),
            MR => self.mr,
            LR => self.lr,
            CR => 1, // started, and it can't be stopped
            IMSC => self.imsc,
            RIS | MIS => 0,
            0xfe0..0x1000 => ID[(off - 0xfe0) as usize / 4] as u32,
            _ => return None,
        })
    }

    pub fn write(&mut self, off: u64, v: u32, ns: u64) -> Option<()> {
        match off {
            MR => self.mr = v,
            LR => {
                self.offset = self.offset.wrapping_add(v.wrapping_sub(self.now(ns)));
                self.lr = v;
            }
            CR | ICR => {}
            IMSC => self.imsc = v & 1,
            _ => return None,
        }
        Some(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_host_seconds_and_loads() {
        let mut r = Pl031::new(1_700_000_000_500);
        assert_eq!(r.read(DR, 0), Some(1_700_000_000));
        assert_eq!(r.read(DR, 499_999_999), Some(1_700_000_000));
        assert_eq!(r.read(DR, 500_000_000), Some(1_700_000_001));
        r.write(LR, 100, 2_000_000_000).unwrap();
        assert_eq!(r.read(LR, 0), Some(100));
        assert_eq!(r.read(DR, 2_000_000_000), Some(100));
        assert_eq!(r.read(DR, 5_000_000_000), Some(103));
        assert_eq!(r.read(CR, 0), Some(1));
        let id: Vec<_> = (0..8).map(|i| r.read(0xfe0 + 4 * i, 0).unwrap()).collect();
        assert_eq!(id, [0x31, 0x10, 0x14, 0, 0x0d, 0xf0, 0x05, 0xb1]);
        assert_eq!(r.read(0x20, 0), None);
    }
}
