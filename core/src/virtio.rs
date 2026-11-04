//! virtio-mmio v2 transports and split virtqueues (virtio 1.2 §4.2 and §2.7),
//! written from the specification, with the Linux `virtio_mmio` driver as the
//! behavior it must satisfy. The device protocols (console, block, …) live in
//! host backends (docs/devices.md):
//!
//! - On a queue notify the transport walks the new descriptor chains, checks
//!   that every buffer lies in RAM and posts each chain to the device's
//!   **request ring** as a flat segment list (RAM offsets, lengths).
//! - The backend writes the guest buffers directly and posts {queue, head,
//!   bytes written} to the **completion ring**, then sets `vm::SIGNAL_DEVICE`.
//!   The run loop drains completion rings into the used rings and raises
//!   InterruptStatus, which drives the transport's GIC line (level).
//! - Anything invalid the guest supplies (chain loops, buffers outside RAM,
//!   indices past the queue size, a readable buffer after a writable one) puts
//!   the device in DEVICE_NEEDS_RESET: it stops processing until reset. It never panics.
//!
//! Ring records are u32 words. Request: `w0` = head | queue << 16 | epoch << 24,
//! `w1` = readable count | writable count << 16, then (offset, length, memory)
//! per segment, readable ones first: the memory is 0 for memory 0's RAM (the
//! offset from its start) or a spill memory's index (the offset in it; ABI 40,
//! docs/spill-memories.md), and a buffer lies in one memory. Completion: `w0` as posted,
//! then the number of bytes written. `epoch` counts device resets (mod 256), so
//! records from before a reset are skipped by the backend and dropped here.
//! A backend that skipped any sets `vm::SIGNAL_DEVICE` as a completion does:
//! the room they took may be what a chain of the new driver waits for.

use core::sync::atomic::{AtomicU8, AtomicU32, Ordering, fence};
use std::collections::VecDeque;

use crate::mem::{Access, Mem};
use crate::snapshot::{self, Reader, Writer};

/// QEMU `virt`'s window: 32 transports of 0x200 bytes, SPIs 16–47.
pub const MMIO_BASE: u64 = 0x0a00_0000;
pub const MMIO_STRIDE: u64 = 0x200;
pub const MAX_DEVICES: usize = 32;
pub const IRQ_BASE: usize = 48;

pub const CONFIG_SIZE: usize = 256;
pub const RING_WORDS: usize = 4096;
pub const MAX_QUEUES: usize = 8;
pub const MAX_QUEUE_SIZE: u64 = 1024;
/// The most buffers a chain through an indirect table may have, whatever the queue's size (as
/// QEMU's `VIRTQUEUE_MAX_SIZE`). Linux bounds only the ring slots an indirect chain takes, not
/// its length: virtio-gpu posts a vmalloc'd command one page a segment, past a queue of 16.
pub const MAX_CHAIN: u64 = 1024;
// The longest request record (2 + 3 words a segment) fits the request ring.
const _: () = assert!(MAX_QUEUE_SIZE <= MAX_CHAIN && 2 + 3 * MAX_CHAIN as usize <= RING_WORDS);

/// `DevShared::events` bits (also bits 8+ of the `DEVICE` exit's value).
pub const EV_REQUEST: u32 = 1;
pub const EV_CONFIG: u32 = 2;
pub const EV_STATUS: u32 = 4;

// Device status (§2.1).
const DRIVER_OK: u32 = 4;
const FEATURES_OK: u32 = 8;
const NEEDS_RESET: u32 = 0x40;

// Feature bits: the transport's own, and the reserved range 24–40 hosts can't offer.
const F_INDIRECT_DESC: u64 = 1 << 28;
const F_EVENT_IDX: u64 = 1 << 29;
const F_VERSION_1: u64 = 1 << 32;
const F_TRANSPORT: u64 = ((1 << 41) - 1) & !((1 << 24) - 1);

// Descriptor and ring flags (§2.7.5, §2.7.6).
const D_NEXT: u64 = 1;
const D_WRITE: u64 = 2;
const D_INDIRECT: u64 = 4;
const AVAIL_NO_INTERRUPT: u64 = 1;

// InterruptStatus bits.
const INT_VRING: u32 = 1;
const INT_CONFIG: u32 = 2;

const MAGIC: u32 = 0x7472_6976; // "virt"
const VENDOR: u32 = 0x4350_4257; // "WBPC"

