//! The room client against fake relays and a fake WebRTC. Each DERP connection gets its own
//! derp.rs test server, and a packet sent through one reaches the node of its key only on a
//! connection to the same region's URL, as a real region routes. The Nostr relay forwards an
//! event to the subscriptions whose kind and `#x` tags it matches and stores nothing. In the fake
//! WebRTC, an offer is answered, an answer opens both ends' channels, and a channel's messages
//! reach the other end, unless a test blocks or drops them.

use std::collections::BTreeMap;

use serde_json::Value;

use super::*;
use crate::derp::testserver::Server as DerpServer;

/// Unix seconds when the tests' clocks start: a little after an hour began.
const T0: u64 = 1_764_000_000 / 3600 * 3600 + 600;
const NOSTR: &str = "wss://nostr.test";

enum Conn {
    Derp { url: String, server: DerpServer },
    Nostr,
}

struct Node {
    c: Client,
    conns: BTreeMap<u32, Conn>,
    guest: Vec<Vec<u8>>,
    events: Vec<Value>,
    derp_packets: usize,
    rtc_packets: usize,
}

/// One end of a fake WebRTC connection.
#[derive(Default)]
struct End {
    peer: Option<(usize, u32)>,
    open: bool,
}

#[derive(Default)]
struct Faults {
    /// Offers and answers go nowhere: no channel ever opens.
    block_rtc: bool,
    /// Channel messages are lost (a stalled path).
    blackhole_rtc: bool,
    /// About a third of relay packets are lost.
    lossy_relay: bool,
    /// The next relay packet node `.0` sends is lost.
    drop_next_from: Option<usize>,
    /// The Nostr relay takes what nodes send and does nothing (a half-open connection).
    silent_nostr: bool,
}

/// A subscription on the fake Nostr relay.
struct Sub {
    node: usize,
    conn: u32,
    id: String,
    kinds: Vec<u64>,
    xs: Vec<String>,
}

struct Net {
    nodes: Vec<Node>,
    ends: BTreeMap<(usize, u32), End>,
    subs: Vec<Sub>,
    /// Every event published, in order.
    published: Vec<Value>,
    now: Instant,
    faults: Faults,
    relayed: usize,
}

fn key(seed: u8) -> [u8; 32] {
    [seed; 32]
}

fn public(seed: u8) -> [u8; 32] {
    let pair = NodeKeyPair::from(Export::<NodePrivateKey>::from_bytes(key(seed)).import());
    *pair.public.export().as_bytes()
}

fn link(derp: &[&str]) -> Link {
    Link {
        id: "test room".into(),
        nostr: vec![NOSTR.into()],
        derp: derp
            .iter()
            .map(|d| Region::Inline(tailcat::parse_relay(d).unwrap()))
            .collect(),
    }
}

fn config(seed: u8) -> Config {
    Config {
        link: link(&["derp.test"]),
        key: Some(key(seed)),
        home: 0,
        derp_map_url: String::new(),
        known: Vec::new(),
        relay_only: false,
        incoming: true,
        unix_time: Some(T0),
    }
}

fn configs(seeds: &[u8]) -> Vec<Config> {
    seeds.iter().map(|s| config(*s)).collect()
}

fn node(c: Client) -> Node {
    Node {
        c,
        conns: BTreeMap::new(),
        guest: Vec::new(),
        events: Vec::new(),
        derp_packets: 0,
        rtc_packets: 0,
    }
}

impl Net {
    fn new(cfgs: Vec<Config>) -> Net {
        let now = Instant::now();
        let nodes = cfgs
            .into_iter()
            .map(|cfg| node(Client::new(cfg, now).unwrap()))
            .collect();
        let mut n = Net {
            nodes,
            ends: BTreeMap::new(),
            subs: Vec::new(),
            published: Vec::new(),
            now,
            faults: Faults::default(),
            relayed: 0,
        };
        n.run();
        for x in &n.nodes {
            assert_eq!(x.c.state, State::Running);
        }
        n
    }

    /// Node `i` restarts (its page reloads): a new client of `cfg`, its connections gone.
    fn restart(&mut self, i: usize, cfg: Config) {
        self.ends.retain(|(j, _), _| *j != i);
        self.subs.retain(|s| s.node != i);
        let now = self.now;
        self.nodes[i] = node(Client::new(cfg, now).unwrap());
        self.run();
    }

    fn signal(&mut self, i: usize, rtc: u32, v: Value) {
        let now = self.now;
        self.nodes[i]
            .c
            .rtc_signal(rtc, v.to_string().as_bytes(), now);
    }

    /// What node `i` sends the Nostr relay.
    fn nostr_in(&mut self, i: usize, conn: u32, text: &[u8]) {
        if self.faults.silent_nostr {
            return;
        }
        let m: Value = serde_json::from_slice(text).unwrap();
        match m[0].as_str().unwrap() {
            "REQ" => {
                // A REQ with an ID in use replaces it (NIP-01).
                self.subs
                    .retain(|s| !(s.node == i && s.conn == conn && s.id == m[1]));
                let f = &m[2];
                self.subs.push(Sub {
                    node: i,
                    conn,
                    id: m[1].as_str().unwrap().into(),
                    kinds: f["kinds"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|k| k.as_u64().unwrap())
                        .collect(),
                    xs: f["#x"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|x| x.as_str().unwrap().into())
                        .collect(),
                });
                let eose = json!(["EOSE", m[1]]).to_string();
                let now = self.now;
                self.nodes[i].c.ws_message(conn, eose.as_bytes(), now);
            }
            "CLOSE" => self
                .subs
                .retain(|s| !(s.node == i && s.conn == conn && s.id == m[1])),
            "EVENT" => {
                let e = m[1].clone();
                let ok = json!(["OK", e["id"], true, ""]).to_string();
                let now = self.now;
                self.nodes[i].c.ws_message(conn, ok.as_bytes(), now);
                self.forward(&e);
            }
            other => panic!("{other}"),
        }
    }

    /// The relay forwards event `e` to every subscription it matches.
    fn forward(&mut self, e: &Value) {
        self.published.push(e.clone());
        let x = e["tags"][0][1].as_str().unwrap();
        let kind = e["kind"].as_u64().unwrap();
        let to: Vec<(usize, u32, String)> = self
            .subs
            .iter()
            .filter(|s| s.kinds.contains(&kind) && s.xs.iter().any(|t| t == x))
            .map(|s| (s.node, s.conn, s.id.clone()))
            .collect();
        let now = self.now;
        for (j, conn, sub) in to {
            let m = json!(["EVENT", sub, e]).to_string();
            self.nodes[j].c.ws_message(conn, m.as_bytes(), now);
        }
    }

