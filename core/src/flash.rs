//! The firmware configuration's variable store: one CFI flash bank with the
//! Intel/Sharp command set (docs/abi.md "M8 phase B"), as EDK2's
//! `VirtNorFlashDxe` drives it. It behaves as QEMU `virt`'s `pflash_cfi01`
//! bank 1 does (the behavioral reference; no code from it): bank width 4, made
//! of two interleaved x16 chips, so a command is written to both 16-bit halves
//! of a word and a status or identifier read returns it in both. Operations
//! complete at once. Reads in array mode are the bytes; every write is a
//! command or the data a command asked for.

use crate::snapshot::{self, Reader, Writer};

/// The bank's PA (QEMU `virt`'s second flash bank).
pub const FLASH: u64 = 0x0400_0000;
/// The erase block (QEMU's, and EDK2's `QEMU_NOR_BLOCK_SIZE`).
pub const BLOCK: u64 = 256 << 10;
/// The bank's size limits: EDK2's store takes three blocks; `virt` has 64 MiB.
pub const MIN_SIZE: u64 = 3 * BLOCK;
pub const MAX_SIZE: u64 = 64 << 20;
/// The largest buffered program, in bytes (EDK2's `P30_MAX_BUFFER_SIZE_IN_BYTES`).
const BUFFER: u64 = 128;

/// Status register bits: ready, and the command-sequence error (erase and program errors).
const SR_READY: u8 = 0x80;
const SR_SEQUENCE: u8 = 0x30;

/// What the next read returns, or what the next write means.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mode {
    Array,
    Status,
    Ident,
    Query,
    /// Word program: the next write is the data.
    Program,
    /// Block erase: the next write must confirm (0xD0).
    Erase,
    /// Lock setup: the next write is lock (0x01) or unlock (0xD0).
    Lock,
    /// Buffered program: the next write is the word count − 1.
    Count,
    /// Buffered program: this many bytes of data to come.
    Data(u64),
    /// Buffered program: the next write must confirm (0xD0).
    Confirm,
}

pub struct Flash {
    bytes: Box<[u8]>,
    mode: Mode,
    status: u8,
}

impl Flash {
    /// An erased bank of `size` bytes (a valid size: [`Flash::valid_size`]).
    pub fn new(size: u64) -> Flash {
        Flash {
            bytes: vec![0xff; size as usize].into_boxed_slice(),
            mode: Mode::Array,
            status: SR_READY,
        }
    }

    pub fn valid_size(size: u64) -> bool {
        size.is_multiple_of(BLOCK) && (MIN_SIZE..=MAX_SIZE).contains(&size)
    }

    pub fn size(&self) -> u64 {
        self.bytes.len() as u64
    }

    /// The bank's bytes (the host copies the saved store in and out: `vm_flash`).
    pub fn as_mut_ptr(&mut self) -> *mut u8 {
        self.bytes.as_mut_ptr()
    }

    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    /// Saves the bank's bytes and the command state.
    pub fn save(&self, w: &mut Writer) {
        w.raw(&self.bytes);
        let (mode, left) = match self.mode {
            Mode::Array => (0, 0),
            Mode::Status => (1, 0),
            Mode::Ident => (2, 0),
            Mode::Query => (3, 0),
            Mode::Program => (4, 0),
            Mode::Erase => (5, 0),
            Mode::Lock => (6, 0),
            Mode::Count => (7, 0),
            Mode::Data(left) => (8, left),
            Mode::Confirm => (9, 0),
        };
        w.u8(mode);
        w.u64(left);
        w.u8(self.status);
    }

