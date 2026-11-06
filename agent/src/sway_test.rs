//! The session child against a real compositor, natively: a headless sway in a runtime directory of the test's own,
//! wl-clipboard as the guest's programs, the test as the page (frames over the socketpair). Skipped (saying so) where
//! sway or wl-clipboard isn't installed; the dev VM has both (docs/devenv.md), and its sway (1.12, wlroots 0.20) has
//! `ext_data_control_manager_v1`, the Debian test image's only the wlr one (tests/page-clipboard.test.ts).

use crate::clip::TEXT;
use crate::frame::{self, ack};
use crate::session;
use rustix::event::{PollFd, PollFlags, Timespec, poll};
use rustix::fd::OwnedFd;
use rustix::io::{read, write};
use rustix::net::{AddressFamily, SocketFlags, SocketType, socketpair};
use std::io::{Read as _, Write as _};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

fn have(cmd: &str) -> bool {
    Command::new(cmd)
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok()
}

struct Sway {
    dir: PathBuf,
    sway: Child,
    socket: String,
}

impl Sway {
    fn start(name: &str) -> Sway {
        let dir =
            std::env::temp_dir().join(format!("webpc-agent-sway-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir(&dir).unwrap();
        std::fs::write(dir.join("config"), "output * resolution 640x480\n").unwrap();
        #[allow(clippy::zombie_processes)]
        // waited for in Drop, or the test fails (and its process ends)
        let sway = Command::new("sway")
            .arg("-c")
            .arg(dir.join("config"))
            .env("XDG_RUNTIME_DIR", &dir)
            .env("WLR_BACKENDS", "headless")
            .env("WLR_RENDERER", "pixman")
            .env("WLR_LIBINPUT_NO_DEVICES", "1")
            .env_remove("WAYLAND_DISPLAY")
            .env_remove("DISPLAY")
            .stdout(Stdio::null())
            .stderr(std::fs::File::create(dir.join("sway.log")).unwrap())
            .spawn()
            .unwrap();
        let end = Instant::now() + Duration::from_secs(20);
        loop {
            let socket = std::fs::read_dir(&dir)
                .unwrap()
                .filter_map(|e| e.ok()?.file_name().into_string().ok())
                .find(|n| session::is_socket_name(n));
            if let Some(socket) = socket {
                // Its listen follows its bind: the child's retries cover it, the tests' programs need it done.
                std::thread::sleep(Duration::from_millis(300));
                return Sway { dir, sway, socket };
            }
            assert!(
                Instant::now() < end,
                "sway didn't start: {}",
                std::fs::read_to_string(dir.join("sway.log")).unwrap_or_default()
            );
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// A wl-clipboard program on this sway.
    fn wl(&self, program: &str) -> Command {
        let mut c = Command::new(program);
        c.env("XDG_RUNTIME_DIR", &self.dir)
            .env("WAYLAND_DISPLAY", &self.socket);
        c
    }

    fn copy(&self, text: &[u8]) {
        let mut c = self
            .wl("wl-copy")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        c.stdin.take().unwrap().write_all(text).unwrap();
        // wl-copy forks to serve the selection; the parent exits once it is set.
        assert!(c.wait().unwrap().success());
    }

    /// wl-paste's output, or None if it found nothing.
    fn paste(&self) -> Option<Vec<u8>> {
        // Bounded: a paste whose bytes never come fails the test rather than hanging it.
        let out = self
            .wl("timeout")
            .args(["5", "wl-paste", "-n", "-t", "text/plain;charset=utf-8"])
            .output()
            .unwrap();
        assert_ne!(out.status.code(), Some(124), "wl-paste got no bytes in 5 s");
        out.status.success().then_some(out.stdout)
    }
}

impl Drop for Sway {
    fn drop(&mut self) {
        let _ = self.sway.kill();
        let _ = self.sway.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// The test's end of the socketpair: the page.
pub(crate) struct Page {
    pub(crate) fd: OwnedFd,
    pub(crate) reader: frame::Reader,
    pub(crate) frames: Vec<(u8, Vec<u8>)>,
}

impl Page {
    pub(crate) fn send(&self, kind: u8, payload: &[u8]) {
        let mut out = Vec::new();
        assert!(frame::encode(kind, payload, &mut out));
        let mut at = 0;
        while at < out.len() {
            at += write(&self.fd, &out[at..]).unwrap();
        }
    }

    /// The next frame of type `kind` (others kept), within `ms`; None if none came.
    pub(crate) fn next(&mut self, kind: u8, ms: u64) -> Option<Vec<u8>> {
        let end = Instant::now() + Duration::from_millis(ms);
        loop {
            if let Some(i) = self.frames.iter().position(|(k, _)| *k == kind) {
                return Some(self.frames.remove(i).1);
            }
            let left = end.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return None;
            }
            let t = Timespec {
                tv_sec: left.as_secs() as i64,
                tv_nsec: left.subsec_nanos() as i64,
            };
            let mut fds = [PollFd::new(&self.fd, PollFlags::IN)];
            if poll(&mut fds, Some(&t)).unwrap() == 0 {
                continue;
            }
            let mut buf = [0u8; 65536];
            let n = read(&self.fd, &mut buf).unwrap();
            assert!(n > 0, "the child closed its end");
            let frames = &mut self.frames;
            self.reader
                .push(&buf[..n], |k, p| frames.push((k, p.to_vec())));
        }
    }

    fn offer(&mut self, ms: u64) -> Option<(u32, Option<Vec<u8>>, u32)> {
        let p = self.next(frame::OFFER, ms)?;
        let o = frame::Offer::decode(&p).unwrap();
        assert_eq!(o.types.len(), 1);
        assert_eq!(o.types[0].0, TEXT);
        Some((o.serial, o.inline.map(|b| b.to_vec()), o.types[0].1))
    }
}

fn text(n: usize) -> Vec<u8> {
    (0..n)
        .flat_map(|i| format!("line {i}, ünïcödé\n").into_bytes())
        .collect()
}

#[test]
fn shares_sways_clipboard_both_ways() {
    if !have("sway") || !have("wl-copy") {
        eprintln!("SKIPPED: no sway or wl-clipboard (docs/devenv.md)");
        return;
    }
    let mut sway = Sway::start("both-ways");
    let (mine, theirs) = socketpair(
        AddressFamily::UNIX,
        SocketType::STREAM,
        SocketFlags::CLOEXEC,
        None,
    )
    .unwrap();
    let runtime = sway.dir.to_str().unwrap().to_owned();
    let child = std::thread::spawn(move || session::serve(theirs, runtime, 0x0100_0000));
    let mut page = Page {
        fd: mine,
        reader: frame::Reader::default(),
        frames: Vec::new(),
    };

    // On the compositor's data device: SESSION (the page forgets the guest's clipboard it knew).
    assert!(
        page.next(frame::SESSION, 5000).is_some(),
        "SESSION once on the compositor"
    );
    // Guest to host: short text inline (the serials the child's base's).
    sway.copy("from the guest ☃".as_bytes());
    let (serial, inline, size) = page.offer(5000).expect("an OFFER for wl-copy");
    assert!(serial > 0x0100_0000);
    assert_eq!(inline.as_deref(), Some("from the guest ☃".as_bytes()));
    assert_eq!(size as usize, "from the guest ☃".len());
    // Long: offered without its bytes, which a REQUEST gets in DATA frames, CREDIT before the first MORE.
    let long = text(20000);
    sway.copy(&long);
    let (serial, inline, size) = page.offer(5000).expect("an OFFER for the long text");
    assert_eq!((inline, size), (None, frame::UNKNOWN));
    let mut req = Vec::new();
    frame::Request {
        serial,
        id: 7,
        mime: TEXT,
    }
    .encode(&mut req);
    page.send(frame::REQUEST, &req);
    let mut got = Vec::new();
    let mut frames = 0;
    loop {
        let p = page.next(frame::DATA, 5000).expect("DATA");
        let (id, flags, b) = frame::decode_data(&p).unwrap();
        assert_eq!(id, 7);
        assert_eq!(flags & frame::DATA_FAIL, 0);
        got.extend_from_slice(b);
        frames += 1;
        if flags & frame::DATA_END != 0 {
            break;
        }
        // No MORE yet for the first CREDIT frames: none past them comes.
        if frames == frame::CREDIT {
            assert!(page.next(frame::DATA, 300).is_none(), "past the credit");
            page.send(frame::MORE, &frame::more(7, 100));
        }
    }
    assert!(
        got == long,
        "the long text: {} bytes of {}",
        got.len(),
        long.len()
    );
    // A request for a stale serial fails.
    let mut req = Vec::new();
    frame::Request {
        serial: serial - 1,
        id: 8,
        mime: TEXT,
    }
    .encode(&mut req);
    page.send(frame::REQUEST, &req);
    let p = page.next(frame::DATA, 2000).unwrap();
    assert_eq!(
        frame::decode_data(&p).unwrap(),
        (8, frame::DATA_FAIL, &[][..])
    );

    // Host to guest: the page's offer inline, held (ACK) and pasted, twice (the cache).
    let mut o = Vec::new();
    frame::Offer {
        serial: 5,
        types: vec![(TEXT, 9)],
        inline: Some(b"host text"),
    }
    .encode(&mut o);
    page.send(frame::OFFER, &o);
    assert_eq!(
        page.next(frame::ACK, 3000).as_deref(),
        Some(&frame::ack(5, ack::HELD)[..])
    );
    assert_eq!(sway.paste().as_deref(), Some(&b"host text"[..]));
    assert_eq!(sway.paste().as_deref(), Some(&b"host text"[..]));
    assert!(
        page.next(frame::REQUEST, 200).is_none(),
        "inline: no request"
    );
    // The host's text copied back by a guest program: no OFFER (echo suppression).
    sway.copy(b"host text");
    assert!(
        page.offer(1000).is_none(),
        "the host's own text offered back"
    );
    // Past inline, under the cache: requested at the first paste, from the cache at the second.
    let mid = text(400);
    let mut o = Vec::new();
    frame::Offer {
        serial: 8,
        types: vec![(TEXT, mid.len() as u32)],
        inline: None,
    }
    .encode(&mut o);
    page.send(frame::OFFER, &o);
    assert_eq!(
        page.next(frame::ACK, 3000).as_deref(),
        Some(&frame::ack(8, ack::HELD)[..])
    );
    let paste = sway
        .wl("wl-paste")
        .arg("-n")
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let r = frame::Request::decode(&page.next(frame::REQUEST, 5000).expect("a REQUEST"))
        .unwrap()
        .id;
    let mut d = Vec::new();
    frame::data(r, frame::DATA_END, &mid, &mut d);
    page.send(frame::DATA, &d);
    assert!(paste.wait_with_output().unwrap().stdout == mid);
    assert!(sway.paste().unwrap() == mid);
    assert!(
        page.next(frame::REQUEST, 300).is_none(),
        "the second paste: from the cache"
    );
    // Long, lazy: each paste requests it; the page's DATA within the credit.
    let big = text(30000);
    let mut o = Vec::new();
    frame::Offer {
        serial: 6,
        types: vec![(TEXT, big.len() as u32)],
        inline: None,
    }
    .encode(&mut o);
    page.send(frame::OFFER, &o);
    assert_eq!(
        page.next(frame::ACK, 3000).as_deref(),
        Some(&frame::ack(6, ack::HELD)[..])
    );
    for _ in 0..2 {
        let mut paste = sway
            .wl("wl-paste")
            .arg("-n")
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let p = page
            .next(frame::REQUEST, 5000)
            .expect("a REQUEST for the paste");
        let r = frame::Request::decode(&p).unwrap();
        assert_eq!((r.serial, r.mime), (6, TEXT));
        let chunks: Vec<&[u8]> = big.chunks(frame::CHUNK).collect();
        let (mut sent, mut credit) = (0, frame::CREDIT as usize);
        let mut out = paste.stdout.take().unwrap();
        let reader = std::thread::spawn(move || {
            let mut b = Vec::new();
            out.read_to_end(&mut b).unwrap();
            b
        });
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
                // (The last paste's MOREs for frames sent after its reader had them all: not this one's.)
                let m = page.next(frame::MORE, 5000).expect("a MORE");
                let (id, n) = frame::decode_more(&m).unwrap();
                if id == r.id {
                    credit += n as usize;
                }
            }
        }
        let b = reader.join().unwrap();
        assert!(paste.wait().unwrap().success());
        assert!(
            b == big,
            "the long paste: {} bytes of {}",
            b.len(),
            big.len()
        );
    }

    // PAUSE: the host's text leaves the clipboard; the guest's copies aren't offered; RESUME: they are again.
    page.send(frame::PAUSE, &[]);
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(sway.paste(), None, "paused: the host's text is gone");
    let mut o = Vec::new();
    frame::Offer {
        serial: 7,
        types: vec![(TEXT, 1)],
        inline: Some(b"x"),
    }
    .encode(&mut o);
    page.send(frame::OFFER, &o);
    assert_eq!(
        page.next(frame::ACK, 3000).as_deref(),
        Some(&frame::ack(7, ack::PAUSED)[..])
    );
    sway.copy(b"while paused");
    assert!(page.offer(1000).is_none(), "paused: offered");
    page.send(frame::RESUME, &[]);
    sway.copy(b"after the pause");
    let (_, inline, _) = page.offer(5000).expect("an OFFER after RESUME");
    assert_eq!(inline.as_deref(), Some(&b"after the pause"[..]));

    // The compositor goes: SESSION again.
    let _ = sway.sway.kill();
    let _ = sway.sway.wait();
    assert!(
        page.next(frame::SESSION, 5000).is_some(),
        "SESSION when the compositor went"
    );

    // The page goes: the child's loop ends.
    drop(page);
    assert_eq!(child.join().unwrap(), Ok("session: the parent is gone"));
}

/// A page's OFFER of `text` (inline or not) as offer `serial`, held (ACK).
fn host_offer(page: &mut Page, serial: u32, text: &[u8], inline: bool) {
    let mut o = Vec::new();
    frame::Offer {
        serial,
        types: vec![(TEXT, text.len() as u32)],
        inline: inline.then_some(text),
    }
    .encode(&mut o);
    page.send(frame::OFFER, &o);
    assert_eq!(
        page.next(frame::ACK, 3000).as_deref(),
        Some(&frame::ack(serial, ack::HELD)[..])
    );
}

#[test]
fn the_hosts_hash_and_transfers_follow_the_clipboard() {
    if !have("sway") || !have("wl-copy") {
        eprintln!("SKIPPED: no sway or wl-clipboard (docs/devenv.md)");
        return;
    }
    let sway = Sway::start("follow");
    let (mine, theirs) = socketpair(
        AddressFamily::UNIX,
        SocketType::STREAM,
        SocketFlags::CLOEXEC,
        None,
    )
    .unwrap();
    let runtime = sway.dir.to_str().unwrap().to_owned();
    let child = std::thread::spawn(move || session::serve(theirs, runtime, 0x0100_0000));
    let mut page = Page {
        fd: mine,
        reader: frame::Reader::default(),
        frames: Vec::new(),
    };
    assert!(page.next(frame::SESSION, 5000).is_some());

    // The host's hash stands for "the guest's clipboard still has it": once the guest copies something else, the
    // host's text copied again is the guest's news.
    host_offer(&mut page, 1, b"text A", true);
    sway.copy(b"text B");
    assert_eq!(
        page.offer(5000).expect("an OFFER of B").1.as_deref(),
        Some(&b"text B"[..])
    );
    sway.copy(b"text A");
    assert_eq!(
        page.offer(5000)
            .expect("an OFFER of A, copied again after B")
            .1
            .as_deref(),
        Some(&b"text A"[..])
    );

    // A paste of an offer that a newer one replaced, finishing: not the host's text any more.
    host_offer(&mut page, 2, b"superseded", false);
    let paste = sway
        .wl("timeout")
        .args(["5", "wl-paste", "-n"])
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let p = page.next(frame::REQUEST, 5000).expect("a REQUEST");
    let r = frame::Request::decode(&p).unwrap();
    assert_eq!(r.serial, 2);
    host_offer(&mut page, 3, b"newer", true);
    let mut d = Vec::new();
    frame::data(r.id, frame::DATA_END, b"superseded", &mut d);
    page.send(frame::DATA, &d);
    assert_eq!(paste.wait_with_output().unwrap().stdout, b"superseded");
    sway.copy(b"superseded");
    assert_eq!(
        page.offer(5000)
            .expect("an OFFER of the superseded offer's text")
            .1
            .as_deref(),
        Some(&b"superseded"[..])
    );
    // The host's text inline, then other text lazily (no hash yet): the first copied again in the guest is news.
    host_offer(&mut page, 10, b"text C", true);
    host_offer(&mut page, 11, &text(1000), false);
    sway.copy(b"text C");
    assert_eq!(
        page.offer(5000)
            .expect("an OFFER of the host's earlier text")
            .1
            .as_deref(),
        Some(&b"text C"[..])
    );

    // The page's HELLO (a new page, a restored one, the port reopened): what was in flight belonged to the page before.
    // A guest program pasting the host's text gets its end, not a wait for DATA that won't come.
    let big = text(10000);
    host_offer(&mut page, 4, &big, false);
    let paste = sway
        .wl("timeout")
        .args(["5", "wl-paste", "-n"])
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let p = page.next(frame::REQUEST, 5000).expect("a REQUEST");
    let r = frame::Request::decode(&p).unwrap();
    let mut d = Vec::new();
    frame::data(r.id, 0, &big[..frame::CHUNK], &mut d);
    page.send(frame::DATA, &d);
    page.send(
        frame::HELLO,
        &frame::Hello {
            version: 1,
            caps: 3,
        }
        .encode(),
    );
    let out = paste.wait_with_output().unwrap();
    assert_ne!(
        out.status.code(),
        Some(124),
        "the paste still waiting after HELLO"
    );
    // A guest program's text being read for the page's request: the new page's MORE for the same id takes nothing.
    let long = text(20000);
    sway.copy(&long);
    let (serial, _, _) = page.offer(5000).expect("an OFFER for the long text");
    let mut req = Vec::new();
    frame::Request {
        serial,
        id: 9,
        mime: TEXT,
    }
    .encode(&mut req);
    page.send(frame::REQUEST, &req);
    for _ in 0..frame::CREDIT {
        page.next(frame::DATA, 5000).expect("DATA");
    }
    page.send(
        frame::HELLO,
        &frame::Hello {
            version: 1,
            caps: 3,
        }
        .encode(),
    );
    page.send(frame::MORE, &frame::more(9, 100));
    assert!(
        page.next(frame::DATA, 500).is_none(),
        "a stale transfer answered the new page's MORE"
    );

    drop(page);
    assert_eq!(child.join().unwrap(), Ok("session: the parent is gone"));
}

/// The page's DATA for request `id`: `bytes` in chunks, within the credit (MOREs taken as they come).
fn answer(page: &mut Page, id: u32, bytes: &[u8]) {
    let chunks: Vec<&[u8]> = bytes.chunks(frame::CHUNK).collect();
    let (mut sent, mut credit) = (0, frame::CREDIT as usize);
    while sent < chunks.len() {
        while credit > 0 && sent < chunks.len() {
            let end = sent + 1 == chunks.len();
            let mut d = Vec::new();
            frame::data(
                id,
                if end { frame::DATA_END } else { 0 },
                chunks[sent],
                &mut d,
            );
            page.send(frame::DATA, &d);
            sent += 1;
            credit -= 1;
        }
        if sent < chunks.len() {
            let m = page.next(frame::MORE, 5000).expect("a MORE");
            let (i, n) = frame::decode_more(&m).unwrap();
            if i == id {
                credit += n as usize;
            }
        }
    }
}

/// What the page gets for its REQUEST of offer `serial` as `mime` (id `id`), MOREs as it goes; None if it failed.
fn fetch(page: &mut Page, serial: u32, id: u32, mime: &str) -> Option<Vec<u8>> {
    let mut req = Vec::new();
    frame::Request { serial, id, mime }.encode(&mut req);
    page.send(frame::REQUEST, &req);
    let mut got = Vec::new();
    loop {
        let p = page.next(frame::DATA, 5000).expect("DATA");
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

/// Bytes that stand for an image: the agent passes them through, whatever they are.
fn picture(n: usize, seed: u32) -> Vec<u8> {
    let mut x = seed | 1;
    (0..n)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            x as u8
        })
        .collect()
}

#[test]
fn shares_images_both_ways_streamed_and_capped() {
    if !have("sway") || !have("wl-copy") {
        eprintln!("SKIPPED: no sway or wl-clipboard (docs/devenv.md)");
        return;
    }
    let sway = Sway::start("images");
    let (mine, theirs) = socketpair(
        AddressFamily::UNIX,
        SocketType::STREAM,
        SocketFlags::CLOEXEC,
        None,
    )
    .unwrap();
    let runtime = sway.dir.to_str().unwrap().to_owned();
    let child = std::thread::spawn(move || session::serve(theirs, runtime, 0x0100_0000));
    let mut page = Page {
        fd: mine,
        reader: frame::Reader::default(),
        frames: Vec::new(),
    };
    assert!(page.next(frame::SESSION, 5000).is_some());
    let copy = |mime: &str, bytes: &[u8]| {
        let mut c = sway
            .wl("wl-copy")
            .args(["--type", mime])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        c.stdin.take().unwrap().write_all(bytes).unwrap();
        assert!(c.wait().unwrap().success());
    };
    let paste = |mime: &str| {
        sway.wl("timeout")
            .args(["5", "wl-paste", "-n", "-t", mime])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap()
    };
    let types = || {
        let out = sway.wl("wl-paste").arg("-l").output().unwrap();
        String::from_utf8(out.stdout).unwrap()
    };
    let offer = |page: &mut Page| {
        let p = page.next(frame::OFFER, 5000).expect("an OFFER");
        let o = frame::Offer::decode(&p).unwrap();
        let types: Vec<(String, u32)> = o.types.iter().map(|(t, s)| (t.to_string(), *s)).collect();
        (o.serial, types, o.inline.map(|b| b.to_vec()))
    };

    // Guest to host: a PNG offered at once, without its bytes (no size: Wayland says none), which a REQUEST streams
    // under the credit (past CREDIT frames: 300 KiB).
    let png = picture(300 << 10, 7);
    copy("image/png", &png);
    let (serial, offered, inline) = offer(&mut page);
    assert_eq!(offered, vec![("image/png".to_owned(), frame::UNKNOWN)]);
    assert_eq!(inline, None);
    let got = fetch(&mut page, serial, 1, "image/png").expect("the PNG's bytes");
    assert!(got == png, "the PNG: {} bytes of {}", got.len(), png.len());
    // Asked as text, which it hasn't: FAIL.
    assert_eq!(fetch(&mut page, serial, 2, TEXT), None);
    // A JPEG alone: offered as it is (the page converts it), not as PNG.
    let jpeg = picture(5000, 9);
    copy("image/jpeg", &jpeg);
    let (serial, offered, _) = offer(&mut page);
    assert_eq!(offered, vec![("image/jpeg".to_owned(), frame::UNKNOWN)]);
    assert_eq!(
        fetch(&mut page, serial, 3, "image/png"),
        None,
        "no PNG offered"
    );
    assert!(fetch(&mut page, serial, 4, "image/jpeg").unwrap() == jpeg);
    // An image the page can't take (SVG; wl-copy offers it as text too): its text alone.
    copy("image/svg+xml", b"<svg/>");
    let (_, offered, inline) = offer(&mut page);
    assert_eq!(offered, vec![(TEXT.to_owned(), 6)]);
    assert_eq!(inline.as_deref(), Some(&b"<svg/>"[..]));

    // Host to guest: the page's PNG, held; offered to guest programs as image/png alone; each paste requests it (no
    // cache for images), streamed within the credit.
    let host = picture(400 << 10, 11);
    let mut o = Vec::new();
    frame::Offer {
        serial: 20,
        types: vec![("image/png", host.len() as u32)],
        inline: None,
    }
    .encode(&mut o);
    page.send(frame::OFFER, &o);
    assert_eq!(
        page.next(frame::ACK, 3000).as_deref(),
        Some(&frame::ack(20, ack::HELD)[..])
    );
    assert_eq!(types().trim(), "image/png");
    for _ in 0..2 {
        let mut p = paste("image/png");
        let q = page.next(frame::REQUEST, 5000).expect("a REQUEST");
        let r = frame::Request::decode(&q).unwrap();
        assert_eq!((r.serial, r.mime), (20, "image/png"));
        let mut out = p.stdout.take().unwrap();
        let reader = std::thread::spawn(move || {
            let mut b = Vec::new();
            out.read_to_end(&mut b).unwrap();
            b
        });
        answer(&mut page, r.id, &host);
        let b = reader.join().unwrap();
        assert!(p.wait().unwrap().success());
        assert!(
            b == host,
            "the pasted PNG: {} bytes of {}",
            b.len(),
            host.len()
        );
    }
    // Text and an image: both offered (the text inline, from the cache; the image requested).
    let mut o = Vec::new();
    frame::Offer {
        serial: 21,
        types: vec![(TEXT, 5), ("image/png", 3)],
        inline: Some(b"alt t"),
    }
    .encode(&mut o);
    page.send(frame::OFFER, &o);
    assert_eq!(
        page.next(frame::ACK, 3000).as_deref(),
        Some(&frame::ack(21, ack::HELD)[..])
    );
    let listed = types();
    assert!(
        listed.lines().any(|l| l == "image/png") && listed.lines().any(|l| l == TEXT),
        "{listed}"
    );
    assert_eq!(sway.paste().as_deref(), Some(&b"alt t"[..]));
    assert!(
        page.next(frame::REQUEST, 300).is_none(),
        "the text inline: no request"
    );
    let p = paste("image/png");
    let q = page.next(frame::REQUEST, 5000).expect("a REQUEST");
    let r = frame::Request::decode(&q).unwrap();
    assert_eq!(r.mime, "image/png");
    answer(&mut page, r.id, b"png");
    assert_eq!(p.wait_with_output().unwrap().stdout, b"png");
    // The image whole changed nothing of the text's cache, and isn't kept: pasted again, it is requested again.
    assert_eq!(sway.paste().as_deref(), Some(&b"alt t"[..]));
    let p = paste("image/png");
    let q = page
        .next(frame::REQUEST, 5000)
        .expect("a REQUEST for the second paste");
    let r = frame::Request::decode(&q).unwrap();
    answer(&mut page, r.id, b"png");
    assert_eq!(p.wait_with_output().unwrap().stdout, b"png");

    // The cap, against the offer's size before any bytes cross: an image past it alone is refused; with text, the
    // text alone is held.
    let mut o = Vec::new();
    frame::Offer {
        serial: 22,
        types: vec![("image/png", (crate::clip::IMAGE_CAP + 1) as u32)],
        inline: None,
    }
    .encode(&mut o);
    page.send(frame::OFFER, &o);
    assert_eq!(
        page.next(frame::ACK, 3000).as_deref(),
        Some(&frame::ack(22, ack::TOO_LARGE)[..])
    );
    assert!(
        types().lines().any(|l| l == "image/png"),
        "the earlier offer still held"
    );
    let mut o = Vec::new();
    frame::Offer {
        serial: 23,
        types: vec![
            (TEXT, 4),
            ("image/png", (crate::clip::IMAGE_CAP + 1) as u32),
        ],
        inline: Some(b"only"),
    }
    .encode(&mut o);
    page.send(frame::OFFER, &o);
    assert_eq!(
        page.next(frame::ACK, 3000).as_deref(),
        Some(&frame::ack(23, ack::HELD)[..])
    );
    assert!(
        !types().lines().any(|l| l == "image/png"),
        "the image past the cap offered"
    );
    assert_eq!(sway.paste().as_deref(), Some(&b"only"[..]));
    // Neither text nor PNG: no type.
    let mut o = Vec::new();
    frame::Offer {
        serial: 24,
        types: vec![("image/jpeg", 3)],
        inline: None,
    }
    .encode(&mut o);
    page.send(frame::OFFER, &o);
    assert_eq!(
        page.next(frame::ACK, 3000).as_deref(),
        Some(&frame::ack(24, ack::NO_TYPE)[..])
    );

    // HTML (plan §3.2): a guest program's (wl-copy offers its text names too) after the text, requested by its type;
    // the page's beside its text, requested by a paste.
    copy(crate::clip::HTML, b"<b>bold</b>");
    let (serial, offered, inline) = offer(&mut page);
    assert_eq!(
        offered,
        vec![
            (TEXT.to_owned(), 11),
            (crate::clip::HTML.to_owned(), frame::UNKNOWN)
        ]
    );
    assert_eq!(inline.as_deref(), Some(&b"<b>bold</b>"[..]));
    assert_eq!(
        fetch(&mut page, serial, 5, crate::clip::HTML).as_deref(),
        Some(&b"<b>bold</b>"[..])
    );
    let mut o = Vec::new();
    frame::Offer {
        serial: 25,
        types: vec![(TEXT, 4), (crate::clip::HTML, 11)],
        inline: Some(b"bold"),
    }
    .encode(&mut o);
    page.send(frame::OFFER, &o);
    assert_eq!(
        page.next(frame::ACK, 3000).as_deref(),
        Some(&frame::ack(25, ack::HELD)[..])
    );
    assert!(
        types().lines().any(|l| l == crate::clip::HTML),
        "{}",
        types()
    );
    let p = paste(crate::clip::HTML);
    let q = page
        .next(frame::REQUEST, 5000)
        .expect("a REQUEST for the HTML");
    let r = frame::Request::decode(&q).unwrap();
    assert_eq!((r.serial, r.mime), (25, crate::clip::HTML));
    answer(&mut page, r.id, b"<i>bold</i>");
    assert_eq!(p.wait_with_output().unwrap().stdout, b"<i>bold</i>");
    assert_eq!(sway.paste().as_deref(), Some(&b"bold"[..]));

    drop(page);
    assert_eq!(child.join().unwrap(), Ok("session: the parent is gone"));
}
