//! Shared by the guest-image runners (boot.rs, kvm_unit_tests.rs): boot a
//! kernel on a whole VM and run it until it powers off, with the virtio
//! backends inline (web/devices.ts is the browser's side; the two must give
//! the guest the same bytes at the same steps in deterministic mode).
#![allow(dead_code)] // each runner uses part of it

pub mod p9;
pub mod qcow2;

use qcow2::Disk;
use std::cell::RefCell;
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::Ordering;
use std::time::Instant;
use webpc_core::mem::{Access, Mem};
use webpc_core::virtio::{DeviceEntry, EV_CONFIG, Request};
use webpc_core::vm::{RAM_BASE, SIGNAL_DEVICE, Vm, VmConfig, exit};

/// Where the runners put the kernel and initrd (web/vm.ts does the same).
const KERNEL: u64 = RAM_BASE + (2 << 20);
const INITRD: u64 = RAM_BASE + (128 << 20);

pub fn image(rel: &str) -> Vec<u8> {
    let path = format!("{}/../target/images/{rel}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read(&path).unwrap_or_else(|e| panic!("{path}: {e} (run images/build.sh)"))
}

/// A target/images disk image (raw or qcow2), open for the life of the process.
pub fn disk(rel: &str) -> &'static Disk {
    let d = Disk::open(image(rel).leak()).unwrap_or_else(|e| panic!("{rel}: {e}"));
    Box::leak(Box::new(d))
}

/// A copy-on-write overlay over a read-only disk, in memory, in 512-byte
/// sectors (web/overlay.ts keeps one on OPFS in 4 KiB blocks; the guest can't
/// tell). Held by reference, so it outlives a boot: the next boot sees the writes.
#[derive(Default)]
pub struct Overlay(RefCell<HashMap<u64, [u8; 512]>>);

impl Overlay {
    pub fn new() -> &'static Overlay {
        Box::leak(Box::default())
    }

    fn read(&self, disk: &Disk, off: u64, buf: &mut [u8]) -> bool {
        if !disk.read(off, buf) {
            return false;
        }
        let o = self.0.borrow();
        if !o.is_empty() {
            for s in off / 512..(off + buf.len() as u64).div_ceil(512) {
                if let Some(d) = o.get(&s) {
                    let (lo, hi) = (
                        (s * 512).max(off),
                        ((s + 1) * 512).min(off + buf.len() as u64),
                    );
                    buf[(lo - off) as usize..(hi - off) as usize]
                        .copy_from_slice(&d[(lo - s * 512) as usize..(hi - s * 512) as usize]);
                }
            }
        }
        true
    }

    fn write(&self, disk: &Disk, off: u64, data: &[u8]) -> bool {
        if off
            .checked_add(data.len() as u64)
            .is_none_or(|end| end > disk.size())
        {
            return false;
        }
        for s in off / 512..(off + data.len() as u64).div_ceil(512) {
            let mut sector = [0; 512];
            let n = (512).min(disk.size() - s * 512) as usize; // a partial last sector
            if !self.read(disk, s * 512, &mut sector[..n]) {
                return false;
            }
            let (lo, hi) = (
                (s * 512).max(off),
                ((s + 1) * 512).min(off + data.len() as u64),
            );
            sector[(lo - s * 512) as usize..(hi - s * 512) as usize]
                .copy_from_slice(&data[(lo - off) as usize..(hi - off) as usize]);
            self.0.borrow_mut().insert(s, sector);
        }
        true
    }
}

/// The virtio devices a runner configures, in slot order (web/devices.ts
/// `DeviceSpec`). `Blk` is a disk image, read-only or writable through an overlay.
#[derive(Clone, Copy)]
pub enum Dev {
    Console,
    Rng,
    Blk(&'static Disk, Option<&'static Overlay>),
    /// virtio-net with the loopback test adapter (web/net.ts `loopback`).
    Net,
    /// virtio-9p: the tag and the tree's initial files (web/9p.ts).
    P9(&'static str, &'static [(&'static str, &'static str)]),
    /// virtio-input: a keyboard (true) or a tablet. Setting a keyboard LED
    /// makes the runner inject `KEY_EVENTS` and `TABLET_EVENTS`, as the
    /// Chromium test page does (tests/browser/boot.html).
    Input(bool),
}

