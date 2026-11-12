//! An xHCI host controller (xHCI 1.2, written from Intel's public
//! specification; Linux's `xhci-plat-hcd` is the driver it must satisfy),
//! bus-agnostic behind its 64 KiB register window, as a DT `generic-xhci`
//! node (docs/usb.md). The core owns the registers and everything in guest
//! memory: the command ring, the transfer rings, the device contexts, the
//! event ring and its segment table. The devices are the host's backends
//! (web/usb.ts), which never see a TRB:
//!
//! - A doorbell walks the endpoint's transfer ring and posts each transfer
//!   descriptor (TD) to the **request ring** as one record: its tag, the
//!   connector and endpoint, the setup packet of a control transfer, and the
//!   data as (RAM offset, length) segments (immediate data inline).
//! - The backend moves the data and posts {tag, completion code, bytes} to the
//!   **completion ring**, then sets `vm::SIGNAL_DEVICE`. The run loop drains it
//!   into Transfer Events on the TD's TRBs (short packets on the TRB where the
//!   data ended, with the residual) and drives the interrupter's line (level).
//! - Port changes go the same way: the host posts an attach (connector,
//!   speed) or a detach to the completion ring, and the port's connect status
//!   changes with a Port Status Change Event, as with a real plug.
//! - Stop Endpoint, a halt and the other ways TDs leave a ring complete in the
//!   core at once; a **cancel** record tells the backend, whose late
//!   completions find no TD and are dropped.
//!
//! Anything the guest supplies is checked: a bad TRB or a ring outside RAM is
//! a TRB Error or a stopped ring, never a panic.
//!
//! Ring records are u32 words (docs/abi.md "USB"). Request: `w0` = tag |
//! generation << 24 (the connector's detach count, mod 256), `w1` =
//! connector | DCI << 8 | kind << 16, `w2` = the number of words that follow,
//! then those of the kind (`REQ_*`). Completion: three words, `w1`'s low byte
//! the kind (`CPL_*`).

use core::sync::atomic::{AtomicU32, Ordering, fence};
use std::collections::{HashMap, VecDeque};

use crate::mem::{Access, Mem};
use crate::snapshot::{self, Reader, Writer};
use crate::virtio::WordRing;

/// The register window (QEMU `virt`'s platform-bus window, free here).
pub const BASE: u64 = 0x0c00_0000;
pub const SIZE: u64 = 0x1_0000;
/// The interrupter's line: the first SPI after the virtio window (INTIDs 48–79).
pub const IRQ: usize = 80;
/// Root connectors; each has a USB 2 port (1–4) and a USB 3 port (5–8).
pub const CONNECTORS: usize = 4;
const PORTS: usize = 2 * CONNECTORS;
pub const MAX_SLOTS: usize = 32;
/// `VmConfig.xhci`: USB 2 ports | USB 3 ports << 8; only these counts are built.
pub const CONFIG: u64 = CONNECTORS as u64 | (CONNECTORS as u64) << 8;
/// TDs posted to the backend and not completed, at most (the completion ring holds three words each).
const MAX_TDS: usize = 1024;
/// TRBs one TD may have (links included).
const MAX_TD_TRBS: usize = 1024;
/// TDs one walk reads before the endpoint waits for the next chunk boundary: a ring of No-Ops
/// linked to itself is a TD for ever.
const WALK_TDS: usize = 256;
/// Events kept for the event ring at most; past it the controller reports a host system error
/// (USBSTS.HSE) and drops them. Commands and walks wait for room long before.
pub const MAX_PENDING: usize = 4096;
/// The least time between posting a TD and its events, unless the vCPUs are idle (then at once).
/// A device that answers before the guest's CPU has moved on would keep it in its interrupt
/// handler for good: a URB resubmitted from its completion (usbtest's unlink tests) starves
/// process context, where a real device takes a microframe or more (docs/usb.md "Latency").
pub const LATENCY_NS: u64 = 125_000;
/// The `DEVICE` exit's slot for the xHCI (past the virtio transports').
pub const EXIT_SLOT: u64 = 32;

/// `XhciShared::events`: records in the request ring.
pub const EV_REQUEST: u32 = 1;

// Request kinds (`w1` >> 16).
pub const REQ_TRANSFER: u32 = 0;
pub const REQ_RESET: u32 = 1;
pub const REQ_CANCEL: u32 = 2;
pub const REQ_CONFIGURED: u32 = 3;
pub const REQ_CLEAR_HALT: u32 = 4;
// Completion kinds (`w1` & 0xff).
pub const CPL_DONE: u32 = 0;
pub const CPL_ATTACH: u32 = 1;
pub const CPL_DETACH: u32 = 2;
/// A segment of immediate data: its length word has this bit (its offset word is 0), and two
/// words of bytes follow.
pub const SEG_IMMEDIATE: u32 = 1 << 31;
/// A segment's memory (0, or a spill memory's index: docs/spill-memories.md) in its length word's bits
/// 27:24 (a TRB's length has 17 bits); the offset is in that memory, from memory 0's first RAM byte for 0.
pub const SEG_MEM_SHIFT: u32 = 24;

// Completion codes (xHCI 1.2 §6.4.5).
pub const CC_SUCCESS: u32 = 1;
pub const CC_BABBLE: u32 = 3;
pub const CC_TRANSACTION: u32 = 4;
pub const CC_TRB: u32 = 5;
pub const CC_STALL: u32 = 6;
const CC_NO_SLOTS: u32 = 9;
const CC_SLOT_NOT_ENABLED: u32 = 11;
const CC_EP_NOT_ENABLED: u32 = 12;
pub const CC_SHORT: u32 = 13;
const CC_PARAMETER: u32 = 17;
const CC_CONTEXT_STATE: u32 = 19;
const CC_RING_STOPPED: u32 = 24;
const CC_STOPPED: u32 = 26;

// TRB types.
const T_NORMAL: u32 = 1;
const T_SETUP: u32 = 2;
const T_DATA: u32 = 3;
const T_STATUS: u32 = 4;
const T_ISOCH: u32 = 5;
const T_LINK: u32 = 6;
const T_EVENT_DATA: u32 = 7;
const T_NOOP: u32 = 8;
const T_ENABLE_SLOT: u32 = 9;
const T_DISABLE_SLOT: u32 = 10;
const T_ADDRESS: u32 = 11;
const T_CONFIGURE: u32 = 12;
const T_EVALUATE: u32 = 13;
const T_RESET_EP: u32 = 14;
const T_STOP_EP: u32 = 15;
const T_SET_DEQ: u32 = 16;
const T_RESET_DEVICE: u32 = 17;
const T_NOOP_CMD: u32 = 23;
const T_TRANSFER_EVENT: u32 = 32;
const T_COMMAND_EVENT: u32 = 33;
const T_PORT_EVENT: u32 = 34;

// TRB control bits.
const C_CYCLE: u32 = 1;
const C_ENT_TC: u32 = 2; // a Link TRB's Toggle Cycle
const C_ISP: u32 = 4;
const C_CH: u32 = 1 << 4;
const C_IOC: u32 = 1 << 5;
const C_IDT: u32 = 1 << 6;
const C_BEI: u32 = 1 << 9;
const C_BSR: u32 = 1 << 9; // Address Device's Block Set Address Request
const C_DC: u32 = 1 << 9; // Configure Endpoint's Deconfigure

// Register blocks.
const CAPLENGTH: u64 = 0x40;
const RTSOFF: u64 = 0x1000;
const DBOFF: u64 = 0x2000;
const XECP: u64 = 0x800;
const PORT_REGS: u64 = CAPLENGTH + 0x400;

// USBCMD, USBSTS.
const CMD_RS: u32 = 1;
const CMD_HCRST: u32 = 2;
const CMD_INTE: u32 = 4;
/// Controller Save State and Controller Restore State: commands, read as 0.
const CMD_CSS: u32 = 1 << 8;
const CMD_CRS: u32 = 1 << 9;
const CMD_MASK: u32 = 0x3c0f; // R/S, HCRST, INTE, HSEE, LHCRST, EWE, EU3S, CME…
const STS_HCH: u32 = 1;
const STS_HSE: u32 = 1 << 2;
const STS_EINT: u32 = 1 << 3;
const STS_PCD: u32 = 1 << 4;
/// Save/Restore Error: a CRS with no state to restore.
const STS_SRE: u32 = 1 << 10;

// PORTSC.
const P_CCS: u32 = 1;
const P_PED: u32 = 1 << 1;
const P_PR: u32 = 1 << 4;
const P_PLS_SHIFT: u32 = 5;
const P_PLS: u32 = 0xf << P_PLS_SHIFT;
const P_PP: u32 = 1 << 9;
const P_SPEED_SHIFT: u32 = 10;
const P_LWS: u32 = 1 << 16;
const P_CSC: u32 = 1 << 17;
const P_WRC: u32 = 1 << 19;
const P_PRC: u32 = 1 << 21;
const P_PLC: u32 = 1 << 22;
const P_CHANGES: u32 = 0x7f << 17; // CSC PEC WRC OCC PRC PLC CEC
const P_WAKE: u32 = 7 << 25; // WCE WDE WOE
const P_WPR: u32 = 1 << 31;
const PLS_U0: u32 = 0;
const PLS_U3: u32 = 3;
const PLS_RX_DETECT: u32 = 5;
const PLS_POLLING: u32 = 7;
const PLS_RESUME: u32 = 15;

// Endpoint and slot states (output context).
const EP_DISABLED: u32 = 0;
const EP_RUNNING: u32 = 1;
const EP_HALTED: u32 = 2;
const EP_STOPPED: u32 = 3;
const SLOT_DEFAULT: u32 = 1;
const SLOT_ADDRESSED: u32 = 2;
const SLOT_CONFIGURED: u32 = 3;
const EP_CONTROL: u32 = 4;

/// Port speed IDs (the default PSIs): what an attach carries.
pub const SPEED_FULL: u32 = 1;
pub const SPEED_LOW: u32 = 2;
pub const SPEED_HIGH: u32 = 3;
pub const SPEED_SUPER: u32 = 4;