/// A device the host configures (`VmConfig.devices`): u64s so the host can
/// fill it with a `BigUint64Array`. Array index = transport slot.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct DeviceEntry {
    /// virtio device ID (§5): 3 console, 4 entropy, 2 block, …
    pub device_id: u64,
    /// Device feature bits offered; the transport adds VERSION_1, INDIRECT_DESC and EVENT_IDX.
    pub features: u64,
    pub queues: u64,
    /// QueueNumMax, a power of 2.
    pub queue_size: u64,
    /// Config-space bytes; the host writes them into `DevShared::config` after `vm_new`.
    pub config_len: u64,
    /// 1: the VM's host-visible window (`VmConfig.window`) is this transport's shared memory region
    /// 1 (virtio-gpu's `VIRTIO_GPU_SHM_ID_HOST_VISIBLE`); 0: no regions (ABI 53).
    pub shm: u64,
}

impl DeviceEntry {
    pub fn valid(&self) -> bool {
        (1..=0xffff).contains(&self.device_id)
            && (1..=MAX_QUEUES as u64).contains(&self.queues)
            && self.queue_size.is_power_of_two()
            && self.queue_size <= MAX_QUEUE_SIZE
            && self.config_len <= CONFIG_SIZE as u64
            && self.shm <= 1
            // Every buffer in flight fits the completion ring, so a backend never waits for room.
            && self.queues * self.queue_size * 2 <= RING_WORDS as u64
    }
}

/// A single-producer single-consumer ring of u32 words; `head` and `tail`
/// count words written and read (wrapping). Layout: head 0, tail 4, buf 8.
#[repr(C)]
pub struct WordRing {
    pub head: AtomicU32,
    pub tail: AtomicU32,
    pub buf: [AtomicU32; RING_WORDS],
}

impl Default for WordRing {
    fn default() -> Self {
        WordRing {
            head: AtomicU32::new(0),
            tail: AtomicU32::new(0),
            buf: [const { AtomicU32::new(0) }; RING_WORDS],
        }
    }
}

impl WordRing {
    /// Producer: appends all of `w`, or nothing if it doesn't fit.
    pub fn push(&self, w: &[u32]) -> bool {
        let h = self.head.load(Ordering::Relaxed);
        let used = h.wrapping_sub(self.tail.load(Ordering::Acquire)) as usize;
        if RING_WORDS - used < w.len() {
            return false;
        }
        for (k, &v) in w.iter().enumerate() {
            self.buf[h.wrapping_add(k as u32) as usize % RING_WORDS].store(v, Ordering::Relaxed);
        }
        self.head
            .store(h.wrapping_add(w.len() as u32), Ordering::Release);
        true
    }

    /// Consumer: the next `N` words, if a whole record of that size is there.
    pub fn pop<const N: usize>(&self) -> Option<[u32; N]> {
        let t = self.tail.load(Ordering::Relaxed);
        if (self.head.load(Ordering::Acquire).wrapping_sub(t) as usize) < N {
            return None;
        }
        let w = core::array::from_fn(|k| {
            self.buf[t.wrapping_add(k as u32) as usize % RING_WORDS].load(Ordering::Relaxed)
        });
        self.tail.store(t.wrapping_add(N as u32), Ordering::Release);
        Some(w)
    }

    /// Consumer: drops everything posted so far.
    pub fn clear(&self) {
        self.tail
            .store(self.head.load(Ordering::Acquire), Ordering::Release);
    }
}

/// A request as the backend sees it (consumer side, for native backends and tests).
#[derive(Debug, PartialEq, Eq)]
pub struct Request {
    /// The record's first word, echoed in the completion.
    pub w0: u32,
    pub queue: u32,
    /// (offset, length, memory)
    pub read: Vec<(u32, u32, u32)>,
    pub write: Vec<(u32, u32, u32)>,
}

impl WordRing {
    /// Consumer: the next request record (the core posts whole records).
    pub fn pop_request(&self) -> Option<Request> {
        let [w0, n] = self.pop::<2>()?;
        let seg = |k| (0..k).map(|_| self.pop::<3>().unwrap().into()).collect();
        let read = seg(n & 0xffff);
        let write = seg(n >> 16);
        Some(Request {
            w0,
            queue: w0 >> 16 & 0xff,
            read,
            write,
        })
    }
}

