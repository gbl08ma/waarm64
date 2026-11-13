//! A session child (docs/plans/clipboard.md §3.2–§3.3): forked by the root process for the active session's user and
//! running as that user, it shares the clipboard of the user's Wayland compositor through data-control
//! (`ext_data_control_manager_v1`, or `zwlr_data_control_manager_v1` where there is no ext one: the two protocols'
//! messages are the same), a client written by hand (src/wire.rs). It finds the compositor's socket in the user's
//! runtime directory, watched with inotify (a user starts sway from a tty long after the agent starts), and comes and
//! goes with it. Where there is no compositor, or one without data-control, it shares the X server's CLIPBOARD
//! instead (src/x11.rs: an Xorg session, or Xwayland under such a compositor), the display's socket watched in
//! `/tmp/.X11-unix` the same way; where data-control exists, Wayland's way stays (the compositor syncs Xwayland's
//! selection with its own). Its frames go to the page through the parent, over a socketpair, in the port's own format.
//!
//! The two ways are one to the rest of this file: a guest program's selection is an offer with types, read through a
//! pipe (X11's conversions are pipes too, src/x11.rs); our source's bytes go into a pipe a paste reads.
//!
//! - **Guest to host:** a guest program's selection with text becomes an OFFER. Its first 4 KiB are read at once:
//!   text that fits goes inline (`clip::INLINE`), unless it is what the host last gave (echo suppression: its hash);
//!   longer text is offered without bytes and read when the page sends a REQUEST, in DATA frames as the page's MOREs
//!   allow. An image (`clip::pick_image`: PNG first, else a type the page converts) joins the OFFER as its program's
//!   type, never read but for a REQUEST (plan §4.4: the agent holds no image). Its HTML too (`text/html`, after them).
//! - **Host to guest:** the page's OFFER (text, `image/png`, `text/html`, or several, each within its cap by the offer's size) becomes a
//!   data source of ours, set as the selection; ACK says so once the compositor has it. A guest program's paste
//!   (`send`) streams the page's DATA into its pipe, requested each time but for text of 64 KiB or less, kept once it
//!   has crossed (`clip::CACHE`; an image never). Our own source's selection isn't offered back.
//! - **PAUSE:** our source goes (the guest's clipboard is cleared if it held the host's data), transfers stop, the
//!   guest's selections are ignored until RESUME.
//! - **SESSION:** when the data device comes (a compositor's, bound) or goes (the compositor gone, its seat gone), the
//!   page hears SESSION and every transfer ends: the guest's clipboard the page knew is another's now.
//!
//! One thread in `ppoll` on the parent's socket, the inotify descriptor, the compositor's socket and the pipes of
//! transfers in progress; no timeout but for the `RETRIES` after a socket that refuses connections comes (a
//! compositor between its bind and its listen; one killed leaves a socket that refuses for good, given up then), and
//! X11's wait for an owner that doesn't answer (`x11::OWNER_WAIT`). Its connects are nonblocking: a display stopped
//! with its backlog full refuses rather than holding the thread. The page's HELLO (passed on by the parent) ends the
//! transfers in flight (they were an earlier page's), drops the host's offer unless its text is whole in the cache, and
//! offers the guest's selection again (`hello`).

use crate::clip::{self, Hash};
use crate::frame::{self, ack};
use crate::log;
use crate::outputs::{self, Outputs};
use crate::prelude::*;
use crate::rt::{self, Instant};
use crate::wire::{Args, Conn, Msg};
use crate::x11::{self, X};
use alloc::collections::{BTreeMap, VecDeque};
use core::mem::MaybeUninit;
use core::time::Duration;
use rustix::event::{PollFd, PollFlags, Timespec, poll};
use rustix::fd::{AsRawFd, OwnedFd, RawFd};
use rustix::fs::inotify::{self, CreateFlags, ReadFlags, WatchFlags};
use rustix::fs::{OFlags, fcntl_getfl, fcntl_setfl};
use rustix::io::{Errno, read, write};
use rustix::net::{AddressFamily, SocketAddrUnix, SocketFlags, SocketType, connect, socket_with};

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
const RETRY: Duration = Duration::from_millis(200);
#[cfg(test)]
const RETRY_FOR: Duration = Duration::from_millis(RETRIES as u64 * 200);
/// A guest program's types, and their length, past which the rest are ignored.
const MAX_TYPES: usize = 32;

/// What an object of ours is.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Obj {
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
    /// wlr-output-management's (src/outputs.rs): the manager, a head and a mode (the compositor's objects), a
    /// configuration of ours.
    OutManager,
    Head,
    Mode,
    OutConfig,
}

/// The connection to the compositor and what is known of it.
pub(crate) struct Wl {
    pub(crate) conn: Conn,
    pub(crate) objs: BTreeMap<u32, Obj>,
    /// The types of offers the compositor has introduced.
    offers: BTreeMap<u32, Vec<String>>,
    next: u32,
    seat: Option<u32>,
    managers: [Option<u32>; 2],
    manager: Option<u32>,
    device: Option<u32>,
    /// The guest's selection (a guest program's offer), not ours.
    selection: Option<u32>,
    /// The first roundtrip came: the globals are known (with no data-control among them, X11's way is tried).
    inited: bool,
    /// Its outputs (wlr-output-management), for DISPLAY's size.
    pub(crate) outputs: Outputs,
}

impl Wl {
    pub(crate) fn id(&mut self, kind: Obj) -> u32 {
        let id = self.next;
        self.next += 1;
        self.objs.insert(id, kind);
        id
    }

