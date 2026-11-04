//! The transport and split queues against hand-built rings, well formed and not.

use super::*;
use crate::vm::RAM_BASE;

const DESC: u64 = RAM_BASE + 0x1000;
const AVAIL: u64 = RAM_BASE + 0x2000;
const USED: u64 = RAM_BASE + 0x3000;
const BUF: u64 = RAM_BASE + 0x8000;
const QSIZE: u64 = 8;

struct T {
    _ram: Vec<u128>,
    mem: Mem,
    t: Transport,
    sh: Box<DevShared>,
}

fn entry() -> DeviceEntry {
    DeviceEntry {
        device_id: 4,
        features: 1 << 3 | 1 << 32, // a device bit, and a transport bit the host can't offer
        queues: 2,
        queue_size: QSIZE,
        config_len: 8,
        shm: 0,
    }
}

impl T {
    fn new() -> T {
        let mut ram = vec![0u128; (64 << 10) / 16];
        // SAFETY: ram is 16-byte aligned, 64 KiB, and lives as long as mem.
        let mem = unsafe { Mem::new(ram.as_mut_ptr() as *mut u8, 64 << 10) }.at(RAM_BASE);
        T {
            _ram: ram,
            mem,
            t: Transport::new(entry()),
            sh: Box::default(),
        }
    }

    fn mem(&self) -> &Mem {
        &self.mem
    }

    fn rd(&mut self, off: u64) -> u64 {
        self.t.read(off, 4, &self.sh).unwrap()
    }

    fn wr(&mut self, off: u64, v: u64) -> u32 {
        self.t.write(off, 4, v, &self.mem, &self.sh).unwrap()
    }

    /// The Linux driver's sequence up to DRIVER_OK (after its reset), with
    /// queue 0 at DESC/AVAIL/USED.
    fn up(&mut self, features: u64) {
        self.wr(0x070, 1 | 2);
        self.wr(0x024, 0);
        self.wr(0x020, features & 0xffff_ffff);
        self.wr(0x024, 1);
        self.wr(0x020, features >> 32);
        self.wr(0x070, 3 | FEATURES_OK as u64);
        assert_ne!(self.rd(0x070) as u32 & FEATURES_OK, 0);
        self.wr(0x030, 0);
        assert_eq!(self.rd(0x044), 0);
        self.wr(0x038, QSIZE);
        for (off, pa) in [(0x080, DESC), (0x090, AVAIL), (0x0a0, USED)] {
            self.wr(off, pa & 0xffff_ffff);
            self.wr(off + 4, pa >> 32);
        }
        self.wr(0x044, 1);
        assert_eq!(self.rd(0x044), 1);
        self.wr(0x070, 3 | (FEATURES_OK | DRIVER_OK) as u64);
        assert_eq!(self.status(), 1 | 2 | FEATURES_OK | DRIVER_OK);
    }

    fn status(&mut self) -> u32 {
        self.rd(0x070) as u32
    }

    fn desc(&self, table: u64, i: u64, addr: u64, len: u64, flags: u64, next: u64) {
        let m = self.mem();
        let d = table + 16 * i;
        m.write(d, 8, addr).unwrap();
        m.write(d + 8, 4, len).unwrap();
        m.write(d + 12, 2, flags).unwrap();
        m.write(d + 14, 2, next).unwrap();
    }

    /// Makes `heads` available on queue 0 and notifies.
    fn offer(&mut self, heads: &[u64]) -> u32 {
        let m = self.mem();
        let mut idx = m.read(AVAIL + 2, 2).unwrap();
        for &h in heads {
            m.write(AVAIL + 4 + 2 * (idx % QSIZE), 2, h).unwrap();
            idx = (idx + 1) & 0xffff;
        }
        m.write(AVAIL + 2, 2, idx).unwrap();
        self.wr(0x050, 0)
    }

    fn broken(&mut self) -> bool {
        self.status() & NEEDS_RESET != 0
    }

    fn complete(&mut self, w0: u32, len: u32) -> u32 {
        assert!(self.sh.cpl.push(&[w0, len]));
        self.t.complete(&self.mem, &self.sh)
    }

    fn used(&self, k: u64) -> (u64, u64, u64) {
        let m = self.mem();
        let e = USED + 4 + 8 * k;
        (
            m.read(USED + 2, 2).unwrap(),
            m.read(e, 4).unwrap(),
            m.read(e + 4, 4).unwrap(),
        )
    }
}

const OFF: u32 = 0x8000; // BUF as a RAM offset

