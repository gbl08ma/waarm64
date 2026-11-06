//! A session child (docs/plans/clipboard.md §3.2–§3.3): forked by the root process for the active session's user and
//! running as that user, it shares the clipboard of the user's Wayland compositor through data-control
//! (`ext_data_control_manager_v1`, or `zwlr_data_control_manager_v1` where there is no ext one: the two protocols'
//! messages are the same), a client written by hand (src/wire.rs). It finds the compositor's socket in the user's
//! runtime directory, watched with inotify (a user starts sway from a tty long after the agent starts), and comes and
//! goes with it. Its frames go to the page through the parent, over a socketpair, in the port's own format.
//!
//! - **Guest to host:** a guest program's selection with text becomes an OFFER. Its first 4 KiB are read at once:
//!   text that fits goes inline (`clip::INLINE`), unless it is what the host last gave (echo suppression: its hash);
//!   longer text is offered without bytes and read when the page sends a REQUEST, in DATA frames as the page's MOREs
//!   allow.
//! - **Host to guest:** the page's OFFER becomes a data source of ours, set as the selection; ACK says so once the
//!   compositor has it. A guest program's paste (`send`) streams the page's DATA into its pipe, requested each time
//!   but for text of 64 KiB or less, kept once it has crossed (`clip::CACHE`). Our own source's selection isn't
//!   offered back.
//! - **PAUSE:** our source goes (the guest's clipboard is cleared if it held the host's data), transfers stop, the
//!   guest's selections are ignored until RESUME.
//! - **SESSION:** when the data device comes (a compositor's, bound) or goes (the compositor gone, its seat gone), the
//!   page hears SESSION and every transfer ends: the guest's clipboard the page knew is another's now.
//!
//! One thread in `ppoll` on the parent's socket, the inotify descriptor, the compositor's socket and the pipes of
//! transfers in progress; no timeout but while a socket that exists refuses connections (a compositor between its
//! bind and its listen).

use crate::clip::{self, Hash};
use crate::frame::{self, ack};
use crate::log;
use crate::wire::{Args, Conn, Msg};
use rustix::event::{PollFd, PollFlags, Timespec, poll};
use rustix::fd::{AsRawFd, OwnedFd, RawFd};
use rustix::fs::inotify::{self, CreateFlags, ReadFlags, WatchFlags};
use rustix::fs::{OFlags, fcntl_getfl, fcntl_setfl};
use rustix::io::{Errno, read, write};
use rustix::net::{AddressFamily, SocketAddrUnix, SocketFlags, SocketType, connect, socket_with};
use std::collections::{HashMap, VecDeque};
use std::mem::MaybeUninit;

/// wl_display's id, and the first a client allocates.
const DISPLAY: u32 = 1;
const FIRST_ID: u32 = 2;
/// The data-control managers, newest first; their requests and events are the same.
const MANAGERS: [&str; 2] = [
    "ext_data_control_manager_v1",
    "zwlr_data_control_manager_v1",
];

/// Opcodes (wayland.xml, ext-data-control-v1.xml, wlr-data-control-unstable-v1.xml).
mod op {
    // wl_display: requests, events.
    pub const SYNC: u16 = 0;
    pub const GET_REGISTRY: u16 = 1;
    pub const ERROR: u16 = 0;
    pub const DELETE_ID: u16 = 1;
    // wl_registry.
    pub const BIND: u16 = 0;
    pub const GLOBAL: u16 = 0;
    // wl_callback.
    pub const DONE: u16 = 0;
    // The manager.
    pub const CREATE_DATA_SOURCE: u16 = 0;
    pub const GET_DATA_DEVICE: u16 = 1;
    // The device: requests, events.
    pub const SET_SELECTION: u16 = 0;
    pub const DATA_OFFER: u16 = 0;
    pub const SELECTION: u16 = 1;
    pub const FINISHED: u16 = 2;
    pub const PRIMARY_SELECTION: u16 = 3;
    // A source: requests, events.
    pub const OFFER: u16 = 0;
    pub const SEND: u16 = 0;
    pub const CANCELLED: u16 = 1;
    // An offer: requests, events (OFFER, as a source's request).
    pub const RECEIVE: u16 = 0;
    // A device's, a source's, an offer's.
    pub const DESTROY: u16 = 1;
}

/// The bytes the child queues for the parent before it stops reading a guest program's pipe.
const PARENT_HIGH: usize = 256 << 10;
/// A socket that refuses: tries, this far apart.
const RETRIES: u32 = 25;
const RETRY: Timespec = Timespec {
    tv_sec: 0,
    tv_nsec: 200_000_000,
};
/// A guest program's types, and their length, past which the rest are ignored.
const MAX_TYPES: usize = 32;

