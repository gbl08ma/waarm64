//! A DERP client over a byte stream (one WebSocket here), sans I/O: the
//! caller hands it what the server sent and sends what it returns. The
//! protocol follows Tailscale's `derp` package (the frame types are also in
//! tailscale-rs's `ts_derp::frame`): a 5-byte header (type, big-endian length)
//! per frame; the server's key first, our client info (sealed to it with a
//! NaCl box), the server's info back, then packets.

use crypto_box::{PublicKey, SalsaBox, SecretKey, aead::Aead};

const MAGIC: &[u8; 8] = b"DERP\xF0\x9F\x94\x91";
const MAX_FRAME: usize = 1 << 16 | 1 << 10; // a packet plus its key, with room to spare

const SERVER_KEY: u8 = 0x01;
const CLIENT_INFO: u8 = 0x02;
const SERVER_INFO: u8 = 0x03;
const SEND_PACKET: u8 = 0x04;
const RECV_PACKET: u8 = 0x05;
const KEEP_ALIVE: u8 = 0x06;
const NOTE_PREFERRED: u8 = 0x07;
const PEER_GONE: u8 = 0x08;
const PEER_PRESENT: u8 = 0x09;
const PING: u8 = 0x12;
const PONG: u8 = 0x13;
const HEALTH: u8 = 0x14;
const RESTARTING: u8 = 0x15;

#[derive(Debug, PartialEq)]
pub enum Event {
    /// The handshake is done: packets can go.
    Ready,
    /// A packet from `src` (a node key).
    Recv { src: [u8; 32], packet: Vec<u8> },
    /// A peer we sent to left this server.
    PeerGone([u8; 32]),
    /// The server's health message ("" when healthy again).
    Health(String),
    /// The server is restarting: reconnect after `reconnect_ms`.
    Restarting { reconnect_ms: u32 },
}

pub struct Conn {
    private: [u8; 32],
    public: [u8; 32],
    preferred: bool,
    server: Option<[u8; 32]>,
    ready: bool,
    buf: Vec<u8>,
    out: Vec<Vec<u8>>,
}

fn frame(t: u8, parts: &[&[u8]]) -> Vec<u8> {
    let len: usize = parts.iter().map(|p| p.len()).sum();
    let mut f = Vec::with_capacity(5 + len);
    f.push(t);
    f.extend_from_slice(&(len as u32).to_be_bytes());
    for p in parts {
        f.extend_from_slice(p);
    }
    f
}

impl Conn {
    /// A connection for the node with key pair (`private`, `public`); `preferred`
    /// tells the server it is our home region.
    pub fn new(private: [u8; 32], public: [u8; 32], preferred: bool) -> Self {
        Conn {
            private,
            public,
            preferred,
            server: None,
            ready: false,
            buf: Vec::new(),
            out: Vec::new(),
        }
    }

    pub fn is_ready(&self) -> bool {
        self.ready
    }

    /// Frames to send to the server (the caller may join them: the server reads a stream).
    pub fn take_output(&mut self) -> Vec<Vec<u8>> {
        std::mem::take(&mut self.out)
    }

    /// Queues `packet` for the node with key `dst`. Before the handshake is
    /// done there is nowhere to send it: false.
    pub fn send(&mut self, dst: &[u8; 32], packet: &[u8]) -> bool {
        if !self.ready || packet.len() > MAX_FRAME - 32 {
            return false;
        }
        self.out.push(frame(SEND_PACKET, &[dst, packet]));
        true
    }

    /// Takes bytes from the server. An error means the connection is unusable.
    pub fn input(&mut self, bytes: &[u8]) -> Result<Vec<Event>, String> {
        self.buf.extend_from_slice(bytes);
        let mut events = Vec::new();
        let mut at = 0;
        if self.server.is_none() && self.buf.first().is_some_and(|&t| t != SERVER_KEY) {
            return Err("not a DERP server (no server key)".into());
        }
        while self.buf.len() - at >= 5 {
            let t = self.buf[at];
            let len = u32::from_be_bytes(self.buf[at + 1..at + 5].try_into().unwrap()) as usize;
            if len > MAX_FRAME {
                return Err(format!("DERP frame of {len} bytes"));
            }
            if self.buf.len() - at - 5 < len {
                break;
            }
            let body = self.buf[at + 5..at + 5 + len].to_vec();
            at += 5 + len;
            self.frame(t, &body, &mut events)?;
        }
        self.buf.drain(..at);
        Ok(events)
    }

