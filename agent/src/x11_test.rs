//! The session child against a real X server, natively: an Xvfb of the test's own (with a cookie, as a user's startx
//! makes one), xclip as the guest's programs, the test as the page (frames over the socketpair, as in src/sway_test.rs).
//! Skipped (saying so) where Xvfb, xauth or xclip isn't installed; the dev VM has them (docs/devenv.md).

use crate::clip::{HTML, PNG, TEXT};
use crate::frame::{self, ack};
use crate::session::{self, Jobs, Where};
use crate::sway_test::Page;
use crate::x11::{self, OWNER_WAIT};
use rustix::net::{AddressFamily, SocketFlags, SocketType, socketpair};
use std::io::{Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

fn have(cmd: &str, arg: &str) -> bool {
    Command::new(cmd)
        .arg(arg)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok()
}

/// Xorg on the dummy driver: one screen, room for 2048×2048 (its outputs start at 1024×768).
const XORG_DUMMY: &str = "Section \"Device\"\n  Identifier \"d\"\n  Driver \"dummy\"\n  VideoRam 65536\nEndSection\nSection \"Screen\"\n  Identifier \"s\"\n  Device \"d\"\n  DefaultDepth 24\n  SubSection \"Display\"\n    Depth 24\n    Virtual 2048 2048\n  EndSubSection\nEndSection\n";

/// The tests one at a time: each one's child takes any display of the user's it finds (another test's too).
static ONE: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn skip() -> bool {
    let ok = have("Xvfb", "-help") && have("xauth", "-V") && have("xclip", "-version");
    if !ok {
        eprintln!("SKIPPED: no Xvfb, xauth or xclip (docs/devenv.md)");
    }
    !ok
}

struct Xvfb {
    dir: PathBuf,
    server: Child,
    n: u32,
    auth: PathBuf,
}

impl Xvfb {
    /// An Xvfb on a free display number, its cookie in a file of the test's own (`-auth`, as startx does).
    fn start(name: &str) -> Xvfb {
        Xvfb::start_with(name, false)
    }

    /// `start`, or with `xorg` an Xorg on the dummy driver (RandR's modes can be made and set on it, not on Xvfb's).
    fn start_with(name: &str, xorg: bool) -> Xvfb {
        let dir =
            std::env::temp_dir().join(format!("waarm64-agent-x11-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir(&dir).unwrap();
        let auth = dir.join("Xauthority");
        // A display number nobody holds (its lock file), from the pid so that parallel tests differ.
        let mut n = 100 + (std::process::id() % 400) * 2 + name.len() as u32 % 2;
        while std::path::Path::new(&format!("/tmp/.X{n}-lock")).exists() {
            n += 1;
        }
        let cookie: String = (0..16)
            .map(|i| {
                format!(
                    "{:02x}",
                    (std::process::id() as usize * 31 + i * 7 + n as usize) as u8
                )
            })
            .collect();
        let st = Command::new("xauth")
            .arg("-f")
            .arg(&auth)
            .args(["add", &format!(":{n}"), "MIT-MAGIC-COOKIE-1", &cookie])
            .stderr(Stdio::null())
            .status()
            .unwrap();
        assert!(st.success());
        #[allow(clippy::zombie_processes)]
        // waited for in Drop, or the test fails (and its process ends)
        let server = if xorg {
            std::fs::write(dir.join("xorg.conf"), XORG_DUMMY).unwrap();
            Command::new("Xorg")
                .arg(format!(":{n}"))
                .arg("-config")
                .arg(dir.join("xorg.conf"))
                .arg("-logfile")
                .arg(dir.join("xorg.log"))
                .arg("-auth")
                .arg(&auth)
                .args(["-noreset", "-nolisten", "tcp"])
                .stdout(Stdio::null())
                .stderr(std::fs::File::create(dir.join("xvfb.log")).unwrap())
                .spawn()
                .unwrap()
        } else {
            Command::new("Xvfb")
                .arg(format!(":{n}"))
                .arg("-auth")
                .arg(&auth)
                .args(["-nolisten", "tcp", "-screen", "0", "320x240x24"])
                .stdout(Stdio::null())
                .stderr(std::fs::File::create(dir.join("xvfb.log")).unwrap())
                .spawn()
                .unwrap()
        };
        let x = Xvfb {
            dir,
            server,
            n,
            auth,
        };
        let end = Instant::now() + Duration::from_secs(20);
        // Up once its socket is there (its listen follows at once).
        while !std::path::Path::new(&format!("/tmp/.X11-unix/X{n}")).exists() {
            assert!(
                Instant::now() < end,
                "Xvfb didn't start: {}",
                std::fs::read_to_string(x.dir.join("xvfb.log")).unwrap_or_default()
            );
            std::thread::sleep(Duration::from_millis(100));
        }
        std::thread::sleep(Duration::from_millis(200));
        x
    }

    fn cmd(&self, program: &str) -> Command {
        let mut c = Command::new(program);
        c.env("DISPLAY", format!(":{}", self.n))
            .env("XAUTHORITY", &self.auth)
            .env_remove("WAYLAND_DISPLAY");
        c
    }

    /// xclip with `args` (bounded); its exit code (None: killed) and its output.
    fn xclip(&self, args: &[&str]) -> (Option<i32>, Vec<u8>) {
        let out = self
            .cmd("timeout")
            .arg("10")
            .arg("xclip")
            .args(args)
            .stderr(Stdio::null())
            .output()
            .unwrap();
        assert_ne!(out.status.code(), Some(124), "xclip {args:?} hung");
        (out.status.code(), out.stdout)
    }

    /// The guest copies `bytes` as `target` (xclip stays to serve them, as wl-copy does).
    fn copy(&self, bytes: &[u8], target: &str) {
        let mut c = self
            .cmd("xclip")
            .args(["-i", "-selection", "clipboard", "-t", target])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        c.stdin.take().unwrap().write_all(bytes).unwrap();
        // xclip forks to serve the selection; the parent exits once it is set.
        assert!(c.wait().unwrap().success());
    }

    /// The guest pastes as `target`: its bytes, or None (nothing, or refused).
    fn paste(&self, target: &str) -> Option<Vec<u8>> {
        let (code, out) = self.xclip(&["-o", "-selection", "clipboard", "-t", target]);
        (code == Some(0)).then_some(out)
    }

    /// A paste in the background: its output once it ends.
    fn paste_later(&self, target: &str) -> std::thread::JoinHandle<Vec<u8>> {
        let mut c = self
            .cmd("timeout")
            .args(["20", "xclip", "-o", "-selection", "clipboard", "-t", target])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut out = c.stdout.take().unwrap();
        std::thread::spawn(move || {
            let mut b = Vec::new();
            out.read_to_end(&mut b).unwrap();
            let _ = c.wait();
            b
        })
    }

    fn at(&self, runtime: &Path) -> Where {
        Where {
            runtime: runtime.to_str().unwrap().to_owned(),
            x11: session::X11_DIR.into(),
            display: Some(self.n),
            jobs: Jobs {
                clip: true,
                resize: false,
            },
        }
    }
}

impl Drop for Xvfb {
    fn drop(&mut self) {
        let _ = self.server.kill();
        let _ = self.server.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn text(n: usize) -> Vec<u8> {
    (0..n)
        .flat_map(|i| format!("line {i}, ünïcödé\n").into_bytes())
        .collect()
}

/// The page's end and the child on a thread, at `at`; a runtime directory of the test's own (no compositor in it).
fn child(at: impl FnOnce(&Path) -> Where, name: &str) -> (Page, Served, PathBuf) {
    let runtime = std::env::temp_dir().join(format!(
        "waarm64-agent-x11run-{name}-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&runtime);
    std::fs::create_dir(&runtime).unwrap();
    let (mine, theirs) = socketpair(
        AddressFamily::UNIX,
        SocketType::STREAM,
        SocketFlags::CLOEXEC,
        None,
    )
    .unwrap();
    let w = at(&runtime);
    let child = std::thread::spawn(move || session::serve_at(theirs, w, 0x0200_0000));
    let page = Page {
        fd: mine,
        reader: frame::Reader::default(),
        frames: Vec::new(),
    };
    (page, child, runtime)
}

type Served = std::thread::JoinHandle<Result<&'static str, (&'static str, rustix::io::Errno)>>;
/// An OFFER: its serial, its types (with their sizes) and its inline bytes.
type Offered = (u32, Vec<(String, u32)>, Option<Vec<u8>>);

/// The next OFFER: its serial, types and inline bytes.
fn offer(page: &mut Page, ms: u64) -> Option<Offered> {
    let p = page.next(frame::OFFER, ms)?;
    let o = frame::Offer::decode(&p).unwrap();
    Some((
        o.serial,
        o.types.iter().map(|(t, s)| (t.to_string(), *s)).collect(),
        o.inline.map(|b| b.to_vec()),
    ))
}

/// The page requests the guest's offer `serial` as `mime`: its bytes (MOREs as they come), or None (DATA FAIL).
fn fetch(page: &mut Page, serial: u32, id: u32, mime: &str) -> Option<Vec<u8>> {
    let mut req = Vec::new();
    frame::Request { serial, id, mime }.encode(&mut req);
    page.send(frame::REQUEST, &req);
    let mut got = Vec::new();
    loop {
        let p = page
            .next(frame::DATA, 10_000)
            .unwrap_or_else(|| panic!("no DATA for request {id}: {} bytes so far", got.len()));
        let (i, flags, b) = frame::decode_data(&p).unwrap();
        assert_eq!(i, id);
        if flags & frame::DATA_FAIL != 0 {
            return None;
        }
        got.extend_from_slice(b);
        if flags & frame::DATA_END != 0 {
            return Some(got);
        }
        page.send(frame::MORE, &frame::more(id, 1));
    }
}

/// The page's OFFER (types with sizes; the first's bytes inline if given), held (ACK).
fn host_offer(page: &mut Page, serial: u32, types: Vec<(&str, u32)>, inline: Option<&[u8]>) {
    let mut o = Vec::new();
    frame::Offer {
        serial,
        types,
        inline,
    }
    .encode(&mut o);
    page.send(frame::OFFER, &o);
    assert_eq!(
        page.next(frame::ACK, 3000).as_deref(),
        Some(&frame::ack(serial, ack::HELD)[..])
    );
}

/// Answers the agent's next REQUEST (for offer `serial`, as `mime`) with `bytes`, within its credit.
fn answer(page: &mut Page, serial: u32, mime: &str, bytes: &[u8]) {
    let p = page.next(frame::REQUEST, 10_000).expect("a REQUEST");
    let r = frame::Request::decode(&p).unwrap();
    assert_eq!((r.serial, r.mime), (serial, mime));
    let chunks: Vec<&[u8]> = bytes.chunks(frame::CHUNK).collect();
    let (mut sent, mut credit) = (0, frame::CREDIT as usize);
    while sent < chunks.len() {
        while credit > 0 && sent < chunks.len() {
            let end = sent + 1 == chunks.len();
            let mut d = Vec::new();
            frame::data(
                r.id,
                if end { frame::DATA_END } else { 0 },
                chunks[sent],
                &mut d,
            );
            page.send(frame::DATA, &d);
            sent += 1;
            credit -= 1;
        }
        if sent < chunks.len() {
            let m = page.next(frame::MORE, 10_000).expect("a MORE");
            let (id, n) = frame::decode_more(&m).unwrap();
            if id == r.id {
                credit += n as usize;
            }
        }
    }
}

#[test]
fn shares_the_x_servers_clipboard_both_ways() {
    if skip() {
        return;
    }
    let _one = ONE.lock().unwrap_or_else(|e| e.into_inner());
    let x = Xvfb::start("both");
    let (mut page, child, runtime) = child(|r| x.at(r), "both");
    assert!(
        page.next(frame::SESSION, 5000).is_some(),
        "SESSION once on the X server"
    );

    // Guest to host: short text inline, as the page's type.
    x.copy("from the guest ☃".as_bytes(), "UTF8_STRING");
    let (serial, types, inline) = offer(&mut page, 5000).expect("an OFFER for xclip's copy");
    assert!(serial > 0x0200_0000);
    assert_eq!(types, [(TEXT.to_owned(), "from the guest ☃".len() as u32)]);
    assert_eq!(inline.as_deref(), Some("from the guest ☃".as_bytes()));
    // 500 KB: one property (xclip sets it whole), read in CHUNKs from its offset.
    let long = text(25000);
    assert!(long.len() > 8 * session_chunk() && long.len() < 1 << 20);
    x.copy(&long, "UTF8_STRING");
    let (serial, types, inline) = offer(&mut page, 5000).expect("an OFFER for the long text");
    assert_eq!((types[0].1, inline), (frame::UNKNOWN, None));
    let got = fetch(&mut page, serial, 1, TEXT).expect("the long text");
    assert!(
        got == long,
        "the long text: {} bytes of {}",
        got.len(),
        long.len()
    );
    // 2 MB: past xclip's chunk (its server's largest request), so by INCR.
    let huge = text(110_000);
    assert!(huge.len() > 2 << 20);
    x.copy(&huge, "UTF8_STRING");
    let (serial, _, _) = offer(&mut page, 5000).expect("an OFFER for the huge text");
    let got = fetch(&mut page, serial, 2, TEXT).expect("the huge text");
    assert!(got == huge, "INCR: {} bytes of {}", got.len(), huge.len());
    // An image alone (its bytes as they are: the agent reads no picture), requested by its type.
    let png: Vec<u8> = (0..300_000u32).map(|i| (i * 7 + i / 255) as u8).collect();
    x.copy(&png, PNG);
    let (serial, types, _) = offer(&mut page, 5000).expect("an OFFER for the image");
    assert_eq!(types, [(PNG.to_owned(), frame::UNKNOWN)]);
    assert!(fetch(&mut page, serial, 3, PNG).unwrap() == png);
    // HTML alone.
    x.copy(b"<b>bold</b>", HTML);
    let (serial, types, _) = offer(&mut page, 5000).expect("an OFFER for HTML");
    assert_eq!(types, [(HTML.to_owned(), frame::UNKNOWN)]);
    assert_eq!(
        fetch(&mut page, serial, 4, HTML).as_deref(),
        Some(&b"<b>bold</b>"[..])
    );
    // A stale serial fails.
    assert_eq!(fetch(&mut page, serial - 1, 5, HTML), None);

    // Host to guest: inline text, held and pasted (twice: the cache) under each of its names.
    host_offer(&mut page, 5, vec![(TEXT, 9)], Some(b"host text"));
    for t in [
        "UTF8_STRING",
        "STRING",
        "TEXT",
        "text/plain;charset=utf-8",
        "UTF8_STRING",
    ] {
        assert_eq!(x.paste(t).as_deref(), Some(&b"host text"[..]), "as {t}");
    }
    assert!(
        page.next(frame::REQUEST, 200).is_none(),
        "inline: no request"
    );
    let targets = String::from_utf8(x.paste("TARGETS").unwrap()).unwrap();
    for t in [
        "TARGETS",
        "UTF8_STRING",
        "STRING",
        "TEXT",
        "text/plain;charset=utf-8",
    ] {
        assert!(
            targets.lines().any(|l| l == t),
            "TARGETS has {t}: {targets:?}"
        );
    }
    assert!(
        !targets.contains("image/png"),
        "no image offered: {targets:?}"
    );
    assert_eq!(x.paste("image/png"), None, "a type not offered: refused");
    // The host's text copied back by a guest program: no OFFER (echo suppression).
    x.copy(b"host text", "UTF8_STRING");
    assert!(
        offer(&mut page, 1000).is_none(),
        "the host's own text offered back"
    );
    // 400 KB, lazy: past the threshold, so the requestor gets it by INCR.
    let big = text(20000);
    host_offer(&mut page, 6, vec![(TEXT, big.len() as u32)], None);
    let paste = x.paste_later("UTF8_STRING");
    answer(&mut page, 6, TEXT, &big);
    let b = paste.join().unwrap();
    assert!(
        b == big,
        "INCR to xclip: {} bytes of {}",
        b.len(),
        big.len()
    );
    // Text, HTML and an image in one offer: each by its type; TARGETS lists them.
    let html = b"<p>from the <i>host</i></p>".to_vec();
    host_offer(
        &mut page,
        7,
        vec![
            (TEXT, 4),
            (HTML, html.len() as u32),
            (PNG, png.len() as u32),
        ],
        Some(b"host"),
    );
    let targets = String::from_utf8(x.paste("TARGETS").unwrap()).unwrap();
    assert!(
        targets.contains("text/html") && targets.contains("image/png"),
        "{targets:?}"
    );
    let p = x.paste_later(HTML);
    answer(&mut page, 7, HTML, &html);
    assert_eq!(p.join().unwrap(), html);
    let p = x.paste_later(PNG);
    answer(&mut page, 7, PNG, &png);
    assert!(p.join().unwrap() == png, "the image by INCR");
    assert_eq!(x.paste("UTF8_STRING").as_deref(), Some(&b"host"[..]));

    // PAUSE: the host's text leaves the clipboard; the guest's copies aren't offered; RESUME: they are again.
    page.send(frame::PAUSE, &[]);
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(
        x.paste("UTF8_STRING"),
        None,
        "paused: the host's text is gone"
    );
    x.copy(b"while paused", "UTF8_STRING");
    assert!(offer(&mut page, 1000).is_none(), "paused: offered");
    page.send(frame::RESUME, &[]);
    x.copy(b"after the pause", "UTF8_STRING");
    let (_, _, inline) = offer(&mut page, 5000).expect("an OFFER after RESUME");
    assert_eq!(inline.as_deref(), Some(&b"after the pause"[..]));

    // The server goes: SESSION again.
    drop(x);
    assert!(
        page.next(frame::SESSION, 5000).is_some(),
        "SESSION when the X server went"
    );
    drop(page);
    assert_eq!(child.join().unwrap(), Ok("session: the parent is gone"));
    let _ = std::fs::remove_dir_all(&runtime);
}

fn session_chunk() -> usize {
    crate::x11::CHUNK
}

/// A compositor without data-control (the test's: it answers the registry with no globals): the X server's clipboard
/// is shared instead (Xwayland's, under such a compositor), found by the user's processes, not a session file.
#[test]
fn a_compositor_without_data_control_gives_way_to_x11() {
    if skip() {
        return;
    }
    let _one = ONE.lock().unwrap_or_else(|e| e.into_inner());
    let x = Xvfb::start("nodc");
    let runtime =
        std::env::temp_dir().join(format!("waarm64-agent-x11run-nodc-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&runtime);
    std::fs::create_dir(&runtime).unwrap();
    let listener = std::os::unix::net::UnixListener::bind(runtime.join("wayland-0")).unwrap();
    // The compositor: get_registry (new_id 2) and sync (new_id 3) come; the callback's done, and nothing else.
    let compositor = std::thread::spawn(move || {
        let (mut s, _) = listener.accept().unwrap();
        let mut buf = [0u8; 24];
        s.read_exact(&mut buf).unwrap();
        let mut done = Vec::new();
        for w in [3u32, 12 << 16, 1] {
            done.extend_from_slice(&w.to_ne_bytes());
        }
        s.write_all(&done).unwrap();
        // Held open until the test ends (the child's end closes it).
        let _ = s.read(&mut [0u8; 64]);
    });
    let (mine, theirs) = socketpair(
        AddressFamily::UNIX,
        SocketType::STREAM,
        SocketFlags::CLOEXEC,
        None,
    )
    .unwrap();
    // No session file's display: the child finds the user's (Xvfb's own command line names it).
    let w = Where {
        runtime: runtime.to_str().unwrap().to_owned(),
        x11: session::X11_DIR.into(),
        display: None,
        jobs: Jobs {
            clip: true,
            resize: false,
        },
    };
    let child = std::thread::spawn(move || session::serve_at(theirs, w, 0x0300_0000));
    let mut page = Page {
        fd: mine,
        reader: frame::Reader::default(),
        frames: Vec::new(),
    };
    assert!(
        page.next(frame::SESSION, 8000).is_some(),
        "SESSION once on the X server"
    );
    x.copy(b"through X11", "UTF8_STRING");
    let (_, _, inline) = offer(&mut page, 5000).expect("an OFFER");
    assert_eq!(inline.as_deref(), Some(&b"through X11"[..]));
    host_offer(&mut page, 9, vec![(TEXT, 4)], Some(b"back"));
    assert_eq!(x.paste("UTF8_STRING").as_deref(), Some(&b"back"[..]));
    drop(page);
    assert_eq!(child.join().unwrap(), Ok("session: the parent is gone"));
    drop(x);
    let _ = compositor.join();
    let _ = std::fs::remove_dir_all(&runtime);
}

/// A raw X client of the test's own: the guest's other programs where xclip can't play them (an owner that never
/// answers, a requestor of two INCR transfers on one window). Blocking, its requests written by hand.
struct Raw {
    s: std::os::unix::net::UnixStream,
    inb: Vec<u8>,
    seq: u16,
    base: u32,
    root: u32,
    next: u32,
    /// Events read while waiting for something else.
    events: Vec<Vec<u8>>,
}

const SELECTION_REQUEST: u8 = 30;
const SELECTION_NOTIFY: u8 = 31;
const PROPERTY_NOTIFY: u8 = 28;

impl Raw {
    fn connect(x: &Xvfb) -> Raw {
        let mut s =
            std::os::unix::net::UnixStream::connect(format!("/tmp/.X11-unix/X{}", x.n)).unwrap();
        let cookie = x11::xauth_cookie(&std::fs::read(&x.auth).unwrap(), x.n, "");
        let mut out = Vec::new();
        x11::setup_request(cookie.as_deref(), &mut out);
        s.write_all(&out).unwrap();
        let mut r = Raw {
            s,
            inb: Vec::new(),
            seq: 0,
            base: 0,
            root: 0,
            next: 0,
            events: Vec::new(),
        };
        loop {
            match x11::setup_reply(&r.inb).unwrap() {
                Some((x11::Setup::Ok { root, base, .. }, size)) => {
                    r.inb.drain(..size);
                    (r.root, r.base) = (root, base);
                    return r;
                }
                Some((x11::Setup::Refused(why), _)) => panic!("the X server refused: {why}"),
                None => assert!(r.fill(Duration::from_secs(5)), "no setup reply"),
            }
        }
    }

    /// Reads what came within `t`; false if nothing did.
    fn fill(&mut self, t: Duration) -> bool {
        self.s
            .set_read_timeout(Some(t.max(Duration::from_millis(1))))
            .unwrap();
        let mut b = [0u8; 65536];
        match self.s.read(&mut b) {
            Ok(0) => panic!("the X server closed the connection"),
            Ok(n) => {
                self.inb.extend_from_slice(&b[..n]);
                true
            }
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                false
            }
            Err(e) => panic!("{e}"),
        }
    }

    fn send(&mut self, opcode: u8, data: u8, f: impl FnOnce(x11::Req<'_>) -> x11::Req<'_>) -> u16 {
        let mut out = Vec::new();
        f(x11::Req::new(&mut out, opcode, data)).done();
        self.s.write_all(&out).unwrap();
        self.seq = self.seq.wrapping_add(1);
        self.seq
    }

    /// The next message within `t`, whole.
    fn message(&mut self, t: Duration) -> Option<Vec<u8>> {
        let end = Instant::now() + t;
        loop {
            if let Some((_, size)) = x11::split(&self.inb).unwrap() {
                return Some(self.inb.drain(..size).collect());
            }
            let left = end.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return None;
            }
            self.fill(left);
        }
    }

    fn reply(&mut self, seq: u16) -> Vec<u8> {
        loop {
            let m = self.message(Duration::from_secs(5)).expect("a reply");
            match m[0] {
                0 => panic!("X error {} for request {}", m[1], m[10]),
                1 if x11::u16_at(&m, 2) == seq => return m,
                1 => {}
                _ => self.events.push(m),
            }
        }
    }

    /// The next event that `f` takes (those it doesn't are kept), within `ms`.
    fn event(&mut self, ms: u64, f: impl Fn(&[u8]) -> bool) -> Option<Vec<u8>> {
        if let Some(i) = self.events.iter().position(|e| f(e)) {
            return Some(self.events.remove(i));
        }
        let end = Instant::now() + Duration::from_millis(ms);
        loop {
            let m = self.message(end.saturating_duration_since(Instant::now()))?;
            match m[0] {
                0 => panic!("X error {} for request {}", m[1], m[10]),
                1 => {}
                _ if f(&m) => return Some(m),
                _ => self.events.push(m),
            }
        }
    }

    fn atom(&mut self, name: &str) -> u32 {
        let seq = self.send(16, 0, |r| {
            r.u16(name.len() as u16).u16(0).bytes(name.as_bytes())
        });
        x11::u32_at(&self.reply(seq), 8)
    }

    /// An InputOnly window of ours, hearing `mask`'s events.
    fn window(&mut self, mask: u32) -> u32 {
        self.next += 1;
        let (w, root) = (self.base | self.next, self.root);
        self.send(1, 0, |r| {
            r.u32(w)
                .u32(root)
                .u16(0)
                .u16(0)
                .u16(1)
                .u16(1)
                .u16(0)
                .u16(2)
                .u32(0)
                .u32(1 << 11)
                .u32(mask)
        });
        w
    }

    /// GetInputFocus's round trip: the requests before it are done.
    fn sync(&mut self) {
        let seq = self.send(43, 0, |r| r);
        self.reply(seq);
    }

    /// Window `w`'s property `p`, deleted: its type and value.
    fn take(&mut self, w: u32, p: u32) -> (u32, Vec<u8>) {
        let seq = self.send(20, 1, |r| r.u32(w).u32(p).u32(0).u32(0).u32(1 << 20));
        let reply = self.reply(seq);
        let (ty, _, value) = x11::property(&reply).unwrap();
        (ty, value.to_vec())
    }

    /// An INCR transfer into `w`'s property `p` (its INCR value taken already): each new value taken, until an empty
    /// one; None if one didn't come within `ms`.
    fn incr(&mut self, w: u32, p: u32, ms: u64) -> Option<Vec<u8>> {
        let mut got = Vec::new();
        loop {
            self.event(ms, |e| {
                e[0] & 0x7f == PROPERTY_NOTIFY
                    && x11::u32_at(e, 4) == w
                    && x11::u32_at(e, 8) == p
                    && e[16] == 0
            })?;
            let (_, v) = self.take(w, p);
            if v.is_empty() {
                return Some(got);
            }
            got.extend_from_slice(&v);
        }
    }
}

/// A guest program that takes the clipboard and never answers a request for it: its connection and its window.
fn silent_owner(x: &Xvfb) -> (Raw, u32) {
    let mut o = Raw::connect(x);
    let clip = o.atom("CLIPBOARD");
    let w = o.window(0);
    o.send(22, 0, |r| r.u32(w).u32(clip).u32(0));
    o.sync();
    (o, w)
}

#[test]
fn owners_that_never_answer_hold_nothing_for_long() {
    if skip() {
        return;
    }
    let _one = ONE.lock().unwrap_or_else(|e| e.into_inner());
    let x = Xvfb::start("silent");
    let (mut page, child, runtime) = child(|r| x.at(r), "silent");
    assert!(page.next(frame::SESSION, 5000).is_some());
    let asked = |e: &[u8]| e[0] & 0x7f == SELECTION_REQUEST;
    // Seven owners in turn (more than the conversions' slots) take the clipboard, get the agent's TARGETS and exit
    // without an answer (the server answers only for an owner gone before the request).
    for k in 0..7 {
        let (mut o, _) = silent_owner(&x);
        assert!(
            o.event(5000, asked).is_some(),
            "the agent's TARGETS never reached silent owner {k}"
        );
    }
    x.copy(b"after the silent owners", "UTF8_STRING");
    let (_, _, inline) = offer(&mut page, 5000).expect("an OFFER after owners that never answered");
    assert_eq!(inline.as_deref(), Some(&b"after the silent owners"[..]));
    // One that stays (as xclip does while it serves an INCR to another requestor) and takes the clipboard again: its
    // second TARGETS comes once the first's wait ended.
    let (mut o, w) = silent_owner(&x);
    assert!(o.event(5000, asked).is_some(), "the first TARGETS");
    let clip = o.atom("CLIPBOARD");
    o.send(22, 0, |r| r.u32(w).u32(clip).u32(0));
    o.sync();
    assert!(
        o.event(OWNER_WAIT.as_millis() as u64 + 3000, asked)
            .is_some(),
        "the owner's second TARGETS, behind the first that it never answered"
    );
    drop(o);
    x.copy(b"and after", "UTF8_STRING");
    let (_, _, inline) = offer(&mut page, 5000).expect("an OFFER after the one that stayed");
    assert_eq!(inline.as_deref(), Some(&b"and after"[..]));
    drop(page);
    assert_eq!(child.join().unwrap(), Ok("session: the parent is gone"));
    let _ = std::fs::remove_dir_all(&runtime);
}

/// xclip pasting in the background: its exit code (None: killed) and output once it ends.
fn paste_job(x: &Xvfb, target: &str) -> std::thread::JoinHandle<(Option<i32>, Vec<u8>)> {
    let c = x
        .cmd("timeout")
        .args(["20", "xclip", "-o", "-selection", "clipboard", "-t", target])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    std::thread::spawn(move || {
        let out = c.wait_with_output().unwrap();
        (out.status.code(), out.stdout)
    })
}

#[test]
fn a_failed_host_transfer_is_refused_not_pasted_empty() {
    if skip() {
        return;
    }
    let _one = ONE.lock().unwrap_or_else(|e| e.into_inner());
    let x = Xvfb::start("refuse");
    let (mut page, child, runtime) = child(|r| x.at(r), "refuse");
    assert!(page.next(frame::SESSION, 5000).is_some());
    let t = text(5000);
    host_offer(&mut page, 3, vec![(TEXT, t.len() as u32)], None);
    // The page fails the request (its offer gone, a cap): the requestor hears a refusal (no property). xclip then asks
    // for STRING, failed too.
    let paste = paste_job(&x, "UTF8_STRING");
    let mut failed = 0;
    while let Some(p) = page.next(frame::REQUEST, if failed == 0 { 10_000 } else { 2000 }) {
        let r = frame::Request::decode(&p).unwrap();
        let mut d = Vec::new();
        frame::data(r.id, frame::DATA_FAIL, &[], &mut d);
        page.send(frame::DATA, &d);
        failed += 1;
    }
    assert!(failed > 0, "no REQUEST");
    let (code, out) = paste.join().unwrap();
    assert_ne!(code, Some(124), "xclip hung");
    assert_ne!(
        code,
        Some(0),
        "xclip took a failed transfer for a paste of {} bytes",
        out.len()
    );
    // Answered whole, the same offer pastes.
    let paste = paste_job(&x, "UTF8_STRING");
    answer(&mut page, 3, TEXT, &t);
    let (code, out) = paste.join().unwrap();
    assert!(
        code == Some(0) && out == t,
        "the paste after: {code:?}, {} bytes",
        out.len()
    );
    drop(page);
    assert_eq!(child.join().unwrap(), Ok("session: the parent is gone"));
    let _ = std::fs::remove_dir_all(&runtime);
}

#[test]
fn two_incr_transfers_to_one_window_both_end() {
    if skip() {
        return;
    }
    let _one = ONE.lock().unwrap_or_else(|e| e.into_inner());
    let x = Xvfb::start("twoincr");
    let (mut page, child, runtime) = child(|r| x.at(r), "twoincr");
    assert!(page.next(frame::SESSION, 5000).is_some());
    // Past the threshold (the server's largest request, 256 KiB): by INCR; small enough that the agent holds it all
    // before the requestor takes a chunk (the page answers both requests first).
    let t = text(16000);
    assert!(t.len() > 262_144 && t.len() < 480_000, "{}", t.len());
    host_offer(&mut page, 4, vec![(TEXT, t.len() as u32)], None);
    let mut r = Raw::connect(&x);
    let (clip, utf8, incr) = (r.atom("CLIPBOARD"), r.atom("UTF8_STRING"), r.atom("INCR"));
    let (pa, pb) = (r.atom("WAARM64_TEST_A"), r.atom("WAARM64_TEST_B"));
    // One window, two properties (as a MULTIPLE does, or two pastes in a row from one program).
    let w = r.window(1 << 22);
    for p in [pa, pb] {
        r.send(24, 0, |q| q.u32(w).u32(clip).u32(utf8).u32(p).u32(0));
    }
    answer(&mut page, 4, TEXT, &t);
    answer(&mut page, 4, TEXT, &t);
    for p in [pa, pb] {
        r.event(5000, |e| {
            e[0] & 0x7f == SELECTION_NOTIFY && x11::u32_at(e, 20) == p
        })
        .expect("a SelectionNotify");
    }
    // The INCR values' own PropertyNotify (before the SelectionNotify): not a chunk.
    r.events.retain(|e| e[0] & 0x7f != PROPERTY_NOTIFY);
    assert_eq!(r.take(w, pa).0, incr, "A by INCR");
    let a = r.incr(w, pa, 5000).expect("A's chunks");
    assert!(a == t, "A: {} bytes of {}", a.len(), t.len());
    assert_eq!(r.take(w, pb).0, incr, "B by INCR");
    let b = r
        .incr(w, pb, 3000)
        .expect("B's chunks: none came after A's transfer ended");
    assert!(b == t, "B: {} bytes of {}", b.len(), t.len());
    drop(page);
    assert_eq!(child.join().unwrap(), Ok("session: the parent is gone"));
    let _ = std::fs::remove_dir_all(&runtime);
}

impl Xvfb {
    /// The screen's size as xrandr says it (`current W x H`).
    fn screen(&self) -> Option<(u32, u32)> {
        let out = self.cmd("timeout").args(["5", "xrandr"]).output().ok()?;
        let s = String::from_utf8(out.stdout).ok()?;
        let at = s.find("current ")? + 8;
        let mut it = s[at..].split(',').next()?.split(" x ");
        Some((
            it.next()?.trim().parse().ok()?,
            it.next()?.trim().parse().ok()?,
        ))
    }

    fn screen_becomes(&self, size: (u32, u32), ms: u64) -> bool {
        let end = Instant::now() + Duration::from_millis(ms);
        while Instant::now() < end {
            if self.screen() == Some(size) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        false
    }
}

#[test]
fn sets_an_x_servers_screen_to_the_pages_size_without_the_clipboard() {
    let dummy = std::path::Path::new("/usr/lib64/xorg/modules/drivers/dummy_drv.so").exists()
        || std::path::Path::new("/usr/lib/xorg/modules/drivers/dummy_drv.so").exists();
    if !have("Xorg", "-version") || !dummy || !have("xrandr", "--version") || !have("xauth", "-V") {
        eprintln!("SKIPPED: no Xorg with the dummy driver, xrandr or xauth (docs/devenv.md)");
        return;
    }
    let _one = ONE.lock().unwrap_or_else(|e| e.into_inner());
    let x = Xvfb::start_with("randr", true);
    assert!(
        x.screen_becomes((1024, 768), 10_000),
        "Xorg's own size: {:?}",
        x.screen()
    );
    let size = |w: u32, h: u32| [w.to_le_bytes(), h.to_le_bytes()].concat();
    let (mut page, served, _runtime) = child(
        |r| Where {
            jobs: Jobs {
                clip: false,
                resize: true,
            },
            ..x.at(r)
        },
        "randr",
    );
    // A size no mode has: made, then set (the screen grown to it).
    page.send(frame::DISPLAY, &size(1200, 904));
    assert!(x.screen_becomes((1200, 904), 10_000), "{:?}", x.screen());
    // Smaller, one of the output's own modes.
    page.send(frame::DISPLAY, &size(800, 600));
    assert!(x.screen_becomes((800, 600), 10_000), "{:?}", x.screen());
    // Wider but shorter than now: the screen grown in one side, then sized to the mode.
    page.send(frame::DISPLAY, &size(1024, 576));
    assert!(x.screen_becomes((1024, 576), 10_000), "{:?}", x.screen());
    // The made mode again: found, not made twice.
    page.send(frame::DISPLAY, &size(1200, 904));
    assert!(x.screen_becomes((1200, 904), 10_000), "{:?}", x.screen());
    let modes = x.cmd("xrandr").output().unwrap().stdout;
    let made = String::from_utf8_lossy(&modes)
        .lines()
        .filter(|l| l.trim_start().starts_with("1200x904 "))
        .count();
    assert_eq!(
        made,
        1,
        "one mode of 1200x904: {}",
        String::from_utf8_lossy(&modes)
    );
    assert!(page.next(frame::SESSION, 300).is_none(), "no clipboard");
    drop(page);
    assert_eq!(served.join().unwrap(), Ok("session: the parent is gone"));
}
