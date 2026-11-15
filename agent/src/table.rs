//! A disk's partition table grown to the disk's end (GROW, src/grow.rs; docs/devices.md "A disk grown"): GPT's or
//! MBR's, read and written through `Disk` (the device's descriptor; the tests' image files). Only the partition that
//! ends last grows, only when the new space follows it, never past the device's end and never smaller; its end is
//! aligned down to 1 MiB. GPT: both headers' and both entry arrays' CRCs checked first (anything that doesn't add up is
//! left alone), the backup's entries and header moved to the disk's last sectors and written before the primary's, so
//! that a crash between them leaves one valid table (the old primary still names the old backup, which is still
//! there). MBR: the last-ending primary partition, within the 32-bit LBAs; an extended partition that ends last isn't
//! grown (nor its logical ones).

use crate::prelude::*;
use rustix::fd::BorrowedFd;
use rustix::io::Errno;

/// Where a table is read and written: byte offsets, whole buffers.
pub trait Disk {
    fn read(&self, at: u64, buf: &mut [u8]) -> Result<(), Errno>;
    fn write(&self, at: u64, buf: &[u8]) -> Result<(), Errno>;
    fn sync(&self) -> Result<(), Errno>;
}

/// A device (or image file) of `size` bytes: no write reaches past it.
pub struct Fd<'a> {
    pub fd: BorrowedFd<'a>,
    pub size: u64,
}

impl Disk for Fd<'_> {
    fn read(&self, mut at: u64, mut buf: &mut [u8]) -> Result<(), Errno> {
        while !buf.is_empty() {
            match rustix::io::pread(self.fd, &mut *buf, at) {
                Ok(0) => return Err(Errno::IO),
                Ok(n) => {
                    buf = &mut buf[n..];
                    at += n as u64;
                }
                Err(Errno::INTR) => {}
                Err(e) => return Err(e),
            }
        }
        Ok(())
    }

    fn write(&self, mut at: u64, mut buf: &[u8]) -> Result<(), Errno> {
        if at
            .checked_add(buf.len() as u64)
            .is_none_or(|end| end > self.size)
        {
            return Err(Errno::NOSPC);
        }
        while !buf.is_empty() {
            match rustix::io::pwrite(self.fd, buf, at) {
                Ok(0) => return Err(Errno::IO),
                Ok(n) => {
                    buf = &buf[n..];
                    at += n as u64;
                }
                Err(Errno::INTR) => {}
                Err(e) => return Err(e),
            }
        }
        Ok(())
    }

    fn sync(&self) -> Result<(), Errno> {
        rustix::fs::fsync(self.fd)
    }
}

/// What became of the table.
#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    /// Neither GPT nor MBR: the filesystem, if any, is the whole disk's.
    NoTable,
    /// The partition that ends last: its number (the kernel's: GPT's entry index + 1, MBR's slot + 1), its first
    /// sector and its length (in logical sectors) as the table now has them, and whether the table was written.
    Last {
        pno: u32,
        start: u64,
        len: u64,
        written: bool,
    },
    /// The space doesn't follow a partition this grows: MBR's extended partition ends last, or there is none.
    NotLast,
    /// Something in the table doesn't add up (a CRC, a header's field, a partition outside the disk): left alone.
    Bad(&'static str),
    /// Reading or writing the device failed.
    Failed(Errno),
}

/// The alignment of a grown partition's end: 1 MiB.
const ALIGN: u64 = 1 << 20;

/// Grows the table on `d` (`size` bytes, logical sectors of `lbs` bytes) to the disk's end.
pub fn grow(d: &impl Disk, size: u64, lbs: u64) -> Outcome {
    if !(512..=4096).contains(&lbs) || !lbs.is_power_of_two() {
        return Outcome::Bad("a logical sector size that isn't 512 to 4096");
    }
    if size / lbs < 3 {
        return Outcome::NoTable;
    }
    let mut mbr = vec![0u8; lbs as usize];
    let mut hdr = vec![0u8; lbs as usize];
    if let Err(e) = d.read(0, &mut mbr).and_then(|()| d.read(lbs, &mut hdr)) {
        return Outcome::Failed(e);
    }
    if &hdr[..8] == b"EFI PART" {
        return match grow_gpt(d, size, lbs, mbr, hdr) {
            Ok(o) => o,
            Err(Fail::Bad(why)) => Outcome::Bad(why),
            Err(Fail::Io(e)) => Outcome::Failed(e),
        };
    }
    match parse_mbr(&mbr) {
        None => Outcome::NoTable,
        Some(p) if p.iter().any(|e| e.kind == 0xee) => {
            Outcome::Bad("a protective MBR without a GPT header")
        }
        Some(p) => match grow_mbr(d, size / lbs, lbs, mbr, &p) {
            Ok(o) => o,
            Err(Fail::Bad(why)) => Outcome::Bad(why),
            Err(Fail::Io(e)) => Outcome::Failed(e),
        },
    }
}