/// What the runners inject when the guest sets a keyboard LED: A pressed and
/// released; a click at (16384, 8192). [type, code, value].
pub const KEY_EVENTS: &[[u32; 3]] = &[[1, 30, 1], [0, 0, 0], [1, 30, 0], [0, 0, 0]];
pub const TABLET_EVENTS: &[[u32; 3]] = &[
    [3, 0, 16384],
    [3, 1, 8192],
    [1, 272, 1],
    [0, 0, 0],
    [1, 272, 0],
    [0, 0, 0],
];

/// What the test and benchmark guests expect, with `root` (a target/images
/// disk image) as /dev/vda, writable through `overlay` if given (web/vm.ts
/// `guestDevices`).
pub fn guest_devices(root: &str, overlay: Option<&'static Overlay>) -> Vec<Dev> {
    vec![Dev::Console, Dev::Rng, Dev::Blk(disk(root), overlay)]
}

/// The Buildroot guest's device test (`/test-devices.sh`, `/test-input.sh`):
/// its devices plus net, 9p with /hello.txt, a keyboard and a tablet (web/vm.ts `testDevices`).
pub fn test_devices(root: &str) -> Vec<Dev> {
    let mut d = guest_devices(root, None);
    d.extend([
        Dev::Net,
        Dev::P9("host", &[("hello.txt", "hello from the host\n")]),
        Dev::Input(true),
        Dev::Input(false),
    ]);
    d
}

/// Their kernel command line (web/vm.ts `GUEST_CMDLINE`).
pub const GUEST_CMDLINE: &str = "console=ttyAMA0 earlycon panic=-1 root=/dev/vda ro init=/init";

/// A distro image from images/build.sh: kernel, initrd and root disk (target/images
/// paths), and a command line that runs a test and powers off (web/vm.ts `DISTROS`).
pub struct Distro {
    pub kernel: &'static str,
    pub initrd: &'static str,
    pub disk: &'static str,
    pub cmdline: &'static str,
}

/// Alpine: OpenRC's local service runs images/alpine/webpc.start, which powers off.
pub const ALPINE: Distro = Distro {
    kernel: "alpine/Image",
    initrd: "alpine/initramfs-virt",
    disk: "alpine/rootfs.ext4",
    cmdline: "console=ttyAMA0 root=/dev/vda rootfstype=ext4 modules=ext4 ro",
};

/// Debian: the stock image; systemd runs the command from the kernel command
/// line as a unit once the system is up, then powers off (systemd-run-generator).
pub const DEBIAN: Distro = Distro {
    kernel: "debian/Image",
    initrd: "debian/initrd.img",
    disk: "debian/disk.qcow2",
    cmdline: "console=ttyAMA0 root=/dev/vda1 ro systemd.run=\"/bin/sh -c 'exec >/dev/console 2>&1; echo webpc: debian; cat /etc/debian_version; uname -r; findmnt -no OPTIONS /; echo webpc: test ok'\" systemd.run_success_action=poweroff systemd.run_failure_action=poweroff systemd.firstboot=off",
};

impl Dev {
    /// web/devices.ts `deviceEntry`: the entry and the initial config space.
    fn entry(self) -> (DeviceEntry, Vec<u8>) {
        let e = |device_id, features, queues, queue_size, config: Vec<u8>| {
            let config_len = config.len() as u64;
            let entry = DeviceEntry {
                device_id,
                features,
                queues,
                queue_size,
                config_len,
            };
            (entry, config)
        };
        match self {
            Dev::Console => e(3, 0, 2, 64, vec![0; 12]),
            Dev::Rng => e(4, 0, 1, 64, vec![]),
            Dev::Blk(disk, overlay) => {
                // SEG_MAX, and RO or (with an overlay) FLUSH; capacity in sectors, seg_max 126.
                let mut c = (disk.size() / 512).to_le_bytes().to_vec();
                c.extend([0; 4]);
                c.extend(126u32.to_le_bytes());
                let rw = if overlay.is_some() { 1 << 9 } else { 1 << 5 };
                e(2, 1 << 2 | rw, 1, 128, c)
            }
            // MAC and STATUS; the default MAC, LINK_UP.
            Dev::Net => e(
                1,
                1 << 5 | 1 << 16,
                2,
                256,
                vec![0x52, 0x54, 0, 0x12, 0x34, 0x56, 1, 0],
            ),
            Dev::P9(tag, _) => {
                let mut c = (tag.len() as u16).to_le_bytes().to_vec();
                c.extend(tag.as_bytes());
                e(9, 1, 1, 128, c)
            }
            Dev::Input(_) => e(18, 0, 2, 64, vec![0; 136]),
        }
    }
}

