//! waarm64-agent: the guest's agent (docs/devices.md "The guest's agent"; clipboard sharing: docs/plans/clipboard.md
//! §3). The page delivers it over fw_cfg and a credential unit starts it as root (web/app/guest-agent.ts). The root
//! process connects to the page over vsock (src/vsock.rs), again whenever the connection ends (a restore resets the
//! guest's transport): it answers the page's HELLO, sets the guest's clock from TIME, pastes TYPE's text on the
//! foreground text console (src/console.rs), and holds PAUSE until RESUME. Where the page's HELLO says the clipboard is
//! shared, it follows the active session on seat0 through logind's files (src/logind.rs), and for that session's user
//! it forks a child (no exec) that drops to the user's ids before it reads
//! anything from the display, and shares the user's Wayland clipboard (src/session.rs), or the X server's where Wayland
//! has no data-control (src/x11.rs); the clipboard's frames pass
//! between the connection and the child's socketpair. One thread in each process, blocked in `ppoll` with no timeout but
//! while a paste is being typed (TYPE's text goes in bursts as the console's reader takes it, `console::Typist`, and
//! the loop serves the rest meanwhile): an idle guest sees no CPU time from either (plan §3.3). The page hears what
//! became of a paste (TYPED: typed, or why not: a console that shows a compositor's graphics gets none of it).
//!
//!   waarm64-agent [port]    the host's vsock port (default 8574)

#![cfg_attr(not(test), no_std, no_main)]

extern crate alloc;

/// What `std`'s prelude would bring (the shipped build is `no_std`: src/rt.rs); every module takes it.
mod prelude {
    pub use alloc::borrow::ToOwned;
    pub use alloc::boxed::Box;
    pub use alloc::string::{String, ToString};
    pub use alloc::vec::Vec;
    pub use alloc::{format, vec};
}

mod clip;
mod console;
mod frame;
mod logind;
mod rt;
#[cfg(test)]
mod serve_test;
mod session;
#[cfg(test)]
mod sway_test;
mod vsock;
mod wire;
mod x11;
#[cfg(test)]
mod x11_test;

use core::mem::MaybeUninit;
use prelude::*;
use rustix::event::{PollFd, PollFlags, poll};
use rustix::fd::{AsRawFd, OwnedFd, RawFd};
use rustix::fs::inotify::{self, CreateFlags, ReadFlags, WatchFlags};
use rustix::fs::{Mode, OFlags, fcntl_getfl, fcntl_setfl, open};
use rustix::io::{Errno, read, write};
use rustix::net::{AddressFamily, SocketFlags, SocketType, socketpair};
use rustix::process::{Pid, Signal, WaitOptions, kill_process, waitpid};

/// What the agent says it can do (frame.rs `cap`).
const CAPS: u32 = frame::cap::TYPE | frame::cap::TEXT | frame::cap::IMAGE | frame::cap::TIME;

/// How far the guest's clock may be from the host's TIME before the agent sets it: a frame's way from the page takes a
/// few milliseconds, and a clock set for nothing is a step that NTP clients and logs see.
const CLOCK_SLACK_NS: u64 = 50_000_000;

/// The waits between failed connections: the first, and the most (doubling).
const RETRY_FIRST_MS: u64 = 500;
const RETRY_MOST_MS: u64 = 30_000;

/// The bytes queued for a child past which it is taken to be stuck (and stopped): the page's DATA is paced by the
/// child's MOREs, so a child that keeps up never has this much waiting.
const CHILD_STUCK: usize = 4 << 20;

unsafe extern "C" {
    /// The C library's (musl's, which the agent links: src/rt.rs): a raw clone would leave its idea of the thread's id stale.
    fn fork() -> i32;
}