    pub(crate) fn msg(&mut self, object: u32, opcode: u16) -> Msg<'_> {
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
    /// The guest program's types the page may request: its text's (offered as `clip::TEXT`) and its image's (offered
    /// as it is).
    text: Option<String>,
    image: Option<String>,
    html: Option<String>,
}

/// The first bytes of the guest's selection's text, being read for its OFFER (with its image's type, if it has one).
struct Probe {
    serial: u32,
    offer: u32,
    mime: String,
    image: Option<String>,
    html: Option<String>,
    fd: OwnedFd,
    buf: Vec<u8>,
}

/// The page's offer, as our source in the guest's clipboard: text (the page's type for it), an image (`image/png`), HTML,
/// or several.
struct Host {
    serial: u32,
    /// Its source: a Wayland object's id, or X11's (src/x11.rs `own`).
    source: u32,
    text: Option<String>,
    image: bool,
    html: bool,
    /// Its text once it crossed whole (up to `clip::CACHE`), or inline; images are never kept.
    cache: Option<Vec<u8>>,
}

enum Xfer {
    /// A guest program's bytes to the page, for the page's request `id`.
    Out {
        id: u32,
        fd: OwnedFd,
        credit: u32,
        sent: usize,
        /// The most it sends (`clip::cap` of its type).
        cap: usize,
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
        /// X11's serve (src/x11.rs `served`), 0 on Wayland.
        xserve: u32,
        len: usize,
        /// The most it takes (`clip::cap` of its type).
        cap: usize,
        /// Text (its hash and its copy kept once whole), not an image (streamed, nothing kept).
        text: bool,
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

/// Where a session's displays are: its runtime directory (Wayland's sockets), X11's sockets' directory (empty: none),
/// and the display its session file names (`DISPLAY=`, an X11 session's); and what the child is for.
pub struct Where {
    pub runtime: String,
    pub x11: String,
    pub display: Option<u32>,
    pub jobs: Jobs,
}

/// A session child's jobs, from the page's HELLO: the clipboard shared (`cap::TEXT`, `cap::IMAGE`), the screen's size
/// followed (`cap::DISPLAY`).
#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
pub struct Jobs {
    pub clip: bool,
    pub resize: bool,
}

impl Jobs {
    pub fn from_caps(caps: u32) -> Jobs {
        Jobs {
            clip: caps & (frame::cap::TEXT | frame::cap::IMAGE) != 0,
            resize: caps & frame::cap::DISPLAY != 0,
        }
    }

    pub fn any(&self) -> bool {
        self.clip || self.resize
    }
}

/// X11's sockets.
pub const X11_DIR: &str = "/tmp/.X11-unix";

struct Child {
    parent: OwnedFd,
    pin: frame::Reader,
    pout: Vec<u8>,
    runtime: String,
    ino: OwnedFd,
    /// The runtime directory's watch, and X11's sockets' (None: no such directory).
    run_wd: i32,
    x_wd: Option<i32>,
    wl: Option<Wl>,
    /// Tries left at a socket that refused.
    retries: u32,
    /// The X server's connection, where Wayland has no data-control.
    x: Option<X>,
    x11: String,
    x_hint: Option<u32>,
    xretries: u32,
    /// Displays whose servers refused us (a cookie not found yet): tried again only by the retries, or once their
    /// socket comes again.
    x_refused: Vec<u32>,
    uid: u32,
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
    jobs: Jobs,
    /// The page's screen size (DISPLAY), which the outputs are set to.
    want: Option<(u32, u32)>,
}

#[derive(Clone, Copy)]
enum Tag {
    Parent,
    Ino,
    Wl,
    Probe,
    X,
    /// A pipe of X11's transfers (src/x11.rs), by its descriptor.
    XPipe(RawFd),
    /// A transfer, by its descriptor (transfers come and go while the events of one poll are handled).
    Xfer(RawFd),
}

pub fn nonblocking(fd: &OwnedFd) {
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
pub fn run(parent: OwnedFd, at: Where, base: u32) -> ! {
    match serve_at(parent, at, base) {
        Ok(why) => {
            log(why, None);
            crate::rt::exit(0)
        }
        Err((why, e)) => {
            log(why, Some(e));
            crate::rt::exit(1)
        }
    }
}

/// `run`'s loop, which returns why it ended (the tests run it on a thread of theirs): Wayland's only (no X11
/// directory), for the clipboard.
#[cfg(test)]
pub fn serve(
    parent: OwnedFd,
    runtime: String,
    base: u32,
) -> Result<&'static str, (&'static str, Errno)> {
    serve_for(
        parent,
        runtime,
        base,
        Jobs {
            clip: true,
            resize: false,
        },
    )
}

/// `serve` for `jobs`.
#[cfg(test)]
pub fn serve_for(
    parent: OwnedFd,
    runtime: String,
    base: u32,
    jobs: Jobs,
) -> Result<&'static str, (&'static str, Errno)> {
    serve_at(
        parent,
        Where {
            runtime,
            x11: String::new(),
            display: None,
            jobs,
        },
        base,
    )
}

/// `run`'s loop, at `at`.
pub fn serve_at(
    parent: OwnedFd,
    at: Where,
    base: u32,
) -> Result<&'static str, (&'static str, Errno)> {
    nonblocking(&parent);
    let ino = inotify::init(CreateFlags::CLOEXEC | CreateFlags::NONBLOCK)
        .map_err(|e| ("session: inotify", e))?;
    let run_wd = inotify::add_watch(
        &ino,
        at.runtime.as_str(),
        WatchFlags::CREATE | WatchFlags::MOVED_TO | WatchFlags::DELETE_SELF | WatchFlags::ONLYDIR,
    )
    .map_err(|e| ("session: can't watch the runtime directory", e))?;
    // X11's sockets, if the directory is there (the unit binds it into its private /tmp).
    let x_wd = if at.x11.is_empty() {
        None
    } else {
        inotify::add_watch(
            &ino,
            at.x11.as_str(),
            WatchFlags::CREATE | WatchFlags::MOVED_TO | WatchFlags::ONLYDIR,
        )
        .ok()
    };
    let mut c = Child {
        parent,
        pin: frame::Reader::default(),
        pout: Vec::new(),
        runtime: at.runtime,
        ino,
        run_wd,
        x_wd,
        wl: None,
        retries: 0,
        x: None,
        x11: at.x11,
        x_hint: at.display,
        xretries: 0,
        x_refused: Vec::new(),
        uid: rustix::process::getuid().as_raw(),
        paused: false,
        next: base,
        guest: None,
        probe: None,
        host: None,
        last_host: None,
        xfers: Vec::new(),
        told: false,
        stop: None,
        jobs: at.jobs,
        want: None,
    };
    c.connect(true);
    c.x_try(true, false);
    loop {
        // X11's conversions whose owner never answered end (x11::OWNER_WAIT).
        if let Some(x) = c.x.as_mut()
            && x.deadline().is_some_and(|d| d <= Instant::now())
        {
            let mut evs = Vec::new();
            x.expire(Instant::now(), &mut evs);
            c.x_events(evs);
        }
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
        if let Some(x) = &c.x {
            let f = if x.pending() {
                PollFlags::IN | PollFlags::OUT
            } else {
                PollFlags::IN
            };
            fds.push(PollFd::new(&x.fd, f));
            tags.push(Tag::X);
            for (fd, f) in x.polls() {
                tags.push(Tag::XPipe(fd.as_raw_fd()));
                fds.push(PollFd::from_borrowed_fd(fd, f));
            }
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
        let (wl_retry, x_retry) = (
            c.wl.is_none() && c.retries > 0,
            c.x.is_none() && c.xretries > 0,
        );
        // The retries' tick, or an X11 owner's wait ending sooner.
        let retry = (wl_retry || x_retry).then_some(RETRY);
        let due =
            c.x.as_ref()
                .and_then(|x| x.deadline())
                .map(|d| d.saturating_duration_since(Instant::now()));
        let wait = match (retry, due) {
            (Some(r), Some(d)) => Some(r.min(d)),
            (r, d) => r.or(d),
        };
        let by_retry = retry.is_some() && wait == retry;
        let timeout = wait.map(|w| Timespec {
            tv_sec: w.as_secs() as i64,
            tv_nsec: w.subsec_nanos() as i64,
        });
        match poll(&mut fds, timeout.as_ref()) {
            Ok(0) if !by_retry => continue,
            Ok(0) => {
                drop(fds);
                if wl_retry {
                    c.retries -= 1;
                    c.connect(false);
                }
                if x_retry {
                    c.xretries -= 1;
                    c.x_try(false, true);
                }
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
                Tag::X => c.x_input(revents),
                Tag::XPipe(fd) => {
                    let mut evs = Vec::new();
                    if let Some(x) = c.x.as_mut() {
                        x.pipe_ready(fd, &mut evs);
                    }
                    c.x_events(evs);
                }
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
        if let Some(x) = &mut self.x
            && let Err(e) = x.flush()
        {
            self.x_disconnect(&format!(
                "the X server's connection failed (errno {})",
                e.raw_os_error()
            ));
        }
    }

    /// Connects to the first compositor's socket in the runtime directory that takes it. `arm`: a socket that refuses
    /// is tried again `RETRIES` times (a compositor between its bind and its listen), the first time a socket comes
    /// (or the connection went) only, so that one that refuses for good (its compositor killed: the file stays) is
    /// given up.
    fn connect(&mut self, arm: bool) {
        if self.wl.is_some() {
            return;
        }
        let Ok(dir) = crate::rt::dir_names(&self.runtime) else {
            return;
        };
        let mut names: Vec<String> = dir.into_iter().filter(|n| is_socket_name(n)).collect();
        rt::sort(&mut names);
        let mut refused = false;
        for n in names {
            let path = format!("{}/{n}", self.runtime);
            let Ok(addr) = SocketAddrUnix::new(path.as_str()) else {
                continue;
            };
            // Nonblocking: a compositor stopped (SIGSTOP, a debugger) with its backlog full refuses (`AGAIN`) rather
            // than holding the child's one thread in `connect`.
            let Ok(fd) = socket_with(
                AddressFamily::UNIX,
                SocketType::STREAM,
                SocketFlags::CLOEXEC | SocketFlags::NONBLOCK,
                None,
            ) else {
                return;
            };
            match connect(&fd, &addr) {
                Ok(()) => {
                    let mut wl = Wl {
                        conn: Conn::new(fd),
                        objs: BTreeMap::new(),
                        offers: BTreeMap::new(),
                        next: FIRST_ID,
                        seat: None,
                        managers: [None, None],
                        manager: None,
                        device: None,
                        selection: None,
                        inited: false,
                        outputs: Outputs::default(),
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
        if refused && arm && self.retries == 0 {
            self.retries = RETRIES;
        }
    }

    fn disconnect(&mut self, why: &str) {
        if let Some(wl) = self.wl.take() {
            log(&format!("session: {why}"), None);
            if wl.device.is_some() {
                self.changed_hands();
                self.host = None;
                self.guest = None;
                self.probe = None;
            }
        }
        self.connect(true);
        self.x_try(true, false);
    }

    // ---- X11's way (src/x11.rs): where Wayland has no data-control.

    /// Whether the X server is wanted: its clipboard to be shared (no compositor, or one known to have no
    /// data-control), or its screen's size set (no compositor: an X11 session; under a compositor Xwayland's screen is
    /// the compositor's).
    fn x_wanted(&self) -> bool {
        let clip = self.jobs.clip
            && self
                .wl
                .as_ref()
                .is_none_or(|w| w.inited && w.device.is_none());
        !self.x11.is_empty() && (clip || (self.jobs.resize && self.wl.is_none()))
    }

    /// The X server's clipboard is the one shared (its connection set up).
    fn x_ready(&self) -> bool {
        self.x.as_ref().is_some_and(|x| x.ready)
    }

    /// Connects to the session's X server (`x11::displays`), with its cookie (`x11::cookie`). `arm`: a socket that
    /// refuses is tried again `RETRIES` times; `retrying` (one of those tries): the displays that refused us too.
    fn x_try(&mut self, arm: bool, retrying: bool) {
        if self.x.is_some() || !self.x_wanted() {
            return;
        }
        let procs = x11::processes("/proc", self.uid);
        let mut refused = false;
        for n in x11::displays(&self.x11, self.x_hint, &procs) {
            if self.x_refused.contains(&n) && !retrying {
                continue;
            }
            let home = x11::home_of(self.uid);
            let cookie = x11::cookie(n, &procs, home.as_deref());
            let jobs = x_jobs(self.jobs, self.wl.is_some());
            match X::connect(&self.x11, n, cookie.as_deref(), self.uid, jobs) {
                Ok(mut x) => {
                    if let Some(size) = self.want {
                        x.resize(size);
                    }
                    self.x = Some(x);
                    self.xretries = 0;
                    return;
                }
                Err(Errno::CONNREFUSED) | Err(Errno::AGAIN) => refused = true,
                Err(_) => {}
            }
        }
        if refused && arm && self.xretries == 0 {
            self.xretries = RETRIES;
        }
    }

    /// The X server's connection ends: if its clipboard was shared, the page hears SESSION. A server that refused us
    /// (its setup not done) is tried again by the retries, the first time.
    fn x_disconnect(&mut self, why: &str) {
        let Some(x) = self.x.take() else { return };
        log(&format!("session: {why} (:{})", x.display), None);
        if x.ready {
            self.changed_hands();
            self.host = None;
            self.guest = None;
            self.probe = None;
        }
        if x.ready || x.is_set_up() {
            self.x_try(true, false);
        } else if !self.x_refused.contains(&x.display) {
            self.x_refused.push(x.display);
            self.xretries = RETRIES;
        }
    }

    fn x_input(&mut self, revents: PollFlags) {
        let Some(x) = self.x.as_mut() else { return };
        if revents.contains(PollFlags::OUT) && x.flush().is_err() {
            return self.x_disconnect("the X server's connection failed");
        }
        if !revents.intersects(PollFlags::IN | PollFlags::HUP | PollFlags::ERR) {
            return;
        }
        let mut evs = Vec::new();
        let r = x.input(&mut evs);
        self.x_events(evs);
        if let Err(why) = r {
            self.x_disconnect(&why);
        }
    }

    fn x_events(&mut self, evs: Vec<x11::Ev>) {
        for e in evs {
            if self.x.is_none() {
                return;
            }
            match e {
                x11::Ev::Ready => {
                    let n = self.x.as_ref().unwrap().display;
                    log(
                        &format!("session: on the X server's CLIPBOARD (:{n})"),
                        None,
                    );
                    self.changed_hands();
                }
                x11::Ev::Selection { offer, types } => self.selection(offer, types),
                x11::Ev::Send {
                    source,
                    mime,
                    fd,
                    serve,
                } => self.host_send(source, fd, &mime, serve),
                x11::Ev::Cancelled { source } => {
                    if self.host.as_ref().is_some_and(|h| h.source == source) {
                        self.host = None;
                    }
                }
                x11::Ev::Held { serial } => {
                    if self.host.as_ref().is_some_and(|h| h.serial == serial) {
                        self.ack(serial, ack::HELD);
                    }
                }
            }
        }
    }

    /// A pipe that the guest's offer `offer`'s bytes as `mime` come out of (its reading end, nonblocking).
    fn receive(&mut self, offer: u32, mime: &str) -> Option<OwnedFd> {
        let fd = if self.x_ready() {
            self.x.as_mut()?.receive(offer, mime)?
        } else {
            let wl = self.wl.as_mut()?;
            let (r, w) = pipe()?;
            wl.msg(offer, op::RECEIVE).string(mime).done();
            wl.conn.push_fd(w);
            r
        };
        nonblocking(&fd);
        Some(fd)
    }

    /// The guest's current selection (a guest program's offer), if there is one.
    fn current(&self) -> Option<u32> {
        if self.x_ready() {
            self.x.as_ref()?.selection()
        } else {
            self.wl.as_ref()?.selection
        }
    }

    fn inotify(&mut self) {
        let mut buf = [MaybeUninit::uninit(); 1024];
        let mut r = inotify::Reader::new(&self.ino, &mut buf);
        let (mut socket, mut xsocket) = (false, false);
        loop {
            match r.next() {
                Ok(e) => {
                    let n = e.file_name().and_then(|n| n.to_str().ok()).unwrap_or("");
                    let overflow = e.events().contains(ReadFlags::QUEUE_OVERFLOW);
                    if overflow {
                        // Events lost: a display's socket may have come (again).
                        xsocket = true;
                        self.x_refused.clear();
                    } else if Some(e.wd()) == self.x_wd {
                        // A display's socket came (again): a server that refused us is tried again.
                        if x11::is_socket_name(n) {
                            xsocket = true;
                            self.x_refused.retain(|d| n[1..] != d.to_string());
                        }
                        continue;
                    }
                    if e.wd() == self.run_wd
                        && e.events().intersects(
                            ReadFlags::DELETE_SELF | ReadFlags::IGNORED | ReadFlags::UNMOUNT,
                        )
                    {
                        self.stop = Some("session: the runtime directory went");
                        return;
                    }
                    socket |= socket_event(e.events(), n);
                }
                Err(Errno::INTR) => {}
                Err(_) => break,
            }
        }
        if socket {
            self.connect(true);
        }
        if xsocket {
            self.x_try(true, false);
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
            frame::HELLO => self.hello(),
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
            frame::DISPLAY if self.jobs.resize => {
                if let Some(size) = frame::decode_display(p) {
                    self.want = Some(size);
                    if let Some(wl) = self.wl.as_mut() {
                        wl.resize(size);
                    }
                    if let Some(x) = self.x.as_mut() {
                        x.resize(size);
                    }
                }
            }
            _ => {}
        }
    }

    /// The page's HELLO, which the parent passes on (a new page, a restored one, the port reopened), whose page knows
    /// nothing of the one before:
    /// - The transfers in flight were the page's before, which won't answer them; they end, without a word to the new
    ///   page. A guest program pasting gets its pipe's end rather than a wait for DATA that won't come.
    /// - The host's offer goes (the guest's clipboard cleared), unless its pastes need no page (text only, whole in the
    ///   cache): its other types' REQUESTs name a serial the new page never gave.
    /// - The guest's selection is offered again, under a new serial: the new page never had it.
    fn hello(&mut self) {
        self.xfers.clear();
        if self
            .host
            .as_ref()
            .is_some_and(|h| h.image || h.html || h.cache.is_none())
        {
            self.clear_host();
        }
        if self.paused {
            return;
        }
        if let Some(g) = self.guest.take()
            && self.current() == Some(g.offer)
        {
            let types = [g.text, g.image, g.html].into_iter().flatten().collect();
            self.selection(g.offer, types);
        }
    }

    /// Our source goes, and the guest's clipboard with it if it holds it.
    fn clear_host(&mut self) {
        if let Some(h) = self.host.take() {
            if self.x_ready() {
                self.x.as_mut().unwrap().disown(h.source, true);
            } else if let Some(wl) = self.wl.as_mut() {
                if let Some(d) = wl.device {
                    wl.msg(d, op::SET_SELECTION).object(0).done();
                }
                wl.destroy_source(h.source);
            }
        }
    }

    fn pause(&mut self) {
        self.paused = true;
        self.clear_host();
        self.probe = None;
        self.guest = None;
        self.end_xfers();
    }

    /// Every transfer ends: the page's requests fail (DATA FAIL), ours stop (MORE 0).
    fn end_xfers(&mut self) {
        for x in core::mem::take(&mut self.xfers) {
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
        let text = o.types.iter().find(|(t, _)| clip::is_page_text(t));
        let image = o
            .types
            .iter()
            .find(|(t, _)| t.eq_ignore_ascii_case(clip::PNG));
        let html = o.types.iter().find(|(t, _)| clip::is_html(t));
        if text.is_none() && image.is_none() && html.is_none() {
            return self.ack(o.serial, ack::NO_TYPE);
        }
        // Each type against its cap by the offer's size, before any bytes cross (plan §3.2, §4.4); inline bytes are the
        // first type's. A type past its cap is left out; none left: too large.
        let inline = text.and_then(|&(t, _)| o.inline.filter(|_| o.types[0].0 == t));
        let fits = |&&(t, size): &&(&str, u32)| {
            (size == frame::UNKNOWN || size as usize <= clip::cap(t))
                && !(clip::is_page_text(t) && inline.is_some_and(|b| b.len() > clip::TEXT_CAP))
        };
        let (text, image, html) = (text.filter(fits), image.filter(fits), html.filter(fits));
        if text.is_none() && image.is_none() && html.is_none() {
            return self.ack(o.serial, ack::TOO_LARGE);
        }
        let inline = inline.filter(|_| text.is_some());
        let host = |source| Host {
            serial: o.serial,
            source,
            text: text.map(|&(t, _)| t.to_owned()),
            image: image.is_some(),
            html: html.is_some(),
            cache: inline.map(|b| b.to_vec()),
        };
        if self.x_ready() {
            let x = self.x.as_mut().unwrap();
            if let Some(h) = self.host.take() {
                x.disown(h.source, false);
            }
            self.guest = None;
            self.probe = None;
            let source = x.own(o.serial, text.is_some(), image.is_some(), html.is_some());
            self.last_host = inline.map(Hash::of);
            self.host = Some(host(source));
            return;
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
        if text.is_some() {
            for t in clip::TEXT_ALIASES {
                wl.msg(source, op::OFFER).string(t).done();
            }
        }
        if html.is_some() {
            wl.msg(source, op::OFFER).string(clip::HTML).done();
        }
        // `image/png` alone: the name programs ask an image by (plan §4.4).
        if image.is_some() {
            wl.msg(source, op::OFFER).string(clip::PNG).done();
        }
        wl.msg(device, op::SET_SELECTION).object(source).done();
        let cb = wl.id(Obj::Ack(o.serial));
        wl.msg(DISPLAY, op::SYNC).object(cb).done();
        // The guest's clipboard has the host's text now: its hash if known (else once a paste has it whole).
        self.last_host = inline.map(Hash::of);
        self.host = Some(host(source));
    }

    /// A guest program pastes the host's offer as `mime`: its bytes into `fd` (closed at once for a type the offer
    /// hasn't). `xserve`: X11's serve it is (`x11::X::served` once the bytes came whole), 0 on Wayland.
    fn host_send(&mut self, source: u32, fd: OwnedFd, mime: &str, xserve: u32) {
        let Some(h) = self.host.as_ref().filter(|h| h.source == source) else {
            return;
        };
        let image = clip::is_image(mime);
        let html = clip::is_html(mime);
        let (serial, cache, mime) = match (&h.text, image) {
            (_, true) if h.image && mime.eq_ignore_ascii_case(clip::PNG) => {
                (h.serial, None, clip::PNG.to_owned())
            }
            (_, false) if h.html && html => (h.serial, None, clip::HTML.to_owned()),
            (Some(t), false) if clip::TEXT_ALIASES.contains(&mime) => {
                (h.serial, h.cache.clone(), t.clone())
            }
            _ => return,
        };
        nonblocking(&fd);
        if let Some(buf) = cache {
            self.xfers.push(Xfer::In {
                id: 0,
                fd,
                ends: VecDeque::new(),
                at: 0,
                ended: true,
                serial,
                xserve,
                len: buf.len(),
                cap: clip::TEXT_CAP,
                text: true,
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
            xserve,
            len: 0,
            cap: clip::cap(&mime),
            text: !image && !html,
            hash: Hash::default(),
            // An image is streamed, never kept (plan §4.4: the agent holds none); HTML isn't kept either.
            copy: (!image && !html).then(Vec::new),
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
            cap,
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
        if *len > *cap {
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

    /// The guest's selection changed hands: `offer` (0: none) with `types` (X11's; a Wayland offer's are its own,
    /// `Wl::offers`).
    fn selection(&mut self, offer: u32, types: Vec<String>) {
        let x = self.x_ready();
        if !x && self.wl.is_none() {
            return;
        }
        if self.host.is_some() {
            // Our own source's (or one the compositor sent before it took ours).
            if let Some(wl) = self.wl.as_mut().filter(|_| !x && offer != 0) {
                wl.destroy_offer(offer);
            }
            return;
        }
        let mut types = types;
        if !x {
            let wl = self.wl.as_mut().unwrap();
            if let Some(old) = wl.selection.take()
                && old != offer
            {
                wl.destroy_offer(old);
            }
            if offer != 0 {
                wl.selection = Some(offer);
                types = wl.offers.get(&offer).cloned().unwrap_or_default();
            }
        }
        self.guest = None;
        self.probe = None;
        if offer == 0 {
            // The clipboard emptied: it hasn't the host's text any more.
            self.last_host = None;
            return;
        }
        if self.paused {
            return;
        }
        let types: Vec<&str> = types.iter().map(|s| s.as_str()).collect();
        let image = clip::pick_image(&types).map(str::to_owned);
        let html = types
            .iter()
            .find(|t| clip::is_html(t))
            .map(|t| t.to_string());
        let Some(mime) = clip::pick_text(&types).map(str::to_owned) else {
            // No text: an image or HTML is offered at once (its bytes when the page asks), else nothing.
            self.last_host = None;
            if image.is_some() || html.is_some() {
                let serial = self.next();
                self.offer_guest(serial, offer, None, image, html);
            }
            return;
        };
        let Some(r) = self.receive(offer, &mime) else {
            return;
        };
        let serial = self.next();
        self.probe = Some(Probe {
            serial,
            offer,
            mime,
            image,
            html,
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
                // The text unread: its image, if it has one, is offered alone.
                let p = self.probe.take().unwrap();
                if p.image.is_some() || p.html.is_some() {
                    self.last_host = None;
                    self.offer_guest(p.serial, p.offer, None, p.image, p.html);
                }
                return;
            }
        };
        p.buf.extend_from_slice(&buf[..n]);
        if n != 0 && p.buf.len() <= clip::INLINE {
            return;
        }
        let p = self.probe.take().unwrap();
        let text = match clip::announce(&p.buf, n == 0, self.last_host) {
            clip::Announce::Inline => Some((p.mime, p.buf.len() as u32, Some(p.buf))),
            clip::Announce::Lazy => Some((p.mime, frame::UNKNOWN, None)),
            clip::Announce::Nothing => {
                // The host's text back (the hash still stands, unless an image came with it), or nothing at all (it
                // doesn't).
                if p.buf.is_empty() || p.image.is_some() {
                    self.last_host = None;
                }
                // HTML that came with the host's own text back is the host's too: not offered.
                if p.image.is_some() {
                    let html = p.html.filter(|_| p.buf.is_empty());
                    self.offer_guest(p.serial, p.offer, None, p.image, html);
                }
                return;
            }
        };
        // Something else: the clipboard moved on from the host's text, which a guest program may copy again later.
        self.last_host = None;
        self.offer_guest(p.serial, p.offer, text, p.image, p.html);
    }

    /// The guest's selection `offer` to the page as OFFER `serial`: its text (the guest program's type, the size, the
    /// bytes inline) first, then its image, then its HTML (unknown sizes: a guest program's offer says none).
    fn offer_guest(
        &mut self,
        serial: u32,
        offer: u32,
        text: Option<(String, u32, Option<Vec<u8>>)>,
        image: Option<String>,
        html: Option<String>,
    ) {
        let mut types = Vec::with_capacity(3);
        let mut inline = None;
        if let Some((_, size, bytes)) = &text {
            types.push((clip::TEXT, *size));
            inline = bytes.as_deref();
        }
        if let Some(i) = &image {
            types.push((i.as_str(), frame::UNKNOWN));
        }
        if html.is_some() {
            types.push((clip::HTML, frame::UNKNOWN));
        }
        let mut out = Vec::new();
        frame::Offer {
            serial,
            types,
            inline,
        }
        .encode(&mut out);
        self.send(frame::OFFER, |o| o.extend_from_slice(&out));
        self.guest = Some(Guest {
            serial,
            offer,
            text: text.map(|(t, _, _)| t),
            image,
            html,
        });
    }

    fn page_request(&mut self, r: frame::Request<'_>) {
        let Some(g) = self.guest.as_ref().filter(|_| !self.paused) else {
            return self.fail(r.id);
        };
        // The text as the page's type, the image and the HTML as the guest program's.
        let mime = match (&g.text, &g.image, &g.html) {
            (Some(t), _, _) if clip::is_page_text(r.mime) => t.clone(),
            (_, Some(i), _) if i.eq_ignore_ascii_case(r.mime) => i.clone(),
            (_, _, Some(h)) if clip::is_html(r.mime) => h.clone(),
            _ => return self.fail(r.id),
        };
        let offer = g.offer;
        if g.serial != r.serial || self.current() != Some(offer) {
            return self.fail(r.id);
        }
        let Some(rd) = self.receive(offer, &mime) else {
            return self.fail(r.id);
        };
        self.xfers.push(Xfer::Out {
            id: r.id,
            fd: rd,
            credit: frame::CREDIT,
            sent: 0,
            cap: clip::cap(&mime),
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
                cap,
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
                if *sent > *cap {
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
                xserve,
                text,
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
                let (id, serial, xserve, done) = (*id, *serial, *xserve, *ended && buf.is_empty());
                if !ok {
                    if id != 0 && !*ended {
                        self.send(frame::MORE, |o| o.extend_from_slice(&frame::more(id, 0)));
                    }
                    return false;
                }
                if done {
                    // X11's requestor gets the value (its pipe closes next), not a refusal.
                    if xserve != 0
                        && let Some(x) = self.x.as_mut()
                    {
                        x.served(xserve);
                    }
                    // The host's text whole: its hash and its copy, unless a newer offer replaced it meanwhile (an
                    // image: nothing kept).
                    if id != 0
                        && *text
                        && let Some(h) = self.host.as_mut().filter(|h| h.serial == serial)
                    {
                        h.cache = copy.take();
                        self.last_host = Some(*hash);
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
                    let (o, code) = (a.object().unwrap_or(0), a.uint().unwrap_or(0));
                    let m = a.string().flatten().unwrap_or("");
                    let why = format!("the compositor's error on object {o}, code {code}: {m}");
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
                if iface == outputs::MANAGER {
                    wl.outputs.global = Some(name);
                }
            }
            (Obj::Init, op::DONE) => {
                wl.objs.insert(object, Obj::Dead);
                wl.inited = true;
                if self.jobs.resize {
                    wl.bind_outputs();
                }
                if !self.jobs.clip {
                    return;
                }
                let k = wl.managers.iter().position(Option::is_some);
                let (Some(seat), Some(k)) = (wl.seat, k) else {
                    if !self.told {
                        self.told = true;
                        log(
                            "session: the compositor has no data-control (ext_data_control_manager_v1, zwlr_data_control_manager_v1): X11's clipboard, if there is one",
                            None,
                        );
                    }
                    return self.x_try(true, false);
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
                // The compositor shares its clipboard with Xwayland's: X11's way gives way.
                if self.x.take().is_some_and(|x| x.ready) {
                    self.host = None;
                    self.guest = None;
                    self.probe = None;
                }
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
                    self.selection(id, Vec::new());
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
                self.x_try(true, false);
            }
            (Obj::Offer, op::OFFER) => {
                if let (Some(Some(t)), Some(types)) = (a.string(), wl.offers.get_mut(&object))
                    && types.len() < MAX_TYPES
                {
                    types.push(t.to_owned());
                }
            }
            (Obj::Source, op::SEND) => {
                if let (Some(fd), Some(Some(mime))) = (fd, a.string()) {
                    self.host_send(object, fd, mime, 0);
                }
            }
            (Obj::Source, op::CANCELLED) => {
                // Another program took the selection (or we did, with a newer source).
                wl.destroy_source(object);
                if self.host.as_ref().is_some_and(|h| h.source == object) {
                    self.host = None;
                }
            }
            (Obj::OutManager | Obj::Head | Obj::Mode | Obj::OutConfig, _) => {
                wl.output_event(kind, object, opcode, a);
                if let Some(size) = self.want {
                    wl.resize(size);
                }
            }
            _ => {}
        }
    }
}

/// What an X connection is for: the child's jobs, but the screen's size only where no Wayland compositor is connected
/// (an X11 session). Under a compositor (one without data-control, whose Xwayland shares the clipboard) the X server is
/// Xwayland, whose screen is the compositor's; its outputs' names (the compositor's, since Xwayland 21.1) don't say so.
pub fn x_jobs(jobs: Jobs, compositor: bool) -> Jobs {
    Jobs {
        clip: jobs.clip,
        resize: jobs.resize && !compositor,
    }
}

/// Whether an inotify event on the runtime directory may be a compositor's socket coming (events lost to an
/// overflow may have been).
pub fn socket_event(events: ReadFlags, name: &str) -> bool {
    events.contains(ReadFlags::QUEUE_OVERFLOW) || is_socket_name(name)
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
    fn an_x_server_under_a_compositor_is_xwaylands_and_its_screen_left_alone() {
        let both = Jobs {
            clip: true,
            resize: true,
        };
        assert_eq!(x_jobs(both, false), both, "an X11 session: both");
        assert_eq!(
            x_jobs(both, true),
            Jobs {
                clip: true,
                resize: false
            },
            "under a compositor (one without data-control): the clipboard only"
        );
    }

    #[test]
    fn finds_the_compositors_socket() {
        assert!(is_socket_name("wayland-1") && is_socket_name("wayland-0"));
        assert!(
            !is_socket_name("wayland-1.lock")
                && !is_socket_name("wayland-")
                && !is_socket_name("pipewire-0")
        );
    }

    /// The thread's voluntary context switches: its wakeups.
    fn wakeups(tid: i32) -> u64 {
        let s = std::fs::read_to_string(format!("/proc/self/task/{tid}/status")).unwrap();
        s.lines()
            .find_map(|l| l.strip_prefix("voluntary_ctxt_switches:"))
            .unwrap()
            .trim()
            .parse()
            .unwrap()
    }

    /// A listening socket at `path` whose backlog is full (`listen(0)` and one connection never accepted): a server
    /// stopped (SIGSTOP, a debugger) or wedged. The listener and the connection that fills it.
    fn full_listener(path: &std::path::Path) -> (OwnedFd, std::os::unix::net::UnixStream) {
        let fd = socket_with(
            AddressFamily::UNIX,
            SocketType::STREAM,
            SocketFlags::CLOEXEC,
            None,
        )
        .unwrap();
        rustix::net::bind(&fd, &SocketAddrUnix::new(path.to_str().unwrap()).unwrap()).unwrap();
        rustix::net::listen(&fd, 0).unwrap();
        let filler = std::os::unix::net::UnixStream::connect(path).unwrap();
        (fd, filler)
    }

    #[test]
    fn a_display_with_a_full_backlog_does_not_hold_the_child() {
        let dir =
            std::env::temp_dir().join(format!("waarm64-agent-backlog-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("x11")).unwrap();
        let wl = full_listener(&dir.join("wayland-1"));
        let x = full_listener(&dir.join("x11/X5"));
        let (mine, theirs) = rustix::net::socketpair(
            AddressFamily::UNIX,
            SocketType::STREAM,
            SocketFlags::CLOEXEC,
            None,
        )
        .unwrap();
        let at = Where {
            runtime: dir.to_str().unwrap().to_owned(),
            x11: dir.join("x11").to_str().unwrap().to_owned(),
            display: Some(5),
            jobs: Jobs {
                clip: true,
                resize: false,
            },
        };
        let child = std::thread::spawn(move || serve_at(theirs, at, 0));
        let mut page = crate::sway_test::Page {
            fd: mine,
            reader: frame::Reader::default(),
            frames: Vec::new(),
        };
        // The child answers the page: a request for an offer it never made fails at once.
        let mut req = Vec::new();
        frame::Request {
            serial: 1,
            id: 7,
            mime: clip::TEXT,
        }
        .encode(&mut req);
        page.send(frame::REQUEST, &req);
        let got = page.next(frame::DATA, 2000);
        // The servers go (a blocked connect returns), then the page: the child ends.
        drop((wl, x));
        drop(page);
        assert_eq!(child.join().unwrap(), Ok("session: the parent is gone"));
        let _ = std::fs::remove_dir_all(&dir);
        let (id, flags, _) =
            frame::decode_data(&got.expect("no answer: the child held up in connect")).unwrap();
        assert_eq!((id, flags & frame::DATA_FAIL), (7, frame::DATA_FAIL));
    }

    #[test]
    fn a_socket_that_refuses_for_good_is_given_up() {
        // A compositor killed: its socket file stays, and refuses.
        let dir = std::env::temp_dir().join(format!("waarm64-agent-dead-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir(&dir).unwrap();
        drop(std::os::unix::net::UnixListener::bind(dir.join("wayland-1")).unwrap());
        let (mine, theirs) = rustix::net::socketpair(
            AddressFamily::UNIX,
            SocketType::STREAM,
            SocketFlags::CLOEXEC,
            None,
        )
        .unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let runtime = dir.to_str().unwrap().to_owned();
        let child = std::thread::spawn(move || {
            tx.send(rustix::thread::gettid().as_raw_nonzero().get())
                .unwrap();
            serve(theirs, runtime, 0)
        });
        let tid = rx.recv().unwrap();
        // The retries (RETRIES of RETRY: 5 s) cover a compositor between its bind and its listen; then no more.
        std::thread::sleep(RETRY_FOR + std::time::Duration::from_secs(1));
        let before = wakeups(tid);
        std::thread::sleep(std::time::Duration::from_secs(2));
        let woke = wakeups(tid) - before;
        drop(mine);
        assert_eq!(child.join().unwrap(), Ok("session: the parent is gone"));
        let _ = std::fs::remove_dir_all(&dir);
        assert!(woke <= 1, "{woke} wakeups in 2 s at a dead socket");
    }
}
