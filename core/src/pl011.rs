//! PL011 UART (the registers Linux's `amba-pl011` driver and earlycon use),
//! written from the PL011 TRM (DDI 0183). Transmission is instant: TX bytes go
//! straight into the console TX ring, the FIFO is always empty (FR.TXFE), and
//! RX bytes come from the console RX ring the host fills.

use core::sync::atomic::{AtomicU8, AtomicU32, Ordering};

pub const RING: usize = 4096;

/// A single-producer single-consumer byte ring shared with the host. `head` and
/// `tail` count bytes written and read (wrapping); byte `k` is at `buf[k % RING]`.
/// Layout (host ABI): head at 0, tail at 4, buf at 8.
#[repr(C)]
pub struct Ring {
    pub head: AtomicU32,
    pub tail: AtomicU32,
    pub buf: [AtomicU8; RING],
}

impl Default for Ring {
    fn default() -> Self {
        Ring {
            head: AtomicU32::new(0),
            tail: AtomicU32::new(0),
            buf: [const { AtomicU8::new(0) }; RING],
        }
    }
}

impl Ring {
    /// Producer side; false when full. A byte into an empty ring notifies
    /// `head` (`memory.atomic.notify`), so a consumer that drained it can
    /// sleep on `head` until there's more (docs/abi.md "Signal word and
    /// console").
    pub fn push(&self, b: u8) -> bool {
        let h = self.head.load(Ordering::Relaxed);
        let t = self.tail.load(Ordering::SeqCst);
        if h.wrapping_sub(t) as usize == RING {
            return false;
        }
        self.buf[h as usize % RING].store(b, Ordering::Relaxed);
        self.head.store(h.wrapping_add(1), Ordering::SeqCst);
        if h == t {
            crate::vm::notify(&self.head);
        }
        true
    }

    /// Consumer side.
    pub fn pop(&self) -> Option<u8> {
        let t = self.tail.load(Ordering::Relaxed);
        if t == self.head.load(Ordering::Acquire) {
            return None;
        }
        let b = self.buf[t as usize % RING].load(Ordering::Relaxed);
        self.tail.store(t.wrapping_add(1), Ordering::Release);
        Some(b)
    }

    pub fn is_empty(&self) -> bool {
        self.tail.load(Ordering::Relaxed) == self.head.load(Ordering::Acquire)
    }
}

/// The console: TX (guest to host) at offset 0, RX (host to guest) after it.
#[repr(C)]
#[derive(Default)]
pub struct Rings {
    pub tx: Ring,
    pub rx: Ring,
}

// Interrupt bits (RIS, MIS, IMSC, ICR).
const RX: u32 = 1 << 4;
const TX: u32 = 1 << 5;
const RT: u32 = 1 << 6;

pub struct Pl011 {
    ilpr: u32,
    ibrd: u32,
    fbrd: u32,
    lcr_h: u32,
    cr: u32,
    ifls: u32,
    imsc: u32,
    dmacr: u32,
    /// TXRIS: set by each transmitted byte (the FIFO drains at once), cleared by ICR.
    tx_ris: bool,
}

impl Default for Pl011 {
    fn default() -> Self {
        Pl011 {
            ilpr: 0,
            ibrd: 0,
            fbrd: 0,
            lcr_h: 0,
            cr: 0x300, // TXE, RXE
            ifls: 0x12,
            imsc: 0,
            dmacr: 0,
            tx_ris: false,
        }
    }
}

impl Pl011 {
    /// RIS: RX and RX timeout while the RX ring has data, and TX.
    fn ris(&self, rx: &Ring) -> u32 {
        (if rx.is_empty() { 0 } else { RX | RT }) | if self.tx_ris { TX } else { 0 }
    }

    /// The interrupt line (SPI 1, INTID 33).
    pub fn irq(&self, rx: &Ring) -> bool {
        self.ris(rx) & self.imsc != 0
    }

    pub fn read(&mut self, off: u64, c: &Rings) -> u32 {
        match off {
            0x000 => c.rx.pop().unwrap_or(0) as u32, // DR, no error bits
            // FR: TXFE, and RXFE while the ring is empty.
            0x018 => 1 << 7 | (c.rx.is_empty() as u32) << 4,
            0x020 => self.ilpr,
            0x024 => self.ibrd,
            0x028 => self.fbrd,
            0x02c => self.lcr_h,
            0x030 => self.cr,
            0x034 => self.ifls,
            0x038 => self.imsc,
            0x03c => self.ris(&c.rx),
            0x040 => self.ris(&c.rx) & self.imsc,
            0x048 => self.dmacr,
            // UARTPeriphID0-3 (PL011 r1p5) and UARTPCellID0-3, for the AMBA probe.
            0xfe0..0x1000 => {
                [0x11, 0x10, 0x14, 0x00, 0x0d, 0xf0, 0x05, 0xb1][(off as usize - 0xfe0) / 4]
            }
            _ => 0,
        }
    }

    /// False if a DR write found the TX ring full; nothing was written then.
    pub fn write(&mut self, off: u64, v: u32, c: &Rings) -> bool {
        match off {
            0x000 => {
                if !c.tx.push(v as u8) {
                    return false;
                }
                self.tx_ris = true;
            }
            0x020 => self.ilpr = v & 0xff,
            0x024 => self.ibrd = v & 0xffff,
            0x028 => self.fbrd = v & 0x3f,
            0x02c => self.lcr_h = v & 0xff,
            0x030 => self.cr = v & 0xff87,
            0x034 => self.ifls = v & 0x3f,
            0x038 => self.imsc = v & 0x7ff,
            0x044 if v & TX != 0 => self.tx_ris = false, // ICR; RX and RT follow the ring
            0x048 => self.dmacr = v & 7,
            _ => {}
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ring_wraps_and_fills() {
        let r = Ring::default();
        for k in 0..3 * RING {
            assert!(r.push(k as u8));
            assert_eq!(r.pop(), Some(k as u8));
        }
        for k in 0..RING {
            assert!(r.push(k as u8));
        }
        assert!(!r.push(0), "full");
        assert_eq!(r.pop(), Some(0));
        assert!(r.push(0));
    }

    #[test]
    fn tx_rx_and_interrupts() {
        let (mut u, c) = (Pl011::default(), Rings::default());
        assert_eq!(u.read(0x018, &c), 0x90); // TXFE, RXFE
        assert!(u.write(0, b'h' as u32, &c));
        assert_eq!(c.tx.pop(), Some(b'h'));
        assert!(!u.irq(&c.rx));
        u.write(0x038, RX | TX, &c);
        assert!(u.irq(&c.rx), "TX interrupt after a byte went out");
        u.write(0x044, TX, &c);
        assert!(!u.irq(&c.rx));
        c.rx.push(b'x');
        assert_eq!((u.read(0x018, &c), u.read(0x040, &c)), (0x80, RX));
        assert!(u.irq(&c.rx));
        assert_eq!(u.read(0, &c), b'x' as u32);
        assert!(!u.irq(&c.rx));
        assert_eq!(u.read(0xfe8, &c), 0x14);
        for _ in 0..RING {
            c.tx.push(0);
        }
        assert!(!u.write(0, 1, &c), "TX ring full");
    }
}
