//! Stateless IPv4/IPv6 translation (RFC 7915's subset for TCP, UDP and ICMP
//! echo) for tunnels that carry only IPv6, as tailcat's does: the guest's IPv4
//! packets leave as IPv6 from the node's tunnel address to `64:ff9b::<v4>`
//! (RFC 6052's well-known prefix, which tailcat's exit node unmaps), and
//! replies come back the other way.
//!
//! The tunnel carries 1280-byte IPv6 packets, so translated IPv4 packets must
//! stay at 1260 bytes. The guest's link MTU stays 1280 (under 1280 Linux turns
//! IPv6 off on the link), so TCP's MSS is clamped in SYNs both ways and an
//! oversized IPv4 packet with DF set is answered with "fragmentation needed".
//! Fragments, IPv4 options' contents and other ICMP types are dropped.

/// The well-known NAT64 prefix, `64:ff9b::/96`.
pub const PREFIX: [u8; 12] = [0, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0];
/// The largest IPv4 packet that fits the tunnel once translated.
pub const MTU4: usize = 1260;
/// The MSS that fits it: MTU4 less the IPv4 and TCP headers (the same as
/// IPv6's 1280 less its 60).
pub const MSS: u16 = 1220;
/// Where "fragmentation needed" comes from: RFC 7335's 192.0.0.1, the
/// translator's side of the guest's 192.0.0.2.
pub const ROUTER4: [u8; 4] = [192, 0, 0, 1];

const TCP: u8 = 6;
const UDP: u8 = 17;
const ICMP: u8 = 1;
const ICMP6: u8 = 58;

/// The one's complement sum of `b` folded into 16 bits (not inverted).
fn sum(mut s: u32, b: &[u8]) -> u32 {
    let (pairs, last) = b.as_chunks::<2>();
    for c in pairs {
        s += u16::from_be_bytes(*c) as u32;
    }
    if let [last] = last {
        s += (*last as u32) << 8;
    }
    while s > 0xffff {
        s = (s & 0xffff) + (s >> 16);
    }
    s
}

fn fold(s: u32) -> u16 {
    !(sum(s, &[]) as u16)
}

/// Rewrites the checksum of the transport segment `seg` (protocol `proto`,
/// checksum at `at`) for the pseudo-header `pseudo` (empty for ICMPv4).
fn checksum(seg: &mut [u8], at: usize, pseudo: &[u8]) {
    seg[at] = 0;
    seg[at + 1] = 0;
    let mut c = fold(sum(sum(0, pseudo), seg));
    if c == 0 && at == 6 {
        c = 0xffff; // UDP: zero means "no checksum"
    }
    seg[at..at + 2].copy_from_slice(&c.to_be_bytes());
}

fn pseudo6(src: &[u8], dst: &[u8], len: usize, next: u8) -> Vec<u8> {
    [src, dst, &(len as u32).to_be_bytes(), &[0, 0, 0, next]].concat()
}

fn pseudo4(src: &[u8], dst: &[u8], len: usize, proto: u8) -> Vec<u8> {
    [src, dst, &[0, proto], &(len as u16).to_be_bytes()].concat()
}

/// Lowers the MSS option of a TCP SYN in `seg` to `MSS` if it's above it.
fn clamp_mss(seg: &mut [u8]) {
    if seg.len() < 20 || seg[13] & 0x02 == 0 {
        return;
    }
    let end = ((seg[12] >> 4) as usize * 4).min(seg.len());
    let mut at = 20;
    while at < end {
        match seg[at] {
            0 => break,
            1 => at += 1,
            kind => {
                let Some(&len) = seg.get(at + 1) else { break };
                if len < 2 || at + len as usize > end {
                    break;
                }
                if kind == 2 && len == 4 && u16::from_be_bytes([seg[at + 2], seg[at + 3]]) > MSS {
                    seg[at + 2..at + 4].copy_from_slice(&MSS.to_be_bytes());
                }
                at += len as usize;
            }
        }
    }
}

