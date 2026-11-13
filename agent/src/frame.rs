//! The agent's frames (docs/plans/clipboard.md §2), the Rust twin of `web/agent-frame.ts`: a u32 length (little-endian,
//! the bytes after it: the type and the payload), a u8 type, then the payload. Both files define the same types, the
//! same payloads and the same version; `tests/agent.test.ts` and this module's tests pin the same bytes.

use crate::prelude::*;
/// Version and capabilities: each side's first frame (the agent's answers the page's).
pub const HELLO: u8 = 1;
/// A serial number and the MIME types a side's clipboard has (`Offer`).
pub const OFFER: u8 = 2;
/// A serial number, a request id and a type: the bytes of an offer, please (`Request`).
pub const REQUEST: u8 = 3;
/// A request id and bytes: an answer to a request, in chunks of at most `CHUNK` (`data`).
pub const DATA: u8 = 4;
/// UTF-8 text to paste on the guest's foreground console.
pub const TYPE: u8 = 5;
/// The toolbar's switch: stop sharing until RESUME.
pub const PAUSE: u8 = 6;
pub const RESUME: u8 = 7;
/// A serial number and a status: what the agent did with the page's offer (`ack`).
pub const ACK: u8 = 8;
/// A request id and a count: how many more DATA frames the requester takes (`more`; 0 stops the answer).
pub const MORE: u8 = 9;
// 10 was SYNC (a stream begun afresh after a restore, over the virtio-console the agent had before vsock): unused.
/// The agent's: the guest's clipboard changed hands (a session child started or stopped, or its compositor came or
/// went); the page forgets what it knew of it and the transfers of the one before.
pub const SESSION: u8 = 11;
/// The agent's: a u8 status (`typed`), what became of TYPE's text: typed whole once the agent has nothing left to
/// type, or why it (or the rest of it) wasn't.
pub const TYPED: u8 = 12;
/// The page's: the host's wall clock (`time`), for the guest's (the agent sets it: after a restore, a pause, the
/// host's own sleep).
pub const TIME: u8 = 13;
/// The page's: the size of its screen (`display`), which the guest's session is to take (the session child sets its
/// compositor's outputs, or the X server's, to it).
pub const DISPLAY: u8 = 14;

/// The largest payload: 64 KiB of data and room for a DATA frame's own fields.
pub const MAX_PAYLOAD: usize = 65536 + 256;
/// The length field's size.
const LEN: usize = 4;

/// The most bytes in a DATA frame.
pub const CHUNK: usize = 65536;
/// The DATA frames an answer may send before the requester's first MORE: what a REQUEST grants.
pub const CREDIT: u32 = 4;

/// The protocol's version: what a HELLO says. A side speaks the lower of the two versions; a newer version only adds
/// frame types, capabilities and fields at a payload's end, which an older side ignores.
pub const VERSION: u16 = 1;

/// HELLO's capability bits: what a side can do. Bits it doesn't know are ignored.
pub mod cap {
    /// TYPE: text pasted on the foreground text console (the agent), or a page that sends it.
    pub const TYPE: u32 = 1 << 0;
    /// The clipboard's text: OFFER, REQUEST, DATA, ACK, MORE.
    pub const TEXT: u32 = 1 << 1;
    /// Images in the clipboard's frames: `image/png` from the page, the guest programs' image types to it.
    pub const IMAGE: u32 = 1 << 2;
    /// TIME: the guest's clock set from the host's (the agent), or a page that sends it.
    pub const TIME: u32 = 1 << 4;
    /// DISPLAY: the session's screen follows the page's size (the agent), or a page that sends it.
    pub const DISPLAY: u32 = 1 << 5;
    // Reserved: 1 << 3 text/html, 1 << 8 a Wayland session, 1 << 9 an X11 session.
}

/// OFFER's flag: the rest of the payload is the first type's bytes, whole.
pub const OFFER_INLINE: u8 = 1 << 0;
/// DATA's flags: the answer's last frame; the answer failed (what came before it is to be dropped).
pub const DATA_END: u8 = 1 << 0;
pub const DATA_FAIL: u8 = 1 << 1;
/// A size an offer doesn't know.
pub const UNKNOWN: u32 = u32::MAX;

/// ACK's statuses.
pub mod ack {
    /// The guest's clipboard holds the offer.
    pub const HELD: u8 = 0;
    /// No session with a clipboard the agent can reach (none active, no display, no data-control).
    pub const NO_SESSION: u8 = 1;
    pub const PAUSED: u8 = 2;
    /// Past the size cap.
    pub const TOO_LARGE: u8 = 3;
    /// No type the agent takes.
    pub const NO_TYPE: u8 = 4;
}

