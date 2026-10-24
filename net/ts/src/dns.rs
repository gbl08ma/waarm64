//! The DNS messages MagicDNS needs (RFC 1035): the question of a query, and answers to it.

use std::net::IpAddr;

pub const A: u16 = 1;
pub const AAAA: u16 = 28;
pub const NOERROR: u8 = 0;
pub const SERVFAIL: u8 = 2;
pub const NXDOMAIN: u8 = 3;
pub const REFUSED: u8 = 5;

#[derive(Debug, PartialEq)]
pub struct Query {
    pub id: u16,
    /// Lower case, without the trailing dot.
    pub name: String,
    pub qtype: u16,
    /// The largest answer over UDP the asker takes: its EDNS(0) size, or 512.
    pub udp_size: usize,
    /// Where the question ends (answers repeat the message up to here).
    end: usize,
}

/// The query in `m`: one question (what resolvers send), not a response.
pub fn parse(m: &[u8]) -> Option<Query> {
    if m.len() < 12 || m[2] & 0x80 != 0 || u16::from_be_bytes([m[4], m[5]]) != 1 {
        return None;
    }
    let mut at = 12;
    let mut labels = Vec::new();
    loop {
        let n = *m.get(at)? as usize;
        at += 1;
        if n == 0 {
            break;
        }
        if n > 63 {
            return None; // a compression pointer has no place in a question
        }
        labels.push(
            std::str::from_utf8(m.get(at..at + n)?)
                .ok()?
                .to_ascii_lowercase(),
        );
        at += n;
    }
    let qtype = u16::from_be_bytes([*m.get(at)?, *m.get(at + 1)?]);
    m.get(at + 3)?; // the class
    let end = at + 4;
    // An OPT record (the root's name, type 41) first among the additional ones: its class is
    // the asker's UDP payload size.
    let opt =
        u16::from_be_bytes([m[10], m[11]]) > 0 && m.get(end..end + 3) == Some(&[0, 0, 41][..]);
    let udp_size = match opt {
        true => (u16::from_be_bytes([*m.get(end + 3)?, *m.get(end + 4)?]) as usize).max(512),
        false => 512,
    };
    Some(Query {
        id: u16::from_be_bytes([m[0], m[1]]),
        name: labels.join("."),
        qtype,
        udp_size,
        end,
    })
}

/// A response's RCODE (SERVFAIL for what isn't one).
pub fn rcode(m: &[u8]) -> u8 {
    match m.get(2..4) {
        Some(&[f, r]) if f & 0x80 != 0 => r & 15,
        _ => SERVFAIL,
    }
}

/// Whether a response was truncated (TC).
pub fn truncated(m: &[u8]) -> bool {
    m.get(2).is_some_and(|f| f & 0x02 != 0)
}

/// Response `m` as it may go over UDP in `max` bytes: as it is if it fits, or else its header
/// and question with TC set (the asker asks again over TCP), as RFC 1035 has it.
pub fn fit(m: &[u8], max: usize) -> Vec<u8> {
    if m.len() <= max || m.len() < 12 {
        return m.to_vec();
    }
    let mut at = 12;
    while let Some(&n) = m.get(at) {
        at += 1 + n as usize;
        if n == 0 || n > 63 {
            break;
        }
    }
    let mut t = m[..(at + 4).min(m.len())].to_vec();
    t[2] |= 0x02;
    t[4..6].copy_from_slice(&[0, 1]);
    t[6..12].fill(0);
    t
}

/// The answer to `q` (from `m`): `rcode` and these addresses (those of the asked type).
pub fn answer(m: &[u8], q: &Query, rcode: u8, addrs: &[IpAddr], ttl: u32) -> Vec<u8> {
    let records: Vec<&IpAddr> = addrs
        .iter()
        .filter(|a| match a {
            IpAddr::V4(_) => q.qtype == A,
            IpAddr::V6(_) => q.qtype == AAAA,
        })
        .collect();
    let mut r = Vec::with_capacity(q.end + records.len() * 28);
    r.extend_from_slice(&q.id.to_be_bytes());
    // A response, authoritative, recursion desired as asked and available.
    r.push(0x84 | (m[2] & 0x01));
    r.push(0x80 | rcode);
    r.extend_from_slice(&[0, 1]);
    r.extend_from_slice(&(records.len() as u16).to_be_bytes());
    r.extend_from_slice(&[0, 0, 0, 0]);
    r.extend_from_slice(&m[12..q.end]);
    for a in records {
        r.extend_from_slice(&[0xc0, 12]); // the question's name
        let (t, data) = match a {
            IpAddr::V4(a) => (A, a.octets().to_vec()),
            IpAddr::V6(a) => (AAAA, a.octets().to_vec()),
        };
        r.extend_from_slice(&t.to_be_bytes());
        r.extend_from_slice(&[0, 1]);
        r.extend_from_slice(&ttl.to_be_bytes());
        r.extend_from_slice(&(data.len() as u16).to_be_bytes());
        r.extend_from_slice(&data);
    }
    r
}