#[test]
fn registers() {
    let mut t = T::new();
    assert_eq!(
        [0x000, 0x004, 0x008, 0x00c].map(|o| t.rd(o)),
        [0x7472_6976, 2, 4, VENDOR as u64]
    );
    assert_eq!(
        t.rd(0x010),
        1 << 3 | 1 << 28 | 1 << 29,
        "and INDIRECT_DESC, EVENT_IDX"
    );
    t.wr(0x014, 1);
    assert_eq!(t.rd(0x010), 1, "VERSION_1, not the host's transport bit");
    t.wr(0x014, 0);
    t.wr(0x014, 2);
    assert_eq!(t.rd(0x010), 0);
    assert_eq!(t.rd(0x034), QSIZE);
    t.wr(0x030, 2);
    assert_eq!(t.rd(0x034), 0, "no queue 2");
    assert_eq!(t.t.read(0x070, 2, &t.sh), None, "registers are 32-bit");
    assert_eq!(t.t.write(0x072, 4, 0, &t.mem, &t.sh), None);
    t.sh.config[1].store(0x12, Ordering::Relaxed);
    assert_eq!(t.t.read(0x100, 2, &t.sh), Some(0x1200));
    assert_eq!(t.t.write(0x104, 1, 7, &t.mem, &t.sh), Some(EV_CONFIG));
    assert_eq!(t.sh.config[4].load(Ordering::Relaxed), 7);
    assert_eq!(t.t.read(0x1fc, 8, &t.sh), None, "past the config space");
}

#[test]
fn feature_negotiation() {
    let mut t = T::new();
    t.wr(0x070, 1 | 2);
    t.wr(0x020, 1 << 3); // no VERSION_1: a legacy driver
    t.wr(0x070, 3 | FEATURES_OK as u64);
    assert_eq!(t.status(), 3, "FEATURES_OK refused");
    t.wr(0x024, 1);
    t.wr(0x020, 1 | 2); // VERSION_1 and bit 33, not offered
    t.wr(0x070, 3 | FEATURES_OK as u64);
    assert_eq!(t.status(), 3);
    t.wr(0x020, 1);
    t.wr(0x070, 3 | FEATURES_OK as u64);
    assert_eq!(t.status(), 1 | 2 | FEATURES_OK);
    let f = |k: usize| t.sh.features[k].load(Ordering::Relaxed);
    assert_eq!((f(0), f(1)), (1 << 3, 1));
}

#[test]
fn request_completion_and_interrupt() {
    let mut t = T::new();
    t.up(F_VERSION_1);
    // Head 3: 16 readable bytes, then 64 writable.
    t.desc(DESC, 3, BUF, 16, D_NEXT, 5);
    t.desc(DESC, 5, BUF + 0x100, 64, D_WRITE, 0);
    assert_eq!(t.offer(&[3]), EV_REQUEST);
    let r = t.sh.req.pop_request().unwrap();
    assert_eq!(
        r,
        Request {
            w0: 3,
            queue: 0,
            read: vec![(OFF, 16, 0)],
            write: vec![(OFF + 0x100, 64, 0)],
        }
    );
    assert!(t.sh.req.pop_request().is_none());
    assert_eq!(t.offer(&[]), 0, "nothing new");
    assert!(!t.t.irq());
    assert_eq!(t.complete(r.w0, 40), 0);
    assert_eq!(t.used(0), (1, 3, 40));
    assert!(t.t.irq());
    assert_eq!(t.rd(0x060), 1);
    t.wr(0x064, 1);
    assert!(!t.t.irq());
    // Stale or bogus completions are dropped: nothing in flight, bad head, bad queue.
    t.complete(3, 1);
    t.complete(0x0001_0000, 1);
    assert_eq!(t.used(0).0, 1);
    assert!(!t.t.irq());
}

#[test]
fn indirect_descriptors() {
    let mut t = T::new();
    t.up(F_VERSION_1 | F_INDIRECT_DESC);
    let table = BUF + 0x1000;
    t.desc(DESC, 0, table, 48, D_INDIRECT, 0);
    t.desc(table, 0, BUF, 1, D_NEXT, 2);
    t.desc(table, 2, BUF + 8, 2, D_NEXT | D_WRITE, 1);
    t.desc(table, 1, BUF + 16, 3, D_WRITE, 0);
    assert_eq!(t.offer(&[0]), EV_REQUEST);
    let r = t.sh.req.pop_request().unwrap();
    assert_eq!(
        (r.read, r.write),
        (vec![(OFF, 1, 0)], vec![(OFF + 8, 2, 0), (OFF + 16, 3, 0)])
    );
    assert!(!t.broken());
}

/// An indirect chain may be longer than the queue (Linux bounds only the ring slots it takes:
/// virtio-gpu posts a vmalloc'd command a page a segment), up to `MAX_CHAIN` buffers.
#[test]
fn an_indirect_chain_longer_than_the_queue() {
    let table = BUF + 0x1000;
    for (n, ok) in [(QSIZE + 1, true), (MAX_CHAIN, true), (MAX_CHAIN + 1, false)] {
        let mut t = T::new();
        t.up(F_VERSION_1 | F_INDIRECT_DESC);
        t.desc(DESC, 0, table, 16 * n, D_INDIRECT, 0);
        for i in 0..n {
            let next = if i + 1 < n { D_NEXT } else { 0 };
            t.desc(table, i, BUF, 4, next, i + 1);
        }
        t.offer(&[0]);
        assert_eq!(t.broken(), !ok, "{n} buffers");
        if ok {
            let r = t.sh.req.pop_request().unwrap();
            assert_eq!(
                (r.read.len(), r.write.len()),
                (n as usize, 0),
                "{n} buffers"
            );
        }
    }
}