enum Fail {
    Bad(&'static str),
    Io(Errno),
}

impl From<Errno> for Fail {
    fn from(e: Errno) -> Fail {
        Fail::Io(e)
    }
}

/// The CRC-32 GPT uses (IEEE 802.3's, reflected; zlib's).
pub fn crc32(b: &[u8]) -> u32 {
    let mut c = !0u32;
    for &x in b {
        c ^= x as u32;
        for _ in 0..8 {
            c = (c >> 1) ^ (0xedb8_8320 & (c & 1).wrapping_neg());
        }
    }
    !c
}

fn u32_at(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(b[at..at + 4].try_into().unwrap())
}

fn u64_at(b: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(b[at..at + 8].try_into().unwrap())
}

fn put32(b: &mut [u8], at: usize, v: u32) {
    b[at..at + 4].copy_from_slice(&v.to_le_bytes());
}

fn put64(b: &mut [u8], at: usize, v: u64) {
    b[at..at + 8].copy_from_slice(&v.to_le_bytes());
}

/// A GPT header's fields (UEFI 2.10 §5.3.2): offsets in its sector.
mod h {
    pub const SIZE: usize = 12;
    pub const CRC: usize = 16;
    pub const MY: usize = 24;
    pub const ALT: usize = 32;
    pub const FIRST: usize = 40;
    pub const LAST: usize = 48;
    pub const GUID: usize = 56;
    pub const ENTRIES: usize = 72;
    pub const COUNT: usize = 80;
    pub const ENTRY_SIZE: usize = 84;
    pub const ENTRIES_CRC: usize = 88;
}

/// A GPT header's sector whose signature, size and CRC hold.
fn check_header(s: &[u8], lbs: u64) -> Result<(), Fail> {
    if &s[..8] != b"EFI PART" {
        return Err(Fail::Bad("a GPT header without its signature"));
    }
    let size = u32_at(s, h::SIZE) as u64;
    if !(92..=lbs).contains(&size) {
        return Err(Fail::Bad("a GPT header's size out of range"));
    }
    let mut c = s[..size as usize].to_vec();
    put32(&mut c, h::CRC, 0);
    if crc32(&c) != u32_at(s, h::CRC) {
        return Err(Fail::Bad("a GPT header's CRC"));
    }
    Ok(())
}

/// Sets a header's CRC over its size.
fn seal(s: &mut [u8]) {
    let size = u32_at(s, h::SIZE) as usize;
    put32(s, h::CRC, 0);
    let c = crc32(&s[..size]);
    put32(s, h::CRC, c);
}

fn grow_gpt(
    d: &impl Disk,
    size: u64,
    lbs: u64,
    mut mbr: Vec<u8>,
    pri: Vec<u8>,
) -> Result<Outcome, Fail> {
    let lbas = size / lbs;
    check_header(&pri, lbs)?;
    let (alt, first, last) = (
        u64_at(&pri, h::ALT),
        u64_at(&pri, h::FIRST),
        u64_at(&pri, h::LAST),
    );
    let (ent_lba, count, esize) = (
        u64_at(&pri, h::ENTRIES),
        u32_at(&pri, h::COUNT) as u64,
        u32_at(&pri, h::ENTRY_SIZE) as u64,
    );
    if u64_at(&pri, h::MY) != 1 {
        return Err(Fail::Bad("the primary GPT header isn't at LBA 1"));
    }
    if esize < 128 || esize % 8 != 0 || esize > 4096 || count == 0 || count * esize > 1 << 20 {
        return Err(Fail::Bad("a GPT entry array's shape out of range"));
    }
    let esec = (count * esize).div_ceil(lbs);
    if alt >= lbas {
        return Err(Fail::Bad("the GPT's backup header past the disk's end"));
    }
    if ent_lba < 2 || ent_lba + esec > first || first > last + 1 || last >= alt {
        return Err(Fail::Bad("a GPT header's layout"));
    }
    let mut entries = vec![0u8; (count * esize) as usize];
    d.read(ent_lba * lbs, &mut entries)?;
    if crc32(&entries) != u32_at(&pri, h::ENTRIES_CRC) {
        return Err(Fail::Bad("the GPT's entries' CRC"));
    }
    // The backup, where the primary says it is: the same table.
    let mut bak = vec![0u8; lbs as usize];
    d.read(alt * lbs, &mut bak)?;
    check_header(&bak, lbs)?;
    let bak_ent = u64_at(&bak, h::ENTRIES);
    if u64_at(&bak, h::MY) != alt
        || u64_at(&bak, h::ALT) != 1
        || u64_at(&bak, h::FIRST) != first
        || u64_at(&bak, h::LAST) != last
        || bak[h::GUID..h::GUID + 16] != pri[h::GUID..h::GUID + 16]
        || u32_at(&bak, h::COUNT) as u64 != count
        || u32_at(&bak, h::ENTRY_SIZE) as u64 != esize
        || u32_at(&bak, h::ENTRIES_CRC) != u32_at(&pri, h::ENTRIES_CRC)
        || bak_ent <= last
        || bak_ent + esec > alt
    {
        return Err(Fail::Bad("the backup GPT header doesn't match the primary"));
    }
    let mut bak_entries = vec![0u8; entries.len()];
    d.read(bak_ent * lbs, &mut bak_entries)?;
    if bak_entries != entries {
        return Err(Fail::Bad(
            "the backup GPT's entries differ from the primary's",
        ));
    }
    // The partition that ends last.
    let mut best: Option<(usize, u64, u64)> = None;
    for i in 0..count as usize {
        let e = &entries[i * esize as usize..][..esize as usize];
        if e[..16].iter().all(|&b| b == 0) {
            continue;
        }
        let (s, l) = (u64_at(e, 32), u64_at(e, 40));
        if s > l || s < first || l > last {
            return Err(Fail::Bad("a GPT partition outside the usable space"));
        }
        if best.is_none_or(|(_, _, bl)| l > bl) {
            best = Some((i, s, l));
        }
    }
    let Some((i, start, end)) = best else {
        return Ok(Outcome::NotLast);
    };
    // The new geometry: the backup's entries and header in the last sectors.
    let new_alt = lbas - 1;
    let moved = new_alt > alt;
    let (b_lba, b_ent, new_last) = if moved {
        let e = new_alt - esec;
        (new_alt, e, e - 1)
    } else {
        (alt, bak_ent, last)
    };
    if new_last < last {
        return Err(Fail::Bad("the grown GPT would have less usable space"));
    }
    let align = (ALIGN / lbs).max(1);
    let new_end = ((new_last + 1) / align * align).wrapping_sub(1);
    let grows = (new_last + 1) / align > 0 && new_end > end;
    if !moved && !grows {
        return Ok(Outcome::Last {
            pno: i as u32 + 1,
            start,
            len: end - start + 1,
            written: false,
        });
    }
    let end = if grows { new_end } else { end };
    put64(&mut entries[i * esize as usize..], 40, end);
    let ecrc = crc32(&entries);
    let mut nb = pri.clone();
    put64(&mut nb, h::MY, b_lba);
    put64(&mut nb, h::ALT, 1);
    put64(&mut nb, h::LAST, new_last);
    put64(&mut nb, h::ENTRIES, b_ent);
    put32(&mut nb, h::ENTRIES_CRC, ecrc);
    seal(&mut nb);
    let mut np = pri;
    put64(&mut np, h::ALT, b_lba);
    put64(&mut np, h::LAST, new_last);
    put32(&mut np, h::ENTRIES_CRC, ecrc);
    seal(&mut np);
    // The backup first, then the primary (its entries before its header: a header that doesn't match its entries
    // leaves the backup, already whole, as the table).
    d.write(b_ent * lbs, &entries)?;
    d.write(b_lba * lbs, &nb)?;
    d.sync()?;
    d.write(ent_lba * lbs, &entries)?;
    d.write(lbs, &np)?;
    d.sync()?;
    if moved {
        // The old backup header, now inside the free space or the grown partition, would be a stale table's.
        d.write(alt * lbs, &vec![0u8; lbs as usize])?;
        // A protective MBR (its one 0xEE entry from LBA 1) covers the disk again; a hybrid one is left as it is.
        if let Some(p) = parse_mbr(&mbr)
            && p.iter().filter(|e| e.kind != 0).count() == 1
            && p[0].kind == 0xee
            && p[0].start == 1
        {
            let n = (lbas - 1).min(u32::MAX as u64) as u32;
            put32(&mut mbr, 446 + 12, n);
            mbr[446 + 5..446 + 8].copy_from_slice(&chs(lbas - 1));
            d.write(0, &mbr)?;
        }
        d.sync()?;
    }
    Ok(Outcome::Last {
        pno: i as u32 + 1,
        start,
        len: end - start + 1,
        written: true,
    })
}

/// An MBR's entry.
#[derive(Clone, Copy)]
struct Entry {
    kind: u8,
    start: u64,
    size: u64,
}

/// The four primary entries of a sector that is an MBR (the signature, boot flags 0 or 0x80, an entry in use, not a
/// FAT boot sector, which has the signature too); None if it isn't one.
fn parse_mbr(s: &[u8]) -> Option<[Entry; 4]> {
    if s[510] != 0x55 || s[511] != 0xaa || &s[0x36..0x39] == b"FAT" || &s[0x52..0x57] == b"FAT32" {
        return None;
    }
    let mut out = [Entry {
        kind: 0,
        start: 0,
        size: 0,
    }; 4];
    for (i, e) in out.iter_mut().enumerate() {
        let r = &s[446 + 16 * i..][..16];
        if r[0] != 0 && r[0] != 0x80 {
            return None;
        }
        *e = Entry {
            kind: r[4],
            start: u32_at(r, 8) as u64,
            size: u32_at(r, 12) as u64,
        };
        if e.kind != 0 && (e.start == 0 || e.size == 0) {
            return None;
        }
    }
    out.iter().any(|e| e.kind != 0).then_some(out)
}

/// An LBA as CHS (255 heads, 63 sectors), or 1023/254/63 past it.
fn chs(lba: u64) -> [u8; 3] {
    let c = lba / (255 * 63);
    if c > 1023 {
        return [0xfe, 0xff, 0xff];
    }
    let (h, s) = ((lba / 63) % 255, lba % 63 + 1);
    [h as u8, (s as u8) | ((c >> 2) as u8 & 0xc0), c as u8]
}

fn grow_mbr(
    d: &impl Disk,
    lbas: u64,
    lbs: u64,
    mut s: Vec<u8>,
    p: &[Entry; 4],
) -> Result<Outcome, Fail> {
    for e in p.iter().filter(|e| e.kind != 0) {
        if e.start + e.size > lbas {
            return Err(Fail::Bad("an MBR partition past the disk's end"));
        }
    }
    let (i, e) = p
        .iter()
        .enumerate()
        .filter(|(_, e)| e.kind != 0)
        .max_by_key(|(_, e)| e.start + e.size)
        .unwrap();
    if matches!(e.kind, 0x05 | 0x0f | 0x85) {
        return Ok(Outcome::NotLast);
    }
    let align = (ALIGN / lbs).max(1);
    // An MBR names sectors in 32 bits: the end at most 2^32.
    let end = lbas.min(1 << 32) / align * align;
    let old = e.start + e.size;
    if end <= old {
        return Ok(Outcome::Last {
            pno: i as u32 + 1,
            start: e.start,
            len: e.size,
            written: false,
        });
    }
    let r = 446 + 16 * i;
    put32(&mut s, r + 12, (end - e.start) as u32);
    s[r + 5..r + 8].copy_from_slice(&chs(end - 1));
    d.write(0, &s)?;
    d.sync()?;
    Ok(Outcome::Last {
        pno: i as u32 + 1,
        start: e.start,
        len: end - e.start,
        written: true,
    })
}

/// Tables written for the tests (here and in src/serve_test.rs) into image files.
#[cfg(test)]
pub mod image {
    use super::*;
    use std::os::unix::fs::FileExt;

