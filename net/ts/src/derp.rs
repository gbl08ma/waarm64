//! A DERP client over a byte stream (one WebSocket here), sans I/O: the
//! caller hands it what the server sent and sends what it returns. The
//! protocol follows Tailscale's `derp` package (the frame types are also in
//! tailscale-rs's `ts_derp::frame`): a 5-byte header (type, big-endian length)
//! per frame; the server's key first, our client info (sealed to it with a
//! NaCl box), the server's info back, then packets.
//!
//! **Liveness.** A browser's WebSocket can stay open for minutes on a path that died (a laptop
//! that slept, a network that changed, a NAT that forgot the flow), and the server's keep-alives
//! come only every 60 s. So the connection pings the server when it has been quiet for
//! [`IDLE_PING`] (which also keeps idle-closing proxies away), and sooner when it has been sending
//! for [`ACTIVE_PING`] with nothing back; with no answer within [`PONG_WAIT`] it reports itself
//! dead, as it does when the handshake doesn't finish within [`CONNECT_WAIT`].

use std::time::{Duration, Instant};

use crypto_box::{PublicKey, SalsaBox, SecretKey, aead::Aead};

const MAGIC: &[u8; 8] = b"DERP\xF0\x9F\x94\x91";
const MAX_FRAME: usize = 1 << 16 | 1 << 10; // a packet plus its key, with room to spare

const SERVER_KEY: u8 = 0x01;

/// Whether `b`, a connection's first message, is a DERP server's key frame (its type, length and magic).
pub fn is_server_key(b: &[u8]) -> bool {
    b.len() >= 5 + 40
        && b[0] == SERVER_KEY
        && u32::from_be_bytes([b[1], b[2], b[3], b[4]]) as usize >= 40
        && &b[5..13] == MAGIC
}
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

