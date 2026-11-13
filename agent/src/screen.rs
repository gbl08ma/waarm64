//! COPY: the foreground virtual terminal's screen as text, for the host's clipboard (docs/clipboard.md "A text
//! console's text"). `/dev/tty0` (the foreground console) says its mode and size (vcsa's header has them in a byte each,
//! too small past 255 columns); the kernel's copy of the screen gives each cell's character: `/dev/vcsu` (a u32 code
//! point a cell; the minor-0 nodes are the foreground console's), or `/dev/vcs` (a byte a cell) where the console isn't
//! in UTF-8 mode (vcsu says ENODATA). Root reads them (they are root's, 0620) with none of the unit's capabilities. A
//! console that shows graphics (a compositor's) has no text.

use crate::frame;
use crate::prelude::*;
use rustix::fd::OwnedFd;
use rustix::fs::{Mode, OFlags, open};
use rustix::io::{Errno, read};
use rustix::ioctl::{Getter, Opcode, ioctl};

/// COPIED's statuses (web/agent-frame.ts `COPIED`); OK's text follows the status.
pub mod status {
    /// The screen's text follows.
    pub const OK: u8 = 0;
    /// The foreground console shows graphics (a compositor runs on it): no text.
    pub const GRAPHICS: u8 = 1;
    /// No virtual terminal (a kernel without them, or no console's nodes in `/dev`).
    pub const NO_CONSOLE: u8 = 2;
    /// Reading it failed.
    pub const FAILED: u8 = 3;
}

/// KDGETMODE (linux/kd.h): `int *`, KD_TEXT or KD_GRAPHICS.
const KDGETMODE: Opcode = 0x4B3B;
const KD_TEXT: i32 = 0;

/// The most text COPIED carries, in UTF-8 bytes: the rest of a larger screen is left out (a 4K console of ASCII is
/// about 65,000 cells, most of them trailing blanks, which go).
pub const MAX_TEXT: usize = frame::CHUNK;

/// A console's rows and columns.
pub type Size = (usize, usize);

/// Where the screen is read (the tests' own files).
pub struct Paths {
    pub tty: String,
    pub vcsu: String,
    pub vcs: String,
    /// The terminal at a path: its rows and columns if it shows text, none if graphics (KDGETMODE, TIOCGWINSZ; the
    /// tests' own).
    pub console: fn(&str) -> Result<Option<Size>, Errno>,
}

impl Default for Paths {
    fn default() -> Paths {
        Paths {
            tty: "/dev/tty0".into(),
            vcsu: "/dev/vcsu".into(),
            vcs: "/dev/vcs".into(),
            console,
        }
    }
}

/// The foreground terminal's size, if it shows text (not graphics).
fn console(tty: &str) -> Result<Option<Size>, Errno> {
    let fd = open_ro(tty)?;
    // SAFETY: KDGETMODE writes an int, which `Getter` gives room for.
    if unsafe { ioctl(&fd, Getter::<KDGETMODE, i32>::new())? } != KD_TEXT {
        return Ok(None);
    }
    let w = rustix::termios::tcgetwinsize(&fd)?;
    Ok(Some((w.ws_row as usize, w.ws_col as usize)))
}

/// COPIED's payload for the foreground console now: a status, then (OK) its text.
pub fn copied(p: &Paths) -> Vec<u8> {
    let mut out = vec![status::OK];
    match screen(p, &mut out) {
        Ok(()) => out,
        Err(s) => vec![s],
    }
}

