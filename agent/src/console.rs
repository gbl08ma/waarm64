//! TYPE: text pasted on the guest's foreground virtual terminal (docs/plans/clipboard.md §3.2 "For a text console"),
//! through TIOCSTI, which puts a byte in a terminal's input as if typed. Root keeps it where
//! `dev.tty.legacy_tiocsti=0`: the check passes with CAP_SYS_ADMIN, which the unit leaves the agent.

use crate::frame::typed;
use crate::log;
use crate::prelude::*;
use crate::rt::Instant;
use core::time::Duration;
use rustix::fd::{AsRawFd, OwnedFd, RawFd};
use rustix::fs::{Mode, OFlags, open};
use rustix::io::{self, ioctl_fionread};
use rustix::ioctl::{Getter, Opcode, Setter, ioctl};

/// The foreground virtual terminal, whichever it is when the text arrives.
const FOREGROUND: &str = "/dev/tty0";
/// TIOCSTI (asm-generic/ioctls.h): `const char *`.
const TIOCSTI: Opcode = 0x5412;
/// KDGETMODE (linux/kd.h): `int *`, KD_TEXT or KD_GRAPHICS.
const KDGETMODE: Opcode = 0x4B3B;
const KD_TEXT: i32 = 0;
/// The line discipline's input buffer (N_TTY_BUF_SIZE): what doesn't fit is dropped, so the agent waits while the
/// terminal's reader holds more than `HIGH` unread bytes, checking every `CHECK` bytes. In canonical mode the unread
/// bytes `FIONREAD` counts are the whole lines only (n_tty's `inq_canon`): the line being typed counts too.
const HIGH: u64 = 4096 - 2 * CHECK as u64;
const CHECK: usize = 256;
/// How long a reader that takes nothing may stall a paste before the rest of it is dropped.
const STALL: Duration = Duration::from_secs(1);
/// The most bytes typed at one `step`, so that the agent's loop goes on serving the rest between steps.
const BURST: usize = 4096;
/// The most bytes queued: TYPE frames past it are dropped, with the rest of their paste. The typed bytes before
/// `at` are let go once they pass half of it.
const QUEUE: usize = 1 << 20;
/// How often a paste in progress is stepped while its reader catches up.
pub const TICK: rustix::event::Timespec = rustix::event::Timespec {
    tv_sec: 0,
    tv_nsec: 1_000_000,
};

/// A terminal TYPE's bytes go to (`Vt`; the tests' own).
pub trait Console: Send {
    /// Opens the foreground terminal for a paste.
    fn open(&mut self) -> io::Result<()>;
    /// Closes it (the paste ended).
    fn close(&mut self);
    /// Whether it shows text (not a compositor's graphics, whose shell reads the bytes later).
    fn text(&self) -> io::Result<bool>;
    /// The bytes its reader hasn't taken.
    fn unread(&self) -> u64;
    /// Whether its reader reads lines (`ICANON`): then `unread` counts whole lines only.
    fn canonical(&self) -> bool {
        false
    }
    /// One byte in its input.
    fn put(&self, b: u8) -> io::Result<()>;
    /// Its descriptor while open: a session child forked meanwhile closes it (the console's input is root's).
    fn fd(&self) -> Option<RawFd> {
        None
    }
}

/// The guest's foreground virtual terminal.
#[derive(Default)]
pub struct Vt(Option<OwnedFd>);

impl Console for Vt {
    fn open(&mut self) -> io::Result<()> {
        self.0 = Some(open(
            FOREGROUND,
            OFlags::RDWR | OFlags::NOCTTY | OFlags::CLOEXEC,
            Mode::empty(),
        )?);
        Ok(())
    }

    fn close(&mut self) {
        self.0 = None;
    }

    fn text(&self) -> io::Result<bool> {
        let tty = self.0.as_ref().ok_or(io::Errno::BADF)?;
        // SAFETY: KDGETMODE writes an int, which `Getter` gives room for.
        Ok(unsafe { ioctl(tty, Getter::<KDGETMODE, i32>::new())? } == KD_TEXT)
    }

    fn unread(&self) -> u64 {
        self.0
            .as_ref()
            .map_or(0, |t| ioctl_fionread(t).unwrap_or(0))
    }

    fn canonical(&self) -> bool {
        self.0.as_ref().is_some_and(|t| {
            rustix::termios::tcgetattr(t)
                .is_ok_and(|a| a.local_modes.contains(rustix::termios::LocalModes::ICANON))
        })
    }