/// What the host and the core exchange (`vm_xhci`). `repr(C)`: events 0,
/// request ring 8, completion ring 8 + 8 + 4·RING_WORDS.
#[repr(C)]
pub struct XhciShared {
    /// `EV_REQUEST` when the core posted records; the host takes it (swap with 0).
    pub events: AtomicU32,
    pub pad: AtomicU32,
    pub req: WordRing,
    pub cpl: WordRing,
}

impl Default for XhciShared {
    fn default() -> Self {
        XhciShared {
            events: AtomicU32::new(0),
            pad: AtomicU32::new(0),
            req: WordRing::default(),
            cpl: WordRing::default(),
        }
    }
}

/// A position on a ring: the TRB's address and the cycle bit it must have.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Pos {
    at: u64,
    cycle: bool,
}

/// One TRB of a TD, as the completion needs it.
#[derive(Clone, Copy, Debug)]
struct Trb {
    at: u64,
    kind: u32,
    /// The transfer length (data TRBs), or the Event Data TRB's parameter.
    len: u32,
    param: u64,
    ctl: u32,
}

impl Trb {
    fn data(&self) -> bool {
        matches!(self.kind, T_NORMAL | T_DATA | T_ISOCH)
    }
}

#[derive(Clone, Debug)]
struct Td {
    tag: u32,
    trbs: Vec<Trb>,
    start: Pos,
    next: Pos,
    /// The completion, once there is one (TDs complete in order).
    done: Option<(u32, u32)>,
    /// Posted to the backend (not a local completion).
    posted: bool,
    /// When (ns of machine time): its events come `LATENCY_NS` after.
    at: u64,
}

#[derive(Clone, Debug, Default)]
struct Ep {
    state: u32,
    ty: u32,
    max_packet: u32,
    interval: u32,
    /// The dequeue pointer: the first TRB of the oldest TD not completed.
    deq: Pos,
    /// Where the next TD is read from.
    walk: Pos,
    inflight: VecDeque<Td>,
    /// Stopped walking at `MAX_TDS`: walks again after completions.
    more: bool,
}

#[derive(Clone, Debug, Default)]
struct Slot {
    enabled: bool,
    /// The root port (1–8) Address Device named, 0 before.
    port: u8,
    /// The output device context (DCBAA[slot] at Address Device).
    ctx: u64,
    eps: [Ep; 32],
}

#[derive(Clone, Copy, Debug, Default)]
struct Port {
    portsc: u32,
    pmsc: u32,
    /// A device is attached (its speed in PORTSC).
    attached: bool,
    /// No port reset since the attach: the first one stays here (the device was just opened).
    fresh: bool,
}

/// A record for the request ring, waiting for room in order.
struct Record {
    tag: u32,
    words: Vec<u32>,
}

/// An event waiting for the event ring, and whether it interrupts.
type Event = ([u32; 4], bool);

/// What CSS keeps (`Xhci::saved`): the segment table (base, TRBs) and the event ring's producer.
type Saved = (Vec<(u64, u32)>, (usize, u32, bool));

/// The controller: its registers, slots, rings and ports. The shared half is `XhciShared`.
pub struct Xhci {
    usbcmd: u32,
    usbsts: u32,
    dnctrl: u32,
    config: u32,
    dcbaap: u64,
    crcr: Pos,
    crr: bool,
    ports: [Port; PORTS],
    gens: [u8; CONNECTORS],
    slots: Vec<Slot>,
    // Interrupter 0.
    iman: u32,
    imod: u32,
    erstsz: u32,
    erstba: u64,
    erdp: u64,
    ehb: bool,
    /// The segment table as read when ERSTBA was written: (base, TRBs).
    erst: Vec<(u64, u32)>,
    /// The event ring's producer: segment, index in it, cycle.
    enq: (usize, u32, bool),
    /// Events that didn't fit the event ring (or came while halted), in order.
    pending: VecDeque<Event>,
    /// An interrupting event was written while EHB was set.
    irq_pending: bool,
    /// What Controller Save State kept for Controller Restore State: the segment table as read
    /// then and the event ring's producer. A driver's resume writes ERSTBA again (Linux's
    /// `xhci_restore_registers`), which starts the ring over; CRS puts the producer back where
    /// the guest's ERDP expects it.
    saved: Option<Saved>,
    next_tag: u32,
    /// Tag → (slot, DCI) of every TD in flight.
    tags: HashMap<u32, (usize, usize)>,
    outbox: VecDeque<Record>,
    /// Halves of 64-bit registers written low first.
    lo: [u32; 4],
    /// The machine's time at the call into the controller (ns).
    now: u64,
    /// TDs complete without waiting for their latency (an idle machine, a stop, a detach).
    force: bool,
    /// The earliest time a completed TD waits for (u64::MAX: none).
    due: u64,
    /// `LATENCY_NS`, or another (the unit tests' 0).
    pub latency: u64,
    /// An endpoint waits to walk on (`Ep::more`): the next boundary should `tick`.
    more: bool,
    /// An endpoint waits for a TD to leave flight (`Ep::more` at `MAX_TDS`): it walks on when one
    /// does, not at the next boundary (an idle vCPU would spin on a `due` of 0 meanwhile).
    full: bool,
    /// The command ring waits for room in the event ring.
    cmd_wait: bool,
    /// Realtime mode: a command whose cancels the backend hasn't read yet completes once it has
    /// (`held`). The host sets it (`Vm`); deterministic mode, whose host serves every record before
    /// the guest runs on, needs no wait.
    pub fence: bool,
    /// The request ring's head after the last cancel record posted to it.
    cancel_mark: Option<u32>,
    /// A command's completion event, held until the backend has read every cancel record.
    held: Option<[u32; 4]>,
    /// CRCR's CS or CA came while a command was `held`: the ring stops after its completion
    /// (CRR reads 1 until then, as the command is still running).
    stop: bool,
    /// `EV_REQUEST` from a flush whose caller doesn't return it (the commands' own): the next
    /// flush returns it.
    posted: u32,
}

impl Default for Xhci {
    fn default() -> Self {
        Xhci::new()
    }
}

/// A guest value that stops a ring.
struct Bad;

impl From<crate::mem::Fault> for Bad {
    fn from(_: crate::mem::Fault) -> Bad {
        Bad
    }
}

fn read_trb(mem: &Mem, at: u64) -> Result<[u32; 4], Bad> {
    if at & 15 != 0 {
        return Err(Bad);
    }
    Ok([
        mem.read(at, 4)? as u32,
        mem.read(at + 4, 4)? as u32,
        mem.read(at + 8, 4)? as u32,
        mem.read(at + 12, 4)? as u32,
    ])
}

fn ty(t: &[u32; 4]) -> u32 {
    t[3] >> 10 & 0x3f
}

impl Xhci {
    pub fn new() -> Xhci {
        Xhci {
            usbcmd: 0,
            usbsts: STS_HCH,
            dnctrl: 0,
            config: 0,
            dcbaap: 0,
            crcr: Pos::default(),
            crr: false,
            ports: core::array::from_fn(|_| Port {
                portsc: P_PP | PLS_RX_DETECT << P_PLS_SHIFT,
                ..Port::default()
            }),
            gens: [0; CONNECTORS],
            slots: vec![Slot::default(); MAX_SLOTS + 1],
            iman: 0,
            imod: 4000,
            erstsz: 0,
            erstba: 0,
            erdp: 0,
            ehb: false,
            erst: Vec::new(),
            enq: (0, 0, true),
            pending: VecDeque::new(),
            irq_pending: false,
            saved: None,
            next_tag: 1,
            tags: HashMap::new(),
            outbox: VecDeque::new(),
            lo: [0; 4],
            now: 0,
            force: false,
            due: u64::MAX,
            latency: LATENCY_NS,
            more: false,
            full: false,
            cmd_wait: false,
            fence: false,
            cancel_mark: None,
            held: None,
            stop: false,
            posted: 0,
        }
    }

    /// The interrupter's line (level): IMAN.IP with IMAN.IE and USBCMD.INTE.
    pub fn irq(&self) -> bool {
        self.iman & 3 == 3 && self.usbcmd & CMD_INTE != 0
    }

    fn running(&self) -> bool {
        self.usbcmd & CMD_RS != 0
    }

    // ---- Registers ----

    /// Register read at `off` in the window; `None` for a size or alignment the
    /// registers don't allow (external abort). `ns` is the machine's time (MFINDEX).
    pub fn read(&mut self, off: u64, size: u32, ns: u64) -> Option<u64> {
        if !matches!(size, 1 | 2 | 4 | 8) || !off.is_multiple_of(size as u64) || off >= SIZE {
            return None;
        }
        if size == 8 {
            let lo = self.read32(off, ns) as u64;
            return Some(lo | (self.read32(off + 4, ns) as u64) << 32);
        }
        let w = self.read32(off & !3, ns) >> (8 * (off & 3));
        Some((w & (u64::MAX >> (64 - 8 * size)) as u32) as u64)
    }

