//! TYPE: text pasted on the guest's foreground virtual terminal (docs/plans/clipboard.md §3.2 "For a text console"),
//! through TIOCSTI, which puts a byte in a terminal's input as if typed. Root keeps it where
//! `dev.tty.legacy_tiocsti=0`: the check passes with CAP_SYS_ADMIN, which the unit leaves the agent.

use rustix::fd::OwnedFd;
use rustix::fs::{Mode, OFlags, open};
use rustix::io::{self, ioctl_fionread};
use rustix::ioctl::{Opcode, Setter, ioctl};
use std::time::{Duration, Instant};

/// The foreground virtual terminal, whichever it is when the text arrives.
const FOREGROUND: &str = "/dev/tty0";
/// TIOCSTI (asm-generic/ioctls.h): `const char *`.
const TIOCSTI: Opcode = 0x5412;
/// The line discipline's input buffer (N_TTY_BUF_SIZE): what doesn't fit is dropped, so the agent waits while the
/// terminal's reader holds more than `HIGH` unread bytes, checking every `CHECK` bytes.
const HIGH: u64 = 4096 - 2 * CHECK as u64;
const CHECK: usize = 256;
/// How long a reader that takes nothing may stall a paste before the rest of it is dropped.
const STALL: Duration = Duration::from_secs(1);

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

/// Puts `bytes` in the foreground terminal's input; the bytes it took. Paced by the terminal's unread input (see
/// `HIGH`), so a long paste into a reader that keeps up arrives whole; a reader that stalls for `STALL` loses the rest.
pub fn type_bytes(bytes: &[u8]) -> io::Result<usize> {
    let tty: OwnedFd = open(
        FOREGROUND,
        OFlags::RDWR | OFlags::NOCTTY | OFlags::CLOEXEC,
        Mode::empty(),
    )?;
    for (i, &b) in bytes.iter().enumerate() {
        if i % CHECK == 0 && !room(&tty) {
            return Ok(i);
        }
        // SAFETY: TIOCSTI takes a pointer to one byte, which `Setter` passes (to `b`, alive across the call).
        unsafe { ioctl(&tty, Setter::<TIOCSTI, u8>::new(b))? };
    }
    Ok(bytes.len())
}

/// Waits (sleeping a millisecond at a time: only while a paste is in progress) until the terminal's reader has taken
/// enough for `2 * CHECK` more bytes; false if it took nothing for `STALL`.
fn room(tty: &OwnedFd) -> bool {
    let mut last = u64::MAX;
    let mut since = Instant::now();
    loop {
        let unread = ioctl_fionread(tty).unwrap_or(0);
        if unread <= HIGH {
            return true;
        }
        if unread < last {
            last = unread;
            since = Instant::now();
        } else if since.elapsed() > STALL {
            return false;
        }
        std::thread::sleep(Duration::from_millis(1));
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
