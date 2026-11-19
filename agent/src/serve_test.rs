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
use rustix::net::{AddressFamily, Shutdown, SocketFlags, SocketType, shutdown, socketpair};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

/// The clock the agent set (`Agent::set_clock`), every test's.
static CLOCK: Mutex<Vec<u64>> = Mutex::new(Vec::new());

/// The bytes the agent added to the kernel's pool (`Agent::add_entropy`), every test's.
static ENTROPY: Mutex<Vec<Vec<u8>>> = Mutex::new(Vec::new());

fn record_entropy(_random: &str, b: &[u8]) -> io::Result<()> {
    ENTROPY.lock().unwrap().push(b.to_vec());
    Ok(())
}

fn record_clock(ns: u64) -> io::Result<()> {
    CLOCK.lock().unwrap().push(ns);
    Ok(())
}

/// The tests' FITRIM (in the agent's forked child: what it did goes to files): a mount point with an `unsupported`
/// file takes no trim, one with `fails` fails; any other gets a line in its `trimmed`.
fn record_trim(point: &str) -> io::Result<()> {
    let p = std::path::Path::new(point);
    if p.join("unsupported").exists() {
        return Err(io::Errno::OPNOTSUPP);
    }
    if p.join("fails").exists() {
        return Err(io::Errno::IO);
    }
    if !p.is_dir() {
        return Err(io::Errno::NOENT);
    }
    let mut f = std::fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(p.join("trimmed"))
        .unwrap();
    std::io::Write::write_all(&mut f, b"trimmed\n").unwrap();
    Ok(())
}

/// The tests' BLKPG (in the agent's forked child): the partition's sysfs `size` (sectors of 512) takes the new
/// length, as the kernel's does; a `blkpg-fails` file beside it fails (EBUSY).
fn fake_resize(
    sys: &str,
    _disk: rustix::fd::BorrowedFd<'_>,
    _pno: u32,
    _start: u64,
    len: u64,
) -> io::Result<()> {
    let p = std::path::Path::new(sys);
    if p.join("blkpg-fails").exists() {
        return Err(io::Errno::BUSY);
    }
    std::fs::write(p.join("size"), format!("{}\n", len / 512)).unwrap();
    Ok(())
}

/// The tests' filesystem grow: a mount point with `fails` fails (ENOSPC); else its `size` file is the filesystem's
/// size, which grows to `bytes` if smaller, with a line in its `grown` (through the mount's directory, as the real
/// one: the open directory may be a detached clone of the mount).
fn fake_grow_fs(
    kind: &str,
    dir: rustix::fd::BorrowedFd<'_>,
    dev: &str,
    bytes: u64,
) -> io::Result<bool> {
    use rustix::fs::{Mode, OFlags, openat};
    let at =
        |name: &str, flags: OFlags| openat(dir, name, flags | OFlags::CLOEXEC, Mode::from(0o644));
    if at("fails", OFlags::RDONLY).is_ok() {
        return Err(io::Errno::NOSPC);
    }
    let had: u64 = at("size", OFlags::RDONLY)
        .ok()
        .and_then(|f| {
            let mut b = [0u8; 32];
            let n = read(&f, &mut b).ok()?;
            std::str::from_utf8(&b[..n]).ok()?.trim().parse().ok()
        })
        .unwrap_or(0);
    if bytes <= had {
        return Ok(false);
    }
    let f = at("size", OFlags::WRONLY | OFlags::CREATE | OFlags::TRUNC).unwrap();
    write(&f, bytes.to_string().as_bytes()).unwrap();
    let f = at("grown", OFlags::WRONLY | OFlags::CREATE | OFlags::APPEND).unwrap();
    write(&f, format!("{kind} {dev} {bytes}\n").as_bytes()).unwrap();
    Ok(true)
}

/// The test child's ACK serials: this, with the type of the frame it got.
const ECHO: u32 = 0xec40_0000;

