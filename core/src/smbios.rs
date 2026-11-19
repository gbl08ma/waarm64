//! The firmware configuration's SMBIOS tables, served over fw_cfg as QEMU
//! does (`etc/smbios/smbios-anchor`, `etc/smbios/smbios-tables`): EDK2's
//! SmbiosPlatformDxe installs them and hands Linux an SMBIOS 3.0 entry point,
//! so the guest's `/sys/class/dmi/id`, `dmidecode` and `hostnamectl` describe
//! the machine (DMTF DSP0134 3.0; docs/platform.md "The firmware
//! configuration's devices"). Deterministic: built from the VM's
//! configuration only, with no serial numbers and a null system UUID.

use crate::vm::{RAM_BASE, VmConfig};

pub const ANCHOR: &str = "etc/smbios/smbios-anchor";
pub const TABLES: &str = "etc/smbios/smbios-tables";
/// The host's file of type 11 strings, NUL-separated (ABI 49): systemd
/// credentials the page gives a machine (web/app/keyboard.ts). The core takes
/// it out of fw_cfg and lists its strings in type 11; a credential's name and
/// contents don't fit fw_cfg's 56-byte file names there.
pub const OEM_STRINGS: &str = "opt/waarm64/oem-strings";

/// What the tables call the machine and its maker.
const VENDOR: &str = "waarm64";

/// Type 11's string with spill memories: `systemd-sysctl` reads the
/// credential `sysctl.extra` (systemd 252+).
pub const NUMA_CREDENTIAL: &str = "io.systemd.credential:sysctl.extra=kernel.numa_balancing=0";

/// fw_cfg's files for `cfg` and the host's type 11 strings: the 3.0 entry
/// point (its table address left 0, as QEMU's) and the structures, ending with
/// type 127.
pub fn files(cfg: &VmConfig, oem: &[&str]) -> Vec<(String, Vec<u8>)> {
    let t = tables(cfg, oem);
    let mut a = b"_SM3_".to_vec();
    a.extend([0, 0x18, 3, 0, 0, 1, 0]); // checksum, length, 3.0.0, revision 1, reserved
    a.extend((t.len() as u32).to_le_bytes());
    a.extend(0u64.to_le_bytes());
    a[5] = a.iter().fold(0u8, |s, &b| s.wrapping_sub(b));
    vec![(ANCHOR.into(), a), (TABLES.into(), t)]
}

/// The host's fw_cfg files with the tables after them, unless the host
/// brings its own; its [`OEM_STRINGS`] file goes into the tables, not fw_cfg.
pub fn with(cfg: &VmConfig, mut host: Vec<(String, Vec<u8>)>) -> Vec<(String, Vec<u8>)> {
    let oem = host
        .iter()
        .position(|(n, _)| n == OEM_STRINGS)
        .map(|i| host.remove(i).1)
        .unwrap_or_default();
    let oem: Vec<&str> = oem
        .split(|&b| b == 0)
        .filter(|s| !s.is_empty())
        .filter_map(|s| core::str::from_utf8(s).ok())
        .collect();
    if !host.iter().any(|(n, _)| n.starts_with("etc/smbios/")) {
        host.extend(files(cfg, &oem));
    }
    host
}

/// One structure: its formatted area after the 4-byte header, then its strings
/// (string fields hold 1-based indices into `strings`; an empty string is 0).
fn structure(out: &mut Vec<u8>, ty: u8, handle: u16, body: &[u8], strings: &[&str]) {
    out.push(ty);
    out.push(4 + body.len() as u8);
    out.extend(handle.to_le_bytes());
    out.extend(body);
    let mut any = false;
    for s in strings.iter().filter(|s| !s.is_empty()) {
        out.extend(s.as_bytes());
        out.push(0);
        any = true;
    }
    out.extend(if any { &[0][..] } else { &[0, 0] });
}