/// The DNS-over-HTTPS service of a well-known resolver's address, or Cloudflare's: where a
/// browser sends what would go to a plain resolver it can't reach (as the Go client does).
pub fn doh_url(resolver: Option<IpAddr>) -> &'static str {
    resolver
        .and_then(known_doh)
        .unwrap_or("https://cloudflare-dns.com/dns-query")
}

/// The DNS-over-HTTPS service of a well-known public resolver's address.
pub fn known_doh(resolver: IpAddr) -> Option<&'static str> {
    match resolver.to_string().as_str() {
        "8.8.8.8" | "8.8.4.4" | "2001:4860:4860::8888" | "2001:4860:4860::8844" => {
            Some("https://dns.google/dns-query")
        }
        "9.9.9.9" | "149.112.112.112" | "2620:fe::fe" | "2620:fe::9" => {
            Some("https://dns.quad9.net/dns-query")
        }
        "1.1.1.1" | "1.0.0.1" | "2606:4700:4700::1111" | "2606:4700:4700::1001" => {
            Some("https://cloudflare-dns.com/dns-query")
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn query(name: &str, qtype: u16) -> Vec<u8> {
        let mut m = vec![0xab, 0xcd, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0];
        for l in name.split('.') {
            m.push(l.len() as u8);
            m.extend_from_slice(l.as_bytes());
        }
        m.push(0);
        m.extend_from_slice(&qtype.to_be_bytes());
        m.extend_from_slice(&[0, 1]);
        m
    }

    #[test]
    fn a_question_and_its_answer() {
        let m = query("Peer.Tail.Test", A);
        let q = parse(&m).unwrap();
        assert_eq!(
            (q.id, q.name.as_str(), q.qtype),
            (0xabcd, "peer.tail.test", A)
        );
        let addrs = [
            IpAddr::from([100, 90, 0, 1]),
            "fd7a:115c:a1e0::1".parse().unwrap(),
        ];
        let r = answer(&m, &q, NOERROR, &addrs, 600);
        assert_eq!(&r[..4], &[0xab, 0xcd, 0x85, 0x80]);
        assert_eq!(&r[6..8], &[0, 1], "one record: the A one");
        assert_eq!(&r[r.len() - 4..], &[100, 90, 0, 1]);
        let r = answer(&m, &q, NXDOMAIN, &[], 0);
        assert_eq!((r[3] & 15, r.len()), (NXDOMAIN, m.len()));
        // A response isn't a query.
        let mut resp = m.clone();
        resp[2] |= 0x80;
        assert_eq!(parse(&resp), None);
        assert_eq!(q.udp_size, 512, "no EDNS");
    }

    #[test]
    fn edns_sizes_and_answers_that_dont_fit() {
        let mut m = query("big.example", 16);
        m[11] = 1; // one additional record: OPT, 1232 bytes
        m.extend_from_slice(&[0, 0, 41, 0x04, 0xd0, 0, 0, 0, 0, 0, 0]);
        let q = parse(&m).unwrap();
        assert_eq!(q.udp_size, 1232);
        // A 2 KB answer: header and question, TC set, no records.
        let mut a = answer(&m, &q, NOERROR, &[], 60);
        a[7] = 9;
        a.resize(2048, 7);
        assert!(!truncated(&a));
        let t = fit(&a, q.udp_size);
        assert!(truncated(&t));
        assert_eq!(&t[4..12], &[0, 1, 0, 0, 0, 0, 0, 0]);
        assert_eq!(t.len(), 12 + "big.example".len() + 2 + 4);
        assert_eq!(rcode(&t), NOERROR);
        assert_eq!(fit(&t, 512), t, "what fits goes as it is");
        assert_eq!(
            rcode(b"\x00\x01\x01\x00"),
            SERVFAIL,
            "a query isn't an answer"
        );
    }
}
