//! The controller against hand-built rings: what Linux's xhci-hcd does, step by step, and
//! what a backend answers, through the shared block's rings.

use super::*;

const DCBAA: u64 = RAM_BASE + 0x1000;
const CMD: u64 = RAM_BASE + 0x2000;
const ERST_TBL: u64 = RAM_BASE + 0x3000;
const EVT: u64 = RAM_BASE + 0x4000;
const EVT_TRBS: u32 = 16;
const OUT_CTX: u64 = RAM_BASE + 0x6000;
const IN_CTX: u64 = RAM_BASE + 0x8000;
const EP0_RING: u64 = RAM_BASE + 0xa000;
const BULK_IN: u64 = RAM_BASE + 0xb000;
const BULK_OUT: u64 = RAM_BASE + 0xc000;
const BUF: u64 = RAM_BASE + 0x10000;
const CMD_TRBS: u64 = 16;

const OP: u64 = CAPLENGTH;
const USBCMD: u64 = OP;
const USBSTS: u64 = OP + 4;
const PORTSC: u64 = PORT_REGS;

/// A parsed request record.
#[derive(Debug)]
struct Req {
    tag: u32,
    g: u32,
    conn: u32,
    dci: u32,
    kind: u32,
    words: Vec<u32>,
}

struct T {
    _ram: Vec<u128>,
    mem: Mem,
    x: Xhci,
    sh: Box<XhciShared>,
    /// The command ring's enqueue (TRB index) and cycle.
    cmd: (u64, bool),
    /// The event ring's dequeue (TRB index) and cycle.
    evt: (u32, bool),
    /// Each transfer ring's enqueue (address) and cycle, by ring base.
    rings: HashMap<u64, (u64, bool)>,
    /// The machine's time for the controller (ns).
    ns: u64,
}

impl T {
    fn new() -> T {
        let mut ram = vec![0u128; (1 << 20) / 16];
        // SAFETY: ram is 16-byte aligned, 1 MiB, and lives as long as mem.
        let mem = unsafe { Mem::new(ram.as_mut_ptr() as *mut u8, 1 << 20) }.at(RAM_BASE);
        let mut t = T {
            _ram: ram,
            mem,
            x: Xhci::new(),
            sh: Box::default(),
            cmd: (0, true),
            evt: (0, true),
            rings: HashMap::new(),
            ns: 0,
        };
        // Events at once; `completions_wait_for_their_latency` has it on.
        t.x.latency = 0;
        t.up();
        t
    }

    fn rd(&mut self, off: u64) -> u32 {
        self.x.read(off, 4, 0).unwrap() as u32
    }

    fn wr(&mut self, off: u64, v: u32) -> u32 {
        self.x
            .write(off, 4, v as u64, &self.mem, &self.sh, self.ns)
            .unwrap()
    }

    fn wr64(&mut self, off: u64, v: u64) {
        self.wr(off, v as u32);
        self.wr(off + 4, (v >> 32) as u32);
    }

    fn put(&self, at: u64, words: &[u32]) {
        for (k, &w) in words.iter().enumerate() {
            self.mem.write(at + 4 * k as u64, 4, w as u64).unwrap();
        }
    }

    fn get(&self, at: u64) -> u32 {
        self.mem.read(at, 4).unwrap() as u32
    }

    /// Linux's bring-up: reset, slots, DCBAA, command ring (with a Link TRB back to its start),
    /// one event ring segment, the interrupter, run.
    fn up(&mut self) {
        self.wr(USBCMD, CMD_HCRST);
        assert_eq!(self.rd(USBSTS) & STS_HCH, STS_HCH);
        self.wr(OP + 0x38, 8);
        self.wr64(OP + 0x30, DCBAA);
        self.put(
            CMD + 16 * (CMD_TRBS - 1),
            &[CMD as u32, 0, 0, T_LINK << 10 | C_ENT_TC],
        );
        self.wr64(OP + 0x18, CMD | 1);
        self.put(ERST_TBL, &[EVT as u32, 0, EVT_TRBS, 0]);
        self.wr(RTSOFF + 0x28, 1);
        self.wr64(RTSOFF + 0x30, ERST_TBL);
        self.wr64(RTSOFF + 0x38, EVT);
        self.wr(RTSOFF + 0x20, 2); // IE
        self.wr(USBCMD, CMD_RS | CMD_INTE);
        assert_eq!(self.rd(USBSTS) & STS_HCH, 0);
    }

    /// The events written since the last call, then ERDP past them (EHB cleared), as Linux's handler.
    fn events(&mut self) -> Vec<[u32; 4]> {
        let mut out = vec![];
        loop {
            let at = EVT + 16 * self.evt.0 as u64;
            let t = [
                self.get(at),
                self.get(at + 4),
                self.get(at + 8),
                self.get(at + 12),
            ];
            if t[3] & 1 != self.evt.1 as u32 {
                break;
            }
            out.push(t);
            self.evt.0 += 1;
            if self.evt.0 == EVT_TRBS {
                self.evt = (0, !self.evt.1);
            }
        }
        if !out.is_empty() {
            assert!(self.x.irq(), "events without an interrupt");
            self.wr(RTSOFF + 0x20, 3); // IP cleared, IE
            self.wr(USBSTS, STS_EINT);
            let at = EVT + 16 * self.evt.0 as u64;
            self.wr(RTSOFF + 0x38, at as u32 | 8);
            self.wr(RTSOFF + 0x3c, (at >> 32) as u32);
        }
        out
    }