/// What an object of ours is.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Obj {
    Registry,
    /// The first roundtrip's callback: the globals are all known.
    Init,
    /// The roundtrip after setting the selection for the page's offer `serial`.
    Ack(u32),
    Seat,
    Manager,
    Device,
    /// A guest program's offer (the compositor's object: no delete_id).
    Offer,
    Source,
    /// A source destroyed whose events may still come (a `send`'s descriptor to close), until delete_id.
    DeadSource,
    /// Destroyed, until delete_id.
    Dead,
}

/// The connection to the compositor and what is known of it.
struct Wl {
    conn: Conn,
    objs: HashMap<u32, Obj>,
    /// The types of offers the compositor has introduced.
    offers: HashMap<u32, Vec<String>>,
    next: u32,
    seat: Option<u32>,
    managers: [Option<u32>; 2],
    manager: Option<u32>,
    device: Option<u32>,
    /// The guest's selection (a guest program's offer), not ours.
    selection: Option<u32>,
}

impl Wl {
    fn id(&mut self, kind: Obj) -> u32 {
        let id = self.next;
        self.next += 1;
        self.objs.insert(id, kind);
        id
    }

    fn msg(&mut self, object: u32, opcode: u16) -> Msg<'_> {
        Msg::new(&mut self.conn.out, object, opcode)
    }

    fn destroy_offer(&mut self, id: u32) {
        if self.offers.remove(&id).is_some() {
            self.msg(id, op::DESTROY).done();
            self.objs.remove(&id);
        }
    }

    fn destroy_source(&mut self, id: u32) {
        if self.objs.get(&id) == Some(&Obj::Source) {
            self.msg(id, op::DESTROY).done();
            self.objs.insert(id, Obj::DeadSource);
        }
    }
}

/// The guest's selection as offered to the page.
struct Guest {
    serial: u32,
    offer: u32,
    mime: String,
}

/// The first bytes of the guest's selection, being read for its OFFER.
struct Probe {
    serial: u32,
    offer: u32,
    mime: String,
    fd: OwnedFd,
    buf: Vec<u8>,
}

/// The page's offer, as our source in the guest's clipboard.
struct Host {
    serial: u32,
    source: u32,
    mime: String,
    /// Its bytes once they crossed whole (up to `clip::CACHE`), or inline.
    cache: Option<Vec<u8>>,
}

enum Xfer {
    /// A guest program's bytes to the page, for the page's request `id`.
    Out {
        id: u32,
        fd: OwnedFd,
        credit: u32,
        sent: usize,
    },
    /// The page's bytes into a guest program's pipe: for our request `id` (0: from the cache, no request).
    In {
        id: u32,
        fd: OwnedFd,
        buf: Vec<u8>,
        at: usize,
        /// Where each DATA frame not yet written whole ends in `buf`: a MORE for each once it is.
        ends: VecDeque<usize>,
        ended: bool,
        serial: u32,
        len: usize,
        hash: Hash,
        copy: Option<Vec<u8>>,
    },
}

impl Xfer {
    fn fd(&self) -> &OwnedFd {
        match self {
            Xfer::Out { fd, .. } | Xfer::In { fd, .. } => fd,
        }
    }
}

struct Child {
    parent: OwnedFd,
    pin: frame::Reader,
    pout: Vec<u8>,
    runtime: String,
    ino: OwnedFd,
    wl: Option<Wl>,
    /// Tries left at a socket that refused.
    retries: u32,
    paused: bool,
    next: u32,
    guest: Option<Guest>,
    probe: Option<Probe>,
    host: Option<Host>,
    /// The hash of the host's last text: the guest's selection with the same isn't offered back.
    last_host: Option<Hash>,
    xfers: Vec<Xfer>,
    /// Logged once a connection: the compositor has no data-control.
    told: bool,
    /// Why the loop is to end (the parent or the runtime directory gone).
    stop: Option<&'static str>,
}

#[derive(Clone, Copy)]
enum Tag {
    Parent,
    Ino,
    Wl,
    Probe,
    /// A transfer, by its descriptor (transfers come and go while the events of one poll are handled).
    Xfer(RawFd),
}

fn nonblocking(fd: &OwnedFd) {
    if let Ok(f) = fcntl_getfl(fd) {
        let _ = fcntl_setfl(fd, f | OFlags::NONBLOCK);
    }
}

/// A pipe for a transfer: the end we keep, nonblocking; the other goes to the compositor.
fn pipe() -> Option<(OwnedFd, OwnedFd)> {
    let (r, w) = rustix::pipe::pipe_with(rustix::pipe::PipeFlags::CLOEXEC).ok()?;
    Some((r, w))
}