#[test]
fn backlog_waits_for_room() {
    let mut t = T::new();
    t.up(F_VERSION_1);
    t.desc(DESC, 0, BUF, 4, 0, 0);
    t.desc(DESC, 1, BUF, 4, 0, 0);
    let fill = vec![0; RING_WORDS - 3];
    assert!(t.sh.req.push(&fill));
    assert_eq!(t.offer(&[0, 1]), 0, "no room for a 4-word record");
    for _ in 0..fill.len() {
        t.sh.req.pop::<1>();
    }
    assert_eq!(
        t.complete(0xff << 24, 0),
        EV_REQUEST,
        "retried after completions"
    );
    assert_eq!(t.sh.req.pop_request().unwrap().w0, 0);
    assert_eq!(t.sh.req.pop_request().unwrap().w0, 1);
}

#[test]
fn no_interrupt_flag() {
    let mut t = T::new();
    t.up(F_VERSION_1);
    t.mem().write(AVAIL, 2, AVAIL_NO_INTERRUPT).unwrap();
    t.desc(DESC, 0, BUF, 4, D_WRITE, 0);
    t.offer(&[0]);
    t.complete(0, 4);
    assert_eq!(t.used(0), (1, 0, 4));
    assert!(!t.t.irq());
}

#[test]
fn used_event_decides_the_interrupt() {
    let mut t = T::new();
    t.up(F_VERSION_1 | F_EVENT_IDX);
    let used_event = AVAIL + 4 + 2 * QSIZE;
    // The flag means nothing under EVENT_IDX.
    t.mem().write(AVAIL, 2, AVAIL_NO_INTERRUPT).unwrap();
    for h in 0..4 {
        t.desc(DESC, h, BUF + 16 * h, 4, D_WRITE, 0);
    }
    t.offer(&[0, 1, 2, 3]);
    t.complete(0, 4);
    assert!(t.t.irq(), "used_event 0: the first entry");
    t.wr(0x064, 1);
    t.complete(1, 4);
    assert!(!t.t.irq(), "used_event 0 is behind");
    t.mem().write(used_event, 2, 2).unwrap();
    // Two in one drain, the second at used_event.
    assert!(t.sh.cpl.push(&[2, 4]));
    t.complete(3, 4);
    assert_eq!(t.used(3), (4, 3, 4));
    assert!(t.t.irq(), "entry 2 written");
}

#[test]
fn used_event_wraps() {
    let mut t = T::new();
    t.up(F_VERSION_1 | F_EVENT_IDX);
    t.desc(DESC, 0, BUF, 4, D_WRITE, 0);
    let used_event = AVAIL + 4 + 2 * QSIZE;
    let mut irqs = 0;
    // Around the 16-bit index, with used_event two entries apart.
    for n in 0u32..0x10010 {
        if n % 2 == 0 {
            t.mem()
                .write(used_event, 2, (n + 1) as u64 & 0xffff)
                .unwrap();
        }
        t.offer(&[0]);
        t.sh.req.pop_request().unwrap();
        t.complete(0, 4);
        irqs += t.t.irq() as u32;
        t.wr(0x064, 1);
    }
    assert_eq!(irqs, 0x10010 / 2);
}

#[test]
fn avail_event_follows_the_device() {
    let mut t = T::new();
    t.up(F_VERSION_1 | F_EVENT_IDX);
    let avail_event = USED + 4 + 8 * QSIZE;
    t.desc(DESC, 0, BUF, 4, D_WRITE, 0);
    t.desc(DESC, 1, BUF + 16, 4, D_WRITE, 0);
    t.offer(&[0, 1]);
    assert_eq!(t.mem().read(avail_event, 2).unwrap(), 2);
    assert_eq!(t.sh.req.pop_request().unwrap().w0, 0);
    assert_eq!(t.sh.req.pop_request().unwrap().w0, 1);
    t.complete(0, 4);
    t.complete(1, 4);
    t.offer(&[0]);
    assert_eq!(t.mem().read(avail_event, 2).unwrap(), 3);
}

#[test]
fn without_event_idx_neither_event_is_used() {
    let mut t = T::new();
    t.up(F_VERSION_1);
    let (used_event, avail_event) = (AVAIL + 4 + 2 * QSIZE, USED + 4 + 8 * QSIZE);
    t.mem().write(used_event, 2, 5).unwrap();
    t.desc(DESC, 0, BUF, 4, D_WRITE, 0);
    t.offer(&[0]);
    assert_eq!(t.mem().read(avail_event, 2).unwrap(), 0);
    t.complete(0, 4);
    assert!(t.t.irq());
}

