//! webpc-agent: the guest's end of clipboard sharing (docs/plans/clipboard.md §3; docs/devices.md "The guest's
//! agent"). The page delivers it over fw_cfg and a credential unit starts it as root (web/app/guest-agent.ts). One
//! process, one thread, blocked in `ppoll` on the agent's port with no timeout: an idle guest sees no CPU time from it
//! (plan §3.3). It answers the page's HELLO, pastes TYPE's text on the foreground text console (src/console.rs) and
//! holds PAUSE until RESUME. The session children of the next steps (a graphical session's clipboard, under its uid)
//! join the same `ppoll` with their socketpairs; inotify on logind's state files picks the session.
//!
//!   webpc-agent [port]    the port's device (default /dev/virtio-ports/org.webpc.agent.0)

mod console;
mod frame;

use rustix::event::{PollFd, PollFlags, poll};
use rustix::fd::OwnedFd;
use rustix::fs::{Mode, OFlags, open};
use rustix::io::{Errno, read, write};
use std::io::Write as _;

const PORT: &str = "/dev/virtio-ports/org.webpc.agent.0";

/// What the agent says it can do (frame.rs `cap`).
const CAPS: u32 = frame::cap::TYPE;

/// Why serving the port stopped.
enum Stop {
    /// The stream from the page went out of step: reopen the port (both ends start afresh).
    Broken,
    /// The host's end is gone, or the port failed.
    Failed(&'static str, Errno),
}

fn main() {
    let path = std::env::args().nth(1).unwrap_or_else(|| PORT.into());
    loop {
        let port = match open(
            path.as_str(),
            OFlags::RDWR | OFlags::NOCTTY | OFlags::CLOEXEC,
            Mode::empty(),
        ) {
            Ok(p) => p,
            Err(e) => fail("can't open the port", e),
        };
        match serve(&port) {
            Stop::Broken => log(
                "the page's stream went out of step: reopening the port",
                None,
            ),
            Stop::Failed(what, e) => fail(what, e),
        }
    }
}

/// The agent's state while it holds the port open.
struct Session<'a> {
    port: &'a OwnedFd,
    paused: bool,
    /// A TYPE frame ended in CR (console.rs `for_tty`).
    cr: bool,
    /// Frames to send, and TYPE's bytes for the terminal.
    out: Vec<u8>,
    tty: Vec<u8>,
    /// The terminal refused TYPE once (logged once).
    tty_failed: bool,
}

fn serve(port: &OwnedFd) -> Stop {
    let mut s = Session {
        port,
        paused: false,
        cr: false,
        out: Vec::new(),
        tty: Vec::new(),
        tty_failed: false,
    };
    let mut reader = frame::Reader::default();
    // virtio_console hands a read one of the guest's receive buffers (a page) at most.
    let mut buf = [0u8; 4096];
    loop {
        let mut fds = [PollFd::new(port, PollFlags::IN)];
        match poll(&mut fds, None) {
            Ok(_) | Err(Errno::INTR) => {}
            Err(e) => return Stop::Failed("poll", e),
        }
        let n = match read(port, &mut buf) {
            // virtio_console: no data and the host's end closed (the page's device keeps it open).
            Ok(0) => return Stop::Failed("the host closed the port", Errno::PIPE),
            Ok(n) => n,
            Err(Errno::INTR) | Err(Errno::AGAIN) => continue,
            Err(e) => return Stop::Failed("read", e),
        };
        reader.push(&buf[..n], |kind, payload| s.frame(kind, payload));
        if reader.broken() {
            return Stop::Broken;
        }
        if let Err(e) = s.flush() {
            return Stop::Failed("write", e);
        }
    }
}

impl Session<'_> {
    fn frame(&mut self, kind: u8, payload: &[u8]) {
        match kind {
            // The page's HELLO (it sends one each time it sees the port open): the agent's answers it.
            frame::HELLO => {
                if frame::Hello::decode(payload).is_some() {
                    frame::encode(
                        frame::HELLO,
                        &frame::Hello {
                            version: frame::VERSION,
                            caps: CAPS,
                        }
                        .encode(),
                        &mut self.out,
                    );
                }
            }
            frame::TYPE if !self.paused => self.type_text(payload),
            frame::PAUSE => self.paused = true,
            frame::RESUME => self.paused = false,
            // TYPE while paused, and what a later version sends: ignored.
            _ => {}
        }
    }

    fn type_text(&mut self, text: &[u8]) {
        if core::str::from_utf8(text).is_err() {
            log("TYPE: not UTF-8, dropped", None);
            return;
        }
        self.tty.clear();
        console::for_tty(text, &mut self.cr, &mut self.tty);
        match console::type_bytes(&self.tty) {
            Ok(n) if n < self.tty.len() => log(
                "TYPE: the console's reader stalled; the rest was dropped",
                None,
            ),
            Ok(_) => {}
            Err(e) if !self.tty_failed => {
                self.tty_failed = true;
                log("TYPE: the console refused it", Some(e));
            }
            Err(_) => {}
        }
        if self.tty.capacity() > 65536 {
            self.tty = Vec::new();
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
        Ok(())
    }
}

/// A line on stderr (the journal's): `webpc-agent: <what>[ (errno N)]`.
fn log(what: &str, e: Option<Errno>) {
    let mut line = Vec::with_capacity(96);
    line.extend_from_slice(b"webpc-agent: ");
    line.extend_from_slice(what.as_bytes());
    if let Some(e) = e {
        line.extend_from_slice(b" (errno ");
        let mut n = e.raw_os_error().unsigned_abs();
        let mut digits = [0u8; 10];
        let mut k = digits.len();
        loop {
            k -= 1;
            digits[k] = b'0' + (n % 10) as u8;
            n /= 10;
            if n == 0 {
                break;
            }
        }
        line.extend_from_slice(&digits[k..]);
        line.push(b')');
    }
    line.push(b'\n');
    let _ = std::io::stderr().write_all(&line);
}

fn fail(what: &str, e: Errno) -> ! {
    log(what, Some(e));
    std::process::exit(1);
}
