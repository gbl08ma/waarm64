//! virtio-mmio v2 transports and split virtqueues (virtio 1.2 §4.2 and §2.7),
//! written from the specification, with the Linux `virtio_mmio` driver as the
//! behavior it must satisfy. The device protocols (console, block, …) live in
//! host backends (PLAN.md §2 "Device backends (ABI 6)"):
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
//! `w1` = readable count | writable count << 16, then (offset from the start of
//! RAM, length) per segment, readable ones first. Completion: `w0` as posted,
//! then the number of bytes written. `epoch` counts device resets (mod 256), so
//! records from before a reset are skipped by the backend and dropped here.

use core::sync::atomic::{AtomicU8, AtomicU32, Ordering};

use crate::mem::{Access, Mem};
use crate::vm::RAM_BASE;

/// QEMU `virt`'s window: 32 transports of 0x200 bytes, SPIs 16–47.
pub const MMIO_BASE: u64 = 0x0a00_0000;
pub const MMIO_STRIDE: u64 = 0x200;
pub const MAX_DEVICES: usize = 32;
pub const IRQ_BASE: usize = 48;

pub const CONFIG_SIZE: usize = 256;
pub const RING_WORDS: usize = 4096;
pub const MAX_QUEUES: usize = 8;
pub const MAX_QUEUE_SIZE: u64 = 1024;

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
    /// Device feature bits offered; the transport adds VERSION_1 and INDIRECT_DESC.
    pub features: u64,
    pub queues: u64,
    /// QueueNumMax, a power of 2.
    pub queue_size: u64,
    /// Config-space bytes; the host writes them into `DevShared::config` after `vm_new`.
    pub config_len: u64,
}

impl DeviceEntry {
    pub fn valid(&self) -> bool {
        (1..=0xffff).contains(&self.device_id)
            && (1..=MAX_QUEUES as u64).contains(&self.queues)
            && self.queue_size.is_power_of_two()
            && self.queue_size <= MAX_QUEUE_SIZE
            && self.config_len <= CONFIG_SIZE as u64
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
    /// (RAM offset, length)
    pub read: Vec<(u32, u32)>,
    pub write: Vec<(u32, u32)>,
}

impl WordRing {
    /// Consumer: the next request record (the core posts whole records).
    pub fn pop_request(&self) -> Option<Request> {
        let [w0, n] = self.pop::<2>()?;
        let seg = |k| (0..k).map(|_| self.pop::<2>().unwrap().into()).collect();
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
/// status 4, negotiated features 8 (low word, high word), epoch 16, config 24,
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
    _pad: AtomicU32,
    pub config: [AtomicU8; CONFIG_SIZE],
    pub req: WordRing,
    pub cpl: WordRing,
}

impl Default for DevShared {
    fn default() -> Self {
        let z = || AtomicU32::new(0);
        DevShared {
            events: z(),
            status: z(),
            features: [z(), z()],
            epoch: z(),
            _pad: z(),
            config: [const { AtomicU8::new(0) }; CONFIG_SIZE],
            req: WordRing::default(),
            cpl: WordRing::default(),
        }
    }
}

#[derive(Clone, Copy, Default)]
struct Queue {
    size: u64,
    ready: bool,
    desc: u64,
    driver: u64,
    device: u64,
    last_avail: u16,
    used: u16,
    /// Chains posted and not completed.
    inflight: u64,
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
/// `size` descriptors at `desc`, appending each buffer as (RAM offset, length)
/// to `out`. Returns the readable and writable counts. Everything the guest
/// supplies is checked: the chain is at most `size` buffers (so loops end),
/// indices stay in their table, buffers lie in RAM, readable before writable,
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
            (table, n, i, nested) = (addr, len / 16, 0, true);
            continue;
        }
        count += 1;
        if count > size {
            return Err(Bad);
        }
        mem.host(addr, len, Access::Read)?;
        if flags & D_WRITE != 0 {
            nw += 1;
        } else if nw > 0 {
            return Err(Bad);
        } else {
            nr += 1;
        }
        out.extend([(addr - RAM_BASE) as u32, len as u32]);
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
    /// A chain didn't fit the request ring; retried after completions.
    backlog: bool,
    scratch: Vec<u32>,
}

impl Transport {
    pub fn new(entry: DeviceEntry) -> Transport {
        Transport {
            entry,
            dev_features_sel: 0,
            drv_features_sel: 0,
            driver_features: 0,
            queue_sel: 0,
            queues: [Queue::default(); MAX_QUEUES],
            isr: 0,
            status: 0,
            epoch: 0,
            backlog: false,
            scratch: Vec::new(),
        }
    }