    /// GPT's partition types the tests use: Linux's filesystem, the ESP, BIOS boot.
    pub const LINUX: [u8; 16] = guid(
        0x0fc63daf,
        0x8483,
        0x4772,
        [0x8e, 0x79, 0x3d, 0x69, 0xd8, 0x47, 0x7d, 0xe4],
    );
    pub const ESP: [u8; 16] = guid(
        0xc12a7328,
        0xf81f,
        0x11d2,
        [0xba, 0x4b, 0x00, 0xa0, 0xc9, 0x3e, 0xc9, 0x3b],
    );
    pub const BIOS: [u8; 16] = guid(
        0x21686148,
        0x6449,
        0x6e6f,
        [0x74, 0x4e, 0x65, 0x65, 0x64, 0x45, 0x46, 0x49],
    );

    pub const fn guid(a: u32, b: u16, c: u16, d: [u8; 8]) -> [u8; 16] {
        let (a, b, c) = (a.to_le_bytes(), b.to_le_bytes(), c.to_le_bytes());
        [
            a[0], a[1], a[2], a[3], b[0], b[1], c[0], c[1], d[0], d[1], d[2], d[3], d[4], d[5],
            d[6], d[7],
        ]
    }

    /// A file's descriptor as rustix's (its `no_std` build has a type of its own).
    pub fn fd(f: &std::fs::File) -> BorrowedFd<'_> {
        // SAFETY: the file is open for as long as the borrow, which `f`'s lifetime bounds.
        unsafe { BorrowedFd::borrow_raw(std::os::fd::AsRawFd::as_raw_fd(f)) }
    }