    /// Runs a command; its completion event's code and slot.
    fn command(&mut self, trb: [u32; 4]) -> (u32, u32) {
        let at = CMD + 16 * self.cmd.0;
        self.put(
            at,
            &[trb[0], trb[1], trb[2], trb[3] & !1 | self.cmd.1 as u32],
        );
        self.cmd.0 += 1;
        if self.cmd.0 == CMD_TRBS - 1 {
            self.put(
                CMD + 16 * (CMD_TRBS - 1),
                &[
                    CMD as u32,
                    0,
                    0,
                    T_LINK << 10 | C_ENT_TC | self.cmd.1 as u32,
                ],
            );
            self.cmd = (0, !self.cmd.1);
        }
        self.wr(DBOFF, 0);
        let ev = self.events();
        let c = ev
            .iter()
            .find(|e| ty(e) == T_COMMAND_EVENT)
            .expect("a command completion");
        assert_eq!(c[0] as u64 | (c[1] as u64) << 32, at);
        (c[2] >> 24, c[3] >> 24)
    }

    fn cpl(&mut self, w: [u32; 3]) {
        assert!(self.sh.cpl.push(&w));
        self.x.complete(&self.mem, &self.sh, self.ns);
    }

    fn requests(&mut self) -> Vec<Req> {
        let mut out = vec![];
        self.sh.events.swap(0, Ordering::AcqRel);
        while let Some([w0, w1, n]) = self.sh.req.pop::<3>() {
            let words = (0..n).map(|_| self.sh.req.pop::<1>().unwrap()[0]).collect();
            out.push(Req {
                tag: w0 & 0xff_ffff,
                g: w0 >> 24,
                conn: w1 & 0xff,
                dci: w1 >> 8 & 0xff,
                kind: w1 >> 16,
                words,
            });
        }
        out
    }

    fn done(&mut self, r: &Req, cc: u32, actual: u32) {
        self.cpl([r.tag | r.g << 24, CPL_DONE | cc << 8, actual]);
    }

    /// Queues a TRB on a transfer ring (16 TRBs, the last a Link back with Toggle Cycle).
    fn trb(&mut self, ring: u64, w: [u32; 4]) -> u64 {
        let (at, cycle) = *self.rings.get(&ring).unwrap_or(&(ring, true));
        self.put(at, &[w[0], w[1], w[2], w[3] & !1 | cycle as u32]);
        let (mut next, mut c) = (at + 16, cycle);
        if next == ring + 15 * 16 {
            self.put(
                next,
                &[ring as u32, 0, 0, T_LINK << 10 | C_ENT_TC | c as u32],
            );
            (next, c) = (ring, !c);
        }
        self.rings.insert(ring, (next, c));
        at
    }

    fn attach(&mut self, c: u32, speed: u32) {
        self.cpl([c, CPL_ATTACH | speed << 8, 0]);
    }

    /// Enable Slot and Address Device for the device on root port `port` (EP0 on EP0_RING).
    fn address(&mut self, port: u32, bsr: bool) -> u32 {
        let (cc, slot) = self.command([0, 0, 0, T_ENABLE_SLOT << 10]);
        assert_eq!((cc, slot), (CC_SUCCESS, 1));
        self.put(DCBAA + 8, &[OUT_CTX as u32, 0]);
        self.put(IN_CTX, &[0, 3, 0, 0, 0, 0, 0, 0]);
        self.put(IN_CTX + 32, &[1 << 27 | 3 << 20, port << 16, 0, 0]);
        self.put(
            IN_CTX + 64,
            &[
                0,
                3 << 1 | EP_CONTROL << 3 | 64 << 16,
                EP0_RING as u32 | 1,
                0,
                8,
            ],
        );
        let bsr = if bsr { C_BSR } else { 0 };
        assert_eq!(
            self.command([IN_CTX as u32, 0, 0, T_ADDRESS << 10 | bsr | 1 << 24]),
            (CC_SUCCESS, 1)
        );
        1
    }

    /// GET_DESCRIPTOR(DEVICE) for `len` bytes on EP0: setup, IN data with ISP, status with IOC.
    fn get_descriptor(&mut self, len: u32) -> (u64, u64) {
        let setup = 0x80 | 6 << 8 | 0x0100 << 16;
        self.trb(
            EP0_RING,
            [setup, len << 16, 8, T_SETUP << 10 | C_IDT | 3 << 16],
        );
        let data = self.trb(
            EP0_RING,
            [BUF as u32, 0, len, T_DATA << 10 | C_ISP | 1 << 16],
        );
        let status = self.trb(EP0_RING, [0, 0, 0, T_STATUS << 10 | C_IOC]);
        self.wr(DBOFF + 4, 1);
        (data, status)
    }