    /// A lookup of anyone's making, published as is.
    fn inject(
        &mut self,
        l: &Lookup,
        room: &Room,
        to: Option<&[u8; 32]>,
        target: [u8; 16],
        hour: u64,
    ) {
        let tag = room.tag_for(&target, hour);
        let content = b64().encode(l.seal(room, to, &tag));
        let e = nostr::Author::random()
            .unwrap()
            .event(KIND, &tag, &content, l.time);
        self.forward(&e);
        self.run();
    }

    fn handle(&mut self, i: usize, a: Action) {
        let now = self.now;
        match a {
            Action::WsOpen {
                conn,
                url,
                protocol,
            } => {
                if url == NOSTR {
                    assert_eq!(protocol, "");
                    self.nodes[i].conns.insert(conn, Conn::Nostr);
                    return;
                }
                assert_eq!(protocol, "derp");
                let server = DerpServer::new([100 + i as u8; 32]);
                let hello = server.hello();
                self.nodes[i].conns.insert(conn, Conn::Derp { url, server });
                self.nodes[i].c.ws_message(conn, &hello, now);
            }
            Action::WsSend { conn, data } => {
                let n = &mut self.nodes[i];
                let url = match n.conns.get_mut(&conn) {
                    Some(Conn::Nostr) => return self.nostr_in(i, conn, &data),
                    Some(Conn::Derp { url, .. }) => url.clone(),
                    None => return,
                };
                let Some(Conn::Derp { server, .. }) = n.conns.get_mut(&conn) else {
                    unreachable!()
                };
                let mut sent = Vec::new();
                let replies = server.input(&data, &mut sent);
                for r in replies {
                    self.nodes[i].c.ws_message(conn, &r, now);
                }
                let src = self.nodes[i].c.public;
                for (dst, p) in sent {
                    self.relayed += 1;
                    if self.faults.drop_next_from == Some(i) {
                        self.faults.drop_next_from = None;
                        continue;
                    }
                    // A third lost, at random (a fixed sequence).
                    if self.faults.lossy_relay
                        && (self.relayed as u64).wrapping_mul(0x9e37_79b9_7f4a_7c15) >> 61 < 3
                    {
                        continue;
                    }
                    // The node of that key, on this region.
                    let Some((j, c)) = self.nodes.iter().enumerate().find_map(|(j, n)| {
                        (n.c.public == dst)
                            .then(|| {
                                n.conns.iter().find_map(|(c, x)| match x {
                                    Conn::Derp { url: u, server }
                                        if *u == url && server.client.is_some() =>
                                    {
                                        Some((j, *c))
                                    }
                                    _ => None,
                                })
                            })
                            .flatten()
                    }) else {
                        continue;
                    };
                    self.nodes[i].derp_packets += 1;
                    let Some(Conn::Derp { server, .. }) = self.nodes[j].conns.get(&c) else {
                        unreachable!()
                    };
                    let frame = server.deliver(&src, &p);
                    self.nodes[j].c.ws_message(c, &frame, now);
                }
            }
            Action::WsClose { conn } => {
                self.nodes[i].conns.remove(&conn);
                self.subs.retain(|s| !(s.node == i && s.conn == conn));
            }
            Action::ToGuest(p) => self.nodes[i].guest.push(p),
            Action::Event(e) => self.nodes[i].events.push(serde_json::from_str(&e).unwrap()),
            Action::RtcOpen { rtc, offer } => {
                self.ends.insert((i, rtc), End::default());
                if offer && !self.faults.block_rtc {
                    self.signal(i, rtc, json!({ "type": "offer", "pc": [i, rtc] }));
                    self.signal(i, rtc, json!({ "candidate": "x" }));
                }
            }
            Action::RtcSignal { rtc, data } => {
                let v: Value = serde_json::from_str(&data).unwrap();
                let pc = |v: &Value| {
                    (
                        v["pc"][0].as_u64().unwrap() as usize,
                        v["pc"][1].as_u64().unwrap() as u32,
                    )
                };
                match v["type"].as_str() {
                    Some("offer") if !self.faults.block_rtc => {
                        self.ends.get_mut(&(i, rtc)).unwrap().peer = Some(pc(&v));
                        self.signal(i, rtc, json!({ "type": "answer", "pc": [i, rtc] }));
                    }
                    Some("answer") => {
                        let other = pc(&v);
                        let Some(e) = self.ends.get_mut(&(i, rtc)) else {
                            return;
                        };
                        e.peer = Some(other);
                        e.open = true;
                        let Some(o) = self.ends.get_mut(&other) else {
                            return;
                        };
                        o.open = true;
                        self.nodes[i].c.rtc_open(rtc, now);
                        self.nodes[other.0].c.rtc_open(other.1, now);
                    }
                    _ => {}
                }
            }
            Action::RtcSend { rtc, data } => {
                let Some(End {
                    peer: Some((j, r)),
                    open: true,
                }) = self.ends.get(&(i, rtc))
                else {
                    return;
                };
                let (j, r) = (*j, *r);
                self.nodes[i].rtc_packets += 1;
                if !self.faults.blackhole_rtc {
                    self.nodes[j].c.rtc_message(r, &data, now);
                }
            }
            Action::RtcClose { rtc } => {
                // The other end's channel closes too, as SCTP's would.
                if let Some(End {
                    peer: Some(other),
                    open: true,
                }) = self.ends.remove(&(i, rtc))
                    && self.ends.remove(&other).is_some()
                {
                    self.nodes[other.0].c.rtc_closed(other.1, now);
                }
            }
            Action::Fetch { .. } => {}
        }
    }

    /// Carries out every node's actions until none is left.
    fn run(&mut self) {
        loop {
            let mut any = false;
            for i in 0..self.nodes.len() {
                while let Some(a) = self.nodes[i].c.poll() {
                    any = true;
                    self.handle(i, a);
                }
            }
            if !any {
                break;
            }
        }
    }