/// Serves the session's clipboard over `parent` until the parent goes or the runtime directory does. `base`: where its
/// serials and request ids start, so that a later child's don't meet an earlier one's in the page.
pub fn run(parent: OwnedFd, runtime: String, base: u32) -> ! {
    match serve(parent, runtime, base) {
        Ok(why) => {
            log(why, None);
            std::process::exit(0)
        }
        Err((why, e)) => {
            log(why, Some(e));
            std::process::exit(1)
        }
    }
}

/// `run`'s loop, which returns why it ended (the tests run it on a thread of theirs).
pub fn serve(
    parent: OwnedFd,
    runtime: String,
    base: u32,
) -> Result<&'static str, (&'static str, Errno)> {
    nonblocking(&parent);
    let ino = inotify::init(CreateFlags::CLOEXEC | CreateFlags::NONBLOCK)
        .map_err(|e| ("session: inotify", e))?;
    inotify::add_watch(
        &ino,
        runtime.as_str(),
        WatchFlags::CREATE | WatchFlags::MOVED_TO | WatchFlags::DELETE_SELF | WatchFlags::ONLYDIR,
    )
    .map_err(|e| ("session: can't watch the runtime directory", e))?;
    let mut c = Child {
        parent,
        pin: frame::Reader::default(),
        pout: Vec::new(),
        runtime,
        ino,
        wl: None,
        retries: 0,
        paused: false,
        next: base,
        guest: None,
        probe: None,
        host: None,
        last_host: None,
        xfers: Vec::new(),
        told: false,
        stop: None,
    };
    c.connect();
    loop {
        c.flush();
        if let Some(why) = c.stop.take() {
            return Ok(why);
        }
        let mut tags = Vec::with_capacity(4 + c.xfers.len());
        let mut fds = Vec::with_capacity(4 + c.xfers.len());
        let pin = if c.pout.is_empty() {
            PollFlags::IN
        } else {
            PollFlags::IN | PollFlags::OUT
        };
        fds.push(PollFd::new(&c.parent, pin));
        tags.push(Tag::Parent);
        fds.push(PollFd::new(&c.ino, PollFlags::IN));
        tags.push(Tag::Ino);
        if let Some(wl) = &c.wl {
            let f = if wl.conn.pending() {
                PollFlags::IN | PollFlags::OUT
            } else {
                PollFlags::IN
            };
            fds.push(PollFd::new(&wl.conn.fd, f));
            tags.push(Tag::Wl);
        }
        if let Some(p) = &c.probe {
            fds.push(PollFd::new(&p.fd, PollFlags::IN));
            tags.push(Tag::Probe);
        }
        for x in &c.xfers {
            let f = match x {
                Xfer::Out { credit, .. } if *credit > 0 && c.pout.len() < PARENT_HIGH => {
                    PollFlags::IN
                }
                Xfer::In { buf, at, .. } if *at < buf.len() => PollFlags::OUT,
                _ => continue,
            };
            fds.push(PollFd::new(x.fd(), f));
            tags.push(Tag::Xfer(x.fd().as_raw_fd()));
        }
        let timeout = (c.wl.is_none() && c.retries > 0).then_some(&RETRY);
        match poll(&mut fds, timeout) {
            Ok(0) => {
                drop(fds);
                c.retries -= 1;
                c.connect();
                continue;
            }
            Ok(_) | Err(Errno::INTR) => {}
            Err(e) => return Err(("session: poll", e)),
        }
        let ready: Vec<(Tag, PollFlags)> = tags
            .into_iter()
            .zip(fds.iter().map(|f| f.revents()))
            .filter(|(_, r)| !r.is_empty())
            .collect();
        drop(fds);
        for (tag, revents) in ready {
            match tag {
                Tag::Parent => c.parent_input(),
                Tag::Ino => c.inotify(),
                Tag::Wl => c.display_input(revents),
                Tag::Probe => c.probe(),
                Tag::Xfer(fd) => {
                    if let Some(i) = c.xfers.iter().position(|x| x.fd().as_raw_fd() == fd)
                        && !c.transfer(i)
                    {
                        c.xfers.remove(i);
                    }
                }
            }
            if let Some(why) = c.stop.take() {
                return Ok(why);
            }
        }
    }
}

impl Child {
    fn next(&mut self) -> u32 {
        self.next = self.next.wrapping_add(1);
        self.next
    }

    fn send(&mut self, kind: u8, f: impl FnOnce(&mut Vec<u8>)) {
        frame::encode_with(kind, &mut self.pout, f);
    }