    /// Configure Endpoint: bulk OUT 1 (DCI 2) and bulk IN 1 (DCI 3), 512 bytes.
    fn configure(&mut self) {
        self.put(IN_CTX, &[0, 1 | 1 << 2 | 1 << 3, 0, 0, 0, 0, 0, 0]);
        self.put(IN_CTX + 32, &[3 << 27, 1 << 16, 0, 0]);
        self.put(
            IN_CTX + 32 * 3,
            &[
                0,
                3 << 1 | 2 << 3 | 512 << 16,
                BULK_OUT as u32 | 1,
                0,
                0,
                0,
                0,
                0,
            ],
        );
        self.put(
            IN_CTX + 32 * 4,
            &[
                0,
                3 << 1 | 6 << 3 | 512 << 16,
                BULK_IN as u32 | 1,
                0,
                0,
                0,
                0,
                0,
            ],
        );
        assert_eq!(
            self.command([IN_CTX as u32, 0, 0, T_CONFIGURE << 10 | 1 << 24]),
            (CC_SUCCESS, 1)
        );
    }

    fn ep_state(&self, dci: u64) -> u32 {
        self.get(OUT_CTX + 32 * dci) & 7
    }

    fn ep_deq(&self, dci: u64) -> u64 {
        self.get(OUT_CTX + 32 * dci + 8) as u64 | (self.get(OUT_CTX + 32 * dci + 12) as u64) << 32
    }
}

fn ptr(e: &[u32; 4]) -> u64 {
    e[0] as u64 | (e[1] as u64) << 32
}

/// A Transfer Event's (TRB, code, residual, DCI).
fn transfer(e: &[u32; 4]) -> (u64, u32, u32, u32) {
    assert_eq!(ty(e), T_TRANSFER_EVENT, "{e:x?}");
    (ptr(e), e[2] >> 24, e[2] & 0xff_ffff, e[3] >> 16 & 0x1f)
}

#[test]
fn capabilities_and_protocols() {
    let mut t = T::new();
    assert_eq!(t.rd(0), 0x0100_0040);
    assert_eq!(t.x.read(2, 2, 0), Some(0x0100), "HCIVERSION by itself");
    assert_eq!(t.rd(4) >> 24, 8);
    assert_eq!(t.rd(0x10) & 5, 1, "64-bit, 32-byte contexts");
    let xecp = (t.rd(0x10) >> 16) as u64 * 4;
    // USB 2.0 on ports 1-4, USB 3.0 on 5-8, then nothing.
    assert_eq!(t.rd(xecp) & 0xff00_00ff, 0x0200_0002);
    assert_eq!(t.rd(xecp + 8) & 0xffff, 0x0401);
    let next = xecp + 4 * (t.rd(xecp) >> 8 & 0xff) as u64;
    assert_eq!(t.rd(next) & 0xff00_ffff, 0x0300_0002);
    assert_eq!(t.rd(next + 8) & 0xffff, 0x0405);
    // Empty ports, powered, RxDetect; MFINDEX in microframes.
    assert_eq!(t.rd(PORTSC), P_PP | PLS_RX_DETECT << 5);
    assert_eq!(t.x.read(RTSOFF, 4, 1_000_000), Some(8));
    assert_eq!(t.x.read(OP + 1, 4, 0), None, "unaligned");
    assert_eq!(
        t.x.write(OP, 2, 0, &t.mem, &t.sh, 0),
        None,
        "a 16-bit write"
    );
    assert_eq!(t.command([0, 0, 0, T_NOOP_CMD << 10]), (CC_SUCCESS, 0));
    assert_eq!(t.command([0, 0, 0, 30 << 10]), (CC_TRB, 0));
}

#[test]
fn usb2_attach_reset_and_hot_unplug() {
    let mut t = T::new();
    t.attach(0, SPEED_HIGH);
    let ev = t.events();
    assert_eq!(ev.len(), 1);
    assert_eq!((ty(&ev[0]), ev[0][0] >> 24), (T_PORT_EVENT, 1));
    let sc = t.rd(PORTSC);
    assert_eq!(sc & (P_CCS | P_PED | P_CSC), P_CCS | P_CSC);
    assert_eq!((sc >> 10 & 0xf, sc >> 5 & 0xf), (SPEED_HIGH, PLS_POLLING));
    assert_ne!(t.rd(USBSTS) & STS_PCD, 0);
    // The driver clears CSC, then resets the port: enabled, U0, PRC; the first reset is the core's.
    t.wr(PORTSC, P_PP | P_CSC);
    t.wr(PORTSC, P_PP | P_PR);
    let sc = t.rd(PORTSC);
    assert_eq!(sc & (P_PED | P_PRC | P_PR | P_CSC), P_PED | P_PRC);
    assert_eq!(sc >> 5 & 0xf, PLS_U0);
    assert_eq!(t.events().len(), 1);
    assert!(t.requests().is_empty(), "the first reset stays in the core");
    t.wr(PORTSC, P_PP | P_PRC);
    t.wr(PORTSC, P_PP | P_PR);
    let r = t.requests();
    assert_eq!((r.len(), r[0].kind, r[0].conn), (1, REQ_RESET, 0));
    // Suspend and resume (USB 2: Resume, then U0 with a link state change).
    t.wr(PORTSC, P_PP | P_PRC | P_LWS | PLS_U3 << 5);
    t.events();
    assert_eq!(t.rd(PORTSC) >> 5 & 0xf, PLS_U3);
    t.wr(PORTSC, P_PP | P_LWS | PLS_RESUME << 5);
    t.wr(PORTSC, P_PP | P_LWS | PLS_U0 << 5);
    assert_eq!(t.rd(PORTSC) & (P_PLC | P_PLS), P_PLC);
    t.events();
    // The host unplugs it.
    t.cpl([0, CPL_DETACH, 0]);
    let sc = t.rd(PORTSC);
    assert_eq!(sc & (P_CCS | P_PED | P_CSC), P_CSC);
    assert_eq!(t.events().len(), 1);
}