    /// Runs time forward to `now + d`, ticking each node when it asks.
    fn advance(&mut self, d: Duration) {
        let end = self.now + d;
        loop {
            self.run();
            let next = self.nodes.iter().filter_map(|n| n.c.deadline()).min();
            match next {
                Some(t) if t <= end => {
                    self.now = t.max(self.now);
                    let now = self.now;
                    for n in &mut self.nodes {
                        if n.c.deadline().is_some_and(|t| t <= now) {
                            n.c.tick(now);
                        }
                    }
                }
                _ => break,
            }
        }
        self.now = end;
        self.run();
    }

    fn addr(&self, i: usize) -> [u8; 16] {
        self.nodes[i].c.addr
    }

    /// A UDP packet from node `i`'s guest to node `j`'s address, port `port`.
    fn send(&mut self, i: usize, j: usize, port: u16, payload: &[u8]) {
        let to = self.addr(j);
        self.send_to(i, to, port, payload);
    }

    fn send_to(&mut self, i: usize, to: [u8; 16], port: u16, payload: &[u8]) {
        let p = udp(self.addr(i), to, port, payload);
        let now = self.now;
        self.nodes[i].c.guest_packet(&p, now);
        self.run();
    }

    /// Node `i` sends to node `j` and the lookup's call back completes.
    fn reach(&mut self, i: usize, j: usize, payload: &[u8]) {
        self.send(i, j, 9, payload);
        self.advance(Duration::from_millis(10));
    }

    /// The UDP payloads node `i`'s guest got, taken (other packets dropped).
    fn got(&mut self, i: usize) -> Vec<Vec<u8>> {
        std::mem::take(&mut self.nodes[i].guest)
            .into_iter()
            .filter(|p| p[6] == ip::UDP)
            .map(|p| p[48..].to_vec())
            .collect()
    }

    /// The ICMPv6 messages node `i`'s guest got: (type, code), taken.
    fn icmp(&mut self, i: usize) -> Vec<(u8, u8)> {
        std::mem::take(&mut self.nodes[i].guest)
            .into_iter()
            .filter(|p| p[6] == ip::ICMP6)
            .map(|p| (p[40], p[41]))
            .collect()
    }

    fn paths(&self, i: usize) -> Vec<String> {
        self.nodes[i]
            .events
            .iter()
            .filter(|e| e["type"] == "path")
            .map(|e| e["path"].as_str().unwrap().to_string())
            .collect()
    }

    fn rtc_state(&self, i: usize) -> Vec<Rtc> {
        self.nodes[i].c.peers.values().map(|p| p.rtc).collect()
    }

    fn logs(&self, i: usize) -> Vec<String> {
        self.nodes[i]
            .events
            .iter()
            .filter(|e| e["type"] == "log")
            .map(|e| e["msg"].as_str().unwrap().to_string())
            .collect()
    }

    /// A relay packet from key `src` to node `i`, on its first DERP connection.
    fn deliver(&mut self, i: usize, src: [u8; 32], p: &[u8]) {
        let (c, frame) = self.nodes[i]
            .conns
            .iter()
            .find_map(|(c, x)| match x {
                Conn::Derp { server, .. } => Some((*c, server.deliver(&src, p))),
                Conn::Nostr => None,
            })
            .unwrap();
        let now = self.now;
        self.nodes[i].c.ws_message(c, &frame, now);
        self.run();
    }

    /// How many times node `i` logged trouble with the Nostr relay (each one reconnects).
    fn nostr_troubles(&self, i: usize) -> usize {
        self.nodes[i]
            .events
            .iter()
            .filter(|e| e["type"] == "log" && e["msg"].as_str().unwrap().contains("Nostr"))
            .count()
    }

    /// Node `i`'s open DERP connections, by URL.
    fn regions(&self, i: usize) -> Vec<String> {
        self.nodes[i]
            .conns
            .values()
            .filter_map(|c| match c {
                Conn::Derp { url, .. } => Some(url.clone()),
                Conn::Nostr => None,
            })
            .collect()
    }

    /// A DNS query from node `i`'s guest to the room's resolver; the answer's addresses and rcode.
    fn resolve(&mut self, i: usize, name: &str, qtype: u16) -> (u8, Vec<[u8; 16]>) {
        let mut q = vec![0x12, 0x34, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0];
        for l in name.split('.') {
            q.push(l.len() as u8);
            q.extend_from_slice(l.as_bytes());
        }
        q.extend_from_slice(&[0]);
        q.extend_from_slice(&qtype.to_be_bytes());
        q.extend_from_slice(&[0, 1]);
        let to = self.nodes[i].c.resolver;
        let p = ip::udp(
            (IpAddr::V6(self.addr(i).into()), 5353),
            (IpAddr::V6(to.into()), 53),
            &q,
        );
        let now = self.now;
        self.nodes[i].c.guest_packet(&p, now);
        self.run();
        let a = self.nodes[i].guest.pop().expect("an answer");
        assert_eq!((&a[8..24], &a[24..40]), (&to[..], &self.addr(i)[..]));
        let m = &a[48..];
        let n = u16::from_be_bytes([m[6], m[7]]) as usize;
        let addrs = (0..n)
            .map(|k| m[m.len() - 16 * (n - k)..][..16].try_into().unwrap())
            .collect();
        (dns::rcode(m), addrs)
    }
}

/// Whether lookup event `e`, for `target`, is sealed to its key: another member of the room who
/// knows the address can't read it.
fn sealed(target: &Client, e: &Value) -> bool {
    let b = b64().decode(e["content"].as_str().unwrap()).unwrap();
    let x = e["tags"][0][1].as_str().unwrap();
    let mine = Lookup::open(&target.room, &target.private, &target.public, x, &b);
    assert!(mine.is_some(), "the target reads it");
    Lookup::open(&target.room, &key(99), &public(99), x, &b).is_none()
}

fn udp(src: [u8; 16], dst: [u8; 16], port: u16, payload: &[u8]) -> Vec<u8> {
    ip::udp(
        (IpAddr::V6(src.into()), 40000),
        (IpAddr::V6(dst.into()), port),
        payload,
    )
}