/// Per-device state shared with the host (`vm_device`). `repr(C)`: events 0,
/// status 4, negotiated features 8 (low word, high word), epoch 16, config_gen 20, config 24,
/// request ring 280, completion ring 280 + 8 + 4·RING_WORDS.
#[repr(C)]
pub struct DevShared {
    /// `EV_*` bits the core sets and the host takes (swap with 0).
    pub events: AtomicU32,
    /// The device status register, for the host.
    pub status: AtomicU32,
    pub features: [AtomicU32; 2],
    /// Device resets so far; records carry its low 8 bits.
    pub epoch: AtomicU32,
    /// The host's config generation (ABI 31): odd while it changes the config space,
    /// even otherwise; see [`DevShared::update_config`].
    pub config_gen: AtomicU32,
    pub config: [AtomicU8; CONFIG_SIZE],
    pub req: WordRing,
    pub cpl: WordRing,
}

impl DevShared {
    /// The host's way to change the config space under a running driver
    /// (ABI 31): `write` runs between two bumps of `config_gen`, so a driver
    /// reading the generation around its config reads sees the change as one.
    /// The caller then sets `vm::SIGNAL_DEVICE`; the transport raises the
    /// config-change interrupt when it takes it.
    pub fn update_config(&self, write: impl FnOnce(&[AtomicU8; CONFIG_SIZE])) {
        self.config_gen.fetch_add(1, Ordering::SeqCst);
        write(&self.config);
        self.config_gen.fetch_add(1, Ordering::SeqCst);
    }
}

impl Default for DevShared {
    fn default() -> Self {
        let z = || AtomicU32::new(0);
        DevShared {
            events: z(),
            status: z(),
            features: [z(), z()],
            epoch: z(),
            config_gen: z(),
            config: [const { AtomicU8::new(0) }; CONFIG_SIZE],
            req: WordRing::default(),
            cpl: WordRing::default(),
        }
    }
}

#[derive(Clone, Default)]
struct Queue {
    size: u64,
    ready: bool,
    desc: u64,
    driver: u64,
    device: u64,
    last_avail: u16,
    used: u16,
    /// The heads of the chains posted and not completed, in the order they
    /// were posted: a backend may hold a chain for as long as it likes (a
    /// receive buffer), and a restored VM posts them again in this order
    /// ([`Transport::restore`]).
    inflight: VecDeque<u16>,
}

impl Queue {
    /// Whether its three areas lie in RAM, aligned, for a size the device allows.
    fn fits(&self, max: u64, mem: &Mem) -> bool {
        let n = self.size;
        let fits = |pa: u64, align: u64, len: u64| {
            pa.is_multiple_of(align) && mem.host(pa, len, Access::Read).is_ok()
        };
        n.is_power_of_two()
            && n <= max
            && fits(self.desc, 16, 16 * n)
            && fits(self.driver, 2, 6 + 2 * n)
            && fits(self.device, 4, 6 + 8 * n)
    }
}

/// A guest-supplied value that puts the device in NEEDS_RESET.
#[derive(Debug, PartialEq, Eq)]
pub struct Bad;

impl From<crate::mem::Fault> for Bad {
    fn from(_: crate::mem::Fault) -> Bad {
        Bad
    }
}

/// Walks the split-queue descriptor chain starting at `head` in the table of
/// `size` descriptors at `desc`, appending each buffer as (offset, length,
/// memory) to `out`. Returns the readable and writable counts. Everything the guest
/// supplies is checked: the chain is at most `size` buffers, or `MAX_CHAIN` once it is in an
/// indirect table (so loops end), indices stay in their table, buffers lie in RAM, readable before writable,
/// and indirect tables (if `indirect_ok`) are well formed and not nested.
pub fn walk_chain(
    mem: &Mem,
    desc: u64,
    size: u64,
    head: u64,
    indirect_ok: bool,
    out: &mut Vec<u32>,
) -> Result<(u32, u32), Bad> {
    let (mut table, mut n, mut i) = (desc, size, head);
    let (mut nr, mut nw, mut count, mut nested) = (0u32, 0u32, 0u64, false);
    let mut limit = size;
    loop {
        if i >= n {
            return Err(Bad);
        }
        let d = table + 16 * i;
        let (addr, len) = (mem.read(d, 8)?, mem.read(d + 8, 4)?);
        let (flags, next) = (mem.read(d + 12, 2)?, mem.read(d + 14, 2)?);
        if flags & D_INDIRECT != 0 {
            if !indirect_ok || nested || flags & D_NEXT != 0 || len == 0 || len % 16 != 0 {
                return Err(Bad);
            }
            (table, n, i, nested, limit) = (addr, len / 16, 0, true, MAX_CHAIN);
            continue;
        }
        count += 1;
        if count > limit {
            return Err(Bad);
        }
        let (m, off) = mem.ram_offset(addr, len).ok_or(Bad)?;
        if flags & D_WRITE != 0 {
            nw += 1;
        } else if nw > 0 {
            return Err(Bad);
        } else {
            nr += 1;
        }
        out.extend([off as u32, len as u32, m as u32]);
        if flags & D_NEXT == 0 {
            return Ok((nr, nw));
        }
        i = next;
    }
}

