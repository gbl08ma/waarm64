//! What the data plane reads of an IP packet (addresses, protocol, ports, TCP flags) and the
//! UDP packets it writes itself (MagicDNS's answers, its own DNS queries).

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use crate::nat46::{checksum, ip4, pseudo4, pseudo6};

pub const TCP: u8 = 6;
pub const UDP: u8 = 17;
pub const ICMP: u8 = 1;
pub const ICMP6: u8 = 58;

/// The parts of a packet the data plane decides on.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Info {
    pub src: IpAddr,
    pub dst: IpAddr,
    pub proto: u8,
    /// Ports for TCP and UDP; for ICMP, the echo identifier as both (0 for other types).
    pub sport: u16,
    pub dport: u16,
    /// TCP: SYN without ACK (a new connection). Others: false.
    pub syn: bool,
    /// ICMP(v6): its type.
    pub icmp_type: Option<u8>,
    /// Where the transport header starts.
    pub l4: usize,
}

/// Reads `p`, an IPv4 or IPv6 packet (IPv6 extension headers are not followed: such a
/// packet's protocol is the first next-header).
pub fn parse(p: &[u8]) -> Option<Info> {
    let (src, dst, proto, l4) = match p.first()? >> 4 {
        4 if p.len() >= 20 => {
            let ihl = (p[0] & 15) as usize * 4;
            // Fragments after the first have no transport header.
            let frag_off = u16::from_be_bytes([p[6], p[7]]) & 0x1fff;
            let proto = if frag_off != 0 { 0 } else { p[9] };
            let s: [u8; 4] = p[12..16].try_into().ok()?;
            let d: [u8; 4] = p[16..20].try_into().ok()?;
            (IpAddr::from(s), IpAddr::from(d), proto, ihl)
        }
        6 if p.len() >= 40 => {
            let s: [u8; 16] = p[8..24].try_into().ok()?;
            let d: [u8; 16] = p[24..40].try_into().ok()?;
            (IpAddr::from(s), IpAddr::from(d), p[6], 40)
        }
        _ => return None,
    };
    let t = p.get(l4..).unwrap_or_default();
    let port = |i: usize| {
        t.get(i..i + 2)
            .map_or(0, |b| u16::from_be_bytes([b[0], b[1]]))
    };
    let (mut sport, mut dport, mut syn, mut icmp_type) = (0, 0, false, None);
    match proto {
        TCP | UDP => {
            (sport, dport) = (port(0), port(2));
            syn = proto == TCP && t.get(13).is_some_and(|f| f & 0x12 == 0x02);
        }
        ICMP | ICMP6 => {
            icmp_type = t.first().copied();
            // Echo request and reply (v4: 8, 0; v6: 128, 129) carry an identifier.
            if matches!(icmp_type, Some(0 | 8 | 128 | 129)) {
                sport = port(4);
                dport = sport;
            }
        }
        _ => {}
    }
    Some(Info {
        src,
        dst,
        proto,
        sport,
        dport,
        syn,
        icmp_type,
        l4,
    })
}

/// A UDP packet from `src` to `dst` (both of one family) carrying `payload`.
pub fn udp(src: (IpAddr, u16), dst: (IpAddr, u16), payload: &[u8]) -> Vec<u8> {
    let len = 8 + payload.len();
    let mut seg = Vec::with_capacity(len);
    seg.extend_from_slice(&src.1.to_be_bytes());
    seg.extend_from_slice(&dst.1.to_be_bytes());
    seg.extend_from_slice(&(len as u16).to_be_bytes());
    seg.extend_from_slice(&[0, 0]);
    seg.extend_from_slice(payload);
    packet(src.0, dst.0, UDP, seg, 6)
}

pub const FIN: u8 = 0x01;
pub const SYN: u8 = 0x02;
pub const RST: u8 = 0x04;
pub const PSH: u8 = 0x08;
pub const ACK: u8 = 0x10;

/// A TCP segment from `src` to `dst` (no options but a SYN's MSS).
pub fn tcp(
    src: (IpAddr, u16),
    dst: (IpAddr, u16),
    seq: u32,
    ack: u32,
    flags: u8,
    payload: &[u8],
) -> Vec<u8> {
    let opts: &[u8] = if flags & SYN != 0 {
        &[2, 4, 0x04, 0xc4]
    } else {
        &[]
    }; // MSS 1220
    let mut seg = Vec::with_capacity(20 + opts.len() + payload.len());
    seg.extend_from_slice(&src.1.to_be_bytes());
    seg.extend_from_slice(&dst.1.to_be_bytes());
    seg.extend_from_slice(&seq.to_be_bytes());
    seg.extend_from_slice(&ack.to_be_bytes());
    seg.push((((20 + opts.len()) / 4) << 4) as u8);
    seg.push(flags);
    seg.extend_from_slice(&[0xff, 0xff, 0, 0, 0, 0]); // window, checksum, urgent
    seg.extend_from_slice(opts);
    seg.extend_from_slice(payload);
    packet(src.0, dst.0, TCP, seg, 16)
}