    fn frame(&mut self, t: u8, b: &[u8], events: &mut Vec<Event>) -> Result<(), String> {
        let Some(server) = self.server else {
            if t != SERVER_KEY || b.len() < 40 || &b[..8] != MAGIC {
                return Err("not a DERP server (no server key)".into());
            }
            let server: [u8; 32] = b[8..40].try_into().unwrap();
            self.server = Some(server);
            let sealed = SalsaBox::new(&PublicKey::from(server), &SecretKey::from(self.private));
            let mut nonce = [0u8; 24];
            getrandom::fill(&mut nonce).map_err(|e| format!("no randomness: {e}"))?;
            let info = sealed
                .encrypt(&nonce.into(), &br#"{"version":2}"#[..])
                .map_err(|_| "sealing the DERP client info")?;
            self.out
                .push(frame(CLIENT_INFO, &[&self.public, &nonce, &info]));
            return Ok(());
        };
        match t {
            SERVER_INFO if !self.ready => {
                if b.len() < 24 {
                    return Err("short DERP server info".into());
                }
                let sealed =
                    SalsaBox::new(&PublicKey::from(server), &SecretKey::from(self.private));
                let nonce: [u8; 24] = b[..24].try_into().unwrap();
                sealed.decrypt(&nonce.into(), &b[24..]).map_err(
                    |_| "the DERP server info doesn't open: the server isn't who it said",
                )?;
                self.ready = true;
                if self.preferred {
                    self.out.push(frame(NOTE_PREFERRED, &[&[1]]));
                }
                events.push(Event::Ready);
            }
            RECV_PACKET if b.len() >= 32 => events.push(Event::Recv {
                src: b[..32].try_into().unwrap(),
                packet: b[32..].to_vec(),
            }),
            PING if b.len() >= 8 => self.out.push(frame(PONG, &[&b[..8]])),
            PEER_GONE if b.len() >= 32 => events.push(Event::PeerGone(b[..32].try_into().unwrap())),
            HEALTH => events.push(Event::Health(String::from_utf8_lossy(b).into_owned())),
            RESTARTING if b.len() >= 4 => events.push(Event::Restarting {
                reconnect_ms: u32::from_be_bytes(b[..4].try_into().unwrap()),
            }),
            KEEP_ALIVE | PONG | PEER_PRESENT => {}
            _ => {} // frames newer than us are ignored, as Go's client does
        }
        Ok(())
    }
}

#[cfg(test)]
pub(crate) mod testserver {
    use crypto_box::aead::AeadCore;

    use super::*;

    /// A DERP server for one client, enough for the tests: it sends its key,
    /// opens the client info, answers with its info and relays packets back
    /// to the client as if they came from `dst`.
    pub struct Server {
        pub private: [u8; 32],
        pub public: [u8; 32],
        pub client: Option<[u8; 32]>,
        buf: Vec<u8>,
    }