/// One virtio-mmio transport: its registers and queues. The device's shared
/// half is `DevShared`, passed in by the caller.
pub struct Transport {
    entry: DeviceEntry,
    dev_features_sel: u32,
    drv_features_sel: u32,
    driver_features: u64,
    queue_sel: u32,
    queues: [Queue; MAX_QUEUES],
    /// InterruptStatus.
    isr: u32,
    status: u32,
    epoch: u32,
    /// The `config_gen` an interrupt was last raised for (kept over resets).
    config_seen: u32,
    /// Makes `ConfigGeneration` differ at every read while the host changes the config.
    gen_skew: u32,
    /// A chain didn't fit the request ring; retried after completions.
    backlog: bool,
    scratch: Vec<u32>,
    /// Shared memory region 1 as (guest PA, length), when the entry asks for the window.
    shm: Option<(u64, u64)>,
    /// SHMSel.
    shm_sel: u32,
}

/// The shared memory region ID a transport with `DeviceEntry.shm` reports the window as.
pub const SHM_ID_WINDOW: u32 = 1;

impl Transport {
    pub fn new(entry: DeviceEntry) -> Transport {
        Transport {
            entry,
            dev_features_sel: 0,
            drv_features_sel: 0,
            driver_features: 0,
            queue_sel: 0,
            queues: core::array::from_fn(|_| Queue::default()),
            isr: 0,
            status: 0,
            epoch: 0,
            config_seen: 0,
            gen_skew: 0,
            backlog: false,
            scratch: Vec::new(),
            shm: None,
            shm_sel: 0,
        }
    }

    /// The transport with the VM's window (PA, length) as its region 1, if its entry asks for it.
    pub fn with_window(mut self, window: Option<(u64, u64)>) -> Transport {
        self.shm = window.filter(|_| self.entry.shm == 1);
        self
    }

    /// The device this is the transport of.
    pub fn entry(&self) -> &DeviceEntry {
        &self.entry
    }

    /// The interrupt line (level): high while InterruptStatus is non-zero.
    pub fn irq(&self) -> bool {
        self.isr != 0
    }

    fn offered(&self) -> u64 {
        self.entry.features & !F_TRANSPORT | F_VERSION_1 | F_INDIRECT_DESC | F_EVENT_IDX
    }

    fn queue(&mut self) -> Option<&mut Queue> {
        let n = self.entry.queues as usize;
        self.queues[..n].get_mut(self.queue_sel as usize)
    }

    /// Register read at `off` in the transport's window; `None` for an access
    /// size the register doesn't allow (external abort).
    pub fn read(&mut self, off: u64, size: u32, sh: &DevShared) -> Option<u64> {
        if off >= 0x100 {
            let c = (off - 0x100) as usize;
            if !matches!(size, 1 | 2 | 4 | 8) || c + size as usize > CONFIG_SIZE {
                return None;
            }
            let b = |k: usize| sh.config[c + k].load(Ordering::Relaxed) as u64;
            return Some((0..size as usize).fold(0, |v, k| v | b(k) << (8 * k)));
        }
        if size != 4 || off & 3 != 0 {
            return None;
        }
        let q = self.queue().map(|q| q.ready);
        Some(match off {
            0x000 => MAGIC,
            0x004 => 2,
            0x008 => self.entry.device_id as u32,
            0x00c => VENDOR,
            0x010 => match self.dev_features_sel {
                s @ (0 | 1) => (self.offered() >> (32 * s)) as u32,
                _ => 0,
            },
            0x034 => q.map_or(0, |_| self.entry.queue_size as u32),
            0x044 => q.is_some_and(|ready| ready) as u32,
            0x060 => self.isr,
            0x070 => self.status,
            // SHMLen and SHMBase (low, high) of the selected region; all ones: none.
            0x0b0..0x0c0 => match self.shm {
                Some((base, len)) if self.shm_sel == SHM_ID_WINDOW => {
                    let v = if off < 0x0b8 { len } else { base };
                    (v >> (8 * (off & 4))) as u32
                }
                _ => u32::MAX,
            },
            0x0fc => {
                let g = sh.config_gen.load(Ordering::SeqCst);
                if g & 1 == 0 {
                    g
                } else {
                    // The host is changing the config: no two reads agree, so the driver retries.
                    self.gen_skew = self.gen_skew.wrapping_add(1);
                    g ^ self.gen_skew << 1
                }
            }
            _ => 0, // write-only registers
        } as u64)
    }

