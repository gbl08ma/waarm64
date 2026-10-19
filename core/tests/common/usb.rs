//! The xHCI's host side natively (web/usb.ts's twin) and Gadget Zero (web/usb-gadget-zero.ts on
//! web/usb-virtual.ts): the same records read, the same bytes given, so a native boot takes the steps
//! the Node and Chromium ones do (docs/usb.md).

use std::collections::VecDeque;
use std::sync::atomic::Ordering;
use webpc_core::vm::{SIGNAL_DEVICE, Vm};
use webpc_core::xhci::{
    CONNECTORS, CPL_ATTACH, CPL_DETACH, CPL_DONE, REQ_CANCEL, REQ_CLEAR_HALT, REQ_CONFIGURED,
    REQ_RESET, REQ_TRANSFER, SEG_IMMEDIATE, SEG_MEM_SHIFT, XhciShared,
};

/// A Gadget Zero's options (web/usb-device.ts `UsbVirtual`).
#[derive(Clone, Copy, Debug)]
pub struct GzOptions {
    pub speed: Speed,
    pub pattern: u8,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Speed {
    Full,
    High,
    Super,
}

impl Speed {
    fn id(self) -> u32 {
        match self {
            Speed::Full => 1,
            Speed::High => 3,
            Speed::Super => 4,
        }
    }
}

/// What a TD ended with (web/usb-device.ts `UsbCode`), as xHCI completion codes.
const SUCCESS: u32 = 1;
const SHORT: u32 = 13;
const STALL: u32 = 6;
const ERROR: u32 = 4;

const SOURCE_SINK: u8 = 3;
const LOOPBACK: u8 = 2;
const QLEN: usize = 32;
const BUFLEN: usize = 4096;

/// A TD as the device sees it.
struct Td {
    tag: u32,
    ep: u8,
    control: bool,
    setup: [u8; 8],
    data: Vec<u8>,
    length: u32,
}

/// A TD's result: code, bytes, IN data.
type Res = (u32, u32, Vec<u8>);

fn u16le(v: u16) -> [u8; 2] {
    v.to_le_bytes()
}

fn config(value: u8, maxp: u16, ss: bool) -> Vec<u8> {
    let s = if value == SOURCE_SINK { 4 } else { 5 };
    let ep = |addr: u8| {
        let mut e = vec![7, 5, addr, 2];
        e.extend(u16le(maxp));
        e.push(0);
        if ss {
            e.extend([6, 0x30, 0, 0, 0, 0]);
        }
        e
    };
    let mut body = vec![9, 4, 0, 0, 2, 0xff, 0, 0, s];
    body.extend(ep(0x81));
    body.extend(ep(0x01));
    let total = 9 + body.len() as u16;
    let mut c = vec![9, 2];
    c.extend(u16le(total));
    c.extend([1, value, s, 0xc0, 1]);
    c.extend(body);
    c
}

fn string(s: &str) -> Vec<u8> {
    let mut d = vec![2 + 2 * s.len() as u8, 3];
    for u in s.encode_utf16() {
        d.extend(u.to_le_bytes());
    }
    d
}

pub struct GadgetZero {
    pub speed: Speed,
    maxp: usize,
    pattern: u8,
    device: Vec<u8>,
    configs: Vec<Vec<u8>>,
    other: Vec<Vec<u8>>,
    qualifier: Option<Vec<u8>>,
    bos: Option<Vec<u8>>,
    strings: Vec<String>,
    configuration: u8,
    halted: Vec<u8>,
    remote_wakeup: bool,
    ep0buf: Vec<u8>,
    queue: VecDeque<Vec<u8>>,
    waiting_in: VecDeque<Td>,
    waiting_out: VecDeque<Td>,
}

impl GadgetZero {
    pub fn new(o: GzOptions) -> GadgetZero {
        let ss = o.speed == Speed::Super;
        let maxp = match o.speed {
            Speed::Super => 1024,
            Speed::High => 512,
            Speed::Full => 64,
        };
        let mut device = vec![18, 1];
        device.extend(u16le(if ss { 0x0320 } else { 0x0200 }));
        device.extend([0xff, 0, 0, if ss { 9 } else { 64 }]);
        device.extend(u16le(0x0525));
        device.extend(u16le(0xa4a0));
        device.extend(u16le(0x0100));
        device.extend([1, 2, 3, 2]);
        let configs = vec![config(SOURCE_SINK, maxp, ss), config(LOOPBACK, maxp, ss)];
        let high = o.speed == Speed::High;
        let qualifier = high.then(|| {
            let mut q = vec![10, 6];
            q.extend(u16le(0x0200));
            q.extend([0xff, 0, 0, 64, 2, 0]);
            q
        });
        let other = if high {
            vec![config(SOURCE_SINK, 64, false), config(LOOPBACK, 64, false)]
        } else {
            vec![]
        };
        let bos = ss.then(|| {
            let mut b = vec![5, 15];
            b.extend(u16le(22));
            b.extend([2, 7, 16, 2, 0, 0, 0, 0, 10, 16, 3, 0]);
            b.extend(u16le(0x000e));
            b.extend([1, 10]);
            b.extend(u16le(0x07ff));
            b
        });
        let strings = [
            "webpc",
            "Gadget Zero",
            "0123456789",
            "source and sink data",
            "loop input to output",
        ]
        .map(String::from)
        .to_vec();
        GadgetZero {
            speed: o.speed,
            maxp: maxp as usize,
            pattern: o.pattern,
            device,
            configs,
            other,
            qualifier,
            bos,
            strings,
            configuration: 0,
            halted: vec![],
            remote_wakeup: false,
            ep0buf: vec![0; BUFLEN],
            queue: VecDeque::new(),
            waiting_in: VecDeque::new(),
            waiting_out: VecDeque::new(),
        }
    }