/// TYPED's statuses.
pub mod typed {
    /// All of it typed: the agent has nothing left to type.
    pub const DONE: u8 = 0;
    /// The foreground console shows graphics (a compositor runs on it), not text: dropped (its shell would run the
    /// lines once the compositor ends).
    pub const NOT_TEXT: u8 = 1;
    /// The console can't be opened or refused the bytes.
    pub const REFUSED: u8 = 2;
    /// The console's reader stopped taking bytes, or too much was queued: the rest dropped.
    pub const DROPPED: u8 = 3;
}

/// A HELLO's payload: u16 version, u32 capabilities (little-endian); later versions append fields.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Hello {
    pub version: u16,
    pub caps: u32,
}

impl Hello {
    pub fn encode(&self) -> [u8; 6] {
        let mut b = [0; 6];
        b[..2].copy_from_slice(&self.version.to_le_bytes());
        b[2..].copy_from_slice(&self.caps.to_le_bytes());
        b
    }

    /// None if the payload is too short to be a HELLO.
    pub fn decode(p: &[u8]) -> Option<Hello> {
        let mut r = Fields(p);
        Some(Hello {
            version: u16::from_le_bytes(r.take(2)?.try_into().ok()?),
            caps: r.u32()?,
        })
    }
}

/// The agent's answer to the page's HELLO `payload`: its own HELLO; nothing if the payload isn't a HELLO.
pub fn hello_answer(payload: &[u8], caps: u32, out: &mut Vec<u8>) {
    if Hello::decode(payload).is_none() {
        return;
    }
    encode(
        HELLO,
        &Hello {
            version: VERSION,
            caps,
        }
        .encode(),
        out,
    );
}

/// DISPLAY's payload: u32 width, u32 height (the guest's pixels); None if short or empty.
pub fn decode_display(p: &[u8]) -> Option<(u32, u32)> {
    let mut r = Fields(p);
    let (w, h) = (r.u32()?, r.u32()?);
    (w > 0 && h > 0).then_some((w, h))
}

/// TIME's payload: u64 nanoseconds since the Unix epoch, the host's wall clock as the page sent it; None if short.
pub fn decode_time(p: &[u8]) -> Option<u64> {
    Some(u64::from_le_bytes(p.get(..8)?.try_into().ok()?))
}

/// An OFFER's payload: u32 serial, u8 flags (`OFFER_INLINE`), u8 count, then for each type a u8 length, the type
/// (ASCII) and a u32 size (`UNKNOWN`); with `OFFER_INLINE`, the rest is the first type's bytes, whole.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Offer<'a> {
    pub serial: u32,
    pub types: Vec<(&'a str, u32)>,
    pub inline: Option<&'a [u8]>,
}

impl<'a> Offer<'a> {
    pub fn encode(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&self.serial.to_le_bytes());
        out.push(if self.inline.is_some() {
            OFFER_INLINE
        } else {
            0
        });
        out.push(self.types.len() as u8);
        for (t, size) in &self.types {
            out.push(t.len() as u8);
            out.extend_from_slice(t.as_bytes());
            out.extend_from_slice(&size.to_le_bytes());
        }
        if let Some(b) = self.inline {
            out.extend_from_slice(b);
        }
    }

    pub fn decode(p: &'a [u8]) -> Option<Offer<'a>> {
        let mut r = Fields(p);
        let serial = r.u32()?;
        let flags = r.u8()?;
        let n = r.u8()?;
        let mut types = Vec::with_capacity(n as usize);
        for _ in 0..n {
            let t = r.str()?;
            types.push((t, r.u32()?));
        }
        let inline = (flags & OFFER_INLINE != 0).then_some(r.0);
        Some(Offer {
            serial,
            types,
            inline,
        })
    }
}

/// A REQUEST's payload: u32 serial, u32 id (the requester's: its answer's DATA and MORE carry it), u8 length, the
/// type.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Request<'a> {
    pub serial: u32,
    pub id: u32,
    pub mime: &'a str,
}

impl<'a> Request<'a> {
    pub fn encode(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&self.serial.to_le_bytes());
        out.extend_from_slice(&self.id.to_le_bytes());
        out.push(self.mime.len() as u8);
        out.extend_from_slice(self.mime.as_bytes());
    }

    pub fn decode(p: &'a [u8]) -> Option<Request<'a>> {
        let mut r = Fields(p);
        Some(Request {
            serial: r.u32()?,
            id: r.u32()?,
            mime: r.str()?,
        })
    }
}