    /// Register write; returns the `EV_*` events for the host (0: none), or
    /// `None` for a disallowed access size.
    pub fn write(&mut self, off: u64, size: u32, v: u64, mem: &Mem, sh: &DevShared) -> Option<u32> {
        if off >= 0x100 {
            let c = (off - 0x100) as usize;
            if !matches!(size, 1 | 2 | 4 | 8) || c + size as usize > CONFIG_SIZE {
                return None;
            }
            for k in 0..size as usize {
                sh.config[c + k].store((v >> (8 * k)) as u8, Ordering::Relaxed);
            }
            return Some(EV_CONFIG);
        }
        if size != 4 || off & 3 != 0 {
            return None;
        }
        let v = v as u32;
        let features_ok = self.status & FEATURES_OK != 0;
        let mut ev = 0;
        match off {
            0x014 => self.dev_features_sel = v,
            0x020 if !features_ok => {
                if let s @ (0 | 1) = self.drv_features_sel {
                    let at = 32 * s;
                    self.driver_features =
                        self.driver_features & !(0xffff_ffff << at) | (v as u64) << at;
                }
            }
            0x024 => self.drv_features_sel = v,
            0x030 => self.queue_sel = v,
            0x038 => self.queue_reg(|q| {
                if v != 0 {
                    q.size = v as u64
                }
            }),
            0x044 => ev = self.set_ready(v & 1 != 0, mem, sh),
            0x050 => ev = self.notify(v as usize, mem, sh),
            0x064 => self.isr &= !v,
            0x070 => ev = self.set_status(v, mem, sh),
            0x080 => self.queue_reg(|q| set_lo(&mut q.desc, v)),
            0x084 => self.queue_reg(|q| set_hi(&mut q.desc, v)),
            0x090 => self.queue_reg(|q| set_lo(&mut q.driver, v)),
            0x094 => self.queue_reg(|q| set_hi(&mut q.driver, v)),
            0x0a0 => self.queue_reg(|q| set_lo(&mut q.device, v)),
            0x0a4 => self.queue_reg(|q| set_hi(&mut q.device, v)),
            0x0ac => self.shm_sel = v,
            _ => {}
        }
        Some(ev)
    }

    /// A write to a register of the selected queue, which must not be live.
    fn queue_reg(&mut self, f: impl FnOnce(&mut Queue)) {
        if let Some(q) = self.queue()
            && !q.ready
        {
            f(q);
        }
    }

    fn set_ready(&mut self, on: bool, mem: &Mem, sh: &DevShared) -> u32 {
        let max = self.entry.queue_size;
        let Some(q) = self.queue() else { return 0 };
        if !on {
            // The driver takes the queue's buffers back (Linux's virtio-input freezes for a suspend so, without a
            // reset): a completion for one of them is dropped, as for any chain not in flight, and doesn't reach
            // the rings the driver may have freed.
            q.ready = false;
            q.inflight.clear();
            return 0;
        }
        // A QueueNum never written, or written 0 (EDK2's virtio-gpu driver does, and QEMU ignores it), is the
        // device's maximum.
        if q.size == 0 {
            q.size = max;
        }
        if q.fits(max, mem) {
            (q.ready, q.last_avail, q.used) = (true, 0, 0);
            q.inflight.clear();
            0
        } else {
            self.needs_reset(sh)
        }
    }