    fn read32(&mut self, off: u64, ns: u64) -> u32 {
        match off {
            // CAPLENGTH, HCIVERSION 1.0
            0x00 => CAPLENGTH as u32 | 0x0100 << 16,
            // HCSPARAMS1: MaxSlots, MaxIntrs 1, MaxPorts
            0x04 => MAX_SLOTS as u32 | 1 << 8 | (PORTS as u32) << 24,
            // HCSPARAMS2: ERST Max 2^4 entries, no scratchpad buffers, IST 1 frame
            0x08 => 4 << 4 | 1 << 3 | 1,
            0x0c => 0,
            // HCCPARAMS1: AC64, NSS, MaxPSASize 0, xECP
            0x10 => 1 | 1 << 7 | ((XECP / 4) as u32) << 16,
            0x14 => DBOFF as u32,
            0x18 => RTSOFF as u32,
            0x1c => 0,
            // Operational registers.
            0x40 => self.usbcmd,
            0x44 => self.usbsts,
            0x48 => 1, // PAGESIZE: 4 KiB
            0x54 => self.dnctrl,
            0x58 => (self.crr as u32) << 3, // CRCR reads 0 but CRR
            0x5c => 0,
            0x70 => self.dcbaap as u32,
            0x74 => (self.dcbaap >> 32) as u32,
            0x78 => self.config,
            PORT_REGS..0x4c0 => {
                let (i, r) = (((off - PORT_REGS) / 16) as usize, (off - PORT_REGS) % 16);
                match r {
                    0 => self.ports[i].portsc,
                    4 => self.ports[i].pmsc,
                    _ => 0,
                }
            }
            // Supported Protocol capabilities: USB 2.0 on ports 1–4, USB 3.0 on 5–8.
            XECP => 2 | 4 << 8 | 0x02 << 24,
            0x804 | 0x814 => u32::from_le_bytes(*b"USB "),
            0x808 => 1 | (CONNECTORS as u32) << 8,
            0x810 => 2 | 0x03 << 24,
            0x818 => (CONNECTORS as u32 + 1) | (CONNECTORS as u32) << 8,
            // Runtime: MFINDEX (125 µs microframes), interrupter 0.
            RTSOFF => (ns / 125_000) as u32 & 0x3fff,
            0x1020 => self.iman,
            0x1024 => self.imod,
            0x1028 => self.erstsz,
            0x1030 => self.erstba as u32,
            0x1034 => (self.erstba >> 32) as u32,
            0x1038 => self.erdp as u32 & !0xf | (self.ehb as u32) << 3 | self.desi(),
            0x103c => (self.erdp >> 32) as u32,
            _ => 0,
        }
    }

    /// The segment ERDP points into (its DESI field).
    fn desi(&self) -> u32 {
        let p = self.erdp & !0xf;
        let i = self
            .erst
            .iter()
            .position(|&(b, n)| p >= b && p < b.wrapping_add(16 * n as u64));
        i.unwrap_or(0) as u32 & 7
    }

    /// Register write; returns `EV_REQUEST` if it posted records for the host (0: none),
    /// or `None` for a disallowed access.
    pub fn write(
        &mut self,
        off: u64,
        size: u32,
        v: u64,
        mem: &Mem,
        sh: &XhciShared,
        ns: u64,
    ) -> Option<u32> {
        if !matches!(size, 4 | 8) || !off.is_multiple_of(size as u64) || off >= SIZE {
            return None;
        }
        self.now = ns;
        if size == 8 {
            self.write32(off, v as u32, mem, sh);
            self.write32(off + 4, (v >> 32) as u32, mem, sh);
        } else {
            self.write32(off, v as u32, mem, sh);
        }
        self.write_events(mem);
        Some(self.flush(sh))
    }

    fn write32(&mut self, off: u64, v: u32, mem: &Mem, sh: &XhciShared) {
        match off {
            0x40 => self.set_usbcmd(v, mem, sh),
            0x44 => {
                // EINT, PCD, HSE, SRE are write-1-to-clear.
                self.usbsts &= !(v & (STS_EINT | STS_PCD | STS_HSE | STS_SRE));
            }
            0x54 => self.dnctrl = v & 0xffff,
            0x58 => {
                if v & 6 != 0 && self.crr && self.held.is_some() {
                    // CS or CA during a held command: it completes first, then the ring stops.
                    self.stop = true;
                } else if v & 6 != 0 && self.crr {
                    // CS or CA: the ring stops after the current command (there is none).
                    self.crr = false;
                    let p = self.crcr.at;
                    self.event(
                        [
                            p as u32,
                            (p >> 32) as u32,
                            CC_RING_STOPPED << 24,
                            T_COMMAND_EVENT << 10,
                        ],
                        true,
                    );
                } else if !self.crr {
                    self.crcr = Pos {
                        at: self.crcr.at & !0xffff_ffff | (v & !0x3f) as u64,
                        cycle: v & 1 != 0,
                    };
                }
            }
            0x5c => {
                if !self.crr {
                    self.crcr.at = self.crcr.at & 0xffff_ffff | (v as u64) << 32;
                }
            }
            0x70 => self.dcbaap = self.dcbaap & !0xffff_ffff | (v & !0x3f) as u64,
            0x74 => self.dcbaap = self.dcbaap & 0xffff_ffff | (v as u64) << 32,
            0x78 => self.config = v & 0x3ff & !0xff | (v & 0xff).min(MAX_SLOTS as u32),
            PORT_REGS..0x4c0 => {
                let (i, r) = (((off - PORT_REGS) / 16) as usize, (off - PORT_REGS) % 16);
                match r {
                    0 => self.set_portsc(i, v, sh),
                    4 => self.ports[i].pmsc = v,
                    _ => {}
                }
            }
            0x1020 => {
                self.iman = self.iman & !(v & 1) & !2 | v & 2;
            }
            0x1024 => self.imod = v,
            0x1028 => self.erstsz = v & 0xffff,
            0x1030 => self.lo[0] = v & !0x3f,
            0x1034 => {
                self.erstba = self.lo[0] as u64 | (v as u64) << 32;
                self.init_event_ring(mem);
                self.resume_commands(mem, sh);
            }
            0x1038 => {
                self.lo[1] = v & !0xf;
                if v & 8 != 0 {
                    self.ehb = false;
                }
            }
            0x103c => {
                self.erdp = self.lo[1] as u64 | (v as u64) << 32;
                self.dequeued(mem);
                self.resume_commands(mem, sh);
            }
            DBOFF.. if off < DBOFF + 4 * (MAX_SLOTS as u64 + 1) && self.running() => {
                match ((off - DBOFF) / 4) as usize {
                    0 if v & 0xff == 0 => self.commands(mem, sh),
                    0 => {}
                    n => self.doorbell(n, (v & 0xff) as usize, mem, sh),
                }
            }
            _ => {}
        }
    }

    fn set_usbcmd(&mut self, v: u32, mem: &Mem, sh: &XhciShared) {
        if v & CMD_HCRST != 0 {
            self.reset(sh);
            return;
        }
        let was = self.running();
        if !was && v & CMD_RS == 0 {
            // Save and restore state, halted only (xHCI 4.23.2): both done at once (SSS, RSS stay 0).
            if v & CMD_CSS != 0 {
                self.saved = Some((self.erst.clone(), self.enq));
                self.usbsts &= !STS_SRE;
            }
            if v & CMD_CRS != 0 {
                match self.saved.take() {
                    // The segment table the guest gave again: the producer goes on where it was.
                    Some((erst, enq)) if erst == self.erst => self.enq = enq,
                    // Nothing saved (a state from before CSS was kept), or another table: the
                    // driver initializes the controller again (Linux's resume on SRE).
                    _ => self.usbsts |= STS_SRE,
                }
            }
        }
        self.usbcmd = v & CMD_MASK & !CMD_HCRST;
        if self.running() {
            self.usbsts &= !STS_HCH;
            if !was {
                // Port changes that came while halted.
                for i in 0..PORTS {
                    if self.ports[i].portsc & P_CHANGES != 0 {
                        self.port_event(i);
                    }
                }
                // Events written now, and an interrupt for any left unread (`dequeued`).
                self.dequeued(mem);
                self.resume_commands(mem, sh);
            }
        } else {
            self.usbsts |= STS_HCH;
            self.crr = false;
        }
    }

    /// HCRST: everything but the attached devices; TDs in flight are cancelled.
    fn reset(&mut self, sh: &XhciShared) {
        for s in 1..=MAX_SLOTS {
            self.disable_eps(s, 0, true);
        }
        self.flush(sh);
        let (ports, gens, outbox, next_tag) = (
            self.ports,
            self.gens,
            core::mem::take(&mut self.outbox),
            self.next_tag,
        );
        *self = Xhci {
            gens,
            outbox,
            next_tag,
            now: self.now,
            latency: self.latency,
            fence: self.fence,
            ..Xhci::new()
        };
        for (i, p) in ports.iter().enumerate() {
            if p.attached {
                let speed = p.portsc >> P_SPEED_SHIFT & 0xf;
                self.connect(i, speed, p.fresh);
            }
        }
    }

    fn set_portsc(&mut self, i: usize, v: u32, sh: &XhciShared) {
        let usb3 = i >= CONNECTORS;
        let p = &mut self.ports[i];
        let old = p.portsc;
        p.portsc &= !(v & P_CHANGES);
        p.portsc = p.portsc & !P_WAKE | v & P_WAKE;
        if v & P_PED != 0 {
            p.portsc &= !P_PED;
            if !usb3 && p.attached {
                p.portsc = p.portsc & !P_PLS | PLS_POLLING << P_PLS_SHIFT;
            }
        }
        let warm = usb3 && v & P_WPR != 0;
        if v & P_PR != 0 || warm {
            if p.attached {
                p.portsc = p.portsc & !P_PLS | P_PED | PLS_U0 << P_PLS_SHIFT;
                if core::mem::take(&mut p.fresh) {
                    // The device was just opened: this reset is the attach's.
                } else {
                    let c = i % CONNECTORS;
                    let w0 = (self.gens[c] as u32) << 24;
                    self.outbox.push_back(Record {
                        tag: 0,
                        words: vec![w0, c as u32 | REQ_RESET << 16, 0],
                    });
                }
            }
            let p = &mut self.ports[i];
            p.portsc |= P_PRC | if warm { P_WRC } else { 0 };
        }
        let p = &mut self.ports[i];
        if v & P_LWS != 0 && p.attached {
            let pls = v >> P_PLS_SHIFT & 0xf;
            let cur = p.portsc >> P_PLS_SHIFT & 0xf;
            let to = match (pls, cur) {
                (PLS_U0, PLS_U3 | PLS_RESUME) => {
                    p.portsc |= P_PLC;
                    Some(PLS_U0)
                }
                (PLS_U3, PLS_U0) => Some(PLS_U3),
                (PLS_RESUME, PLS_U3) if !usb3 => Some(PLS_RESUME),
                (PLS_RX_DETECT, _) if usb3 => Some(PLS_RX_DETECT),
                _ => None,
            };
            if let Some(to) = to {
                p.portsc = p.portsc & !P_PLS | to << P_PLS_SHIFT;
            }
        }
        if self.ports[i].portsc & P_CHANGES & !old != 0 {
            self.port_event(i);
        }
        let _ = sh;
    }