#[test]
fn usb3_attach_is_enabled_at_once() {
    let mut t = T::new();
    t.attach(1, SPEED_SUPER);
    let ev = t.events();
    assert_eq!(ev[0][0] >> 24, 6, "connector 1's USB 3 port");
    let sc = t.rd(PORTSC + 16 * 5);
    assert_eq!(sc & (P_CCS | P_PED), P_CCS | P_PED);
    assert_eq!((sc >> 10 & 0xf, sc >> 5 & 0xf), (SPEED_SUPER, PLS_U0));
    assert_eq!(
        t.rd(PORTSC + 16),
        P_PP | PLS_RX_DETECT << 5,
        "its USB 2 port stays empty"
    );
    // A second device on the same connector is refused.
    t.attach(1, SPEED_HIGH);
    assert!(t.events().is_empty());
    // Warm reset.
    t.wr(PORTSC + 16 * 5, P_PP | P_CSC | P_WPR);
    assert_ne!(t.rd(PORTSC + 16 * 5) & (P_WRC | P_PRC), 0);
}

#[test]
fn ports_change_while_halted_report_at_run() {
    let mut t = T::new();
    t.wr(USBCMD, 0);
    t.attach(2, SPEED_FULL);
    assert!(t.events().is_empty());
    t.wr(USBCMD, CMD_RS | CMD_INTE);
    let ev = t.events();
    assert_eq!((ev.len(), ev[0][0] >> 24), (1, 3));
}

#[test]
fn enumeration_control_transfers_and_a_short_read() {
    let mut t = T::new();
    t.attach(0, SPEED_HIGH);
    t.wr(PORTSC, P_PP | P_CSC | P_PR);
    t.events();
    // BSR=1 first, as Linux's new scheme: Default, address 0.
    t.address(1, true);
    assert_eq!(t.get(OUT_CTX + 12), SLOT_DEFAULT << 27);
    assert_eq!(t.ep_state(1), EP_RUNNING);
    let (data, status) = t.get_descriptor(64);
    let r = t.requests();
    assert_eq!(r.len(), 1);
    let q = &r[0];
    assert_eq!((q.kind, q.dci, q.conn), (REQ_TRANSFER, 1, 0));
    // segments 1 | control << 16 | setup << 24, 64 bytes, the setup packet, then one segment.
    assert_eq!(q.words[0], 1 | EP_CONTROL << 16 | 1 << 24);
    assert_eq!(q.words[1], 64);
    assert_eq!(q.words[2..4], [0x0100_0680, 64 << 16]);
    assert_eq!(q.words[4..6], [(BUF - RAM_BASE) as u32, 64]);
    // The device gave 18 bytes: Short Packet on the data stage, then the status stage's success.
    t.done(q, CC_SUCCESS, 18);
    let ev = t.events();
    assert_eq!(ev.len(), 2);
    assert_eq!(transfer(&ev[0]), (data, CC_SHORT, 46, 1));
    assert_eq!(transfer(&ev[1]), (status, CC_SUCCESS, 0, 1));
    // A completion for a tag that's done is dropped.
    t.done(q, CC_SUCCESS, 18);
    assert!(t.events().is_empty());
    // Address Device again with BSR=0 (the ring goes on where it was): Addressed.
    let (cc, _) = t.command([0, 0, 0, T_ENABLE_SLOT << 10]);
    assert_eq!(cc, CC_SUCCESS);
    let at = t.rings[&EP0_RING].0;
    t.put(IN_CTX + 64 + 8, &[at as u32 | 1, 0]);
    assert_eq!(
        t.command([IN_CTX as u32, 0, 0, T_ADDRESS << 10 | 1 << 24]),
        (CC_SUCCESS, 1)
    );
    assert_eq!(t.get(OUT_CTX + 12), SLOT_ADDRESSED << 27 | 1);
    // BSR=1 on an addressed slot is a context state error.
    assert_eq!(
        t.command([IN_CTX as u32, 0, 0, T_ADDRESS << 10 | C_BSR | 1 << 24]),
        (CC_CONTEXT_STATE, 1)
    );
    // Evaluate Context: EP0's max packet size.
    t.put(IN_CTX, &[0, 2, 0, 0, 0, 0, 0, 0]);
    t.put(IN_CTX + 64, &[0, 3 << 1 | EP_CONTROL << 3 | 512 << 16]);
    assert_eq!(
        t.command([IN_CTX as u32, 0, 0, T_EVALUATE << 10 | 1 << 24]),
        (CC_SUCCESS, 1)
    );
    assert_eq!(t.get(OUT_CTX + 32 + 4) >> 16, 512);
}

