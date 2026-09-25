//! Shared by the guest-image runners (boot.rs, kvm_unit_tests.rs): boot a
//! kernel on a whole VM and run it until it powers off, with the virtio
//! backends inline (web/devices.ts is the browser's side; the two must give
//! the guest the same bytes at the same steps in deterministic mode).
#![allow(dead_code)] // each runner uses part of it

use std::sync::atomic::Ordering;
use std::time::Instant;
use webpc_core::mem::{Access, Mem};
use webpc_core::virtio::{DeviceEntry, Request};
use webpc_core::vm::{RAM_BASE, SIGNAL_DEVICE, Vm, VmConfig, exit};

pub const RAM_SIZE: u64 = 256 << 20;
/// Where the runners put the kernel and initrd (web/vm.ts does the same).
const KERNEL: u64 = RAM_BASE + (2 << 20);
const INITRD: u64 = RAM_BASE + (128 << 20);

pub fn image(rel: &str) -> Vec<u8> {
    let path = format!("{}/../target/images/{rel}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read(&path).unwrap_or_else(|e| panic!("{path}: {e} (run images/build.sh)"))
}

/// The virtio devices a runner configures, in slot order (web/devices.ts
/// `DeviceSpec`). `Blk` is a read-only disk image.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Dev {
    Console,
    Rng,
    Blk(&'static [u8]),
}

/// What the test and benchmark guests expect, with target/images/linux's root
/// filesystem as /dev/vda (web/vm.ts `guestDevices`).
pub fn guest_devices() -> Vec<Dev> {
    let disk = image("linux/rootfs.ext4").leak();
    vec![Dev::Console, Dev::Rng, Dev::Blk(disk)]
}

/// Their kernel command line (web/vm.ts `GUEST_CMDLINE`).
pub const GUEST_CMDLINE: &str = "console=ttyAMA0 earlycon panic=-1 root=/dev/vda ro init=/init";

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
            Dev::Blk(disk) => {
                // SEG_MAX and RO; capacity in sectors, seg_max 126.
                let mut c = (disk.len() as u64 / 512).to_le_bytes().to_vec();
                c.extend([0; 4]);
                c.extend(126u32.to_le_bytes());
                e(2, 1 << 2 | 1 << 5, 1, 128, c)
            }
        }
    }
}

/// A virtio-blk request on a read-only `disk` (web/devices.ts `blk`): the
/// header from the readable bytes, data into the writable ones but the last,
/// which takes the status. Returns the bytes written.
fn blk(disk: &[u8], read: &[&mut [u8]], write: &mut [&mut [u8]]) -> u32 {
    let hdr: Vec<u8> = read
        .iter()
        .flat_map(|s| s.iter().copied())
        .take(16)
        .collect();
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
    let (status, n) = match (hdr.len() == 16).then(|| word(0)) {
        Some(0) => {
            let off = u64::from_le_bytes(hdr[8..16].try_into().unwrap()) as usize * 512;
            match disk.get(off..off + room) {
                Some(src) => {
                    fill(&mut data, src);
                    (0, room)
                }
                None => (1, 0),
            }
        }
        Some(8) => {
            let mut id = [0u8; 20];
            id[..9].copy_from_slice(b"webpc-blk");
            fill(&mut data, &id[..room.min(20)]);
            (0, room.min(20))
        }
        Some(1) => (1, 0), // OUT on a read-only disk
        _ => (2, 0),
    };
    *st = status;
    n as u32 + 1
}

/// The backends, as web/devices.ts has them: console TX to `hvc` (receive
/// buffers wait for input that never comes), rng from splitmix64 seeded 0
/// (in realtime mode too: std has no CSPRNG), blk from memory.
struct Backends {
    devs: Vec<Dev>,
    hvc: Vec<u8>,
    rng: (u64, u64, u32),
}

impl Backends {
    fn new(devs: &[Dev]) -> Backends {
        Backends {
            devs: devs.to_vec(),
            hvc: Vec::new(),
            rng: (0, 0, 0),
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

    /// Takes every device's events and requests (a DEVICE exit).
    fn poll(&mut self, vm: &Vm) {
        let sh = &vm.shared;
        for (i, d) in sh.devices.iter().enumerate() {
            d.events.swap(0, Ordering::AcqRel);
            // Nothing waits in these backends, so a reset only drops old records.
            let epoch = d.epoch.load(Ordering::Acquire) & 0xff;
            while let Some(Request {
                w0,
                queue,
                read,
                write,
            }) = d.req.pop_request()
            {
                if w0 >> 24 != epoch {
                    continue;
                }
                let seg = |(off, len): (u32, u32)| {
                    let p = vm
                        .mem
                        .host(RAM_BASE + off as u64, len as u64, Access::Write);
                    // SAFETY: the core checked the buffer is guest RAM; a
                    // guest may overlap buffers, but only bytes move through them.
                    unsafe { std::slice::from_raw_parts_mut(p.unwrap(), len as usize) }
                };
                let len = match (self.devs[i], queue) {
                    (Dev::Console, 0) => continue, // a receive buffer
                    (Dev::Console, _) => {
                        read.into_iter()
                            .for_each(|s| self.hvc.extend_from_slice(seg(s)));
                        0
                    }
                    (Dev::Rng, _) => write.into_iter().fold(0, |n, s| {
                        seg(s).iter_mut().for_each(|b| *b = self.rng_byte());
                        n + s.1
                    }),
                    (Dev::Blk(disk), _) => {
                        let r: Vec<_> = read.into_iter().map(seg).collect();
                        let mut w: Vec<_> = write.into_iter().map(seg).collect();
                        blk(disk, &r, &mut w)
                    }
                };
                assert!(d.cpl.push(&[w0, len]), "completion ring full");
                sh.signal.fetch_or(SIGNAL_DEVICE, Ordering::AcqRel);
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
    pub summary: String,
}

impl Run {
    pub fn powered_off(&self) -> bool {
        (self.kind, self.x0) == (exit::PSCI, 0x8400_0008)
    }
}

/// Boots `kernel` (and `initrd`) with `cmdline` and `devices`, and runs up to
/// `max_steps`, in deterministic mode unless `realtime`. With `echo`, the
/// console goes to stderr as it comes (seen with --nocapture).
pub fn boot(
    kernel: &[u8],
    initrd: Option<&[u8]>,
    cmdline: &str,
    devices: &[Dev],
    realtime: bool,
    max_steps: u64,
    echo: bool,
) -> Run {
    let mut ram = vec![0u128; RAM_SIZE as usize / 16];
    // SAFETY: ram is 16-byte aligned, RAM_SIZE bytes long, and outlives the Vm.
    let mem = unsafe { Mem::new(ram.as_mut_ptr() as *mut u8, RAM_SIZE) };
    let (entries, configs): (Vec<_>, Vec<_>) = devices.iter().map(|d| d.entry()).unzip();
    let cfg = VmConfig {
        deterministic: !realtime as u64,
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
    Run {
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
