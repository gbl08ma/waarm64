//! QEMU's firmware configuration device, its MMIO interface without DMA
//! (QEMU docs/specs/fw_cfg.rst; docs/abi.md "M8 phase B"): the host's named
//! files for the firmware and the guest (Linux's `qemu_fw_cfg` driver, and
//! systemd's credentials under `opt/io.systemd.credentials/`).

/// The device's PA (QEMU `virt`'s).
pub const FW_CFG: u64 = 0x0902_0000;
/// Its registers: data (+0), selector (+8), DMA address (+0x10, absent here).
pub const SIZE: u64 = 0x18;
const DATA: u64 = 0;
const SELECTOR: u64 = 8;
const DMA: u64 = 0x10;

const SIGNATURE: u16 = 0x0000;
const ID: u16 = 0x0001;
const FILE_DIR: u16 = 0x0019;
const FILE_FIRST: u16 = 0x0020;
/// A file's name field, NUL included.
pub const NAME: usize = 56;

pub struct FwCfg {
    files: Vec<Vec<u8>>,
    dir: Vec<u8>,
    selector: u16,
    offset: usize,
}

impl FwCfg {
    /// The device serving `files` (name, contents) at selectors 0x20 upwards;
    /// None if a name is empty or too long, or there are too many.
    pub fn new(files: Vec<(String, Vec<u8>)>) -> Option<FwCfg> {
        if files.len() > (u16::MAX - FILE_FIRST) as usize {
            return None;
        }
        let mut dir = (files.len() as u32).to_be_bytes().to_vec();
        for (i, (name, data)) in files.iter().enumerate() {
            if name.is_empty() || name.len() >= NAME || name.contains('\0') {
                return None;
            }
            dir.extend((data.len() as u32).to_be_bytes());
            dir.extend((FILE_FIRST + i as u16).to_be_bytes());
            dir.extend([0, 0]);
            let mut n = [0u8; NAME];
            n[..name.len()].copy_from_slice(name.as_bytes());
            dir.extend(n);
        }
        Some(FwCfg {
            files: files.into_iter().map(|(_, d)| d).collect(),
            dir,
            selector: 0,
            offset: 0,
        })
    }

    /// Parses the host's buffer: records of a NUL-padded 56-byte name, a u32
    /// LE size and that many bytes. None if it's malformed.
    pub fn parse(mut b: &[u8]) -> Option<Vec<(String, Vec<u8>)>> {
        let mut files = Vec::new();
        while !b.is_empty() {
            let name = b.get(..NAME)?;
            let len = u32::from_le_bytes(b.get(NAME..NAME + 4)?.try_into().ok()?) as usize;
            let data = b.get(NAME + 4..NAME + 4 + len)?;
            let end = name.iter().position(|&c| c == 0)?;
            if name[end..].iter().any(|&c| c != 0) {
                return None;
            }
            files.push((String::from_utf8(name[..end].to_vec()).ok()?, data.to_vec()));
            b = &b[NAME + 4 + len..];
        }
        Some(files)
    }

    /// The selected item's bytes (an absent one is empty: it reads as zeros).
    fn item(&self) -> &[u8] {
        match self.selector {
            SIGNATURE => b"QEMU",
            ID => &[1, 0, 0, 0], // the traditional interface, no DMA
            FILE_DIR => &self.dir,
            s if s >= FILE_FIRST => self.files.get((s - FILE_FIRST) as usize).map_or(&[], |f| f),
            _ => &[],
        }
    }

    pub fn read(&mut self, off: u64, size: u32) -> Option<u64> {
        match off {
            DATA if size <= 8 => {
                let item = self.item();
                let mut b = [0u8; 8];
                for (k, v) in b.iter_mut().take(size as usize).enumerate() {
                    *v = item.get(self.offset + k).copied().unwrap_or(0);
                }
                self.offset += size as usize;
                Some(u64::from_le_bytes(b))
            }
            SELECTOR if size == 2 => Some(0),
            DMA..SIZE => Some(0),
            _ => None,
        }
    }

    pub fn write(&mut self, off: u64, size: u32, v: u64) -> Option<()> {
        match off {
            DATA if size <= 8 => {}
            SELECTOR if size == 2 => {
                self.selector = (v as u16).swap_bytes();
                self.offset = 0;
            }
            DMA..SIZE => {}
            _ => return None,
        }
        Some(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn select(f: &mut FwCfg, s: u16) {
        f.write(SELECTOR, 2, s.swap_bytes() as u64).unwrap();
    }

    #[test]
    fn signature_directory_and_files() {
        let mut f = FwCfg::new(vec![
            ("opt/a".into(), b"hello".to_vec()),
            ("etc/b".into(), vec![]),
        ])
        .unwrap();
        select(&mut f, SIGNATURE);
        assert_eq!(f.read(DATA, 4), Some(u32::from_le_bytes(*b"QEMU") as u64));
        select(&mut f, ID);
        assert_eq!(f.read(DATA, 4), Some(1));
        select(&mut f, FILE_DIR);
        let count = (0..4)
            .map(|_| f.read(DATA, 1).unwrap() as u8)
            .collect::<Vec<_>>();
        assert_eq!(count, [0, 0, 0, 2], "big-endian count");
        let mut e = [0u8; 64];
        for b in e.iter_mut() {
            *b = f.read(DATA, 1).unwrap() as u8;
        }
        assert_eq!(
            &e[..8],
            &[0, 0, 0, 5, 0, 0x20, 0, 0],
            "size, select, reserved"
        );
        assert_eq!(&e[8..14], b"opt/a\0");
        select(&mut f, 0x20);
        assert_eq!(f.read(DATA, 8), Some(u64::from_le_bytes(*b"hello\0\0\0")));
        assert_eq!(f.read(DATA, 1), Some(0), "past the end");
        select(&mut f, 0x20);
        assert_eq!(
            f.read(DATA, 2),
            Some(u16::from_le_bytes(*b"he") as u64),
            "rewound"
        );
        select(&mut f, 0x22);
        assert_eq!(f.read(DATA, 8), Some(0), "absent");
        assert_eq!(f.read(DMA, 8), Some(0));
        assert_eq!(f.read(SIZE, 1), None);
    }

    #[test]
    fn parses_the_host_buffer() {
        let rec = |n: &str, d: &[u8]| {
            let mut r = vec![0u8; NAME];
            r[..n.len()].copy_from_slice(n.as_bytes());
            r.extend((d.len() as u32).to_le_bytes());
            r.extend(d);
            r
        };
        let b = [rec("a", b"xy"), rec("opt/b", b"")].concat();
        let files = FwCfg::parse(&b).unwrap();
        assert_eq!(
            files,
            vec![("a".into(), b"xy".to_vec()), ("opt/b".into(), vec![])]
        );
        assert_eq!(FwCfg::parse(&b[..b.len() - 1]), None, "truncated");
        assert_eq!(FwCfg::parse(&rec("a", b"xyz")[..NAME + 5]), None);
        let mut long = rec("a", b"");
        long[NAME - 1] = b'z';
        assert_eq!(FwCfg::parse(&long), None, "bytes after the NUL");
        assert!(FwCfg::new(vec![(String::new(), vec![])]).is_none());
    }
}