/// Why serving the connection stopped.
enum Stop {
    /// The stream from the page went out of step: connect again (both ends start afresh).
    Broken,
    /// The host's end is gone (a restore resets the transport), or the connection failed.
    Failed(&'static str, Errno),
}

/// The C library's entry point: `waarm64-agent [port]`.
#[cfg(not(test))]
#[unsafe(no_mangle)]
extern "C" fn main(argc: i32, argv: *const *const core::ffi::c_char) -> i32 {
    rt::bare::start();
    let port = (argc > 1)
        // SAFETY: the C library's `argv` holds `argc` NUL-terminated strings.
        .then(|| unsafe { core::ffi::CStr::from_ptr(*argv.add(1)) })
        .and_then(|a| a.to_str().ok()?.parse().ok());
    run(port.unwrap_or(vsock::AGENT_PORT))
}

/// Serves the page over vsock's `port`, connecting again whenever the connection ends: at once after one that was
/// served, then at waits that double up to `RETRY_MOST_MS` while connecting fails (the vsock driver not loaded yet, a
/// page without the agent's end).
#[cfg_attr(test, allow(dead_code))]
fn run(port: u32) -> ! {
    let mut agent = Agent::new(logind::Paths::default(), Box::new(console::Vt::default()));
    let mut wait = 0;
    loop {
        if wait > 0 {
            let ts = rustix::time::Timespec {
                tv_sec: (wait / 1000) as i64,
                tv_nsec: ((wait % 1000) * 1_000_000) as i64,
            };
            let _ = rustix::thread::nanosleep(&ts);
        }
        match vsock::connect(port) {
            Ok(conn) => {
                wait = 0;
                match serve(&conn, &mut agent) {
                    Stop::Broken => {
                        log("the page's stream went out of step: connecting again", None)
                    }
                    Stop::Failed(what, e) => log(what, Some(e)),
                }
            }
            Err(e) => {
                if wait == 0 {
                    log("can't connect to the page", Some(e));
                }
                wait = (wait * 2).clamp(RETRY_FIRST_MS, RETRY_MOST_MS);
            }
        }
    }
}

/// A session child: its process, its socketpair, the frames to and from it.
struct Proc {
    /// None: the tests' child, on a thread.
    pid: Option<Pid>,
    sock: OwnedFd,
    reader: frame::Reader,
    out: Vec<u8>,
    key: logind::Active,
}

/// What lasts across the connections: the pause, the session tracking and its child.
struct Agent {
    paths: logind::Paths,
    /// The page shares the clipboard (its HELLO's `cap::TEXT`): the session child runs only then.
    clipboard: bool,
    /// Sets the guest's clock (CLOCK_REALTIME) to a time in nanoseconds since the epoch; the tests' records it.
    set_clock: fn(u64) -> Result<(), Errno>,
    /// TYPE's text, on its way to the foreground console.
    typist: console::Typist,
    /// The tests': a function on a thread in place of the forked child.
    #[cfg(test)]
    test_child: Option<fn(OwnedFd, String, u32)>,
    paused: bool,
    ino: Option<OwnedFd>,
    /// The watches on logind's directories (None: not there yet; tried again at each event).
    watches: [Option<i32>; 2],
    mounts: Option<OwnedFd>,
    child: Option<Proc>,
    /// A session whose child ended by itself: not started again for it until the session changes.
    exited: Option<logind::Active>,
    generation: u32,
    /// A child stopped or ended: the page hears SESSION (what it knew of the guest's clipboard, and that child's
    /// transfers, are gone).
    lost: bool,
}

impl Agent {
    fn new(paths: logind::Paths, console: Box<dyn console::Console>) -> Agent {
        let ino = inotify::init(CreateFlags::CLOEXEC | CreateFlags::NONBLOCK)
            .map_err(|e| log("inotify", Some(e)))
            .ok();
        // The mount table polls POLLPRI when it changes (a user's runtime directory mounted or unmounted).
        let mounts = open(
            logind::MOUNTS,
            OFlags::RDONLY | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .ok();
        let mut a = Agent {
            paths,
            clipboard: false,
            set_clock,
            typist: console::Typist::new(console),
            #[cfg(test)]
            test_child: None,
            paused: false,
            ino,
            watches: [None, None],
            mounts,
            child: None,
            exited: None,
            generation: 0,
            lost: false,
        };
        a.watch();
        a
    }

    /// Adds the watches on logind's directories that aren't there yet.
    fn watch(&mut self) {
        let Some(ino) = &self.ino else { return };
        for (w, dir) in self
            .watches
            .iter_mut()
            .zip([&self.paths.seats, &self.paths.sessions])
        {
            if w.is_none() {
                *w = inotify::add_watch(
                    ino,
                    dir.as_str(),
                    WatchFlags::MOVED_TO | WatchFlags::DELETE | WatchFlags::ONLYDIR,
                )
                .ok();
            }
        }
    }

    /// Whether logind's files changed (any of a seat's or a session's).
    fn inotify(&mut self) -> bool {
        let Some(ino) = &self.ino else { return false };
        let mut buf = [MaybeUninit::uninit(); 2048];
        let mut r = inotify::Reader::new(ino, &mut buf);
        let mut changed = false;
        loop {
            match r.next() {
                Ok(e) => {
                    if e.events().contains(ReadFlags::IGNORED) {
                        let wd = e.wd();
                        for w in self.watches.iter_mut().filter(|w| **w == Some(wd)) {
                            *w = None;
                        }
                    }
                    let name = e.file_name().and_then(|n| n.to_str().ok()).unwrap_or("");
                    changed |= logind_change(e.events(), name);
                }
                Err(Errno::INTR) => {}
                Err(_) => break,
            }
        }
        changed
    }

    /// Starts, stops or swaps the session child for the active session now (none while the clipboard isn't shared).
    /// `port`: the connection, closed in a new child.
    fn track(&mut self, port: RawFd) {
        if !self.clipboard {
            return self.stop_child();
        }
        self.watch();
        let want = logind::active(&self.paths);
        if self
            .child
            .as_ref()
            .is_some_and(|c| Some(&c.key) == want.as_ref())
        {
            return;
        }
        self.stop_child();
        if self.exited != want {
            self.exited = None;
        }
        if let Some(a) = want
            && self.exited.is_none()
        {
            self.spawn(a, port);
        }
    }

    /// Stops the child: its socket closed (it ends its loop when it reads the end), SIGKILL (the unit leaves the
    /// agent CAP_KILL for it: the child is the user's process now), reaped.
    fn stop_child(&mut self) {
        if let Some(c) = self.child.take() {
            self.lost = true;
            let pid = c.pid;
            drop(c);
            if let Some(pid) = pid {
                let _ = kill_process(pid, Signal::KILL);
                let _ = waitpid(Some(pid), WaitOptions::empty());
            }
        }
    }

    /// The child ended by itself (its socket closed): reaped, and not started again for the same session.
    fn child_gone(&mut self) {
        if let Some(c) = self.child.take() {
            self.lost = true;
            if let Some(pid) = c.pid {
                let _ = waitpid(Some(pid), WaitOptions::empty());
            }
            log("session: its child ended", None);
            self.exited = Some(c.key);
        }
    }

    fn spawn(&mut self, a: logind::Active, port: RawFd) {
        let Ok((mine, theirs)) = socketpair(
            AddressFamily::UNIX,
            SocketType::STREAM,
            SocketFlags::CLOEXEC,
            None,
        ) else {
            return;
        };
        self.generation = self.generation.wrapping_add(1);
        let base = self.generation << 24;
        #[cfg(test)]
        if let Some(f) = self.test_child {
            let runtime = a.runtime.clone();
            std::thread::spawn(move || f(theirs, runtime, base));
            return self.started(None, mine, a);
        }
        // SAFETY: the agent is one thread, so the child has the whole process's state in order (no lock held by
        // another thread); it never returns to the parent's frames (session::run exits).
        let pid = unsafe { fork() };
        if pid < 0 {
            log("session: fork failed", None);
            return;
        }
        if pid == 0 {
            // The child: none of the parent's descriptors but its socket (the port above all: the page must see it
            // close when the parent goes), then the user's ids before anything from the display is read.
            let mut close = vec![port, mine.as_raw_fd()];
            close.extend(self.ino.as_ref().map(|f| f.as_raw_fd()));
            close.extend(self.mounts.as_ref().map(|f| f.as_raw_fd()));
            close.extend(self.typist.fd());
            for fd in close {
                // SAFETY: the parent's descriptors, which this process (which never returns to their owners) no
                // longer uses; their OwnedFds are never dropped here (session::run exits).
                unsafe { rustix::io::close(fd) };
            }
            core::mem::forget(mine);
            let (uid, gid) = logind::ids(&a);
            let dropped = rustix::thread::set_thread_groups(&[])
                .and_then(|()| rustix::thread::set_thread_res_gid(gid, gid, gid))
                .and_then(|()| rustix::thread::set_thread_res_uid(uid, uid, uid));
            if let Err(e) = dropped {
                log("session: can't take the user's ids", Some(e));
                rt::exit(1);
            }
            // After the ids change (which clears it): the child goes with the parent.
            let _ = rustix::process::set_parent_process_death_signal(Some(Signal::KILL));
            if rustix::process::getppid().is_none_or(|p| p.as_raw_nonzero().get() == 1) {
                rt::exit(0);
            }
            let at = session::Where {
                runtime: a.runtime,
                x11: session::X11_DIR.into(),
                display: a.display,
            };
            session::run(theirs, at, base);
        }
        drop(theirs);
        self.started(Pid::from_raw(pid), mine, a);
    }

    fn started(&mut self, pid: Option<Pid>, mine: OwnedFd, a: logind::Active) {
        if let Ok(f) = fcntl_getfl(&mine) {
            let _ = fcntl_setfl(&mine, f | OFlags::NONBLOCK);
        }
        log(
            &format!("session: a child for session {} (uid {})", a.session, a.uid),
            None,
        );
        let mut c = Proc {
            pid,
            sock: mine,
            reader: frame::Reader::default(),
            out: Vec::new(),
            key: a,
        };
        if self.paused {
            frame::encode(frame::PAUSE, &[], &mut c.out);
        }
        self.child = Some(c);
    }

    /// A frame for the child; false if there is none (the frame is the parent's to answer).
    fn for_child(&mut self, kind: u8, payload: &[u8]) -> bool {
        let Some(c) = &mut self.child else {
            return false;
        };
        frame::encode(kind, payload, &mut c.out);
        if c.out.len() > CHILD_STUCK {
            log("session: its child stopped reading: stopped", None);
            self.stop_child();
            return false;
        }
        true
    }

    /// TIME: the guest's clock set to the host's `ns`, unless it is within `CLOCK_SLACK_NS` of it already.
    fn time(&mut self, ns: u64) {
        let now = rustix::time::clock_gettime(rustix::time::ClockId::Realtime);
        let ours = (now.tv_sec as i128) * 1_000_000_000 + now.tv_nsec as i128;
        let off = ns as i128 - ours;
        if off.unsigned_abs() < CLOCK_SLACK_NS as u128 {
            return;
        }
        match (self.set_clock)(ns) {
            Ok(()) => log(
                &format!(
                    "the clock set from the host's: moved {} ms",
                    off / 1_000_000
                ),
                None,
            ),
            Err(e) => log("can't set the clock", Some(e)),
        }
    }

    fn flush_child(&mut self) {
        let Some(c) = &mut self.child else { return };
        while !c.out.is_empty() {
            match write(&c.sock, &c.out) {
                Ok(n) => {
                    c.out.drain(..n);
                }
                Err(Errno::INTR) => {}
                Err(Errno::AGAIN) => return,
                Err(_) => return self.child_gone(),
            }
        }
        if c.out.capacity() > 4 * frame::MAX_PAYLOAD {
            c.out = Vec::new();
        }
    }
}

/// The guest's clock (CLOCK_REALTIME), set: the agent's `set_clock`.
fn set_clock(ns: u64) -> Result<(), Errno> {
    rustix::time::clock_settime(
        rustix::time::ClockId::Realtime,
        rustix::time::Timespec {
            tv_sec: (ns / 1_000_000_000) as i64,
            tv_nsec: (ns % 1_000_000_000) as i64,
        },
    )
}

/// The agent's state while it is connected.
struct Session<'a> {
    port: &'a OwnedFd,
    agent: &'a mut Agent,
    /// Frames to send.
    out: Vec<u8>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Tag {
    Port,
    Ino,
    Mounts,
    Child,
}

fn serve(port: &OwnedFd, agent: &mut Agent) -> Stop {
    let mut s = Session {
        port,
        agent,
        out: Vec::new(),
    };
    s.agent.typist.reset();
    s.agent.track(port.as_raw_fd());
    let mut reader = frame::Reader::default();
    let mut buf = [0u8; 16384];
    loop {
        s.agent.flush_child();
        let mut tags = Vec::with_capacity(4);
        let mut fds = Vec::with_capacity(4);
        fds.push(PollFd::new(port, PollFlags::IN));
        tags.push(Tag::Port);
        if let Some(i) = &s.agent.ino {
            fds.push(PollFd::new(i, PollFlags::IN));
            tags.push(Tag::Ino);
        }
        if let Some(m) = &s.agent.mounts {
            fds.push(PollFd::new(m, PollFlags::PRI));
            tags.push(Tag::Mounts);
        }
        if let Some(c) = &s.agent.child {
            let f = if c.out.is_empty() {
                PollFlags::IN
            } else {
                PollFlags::IN | PollFlags::OUT
            };
            fds.push(PollFd::new(&c.sock, f));
            tags.push(Tag::Child);
        }
        // No timeout but while a paste is being typed (its reader catching up).
        let timeout = s.agent.typist.busy().then_some(&console::TICK);
        match poll(&mut fds, timeout) {
            Ok(_) | Err(Errno::INTR) => {}
            Err(e) => return Stop::Failed("poll", e),
        }
        let ready: Vec<(Tag, PollFlags)> = tags
            .into_iter()
            .zip(fds.iter().map(|f| f.revents()))
            .filter(|(_, r)| !r.is_empty())
            .collect();
        drop(fds);
        let mut track = false;
        for (tag, revents) in ready {
            match tag {
                Tag::Port => {
                    let n = match read(port, &mut buf) {
                        // The host's end closed (or reset: a restore, a page that wants the stream afresh).
                        Ok(0) => {
                            return Stop::Failed("the host closed the connection", Errno::PIPE);
                        }
                        Ok(n) => n,
                        Err(Errno::INTR) | Err(Errno::AGAIN) => continue,
                        Err(e) => return Stop::Failed("read", e),
                    };
                    reader.push(&buf[..n], |kind, payload| s.frame(kind, payload));
                    if reader.broken() {
                        return Stop::Broken;
                    }
                }
                Tag::Ino => track |= s.agent.inotify(),
                Tag::Mounts => track = true,
                Tag::Child => {
                    if revents.contains(PollFlags::OUT) {
                        s.agent.flush_child();
                    }
                    if revents.intersects(PollFlags::IN | PollFlags::HUP | PollFlags::ERR) {
                        s.child_input();
                    }
                }
            }
        }
        if track {
            s.agent.track(port.as_raw_fd());
        }
        if core::mem::take(&mut s.agent.lost) {
            frame::encode(frame::SESSION, &[], &mut s.out);
        }
        if let Some(status) = s.agent.typist.step() {
            frame::encode(frame::TYPED, &[status], &mut s.out);
        }
        if let Err(e) = s.flush() {
            return Stop::Failed("write", e);
        }
    }
}

impl Session<'_> {
    fn frame(&mut self, kind: u8, payload: &[u8]) {
        match kind {
            // The page's HELLO (one at each connection): the agent's answers it. It says whether the clipboard is
            // shared (the session child runs or stops); the child hears it too: its transfers in flight were the
            // page's before.
            frame::HELLO => {
                frame::hello_answer(payload, CAPS, &mut self.out);
                if let Some(h) = frame::Hello::decode(payload) {
                    self.agent.clipboard = h.caps & (frame::cap::TEXT | frame::cap::IMAGE) != 0;
                    self.agent.track(self.port.as_raw_fd());
                    self.agent.for_child(kind, payload);
                }
            }
            frame::TIME => {
                if let Some(ns) = frame::decode_time(payload) {
                    self.agent.time(ns);
                }
            }
            frame::TYPE if !self.agent.paused => {
                if let Some(status) = self.agent.typist.push(payload) {
                    frame::encode(frame::TYPED, &[status], &mut self.out);
                }
            }
            frame::PAUSE | frame::RESUME => {
                self.agent.paused = kind == frame::PAUSE;
                if self.agent.paused {
                    self.agent.typist.reset();
                }
                self.agent.for_child(kind, &[]);
            }
            // The clipboard's: the session child's, which answers them; without one, the agent says it has no
            // session (an offer) or fails the request.
            frame::OFFER | frame::REQUEST | frame::DATA | frame::MORE => {
                if self.agent.for_child(kind, payload) {
                    return;
                }
                if kind == frame::OFFER
                    && let Some(o) = frame::Offer::decode(payload)
                {
                    let status = if self.agent.paused {
                        frame::ack::PAUSED
                    } else {
                        frame::ack::NO_SESSION
                    };
                    frame::encode(frame::ACK, &frame::ack(o.serial, status), &mut self.out);
                }
                if kind == frame::REQUEST
                    && let Some(r) = frame::Request::decode(payload)
                {
                    frame::encode_with(frame::DATA, &mut self.out, |o| {
                        frame::data(r.id, frame::DATA_FAIL, &[], o)
                    });
                }
            }
            // TYPE while paused, and what a later version sends: ignored.
            _ => {}
        }
    }

