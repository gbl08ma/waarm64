//! MagicDNS over TCP (RFC 7766), sans I/O: what a guest's resolver falls back to when an answer
//! over UDP came back truncated. Just enough TCP for that: a connection per asker, queries in order
//! (each with its 2-byte length), the answers as they come, and the connection closed once the
//! guest closes its side and every answer went. Nothing is retransmitted: the segments go straight
//! to the guest over the gateway's link, which doesn't lose them, and a resolver that misses one
//! times out and asks again as it would of any server.

use std::{
    collections::BTreeMap,
    net::IpAddr,
    time::{Duration, Instant},
};

use crate::ip::{self, ACK, FIN, PSH, RST, SYN};

/// A connection: the guest's address and port, and the MagicDNS address it asked at.
pub type Key = (IpAddr, u16, IpAddr);

/// The connections kept at once; one more is refused.
const MAX_CONNS: usize = 64;
/// A connection quiet this long (the guest gone without a word) goes.
const IDLE: Duration = Duration::from_secs(30);
/// Answer bytes per segment: within the MSS the guest's link takes.
const SEGMENT: usize = 1200;

struct Conn {
    /// The next sequence numbers we send and expect.
    snd: u32,
    rcv: u32,
    /// What came in that isn't a whole query yet.
    buf: Vec<u8>,
    /// Queries not answered yet.
    pending: u32,
    /// The guest closed its side: we close ours after the last answer.
    fin: bool,
    until: Instant,
}

/// What a segment from the guest led to.
#[derive(Debug, PartialEq)]
pub enum Out {
    /// A segment for the guest.
    Packet(Vec<u8>),
    /// A query to answer, through `answer`.
    Query(Key, Vec<u8>),
}

#[derive(Default)]
pub struct Server {
    conns: BTreeMap<Key, Conn>,
}

impl Server {
    /// A TCP segment from the guest to MagicDNS's port 53 (`i` as `ip::parse` read it).
    pub fn input(&mut self, p: &[u8], i: &ip::Info, now: Instant) -> Vec<Out> {
        let Some((seq, ack, flags, payload)) = ip::tcp_segment(p, i) else {
            return Vec::new();
        };
        let key = (i.src, i.sport, i.dst);
        let (us, them) = ((i.dst, i.dport), (i.src, i.sport));
        if flags & RST != 0 {
            self.conns.remove(&key);
            return Vec::new();
        }
        if flags & SYN != 0 && flags & ACK == 0 {
            if self.conns.len() >= MAX_CONNS && !self.conns.contains_key(&key) {
                let rst = ip::tcp(us, them, 0, seq.wrapping_add(1), RST | ACK, &[]);
                return vec![Out::Packet(rst)];
            }
            let mut isn = [0u8; 4];
            getrandom::fill(&mut isn).expect("randomness");
            let isn = u32::from_be_bytes(isn);
            self.conns.insert(
                key,
                Conn {
                    snd: isn.wrapping_add(1),
                    rcv: seq.wrapping_add(1),
                    buf: Vec::new(),
                    pending: 0,
                    fin: false,
                    until: now + IDLE,
                },
            );
            let syn_ack = ip::tcp(us, them, isn, seq.wrapping_add(1), SYN | ACK, &[]);
            return vec![Out::Packet(syn_ack)];
        }
        let Some(c) = self.conns.get_mut(&key) else {
            if payload.is_empty() && flags & FIN == 0 {
                return Vec::new(); // the last ACK of one we closed
            }
            // Not a connection we have (one we closed, or forgot): reset, as a stack would.
            let len = payload.len() as u32 + (flags & FIN != 0) as u32;
            let rst = ip::tcp(us, them, ack, seq.wrapping_add(len), RST | ACK, &[]);
            return vec![Out::Packet(rst)];
        };
        c.until = now + IDLE;
        let mut out = Vec::new();
        let in_order = seq == c.rcv;
        if !payload.is_empty() {
            if in_order {
                c.buf.extend_from_slice(payload);
                c.rcv = c.rcv.wrapping_add(payload.len() as u32);
            }
            while c.buf.len() >= 2 {
                let n = u16::from_be_bytes([c.buf[0], c.buf[1]]) as usize;
                if c.buf.len() < 2 + n {
                    break;
                }
                let q: Vec<u8> = c.buf.drain(..2 + n).skip(2).collect();
                c.pending += 1;
                out.push(Out::Query(key, q));
            }
        }
        if flags & FIN != 0 && seq.wrapping_add(payload.len() as u32) == c.rcv && !c.fin {
            c.rcv = c.rcv.wrapping_add(1);
            c.fin = true;
        }
        if !payload.is_empty() || flags & FIN != 0 {
            // What came in, acknowledged (out of order: what we expect, again).
            let fin = c.fin && c.pending == 0;
            let flags = if fin { FIN | ACK } else { ACK };
            out.insert(0, Out::Packet(ip::tcp(us, them, c.snd, c.rcv, flags, &[])));
            if fin {
                self.conns.remove(&key);
            }
        }
        out
    }