    /// A sparse image file of `size` bytes.
    pub fn file(path: &std::path::Path, size: u64) -> std::fs::File {
        let f = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(true)
            .open(path)
            .unwrap();
        f.set_len(size).unwrap();
        f
    }

    /// A GPT as a partitioning tool writes it on a disk of `size` bytes (sectors of `lbs`): 128 entries of 128 bytes,
    /// `parts` (entry index, type, first and last LBA), the protective MBR.
    pub fn gpt(f: &std::fs::File, size: u64, lbs: u64, parts: &[(usize, [u8; 16], u64, u64)]) {
        let lbas = size / lbs;
        let mut entries = vec![0u8; 128 * 128];
        for &(i, t, s, l) in parts {
            let e = &mut entries[i * 128..][..128];
            e[..16].copy_from_slice(&t);
            e[16..32].copy_from_slice(&[i as u8 + 1; 16]);
            put64(e, 32, s);
            put64(e, 40, l);
        }
        let esec = (128 * 128) / lbs;
        let mut hd = vec![0u8; lbs as usize];
        hd[..8].copy_from_slice(b"EFI PART");
        put32(&mut hd, 8, 0x0001_0000);
        put32(&mut hd, h::SIZE, 92);
        put64(&mut hd, h::MY, 1);
        put64(&mut hd, h::ALT, lbas - 1);
        put64(&mut hd, h::FIRST, 2 + esec);
        put64(&mut hd, h::LAST, lbas - 2 - esec);
        hd[h::GUID..h::GUID + 16].copy_from_slice(&[0x5a; 16]);
        put64(&mut hd, h::ENTRIES, 2);
        put32(&mut hd, h::COUNT, 128);
        put32(&mut hd, h::ENTRY_SIZE, 128);
        put32(&mut hd, h::ENTRIES_CRC, crc32(&entries));
        let mut bk = hd.clone();
        seal(&mut hd);
        put64(&mut bk, h::MY, lbas - 1);
        put64(&mut bk, h::ALT, 1);
        put64(&mut bk, h::ENTRIES, lbas - 1 - esec);
        seal(&mut bk);
        let mut mbr = vec![0u8; lbs as usize];
        mbr[446 + 1..446 + 4].copy_from_slice(&[0, 2, 0]);
        mbr[446 + 4] = 0xee;
        mbr[446 + 5..446 + 8].copy_from_slice(&chs(lbas - 1));
        put32(&mut mbr, 446 + 8, 1);
        put32(&mut mbr, 446 + 12, (lbas - 1).min(u32::MAX as u64) as u32);
        mbr[510] = 0x55;
        mbr[511] = 0xaa;
        f.write_all_at(&mbr, 0).unwrap();
        f.write_all_at(&hd, lbs).unwrap();
        f.write_all_at(&entries, 2 * lbs).unwrap();
        f.write_all_at(&entries, (lbas - 1 - esec) * lbs).unwrap();
        f.write_all_at(&bk, (lbas - 1) * lbs).unwrap();
    }