/// web/net.ts `loopback`: the reply to a frame, if it's an ARP or ICMP echo
/// request for 10.0.2.2 (at 52:55:0a:00:02:02).
pub fn loopback(f: &[u8]) -> Option<Vec<u8>> {
    const IP: [u8; 4] = [10, 0, 2, 2];
    const MAC: [u8; 6] = [0x52, 0x55, 0x0a, 0x00, 0x02, 0x02];
    let ty = u16::from_be_bytes([*f.get(12)?, *f.get(13)?]);
    if ty == 0x0806 && f.len() >= 42 && f[21] == 1 && f[38..42] == IP {
        let mut r = f[6..12].to_vec();
        r.extend(MAC);
        r.extend([0x08, 0x06, 0, 1, 0x08, 0, 6, 4, 0, 2]);
        r.extend(MAC);
        r.extend(IP);
        r.extend(&f[22..32]);
        return Some(r);
    }
    if ty != 0x0800 || f.len() < 34 {
        return None;
    }
    let icmp = 14 + (f[14] as usize & 0xf) * 4;
    if f[23] != 1 || f[30..34] != IP || f.len() < icmp + 8 || f[icmp] != 8 {
        return None;
    }
    let mut r = f[..(14 + u16::from_be_bytes([f[16], f[17]]) as usize).min(f.len())].to_vec();
    r[..6].copy_from_slice(&f[6..12]);
    r[6..12].copy_from_slice(&MAC);
    r[26..30].copy_from_slice(&f[30..34]);
    r[30..34].copy_from_slice(&f[26..30]);
    r[icmp] = 0;
    r[icmp + 2..icmp + 4].fill(0);
    let mut sum: u32 = r[icmp..]
        .chunks(2)
        .map(|c| (c[0] as u32) << 8 | *c.get(1).unwrap_or(&0) as u32)
        .sum();
    while sum > 0xffff {
        sum = (sum & 0xffff) + (sum >> 16);
    }
    r[icmp + 2..icmp + 4].copy_from_slice(&(!sum as u16).to_be_bytes());
    Some(r)
}

/// web/devices.ts `inputConfig`: the answer to a config query about a keyboard or a tablet.
fn input_config(kbd: bool, select: u8, subsel: u8) -> Vec<u8> {
    let bitmap = |bits: &[usize]| {
        let mut b = vec![0u8; bits.iter().max().unwrap() / 8 + 1];
        bits.iter().for_each(|&k| b[k / 8] |= 1 << (k % 8));
        b
    };
    match (select, subsel, kbd) {
        (1, _, _) => (if kbd {
            "webpc keyboard"
        } else {
            "webpc tablet"
        })
        .into(),
        (3, _, _) => [6u16, 0, if kbd { 1 } else { 2 }, 1]
            .iter()
            .flat_map(|v| v.to_le_bytes())
            .collect(),
        (0x11, 1, true) => bitmap(&(1..=248).collect::<Vec<_>>()),
        (0x11, 0x11, true) => bitmap(&[0, 1, 2]),
        (0x11, 0x14, true) => vec![0],
        (0x11, 1, false) => bitmap(&[0x110, 0x111, 0x112]),
        (0x11, 2, false) => bitmap(&[8]),
        (0x11, 3, false) => bitmap(&[0, 1]),
        (0x12, 0 | 1, false) => [0u32, 32767, 0, 0, 0]
            .iter()
            .flat_map(|v| v.to_le_bytes())
            .collect(),
        _ => vec![],
    }
}