    /// The answer to a query `input` gave for `key`: the segments that carry it.
    pub fn answer(&mut self, key: Key, msg: &[u8]) -> Vec<Vec<u8>> {
        let Some(c) = self.conns.get_mut(&key) else {
            return Vec::new();
        };
        let (us, them) = ((key.2, 53), (key.0, key.1));
        c.pending = c.pending.saturating_sub(1);
        let mut data = (msg.len().min(0xffff) as u16).to_be_bytes().to_vec();
        data.extend_from_slice(&msg[..msg.len().min(0xffff)]);
        let mut out = Vec::new();
        for chunk in data.chunks(SEGMENT) {
            out.push(ip::tcp(us, them, c.snd, c.rcv, ACK | PSH, chunk));
            c.snd = c.snd.wrapping_add(chunk.len() as u32);
        }
        if c.fin && c.pending == 0 {
            out.push(ip::tcp(us, them, c.snd, c.rcv, FIN | ACK, &[]));
            self.conns.remove(&key);
        }
        out
    }

    /// Forgets connections quiet since before `now`.
    pub fn sweep(&mut self, now: Instant) {
        self.conns.retain(|_, c| c.until > now);
    }

    pub fn is_empty(&self) -> bool {
        self.conns.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GUEST: [u8; 4] = [100, 90, 0, 2];

    fn seg(seq: u32, ack: u32, flags: u8, payload: &[u8]) -> Vec<u8> {
        ip::tcp(
            (IpAddr::from(GUEST), 40000),
            (ip::MAGIC_DNS4, 53),
            seq,
            ack,
            flags,
            payload,
        )
    }

    fn read(p: &[u8]) -> (u32, u32, u8, Vec<u8>) {
        let i = ip::parse(p).unwrap();
        assert_eq!(
            (i.src, i.sport, i.dst, i.dport),
            (ip::MAGIC_DNS4, 53, IpAddr::from(GUEST), 40000)
        );
        let (s, a, f, d) = ip::tcp_segment(p, &i).unwrap();
        (s, a, f, d.to_vec())
    }

    fn input(s: &mut Server, p: &[u8], now: Instant) -> Vec<Out> {
        s.input(p, &ip::parse(p).unwrap(), now)
    }

    #[test]
    fn a_query_over_tcp_and_its_answer() {
        let now = Instant::now();
        let mut s = Server::default();
        let out = input(&mut s, &seg(1000, 0, SYN, &[]), now);
        let Out::Packet(p) = &out[0] else { panic!() };
        let (isn, ack, flags, _) = read(p);
        assert_eq!((ack, flags), (1001, SYN | ACK));
        // The query arrives in two segments; the first is only acknowledged.
        let q = b"\x00\x05hello";
        let out = input(&mut s, &seg(1001, isn + 1, ACK, &q[..3]), now);
        assert_eq!(out.len(), 1);
        let out = input(&mut s, &seg(1004, isn + 1, ACK | PSH, &q[3..]), now);
        assert_eq!(out.len(), 2);
        let Out::Packet(p) = &out[0] else { panic!() };
        assert_eq!(read(p).1, 1001 + 7);
        let Out::Query(key, msg) = &out[1] else {
            panic!()
        };
        assert_eq!(msg, b"hello");
        // The guest closes its side before the answer: it comes, then our FIN.
        let out = input(&mut s, &seg(1008, isn + 1, FIN | ACK, &[]), now);
        let Out::Packet(p) = &out[0] else { panic!() };
        assert_eq!(read(p).2, ACK, "not closed while an answer is due");
        let big = vec![7u8; 3000];
        let segs = s.answer(*key, &big);
        assert_eq!(segs.len(), 4, "three segments and a FIN");
        let data: Vec<u8> = segs.iter().flat_map(|p| read(p).3).collect();
        assert_eq!(&data[..2], &[0x0b, 0xb8]);
        assert_eq!(data.len(), 3002);
        let (fin_seq, fin_ack, flags, _) = read(&segs[3]);
        assert_eq!((fin_seq, fin_ack, flags), (isn + 1 + 3002, 1009, FIN | ACK));
        assert!(s.is_empty());
        // Its last ACK is the end; data after that, a reset.
        assert!(input(&mut s, &seg(1009, fin_seq + 1, ACK, &[]), now).is_empty());
        let out = input(&mut s, &seg(1009, fin_seq + 1, ACK, b"\x00\x01x"), now);
        assert!(matches!(&out[0], Out::Packet(p) if read(p).2 & RST != 0));
    }
}