/// An ICMPv6 message from `src` to `dst`: `typ`, `code` and `body` (its checksum filled in).
pub fn icmp6(src: Ipv6Addr, dst: Ipv6Addr, typ: u8, code: u8, body: &[u8]) -> Vec<u8> {
    let mut seg = vec![typ, code, 0, 0];
    seg.extend_from_slice(body);
    packet(IpAddr::V6(src), IpAddr::V6(dst), ICMP6, seg, 2)
}

/// An IP packet around transport segment `seg`, its checksum (at `sum`) filled in.
fn packet(src: IpAddr, dst: IpAddr, proto: u8, mut seg: Vec<u8>, sum: usize) -> Vec<u8> {
    let len = seg.len();
    match (src, dst) {
        (IpAddr::V4(s), IpAddr::V4(d)) => {
            checksum(
                &mut seg,
                sum,
                &pseudo4(&s.octets(), &d.octets(), len, proto),
            );
            ip4(s.octets(), d.octets(), proto, 64, &seg)
        }
        (s, d) => {
            let (s, d) = (v6(s), v6(d));
            checksum(
                &mut seg,
                sum,
                &pseudo6(&s.octets(), &d.octets(), len, proto),
            );
            let mut p = vec![0x60, 0, 0, 0];
            p.extend_from_slice(&(len as u16).to_be_bytes());
            p.extend_from_slice(&[proto, 64]);
            p.extend_from_slice(&s.octets());
            p.extend_from_slice(&d.octets());
            p.extend_from_slice(&seg);
            p
        }
    }
}

/// A TCP segment's sequence and acknowledgment numbers, flags and payload (as `parse` read it).
pub fn tcp_segment<'a>(p: &'a [u8], i: &Info) -> Option<(u32, u32, u8, &'a [u8])> {
    if i.proto != TCP {
        return None;
    }
    let t = p.get(i.l4..)?;
    let off = (*t.get(12)? >> 4) as usize * 4;
    let seq = u32::from_be_bytes(t.get(4..8)?.try_into().ok()?);
    let ack = u32::from_be_bytes(t.get(8..12)?.try_into().ok()?);
    // An IPv4 packet may carry padding after its total length; read up to it.
    let end = match p[0] >> 4 {
        4 => (u16::from_be_bytes([p[2], p[3]]) as usize).min(p.len()),
        _ => (40 + u16::from_be_bytes([p[4], p[5]]) as usize).min(p.len()),
    };
    Some((seq, ack, t[13], p.get(i.l4 + off.max(20)..end)?))
}

fn v6(a: IpAddr) -> Ipv6Addr {
    match a {
        IpAddr::V6(a) => a,
        IpAddr::V4(a) => a.to_ipv6_mapped(),
    }
}

/// The UDP payload of `p` (as `parse` read it).
pub fn udp_payload<'a>(p: &'a [u8], i: &Info) -> Option<&'a [u8]> {
    if i.proto != UDP {
        return None;
    }
    p.get(i.l4 + 8..)
}

pub const MAGIC_DNS4: IpAddr = IpAddr::V4(Ipv4Addr::new(100, 100, 100, 100));
pub const MAGIC_DNS6: IpAddr = IpAddr::V6(Ipv6Addr::new(0xfd7a, 0x115c, 0xa1e0, 0, 0, 0, 0, 0x53));

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn udp_packets_read_back() {
        for (s, d) in [
            (IpAddr::from([100, 90, 0, 2]), MAGIC_DNS4),
            (
                IpAddr::from([
                    0xfd, 0x7a, 0x11, 0x5c, 0xa1, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2,
                ]),
                MAGIC_DNS6,
            ),
        ] {
            let p = udp((s, 40000), (d, 53), b"query");
            let i = parse(&p).unwrap();
            assert_eq!(
                (i.src, i.dst, i.proto, i.sport, i.dport),
                (s, d, UDP, 40000, 53)
            );
            assert_eq!(udp_payload(&p, &i), Some(&b"query"[..]));
        }
    }

    #[test]
    fn tcp_syn_and_icmp_echo() {
        let mut p = vec![
            0x45, 0, 0, 40, 0, 0, 0x40, 0, 64, TCP, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
        ];
        p.extend_from_slice(&[
            0, 80, 0x1f, 0x90, 0, 0, 0, 0, 0, 0, 0, 0, 0x50, 0x02, 0, 0, 0, 0, 0, 0,
        ]);
        let i = parse(&p).unwrap();
        assert!(i.syn && i.dport == 8080);
        p[33] = 0x12; // SYN-ACK: not a new connection
        assert!(!parse(&p).unwrap().syn);
        let mut e = vec![
            0x45, 0, 0, 28, 0, 0, 0, 0, 64, ICMP, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
        ];
        e.extend_from_slice(&[8, 0, 0, 0, 0x12, 0x34, 0, 1]);
        let i = parse(&e).unwrap();
        assert_eq!((i.icmp_type, i.sport), (Some(8), 0x1234));
    }
}