    /// Restores what [`Flash::save`] wrote, for a bank of the same size.
    pub fn restore(&mut self, r: &mut Reader) -> snapshot::Result<()> {
        let n = self.bytes.len();
        self.bytes.copy_from_slice(r.raw(n)?);
        let (mode, left) = (r.u8()?, r.u64()?);
        self.mode = match mode {
            0 => Mode::Array,
            1 => Mode::Status,
            2 => Mode::Ident,
            3 => Mode::Query,
            4 => Mode::Program,
            5 => Mode::Erase,
            6 => Mode::Lock,
            7 => Mode::Count,
            8 if (1..=BUFFER).contains(&left) => Mode::Data(left),
            9 => Mode::Confirm,
            _ => return Err(snapshot::Error::Corrupt),
        };
        self.status = r.u8()?;
        Ok(())
    }

    /// Whether `off..off + size` lies in the bank.
    fn inside(&self, off: u64, size: u32) -> bool {
        off.checked_add(size as u64)
            .is_some_and(|end| end <= self.size())
    }

    /// A read of `size` bytes at `off`; None outside the bank.
    pub fn read(&self, off: u64, size: u32) -> Option<u64> {
        if !self.inside(off, size) {
            return None;
        }
        let both = |v: u16| {
            let w = v as u64 | (v as u64) << 16;
            w | w << 32
        };
        let v = match self.mode {
            Mode::Array => {
                let mut b = [0u8; 8];
                b[..size as usize].copy_from_slice(&self.bytes[off as usize..][..size as usize]);
                return Some(u64::from_le_bytes(b));
            }
            // Word n of the identifier or query space is at byte 4n (each chip's word n).
            Mode::Ident => both(match (off % BLOCK) / 4 {
                0 => 0x89, // manufacturer: Intel
                1 => 0x18, // device
                _ => 0,    // block lock status, and the rest: unlocked
            }),
            Mode::Query => both(match (off / 4) & 0xff {
                0x10 => b'Q' as u16,
                0x11 => b'R' as u16,
                0x12 => b'Y' as u16,
                _ => 0,
            }),
            _ => both(self.status as u16),
        };
        Some(v & (u64::MAX >> (64 - 8 * size)))
    }

    /// A write of `size` bytes at `off`; None outside the bank.
    pub fn write(&mut self, off: u64, size: u32, v: u64) -> Option<()> {
        if !self.inside(off, size) {
            return None;
        }
        let cmd = v as u8;
        self.mode = match self.mode {
            Mode::Program => {
                self.store(off, size, v);
                Mode::Status
            }
            Mode::Erase if cmd == 0xd0 => {
                let start = (off - off % BLOCK) as usize;
                self.bytes[start..start + BLOCK as usize].fill(0xff);
                self.status |= SR_READY;
                Mode::Status
            }
            Mode::Lock if cmd == 0x01 || cmd == 0xd0 => {
                self.status |= SR_READY;
                Mode::Status
            }
            Mode::Count if (v & 0xffff) < BUFFER / 4 => Mode::Data(((v & 0xffff) + 1) * 4),
            Mode::Data(left) => {
                self.store(off, size, v);
                match left.saturating_sub(size as u64) {
                    0 => Mode::Confirm,
                    left => Mode::Data(left),
                }
            }
            Mode::Confirm if cmd == 0xd0 => {
                self.status |= SR_READY;
                Mode::Status
            }
            Mode::Erase | Mode::Lock | Mode::Count | Mode::Confirm => self.error(),
            Mode::Array | Mode::Status | Mode::Ident | Mode::Query => match cmd {
                0xff => Mode::Array,
                0x70 => Mode::Status,
                // QEMU clears the whole register, ready bit included.
                0x50 => {
                    self.status = 0;
                    Mode::Array
                }
                0x20 => Mode::Erase,
                0x40 | 0x10 => Mode::Program,
                0xe8 => {
                    self.status |= SR_READY;
                    Mode::Count
                }
                0x60 => Mode::Lock,
                0x90 => Mode::Ident,
                0x98 => Mode::Query,
                _ => self.error(),
            },
        };
        Some(())
    }

