//! The transport and split queues against hand-built rings, well formed and not.

use super::*;

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
    assert_eq!(t.rd(0x010), 1 << 3 | 1 << 28, "and INDIRECT_DESC");
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
            read: vec![(OFF, 16)],
            write: vec![(OFF + 0x100, 64)],
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
        (vec![(OFF, 1)], vec![(OFF + 8, 2), (OFF + 16, 3)])
    );
    assert!(!t.broken());
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
    // A queue size that isn't a power of 2, or is past QueueNumMax.
    for n in [3, 2 * QSIZE, 0] {
        let mut t = T::new();
        t.wr(0x038, n);
        t.wr(0x044, 1);
        assert!(t.broken(), "size {n}");
    }
}

#[test]
fn shared_layout() {
    use core::mem::offset_of;
    assert_eq!(offset_of!(DevShared, events), 0);
    assert_eq!(offset_of!(DevShared, status), 4);
    assert_eq!(offset_of!(DevShared, features), 8);
    assert_eq!(offset_of!(DevShared, epoch), 16);
    assert_eq!(offset_of!(DevShared, config), 24);
    assert_eq!(offset_of!(DevShared, req), 280);
    assert_eq!(offset_of!(DevShared, cpl), 280 + 8 + 4 * RING_WORDS);
    assert_eq!(size_of::<DeviceEntry>(), 40);
}