    /// A Port Status Change Event for port index `i` (and USBSTS.PCD).
    fn port_event(&mut self, i: usize) {
        self.usbsts |= STS_PCD;
        if self.running() {
            self.event(
                [
                    (i as u32 + 1) << 24,
                    0,
                    CC_SUCCESS << 24,
                    T_PORT_EVENT << 10,
                ],
                true,
            );
        }
    }

    fn connect(&mut self, i: usize, speed: u32, fresh: bool) {
        let usb3 = i >= CONNECTORS;
        let p = &mut self.ports[i];
        p.attached = true;
        p.fresh = fresh;
        let (pls, ped) = if usb3 {
            (PLS_U0, P_PED)
        } else {
            (PLS_POLLING, 0)
        };
        p.portsc = P_PP
            | P_CCS
            | P_CSC
            | ped
            | pls << P_PLS_SHIFT
            | speed << P_SPEED_SHIFT
            | p.portsc & P_WAKE;
        self.port_event(i);
    }

    // ---- The event ring ----

    fn init_event_ring(&mut self, mem: &Mem) {
        let n = (self.erstsz as usize).min(16);
        self.erst.clear();
        for k in 0..n {
            let e = self.erstba.wrapping_add(16 * k as u64);
            match (mem.read(e, 8), mem.read(e + 8, 4)) {
                (Ok(b), Ok(sz)) if sz as u32 & 0xffff >= 16 => {
                    self.erst.push((b & !0x3f, sz as u32 & 0xffff))
                }
                _ => break,
            }
        }
        self.enq = (0, 0, true);
        self.write_events(mem);
    }

    fn enq_addr(&self) -> u64 {
        let (s, i, _) = self.enq;
        self.erst[s].0.wrapping_add(16 * i as u64)
    }

    fn ring_full(&self) -> bool {
        let (mut s, mut i) = (self.enq.0, self.enq.1 + 1);
        if i == self.erst[s].1 {
            (s, i) = ((s + 1) % self.erst.len(), 0);
        }
        self.erst[s].0.wrapping_add(16 * i as u64) == self.erdp & !0xf
    }

    fn event(&mut self, trb: [u32; 4], interrupt: bool) {
        if self.pending.len() >= MAX_PENDING {
            self.usbsts |= STS_HSE;
            return;
        }
        self.pending.push_back((trb, interrupt));
    }

    /// Writes waiting events while the ring has room (and the controller runs), then interrupts.
    fn write_events(&mut self, mem: &Mem) {
        if self.erst.is_empty() || !self.running() {
            return;
        }
        while let Some(&(mut trb, interrupt)) = self.pending.front() {
            if self.ring_full() {
                break;
            }
            self.pending.pop_front();
            let at = self.enq_addr();
            trb[3] = trb[3] & !C_CYCLE | self.enq.2 as u32;
            let ok = (0..3).all(|k| mem.write(at + 4 * k, 4, trb[k as usize] as u64).is_ok());
            fence(Ordering::Release);
            if !ok || mem.write(at + 12, 4, trb[3] as u64).is_err() {
                self.erst.clear(); // a segment outside RAM: no event ring until ERSTBA again
                return;
            }
            let (s, i, c) = self.enq;
            self.enq = if i + 1 < self.erst[s].1 {
                (s, i + 1, c)
            } else if s + 1 < self.erst.len() {
                (s + 1, 0, c)
            } else {
                (0, 0, !c)
            };
            if interrupt {
                self.irq_pending = true;
            }
        }
        self.interrupt();
    }

    fn interrupt(&mut self) {
        if self.irq_pending && !self.ehb {
            self.irq_pending = false;
            self.ehb = true;
            self.iman |= 1;
            self.usbsts |= STS_EINT;
        }
    }