    fn put(&self, b: u8) -> io::Result<()> {
        let tty = self.0.as_ref().ok_or(io::Errno::BADF)?;
        // SAFETY: TIOCSTI takes a pointer to one byte, which `Setter` passes (to `b`, alive across the call).
        unsafe { ioctl(tty, Setter::<TIOCSTI, u8>::new(b)) }
    }

    fn fd(&self) -> Option<RawFd> {
        self.0.as_ref().map(|f| f.as_raw_fd())
    }
}

/// Line ends as a terminal's Enter key sends them (CR, which the terminal maps to NL where it wants one), as terminal
/// emulators paste: CRLF and LF become CR. `cr` carries a CR at the end of one TYPE frame over to the next.
pub fn for_tty(text: &[u8], cr: &mut bool, out: &mut Vec<u8>) {
    for &b in text {
        if b == b'\n' {
            if !*cr {
                out.push(b'\r');
            }
        } else {
            out.push(b);
        }
        *cr = b == b'\r';
    }
}

/// TYPE's text on its way to the foreground terminal: queued as frames come, typed by `step` in bursts, paced by the
/// terminal's unread input (`HIGH`, checked every `CHECK` bytes), so a long paste into a reader that keeps up arrives
/// whole and the agent's loop, which steps it every `TICK` meanwhile, never waits for it. A reader that takes nothing
/// for `STALL` loses the rest; a console that shows graphics (a compositor runs on it: the shell behind it would run
/// the lines once the compositor ends) gets none of it. A paste is the TYPE frames up to an empty one (the page's
/// end of a paste): once one of its frames is dropped (`QUEUE`), its later ones are too, so what is typed is a prefix,
/// and the queue's end says `DROPPED`, not `DONE`.
pub struct Typist {
    con: Box<dyn Console>,
    queue: Vec<u8>,
    at: usize,
    /// The paste lost a frame: its later frames are dropped until its end (an empty TYPE).
    refusing: bool,
    /// The queue lost text: its end says `DROPPED`.
    lost: bool,
    /// The bytes typed since the last line end (a canonical reader's line not counted by `unread`).
    line: u64,
    /// The last frame ended in CR (`for_tty`).
    cr: bool,
    open: bool,
    /// The reader's unread bytes when it last took some, and when.
    last: u64,
    since: Instant,
}

impl Typist {
    pub fn new(con: Box<dyn Console>) -> Typist {
        Typist {
            con,
            queue: Vec::new(),
            at: 0,
            refusing: false,
            lost: false,
            line: 0,
            cr: false,
            open: false,
            last: u64::MAX,
            since: Instant::now(),
        }
    }

    /// Queues a TYPE frame's text (UTF-8; empty: its paste ends); a status (`typed`) if it was dropped.
    pub fn push(&mut self, text: &[u8]) -> Option<u8> {
        if text.is_empty() {
            self.refusing = false;
            return None;
        }
        if self.refusing {
            return None;
        }
        if core::str::from_utf8(text).is_err() {
            log("TYPE: not UTF-8, dropped", None);
            return Some(typed::REFUSED);
        }
        if self.queue.len() - self.at + text.len() > QUEUE {
            log("TYPE: too much queued; the rest of the paste dropped", None);
            self.refusing = true;
            self.lost = self.busy();
            return Some(typed::DROPPED);
        }
        for_tty(text, &mut self.cr, &mut self.queue);
        None
    }

    /// Whether there is text to type.
    pub fn busy(&self) -> bool {
        self.at < self.queue.len()
    }