    fn set_status(&mut self, v: u32, mem: &Mem, sh: &DevShared) -> u32 {
        if v == 0 {
            // Reset: everything but the configuration; completions still in
            // the ring (and any posted later for older requests) are dropped,
            // and the negotiated features are 0 again until FEATURES_OK.
            let (entry, epoch, seen, scratch, shm) = (
                self.entry,
                self.epoch + 1,
                self.config_seen,
                core::mem::take(&mut self.scratch),
                self.shm,
            );
            *self = Transport {
                epoch,
                config_seen: seen,
                scratch,
                shm,
                ..Transport::new(entry)
            };
            sh.epoch.store(epoch, Ordering::Release);
            sh.features
                .iter()
                .for_each(|f| f.store(0, Ordering::Relaxed));
            sh.cpl.clear();
            sh.status.store(0, Ordering::Release);
            return EV_STATUS;
        }
        let mut v = v & 0xff & !NEEDS_RESET;
        if v & FEATURES_OK != 0 && self.status & FEATURES_OK == 0 {
            let f = self.driver_features;
            if f & !self.offered() != 0 || f & F_VERSION_1 == 0 {
                v &= !FEATURES_OK;
            } else {
                sh.features[0].store(f as u32, Ordering::Relaxed);
                sh.features[1].store((f >> 32) as u32, Ordering::Relaxed);
            }
        }
        let was_ok = self.status & DRIVER_OK != 0;
        self.status = v | self.status & NEEDS_RESET;
        sh.status.store(self.status, Ordering::Release);
        let mut ev = EV_STATUS;
        if !was_ok && v & DRIVER_OK != 0 {
            // Buffers the driver made available before DRIVER_OK.
            for i in 0..self.entry.queues as usize {
                ev |= self.notify(i, mem, sh);
            }
        }
        ev
    }

    fn needs_reset(&mut self, sh: &DevShared) -> u32 {
        self.status |= NEEDS_RESET;
        sh.status.store(self.status, Ordering::Release);
        if self.status & DRIVER_OK != 0 {
            self.isr |= INT_CONFIG;
        }
        EV_STATUS
    }

    /// Queue `i` has new available buffers: posts their chains to the request
    /// ring (as many as fit) and returns `EV_REQUEST` if it posted any.
    fn notify(&mut self, i: usize, mem: &Mem, sh: &DevShared) -> u32 {
        if self.status & (DRIVER_OK | NEEDS_RESET) != DRIVER_OK
            || i >= self.entry.queues as usize
            || !self.queues[i].ready
        {
            return 0;
        }
        match self.post(i, mem, sh) {
            Ok(true) => EV_REQUEST,
            Ok(false) => 0,
            Err(Bad) => self.needs_reset(sh),
        }
    }

    fn post(&mut self, i: usize, mem: &Mem, sh: &DevShared) -> Result<bool, Bad> {
        let indirect = self.driver_features & F_INDIRECT_DESC != 0;
        let event_idx = self.driver_features & F_EVENT_IDX != 0;
        let w_epoch = (self.epoch & 0xff) << 24 | (i as u32) << 16;
        let q = &mut self.queues[i];
        let mut avail = mem.read(q.driver + 2, 2)? as u16;
        let mut posted = false;
        loop {
            if avail.wrapping_sub(q.last_avail) as u64 > q.size {
                return Err(Bad);
            }
            while q.last_avail != avail {
                if q.inflight.len() as u64 == q.size {
                    return Err(Bad); // more chains than the queue holds
                }
                let slot = q.last_avail as u64 % q.size;
                let head = mem.read(q.driver + 4 + 2 * slot, 2)?;
                let out = &mut self.scratch;
                out.clear();
                out.extend([w_epoch | head as u32, 0]);
                let (nr, nw) = walk_chain(mem, q.desc, q.size, head, indirect, out)?;
                out[1] = nr | nw << 16;
                if !sh.req.push(out) {
                    // Retried at the next `complete`, which needs no notify: after a
                    // completion, or the backend's signal once it skipped records
                    // from before a reset (which complete nothing).
                    self.backlog = true;
                    return Ok(posted);
                }
                q.last_avail = q.last_avail.wrapping_add(1);
                q.inflight.push_back(head as u16);
                posted = true;
            }
            if !event_idx {
                return Ok(posted);
            }
            // avail_event (§2.7.10): the driver notifies when it makes the buffer at
            // `last_avail` available. Written, then the index read again: a buffer made
            // available in between came without a notify.
            mem.write(q.device + 4 + 8 * q.size, 2, q.last_avail as u64)?;
            fence(Ordering::SeqCst);
            avail = mem.read(q.driver + 2, 2)? as u16;
            if avail == q.last_avail {
                return Ok(posted);
            }
        }
    }

