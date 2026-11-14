//! X11's clipboard by hand (docs/plans/clipboard.md §3.2 "X11", §3.3): no Xlib, no xcb, no x11rb. The session child
//! (src/session.rs) uses it where the session has no Wayland compositor with data-control: an Xorg session, or Xwayland
//! under a compositor without it. CLIPBOARD only (PRIMARY stays off, §3.2).
//!
//! The wire format is the core protocol's, little-endian (the setup's byte order `l`): a request is an opcode, a byte,
//! a u16 length in 4-byte words and its fields; the server sends 32-byte events and errors, and replies of 32 bytes
//! and more (their length in words beyond the 32). Requests used: InternAtom, QueryExtension, CreateWindow,
//! ChangeWindowAttributes, ChangeProperty, DeleteProperty, GetProperty, SetSelectionOwner, GetSelectionOwner,
//! ConvertSelection, SendEvent; XFixes' QueryVersion and SelectSelectionInput.
//!
//! So that the session child treats X11 as it treats Wayland, a transfer is a pipe here too:
//! - **Reading the guest's selection** (`receive`): ConvertSelection to a property of our window; at SelectionNotify,
//!   GetProperty in `CHUNK`s (deleting it with the last), each written to the pipe whose other end the caller reads, the
//!   next asked only once the pipe took the last (the bytes are streamed, never held whole). An `INCR` property starts
//!   the incremental protocol: each new value of the property (PropertyNotify) is read and deleted, until an empty one.
//! - **Owning it** (`own`): SetSelectionOwner, then GetSelectionOwner says whether we hold it (`Ev::Held`). A
//!   SelectionRequest for a type we offer becomes `Ev::Send` with a pipe's writing end, which the caller fills; this
//!   side reads the other end and sets the requestor's property with what came, whole if it fits in `threshold` (under
//!   the server's largest request), else by `INCR`: the requestor's PropertyNotify (deleted) asks for each `CHUNK`, an
//!   empty one ends it. `TARGETS` and `TIMESTAMP` are answered here.
//! - **The guest's selection changing hands**: XFixes' SelectionNotify, at which `TARGETS` is converted; its types, as
//!   names (the atoms interned at the start: `NAMES`), become `Ev::Selection`.
//!
//! Finding the display (`displays`, `cookie`): the sockets in `/tmp/.X11-unix`, a session's own being the one its
//! session file names (`DISPLAY=`), else one a process of the user's names (its `DISPLAY`, or an argument `:<n>`, as
//! the server's own command line has it); the cookie (`MIT-MAGIC-COOKIE-1`) from the server's `-auth` file, a process's
//! `XAUTHORITY`, or `~/.Xauthority`; none (a server without access control, as Xwayland under sway is) if none has it.

use crate::prelude::*;
use crate::rt::{self, Instant};
use crate::session::Jobs;

mod randr;
use alloc::collections::VecDeque;
use core::time::Duration;
use rustix::event::PollFlags;
use rustix::fd::{AsRawFd, BorrowedFd, OwnedFd, RawFd};
use rustix::io::{Errno, read, write};
use rustix::net::{AddressFamily, SocketAddrUnix, SocketFlags, SocketType, connect, socket_with};

/// The bytes asked of a property at once, and written to a requestor's at once under `INCR`.
pub const CHUNK: usize = 64 << 10;
/// The most a reply may claim: past it, the stream is out of step.
const MAX_REPLY: usize = 4 << 20;
/// The properties of our window that conversions use, one each at a time.
const PROPS: usize = 6;
/// Transfers to requestors at once; past it the oldest goes (a requestor gone mid-transfer leaves one behind).
const MAX_SERVES: usize = 8;
/// A guest program's types, past which the rest are ignored (as Wayland's).
const MAX_TYPES: usize = 64;
/// How long a conversion waits for its owner (its SelectionNotify, or under INCR its next value) before it ends as
/// refused: an owner that exits or crashes without answering, or drops our request (xclip 0.13 does during an INCR to
/// another requestor), would otherwise hold its slot, and its owner's later conversions (`owner_busy`), for good. Xt's
/// and Qt's requestors wait 5 s.
#[cfg(not(test))]
const OWNER_WAIT: Duration = Duration::from_secs(10);
#[cfg(test)]
pub const OWNER_WAIT: Duration = Duration::from_secs(1);

/// The atoms interned at the start, by index: the names a selection's types are known by (others are ignored).
pub const NAMES: [&str; 22 + PROPS] = [
    "CLIPBOARD",
    "TARGETS",
    "INCR",
    "ATOM",
    "TIMESTAMP",
    "INTEGER",
    "MULTIPLE",
    "UTF8_STRING",
    "STRING",
    "TEXT",
    "text/plain;charset=utf-8",
    "text/plain",
    "text/html",
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/bmp",
    "image/x-bmp",
    "image/x-ms-bmp",
    "image/gif",
    "image/avif",
    "text/plain;charset=UTF-8",
    "WAARM64_0",
    "WAARM64_1",
    "WAARM64_2",
    "WAARM64_3",
    "WAARM64_4",
    "WAARM64_5",
];
const CLIPBOARD: usize = 0;
const TARGETS: usize = 1;
const INCR: usize = 2;
const ATOM: usize = 3;
const TIMESTAMP: usize = 4;
const INTEGER: usize = 5;
const UTF8_STRING: usize = 7;
const TEXT: usize = 9;
const HTML: usize = 12;
const PNG: usize = 13;
const PROP0: usize = 22;
/// The types we offer for text, as a requestor may ask (clip::TEXT_ALIASES' X11 and MIME names).
const TEXT_TARGETS: [usize; 5] = [UTF8_STRING, 10, 11, TEXT, 8];

/// Core opcodes.
mod op {
    pub const CREATE_WINDOW: u8 = 1;
    pub const CHANGE_WINDOW_ATTRIBUTES: u8 = 2;
    pub const INTERN_ATOM: u8 = 16;
    pub const CHANGE_PROPERTY: u8 = 18;
    pub const DELETE_PROPERTY: u8 = 19;
    pub const GET_PROPERTY: u8 = 20;
    pub const SET_SELECTION_OWNER: u8 = 22;
    pub const GET_SELECTION_OWNER: u8 = 23;
    pub const CONVERT_SELECTION: u8 = 24;
    pub const SEND_EVENT: u8 = 25;
    pub const QUERY_EXTENSION: u8 = 98;
    // XFixes' minor opcodes.
    pub const XFIXES_QUERY_VERSION: u8 = 0;
    pub const XFIXES_SELECT_SELECTION_INPUT: u8 = 2;
}

/// Event codes.
mod ev {
    pub const PROPERTY_NOTIFY: u8 = 28;
    pub const SELECTION_CLEAR: u8 = 29;
    pub const SELECTION_REQUEST: u8 = 30;
    pub const SELECTION_NOTIFY: u8 = 31;
}

const PROPERTY_CHANGE_MASK: u32 = 1 << 22;
/// CreateWindow's and ChangeWindowAttributes' value-mask bit for the event mask.
const CW_EVENT_MASK: u32 = 1 << 11;
/// XFixes' SelectSelectionInput: the owner set, its window destroyed, its client gone.
const XFIXES_SELECTION_MASK: u32 = 1 | 2 | 4;
const NEW_VALUE: u8 = 0;
const DELETED: u8 = 1;

// ---- The wire format.

/// A request being written at the end of `out`: `done` writes its length.
pub struct Req<'a> {
    out: &'a mut Vec<u8>,
    at: usize,
}

