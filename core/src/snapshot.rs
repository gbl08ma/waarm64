//! The format of a VM's saved state (docs/abi.md "M8 phase C: snapshots"):
//! little-endian fields in a fixed order, written by each part's `save` and
//! read back by its `restore` (`vm/state.rs` has the VM's). Guest RAM isn't
//! in it: the host copies that.
//!
//! A snapshot comes from a file a user chose, so a reader never trusts it: every
//! read is bounds-checked and every count has a limit ([`Error::Corrupt`]).

/// `WPCS`.
pub const MAGIC: u32 = u32::from_le_bytes(*b"WPCS");
/// Bumped whenever a saved field is added, removed or changes meaning (the
/// pinned bytes in `vm/tests.rs` fail when the layout moves without it).
/// 3: a guest in PSCI SYSTEM_SUSPEND, after the devices. 4: a virtio transport's SHMSel, and
/// the xHCI's endpoints whose walk waits for room. 5: what the xHCI's Controller Save State kept
/// (read from 5 on; a 4's controller has none).
pub const VERSION: u32 = 5;
/// The oldest version a restore still reads (4: the older ones lack fields in the devices').
pub const VERSION_MIN: u32 = 4;

/// Why a restore was refused (`vm_snapshot_restore`'s return value).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    /// Not a snapshot, or one of a version outside [`VERSION_MIN`]..=[`VERSION`].
    Format = 1,
    /// The VM's configuration isn't the one the snapshot was taken on.
    Config = 2,
    /// Truncated, or a value that can't be (an address outside RAM, a count past its limit).
    Corrupt = 3,
}

pub type Result<T> = core::result::Result<T, Error>;

/// The state being written.
#[derive(Default)]
pub struct Writer(pub Vec<u8>);

impl Writer {
    pub fn u8(&mut self, v: u8) {
        self.0.push(v);
    }

    pub fn bool(&mut self, v: bool) {
        self.0.push(v as u8);
    }

    pub fn u16(&mut self, v: u16) {
        self.0.extend(v.to_le_bytes());
    }

    pub fn u32(&mut self, v: u32) {
        self.0.extend(v.to_le_bytes());
    }

    pub fn u64(&mut self, v: u64) {
        self.0.extend(v.to_le_bytes());
    }

    pub fn u128(&mut self, v: u128) {
        self.0.extend(v.to_le_bytes());
    }

    /// Bytes whose length the reader knows.
    pub fn raw(&mut self, b: &[u8]) {
        self.0.extend(b);
    }

    /// Bytes with their length (a u32) in front.
    pub fn bytes(&mut self, b: &[u8]) {
        self.u32(b.len() as u32);
        self.raw(b);
    }
}

/// The state being read.
pub struct Reader<'a>(pub &'a [u8]);

impl<'a> Reader<'a> {
    /// The next `n` bytes.
    pub fn raw(&mut self, n: usize) -> Result<&'a [u8]> {
        if self.0.len() < n {
            return Err(Error::Corrupt);
        }
        let (a, b) = self.0.split_at(n);
        self.0 = b;
        Ok(a)
    }

    fn array<const N: usize>(&mut self) -> Result<[u8; N]> {
        Ok(self.raw(N)?.try_into().unwrap())
    }

    pub fn u8(&mut self) -> Result<u8> {
        Ok(self.raw(1)?[0])
    }

    /// A flag: 0 or 1.
    pub fn bool(&mut self) -> Result<bool> {
        match self.u8()? {
            0 => Ok(false),
            1 => Ok(true),
            _ => Err(Error::Corrupt),
        }
    }

    pub fn u16(&mut self) -> Result<u16> {
        Ok(u16::from_le_bytes(self.array()?))
    }

    pub fn u32(&mut self) -> Result<u32> {
        Ok(u32::from_le_bytes(self.array()?))
    }

    pub fn u64(&mut self) -> Result<u64> {
        Ok(u64::from_le_bytes(self.array()?))
    }

    pub fn u128(&mut self) -> Result<u128> {
        Ok(u128::from_le_bytes(self.array()?))
    }

    /// Length-prefixed bytes, at most `max`.
    pub fn bytes(&mut self, max: usize) -> Result<&'a [u8]> {
        let n = self.u32()? as usize;
        if n > max {
            return Err(Error::Corrupt);
        }
        self.raw(n)
    }

    /// A count, at most `max`.
    pub fn count(&mut self, max: usize) -> Result<usize> {
        let n = self.u32()? as usize;
        if n > max {
            return Err(Error::Corrupt);
        }
        Ok(n)
    }

    /// The state must end here.
    pub fn end(&self) -> Result<()> {
        if self.0.is_empty() {
            Ok(())
        } else {
            Err(Error::Corrupt)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fields_round_trip_and_short_reads_fail() {
        let mut w = Writer::default();
        w.u8(7);
        w.bool(true);
        w.u16(0x1234);
        w.u32(0xdead_beef);
        w.u64(u64::MAX - 1);
        w.u128(1 << 100);
        w.bytes(b"abc");
        let mut r = Reader(&w.0);
        assert_eq!(r.u8(), Ok(7));
        assert_eq!(r.bool(), Ok(true));
        assert_eq!(r.u16(), Ok(0x1234));
        assert_eq!(r.u32(), Ok(0xdead_beef));
        assert_eq!(r.u64(), Ok(u64::MAX - 1));
        assert_eq!(r.u128(), Ok(1 << 100));
        assert_eq!(r.bytes(3), Ok(&b"abc"[..]));
        assert_eq!(r.end(), Ok(()));
        assert_eq!(r.u8(), Err(Error::Corrupt));
        assert_eq!(Reader(&w.0[..5]).u64(), Err(Error::Corrupt));
        assert_eq!(Reader(&[2]).bool(), Err(Error::Corrupt));
        // A length past its limit, and one past the data.
        assert_eq!(
            Reader(&[4, 0, 0, 0, 1, 2, 3, 4]).bytes(3),
            Err(Error::Corrupt)
        );
        assert_eq!(Reader(&[4, 0, 0, 0, 1, 2, 3]).bytes(8), Err(Error::Corrupt));
        assert_eq!(Reader(&[9, 0, 0, 0]).count(8), Err(Error::Corrupt));
    }
}