/// A DATA frame's payload: u32 id, u8 flags (`DATA_END`, `DATA_FAIL`), then at most `CHUNK` bytes.
pub fn data(id: u32, flags: u8, bytes: &[u8], out: &mut Vec<u8>) {
    out.extend_from_slice(&id.to_le_bytes());
    out.push(flags);
    out.extend_from_slice(bytes);
}

/// A DATA frame's id, flags and bytes.
pub fn decode_data(p: &[u8]) -> Option<(u32, u8, &[u8])> {
    let mut r = Fields(p);
    Some((r.u32()?, r.u8()?, r.0))
}

/// ACK's payload: u32 serial (the page's offer), u8 status (`ack`).
pub fn ack(serial: u32, status: u8) -> [u8; 5] {
    let mut b = [0; 5];
    b[..4].copy_from_slice(&serial.to_le_bytes());
    b[4] = status;
    b
}

#[cfg(test)] // the agent only sends ACK
pub fn decode_ack(p: &[u8]) -> Option<(u32, u8)> {
    let mut r = Fields(p);
    Some((r.u32()?, r.u8()?))
}

/// MORE's payload: u32 id (the requester's), u32 count.
pub fn more(id: u32, n: u32) -> [u8; 8] {
    let mut b = [0; 8];
    b[..4].copy_from_slice(&id.to_le_bytes());
    b[4..].copy_from_slice(&n.to_le_bytes());
    b
}

pub fn decode_more(p: &[u8]) -> Option<(u32, u32)> {
    let mut r = Fields(p);
    Some((r.u32()?, r.u32()?))
}

/// A payload read field by field (little-endian); None past its end.
struct Fields<'a>(&'a [u8]);

impl<'a> Fields<'a> {
    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        if self.0.len() < n {
            return None;
        }
        let (a, b) = self.0.split_at(n);
        self.0 = b;
        Some(a)
    }
    fn u8(&mut self) -> Option<u8> {
        Some(self.take(1)?[0])
    }
    fn u32(&mut self) -> Option<u32> {
        Some(u32::from_le_bytes(self.take(4)?.try_into().ok()?))
    }
    /// A u8 length, then that many bytes of UTF-8.
    fn str(&mut self) -> Option<&'a str> {
        let n = self.u8()? as usize;
        core::str::from_utf8(self.take(n)?).ok()
    }
}

/// Appends a frame to `out`; false (nothing appended) past `MAX_PAYLOAD`.
pub fn encode(kind: u8, payload: &[u8], out: &mut Vec<u8>) -> bool {
    if payload.len() > MAX_PAYLOAD {
        return false;
    }
    out.extend_from_slice(&(1 + payload.len() as u32).to_le_bytes());
    out.push(kind);
    out.extend_from_slice(payload);
    true
}

/// Appends a frame whose payload `f` writes in place (no copy of the payload); false (nothing appended) past
/// `MAX_PAYLOAD`.
pub fn encode_with(kind: u8, out: &mut Vec<u8>, f: impl FnOnce(&mut Vec<u8>)) -> bool {
    let at = out.len();
    out.extend_from_slice(&[0; LEN]);
    out.push(kind);
    f(out);
    let len = out.len() - at - LEN;
    if len - 1 > MAX_PAYLOAD {
        out.truncate(at);
        return false;
    }
    out[at..at + LEN].copy_from_slice(&(len as u32).to_le_bytes());
    true
}

/// Cuts a byte stream into frames, whatever pieces it arrives in. A length that can't be a frame's (zero, or past
/// `MAX_PAYLOAD`) means the stream is out of step: the reader is broken and drops everything (the agent then reopens
/// the port with a new reader, which starts both directions afresh: web/app/agent-link.ts resets at each opening).
#[derive(Default)]
pub struct Reader {
    buf: Vec<u8>,
    broken: bool,
}

impl Reader {
    /// Calls `f` with each frame (type, payload) that `bytes` completes.
    pub fn push(&mut self, bytes: &[u8], mut f: impl FnMut(u8, &[u8])) {
        if self.broken {
            return;
        }
        self.buf.extend_from_slice(bytes);
        let mut at = 0;
        while self.buf.len() - at >= LEN {
            let len = u32::from_le_bytes(self.buf[at..at + LEN].try_into().unwrap()) as usize;
            if !(1..=MAX_PAYLOAD + 1).contains(&len) {
                self.broken = true;
                self.buf = Vec::new();
                return;
            }
            if self.buf.len() - at < LEN + len {
                break;
            }
            f(self.buf[at + LEN], &self.buf[at + LEN + 1..at + LEN + len]);
            at += LEN + len;
        }
        self.buf.drain(..at);
        // An idle agent holds no frame's worth of memory (plan §3.3: VmRSS).
        if self.buf.is_empty() && self.buf.capacity() > 4096 {
            self.buf = Vec::new();
        }
    }