/// A configured device on connector 0 (high speed), with its EP0 ring at EP0_RING.
fn configured() -> T {
    let mut t = T::new();
    t.attach(0, SPEED_HIGH);
    t.wr(PORTSC, P_PP | P_CSC | P_PR);
    t.events();
    t.address(1, false);
    t.configure();
    let r = t.requests();
    assert_eq!(r.len(), 1);
    assert_eq!(r[0].kind, REQ_CONFIGURED);
    assert_eq!(r[0].words, [2, 2 | 2 << 8, 512, 3 | 6 << 8, 512]);
    assert_eq!(t.get(OUT_CTX + 12) >> 27, SLOT_CONFIGURED);
    assert_eq!((t.ep_state(2), t.ep_state(3)), (EP_RUNNING, EP_RUNNING));
    t
}

#[test]
fn bulk_tds_across_a_link_trb() {
    let mut t = configured();
    // 7 one-TRB TDs, then a TD of three chained TRBs whose second follows the Link TRB at slot 15.
    for k in 0..7u32 {
        t.trb(
            BULK_OUT,
            [BUF as u32 + 512 * k, 0, 512, T_NORMAL << 10 | C_IOC],
        );
    }
    t.wr(DBOFF + 4, 2);
    let r = t.requests();
    assert_eq!(r.len(), 7);
    for q in &r {
        assert_eq!(q.words[..2], [1 | 2 << 16, 512]);
        t.done(q, CC_SUCCESS, 512);
    }
    assert_eq!(t.events().len(), 7);
    for _ in 0..7 {
        t.trb(BULK_OUT, [BUF as u32, 0, 16, T_NORMAL << 10 | C_IOC]);
    }
    t.wr(DBOFF + 4, 2);
    for q in t.requests() {
        t.done(&q, CC_SUCCESS, 16);
    }
    assert_eq!(t.events().len(), 7);
    let a = t.trb(BULK_OUT, [BUF as u32, 0, 100, T_NORMAL << 10 | C_CH]);
    assert_eq!(a, BULK_OUT + 14 * 16);
    let b = t.trb(BULK_OUT, [BUF as u32 + 100, 0, 200, T_NORMAL << 10 | C_CH]);
    assert_eq!(b, BULK_OUT, "past the Link TRB, with the cycle toggled");
    let c = t.trb(
        BULK_OUT,
        [0x0403_0201, 0x0807_0605, 8, T_NORMAL << 10 | C_IOC | C_IDT],
    );
    t.wr(DBOFF + 4, 2);
    let r = t.requests();
    assert_eq!(r.len(), 1);
    assert_eq!(r[0].words[..2], [3 | 2 << 16, 308]);
    let base = (BUF - RAM_BASE) as u32;
    assert_eq!(
        r[0].words[2..],
        [
            base,
            100,
            base + 100,
            200,
            0,
            8 | SEG_IMMEDIATE,
            0x0403_0201,
            0x0807_0605
        ]
    );
    t.done(&r[0], CC_SUCCESS, 308);
    let ev = t.events();
    assert_eq!(ev.len(), 1);
    assert_eq!(transfer(&ev[0]), (c, CC_SUCCESS, 0, 2));
    // A TD whose first TRB the guest hasn't given yet (its cycle is the old one) waits.
    t.put(
        BULK_OUT + 32,
        &[BUF as u32, 0, 1, T_NORMAL << 10 | C_IOC | 1],
    );
    t.wr(DBOFF + 4, 2);
    assert!(t.requests().is_empty());
}

#[test]
fn a_short_bulk_in_reports_on_its_trb() {
    let mut t = configured();
    let a = t.trb(BULK_IN, [BUF as u32, 0, 512, T_NORMAL << 10 | C_CH | C_ISP]);
    t.trb(
        BULK_IN,
        [BUF as u32 + 512, 0, 512, T_NORMAL << 10 | C_IOC | C_ISP],
    );
    let next = t.trb(BULK_IN, [BUF as u32, 0, 64, T_NORMAL << 10 | C_IOC | C_ISP]);
    t.wr(DBOFF + 4, 3);
    let r = t.requests();
    assert_eq!(r.len(), 2);
    t.done(&r[0], CC_SHORT, 300);
    t.done(&r[1], CC_SUCCESS, 64);
    let ev = t.events();
    assert_eq!(ev.len(), 2);
    assert_eq!(transfer(&ev[0]), (a, CC_SHORT, 212, 3));
    assert_eq!(transfer(&ev[1]), (next, CC_SUCCESS, 0, 3));
}

