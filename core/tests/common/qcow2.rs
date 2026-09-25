//! Disk images for the native block backend: raw, or qcow2 v2/v3 read through
//! its L1/L2 tables (web/qcow2.ts is the browser's twin; the same rules). From
//! the format spec, QEMU's docs/interop/qcow2.txt (no QEMU code). Refcounts
//! are ignored (read-only); unallocated and zero-flag clusters read as zeros;
//! compressed clusters are raw deflate. Refused at open: encryption, backing
//! files, external data files, extended L2 entries, zstd, unknown
//! incompatible features.

use std::cell::RefCell;

const MAGIC: &[u8] = b"QFI\xfb";
const OFFSET_MASK: u64 = 0x00ff_ffff_ffff_fe00; // bits 9-55
const COMPRESSED: u64 = 1 << 62;
const ZERO: u64 = 1; // v3
const KNOWN_INCOMPATIBLE: u64 = 1 << 0 | 1 << 1 | 1 << 3; // dirty, corrupt, compression type

pub struct Disk {
    file: &'static [u8],
    qcow2: Option<Qcow2>,
}

struct Qcow2 {
    version: u32,
    cluster_bits: u32,
    size: u64,
    l1: Vec<u64>,
    /// The last compressed cluster read (a guest reads one a page at a time).
    recent: RefCell<Option<(u64, Vec<u8>)>>,
}

fn be64(b: &[u8], at: usize) -> u64 {
    u64::from_be_bytes(b[at..at + 8].try_into().unwrap())
}
fn be32(b: &[u8], at: usize) -> u32 {
    u32::from_be_bytes(b[at..at + 4].try_into().unwrap())
}

impl Disk {
    /// qcow2 by its magic, raw otherwise.
    pub fn open(file: &'static [u8]) -> Result<Disk, String> {
        let qcow2 = if file.len() >= 112 && file.starts_with(MAGIC) {
            Some(Qcow2::open(file).map_err(|e| format!("qcow2: {e}"))?)
        } else {
            None
        };
        Ok(Disk { file, qcow2 })
    }

    pub fn size(&self) -> u64 {
        self.qcow2
            .as_ref()
            .map_or(self.file.len() as u64, |q| q.size)
    }

    /// Fills `buf` from `off`; false past the end or on a malformed image.
    pub fn read(&self, off: u64, buf: &mut [u8]) -> bool {
        let Some(q) = &self.qcow2 else {
            let src = usize::try_from(off)
                .ok()
                .and_then(|o| self.file.get(o..o.checked_add(buf.len())?));
            return src.map(|s| buf.copy_from_slice(s)).is_some();
        };
        if off
            .checked_add(buf.len() as u64)
            .is_none_or(|end| end > q.size)
        {
            return false;
        }
        let cs = 1u64 << q.cluster_bits;
        let l2_entries = cs / 8;
        let mut k = 0;
        while k < buf.len() {
            let pos = off + k as u64;
            let (c, o) = (pos / cs, (pos % cs) as usize);
            let n = (cs as usize - o).min(buf.len() - k);
            let dst = &mut buf[k..k + n];
            let Some(e) = self.l2_entry(q, c / l2_entries, c % l2_entries) else {
                return false;
            };
            if e & COMPRESSED != 0 {
                let mut recent = q.recent.borrow_mut();
                if recent.as_ref().is_none_or(|r| r.0 != e) {
                    let Some(data) = self.inflate(q, e) else {
                        return false;
                    };
                    *recent = Some((e, data));
                }
                dst.copy_from_slice(&recent.as_ref().unwrap().1[o..o + n]);
            } else if (q.version == 3 && e & ZERO != 0) || e & OFFSET_MASK == 0 {
                dst.fill(0);
            } else {
                let at = (e & OFFSET_MASK) as usize + o;
                let Some(src) = self.file.get(at..at + n) else {
                    return false;
                };
                dst.copy_from_slice(src);
            }
            k += n;
        }
        true
    }

    fn l2_entry(&self, q: &Qcow2, l1: u64, i: u64) -> Option<u64> {
        let t = (*q.l1.get(l1 as usize)? & OFFSET_MASK) as usize;
        if t == 0 {
            return Some(0);
        }
        let at = t + i as usize * 8;
        Some(be64(self.file.get(at..at + 8)?, 0))
    }

    /// A compressed cluster: bits 0..x-1 the host offset, x..61 the number of
    /// 512-byte sectors after the first. The input runs to a sector boundary,
    /// so it usually ends with the next cluster's bytes (after the stream's end).
    fn inflate(&self, q: &Qcow2, e: u64) -> Option<Vec<u8>> {
        let x = 62 - (q.cluster_bits - 8);
        let off = (e & ((1 << x) - 1)) as usize;
        let sectors = ((e & ((1 << 62) - 1)) >> x) as usize + 1;
        let end = (off - off % 512 + sectors * 512).min(self.file.len());
        let cs = 1 << q.cluster_bits;
        let data = miniz_oxide::inflate::decompress_to_vec_with_limit(self.file.get(off..end)?, cs)
            .ok()?;
        (data.len() == cs).then_some(data)
    }
}

impl Qcow2 {
    fn open(f: &[u8]) -> Result<Qcow2, String> {
        let version = be32(f, 4);
        if version != 2 && version != 3 {
            return Err(format!("version {version}"));
        }
        if be64(f, 8) != 0 {
            return Err("backing files are not supported".into());
        }
        let cluster_bits = be32(f, 20);
        if !(9..=21).contains(&cluster_bits) {
            return Err(format!("cluster_bits {cluster_bits}"));
        }
        let size = be64(f, 24);
        if be32(f, 32) != 0 {
            return Err("encrypted images are not supported".into());
        }
        let (l1_size, l1_offset) = (be32(f, 36) as usize, be64(f, 40) as usize);
        if version == 3 {
            let inc = be64(f, 72);
            if inc & 1 << 2 != 0 {
                return Err("external data files are not supported".into());
            }
            if inc & 1 << 4 != 0 {
                return Err("extended L2 entries are not supported".into());
            }
            if inc & !KNOWN_INCOMPATIBLE != 0 {
                return Err(format!("unknown incompatible features {inc:#x}"));
            }
            if inc & 1 << 3 != 0 && be32(f, 100) > 104 && f[104] != 0 {
                return Err("zstd compression is not supported".into());
            }
        }
        let covered = (l1_size as u128) << (2 * cluster_bits - 3);
        if covered < size as u128 {
            return Err("L1 table too small for the virtual size".into());
        }
        let l1 = f
            .get(l1_offset..l1_offset + l1_size * 8)
            .ok_or("L1 table past the end of the file")?
            .chunks(8)
            .map(|c| be64(c, 0))
            .collect();
        Ok(Qcow2 {
            version,
            cluster_bits,
            size,
            l1,
            recent: RefCell::new(None),
        })
    }
}