    fn ack(&mut self, serial: u32, status: u8) {
        self.send(frame::ACK, |o| {
            o.extend_from_slice(&frame::ack(serial, status))
        });
    }

    fn fail(&mut self, id: u32) {
        self.send(frame::DATA, |o| frame::data(id, frame::DATA_FAIL, &[], o));
    }

    fn flush(&mut self) {
        while !self.pout.is_empty() {
            match write(&self.parent, &self.pout) {
                Ok(n) => {
                    self.pout.drain(..n);
                }
                Err(Errno::INTR) => {}
                Err(Errno::AGAIN) => break,
                Err(_) => {
                    self.stop = Some("session: the parent is gone");
                    break;
                }
            }
        }
        if self.pout.is_empty() && self.pout.capacity() > 4 * frame::MAX_PAYLOAD {
            self.pout = Vec::new();
        }
        let failed = match &mut self.wl {
            Some(wl) => wl.conn.flush().is_err(),
            None => false,
        };
        if failed {
            self.disconnect("the compositor's connection failed");
        }
    }

    /// Connects to the first compositor's socket in the runtime directory that takes it.
    fn connect(&mut self) {
        if self.wl.is_some() {
            return;
        }
        let Ok(dir) = std::fs::read_dir(&self.runtime) else {
            return;
        };
        let mut names: Vec<String> = dir
            .filter_map(|e| e.ok()?.file_name().into_string().ok())
            .filter(|n| is_socket_name(n))
            .collect();
        names.sort();
        let mut refused = false;
        for n in names {
            let path = format!("{}/{n}", self.runtime);
            let Ok(addr) = SocketAddrUnix::new(path.as_str()) else {
                continue;
            };
            let Ok(fd) = socket_with(
                AddressFamily::UNIX,
                SocketType::STREAM,
                SocketFlags::CLOEXEC,
                None,
            ) else {
                return;
            };
            match connect(&fd, &addr) {
                Ok(()) => {
                    nonblocking(&fd);
                    let mut wl = Wl {
                        conn: Conn::new(fd),
                        objs: HashMap::new(),
                        offers: HashMap::new(),
                        next: FIRST_ID,
                        seat: None,
                        managers: [None, None],
                        manager: None,
                        device: None,
                        selection: None,
                    };
                    let registry = wl.id(Obj::Registry);
                    wl.msg(DISPLAY, op::GET_REGISTRY).object(registry).done();
                    let cb = wl.id(Obj::Init);
                    wl.msg(DISPLAY, op::SYNC).object(cb).done();
                    self.wl = Some(wl);
                    self.retries = 0;
                    self.told = false;
                    return;
                }
                Err(Errno::CONNREFUSED) | Err(Errno::AGAIN) => refused = true,
                Err(_) => {}
            }
        }
        if refused && self.retries == 0 {
            self.retries = RETRIES;
        }
    }

    fn disconnect(&mut self, why: &str) {
        if let Some(wl) = self.wl.take() {
            log(&format!("session: {why}"), None);
            if wl.device.is_some() {
                self.changed_hands();
            }
        }
        self.host = None;
        self.guest = None;
        self.probe = None;
        self.connect();
    }

    fn inotify(&mut self) {
        let mut buf = [MaybeUninit::uninit(); 1024];
        let mut r = inotify::Reader::new(&self.ino, &mut buf);
        let mut socket = false;
        loop {
            match r.next() {
                Ok(e) => {
                    if e.events().intersects(
                        ReadFlags::DELETE_SELF | ReadFlags::IGNORED | ReadFlags::UNMOUNT,
                    ) {
                        self.stop = Some("session: the runtime directory went");
                        return;
                    }
                    if let Some(n) = e.file_name().and_then(|n| n.to_str().ok()) {
                        socket |= is_socket_name(n);
                    }
                }
                Err(Errno::INTR) => {}
                Err(_) => break,
            }
        }
        if socket {
            self.connect();
        }
    }

    fn parent_input(&mut self) {
        let mut buf = [0u8; 16384];
        let n = match read(&self.parent, &mut buf) {
            Ok(0) => return self.stop = Some("session: the parent is gone"),
            Ok(n) => n,
            Err(Errno::INTR) | Err(Errno::AGAIN) => return,
            Err(_) => return self.stop = Some("session: the parent is gone"),
        };
        let mut frames = Vec::new();
        self.pin
            .push(&buf[..n], |k, p| frames.push((k, p.to_vec())));
        if self.pin.broken() {
            self.stop = Some("session: the parent's stream went out of step");
            return;
        }
        for (k, p) in frames {
            self.frame(k, &p);
        }
    }