#[test]
fn reset_drops_old_completions() {
    let mut t = T::new();
    t.up(F_VERSION_1);
    t.desc(DESC, 0, BUF, 4, D_WRITE, 0);
    t.offer(&[0]);
    let old = t.sh.req.pop_request().unwrap().w0;
    assert!(t.sh.cpl.push(&[old, 4]));
    assert_eq!(t.wr(0x070, 0), EV_STATUS);
    assert_eq!((t.status(), t.sh.epoch.load(Ordering::Relaxed)), (0, 1));
    assert_eq!(t.rd(0x044), 0, "queues reset");
    t.up(F_VERSION_1);
    t.mem().write(AVAIL + 2, 2, 0).unwrap();
    t.offer(&[0]);
    let new = t.sh.req.pop_request().unwrap().w0;
    assert_eq!(new, 1 << 24);
    t.complete(old, 4);
    assert_eq!(t.used(0).0, 0, "completion from before the reset");
    t.complete(new, 4);
    assert_eq!(t.used(0), (1, 0, 4));
}

#[test]
fn a_queue_turned_off_drops_its_chains_in_flight() {
    // Linux's virtio-input freezes for a suspend by turning its queues off, without a reset.
    let mut t = T::new();
    t.up(F_VERSION_1);
    t.desc(DESC, 0, BUF, 4, D_WRITE, 0);
    t.offer(&[0]);
    let w0 = t.sh.req.pop_request().unwrap().w0;
    t.wr(0x030, 0);
    t.wr(0x044, 0);
    t.complete(w0, 4);
    assert_eq!(t.used(0).0, 0, "no completion into the queue's rings");
    // And the device saves and restores (a snapshot of a suspended guest).
    assert!(t.t.quiet(&t.sh));
    let (res, _, _) = restored(&t, &saved(&t));
    assert_eq!(res, Ok(()));
}

/// Each malformed ring puts the device in NEEDS_RESET with a config interrupt.
#[test]
fn malformed_rings_need_reset() {
    type Setup = fn(&mut T) -> Vec<u64>;
    let cases: &[(&str, Setup)] = &[
        ("loop", |t| {
            t.desc(DESC, 0, BUF, 4, D_NEXT, 1);
            t.desc(DESC, 1, BUF, 4, D_NEXT, 0);
            vec![0]
        }),
        ("next past the table", |t| {
            t.desc(DESC, 0, BUF, 4, D_NEXT, QSIZE);
            vec![0]
        }),
        ("head past the table", |_| vec![QSIZE]),
        ("buffer outside RAM", |t| {
            t.desc(DESC, 0, RAM_BASE + (64 << 10) - 2, 4, 0, 0);
            vec![0]
        }),
        ("buffer below RAM", |t| {
            t.desc(DESC, 0, 0x0900_0000, 4, 0, 0);
            vec![0]
        }),
        ("readable after writable", |t| {
            t.desc(DESC, 0, BUF, 4, D_WRITE | D_NEXT, 1);
            t.desc(DESC, 1, BUF, 4, 0, 0);
            vec![0]
        }),
        ("indirect not negotiated", |t| {
            t.desc(DESC, 0, BUF + 0x1000, 16, D_INDIRECT, 0);
            vec![0]
        }),
        ("more chains than slots", |t| {
            t.desc(DESC, 0, BUF, 4, 0, 0);
            vec![0; QSIZE as usize + 1]
        }),
    ];
    for (name, setup) in cases {
        let mut t = T::new();
        t.up(F_VERSION_1);
        let heads = setup(&mut t);
        assert_eq!(t.offer(&heads), EV_STATUS, "{name}");
        assert!(t.broken(), "{name}");
        assert_eq!(t.rd(0x060), 2, "{name}: config change interrupt");
        assert_eq!(t.offer(&[]), 0, "{name}: stopped");
    }

    let indirect: &[(&str, Setup)] = &[
        ("nested indirect", |t| {
            t.desc(DESC, 0, BUF + 0x1000, 16, D_INDIRECT, 0);
            t.desc(BUF + 0x1000, 0, BUF + 0x1000, 16, D_INDIRECT, 0);
            vec![0]
        }),
        ("indirect with next", |t| {
            t.desc(DESC, 0, BUF + 0x1000, 16, D_INDIRECT | D_NEXT, 1);
            vec![0]
        }),
        ("indirect length", |t| {
            t.desc(DESC, 0, BUF + 0x1000, 20, D_INDIRECT, 0);
            vec![0]
        }),
        ("indirect loop", |t| {
            t.desc(DESC, 0, BUF + 0x1000, 32, D_INDIRECT, 0);
            t.desc(BUF + 0x1000, 0, BUF, 4, D_NEXT, 1);
            t.desc(BUF + 0x1000, 1, BUF, 4, D_NEXT, 0);
            vec![0]
        }),
        ("indirect table outside RAM", |t| {
            t.desc(DESC, 0, RAM_BASE + (64 << 10), 16, D_INDIRECT, 0);
            vec![0]
        }),
    ];
    for (name, setup) in indirect {
        let mut t = T::new();
        t.up(F_VERSION_1 | F_INDIRECT_DESC);
        let heads = setup(&mut t);
        t.offer(&heads);
        assert!(t.broken(), "{name}");
    }

    // An available index more than a queue ahead.
    let mut t = T::new();
    t.up(F_VERSION_1);
    t.mem().write(AVAIL + 2, 2, QSIZE + 1).unwrap();
    t.wr(0x050, 0);
    assert!(t.broken(), "avail index jump");

    // Queue addresses: misaligned, or the ring outside RAM.
    for (off, pa) in [
        (0x080, DESC + 8),
        (0x090, AVAIL + 1),
        (0x0a0, RAM_BASE + (64 << 10) - 8),
    ] {
        let mut t = T::new();
        t.wr(0x038, QSIZE);
        for (o, p) in [(0x080, DESC), (0x090, AVAIL), (0x0a0, USED)] {
            t.wr(o, if o == off { pa } else { p });
        }
        t.wr(0x044, 1);
        assert_eq!(t.rd(0x044), 0, "{off:#x}");
        assert!(t.broken());
    }
    // A queue size that isn't a power of 2, or is past QueueNumMax (0 is the device's maximum: below).
    for n in [3, 2 * QSIZE] {
        let mut t = T::new();
        t.wr(0x038, n);
        t.wr(0x044, 1);
        assert!(t.broken(), "size {n}");
    }
}

