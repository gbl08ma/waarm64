//! The DNS messages MagicDNS needs (RFC 1035): the question of a query, and answers to it.

use std::net::IpAddr;

pub const A: u16 = 1;
pub const AAAA: u16 = 28;
pub const NOERROR: u8 = 0;
pub const SERVFAIL: u8 = 2;
pub const NXDOMAIN: u8 = 3;

#[derive(Debug, PartialEq)]
pub struct Query {
    pub id: u16,
    /// Lower case, without the trailing dot.
    pub name: String,
    pub qtype: u16,
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
    Some(Query {
        id: u16::from_be_bytes([m[0], m[1]]),
        name: labels.join("."),
        qtype,
        end: at + 4,
    })
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
    match resolver.map(|a| a.to_string()).as_deref() {
        Some("8.8.8.8" | "8.8.4.4" | "2001:4860:4860::8888" | "2001:4860:4860::8844") => {
            "https://dns.google/dns-query"
        }
        Some("9.9.9.9" | "149.112.112.112" | "2620:fe::fe" | "2620:fe::9") => {
            "https://dns.quad9.net/dns-query"
        }
        _ => "https://cloudflare-dns.com/dns-query",
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
    }
}