    fn frame(&mut self, kind: u8, p: &[u8]) {
        match kind {
            frame::PAUSE => self.pause(),
            frame::RESUME => self.paused = false,
            frame::OFFER => {
                if let Some(o) = frame::Offer::decode(p) {
                    self.host_offer(&o);
                }
            }
            frame::REQUEST => {
                if let Some(r) = frame::Request::decode(p) {
                    self.page_request(r);
                }
            }
            frame::DATA => {
                if let Some((id, flags, b)) = frame::decode_data(p) {
                    self.page_data(id, flags, b);
                }
            }
            frame::MORE => {
                if let Some((id, n)) = frame::decode_more(p) {
                    self.page_more(id, n);
                }
            }
            _ => {}
        }
    }

    fn pause(&mut self) {
        self.paused = true;
        if let (Some(h), Some(wl)) = (self.host.take(), self.wl.as_mut()) {
            if let Some(d) = wl.device {
                wl.msg(d, op::SET_SELECTION).object(0).done();
            }
            wl.destroy_source(h.source);
        }
        self.host = None;
        self.probe = None;
        self.guest = None;
        self.end_xfers();
    }

    /// Every transfer ends: the page's requests fail (DATA FAIL), ours stop (MORE 0).
    fn end_xfers(&mut self) {
        for x in std::mem::take(&mut self.xfers) {
            match x {
                Xfer::Out { id, .. } => self.fail(id),
                Xfer::In { id, ended, .. } if id != 0 && !ended => {
                    self.send(frame::MORE, |o| o.extend_from_slice(&frame::more(id, 0)))
                }
                Xfer::In { .. } => {}
            }
        }
    }

    /// The guest's clipboard changed hands (a compositor's data device came or went): the page hears SESSION, and the
    /// transfers of the one before end.
    fn changed_hands(&mut self) {
        self.end_xfers();
        self.send(frame::SESSION, |_| {});
    }

    // ---- The page's offer: our source in the guest's clipboard.

    fn host_offer(&mut self, o: &frame::Offer<'_>) {
        if self.paused {
            return self.ack(o.serial, ack::PAUSED);
        }
        let Some(&(mime, size)) = o.types.iter().find(|(t, _)| clip::is_page_text(t)) else {
            return self.ack(o.serial, ack::NO_TYPE);
        };
        // Inline bytes are the first type's.
        let inline = o.inline.filter(|_| o.types[0].0 == mime);
        if (size != frame::UNKNOWN && size as usize > clip::TEXT_CAP)
            || inline.is_some_and(|b| b.len() > clip::TEXT_CAP)
        {
            return self.ack(o.serial, ack::TOO_LARGE);
        }
        let Some(wl) = self.wl.as_mut() else {
            return self.ack(o.serial, ack::NO_SESSION);
        };
        let (Some(manager), Some(device)) = (wl.manager, wl.device) else {
            return self.ack(o.serial, ack::NO_SESSION);
        };
        if let Some(h) = self.host.take() {
            wl.destroy_source(h.source);
        }
        if let Some(s) = wl.selection.take() {
            wl.destroy_offer(s);
        }
        self.guest = None;
        self.probe = None;
        let source = wl.id(Obj::Source);
        wl.msg(manager, op::CREATE_DATA_SOURCE)
            .object(source)
            .done();
        for t in clip::TEXT_ALIASES {
            wl.msg(source, op::OFFER).string(t).done();
        }
        wl.msg(device, op::SET_SELECTION).object(source).done();
        let cb = wl.id(Obj::Ack(o.serial));
        wl.msg(DISPLAY, op::SYNC).object(cb).done();
        if let Some(b) = inline {
            self.last_host = Some(Hash::of(b));
        }
        self.host = Some(Host {
            serial: o.serial,
            source,
            mime: mime.to_owned(),
            cache: inline.map(|b| b.to_vec()),
        });
    }

    /// A guest program pastes the host's offer: its bytes into `fd`.
    fn host_send(&mut self, source: u32, fd: OwnedFd) {
        let Some(h) = self.host.as_ref().filter(|h| h.source == source) else {
            return;
        };
        nonblocking(&fd);
        let (serial, cache, mime) = (h.serial, h.cache.clone(), h.mime.clone());
        if let Some(buf) = cache {
            self.xfers.push(Xfer::In {
                id: 0,
                fd,
                ends: VecDeque::new(),
                at: 0,
                ended: true,
                serial,
                len: buf.len(),
                hash: Hash::default(),
                copy: None,
                buf,
            });
            return;
        }
        let id = self.next();
        self.send(frame::REQUEST, |o| {
            frame::Request {
                serial,
                id,
                mime: &mime,
            }
            .encode(o)
        });
        self.xfers.push(Xfer::In {
            id,
            fd,
            buf: Vec::new(),
            at: 0,
            ends: VecDeque::new(),
            ended: false,
            serial,
            len: 0,
            hash: Hash::default(),
            copy: Some(Vec::new()),
        });
    }