    /// Types what the terminal's reader has room for now (`BURST` at most); a status (`typed`) once the queue has
    /// ended: typed whole, or dropped and why.
    pub fn step(&mut self) -> Option<u8> {
        if !self.busy() {
            return None;
        }
        // What was typed goes once it passes half the queue (so a long paste holds about the queue, not itself).
        if self.at >= QUEUE / 2 {
            self.queue.drain(..self.at);
            self.at = 0;
        }
        if !self.open {
            if let Err(e) = self.con.open() {
                log("TYPE: can't open the console", Some(e));
                return Some(self.end(typed::REFUSED));
            }
            self.open = true;
            self.last = u64::MAX;
            self.since = Instant::now();
        }
        match self.con.text() {
            Ok(true) => {}
            Ok(false) => {
                log(
                    "TYPE: the console shows graphics (a compositor's), not text: dropped",
                    None,
                );
                return Some(self.end(typed::NOT_TEXT));
            }
            Err(e) => {
                log("TYPE: the console's mode", Some(e));
                return Some(self.end(typed::REFUSED));
            }
        }
        let mut budget = BURST;
        let canonical = self.con.canonical();
        while self.busy() && budget > 0 {
            let unread = self.con.unread() + if canonical { self.line } else { 0 };
            if unread > HIGH {
                if unread < self.last {
                    self.last = unread;
                    self.since = Instant::now();
                } else if self.since.elapsed() > STALL {
                    log(
                        "TYPE: the console's reader stalled; the rest was dropped",
                        None,
                    );
                    return Some(self.end(typed::DROPPED));
                }
                return None;
            }
            self.last = u64::MAX;
            self.since = Instant::now();
            let n = CHECK.min(self.queue.len() - self.at).min(budget);
            for i in self.at..self.at + n {
                let b = self.queue[i];
                if let Err(e) = self.con.put(b) {
                    log("TYPE: the console refused it", Some(e));
                    return Some(self.end(typed::REFUSED));
                }
                self.line = if b == b'\r' || b == b'\n' {
                    0
                } else {
                    self.line + 1
                };
            }
            self.at += n;
            budget -= n;
        }
        (!self.busy()).then(|| self.end(typed::DONE))
    }

    /// The paste ends (`status` returned): the queue emptied, the console closed.
    fn end(&mut self, status: u8) -> u8 {
        let status = if status == typed::DONE && self.lost {
            typed::DROPPED
        } else {
            status
        };
        self.lost = false;
        self.line = 0;
        self.queue.clear();
        if self.queue.capacity() > 65536 {
            self.queue = Vec::new();
        }
        self.at = 0;
        if self.open {
            self.con.close();
            self.open = false;
        }
        status
    }

    /// The console's descriptor while a paste has it open.
    pub fn fd(&self) -> Option<RawFd> {
        self.con.fd()
    }