/// The test child: an ACK for each frame, until the parent closes its end; DESKTOP with a value no state has at each
/// HELLO, X11's at each OFFER.
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
            if k == frame::HELLO {
                frame::encode(frame::DESKTOP, &[7], &mut out);
            }
            if k == frame::OFFER {
                frame::encode(frame::DESKTOP, &[frame::desktop::X11], &mut out);
            }
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
        let renew = crate::renew::Paths {
            random: s("random"),
            machine_id: s("machine-id"),
            seed: s("random-seed"),
            ssh: s("ssh"),
            keygen: vec![s("no-keygen"), s("ssh-keygen")],
            proc: "/proc".into(),
        };
        let lease = crate::lease::Paths {
            networkd: s("netif-links"),
            busctl: vec![s("busctl")],
            nm: s("NetworkManager"),
            nmcli: vec![s("nmcli")],
            dhcpcd: vec![s("dhcpcd")],
            dhcpcd_conf: s("dhcpcd.conf"),
            net: s("net"),
            proc: s("proc"),
        };
        let trim_table = s("mountinfo");
        let grow = crate::grow::Paths {
            sys_block: s("sys/block"),
            dev: s("dev"),
            mountinfo: s("mountinfo"),
        };
        let drop_caches = s("drop_caches");
        let (environment, loadkeys) = (s("environment"), s("loadkeys"));
        let screen = crate::screen::Paths {
            tty: s("tty0"),
            vcsu: s("vcsu"),
            vcs: s("vcs"),
            console: two_by_four,
        };
        let os = crate::os::Paths {
            files: vec![s("os-release")],
        };
        let power = crate::power::Paths {
            logind: s("logind"),
            busctl: vec![s("busctl")],
            shutdown: vec![s("shutdown")],
            poweroff: vec![s("poweroff")],
            reboot: vec![s("reboot")],
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
            a.add_entropy = record_entropy;
            a.renew = renew;
            a.lease = lease;
            a.trim = crate::trim::Paths {
                mountinfo: trim_table,
            };
            a.fitrim = record_trim;
            a.grow = grow;
            a.grow_ops = crate::grow::Ops {
                resize_part: fake_resize,
                grow_fs: fake_grow_fs,
            };
            a.drop = crate::drop::Paths { drop_caches };
            a.environment = environment;
            a.loadkeys_at = vec![loadkeys];
            a.screen = screen;
            a.os = os;
            a.power = power;
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
        // The page's end shut for writing: the agent reads its end (the host closed the connection). Not closed: a
        // Unix socket closed with the agent's frames unread in it resets the agent's (a read error, not the end).
        let _ = shutdown(&self.page.fd, Shutdown::Write);
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

#[test]
fn applies_the_pages_layout_where_the_session_hasnt_it() {
    use crate::keymap::Keymap;
    use std::os::unix::fs::PermissionsExt;
    let mut h = Harness::start("keymap");
    let root = h.root.clone();
    let r = |p: &str| root.join(p);
    let km = |layout: &str, variant: &str, vc: &str| {
        Keymap {
            layout: layout.into(),
            model: "pc105".into(),
            variant: variant.into(),
            vc: vc.into(),
        }
        .encode()
    };
    // The boot set German (the page's credentials' script); kbd's loadkeys there, recording its calls.
    std::fs::write(
        r("environment"),
        "XKB_DEFAULT_LAYOUT=de\nXKB_DEFAULT_MODEL=pc105\n",
    )
    .unwrap();
    std::fs::write(
        r("loadkeys"),
        format!("#!/bin/sh\necho \"$*\" >> {}\n", r("loaded").display()),
    )
    .unwrap();
    std::fs::set_permissions(r("loadkeys"), std::fs::Permissions::from_mode(0o755)).unwrap();
    let loaded = || std::fs::read_to_string(r("loaded")).unwrap_or_default();
    let caps = frame::cap::TIME | frame::cap::DESKTOP | frame::cap::KEYMAP;
    h.page.send(frame::HELLO, &hello_with(caps));
    let a = frame::Hello::decode(&h.page.next(frame::HELLO, 2000).unwrap()).unwrap();
    assert_ne!(a.caps & frame::cap::KEYMAP, 0, "the agent sets the layout");
    // The page's is the boot's: nothing done.
    h.page.send(frame::KEYMAP, &km("de", "", "de-latin1"));
    let uid = rustix::process::getuid().as_raw();
    h.logind(
        "sessions/3",
        &format!("UID={uid}\nCLASS=user\nSTATE=active\n"),
    );
    h.logind("seats/seat0", "IS_SEAT0=1\nACTIVE=3\n");
    assert!(h.echoed(frame::HELLO, 3000), "the child");
    assert!(!h.echoed(frame::KEYMAP, 300), "the session has it");
    // Portuguese (a snapshot of another setting restored): to the child, and the consoles' keymap loaded.
    h.page.send(frame::KEYMAP, &km("pt", "", "pt-latin1"));
    assert!(h.echoed(frame::KEYMAP, 1000), "to the child");
    let end = Instant::now() + Duration::from_secs(5);
    while loaded().is_empty() && Instant::now() < end {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(loaded(), "-q pt-latin1\n");
    // Again: the session has it now. A name that isn't plain: dropped.
    h.page.send(frame::KEYMAP, &km("pt", "", "pt-latin1"));
    h.page.send(frame::KEYMAP, &km("us;exec", "", ""));
    assert!(!h.echoed(frame::KEYMAP, 300));
    // A new session's child hears it first, after the HELLO.
    h.logind(
        "sessions/4",
        &format!("UID={uid}\nCLASS=user\nSTATE=active\n"),
    );
    h.logind("seats/seat0", "IS_SEAT0=1\nACTIVE=4\n");
    assert!(h.echoed(frame::HELLO, 3000), "the new child");
    assert!(h.echoed(frame::KEYMAP, 1000), "and the layout");
    assert_eq!(loaded(), "-q pt-latin1\n", "loaded once");
    // Two layouts while loadkeys runs (a slow one): the consoles end with the last (review L2).
    std::fs::write(
        r("loadkeys"),
        format!(
            "#!/bin/sh\nsleep 0.3\necho \"$*\" >> {}\n",
            r("loaded").display()
        ),
    )
    .unwrap();
    h.page.send(frame::KEYMAP, &km("fr", "", "fr-latin1"));
    std::thread::sleep(Duration::from_millis(50));
    h.page.send(frame::KEYMAP, &km("it", "", "it"));
    let end = Instant::now() + Duration::from_secs(5);
    while !loaded().ends_with("-q it\n") && Instant::now() < end {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(loaded(), "-q pt-latin1\n-q fr-latin1\n-q it\n");
    // Names a command line would read otherwise: sway's other separator, an option for loadkeys (review L3).
    while h.echoed(frame::KEYMAP, 300) {} // the two above, the child's
    h.page.send(frame::KEYMAP, &km("us,exit", "", ""));
    h.page.send(frame::KEYMAP, &km("us", "", "-h"));
    assert!(!h.echoed(frame::KEYMAP, 300), "dropped");
}

#[test]
fn renews_a_templates_identity() {
    use crate::renew::what;
    use std::os::unix::fs::PermissionsExt;
    let mut h = Harness::start("renew");
    let r = |p: &str| h.root.join(p);
    let old_id = "0123456789abcdef0123456789abcdef\n";
    std::fs::write(r("machine-id"), old_id).unwrap();
    std::fs::set_permissions(r("machine-id"), std::fs::Permissions::from_mode(0o444)).unwrap();
    std::fs::write(r("random-seed"), [7u8; 512]).unwrap();
    std::fs::create_dir(r("ssh")).unwrap();
    for t in ["ed25519", "rsa"] {
        std::fs::write(r(&format!("ssh/ssh_host_{t}_key")), "old").unwrap();
        std::fs::write(r(&format!("ssh/ssh_host_{t}_key.pub")), "old pub").unwrap();
    }
    std::fs::write(r("ssh/sshd_config"), "kept").unwrap();
    // ssh-keygen as the agent runs it: `-q -N "" -t <type> -f <out>`.
    std::fs::write(
        r("ssh-keygen"),
        "#!/bin/sh\nwhile [ $# -gt 1 ]; do case $1 in -f) f=$2;; -t) t=$2;; esac; shift; done\necho \"new $t\" > \"$f\"; echo \"new $t pub\" > \"$f.pub\"\n",
    )
    .unwrap();
    std::fs::set_permissions(r("ssh-keygen"), std::fs::Permissions::from_mode(0o755)).unwrap();
    h.page.send(
        frame::HELLO,
        &hello_with(frame::cap::TIME | frame::cap::RENEW),
    );
    let a = frame::Hello::decode(&h.page.next(frame::HELLO, 2000).unwrap()).unwrap();
    assert_ne!(a.caps & frame::cap::RENEW, 0, "the agent renews");
    let bytes: Vec<u8> = (0..64u8).map(|i| i.wrapping_mul(37) ^ 0x5a).collect();
    h.page.send(frame::RENEW, &bytes);
    let done = h.page.next(frame::RENEWED, 10_000).expect("RENEWED");
    assert_eq!(
        done,
        [what::ENTROPY | what::MACHINE_ID | what::SEED | what::SSH, 0],
        "everything renewed, nothing failed"
    );
    assert!(
        ENTROPY.lock().unwrap().contains(&bytes),
        "the page's bytes to the kernel's pool"
    );
    let id = std::fs::read_to_string(r("machine-id")).unwrap();
    assert!(
        id != old_id && id.len() == 33 && id.ends_with('\n'),
        "{id:?}"
    );
    assert!(
        id[..32]
            .bytes()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
    );
    assert_eq!(&id[12..13], "4", "a version 4 id");
    assert_eq!(
        std::fs::metadata(r("machine-id"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o444,
        "its mode kept"
    );
    let seed = std::fs::read(r("random-seed")).unwrap();
    assert!(seed.len() == 512 && seed != [7u8; 512]);
    for t in ["ed25519", "rsa"] {
        assert_eq!(
            std::fs::read_to_string(r(&format!("ssh/ssh_host_{t}_key"))).unwrap(),
            format!("new {t}\n")
        );
        assert_eq!(
            std::fs::read_to_string(r(&format!("ssh/ssh_host_{t}_key.pub"))).unwrap(),
            format!("new {t} pub\n")
        );
        assert!(
            !r(&format!("ssh/ssh_host_{t}_key.new")).exists(),
            "renamed into place"
        );
    }
    assert_eq!(
        std::fs::read_to_string(r("ssh/sshd_config")).unwrap(),
        "kept"
    );
    // Without ssh-keygen: the keys left as they are, the rest renewed again.
    std::fs::remove_file(r("ssh-keygen")).unwrap();
    h.page.send(frame::RENEW, &bytes);
    assert_eq!(
        h.page.next(frame::RENEWED, 5000).expect("RENEWED"),
        [what::ENTROPY | what::MACHINE_ID | what::SEED, 0]
    );
    assert_ne!(
        std::fs::read_to_string(r("machine-id")).unwrap(),
        id,
        "a new id each time"
    );
    assert_eq!(
        std::fs::read_to_string(r("ssh/ssh_host_rsa_key")).unwrap(),
        "new rsa\n"
    );
}

#[test]
fn renews_ssh_host_keys_with_the_real_ssh_keygen() {
    use crate::renew::what;
    let Some(kg) = ["/usr/bin/ssh-keygen", "/bin/ssh-keygen"]
        .into_iter()
        .find(|p| std::path::Path::new(p).exists())
    else {
        eprintln!("SKIPPED: no ssh-keygen");
        return;
    };
    let mut h = Harness::start("renew-ssh");
    let r = |p: &str| h.root.join(p);
    std::fs::create_dir(r("ssh")).unwrap();
    for t in ["ed25519", "rsa"] {
        std::fs::write(r(&format!("ssh/ssh_host_{t}_key")), "old").unwrap();
        std::fs::write(r(&format!("ssh/ssh_host_{t}_key.pub")), "old pub").unwrap();
    }
    std::os::unix::fs::symlink(kg, r("ssh-keygen")).unwrap();
    // A running sshd serving the old keys (made real first), unprivileged on a port of its own.
    let sshd = std::path::Path::new("/usr/sbin/sshd").exists() && have_keyscan();
    let mut server = None;
    let port = 23000 + (std::process::id() % 2000) as u16;
    if sshd {
        for t in ["ed25519", "rsa"] {
            let key = r(&format!("ssh/ssh_host_{t}_key"));
            let _ = std::fs::remove_file(&key);
            let _ = std::fs::remove_file(r(&format!("ssh/ssh_host_{t}_key.pub")));
            let st = std::process::Command::new(kg)
                .args(["-q", "-N", "", "-t", t, "-f"])
                .arg(&key)
                .status()
                .unwrap();
            assert!(st.success());
        }
        let cfg = format!(
            "Port {port}\nListenAddress 127.0.0.1\nHostKey {}\nPidFile {}\nUsePAM no\n",
            r("ssh/ssh_host_ed25519_key").display(),
            r("sshd.pid").display()
        );
        std::fs::write(r("sshd_config"), cfg).unwrap();
        server = Some(
            std::process::Command::new("timeout")
                .args(["120", "/usr/sbin/sshd", "-D", "-e", "-f"])
                .arg(r("sshd_config"))
                .stderr(std::fs::File::create(r("sshd.log")).unwrap())
                .spawn()
                .unwrap(),
        );
    } else {
        eprintln!("SKIPPED (the served keys): no sshd or ssh-keyscan");
    }
    let served = |port: u16| {
        let out = std::process::Command::new("timeout")
            .args([
                "10",
                "ssh-keyscan",
                "-p",
                &port.to_string(),
                "-t",
                "ed25519",
                "127.0.0.1",
            ])
            .stderr(std::process::Stdio::null())
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .find(|l| !l.starts_with('#'))
            .and_then(|l| l.split_whitespace().nth(2))
            .map(str::to_owned)
    };
    let before = sshd.then(|| {
        let end = std::time::Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(k) = served(port) {
                break k;
            }
            assert!(
                std::time::Instant::now() < end,
                "sshd didn't serve: {}",
                std::fs::read_to_string(r("sshd.log")).unwrap_or_default()
            );
            std::thread::sleep(Duration::from_millis(200));
        }
    });
    h.page.send(frame::HELLO, &hello_with(frame::cap::TIME));
    assert!(h.page.next(frame::HELLO, 2000).is_some());
    // A key of a type this ssh-keygen can't make (as DSA's under OpenSSH 10): it fails alone, and the others are still
    // served (sshd told to load them).
    std::fs::write(r("ssh/ssh_host_bogus_key"), "old").unwrap();
    h.page.send(frame::RENEW, &[9u8; 64]);
    let done = h.page.next(frame::RENEWED, 60_000).expect("RENEWED");
    // No machine id or seed in this test's directory: those not there are in neither. The SSH keys: renewed and failed
    // (some of them each).
    assert_eq!(done, [what::ENTROPY | what::SSH, what::SSH]);
    for t in ["ed25519", "rsa"] {
        let key = r(&format!("ssh/ssh_host_{t}_key"));
        let out = std::process::Command::new(kg)
            .arg("-l")
            .arg("-f")
            .arg(&key)
            .output()
            .unwrap();
        let line = String::from_utf8_lossy(&out.stdout).to_lowercase();
        assert!(
            out.status.success() && line.contains(&format!("({t})")),
            "{t}: {line}"
        );
        let pubkey = std::fs::read_to_string(r(&format!("ssh/ssh_host_{t}_key.pub"))).unwrap();
        assert!(pubkey.starts_with("ssh-"), "{pubkey}");
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&key).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "the private half the owner's only");
    }
    // The running sshd serves the new key (it was told to load them: review 1).
    if let (Some(before), Some(mut server)) = (before, server) {
        let on_disk = std::fs::read_to_string(r("ssh/ssh_host_ed25519_key.pub")).unwrap();
        let new = on_disk.split_whitespace().nth(1).unwrap().to_owned();
        assert_ne!(new, before);
        let end = std::time::Instant::now() + Duration::from_secs(10);
        let mut now = served(port);
        while now.as_deref() != Some(&new) && std::time::Instant::now() < end {
            std::thread::sleep(Duration::from_millis(200));
            now = served(port);
        }
        let _ = server.kill();
        let _ = server.wait();
        assert_eq!(
            now.as_deref(),
            Some(new.as_str()),
            "the running sshd serves the new key, not {before}"
        );
    }
}

fn have_keyscan() -> bool {
    std::process::Command::new("ssh-keyscan")
        .arg("-h")
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok()
}

#[test]
fn renews_the_leases_with_the_network_manager_that_runs() {
    use crate::lease::status;
    use std::os::unix::fs::PermissionsExt;
    let mut h = Harness::start("lease");
    let r = |p: &str| h.root.join(p);
    // The cards: two with a device, `lo` and a bridge without.
    for (k, (n, dev)) in [
        ("enp0s1", true),
        ("eth1", true),
        ("lo", false),
        ("br0", false),
    ]
    .into_iter()
    .enumerate()
    {
        std::fs::create_dir_all(r(&format!("net/{n}"))).unwrap();
        std::fs::write(r(&format!("net/{n}/ifindex")), format!("{}\n", k + 2)).unwrap();
        std::fs::write(
            r(&format!("net/{n}/address")),
            format!("52:54:00:00:00:{k:02x}\n"),
        )
        .unwrap();
        if dev {
            std::fs::create_dir(r(&format!("net/{n}/device"))).unwrap();
        }
    }
    let tool = |name: &str, exit: u8| {
        std::fs::write(
            r(name),
            format!(
                "#!/bin/sh\necho \"$*\" >> {}\nexit {exit}\n",
                r("calls").display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(r(name), std::fs::Permissions::from_mode(0o755)).unwrap();
    };
    let calls = || std::fs::read_to_string(r("calls")).unwrap_or_default();
    h.page.send(frame::HELLO, &hello_with(frame::cap::TIME));
    let a = frame::Hello::decode(&h.page.next(frame::HELLO, 2000).unwrap()).unwrap();
    assert_ne!(a.caps & frame::cap::LEASE, 0, "the agent renews leases");
    // No network manager it knows: the page is told (it flaps the link instead).
    h.page.send(frame::LEASE, &[]);
    assert_eq!(
        h.page.next(frame::LEASED, 5000).as_deref(),
        Some(&[status::NO_CLIENT][..])
    );
    // networkd running, busctl there: RenewLink for each card.
    tool("busctl", 0);
    tool("nmcli", 0);
    std::fs::create_dir(r("netif-links")).unwrap();
    std::fs::create_dir(r("NetworkManager")).unwrap();
    h.page.send(frame::LEASE, &[]);
    assert_eq!(
        h.page.next(frame::LEASED, 5000).as_deref(),
        Some(&[status::RENEWED][..])
    );
    // Its D-Bus method by index: networkctl resolves a link over netlink, which the unit's RestrictAddressFamilies
    // refuses (Debian 13: "Address family not supported by protocol").
    let m = "call org.freedesktop.network1 /org/freedesktop/network1 org.freedesktop.network1.Manager RenewLink i";
    assert_eq!(calls(), format!("{m} 2\n{m} 3\n"), "networkd first");
    // A card whose renewal fails: the others are renewed all the same (FAILED said).
    std::fs::remove_file(r("calls")).unwrap();
    std::fs::write(
        r("busctl"),
        format!(
            "#!/bin/sh\necho \"$*\" >> {}\n[ \"$7\" = 2 ] && exit 1\nexit 0\n",
            r("calls").display()
        ),
    )
    .unwrap();
    h.page.send(frame::LEASE, &[]);
    assert_eq!(
        h.page.next(frame::LEASED, 5000).as_deref(),
        Some(&[status::FAILED][..])
    );
    assert_eq!(
        calls(),
        format!("{m} 2\n{m} 3\n"),
        "each card, past a failure"
    );
    tool("busctl", 0);
    // The cards the page has connected, by their MACs: those only (review M2); one the guest hasn't: none renewed.
    std::fs::remove_file(r("calls")).unwrap();
    h.page.send(frame::LEASE, &[1, 0x52, 0x54, 0, 0, 0, 1]);
    assert_eq!(
        h.page.next(frame::LEASED, 5000).as_deref(),
        Some(&[status::RENEWED][..])
    );
    assert_eq!(calls(), format!("{m} 3\n"), "eth1 alone");
    h.page.send(frame::LEASE, &[1, 2, 0, 0, 0, 0, 9]);
    assert_eq!(
        h.page.next(frame::LEASED, 5000).as_deref(),
        Some(&[status::NO_CLIENT][..])
    );
    assert_eq!(calls(), format!("{m} 3\n"), "none of the guest's");
    // NetworkManager alone: each card connected again.
    std::fs::remove_dir(r("netif-links")).unwrap();
    std::fs::remove_file(r("calls")).unwrap();
    h.page.send(frame::LEASE, &[]);
    assert_eq!(
        h.page.next(frame::LEASED, 5000).as_deref(),
        Some(&[status::RENEWED][..])
    );
    assert_eq!(calls(), "device connect enp0s1\ndevice connect eth1\n");
    // Its tool failing: FAILED.
    tool("nmcli", 4);
    h.page.send(frame::LEASE, &[]);
    assert_eq!(
        h.page.next(frame::LEASED, 5000).as_deref(),
        Some(&[status::FAILED][..])
    );
    // The tool gone: none it knows.
    std::fs::remove_file(r("nmcli")).unwrap();
    h.page.send(frame::LEASE, &[]);
    assert_eq!(
        h.page.next(frame::LEASED, 5000).as_deref(),
        Some(&[status::NO_CLIENT][..])
    );
    std::fs::remove_dir(r("NetworkManager")).unwrap();

    // Alpine's clients, without a manager (decision 14): found among the processes. A process in the fake /proc: its
    // name and argv.
    let process = |pid: u32, comm: &str, argv: &[&str]| {
        std::fs::create_dir_all(r(&format!("proc/{pid}"))).unwrap();
        std::fs::write(r(&format!("proc/{pid}/comm")), format!("{comm}\n")).unwrap();
        let mut cmdline = argv.join("\0");
        cmdline.push('\0');
        std::fs::write(r(&format!("proc/{pid}/cmdline")), cmdline).unwrap();
    };
    // dhcpcd running (its argv rewritten, as dhcpcd does: found by its name) and its tool there: a rebind of each card.
    std::fs::create_dir(r("proc")).unwrap();
    process(1, "init", &["/sbin/init"]);
    process(400, "dhcpcd", &["dhcpcd: [master] [ip4] [ip6]"]);
    h.page.send(frame::LEASE, &[]);
    assert_eq!(
        h.page.next(frame::LEASED, 5000).as_deref(),
        Some(&[status::NO_CLIENT][..]),
        "dhcpcd without its tool"
    );
    tool("dhcpcd", 0);
    std::fs::remove_file(r("calls")).unwrap();
    h.page.send(frame::LEASE, &[]);
    assert_eq!(
        h.page.next(frame::LEASED, 5000).as_deref(),
        Some(&[status::RENEWED][..])
    );
    assert_eq!(calls(), "-n enp0s1\n-n eth1\n");
    // Where the configuration leaves a card out (a static one), not that card (review #6): `-n` would start a dhcpcd.
    std::fs::write(r("dhcpcd.conf"), "denyinterfaces eth1\n").unwrap();
    std::fs::remove_file(r("calls")).unwrap();
    h.page.send(frame::LEASE, &[]);
    assert_eq!(
        h.page.next(frame::LEASED, 5000).as_deref(),
        Some(&[status::RENEWED][..])
    );
    assert_eq!(calls(), "-n enp0s1\n", "the card dhcpcd leaves alone");
    std::fs::remove_file(r("dhcpcd.conf")).unwrap();
    // A dhcpcd for one card alone (ifupdown's `dhcpcd enp0s1`): that card; none runs for eth1: nothing there.
    process(400, "dhcpcd", &["dhcpcd: enp0s1 [ip4] [ip6]"]);
    std::fs::remove_file(r("calls")).unwrap();
    h.page.send(frame::LEASE, &[]);
    assert_eq!(
        h.page.next(frame::LEASED, 5000).as_deref(),
        Some(&[status::RENEWED][..])
    );
    assert_eq!(calls(), "-n enp0s1\n", "eth1 has no dhcpcd");
    process(400, "dhcpcd", &["dhcpcd: [master] [ip4] [ip6]"]);
    // udhcpc for a card (ifupdown's arguments): SIGUSR1, busybox's renew, to that process; dhcpcd's rebind for the other.
    // The process is a real one (a shell that says what it got) behind a fake /proc entry.
    let got = r("usr1");
    let mut child = std::process::Command::new("sh")
        .arg("-c")
        .arg(format!(
            "trap 'echo usr1 > {}; exit 0' USR1; while :; do sleep 0.05; done",
            got.display()
        ))
        .spawn()
        .unwrap();
    std::thread::sleep(std::time::Duration::from_millis(200)); // its trap set
    process(
        child.id(),
        "udhcpc",
        &[
            "/sbin/udhcpc",
            "-b",
            "-R",
            "-p",
            "/var/run/udhcpc.enp0s1.pid",
            "-i",
            "enp0s1",
            "-x",
            "hostname:alpine",
        ],
    );
    std::fs::remove_file(r("calls")).unwrap();
    h.page.send(frame::LEASE, &[]);
    assert_eq!(
        h.page.next(frame::LEASED, 5000).as_deref(),
        Some(&[status::RENEWED][..])
    );
    assert!(child.wait().unwrap().success(), "udhcpc got SIGUSR1");
    assert_eq!(std::fs::read_to_string(&got).unwrap(), "usr1\n");
    assert_eq!(calls(), "-n eth1\n", "dhcpcd for the card without a udhcpc");
    std::fs::remove_dir_all(r(&format!("proc/{}", child.id()))).unwrap();
    // udhcpc alone, for a card of the page's: its signal, nothing run; for a card the page didn't connect: none.
    std::fs::remove_dir_all(r("proc/400")).unwrap();
    std::fs::remove_file(r("calls")).unwrap();
    let mut child = std::process::Command::new("sh")
        .arg("-c")
        .arg("trap 'exit 0' USR1; while :; do sleep 0.05; done")
        .spawn()
        .unwrap();
    std::thread::sleep(std::time::Duration::from_millis(200));
    process(child.id(), "busybox", &["busybox", "udhcpc", "-bRienp0s1"]);
    h.page.send(frame::LEASE, &[1, 0x52, 0x54, 0, 0, 0, 1]);
    assert_eq!(
        h.page.next(frame::LEASED, 5000).as_deref(),
        Some(&[status::NO_CLIENT][..]),
        "eth1 has no client"
    );
    h.page.send(frame::LEASE, &[1, 0x52, 0x54, 0, 0, 0, 0]);
    assert_eq!(
        h.page.next(frame::LEASED, 5000).as_deref(),
        Some(&[status::RENEWED][..])
    );
    assert!(
        child.wait().unwrap().success(),
        "busybox's udhcpc got SIGUSR1"
    );
    assert_eq!(calls(), "", "nothing run");
}

/// The tests' foreground console: text, 2 rows of 4 columns.
fn two_by_four(_: &str) -> io::Result<Option<crate::screen::Size>> {
    Ok(Some((2, 4)))
}

#[test]
fn copies_the_consoles_screen_paused_or_not() {
    use crate::screen::status;
    let mut h = Harness::start("copy");
    let vcsu = h.root.join("vcsu");
    h.page.send(frame::HELLO, &hello_with(frame::cap::TIME));
    let a = frame::Hello::decode(&h.page.next(frame::HELLO, 2000).unwrap()).unwrap();
    assert_ne!(a.caps & frame::cap::COPY, 0, "the agent copies the console");
    let ask = |h: &mut Harness| {
        h.page.send(frame::COPY, &[]);
        h.page.next(frame::COPIED, 2000)
    };
    // No console's nodes: none.
    assert_eq!(ask(&mut h).as_deref(), Some(&[status::NO_CONSOLE][..]));
    let cells: Vec<u8> = "ok  é☃  "
        .chars()
        .flat_map(|c| (c as u32).to_le_bytes())
        .collect();
    std::fs::write(&vcsu, cells).unwrap();
    let want = [&[status::OK][..], "ok\né☃".as_bytes()].concat();
    assert_eq!(ask(&mut h), Some(want.clone()));
    // Paused (the clipboard's switch): the user's own copy all the same, as Copy the screen.
    h.page.send(frame::PAUSE, &[]);
    assert_eq!(ask(&mut h), Some(want));
}

#[test]
fn trims_each_filesystem_and_says_what_became_of_it() {
    use crate::trim::status;
    let mut h = Harness::start("trim");
    let root = h.root.clone();
    let r = |p: &str| root.join(p);
    h.page.send(frame::HELLO, &hello_with(frame::cap::TIME));
    let a = frame::Hello::decode(&h.page.next(frame::HELLO, 2000).unwrap()).unwrap();
    assert_ne!(a.caps & frame::cap::TRIM, 0, "the agent trims");
    let trims = |d: &str| {
        std::fs::read_to_string(r(&format!("{d}/trimmed")))
            .unwrap_or_default()
            .lines()
            .count()
    };
    let ask = |h: &mut Harness| {
        h.page.send(frame::TRIM, &[]);
        h.page.next(frame::TRIMMED, 5000)
    };
    // No mount table, or nothing on a block device: none takes it.
    assert_eq!(ask(&mut h).as_deref(), Some(&[status::NONE][..]));
    for d in ["root", "boot", "gone"] {
        std::fs::create_dir(r(d)).unwrap();
    }
    std::fs::remove_dir(r("gone")).unwrap();
    // The root's filesystem through a mount point the unit can't reach, then its own; a bind of it; the boot disk's;
    // a tmpfs.
    let table = format!(
        "1 0 254:1 / {gone} rw - ext4 /dev/vda2 rw\n2 1 254:1 / {root} rw - ext4 /dev/vda2 rw\n\
         3 1 254:1 /x {root} ro - ext4 /dev/vda2 rw\n4 1 254:17 / {boot} rw - vfat /dev/vdb1 rw\n\
         5 1 0:25 / {root} rw - tmpfs tmpfs rw\n",
        gone = r("gone").display(),
        root = r("root").display(),
        boot = r("boot").display()
    );
    std::fs::write(r("mountinfo"), table).unwrap();
    assert_eq!(ask(&mut h).as_deref(), Some(&[status::TRIMMED][..]));
    assert_eq!(
        (trims("root"), trims("boot")),
        (1, 1),
        "each filesystem once"
    );
    // A disk that doesn't discard: the others are still trimmed.
    std::fs::write(r("boot/unsupported"), "").unwrap();
    assert_eq!(ask(&mut h).as_deref(), Some(&[status::TRIMMED][..]));
    assert_eq!((trims("root"), trims("boot")), (2, 1));
    // One that fails: FAILED, the rest trimmed all the same.
    std::fs::write(r("boot/fails"), "").unwrap();
    std::fs::remove_file(r("boot/unsupported")).unwrap();
    assert_eq!(ask(&mut h).as_deref(), Some(&[status::FAILED][..]));
    assert_eq!(trims("root"), 3);
}

#[test]
fn drops_the_caches_and_says_what_became_of_it() {
    use crate::drop::status;
    let mut h = Harness::start("drop");
    let file = h.root.join("drop_caches");
    h.page.send(frame::HELLO, &hello_with(frame::cap::TIME));
    let a = frame::Hello::decode(&h.page.next(frame::HELLO, 2000).unwrap()).unwrap();
    assert_ne!(a.caps & frame::cap::DROP, 0, "the agent drops the caches");
    // No kernel switch to write (a sandbox without it): FAILED.
    h.page.send(frame::DROP, &[]);
    assert_eq!(
        h.page.next(frame::DROPPED, 5000).as_deref(),
        Some(&[status::FAILED][..])
    );
    // The switch: `3` written to it (the page cache, dentries and inodes).
    std::fs::write(&file, "").unwrap();
    h.page.send(frame::DROP, &[]);
    assert_eq!(
        h.page.next(frame::DROPPED, 5000).as_deref(),
        Some(&[status::DROPPED][..])
    );
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "3\n");
}

#[test]
fn says_the_childs_desktop_to_a_page_that_asks() {
    let mut h = Harness::start("desktop");
    let caps = frame::cap::TIME | frame::cap::DESKTOP;
    h.page.send(frame::HELLO, &hello_with(caps));
    let a =
        frame::Hello::decode(&h.page.next(frame::HELLO, 2000).expect("the agent's HELLO")).unwrap();
    assert_ne!(a.caps & frame::cap::DESKTOP, 0, "the agent says it");
    // A child for the state alone: what it says (a known state only) reaches the page, once.
    h.activate();
    assert_eq!(
        h.page.next(frame::DESKTOP, 2000).as_deref(),
        Some(&[frame::desktop::X11][..]),
        "the child's state, not a value it can't have"
    );
    h.page.send(frame::HELLO, &hello_with(caps));
    assert!(h.echoed(frame::HELLO, 2000), "the same child hears it");
    assert!(
        h.page.next(frame::DESKTOP, 300).is_none(),
        "the same state: not said again"
    );
    // The session goes: the child stopped, the state down.
    h.logind("seats/seat0", "IS_SEAT0=1\n");
    assert_eq!(
        h.page.next(frame::DESKTOP, 2000).as_deref(),
        Some(&[frame::desktop::NONE][..])
    );
    // A page that doesn't ask: its child says it, the page hears nothing.
    h.page.send(frame::HELLO, &hello());
    // (The new child hears the HELLO first: its DESKTOP has passed the parent once its OFFER's ACK is back.)
    h.activate();
    assert!(h.page.next(frame::DESKTOP, 300).is_none(), "not asked");
}

#[test]
fn names_the_os_to_a_page_that_asks() {
    let mut h = Harness::start("os");
    std::fs::write(
        h.root.join("os-release"),
        "PRETTY_NAME=\"Debian GNU/Linux 13 (trixie)\"\nVERSION_ID=\"13\"\nID=debian\n",
    )
    .unwrap();
    h.page
        .send(frame::HELLO, &hello_with(frame::cap::TIME | frame::cap::OS));
    let a = frame::Hello::decode(&h.page.next(frame::HELLO, 2000).unwrap()).unwrap();
    assert_ne!(a.caps & frame::cap::OS, 0, "the agent names it");
    assert_eq!(
        h.page.next(frame::OS, 2000).as_deref(),
        Some(&b"\x1cDebian GNU/Linux 13 (trixie)\x06debian\x0213"[..])
    );
    // At each HELLO (the file read again); not to a page that doesn't ask.
    std::fs::write(h.root.join("os-release"), "NAME=Other\n").unwrap();
    h.page
        .send(frame::HELLO, &hello_with(frame::cap::TIME | frame::cap::OS));
    assert_eq!(
        h.page.next(frame::OS, 2000).as_deref(),
        Some(&b"\x05Other\x05linux\x00"[..])
    );
    h.page.send(frame::HELLO, &hello_with(frame::cap::TIME));
    assert!(h.page.next(frame::HELLO, 2000).is_some());
    assert!(h.page.next(frame::OS, 300).is_none(), "not asked");
}

#[test]
fn powers_off_or_reboots_as_asked_and_says_if_taken() {
    use crate::power::status;
    use std::os::unix::fs::PermissionsExt;
    let mut h = Harness::start("power");
    let root = h.root.clone();
    let r = |p: &str| root.join(p);
    let tool = |name: &str, exit: u8| {
        std::fs::write(
            r(name),
            format!(
                "#!/bin/sh\necho \"$*\" >> {}\nexit {exit}\n",
                r("calls").display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(r(name), std::fs::Permissions::from_mode(0o755)).unwrap();
    };
    let calls = || std::fs::read_to_string(r("calls")).unwrap_or_default();
    h.page.send(frame::HELLO, &hello_with(frame::cap::TIME));
    let a = frame::Hello::decode(&h.page.next(frame::HELLO, 2000).unwrap()).unwrap();
    assert_ne!(a.caps & frame::cap::POWER, 0, "the agent powers off");
    let ask = |h: &mut Harness, what: u8| {
        h.page.send(frame::POWER, &[what]);
        h.page.next(frame::POWERED, 5000)
    };
    assert_eq!(
        ask(&mut h, frame::power::OFF).as_deref(),
        Some(&[status::NO_TOOL][..]),
        "no tool"
    );
    // logind running with busctl: its method, inhibitors checked for root too.
    tool("busctl", 0);
    tool("shutdown", 0);
    std::fs::create_dir(r("logind")).unwrap();
    assert_eq!(
        ask(&mut h, frame::power::REBOOT).as_deref(),
        Some(&[status::TAKEN][..])
    );
    let m = "call org.freedesktop.login1 /org/freedesktop/login1 org.freedesktop.login1.Manager";
    assert_eq!(calls(), format!("{m} RebootWithFlags t 1\n"));
    // Refused (a block inhibitor): said.
    tool("busctl", 1);
    assert_eq!(
        ask(&mut h, frame::power::OFF).as_deref(),
        Some(&[status::REFUSED][..])
    );
    // No logind: shutdown.
    std::fs::remove_dir(r("logind")).unwrap();
    std::fs::remove_file(r("calls")).unwrap();
    assert_eq!(
        ask(&mut h, frame::power::OFF).as_deref(),
        Some(&[status::TAKEN][..])
    );
    assert_eq!(calls(), "now\n");
    // A request it doesn't know: no answer.
    h.page.send(frame::POWER, &[7]);
    assert!(h.page.next(frame::POWERED, 300).is_none());
    // One while another runs (a busctl that takes its time): BUSY at once, then the first's answer.
    std::fs::write(r("busctl"), "#!/bin/sh\nsleep 0.5\nexit 0\n").unwrap();
    std::fs::create_dir(r("logind")).unwrap();
    h.page.send(frame::POWER, &[frame::power::OFF]);
    h.page.send(frame::POWER, &[frame::power::REBOOT]);
    assert_eq!(
        h.page.next(frame::POWERED, 5000).as_deref(),
        Some(&[status::BUSY][..])
    );
    assert_eq!(
        h.page.next(frame::POWERED, 5000).as_deref(),
        Some(&[status::TAKEN][..])
    );
}

/// GROWN's fields: the serial, the partition's and the filesystem's statuses, the errno, the size.
fn grown(p: &[u8]) -> (String, u8, u8, u32, u64) {
    let n = p[0] as usize;
    let r = &p[1 + n..];
    (
        String::from_utf8(p[1..1 + n].to_vec()).unwrap(),
        r[0],
        r[1],
        u32::from_le_bytes(r[2..6].try_into().unwrap()),
        u64::from_le_bytes(r[6..14].try_into().unwrap()),
    )
}

/// GROW's payload.
fn grow_frame(serial: &str, size: u64) -> Vec<u8> {
    let mut p = vec![serial.len() as u8];
    p.extend_from_slice(serial.as_bytes());
    p.extend_from_slice(&size.to_le_bytes());
    p
}

#[test]
fn grows_a_disks_last_partition_and_its_mounted_filesystem() {
    use crate::grow::{fs, part};
    use crate::table::image;
    const MIB: u64 = 1 << 20;
    let mut h = Harness::start("grow");
    let root = h.root.clone();
    let r = |p: &str| root.join(p);
    let w = |p: &str, text: &str| {
        let p = r(p);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    };
    std::fs::create_dir_all(r("dev")).unwrap();
    // A disk in sysfs (its partitions numbered, started and sized as the kernel has them) and its node, an image.
    let disk = |name: &str, serial: &str, parts: &[(&str, u32, u64, u64)], size: u64| {
        w(&format!("sys/block/{name}/serial"), &format!("{serial}\n"));
        w(
            &format!("sys/block/{name}/queue/logical_block_size"),
            "512\n",
        );
        std::fs::create_dir_all(r(&format!("sys/block/{name}/holders"))).unwrap();
        for &(p, n, start, len) in parts {
            w(
                &format!("sys/block/{name}/{p}/partition"),
                &format!("{n}\n"),
            );
            w(
                &format!("sys/block/{name}/{p}/start"),
                &format!("{start}\n"),
            );
            w(&format!("sys/block/{name}/{p}/size"), &format!("{len}\n"));
            std::fs::create_dir_all(r(&format!("sys/block/{name}/{p}/holders"))).unwrap();
        }
        image::file(&r(&format!("dev/{name}")), size)
    };
    let ask = |h: &mut Harness, serial: &str, size: u64| {
        h.page.send(frame::GROW, &grow_frame(serial, size));
        grown(&h.page.next(frame::GROWN, 5000).expect("a GROWN"))
    };
    h.page.send(frame::HELLO, &hello_with(frame::cap::TIME));
    let a = frame::Hello::decode(&h.page.next(frame::HELLO, 2000).unwrap()).unwrap();
    assert_ne!(a.caps & frame::cap::GROW, 0, "the agent grows disks");

    // Debian's layout, its root mounted as ext4.
    let vda = disk(
        "vda",
        "waarm64-d1",
        &[
            ("vda1", 1, 16384, 47104),
            ("vda14", 14, 2048, 6144),
            ("vda15", 15, 8192, 8192),
        ],
        32 * MIB,
    );
    image::debian(&vda, 32 * MIB);
    // The partitions' device numbers in sysfs: the test's own directories' (an ext4's or xfs's mount directory is on
    // its partition: the grow checks it).
    let here = std::os::unix::fs::MetadataExt::dev(&std::fs::metadata(&root).unwrap());
    let here = format!("{}:{}", rustix::fs::major(here), rustix::fs::minor(here));
    w("sys/block/vda/vda1/dev", &format!("{here}\n"));
    std::fs::create_dir(r("root")).unwrap();
    let mounts = |extra: &str| {
        format!(
            "1 0 254:1 / {gone} rw - ext4 /dev/vda1 rw\n2 1 254:1 / {root} rw - ext4 /dev/vda1 rw\n\
             3 1 254:15 / {root}/boot/efi rw - vfat /dev/vda15 rw\n{extra}",
            gone = r("gone").display(),
            root = r("root").display(),
        )
    };
    w("mountinfo", &mounts(""));
    assert_eq!(
        ask(&mut h, "waarm64-nope", MIB),
        ("waarm64-nope".into(), part::NOT_FOUND, fs::SKIPPED, 0, 0)
    );
    assert_eq!(
        ask(&mut h, "waarm64-d1", 64 * MIB),
        ("waarm64-d1".into(), part::NOT_YET, fs::SKIPPED, 0, 32 * MIB),
        "the disk not at its grown size yet"
    );
    vda.set_len(64 * MIB).unwrap();
    let p1 = (129023 - 16384 + 1) * 512;
    assert_eq!(
        ask(&mut h, "waarm64-d1", 64 * MIB),
        ("waarm64-d1".into(), part::GROWN, fs::GROWN, 0, p1)
    );
    assert_eq!(
        image::gpt_parts(&vda, 512).unwrap(),
        vec![(0, 16384, 129023), (13, 2048, 8191), (14, 8192, 16383)]
    );
    assert_eq!(
        std::fs::read_to_string(r("sys/block/vda/vda1/size")).unwrap(),
        format!("{}\n", p1 / 512),
        "the kernel told"
    );
    assert_eq!(
        std::fs::read_to_string(r("root/grown")).unwrap(),
        format!("ext4 /dev/vda1 {p1}\n"),
        "the filesystem grown once, at its mount point the unit reaches"
    );
    // Again: nothing to grow.
    assert_eq!(
        ask(&mut h, "waarm64-d1", 64 * MIB),
        ("waarm64-d1".into(), part::NOTHING, fs::NOTHING, 0, p1)
    );
    // One GROW per disk at a time: a second for it while the first waits or runs is answered by the first's GROWN.
    for s in ["waarm64-d1", "waarm64-d1", "waarm64-nope"] {
        h.page.send(frame::GROW, &grow_frame(s, 64 * MIB));
    }
    let mut got = Vec::new();
    while let Some(p) = h.page.next(frame::GROWN, 1000) {
        got.push(grown(&p).0);
    }
    assert_eq!(
        got,
        vec!["waarm64-d1".to_owned(), "waarm64-nope".to_owned()]
    );

    // An MBR's last primary, not mounted; the serial as the device cuts it (20 bytes).
    let vdb = disk(
        "vdb",
        "waarm64-0123456789ab",
        &[("vdb1", 1, 2048, 30720)],
        16 * MIB,
    );
    image::mbr(&vdb, &[(0, 0x83, 2048, 30720)]);
    vdb.set_len(32 * MIB).unwrap();
    assert_eq!(
        ask(&mut h, "waarm64-0123456789abcdef", 32 * MIB),
        (
            "waarm64-0123456789abcdef".into(),
            part::GROWN,
            fs::NOT_MOUNTED,
            0,
            (65536 - 2048) * 512
        )
    );
    // A whole disk's btrfs, mounted, no table.
    disk("vdc", "waarm64-c", &[], 48 * MIB);
    std::fs::create_dir(r("srv")).unwrap();
    // An LVM physical volume on a partition: grown, its filesystems (the volume's) left alone.
    let vdd = disk("vdd", "waarm64-d", &[("vdd1", 1, 2048, 30720)], 16 * MIB);
    image::gpt(&vdd, 16 * MIB, 512, &[(0, image::LINUX, 2048, 32734)]);
    w("sys/block/vdd/vdd1/size", "30687\n");
    std::fs::create_dir(r("sys/block/vdd/vdd1/holders/dm-0")).unwrap();
    vdd.set_len(32 * MIB).unwrap();
    // xfs whose grow fails; a vfat; a partition the kernel won't resize.
    let vde = disk("vde", "waarm64-e", &[("vde1", 1, 2048, 30687)], 16 * MIB);
    image::gpt(&vde, 16 * MIB, 512, &[(0, image::LINUX, 2048, 32734)]);
    vde.set_len(32 * MIB).unwrap();
    w("sys/block/vde/vde1/dev", &format!("{here}\n"));
    std::fs::create_dir(r("data")).unwrap();
    std::fs::write(r("data/fails"), "").unwrap();
    let vdf = disk("vdf", "waarm64-f", &[("vdf1", 1, 2048, 30687)], 16 * MIB);
    image::gpt(&vdf, 16 * MIB, 512, &[(0, image::LINUX, 2048, 32734)]);
    vdf.set_len(32 * MIB).unwrap();
    std::fs::create_dir(r("win")).unwrap();
    let vdg = disk("vdg", "waarm64-g", &[("vdg1", 1, 2048, 30687)], 16 * MIB);
    image::gpt(&vdg, 16 * MIB, 512, &[(0, image::LINUX, 2048, 32734)]);
    vdg.set_len(32 * MIB).unwrap();
    std::fs::write(r("sys/block/vdg/vdg1/blkpg-fails"), "").unwrap();
    // A table whose backup header is corrupt.
    let vdh = disk("vdh", "waarm64-h", &[("vdh1", 1, 2048, 30687)], 16 * MIB);
    image::gpt(&vdh, 16 * MIB, 512, &[(0, image::LINUX, 2048, 32734)]);
    std::os::unix::fs::FileExt::write_all_at(&vdh, &[1], 16 * MIB - 512 + 60).unwrap();
    vdh.set_len(32 * MIB).unwrap();
    w(
        "mountinfo",
        &mounts(&format!(
            "4 1 0:40 / {srv} rw - btrfs /dev/vdc rw\n5 1 254:65 / {data} rw - xfs /dev/vde1 rw\n\
             6 1 254:81 / {win} rw - vfat /dev/vdf1 rw\n",
            srv = r("srv").display(),
            data = r("data").display(),
            win = r("win").display(),
        )),
    );
    let gpt16to32 = (65536 - 34) / 2048 * 2048 - 2048;
    assert_eq!(
        ask(&mut h, "waarm64-c", 48 * MIB),
        ("waarm64-c".into(), part::NO_TABLE, fs::GROWN, 0, 48 * MIB)
    );
    assert_eq!(
        std::fs::read_to_string(r("srv/grown")).unwrap(),
        format!("btrfs /dev/vdc {}\n", 48 * MIB)
    );
    assert_eq!(
        ask(&mut h, "waarm64-d", 32 * MIB),
        (
            "waarm64-d".into(),
            part::GROWN,
            fs::STACKED,
            0,
            gpt16to32 * 512
        )
    );
    assert_eq!(
        ask(&mut h, "waarm64-e", 32 * MIB),
        (
            "waarm64-e".into(),
            part::GROWN,
            fs::FAILED,
            28,
            gpt16to32 * 512
        ),
        "the filesystem's errno (ENOSPC)"
    );
    assert_eq!(
        ask(&mut h, "waarm64-f", 32 * MIB),
        (
            "waarm64-f".into(),
            part::GROWN,
            fs::UNSUPPORTED,
            0,
            gpt16to32 * 512
        )
    );
    assert_eq!(
        ask(&mut h, "waarm64-g", 32 * MIB),
        (
            "waarm64-g".into(),
            part::FAILED,
            fs::SKIPPED,
            16,
            30687 * 512
        ),
        "BLKPG's errno (EBUSY)"
    );
    // The table written, the kernel not told: the next GROW tells it.
    std::fs::remove_file(r("sys/block/vdg/vdg1/blkpg-fails")).unwrap();
    assert_eq!(
        ask(&mut h, "waarm64-g", 32 * MIB),
        (
            "waarm64-g".into(),
            part::GROWN,
            fs::NOT_MOUNTED,
            0,
            gpt16to32 * 512
        )
    );
    let before = std::fs::read(r("dev/vdh")).unwrap();
    assert_eq!(
        ask(&mut h, "waarm64-h", 32 * MIB),
        (
            "waarm64-h".into(),
            part::BAD_TABLE,
            fs::SKIPPED,
            0,
            32 * MIB
        )
    );
    assert!(
        std::fs::read(r("dev/vdh")).unwrap() == before,
        "a bad table: nothing written"
    );
    // Another filesystem mounted over the partition's mount point (the directory isn't on the partition): not grown.
    let vdi = disk("vdi", "waarm64-i", &[("vdi1", 1, 2048, 30687)], 16 * MIB);
    image::gpt(&vdi, 16 * MIB, 512, &[(0, image::LINUX, 2048, 32734)]);
    vdi.set_len(32 * MIB).unwrap();
    w("sys/block/vdi/vdi1/dev", "254:129\n");
    std::fs::create_dir(r("over")).unwrap();
    // A root the kernel mounted (no initramfs): the table's source `/dev/root`, its device number the partition's.
    let vdj = disk("vdj", "waarm64-j", &[("vdj1", 1, 2048, 30687)], 16 * MIB);
    image::gpt(&vdj, 16 * MIB, 512, &[(0, image::LINUX, 2048, 32734)]);
    vdj.set_len(32 * MIB).unwrap();
    w("sys/block/vdj/vdj1/dev", &format!("{here}\n"));
    std::fs::create_dir(r("kroot")).unwrap();
    w(
        "mountinfo",
        &format!(
            "8 1 254:129 / {over} rw - ext4 /dev/vdi1 rw\n9 0 {here} / {kroot} rw - ext4 /dev/root rw\n",
            over = r("over").display(),
            kroot = r("kroot").display(),
        ),
    );
    assert_eq!(
        ask(&mut h, "waarm64-i", 32 * MIB),
        (
            "waarm64-i".into(),
            part::GROWN,
            fs::FAILED,
            18,
            gpt16to32 * 512
        ),
        "EXDEV: the mount point's directory is another filesystem's"
    );
    assert!(!r("over/grown").exists(), "the other filesystem not grown");
    assert_eq!(
        ask(&mut h, "waarm64-j", 32 * MIB),
        (
            "waarm64-j".into(),
            part::GROWN,
            fs::GROWN,
            0,
            gpt16to32 * 512
        )
    );
    assert_eq!(
        std::fs::read_to_string(r("kroot/grown")).unwrap(),
        format!("ext4 /dev/vdj1 {}\n", gpt16to32 * 512)
    );
    // A GROW that doesn't read (its size cut short; nothing at all) is answered too.
    let mut cut = grow_frame("waarm64-d1", 64 * MIB);
    cut.truncate(cut.len() - 3);
    h.page.send(frame::GROW, &cut);
    assert_eq!(
        grown(&h.page.next(frame::GROWN, 5000).expect("a GROWN")),
        ("waarm64-d1".into(), part::BAD_REQUEST, fs::SKIPPED, 22, 0)
    );
    h.page.send(frame::GROW, &[]);
    assert_eq!(
        grown(&h.page.next(frame::GROWN, 5000).expect("a GROWN")),
        ("".into(), part::BAD_REQUEST, fs::SKIPPED, 22, 0)
    );
}