/// A QueueNum of 0 (written, or never written) leaves the queue at the device's maximum, as QEMU does:
/// EDK2's virtio-gpu driver writes 0 and expects the ring it laid out for QueueNumMax to work.
#[test]
fn queue_num_zero_is_the_maximum() {
    let mut t = T::new();
    t.wr(0x070, 1 | 2);
    t.wr(0x070, 3 | FEATURES_OK as u64);
    t.wr(0x030, 0);
    t.wr(0x038, 0);
    for (off, pa) in [(0x080, DESC), (0x090, AVAIL), (0x0a0, USED)] {
        t.wr(off, pa & 0xffff_ffff);
        t.wr(off + 4, pa >> 32);
    }
    t.wr(0x044, 1);
    assert_eq!(t.rd(0x044), 1);
    assert!(!t.broken());
    assert_eq!(t.t.queues[0].size, QSIZE);
}

/// A new transport of the same device on the same RAM, restored from `t`'s state.
fn restored(t: &T, state: &[u8]) -> (snapshot::Result<()>, Transport, Box<DevShared>) {
    let (mut n, sh) = (Transport::new(entry()), Box::<DevShared>::default());
    let mut r = Reader(state);
    let res = n.restore(&mut r, &t.mem, &sh).and_then(|()| r.end());
    (res, n, sh)
}

fn saved(t: &T) -> Vec<u8> {
    let mut w = Writer::default();
    t.t.save(&mut w, &t.sh);
    w.0
}

#[test]
fn a_restored_transport_posts_the_chains_in_flight_again() {
    let mut t = T::new();
    t.up(F_VERSION_1 | F_INDIRECT_DESC);
    t.wr(0x100, 0x55); // a config byte the driver wrote
    // Five chains: 6 is a receive buffer, 2 a two-buffer request, 4 indirect.
    t.desc(DESC, 6, BUF, 64, D_WRITE, 0);
    t.desc(DESC, 2, BUF + 0x100, 16, D_NEXT, 7);
    t.desc(DESC, 7, BUF + 0x200, 32, D_WRITE, 0);
    let table = BUF + 0x1000;
    t.desc(DESC, 4, table, 32, D_INDIRECT, 0);
    t.desc(table, 0, BUF + 0x300, 8, D_NEXT, 1);
    t.desc(table, 1, BUF + 0x400, 8, D_WRITE, 0);
    t.desc(DESC, 0, BUF + 0x500, 4, 0, 0);
    t.desc(DESC, 1, BUF + 0x600, 4, 0, 0);
    assert_eq!(t.offer(&[6, 2, 4, 0, 1]), EV_REQUEST);
    assert!(!t.t.quiet(&t.sh), "requests the backend hasn't taken");
    let posted: Vec<Request> = core::iter::from_fn(|| t.sh.req.pop_request()).collect();
    assert_eq!(posted.len(), 5);
    // The backend answers 2 and 1 (out of order) and holds 6, 4 and 0.
    t.complete(2, 5);
    t.complete(1, 0);
    assert_eq!((t.used(0), t.used(1)), ((2, 2, 5), (2, 1, 0)));
    assert!(t.t.quiet(&t.sh) && t.t.repostable(&t.mem));
    let state = saved(&t);

    let (res, n, sh) = restored(&t, &state);
    assert_eq!(res, Ok(()));
    assert_eq!(sh.events.swap(0, Ordering::Relaxed), EV_REQUEST);
    // The same records, in the order the chains were posted.
    let again: Vec<Request> = core::iter::from_fn(|| sh.req.pop_request()).collect();
    let held: Vec<&Request> = [0, 2, 3].iter().map(|&k| &posted[k]).collect();
    assert_eq!(again.iter().collect::<Vec<_>>(), held);
    // The registers, the shared block and the interrupt line are as they were:
    // it saves the same bytes...
    let mut w = Writer::default();
    n.save(&mut w, &sh);
    assert_eq!(w.0, state);
    (t.t, t.sh) = (n, sh);
    assert_eq!(t.status(), 1 | 2 | FEATURES_OK | DRIVER_OK);
    assert_eq!((t.rd(0x044), t.rd(0x060), t.rd(0x100) & 0xff), (1, 1, 0x55));
    assert!(t.t.irq());
    assert_eq!(t.sh.features[0].load(Ordering::Relaxed), 1 << 28);
    // ...and it runs on: a completion goes to the next used entry, a new
    // chain is posted once (the old ones aren't walked again).
    t.complete(4, 9);
    assert_eq!(t.used(2), (3, 4, 9));
    assert_eq!(t.offer(&[1]), EV_REQUEST);
    assert_eq!(t.sh.req.pop_request().unwrap().w0, 1);
    assert!(t.sh.req.pop_request().is_none());
    // What was never in flight, or completed before the save, doesn't complete.
    t.complete(2, 1);
    t.complete(5, 1);
    assert_eq!(t.used(0).0, 3);
    assert!(!t.broken());
}