    /// Frames from the child, to the page: the clipboard's only (it is the user's process; nothing else of its
    /// passes).
    fn child_input(&mut self) {
        let Some(c) = &mut self.agent.child else {
            return;
        };
        let mut buf = [0u8; 16384];
        let n = match read(&c.sock, &mut buf) {
            Ok(0) => return self.agent.child_gone(),
            Ok(n) => n,
            Err(Errno::INTR) | Err(Errno::AGAIN) => return,
            Err(_) => return self.agent.child_gone(),
        };
        let out = &mut self.out;
        c.reader.push(&buf[..n], |kind, payload| {
            if matches!(
                kind,
                frame::OFFER
                    | frame::REQUEST
                    | frame::DATA
                    | frame::ACK
                    | frame::MORE
                    | frame::SESSION
            ) {
                frame::encode(kind, payload, out);
            }
        });
        if c.reader.broken() {
            log(
                "session: its child's stream went out of step: stopped",
                None,
            );
            self.agent.stop_child();
        }
    }

    fn flush(&mut self) -> Result<(), Errno> {
        let mut at = 0;
        while at < self.out.len() {
            match write(self.port, &self.out[at..]) {
                Ok(n) => at += n,
                Err(Errno::INTR) => {}
                Err(e) => return Err(e),
            }
        }
        self.out.clear();
        if self.out.capacity() > 4 * frame::MAX_PAYLOAD {
            self.out = Vec::new();
        }
        Ok(())
    }
}

/// Whether an inotify event on logind's directories may change the active session: a seat's file or a session's, a
/// watch gone, or events lost (the queue overflowed).
fn logind_change(events: ReadFlags, name: &str) -> bool {
    events.intersects(ReadFlags::IGNORED | ReadFlags::QUEUE_OVERFLOW)
        || name == "seat0"
        || logind::valid_id(name)
}

/// A line on stderr (the journal's): `waarm64-agent: <what>[ (errno N)]`.
fn log(what: &str, e: Option<Errno>) {
    let mut line = Vec::with_capacity(96);
    line.extend_from_slice(b"waarm64-agent: ");
    line.extend_from_slice(what.as_bytes());
    if let Some(e) = e {
        line.extend_from_slice(b" (errno ");
        line.extend_from_slice(rt::decimal(e.raw_os_error().unsigned_abs(), &mut [0; 10]));
        line.push(b')');
    }
    line.push(b'\n');
    rt::stderr(&line);
}