    impl Server {
        pub fn new(private: [u8; 32]) -> Self {
            let public = *SecretKey::from(private).public_key().as_bytes();
            Server {
                private,
                public,
                client: None,
                buf: Vec::new(),
            }
        }
        pub fn hello(&self) -> Vec<u8> {
            frame(SERVER_KEY, &[MAGIC, &self.public])
        }
        /// Frames for the client in reply to what it sent; `sent` collects its packets.
        pub fn input(&mut self, bytes: &[u8], sent: &mut Vec<([u8; 32], Vec<u8>)>) -> Vec<Vec<u8>> {
            self.buf.extend_from_slice(bytes);
            let mut out = Vec::new();
            while self.buf.len() >= 5 {
                let len = u32::from_be_bytes(self.buf[1..5].try_into().unwrap()) as usize;
                if self.buf.len() < 5 + len {
                    break;
                }
                let f: Vec<u8> = self.buf.drain(..5 + len).collect();
                let b = &f[5..];
                match f[0] {
                    CLIENT_INFO => {
                        let client: [u8; 32] = b[..32].try_into().unwrap();
                        let open =
                            SalsaBox::new(&PublicKey::from(client), &SecretKey::from(self.private));
                        let nonce: [u8; 24] = b[32..56].try_into().unwrap();
                        let info = open.decrypt(&nonce.into(), &b[56..]).unwrap();
                        assert_eq!(info, br#"{"version":2}"#);
                        self.client = Some(client);
                        let n = SalsaBox::generate_nonce(&mut crypto_box::aead::OsRng);
                        let sealed = open.encrypt(&n, &br#"{"version":2}"#[..]).unwrap();
                        out.push(frame(SERVER_INFO, &[&n, &sealed]));
                    }
                    SEND_PACKET => sent.push((b[..32].try_into().unwrap(), b[32..].to_vec())),
                    _ => {}
                }
            }
            out
        }
        pub fn deliver(&self, src: &[u8; 32], packet: &[u8]) -> Vec<u8> {
            frame(RECV_PACKET, &[src, packet])
        }
    }
}

#[cfg(test)]
mod tests {
    use crypto_box::aead::AeadCore;

    use super::{testserver::Server, *};

    fn keys(seed: u8) -> ([u8; 32], [u8; 32]) {
        let private = [seed; 32];
        (private, *SecretKey::from(private).public_key().as_bytes())
    }

    #[test]
    fn handshake_and_packets() {
        let (cp, cpub) = keys(1);
        let mut c = Conn::new(cp, cpub, true);
        let mut s = Server::new([2; 32]);
        let mut sent = Vec::new();
        // The server's key arrives split across messages.
        let hello = s.hello();
        assert_eq!(c.input(&hello[..7]).unwrap(), vec![]);
        assert_eq!(c.input(&hello[7..]).unwrap(), vec![]);
        assert!(!c.send(&[9; 32], b"early"));
        let mut replies = Vec::new();
        for m in c.take_output() {
            replies.extend(s.input(&m, &mut sent));
        }
        assert_eq!(s.client, Some(cpub));
        assert_eq!(c.input(&replies.concat()).unwrap(), vec![Event::Ready]);
        // NotePreferred went out with the handshake's end.
        assert_eq!(c.take_output(), vec![vec![NOTE_PREFERRED, 0, 0, 0, 1, 1]]);
        assert!(c.send(&[9; 32], b"hi"));
        for m in c.take_output() {
            s.input(&m, &mut sent);
        }
        assert_eq!(sent, vec![([9; 32], b"hi".to_vec())]);
        let two = [
            s.deliver(&[7; 32], b"a"),
            s.deliver(&[8; 32], b"bc"),
            frame(PING, &[&[5; 8]]),
        ]
        .concat();
        assert_eq!(
            c.input(&two).unwrap(),
            vec![
                Event::Recv {
                    src: [7; 32],
                    packet: b"a".to_vec()
                },
                Event::Recv {
                    src: [8; 32],
                    packet: b"bc".to_vec()
                }
            ]
        );
        assert_eq!(c.take_output(), vec![frame(PONG, &[&[5; 8]])]);
    }

    #[test]
    fn rejects_a_non_derp_server() {
        let (cp, cpub) = keys(1);
        assert!(
            Conn::new(cp, cpub, false)
                .input(b"HTTP/1.1 200 OK\r\n")
                .is_err()
        );
    }

    #[test]
    fn rejects_a_server_that_cant_open_the_box() {
        let (cp, cpub) = keys(1);
        let mut c = Conn::new(cp, cpub, false);
        let s = Server::new([2; 32]);
        c.input(&s.hello()).unwrap();
        c.take_output();
        // Server info sealed by a different key.
        let other = SalsaBox::new(&PublicKey::from(cpub), &SecretKey::from([3; 32]));
        let n = SalsaBox::generate_nonce(&mut crypto_box::aead::OsRng);
        let sealed = other.encrypt(&n, &b"{}"[..]).unwrap();
        assert!(c.input(&frame(SERVER_INFO, &[&n, &sealed])).is_err());
    }
}