/// A virtio-blk request on `disk`, writable through `overlay` (web/devices.ts
/// `blk`): the header (and OUT's data) from the readable bytes, IN's data into
/// the writable ones but the last, which takes the status. Returns the bytes written.
fn blk(disk: &Disk, overlay: Option<&Overlay>, read: &[&mut [u8]], write: &mut [&mut [u8]]) -> u32 {
    let readable: Vec<u8> = read.iter().flat_map(|s| s.iter().copied()).collect();
    let hdr = &readable[..readable.len().min(16)];
    let Some((status, data)) = write.split_last_mut() else {
        return 0;
    };
    let Some((st, last)) = status.split_last_mut() else {
        return 0;
    };
    let mut data: Vec<&mut [u8]> = data.iter_mut().map(|s| &mut **s).chain([last]).collect();
    let room: usize = data.iter().map(|s| s.len()).sum();
    let word = |k: usize| u32::from_le_bytes(hdr[k..k + 4].try_into().unwrap());
    let fill = |data: &mut [&mut [u8]], mut src: &[u8]| {
        for s in data.iter_mut() {
            let n = s.len().min(src.len());
            s[..n].copy_from_slice(&src[..n]);
            src = &src[n..];
        }
    };
    let off = || u64::from_le_bytes(hdr[8..16].try_into().unwrap()).wrapping_mul(512);
    let (status, n) = match (hdr.len() == 16).then(|| word(0)) {
        Some(0) => {
            let mut src = vec![0; room];
            let ok = match overlay {
                Some(o) => o.read(disk, off(), &mut src),
                None => disk.read(off(), &mut src),
            };
            if ok {
                fill(&mut data, &src);
                (0, room)
            } else {
                (1, 0)
            }
        }
        Some(8) => {
            let mut id = [0u8; 20];
            id[..9].copy_from_slice(b"webpc-blk");
            fill(&mut data, &id[..room.min(20)]);
            (0, room.min(20))
        }
        // OUT: IOERR on a read-only disk.
        Some(1) => match overlay {
            Some(o) if o.write(disk, off(), &readable[16..]) => (0, 0),
            _ => (1, 0),
        },
        Some(4) if overlay.is_some() => (0, 0), // FLUSH: nothing is volatile
        _ => (2, 0),
    };
    *st = status;
    n as u32 + 1
}

/// A request's buffer: guest RAM at (RAM offset, length).
fn seg(vm: &Vm, (off, len): (u32, u32)) -> &'static mut [u8] {
    let p = vm
        .mem
        .host(RAM_BASE + off as u64, len as u64, Access::Write)
        .unwrap();
    // SAFETY: the core checked the buffer is guest RAM, which outlives the
    // run; a guest may overlap buffers, but only bytes move through them.
    unsafe { std::slice::from_raw_parts_mut(p, len as usize) }
}

/// Writes `data` across the request's writable buffers, in order.
fn scatter(vm: &Vm, r: &Request, mut data: &[u8]) {
    for &s in &r.write {
        let b = seg(vm, s);
        let n = b.len().min(data.len());
        b[..n].copy_from_slice(&data[..n]);
        data = &data[n..];
    }
}

fn complete(vm: &Vm, i: usize, w0: u32, len: u32) {
    assert!(
        vm.shared.devices[i].cpl.push(&[w0, len]),
        "completion ring full"
    );
    vm.shared.signal.fetch_or(SIGNAL_DEVICE, Ordering::AcqRel);
}

/// Buffers a backend holds until it has something for them, and what waits for
/// buffers: frames for virtio-net, events for virtio-input (web/devices.ts `net`, `input`).
#[derive(Default)]
struct Held {
    bufs: VecDeque<Request>,
    items: VecDeque<Vec<u8>>,
}

impl Held {
    /// Queues `item`, dropping the oldest past `max`, and fills buffers.
    fn push(&mut self, vm: &Vm, i: usize, item: Vec<u8>, max: usize) {
        self.items.push_back(item);
        if self.items.len() > max {
            self.items.pop_front();
        }
        self.deliver(vm, i);
    }

    /// Items that don't fit the next buffer are dropped.
    fn deliver(&mut self, vm: &Vm, i: usize) {
        while let (Some(r), Some(item)) = (self.bufs.front(), self.items.front()) {
            let room: u32 = r.write.iter().map(|s| s.1).sum();
            if item.len() as u32 <= room {
                scatter(vm, r, item);
                complete(vm, i, r.w0, item.len() as u32);
                self.bufs.pop_front();
            }
            self.items.pop_front();
        }
    }
}