    fn page_data(&mut self, id: u32, flags: u8, b: &[u8]) {
        let Some(i) = self
            .xfers
            .iter()
            .position(|x| matches!(x, Xfer::In { id: x, ended: false, .. } if *x == id && id != 0))
        else {
            return;
        };
        let Xfer::In {
            buf,
            ends,
            ended,
            len,
            hash,
            copy,
            ..
        } = &mut self.xfers[i]
        else {
            unreachable!()
        };
        if flags & frame::DATA_FAIL != 0 {
            self.xfers.remove(i);
            return;
        }
        *len += b.len();
        if *len > clip::TEXT_CAP {
            self.xfers.remove(i);
            return self.send(frame::MORE, |o| o.extend_from_slice(&frame::more(id, 0)));
        }
        hash.add(b);
        if copy
            .as_ref()
            .is_some_and(|c| c.len() + b.len() > clip::CACHE)
        {
            *copy = None;
        }
        if let Some(c) = copy {
            c.extend_from_slice(b);
        }
        buf.extend_from_slice(b);
        ends.push_back(buf.len());
        *ended = flags & frame::DATA_END != 0;
        if !self.transfer(i) {
            self.xfers.remove(i);
        }
    }

    // ---- The guest's selection: an offer to the page.

    fn selection(&mut self, offer: u32) {
        let Some(wl) = self.wl.as_mut() else { return };
        if self.host.is_some() {
            // Our own source's (or one the compositor sent before it took ours).
            if offer != 0 {
                wl.destroy_offer(offer);
            }
            return;
        }
        if let Some(old) = wl.selection.take()
            && old != offer
        {
            wl.destroy_offer(old);
        }
        self.guest = None;
        self.probe = None;
        if offer == 0 {
            return;
        }
        wl.selection = Some(offer);
        if self.paused {
            return;
        }
        let types: Vec<&str> = wl
            .offers
            .get(&offer)
            .map_or(Vec::new(), |t| t.iter().map(|s| s.as_str()).collect());
        let Some(mime) = clip::pick_text(&types).map(str::to_owned) else {
            return;
        };
        let Some((r, w)) = pipe() else { return };
        nonblocking(&r);
        wl.msg(offer, op::RECEIVE).string(&mime).done();
        wl.conn.push_fd(w);
        let serial = self.next();
        self.probe = Some(Probe {
            serial,
            offer,
            mime,
            fd: r,
            buf: Vec::new(),
        });
    }

    fn probe(&mut self) {
        let Some(p) = self.probe.as_mut() else { return };
        let mut buf = [0u8; clip::INLINE + 1];
        let room = clip::INLINE + 1 - p.buf.len();
        let n = match read(&p.fd, &mut buf[..room]) {
            Ok(n) => n,
            Err(Errno::INTR) | Err(Errno::AGAIN) => return,
            Err(_) => {
                self.probe = None;
                return;
            }
        };
        p.buf.extend_from_slice(&buf[..n]);
        if n != 0 && p.buf.len() <= clip::INLINE {
            return;
        }
        let p = self.probe.take().unwrap();
        self.guest = Some(Guest {
            serial: p.serial,
            offer: p.offer,
            mime: p.mime,
        });
        let serial = p.serial;
        let (size, inline) = match clip::announce(&p.buf, n == 0, self.last_host) {
            clip::Announce::Inline => (p.buf.len() as u32, Some(&p.buf[..])),
            clip::Announce::Lazy => (frame::UNKNOWN, None),
            clip::Announce::Nothing => return,
        };
        self.send(frame::OFFER, |o| {
            frame::Offer {
                serial,
                types: vec![(clip::TEXT, size)],
                inline,
            }
            .encode(o)
        });
    }

    fn page_request(&mut self, r: frame::Request<'_>) {
        let ok = !self.paused && clip::is_page_text(r.mime);
        let (Some(g), Some(wl)) = (self.guest.as_ref().filter(|_| ok), self.wl.as_mut()) else {
            return self.fail(r.id);
        };
        if g.serial != r.serial || wl.selection != Some(g.offer) {
            return self.fail(r.id);
        }
        let Some((rd, w)) = pipe() else {
            return self.fail(r.id);
        };
        nonblocking(&rd);
        wl.msg(g.offer, op::RECEIVE).string(&g.mime).done();
        wl.conn.push_fd(w);
        self.xfers.push(Xfer::Out {
            id: r.id,
            fd: rd,
            credit: frame::CREDIT,
            sent: 0,
        });
    }

