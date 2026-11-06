//! The agent's frames (docs/plans/clipboard.md §2), the Rust twin of `web/agent-frame.ts`: a u32 length (little-endian,
//! the bytes after it: the type and the payload), a u8 type, then the payload. Both files define the same types, the
//! same payloads and the same version; `tests/agent.test.ts` and this module's tests pin the same bytes.

/// Version and capabilities: each side's first frame (the agent's answers the page's).
pub const HELLO: u8 = 1;
/// A serial number and the MIME types a side has (step 3).
#[allow(dead_code)] // the clipboard's frames: step 3
pub const OFFER: u8 = 2;
/// A serial number and a type: the bytes of an offer, please (step 3).
#[allow(dead_code)]
pub const REQUEST: u8 = 3;
/// A serial number, a type and bytes: an answer to a request (step 3).
#[allow(dead_code)]
pub const DATA: u8 = 4;
/// UTF-8 text to paste on the guest's foreground console.
pub const TYPE: u8 = 5;
/// The toolbar's switch: stop sharing until RESUME.
pub const PAUSE: u8 = 6;
pub const RESUME: u8 = 7;

/// The largest payload: 64 KiB of data and room for a DATA frame's own fields.
pub const MAX_PAYLOAD: usize = 65536 + 256;
/// The length field's size.
const LEN: usize = 4;

/// The protocol's version: what a HELLO says. A side speaks the lower of the two versions; a newer version only adds
/// frame types, capabilities and fields at a payload's end, which an older side ignores.
pub const VERSION: u16 = 1;

/// HELLO's capability bits: what a side can do. Bits it doesn't know are ignored.
pub mod cap {
    /// TYPE: text pasted on the foreground text console (the agent), or a page that sends it.
    pub const TYPE: u32 = 1 << 0;
    // Reserved for the next steps: 1 << 1 the clipboard's text (OFFER, REQUEST, DATA), 1 << 2 images, 1 << 3
    // text/html, 1 << 8 a Wayland session, 1 << 9 an X11 session.
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
        Some(Hello {
            version: u16::from_le_bytes(p.get(..2)?.try_into().ok()?),
            caps: u32::from_le_bytes(p.get(2..6)?.try_into().ok()?),
        })
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