    /// Debian's layout (its cloud images'): p14 BIOS boot and p15 the ESP first, p1 the root after them, ending last.
    pub fn debian(f: &std::fs::File, size: u64) {
        let last = size / 512 - 34;
        gpt(
            f,
            size,
            512,
            &[
                (0, LINUX, 16384, last / 2048 * 2048 - 1),
                (13, BIOS, 2048, 8191),
                (14, ESP, 8192, 16383),
            ],
        );
    }

    /// An MBR with `parts` (slot, type, first sector, sectors) on sectors of 512.
    pub fn mbr(f: &std::fs::File, parts: &[(usize, u8, u64, u64)]) {
        let mut s = vec![0u8; 512];
        for &(i, t, start, n) in parts {
            let r = 446 + 16 * i;
            s[r + 4] = t;
            s[r + 1..r + 4].copy_from_slice(&chs(start));
            s[r + 5..r + 8].copy_from_slice(&chs(start + n - 1));
            put32(&mut s, r + 8, start as u32);
            put32(&mut s, r + 12, n as u32);
        }
        s[510] = 0x55;
        s[511] = 0xaa;
        f.write_all_at(&s, 0).unwrap();
    }

    /// A disk whose writes fail (`ROFS`).
    struct ReadOnly<'a, D: Disk>(&'a D);

    impl<D: Disk> Disk for ReadOnly<'_, D> {
        fn read(&self, at: u64, buf: &mut [u8]) -> Result<(), Errno> {
            self.0.read(at, buf)
        }
        fn write(&self, _: u64, _: &[u8]) -> Result<(), Errno> {
            Err(Errno::ROFS)
        }
        fn sync(&self) -> Result<(), Errno> {
            Ok(())
        }
    }

    /// GPT's partitions as the image's table has them now (re-parsed, both copies checked): (index, first, last).
    pub fn gpt_parts(f: &std::fs::File, lbs: u64) -> Result<Vec<(usize, u64, u64)>, &'static str> {
        let size = f.metadata().unwrap().len();
        let d = Fd { fd: fd(f), size };
        let mut pri = vec![0u8; lbs as usize];
        d.read(lbs, &mut pri).unwrap();
        // A grow of the table as it is checks both copies and writes nothing when it's whole and at the end.
        let mut s = vec![0u8; lbs as usize];
        d.read(0, &mut s).unwrap();
        match grow_gpt(&ReadOnly(&d), size, lbs, s, pri.clone()) {
            Ok(Outcome::Last { written: false, .. }) | Ok(Outcome::NotLast) => {}
            Ok(_) | Err(Fail::Io(Errno::ROFS)) => {
                return Err("the table wasn't at the disk's end, or its partition could grow");
            }
            Err(Fail::Bad(why)) => return Err(why),
            Err(Fail::Io(_)) => return Err("I/O"),
        }
        let n = u32_at(&pri, h::COUNT) as usize;
        let mut e = vec![0u8; n * 128];
        d.read(u64_at(&pri, h::ENTRIES) * lbs, &mut e).unwrap();
        Ok((0..n)
            .filter(|i| e[i * 128..][..16].iter().any(|&b| b != 0))
            .map(|i| (i, u64_at(&e, i * 128 + 32), u64_at(&e, i * 128 + 40)))
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::image::*;
    use super::*;
    use std::os::unix::fs::FileExt;
    use std::path::PathBuf;

    const MIB: u64 = 1 << 20;

    fn dir(name: &str) -> PathBuf {
        let d =
            std::env::temp_dir().join(format!("waarm64-agent-table-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn run(f: &std::fs::File, lbs: u64) -> Outcome {
        let size = f.metadata().unwrap().len();
        grow(&Fd { fd: fd(f), size }, size, lbs)
    }

    fn tool(name: &str) -> Option<PathBuf> {
        ["/usr/sbin", "/sbin", "/usr/bin", "/bin"]
            .iter()
            .map(|d| PathBuf::from(d).join(name))
            .find(|p| p.exists())
    }

    #[test]
    fn crc32_is_zlibs() {
        assert_eq!(crc32(b"123456789"), 0xcbf4_3926);
        assert_eq!(crc32(b""), 0);
    }

    #[test]
    fn grows_debians_root_which_ends_last_and_moves_the_backup() {
        let d = dir("debian");
        let f = file(&d.join("disk"), 32 * MIB);
        debian(&f, 32 * MIB);
        assert_eq!(
            gpt_parts(&f, 512).unwrap(),
            vec![(0, 16384, 63487), (13, 2048, 8191), (14, 8192, 16383)]
        );
        f.set_len(64 * MIB).unwrap();
        // The old table, its backup where the disk ended.
        assert_eq!(
            gpt_parts(&f, 512),
            Err("the table wasn't at the disk's end, or its partition could grow")
        );
        let last = (64 * MIB / 512 - 34) / 2048 * 2048 - 1;
        assert_eq!(
            run(&f, 512),
            Outcome::Last {
                pno: 1,
                start: 16384,
                len: last - 16384 + 1,
                written: true
            }
        );
        assert_eq!(
            gpt_parts(&f, 512).unwrap(),
            vec![(0, 16384, last), (13, 2048, 8191), (14, 8192, 16383)],
            "p1 grown to the last whole MiB, p14 and p15 as they were"
        );
        // The old backup header is gone; the protective MBR covers the disk.
        let mut s = [0u8; 8];
        f.read_exact_at(&mut s, 32 * MIB - 512).unwrap();
        assert_eq!(s, [0; 8]);
        let mut m = [0u8; 4];
        f.read_exact_at(&mut m, 446 + 12).unwrap();
        assert_eq!(u32::from_le_bytes(m) as u64, 64 * MIB / 512 - 1);
        // Again: nothing to grow, nothing written.
        assert_eq!(
            run(&f, 512),
            Outcome::Last {
                pno: 1,
                start: 16384,
                len: last - 16384 + 1,
                written: false
            }
        );
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn grows_the_partition_that_ends_last_not_the_first_one() {
        let d = dir("order");
        let f = file(&d.join("disk"), 16 * MIB);
        // p1 first with free space after it, p2 at the old end: p2 grows.
        let old_last = 16 * MIB / 512 - 34;
        gpt(
            &f,
            16 * MIB,
            512,
            &[(1, LINUX, 20480, old_last), (0, LINUX, 2048, 4095)],
        );
        f.set_len(48 * MIB).unwrap();
        let o = run(&f, 512);
        let new = 48 * MIB / 512 / 2048 * 2048 - 2048 - 1;
        assert_eq!(
            o,
            Outcome::Last {
                pno: 2,
                start: 20480,
                len: new - 20480 + 1,
                written: true
            }
        );
        assert_eq!(
            gpt_parts(&f, 512).unwrap(),
            vec![(0, 2048, 4095), (1, 20480, new)]
        );
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_disk_not_grown_moves_nothing_and_a_small_growth_only_the_backup() {
        let d = dir("small");
        let f = file(&d.join("disk"), 16 * MIB);
        gpt(&f, 16 * MIB, 512, &[(0, LINUX, 2048, 30719)]);
        assert_eq!(
            run(&f, 512),
            Outcome::Last {
                pno: 1,
                start: 2048,
                len: 28672,
                written: false
            }
        );
        // Grown by 512 KiB: the partition to its next whole MiB, which the backup's sectors left free.
        f.set_len(16 * MIB + 512 * 1024).unwrap();
        assert_eq!(
            run(&f, 512),
            Outcome::Last {
                pno: 1,
                start: 2048,
                len: 32768 - 2048,
                written: true
            }
        );
        assert_eq!(gpt_parts(&f, 512).unwrap(), vec![(0, 2048, 32767)]);
        // By 64 KiB more: no whole MiB after it; the backup moves to the end all the same.
        f.set_len(16 * MIB + 576 * 1024).unwrap();
        assert_eq!(
            run(&f, 512),
            Outcome::Last {
                pno: 1,
                start: 2048,
                len: 32768 - 2048,
                written: true
            }
        );
        assert_eq!(gpt_parts(&f, 512).unwrap(), vec![(0, 2048, 32767)]);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn sectors_of_4_kib() {
        let d = dir("4k");
        let f = file(&d.join("disk"), 64 * MIB);
        gpt(&f, 64 * MIB, 4096, &[(0, LINUX, 256, 64 * MIB / 4096 - 6)]);
        f.set_len(128 * MIB).unwrap();
        let o = run(&f, 4096);
        let new = 128 * MIB / 4096 - 256 - 1;
        assert_eq!(
            o,
            Outcome::Last {
                pno: 1,
                start: 256,
                len: new - 256 + 1,
                written: true
            }
        );
        assert_eq!(gpt_parts(&f, 4096).unwrap(), vec![(0, 256, new)]);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_corrupt_table_is_left_alone() {
        let d = dir("corrupt");
        for (what, at, why) in [
            ("primary header", 512 + 60, "a GPT header's CRC"),
            ("entries", 1024 + 100, "the GPT's entries' CRC"),
            ("backup header", 16 * MIB - 512 + 60, "a GPT header's CRC"),
            (
                "backup entries",
                16 * MIB - 512 * 33 + 5,
                "the backup GPT's entries differ from the primary's",
            ),
        ] {
            let f = file(&d.join("disk"), 16 * MIB);
            gpt(&f, 16 * MIB, 512, &[(0, LINUX, 2048, 30719)]);
            f.write_all_at(&[0x77], at).unwrap();
            f.set_len(32 * MIB).unwrap();
            let before = std::fs::read(d.join("disk")).unwrap();
            assert_eq!(run(&f, 512), Outcome::Bad(why), "{what}");
            assert!(
                std::fs::read(d.join("disk")).unwrap() == before,
                "{what}: nothing written"
            );
        }
        // A backup header the primary names past the disk's end (a disk smaller than its table).
        let f = file(&d.join("disk"), 32 * MIB);
        gpt(&f, 32 * MIB, 512, &[(0, LINUX, 2048, 30719)]);
        f.set_len(16 * MIB).unwrap();
        assert_eq!(
            run(&f, 512),
            Outcome::Bad("the GPT's backup header past the disk's end")
        );
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn mbr_grows_its_last_primary_within_32_bits() {
        let d = dir("mbr");
        let f = file(&d.join("disk"), 32 * MIB);
        mbr(&f, &[(0, 0x83, 2048, 30720), (1, 0x82, 32768, 32768)]);
        f.set_len(64 * MIB).unwrap();
        assert_eq!(
            run(&f, 512),
            Outcome::Last {
                pno: 2,
                start: 32768,
                len: 131072 - 32768,
                written: true
            }
        );
        let mut s = [0u8; 512];
        f.read_exact_at(&mut s, 0).unwrap();
        let p = parse_mbr(&s).unwrap();
        assert_eq!(
            (p[0].start, p[0].size, p[1].start, p[1].size),
            (2048, 30720, 32768, 131072 - 32768)
        );
        assert_eq!(s[446 + 16 + 5..446 + 16 + 8], chs(131071));
        assert!(
            matches!(run(&f, 512), Outcome::Last { written: false, .. }),
            "again: nothing"
        );
        // Past 2 TiB: the end at 2^32 sectors, aligned.
        let f = file(&d.join("big"), 64 * MIB);
        mbr(&f, &[(0, 0x83, 2048, 64 * MIB / 512 - 2048)]);
        f.set_len(3 << 40).unwrap();
        let end = (1u64 << 32) / 2048 * 2048;
        assert_eq!(
            run(&f, 512),
            Outcome::Last {
                pno: 1,
                start: 2048,
                len: end - 2048,
                written: true
            }
        );
        assert!(
            matches!(run(&f, 512), Outcome::Last { written: false, .. }),
            "at the 32-bit end: nothing"
        );
        // An extended partition that ends last isn't grown.
        let f = file(&d.join("ext"), 32 * MIB);
        mbr(&f, &[(0, 0x83, 2048, 20480), (1, 0x05, 22528, 32768)]);
        f.set_len(64 * MIB).unwrap();
        assert_eq!(run(&f, 512), Outcome::NotLast);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn no_table_on_a_whole_disk_filesystem() {
        let d = dir("none");
        let f = file(&d.join("disk"), 16 * MIB);
        assert_eq!(run(&f, 512), Outcome::NoTable);
        // A FAT boot sector has MBR's signature: still no table.
        let mut s = vec![0u8; 512];
        s[0x36..0x39].copy_from_slice(b"FAT");
        s[446..462].copy_from_slice(&[0xeb; 16]);
        s[510] = 0x55;
        s[511] = 0xaa;
        f.write_all_at(&s, 0).unwrap();
        assert_eq!(run(&f, 512), Outcome::NoTable);
        let _ = std::fs::remove_dir_all(&d);
    }

    /// The grown tables as the system's own tools see them (sfdisk, sgdisk), where the dev VM has them: tables they
    /// wrote, grown by `grow`, verified by them.
    #[test]
    fn the_systems_tools_verify_the_grown_tables() {
        let (Some(sfdisk), Some(sgdisk)) = (tool("sfdisk"), tool("sgdisk")) else {
            eprintln!("skipped: no sfdisk or sgdisk");
            return;
        };
        let d = dir("tools");
        let img = d.join("disk");
        let sh = |cmd: &PathBuf, args: &[&str], input: &str| {
            let mut c = std::process::Command::new(cmd)
                .args(args)
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .unwrap();
            std::io::Write::write_all(c.stdin.as_mut().unwrap(), input.as_bytes()).unwrap();
            let o = c.wait_with_output().unwrap();
            (
                o.status.success(),
                String::from_utf8_lossy(&o.stdout).into_owned()
                    + &String::from_utf8_lossy(&o.stderr),
            )
        };
        let p = img.to_str().unwrap();
        // Debian's layout by sfdisk.
        file(&img, 64 * MIB);
        let (ok, out) = sh(
            &sfdisk,
            &["-q", "--no-reread", "--no-tell-kernel", p],
            "label: gpt\n\
             p14 : start=2048, size=6144, type=21686148-6449-6E6F-744E-656564454649\n\
             p15 : start=8192, size=8192, type=C12A7328-F81F-11D2-BA4B-00A0C93EC93B\n\
             p1 : start=16384, type=0FC63DAF-8483-4772-8E79-3D69D8477DE4\n",
        );
        assert!(ok, "{out}");
        std::fs::OpenOptions::new()
            .write(true)
            .open(&img)
            .unwrap()
            .set_len(256 * MIB)
            .unwrap();
        let f = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&img)
            .unwrap();
        assert!(matches!(
            run(&f, 512),
            Outcome::Last {
                pno: 1,
                written: true,
                ..
            }
        ));
        let (ok, out) = sh(&sfdisk, &["--verify", p], "");
        assert!(
            ok && out.contains("No errors detected"),
            "sfdisk --verify: {out}"
        );
        let (ok, out) = sh(&sgdisk, &["-v", p], "");
        // sgdisk regenerates a bad backup in memory and finds no problems in that: its cautions say so.
        assert!(
            ok && out.contains("No problems found")
                && !out.contains("aution")
                && !out.contains("nvalid"),
            "sgdisk -v: {out}"
        );
        let (ok, out) = sh(&sfdisk, &["-d", p], "");
        assert!(ok && out.contains("last-lba: 524254"), "{out}");
        assert!(
            out.contains("start=       16384, size=      505856"),
            "p1 to the last whole MiB: {out}"
        );
        // An MBR by sfdisk.
        file(&img, 64 * MIB);
        let (ok, out) = sh(
            &sfdisk,
            &["-q", "--no-reread", "--no-tell-kernel", p],
            "label: dos\nstart=2048, type=83\n",
        );
        assert!(ok, "{out}");
        std::fs::OpenOptions::new()
            .write(true)
            .open(&img)
            .unwrap()
            .set_len(256 * MIB)
            .unwrap();
        let f = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&img)
            .unwrap();
        assert!(matches!(
            run(&f, 512),
            Outcome::Last {
                pno: 1,
                written: true,
                ..
            }
        ));
        let (ok, out) = sh(&sfdisk, &["--verify", p], "");
        assert!(
            ok && out.contains("No errors detected"),
            "sfdisk --verify: {out}"
        );
        let (ok, out) = sh(&sfdisk, &["-d", p], "");
        assert!(
            ok && out.contains("start=        2048, size=      522240"),
            "{out}"
        );
        let _ = std::fs::remove_dir_all(&d);
    }
}