    /// Moves the backend's completions into the used rings, raising
    /// InterruptStatus unless the driver suppressed it (with the flag, or
    /// with `used_event` under EVENT_IDX), then retries chains
    /// that didn't fit the request ring. Returns events for the host.
    pub fn complete(&mut self, mem: &Mem, sh: &DevShared) -> u32 {
        let g = sh.config_gen.load(Ordering::SeqCst);
        if g & 1 == 0 && g != self.config_seen {
            self.config_seen = g;
            self.isr |= INT_CONFIG;
        }
        let event_idx = self.driver_features & F_EVENT_IDX != 0;
        let old: [u16; MAX_QUEUES] = core::array::from_fn(|i| self.queues[i].used);
        while let Some([w0, len]) = sh.cpl.pop::<2>() {
            let (head, i) = ((w0 & 0xffff) as u64, (w0 >> 16 & 0xff) as usize);
            if w0 >> 24 != self.epoch & 0xff
                || self.status & NEEDS_RESET != 0
                || i >= self.entry.queues as usize
            {
                continue;
            }
            let q = &mut self.queues[i];
            if !q.ready {
                continue;
            }
            // Only a chain that is in flight completes (the oldest first, as backends mostly answer).
            let Some(at) = q.inflight.iter().position(|&h| h as u64 == head) else {
                continue;
            };
            q.inflight.remove(at);
            // In RAM: checked when the queue became ready.
            let e = q.device + 4 + 8 * (q.used as u64 % q.size);
            q.used = q.used.wrapping_add(1);
            let ok = mem.write(e, 4, head).is_ok()
                && mem.write(e + 4, 4, len as u64).is_ok()
                && mem.write(q.device + 2, 2, q.used as u64).is_ok();
            if event_idx {
                continue;
            }
            let flags = mem.read(q.driver, 2).unwrap_or(0);
            if ok && flags & AVAIL_NO_INTERRUPT == 0 {
                self.isr |= INT_VRING;
            }
        }
        let moved = |(q, &old): (&Queue, &u16)| q.used != old;
        if event_idx && self.queues.iter().zip(&old).any(moved) {
            // used_event (§2.7.10): the driver wants an interrupt once the used index passes
            // it, so one is raised if this drain moved the index past it. The used index is
            // written before used_event is read, as the driver orders the reverse.
            fence(Ordering::SeqCst);
            for (q, &old) in self.queues.iter().zip(&old).filter(|&p| moved(p)) {
                let event = mem.read(q.driver + 4 + 2 * q.size, 2).unwrap_or(0) as u16;
                if q.used.wrapping_sub(event).wrapping_sub(1) < q.used.wrapping_sub(old) {
                    self.isr |= INT_VRING;
                }
            }
        }
        if !core::mem::take(&mut self.backlog) {
            return 0;
        }
        (0..self.entry.queues as usize).fold(0, |ev, i| ev | self.notify(i, mem, sh))
    }
}

impl Transport {
    /// Whether nothing waits for the host: no event to take, no request to
    /// read, no completion to drain, no chain waiting for room. A snapshot is
    /// taken in this state, so the rings and events aren't in it.
    pub fn quiet(&self, sh: &DevShared) -> bool {
        let empty = |r: &WordRing| r.head.load(Ordering::Acquire) == r.tail.load(Ordering::Acquire);
        sh.events.load(Ordering::Acquire) == 0
            && sh.config_gen.load(Ordering::SeqCst) == self.config_seen
            && empty(&sh.req)
            && empty(&sh.cpl)
            && !self.backlog
    }

    /// Whether a restore could post every in-flight chain again: each still
    /// walks (a guest must leave the buffers it made available alone) and
    /// together they fit an empty request ring. The chains of a quiet device
    /// are the ones its backend holds (receive and event buffers).
    pub fn repostable(&mut self, mem: &Mem) -> bool {
        let indirect = self.driver_features & F_INDIRECT_DESC != 0;
        let mut words = 0;
        for q in &self.queues[..self.entry.queues as usize] {
            for &head in &q.inflight {
                let out = &mut self.scratch;
                out.clear();
                if walk_chain(mem, q.desc, q.size, head as u64, indirect, out).is_err() {
                    return false;
                }
                words += 2 + out.len();
            }
        }
        words <= RING_WORDS
    }