    fn byte(&self, i: usize) -> u8 {
        if self.pattern == 0 {
            0
        } else {
            (i % self.maxp % 63) as u8
        }
    }

    fn has_ep(&self, ep: u8) -> bool {
        self.configuration != 0 && (ep == 0x81 || ep == 0x01)
    }

    fn changed(&mut self) {
        self.queue.clear();
        self.waiting_in.clear();
        self.waiting_out.clear();
    }

    pub fn reset(&mut self) {
        self.configuration = 0;
        self.halted.clear();
        self.remote_wakeup = false;
        self.changed();
    }

    pub fn cancel(&mut self, ep: u8, tags: &[u32]) {
        let keep = |t: &Td| !(t.ep == ep && tags.contains(&t.tag));
        self.waiting_in.retain(keep);
        self.waiting_out.retain(keep);
    }

    /// Starts a TD; the results of every TD that completed (this one, or ones it let go).
    fn submit(&mut self, t: Td, out: &mut Vec<(u32, Res)>) {
        if t.control {
            let r = self.setup(&t);
            out.push((t.tag, r));
            return;
        }
        if !self.has_ep(t.ep) {
            out.push((t.tag, (ERROR, 0, vec![])));
            return;
        }
        if self.halted.contains(&t.ep) {
            out.push((t.tag, (STALL, 0, vec![])));
            return;
        }
        if self.configuration == SOURCE_SINK {
            if t.ep & 0x80 != 0 {
                let data: Vec<u8> = (0..t.length as usize).map(|i| self.byte(i)).collect();
                out.push((t.tag, (SUCCESS, t.length, data)));
            } else if t.data.iter().enumerate().any(|(i, &b)| b != self.byte(i)) {
                self.halted.push(t.ep);
                out.push((t.tag, (STALL, 0, vec![])));
            } else {
                out.push((t.tag, (SUCCESS, t.data.len() as u32, vec![])));
            }
            return;
        }
        if t.ep & 0x80 != 0 {
            self.waiting_in.push_back(t);
        } else {
            self.waiting_out.push_back(t);
        }
        loop {
            let mut moved = false;
            if !self.waiting_out.is_empty() && self.queue.len() < QLEN {
                let o = self.waiting_out.pop_front().unwrap();
                let n = o.data.len() as u32;
                self.queue.push_back(o.data);
                out.push((o.tag, (SUCCESS, n, vec![])));
                moved = true;
            }
            if !self.waiting_in.is_empty() && !self.queue.is_empty() {
                let i = self.waiting_in.pop_front().unwrap();
                let mut d = self.queue.pop_front().unwrap();
                d.truncate(i.length as usize);
                let code = if (d.len() as u32) < i.length {
                    SHORT
                } else {
                    SUCCESS
                };
                out.push((i.tag, (code, d.len() as u32, d)));
                moved = true;
            }
            if !moved {
                break;
            }
        }
    }