#[test]
fn a_rooms_derivations() {
    let r = Room::derive("test room");
    assert_eq!(
        r,
        Room::derive("test room"),
        "every member derives the same"
    );
    assert_eq!(r.prefix[0], 0xfd);
    assert_ne!(r.prefix, TAILCAT_PREFIX);
    assert_eq!(r.tag.len(), 8);
    assert_eq!(r.tag, base32(&r.prefix[1..]));
    let other = Room::derive("test room 2");
    assert_ne!(r.prefix, other.prefix);
    assert_ne!(r.psk, other.psk);
    let secrets = [r.salt, r.lookup, r.psk];
    for (i, a) in secrets.iter().enumerate() {
        for b in &secrets[i + 1..] {
            assert_ne!(a, b, "distinct labels");
        }
        assert_ne!(&a[..5], &r.prefix[1..]);
    }
    let k = public(1);
    let a = r.addr(&k);
    assert_eq!(&a[..6], &r.prefix);
    assert_eq!(&a[6..], &k[..10]);
    assert!(r.contains(&a));
    assert_eq!(&r.resolver()[..6], &r.prefix);
    assert_eq!(Ipv6Addr::from(r.resolver()).segments()[7], 0x53);
    let name = r.name(&k);
    assert_eq!(name, format!("{}.{}.p2p.alt", base32(&k), r.tag));
    assert_eq!(base32(&k).len(), 52);
    assert_eq!(base32(b"\x00\x44\x32\x14\xc7"), "abcdefgh");
    assert_eq!(base32(b"f"), "my", "RFC 4648's vector, lower case");
    assert_eq!(base32(b"fooba"), "mzxw6ytb");
    for b in [
        &b""[..],
        b"f",
        b"fo",
        b"foo",
        b"foob",
        b"fooba",
        b"foobar",
        &k,
    ] {
        assert_eq!(unbase32(&base32(b)).as_deref(), Some(b));
    }
    assert_eq!(unbase32("mz"), None, "trailing bits set: not canonical");
    assert_eq!(unbase32("m1"), None);
}

#[test]
fn a_lookup_finds_a_peer_and_its_packets_then_take_their_channel() {
    let mut n = Net::new(configs(&[1, 2]));
    n.send(0, 1, 9, b"first");
    let lookup = n.published.last().unwrap().clone();
    assert_eq!(lookup["kind"], KIND);
    assert_eq!(
        lookup["tags"][0][1],
        n.nodes[1].c.room.tag_for(&n.addr(1), T0 / 3600),
        "node 1's tag of the hour"
    );
    assert!(
        !sealed(&n.nodes[1].c, &lookup),
        "with the room's lookup key: node 0 knows only the address"
    );
    n.send(0, 1, 9, b"second"); // queued with the first, or after it
    n.advance(Duration::from_millis(10));
    assert_eq!(
        n.got(1),
        [b"first".to_vec(), b"second".to_vec()],
        "the call back carried them"
    );
    assert_eq!(n.published.len(), 1, "one lookup, answered");
    // The handshake is done: the lower key offers, the channel opens on both sides.
    assert_eq!(n.paths(0), ["direct"], "{:?}", n.nodes[0].events);
    assert_eq!(n.paths(1), ["direct"]);
    let (d0, d1) = (n.nodes[0].derp_packets, n.nodes[1].derp_packets);
    for k in 0..10u8 {
        n.send(0, 1, 9, &[k; 100]);
        n.send(1, 0, 9, &[k; 50]);
    }
    assert_eq!(n.got(1).len(), 10);
    assert_eq!(n.got(0).len(), 10);
    assert_eq!(
        (n.nodes[0].derp_packets, n.nodes[1].derp_packets),
        (d0, d1),
        "nothing more through the relay"
    );
    assert!(n.nodes[0].rtc_packets >= 10 && n.nodes[1].rtc_packets >= 10);
    // Each saw the other's name.
    let name = n.nodes[0].c.room.name(&public(2));
    assert!(
        n.nodes[0]
            .events
            .iter()
            .any(|e| e["type"] == "peer" && e["name"] == name)
    );
}

#[test]
fn a_name_resolves_by_computing_and_its_lookup_is_sealed_to_the_key() {
    let mut n = Net::new(configs(&[1, 2]));
    let name = n.nodes[0].c.room.name(&public(2));
    let self_event = n.nodes[1]
        .events
        .iter()
        .find(|e| e["type"] == "self")
        .unwrap()
        .clone();
    assert_eq!(self_event["name"], name.as_str(), "the name the page shows");
    let (rcode, addrs) = n.resolve(0, &name, dns::AAAA);
    assert_eq!((rcode, addrs), (dns::NOERROR, vec![n.addr(1)]));
    assert_eq!(n.resolve(0, &name.to_uppercase(), dns::AAAA).1, [n.addr(1)]);
    let (rcode, addrs) = n.resolve(0, &name, dns::A);
    assert_eq!(
        (rcode, addrs.len()),
        (dns::NOERROR, 0),
        "no IPv4 between guests"
    );
    for bad in [
        format!("{}.p2p.alt", n.nodes[0].c.room.tag),
        format!(
            "{}.{}",
            base32(&public(2)),
            Room::derive("another").domain()
        ),
        format!(
            "{}.{}",
            &base32(&public(2))[1..],
            n.nodes[0].c.room.domain()
        ),
        "example.com".into(),
    ] {
        assert_eq!(n.resolve(0, &bad, dns::AAAA).0, dns::NXDOMAIN, "{bad}");
    }
    let lease = n.nodes[0]
        .events
        .iter()
        .find(|e| e["type"] == "lease")
        .unwrap()["lease"]
        .clone();
    assert_eq!(lease["dns6"][0], json!(n.nodes[0].c.resolver));
    assert_eq!(lease["domains"][0], n.nodes[0].c.room.domain());
    n.reach(0, 1, b"by name");
    assert!(
        sealed(&n.nodes[1].c, &n.published[0]),
        "sealed to node 1's key"
    );
    assert_eq!(n.got(1), [b"by name".to_vec()]);
}

#[test]
fn nobody_at_an_address_is_unreachable_after_the_lookups() {
    let mut n = Net::new(configs(&[1]));
    let nobody = n.nodes[0].c.room.addr(&public(9));
    n.send_to(0, nobody, 9, b"anyone?");
    n.advance(Duration::from_millis(1500));
    assert_eq!(n.published.len(), 2, "again after 1 s");
    n.advance(Duration::from_secs(2));
    assert_eq!(n.published.len(), 3, "and after 3 s");
    assert!(n.icmp(0).is_empty(), "the packet still waits");
    n.advance(Duration::from_secs(3));
    assert_eq!(n.icmp(0), [(1, 3)], "address unreachable");
    assert_eq!(n.published.len(), 3, "then it gave up");
    n.send_to(0, nobody, 9, b"again");
    assert_eq!(n.icmp(0), [(1, 3)], "at once, for a while");
    assert_eq!(n.published.len(), 3);
    n.advance(Duration::from_secs(6));
    n.send_to(0, nobody, 9, b"later");
    assert_eq!(n.published.len(), 4, "looked up again later");
    // Outside the room, or to itself: dropped.
    n.send_to(0, Room::derive("other").addr(&public(9)), 9, b"x");
    let me = n.addr(0);
    n.send_to(0, me, 9, b"x");
    assert_eq!(n.published.len(), 4);
}