#[test]
fn a_stall_halts_until_reset_endpoint_and_a_new_dequeue() {
    let mut t = configured();
    let a = t.trb(
        BULK_IN,
        [BUF as u32, 0, 512, T_NORMAL << 10 | C_IOC | C_ISP],
    );
    let b = t.trb(
        BULK_IN,
        [BUF as u32, 0, 512, T_NORMAL << 10 | C_IOC | C_ISP],
    );
    t.wr(DBOFF + 4, 3);
    let r = t.requests();
    assert_eq!(r.len(), 2);
    t.done(&r[0], CC_STALL, 0);
    let ev = t.events();
    assert_eq!(ev.len(), 1);
    assert_eq!(transfer(&ev[0]), (a, CC_STALL, 512, 3));
    assert_eq!(t.ep_state(3), EP_HALTED);
    assert_eq!(t.ep_deq(3), a | 1, "the halted TD");
    // The TD after it left the backend; its late completion is dropped.
    let c = t.requests();
    assert_eq!(
        (c.len(), c[0].kind, c[0].words.clone()),
        (1, REQ_CANCEL, vec![1, r[1].tag])
    );
    t.done(&r[1], CC_SUCCESS, 512);
    assert!(t.events().is_empty());
    // A doorbell on a halted endpoint does nothing.
    t.wr(DBOFF + 4, 3);
    assert!(t.requests().is_empty());
    // Stop Endpoint on a halted one: context state error.
    assert_eq!(
        t.command([0, 0, 0, T_STOP_EP << 10 | 3 << 16 | 1 << 24]),
        (CC_CONTEXT_STATE, 1)
    );
    assert_eq!(
        t.command([0, 0, 0, T_RESET_EP << 10 | 3 << 16 | 1 << 24]),
        (CC_SUCCESS, 1)
    );
    assert_eq!(t.ep_state(3), EP_STOPPED);
    let c = t.requests();
    assert_eq!((c[0].kind, c[0].dci), (REQ_CLEAR_HALT, 3));
    // Linux moves the dequeue pointer past the stalled TD and rings again: the second TD is posted again.
    assert_eq!(
        t.command([b as u32 | 1, 0, 0, T_SET_DEQ << 10 | 3 << 16 | 1 << 24]),
        (CC_SUCCESS, 1)
    );
    assert_eq!(t.ep_deq(3), b | 1);
    t.wr(DBOFF + 4, 3);
    assert_eq!(t.ep_state(3), EP_RUNNING);
    let r = t.requests();
    assert_eq!(r.len(), 1);
    t.done(&r[0], CC_SUCCESS, 512);
    assert_eq!(transfer(&t.events()[0]), (b, CC_SUCCESS, 0, 3));
}

#[test]
fn stop_endpoint_cancels_what_is_in_flight() {
    let mut t = configured();
    let a = t.trb(
        BULK_IN,
        [BUF as u32, 0, 512, T_NORMAL << 10 | C_IOC | C_ISP],
    );
    t.trb(
        BULK_IN,
        [BUF as u32, 0, 512, T_NORMAL << 10 | C_IOC | C_ISP],
    );
    t.wr(DBOFF + 4, 3);
    let r = t.requests();
    assert_eq!(r.len(), 2);
    // A completion that came before the command is taken first.
    t.sh.cpl
        .push(&[r[0].tag | r[0].g << 24, CPL_DONE | CC_SUCCESS << 8, 512]);
    let at = CMD + 16 * t.cmd.0;
    t.put(
        at,
        &[
            0,
            0,
            0,
            T_STOP_EP << 10 | 3 << 16 | 1 << 24 | t.cmd.1 as u32,
        ],
    );
    t.cmd.0 += 1;
    t.wr(DBOFF, 0);
    let ev = t.events();
    assert_eq!(ev.len(), 3);
    assert_eq!(transfer(&ev[0]), (a, CC_SUCCESS, 0, 3));
    let (stopped, cc, _, _) = transfer(&ev[1]);
    assert_eq!((stopped, cc), (a + 16, CC_STOPPED));
    assert_eq!(ty(&ev[2]), T_COMMAND_EVENT);
    assert_eq!(t.ep_state(3), EP_STOPPED);
    assert_eq!(t.ep_deq(3), (a + 16) | 1);
    let c = t.requests();
    assert_eq!(
        (c[0].kind, c[0].words.clone()),
        (REQ_CANCEL, vec![1, r[1].tag])
    );
    t.done(&r[1], CC_SUCCESS, 512);
    assert!(
        t.events().is_empty(),
        "a cancelled TD's completion is dropped"
    );
    // Ringing again posts it again, with a new tag.
    t.wr(DBOFF + 4, 3);
    let again = t.requests();
    assert_eq!(again.len(), 1);
    assert_ne!(again[0].tag, r[1].tag);
}