#[test]
fn a_state_that_cannot_be_is_refused() {
    let mut t = T::new();
    t.up(F_VERSION_1);
    t.desc(DESC, 3, BUF, 16, D_WRITE, 0);
    t.desc(DESC, 5, BUF + 0x100, 16, D_WRITE, 0);
    t.offer(&[3, 5]);
    while t.sh.req.pop_request().is_some() {}
    let state = saved(&t);
    assert_eq!(restored(&t, &state).0, Ok(()));
    let corrupt = Err(snapshot::Error::Corrupt);
    // Every strict prefix is truncated.
    for n in 0..state.len() {
        assert_eq!(restored(&t, &state[..n]).0, corrupt, "{n} bytes");
    }
    // The layout: the registers (36 bytes: the driver's features at 8), then
    // per queue its size (8), ready (1), three addresses (24), last_avail and
    // used (4), the chains in flight (a count, 4, and their heads).
    const Q0: usize = 36;
    let with = |at: usize, bytes: &[u8]| {
        let mut s = state.clone();
        s[at..at + bytes.len()].copy_from_slice(bytes);
        restored(&t, &s).0
    };
    assert_eq!(
        with(Q0, &16u64.to_le_bytes()),
        corrupt,
        "a size past the device's"
    );
    assert_eq!(
        with(Q0, &3u64.to_le_bytes()),
        corrupt,
        "a size that is no power of 2"
    );
    assert_eq!(
        with(Q0 + 9, &0u64.to_le_bytes()),
        corrupt,
        "descriptors outside RAM"
    );
    assert_eq!(
        with(Q0 + 9, &(DESC + 4).to_le_bytes()),
        corrupt,
        "misaligned"
    );
    assert_eq!(
        with(Q0 + 8, &[0]),
        corrupt,
        "chains in flight on a queue that isn't ready"
    );
    assert_eq!(
        with(Q0 + 37, &9u32.to_le_bytes()),
        corrupt,
        "more chains than the queue holds"
    );
    assert_eq!(
        with(Q0 + 41, &7u16.to_le_bytes()),
        corrupt,
        "a head that is no chain's"
    );
    assert_eq!(
        with(8, &(1u64 << 40).to_le_bytes()),
        corrupt,
        "a feature never offered"
    );
    // A guest that scribbled over a buffer it gave away: the save refuses.
    t.desc(DESC, 5, 0x1000, 16, D_WRITE, 0);
    assert!(!t.t.repostable(&t.mem));
    assert_eq!(restored(&t, &state).0, corrupt);
}