#[test]
fn stale_replayed_forged_and_misdirected_lookups_go_unanswered() {
    let mut n = Net::new(configs(&[2]));
    let room = n.nodes[0].c.room.clone();
    let target = n.addr(0);
    let hour = T0 / 3600;
    let mk = |time: u64, region: u16, nonce: u8| Lookup {
        key: public(1),
        region,
        time,
        nonce: [nonce; 16],
    };
    let calls = |n: &Net| n.nodes[0].c.peers.len();
    n.inject(&mk(T0 - 3700, 0, 1), &room, None, target, hour);
    assert_eq!(calls(&n), 0, "over an hour old");
    n.inject(&mk(T0 + 3700, 0, 2), &room, None, target, hour);
    assert_eq!(calls(&n), 0, "over an hour ahead");
    n.inject(&mk(T0, 5, 3), &room, None, target, hour);
    assert_eq!(calls(&n), 0, "a region outside the link");
    n.inject(&mk(T0, 0, 4), &Room::derive("another"), None, target, hour);
    assert_eq!(calls(&n), 0, "another room's keys");
    n.inject(&mk(T0, 0, 5), &room, Some(&public(3)), target, hour);
    assert_eq!(calls(&n), 0, "sealed to another key");
    let mut tagged = n.nodes[0].c.room.clone();
    tagged.salt[0] ^= 1;
    n.inject(&mk(T0, 0, 6), &tagged, None, target, hour);
    assert_eq!(calls(&n), 0, "under a tag that isn't ours");
    n.inject(&mk(T0, 0, 7), &room, None, target, hour + 3);
    assert_eq!(calls(&n), 0, "under a later hour's tag");
    let logs = n.logs(0).len();
    assert_eq!(logs, 3, "{:?}", n.logs(0)); // the three that opened said why
    // A good one is called back (to a key nobody holds here: on trial, then forgotten)...
    n.inject(&mk(T0, 0, 8), &room, None, target, hour);
    assert_eq!(calls(&n), 1);
    // ...and its copy, replayed after the trial ended, isn't.
    let replay = n.published.last().unwrap().clone();
    n.advance(Duration::from_secs(21));
    assert_eq!(calls(&n), 0, "the trial ended");
    n.forward(&replay);
    n.run();
    assert_eq!(calls(&n), 0, "replayed");
    // Beyond a few new peers a second: dropped.
    for k in 0..10u8 {
        let mut l = mk(T0 + 21, 0, 20 + k);
        l.key = public(30 + k);
        n.inject(&l, &room, None, target, hour);
    }
    assert_eq!(calls(&n), TRIALS_PER_SECOND);
}

#[test]
fn a_member_comes_in_by_its_lookup_unless_incoming_is_off() {
    let mut cfgs = configs(&[1, 2]);
    cfgs[1].incoming = false;
    let mut n = Net::new(cfgs);
    n.send(0, 1, 9, b"knock");
    n.advance(Duration::from_secs(7));
    assert!(n.got(1).is_empty());
    assert!(n.nodes[1].c.peers.is_empty(), "no call back");
    assert_eq!(n.icmp(0), [(1, 3)]);
    // Node 1's guest opens a flow to node 0: replies to it come in, nothing else.
    n.reach(1, 0, b"hi");
    assert_eq!(n.got(0), [b"hi".to_vec()]);
    let reply = |n: &Net, b: &[u8]| {
        ip::udp(
            (IpAddr::V6(n.addr(0).into()), 9),
            (IpAddr::V6(n.addr(1).into()), 40000),
            b,
        )
    };
    let p = reply(&n, b"reply");
    let now = n.now;
    n.nodes[0].c.guest_packet(&p, now);
    n.run();
    n.send(0, 1, 22, b"to another port");
    assert_eq!(n.got(1), [b"reply".to_vec()], "only the flow's reply");
    // Node 0's page reloads: its lookup for node 1 is answered, as node 1 has a flow with it.
    n.restart(0, config(1));
    n.reach(0, 1, b"again");
    n.advance(Duration::from_secs(5));
    let p = reply(&n, b"reply 2");
    let now = n.now;
    n.nodes[0].c.guest_packet(&p, now);
    n.run();
    assert_eq!(n.got(1), [b"reply 2".to_vec()]);
}

#[test]
fn a_handshake_without_the_rooms_key_lets_nobody_in() {
    let mut other = config(1);
    other.link.id = "another room".into();
    let mut n = Net::new(vec![other, config(2)]);
    // Node 0 is another room's: its handshake goes to node 1's key by hand.
    let to = n.nodes[1].c.room.addr(&public(2));
    let from = n.addr(0);
    let mut p = udp(from, to, 9, b"in?");
    pad(&mut p);
    let now = n.now;
    let id = n.nodes[0].c.add_peer(public(2), false, 0, now);
    let r = n.nodes[0].c.wg.send(now, [(id, vec![PacketMut::from(p)])]);
    n.nodes[0].c.send_to_peers(r.to_peers, now);
    n.advance(Duration::from_secs(19));
    assert_eq!(n.nodes[1].c.peers.len(), 1, "on trial");
    n.advance(Duration::from_secs(2));
    assert!(n.nodes[1].c.peers.is_empty(), "forgotten after 20 s");
    n.advance(Duration::from_secs(120));
    assert!(n.got(1).is_empty());
    assert!(!n.nodes[1].events.iter().any(|e| e["type"] == "peer"));
}

#[test]
fn a_peer_reaches_the_guest_only_from_its_own_address() {
    let mut n = Net::new(configs(&[1, 2]));
    n.reach(0, 1, b"ok");
    assert_eq!(n.got(1).len(), 1);
    // Node 0 sends, inside its session, packets with other source addresses.
    let id = n.nodes[0].c.by_addr[&n.addr(1)];
    for src in [n.nodes[0].c.room.addr(&public(3)), [0xfd; 16]] {
        let mut p = udp(src, n.addr(1), 9, b"forged");
        pad(&mut p);
        let now = n.now;
        let r = n.nodes[0].c.wg.send(now, [(id, vec![PacketMut::from(p)])]);
        n.nodes[0].c.send_to_peers(r.to_peers, now);
        n.run();
    }
    assert!(n.got(1).is_empty());
}

