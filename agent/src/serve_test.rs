//! The root process's loop (`serve`) natively: a socketpair stands in for the vsock connection, the test's own directories for
//! logind's files and the users' runtime directories, a console of the test's for the foreground terminal, and a
//! child on a thread that answers each frame it gets with an ACK of the frame's type (`ECHO | kind`) for the forked
//! session child (src/sway_test.rs tests the real one).

use crate::console::Console;
use crate::frame::{self, typed};
use crate::sway_test::Page;
use crate::{Agent, Stop, logind, serve};
use rustix::fd::OwnedFd;
use rustix::io::{self, read, write};
use rustix::net::{AddressFamily, SocketFlags, SocketType, socketpair};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

/// The clock the agent set (`Agent::set_clock`), every test's.
static CLOCK: Mutex<Vec<u64>> = Mutex::new(Vec::new());

fn record_clock(ns: u64) -> io::Result<()> {
    CLOCK.lock().unwrap().push(ns);
    Ok(())
}

/// The test child's ACK serials: this, with the type of the frame it got.
const ECHO: u32 = 0xec40_0000;

/// The test child: an ACK for each frame, until the parent closes its end.
fn echo_child(fd: OwnedFd, _runtime: String, _base: u32) {
    let mut reader = frame::Reader::default();
    let mut buf = [0u8; 65536];
    loop {
        let n = match read(&fd, &mut buf) {
            Ok(0) | Err(_) => return,
            Ok(n) => n,
        };
        let mut out = Vec::new();
        reader.push(&buf[..n], |k, _| {
            frame::encode(frame::ACK, &frame::ack(ECHO | k as u32, 0), &mut out);
        });
        let mut at = 0;
        while at < out.len() {
            match write(&fd, &out[at..]) {
                Ok(n) => at += n,
                Err(io::Errno::AGAIN) => std::thread::sleep(Duration::from_millis(1)),
                Err(_) => return,
            }
        }
    }
}

/// The test's console: text or graphics, a reader that takes everything at once but while `stall` says.
#[derive(Default)]
struct Fake {
    graphics: bool,
    /// The reader takes nothing until then.
    stall: Option<Instant>,
    open: bool,
    got: Vec<u8>,
}

struct FakeConsole(Arc<Mutex<Fake>>);

impl Console for FakeConsole {
    fn open(&mut self) -> io::Result<()> {
        self.0.lock().unwrap().open = true;
        Ok(())
    }
    fn close(&mut self) {
        self.0.lock().unwrap().open = false;
    }
    fn text(&self) -> io::Result<bool> {
        Ok(!self.0.lock().unwrap().graphics)
    }
    fn unread(&self) -> u64 {
        let f = self.0.lock().unwrap();
        if f.stall.is_some_and(|t| Instant::now() < t) {
            4000
        } else {
            0
        }
    }
    fn put(&self, b: u8) -> io::Result<()> {
        let mut f = self.0.lock().unwrap();
        assert!(f.open, "a byte put on a console not opened");
        f.got.push(b);
        Ok(())
    }
}

struct Harness {
    page: Page,
    root: PathBuf,
    con: Arc<Mutex<Fake>>,
    agent: Option<JoinHandle<&'static str>>,
}

