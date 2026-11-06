//! TYPE: text pasted on the guest's foreground virtual terminal (docs/plans/clipboard.md §3.2 "For a text console"),
//! through TIOCSTI, which puts a byte in a terminal's input as if typed. Root keeps it where
//! `dev.tty.legacy_tiocsti=0`: the check passes with CAP_SYS_ADMIN, which the unit leaves the agent.

use crate::frame::typed;
use crate::log;
use rustix::fd::{AsRawFd, OwnedFd, RawFd};
use rustix::fs::{Mode, OFlags, open};
use rustix::io::{self, ioctl_fionread};
use rustix::ioctl::{Getter, Opcode, Setter, ioctl};
use std::time::{Duration, Instant};

/// The foreground virtual terminal, whichever it is when the text arrives.
const FOREGROUND: &str = "/dev/tty0";
/// TIOCSTI (asm-generic/ioctls.h): `const char *`.
const TIOCSTI: Opcode = 0x5412;
/// KDGETMODE (linux/kd.h): `int *`, KD_TEXT or KD_GRAPHICS.
const KDGETMODE: Opcode = 0x4B3B;
const KD_TEXT: i32 = 0;
/// The line discipline's input buffer (N_TTY_BUF_SIZE): what doesn't fit is dropped, so the agent waits while the
/// terminal's reader holds more than `HIGH` unread bytes, checking every `CHECK` bytes.
const HIGH: u64 = 4096 - 2 * CHECK as u64;
const CHECK: usize = 256;
/// How long a reader that takes nothing may stall a paste before the rest of it is dropped.
const STALL: Duration = Duration::from_secs(1);
/// The most bytes typed at one `step`, so that the agent's loop goes on serving the rest between steps.
const BURST: usize = 4096;
/// The most bytes queued: TYPE frames past it are dropped.
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
/// the lines once the compositor ends) gets none of it.
pub struct Typist {
    con: Box<dyn Console>,
    queue: Vec<u8>,
    at: usize,
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
            cr: false,
            open: false,
            last: u64::MAX,
            since: Instant::now(),
        }
    }

    /// Queues a TYPE frame's text (UTF-8); a status (`typed`) if it was dropped.
    pub fn push(&mut self, text: &[u8]) -> Option<u8> {
        if core::str::from_utf8(text).is_err() {
            log("TYPE: not UTF-8, dropped", None);
            return Some(typed::REFUSED);
        }
        if self.queue.len() - self.at + text.len() > QUEUE {
            log("TYPE: too much queued; dropped", None);
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
        while self.busy() && budget > 0 {
            let unread = self.con.unread();
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
                if let Err(e) = self.con.put(self.queue[i]) {
                    log("TYPE: the console refused it", Some(e));
                    return Some(self.end(typed::REFUSED));
                }
            }
            self.at += n;
            budget -= n;
        }
        (!self.busy()).then(|| self.end(typed::DONE))
    }

    /// The paste ends (`status` returned): the queue emptied, the console closed.
    fn end(&mut self, status: u8) -> u8 {
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
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