fn event([ty, code, value]: [u32; 3]) -> Vec<u8> {
    let mut e = (ty as u16).to_le_bytes().to_vec();
    e.extend((code as u16).to_le_bytes());
    e.extend(value.to_le_bytes());
    e
}

/// The backends, as web/devices.ts has them: console TX to `hvc` (receive
/// buffers wait for input that never comes), rng from splitmix64 seeded 0
/// (in realtime mode too: std has no CSPRNG), blk from memory, net to the
/// loopback adapter, 9p on an in-memory tree, input from the runner.
struct Backends {
    devs: Vec<Dev>,
    hvc: Vec<u8>,
    rng: (u64, u64, u32),
    held: Vec<Held>,
    p9: Vec<Option<p9::Server>>,
}

impl Backends {
    fn new(devs: &[Dev]) -> Backends {
        Backends {
            devs: devs.to_vec(),
            hvc: Vec::new(),
            rng: (0, 0, 0),
            held: devs.iter().map(|_| Held::default()).collect(),
            p9: devs
                .iter()
                .map(|d| match d {
                    Dev::P9(_, files) => Some(p9::Server::new(files)),
                    _ => None,
                })
                .collect(),
        }
    }

    fn rng_byte(&mut self) -> u8 {
        let (s, word, left) = &mut self.rng;
        if *left == 0 {
            *s = s.wrapping_add(0x9e37_79b9_7f4a_7c15);
            let mut z = *s;
            z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
            (*word, *left) = (z ^ (z >> 31), 8);
        }
        let b = *word as u8;
        (*word, *left) = (*word >> 8, *left - 1);
        b
    }

    /// The guest set a keyboard LED: inject the test events.
    fn led(&mut self, vm: &Vm) {
        for i in 0..self.devs.len() {
            if let Dev::Input(kbd) = self.devs[i] {
                let events = if kbd { KEY_EVENTS } else { TABLET_EVENTS };
                for &e in events {
                    self.held[i].push(vm, i, event(e), 1024);
                }
            }
        }
    }

    /// Takes every device's events and requests (a DEVICE exit).
    fn poll(&mut self, vm: &Vm) {
        let sh = &vm.shared;
        for (i, d) in sh.devices.iter().enumerate() {
            let events = d.events.swap(0, Ordering::AcqRel);
            if let Dev::Input(kbd) = self.devs[i]
                && events & EV_CONFIG != 0
            {
                let c = &d.config;
                let (sel, sub) = (c[0].load(Ordering::Relaxed), c[1].load(Ordering::Relaxed));
                let mut a = input_config(kbd, sel, sub);
                a.truncate(128);
                c[2].store(a.len() as u8, Ordering::Relaxed);
                for k in 0..128 {
                    c[8 + k].store(*a.get(k).unwrap_or(&0), Ordering::Relaxed);
                }
            }
            // A reset drops old records and whatever the backend held.
            let epoch = d.epoch.load(Ordering::Acquire) & 0xff;
            if self.held[i]
                .bufs
                .front()
                .is_some_and(|r| r.w0 >> 24 != epoch)
            {
                self.held[i] = Held::default();
            }
            while let Some(r) = d.req.pop_request() {
                if r.w0 >> 24 != epoch {
                    continue;
                }
                let readable =
                    || -> Vec<u8> { r.read.iter().flat_map(|&s| seg(vm, s).to_vec()).collect() };
                let len = match (self.devs[i], r.queue) {
                    (Dev::Console, 0) => continue, // a receive buffer
                    (Dev::Console, _) => {
                        self.hvc.extend(readable());
                        0
                    }
                    (Dev::Rng, _) => r.write.iter().fold(0, |n, &s| {
                        seg(vm, s).iter_mut().for_each(|b| *b = self.rng_byte());
                        n + s.1
                    }),
                    (Dev::Blk(disk, overlay), _) => {
                        let rd: Vec<_> = r.read.iter().map(|&s| seg(vm, s)).collect();
                        let mut w: Vec<_> = r.write.iter().map(|&s| seg(vm, s)).collect();
                        blk(disk, overlay, &rd, &mut w)
                    }
                    (Dev::Net | Dev::Input(_), 0) => {
                        self.held[i].bufs.push_back(r);
                        self.held[i].deliver(vm, i);
                        continue;
                    }
                    (Dev::Net, _) => {
                        // A frame for the adapter: the header stripped, guest bugs dropped.
                        let f = readable();
                        if f.len() > 12
                            && f.len() <= 12 + 1518
                            && let Some(reply) = loopback(&f[12..])
                        {
                            let mut b = vec![0; 12];
                            b[10] = 1; // num_buffers
                            b.extend(reply);
                            self.held[i].push(vm, i, b, 256);
                        }
                        0
                    }
                    (Dev::Input(_), _) => {
                        // A status event: an LED (type 0x11) set to 1 triggers the test's events.
                        let e = readable();
                        if e.len() >= 8 && e[..2] == [0x11, 0] && e[4..8] == [1, 0, 0, 0] {
                            complete(vm, i, r.w0, 0);
                            self.led(vm);
                            continue;
                        }
                        0
                    }
                    (Dev::P9(..), _) => {
                        let m = readable();
                        let room: usize = r.write.iter().map(|s| s.1 as usize).sum();
                        let size = m
                            .get(..4)
                            .map_or(0, |b| u32::from_le_bytes(b.try_into().unwrap()) as usize);
                        if !(7..=m.len()).contains(&size) || room < 11 {
                            0
                        } else {
                            let reply = self.p9[i].as_mut().unwrap().handle(&m[..size], room);
                            if reply.len() > room {
                                0
                            } else {
                                scatter(vm, &r, &reply);
                                reply.len() as u32
                            }
                        }
                    }
                };
                complete(vm, i, r.w0, len);
            }
        }
    }
}

