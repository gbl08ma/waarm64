//! The session child against a real X server, natively: an Xvfb of the test's own (with a cookie, as a user's startx
//! makes one), xclip as the guest's programs, the test as the page (frames over the socketpair, as in src/sway_test.rs).
//! Skipped (saying so) where Xvfb, xauth or xclip isn't installed; the dev VM has them (docs/devenv.md).

use crate::clip::{HTML, PNG, TEXT};
use crate::frame::{self, ack};
use crate::session::{self, Where};
use crate::sway_test::Page;
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
        let dir =
            std::env::temp_dir().join(format!("webpc-agent-x11-{name}-{}", std::process::id()));
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
        let server = Command::new("Xvfb")
            .arg(format!(":{n}"))
            .arg("-auth")
            .arg(&auth)
            .args(["-nolisten", "tcp", "-screen", "0", "320x240x24"])
            .stdout(Stdio::null())
            .stderr(std::fs::File::create(dir.join("xvfb.log")).unwrap())
            .spawn()
            .unwrap();
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
    let runtime =
        std::env::temp_dir().join(format!("webpc-agent-x11run-{name}-{}", std::process::id()));
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
        std::env::temp_dir().join(format!("webpc-agent-x11run-nodc-{}", std::process::id()));
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