impl<'a> Req<'a> {
    /// A request with `opcode` and its second byte `data`.
    pub fn new(out: &'a mut Vec<u8>, opcode: u8, data: u8) -> Req<'a> {
        let at = out.len();
        out.extend_from_slice(&[opcode, data, 0, 0]);
        Req { out, at }
    }

    pub fn u32(self, v: u32) -> Self {
        self.out.extend_from_slice(&v.to_le_bytes());
        self
    }

    pub fn u16(self, v: u16) -> Self {
        self.out.extend_from_slice(&v.to_le_bytes());
        self
    }

    /// Bytes, padded to 4.
    pub fn bytes(self, b: &[u8]) -> Self {
        self.out.extend_from_slice(b);
        while !(self.out.len() - self.at).is_multiple_of(4) {
            self.out.push(0);
        }
        self
    }

    pub fn done(self) {
        let words = ((self.out.len() - self.at) / 4) as u16;
        self.out[self.at + 2..self.at + 4].copy_from_slice(&words.to_le_bytes());
    }
}

/// The connection setup's request: byte order `l`, protocol 11.0, the authorization (`MIT-MAGIC-COOKIE-1` with a cookie,
/// else none).
pub fn setup_request(cookie: Option<&[u8]>, out: &mut Vec<u8>) {
    let (name, data): (&[u8], &[u8]) = match cookie {
        Some(c) => (b"MIT-MAGIC-COOKIE-1", c),
        None => (b"", b""),
    };
    out.extend_from_slice(&[b'l', 0]);
    out.extend_from_slice(&11u16.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&(name.len() as u16).to_le_bytes());
    out.extend_from_slice(&(data.len() as u16).to_le_bytes());
    out.extend_from_slice(&[0, 0]);
    for b in [name, data] {
        out.extend_from_slice(b);
        out.resize(out.len().next_multiple_of(4), 0);
    }
}

/// What the setup's reply says: the server took us (its first screen's root, our ids' base and mask, the largest
/// request in bytes), or why not.
#[derive(Debug, PartialEq, Eq)]
pub enum Setup {
    Ok {
        root: u32,
        base: u32,
        mask: u32,
        max_request: usize,
    },
    Refused(String),
}

/// The setup's reply at the start of `buf`, and its size; None while incomplete. Err: it can't be one.
pub fn setup_reply(buf: &[u8]) -> Result<Option<(Setup, usize)>, ()> {
    if buf.len() < 8 {
        return Ok(None);
    }
    let size = 8 + 4 * u16_at(buf, 6) as usize;
    if buf.len() < size {
        return Ok(None);
    }
    let r = &buf[..size];
    match r[0] {
        1 => {
            if size < 40 {
                return Err(());
            }
            let vendor = u16_at(r, 24) as usize;
            let formats = r[29] as usize;
            let screen = 40 + vendor.next_multiple_of(4) + 8 * formats;
            if r[28] == 0 || size < screen + 4 {
                return Err(());
            }
            Ok(Some((
                Setup::Ok {
                    root: u32_at(r, screen),
                    base: u32_at(r, 12),
                    mask: u32_at(r, 16),
                    max_request: 4 * u16_at(r, 26) as usize,
                },
                size,
            )))
        }
        // Failed (its reason's length in the second byte), or Authenticate (the reason in the rest).
        0 | 2 => {
            let reason = if r[0] == 0 {
                &r[8..(8 + r[1] as usize).min(size)]
            } else {
                &r[8..]
            };
            let why = String::from_utf8_lossy(reason);
            Ok(Some((
                Setup::Refused(why.trim_end_matches(['\0', '\n']).to_owned()),
                size,
            )))
        }
        _ => Err(()),
    }
}

/// A message from the server: a reply, an error or an event, by its first byte.
#[derive(Debug, PartialEq, Eq)]
pub enum Msg<'a> {
    /// The request `seq`'s reply: its whole bytes (32 and what follows).
    Reply {
        seq: u16,
        bytes: &'a [u8],
    },
    Error {
        seq: u16,
        code: u8,
        major: u8,
    },
    /// An event (its code without SendEvent's bit), its 32 bytes.
    Event {
        code: u8,
        bytes: &'a [u8],
    },
}

/// The first message in `buf`, and its size; None while incomplete. Err: out of step (a reply too large to be ours).
pub fn split(buf: &[u8]) -> Result<Option<(Msg<'_>, usize)>, ()> {
    if buf.len() < 32 {
        return Ok(None);
    }
    let size = match buf[0] {
        // A reply, and a GenericEvent: their length follows.
        1 | 35 => 32 + 4 * u32_at(buf, 4) as usize,
        _ => 32,
    };
    if size > MAX_REPLY {
        return Err(());
    }
    if buf.len() < size {
        return Ok(None);
    }
    let seq = u16_at(buf, 2);
    let m = match buf[0] {
        0 => Msg::Error {
            seq,
            code: buf[1],
            major: buf[10],
        },
        1 => Msg::Reply {
            seq,
            bytes: &buf[..size],
        },
        c => Msg::Event {
            code: c & 0x7f,
            bytes: &buf[..size],
        },
    };
    Ok(Some((m, size)))
}

pub fn u32_at(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(b[at..at + 4].try_into().unwrap())
}

pub fn u16_at(b: &[u8], at: usize) -> u16 {
    u16::from_le_bytes(b[at..at + 2].try_into().unwrap())
}

/// A GetProperty reply's type, the bytes after those it returned, and its value.
pub fn property(reply: &[u8]) -> Option<(u32, u32, &[u8])> {
    if reply.len() < 32 {
        return None;
    }
    let (format, ty, after, n) = (
        reply[1],
        u32_at(reply, 8),
        u32_at(reply, 12),
        u32_at(reply, 16),
    );
    let len = n as usize * (format as usize / 8).max(1);
    let value = reply.get(32..32 + if format == 0 { 0 } else { len })?;
    Some((ty, after, value))
}

/// A SelectionNotify (sent to a requestor) as SendEvent carries it.
pub fn selection_notify(
    time: u32,
    requestor: u32,
    selection: u32,
    target: u32,
    property: u32,
) -> [u8; 32] {
    let mut e = [0u8; 32];
    e[0] = ev::SELECTION_NOTIFY;
    for (i, v) in [time, requestor, selection, target, property]
        .into_iter()
        .enumerate()
    {
        e[4 + 4 * i..8 + 4 * i].copy_from_slice(&v.to_le_bytes());
    }
    e
}

// ---- Finding the display.

/// The display number in a `DISPLAY` value (`:0`, `:0.0`, `unix:1`; not a TCP host's).
pub fn display_number(v: &str) -> Option<u32> {
    let rest = v.strip_prefix(':').or_else(|| v.strip_prefix("unix:"))?;
    rest.split('.').next()?.parse().ok()
}

/// What a process of the user's says of the displays: those it names (its `DISPLAY`, or an argument `:<n>`, as a
/// server's command line has its own), and where their cookies may be (a server's `-auth`, a client's `XAUTHORITY`, its
/// `HOME`'s `.Xauthority`).
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Named {
    pub display: Vec<u32>,
    pub auth: Vec<String>,
    pub home: Option<String>,
}

/// A process's `cmdline` and `environ` (NUL-separated), read for what they say of display `n` (None: any).
pub fn named(cmdline: &[u8], environ: &[u8]) -> Named {
    let mut n = Named::default();
    let args: Vec<&str> = cmdline
        .split(|&b| b == 0)
        .filter_map(|a| core::str::from_utf8(a).ok())
        .collect();
    for (i, a) in args.iter().enumerate().skip(1) {
        if let Some(d) = a.strip_prefix(':').and_then(|d| d.parse().ok()) {
            n.display.push(d);
        }
        if *a == "-auth"
            && let Some(f) = args.get(i + 1)
        {
            n.auth.push((*f).to_owned());
        }
    }
    for kv in environ.split(|&b| b == 0) {
        let Ok(kv) = core::str::from_utf8(kv) else {
            continue;
        };
        if let Some(d) = kv.strip_prefix("DISPLAY=").and_then(display_number) {
            n.display.push(d);
        } else if let Some(f) = kv.strip_prefix("XAUTHORITY=") {
            n.auth.push(f.to_owned());
        } else if let Some(h) = kv.strip_prefix("HOME=") {
            n.home = Some(h.to_owned());
        }
    }
    n
}

/// The processes of `uid` under `proc` (/proc), as `named` reads them.
pub fn processes(proc: &str, uid: u32) -> Vec<Named> {
    let Ok(dir) = rt::dir_names(proc) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for pid in dir {
        if !pid.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        let path = format!("{proc}/{pid}");
        let ours = rustix::fs::stat(path.as_str()).is_ok_and(|s| s.st_uid == uid);
        if !ours {
            continue;
        }
        let cmdline = rt::read_file(format!("{path}/cmdline")).unwrap_or_default();
        let environ = rt::read_file(format!("{path}/environ")).unwrap_or_default();
        let n = named(&cmdline, &environ);
        if !n.display.is_empty() {
            out.push(n);
        }
    }
    out
}

/// The displays to try, lowest first: the sockets `X<n>` in `dir` that are the session's (`hint`, its session file's
/// `DISPLAY`: that one only), else that a process of the user's names (`procs`).
pub fn displays(dir: &str, hint: Option<u32>, procs: &[Named]) -> Vec<u32> {
    let Ok(d) = rt::dir_names(dir) else {
        return Vec::new();
    };
    let mut ns: Vec<u32> = d
        .iter()
        .filter_map(|e| e.strip_prefix('X')?.parse().ok())
        .filter(|n| match hint {
            Some(h) => *n == h,
            None => procs.iter().any(|p| p.display.contains(n)),
        })
        .collect();
    rt::sort(&mut ns);
    ns
}

/// Whether a display's socket (its `stat`'s mode and owner) may be the server of the session's user `uid`: a socket of
/// root's (Xorg) or the user's own (Xwayland, Xvfb, a user's Xorg); another user's is someone else's listener.
pub fn trusted_socket(mode: u32, owner: u32, uid: u32) -> bool {
    rustix::fs::FileType::from_raw_mode(mode) == rustix::fs::FileType::Socket
        && (owner == 0 || owner == uid)
}