    fn setup(&mut self, t: &Td) -> Res {
        let s = &t.setup;
        let (rt, req) = (s[0], s[1]);
        let value = u16::from_le_bytes([s[2], s[3]]);
        let index = u16::from_le_bytes([s[4], s[5]]);
        let length = u16::from_le_bytes([s[6], s[7]]) as usize;
        let into = if rt & 0x80 != 0 { length } else { 0 };
        let answer = |a: Option<Option<Vec<u8>>>| -> Res {
            match a {
                None => (STALL, 0, vec![]),
                Some(None) => (
                    SUCCESS,
                    if into > 0 { 0 } else { t.data.len() as u32 },
                    vec![],
                ),
                Some(Some(mut d)) => {
                    d.truncate(into);
                    let code = if d.len() < into { SHORT } else { SUCCESS };
                    (code, d.len() as u32, d)
                }
            }
        };
        if rt & 0x60 == 0
            && let Some(a) = self.standard(rt, req, value, index)
        {
            return answer(a);
        }
        // Gadget Zero's vendor requests (source/sink).
        let a = if self.configuration != SOURCE_SINK
            || rt & 0x60 != 0x40
            || value != 0
            || index != 0
            || length > BUFLEN
        {
            None
        } else if req == 0x5b && rt & 0x80 == 0 {
            self.ep0buf[..t.data.len()].copy_from_slice(&t.data);
            Some(None)
        } else if req == 0x5c && rt & 0x80 != 0 {
            Some(Some(self.ep0buf[..length].to_vec()))
        } else {
            None
        };
        answer(a)
    }

    /// A standard request: `Some(None)` accepted, `Some(Some(data))` IN data, `None` stall; the
    /// outer `None` for one the subclass would take (web/usb-virtual.ts UNKNOWN).
    #[allow(clippy::option_option)]
    fn standard(
        &mut self,
        rt: u8,
        req: u8,
        value: u16,
        index: u16,
    ) -> Option<Option<Option<Vec<u8>>>> {
        let recipient = rt & 0x1f;
        let configured = self.configuration != 0;
        let iface = configured && index & 0xff == 0;
        Some(match req {
            0 => match recipient {
                0 => Some(Some(vec![1 | (self.remote_wakeup as u8) << 1, 0])),
                1 => iface.then(|| Some(vec![0, 0])),
                2 => {
                    let ep = index as u8;
                    (ep & 0x7f == 0 || self.has_ep(ep))
                        .then(|| Some(vec![self.halted.contains(&ep) as u8, 0]))
                }
                _ => None,
            },
            1 | 3 => {
                let set = req == 3;
                match recipient {
                    0 => {
                        if value == 1 {
                            self.remote_wakeup = set;
                        }
                        Some(None)
                    }
                    1 => iface.then_some(None),
                    2 if value == 0 => {
                        let ep = index as u8;
                        if ep & 0x7f == 0 {
                            Some(None)
                        } else if !self.has_ep(ep) {
                            None
                        } else {
                            if set {
                                if !self.halted.contains(&ep) {
                                    self.halted.push(ep);
                                }
                            } else {
                                self.halted.retain(|&e| e != ep);
                            }
                            Some(None)
                        }
                    }
                    _ => None,
                }
            }
            5 => Some(None),
            6 => self.descriptor(rt, value).map(Some),
            8 => Some(Some(vec![self.configuration])),
            9 => {
                let v = value as u8;
                if v != 0 && v != SOURCE_SINK && v != LOOPBACK {
                    None
                } else {
                    self.configuration = v;
                    self.halted.clear();
                    self.changed();
                    Some(None)
                }
            }
            10 => iface.then(|| Some(vec![0])),
            11 => {
                if iface && value == 0 {
                    self.halted.clear();
                    self.changed();
                    Some(None)
                } else {
                    None
                }
            }
            48 | 49 => Some(None),
            _ => return None,
        })
    }