#[test]
fn held_chains_past_a_request_ring_cannot_be_saved() {
    // A queue of 64 whose chains are indirect tables of 40 buffers: 82 words
    // a record, so 49 of them fit a request ring and 50 don't.
    const N: u64 = 64;
    let mut t = T::new();
    t.t = Transport::new(DeviceEntry {
        queues: 1,
        queue_size: N,
        ..entry()
    });
    t.wr(0x070, 1 | 2);
    t.wr(0x024, 1);
    t.wr(0x020, (F_VERSION_1 | F_INDIRECT_DESC) >> 32);
    t.wr(0x024, 0);
    t.wr(0x020, F_INDIRECT_DESC);
    t.wr(0x070, 3 | FEATURES_OK as u64);
    t.wr(0x038, N);
    for (off, pa) in [(0x080, DESC), (0x090, AVAIL), (0x0a0, USED)] {
        t.wr(off, pa);
    }
    t.wr(0x044, 1);
    t.wr(0x070, 3 | (FEATURES_OK | DRIVER_OK) as u64);
    assert_eq!(t.status(), 1 | 2 | FEATURES_OK | DRIVER_OK);
    let table = BUF + 0x1000;
    for k in 0..40 {
        let next = if k < 39 { D_NEXT } else { 0 };
        t.desc(table, k, BUF, 4, D_WRITE | next, k + 1);
    }
    // A chain is 2 + 40 · 3 words: 33 fit the request ring.
    for h in 0..34 {
        t.desc(DESC, h, table, 40 * 16, D_INDIRECT, 0);
        t.mem.write(AVAIL + 4 + 2 * h, 2, h).unwrap();
        t.mem.write(AVAIL + 2, 2, h + 1).unwrap();
        assert_eq!(t.wr(0x050, 0), EV_REQUEST);
        assert_eq!(t.sh.req.pop_request().unwrap().write.len(), 40);
        assert_eq!(t.t.repostable(&t.mem), h < 33, "{} chains held", h + 1);
    }
    assert!(t.t.quiet(&t.sh));
    // One fewer fits: a restore posts them all.
    t.complete(7, 0);
    assert!(t.t.repostable(&t.mem));
    let (mut n, sh) = (Transport::new(*t.t.entry()), Box::<DevShared>::default());
    assert_eq!(n.restore(&mut Reader(&saved(&t)), &t.mem, &sh), Ok(()));
    assert_eq!(core::iter::from_fn(|| sh.req.pop_request()).count(), 33);
}

#[test]
fn shared_layout() {
    use core::mem::offset_of;
    assert_eq!(offset_of!(DevShared, events), 0);
    assert_eq!(offset_of!(DevShared, status), 4);
    assert_eq!(offset_of!(DevShared, features), 8);
    assert_eq!(offset_of!(DevShared, epoch), 16);
    assert_eq!(offset_of!(DevShared, config_gen), 20);
    assert_eq!(offset_of!(DevShared, config), 24);
    assert_eq!(offset_of!(DevShared, req), 280);
    assert_eq!(offset_of!(DevShared, cpl), 280 + 8 + 4 * RING_WORDS);
    assert_eq!(size_of::<DeviceEntry>(), 48); // web/devices.ts ENTRY_WORDS
}

/// A host config change the way `web/devices.ts` does it: the bytes, then the signal's drain.
fn change(t: &mut T, at: usize, v: u8) {
    t.sh.update_config(|c| c[at].store(v, Ordering::Relaxed));
    t.t.complete(&t.mem, &t.sh);
}

#[test]
fn a_host_config_change_raises_the_config_interrupt() {
    let mut t = T::new();
    t.up(F_VERSION_1);
    assert_eq!(t.rd(0x060), 0);
    let gen0 = t.rd(0x0fc);
    change(&mut t, 4, 7);
    assert_eq!(t.rd(0x060), INT_CONFIG as u64);
    assert!(t.t.irq());
    assert_eq!(t.t.read(0x100 + 4, 1, &t.sh), Some(7));
    assert_eq!(t.rd(0x0fc), gen0 + 2);
    t.wr(0x064, INT_CONFIG as u64);
    assert!(!t.t.irq());
    // Nothing changed since: taking the signal again raises nothing.
    t.t.complete(&t.mem, &t.sh);
    assert!(!t.t.irq());
    // Each change raises it once.
    change(&mut t, 4, 8);
    change(&mut t, 4, 9);
    assert_eq!(t.rd(0x060), INT_CONFIG as u64);
    assert_eq!(t.rd(0x0fc), gen0 + 6);
}

#[test]
fn the_generation_never_agrees_with_itself_while_the_host_changes_the_config() {
    let mut t = T::new();
    t.up(F_VERSION_1);
    t.sh.config_gen.store(1, Ordering::SeqCst); // the host is between its two bumps
    let reads: Vec<u64> = (0..4).map(|_| t.rd(0x0fc)).collect();
    for (i, a) in reads.iter().enumerate() {
        assert!(reads[i + 1..].iter().all(|b| b != a), "{reads:?}");
    }
    // The interrupt waits for the end of the update.
    t.t.complete(&t.mem, &t.sh);
    assert_eq!(t.rd(0x060), 0);
    t.sh.config_gen.store(2, Ordering::SeqCst);
    assert_eq!((t.rd(0x0fc), t.rd(0x0fc)), (2, 2));
    t.t.complete(&t.mem, &t.sh);
    assert_eq!(t.rd(0x060), INT_CONFIG as u64);
}

#[test]
fn a_reset_does_not_raise_an_old_config_change_again() {
    let mut t = T::new();
    t.up(F_VERSION_1);
    change(&mut t, 0, 1);
    t.wr(0x064, INT_CONFIG as u64);
    t.wr(0x070, 0);
    t.t.complete(&t.mem, &t.sh);
    assert!(!t.t.irq());
    assert_eq!(t.rd(0x0fc), 2); // the generation is the host's, not the driver's
}