#[test]
fn an_unplug_fails_what_is_in_flight() {
    let mut t = configured();
    let a = t.trb(
        BULK_IN,
        [BUF as u32, 0, 512, T_NORMAL << 10 | C_IOC | C_ISP],
    );
    t.wr(DBOFF + 4, 3);
    let r = t.requests();
    t.cpl([0, CPL_DETACH, 0]);
    let ev = t.events();
    assert_eq!(ev.len(), 2);
    assert_eq!(transfer(&ev[0]), (a, CC_TRANSACTION, 512, 3));
    assert_eq!(ty(&ev[1]), T_PORT_EVENT);
    // The backend's late completion is dropped; new TDs fail at once.
    t.done(&r[0], CC_SUCCESS, 512);
    assert!(t.events().is_empty());
    assert_eq!(
        t.command([0, 0, 0, T_RESET_EP << 10 | 3 << 16 | 1 << 24]),
        (CC_SUCCESS, 1)
    );
    let next = t.ep_deq(3) & !0xf;
    assert_eq!(
        t.command([
            (next as u32 + 16) | 1,
            0,
            0,
            T_SET_DEQ << 10 | 3 << 16 | 1 << 24
        ]),
        (CC_SUCCESS, 1)
    );
    let b = t.trb(
        BULK_IN,
        [BUF as u32, 0, 512, T_NORMAL << 10 | C_IOC | C_ISP],
    );
    t.wr(DBOFF + 4, 3);
    assert!(t.requests().is_empty());
    assert_eq!(transfer(&t.events()[0]), (b, CC_TRANSACTION, 512, 3));
    // A device plugged in again on the connector has a new generation.
    t.attach(0, SPEED_HIGH);
    t.wr(PORTSC, P_PP | P_CSC | P_PR);
    assert!(t.requests().is_empty(), "the new device's first reset");
    assert_eq!(
        t.command([0, 0, 0, T_DISABLE_SLOT << 10 | 1 << 24]),
        (CC_SUCCESS, 1)
    );
    t.events();
    t.rings.clear();
    t.address(1, false);
    t.get_descriptor(18);
    let r = t.requests();
    assert_eq!(r[0].g, 1);
}

#[test]
fn bad_trbs_are_trb_errors() {
    let mut t = configured();
    // A TRB pointing outside RAM (the buffer), and a Setup TRB on a bulk ring.
    t.trb(BULK_OUT, [0x1000, 0, 512, T_NORMAL << 10 | C_IOC]);
    t.wr(DBOFF + 4, 2);
    let ev = t.events();
    assert_eq!(transfer(&ev[0]).1, CC_TRB);
    assert_eq!(t.ep_state(2), EP_HALTED);
    let a = t.trb(BULK_IN, [0, 0, 8, T_SETUP << 10 | C_IDT]);
    t.wr(DBOFF + 4, 3);
    assert_eq!(transfer(&t.events()[0]), (a, CC_TRB, 0, 3));
    // A No-Op TD completes in the core.
    let mut t = configured();
    let n = t.trb(BULK_OUT, [0, 0, 0, T_NOOP << 10 | C_IOC]);
    t.wr(DBOFF + 4, 2);
    assert!(t.requests().is_empty());
    assert_eq!(transfer(&t.events()[0]), (n, CC_SUCCESS, 0, 2));
    // Commands for slots and endpoints that aren't there.
    assert_eq!(
        t.command([0, 0, 0, T_STOP_EP << 10 | 5 << 16 | 1 << 24]),
        (CC_EP_NOT_ENABLED, 1)
    );
    assert_eq!(
        t.command([0, 0, 0, T_STOP_EP << 10 | 3 << 16 | 7 << 24]),
        (CC_SLOT_NOT_ENABLED, 7)
    );
}

#[test]
fn a_full_event_ring_keeps_its_events() {
    let mut t = T::new();
    // 20 No-Op commands without reading the events: 15 fit (one slot stays free), the rest wait.
    for k in 0..20 {
        let at = CMD + 16 * t.cmd.0;
        t.put(at, &[0, 0, 0, T_NOOP_CMD << 10 | t.cmd.1 as u32]);
        t.cmd.0 += 1;
        if t.cmd.0 == CMD_TRBS - 1 {
            t.put(
                CMD + 16 * (CMD_TRBS - 1),
                &[CMD as u32, 0, 0, T_LINK << 10 | C_ENT_TC | t.cmd.1 as u32],
            );
            t.cmd = (0, !t.cmd.1);
        }
        if k == 13 || k == 19 {
            t.wr(DBOFF, 0);
        }
    }
    assert_eq!(t.x.pending.len(), 5);
    assert_eq!(t.events().len(), 15);
    assert_eq!(t.events().len(), 5, "written once ERDP moved");
    assert!(t.events().is_empty());
}

#[test]
fn deconfigure_and_drop_cancel() {
    let mut t = configured();
    t.trb(
        BULK_IN,
        [BUF as u32, 0, 512, T_NORMAL << 10 | C_IOC | C_ISP],
    );
    t.wr(DBOFF + 4, 3);
    let r = t.requests();
    assert_eq!(
        t.command([0, 0, 0, T_CONFIGURE << 10 | C_DC | 1 << 24]),
        (CC_SUCCESS, 1)
    );
    let c = t.requests();
    assert_eq!(
        (c[0].kind, c[0].words.clone()),
        (REQ_CANCEL, vec![1, r[0].tag])
    );
    assert_eq!((c[1].kind, c[1].words.clone()), (REQ_CONFIGURED, vec![0]));
    assert_eq!(t.get(OUT_CTX + 12) >> 27, SLOT_ADDRESSED);
    assert_eq!(t.ep_state(3), EP_DISABLED);
}

#[test]
fn hcrst_cancels_and_keeps_the_devices() {
    let mut t = configured();
    t.trb(
        BULK_IN,
        [BUF as u32, 0, 512, T_NORMAL << 10 | C_IOC | C_ISP],
    );
    t.wr(DBOFF + 4, 3);
    let r = t.requests();
    t.wr(USBCMD, CMD_HCRST);
    let c = t.requests();
    assert_eq!(
        (c[0].kind, c[0].words.clone()),
        (REQ_CANCEL, vec![1, r[0].tag])
    );
    assert_eq!(t.rd(PORTSC) & (P_CCS | P_CSC | P_PED), P_CCS | P_CSC);
}