    fn descriptor(&self, rt: u8, value: u16) -> Option<Vec<u8>> {
        if rt & 0x1f != 0 {
            return None;
        }
        let (ty, index) = ((value >> 8) as u8, (value & 0xff) as usize);
        match ty {
            1 => Some(self.device.clone()),
            2 => self.configs.get(index).cloned(),
            3 if index == 0 => Some(vec![4, 3, 0x09, 0x04]),
            3 => self.strings.get(index - 1).map(|s| string(s)),
            6 => self.qualifier.clone(),
            7 => self.other.get(index).map(|c| {
                let mut c = c.clone();
                c[1] = 7;
                c
            }),
            15 => self.bos.clone(),
            _ => None,
        }
    }
}

/// One TD in flight: where its IN data goes.
struct Flight {
    tag: u32,
    connector: usize,
    g: u8,
    into: bool,
    /// (guest PA, length)
    segs: Vec<(u64, u32)>,
    length: u32,
}

/// The glue (web/usb.ts `Usb`): the Gadget Zeros on the connectors and their TDs.
pub struct UsbHost {
    devs: Vec<Option<GadgetZero>>,
    gens: [u8; CONNECTORS],
    flights: Vec<Flight>,
}

impl Default for UsbHost {
    fn default() -> Self {
        UsbHost {
            devs: (0..CONNECTORS).map(|_| None).collect(),
            gens: [0; CONNECTORS],
            flights: vec![],
        }
    }
}

fn sh(vm: &Vm) -> &XhciShared {
    vm.shared.xhci.as_ref().expect("a VM with an xHCI")
}

fn completion(vm: &Vm, w: [u32; 3]) {
    assert!(sh(vm).cpl.push(&w), "the xHCI completion ring is full");
    vm.signal(SIGNAL_DEVICE);
}

impl UsbHost {
    pub fn attach(&mut self, vm: &Vm, c: usize, o: GzOptions) {
        assert!(self.devs[c].is_none(), "connector {c} has a device");
        self.devs[c] = Some(GadgetZero::new(o));
        completion(vm, [c as u32, CPL_ATTACH | o.speed.id() << 8, 0]);
    }

    pub fn detach(&mut self, vm: &Vm, c: usize) {
        if self.devs[c].take().is_some() {
            self.gens[c] = self.gens[c].wrapping_add(1);
            self.flights.retain(|f| f.connector != c);
            completion(vm, [c as u32, CPL_DETACH, 0]);
        }
    }

    pub fn poll(&mut self, vm: &Vm) {
        let s = sh(vm);
        s.events.swap(0, Ordering::AcqRel);
        let mut records = vec![];
        while let Some([w0, w1, n]) = s.req.pop::<3>() {
            let w: Vec<u32> = (0..n).map(|_| s.req.pop::<1>().unwrap()[0]).collect();
            records.push((w0, w1, w));
        }
        // A TD cancelled before it was read never reaches its device (web/usb.ts `poll`); from the
        // end, so that a tag given again after its cancel is the new TD's.
        let mut skip = vec![false; records.len()];
        let mut cancelled: Vec<u32> = vec![];
        for (i, r) in records.iter().enumerate().rev() {
            if r.1 >> 16 == REQ_CANCEL {
                cancelled.extend(&r.2[1..1 + r.2[0] as usize]);
            } else if r.1 >> 16 == REQ_TRANSFER
                && let Some(k) = cancelled.iter().position(|&t| t == r.0 & 0xff_ffff)
            {
                cancelled.swap_remove(k);
                skip[i] = true;
            }
        }
        for (i, (w0, w1, w)) in records.into_iter().enumerate() {
            let (c, dci, kind) = ((w1 & 0xff) as usize, (w1 >> 8 & 0xff) as u8, w1 >> 16);
            let g = (w0 >> 24) as u8;
            if c >= CONNECTORS || self.devs[c].is_none() || g != self.gens[c] {
                continue;
            }
            let ep = if dci == 1 {
                0
            } else {
                dci >> 1 | (dci & 1) << 7
            };
            match kind {
                REQ_TRANSFER if !skip[i] => self.transfer(vm, c, g, w0 & 0xff_ffff, ep, &w),
                REQ_TRANSFER => {}
                REQ_RESET => self.devs[c].as_mut().unwrap().reset(),
                REQ_CANCEL => {
                    let tags: Vec<u32> = w[1..1 + w[0] as usize]
                        .iter()
                        .copied()
                        .filter(|t| self.flights.iter().any(|f| f.tag == *t))
                        .collect();
                    self.flights.retain(|f| !tags.contains(&f.tag));
                    if !tags.is_empty() {
                        self.devs[c].as_mut().unwrap().cancel(ep, &tags);
                    }
                }
                REQ_CONFIGURED | REQ_CLEAR_HALT => {}
                _ => {}
            }
        }
    }

