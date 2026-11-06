//! Wayland's wire format by hand (docs/plans/clipboard.md §3.3): no libwayland, no generated code. A message is a
//! header (u32 object id; u32 size << 16 | opcode, the size counting the header) and its arguments, each a multiple of
//! 4 bytes in the host's byte order: int, uint, object and new_id as one word; a string as u32 length (with its NUL; 0
//! for a null string), the bytes, a NUL, padding; an array as u32 length, the bytes, padding. File descriptors travel
//! beside the bytes, as SCM_RIGHTS, in the order of the messages that carry them. `Conn` holds a connection's buffers
//! both ways (src/session.rs speaks the protocol over it).

use rustix::fd::{AsFd, BorrowedFd, OwnedFd};
use rustix::io::{Errno, IoSlice, IoSliceMut};
use rustix::net::{
    RecvAncillaryBuffer, RecvAncillaryMessage, RecvFlags, SendAncillaryBuffer,
    SendAncillaryMessage, SendFlags, recvmsg, sendmsg,
};
use std::collections::VecDeque;
use std::mem::MaybeUninit;

/// libwayland's limit on a message (and so ours): its buffers are 4 KiB.
pub const MAX_MESSAGE: usize = 4096;
/// The most file descriptors one sendmsg carries (libwayland's MAX_FDS_OUT).
const MAX_FDS: usize = 28;

/// A request being written: `Msg::new` starts it at the end of `out`, `done` writes its header's size.
pub struct Msg<'a> {
    out: &'a mut Vec<u8>,
    at: usize,
    opcode: u16,
}

impl<'a> Msg<'a> {
    /// A message to `object`, opcode `opcode`.
    pub fn new(out: &'a mut Vec<u8>, object: u32, opcode: u16) -> Msg<'a> {
        let at = out.len();
        out.extend_from_slice(&object.to_ne_bytes());
        out.extend_from_slice(&[0; 4]);
        Msg { out, at, opcode }
    }

    pub fn uint(self, v: u32) -> Self {
        self.out.extend_from_slice(&v.to_ne_bytes());
        self
    }

    /// An object or a new_id: its id (0: a null object).
    pub fn object(self, id: u32) -> Self {
        self.uint(id)
    }

    /// A string (not null): its length with the NUL, the bytes, the NUL, padding to 4.
    pub fn string(self, s: &str) -> Self {
        let m = self.uint(s.len() as u32 + 1);
        m.out.extend_from_slice(s.as_bytes());
        m.out.push(0);
        m.pad()
    }

    fn pad(self) -> Self {
        while !(self.out.len() - self.at).is_multiple_of(4) {
            self.out.push(0);
        }
        self
    }

    /// Writes the header's size and opcode: the message is complete.
    pub fn done(self) {
        let size = (self.out.len() - self.at) as u32;
        debug_assert!(size as usize <= MAX_MESSAGE);
        self.out[self.at + 4..self.at + 8]
            .copy_from_slice(&(size << 16 | self.opcode as u32).to_ne_bytes());
    }
}

/// An event: its object, opcode and arguments (`Args` reads them).
#[derive(Debug, PartialEq, Eq)]
pub struct Event<'a> {
    pub object: u32,
    pub opcode: u16,
    pub args: &'a [u8],
}

/// The first message in `buf`, and its size; None while it is incomplete. Err if its size can't be (under 8, not a
/// multiple of 4, past `MAX_MESSAGE`): the stream is out of step.
pub fn split(buf: &[u8]) -> Result<Option<(Event<'_>, usize)>, ()> {
    if buf.len() < 8 {
        return Ok(None);
    }
    let object = u32::from_ne_bytes(buf[..4].try_into().unwrap());
    let word = u32::from_ne_bytes(buf[4..8].try_into().unwrap());
    let size = (word >> 16) as usize;
    if size < 8 || !size.is_multiple_of(4) || size > MAX_MESSAGE {
        return Err(());
    }
    if buf.len() < size {
        return Ok(None);
    }
    Ok(Some((
        Event {
            object,
            opcode: word as u16,
            args: &buf[8..size],
        },
        size,
    )))
}

/// An event's arguments, read in order; None past their end (a malformed message).
pub struct Args<'a>(pub &'a [u8]);

impl<'a> Args<'a> {
    pub fn uint(&mut self) -> Option<u32> {
        let w = self.0.get(..4)?;
        self.0 = &self.0[4..];
        Some(u32::from_ne_bytes(w.try_into().ok()?))
    }

    pub fn object(&mut self) -> Option<u32> {
        self.uint()
    }

    /// A string; Some(None) for a null one. Not UTF-8, or without its NUL: None.
    pub fn string(&mut self) -> Option<Option<&'a str>> {
        let n = self.uint()? as usize;
        if n == 0 {
            return Some(None);
        }
        let padded = n.div_ceil(4) * 4;
        let b = self.0.get(..padded)?;
        if b[n - 1] != 0 {
            return None;
        }
        self.0 = &self.0[padded..];
        Some(Some(core::str::from_utf8(&b[..n - 1]).ok()?))
    }
}