#[test]
fn snapshots_round_trip_with_empty_ports() {
    let mut t = configured();
    assert!(!t.x.saveable(), "a device is attached");
    t.cpl([0, CPL_DETACH, 0]);
    t.events();
    assert!(t.x.saveable() && t.x.quiet(&t.sh));
    let mut w = Writer::default();
    t.x.save(&mut w);
    let mut x2 = Xhci::new();
    let mut r = Reader(&w.0);
    x2.restore(&mut r).unwrap();
    r.end().unwrap();
    let mut w2 = Writer::default();
    x2.save(&mut w2);
    let diff = w.0.iter().zip(&w2.0).position(|(a, b)| a != b);
    assert_eq!((diff, w.0.len()), (None, w2.0.len()), "the states differ");
    // Truncated: an error, not a panic.
    for n in [0, 7, w.0.len() / 2, w.0.len() - 1] {
        assert!(Xhci::new().restore(&mut Reader(&w.0[..n])).is_err());
    }
}

#[test]
fn records_wait_for_room_in_the_request_ring() {
    let mut t = configured();
    // Fill the request ring with the host not reading: TDs wait in order and post after it reads.
    let n = 2000;
    let mut posted = 0;
    let mut tags = vec![];
    for k in 0..n {
        t.trb(BULK_OUT, [BUF as u32, 0, 8, T_NORMAL << 10 | C_IOC]);
        if k % 14 == 13 {
            t.wr(DBOFF + 4, 2);
            for q in t.requests() {
                tags.push(q.tag);
                posted += 1;
                t.done(&q, CC_SUCCESS, 8);
            }
            assert_eq!(t.events().len(), 14);
        }
    }
    assert_eq!(posted, n / 14 * 14);
    tags.dedup();
    assert_eq!(tags.len(), posted);
}

#[test]
fn completions_wait_for_their_latency() {
    let mut t = configured();
    t.x.latency = LATENCY_NS;
    t.ns = 1_000_000;
    let a = t.trb(
        BULK_IN,
        [BUF as u32, 0, 512, T_NORMAL << 10 | C_IOC | C_ISP],
    );
    t.wr(DBOFF + 4, 3);
    let r = t.requests();
    t.done(&r[0], CC_SUCCESS, 512);
    assert!(t.events().is_empty(), "too early");
    assert_eq!(t.x.due(), 1_000_000 + LATENCY_NS);
    t.x.tick(1_000_000 + LATENCY_NS - 1, false, &t.mem, &t.sh);
    assert!(t.events().is_empty());
    t.x.tick(1_000_000 + LATENCY_NS, false, &t.mem, &t.sh);
    assert_eq!(transfer(&t.events()[0]), (a, CC_SUCCESS, 0, 3));
    assert_eq!(t.x.due(), u64::MAX);
    // An idle machine takes it at once.
    let b = t.trb(
        BULK_IN,
        [BUF as u32, 0, 512, T_NORMAL << 10 | C_IOC | C_ISP],
    );
    t.wr(DBOFF + 4, 3);
    let r = t.requests();
    t.done(&r[0], CC_SUCCESS, 512);
    t.x.tick(t.ns, true, &t.mem, &t.sh);
    assert_eq!(transfer(&t.events()[0]), (b, CC_SUCCESS, 0, 3));
    // A Stop Endpoint takes what completed, latency or not.
    let c = t.trb(
        BULK_IN,
        [BUF as u32, 0, 512, T_NORMAL << 10 | C_IOC | C_ISP],
    );
    t.wr(DBOFF + 4, 3);
    let r = t.requests();
    t.done(&r[0], CC_SUCCESS, 512);
    assert_eq!(
        t.command([0, 0, 0, T_STOP_EP << 10 | 3 << 16 | 1 << 24]),
        (CC_SUCCESS, 1)
    );
    let _ = c;
    assert!(t.requests().is_empty(), "nothing to cancel");
}

#[test]
fn a_halted_td_after_a_link_trb_is_where_its_first_trb_is() {
    // Linux finds the new dequeue state by walking from the controller's (usbtest 10 found it):
    // that must be the TD's first TRB, past the Link TRB before it, with its cycle.
    let mut t = configured();
    for _ in 0..15 {
        t.trb(BULK_IN, [BUF as u32, 0, 64, T_NORMAL << 10 | C_IOC | C_ISP]);
    }
    t.wr(DBOFF + 4, 3);
    for q in t.requests() {
        t.done(&q, CC_SUCCESS, 64);
    }
    assert_eq!(t.events().len(), 15);
    let a = t.trb(BULK_IN, [BUF as u32, 0, 64, T_NORMAL << 10 | C_IOC | C_ISP]);
    assert_eq!(a, BULK_IN);
    t.wr(DBOFF + 4, 3);
    let r = t.requests();
    t.done(&r[0], CC_STALL, 0);
    assert_eq!(transfer(&t.events()[0]).1, CC_STALL);
    assert_eq!(
        t.ep_deq(3),
        BULK_IN,
        "the ring's start, cycle 0 (toggled by the Link TRB)"
    );
}