fn screen(p: &Paths, out: &mut Vec<u8>) -> Result<(), u8> {
    let missing = |e: Errno| {
        if matches!(e, Errno::NOENT | Errno::NXIO | Errno::NODEV) {
            status::NO_CONSOLE
        } else {
            status::FAILED
        }
    };
    let (rows, cols) = (p.console)(&p.tty)
        .map_err(missing)?
        .ok_or(status::GRAPHICS)?;
    let mut cells = vec![0u8; rows * cols * 4];
    let unicode = match open_ro(&p.vcsu).and_then(|f| read_all(&f, &mut cells)) {
        Ok(n) => {
            cells.truncate(n - n % 4);
            true
        }
        // Not in UTF-8 mode (or a kernel before vcsu, 4.19): a byte a cell, the console's 8-bit characters.
        Err(Errno::NODATA | Errno::NOENT | Errno::NXIO) => {
            cells.truncate(rows * cols);
            let n = read_all(&open_ro(&p.vcs).map_err(missing)?, &mut cells).map_err(missing)?;
            cells.truncate(n);
            false
        }
        Err(e) => return Err(missing(e)),
    };
    let chars: Vec<u32> = if unicode {
        cells
            .as_chunks::<4>()
            .0
            .iter()
            .map(|&c| u32::from_le_bytes(c))
            .collect()
    } else {
        cells.iter().map(|&b| eight_bit(b)).collect()
    };
    text(cols, &chars, out);
    Ok(())
}

fn open_ro(path: &str) -> Result<OwnedFd, Errno> {
    open(
        path,
        OFlags::RDONLY | OFlags::NOCTTY | OFlags::CLOEXEC,
        Mode::empty(),
    )
}

/// Reads until `buf` is full or the file ends: the bytes read.
fn read_all(fd: &OwnedFd, buf: &mut [u8]) -> Result<usize, Errno> {
    let mut at = 0;
    while at < buf.len() {
        match read(fd, &mut buf[at..]) {
            Ok(0) => break,
            Ok(n) => at += n,
            Err(Errno::INTR) => {}
            Err(e) => return Err(e),
        }
    }
    Ok(at)
}

/// A console's 8-bit character as the text's: ASCII as it is, the rest (a font's glyph, whose character the agent
/// doesn't know) U+FFFD.
fn eight_bit(b: u8) -> u32 {
    if b.is_ascii() { b as u32 } else { 0xFFFD }
}

/// The screen's text: its rows of `cols` cells, each without its trailing blanks, joined by line ends, without the
/// blank rows at the end; a cell's NUL (never written) or control character a space, a code point that isn't one
/// U+FFFD. At most `MAX_TEXT` bytes are added to `out`, cut between characters.
pub fn text(cols: usize, cells: &[u32], out: &mut Vec<u8>) {
    if cols == 0 {
        return;
    }
    let start = out.len();
    // Where the text ends without its blank rows: the end of the last row that has a character.
    let mut end = start;
    for (i, row) in cells.chunks(cols).enumerate() {
        let used = row.iter().rposition(|&c| !blank(c)).map_or(0, |i| i + 1);
        if i > 0 {
            push_char('\n', out);
        }
        for &c in &row[..used] {
            push_char(cell(c), out);
        }
        if used > 0 {
            end = out.len();
        }
        if out.len() - start > MAX_TEXT {
            break;
        }
    }
    out.truncate(end);
    if out.len() - start > MAX_TEXT {
        let mut cut = start + MAX_TEXT;
        // Back to a character's first byte (never a continuation byte, 10xxxxxx).
        while out[cut] & 0xC0 == 0x80 {
            cut -= 1;
        }
        out.truncate(cut);
    }
}

fn blank(c: u32) -> bool {
    c == 0 || c == b' ' as u32
}

fn cell(c: u32) -> char {
    match char::from_u32(c) {
        Some(ch) if ch.is_control() => ' ',
        Some(ch) => ch,
        None => '\u{FFFD}',
    }
}