#[test]
fn the_guest_cant_use_the_signalling_port() {
    let mut n = Net::new(configs(&[1, 2]));
    n.reach(0, 1, b"ok");
    n.got(1);
    let before = n.nodes[0].derp_packets + n.nodes[0].rtc_packets;
    n.send(0, 1, SIGNAL_PORT, br#"{"n":1,"s":99,"t":"refuse"}"#);
    let p = ip::udp(
        (IpAddr::V6(n.addr(0).into()), SIGNAL_PORT),
        (IpAddr::V6(n.addr(1).into()), 9),
        b"from it",
    );
    let now = n.now;
    n.nodes[0].c.guest_packet(&p, now);
    n.run();
    assert_eq!(
        n.nodes[0].derp_packets + n.nodes[0].rtc_packets,
        before,
        "nothing left"
    );
    assert!(n.got(1).is_empty());
}

#[test]
fn relay_only_never_opens_a_channel() {
    for side in [0, 1] {
        let mut cfgs = configs(&[1, 2]);
        cfgs[side].relay_only = true;
        let mut n = Net::new(cfgs);
        n.reach(0, 1, b"a");
        for _ in 0..4 {
            n.advance(Duration::from_secs(30));
            n.send(1, 0, 9, b"b");
        }
        assert_eq!(n.got(1), [b"a".to_vec()]);
        assert_eq!(n.got(0).len(), 4);
        assert!(n.paths(0).is_empty() && n.paths(1).is_empty());
        assert!(
            n.ends.keys().all(|(i, _)| *i != side),
            "the relay-only side made no connection"
        );
        assert_eq!(n.rtc_state(0), [Rtc::Off], "side {side}");
        assert_eq!(n.rtc_state(1), [Rtc::Off]);
    }
}

#[test]
fn a_channel_that_never_opens_leaves_the_relay_carrying_and_is_tried_again_later() {
    let mut n = Net::new(configs(&[1, 2]));
    n.faults.block_rtc = true;
    n.reach(0, 1, b"a");
    n.advance(Duration::from_secs(5));
    assert!(n.paths(0).is_empty());
    n.advance(Duration::from_secs(6));
    assert!(n.ends.is_empty(), "the attempt was closed after 10 s");
    n.send(0, 1, 9, b"b");
    assert_eq!(n.got(1), [b"a".to_vec(), b"b".to_vec()]);
    // The next offer comes after the backoff, and works now.
    n.faults.block_rtc = false;
    n.advance(Duration::from_secs(25));
    assert!(n.paths(0).is_empty(), "not before 30 s");
    n.send(0, 1, 9, b"c");
    n.advance(Duration::from_secs(10));
    assert_eq!(n.paths(0), ["direct"]);
}

#[test]
fn a_closed_channel_falls_back_to_the_relay_then_opens_again() {
    let mut n = Net::new(configs(&[1, 2]));
    n.reach(0, 1, b"a");
    assert_eq!(n.paths(1), ["direct"]);
    // Node 1's page loses the connection (its ICE failed, say).
    let (&(i, rtc), _) = n.ends.iter().find(|((i, _), _)| *i == 1).unwrap();
    n.handle(i, Action::RtcClose { rtc });
    let now = n.now;
    n.nodes[1].c.rtc_closed(rtc, now);
    n.run();
    assert_eq!(n.paths(0), ["direct", "relay"]);
    assert_eq!(n.paths(1), ["direct", "relay"]);
    n.send(0, 1, 9, b"b");
    n.send(1, 0, 9, b"c");
    assert_eq!(n.got(1), [b"a".to_vec(), b"b".to_vec()]);
    assert_eq!(n.got(0), [b"c".to_vec()]);
    n.advance(Duration::from_secs(31));
    assert_eq!(n.paths(0), ["direct", "relay", "direct"]);
}

#[test]
fn a_stalled_channel_falls_back_to_the_relay() {
    let mut n = Net::new(configs(&[1, 2]));
    n.reach(0, 1, b"a");
    assert_eq!(n.paths(0), ["direct"]);
    n.got(1);
    n.faults.blackhole_rtc = true;
    n.send(0, 1, 9, b"lost");
    n.advance(Duration::from_secs(16));
    assert_eq!(n.paths(0), ["direct", "relay"], "{:?}", n.nodes[0].events);
    n.send(0, 1, 9, b"b");
    assert_eq!(n.got(1), [b"b".to_vec()]);
}

#[test]
fn signalling_survives_a_lossy_relay() {
    let mut n = Net::new(configs(&[1, 2]));
    n.faults.lossy_relay = true;
    n.send(0, 1, 9, b"a");
    for _ in 0..4 {
        n.advance(Duration::from_secs(5));
        n.send(0, 1, 9, b"more");
    }
    assert_eq!(n.paths(0), ["direct"], "{:?}", n.nodes[0].events);
    assert_eq!(n.paths(1), ["direct"]);
}

#[test]
fn a_restarted_peer_is_called_back_and_gets_a_new_channel() {
    let mut n = Net::new(configs(&[1, 2]));
    n.reach(0, 1, b"a");
    assert_eq!(n.paths(0), ["direct"]);
    // Node 1's page reloads: same key, a new instance; its old channel is gone.
    n.restart(1, config(2));
    n.send(1, 0, 9, b"back");
    // Node 0 has a session with that key: it probes it, nothing answers, it calls back.
    n.advance(Duration::from_secs(5));
    assert_eq!(n.got(0), [b"back".to_vec()]);
    assert!(n.icmp(1).is_empty());
    assert_eq!(
        n.paths(0),
        ["direct", "relay", "direct"],
        "{:?}",
        n.nodes[0].events
    );
    n.send(0, 1, 9, b"b");
    assert_eq!(n.got(1), [b"b".to_vec()]);
}

#[test]
fn a_forged_lookup_naming_a_live_peer_doesnt_move_it() {
    let mut cfgs = configs(&[1, 2]);
    for c in &mut cfgs {
        c.link = link(&["a.test", "b.test"]);
    }
    let mut n = Net::new(cfgs);
    n.reach(0, 1, b"a");
    n.got(1);
    // A member says node 0 looks node 1 up from region 1, where node 0 isn't.
    let room = n.nodes[1].c.room.clone();
    let l = Lookup {
        key: public(1),
        region: 1,
        time: T0,
        nonce: [9; 16],
    };
    let to = n.addr(1);
    n.inject(&l, &room, None, to, T0 / 3600);
    n.advance(Duration::from_secs(10));
    let id = n.nodes[1].c.by_addr[&n.addr(0)];
    assert_eq!(
        n.nodes[1].c.peers[&id].via, 0,
        "the probe was answered: not re-routed"
    );
    assert_eq!(n.paths(1), ["direct"], "the channel stayed");
    n.send(1, 0, 9, b"still");
    assert_eq!(n.got(0), [b"still".to_vec()]);
}

#[test]
fn a_peer_that_was_relay_only_and_restarted_without_gets_a_channel() {
    let mut cfgs = configs(&[1, 2]);
    cfgs[1].relay_only = true;
    let mut n = Net::new(cfgs);
    n.reach(0, 1, b"a");
    n.advance(Duration::from_secs(1));
    assert_eq!(n.rtc_state(0), [Rtc::Off]);
    n.restart(1, config(2));
    n.send(1, 0, 9, b"back");
    n.advance(Duration::from_secs(6));
    assert_eq!(n.got(0), [b"back".to_vec()]);
    assert_eq!(n.paths(0), ["direct"], "{:?}", n.nodes[0].events);
}

#[test]
fn the_call_back_joins_the_dialers_home_region_and_leaves_it_when_done() {
    let mut cfgs = configs(&[1, 2]);
    for c in &mut cfgs {
        c.link = link(&["a.test", "b.test"]);
    }
    cfgs[1].home = 1;
    cfgs[1].relay_only = true; // the relay carries it all
    let mut n = Net::new(cfgs);
    assert_eq!(n.regions(0), ["wss://a.test/derp"]);
    assert_eq!(n.regions(1), ["wss://b.test/derp"]);
    n.reach(0, 1, b"a");
    assert_eq!(n.got(1), [b"a".to_vec()]);
    assert_eq!(
        n.regions(1),
        ["wss://b.test/derp", "wss://a.test/derp"],
        "node 1 joined node 0's home region"
    );
    assert_eq!(n.regions(0), ["wss://a.test/derp"]);
    n.send(1, 0, 9, b"b");
    assert_eq!(n.got(0), [b"b".to_vec()]);
    let hello = n.nodes[0].c.peers.values().next().unwrap().region;
    assert_eq!(hello, Some(1), "each told the other its home region");
    // Quiet for three minutes: the peer is forgotten, and a minute on, the region is left.
    n.advance(Duration::from_secs(181));
    assert!(n.nodes[1].c.peers.is_empty());
    n.advance(Duration::from_secs(61));
    assert_eq!(n.regions(1), ["wss://b.test/derp"]);
}

#[test]
fn the_hour_turns_and_a_dialers_clock_may_be_off() {
    let mut cfgs = configs(&[1, 2, 3]);
    cfgs[2].unix_time = Some(T0 + 40 * 60); // node 2's clock is 40 minutes ahead
    let mut n = Net::new(cfgs);
    n.reach(2, 0, b"from the future");
    assert_eq!(n.got(0), [b"from the future".to_vec()]);
    // Past the hour (and the next): node 0 subscribes to the new hours' tags.
    n.advance(Duration::from_secs(2 * 3600));
    let tags: Vec<String> = n
        .subs
        .iter()
        .filter(|s| s.node == 0)
        .flat_map(|s| s.xs.clone())
        .collect();
    let hour = (T0 + 2 * 3600) / 3600;
    assert_eq!(tags.len(), 3, "one subscription: the old ones closed");
    assert!(tags.contains(&n.nodes[0].c.room.tag_for(&n.addr(0), hour)));
    assert!(!tags.contains(&n.nodes[0].c.room.tag_for(&n.addr(0), T0 / 3600)));
    n.reach(1, 0, b"later");
    assert_eq!(n.got(0), [b"later".to_vec()]);
}

#[test]
fn a_quiet_channel_closes_and_the_next_packet_offers_again() {
    let mut n = Net::new(configs(&[1, 2]));
    n.reach(0, 1, b"a");
    assert_eq!(n.paths(0), ["direct"]);
    n.advance(Duration::from_secs(61));
    assert_eq!(n.paths(0), ["direct", "relay"], "idle for a minute");
    assert!(n.ends.is_empty());
    n.advance(Duration::from_secs(60));
    assert_eq!(n.paths(0), ["direct", "relay"], "no offer without traffic");
    // The answerer's guest speaks first: the offerer sees it and offers.
    let answerer = if public(1) < public(2) { 1 } else { 0 };
    n.send(answerer, 1 - answerer, 9, b"b");
    n.advance(Duration::from_millis(10));
    assert_eq!(n.paths(0), ["direct", "relay", "direct"]);
}

#[test]
fn past_the_channel_cap_peers_go_through_the_relay() {
    let seeds: Vec<u8> = (1..=(MAX_RTC as u8 + 3)).collect();
    let mut n = Net::new(configs(&seeds));
    for j in 1..seeds.len() {
        n.reach(0, j, b"hi");
        n.advance(Duration::from_millis(200)); // within the lookups' rate
    }
    let open = n.ends.keys().filter(|(i, _)| *i == 0).count();
    assert_eq!(open, MAX_RTC, "node 0 holds at most {MAX_RTC} connections");
    for j in 1..seeds.len() {
        assert_eq!(n.got(j), [b"hi".to_vec()], "node {j}");
        n.send(j, 0, 9, b"back");
    }
    assert_eq!(
        n.got(0).len(),
        seeds.len() - 1,
        "every one of them, some through the relay"
    );
}

#[test]
fn a_peer_made_again_on_one_side_gets_its_channel_back() {
    let mut n = Net::new(configs(&[1, 2]));
    n.reach(0, 1, b"a");
    n.got(1);
    let o = if public(1) < public(2) { 0 } else { 1 };
    assert_eq!(n.paths(o), ["direct"]);
    // The offerer forgets the other (its region was down a while, say) and makes it again; the
    // other keeps its peer, with what it saw of the offerer's signalling.
    let other = public(if o == 0 { 2 } else { 1 });
    let id = n.nodes[o].c.by_addr[&n.addr(1 - o)];
    n.nodes[o].c.forget(id);
    let now = n.now;
    n.nodes[o].c.add_peer(other, false, 0, now);
    n.run();
    n.send(o, 1 - o, 9, b"again");
    n.advance(Duration::from_secs(1));
    assert_eq!(n.got(1 - o), [b"again".to_vec()]);
    assert_eq!(n.paths(o), ["direct", "relay", "direct"], "{:?}", n.logs(o));
}

#[test]
fn both_guests_dialing_at_once_get_through() {
    let mut n = Net::new(configs(&[1, 2]));
    let (a, b) = (n.addr(0), n.addr(1));
    let now = n.now;
    n.nodes[0].c.guest_packet(&udp(a, b, 9, b"from 0"), now);
    n.nodes[1].c.guest_packet(&udp(b, a, 9, b"from 1"), now);
    n.run();
    n.advance(Duration::from_secs(8));
    assert_eq!(n.got(1), [b"from 0".to_vec()]);
    assert_eq!(n.got(0), [b"from 1".to_vec()]);
    assert!(
        n.icmp(0).is_empty() && n.icmp(1).is_empty(),
        "nobody told unreachable"
    );
}

#[test]
fn junk_handshakes_dont_use_up_the_trials() {
    let mut n = Net::new(configs(&[1, 2]));
    // Anyone on node 1's region, knowing its key, sends initiation-sized junk.
    for k in 0..20u8 {
        let mut junk = vec![k; INITIATION.1];
        junk[0] = INITIATION.0;
        n.deliver(1, public(50 + k), &junk);
    }
    assert!(n.nodes[1].c.peers.is_empty());
    n.reach(0, 1, b"still");
    assert_eq!(n.got(1), [b"still".to_vec()]);
    // And unasked handshakes have their own budget: they don't block call backs.
    let mut cfgs = configs(&[1, 2]);
    cfgs[0].link.id = "another room".into(); // its handshakes can't complete in node 1's room
    let mut n = Net::new(vec![cfgs.remove(0), config(2), config(3)]);
    let now = n.now;
    for _ in 0..3 {
        let id = n.nodes[0].c.add_peer(public(2), false, 0, now);
        let r = n.nodes[0].c.wg.send(now, [(id, Vec::new())]);
        n.nodes[0].c.send_to_peers(r.to_peers, now);
        n.run();
        n.nodes[0].c.forget(id);
    }
    n.reach(2, 1, b"through");
    assert_eq!(n.got(1), [b"through".to_vec()]);
}

#[test]
fn a_forged_lookup_naming_another_region_doesnt_cut_a_key_off() {
    for dialer in [0, 1] {
        let mut cfgs = configs(&[1, 2]);
        for c in &mut cfgs {
            c.link = link(&["a.test", "b.test"]);
        }
        let mut n = Net::new(cfgs);
        // A member tells node 1 that node 0 looks it up from region 1, where node 0 isn't.
        let room = n.nodes[1].c.room.clone();
        let l = Lookup {
            key: public(1),
            region: 1,
            time: T0,
            nonce: [7; 16],
        };
        let to = n.addr(1);
        n.inject(&l, &room, None, to, T0 / 3600);
        assert_eq!(
            n.nodes[1].c.peers.len(),
            1,
            "on trial, its initiation lost in region 1"
        );
        // Whichever dials, they reach each other at once.
        n.send(dialer, 1 - dialer, 9, b"hi");
        n.advance(Duration::from_secs(1));
        assert_eq!(n.got(1 - dialer), [b"hi".to_vec()], "dialer {dialer}");
    }
}

#[test]
fn a_lost_call_back_is_sent_again_with_the_next_lookup() {
    let mut n = Net::new(configs(&[1, 2]));
    n.faults.drop_next_from = Some(1); // node 1's initiation
    n.send(0, 1, 9, b"a");
    n.advance(Duration::from_millis(1500));
    assert_eq!(
        n.got(1),
        [b"a".to_vec()],
        "with the lookup at 1 s, not WireGuard's 5 s"
    );
}

#[test]
fn a_guest_sweeping_the_room_is_bounded() {
    let mut n = Net::new(configs(&[1]));
    let room = n.nodes[0].c.room.clone();
    for k in 0..200u8 {
        let mut key = [0u8; 32];
        key[0] = k;
        n.send_to(0, room.addr(&key), 9, b"scan");
    }
    assert_eq!(n.nodes[0].c.pending.len(), MAX_PENDING);
    assert_eq!(n.icmp(0).len(), 200 - MAX_PENDING, "the rest at once");
    assert_eq!(
        n.published.len(),
        LOOKUPS_PER_SECOND,
        "a few a second on the relays"
    );
    n.advance(Duration::from_secs(7));
    assert!(n.nodes[0].c.pending.is_empty());
}

#[test]
fn a_relay_that_ends_our_subscription_or_goes_silent_is_subscribed_again() {
    let mut n = Net::new(configs(&[1, 2]));
    // The relay ends node 1's subscription.
    let s = n.subs.iter().position(|s| s.node == 1).unwrap();
    let sub = n.subs.remove(s);
    let closed = json!(["CLOSED", sub.id, "rate-limited: slow down"]).to_string();
    let now = n.now;
    n.nodes[1].c.ws_message(sub.conn, closed.as_bytes(), now);
    n.advance(Duration::from_secs(11));
    assert!(n.subs.iter().any(|s| s.node == 1), "subscribed again");
    n.reach(0, 1, b"found");
    assert_eq!(n.got(1), [b"found".to_vec()]);
    // The relay goes silent (a half-open connection): node 1 notices and connects again.
    let opens = n.nostr_troubles(1);
    n.faults.silent_nostr = true;
    n.advance(Duration::from_secs(80));
    assert!(n.nostr_troubles(1) > opens, "{:?}", n.logs(1));
    n.faults.silent_nostr = false;
    n.advance(Duration::from_secs(70));
    assert!(
        n.subs
            .iter()
            .any(|s| s.node == 1 && n.nodes[1].conns.contains_key(&s.conn))
    );
}

#[test]
fn a_failed_map_doesnt_stop_a_room_whose_home_is_its_own_derper() {
    let mut cfg = config(1);
    cfg.link.derp.push(Region::Map(900));
    let mut n = Net::new(vec![cfg]);
    let now = n.now;
    n.nodes[0].c.fetched(1, false, b"", now);
    n.run();
    assert_eq!(n.nodes[0].c.state, State::Running);
}