/// What to do with an IPv4 packet from the guest.
#[derive(Debug, PartialEq)]
pub enum Out {
    /// Send this IPv6 packet into the tunnel.
    Tunnel(Vec<u8>),
    /// Give this IPv4 packet back to the guest (an ICMP error).
    Guest(Vec<u8>),
    Drop,
}

/// Translates the guest's IPv4 packet `p` to IPv6 from `src6`.
pub fn out4(p: &[u8], src6: &[u8; 16]) -> Out {
    if p.len() < 20 || p[0] >> 4 != 4 {
        return Out::Drop;
    }
    let ihl = (p[0] & 15) as usize * 4;
    let total = u16::from_be_bytes([p[2], p[3]]) as usize;
    if ihl < 20 || total < ihl || total > p.len() {
        return Out::Drop;
    }
    let flags = u16::from_be_bytes([p[6], p[7]]);
    if flags & 0x3fff != 0 {
        return Out::Drop; // a fragment (MF or an offset)
    }
    if total > MTU4 {
        return if flags & 0x4000 != 0 {
            Out::Guest(frag_needed(p, ihl))
        } else {
            Out::Drop
        };
    }
    let (proto, mut seg) = (p[9], p[ihl..total].to_vec());
    let mut dst6 = [0u8; 16];
    dst6[..12].copy_from_slice(&PREFIX);
    dst6[12..].copy_from_slice(&p[16..20]);
    let next = match proto {
        TCP if seg.len() >= 20 => {
            clamp_mss(&mut seg);
            let ps = pseudo6(src6, &dst6, seg.len(), TCP);
            checksum(&mut seg, 16, &ps);
            TCP
        }
        UDP if seg.len() >= 8 => {
            let ps = pseudo6(src6, &dst6, seg.len(), UDP);
            checksum(&mut seg, 6, &ps);
            UDP
        }
        ICMP if seg.len() >= 8 && (seg[0] == 8 || seg[0] == 0) && seg[1] == 0 => {
            seg[0] = if seg[0] == 8 { 128 } else { 129 };
            let ps = pseudo6(src6, &dst6, seg.len(), ICMP6);
            checksum(&mut seg, 2, &ps);
            ICMP6
        }
        _ => return Out::Drop,
    };
    let mut v6 = Vec::with_capacity(40 + seg.len());
    v6.extend_from_slice(&[0x60 | p[1] >> 4, p[1] << 4, 0, 0]);
    v6.extend_from_slice(&(seg.len() as u16).to_be_bytes());
    v6.extend_from_slice(&[next, p[8]]);
    v6.extend_from_slice(src6);
    v6.extend_from_slice(&dst6);
    v6.extend_from_slice(&seg);
    Out::Tunnel(v6)
}

/// ICMP "fragmentation needed" (type 3 code 4) with MTU4, for `p`'s sender.
fn frag_needed(p: &[u8], ihl: usize) -> Vec<u8> {
    let quoted = &p[..(ihl + 8).min(p.len())];
    let mut icmp = [
        &[3, 4, 0, 0, 0, 0][..],
        &(MTU4 as u16).to_be_bytes(),
        quoted,
    ]
    .concat();
    checksum(&mut icmp, 2, &[]);
    ip4(ROUTER4, p[12..16].try_into().unwrap(), ICMP, 64, &icmp)
}

fn ip4(src: [u8; 4], dst: [u8; 4], proto: u8, ttl: u8, payload: &[u8]) -> Vec<u8> {
    let total = 20 + payload.len();
    let mut h = vec![
        0x45,
        0,
        (total >> 8) as u8,
        total as u8,
        0,
        0,
        0x40,
        0,
        ttl,
        proto,
        0,
        0,
    ];
    h.extend_from_slice(&src);
    h.extend_from_slice(&dst);
    let c = fold(sum(0, &h));
    h[10..12].copy_from_slice(&c.to_be_bytes());
    h.extend_from_slice(payload);
    h
}