    /// Programs `size` bytes at `off` (QEMU stores them: no NOR AND with the old bits).
    fn store(&mut self, off: u64, size: u32, v: u64) {
        let b = v.to_le_bytes();
        self.bytes[off as usize..][..size as usize].copy_from_slice(&b[..size as usize]);
        self.status |= SR_READY;
    }

    /// A command out of sequence: the error bits, back to read array.
    fn error(&mut self) -> Mode {
        self.status |= SR_SEQUENCE;
        Mode::Array
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A command as EDK2 sends it: in both chips' halves.
    fn cmd(f: &mut Flash, off: u64, c: u64) {
        f.write(off, 4, c | c << 16).unwrap();
    }

    #[test]
    fn erase_program_and_status_as_edk2_drives_them() {
        let mut f = Flash::new(MIN_SIZE);
        assert_eq!(f.read(0, 4), Some(0xffff_ffff));
        assert_eq!(f.read(MIN_SIZE - 4, 8), None, "past the end");
        // Word program: setup, data, then the status reads ready.
        cmd(&mut f, 0x100, 0x40);
        f.write(0x100, 4, 0x1234_5678).unwrap();
        assert_eq!(f.read(0x100, 4), Some(0x0080_0080), "status after program");
        cmd(&mut f, 0, 0xff);
        assert_eq!(f.read(0x100, 4), Some(0x1234_5678));
        assert_eq!(
            f.read(0xfe, 8),
            Some(0xffff_1234_5678_ffff),
            "any size and alignment"
        );
        // Buffered program: 0xE8, count − 1, the words, confirm.
        cmd(&mut f, BLOCK, 0xe8);
        assert_eq!(f.read(BLOCK, 4), Some(0x0080_0080), "buffer available");
        cmd(&mut f, BLOCK, 1);
        f.write(BLOCK, 4, 0xaaaa_bbbb).unwrap();
        f.write(BLOCK + 4, 4, 0xcccc_dddd).unwrap();
        cmd(&mut f, 0, 0xd0);
        cmd(&mut f, 0, 0x70);
        assert_eq!(f.read(0, 4), Some(0x0080_0080));
        cmd(&mut f, 0, 0x50);
        cmd(&mut f, 0, 0xff);
        assert_eq!(f.read(BLOCK, 8), Some(0xcccc_dddd_aaaa_bbbb));
        // Block erase: the whole 256 KiB block, not its neighbours.
        cmd(&mut f, BLOCK + 0x40, 0x20);
        cmd(&mut f, BLOCK + 0x40, 0xd0);
        cmd(&mut f, 0, 0xff);
        assert_eq!(f.read(BLOCK, 8), Some(u64::MAX));
        assert_eq!(f.read(0x100, 4), Some(0x1234_5678));
        // Unlock, and the lock status (identifier word 2) reads unlocked.
        cmd(&mut f, BLOCK, 0x60);
        cmd(&mut f, BLOCK, 0xd0);
        cmd(&mut f, BLOCK + 8, 0x90);
        assert_eq!(f.read(BLOCK + 8, 4), Some(0));
        assert_eq!(f.read(BLOCK, 4), Some(0x0089_0089));
        cmd(&mut f, 0, 0x98);
        let q: Vec<_> = (0x10..0x13)
            .map(|w| f.read(4 * w, 4).unwrap() as u8)
            .collect();
        assert_eq!(q, b"QRY");
        // Out of sequence: the error bits, and array mode.
        cmd(&mut f, 0, 0x20);
        cmd(&mut f, 0, 0xff);
        assert_eq!(f.read(0x100, 4), Some(0x1234_5678), "no erase");
        cmd(&mut f, 0, 0x70);
        assert_eq!(f.read(0, 4), Some(0x00b0_00b0));
    }

    #[test]
    fn sizes() {
        assert!(Flash::valid_size(MIN_SIZE) && Flash::valid_size(1 << 20));
        assert!(!Flash::valid_size(0) && !Flash::valid_size(MIN_SIZE + 4096));
        assert!(!Flash::valid_size(MAX_SIZE + BLOCK));
    }
}