    /// The guest moved ERDP: room for waiting events, and an interrupt if it left any unread.
    /// Halted, it only takes the position: a driver's resume writes ERDP before CRS puts the
    /// producer back (`saved`), and the ring may be another's until then.
    fn dequeued(&mut self, mem: &Mem) {
        self.write_events(mem);
        if self.running()
            && !self.ehb
            && !self.erst.is_empty()
            && self.enq_addr() != self.erdp & !0xf
        {
            self.irq_pending = true;
            self.interrupt();
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn transfer_event(
        &mut self,
        slot: usize,
        dci: usize,
        at: u64,
        cc: u32,
        len: u32,
        ed: bool,
        interrupt: bool,
    ) {
        self.event(
            [
                at as u32,
                (at >> 32) as u32,
                len & 0xff_ffff | cc << 24,
                (ed as u32) << 2
                    | T_TRANSFER_EVENT << 10
                    | (dci as u32) << 16
                    | (slot as u32) << 24,
            ],
            interrupt,
        );
    }

    // ---- Commands ----

    fn commands(&mut self, mem: &Mem, sh: &XhciShared) {
        // What the backends finished comes first (a Stop Endpoint must not cancel a TD that completed).
        self.drain(mem, sh);
        if let Some(ev) = self.held {
            if self.cancelling(sh) {
                return;
            }
            self.held = None;
            self.event(ev, true);
            if core::mem::take(&mut self.stop) {
                self.crr = false;
                let p = self.crcr.at;
                let stopped = [
                    p as u32,
                    (p >> 32) as u32,
                    CC_RING_STOPPED << 24,
                    T_COMMAND_EVENT << 10,
                ];
                self.event(stopped, true);
                self.write_events(mem);
                return;
            }
            self.write_events(mem);
            if !self.pending.is_empty() {
                self.cmd_wait = true;
                return;
            }
        }
        self.crr = true;
        let mut links = 0;
        for _ in 0..4096 {
            let at = self.crcr.at;
            let Ok(t) = read_trb(mem, at) else {
                self.crr = false;
                break;
            };
            if t[3] & C_CYCLE != self.crcr.cycle as u32 {
                break;
            }
            if ty(&t) == T_LINK {
                links += 1;
                if links > 64 {
                    self.crr = false;
                    break;
                }
                self.crcr.at = (t[0] as u64 | (t[1] as u64) << 32) & !0xf;
                if t[3] & C_ENT_TC != 0 {
                    self.crcr.cycle = !self.crcr.cycle;
                }
                continue;
            }
            links = 0;
            let (cc, slot) = self.command(&t, mem);
            let ev = [
                at as u32,
                (at >> 32) as u32,
                cc << 24,
                T_COMMAND_EVENT << 10 | (slot as u32) << 24,
            ];
            self.crcr.at = self.crcr.at.wrapping_add(16);
            if self.fence {
                // The backend may still be writing IN data into a TD this cancelled: the guest gets
                // its buffers back (this completion) only once the backend has read the cancel.
                self.posted |= self.flush(sh);
                if self.cancelling(sh) {
                    self.held = Some(ev);
                    // The backend's poll that reads it signals (`complete`); a tick looks again.
                    self.due = self.due.min(self.now.saturating_add(LATENCY_NS));
                    break;
                }
            }
            self.event(ev, true);
            self.write_events(mem);
            if !self.pending.is_empty() {
                // No room for its completion: the ring goes on when the guest makes room.
                self.cmd_wait = true;
                break;
            }
        }
        self.write_events(mem);
    }

    /// Whether the backend has cancel records it hasn't read (`fence`).
    fn cancelling(&mut self, sh: &XhciShared) -> bool {
        if self.outbox.iter().any(|r| r.words[1] >> 16 == REQ_CANCEL) {
            return true;
        }
        let Some(mark) = self.cancel_mark else {
            return false;
        };
        if (sh.req.tail.load(Ordering::Acquire).wrapping_sub(mark) as i32) < 0 {
            return true;
        }
        self.cancel_mark = None;
        false
    }

    /// A held command completes, and the ring runs on, once the backend has read the cancels.
    fn release(&mut self, mem: &Mem, sh: &XhciShared) {
        if self.held.is_some() && self.running() {
            self.commands(mem, sh);
            if self.held.is_some() {
                self.due = self.due.min(self.now.saturating_add(LATENCY_NS));
            }
        }
    }

    /// Commands that waited for room in the event ring run on, if there is room now.
    fn resume_commands(&mut self, mem: &Mem, sh: &XhciShared) {
        if self.cmd_wait && self.crr && self.running() && self.pending.is_empty() {
            self.cmd_wait = false;
            self.commands(mem, sh);
        }
    }

    /// One command: its completion code and the slot its event names.
    fn command(&mut self, t: &[u32; 4], mem: &Mem) -> (u32, usize) {
        let slot = (t[3] >> 24) as usize;
        let dci = (t[3] >> 16 & 0x1f) as usize;
        let param = t[0] as u64 | (t[1] as u64) << 32;
        let enabled = (1..=self.max_slots()).contains(&slot) && self.slots[slot].enabled;
        match ty(t) {
            T_NOOP_CMD => (CC_SUCCESS, 0),
            T_ENABLE_SLOT => match (1..=self.max_slots()).find(|&s| !self.slots[s].enabled) {
                Some(s) => {
                    self.slots[s] = Slot {
                        enabled: true,
                        ..Slot::default()
                    };
                    (CC_SUCCESS, s)
                }
                None => (CC_NO_SLOTS, 0),
            },
            T_DISABLE_SLOT | T_ADDRESS | T_CONFIGURE | T_EVALUATE | T_RESET_DEVICE | T_RESET_EP
            | T_STOP_EP | T_SET_DEQ
                if !enabled =>
            {
                (CC_SLOT_NOT_ENABLED, slot)
            }
            T_DISABLE_SLOT => {
                self.disable_eps(slot, 0, true);
                self.slots[slot] = Slot::default();
                (CC_SUCCESS, slot)
            }
            T_ADDRESS => (
                self.address(slot, param, t[3] & C_BSR != 0, mem)
                    .unwrap_or(CC_PARAMETER),
                slot,
            ),
            T_CONFIGURE => (
                self.configure(slot, param, t[3] & C_DC != 0, mem)
                    .unwrap_or(CC_PARAMETER),
                slot,
            ),
            T_EVALUATE => (
                self.evaluate(slot, param, mem).unwrap_or(CC_PARAMETER),
                slot,
            ),
            T_RESET_DEVICE => {
                if self.slot_state(slot, mem) < SLOT_DEFAULT {
                    return (CC_CONTEXT_STATE, slot);
                }
                self.disable_eps(slot, 2, false);
                self.cancel_all(slot, 1, mem);
                self.set_slot_ctx(slot, mem, |c| {
                    c[0] = c[0] & !(0x1f << 27) | 1 << 27;
                    c[3] = SLOT_DEFAULT << 27;
                });
                (CC_SUCCESS, slot)
            }
            T_RESET_EP | T_STOP_EP | T_SET_DEQ => {
                if dci == 0 || self.slots[slot].eps[dci].state == EP_DISABLED {
                    return (CC_EP_NOT_ENABLED, slot);
                }
                let ep = &self.slots[slot].eps[dci];
                let cc = match ty(t) {
                    T_RESET_EP if ep.state == EP_HALTED => {
                        self.set_ep_state(slot, dci, EP_STOPPED, mem);
                        self.record(slot, dci, REQ_CLEAR_HALT, 0, vec![]);
                        CC_SUCCESS
                    }
                    T_STOP_EP if ep.state == EP_RUNNING => self.stop(slot, dci, mem),
                    T_SET_DEQ if ep.state == EP_STOPPED => {
                        let to = Pos {
                            at: param & !0xf,
                            cycle: param & 1 != 0,
                        };
                        let ep = &mut self.slots[slot].eps[dci];
                        (ep.deq, ep.walk) = (to, to);
                        self.set_ep_state(slot, dci, EP_STOPPED, mem);
                        CC_SUCCESS
                    }
                    _ => CC_CONTEXT_STATE,
                };
                (cc, slot)
            }
            _ => (CC_TRB, slot),
        }
    }

    fn max_slots(&self) -> usize {
        (self.config & 0xff) as usize
    }

    /// The output slot context's state.
    fn slot_state(&self, slot: usize, mem: &Mem) -> u32 {
        let ctx = self.slots[slot].ctx;
        if ctx == 0 {
            return 0;
        }
        mem.read(ctx + 12, 4).map_or(0, |v| v as u32 >> 27)
    }

    fn set_slot_ctx(&self, slot: usize, mem: &Mem, f: impl FnOnce(&mut [u32; 4])) {
        let ctx = self.slots[slot].ctx;
        let mut c = [0u32; 4];
        for (k, w) in c.iter_mut().enumerate() {
            *w = mem.read(ctx + 4 * k as u64, 4).unwrap_or(0) as u32;
        }
        f(&mut c);
        for (k, &w) in c.iter().enumerate() {
            let _ = mem.write(ctx + 4 * k as u64, 4, w as u64);
        }
    }

    /// Writes an endpoint's state and dequeue pointer into the output context.
    fn set_ep_state(&mut self, slot: usize, dci: usize, state: u32, mem: &Mem) {
        let s = &mut self.slots[slot];
        s.eps[dci].state = state;
        let ctx = s.ctx + 32 * dci as u64;
        let d = s.eps[dci].deq;
        if s.ctx == 0 {
            return;
        }
        if let Ok(w0) = mem.read(ctx, 4) {
            let _ = mem.write(ctx, 4, w0 & !7 | state as u64);
        }
        let _ = mem.write(ctx + 8, 8, d.at | d.cycle as u64);
    }

    /// The input context at `param` (64-byte aligned, in RAM): its 33 32-byte contexts.
    fn input(param: u64, mem: &Mem) -> Option<Vec<[u32; 8]>> {
        if param & 0x3f != 0 {
            return None;
        }
        mem.host(param, 33 * 32, Access::Read).ok()?;
        Some(
            (0..33)
                .map(|c| {
                    core::array::from_fn(|k| {
                        mem.read(param + 32 * c + 4 * k as u64, 4).unwrap() as u32
                    })
                })
                .collect(),
        )
    }

    fn write_ctx(mem: &Mem, at: u64, c: &[u32; 8]) {
        for (k, &w) in c.iter().enumerate() {
            let _ = mem.write(at + 4 * k as u64, 4, w as u64);
        }
    }

    fn address(&mut self, slot: usize, param: u64, bsr: bool, mem: &Mem) -> Option<u32> {
        let ic = Xhci::input(param, mem)?;
        if ic[0][1] & 3 != 3 {
            return Some(CC_PARAMETER);
        }
        let state = self.slot_state(slot, mem);
        if state > SLOT_DEFAULT || state == SLOT_DEFAULT && bsr {
            return Some(CC_CONTEXT_STATE);
        }
        let port = (ic[1][1] >> 16 & 0xff) as usize;
        if !(1..=PORTS).contains(&port) {
            return Some(CC_PARAMETER);
        }
        let ctx = mem
            .read(self.dcbaap.wrapping_add(8 * slot as u64), 8)
            .ok()?
            & !0x3f;
        mem.host(ctx, 32 * 32, Access::Write).ok()?;
        let p = &self.ports[port - 1];
        if !p.attached || p.portsc & P_PED == 0 {
            return Some(CC_TRANSACTION);
        }
        self.cancel_all(slot, 1, mem);
        let s = &mut self.slots[slot];
        (s.ctx, s.port) = (ctx, port as u8);
        let mut sc = ic[1];
        sc[3] = if bsr {
            SLOT_DEFAULT << 27
        } else {
            SLOT_ADDRESSED << 27 | slot as u32
        };
        Xhci::write_ctx(mem, ctx, &sc);
        let mut e = ic[2];
        e[0] = e[0] & !7 | EP_RUNNING;
        Xhci::write_ctx(mem, ctx + 32, &e);
        let deq = Pos {
            at: (e[2] as u64 | (e[3] as u64) << 32) & !0xf,
            cycle: e[2] & 1 != 0,
        };
        s.eps[1] = Ep {
            state: EP_RUNNING,
            ty: EP_CONTROL,
            max_packet: e[1] >> 16,
            deq,
            walk: deq,
            ..Ep::default()
        };
        Some(CC_SUCCESS)
    }

    fn configure(&mut self, slot: usize, param: u64, dc: bool, mem: &Mem) -> Option<u32> {
        let state = self.slot_state(slot, mem);
        if state != SLOT_ADDRESSED && state != SLOT_CONFIGURED {
            return Some(CC_CONTEXT_STATE);
        }
        let ctx = self.slots[slot].ctx;
        if dc {
            self.disable_eps(slot, 2, false);
            for d in 2..32 {
                self.write_disabled(slot, d, mem);
            }
        } else {
            let ic = Xhci::input(param, mem)?;
            let (drop, add) = (ic[0][0], ic[0][1]);
            // All or nothing: a context it can't take leaves every endpoint as it was.
            let bad =
                |d: usize| add & 1 << d != 0 && matches!(ic[d + 1][1] >> 3 & 7, 0 | EP_CONTROL);
            if (2..32).any(bad) {
                return Some(CC_PARAMETER);
            }
            for d in 2..32 {
                if (drop | add) & 1 << d != 0 {
                    self.disable_ep(slot, d);
                    self.write_disabled(slot, d, mem);
                }
            }
            for d in 2..32 {
                if add & 1 << d == 0 {
                    continue;
                }
                let mut e = ic[d + 1];
                let t = e[1] >> 3 & 7;
                e[0] = e[0] & !7 | EP_RUNNING;
                Xhci::write_ctx(mem, ctx + 32 * d as u64, &e);
                let deq = Pos {
                    at: (e[2] as u64 | (e[3] as u64) << 32) & !0xf,
                    cycle: e[2] & 1 != 0,
                };
                self.slots[slot].eps[d] = Ep {
                    state: EP_RUNNING,
                    ty: t,
                    max_packet: e[1] >> 16,
                    interval: e[0] >> 16 & 0xff,
                    deq,
                    walk: deq,
                    ..Ep::default()
                };
            }
            if add & 1 != 0 {
                let sc = ic[1];
                self.set_slot_ctx(slot, mem, |c| c[..3].copy_from_slice(&sc[..3]));
            }
        }
        let any = (2..32).any(|d| self.slots[slot].eps[d].state != EP_DISABLED);
        let st = if any { SLOT_CONFIGURED } else { SLOT_ADDRESSED };
        self.set_slot_ctx(slot, mem, |c| c[3] = c[3] & !(0x1f << 27) | st << 27);
        let mut list = vec![];
        for (d, e) in self.slots[slot].eps.iter().enumerate().skip(2) {
            if e.state != EP_DISABLED {
                list.extend([d as u32 | e.ty << 8 | e.interval << 16, e.max_packet]);
            }
        }
        let n = list.len() as u32 / 2;
        let mut words = vec![n];
        words.extend(list);
        self.record(slot, 0, REQ_CONFIGURED, 0, words);
        Some(CC_SUCCESS)
    }

    fn write_disabled(&self, slot: usize, d: usize, mem: &Mem) {
        let at = self.slots[slot].ctx + 32 * d as u64;
        if let Ok(w0) = mem.read(at, 4) {
            let _ = mem.write(at, 4, w0 & !7);
        }
    }

    fn evaluate(&mut self, slot: usize, param: u64, mem: &Mem) -> Option<u32> {
        let ic = Xhci::input(param, mem)?;
        let ctx = self.slots[slot].ctx;
        if ctx == 0 {
            return Some(CC_CONTEXT_STATE);
        }
        let add = ic[0][1];
        if add & 1 != 0 {
            let sc = ic[1];
            self.set_slot_ctx(slot, mem, |c| {
                c[1] = c[1] & !0xffff | sc[1] & 0xffff;
                c[2] = c[2] & 0x3f_ffff | sc[2] & !0x3f_ffff;
            });
        }
        if add & 2 != 0 {
            let mp = ic[2][1] >> 16;
            self.slots[slot].eps[1].max_packet = mp;
            if let Ok(w1) = mem.read(ctx + 36, 4) {
                let _ = mem.write(ctx + 36, 4, w1 & 0xffff | (mp as u64) << 16);
            }
        }
        Some(CC_SUCCESS)
    }

    /// Stop Endpoint: the TDs in flight leave the backend (a cancel record), the oldest gets a
    /// Stopped event, and the dequeue pointer goes back to it, so that the guest's next doorbell
    /// (after it moved the dequeue pointer past what it cancelled) posts the rest again.
    fn stop(&mut self, slot: usize, dci: usize, mem: &Mem) -> u32 {
        // What the device finished counts as finished, latency or not.
        self.force = true;
        self.settle(slot, dci, mem);
        self.force = false;
        if self.slots[slot].eps[dci].state == EP_HALTED {
            // It halted on what it finished: halted, as Linux's Reset Endpoint expects.
            return CC_CONTEXT_STATE;
        }
        if let Some(td) = self.slots[slot].eps[dci].inflight.front() {
            let first = td.trbs.iter().find(|t| t.kind != T_LINK).copied();
            if let Some(t) = first {
                let len = if t.data() { t.len } else { 0 };
                self.transfer_event(slot, dci, t.at, CC_STOPPED, len, false, true);
            }
        }
        self.cancel_all(slot, dci, mem);
        self.set_ep_state(slot, dci, EP_STOPPED, mem);
        CC_SUCCESS
    }

    /// Takes every TD of an endpoint out of flight without events: the dequeue pointer goes
    /// back to the oldest, and the backend gets a cancel record for those it has.
    fn cancel_all(&mut self, slot: usize, dci: usize, _mem: &Mem) {
        let ep = &mut self.slots[slot].eps[dci];
        if let Some(td) = ep.inflight.front() {
            ep.deq = td.start;
        }
        ep.walk = ep.deq;
        ep.more = false;
        let tds: Vec<Td> = ep.inflight.drain(..).collect();
        let mut tags = vec![];
        for td in tds {
            self.tags.remove(&td.tag);
            if !td.posted {
                continue;
            }
            // Not posted yet: it leaves the outbox instead.
            if let Some(i) = self.outbox.iter().position(|r| r.tag == td.tag) {
                self.outbox.remove(i);
            } else {
                tags.push(td.tag);
            }
        }
        if !tags.is_empty() {
            let mut words = vec![tags.len() as u32];
            words.extend(tags);
            self.record(slot, dci, REQ_CANCEL, 0, words);
        }
    }

    fn disable_ep(&mut self, slot: usize, d: usize) {
        if self.slots[slot].eps[d].state == EP_DISABLED {
            return;
        }
        // Dummy memory: nothing is written for a disabled endpoint but the cancel record.
        let ep = &mut self.slots[slot].eps[d];
        let tds: Vec<Td> = ep.inflight.drain(..).collect();
        *ep = Ep::default();
        let mut tags = vec![];
        for td in tds {
            self.tags.remove(&td.tag);
            if !td.posted {
                continue;
            }
            if let Some(i) = self.outbox.iter().position(|r| r.tag == td.tag) {
                self.outbox.remove(i);
            } else {
                tags.push(td.tag);
            }
        }
        if !tags.is_empty() {
            let mut words = vec![tags.len() as u32];
            words.extend(tags);
            self.record(slot, d, REQ_CANCEL, 0, words);
        }
    }

    /// Disables endpoints `from`..31 of a slot (0: all), with cancel records for their TDs
    /// unless the slot's device is gone (`quiet`: Disable Slot after a detach, HCRST).
    fn disable_eps(&mut self, slot: usize, from: usize, _quiet: bool) {
        for d in from.max(1)..32 {
            self.disable_ep(slot, d);
        }
    }

    // ---- Transfers ----

    /// The connector and generation of a slot's device, if its port has one.
    fn device_of(&self, slot: usize) -> Option<(usize, u8)> {
        let p = self.slots[slot].port as usize;
        if p == 0 || !self.ports[p - 1].attached {
            return None;
        }
        let c = (p - 1) % CONNECTORS;
        Some((c, self.gens[c]))
    }

    fn record(&mut self, slot: usize, dci: usize, kind: u32, tag: u32, mut words: Vec<u32>) {
        let Some((c, g)) = self.device_of(slot) else {
            return;
        };
        let mut w = vec![
            tag | (g as u32) << 24,
            c as u32 | (dci as u32) << 8 | kind << 16,
            words.len() as u32,
        ];
        w.append(&mut words);
        self.outbox.push_back(Record { tag, words: w });
    }

    /// Moves waiting records into the request ring, in order, as far as there is room.
    fn flush(&mut self, sh: &XhciShared) -> u32 {
        let mut ev = core::mem::take(&mut self.posted);
        while let Some(r) = self.outbox.front() {
            if !sh.req.push(&r.words) {
                break;
            }
            if r.words[1] >> 16 == REQ_CANCEL {
                self.cancel_mark = Some(sh.req.head.load(Ordering::Relaxed));
            }
            self.outbox.pop_front();
            ev = EV_REQUEST;
        }
        if ev != 0 {
            sh.events.fetch_or(ev, Ordering::AcqRel);
        }
        ev
    }

    fn doorbell(&mut self, slot: usize, dci: usize, mem: &Mem, sh: &XhciShared) {
        if !(1..=self.max_slots()).contains(&slot)
            || !(1..32).contains(&dci)
            || !self.slots[slot].enabled
        {
            return;
        }
        self.drain(mem, sh);
        let ep = &mut self.slots[slot].eps[dci];
        if ep.state == EP_STOPPED {
            ep.state = EP_RUNNING;
            self.set_ep_state(slot, dci, EP_RUNNING, mem);
        }
        self.walk(slot, dci, mem);
        self.write_events(mem);
    }

    /// Reads the TDs the guest made available on a running endpoint and posts them.
    fn walk(&mut self, slot: usize, dci: usize, mem: &Mem) {
        for n in 0.. {
            let ep = &self.slots[slot].eps[dci];
            if ep.state != EP_RUNNING {
                return;
            }
            // Room in flight, a bound per walk and room for the events: else on at the next boundary.
            if self.tags.len() >= MAX_TDS {
                self.slots[slot].eps[dci].more = true;
                self.full = true;
                return;
            }
            if n >= WALK_TDS || self.pending.len() >= WALK_TDS {
                self.slots[slot].eps[dci].more = true;
                self.more = true;
                return;
            }
            let control = ep.ty == EP_CONTROL;
            let start = ep.walk;
            let (trbs, first, next, bad) = match read_td(mem, start, control) {
                Ok(None) => return,
                Ok(Some((trbs, first, next))) => (trbs, first, next, false),
                Err(at) => (
                    vec![Trb {
                        at,
                        kind: T_NORMAL,
                        len: 0,
                        param: 0,
                        ctl: C_IOC,
                    }],
                    start,
                    start,
                    true,
                ),
            };
            // The next tag no TD in flight has (a long-held IN TD keeps its own for good).
            let mut tag = self.next_tag;
            while self.tags.contains_key(&tag) {
                tag = if tag + 1 >= 1 << 24 { 1 } else { tag + 1 };
            }
            self.next_tag = if tag + 1 >= 1 << 24 { 1 } else { tag + 1 };
            let mut td = Td {
                tag,
                trbs,
                start: first,
                next,
                done: None,
                posted: false,
                at: 0,
            };
            if bad {
                td.done = Some((CC_TRB, 0));
            } else if !td.trbs.iter().any(|t| t.data() || t.kind == T_SETUP) {
                td.done = Some((CC_SUCCESS, 0)); // No-Ops and Event Data only
            } else if self.device_of(slot).is_none() {
                td.done = Some((CC_TRANSACTION, 0)); // nothing answers on that port
            } else if let Some(words) = self
                .request(slot, dci, &td, mem)
                .filter(|w| w.len() + 3 <= crate::virtio::RING_WORDS)
            {
                (td.posted, td.at) = (true, self.now);
                self.record(slot, dci, REQ_TRANSFER, tag, words);
            } else {
                td.done = Some((CC_TRB, 0));
            }
            self.tags.insert(tag, (slot, dci));
            let ep = &mut self.slots[slot].eps[dci];
            ep.walk = next;
            ep.inflight.push_back(td);
            self.settle(slot, dci, mem);
            if bad {
                return;
            }
        }
    }

    /// A TD's request words after `w1`: segment count | endpoint type << 16, length, the setup
    /// packet (control), then the segments. `None` if a buffer isn't in RAM.
    fn request(&self, slot: usize, dci: usize, td: &Td, mem: &Mem) -> Option<Vec<u32>> {
        let ep = &self.slots[slot].eps[dci];
        let mut w = vec![0, 0];
        let mut setup = None;
        for t in &td.trbs {
            if t.kind == T_SETUP {
                if t.ctl & C_IDT == 0 || t.len != 8 {
                    return None;
                }
                setup = Some(t.param);
            }
        }
        if dci == 1 && setup.is_none() {
            return None; // a control transfer without its setup stage
        }
        let data = td.trbs.iter().filter(|t| t.data()).count();
        let into = match setup {
            Some(s) => s & 0x80 != 0,
            None => dci & 1 == 1,
        };
        if let Some(s) = setup {
            w.extend([s as u32, (s >> 32) as u32]);
        }
        let (mut n, mut total) = (0u32, 0u32);
        for t in td.trbs.iter().filter(|t| t.data()) {
            if t.ctl & C_IDT != 0 {
                // Immediate data is a TD of one TRB (xHCI 1.2 §4.11.2.2's rule for Normal TRBs).
                if into || t.len > 8 || data > 1 {
                    return None;
                }
                w.extend([
                    0,
                    t.len | SEG_IMMEDIATE,
                    t.param as u32,
                    (t.param >> 32) as u32,
                ]);
            } else {
                // A zero-length TRB (Linux's zero-length packet) may point anywhere.
                let (m, off) = if t.len == 0 {
                    (0, 0)
                } else {
                    mem.ram_offset(t.param, t.len as u64)?
                };
                w.extend([off as u32, t.len | (m as u32) << SEG_MEM_SHIFT]);
            }
            n += 1;
            total = total.checked_add(t.len)?;
        }
        w[0] = n | ep.ty << 16 | (setup.is_some() as u32) << 24;
        w[1] = total;
        Some(w)
    }

    /// Completes the endpoint's oldest TDs while they are done: their events, the dequeue
    /// pointer past them, and on an error a halt (the rest leave the backend).
    fn settle(&mut self, slot: usize, dci: usize, mem: &Mem) {
        loop {
            let ep = &mut self.slots[slot].eps[dci];
            let Some(td) = ep.inflight.front() else {
                return;
            };
            let Some((cc, actual)) = td.done else {
                return;
            };
            let due = td.at.saturating_add(self.latency);
            if td.posted && !self.force && self.now < due {
                self.due = self.due.min(due);
                return;
            }
            let td = ep.inflight.pop_front().unwrap();
            self.tags.remove(&td.tag);
            let err = self.events_of(slot, dci, &td, cc, actual);
            let isoch = matches!(self.slots[slot].eps[dci].ty, 1 | 5);
            if err && !isoch {
                // Halted on the TD: the TDs after it leave the backend, and the guest resets the
                // endpoint and moves the dequeue pointer (or rings again to retry it).
                self.cancel_all(slot, dci, mem);
                let ep = &mut self.slots[slot].eps[dci];
                (ep.deq, ep.walk) = (td.start, td.start);
                self.set_ep_state(slot, dci, EP_HALTED, mem);
                return;
            }
            let ep = &mut self.slots[slot].eps[dci];
            ep.deq = td.next;
            if ep.inflight.is_empty() {
                ep.deq = ep.walk;
            }
        }
    }

    /// The Transfer Events of a TD that completed with `cc` after `actual` bytes; true if it
    /// ended in an error (the endpoint halts).
    fn events_of(&mut self, slot: usize, dci: usize, td: &Td, cc: u32, actual: u32) -> bool {
        let err = !matches!(cc, CC_SUCCESS | CC_SHORT);
        let mut left = actual;
        let mut short = false; // the short packet came: data TRBs after it are skipped
        let mut reported = false;
        let mut edtla = 0u32;
        let payload: Vec<usize> = (0..td.trbs.len()).filter(|&i| td.trbs[i].data()).collect();
        let last_data = payload.last().copied();
        let status = td.trbs.iter().position(|t| t.kind == T_STATUS);
        for (i, t) in td.trbs.iter().enumerate() {
            let ioc = t.ctl & C_IOC != 0;
            let irq = t.ctl & C_BEI == 0;
            match t.kind {
                T_NORMAL | T_DATA | T_ISOCH => {
                    if short {
                        continue;
                    }
                    let n = left.min(t.len);
                    left -= n;
                    edtla += n;
                    let residual = t.len - n;
                    if err && (n < t.len || Some(i) == last_data) {
                        self.transfer_event(slot, dci, t.at, cc, residual, false, true);
                        return true;
                    }
                    if n < t.len {
                        short = true;
                        if t.ctl & (C_ISP | C_IOC) != 0 {
                            self.transfer_event(
                                slot,
                                dci,
                                t.at,
                                CC_SHORT,
                                residual,
                                false,
                                irq || t.ctl & C_ISP != 0,
                            );
                            reported = true;
                        }
                    } else if ioc {
                        self.transfer_event(slot, dci, t.at, CC_SUCCESS, 0, false, irq);
                    }
                }
                T_SETUP => {
                    if err && last_data.is_none() && status.is_none() {
                        self.transfer_event(slot, dci, t.at, cc, 0, false, true);
                        return true;
                    }
                    if ioc && !err {
                        self.transfer_event(slot, dci, t.at, CC_SUCCESS, 0, false, irq);
                    }
                }
                T_STATUS => {
                    if err {
                        // A stall or error with no data stage is the status stage's.
                        self.transfer_event(slot, dci, t.at, cc, 0, false, true);
                        return true;
                    }
                    short = false;
                    if ioc {
                        self.transfer_event(slot, dci, t.at, CC_SUCCESS, 0, false, irq);
                    }
                }
                T_EVENT_DATA => {
                    if ioc && !short {
                        let code = if err { cc } else { CC_SUCCESS };
                        self.transfer_event(slot, dci, t.param, code, edtla, true, irq);
                    }
                    edtla = 0;
                }
                _ => {
                    if ioc && !err {
                        self.transfer_event(slot, dci, t.at, CC_SUCCESS, 0, false, irq);
                    }
                }
            }
        }
        if err {
            // An error past the TD's data (none of its TRBs took it): the last TRB's.
            let t = td.trbs.last().unwrap();
            self.transfer_event(slot, dci, t.at, cc, 0, false, true);
            return true;
        }
        if short && !reported && status.is_none() {
            // A short packet on a TRB without ISP: the TD's interrupting TRB says so.
            if let Some(t) = td.trbs.iter().rev().find(|t| t.ctl & C_IOC != 0) {
                let len = if t.data() { t.len } else { 0 };
                self.transfer_event(slot, dci, t.at, CC_SHORT, len, false, true);
            }
        }
        false
    }

    // ---- The backend's side ----

    /// The earliest time (ns) a completed TD waits for its latency; u64::MAX if none waits.
    pub fn due(&self) -> u64 {
        if self.walks_on() { 0 } else { self.due }
    }

    /// An endpoint waits to walk on and could: a bound of the last walk, or a TD left flight.
    fn walks_on(&self) -> bool {
        self.more || self.full && self.tags.len() < MAX_TDS
    }

    /// Walks on the endpoints that stopped for room (`Ep::more`).
    fn rewalk(&mut self, mem: &Mem) {
        if !self.walks_on() {
            return;
        }
        (self.more, self.full) = (false, false);
        for s in 1..=MAX_SLOTS {
            if !self.slots[s].enabled {
                continue;
            }
            for d in 1..32 {
                if core::mem::take(&mut self.slots[s].eps[d].more) {
                    self.walk(s, d, mem);
                }
            }
        }
    }

    /// Gives the completed TDs their events once their latency passed, or all of them with
    /// `force` (the machine is idle: nothing would run meanwhile). Returns `EV_REQUEST` if that
    /// posted records (a halt's cancels).
    pub fn tick(&mut self, ns: u64, force: bool, mem: &Mem, sh: &XhciShared) -> u32 {
        self.now = ns;
        self.force = force;
        self.due = u64::MAX;
        for s in 1..=MAX_SLOTS {
            if !self.slots[s].enabled {
                continue;
            }
            for d in 1..32 {
                if self.slots[s].eps[d]
                    .inflight
                    .front()
                    .is_some_and(|t| t.done.is_some())
                {
                    self.settle(s, d, mem);
                }
            }
        }
        self.force = false;
        self.rewalk(mem);
        self.release(mem, sh);
        self.write_events(mem);
        self.flush(sh)
    }

    /// Takes the backend's completions and port changes; returns `EV_REQUEST` if that posted
    /// records (walks that had waited for room, cancels).
    pub fn complete(&mut self, mem: &Mem, sh: &XhciShared, ns: u64) -> u32 {
        self.now = ns;
        self.drain(mem, sh);
        // Endpoints that stopped walking for room walk again.
        self.rewalk(mem);
        self.release(mem, sh);
        self.write_events(mem);
        self.flush(sh)
    }

    fn drain(&mut self, mem: &Mem, sh: &XhciShared) {
        let mut touched = vec![];
        while let Some([w0, w1, w2]) = sh.cpl.pop::<3>() {
            match w1 & 0xff {
                CPL_DONE => {
                    let tag = w0 & 0xff_ffff;
                    let Some(&(slot, dci)) = self.tags.get(&tag) else {
                        continue; // cancelled
                    };
                    let Some((c, g)) = self.device_of(slot) else {
                        continue;
                    };
                    if (w0 >> 24) as u8 != g || c >= CONNECTORS {
                        continue;
                    }
                    let ep = &mut self.slots[slot].eps[dci];
                    let Some(td) = ep.inflight.iter_mut().find(|t| t.tag == tag && t.posted) else {
                        continue;
                    };
                    let cc = match w1 >> 8 & 0xff {
                        c @ (CC_SUCCESS | CC_SHORT | CC_STALL | CC_BABBLE) => c,
                        _ => CC_TRANSACTION,
                    };
                    let total: u32 = td.trbs.iter().filter(|t| t.data()).map(|t| t.len).sum();
                    let actual = w2.min(total);
                    let cc = match cc {
                        CC_SUCCESS if actual < total => CC_SHORT,
                        CC_SHORT if actual >= total => CC_SUCCESS,
                        c => c,
                    };
                    td.done = Some((cc, actual));
                    if !touched.contains(&(slot, dci)) {
                        touched.push((slot, dci));
                    }
                }
                CPL_ATTACH => {
                    let c = w0 as usize;
                    let speed = w1 >> 8 & 0xf;
                    if c >= CONNECTORS || !(SPEED_FULL..=SPEED_SUPER).contains(&speed) {
                        continue;
                    }
                    let i = if speed == SPEED_SUPER {
                        c + CONNECTORS
                    } else {
                        c
                    };
                    if self.ports[c].attached || self.ports[c + CONNECTORS].attached {
                        continue;
                    }
                    self.connect(i, speed, true);
                }
                CPL_DETACH => {
                    let c = w0 as usize;
                    if c < CONNECTORS {
                        self.detach(c, mem);
                    }
                }
                _ => {}
            }
        }
        for (s, d) in touched {
            self.settle(s, d, mem);
        }
        self.write_events(mem);
    }

    /// The device on connector `c` went away: its TDs complete with transaction errors, its
    /// records leave the outbox, and the port shows the disconnect.
    fn detach(&mut self, c: usize, mem: &Mem) {
        for i in [c, c + CONNECTORS] {
            if !self.ports[i].attached {
                continue;
            }
            for s in 1..=MAX_SLOTS {
                if self.slots[s].enabled && self.slots[s].port as usize == i + 1 {
                    for d in 1..32 {
                        for td in self.slots[s].eps[d].inflight.iter_mut() {
                            if td.done.is_none() {
                                td.done = Some((CC_TRANSACTION, 0));
                            }
                        }
                        self.force = true;
                        self.settle(s, d, mem);
                        self.force = false;
                    }
                }
            }
            let g = self.gens[c];
            self.outbox
                .retain(|r| !(r.words[1] & 0xff == c as u32 && (r.words[0] >> 24) as u8 == g));
            let p = &mut self.ports[i];
            p.attached = false;
            p.fresh = false;
            p.portsc =
                P_PP | P_CSC | PLS_RX_DETECT << P_PLS_SHIFT | p.portsc & (P_WAKE | P_CHANGES);
            self.port_event(i);
        }
        self.gens[c] = self.gens[c].wrapping_add(1);
    }
}

/// Reads one TD from `start`: its TRBs (links followed), the position of its first one (past
/// the links before it: where the guest's driver says it starts) and the position after it; `None`
/// if it isn't all there yet (a TRB with the other cycle); `Err` with the TRB's address if a
/// TRB is out of RAM, of a type that doesn't belong, or the TD is too long.
type ReadTd = (Vec<Trb>, Pos, Pos);

fn read_td(mem: &Mem, start: Pos, control: bool) -> Result<Option<ReadTd>, u64> {
    let mut p = start;
    let mut first = start;
    let mut trbs = vec![];
    let mut links = 0;
    let mut stage = 0; // control: 0 setup, 1 data, 2 status seen
    loop {
        if trbs.len() + links >= MAX_TD_TRBS {
            return Err(p.at);
        }
        let t = read_trb(mem, p.at).map_err(|_| p.at)?;
        if t[3] & C_CYCLE != p.cycle as u32 {
            return Ok(None);
        }
        let kind = ty(&t);
        if kind == T_LINK {
            links += 1;
            let to = (t[0] as u64 | (t[1] as u64) << 32) & !0xf;
            p = Pos {
                at: to,
                cycle: p.cycle ^ (t[3] & C_ENT_TC != 0),
            };
            continue;
        }
        let param = t[0] as u64 | (t[1] as u64) << 32;
        let trb = Trb {
            at: p.at,
            kind,
            len: if kind == T_EVENT_DATA {
                0
            } else {
                t[2] & 0x1_ffff
            },
            param,
            ctl: t[3],
        };
        let ok = match kind {
            T_NORMAL => !control || stage == 1,
            T_ISOCH => !control && trbs.is_empty(),
            T_SETUP => control && trbs.is_empty(),
            // A Data or Status stage belongs after a Setup stage.
            T_DATA => {
                control && stage == 0 && trbs.first().is_some_and(|t: &Trb| t.kind == T_SETUP)
            }
            T_STATUS => {
                control && stage < 2 && trbs.first().is_some_and(|t: &Trb| t.kind == T_SETUP)
            }
            T_EVENT_DATA | T_NOOP => true,
            _ => false,
        };
        if !ok {
            return Err(p.at);
        }
        if kind == T_DATA {
            stage = 1;
        }
        if kind == T_STATUS {
            stage = 2;
        }
        if trbs.is_empty() {
            first = p;
        }
        trbs.push(trb);
        p.at = p.at.wrapping_add(16);
        let chained = t[3] & C_CH != 0;
        let more = if control && trbs[0].kind == T_SETUP {
            // A control transfer runs to its status stage (and what the status stage chains).
            stage < 2 || chained
        } else {
            chained
        };
        if !more {
            return Ok(Some((trbs, first, p)));
        }
    }
}

impl Xhci {
    /// Whether nothing waits for the host and nothing is in flight: a snapshot is taken then.
    pub fn quiet(&self, sh: &XhciShared) -> bool {
        let empty = |r: &WordRing| r.head.load(Ordering::Acquire) == r.tail.load(Ordering::Acquire);
        sh.events.load(Ordering::Acquire) == 0
            && empty(&sh.req)
            && empty(&sh.cpl)
            && self.outbox.is_empty()
            && self.tags.is_empty()
    }

    /// Whether a snapshot can be taken at all: every port empty (a restored controller's are;
    /// the host detaches its devices first, docs/usb.md "Snapshots").
    pub fn saveable(&self) -> bool {
        self.ports.iter().all(|p| !p.attached) && self.tags.is_empty() && self.held.is_none()
    }

    /// Saves the registers, ports, slots and rings (with the endpoints whose walk waits for room,
    /// `Ep::more`); the TDs in flight and the records are empty (`quiet`, `saveable`).
    pub fn save(&self, w: &mut Writer) {
        for v in [self.usbcmd, self.usbsts, self.dnctrl, self.config] {
            w.u32(v);
        }
        w.u64(self.dcbaap);
        w.u64(self.crcr.at);
        w.bool(self.crcr.cycle);
        w.bool(self.crr);
        for p in &self.ports {
            w.u32(p.portsc);
            w.u32(p.pmsc);
        }
        for s in &self.slots[1..] {
            w.bool(s.enabled);
            w.u8(s.port);
            w.u64(s.ctx);
            for e in &s.eps[1..] {
                for v in [e.state, e.ty, e.max_packet, e.interval] {
                    w.u32(v);
                }
                for p in [e.deq, e.walk] {
                    w.u64(p.at);
                    w.bool(p.cycle);
                }
                // A walk that stopped for room goes on at the restored VM's next boundary.
                w.bool(e.more);
            }
        }
        for v in [self.iman, self.imod, self.erstsz] {
            w.u32(v);
        }
        w.u64(self.erstba);
        w.u64(self.erdp);
        w.bool(self.ehb);
        w.bool(self.irq_pending);
        w.u32(self.erst.len() as u32);
        for &(b, n) in &self.erst {
            w.u64(b);
            w.u32(n);
        }
        w.u32(self.enq.0 as u32);
        w.u32(self.enq.1);
        w.bool(self.enq.2);
        w.u32(self.pending.len() as u32);
        for (t, irq) in &self.pending {
            t.iter().for_each(|&v| w.u32(v));
            w.bool(*irq);
        }
        w.u32(self.next_tag);
        w.u32(self.lo[0]);
        w.u32(self.lo[1]);
        w.bool(self.cmd_wait);
        // Format 5: what CSS kept (a guest asleep in SYSTEM_SUSPEND has its controller saved).
        w.bool(self.saved.is_some());
        if let Some((erst, enq)) = &self.saved {
            w.u32(erst.len() as u32);
            for &(b, n) in erst {
                w.u64(b);
                w.u32(n);
            }
            w.u32(enq.0 as u32);
            w.u32(enq.1);
            w.bool(enq.2);
        }
    }

    /// Restores what [`Xhci::save`] wrote into a new controller (its ports empty), in the
    /// state's format `version` (4 has no CSS state: a CRS after it reports SRE).
    pub fn restore(&mut self, r: &mut Reader, version: u32) -> snapshot::Result<()> {
        const CORRUPT: snapshot::Error = snapshot::Error::Corrupt;
        self.usbcmd = r.u32()? & CMD_MASK;
        self.usbsts = r.u32()? & (STS_HCH | STS_EINT | STS_PCD | STS_SRE);
        self.dnctrl = r.u32()?;
        self.config = r.u32()?;
        if self.config & 0xff > MAX_SLOTS as u32 {
            return Err(CORRUPT);
        }
        self.dcbaap = r.u64()?;
        self.crcr = Pos {
            at: r.u64()? & !0xf,
            cycle: r.bool()?,
        };
        self.crr = r.bool()?;
        for p in &mut self.ports {
            // Empty: whatever device was there is gone with the old VM's backends.
            p.portsc = r.u32()? & !(P_CCS | P_PED | 0xf << P_SPEED_SHIFT) | P_PP;
            p.pmsc = r.u32()?;
        }
        for s in &mut self.slots[1..] {
            s.enabled = r.bool()?;
            s.port = r.u8()?;
            s.ctx = r.u64()?;
            if s.port as usize > PORTS {
                return Err(CORRUPT);
            }
            for e in &mut s.eps[1..] {
                e.state = r.u32()?;
                e.ty = r.u32()?;
                e.max_packet = r.u32()?;
                e.interval = r.u32()?;
                if e.state > 4 || e.ty > 7 {
                    return Err(CORRUPT);
                }
                e.deq = Pos {
                    at: r.u64()? & !0xf,
                    cycle: r.bool()?,
                };
                e.walk = Pos {
                    at: r.u64()? & !0xf,
                    cycle: r.bool()?,
                };
                e.more = r.bool()?;
                self.more |= e.more;
            }
        }
        self.iman = r.u32()? & 3;
        self.imod = r.u32()?;
        self.erstsz = r.u32()? & 0xffff;
        self.erstba = r.u64()?;
        self.erdp = r.u64()?;
        self.ehb = r.bool()?;
        self.irq_pending = r.bool()?;
        let n = r.count(16)?;
        self.erst = (0..n)
            .map(|_| Ok((r.u64()?, r.u32()?)))
            .collect::<snapshot::Result<_>>()?;
        self.enq = (r.u32()? as usize, r.u32()?, r.bool()?);
        if !self.erst.is_empty()
            && (self.enq.0 >= self.erst.len() || self.enq.1 >= self.erst[self.enq.0].1)
            || self.erst.iter().any(|&(_, n)| n < 16)
        {
            return Err(CORRUPT);
        }
        let n = r.count(1 << 16)?;
        for _ in 0..n {
            let t = [r.u32()?, r.u32()?, r.u32()?, r.u32()?];
            self.pending.push_back((t, r.bool()?));
        }
        self.next_tag = r.u32()?;
        if !(1..1 << 24).contains(&self.next_tag) {
            return Err(CORRUPT);
        }
        // The low halves of ERSTBA and ERDP written and not yet their high ones.
        self.lo[0] = r.u32()? & !0x3f;
        self.lo[1] = r.u32()? & !0xf;
        self.cmd_wait = r.bool()?;
        if version >= 5 && r.bool()? {
            let n = r.count(16)?;
            let erst: Vec<(u64, u32)> = (0..n)
                .map(|_| Ok((r.u64()?, r.u32()?)))
                .collect::<snapshot::Result<_>>()?;
            let enq = (r.u32()? as usize, r.u32()?, r.bool()?);
            // Checked as the live ring's are, for the CRS that will use them.
            if !erst.is_empty() && (enq.0 >= erst.len() || enq.1 >= erst[enq.0].1)
                || erst.iter().any(|&(_, n)| n < 16)
            {
                return Err(CORRUPT);
            }
            self.saved = Some((erst, enq));
        }
        Ok(())
    }
}

#[cfg(test)]
mod review;
#[cfg(test)]
mod tests;