    pub fn broken(&self) -> bool {
        self.broken
    }

    /// Bytes of a frame not yet complete.
    #[cfg(test)]
    pub fn pending(&self) -> usize {
        self.buf.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frames(r: &mut Reader, bytes: &[u8]) -> Vec<(u8, Vec<u8>)> {
        let mut out = Vec::new();
        r.push(bytes, |t, p| out.push((t, p.to_vec())));
        out
    }

    #[test]
    fn encodes_as_the_page_does() {
        // The same bytes as tests/agent.test.ts "frames: HELLO's payload".
        let mut out = Vec::new();
        assert!(encode(
            HELLO,
            &Hello {
                version: 1,
                caps: cap::TYPE
            }
            .encode(),
            &mut out
        ));
        assert_eq!(out, [7, 0, 0, 0, 1, 1, 0, 1, 0, 0, 0]);
        out.clear();
        assert!(encode(PAUSE, &[], &mut out));
        assert_eq!(out, [1, 0, 0, 0, 6]);
        assert!(!encode(DATA, &vec![0; MAX_PAYLOAD + 1], &mut out));
        assert!(encode(DATA, &vec![0; MAX_PAYLOAD], &mut out));
        out.clear();
        assert!(encode_with(ACK, &mut out, |o| o.extend_from_slice(&ack(3, ack::HELD))));
        assert_eq!(out, [6, 0, 0, 0, ACK, 3, 0, 0, 0, 0]);
        assert!(!encode_with(DATA, &mut out, |o| o
            .extend_from_slice(&vec![0; MAX_PAYLOAD + 1])));
        assert_eq!(out.len(), 10, "a frame too long: nothing appended");
    }

    #[test]
    fn clipboard_payloads_encode_as_the_page_does() {
        // The same bytes as tests/agent.test.ts "frames: the clipboard's payloads".
        let mut out = Vec::new();
        Offer {
            serial: 0x0102_0304,
            types: vec![("text/plain", 3)],
            inline: Some(b"abc"),
        }
        .encode(&mut out);
        let mut want = vec![4, 3, 2, 1, OFFER_INLINE, 1, 10];
        want.extend_from_slice(b"text/plain");
        want.extend_from_slice(&[3, 0, 0, 0]);
        want.extend_from_slice(b"abc");
        assert_eq!(out, want);
        assert_eq!(
            Offer::decode(&out),
            Some(Offer {
                serial: 0x0102_0304,
                types: vec![("text/plain", 3)],
                inline: Some(&b"abc"[..])
            })
        );
        out.clear();
        let lazy = Offer {
            serial: 9,
            types: vec![
                ("text/plain;charset=utf-8", UNKNOWN),
                ("UTF8_STRING", UNKNOWN),
            ],
            inline: None,
        };
        lazy.encode(&mut out);
        assert_eq!(Offer::decode(&out), Some(lazy));
        assert_eq!(Offer::decode(&out[..out.len() - 1]), None, "cut short");
        out.clear();
        Request {
            serial: 7,
            id: 2,
            mime: "text/plain",
        }
        .encode(&mut out);
        let mut want = vec![7, 0, 0, 0, 2, 0, 0, 0, 10];
        want.extend_from_slice(b"text/plain");
        assert_eq!(out, want);
        assert_eq!(
            Request::decode(&out),
            Some(Request {
                serial: 7,
                id: 2,
                mime: "text/plain"
            })
        );
        out.clear();
        data(5, DATA_END, b"hi", &mut out);
        assert_eq!(out, [5, 0, 0, 0, DATA_END, b'h', b'i']);
        assert_eq!(decode_data(&out), Some((5, DATA_END, &b"hi"[..])));
        assert_eq!(ack(3, ack::TOO_LARGE), [3, 0, 0, 0, 3]);
        assert_eq!(decode_ack(&[3, 0, 0, 0, 3]), Some((3, ack::TOO_LARGE)));
        assert_eq!(more(6, 1), [6, 0, 0, 0, 1, 0, 0, 0]);
        assert_eq!(decode_more(&more(6, 1)), Some((6, 1)));
        assert_eq!(decode_more(&[6, 0, 0, 0, 1]), None);
        const { assert!(5 + CHUNK <= MAX_PAYLOAD) };
    }

    #[test]
    fn answers_a_hello_and_reads_time() {
        // The same bytes as tests/agent.test.ts "frames: HELLO's answer, TIME".
        let mut out = Vec::new();
        hello_answer(&[1, 0, 3, 0, 0, 0], cap::TYPE | cap::TEXT, &mut out);
        assert_eq!(out, [7, 0, 0, 0, HELLO, 1, 0, 3, 0, 0, 0]);
        out.clear();
        hello_answer(&[1, 0, 3, 0, 0, 0, 1, 2, 3], cap::TIME, &mut out);
        assert_eq!(
            out,
            [7, 0, 0, 0, HELLO, 1, 0, 16, 0, 0, 0],
            "later fields ignored"
        );
        out.clear();
        hello_answer(&[1, 0, 3, 0, 0], 3, &mut out);
        assert!(out.is_empty(), "not a HELLO: no answer");
        assert_eq!((SESSION, TIME, cap::TIME), (11, 13, 16));
        let t = 1_763_000_000_123_456_789u64;
        assert_eq!(decode_time(&t.to_le_bytes()), Some(t));
        assert_eq!(decode_time(&[1, 2, 3]), None);
        // DISPLAY: the bytes tests/agent.test.ts "frames: TIME and SESSION" pins (1280x720; later fields ignored).
        assert_eq!((DISPLAY, cap::DISPLAY), (14, 32));
        assert_eq!(
            decode_display(&[0, 5, 0, 0, 0xd0, 2, 0, 0, 9]),
            Some((1280, 720))
        );
        assert_eq!(decode_display(&[0, 5, 0, 0, 0xd0, 2, 0]), None, "short");
        assert_eq!(decode_display(&[0; 8]), None, "no size");
        // TYPED and its statuses: the numbers tests/agent.test.ts pins.
        assert_eq!(
            (
                TYPED,
                typed::DONE,
                typed::NOT_TEXT,
                typed::REFUSED,
                typed::DROPPED
            ),
            (12, 0, 1, 2, 3)
        );
    }

    #[test]
    fn hello_round_trips_and_ignores_what_it_does_not_know() {
        let h = Hello {
            version: 3,
            caps: 0x8000_0101,
        };
        assert_eq!(Hello::decode(&h.encode()), Some(h));
        let mut longer = h.encode().to_vec();
        longer.extend_from_slice(b"a later version's field");
        assert_eq!(Hello::decode(&longer), Some(h));
        assert_eq!(Hello::decode(&[1, 0, 1, 0, 0]), None);
    }

    #[test]
    fn cuts_a_stream_in_any_pieces() {
        let mut stream = Vec::new();
        encode(TYPE, "héllo ☃\n".as_bytes(), &mut stream);
        encode(PAUSE, &[], &mut stream);
        let data: Vec<u8> = (0..65536u32).map(|k| (k * 7) as u8).collect();
        assert!(encode(DATA, &data, &mut stream));
        encode(RESUME, &[], &mut stream);
        // Frames as (type, length, a sum of the payload): a mismatch prints a short line, not 64 KiB.
        let sum = |p: &[u8]| {
            p.iter()
                .fold(7u32, |a, &x| a.wrapping_mul(31).wrapping_add(x as u32))
        };
        let want = [
            (TYPE, "héllo ☃\n".as_bytes()),
            (PAUSE, &[][..]),
            (DATA, &data[..]),
            (RESUME, &[][..]),
        ]
        .map(|(t, p)| (t, p.len(), sum(p)))
        .to_vec();
        for piece in [1, 3, 4, 5, 4096, stream.len()] {
            let mut r = Reader::default();
            let mut got = Vec::new();
            for c in stream.chunks(piece) {
                got.extend(
                    frames(&mut r, c)
                        .into_iter()
                        .map(|(t, p)| (t, p.len(), sum(&p))),
                );
            }
            assert_eq!(got, want, "in pieces of {piece}");
            assert_eq!(r.pending(), 0);
            assert!(!r.broken());
        }
    }

    #[test]
    fn a_length_out_of_step_breaks_it() {
        let mut r = Reader::default();
        assert_eq!(frames(&mut r, &[0, 0, 0, 0, 5]), vec![]);
        assert!(r.broken());
        let mut ok = Vec::new();
        encode(PAUSE, &[], &mut ok);
        assert_eq!(frames(&mut r, &ok), vec![], "broken: dropped");
        let mut r = Reader::default();
        assert_eq!(frames(&mut r, &ok), vec![(PAUSE, vec![])]);
        let mut big = ((MAX_PAYLOAD + 2) as u32).to_le_bytes().to_vec();
        big.push(DATA);
        assert_eq!(frames(&mut r, &big), vec![]);
        assert!(r.broken());
    }
}