    /// Saves the registers (SHMSel among them), the queues with their in-flight chains, and the
    /// shared block's status, features, epoch and config space.
    pub fn save(&self, w: &mut Writer, sh: &DevShared) {
        w.u32(self.dev_features_sel);
        w.u32(self.drv_features_sel);
        w.u64(self.driver_features);
        w.u32(self.queue_sel);
        w.u32(self.shm_sel);
        w.u32(self.isr);
        w.u32(self.status);
        w.u32(self.epoch);
        for q in &self.queues[..self.entry.queues as usize] {
            w.u64(q.size);
            w.bool(q.ready);
            w.u64(q.desc);
            w.u64(q.driver);
            w.u64(q.device);
            w.u16(q.last_avail);
            w.u16(q.used);
            w.u32(q.inflight.len() as u32);
            q.inflight.iter().for_each(|&h| w.u16(h));
        }
        w.u32(sh.features[0].load(Ordering::Relaxed));
        w.u32(sh.features[1].load(Ordering::Relaxed));
        let config: Vec<u8> = sh
            .config
            .iter()
            .map(|b| b.load(Ordering::Relaxed))
            .collect();
        w.raw(&config);
    }

    /// Restores what [`Transport::save`] wrote into a new transport of the
    /// same device, with guest RAM already restored: every in-flight chain is
    /// posted to the request ring again (`EV_REQUEST` in `sh.events`), in its
    /// queue's order, so the new backend holds the buffers the old one held.
    /// `Corrupt` for a queue outside RAM, a chain that doesn't walk, or
    /// chains that don't fit the ring at once (a save checks both:
    /// [`Transport::repostable`]).
    pub fn restore(&mut self, r: &mut Reader, mem: &Mem, sh: &DevShared) -> snapshot::Result<()> {
        const CORRUPT: snapshot::Error = snapshot::Error::Corrupt;
        self.dev_features_sel = r.u32()?;
        self.drv_features_sel = r.u32()?;
        self.driver_features = r.u64()?;
        self.queue_sel = r.u32()?;
        self.shm_sel = r.u32()?;
        self.isr = r.u32()? & (INT_VRING | INT_CONFIG);
        self.status = r.u32()? & 0xff;
        self.epoch = r.u32()?;
        self.config_seen = sh.config_gen.load(Ordering::SeqCst);
        if self.driver_features & !self.offered() != 0 {
            return Err(CORRUPT);
        }
        let max = self.entry.queue_size;
        for i in 0..self.entry.queues as usize {
            let mut q = Queue {
                size: r.u64()?,
                ready: r.bool()?,
                desc: r.u64()?,
                driver: r.u64()?,
                device: r.u64()?,
                last_avail: r.u16()?,
                used: r.u16()?,
                inflight: VecDeque::new(),
            };
            let n = r.count(MAX_QUEUE_SIZE as usize)?;
            for _ in 0..n {
                q.inflight.push_back(r.u16()?);
            }
            if q.ready && !q.fits(max, mem) || !q.ready && n > 0 || n as u64 > q.size {
                return Err(CORRUPT);
            }
            self.queues[i] = q;
        }
        sh.status.store(self.status, Ordering::Release);
        sh.epoch.store(self.epoch, Ordering::Release);
        sh.features[0].store(r.u32()?, Ordering::Relaxed);
        sh.features[1].store(r.u32()?, Ordering::Relaxed);
        for (c, &b) in sh.config.iter().zip(r.raw(CONFIG_SIZE)?) {
            c.store(b, Ordering::Relaxed);
        }
        // The chains the old backend held (or hadn't answered), for the new one.
        let indirect = self.driver_features & F_INDIRECT_DESC != 0;
        let mut posted = false;
        for (i, q) in self.queues[..self.entry.queues as usize].iter().enumerate() {
            let w_epoch = (self.epoch & 0xff) << 24 | (i as u32) << 16;
            for &head in &q.inflight {
                let out = &mut self.scratch;
                out.clear();
                out.extend([w_epoch | head as u32, 0]);
                let (nr, nw) = walk_chain(mem, q.desc, q.size, head as u64, indirect, out)
                    .map_err(|Bad| CORRUPT)?;
                out[1] = nr | nw << 16;
                if !sh.req.push(out) {
                    return Err(CORRUPT);
                }
                posted = true;
            }
        }
        if posted {
            sh.events.fetch_or(EV_REQUEST, Ordering::AcqRel);
        }
        Ok(())
    }
}

fn set_lo(r: &mut u64, v: u32) {
    *r = *r & !0xffff_ffff | v as u64;
}

fn set_hi(r: &mut u64, v: u32) {
    *r = *r & 0xffff_ffff | (v as u64) << 32;
}

#[cfg(test)]
mod tests;