impl Harness {
    fn start(name: &str) -> Harness {
        let root =
            std::env::temp_dir().join(format!("waarm64-agent-serve-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for d in ["seats", "sessions", "users"] {
            std::fs::create_dir_all(root.join(d)).unwrap();
        }
        std::fs::create_dir(root.join(format!("users/{}", rustix::process::getuid().as_raw())))
            .unwrap();
        let s = |d: &str| root.join(d).to_str().unwrap().to_owned();
        let paths = logind::Paths {
            seats: s("seats"),
            sessions: s("sessions"),
            users: s("users"),
        };
        let con = Arc::new(Mutex::new(Fake::default()));
        let c = con.clone();
        let (mine, theirs) = socketpair(
            AddressFamily::UNIX,
            SocketType::STREAM,
            SocketFlags::CLOEXEC,
            None,
        )
        .unwrap();
        let agent = std::thread::spawn(move || {
            let mut a = Agent::new(paths, Box::new(FakeConsole(c)));
            a.test_child = Some(echo_child);
            a.set_clock = record_clock;
            match serve(&theirs, &mut a) {
                Stop::Broken => "broken",
                Stop::Failed(what, _) => what,
            }
        });
        Harness {
            page: Page {
                fd: mine,
                reader: frame::Reader::default(),
                frames: Vec::new(),
            },
            root,
            con,
            agent: Some(agent),
        }
    }

    /// A logind file written as logind does: whole, then renamed into place.
    fn logind(&self, path: &str, text: &str) {
        let tmp = self.root.join(format!("{path}.tmp"));
        std::fs::write(&tmp, text).unwrap();
        std::fs::rename(&tmp, self.root.join(path)).unwrap();
    }

    /// Session 3 of the test's user, active on seat0: the agent starts its child.
    fn activate(&mut self) {
        let uid = rustix::process::getuid().as_raw();
        self.logind(
            "sessions/3",
            &format!("UID={uid}\nCLASS=user\nSTATE=active\n"),
        );
        self.logind("seats/seat0", "IS_SEAT0=1\nACTIVE=3\n");
        // Until the child answers: an OFFER without one gets the parent's ACK NO_SESSION.
        let end = Instant::now() + Duration::from_secs(5);
        while Instant::now() < end {
            self.page.send(frame::OFFER, &offer(77));
            let a = self
                .page
                .next(frame::ACK, 1000)
                .expect("an ACK for the OFFER");
            if frame::decode_ack(&a).unwrap().0 == ECHO | frame::OFFER as u32 {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        panic!("no child for the active session");
    }

    /// The child's ACK for a frame of type `kind`, within `ms`.
    fn echoed(&mut self, kind: u8, ms: u64) -> bool {
        let end = Instant::now() + Duration::from_millis(ms);
        while let Some(a) = self.page.next(
            frame::ACK,
            end.saturating_duration_since(Instant::now()).as_millis() as u64,
        ) {
            if frame::decode_ack(&a).unwrap().0 == ECHO | kind as u32 {
                return true;
            }
        }
        false
    }

    fn typed(&mut self, ms: u64) -> Option<u8> {
        self.page.next(frame::TYPED, ms).map(|p| {
            assert_eq!(p.len(), 1);
            p[0]
        })
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        // The page's end closed: the agent's loop ends (the host closed the connection).
        let (a, b) = socketpair(
            AddressFamily::UNIX,
            SocketType::STREAM,
            SocketFlags::CLOEXEC,
            None,
        )
        .unwrap();
        drop(b);
        drop(std::mem::replace(&mut self.page.fd, a));
        if let Some(a) = self.agent.take()
            && !std::thread::panicking()
        {
            assert_eq!(a.join().unwrap(), "the host closed the connection");
        }
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn offer(serial: u32) -> Vec<u8> {
    let mut o = Vec::new();
    frame::Offer {
        serial,
        types: vec![(crate::clip::TEXT, 1)],
        inline: Some(b"x"),
    }
    .encode(&mut o);
    o
}

fn hello() -> [u8; 6] {
    hello_with(frame::cap::TYPE | frame::cap::TEXT | frame::cap::TIME)
}

fn hello_with(caps: u32) -> [u8; 6] {
    frame::Hello { version: 1, caps }.encode()
}

#[test]
fn no_session_child_without_the_clipboard() {
    let mut h = Harness::start("noclip");
    h.page.send(frame::HELLO, &hello_with(frame::cap::TIME));
    let a =
        frame::Hello::decode(&h.page.next(frame::HELLO, 2000).expect("the agent's HELLO")).unwrap();
    assert_ne!(a.caps & frame::cap::TIME, 0, "the agent sets the clock");
    let uid = rustix::process::getuid().as_raw();
    h.logind(
        "sessions/3",
        &format!("UID={uid}\nCLASS=user\nSTATE=active\n"),
    );
    h.logind("seats/seat0", "IS_SEAT0=1\nACTIVE=3\n");
    std::thread::sleep(Duration::from_millis(300));
    h.page.send(frame::OFFER, &offer(9));
    assert_eq!(
        frame::decode_ack(&h.page.next(frame::ACK, 2000).unwrap()),
        Some((9, frame::ack::NO_SESSION)),
        "no child while the page doesn't share the clipboard"
    );
    // The clipboard shared (a page's HELLO with it): the child starts.
    h.page.send(frame::HELLO, &hello());
    h.activate();
}

#[test]
fn sets_the_clock_from_time_past_the_slack() {
    let mut h = Harness::start("time");
    let now = || {
        let t = rustix::time::clock_gettime(rustix::time::ClockId::Realtime);
        t.tv_sec as u64 * 1_000_000_000 + t.tv_nsec as u64
    };
    let far = now() + 90_000_000_000;
    let near = now() + 1_000_000;
    h.page.send(frame::TIME, &far.to_le_bytes());
    h.page.send(frame::TIME, &near.to_le_bytes());
    h.page.send(frame::TIME, &[1, 2, 3]);
    // Frames are served in order: the HELLO's answer comes after the TIMEs were taken.
    h.page.send(frame::HELLO, &hello());
    assert!(h.page.next(frame::HELLO, 2000).is_some());
    let set = CLOCK.lock().unwrap().clone();
    assert!(set.contains(&far), "90 s off: set");
    assert!(!set.contains(&near), "1 ms off: left");
}

#[test]
fn follows_the_session_and_passes_the_child_its_frames() {
    let mut h = Harness::start("session");
    h.page.send(frame::HELLO, &hello());
    assert!(
        h.page.next(frame::HELLO, 2000).is_some(),
        "the agent's HELLO"
    );
    // No session: the parent answers an offer itself.
    h.page.send(frame::OFFER, &offer(5));
    assert_eq!(
        frame::decode_ack(&h.page.next(frame::ACK, 2000).unwrap()),
        Some((5, frame::ack::NO_SESSION))
    );
    h.activate();
    // The child gets the clipboard's frames, the switch, and the page's HELLO (its transfers are an earlier page's).
    h.page.send(frame::PAUSE, &[]);
    assert!(h.echoed(frame::PAUSE, 2000), "PAUSE to the child");
    h.page.send(frame::RESUME, &[]);
    assert!(h.echoed(frame::RESUME, 2000), "RESUME to the child");
    h.page.send(frame::HELLO, &hello());
    assert!(
        h.page.next(frame::HELLO, 2000).is_some(),
        "the agent's HELLO"
    );
    assert!(
        h.echoed(frame::HELLO, 2000),
        "the page's HELLO to the child"
    );
    // The session goes: the child is stopped, and the page hears SESSION.
    h.logind("seats/seat0", "IS_SEAT0=1\n");
    assert!(
        h.page.next(frame::SESSION, 2000).is_some(),
        "SESSION when the child stops"
    );
    h.page.send(frame::OFFER, &offer(6));
    assert_eq!(
        frame::decode_ack(&h.page.next(frame::ACK, 2000).unwrap()),
        Some((6, frame::ack::NO_SESSION))
    );
}

#[test]
fn types_on_a_text_console_only() {
    let mut h = Harness::start("graphics");
    h.page.send(frame::TYPE, b"a\nb\r\n");
    assert_eq!(h.typed(2000), Some(typed::DONE));
    assert_eq!(h.con.lock().unwrap().got, b"a\rb\r");
    // A compositor on the console: nothing typed (its shell would run it once the compositor ends), and the page hears
    // why.
    h.con.lock().unwrap().graphics = true;
    h.page.send(frame::TYPE, b"touch /tmp/typed\n");
    assert_eq!(h.typed(2000), Some(typed::NOT_TEXT));
    assert_eq!(h.con.lock().unwrap().got, b"a\rb\r", "typed under graphics");
}

#[test]
fn typing_does_not_hold_up_the_rest() {
    let mut h = Harness::start("typing");
    // A reader that takes nothing for 800 ms, then everything: the paste waits for it, the page's frames don't.
    h.con.lock().unwrap().stall = Some(Instant::now() + Duration::from_millis(800));
    let text = vec![b'x'; 8192];
    h.page.send(frame::TYPE, &text);
    let t = Instant::now();
    h.page.send(frame::HELLO, &hello());
    assert!(
        h.page.next(frame::HELLO, 2000).is_some(),
        "the agent's HELLO"
    );
    assert!(
        t.elapsed() < Duration::from_millis(400),
        "HELLO answered after {:?}, behind the paste",
        t.elapsed()
    );
    assert_eq!(h.typed(3000), Some(typed::DONE));
    assert!(h.con.lock().unwrap().got == text, "the paste, whole");
    // A reader that stalls past a second: the rest dropped.
    h.con.lock().unwrap().stall = Some(Instant::now() + Duration::from_secs(5));
    h.con.lock().unwrap().got.clear();
    h.page.send(frame::TYPE, &text);
    assert_eq!(h.typed(3000), Some(typed::DROPPED));
    assert!(h.con.lock().unwrap().got.len() < text.len());
}

#[test]
fn an_inotify_overflow_is_a_change() {
    use rustix::fs::inotify::ReadFlags;
    assert!(crate::logind_change(ReadFlags::MOVED_TO, "seat0"));
    assert!(crate::logind_change(ReadFlags::DELETE, "c2"));
    assert!(!crate::logind_change(ReadFlags::MOVED_TO, "3.ref"));
    // Events lost: any of them may have been the session's.
    assert!(crate::logind_change(ReadFlags::QUEUE_OVERFLOW, ""));
    assert!(crate::session::socket_event(ReadFlags::CREATE, "wayland-1"));
    assert!(!crate::session::socket_event(
        ReadFlags::CREATE,
        "wayland-1.lock"
    ));
    assert!(crate::session::socket_event(ReadFlags::QUEUE_OVERFLOW, ""));
}

#[test]
fn a_child_for_the_screens_size_hears_the_hello_and_the_size_first() {
    let mut h = Harness::start("display");
    let size = |w: u32, hh: u32| [w.to_le_bytes(), hh.to_le_bytes()].concat();
    h.page.send(
        frame::HELLO,
        &hello_with(frame::cap::TIME | frame::cap::DISPLAY),
    );
    let a =
        frame::Hello::decode(&h.page.next(frame::HELLO, 2000).expect("the agent's HELLO")).unwrap();
    assert_ne!(
        a.caps & frame::cap::DISPLAY,
        0,
        "the agent follows the size"
    );
    h.page.send(frame::DISPLAY, &size(1024, 768));
    h.page.send(frame::DISPLAY, &[0; 8]); // no size: not kept
    // The session comes: a child for the size alone, which hears the page's HELLO and the size before anything else.
    let uid = rustix::process::getuid().as_raw();
    h.logind(
        "sessions/3",
        &format!("UID={uid}\nCLASS=user\nSTATE=active\n"),
    );
    h.logind("seats/seat0", "IS_SEAT0=1\nACTIVE=3\n");
    assert!(h.echoed(frame::HELLO, 3000), "the HELLO first");
    assert!(h.echoed(frame::DISPLAY, 1000), "then the size");
    assert!(!h.echoed(frame::DISPLAY, 300), "the empty size not passed");
    h.page.send(frame::DISPLAY, &size(800, 600));
    assert!(h.echoed(frame::DISPLAY, 1000), "a new size to the child");
    // The page's HELLO again with the same jobs: to the same child, once.
    h.page.send(
        frame::HELLO,
        &hello_with(frame::cap::TIME | frame::cap::DISPLAY),
    );
    assert!(h.echoed(frame::HELLO, 1000));
    assert!(!h.echoed(frame::HELLO, 300), "once");
    // Other jobs (the clipboard now, no size): a child started afresh (SESSION), which hears the HELLO, no size.
    h.page.send(frame::HELLO, &hello());
    assert!(
        h.page.next(frame::SESSION, 2000).is_some(),
        "the old child stopped"
    );
    assert!(h.echoed(frame::HELLO, 2000), "the new child's HELLO");
    assert!(!h.echoed(frame::DISPLAY, 300), "no size for it");
}