/// Translates an IPv6 packet from the tunnel for the guest's IPv4 address
/// `guest4`, if it comes from the NAT64 prefix; None otherwise.
pub fn in6(p: &[u8], guest4: [u8; 4]) -> Option<Vec<u8>> {
    if p.len() < 40 || p[0] >> 4 != 6 || p[8..20] != PREFIX {
        return None;
    }
    let len = u16::from_be_bytes([p[4], p[5]]) as usize;
    if 40 + len > p.len() {
        return None;
    }
    let src4: [u8; 4] = p[20..24].try_into().unwrap();
    let mut seg = p[40..40 + len].to_vec();
    let proto = match p[6] {
        TCP if seg.len() >= 20 => {
            clamp_mss(&mut seg);
            let ps = pseudo4(&src4, &guest4, seg.len(), TCP);
            checksum(&mut seg, 16, &ps);
            TCP
        }
        UDP if seg.len() >= 8 => {
            let ps = pseudo4(&src4, &guest4, seg.len(), UDP);
            checksum(&mut seg, 6, &ps);
            UDP
        }
        ICMP6 if seg.len() >= 8 && (seg[0] == 128 || seg[0] == 129) && seg[1] == 0 => {
            seg[0] = if seg[0] == 128 { 8 } else { 0 };
            checksum(&mut seg, 2, &[]);
            ICMP
        }
        _ => return None,
    };
    let tclass = (p[0] << 4) | (p[1] >> 4);
    let mut v4 = ip4(src4, guest4, proto, p[7], &seg);
    v4[1] = tclass;
    v4[10] = 0;
    v4[11] = 0;
    let c = fold(sum(0, &v4[..20]));
    v4[10..12].copy_from_slice(&c.to_be_bytes());
    Some(v4)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SRC6: [u8; 16] = [
        0xfd, 0x7a, 0x11, 0x5c, 0xa1, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ];
    const GUEST: [u8; 4] = [192, 0, 0, 2];

    fn valid4(p: &[u8]) {
        assert_eq!(fold(sum(0, &p[..20])), 0, "IPv4 header checksum");
        let seg = &p[20..];
        let pseudo = if p[9] == ICMP {
            vec![]
        } else {
            pseudo4(&p[12..16], &p[16..20], seg.len(), p[9])
        };
        assert_eq!(fold(sum(sum(0, &pseudo), seg)), 0, "transport checksum");
    }

    fn valid6(p: &[u8]) {
        let seg = &p[40..];
        assert_eq!(
            fold(sum(
                sum(0, &pseudo6(&p[8..24], &p[24..40], seg.len(), p[6])),
                seg
            )),
            0,
            "transport checksum"
        );
    }

    fn udp4(payload: &[u8], df: bool) -> Vec<u8> {
        let mut seg = [
            &[0x30, 0x39, 0, 53][..],
            &((8 + payload.len()) as u16).to_be_bytes(),
            &[0, 0],
            payload,
        ]
        .concat();
        let ps = pseudo4(&GUEST, &[1, 1, 1, 1], seg.len(), UDP);
        checksum(&mut seg, 6, &ps);
        let mut p = ip4(GUEST, [1, 1, 1, 1], UDP, 64, &seg);
        if !df {
            p[6] = 0;
            p[10] = 0;
            p[11] = 0;
            let c = fold(sum(0, &p[..20]));
            p[10..12].copy_from_slice(&c.to_be_bytes());
        }
        p
    }

    #[test]
    fn udp_both_ways() {
        let p = udp4(b"query", true);
        valid4(&p);
        let Out::Tunnel(v6) = out4(&p, &SRC6) else {
            panic!()
        };
        assert_eq!(v6[6], UDP);
        assert_eq!(&v6[8..24], &SRC6);
        assert_eq!(
            &v6[24..40],
            &[0, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1]
        );
        assert_eq!(&v6[48..], b"query");
        valid6(&v6);
        // The reply: swap the addresses and ports, as the exit node's would be.
        let mut r = v6.clone();
        r[8..24].copy_from_slice(&v6[24..40]);
        r[24..40].copy_from_slice(&SRC6);
        r.swap(40, 42);
        r.swap(41, 43);
        let back = in6(&r, GUEST).unwrap();
        valid4(&back);
        assert_eq!(&back[12..16], &[1, 1, 1, 1]);
        assert_eq!(&back[16..20], &GUEST);
        assert_eq!(&back[28..], b"query");
    }

    #[test]
    fn tcp_syn_mss_is_clamped() {
        // A SYN with MSS 1460, window scale and SACK permitted.
        let mut seg = vec![
            0x9c, 0x40, 0, 80, 0, 0, 0, 1, 0, 0, 0, 0, 0x80, 0x02, 0xff, 0xff, 0, 0, 0, 0,
        ];
        seg.extend_from_slice(&[2, 4, 0x05, 0xb4, 1, 3, 3, 7, 4, 2, 0, 0, 0, 0, 0, 0]);
        let p = ip4(GUEST, [93, 184, 215, 14], TCP, 64, &seg);
        let Out::Tunnel(v6) = out4(&p, &SRC6) else {
            panic!()
        };
        valid6(&v6);
        assert_eq!(u16::from_be_bytes([v6[62], v6[63]]), MSS);
        // An MSS already under it stays.
        let mut small = seg.clone();
        small[22..24].copy_from_slice(&536u16.to_be_bytes());
        let Out::Tunnel(v6) = out4(&ip4(GUEST, [93, 184, 215, 14], TCP, 64, &small), &SRC6) else {
            panic!()
        };
        assert_eq!(u16::from_be_bytes([v6[62], v6[63]]), 536);
    }

    #[test]
    fn ping_both_ways() {
        let mut icmp = vec![8, 0, 0, 0, 0x12, 0x34, 0, 1, b'p', b'i', b'n', b'g'];
        checksum(&mut icmp, 2, &[]);
        let Out::Tunnel(v6) = out4(&ip4(GUEST, [8, 8, 8, 8], ICMP, 64, &icmp), &SRC6) else {
            panic!()
        };
        assert_eq!((v6[6], v6[40]), (ICMP6, 128));
        valid6(&v6);
        let mut r = v6.clone();
        r[8..24].copy_from_slice(&v6[24..40]);
        r[24..40].copy_from_slice(&SRC6);
        r[40] = 129;
        let back = in6(&r, GUEST).unwrap();
        valid4(&back);
        assert_eq!((back[9], back[20]), (ICMP, 0));
        assert_eq!(&back[24..], &[0x12, 0x34, 0, 1, b'p', b'i', b'n', b'g']);
    }

    #[test]
    fn oversize_gets_frag_needed_or_dropped() {
        let big = udp4(&[0; 1300], true);
        let Out::Guest(e) = out4(&big, &SRC6) else {
            panic!()
        };
        valid4(&e);
        assert_eq!((e[9], e[20], e[21]), (ICMP, 3, 4));
        assert_eq!(u16::from_be_bytes([e[26], e[27]]) as usize, MTU4);
        assert_eq!(&e[16..20], &GUEST);
        assert_eq!(&e[28..48], &big[..20]);
        assert_eq!(out4(&udp4(&[0; 1300], false), &SRC6), Out::Drop);
        // The largest that fits goes through, and fills the tunnel's MTU exactly.
        let Out::Tunnel(v6) = out4(&udp4(&[0; MTU4 - 28], true), &SRC6) else {
            panic!()
        };
        assert_eq!(v6.len(), 1280);
    }

    #[test]
    fn drops_what_it_doesnt_translate() {
        let mut frag = udp4(b"x", false);
        frag[6] = 0x20; // MF
        assert_eq!(out4(&frag, &SRC6), Out::Drop);
        assert_eq!(out4(&[0x45; 10], &SRC6), Out::Drop);
        // IPv6 not from the prefix is native IPv6, not ours to translate.
        let mut v6 = vec![0x60, 0, 0, 0, 0, 8, UDP, 64];
        v6.extend_from_slice(&[0xfd; 16]);
        v6.extend_from_slice(&SRC6);
        v6.extend_from_slice(&[0; 8]);
        assert_eq!(in6(&v6, GUEST), None);
    }
}