/// Whether `name` in the sockets' directory may be a display's socket.
pub fn is_socket_name(name: &str) -> bool {
    name.strip_prefix('X')
        .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

/// The cookie of display `n` in an Xauthority file's bytes: an `MIT-MAGIC-COOKIE-1` entry for its number, local
/// (family 256, this host's name first) or any host's (65535).
pub fn xauth_cookie(file: &[u8], n: u32, host: &str) -> Option<Vec<u8>> {
    let want = n.to_string();
    let mut at = 0;
    let field = |at: &mut usize| -> Option<&[u8]> {
        let len = u16::from_be_bytes(file.get(*at..*at + 2)?.try_into().ok()?) as usize;
        let b = file.get(*at + 2..*at + 2 + len)?;
        *at += 2 + len;
        Some(b)
    };
    let mut best: Option<(u8, Vec<u8>)> = None;
    while at < file.len() {
        let Some(family) = file
            .get(at..at + 2)
            .map(|b| u16::from_be_bytes([b[0], b[1]]))
        else {
            break;
        };
        at += 2;
        let (Some(addr), Some(num), Some(name), Some(data)) = (
            field(&mut at),
            field(&mut at),
            field(&mut at),
            field(&mut at),
        ) else {
            break;
        };
        if name != b"MIT-MAGIC-COOKIE-1"
            || !(num == want.as_bytes() || (family == 65535 && num.is_empty()))
        {
            continue;
        }
        let rank = match family {
            256 if addr == host.as_bytes() => 0,
            256 => 1,
            65535 => 2,
            _ => continue,
        };
        if best.as_ref().is_none_or(|(r, _)| rank < *r) {
            best = Some((rank, data.to_vec()));
        }
    }
    best.map(|(_, c)| c)
}

/// Display `n`'s cookie, from the files the user's processes name (`procs`), then `home`'s `.Xauthority`; None: none
/// found (a server without access control takes none).
pub fn cookie(n: u32, procs: &[Named], home: Option<&str>) -> Option<Vec<u8>> {
    cookie_and_file(n, procs, home).map(|(c, _)| c)
}

/// `cookie`'s file (a tool's `XAUTHORITY`: src/keymap.rs `setxkbmap`).
pub fn cookie_file(n: u32, procs: &[Named], home: Option<&str>) -> Option<String> {
    cookie_and_file(n, procs, home).map(|(_, f)| f)
}

fn cookie_and_file(n: u32, procs: &[Named], home: Option<&str>) -> Option<(Vec<u8>, String)> {
    let host = rt::read_text("/proc/sys/kernel/hostname").unwrap_or_default();
    let mut files: Vec<String> = procs
        .iter()
        .filter(|p| p.display.contains(&n))
        .flat_map(|p| p.auth.iter().cloned())
        .collect();
    let homes = procs.iter().filter_map(|p| p.home.as_deref()).chain(home);
    files.extend(homes.map(|h| format!("{h}/.Xauthority")));
    files.into_iter().find_map(|f| {
        let c = xauth_cookie(&rt::read_file(&f).ok()?, n, host.trim())?;
        Some((c, f))
    })
}

/// The home of `uid`, from /etc/passwd.
pub fn home_of(uid: u32) -> Option<String> {
    let passwd = rt::read_text("/etc/passwd").ok()?;
    passwd.lines().find_map(|l| {
        let f: Vec<&str> = l.split(':').collect();
        (f.len() >= 6 && f[2].parse() == Ok(uid)).then(|| f[5].to_owned())
    })
}

// ---- The client.

/// What the session child hears of the X server.
#[derive(Debug)]
pub enum Ev {
    /// The selection is watched: the clipboard is ours to share (SESSION).
    Ready,
    /// The guest's selection changed hands: its offer's id (0: no owner) and types.
    Selection { offer: u32, types: Vec<String> },
    /// A guest program pastes our source as `mime`: its bytes into `fd`, then `served(serve)` if they came whole (else
    /// the paste is refused, or under INCR ends with what came).
    Send {
        source: u32,
        mime: String,
        fd: OwnedFd,
        serve: u32,
    },
    /// Our source lost the selection to another program.
    Cancelled { source: u32 },
    /// The page's offer `serial` holds the selection.
    Held { serial: u32 },
}

/// A reply awaited, by what it answers.
#[derive(Clone, Copy, Debug)]
enum Want {
    Atom(usize),
    Extension,
    Version,
    /// The selection's owner when the watch began.
    Owner,
    /// Whether our source `source` (for the page's offer `serial`) holds the selection.
    Held {
        source: u32,
        serial: u32,
    },
    /// A conversion's property, read.
    Property(u32),
    /// RandR's (src/x11/randr.rs).
    Randr(randr::Step),
}

/// Where a conversion's bytes go.
enum Sink {
    Pipe(OwnedFd),
    /// Nowhere: its reader went during an INCR transfer, whose owner waits for each chunk to be taken (it is read to
    /// its end, so that the owner's transfer ends too).
    Drain,
    /// The `TARGETS` of the guest's offer `offer`.
    Targets(u32),
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Conv {
    /// ConvertSelection sent: SelectionNotify awaited.
    Asked,
    /// A GetProperty in flight.
    Reading,
    /// Read up to `offset`, more to read once the pipe took what came.
    More,
    /// Under INCR: the next value awaited.
    Waiting,
    /// Under INCR: a value came, read once the pipe took what came before.
    Came,
    /// All read: the pipe closed once it took the rest.
    Done,
}

/// The guest's selection being read into a sink, through one of our window's properties.
struct Conversion {
    prop: u32,
    /// The guest's owner it converts from, and the target asked (its SelectionNotify names it).
    owner: u32,
    target: u32,
    /// Since when it waits for the owner (`OWNER_WAIT`), in `Asked` and `Waiting`.
    since: Instant,
    sink: Sink,
    state: Conv,
    incr: bool,
    /// Where the next GetProperty reads, in 4-byte words.
    offset: u32,
    buf: Vec<u8>,
    at: usize,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Serving {
    /// Its bytes coming from the pipe, to be set whole if they fit.
    Collect,
    /// Under INCR: the requestor's deletion of the last value awaited.
    Waiting,
    /// Under INCR: deleted, the next value set as soon as there are bytes for it.
    Ready,
}

/// Our source's bytes on their way to a requestor's property.
struct Serve {
    /// Its id (`Ev::Send`), and whether the bytes came whole (`served`): an EOF without it is a failed transfer.
    id: u32,
    ok: bool,
    requestor: u32,
    prop: u32,
    target: u32,
    ty: u32,
    time: u32,
    fd: OwnedFd,
    buf: Vec<u8>,
    eof: bool,
    state: Serving,
}

/// Our source in the guest's selection: the page's offer.
struct Source {
    id: u32,
    text: bool,
    image: bool,
    html: bool,
}

pub struct X {
    pub fd: OwnedFd,
    pub display: u32,
    out: Vec<u8>,
    inb: Vec<u8>,
    /// The last request's sequence number.
    seq: u16,
    replies: VecDeque<(u16, Want)>,
    set_up: bool,
    pub ready: bool,
    root: u32,
    win: u32,
    max_request: usize,
    atoms: [u32; NAMES.len()],
    atoms_left: usize,
    xfixes: Option<(u8, u8)>,
    /// The guest's selection: its owner (0: none), its offer's id, its time.
    owner: u32,
    offer: u32,
    offer_time: u32,
    next: u32,
    source: Option<Source>,
    /// The time our window took the selection (XFixes says it): TIMESTAMP's answer.
    owned_at: u32,
    convs: Vec<Conversion>,
    /// Conversions waiting for the owner (`owner_busy`): the offer each is for, its target, its sink.
    queue: VecDeque<(u32, u32, Sink)>,
    serves: Vec<Serve>,
    /// The last serve's id.
    serve_id: u32,
    /// The clipboard is shared over this connection.
    clip: bool,
    randr: randr::Randr,
}

impl X {
    /// Connects to display `n`'s socket in `dir` and sends the setup (with `cookie`, if there is one), if the socket is
    /// root's or `uid`'s (the session's user: `/tmp/.X11-unix` is anyone's to bind in, and the cookie isn't anyone's to
    /// see). Nonblocking: a server stopped with its backlog full refuses (`AGAIN`) rather than holding the child up.
    /// `jobs`: what the connection is for, the clipboard (CLIPBOARD watched, our windows made) and the screen's size
    /// (RandR).
    pub fn connect(
        dir: &str,
        n: u32,
        cookie: Option<&[u8]>,
        uid: u32,
        jobs: Jobs,
    ) -> Result<X, Errno> {
        let path = format!("{dir}/X{n}");
        let st = rustix::fs::stat(path.as_str())?;
        if !trusted_socket(st.st_mode, st.st_uid, uid) {
            return Err(Errno::PERM);
        }
        let addr = SocketAddrUnix::new(path.as_str())?;
        let fd = socket_with(
            AddressFamily::UNIX,
            SocketType::STREAM,
            SocketFlags::CLOEXEC | SocketFlags::NONBLOCK,
            None,
        )?;
        connect(&fd, &addr)?;
        let mut out = Vec::new();
        setup_request(cookie, &mut out);
        Ok(X {
            fd,
            display: n,
            out,
            inb: Vec::new(),
            seq: 0,
            replies: VecDeque::new(),
            set_up: false,
            ready: false,
            root: 0,
            win: 0,
            max_request: 4 * 65535,
            atoms: [0; NAMES.len()],
            atoms_left: NAMES.len(),
            xfixes: None,
            owner: 0,
            offer: 0,
            offer_time: 0,
            next: 0,
            source: None,
            owned_at: 0,
            convs: Vec::new(),
            queue: VecDeque::new(),
            serves: Vec::new(),
            serve_id: 0,
            clip: jobs.clip,
            randr: randr::Randr::new(jobs.resize),
        })
    }

    /// The server took us (its setup's reply was a success).
    pub fn is_set_up(&self) -> bool {
        self.set_up
    }

    /// The connection served what it was for: the clipboard's watch up, or (without the clipboard) the setup done.
    pub fn did_its_job(&self) -> bool {
        self.ready || (self.set_up && !self.clip)
    }

    pub fn pending(&self) -> bool {
        !self.out.is_empty()
    }

    /// A request: written, its sequence number counted (and its reply awaited as `want`).
    fn req(
        &mut self,
        opcode: u8,
        data: u8,
        want: Option<Want>,
        f: impl FnOnce(Req<'_>) -> Req<'_>,
    ) {
        f(Req::new(&mut self.out, opcode, data)).done();
        self.seq = self.seq.wrapping_add(1);
        if let Some(w) = want {
            self.replies.push_back((self.seq, w));
        }
    }

    pub fn flush(&mut self) -> Result<(), Errno> {
        while !self.out.is_empty() {
            match rustix::net::send(&self.fd, &self.out, rustix::net::SendFlags::NOSIGNAL) {
                Ok(n) => {
                    self.out.drain(..n);
                }
                Err(Errno::INTR) => {}
                Err(Errno::AGAIN) => break,
                Err(e) => return Err(e),
            }
        }
        if self.out.is_empty() && self.out.capacity() > 4 * CHUNK {
            self.out = Vec::new();
        }
        Ok(())
    }

    /// The largest property value set whole; past it, INCR.
    fn threshold(&self) -> usize {
        (self.max_request.saturating_sub(64) & !3).clamp(4096, 4 * CHUNK)
    }

    fn atom(&self, i: usize) -> u32 {
        self.atoms[i]
    }

    fn name(&self, atom: u32) -> Option<&'static str> {
        self.atoms
            .iter()
            .position(|&a| a == atom && a != 0)
            .map(|i| NAMES[i])
    }

    /// Reads what came and handles it. Err: the connection is to end (why).
    pub fn input(&mut self, evs: &mut Vec<Ev>) -> Result<(), String> {
        let mut buf = [0u8; 16384];
        loop {
            match read(&self.fd, &mut buf) {
                Ok(0) => return Err("the X server closed the connection".into()),
                Ok(n) => self.inb.extend_from_slice(&buf[..n]),
                Err(Errno::INTR) => continue,
                Err(Errno::AGAIN) => break,
                Err(e) => {
                    return Err(format!(
                        "the X server's connection failed (errno {})",
                        e.raw_os_error()
                    ));
                }
            }
            if self.inb.len() > MAX_REPLY + 32 {
                break;
            }
        }
        let inb = core::mem::take(&mut self.inb);
        let mut at = 0;
        let r = self.messages(&inb, &mut at, evs);
        if self.ready {
            self.start();
        }
        self.inb = inb;
        self.inb.drain(..at);
        if self.inb.is_empty() && self.inb.capacity() > 4 * CHUNK {
            self.inb = Vec::new();
        }
        r
    }

    fn messages(&mut self, inb: &[u8], at: &mut usize, evs: &mut Vec<Ev>) -> Result<(), String> {
        if !self.set_up {
            match setup_reply(&inb[*at..]) {
                Ok(None) => return Ok(()),
                Ok(Some((
                    Setup::Ok {
                        root,
                        base,
                        mask,
                        max_request,
                    },
                    size,
                ))) => {
                    *at += size;
                    self.set_up(root, base, mask, max_request);
                }
                Ok(Some((Setup::Refused(why), _))) => {
                    return Err(format!("the X server refused us: {why}"));
                }
                Err(()) => return Err("the X server's setup reply is out of step".into()),
            }
        }
        loop {
            match split(&inb[*at..]) {
                Ok(Some((m, size))) => {
                    *at += size;
                    self.message(m, evs)?;
                }
                Ok(None) => return Ok(()),
                Err(()) => return Err("the X server's stream went out of step".into()),
            }
        }
    }

    /// The setup's reply: the atoms interned, XFixes asked for, our window made (an InputOnly window that hears its
    /// properties change).
    fn set_up(&mut self, root: u32, base: u32, mask: u32, max_request: usize) {
        self.set_up = true;
        self.root = root;
        self.max_request = max_request.max(4096);
        self.win = base | (1 & mask);
        if self.randr.on {
            self.randr_start();
        }
        if !self.clip {
            return;
        }
        for (i, name) in NAMES.iter().enumerate() {
            self.req(op::INTERN_ATOM, 0, Some(Want::Atom(i)), |r| {
                r.u16(name.len() as u16).u16(0).bytes(name.as_bytes())
            });
        }
        self.req(op::QUERY_EXTENSION, 0, Some(Want::Extension), |r| {
            r.u16(6).u16(0).bytes(b"XFIXES")
        });
        // Ours, which owns the selection, and one for each conversion: an owner keeps one transfer per requestor
        // window (xclip's INCR does), so that two at once must come from two windows.
        for k in 0..=PROPS as u32 {
            let (win, root) = (self.win + k, self.root);
            self.req(op::CREATE_WINDOW, 0, None, |r| {
                // depth CopyFromParent, at -1,-1, 1×1, no border, InputOnly, visual CopyFromParent; its event mask.
                r.u32(win)
                    .u32(root)
                    .u16(0xffff)
                    .u16(0xffff)
                    .u16(1)
                    .u16(1)
                    .u16(0)
                    .u16(2)
                    .u32(0)
                    .u32(CW_EVENT_MASK)
                    .u32(PROPERTY_CHANGE_MASK)
            });
        }
    }

    /// The window and the property a conversion of slot `k` uses.
    fn slot(&self, k: usize) -> (u32, u32) {
        (self.win + 1 + k as u32, self.atom(PROP0 + k))
    }

    /// The window conversion property `prop` is on.
    fn slot_win(&self, prop: u32) -> u32 {
        (0..PROPS)
            .map(|k| self.slot(k))
            .find(|&(_, p)| p == prop)
            .map_or(0, |(w, _)| w)
    }

    fn message(&mut self, m: Msg<'_>, evs: &mut Vec<Ev>) -> Result<(), String> {
        match m {
            Msg::Reply { seq, bytes } => {
                if let Some(w) = self.take_reply(seq) {
                    self.reply(w, bytes, evs)?;
                }
            }
            Msg::Error { seq, code, major } => {
                if let Some(w) = self.take_reply(seq) {
                    match w {
                        Want::Property(prop) => self.abort(prop, true),
                        Want::Atom(_) | Want::Extension | Want::Version | Want::Owner => {
                            return Err(format!(
                                "the X server's error {code} at the setup (request {major})"
                            ));
                        }
                        Want::Held { .. } => {}
                        Want::Randr(step) => self.randr_error(step, code),
                    }
                }
                // Others are a requestor's window gone mid-transfer, mostly: nothing to do.
            }
            Msg::Event { code, bytes } => self.event(code, bytes, evs),
        }
        Ok(())
    }

    /// The awaited reply `seq` answers (those before it that got none are dropped).
    fn take_reply(&mut self, seq: u16) -> Option<Want> {
        while let Some(&(s, w)) = self.replies.front() {
            if s == seq {
                self.replies.pop_front();
                return Some(w);
            }
            // An earlier one's: answered already (or never will be). Sequence numbers wrap: compare by distance.
            if seq.wrapping_sub(s) < 0x8000 {
                self.replies.pop_front();
            } else {
                break;
            }
        }
        None
    }

    fn reply(&mut self, w: Want, r: &[u8], evs: &mut Vec<Ev>) -> Result<(), String> {
        match w {
            Want::Atom(i) => {
                self.atoms[i] = u32_at(r, 8);
                self.atoms_left -= 1;
                self.maybe_watch();
            }
            Want::Extension => {
                if r[8] == 0 {
                    return Err("the X server has no XFIXES".into());
                }
                self.xfixes = Some((r[9], r[10]));
                let major = r[9];
                self.req(major, op::XFIXES_QUERY_VERSION, Some(Want::Version), |r| {
                    r.u32(5).u32(0)
                });
            }
            Want::Version => self.maybe_watch(),
            Want::Owner => {
                self.ready = true;
                evs.push(Ev::Ready);
                let owner = u32_at(r, 8);
                self.owner_changed(owner, 0, evs);
            }
            Want::Held { source, serial } => {
                if u32_at(r, 8) == self.win && self.source.as_ref().is_some_and(|s| s.id == source)
                {
                    evs.push(Ev::Held { serial });
                }
            }
            Want::Property(prop) => self.got_property(prop, r, evs),
            Want::Randr(step) => self.randr_reply(step, r),
        }
        Ok(())
    }

    /// Once the atoms and XFixes' version are known: the selection's owner watched, and asked.
    fn maybe_watch(&mut self) {
        let Some((major, _)) = self.xfixes else {
            return;
        };
        let version_known = !self.replies.iter().any(|(_, w)| matches!(w, Want::Version));
        if self.atoms_left > 0 || !version_known || self.ready {
            return;
        }
        if self.replies.iter().any(|(_, w)| matches!(w, Want::Owner)) {
            return;
        }
        let (win, clip) = (self.win, self.atom(CLIPBOARD));
        self.req(major, op::XFIXES_SELECT_SELECTION_INPUT, None, |r| {
            r.u32(win).u32(clip).u32(XFIXES_SELECTION_MASK)
        });
        self.req(op::GET_SELECTION_OWNER, 0, Some(Want::Owner), |r| {
            r.u32(clip)
        });
    }

    fn event(&mut self, code: u8, e: &[u8], evs: &mut Vec<Ev>) {
        if let Some((_, first)) = self.xfixes
            && code == first
        {
            // XFixes' SelectionNotify: subtype, window, owner, selection, timestamp, selection timestamp.
            if u32_at(e, 12) != self.atom(CLIPBOARD) || !self.ready {
                return;
            }
            // Its owner's window destroyed, or its client gone (subtypes 1, 2): no owner now.
            let owner = if e[1] == 0 { u32_at(e, 8) } else { 0 };
            let time = u32_at(e, 20);
            if owner == self.win {
                self.owned_at = time;
                return;
            }
            return self.owner_changed(owner, time, evs);
        }
        match code {
            ev::PROPERTY_NOTIFY => {
                let (win, atom, state) = (u32_at(e, 4), u32_at(e, 8), e[16]);
                if state == NEW_VALUE && win != 0 && self.slot_win(atom) == win {
                    if let Some(c) = self
                        .convs
                        .iter_mut()
                        .find(|c| c.prop == atom && c.state == Conv::Waiting)
                    {
                        c.state = Conv::Came;
                        c.since = Instant::now();
                        self.pump_conv(atom, evs);
                    }
                } else if state == DELETED
                    && let Some(i) = self.serves.iter().position(|s| {
                        s.requestor == win && s.prop == atom && s.state == Serving::Waiting
                    })
                {
                    self.serves[i].state = Serving::Ready;
                    self.pump_serve(i);
                }
            }
            ev::SELECTION_CLEAR => {
                if u32_at(e, 12) == self.atom(CLIPBOARD)
                    && let Some(s) = self.source.take()
                {
                    evs.push(Ev::Cancelled { source: s.id });
                }
            }
            ev::SELECTION_REQUEST => self.request(e, evs),
            ev::SELECTION_NOTIFY => {
                // To a conversion's window: it is answered (refused: no property). Its target too: a late answer to a
                // conversion that `expire` ended may come to a slot in use again.
                let (requestor, target, prop) = (u32_at(e, 8), u32_at(e, 16), u32_at(e, 20));
                let Some((_, slot)) = (0..PROPS)
                    .map(|k| self.slot(k))
                    .find(|&(w, _)| w == requestor)
                else {
                    return;
                };
                let found = self
                    .convs
                    .iter()
                    .position(|c| c.state == Conv::Asked && c.prop == slot && c.target == target);
                let Some(i) = found else { return };
                if prop == 0 {
                    let c = self.convs.remove(i);
                    self.finish(c, evs);
                    return;
                }
                self.get(i);
            }
            _ => {}
        }
    }

    // ---- The guest's selection.

    /// The selection has a new owner (another program's window, or none), at `time`: a new offer, its types asked.
    fn owner_changed(&mut self, owner: u32, time: u32, evs: &mut Vec<Ev>) {
        self.next = self.next.wrapping_add(1).max(1);
        self.owner = owner;
        self.offer = if owner == 0 { 0 } else { self.next };
        self.offer_time = time;
        if owner == 0 {
            evs.push(Ev::Selection {
                offer: 0,
                types: Vec::new(),
            });
            return;
        }
        let offer = self.offer;
        if !self.convert(self.atom(TARGETS), Sink::Targets(offer)) {
            evs.push(Ev::Selection {
                offer,
                types: Vec::new(),
            });
        }
    }

    /// The guest's current offer (not ours), if there is one.
    pub fn selection(&self) -> Option<u32> {
        (self.offer != 0).then_some(self.offer)
    }

    /// The guest's offer `offer` as `mime`: the pipe's reading end its bytes come out of. None: not the current offer,
    /// a type not known, or too many conversions at once.
    pub fn receive(&mut self, offer: u32, mime: &str) -> Option<OwnedFd> {
        if offer == 0 || offer != self.offer {
            return None;
        }
        let i = NAMES.iter().position(|n| *n == mime)?;
        let (r, w) = rustix::pipe::pipe_with(rustix::pipe::PipeFlags::CLOEXEC).ok()?;
        crate::session::nonblocking(&w);
        self.convert(self.atom(i), Sink::Pipe(w)).then_some(r)
    }

    /// ConvertSelection of the guest's selection to `target`, into a free property of ours; false if none is free.
    fn convert(&mut self, target: u32, sink: Sink) -> bool {
        if self.queue.len() >= PROPS {
            return false;
        }
        self.queue.push_back((self.offer, target, sink));
        self.start();
        true
    }

    /// Whether the guest's owner `owner` is in the middle of a transfer of ours: a conversion not answered yet, or an
    /// INCR one not ended. Some owners serve one INCR at a time and drop the requests that come meanwhile (xclip 0.13,
    /// Debian 13's: found by the page test), so a conversion waits for the owner to be free.
    fn owner_busy(&self, owner: u32) -> bool {
        self.convs.iter().any(|c| {
            c.owner == owner && (c.state == Conv::Asked || (c.incr && c.state != Conv::Done))
        })
    }

    /// Starts the queued conversion, if the owner is free and a slot is (a stale offer's are dropped: their pipes close).
    fn start(&mut self) {
        while self.queue.front().is_some_and(|q| q.0 != self.offer) {
            self.queue.pop_front();
        }
        if self.queue.is_empty() || self.owner_busy(self.owner) {
            return;
        }
        let busy = |p: u32| self.convs.iter().any(|c| c.prop == p);
        let Some((win, prop)) = (0..PROPS).map(|k| self.slot(k)).find(|&(_, p)| !busy(p)) else {
            return;
        };
        let (_, target, sink) = self.queue.pop_front().unwrap();
        let (clip, time, owner) = (self.atom(CLIPBOARD), self.offer_time, self.owner);
        self.req(op::CONVERT_SELECTION, 0, None, |r| {
            r.u32(win).u32(clip).u32(target).u32(prop).u32(time)
        });
        self.convs.push(Conversion {
            prop,
            owner,
            target,
            since: Instant::now(),
            sink,
            state: Conv::Asked,
            incr: false,
            offset: 0,
            buf: Vec::new(),
            at: 0,
        });
    }

    /// GetProperty of conversion `i`'s property: a `CHUNK` from its offset, deleted once read to its end.
    fn get(&mut self, i: usize) {
        let (prop, offset) = (self.convs[i].prop, self.convs[i].offset);
        let win = self.slot_win(prop);
        self.convs[i].state = Conv::Reading;
        self.req(op::GET_PROPERTY, 1, Some(Want::Property(prop)), |r| {
            r.u32(win)
                .u32(prop)
                .u32(0)
                .u32(offset)
                .u32((CHUNK / 4) as u32)
        });
    }

    fn got_property(&mut self, prop: u32, reply: &[u8], evs: &mut Vec<Ev>) {
        let incr = self.atom(INCR);
        let Some(i) = self
            .convs
            .iter()
            .position(|c| c.prop == prop && c.state == Conv::Reading)
        else {
            return;
        };
        let Some((ty, after, value)) = property(reply) else {
            return self.abort(prop, true);
        };
        let c = &mut self.convs[i];
        if ty == incr && !c.incr && c.offset == 0 {
            // INCR: the value is a lower bound of the size; the chunks come as new values, once this one is deleted
            // (our GetProperty deleted it).
            c.incr = true;
            c.state = Conv::Waiting;
            c.since = Instant::now();
            return;
        }
        if matches!(c.sink, Sink::Drain) && !c.incr {
            // Its reader went before it came: not INCR, so nothing waits on it.
            c.state = Conv::Reading;
            return self.abort(prop, true);
        }
        let targets = matches!(c.sink, Sink::Targets(_));
        c.state = if after > 0 && value.len() % 4 != 0 {
            // A partial word before the end can't be: the property changed under us.
            Conv::Done
        } else if after > 0 {
            c.offset += (value.len() / 4) as u32;
            Conv::More
        } else if c.incr && !value.is_empty() {
            c.offset = 0;
            c.since = Instant::now();
            Conv::Waiting
        } else {
            Conv::Done
        };
        if targets {
            // TARGETS: the atoms we know (`NAMES`), however many others it lists (GTK's image targets name every
            // gdk-pixbuf writer, an office suite many formats), up to `MAX_TYPES`.
            let atoms = self.atoms;
            let c = &mut self.convs[i];
            for w in value.as_chunks::<4>().0 {
                if atoms.contains(&u32::from_le_bytes(*w)) {
                    c.buf.extend_from_slice(w);
                }
            }
            if c.buf.len() >= 4 * MAX_TYPES {
                c.buf.truncate(4 * MAX_TYPES);
                c.state = Conv::Done;
            }
        } else {
            c.buf.extend_from_slice(value);
        }
        self.pump_conv(prop, evs);
    }

    /// Moves conversion `prop`'s bytes into its pipe; then the next read, or its end.
    fn pump_conv(&mut self, prop: u32, evs: &mut Vec<Ev>) {
        let Some(i) = self.convs.iter().position(|c| c.prop == prop) else {
            return;
        };
        let c = &mut self.convs[i];
        if let Sink::Pipe(fd) = &c.sink {
            while c.at < c.buf.len() {
                match write(fd, &c.buf[c.at..]) {
                    Ok(n) => c.at += n,
                    Err(Errno::INTR) => {}
                    Err(Errno::AGAIN) => return,
                    // The reader is gone (it took what it wanted, or stopped).
                    Err(_) => return self.abort(prop, false),
                }
            }
        }
        if !matches!(c.sink, Sink::Targets(_)) {
            c.buf.clear();
            c.at = 0;
        }
        match c.state {
            Conv::More => self.get(i),
            Conv::Came => {
                self.convs[i].offset = 0;
                self.get(i);
            }
            Conv::Done => {
                let c = self.convs.remove(i);
                self.finish(c, evs);
            }
            Conv::Asked | Conv::Reading | Conv::Waiting => {}
        }
    }

    /// A conversion ended (all read, or refused): its pipe closes; the targets' become the offer's types.
    fn finish(&mut self, c: Conversion, evs: &mut Vec<Ev>) {
        if let Sink::Targets(offer) = c.sink {
            if offer != self.offer {
                return;
            }
            let mut types = Vec::new();
            for w in c.buf.as_chunks::<4>().0 {
                if let Some(n) = self.name(u32::from_le_bytes(*w))
                    && !types.iter().any(|t| t == n)
                    && !n.starts_with("WAARM64_")
                {
                    types.push(n.to_owned());
                }
            }
            evs.push(Ev::Selection { offer, types });
        }
    }

    /// A conversion stopped (its reader gone; `hard`: an error): its pipe closed, its property deleted. One that may
    /// be (or become) INCR is drained instead (`Sink::Drain`), unless `hard`.
    fn abort(&mut self, prop: u32, hard: bool) {
        let Some(i) = self.convs.iter().position(|c| c.prop == prop) else {
            return;
        };
        let c = &mut self.convs[i];
        if !hard && (c.incr || c.state == Conv::Asked) && c.state != Conv::Done {
            c.sink = Sink::Drain;
            c.buf.clear();
            c.at = 0;
            if matches!(c.state, Conv::More | Conv::Came) {
                self.pump_conv(prop, &mut Vec::new());
            }
            return;
        }
        self.convs.remove(i);
        let win = self.slot_win(prop);
        self.req(op::DELETE_PROPERTY, 0, None, |r| r.u32(win).u32(prop));
    }

    // ---- Our source.

    /// The page's offer `serial` as the selection (text, an image, HTML: its types); its source's id. `Ev::Held` once
    /// the server says we hold it.
    pub fn own(&mut self, serial: u32, text: bool, image: bool, html: bool) -> u32 {
        self.next = self.next.wrapping_add(1).max(1);
        let id = self.next;
        self.source = Some(Source {
            id,
            text,
            image,
            html,
        });
        // Not the guest's any more: its offer's transfers carry on, new ones fail.
        self.owner = self.win;
        self.offer = 0;
        let (win, clip) = (self.win, self.atom(CLIPBOARD));
        self.req(op::SET_SELECTION_OWNER, 0, None, |r| {
            r.u32(win).u32(clip).u32(0)
        });
        self.req(
            op::GET_SELECTION_OWNER,
            0,
            Some(Want::Held { source: id, serial }),
            |r| r.u32(clip),
        );
        id
    }

    /// Our source goes; `clear`: the selection with it (if it is still ours).
    pub fn disown(&mut self, source: u32, clear: bool) {
        if self.source.as_ref().is_some_and(|s| s.id == source) {
            self.source = None;
            if clear {
                let clip = self.atom(CLIPBOARD);
                self.req(op::SET_SELECTION_OWNER, 0, None, |r| {
                    r.u32(0).u32(clip).u32(0)
                });
            }
        }
    }

    /// The types our source offers, as atoms (`TARGETS`' answer).
    fn targets(&self) -> Vec<u32> {
        let mut t = vec![self.atom(TARGETS), self.atom(TIMESTAMP)];
        if let Some(s) = &self.source {
            if s.text {
                t.extend(TEXT_TARGETS.iter().map(|&i| self.atom(i)));
            }
            if s.html {
                t.push(self.atom(HTML));
            }
            if s.image {
                t.push(self.atom(PNG));
            }
        }
        t
    }

    /// A SelectionRequest: answered here (`TARGETS`, `TIMESTAMP`), served from a pipe (a type we offer), or refused.
    fn request(&mut self, e: &[u8], evs: &mut Vec<Ev>) {
        let (time, requestor, selection, target) =
            (u32_at(e, 4), u32_at(e, 12), u32_at(e, 16), u32_at(e, 20));
        // An obsolete requestor names no property: the target's.
        let prop = match u32_at(e, 24) {
            0 => target,
            p => p,
        };
        let refuse = |x: &mut X| x.notify(time, requestor, selection, target, 0);
        let Some(source) = self
            .source
            .as_ref()
            .filter(|_| selection == self.atom(CLIPBOARD))
        else {
            return refuse(self);
        };
        let id = source.id;
        if target == self.atom(TARGETS) {
            let t = self.targets();
            let atom = self.atom(ATOM);
            self.set_property(requestor, prop, atom, 32, &atoms_bytes(&t));
            return self.notify(time, requestor, selection, target, prop);
        }
        if target == self.atom(TIMESTAMP) {
            let integer = self.atom(INTEGER);
            let at = self.owned_at.to_le_bytes();
            self.set_property(requestor, prop, integer, 32, &at);
            return self.notify(time, requestor, selection, target, prop);
        }
        if target == 0 || !self.targets()[2..].contains(&target) {
            return refuse(self);
        }
        let Some(mime) = self.name(target) else {
            return refuse(self);
        };
        let Ok((r, w)) = rustix::pipe::pipe_with(rustix::pipe::PipeFlags::CLOEXEC) else {
            return refuse(self);
        };
        crate::session::nonblocking(&r);
        // TEXT is answered as UTF-8 (the owner picks its encoding); the others as what they are.
        let ty = if target == self.atom(TEXT) {
            self.atom(UTF8_STRING)
        } else {
            target
        };
        if self.serves.len() >= MAX_SERVES {
            self.serves.remove(0);
        }
        self.serve_id = self.serve_id.wrapping_add(1).max(1);
        let serve = self.serve_id;
        self.serves.push(Serve {
            id: serve,
            ok: false,
            requestor,
            prop,
            target,
            ty,
            time,
            fd: r,
            buf: Vec::new(),
            eof: false,
            state: Serving::Collect,
        });
        evs.push(Ev::Send {
            source: id,
            mime: mime.to_owned(),
            fd: w,
            serve,
        });
    }

    fn notify(&mut self, time: u32, requestor: u32, selection: u32, target: u32, prop: u32) {
        let e = selection_notify(time, requestor, selection, target, prop);
        self.req(op::SEND_EVENT, 0, None, |r| {
            r.u32(requestor).u32(0).bytes(&e)
        });
    }

    fn set_property(&mut self, win: u32, prop: u32, ty: u32, format: u8, value: &[u8]) {
        let n = (value.len() / (format as usize / 8)) as u32;
        self.req(op::CHANGE_PROPERTY, 0, None, |r| {
            r.u32(win)
                .u32(prop)
                .u32(ty)
                .bytes(&[format, 0, 0, 0])
                .u32(n)
                .bytes(value)
        });
    }

    fn select_property_changes(&mut self, win: u32, on: bool) {
        let mask = if on { PROPERTY_CHANGE_MASK } else { 0 };
        self.req(op::CHANGE_WINDOW_ATTRIBUTES, 0, None, |r| {
            r.u32(win).u32(CW_EVENT_MASK).u32(mask)
        });
    }

    /// Reads serve `i`'s pipe and moves its bytes on: set whole once all came and fit, else by INCR as the requestor
    /// takes each chunk. Taken out once done.
    fn pump_serve(&mut self, i: usize) {
        let (threshold, clip, incr) = (self.threshold(), self.atom(CLIPBOARD), self.atom(INCR));
        let s = &mut self.serves[i];
        let want = if s.state == Serving::Collect {
            threshold + 1
        } else {
            CHUNK
        };
        let mut chunk = [0u8; 16384];
        while !s.eof && s.buf.len() < want {
            match read(&s.fd, &mut chunk) {
                Ok(0) => s.eof = true,
                Ok(n) => s.buf.extend_from_slice(&chunk[..n]),
                Err(Errno::INTR) => {}
                Err(Errno::AGAIN) => break,
                Err(_) => s.eof = true,
            }
        }
        let (requestor, prop, ty, target, time) = (s.requestor, s.prop, s.ty, s.target, s.time);
        match s.state {
            Serving::Collect if s.buf.len() > threshold => {
                // Too large for one request: INCR, its value the size so far (a lower bound).
                let len = (s.buf.len() as u32).to_le_bytes();
                s.state = Serving::Waiting;
                self.select_property_changes(requestor, true);
                self.set_property(requestor, prop, incr, 32, &len);
                self.notify(time, requestor, clip, target, prop);
            }
            Serving::Collect if s.eof => {
                // All came (`served`), set whole; else the host's transfer failed (DATA FAIL, a cap, the page gone):
                // refused, as ICCCM has it (no property), not an empty or partial value taken as the paste.
                let s = self.serves.remove(i);
                if s.ok {
                    self.set_property(requestor, prop, ty, 8, &s.buf);
                    self.notify(time, requestor, clip, target, prop);
                } else {
                    self.notify(time, requestor, clip, target, 0);
                }
            }
            Serving::Ready if s.buf.len() >= CHUNK || (s.eof && !s.buf.is_empty()) => {
                let n = s.buf.len().min(CHUNK);
                let value: Vec<u8> = s.buf.drain(..n).collect();
                s.state = Serving::Waiting;
                self.set_property(requestor, prop, ty, 8, &value);
            }
            Serving::Ready if s.eof => {
                // The end: an empty value (a failed transfer's too: INCR has no way to say so once it began). The
                // requestor's PropertyNotify stays selected while another INCR serve to it goes on (the mask is per
                // window).
                self.serves.remove(i);
                self.set_property(requestor, prop, ty, 8, &[]);
                if !self
                    .serves
                    .iter()
                    .any(|s| s.requestor == requestor && s.state != Serving::Collect)
                {
                    self.select_property_changes(requestor, false);
                }
            }
            _ => {}
        }
    }

    /// Serve `serve`'s bytes came whole: its pipe's end is the value's end (else a refusal).
    pub fn served(&mut self, serve: u32) {
        if let Some(s) = self.serves.iter_mut().find(|s| s.id == serve) {
            s.ok = true;
        }
    }

    // ---- Owners that don't answer.

    /// When the next conversion's wait for its owner ends (`OWNER_WAIT`), if one waits.
    pub fn deadline(&self) -> Option<Instant> {
        self.convs
            .iter()
            .filter(|c| matches!(c.state, Conv::Asked | Conv::Waiting))
            .map(|c| c.since + OWNER_WAIT)
            .min()
    }

    /// The conversions whose owner hasn't answered for `OWNER_WAIT` by `now` end as refused (their pipes closed, their
    /// properties deleted, a TARGETS of the current offer's an offer without types); the queued ones start.
    pub fn expire(&mut self, now: Instant, evs: &mut Vec<Ev>) {
        while let Some(i) = self.convs.iter().position(|c| {
            matches!(c.state, Conv::Asked | Conv::Waiting) && c.since + OWNER_WAIT <= now
        }) {
            let mut c = self.convs.remove(i);
            let (win, prop) = (self.slot_win(c.prop), c.prop);
            self.req(op::DELETE_PROPERTY, 0, None, |r| r.u32(win).u32(prop));
            c.buf.clear();
            self.finish(c, evs);
        }
        if self.ready {
            self.start();
        }
    }

    // ---- The pipes, for the child's poll.

    /// The pipes this side moves bytes through, with what each waits for.
    pub fn polls(&self) -> Vec<(BorrowedFd<'_>, PollFlags)> {
        let mut v = Vec::new();
        for c in &self.convs {
            if let Sink::Pipe(fd) = &c.sink
                && c.at < c.buf.len()
            {
                v.push((rustix::fd::AsFd::as_fd(fd), PollFlags::OUT));
            }
        }
        for s in &self.serves {
            let wants = match s.state {
                Serving::Collect => true,
                Serving::Waiting | Serving::Ready => s.buf.len() < CHUNK,
            };
            if !s.eof && wants {
                v.push((rustix::fd::AsFd::as_fd(&s.fd), PollFlags::IN));
            }
        }
        v
    }

    /// A pipe of `polls` is ready.
    pub fn pipe_ready(&mut self, fd: RawFd, evs: &mut Vec<Ev>) {
        let conv = self.convs.iter().find_map(|c| match &c.sink {
            Sink::Pipe(f) if f.as_raw_fd() == fd => Some(c.prop),
            _ => None,
        });
        if let Some(prop) = conv {
            self.pump_conv(prop, evs);
            return self.start();
        }
        if let Some(i) = self.serves.iter().position(|s| s.fd.as_raw_fd() == fd) {
            self.pump_serve(i);
        }
    }
}

fn atoms_bytes(atoms: &[u32]) -> Vec<u8> {
    atoms.iter().flat_map(|a| a.to_le_bytes()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requests_as_xcb_writes_them() {
        let mut out = Vec::new();
        // InternAtom("CLIPBOARD", only-if-exists false): 16, 0, length 2 + 3 words, the name's length, its bytes padded.
        Req::new(&mut out, op::INTERN_ATOM, 0)
            .u16(9)
            .u16(0)
            .bytes(b"CLIPBOARD")
            .done();
        assert_eq!(&out[..8], &[16, 0, 5, 0, 9, 0, 0, 0]);
        assert_eq!(&out[8..17], b"CLIPBOARD");
        assert_eq!(out.len(), 20);
        out.clear();
        // ConvertSelection(requestor 0x200001, CLIPBOARD 0x1d0, TARGETS 0x1d1, property 0x1d2, CurrentTime).
        Req::new(&mut out, op::CONVERT_SELECTION, 0)
            .u32(0x0020_0001)
            .u32(0x1d0)
            .u32(0x1d1)
            .u32(0x1d2)
            .u32(0)
            .done();
        assert_eq!(&out[..4], &[24, 0, 6, 0]);
        assert_eq!(u32_at(&out, 4), 0x0020_0001);
        assert_eq!(u32_at(&out, 16), 0x1d2);
        out.clear();
        // The setup: `l`, 11.0, the name's and the cookie's lengths, each padded.
        setup_request(Some(&[0xaa; 16]), &mut out);
        assert_eq!(&out[..12], &[b'l', 0, 11, 0, 0, 0, 18, 0, 16, 0, 0, 0]);
        assert_eq!(&out[12..30], b"MIT-MAGIC-COOKIE-1");
        assert_eq!(out.len(), 12 + 20 + 16);
        out.clear();
        setup_request(None, &mut out);
        assert_eq!(out.len(), 12);
        // A SelectionNotify for SendEvent: code 31, then time, requestor, selection, target, property.
        let e = selection_notify(7, 0x400001, 0x1d0, 0x1f, 0x1d2);
        assert_eq!(e[0], 31);
        assert_eq!(
            [
                u32_at(&e, 4),
                u32_at(&e, 8),
                u32_at(&e, 12),
                u32_at(&e, 16),
                u32_at(&e, 20)
            ],
            [7, 0x400001, 0x1d0, 0x1f, 0x1d2]
        );
    }

    /// A setup reply as Xvfb sends one: vendor "The X.Org Foundation" (20), two formats, one screen whose root is 0x3d1.
    fn setup_ok() -> Vec<u8> {
        let mut r = vec![1, 0, 11, 0, 0, 0];
        let mut body = Vec::new();
        body.extend_from_slice(&12101011u32.to_le_bytes());
        body.extend_from_slice(&0x0020_0000u32.to_le_bytes());
        body.extend_from_slice(&0x001f_ffffu32.to_le_bytes());
        body.extend_from_slice(&256u32.to_le_bytes());
        body.extend_from_slice(&20u16.to_le_bytes());
        body.extend_from_slice(&65535u16.to_le_bytes());
        body.extend_from_slice(&[1, 2, 0, 0, 32, 32, 8, 255]);
        body.extend_from_slice(&[0; 4]);
        body.extend_from_slice(b"The X.Org Foundation");
        body.extend_from_slice(&[1, 1, 32, 0, 0, 0, 0, 0, 24, 32, 32, 0, 0, 0, 0, 0]);
        body.extend_from_slice(&0x3d1u32.to_le_bytes());
        body.resize(body.len() + 36, 0);
        r.extend_from_slice(&((body.len() / 4) as u16).to_le_bytes());
        r.extend_from_slice(&body);
        r
    }

    #[test]
    fn the_setup_reply_says_the_root_and_the_request_size() {
        let r = setup_ok();
        let (s, size) = setup_reply(&r).unwrap().unwrap();
        assert_eq!(size, r.len());
        assert_eq!(
            s,
            Setup::Ok {
                root: 0x3d1,
                base: 0x0020_0000,
                mask: 0x001f_ffff,
                max_request: 4 * 65535
            }
        );
        assert!(
            setup_reply(&r[..r.len() - 1]).unwrap().is_none(),
            "incomplete"
        );
        // Failed: the reason's length in the second byte.
        let mut f = vec![0, 22, 11, 0, 0, 0, 6, 0];
        f.extend_from_slice(b"Authorization required\0\0");
        let (s, _) = setup_reply(&f).unwrap().unwrap();
        assert_eq!(s, Setup::Refused("Authorization required".into()));
        assert!(setup_reply(&[9, 0, 0, 0, 0, 0, 0, 0]).is_err());
    }

    #[test]
    fn replies_errors_and_events_split() {
        let mut buf = vec![0u8; 32];
        // A reply with 2 words more, seq 5.
        buf[0] = 1;
        buf[2] = 5;
        buf[4] = 2;
        buf.extend_from_slice(&[1, 2, 3, 4, 5, 6, 7, 8]);
        // An error (BadWindow 3, seq 6, major 18), then an event sent by SendEvent (its high bit).
        let mut err = [0u8; 32];
        err[1] = 3;
        err[2] = 6;
        err[10] = 18;
        buf.extend_from_slice(&err);
        let mut e = selection_notify(1, 2, 3, 4, 5);
        e[0] |= 0x80;
        buf.extend_from_slice(&e);
        let (m, size) = split(&buf).unwrap().unwrap();
        assert_eq!(size, 40);
        assert!(matches!(m, Msg::Reply { seq: 5, bytes } if bytes.len() == 40));
        let (m, _) = split(&buf[40..]).unwrap().unwrap();
        assert_eq!(
            m,
            Msg::Error {
                seq: 6,
                code: 3,
                major: 18
            }
        );
        let (m, _) = split(&buf[72..]).unwrap().unwrap();
        assert!(matches!(m, Msg::Event { code: 31, .. }));
        assert!(split(&buf[..39]).unwrap().is_none(), "half a reply");
        let mut huge = vec![1u8; 32];
        huge[4..8].copy_from_slice(&(2u32 << 20).to_le_bytes());
        assert!(split(&huge).is_err(), "a reply past MAX_REPLY");
    }

    #[test]
    fn a_property_reply_reads() {
        // GetProperty's reply: format 8, type 0x1f (STRING), 3 bytes after, a value of 5 bytes.
        let mut r = vec![1, 8, 0, 0, 2, 0, 0, 0];
        r.extend_from_slice(&0x1fu32.to_le_bytes());
        r.extend_from_slice(&3u32.to_le_bytes());
        r.extend_from_slice(&5u32.to_le_bytes());
        r.resize(32, 0);
        r.extend_from_slice(b"hello\0\0\0");
        assert_eq!(property(&r), Some((0x1f, 3, &b"hello"[..])));
        // Format 32: its length counts words.
        let mut a = r.clone();
        a[1] = 32;
        a[16] = 2;
        assert_eq!(property(&a).unwrap().2.len(), 8);
        // No such property: format 0, type None.
        let mut none = vec![1, 0, 0, 0, 0, 0, 0, 0];
        none.resize(32, 0);
        assert_eq!(property(&none), Some((0, 0, &b""[..])));
        assert_eq!(property(&r[..20]), None);
    }

    #[test]
    fn finds_the_users_display_and_cookie() {
        assert_eq!(display_number(":0"), Some(0));
        assert_eq!(display_number(":12.0"), Some(12));
        assert_eq!(display_number("unix:3"), Some(3));
        assert_eq!(display_number("host:0"), None);
        assert_eq!(display_number("wayland-0"), None);
        // Xvfb's command line, and a client's environment.
        let server = named(
            b"Xvfb\0:5\0-auth\0/home/u/.serverauth.77\0-nolisten\0tcp\0",
            b"HOME=/home/u\0",
        );
        assert_eq!(server.display, [5]);
        assert_eq!(server.auth, ["/home/u/.serverauth.77"]);
        let client = named(
            b"xterm\0",
            b"PATH=/bin\0DISPLAY=:1.0\0XAUTHORITY=/run/user/1000/xauth_x\0HOME=/home/u\0",
        );
        assert_eq!(
            client,
            Named {
                display: vec![1],
                auth: vec!["/run/user/1000/xauth_x".into()],
                home: Some("/home/u".into())
            }
        );
        // An argument that isn't a display, and argv[0] never counts.
        assert!(named(b":7\0--x\0", b"").display.is_empty());
        assert!(
            is_socket_name("X0")
                && is_socket_name("X12")
                && !is_socket_name("X")
                && !is_socket_name("X1.lock")
        );
    }

    fn entry(family: u16, addr: &[u8], num: &[u8], name: &[u8], data: &[u8]) -> Vec<u8> {
        let mut v = family.to_be_bytes().to_vec();
        for f in [addr, num, name, data] {
            v.extend_from_slice(&(f.len() as u16).to_be_bytes());
            v.extend_from_slice(f);
        }
        v
    }

    #[test]
    fn reads_xauthority_files() {
        let mut f = entry(256, b"otherhost", b"0", b"MIT-MAGIC-COOKIE-1", &[1; 16]);
        f.extend(entry(
            256,
            b"myhost",
            b"1",
            b"XDM-AUTHORIZATION-1",
            &[2; 16],
        ));
        f.extend(entry(256, b"myhost", b"0", b"MIT-MAGIC-COOKIE-1", &[3; 16]));
        f.extend(entry(65535, b"", b"", b"MIT-MAGIC-COOKIE-1", &[4; 16]));
        f.extend(entry(
            0,
            &[127, 0, 0, 1],
            b"2",
            b"MIT-MAGIC-COOKIE-1",
            &[5; 16],
        ));
        assert_eq!(
            xauth_cookie(&f, 0, "myhost"),
            Some(vec![3; 16]),
            "this host's first"
        );
        assert_eq!(
            xauth_cookie(&f, 0, "elsewhere"),
            Some(vec![1; 16]),
            "a local one"
        );
        assert_eq!(
            xauth_cookie(&f, 1, "myhost"),
            Some(vec![4; 16]),
            "the wild one: no cookie of its own"
        );
        assert_eq!(
            xauth_cookie(&f[..f.len() - 3], 9, "myhost"),
            Some(vec![4; 16]),
            "a cut entry ends it"
        );
        assert_eq!(xauth_cookie(&[], 0, "h"), None);
    }

    /// A listening socket `X<n>` in a directory of the test's own, and the directory.
    fn listener(name: &str, n: u32) -> (std::os::unix::net::UnixListener, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("waarm64-agent-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir(&dir).unwrap();
        let l = std::os::unix::net::UnixListener::bind(dir.join(format!("X{n}"))).unwrap();
        (l, dir)
    }

    #[test]
    fn only_roots_or_the_users_display_socket_gets_the_cookie() {
        let me = rustix::process::getuid().as_raw();
        let (_l, dir) = listener("x11owner", 3);
        let d = dir.to_str().unwrap();
        assert!(
            X::connect(d, 3, Some(&[7; 16]), me, Jobs::default()).is_ok(),
            "the user's own"
        );
        assert!(
            X::connect(d, 3, Some(&[7; 16]), me + 1, Jobs::default()).is_err(),
            "another user's socket, bound first in the world-writable directory"
        );
        let sock = mode_of(rustix::fs::FileType::Socket);
        assert!(trusted_socket(sock, 0, 1000), "Xorg's: root's");
        assert!(!trusted_socket(sock, 1001, 1000));
        assert!(
            !trusted_socket(mode_of(rustix::fs::FileType::RegularFile), 1000, 1000),
            "not a socket"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn mode_of(t: rustix::fs::FileType) -> u32 {
        t.as_raw_mode() | 0o755
    }

    #[test]
    fn a_long_targets_list_keeps_the_types_we_know() {
        let me = rustix::process::getuid().as_raw();
        let (_l, dir) = listener("x11targets", 4);
        let mut x = X::connect(
            dir.to_str().unwrap(),
            4,
            None,
            me,
            Jobs {
                clip: true,
                resize: false,
                desktop: false,
                keymap: false,
            },
        )
        .unwrap();
        for (i, a) in x.atoms.iter_mut().enumerate() {
            *a = 0x100 + i as u32;
        }
        (x.ready, x.owner, x.offer) = (true, 0x0040_0001, 5);
        let prop = x.atom(PROP0);
        x.convs.push(Conversion {
            prop,
            owner: x.owner,
            target: x.atom(TARGETS),
            since: Instant::now(),
            sink: Sink::Targets(5),
            state: Conv::Reading,
            incr: false,
            offset: 0,
            buf: Vec::new(),
            at: 0,
        });
        // GetProperty's reply: 70 atoms (format 32, type ATOM), UTF8_STRING the 6th, image/png the 69th, the rest
        // ones we don't know (a GTK owner's pixbuf formats).
        let mut atoms: Vec<u32> = (0..70).map(|i| 0x9000 + i).collect();
        atoms[5] = x.atom(UTF8_STRING);
        atoms[68] = x.atom(PNG);
        let mut r = vec![1, 32, 0, 0];
        r.extend_from_slice(&(atoms.len() as u32).to_le_bytes());
        r.extend_from_slice(&x.atom(ATOM).to_le_bytes());
        r.extend_from_slice(&0u32.to_le_bytes());
        r.extend_from_slice(&(atoms.len() as u32).to_le_bytes());
        r.resize(32, 0);
        r.extend(atoms_bytes(&atoms));
        let mut evs = Vec::new();
        x.got_property(prop, &r, &mut evs);
        let types = evs.iter().find_map(|e| match e {
            Ev::Selection { offer: 5, types } => Some(types.clone()),
            _ => None,
        });
        assert_eq!(
            types.as_deref(),
            Some(&["UTF8_STRING".to_owned(), "image/png".to_owned()][..])
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_sessions_display_is_the_hinted_one_else_a_users_process_names_it() {
        let dir = std::env::temp_dir().join(format!("waarm64-agent-x11dir-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir(&dir).unwrap();
        for n in ["X0", "X3", "X10", "X1-lock"] {
            std::fs::write(dir.join(n), b"").unwrap();
        }
        let d = dir.to_str().unwrap();
        let procs = [named(b"Xvfb\0:3\0", b""), named(b"sh\0", b"DISPLAY=:10\0")];
        assert_eq!(displays(d, None, &procs), [3, 10]);
        assert_eq!(
            displays(d, Some(0), &procs),
            [0],
            "the session file's DISPLAY: that one only"
        );
        assert_eq!(displays(d, Some(4), &procs), Vec::<u32>::new());
        assert_eq!(
            displays(d, None, &[]),
            Vec::<u32>::new(),
            "nobody's: not the user's"
        );
        // The processes under a /proc of the test's own: the user's (the test's uid) read, with their displays.
        let proc = dir.join("proc");
        for (pid, cmd, env) in [
            ("12", &b"Xvfb\0:3\0-auth\0/a\0"[..], &b""[..]),
            ("13", b"sh\0", b"HOME=/h\0"),
            ("x", b"Xvfb\0:4\0", b""),
        ] {
            std::fs::create_dir_all(proc.join(pid)).unwrap();
            std::fs::write(proc.join(pid).join("cmdline"), cmd).unwrap();
            std::fs::write(proc.join(pid).join("environ"), env).unwrap();
        }
        let uid = rustix::process::getuid().as_raw();
        let p = processes(proc.to_str().unwrap(), uid);
        assert_eq!(p.len(), 1, "the one that names a display, by a pid's name");
        assert_eq!(p[0].auth, ["/a"]);
        assert!(
            processes(proc.to_str().unwrap(), uid + 1).is_empty(),
            "another user's"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