    fn page_more(&mut self, id: u32, n: u32) {
        let Some(i) = self
            .xfers
            .iter()
            .position(|x| matches!(x, Xfer::Out { id: x, .. } if *x == id))
        else {
            return;
        };
        if n == 0 {
            self.xfers.remove(i);
        } else if let Xfer::Out { credit, .. } = &mut self.xfers[i] {
            *credit = credit.saturating_add(n);
        }
    }

    /// Moves a transfer's bytes on; false once it has ended (it is then to be taken out).
    fn transfer(&mut self, i: usize) -> bool {
        match &mut self.xfers[i] {
            Xfer::Out {
                id,
                fd,
                credit,
                sent,
            } => {
                if *credit == 0 {
                    return true;
                }
                let mut buf = vec![0u8; frame::CHUNK];
                let n = match read(&*fd, &mut buf) {
                    Ok(n) => n,
                    Err(Errno::INTR) | Err(Errno::AGAIN) => return true,
                    Err(_) => {
                        let id = *id;
                        self.fail(id);
                        return false;
                    }
                };
                let id = *id;
                *sent += n;
                *credit -= 1;
                if *sent > clip::TEXT_CAP {
                    self.fail(id);
                    return false;
                }
                let flags = if n == 0 { frame::DATA_END } else { 0 };
                self.send(frame::DATA, |o| frame::data(id, flags, &buf[..n], o));
                n != 0
            }
            Xfer::In {
                id,
                fd,
                buf,
                at,
                ends,
                ended,
                serial,
                hash,
                copy,
                ..
            } => {
                let mut granted = 0;
                let mut ok = true;
                while *at < buf.len() {
                    match write(&*fd, &buf[*at..]) {
                        Ok(n) => *at += n,
                        Err(Errno::INTR) => {}
                        Err(Errno::AGAIN) => break,
                        Err(_) => {
                            ok = false;
                            break;
                        }
                    }
                }
                while ends.front().is_some_and(|&e| e <= *at) {
                    ends.pop_front();
                    granted += 1;
                }
                if *at == buf.len() {
                    buf.clear();
                    *at = 0;
                    if buf.capacity() > 4 * frame::CHUNK {
                        *buf = Vec::new();
                    }
                }
                let (id, serial, done) = (*id, *serial, *ended && buf.is_empty());
                if !ok {
                    if id != 0 && !*ended {
                        self.send(frame::MORE, |o| o.extend_from_slice(&frame::more(id, 0)));
                    }
                    return false;
                }
                if done {
                    if id != 0 {
                        self.last_host = Some(*hash);
                        let copy = copy.take();
                        if let Some(h) = self.host.as_mut().filter(|h| h.serial == serial) {
                            h.cache = copy;
                        }
                    }
                    return false;
                }
                if granted > 0 && id != 0 && !*ended {
                    self.send(frame::MORE, |o| {
                        o.extend_from_slice(&frame::more(id, granted))
                    });
                }
                true
            }
        }
    }

    // ---- The compositor's events.

    fn display_input(&mut self, revents: PollFlags) {
        let Some(wl) = self.wl.as_mut() else { return };
        if revents.contains(PollFlags::OUT) && wl.conn.flush().is_err() {
            return self.disconnect("the compositor's connection failed");
        }
        if !revents.intersects(PollFlags::IN | PollFlags::HUP | PollFlags::ERR) {
            return;
        }
        match wl.conn.fill() {
            Ok(true) => {}
            Ok(false) | Err(_) => return self.disconnect("the compositor closed the connection"),
        }
        let Wl { conn, objs, .. } = wl;
        let mut events = Vec::new();
        let r = conn.events(|e, fds| {
            let kind = objs.get(&e.object).copied();
            let fd = matches!(kind, Some(Obj::Source | Obj::DeadSource))
                .then_some(())
                .filter(|_| e.opcode == op::SEND)
                .and_then(|_| fds.pop_front());
            events.push((e.object, e.opcode, e.args.to_vec(), fd));
        });
        for (object, opcode, args, fd) in events {
            if self.wl.is_none() {
                return;
            }
            self.event(object, opcode, &args, fd);
        }
        if r.is_err() {
            self.disconnect("the compositor's stream went out of step");
        }
    }