#[test]
fn a_device_with_a_config_change_not_yet_taken_is_not_quiet() {
    let mut t = T::new();
    t.up(F_VERSION_1);
    assert!(t.t.quiet(&t.sh));
    t.sh.update_config(|c| c[0].store(1, Ordering::Relaxed));
    assert!(!t.t.quiet(&t.sh));
    t.t.complete(&t.mem, &t.sh);
    assert!(t.t.quiet(&t.sh));
}

#[test]
fn the_window_is_shared_memory_region_1_and_survives_a_reset() {
    let mut t = T::new();
    let regs = |t: &mut T, sel: u64| {
        t.wr(0x0ac, sel);
        [0x0b0, 0x0b4, 0x0b8, 0x0bc].map(|o| t.rd(o) as u32)
    };
    // Without `shm` in the entry, every region is absent (all ones), window or not.
    t.t = Transport::new(entry()).with_window(Some((0x1_4000_0000, 256 << 20)));
    assert_eq!(regs(&mut t, 1), [u32::MAX; 4]);
    t.t = Transport::new(DeviceEntry { shm: 1, ..entry() })
        .with_window(Some((0x1_4000_0000, 256 << 20)));
    assert_eq!(regs(&mut t, 1), [256 << 20, 0, 0x4000_0000, 1]);
    // Region 0 (virtio-gpu's ID 1 is the host-visible one) and others are absent.
    assert_eq!(regs(&mut t, 0), [u32::MAX; 4]);
    assert_eq!(regs(&mut t, 2), [u32::MAX; 4]);
    t.wr(0x070, 0);
    assert_eq!(regs(&mut t, 1), [256 << 20, 0, 0x4000_0000, 1]);
    // An entry that asks for it on a VM without one has none.
    t.t = Transport::new(DeviceEntry { shm: 1, ..entry() }).with_window(None);
    assert_eq!(regs(&mut t, 1), [u32::MAX; 4]);
    assert!(!DeviceEntry { shm: 2, ..entry() }.valid());
}

#[test]
fn a_reset_clears_the_negotiated_features() {
    // `features()` is 0 before FEATURES_OK (web/devices.ts's net takes non-zero as a driver there).
    let mut t = T::new();
    t.up(F_VERSION_1 | F_EVENT_IDX);
    let f = |t: &T| [0, 1].map(|k| t.sh.features[k].load(Ordering::Relaxed));
    assert_eq!(f(&t), [F_EVENT_IDX as u32, 1]);
    t.wr(0x070, 0);
    assert_eq!(f(&t), [0, 0], "the old driver's features after a reset");
}

#[test]
fn a_backlog_behind_records_from_before_a_reset_waits_for_the_backends_signal() {
    // The request ring is full of a record the backend hasn't read when the driver resets; the
    // new driver's first chain doesn't fit behind it. The backend skips the stale record and
    // signals (no completion comes for it, docs/devices.md): the run loop's `complete` posts the
    // chain and writes avail_event, so the driver notifies its next buffer.
    let mut t = T::new();
    t.up(F_VERSION_1 | F_EVENT_IDX);
    t.desc(DESC, 0, BUF, 4, D_WRITE, 0);
    let fill = vec![0; RING_WORDS - 3];
    assert!(t.sh.req.push(&fill));
    t.wr(0x070, 0);
    for k in 0..4 {
        t.mem().write(AVAIL + 8 * k, 8, 0).unwrap();
        t.mem().write(USED + 8 * k, 8, 0).unwrap();
    }
    t.up(F_VERSION_1 | F_EVENT_IDX);
    assert_eq!(t.offer(&[0]), 0, "no room behind the stale record");
    let avail_event = USED + 4 + 8 * QSIZE;
    assert_eq!(t.mem().read(avail_event, 2).unwrap(), 0);
    for _ in 0..fill.len() {
        t.sh.req.pop::<1>();
    }
    assert_eq!(t.t.complete(&t.mem, &t.sh), EV_REQUEST);
    assert_eq!(t.sh.req.pop_request().unwrap().w0, 1 << 24);
    assert_eq!(t.mem().read(avail_event, 2).unwrap(), 1);
}

#[test]
fn the_selected_shared_memory_region_is_in_the_state() {
    let window = Some((0x1_4000_0000, 256 << 20));
    let e = DeviceEntry { shm: 1, ..entry() };
    let mut t = T::new();
    t.t = Transport::new(e).with_window(window);
    t.up(F_VERSION_1);
    t.wr(0x0ac, SHM_ID_WINDOW as u64);
    let state = saved(&t);
    let mut n = Transport::new(e).with_window(window);
    let sh = Box::<DevShared>::default();
    let mut r = Reader(&state);
    assert_eq!(
        n.restore(&mut r, &t.mem, &sh).and_then(|()| r.end()),
        Ok(())
    );
    (t.t, t.sh) = (n, sh);
    assert_eq!(
        t.rd(0x0b0) as u32,
        256 << 20,
        "SHMLen of the region selected before the save"
    );
}