/// How long the server may take from the WebSocket's opening to its info.
pub const CONNECT_WAIT: Duration = Duration::from_secs(10);
/// Quiet this long (nothing from the server), a ping.
pub const IDLE_PING: Duration = Duration::from_secs(25);
/// Sending this long with nothing back, a ping.
pub const ACTIVE_PING: Duration = Duration::from_secs(2);
/// A ping unanswered (nothing at all from the server) this long: the connection is dead.
pub const PONG_WAIT: Duration = Duration::from_secs(6);

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
    opened: Instant,
    /// When the server was last heard, and when we last sent it a packet.
    heard: Instant,
    sent: Option<Instant>,
    /// When our unanswered ping went out.
    ping: Option<Instant>,
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
    pub fn new(private: [u8; 32], public: [u8; 32], preferred: bool, now: Instant) -> Self {
        Conn {
            private,
            public,
            preferred,
            server: None,
            ready: false,
            buf: Vec::new(),
            out: Vec::new(),
            opened: now,
            heard: now,
            sent: None,
            ping: None,
        }
    }

    /// Checks the connection at `now`: Err if it's dead (the caller drops it and reconnects).
    /// It may queue a ping: take the output after.
    pub fn tick(&mut self, now: Instant) -> Result<(), String> {
        if !self.ready {
            return match now.saturating_duration_since(self.opened) >= CONNECT_WAIT {
                true => Err("no answer from the relay".into()),
                false => Ok(()),
            };
        }
        if let Some(at) = self.ping {
            if now.saturating_duration_since(at) >= PONG_WAIT {
                return Err("the relay stopped answering".into());
            }
            return Ok(());
        }
        if self.ping_due().is_some_and(|t| t <= now) {
            let mut id = [0u8; 8];
            getrandom::fill(&mut id).map_err(|e| format!("no randomness: {e}"))?;
            self.out.push(frame(PING, &[&id]));
            self.ping = Some(now);
        }
        Ok(())
    }

    /// Sending for [`ACTIVE_PING`] with nothing back, or quiet for [`IDLE_PING`].
    fn ping_due(&self) -> Option<Instant> {
        let idle = self.heard + IDLE_PING;
        Some(match self.sent.filter(|s| *s > self.heard) {
            Some(s) => idle.min(s + ACTIVE_PING),
            None => idle,
        })
    }

    /// When [`Conn::tick`] must run next.
    pub fn deadline(&self) -> Option<Instant> {
        if !self.ready {
            return Some(self.opened + CONNECT_WAIT);
        }
        match self.ping {
            Some(at) => Some(at + PONG_WAIT),
            None => self.ping_due(),
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
    pub fn send(&mut self, dst: &[u8; 32], packet: &[u8], now: Instant) -> bool {
        if !self.ready || packet.len() > MAX_FRAME - 32 {
            return false;
        }
        self.out.push(frame(SEND_PACKET, &[dst, packet]));
        if self.sent.is_none_or(|s| s <= self.heard) {
            self.sent = Some(now);
        }
        true
    }

    /// Takes bytes from the server. An error means the connection is unusable.
    pub fn input(&mut self, bytes: &[u8], now: Instant) -> Result<Vec<Event>, String> {
        // Anything at all from the server says the path works.
        self.heard = now;
        self.ping = None;
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
                    PING => out.push(frame(PONG, &[b])),
                    _ => {}
                }
            }
            out
        }
        pub fn deliver(&self, src: &[u8; 32], packet: &[u8]) -> Vec<u8> {
            frame(RECV_PACKET, &[src, packet])
        }
        pub fn peer_gone(&self, key: &[u8; 32]) -> Vec<u8> {
            frame(PEER_GONE, &[key, &[0]])
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
        let now = Instant::now();
        let mut c = Conn::new(cp, cpub, true, now);
        let mut s = Server::new([2; 32]);
        let mut sent = Vec::new();
        // The server's key arrives split across messages.
        let hello = s.hello();
        assert_eq!(c.input(&hello[..7], now).unwrap(), vec![]);
        assert_eq!(c.input(&hello[7..], now).unwrap(), vec![]);
        assert!(!c.send(&[9; 32], b"early", now));
        let mut replies = Vec::new();
        for m in c.take_output() {
            replies.extend(s.input(&m, &mut sent));
        }
        assert_eq!(s.client, Some(cpub));
        assert_eq!(c.input(&replies.concat(), now).unwrap(), vec![Event::Ready]);
        // NotePreferred went out with the handshake's end.
        assert_eq!(c.take_output(), vec![vec![NOTE_PREFERRED, 0, 0, 0, 1, 1]]);
        assert!(c.send(&[9; 32], b"hi", now));
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
            c.input(&two, now).unwrap(),
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
            Conn::new(cp, cpub, false, Instant::now())
                .input(b"HTTP/1.1 200 OK\r\n", Instant::now())
                .is_err()
        );
    }

    #[test]
    fn rejects_a_server_that_cant_open_the_box() {
        let (cp, cpub) = keys(1);
        let now = Instant::now();
        let mut c = Conn::new(cp, cpub, false, now);
        let s = Server::new([2; 32]);
        c.input(&s.hello(), now).unwrap();
        c.take_output();
        // Server info sealed by a different key.
        let other = SalsaBox::new(&PublicKey::from(cpub), &SecretKey::from([3; 32]));
        let n = SalsaBox::generate_nonce(&mut crypto_box::aead::OsRng);
        let sealed = other.encrypt(&n, &b"{}"[..]).unwrap();
        assert!(c.input(&frame(SERVER_INFO, &[&n, &sealed]), now).is_err());
    }

    /// A connected client and its server, at `now`.
    fn ready(now: Instant) -> (Conn, Server) {
        let (cp, cpub) = keys(1);
        let mut c = Conn::new(cp, cpub, false, now);
        let mut s = Server::new([2; 32]);
        c.input(&s.hello(), now).unwrap();
        let mut replies = Vec::new();
        for m in c.take_output() {
            replies.extend(s.input(&m, &mut Vec::new()));
        }
        assert_eq!(c.input(&replies.concat(), now).unwrap(), vec![Event::Ready]);
        c.take_output();
        (c, s)
    }

    fn pings(c: &mut Conn) -> usize {
        c.take_output().iter().filter(|f| f[0] == PING).count()
    }

    #[test]
    fn a_relay_that_never_answers_times_out() {
        let (cp, cpub) = keys(1);
        let now = Instant::now();
        let mut c = Conn::new(cp, cpub, false, now);
        assert_eq!(c.deadline(), Some(now + CONNECT_WAIT));
        assert!(c.tick(now + CONNECT_WAIT / 2).is_ok());
        assert!(c.tick(now + CONNECT_WAIT).is_err());
    }

    #[test]
    fn a_quiet_relay_is_pinged_and_a_dead_one_dropped() {
        let now = Instant::now();
        let (mut c, s) = ready(now);
        // Quiet: a ping after IDLE_PING; an answer (anything) keeps it.
        assert_eq!(c.deadline(), Some(now + IDLE_PING));
        c.tick(now + IDLE_PING / 2).unwrap();
        assert_eq!(pings(&mut c), 0);
        let t = now + IDLE_PING;
        c.tick(t).unwrap();
        assert_eq!(pings(&mut c), 1);
        assert_eq!(c.deadline(), Some(t + PONG_WAIT));
        c.input(&frame(PONG, &[&[0; 8]]), t + Duration::from_millis(30))
            .unwrap();
        c.tick(t + PONG_WAIT).unwrap();
        assert_eq!(pings(&mut c), 0);
        // Sending with nothing back: a ping after ACTIVE_PING, then dead after PONG_WAIT.
        let t = t + Duration::from_secs(1);
        assert!(c.send(&[9; 32], b"hi", t));
        c.take_output();
        assert!(c.send(&[9; 32], b"again", t + Duration::from_secs(1)));
        c.take_output();
        assert_eq!(
            c.deadline(),
            Some(t + ACTIVE_PING),
            "from the first unanswered send"
        );
        c.tick(t + ACTIVE_PING).unwrap();
        assert_eq!(pings(&mut c), 1);
        c.tick(t + ACTIVE_PING + PONG_WAIT / 2).unwrap();
        assert!(c.tick(t + ACTIVE_PING + PONG_WAIT).is_err());
        // A delivered packet counts as an answer.
        let (mut c, s2) = ready(now);
        let _ = s;
        assert!(c.send(&[9; 32], b"hi", now));
        c.take_output();
        c.input(
            &s2.deliver(&[7; 32], b"back"),
            now + Duration::from_millis(50),
        )
        .unwrap();
        c.tick(now + ACTIVE_PING + PONG_WAIT).unwrap();
        assert_eq!(pings(&mut c), 0);
    }
}