    fn event(&mut self, object: u32, opcode: u16, args: &[u8], fd: Option<OwnedFd>) {
        let wl = self.wl.as_mut().unwrap();
        let mut a = Args(args);
        if object == DISPLAY {
            match opcode {
                op::ERROR => {
                    let (o, code) = (a.object(), a.uint());
                    let m = a.string().flatten().unwrap_or("");
                    let why = format!("the compositor's error on object {o:?}, code {code:?}: {m}");
                    self.disconnect(&why);
                }
                op::DELETE_ID => {
                    if let Some(id) = a.uint() {
                        wl.objs.remove(&id);
                    }
                }
                _ => {}
            }
            return;
        }
        let Some(kind) = wl.objs.get(&object).copied() else {
            return;
        };
        match (kind, opcode) {
            (Obj::Registry, op::GLOBAL) => {
                let (Some(name), Some(Some(iface)), Some(_version)) =
                    (a.uint(), a.string(), a.uint())
                else {
                    return;
                };
                if iface == "wl_seat" && wl.seat.is_none() {
                    // The first seat; bound once the globals are all known (Init).
                    wl.seat = Some(name);
                }
                if let Some(k) = MANAGERS.iter().position(|m| *m == iface) {
                    wl.managers[k] = Some(name);
                }
            }
            (Obj::Init, op::DONE) => {
                wl.objs.insert(object, Obj::Dead);
                let k = wl.managers.iter().position(Option::is_some);
                let (Some(seat), Some(k)) = (wl.seat, k) else {
                    if !self.told {
                        self.told = true;
                        log(
                            "session: the compositor has no data-control (ext_data_control_manager_v1, zwlr_data_control_manager_v1): no clipboard",
                            None,
                        );
                    }
                    return;
                };
                let seat_id = wl.id(Obj::Seat);
                wl.msg(FIRST_ID, op::BIND)
                    .uint(seat)
                    .string("wl_seat")
                    .uint(1)
                    .object(seat_id)
                    .done();
                let name = wl.managers[k].unwrap();
                let manager = wl.id(Obj::Manager);
                wl.msg(FIRST_ID, op::BIND)
                    .uint(name)
                    .string(MANAGERS[k])
                    .uint(1)
                    .object(manager)
                    .done();
                let device = wl.id(Obj::Device);
                wl.msg(manager, op::GET_DATA_DEVICE)
                    .object(device)
                    .object(seat_id)
                    .done();
                wl.manager = Some(manager);
                wl.device = Some(device);
                log(
                    &format!("session: on the compositor's {}", MANAGERS[k]),
                    None,
                );
                self.changed_hands();
            }
            (Obj::Ack(serial), op::DONE) => {
                wl.objs.insert(object, Obj::Dead);
                if self.host.as_ref().is_some_and(|h| h.serial == serial) {
                    self.ack(serial, ack::HELD);
                }
            }
            (Obj::Device, op::DATA_OFFER) => {
                if let Some(id) = a.object() {
                    wl.objs.insert(id, Obj::Offer);
                    wl.offers.insert(id, Vec::new());
                }
            }
            (Obj::Device, op::SELECTION) => {
                if let Some(id) = a.object() {
                    self.selection(id);
                }
            }
            (Obj::Device, op::PRIMARY_SELECTION) => {
                if let Some(id) = a.object().filter(|&id| id != 0) {
                    wl.destroy_offer(id);
                }
            }
            (Obj::Device, op::FINISHED) => {
                // The seat went: the device is no more (destroyed, as the protocol asks).
                wl.msg(object, op::DESTROY).done();
                wl.objs.insert(object, Obj::Dead);
                wl.device = None;
                self.host = None;
                self.guest = None;
                self.probe = None;
                self.changed_hands();
            }
            (Obj::Offer, op::OFFER) => {
                if let (Some(Some(t)), Some(types)) = (a.string(), wl.offers.get_mut(&object))
                    && types.len() < MAX_TYPES
                {
                    types.push(t.to_owned());
                }
            }
            (Obj::Source, op::SEND) => {
                if let (Some(fd), Some(Some(_mime))) = (fd, a.string()) {
                    self.host_send(object, fd);
                }
            }
            (Obj::Source, op::CANCELLED) => {
                // Another program took the selection (or we did, with a newer source).
                wl.destroy_source(object);
                if self.host.as_ref().is_some_and(|h| h.source == object) {
                    self.host = None;
                }
            }
            _ => {}
        }
    }
}

/// A compositor's socket in a runtime directory: `wayland-<n>` (not its `.lock`).
pub fn is_socket_name(n: &str) -> bool {
    n.strip_prefix("wayland-")
        .is_some_and(|rest| !rest.is_empty() && !rest.ends_with(".lock"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_compositors_socket() {
        assert!(is_socket_name("wayland-1") && is_socket_name("wayland-0"));
        assert!(
            !is_socket_name("wayland-1.lock")
                && !is_socket_name("wayland-")
                && !is_socket_name("pipewire-0")
        );
    }
}
