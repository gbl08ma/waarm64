//! CONSOLE (docs/devices.md "The serial console's size"): the page fits its serial terminal to its box and says the
//! columns and rows; the agent sets the serial console's window size to them (TIOCSWINSZ on the PL011's tty), which the
//! kernel follows with a SIGWINCH to the tty's foreground process group (a shell, vi, less redraw for it). The PL011 has
//! no size of its own to negotiate, so without this a guest assumes 80×24. The agent keeps the tty open after: a tty's
//! size lives while it is open, so a login that ends and is started again (busybox init's respawn) finds it still set.
//! Opened afresh at each CONSOLE (a getty's vhangup leaves an older file hung up), without becoming its controlling tty.

use crate::prelude::*;
use rustix::fd::OwnedFd;
use rustix::fs::{Mode, OFlags};
use rustix::io::Errno;
use rustix::termios::{Winsize, isatty, tcsetwinsize};

/// The serial console the page shows: the PL011's tty.
pub const SERIAL: &str = "/dev/ttyAMA0";

/// The serial console's tty (`path`) and the file the agent keeps open on it.
pub struct Console {
    path: String,
    held: Option<OwnedFd>,
}

impl Console {
    pub fn new(path: &str) -> Console {
        Console {
            path: path.into(),
            held: None,
        }
    }

    /// The tty's window size set to `cols` × `rows`; the file kept open.
    pub fn set(&mut self, cols: u16, rows: u16) -> Result<(), Errno> {
        let fd = rustix::fs::open(
            self.path.as_str(),
            OFlags::RDWR | OFlags::NOCTTY | OFlags::NONBLOCK | OFlags::CLOEXEC,
            Mode::empty(),
        )?;
        if !isatty(&fd) {
            return Err(Errno::NOTTY);
        }
        tcsetwinsize(
            &fd,
            Winsize {
                ws_row: rows,
                ws_col: cols,
                ws_xpixel: 0,
                ws_ypixel: 0,
            },
        )?;
        self.held = Some(fd);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rustix::fd::FromRawFd;

    unsafe extern "C" {
        fn posix_openpt(flags: i32) -> i32;
        fn grantpt(fd: i32) -> i32;
        fn unlockpt(fd: i32) -> i32;
        fn ptsname(fd: i32) -> *const core::ffi::c_char;
    }

    /// A pseudo-terminal's two ends: the master, and the path of the tty (the PL011's stand-in).
    fn pty() -> (OwnedFd, String) {
        // SAFETY: the C library's pty calls on a descriptor they return; ptsname's string is copied at once.
        unsafe {
            let m = posix_openpt(0o2 | 0o400 | 0o2000000); // O_RDWR | O_NOCTTY | O_CLOEXEC
            assert!(m >= 0, "posix_openpt");
            assert_eq!((grantpt(m), unlockpt(m)), (0, 0));
            let name = core::ffi::CStr::from_ptr(ptsname(m))
                .to_str()
                .unwrap()
                .to_owned();
            (OwnedFd::from_raw_fd(m), name)
        }
    }

    #[test]
    fn the_ttys_size_set_and_kept() {
        let (master, path) = pty();
        let mut c = Console::new(&path);
        c.set(132, 43).unwrap();
        let w = rustix::termios::tcgetwinsize(&master).unwrap();
        assert_eq!((w.ws_col, w.ws_row), (132, 43));
        c.set(80, 25).unwrap();
        let w = rustix::termios::tcgetwinsize(&master).unwrap();
        assert_eq!((w.ws_col, w.ws_row), (80, 25), "again");
        assert!(c.held.is_some(), "the tty kept open");
        assert_eq!(
            Console::new("/nonexistent/tty").set(80, 25),
            Err(Errno::NOENT)
        );
        assert_eq!(Console::new("/dev/null").set(80, 25), Err(Errno::NOTTY));
    }
}