pub struct Run {
    /// The exit kind that ended it, and ExitInfo.x0 (the PSCI function for a PSCI exit).
    pub kind: u32,
    pub x0: u64,
    /// Console output with the tty's \r\n turned back into \n.
    pub console: String,
    /// What the guest wrote to its virtio console, \r\n turned into \n too.
    pub hvc: String,
    /// The framebuffer's bytes at the end, if there was one.
    pub fb: Vec<u8>,
    /// Steps retired (instructions plus exceptions taken).
    pub steps: u64,
    pub summary: String,
}

impl Run {
    pub fn powered_off(&self) -> bool {
        (self.kind, self.x0) == (exit::PSCI, 0x8400_0008)
    }
}

/// What to boot: `kernel` (and `initrd`) with `cmdline` and `devices` on
/// `ram_size` bytes of RAM, run up to `max_steps`, in deterministic mode unless
/// `realtime`. With `echo`, the console goes to stderr as it comes (seen with
/// --nocapture).
pub struct Boot<'a> {
    pub kernel: &'a [u8],
    pub initrd: Option<&'a [u8]>,
    pub cmdline: &'a str,
    pub devices: &'a [Dev],
    pub ram_size: u64,
    pub realtime: bool,
    pub max_steps: u64,
    pub echo: bool,
    /// A framebuffer's width and height (0, 0: none).
    pub fb: (u64, u64),
    /// `VmConfig.features` (`cpu::FEATURE_*`; M6.5).
    pub features: u64,
    /// `VmConfig.gic`: 2, 3, or 0 for the default (M7).
    pub gic: u64,
}

impl<'a> Boot<'a> {
    /// 256 MiB, no initrd or devices, deterministic, 20 G steps, quiet.
    pub fn new(kernel: &'a [u8], cmdline: &'a str) -> Boot<'a> {
        Boot {
            kernel,
            initrd: None,
            cmdline,
            devices: &[],
            ram_size: 256 << 20,
            realtime: false,
            max_steps: 20_000_000_000,
            echo: false,
            fb: (0, 0),
            // The crypto extensions, as `bootVm` gives them (M6.5 loop 7).
            features: webpc_core::cpu::FEATURE_CRYPTO,
            gic: 0,
        }
    }
}