/// A connection to a compositor: the socket, what has come in and not been taken (bytes and descriptors), and what
/// waits to go out.
pub struct Conn {
    pub fd: OwnedFd,
    inbuf: Vec<u8>,
    fds: VecDeque<OwnedFd>,
    pub out: Vec<u8>,
    outfds: Vec<OwnedFd>,
}

impl Conn {
    pub fn new(fd: OwnedFd) -> Conn {
        Conn {
            fd,
            inbuf: Vec::new(),
            fds: VecDeque::new(),
            out: Vec::new(),
            outfds: Vec::new(),
        }
    }

    /// A descriptor for the request just written (sent with the bytes, closed here once sent).
    pub fn push_fd(&mut self, fd: OwnedFd) {
        self.outfds.push(fd);
    }

    /// Whether anything waits to go out.
    pub fn pending(&self) -> bool {
        !self.out.is_empty()
    }

    /// Sends what it can without blocking. Err: the connection failed.
    pub fn flush(&mut self) -> Result<(), Errno> {
        while !self.out.is_empty() {
            let n = self.outfds.len().min(MAX_FDS);
            let mut space = [MaybeUninit::uninit(); rustix::cmsg_space!(ScmRights(MAX_FDS))];
            let mut control = SendAncillaryBuffer::new(&mut space);
            let borrowed: Vec<BorrowedFd<'_>> =
                self.outfds[..n].iter().map(|f| f.as_fd()).collect();
            if n > 0 {
                control.push(SendAncillaryMessage::ScmRights(&borrowed));
            }
            // A message's descriptors must arrive with or before its bytes: with more than MAX_FDS waiting, send
            // only the bytes up to the end of the first message (one carries a few at most).
            let len = if self.outfds.len() > MAX_FDS {
                split(&self.out)
                    .ok()
                    .flatten()
                    .map_or(self.out.len(), |(_, s)| s)
            } else {
                self.out.len()
            };
            match sendmsg(
                &self.fd,
                &[IoSlice::new(&self.out[..len])],
                &mut control,
                SendFlags::DONTWAIT | SendFlags::NOSIGNAL,
            ) {
                Ok(sent) => {
                    drop(borrowed);
                    self.outfds.drain(..n);
                    self.out.drain(..sent);
                }
                Err(Errno::INTR) => {}
                Err(Errno::AGAIN) => return Ok(()),
                Err(e) => return Err(e),
            }
        }
        if self.out.capacity() > MAX_MESSAGE * 4 {
            self.out = Vec::new();
        }
        Ok(())
    }

    /// Reads what has arrived. Ok(false): the compositor closed the connection.
    pub fn fill(&mut self) -> Result<bool, Errno> {
        let mut buf = [0u8; MAX_MESSAGE];
        let mut space = [MaybeUninit::uninit(); rustix::cmsg_space!(ScmRights(MAX_FDS))];
        let mut control = RecvAncillaryBuffer::new(&mut space);
        let r = loop {
            match recvmsg(
                &self.fd,
                &mut [IoSliceMut::new(&mut buf)],
                &mut control,
                RecvFlags::DONTWAIT | RecvFlags::CMSG_CLOEXEC,
            ) {
                Err(Errno::INTR) => {}
                Err(Errno::AGAIN) => return Ok(true),
                other => break other?,
            }
        };
        for m in control.drain() {
            if let RecvAncillaryMessage::ScmRights(fds) = m {
                self.fds.extend(fds);
            }
        }
        if r.bytes == 0 {
            return Ok(false);
        }
        self.inbuf.extend_from_slice(&buf[..r.bytes]);
        Ok(true)
    }