    /// Drops what is queued, without a word (PAUSE, a new opening of the port: a new stream).
    pub fn reset(&mut self) {
        self.end(typed::DONE);
        self.cr = false;
        self.refusing = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn tty(parts: &[&str]) -> String {
        let (mut cr, mut out) = (false, Vec::new());
        for p in parts {
            for_tty(p.as_bytes(), &mut cr, &mut out);
        }
        String::from_utf8(out).unwrap()
    }

    #[test]
    fn line_ends_become_enter() {
        assert_eq!(tty(&["a\nb\r\nc\rd"]), "a\rb\rc\rd");
        assert_eq!(tty(&["a\r", "\nb"]), "a\rb", "a CRLF across two frames");
        assert_eq!(tty(&["\n\n"]), "\r\r");
        assert_eq!(tty(&["héllo ☃"]), "héllo ☃");
    }

    /// A terminal as n_tty is to the Typist: `unread` what `FIONREAD` says (in canonical mode the whole lines only),
    /// the bytes past its buffer (4095, a canonical line's too) lost; the test plays its reader.
    #[derive(Default)]
    struct Tty {
        got: Vec<u8>,
        unread: u64,
        canonical: bool,
        /// A canonical reader's line not ended yet.
        partial: u64,
        lost: usize,
    }

    struct Fake(Arc<Mutex<Tty>>);

    impl Console for Fake {
        fn open(&mut self) -> io::Result<()> {
            Ok(())
        }
        fn close(&mut self) {}
        fn text(&self) -> io::Result<bool> {
            Ok(true)
        }
        fn unread(&self) -> u64 {
            self.0.lock().unwrap().unread
        }
        fn canonical(&self) -> bool {
            self.0.lock().unwrap().canonical
        }
        fn put(&self, b: u8) -> io::Result<()> {
            let mut t = self.0.lock().unwrap();
            let full = if t.canonical {
                b != b'\r' && t.partial >= 4095
            } else {
                t.unread >= 4095
            };
            if full {
                t.lost += 1;
            } else if t.canonical && b == b'\r' {
                t.unread += t.partial + 1;
                t.partial = 0;
                t.got.push(b);
            } else {
                if t.canonical {
                    t.partial += 1;
                } else {
                    t.unread += 1;
                }
                t.got.push(b);
            }
            Ok(())
        }
    }

    fn typist() -> (Typist, Arc<Mutex<Tty>>) {
        let tty = Arc::new(Mutex::new(Tty::default()));
        (Typist::new(Box::new(Fake(tty.clone()))), tty)
    }

    /// One step after the reader took `take` bytes of its unread input.
    fn step(t: &mut Typist, tty: &Mutex<Tty>, take: u64, statuses: &mut Vec<u8>) {
        {
            let mut tty = tty.lock().unwrap();
            tty.unread = tty.unread.saturating_sub(take);
        }
        statuses.extend(t.step());
    }

    #[test]
    fn a_paste_past_the_queue_is_typed_as_a_prefix_and_ends_dropped() {
        let (mut t, tty) = typist();
        // 18 frames of 64 KiB, each its own letter: a hole shows as a letter's run missing.
        let input: Vec<u8> = (0..18 * 65536).map(|i| b'a' + (i / 65536) as u8).collect();
        let frames: Vec<&[u8]> = input.chunks(65536).collect();
        let mut statuses = Vec::new();
        for f in &frames[..17] {
            statuses.extend(t.push(f));
        }
        assert_eq!(statuses, [typed::DROPPED], "the 17th frame past the queue");
        // A reader that takes 4 KiB between steps; once a frame's worth is typed, the 18th comes (room for it now).
        while tty.lock().unwrap().got.len() < 65536 {
            step(&mut t, &tty, 4096, &mut statuses);
        }
        statuses.extend(t.push(frames[17]));
        statuses.extend(t.push(&[]));
        while t.busy() {
            step(&mut t, &tty, 4096, &mut statuses);
        }
        let got = tty.lock().unwrap().got.clone();
        assert!(
            input.starts_with(&got),
            "typed with a hole: {} bytes, ending in {:?}",
            got.len(),
            got.last().map(|&b| b as char)
        );
        assert_eq!(got.len(), 16 * 65536, "the frames before the drop, whole");
        assert_eq!(
            statuses.last(),
            Some(&typed::DROPPED),
            "the paste's end said {statuses:?}"
        );
        // The next paste (after the empty frame) is typed again.
        statuses.clear();
        t.push(b"next");
        t.push(&[]);
        while t.busy() {
            step(&mut t, &tty, 4096, &mut statuses);
        }
        assert_eq!(statuses, [typed::DONE]);
        assert!(tty.lock().unwrap().got.ends_with(b"next"));
    }

    #[test]
    fn a_long_paste_holds_about_the_queue_not_the_whole_paste() {
        let (mut t, tty) = typist();
        let mut statuses = Vec::new();
        // 8 MiB into a reader that keeps up: a frame comes as the one before is typed.
        for k in 0..128u8 {
            statuses.extend(t.push(&[b'0' + k % 64; 65536]));
            for _ in 0..16 {
                step(&mut t, &tty, u64::MAX, &mut statuses);
            }
            assert!(
                t.queue.capacity() <= 2 * QUEUE,
                "{} bytes held after {} MiB",
                t.queue.capacity(),
                (k as usize + 1) / 16
            );
        }
        while t.busy() {
            step(&mut t, &tty, u64::MAX, &mut statuses);
        }
        assert_eq!(statuses, [typed::DONE]);
        assert_eq!(tty.lock().unwrap().got.len(), 128 * 65536);
    }

    #[test]
    fn a_canonical_readers_line_counts_until_it_ends() {
        let (mut t, tty) = typist();
        tty.lock().unwrap().canonical = true;
        let mut statuses = Vec::new();
        // Short lines: the reader takes each line as it ends; all typed.
        let lines: Vec<u8> = (0..200)
            .flat_map(|i| format!("{i:0>79}\n").into_bytes())
            .collect();
        t.push(&lines);
        t.push(&[]);
        while t.busy() {
            step(&mut t, &tty, u64::MAX, &mut statuses);
        }
        assert_eq!(statuses, [typed::DONE]);
        assert_eq!(tty.lock().unwrap().got.len(), lines.len());
        // One line of 6 KiB: past the buffer before it ends, which the reader can't take. Not typed past it: the rest
        // dropped, and said so.
        let mut long = vec![b'x'; 6144];
        long.push(b'\n');
        t.push(&long);
        t.push(&[]);
        let end = Instant::now() + Duration::from_secs(5);
        statuses.clear();
        while t.busy() && Instant::now() < end {
            step(&mut t, &tty, u64::MAX, &mut statuses);
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(tty.lock().unwrap().lost, 0, "typed past n_tty's line");
        assert_eq!(statuses, [typed::DROPPED]);
    }
}