    fn transfer(&mut self, vm: &Vm, c: usize, g: u8, tag: u32, ep: u8, w: &[u32]) {
        let (nseg, setup) = (w[0] & 0xffff, w[0] >> 24 & 1 != 0);
        let length = w[1];
        let mut k = 2;
        let mut s = [0u8; 8];
        if setup {
            s[..4].copy_from_slice(&w[2].to_le_bytes());
            s[4..].copy_from_slice(&w[3].to_le_bytes());
            k = 4;
        }
        let mut segs = vec![];
        let mut imm: Vec<Option<Vec<u8>>> = vec![];
        for _ in 0..nseg {
            let (off, len) = (w[k], w[k + 1]);
            k += 2;
            if len & SEG_IMMEDIATE != 0 {
                let mut b = w[k].to_le_bytes().to_vec();
                b.extend(w[k + 1].to_le_bytes());
                k += 2;
                let n = (len & 0xff) as usize;
                b.truncate(n);
                segs.push((0, n as u32));
                imm.push(Some(b));
            } else {
                let m = (len >> SEG_MEM_SHIFT & 0xf) as usize;
                segs.push((vm.mem.ram_pa(m, off as u64), len & 0xff_ffff));
                imm.push(None);
            }
        }
        let into = if setup {
            s[0] & 0x80 != 0
        } else {
            ep & 0x80 != 0
        };
        let mut data = vec![];
        if !into && length > 0 {
            for (i, &(off, len)) in segs.iter().enumerate() {
                match &imm[i] {
                    Some(b) => data.extend(b),
                    None => data.extend(read(vm, off, len)),
                }
            }
        }
        self.flights.push(Flight {
            tag,
            connector: c,
            g,
            into,
            segs,
            length,
        });
        let td = Td {
            tag,
            ep,
            control: setup,
            setup: s,
            data,
            length,
        };
        let mut out = vec![];
        self.devs[c].as_mut().unwrap().submit(td, &mut out);
        for (tag, r) in out {
            self.done(vm, tag, r);
        }
    }

    fn done(&mut self, vm: &Vm, tag: u32, (code, actual, data): Res) {
        let Some(i) = self.flights.iter().position(|f| f.tag == tag) else {
            return;
        };
        let f = self.flights.remove(i);
        let mut actual = actual.min(f.length);
        if f.into {
            actual = actual.min(data.len() as u32);
            let mut at = 0;
            for &(off, len) in &f.segs {
                if at >= actual {
                    break;
                }
                let n = len.min(actual - at);
                write(vm, off, &data[at as usize..(at + n) as usize]);
                at += n;
            }
        }
        completion(vm, [tag | (f.g as u32) << 24, CPL_DONE | code << 8, actual]);
    }
}

fn read(vm: &Vm, pa: u64, len: u32) -> Vec<u8> {
    let p = vm
        .mem
        .host(pa, len as u64, webpc_core::mem::Access::Read)
        .map(|h| vm.mem.native_ptr(h))
        .unwrap();
    // SAFETY: host() checked the range is guest RAM.
    unsafe { std::slice::from_raw_parts(p, len as usize) }.to_vec()
}

fn write(vm: &Vm, pa: u64, b: &[u8]) {
    let p = vm
        .mem
        .host(pa, b.len() as u64, webpc_core::mem::Access::Write)
        .map(|h| vm.mem.native_ptr(h))
        .unwrap();
    // SAFETY: host() checked the range is guest RAM.
    unsafe { std::ptr::copy_nonoverlapping(b.as_ptr(), p, b.len()) };
}