    /// The interrupt line (level): high while InterruptStatus is non-zero.
    pub fn irq(&self) -> bool {
        self.isr != 0
    }

    fn offered(&self) -> u64 {
        self.entry.features & !F_TRANSPORT | F_VERSION_1 | F_INDIRECT_DESC
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
        let q = self.queue().copied();
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
            0x044 => q.is_some_and(|q| q.ready) as u32,
            0x060 => self.isr,
            0x070 => self.status,
            0x0b0..0x0c0 => u32::MAX, // SHMLen/SHMBase: no shared memory regions
            _ => 0, // write-only registers and ConfigGeneration (config never changes under the driver)
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
            0x038 => self.queue_reg(|q| q.size = v as u64),
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
            q.ready = false;
            return 0;
        }
        let n = q.size;
        let fits = |pa: u64, align: u64, len: u64| {
            pa.is_multiple_of(align) && mem.host(pa, len, Access::Read).is_ok()
        };
        if n.is_power_of_two()
            && n <= max
            && fits(q.desc, 16, 16 * n)
            && fits(q.driver, 2, 6 + 2 * n)
            && fits(q.device, 4, 6 + 8 * n)
        {
            (q.ready, q.last_avail, q.used, q.inflight) = (true, 0, 0, 0);
            0
        } else {
            self.needs_reset(sh)
        }
    }

    fn set_status(&mut self, v: u32, mem: &Mem, sh: &DevShared) -> u32 {
        if v == 0 {
            // Reset: everything but the configuration; completions still in
            // the ring (and any posted later for older requests) are dropped.
            let (entry, epoch, scratch) = (
                self.entry,
                self.epoch + 1,
                core::mem::take(&mut self.scratch),
            );
            *self = Transport {
                epoch,
                scratch,
                ..Transport::new(entry)
            };
            sh.epoch.store(epoch, Ordering::Release);
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
        let w_epoch = (self.epoch & 0xff) << 24 | (i as u32) << 16;
        let q = &mut self.queues[i];
        let avail = mem.read(q.driver + 2, 2)? as u16;
        if avail.wrapping_sub(q.last_avail) as u64 > q.size {
            return Err(Bad);
        }
        let mut posted = false;
        while q.last_avail != avail {
            if q.inflight == q.size {
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
                self.backlog = true;
                break;
            }
            q.last_avail = q.last_avail.wrapping_add(1);
            q.inflight += 1;
            posted = true;
        }
        Ok(posted)
    }

    /// Moves the backend's completions into the used rings, raising
    /// InterruptStatus unless the driver suppressed it, then retries chains
    /// that didn't fit the request ring. Returns events for the host.
    pub fn complete(&mut self, mem: &Mem, sh: &DevShared) -> u32 {
        while let Some([w0, len]) = sh.cpl.pop::<2>() {
            let (head, i) = ((w0 & 0xffff) as u64, (w0 >> 16 & 0xff) as usize);
            if w0 >> 24 != self.epoch & 0xff
                || self.status & NEEDS_RESET != 0
                || i >= self.entry.queues as usize
            {
                continue;
            }
            let q = &mut self.queues[i];
            if !q.ready || head >= q.size || q.inflight == 0 {
                continue;
            }
            // In RAM: checked when the queue became ready.
            let e = q.device + 4 + 8 * (q.used as u64 % q.size);
            q.used = q.used.wrapping_add(1);
            q.inflight -= 1;
            let ok = mem.write(e, 4, head).is_ok()
                && mem.write(e + 4, 4, len as u64).is_ok()
                && mem.write(q.device + 2, 2, q.used as u64).is_ok();
            let flags = mem.read(q.driver, 2).unwrap_or(0);
            if ok && flags & AVAIL_NO_INTERRUPT == 0 {
                self.isr |= INT_VRING;
            }
        }
        if !core::mem::take(&mut self.backlog) {
            return 0;
        }
        (0..self.entry.queues as usize).fold(0, |ev, i| ev | self.notify(i, mem, sh))
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