    /// Calls `f` with each complete event that has arrived (and a way to take the descriptors it carries). Err: the
    /// stream is out of step.
    pub fn events(
        &mut self,
        mut f: impl FnMut(&Event<'_>, &mut VecDeque<OwnedFd>),
    ) -> Result<(), ()> {
        let mut at = 0;
        let result = loop {
            match split(&self.inbuf[at..]) {
                Ok(Some((e, size))) => {
                    f(&e, &mut self.fds);
                    at += size;
                }
                Ok(None) => break Ok(()),
                Err(()) => break Err(()),
            }
        };
        self.inbuf.drain(..at);
        if self.inbuf.is_empty() && self.inbuf.capacity() > MAX_MESSAGE * 2 {
            self.inbuf = Vec::new();
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(b: &[u8]) -> Vec<u32> {
        b.chunks(4)
            .map(|w| u32::from_ne_bytes(w.try_into().unwrap()))
            .collect()
    }

    #[test]
    fn requests_as_libwayland_writes_them() {
        let mut out = Vec::new();
        // wl_display.get_registry(new_id 2)
        Msg::new(&mut out, 1, 1).object(2).done();
        assert_eq!(words(&out), [1, 12 << 16 | 1, 2]);
        out.clear();
        // wl_registry.bind(name 7, "wl_seat", version 1, new_id 5): an untyped new_id is interface, version, id.
        Msg::new(&mut out, 2, 0)
            .uint(7)
            .string("wl_seat")
            .uint(1)
            .object(5)
            .done();
        let mut want = vec![2, 32 << 16, 7, 8];
        want.extend(words(b"wl_seat\0"));
        want.extend([1, 5]);
        assert_eq!(words(&out), want);
        out.clear();
        // Padding: a string of 4 bytes takes 8 (its NUL), one of 3 takes 4.
        Msg::new(&mut out, 9, 0).string("text").done();
        assert_eq!(out.len(), 8 + 4 + 8);
        out.clear();
        Msg::new(&mut out, 9, 0).string("abc").done();
        assert_eq!(out.len(), 8 + 4 + 4);
        assert_eq!(&out[12..], b"abc\0");
    }

    #[test]
    fn events_split_and_read() {
        let mut buf = Vec::new();
        // wl_registry.global(name 3, "zwlr_data_control_manager_v1", version 2), then half of another.
        Msg::new(&mut buf, 2, 0)
            .uint(3)
            .string("zwlr_data_control_manager_v1")
            .uint(2)
            .done();
        let first = buf.len();
        Msg::new(&mut buf, 1, 1).uint(5).done();
        let (e, size) = split(&buf).unwrap().unwrap();
        assert_eq!(size, first);
        assert_eq!((e.object, e.opcode), (2, 0));
        let mut a = Args(e.args);
        assert_eq!(a.uint(), Some(3));
        assert_eq!(a.string(), Some(Some("zwlr_data_control_manager_v1")));
        assert_eq!(a.uint(), Some(2));
        assert_eq!(a.uint(), None, "past the end");
        assert!(
            split(&buf[first..first + 6]).unwrap().is_none(),
            "half a header"
        );
        assert!(
            split(&buf[first..first + 11]).unwrap().is_none(),
            "half a message"
        );
        let (e, _) = split(&buf[first..]).unwrap().unwrap();
        assert_eq!(
            (e.object, e.opcode, e.args),
            (1, 1, &5u32.to_ne_bytes()[..])
        );
        // A null string; a string without its NUL; one that runs past the message.
        assert_eq!(Args(&0u32.to_ne_bytes()).string(), Some(None));
        let mut bad = 4u32.to_ne_bytes().to_vec();
        bad.extend_from_slice(b"abcd");
        assert_eq!(Args(&bad).string(), None);
        let mut short = 9u32.to_ne_bytes().to_vec();
        short.extend_from_slice(b"abcd");
        assert_eq!(Args(&short).string(), None);
        // Sizes that can't be: out of step.
        for size in [4u32, 10, 4100] {
            let mut m = 1u32.to_ne_bytes().to_vec();
            m.extend_from_slice(&(size << 16).to_ne_bytes());
            m.resize(4200, 0);
            assert!(split(&m).is_err(), "size {size}");
        }
    }

    #[test]
    fn a_connection_carries_bytes_and_descriptors() {
        use rustix::net::{AddressFamily, SocketFlags, SocketType, socketpair};
        let (a, b) = socketpair(
            AddressFamily::UNIX,
            SocketType::STREAM,
            SocketFlags::CLOEXEC,
            None,
        )
        .unwrap();
        let (mut a, mut b) = (Conn::new(a), Conn::new(b));
        let (r, w) = rustix::pipe::pipe().unwrap();
        // A request with a descriptor (zwlr_data_control_offer_v1.receive(mime, fd)), then one without.
        Msg::new(&mut a.out, 0xff00_0001, 0)
            .string("text/plain")
            .done();
        a.push_fd(w);
        Msg::new(&mut a.out, 1, 0).object(3).done();
        a.flush().unwrap();
        assert!(!a.pending());
        assert!(b.fill().unwrap());
        let mut got = Vec::new();
        b.events(|e, fds| {
            let fd = (e.object != 1).then(|| fds.pop_front().unwrap());
            got.push((e.object, e.opcode, fd));
        })
        .unwrap();
        assert_eq!(got.len(), 2);
        // The descriptor that came is the pipe's writing end.
        let fd = got[0].2.take().unwrap();
        rustix::io::write(&fd, b"hi").unwrap();
        drop(fd);
        let mut buf = [0u8; 4];
        assert_eq!(rustix::io::read(&r, &mut buf).unwrap(), 2);
        // The other end closes: fill says so. (Soon, not at once: a process another test forks holds a copy of `a` until
        // its exec.)
        drop(a);
        let end = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while b.fill().unwrap() {
            assert!(std::time::Instant::now() < end, "no end of the stream");
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }
}