fn tables(cfg: &VmConfig, oem: &[&str]) -> Vec<u8> {
    let ncpus = cfg.ncpus.max(1) as u16;
    let mut t = Vec::new();
    // Type 0, firmware: EDK2 (the page's QEMU_EFI.fd), characteristics not
    // supported, UEFI and "a virtual machine" (byte 2, bits 3 and 4).
    let mut b = vec![1, 2, 0, 0, 0, 0x2f]; // vendor, version, segment 0 (UEFI), no date, 3 MiB
    b.extend(8u64.to_le_bytes());
    b.extend([0, 0x18, 0, 0, 0xff, 0xff]);
    structure(&mut t, 0, 0x0000, &b, &["EDK II", "ArmVirtQemuKernel"]);
    // Type 1, the system: no serial, a null UUID (systemd then picks no machine
    // ID from it), woken by the power switch.
    let mut b = vec![1, 2, 0, 0];
    b.extend([0; 16]);
    b.extend([6, 0, 3]);
    structure(&mut t, 1, 0x0100, &b, &[VENDOR, VENDOR, "Virtual Machine"]);
    // Type 3, the chassis: "other", states safe, security unknown.
    let b = [1, 1, 0, 0, 0, 3, 3, 3, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    structure(&mut t, 3, 0x0300, &b, &[VENDOR]);
    // Type 4, one socket with every vCPU as a core: an ARMv8 (family 2,
    // 0x0101) made by and named waarm64 (lscpu's "BIOS Vendor ID" and "BIOS
    // Model name") whose processor ID is MIDR_EL1, enabled, 64-bit (and multi-core).
    let mut b = vec![1, 3, 0xfe, 2];
    b.extend(crate::interp::sys::MIDR.to_le_bytes());
    b.extend([3, 0, 0, 0, 0, 0, 0, 0, 0x41, 2]);
    b.extend([0xff; 6]); // no cache structures
    b.extend([0, 0, 0]);
    let n8 = ncpus.min(255) as u8;
    b.extend([n8, n8, n8]);
    b.extend((0x04 | if ncpus > 1 { 0x08 } else { 0 } as u16).to_le_bytes());
    b.extend(0x0101u16.to_le_bytes());
    for _ in 0..3 {
        b.extend(ncpus.to_le_bytes());
    }
    structure(&mut t, 4, 0x0400, &b, &["CPU 0", VENDOR, VENDOR]);
    // Type 11, OEM strings: with spill memories (NUMA nodes), a systemd
    // credential that turns NUMA balancing off (its scanner's faults are guest
    // code; docs/spill-memories.md); then the host's. systemd imports SMBIOS
    // credentials in a VM, which type 0's "a virtual machine" bit tells it.
    let spill = cfg.spill_layout();
    let strings: Vec<&str> = (!spill.is_empty())
        .then_some(NUMA_CREDENTIAL)
        .into_iter()
        .chain(oem.iter().copied())
        .collect();
    if !strings.is_empty() {
        structure(&mut t, 11, 0x0b00, &[strings.len() as u8], &strings);
    }
    // Type 16, the memory array: system memory without error correction, one device.
    let total = cfg.ram_size + spill.iter().map(|s| s.1).sum::<u64>();
    let kib = total >> 10;
    let mut b = vec![1, 3, 3];
    b.extend((kib.min(0x8000_0000) as u32).to_le_bytes());
    b.extend(0xfffeu16.to_le_bytes());
    b.extend(1u16.to_le_bytes());
    b.extend(if kib >= 0x8000_0000 { total } else { 0 }.to_le_bytes());
    structure(&mut t, 16, 0x1000, &b, &[]);
    // Type 17, the device: all of RAM, of unknown width and speed.
    let mib = total >> 20;
    let mut b = Vec::new();
    b.extend(0x1000u16.to_le_bytes());
    b.extend([0xfe, 0xff, 0xff, 0xff, 0xff, 0xff]); // no error info, widths unknown
    b.extend((mib.min(0x7fff) as u16).to_le_bytes());
    b.extend([1, 0, 1, 0, 7]); // form factor other, no set, "DIMM 0", no bank, RAM
    b.extend(2u16.to_le_bytes()); // type detail other
    b.extend([0, 0, 2, 0, 0, 0, 0]); // speed unknown, the maker, no serial, tag or part, attributes
    b.extend(if mib >= 0x7fff { mib as u32 } else { 0 }.to_le_bytes());
    b.extend([0; 8]); // configured speed, voltages unknown
    structure(&mut t, 17, 0x1100, &b, &["DIMM 0", VENDOR]);
    // Type 19, where the array sits in the physical address space: one per memory.
    for (k, (pa, size)) in [(RAM_BASE, cfg.ram_size)]
        .into_iter()
        .chain(spill)
        .enumerate()
    {
        let (start, end) = (pa >> 10, ((pa + size) >> 10) - 1);
        let big = end >= 0xffff_ffff;
        let mut b = Vec::new();
        b.extend(if big { u32::MAX } else { start as u32 }.to_le_bytes());
        b.extend(if big { u32::MAX } else { end as u32 }.to_le_bytes());
        b.extend(0x1000u16.to_le_bytes());
        b.push(1);
        b.extend(if big { pa } else { 0 }.to_le_bytes());
        b.extend(if big { pa + size - 1 } else { 0 }.to_le_bytes());
        structure(&mut t, 19, 0x1300 + k as u16, &b, &[]);
    }
    // Type 32, boot: no errors.
    structure(&mut t, 32, 0x2000, &[0; 7], &[]);
    structure(&mut t, 127, 0x7f00, &[], &[]);
    t
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The structures' (type, length, strings, offset) in order.
    fn walk(all: &[u8]) -> Vec<(u8, u8, Vec<String>, usize)> {
        let mut v = Vec::new();
        let mut t = all;
        while !t.is_empty() {
            let at = all.len() - t.len();
            let (ty, len) = (t[0], t[1]);
            let mut s = &t[len as usize..];
            let mut strings = Vec::new();
            if s[..2] == [0, 0] {
                s = &s[2..];
            } else {
                while s[0] != 0 {
                    let n = s.iter().position(|&c| c == 0).unwrap();
                    strings.push(String::from_utf8(s[..n].to_vec()).unwrap());
                    s = &s[n + 1..];
                }
                s = &s[1..];
            }
            v.push((ty, len, strings, at));
            t = s;
        }
        v
    }

    #[test]
    fn anchor_and_structures() {
        let cfg = VmConfig {
            ram_size: 2 << 30,
            ncpus: 4,
            ..VmConfig::default()
        };
        let f = files(&cfg, &[]);
        let (a, t) = (&f[0].1, &f[1].1);
        assert_eq!((f[0].0.as_str(), f[1].0.as_str()), (ANCHOR, TABLES));
        assert_eq!(
            (&a[..5], a.len(), a[6], a[7]),
            (&b"_SM3_"[..], 0x18, 0x18, 3)
        );
        assert_eq!(a.iter().fold(0u8, |s, &b| s.wrapping_add(b)), 0);
        assert_eq!(
            u32::from_le_bytes(a[12..16].try_into().unwrap()) as usize,
            t.len()
        );
        let w = walk(t);
        let shape: Vec<_> = w.iter().map(|&(ty, len, _, _)| (ty, len)).collect();
        assert_eq!(
            shape,
            [
                (0, 0x18),
                (1, 0x1b),
                (3, 0x16),
                (4, 0x30),
                (16, 0x17),
                (17, 0x28),
                (19, 0x1f),
                (32, 0x0b),
                (127, 4)
            ]
        );
        assert_eq!(w[1].2, ["waarm64", "waarm64", "Virtual Machine"]);
        // The processor: 4 cores, multi-core; the memory: 2 GiB at RAM_BASE.
        let p = w[3].3;
        assert_eq!(&t[p + 0x23..p + 0x28], &[4, 4, 4, 0x0c, 0]);
        assert_eq!(w[5].2, ["DIMM 0", "waarm64"]);
        let d = w[5].3;
        assert_eq!(u16::from_le_bytes([t[d + 0xc], t[d + 0xd]]), 2048);
        let m = w[6].3;
        let kib = |o: usize| u32::from_le_bytes(t[m + o..m + o + 4].try_into().unwrap()) as u64;
        assert_eq!(
            (kib(4), kib(8)),
            (RAM_BASE >> 10, ((RAM_BASE + (2 << 30)) >> 10) - 1)
        );
    }

    #[test]
    fn spill_memories_add_the_credential_and_their_ranges() {
        let cfg = VmConfig {
            ram_size: 2 << 30,
            spill: [4 << 30, 0, 0, 0, 0, 0, 0, 0],
            ..VmConfig::default()
        };
        let t = &files(&cfg, &[])[1].1;
        let w = walk(t);
        let types: Vec<_> = w.iter().map(|x| x.0).collect();
        assert_eq!(types, [0, 1, 3, 4, 11, 16, 17, 19, 19, 32, 127]);
        assert_eq!(
            (w[4].1, &w[4].2[..]),
            (5, &[NUMA_CREDENTIAL.to_string()][..])
        );
        assert_eq!(t[w[4].3 + 4], 1); // one string
        let d = w[6].3;
        assert_eq!(u16::from_le_bytes([t[d + 0xc], t[d + 0xd]]), 6 << 10);
        // The spill memory at 4 GiB (past memory 0's end at 3 GiB, the next GiB boundary).
        let m = w[8].3;
        let kib = |o: usize| u32::from_le_bytes(t[m + o..m + o + 4].try_into().unwrap());
        assert_eq!((kib(4), kib(8)), (4 << 20, (8 << 20) - 1));
    }

    #[test]
    fn the_hosts_strings_go_into_type_11_not_fw_cfg() {
        let cfg = VmConfig {
            ram_size: 2 << 30,
            ..VmConfig::default()
        };
        let host = vec![
            ("opt/a".to_string(), vec![1]),
            (
                OEM_STRINGS.to_string(),
                b"io.systemd.credential:a=1\0\0b=2\0".to_vec(),
            ),
        ];
        let f = with(&cfg, host);
        let names: Vec<_> = f.iter().map(|x| x.0.as_str()).collect();
        assert_eq!(names, ["opt/a", ANCHOR, TABLES]);
        let w = walk(&f[2].1);
        assert_eq!(
            (w[4].0, &w[4].2[..]),
            (
                11,
                &["io.systemd.credential:a=1".to_string(), "b=2".to_string()][..]
            )
        );
        assert_eq!(f[2].1[w[4].3 + 4], 2);
        // With spill memories, the NUMA credential first.
        let cfg = VmConfig {
            spill: [1 << 30, 0, 0, 0, 0, 0, 0, 0],
            ..cfg
        };
        let f = with(&cfg, vec![(OEM_STRINGS.to_string(), b"b=2".to_vec())]);
        let w = walk(&f[1].1);
        assert_eq!(w[4].2, [NUMA_CREDENTIAL, "b=2"]);
    }

    #[test]
    fn large_memory_uses_the_extended_fields() {
        let cfg = VmConfig {
            ram_size: 64 << 30,
            ..VmConfig::default()
        };
        let t = &files(&cfg, &[])[1].1;
        let d = walk(t)[5].3;
        assert_eq!(u16::from_le_bytes([t[d + 0xc], t[d + 0xd]]), 0x7fff);
        assert_eq!(
            u32::from_le_bytes(t[d + 0x1c..d + 0x20].try_into().unwrap()),
            64 << 10
        );
    }
}