pub fn boot(b: &Boot) -> Run {
    let &Boot {
        kernel,
        initrd,
        cmdline,
        devices,
        ram_size,
        realtime,
        max_steps,
        echo,
        fb,
        features,
        gic,
    } = b;
    let mut ram = vec![0u128; ram_size as usize / 16];
    // SAFETY: ram is 16-byte aligned, ram_size bytes long, and outlives the Vm.
    let mem = unsafe { Mem::new(ram.as_mut_ptr() as *mut u8, ram_size) };
    let (entries, configs): (Vec<_>, Vec<_>) = devices.iter().map(|d| d.entry()).unzip();
    let cfg = VmConfig {
        ram_size,
        deterministic: !realtime as u64,
        fb_width: fb.0,
        fb_height: fb.1,
        features,
        gic,
        ..VmConfig::default()
    };
    let mut vm = Vm::with_devices(mem, cfg, &entries);
    for (d, c) in vm.shared.devices.iter().zip(&configs) {
        for (k, &b) in c.iter().enumerate() {
            d.config[k].store(b, Ordering::Relaxed);
        }
    }
    let mut backends = Backends::new(devices);
    let load = |vm: &Vm, pa: u64, b: &[u8]| {
        let p = vm.mem.host(pa, b.len() as u64, Access::Write).unwrap();
        // SAFETY: host() checked the range is guest RAM.
        unsafe { std::ptr::copy_nonoverlapping(b.as_ptr(), p, b.len()) };
    };
    load(&vm, KERNEL, kernel);
    if let Some(rd) = initrd {
        load(&vm, INITRD, rd);
    }
    vm.boot(KERNEL, initrd.map(|rd| (INITRD, rd.len() as u64)), cmdline)
        .unwrap();

    let t = Instant::now();
    let (mut out, mut steps) = (Vec::new(), 0);
    let kind = loop {
        // As web/vm.ts `run`: DEVICE exits are handled within one budget.
        let (budget, mut ran) = (100_000_000, 0);
        let kind = loop {
            let kind = vm.run(budget - ran);
            ran += vm.exit.retired;
            if kind == exit::IDLE && realtime {
                // Nothing completes asynchronously here: sleep to the deadline.
                let ns = vm.exit.value.min(10_000_000);
                std::thread::sleep(std::time::Duration::from_nanos(ns));
                continue;
            }
            if kind != exit::DEVICE {
                break kind;
            }
            backends.poll(&vm);
            if ran == budget {
                break exit::BUDGET;
            }
        };
        steps += ran;
        let start = out.len();
        while let Some(b) = vm.shared.console.tx.pop() {
            out.push(b);
        }
        if echo {
            eprint!("{}", String::from_utf8_lossy(&out[start..]));
        }
        match kind {
            exit::BUDGET | exit::TX_FULL if steps < max_steps => {}
            _ => break kind,
        }
    };
    let secs = t.elapsed().as_secs_f64();
    let fb = webpc_core::boot::framebuffer(&cfg).map_or(vec![], |(pa, len)| {
        let p = vm.mem.host(pa, len, Access::Read).unwrap();
        // SAFETY: host() checked the range is guest RAM.
        unsafe { std::slice::from_raw_parts(p, len as usize) }.to_vec()
    });
    Run {
        fb,
        steps,
        kind,
        x0: vm.exit.x[0],
        console: String::from_utf8_lossy(&out).replace("\r\n", "\n"),
        hvc: String::from_utf8_lossy(&backends.hvc).replace("\r\n", "\n"),
        summary: format!(
            "{steps} steps, guest time {:.2} s, {secs:.1} s wall, {:.0} MIPS; exit {kind} value {:#x} pc {:#x}",
            vm.now() as f64 / 62.5e6,
            steps as f64 / secs / 1e6,
            vm.exit.value,
            vm.vcpu.cpu.pc
        ),
    }
}

/// A guest's deterministic step count from `tests/steps.txt`, which every
/// runner (native, Node, Chromium; interpreter and JIT) checks against.
pub fn steps(name: &str) -> u64 {
    include_str!("../../../tests/steps.txt")
        .lines()
        .filter(|l| !l.starts_with('#'))
        .find_map(|l| l.strip_prefix(name)?.strip_prefix(' ')?.trim().parse().ok())
        .unwrap_or_else(|| panic!("no {name} in tests/steps.txt"))
}