fn push_char(c: char, out: &mut Vec<u8>) {
    out.extend_from_slice(c.encode_utf8(&mut [0; 4]).as_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cells(rows: &[&str], cols: usize) -> Vec<u32> {
        let mut v = Vec::new();
        for r in rows {
            let mut row: Vec<u32> = r.chars().map(|c| c as u32).collect();
            row.resize(cols, b' ' as u32);
            v.extend(row);
        }
        v
    }

    fn of(cols: usize, c: &[u32]) -> String {
        let mut out = Vec::new();
        text(cols, c, &mut out);
        String::from_utf8(out).unwrap()
    }

    #[test]
    fn rows_without_their_trailing_blanks_nor_the_blank_rows_after() {
        let c = cells(&["root@deb", ":~# ls  ", "", "  é ☃ 𝄞", "", ""], 8);
        assert_eq!(of(8, &c), "root@deb\n:~# ls\n\n  é ☃ 𝄞");
        // Blank rows first stay (the text's place on the screen); NUL cells (never written) are blanks.
        let mut c = cells(&["", "x"], 4);
        c[0] = 0;
        assert_eq!(of(4, &c), "\nx");
        assert_eq!(of(4, &cells(&["", ""], 4)), "");
        assert_eq!(of(0, &[]), "");
    }

    #[test]
    fn controls_are_spaces_and_non_characters_replaced() {
        let c = [b'a' as u32, 7, b'b' as u32, 0xD800, 0x11_0000, b'c' as u32];
        assert_eq!(of(6, &c), "a b\u{FFFD}\u{FFFD}c");
        assert_eq!(eight_bit(b'A'), 'A' as u32);
        assert_eq!(eight_bit(0xC4), 0xFFFD);
    }

    #[test]
    fn a_large_screen_is_cut_between_characters() {
        // 200 rows of 200 snowmen (3 bytes each): far past MAX_TEXT.
        let c = vec!['☃' as u32; 200 * 200];
        let t = of(200, &c);
        assert!(t.len() <= MAX_TEXT && t.len() > MAX_TEXT - 4, "{}", t.len());
        assert!(t.ends_with('☃') || t.ends_with('\n'));
    }

    fn graphics(_: &str) -> Result<Option<Size>, Errno> {
        Ok(None)
    }
    fn two_by_three(_: &str) -> Result<Option<Size>, Errno> {
        Ok(Some((2, 3)))
    }
    fn no_tty(_: &str) -> Result<Option<Size>, Errno> {
        Err(Errno::NOENT)
    }

    /// The console's files in a directory of the test's (a console of 2 rows and 3 columns): vcsu's cells (or none),
    /// vcs's bytes.
    fn files(name: &str, vcsu: Option<&[u32]>, vcs: &[u8]) -> Paths {
        let dir =
            std::env::temp_dir().join(format!("waarm64-screen-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        if let Some(u) = vcsu {
            std::fs::write(
                dir.join("vcsu"),
                u.iter().flat_map(|c| c.to_le_bytes()).collect::<Vec<_>>(),
            )
            .unwrap();
        }
        std::fs::write(dir.join("vcs"), vcs).unwrap();
        let at = |f: &str| dir.join(f).to_str().unwrap().to_owned();
        Paths {
            tty: at("tty0"),
            vcsu: at("vcsu"),
            vcs: at("vcs"),
            console: two_by_three,
        }
    }

    #[test]
    fn copied_reads_the_screen_or_says_why_not() {
        let mut p = files("unicode", Some(&cells(&["ab", "☃"], 3)), b"");
        assert_eq!(copied(&p), [&[status::OK][..], "ab\n☃".as_bytes()].concat());
        // Without vcsu (not in UTF-8 mode, or an old kernel): vcs's bytes.
        let mut q = files("bytes", None, b"hi \xC4  ");
        assert_eq!(
            copied(&q),
            [&[status::OK][..], "hi\n\u{FFFD}".as_bytes()].concat()
        );
        p.console = graphics;
        assert_eq!(copied(&p), [status::GRAPHICS]);
        p.console = no_tty;
        assert_eq!(copied(&p), [status::NO_CONSOLE]);
        q.vcs = "/nonexistent/vcs".into();
        assert_eq!(copied(&q), [status::NO_CONSOLE]);
        // vcsu that isn't a file to read.
        p.console = two_by_three;
        p.vcsu = std::env::temp_dir().to_str().unwrap().to_owned();
        assert_eq!(copied(&p), [status::FAILED]);
    }
}
