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
    Derp {
        url: String,
        server: DerpServer,
    },
    /// A Nostr relay, by its URL (any that starts with `wss://nostr`).
    Nostr(String),
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
    /// The next WireGuard keepalive node `.0` sends is lost, on either path.
    drop_keepalive_from: Option<usize>,
    /// Node `.0` is ticked this long after the deadline it asks for (WireGuard's timers are a
    /// range, the module asks for its start; a busy worker's timer is late, a path has latency).
    late: Option<(usize, Duration)>,
    /// The Nostr relay takes what nodes send and does nothing (a half-open connection).
    silent_nostr: bool,
    /// The first DERP connection node `.0` opens to URL `.1` gets its server's hello only when
    /// `Net::release` says (a region far away, or down).
    hold_first: Vec<(usize, String)>,
    /// Node `.0`'s connections to URL `.1` after the first never get a hello (a region whose
    /// probe answers but whose DERP doesn't work).
    mute_after_first: Vec<(usize, String)>,
}

/// A subscription on the fake Nostr relay.
struct Sub {
    node: usize,
    conn: u32,
    /// The relay's URL.
    url: String,
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
    /// Hellos held by `Faults::hold_first`: (node, connection, the hello).
    held: Vec<(usize, u32, Vec<u8>)>,
    /// The (node, URL) pairs a DERP connection was opened for.
    opened: std::collections::BTreeSet<(usize, String)>,
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
        default_nostr: false,
        default_derp: false,
    }
}

fn config(seed: u8) -> Config {
    Config {
        link: link(&["derp.test"]),
        key: Some(key(seed)),
        home: None,
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
        let n = Net::build(cfgs, Faults::default());
        for x in &n.nodes {
            assert_eq!(x.c.state, State::Running);
        }
        n
    }

    /// The nodes started under `faults`, whatever state they reach.
    fn build(cfgs: Vec<Config>, faults: Faults) -> Net {
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
            faults,
            relayed: 0,
            held: Vec::new(),
            opened: Default::default(),
        };
        n.run();
        n
    }

    /// The held hellos arrive, on connections the client closed too (the page may still pass
    /// on what came before its close took effect), and then those connections close.
    fn release(&mut self) {
        let now = self.now;
        for (i, conn, hello) in std::mem::take(&mut self.held) {
            self.nodes[i].c.ws_message(conn, &hello, now);
            self.run();
            if !self.nodes[i].conns.contains_key(&conn) {
                self.nodes[i].c.ws_closed(conn, now);
            }
        }
        self.run();
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

    /// What node `i` sends Nostr relay `url`.
    fn nostr_in(&mut self, i: usize, conn: u32, url: String, text: &[u8]) {
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
                    url,
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
                self.forward_on(&e, Some(&url));
            }
            other => panic!("{other}"),
        }
    }

    /// Event `e`, published on every relay: each forwards it to every subscription it matches.
    fn forward(&mut self, e: &Value) {
        self.forward_on(e, None);
    }

    /// Event `e`, published on relay `url` (None: on every relay).
    fn forward_on(&mut self, e: &Value, url: Option<&str>) {
        self.published.push(e.clone());
        let x = e["tags"][0][1].as_str().unwrap();
        let kind = e["kind"].as_u64().unwrap();
        let to: Vec<(usize, u32, String)> = self
            .subs
            .iter()
            .filter(|s| url.is_none_or(|u| s.url == u))
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
                if url.starts_with("wss://nostr") {
                    assert_eq!(protocol, "");
                    self.nodes[i].conns.insert(conn, Conn::Nostr(url));
                    return;
                }
                assert_eq!(protocol, "derp");
                let server = DerpServer::new([100 + i as u8; 32]);
                let hello = server.hello();
                let hold = (self.faults.hold_first.iter()).position(|(j, u)| *j == i && *u == url);
                let mute = self.opened.contains(&(i, url.clone()))
                    && (self.faults.mute_after_first.iter()).any(|(j, u)| *j == i && *u == url);
                self.opened.insert((i, url.clone()));
                self.nodes[i].conns.insert(conn, Conn::Derp { url, server });
                if mute {
                    return;
                }
                if let Some(k) = hold {
                    self.faults.hold_first.remove(k);
                    self.held.push((i, conn, hello));
                    return;
                }
                self.nodes[i].c.ws_message(conn, &hello, now);
            }
            Action::WsSend { conn, data } => {
                let n = &mut self.nodes[i];
                let url = match n.conns.get_mut(&conn) {
                    Some(Conn::Nostr(url)) => {
                        let url = url.clone();
                        return self.nostr_in(i, conn, url, &data);
                    }
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
                    if self.lose_keepalive(i, &p) {
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
                if self.lose_keepalive(i, &data) {
                    return;
                }
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

    /// Whether node `i`'s WireGuard packet `p` is the keepalive `Faults::drop_keepalive_from` loses.
    fn lose_keepalive(&mut self, i: usize, p: &[u8]) -> bool {
        let lost = self.faults.drop_keepalive_from == Some(i) && p.len() == 32 && p[0] == 4;
        if lost {
            self.faults.drop_keepalive_from = None;
        }
        lost
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
        let late = self.faults.late;
        let due = move |j: usize, n: &Node| {
            let l = late
                .filter(|(k, _)| *k == j)
                .map_or(Duration::ZERO, |(_, l)| l);
            n.c.deadline().map(|t| t + l)
        };
        loop {
            self.run();
            let next = self
                .nodes
                .iter()
                .enumerate()
                .filter_map(|(j, n)| due(j, n))
                .min();
            match next {
                Some(t) if t <= end => {
                    self.now = t.max(self.now);
                    let now = self.now;
                    for (j, n) in self.nodes.iter_mut().enumerate() {
                        if due(j, n).is_some_and(|t| t <= now) {
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
                Conn::Nostr(_) => None,
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
                Conn::Nostr(_) => None,
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
    assert_eq!(name, format!("{}.{}.p2p.internal", base32(&k), r.tag));
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
        format!("{}.p2p.internal", n.nodes[0].c.room.tag),
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
    n.inject(&mk(T0 - 3700, INLINE_REGION, 1), &room, None, target, hour);
    assert_eq!(calls(&n), 0, "over an hour old");
    n.inject(&mk(T0 + 3700, INLINE_REGION, 2), &room, None, target, hour);
    assert_eq!(calls(&n), 0, "over an hour ahead");
    n.inject(&mk(T0, INLINE_REGION | 5, 3), &room, None, target, hour);
    assert_eq!(calls(&n), 0, "a region outside the link");
    n.inject(
        &mk(T0, INLINE_REGION, 4),
        &Room::derive("another"),
        None,
        target,
        hour,
    );
    assert_eq!(calls(&n), 0, "another room's keys");
    n.inject(
        &mk(T0, INLINE_REGION, 5),
        &room,
        Some(&public(3)),
        target,
        hour,
    );
    assert_eq!(calls(&n), 0, "sealed to another key");
    let mut tagged = n.nodes[0].c.room.clone();
    tagged.salt[0] ^= 1;
    n.inject(&mk(T0, INLINE_REGION, 6), &tagged, None, target, hour);
    assert_eq!(calls(&n), 0, "under a tag that isn't ours");
    n.inject(&mk(T0, INLINE_REGION, 7), &room, None, target, hour + 3);
    assert_eq!(calls(&n), 0, "under a later hour's tag");
    let logs = n.logs(0).len();
    assert_eq!(logs, 3, "{:?}", n.logs(0)); // the three that opened said why
    // A good one is called back (to a key nobody holds here: on trial, then forgotten)...
    n.inject(&mk(T0, INLINE_REGION, 8), &room, None, target, hour);
    assert_eq!(calls(&n), 1);
    // ...and its copy, replayed after the trial ended, isn't.
    let replay = n.published.last().unwrap().clone();
    n.advance(Duration::from_secs(21));
    assert_eq!(calls(&n), 0, "the trial ended");
    n.forward(&replay);
    n.run();
    assert_eq!(calls(&n), 0, "replayed");
}

#[test]
fn a_crowds_lookups_wait_for_the_budget_and_past_its_queue_are_dropped() {
    let mut n = Net::new(configs(&[2]));
    let room = n.nodes[0].c.room.clone();
    let target = n.addr(0);
    let hour = T0 / 3600;
    let calls = |n: &Net| n.nodes[0].c.peers.len();
    let crowd = TRIALS_PER_SECOND + MAX_CALLS_WAITING + 3;
    let lookup = |k: usize, nonce: u8| Lookup {
        key: public(30 + k as u8),
        region: INLINE_REGION,
        time: T0,
        nonce: [nonce; 16],
    };
    for k in 0..crowd {
        n.inject(&lookup(k, k as u8), &room, None, target, hour);
    }
    assert_eq!(calls(&n), TRIALS_PER_SECOND, "the budget's at once");
    // A dialer's resend doesn't take a second place.
    n.inject(&lookup(TRIALS_PER_SECOND, 200), &room, None, target, hour);
    let dropped = |n: &Net| {
        n.logs(0)
            .iter()
            .filter(|l| l.contains("too many new peers"))
            .count()
    };
    assert_eq!(dropped(&n), 3, "past the queue");
    n.advance(Duration::from_millis(1001));
    assert_eq!(calls(&n), 2 * TRIALS_PER_SECOND, "the next second's");
    n.advance(Duration::from_secs(3));
    assert_eq!(
        calls(&n),
        TRIALS_PER_SECOND + MAX_CALLS_WAITING,
        "the queue served in order within 4 s"
    );
    let first_dropped = public(30 + (TRIALS_PER_SECOND + MAX_CALLS_WAITING) as u8);
    assert!(n.nodes[0].c.peers.values().all(|p| p.key != first_dropped));
    n.advance(Duration::from_secs(2));
    assert_eq!(calls(&n), TRIALS_PER_SECOND + MAX_CALLS_WAITING);
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

/// Node `from` starts a handshake with key `to` by hand (no lookup), its guest's packet `b` waiting.
fn handshake_by_hand(n: &mut Net, from: usize, to: [u8; 32], b: &[u8]) {
    let dst = n.nodes[from].c.room.addr(&to);
    let mut p = udp(n.nodes[from].c.addr, dst, 9, b);
    pad(&mut p);
    let now = n.now;
    let id = n.nodes[from].c.add_peer(to, false, 0, now);
    let r = n.nodes[from]
        .c
        .wg
        .send(now, [(id, vec![PacketMut::from(p)])]);
    n.nodes[from].c.send_to_peers(r.to_peers, now);
}

#[test]
fn a_handshake_without_the_rooms_key_lets_nobody_in() {
    // Nodes 0..32 are another room's, with node 1's name: their initiations lack the room's proof.
    let outsiders = 2 * TRIALS_PER_SECOND;
    let mut cfgs: Vec<Config> = (0..outsiders)
        .map(|k| {
            let mut c = config(10 + k as u8);
            c.link.id = "another room".into();
            c
        })
        .collect();
    cfgs.extend([config(2), config(3)]);
    let mut n = Net::new(cfgs);
    let (target, member) = (outsiders, outsiders + 1);
    for k in 0..outsiders {
        handshake_by_hand(&mut n, k, public(2), b"in?");
    }
    n.run();
    let t = &n.nodes[target].c;
    assert!(t.peers.is_empty(), "nobody on trial");
    assert!(t.trials_in.is_empty(), "nothing charged to the budget");
    // A member's unasked handshake in the same second still gets in.
    handshake_by_hand(&mut n, member, public(2), b"member");
    n.run();
    assert_eq!(n.got(target), [b"member".to_vec()]);
    n.advance(Duration::from_secs(120));
    assert!(
        n.nodes[..outsiders]
            .iter()
            .all(|o| o.c.peers.values().all(|p| !p.confirmed))
    );
}

#[test]
fn an_initiation_carries_the_rooms_proof() {
    let room = Room::derive("r");
    let mut init = [5u8; 148];
    init[0] = 1;
    room.prove(&mut init);
    let mut copy = init;
    assert!(room.check_proof(&mut copy));
    assert_eq!(copy[132..], [0; 16], "cleared for WireGuard");
    assert_eq!(copy[..132], init[..132]);
    let mut copy = init;
    assert!(!Room::derive("r2").check_proof(&mut copy));
    let mut copy = init;
    copy[40] ^= 1;
    assert!(!room.check_proof(&mut copy), "over the initiation's bytes");
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
fn a_browser_without_direct_paths_stops_both_sides_offering_until_it_has_them_again() {
    for side in [0, 1] {
        let mut n = Net::new(configs(&[1, 2]));
        let other = 1 - side;
        let now = n.now;
        n.nodes[side].c.rtc_blocked(true, now);
        n.reach(0, 1, b"a");
        let made = |n: &Net, i: usize| n.nodes[i].c.next_rtc;
        let before = [made(&n, 0), made(&n, 1)];
        for _ in 0..12 {
            n.advance(Duration::from_secs(30));
            n.send(0, 1, 9, b"b");
            n.send(1, 0, 9, b"c");
        }
        assert_eq!(n.got(1).len(), 13, "side {side}: the relay carries");
        assert_eq!(n.got(0).len(), 12);
        assert_eq!(
            made(&n, side),
            before[side],
            "side {side}: the blocked side made no connection"
        );
        assert!(
            made(&n, other) <= before[other] + 1,
            "side {side}: the other stopped offering once told ({} made)",
            made(&n, other) - before[other]
        );
        assert_eq!(n.rtc_state(0), [Rtc::Off], "side {side}");
        assert_eq!(n.rtc_state(1), [Rtc::Off]);
        let told = n.nodes[other]
            .events
            .iter()
            .any(|e| e["type"] == "no-direct" && e["why"] == "blocked");
        assert!(told, "side {side}: the other side's page hears why");
        // The browser can again (a setting changed, another network): offered again at once.
        let now = n.now;
        n.nodes[side].c.rtc_blocked(false, now);
        n.run();
        n.advance(Duration::from_secs(1));
        assert_eq!(
            n.paths(0),
            ["direct"],
            "side {side}: {:?}",
            n.nodes[0].events
        );
        assert_eq!(n.paths(1), ["direct"]);
        for i in [0, 1] {
            n.nodes[i].c.check_rtcs();
        }
    }
}

#[test]
fn a_browser_that_loses_direct_paths_closes_its_channels_and_gets_them_back() {
    let mut n = Net::new(configs(&[1, 2]));
    n.reach(0, 1, b"a");
    assert_eq!(n.paths(0), ["direct"]);
    let now = n.now;
    n.nodes[1].c.rtc_blocked(true, now);
    n.run();
    n.advance(Duration::from_millis(100));
    assert_eq!(n.paths(0), ["direct", "relay"]);
    assert_eq!(n.paths(1), ["direct", "relay"]);
    assert!(n.ends.is_empty(), "both ends closed");
    n.send(0, 1, 9, b"b");
    assert_eq!(n.got(1), [b"a".to_vec(), b"b".to_vec()]);
    for _ in 0..10 {
        n.advance(Duration::from_secs(60));
        n.send(0, 1, 9, b"x");
        n.send(1, 0, 9, b"y");
    }
    assert!(n.ends.is_empty(), "no offers while blocked");
    assert_eq!(n.rtc_state(0), [Rtc::Off]);
    // Unblocked: the peer, still in a session, is offered at once (no backoff behind it).
    n.send(0, 1, 9, b"c");
    let now = n.now;
    n.nodes[1].c.rtc_blocked(false, now);
    n.run();
    n.advance(Duration::from_secs(1));
    assert_eq!(n.paths(0), ["direct", "relay", "direct"]);
    for i in [0, 1] {
        n.nodes[i].c.check_rtcs();
    }
}

#[test]
fn a_failed_attempt_says_why_to_the_page() {
    let mut n = Net::new(configs(&[1, 2]));
    n.faults.block_rtc = true;
    n.reach(0, 1, b"a");
    n.advance(Duration::from_secs(11));
    // The offerer's attempt ran out (the answerer never saw it).
    let i = if public(1) < public(2) { 0 } else { 1 };
    let failed = n.nodes[i]
        .events
        .iter()
        .any(|e| e["type"] == "no-direct" && e["why"] == "failed");
    assert!(failed, "node {i}: {:?}", n.nodes[i].events);
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
    n.advance(RTC_STALL + Duration::from_secs(1));
    assert_eq!(n.paths(0), ["direct", "relay"], "{:?}", n.nodes[0].events);
    n.send(0, 1, 9, b"b");
    assert_eq!(n.got(1), [b"b".to_vec()]);
}

/// Node 0's guest streams UDP to node 1's for a minute, which never answers (only WireGuard's
/// passive keepalive comes back, every 9 to 11 s: here the end of that, and 200 ms of latency),
/// and one of node 1's keepalives is lost after 15 s.
fn one_way_with_a_keepalive_lost(n: &mut Net) {
    n.faults.late = Some((1, Duration::from_millis(1200)));
    for k in 0..600 {
        if k == 150 {
            n.faults.drop_keepalive_from = Some(1);
        }
        n.send(0, 1, 9, b"stream");
        n.advance(Duration::from_millis(100));
    }
    assert!(
        n.faults.drop_keepalive_from.is_none(),
        "a keepalive was lost"
    );
    assert_eq!(n.got(1).len(), 600);
}

#[test]
fn one_lost_keepalive_keeps_the_direct_path() {
    let mut n = Net::new(configs(&[1, 2]));
    n.reach(0, 1, b"a");
    assert_eq!(n.paths(0), ["direct"]);
    n.got(1);
    one_way_with_a_keepalive_lost(&mut n);
    assert_eq!(n.paths(0), ["direct"], "{:?}", n.logs(0));
}

#[test]
fn one_lost_keepalive_keeps_the_peer() {
    let mut cfgs = configs(&[1, 2]);
    cfgs[1].relay_only = true; // through the relay
    let mut n = Net::new(cfgs);
    n.reach(0, 1, b"a");
    n.got(1);
    one_way_with_a_keepalive_lost(&mut n);
    let gone = n.nodes[0]
        .events
        .iter()
        .filter(|e| e["type"] == "peer-gone")
        .count();
    assert_eq!(gone, 0, "{:?}", n.logs(0));
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
        region: INLINE_REGION | 1,
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
    cfgs[1].home = Some(1);
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
fn the_hours_turn_waits_for_the_next_renewal() {
    // Both clocks 30 s ahead: the hour turns half a minute before a renewal.
    let mut cfgs = configs(&[1, 2]);
    for c in &mut cfgs {
        c.unix_time = Some(T0 + 30);
    }
    let mut n = Net::new(cfgs);
    let tags = |n: &Net| -> Vec<String> {
        n.subs
            .iter()
            .filter(|s| s.node == 0)
            .flat_map(|s| s.xs.clone())
            .collect()
    };
    let hour = T0 / 3600;
    let tag = |n: &Net, h: u64| n.nodes[0].c.room.tag_for(&n.addr(0), h);
    let turn = Duration::from_secs(3600 - (T0 + 30) % 3600);
    n.advance(turn + Duration::from_secs(1));
    assert!(
        !tags(&n).contains(&tag(&n, hour + 2)),
        "not renewed at the turn"
    );
    // A dialer in the new hour finds it: the subscription had the next hour's tag.
    n.reach(1, 0, b"in the new hour");
    assert_eq!(n.got(0), [b"in the new hour".to_vec()]);
    n.advance(Duration::from_secs(60));
    let t = tags(&n);
    assert_eq!(t.len(), 3, "one subscription: the old one closed");
    assert!(t.contains(&tag(&n, hour + 2)), "renewed within a minute");
    assert!(!t.contains(&tag(&n, hour - 1)));
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
    n.advance(Duration::from_secs(5)); // the last waited for the connections' rate
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
    n.advance(RTC_GAP);
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
            region: INLINE_REGION | 1,
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
    for s in 1..=7 {
        n.advance(Duration::from_secs(1));
        assert!(
            n.published.len() <= (s + 1) * LOOKUPS_PER_SECOND,
            "at {s} s"
        );
    }
    // Each went out (first sends before resends), then was given up.
    n.advance(LOOKUP_GIVE_UP);
    assert!(n.nodes[0].c.pending.is_empty());
    assert_eq!(n.icmp(0).len(), MAX_PENDING);
}

#[test]
fn a_guest_dialing_many_members_at_once_reaches_them_all() {
    let members = 4 * LOOKUPS_PER_SECOND - 2;
    let seeds: Vec<u8> = (1..=members as u8 + 1).collect();
    let mut n = Net::new(configs(&seeds));
    let now = n.now;
    for j in 1..=members {
        let p = udp(n.addr(0), n.addr(j), 9, b"hi");
        n.nodes[0].c.guest_packet(&p, now);
    }
    n.run();
    assert_eq!(n.published.len(), LOOKUPS_PER_SECOND, "the rate's at once");
    n.advance(LOOKUP_GIVE_UP);
    for j in 1..=members {
        assert_eq!(n.got(j), [b"hi".to_vec()], "member {j}");
    }
    assert!(n.icmp(0).is_empty(), "nobody unreachable");
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
fn a_failed_map_doesnt_stop_a_room_with_a_derper_of_its_own() {
    // Configured home of its own: up at once, the map loading or not.
    let mut cfg = config(1);
    cfg.link.derp.push(Region::Map(900));
    cfg.home = Some(0);
    let mut n = Net::new(vec![cfg]);
    let now = n.now;
    n.nodes[0].c.fetched(1, false, b"", now);
    n.run();
    assert_eq!(n.nodes[0].c.state, State::Running);
    // Home to be chosen: it waits for the map (its regions are candidates), and without it
    // takes its own, whichever comes first in the link.
    for derp in [
        vec![
            Region::Map(900),
            Region::Inline(tailcat::parse_relay("derp.test").unwrap()),
        ],
        vec![
            Region::Inline(tailcat::parse_relay("derp.test").unwrap()),
            Region::Map(900),
        ],
    ] {
        let mut cfg = config(1);
        cfg.link.derp = derp;
        let mut n = Net::build(vec![cfg], Faults::default());
        assert_eq!(n.nodes[0].c.state, State::FetchingMap);
        let now = n.now;
        n.nodes[0].c.fetched(1, false, b"", now);
        n.run();
        assert_eq!(n.nodes[0].c.state, State::Running);
        assert_eq!(n.regions(0), ["wss://derp.test/derp"]);
    }
}

#[test]
fn a_failed_client_stays_off_nostr() {
    let mut cfg = config(1);
    cfg.link.derp = vec![Region::Map(0)];
    let now = Instant::now();
    let mut c = Client::new(cfg, now).unwrap();
    while c.poll().is_some() {}
    c.fetched(1, false, b"", now); // the map doesn't load: Failed, before the relay's EOSE
    while c.poll().is_some() {}
    assert_eq!(c.state, State::Failed);
    let mut t = now;
    for _ in 0..30 {
        let Some(d) = c.deadline() else { break };
        t = d.max(t);
        c.tick(t);
        while let Some(a) = c.poll() {
            assert!(
                !matches!(a, Action::WsOpen { .. }),
                "opened again at {:?}",
                t - now
            );
        }
    }
}

#[test]
fn a_member_cant_churn_our_peer_connections() {
    let mut n = Net::new(configs(&[1, 2]));
    n.reach(0, 1, b"a");
    let o = if public(1) < public(2) { 0 } else { 1 };
    let a = 1 - o;
    let id = n.nodes[o].c.by_addr[&n.addr(a)];
    let before = n.nodes[a].c.next_rtc;
    let now = n.now;
    for k in 0..200u32 {
        let m = Msg {
            t: "sig".into(),
            o: 1000 + k,
            d: json!({ "candidate": "x" }).to_string(),
            ..Msg::default()
        };
        n.nodes[o].c.signal(id, m, now);
        n.run();
    }
    assert_eq!(
        n.nodes[a].c.next_rtc - before,
        0,
        "within the gap of the last"
    );
    // Past the gap, one more, however many come.
    n.now += RTC_GAP;
    let now = n.now;
    for k in 0..200u32 {
        let m = Msg {
            t: "sig".into(),
            o: 2000 + k,
            d: json!({ "candidate": "x" }).to_string(),
            ..Msg::default()
        };
        n.nodes[o].c.signal(id, m, now);
        n.run();
    }
    assert_eq!(n.nodes[a].c.next_rtc - before, 1);
}

#[test]
fn a_forgotten_peer_says_so() {
    let mut n = Net::new(configs(&[1, 2]));
    n.reach(0, 1, b"a");
    n.advance(PEER_IDLE + Duration::from_secs(5));
    assert!(n.nodes[0].c.peers.is_empty());
    let gone: Vec<&Value> = n.nodes[0]
        .events
        .iter()
        .filter(|e| e["type"] == "peer-gone")
        .collect();
    assert_eq!(gone.len(), 1);
    assert_eq!(gone[0]["address6"], json!(n.addr(1)));
}

#[test]
fn a_forged_lookup_makes_no_direct_connection_until_the_guests_speak() {
    let mut n = Net::new(configs(&[1, 2, 3]));
    // Node 2 tells node 0 that node 1 looks it up: node 0 calls node 1 back.
    let room = n.nodes[0].c.room.clone();
    let l = Lookup {
        key: public(2),
        region: INLINE_REGION,
        time: T0,
        nonce: [5; 16],
    };
    let to = n.addr(0);
    n.inject(&l, &room, None, to, T0 / 3600);
    n.advance(Duration::from_secs(2));
    let confirmed = |n: &Net, i: usize| n.nodes[i].c.peers.values().any(|p| p.confirmed);
    assert!(
        confirmed(&n, 0) && confirmed(&n, 1),
        "a session, as a call back makes"
    );
    assert!(
        n.ends.is_empty(),
        "no WebRTC connection: neither guest asked"
    );
    assert!(n.paths(0).is_empty() && n.paths(1).is_empty());
    // The guests' first packet brings one.
    n.send(0, 1, 9, b"now");
    n.advance(Duration::from_millis(10));
    assert_eq!(n.got(1), [b"now".to_vec()]);
    assert_eq!(n.paths(0), ["direct"]);
}

#[test]
fn a_forgotten_peers_channel_closes_before_it_says_gone() {
    let mut n = Net::new(configs(&[1, 2]));
    n.reach(0, 1, b"a");
    assert_eq!(n.paths(0), ["direct"]);
    let id = n.nodes[0].c.by_addr[&n.addr(1)];
    n.nodes[0].c.forget(id); // idle, lost, or its probe unanswered
    n.run();
    let kinds: Vec<&str> = n.nodes[0]
        .events
        .iter()
        .map(|e| e["type"].as_str().unwrap())
        .filter(|t| ["peer", "path", "peer-gone"].contains(t))
        .collect();
    // A `path` after `peer-gone` would bring it back in the page's list (web/room.ts).
    assert_eq!(kinds, ["peer", "path", "path", "peer-gone"]);
}

/// Junk under `tag`, different for each `k` (copies of one are opened once): a member's (the
/// room's MAC holds, nothing opens) or an outsider's.
fn junk(room: &Room, tag: &str, k: u32, member: bool) -> Value {
    let mut junk = [7u8; lookup::SIZE];
    junk[..4].copy_from_slice(&k.to_le_bytes());
    if member {
        let m = lookup::mac(room, tag, &junk[..lookup::SIZE - 16]);
        junk[lookup::SIZE - 16..].copy_from_slice(&m);
    }
    nostr::Author::random()
        .unwrap()
        .event(KIND, tag, &b64().encode(junk), T0)
}

#[test]
fn junk_under_our_tag_is_opened_only_within_a_budget() {
    let mut n = Net::new(configs(&[2]));
    let room = n.nodes[0].c.room.clone();
    let target = n.addr(0);
    let tag = room.tag_for(&target, T0 / 3600);
    let good = |nonce: u8| Lookup {
        key: public(1),
        region: INLINE_REGION,
        time: T0,
        nonce: [nonce; 16],
    };
    // An outsider's (it saw a lookup to us, so it has the tag) costs no budget.
    for k in 0..10 * LOOKUP_EVENTS_PER_SECOND as u32 {
        n.forward(&junk(&room, &tag, k, false));
    }
    n.run();
    assert!(n.nodes[0].c.lookups_in.iter().all(|w| w.is_empty()));
    n.inject(&good(3), &room, None, target, T0 / 3600);
    assert_eq!(
        n.nodes[0].c.peers.len(),
        1,
        "an outsider's flood keeps nobody out"
    );
    let id = n.nodes[0].c.by_addr[&room.addr(&public(1))];
    n.nodes[0].c.forget(id);
    n.advance(Duration::from_millis(1001));
    // A member's is opened, within the budget.
    for k in 0..LOOKUP_EVENTS_PER_SECOND as u32 {
        n.forward(&junk(&room, &tag, k, true));
    }
    n.inject(&good(1), &room, None, target, T0 / 3600);
    assert!(n.nodes[0].c.peers.is_empty(), "past the second's budget");
    n.advance(Duration::from_millis(1001));
    n.inject(&good(2), &room, None, target, T0 / 3600);
    assert_eq!(n.nodes[0].c.peers.len(), 1, "the next second's");
}

/// A node on six relays (as the default link's), and a lookup to it of `key`'s.
fn six_relays() -> (Net, impl Fn(u8, u8) -> Lookup) {
    let mut cfg = config(2);
    cfg.link.nostr = (0..6).map(|k| format!("wss://nostr{k}.test")).collect();
    let n = Net::new(vec![cfg]);
    let lookup = |key: u8, nonce: u8| Lookup {
        key: public(key),
        region: INLINE_REGION,
        time: T0,
        nonce: [nonce; 16],
    };
    (n, lookup)
}

#[test]
fn a_lookups_copies_through_every_relay_cost_the_budget_once() {
    let (mut n, lookup) = six_relays();
    let room = n.nodes[0].c.room.clone();
    let target = n.addr(0);
    // Each lookup reaches the node through all six relays.
    let dialers = TRIALS_PER_SECOND + MAX_CALLS_WAITING - 4;
    for k in 0..dialers {
        n.inject(
            &lookup(30 + k as u8, k as u8),
            &room,
            None,
            target,
            T0 / 3600,
        );
    }
    let c = &n.nodes[0].c;
    assert_eq!(
        c.peers.len() + c.calls_waiting.len(),
        dialers,
        "every dialer called back, or waiting its turn"
    );
    let charged: usize = c.lookups_in.iter().map(|w| w.len()).sum();
    assert_eq!(charged, dialers, "each lookup charged once, not per copy");
}

#[test]
fn junk_through_one_relay_doesnt_block_lookups_through_the_others() {
    let (mut n, lookup) = six_relays();
    let room = n.nodes[0].c.room.clone();
    let target = n.addr(0);
    let tag = room.tag_for(&target, T0 / 3600);
    for k in 0..300u32 {
        n.forward_on(&junk(&room, &tag, k, true), Some("wss://nostr0.test"));
    }
    n.run();
    let l = lookup(1, 1);
    let content = b64().encode(l.seal(&room, None, &tag));
    let e = nostr::Author::random()
        .unwrap()
        .event(KIND, &tag, &content, T0);
    for k in 1..6 {
        n.forward_on(&e, Some(&format!("wss://nostr{k}.test")));
    }
    n.run();
    assert_eq!(n.nodes[0].c.peers.len(), 1, "called back");
}

#[test]
fn the_home_region_is_the_first_to_answer_a_probe() {
    let mut cfgs = configs(&[1, 2]);
    for c in &mut cfgs {
        c.link = link(&["a.test", "b.test", "c.test"]);
    }
    cfgs[1].home = Some(0); // configured: no probes
    let faults = Faults {
        hold_first: vec![
            (0, "wss://a.test/derp".into()),
            (0, "wss://b.test/derp".into()),
        ],
        ..Faults::default()
    };
    let mut n = Net::build(cfgs, faults);
    assert_eq!(n.nodes[0].c.state, State::Running);
    assert_eq!(n.nodes[0].c.home, 2, "c answered first");
    assert_eq!(
        n.regions(0),
        ["wss://c.test/derp"],
        "the other probes closed"
    );
    assert_eq!(
        n.regions(1),
        ["wss://a.test/derp"],
        "a configured home isn't probed"
    );
    n.release(); // the slower regions' answers come too late to matter
    assert_eq!(n.nodes[0].c.home, 2);
    assert_eq!(n.regions(0), ["wss://c.test/derp"]);
    // The lookup says the dialer's home region, and the call back goes there.
    n.reach(1, 0, b"a");
    assert_eq!(n.got(0), [b"a".to_vec()]);
    assert_eq!(n.regions(0), ["wss://c.test/derp", "wss://a.test/derp"]);
    n.send(0, 1, 9, b"b");
    assert_eq!(n.got(1), [b"b".to_vec()]);
    assert_eq!(
        n.nodes[1].c.peers.values().next().unwrap().region,
        Some(2),
        "its hello named c"
    );
}

#[test]
fn with_no_probe_answering_in_time_the_first_region_is_home() {
    let mut cfg = config(1);
    cfg.link = link(&["a.test", "b.test"]);
    let faults = Faults {
        hold_first: vec![
            (0, "wss://a.test/derp".into()),
            (0, "wss://b.test/derp".into()),
        ],
        ..Faults::default()
    };
    let mut n = Net::build(vec![cfg], faults);
    assert_eq!(n.nodes[0].c.state, State::Connecting);
    n.advance(PROBE_WAIT - Duration::from_millis(1));
    assert_eq!(n.nodes[0].c.state, State::Connecting, "still waiting");
    n.advance(Duration::from_millis(1));
    assert_eq!(n.nodes[0].c.state, State::Running);
    assert_eq!(n.nodes[0].c.home, 0);
    assert_eq!(n.regions(0), ["wss://a.test/derp"], "the probes closed");
    assert!(
        n.nodes[0].events.iter().any(|e| e["type"] == "log"
            && e["msg"]
                .as_str()
                .unwrap()
                .starts_with("DERP: no region answered")),
        "said"
    );
    n.release();
    assert_eq!(n.regions(0), ["wss://a.test/derp"]);
}

#[test]
fn a_link_without_regions_takes_the_maps_and_the_nearest_is_home() {
    let mut cfg = config(1);
    cfg.link.derp = vec![Region::Map(0)];
    cfg.link.default_derp = true;
    let faults = Faults {
        hold_first: vec![(0, "wss://a.test/derp".into())],
        ..Faults::default()
    };
    let mut n = Net::build(vec![cfg], faults);
    assert_eq!(n.nodes[0].c.state, State::FetchingMap);
    let map = br#"{"Regions":{"12":{"Nodes":[{"HostName":"b.test"}]},"9":{"Nodes":[{"HostName":"a.test"}]},"20":{"Nodes":[{"HostName":"stun.test","STUNOnly":true}]}}}"#;
    let now = n.now;
    n.nodes[0].c.fetched(1, true, map, now);
    n.run();
    assert_eq!(n.nodes[0].c.state, State::Running);
    assert_eq!(
        n.nodes[0].c.cfg.link.derp,
        [Region::Map(9), Region::Map(12)],
        "the map's DERP regions, lowest ID first"
    );
    assert_eq!(n.nodes[0].c.home, 1, "b answered first");
    assert_eq!(n.regions(0), ["wss://b.test/derp"]);
    assert_eq!(
        n.nodes[0].c.cfg.link.encode(),
        "waarm64-room:test%20room?nostr=wss%3A%2F%2Fnostr.test",
        "the link handed out still follows the defaults"
    );
}

#[test]
fn every_probe_closing_falls_back_at_once_and_says_why() {
    let mut cfg = config(1);
    cfg.link = link(&["a.test", "b.test"]);
    let faults = Faults {
        hold_first: vec![
            (0, "wss://a.test/derp".into()),
            (0, "wss://b.test/derp".into()),
        ],
        ..Faults::default()
    };
    let mut n = Net::build(vec![cfg], faults);
    let probes: Vec<u32> = n.nodes[0].conns.keys().copied().collect::<Vec<_>>();
    let now = n.now;
    for conn in probes {
        if !matches!(n.nodes[0].conns.get(&conn), Some(Conn::Derp { .. })) {
            continue;
        }
        n.nodes[0].conns.remove(&conn);
        n.nodes[0].c.ws_closed(conn, now);
    }
    n.held.clear();
    n.run();
    assert_eq!(
        n.nodes[0].c.state,
        State::Running,
        "without waiting out the 3 s"
    );
    assert_eq!(n.regions(0), ["wss://a.test/derp"]);
    assert!(n.nodes[0].events.iter().any(|e| {
        e["type"] == "log"
            && e["msg"]
                .as_str()
                .unwrap()
                .starts_with("DERP: every region's probe closed")
    }));
}

#[test]
fn a_probe_answered_by_something_other_than_a_derper_doesnt_count() {
    let mut cfg = config(1);
    cfg.link = link(&["a.test", "b.test"]);
    let faults = Faults {
        hold_first: vec![
            (0, "wss://a.test/derp".into()),
            (0, "wss://b.test/derp".into()),
        ],
        ..Faults::default()
    };
    let mut n = Net::build(vec![cfg], faults);
    let (_, a, _) = n.held[0].clone();
    let now = n.now;
    n.nodes[0].c.ws_message(a, b"HTTP/1.1 200 OK", now); // a's answer isn't a server key
    n.run();
    assert_eq!(n.nodes[0].c.state, State::Connecting, "b's probe still out");
    n.held.remove(0);
    n.release(); // b's real answer
    assert_eq!(n.nodes[0].c.state, State::Running);
    assert_eq!(n.nodes[0].c.home, 1);
}

#[test]
fn a_home_that_keeps_failing_before_running_hands_over_to_the_next_region() {
    let mut cfg = config(1);
    cfg.link = link(&["a.test", "b.test"]);
    // a's probe answers first, but its DERP connections never get a hello; b's probe is slower.
    let faults = Faults {
        hold_first: vec![(0, "wss://b.test/derp".into())],
        mute_after_first: vec![(0, "wss://a.test/derp".into())],
        ..Faults::default()
    };
    let mut n = Net::build(vec![cfg], faults);
    assert_eq!(n.nodes[0].c.home, 0);
    assert_eq!(n.nodes[0].c.state, State::Connecting);
    n.advance(Duration::from_secs(300));
    assert_eq!(n.nodes[0].c.state, State::Running, "b took over");
    assert_eq!(n.nodes[0].c.home, 1);
    assert_eq!(n.regions(0), ["wss://b.test/derp"], "a's left");
}

#[test]
fn members_with_different_maps_name_the_same_region() {
    // Node 0 loaded the map before region 5 went; node 1 after. A default link takes the map's
    // regions, so their indexes differ, but lookups and hellos name regions by ID.
    let before = br#"{"Regions":{"5":{"Nodes":[{"HostName":"e.test"}]},"7":{"Nodes":[{"HostName":"g.test"}]},"9":{"Nodes":[{"HostName":"i.test"}]}}}"#;
    let after = br#"{"Regions":{"7":{"Nodes":[{"HostName":"g.test"}]},"9":{"Nodes":[{"HostName":"i.test"}]}}}"#;
    let mut cfgs = configs(&[1, 2]);
    for c in &mut cfgs {
        c.link.derp = vec![Region::Map(0)];
        c.link.default_derp = true;
    }
    // Node 0's nearest is 9 (index 2 for it), node 1's is 7.
    let faults = Faults {
        hold_first: vec![
            (0, "wss://e.test/derp".into()),
            (0, "wss://g.test/derp".into()),
            (1, "wss://i.test/derp".into()),
        ],
        ..Faults::default()
    };
    let mut n = Net::build(cfgs, faults);
    let now = n.now;
    n.nodes[0].c.fetched(1, true, before, now);
    n.nodes[1].c.fetched(1, true, after, now);
    n.run();
    assert_eq!(n.nodes[0].c.home, 2);
    assert_eq!(n.nodes[1].c.home, 0);
    n.reach(0, 1, b"a");
    assert_eq!(n.got(1), [b"a".to_vec()]);
    assert_eq!(
        n.regions(1),
        ["wss://g.test/derp", "wss://i.test/derp"],
        "node 1 called back into node 0's home, region 9 (its index 1)"
    );
    n.send(1, 0, 9, b"b");
    assert_eq!(n.got(0), [b"b".to_vec()]);
}

#[test]
fn the_map_takes_at_most_eight_regions_and_skips_those_not_for_home() {
    let regions: Vec<String> = (1..=10)
        .map(|k| {
            let flag = if k == 1 {
                r#","Avoid":true"#
            } else if k == 2 {
                r#","NoMeasureNoHome":true"#
            } else {
                ""
            };
            format!(r#""{k}":{{"Nodes":[{{"HostName":"r{k}.test"}}]{flag}}}"#)
        })
        .collect();
    let map = format!(r#"{{"Regions":{{{}}}}}"#, regions.join(","));
    let mut cfg = config(1);
    cfg.link.derp = vec![Region::Map(0)];
    cfg.link.default_derp = true;
    let mut n = Net::build(vec![cfg], Faults::default());
    let now = n.now;
    n.nodes[0].c.fetched(1, true, map.as_bytes(), now);
    n.run();
    assert_eq!(
        n.nodes[0].c.cfg.link.derp,
        (1..=8).map(Region::Map).collect::<Vec<_>>(),
        "the eight lowest IDs"
    );
    assert_eq!(
        n.nodes[0].c.home, 2,
        "regions 1 and 2 aren't probed: region 3 answered first"
    );
}

#[test]
fn a_region_missing_from_the_map_doesnt_fail_the_client() {
    let map = br#"{"Regions":{"1":{"Nodes":[{"HostName":"a.test"}]}}}"#;
    for home in [None, Some(0)] {
        let mut cfg = config(1);
        cfg.link.derp = vec![Region::Map(999), Region::Map(1)];
        cfg.home = home;
        let mut n = Net::build(vec![cfg], Faults::default());
        let now = n.now;
        n.nodes[0].c.fetched(1, true, map, now);
        n.run();
        assert_eq!(n.nodes[0].c.state, State::Running, "home {home:?}");
        assert_eq!(n.nodes[0].c.home, 1);
        assert_eq!(n.regions(0), ["wss://a.test/derp"]);
    }
}

#[test]
fn a_configured_home_that_isnt_usable_is_chosen_past_by_probes() {
    // One not on the map, and one past the link's regions: the probes choose, as unconfigured.
    for home in [2, 7] {
        let mut cfg = config(1);
        cfg.link = link(&["a.test", "b.test"]);
        cfg.link.derp.push(Region::Map(900));
        cfg.home = Some(home);
        let faults = Faults {
            hold_first: vec![(0, "wss://a.test/derp".into())],
            ..Faults::default()
        };
        let mut n = Net::build(vec![cfg], faults);
        let now = n.now;
        n.nodes[0].c.fetched(
            1,
            true,
            br#"{"Regions":{"1":{"Nodes":[{"HostName":"x.test"}]}}}"#,
            now,
        );
        n.run();
        assert_eq!(n.nodes[0].c.state, State::Running, "home {home}");
        assert_eq!(n.nodes[0].c.home, 1, "b answered first");
    }
    // And the probed home hands over when it keeps failing, as an unconfigured one does.
    let mut cfg = config(1);
    cfg.link = link(&["a.test", "b.test"]);
    cfg.home = Some(7);
    let faults = Faults {
        hold_first: vec![(0, "wss://b.test/derp".into())],
        mute_after_first: vec![(0, "wss://a.test/derp".into())],
        ..Faults::default()
    };
    let mut n = Net::build(vec![cfg], faults);
    assert_eq!(n.nodes[0].c.home, 0);
    n.advance(Duration::from_secs(300));
    assert_eq!(n.nodes[0].c.state, State::Running);
    assert_eq!(n.nodes[0].c.home, 1);
}

#[test]
fn the_fallback_is_a_probe_still_out_not_one_that_failed() {
    let mut cfg = config(1);
    cfg.link = link(&["a.test", "b.test"]);
    let faults = Faults {
        hold_first: vec![
            (0, "wss://a.test/derp".into()),
            (0, "wss://b.test/derp".into()),
        ],
        ..Faults::default()
    };
    let mut n = Net::build(vec![cfg], faults);
    let (_, a, _) = n.held.remove(0);
    let now = n.now;
    n.nodes[0].conns.remove(&a);
    n.nodes[0].c.ws_closed(a, now); // a is down; b is slow
    n.advance(PROBE_WAIT);
    assert_eq!(n.nodes[0].c.home, 1, "b, still out, over a, which closed");
    assert!(n.nodes[0].c.probes.is_empty());
}

#[test]
fn the_hand_over_takes_the_best_region_left() {
    // Regions 1 (Avoid), 2 and 3; 3 answers first but its DERP never works; 2's probe was still
    // out: 2 takes over, not 1.
    let map = br#"{"Regions":{"1":{"Avoid":true,"Nodes":[{"HostName":"r1.test"}]},"2":{"Nodes":[{"HostName":"r2.test"}]},"3":{"Nodes":[{"HostName":"r3.test"}]}}}"#;
    let mut cfg = config(1);
    cfg.link.derp = vec![Region::Map(0)];
    cfg.link.default_derp = true;
    let faults = Faults {
        hold_first: vec![(0, "wss://r2.test/derp".into())],
        mute_after_first: vec![(0, "wss://r3.test/derp".into())],
        ..Faults::default()
    };
    let mut n = Net::build(vec![cfg], faults);
    let now = n.now;
    n.nodes[0].c.fetched(1, true, map, now);
    n.run();
    assert_eq!(n.nodes[0].c.home, 2);
    n.advance(Duration::from_secs(300));
    assert_eq!(n.nodes[0].c.state, State::Running);
    assert_eq!(n.nodes[0].c.home, 1, "region 2");
}

#[test]
fn a_region_not_for_home_is_handed_over_to_last() {
    // Regions 1 (Avoid), 2 and 3; 2's probe fails, 3 answers but its DERP never works: 2, whose
    // probe failed, still comes before 1, which may not be home.
    let map = br#"{"Regions":{"1":{"Avoid":true,"Nodes":[{"HostName":"r1.test"}]},"2":{"Nodes":[{"HostName":"r2.test"}]},"3":{"Nodes":[{"HostName":"r3.test"}]}}}"#;
    let mut cfg = config(1);
    cfg.link.derp = vec![Region::Map(0)];
    cfg.link.default_derp = true;
    let faults = Faults {
        hold_first: vec![
            (0, "wss://r2.test/derp".into()),
            (0, "wss://r3.test/derp".into()),
        ],
        mute_after_first: vec![(0, "wss://r3.test/derp".into())],
        ..Faults::default()
    };
    let mut n = Net::build(vec![cfg], faults);
    let now = n.now;
    n.nodes[0].c.fetched(1, true, map, now);
    n.run();
    let (_, r2, _) = n.held.remove(0);
    n.nodes[0].conns.remove(&r2);
    n.nodes[0].c.ws_closed(r2, now); // 2's probe closes
    n.release(); // 3 answers
    assert_eq!(n.nodes[0].c.home, 2);
    n.advance(Duration::from_secs(300));
    assert_eq!(n.nodes[0].c.state, State::Running);
    assert_eq!(n.nodes[0].c.home, 1, "region 2, not region 1");
}

#[test]
fn with_every_region_failing_the_client_fails() {
    let mut cfg = config(1);
    cfg.link = link(&["a.test", "b.test", "c.test"]);
    let faults = Faults {
        mute_after_first: vec![
            (0, "wss://a.test/derp".into()),
            (0, "wss://b.test/derp".into()),
            (0, "wss://c.test/derp".into()),
        ],
        ..Faults::default()
    };
    let mut n = Net::build(vec![cfg], faults);
    n.advance(Duration::from_secs(1200));
    assert_eq!(n.nodes[0].c.state, State::Failed);
    let mut tried = n.nodes[0].c.tried.clone();
    tried.sort();
    assert_eq!(tried, [0, 1, 2], "each was home once");
}

#[test]
fn a_map_region_named_twice_resolves_to_ours() {
    let map = br#"{"Regions":{"5":{"Nodes":[{"HostName":"e.test"}]}}}"#;
    let mut cfg = config(1);
    cfg.link.derp = vec![Region::Map(5), Region::Map(5)];
    cfg.home = Some(1);
    let mut n = Net::build(vec![cfg], Faults::default());
    let now = n.now;
    n.nodes[0].c.fetched(1, true, map, now);
    n.run();
    assert_eq!(n.nodes[0].c.home, 1);
    assert_eq!(
        n.nodes[0].c.local_region(5),
        Some(1),
        "the home entry, not the first"
    );
    assert_eq!(n.regions(0), ["wss://e.test/derp"], "one connection");
}

#[test]
fn the_maps_regions_a_room_can_name_and_reach() {
    let map = br#"{"Regions":{"4":{"Nodes":[{"HostName":"d.test","CertName":"other.test"}]},"40000":{"Nodes":[{"HostName":"big.test"}]},"6":{"Nodes":[{"HostName":"f.test"}]}}}"#;
    assert_eq!(tailcat::region_ids(map).unwrap(), [(6, true)]);
}

#[test]
fn closing_while_probing_leaves_nothing_open_or_scheduled() {
    let mut cfg = config(1);
    cfg.link = link(&["a.test", "b.test"]);
    let faults = Faults {
        hold_first: vec![
            (0, "wss://a.test/derp".into()),
            (0, "wss://b.test/derp".into()),
        ],
        ..Faults::default()
    };
    let mut n = Net::build(vec![cfg], faults);
    n.nodes[0].c.close();
    n.run();
    assert!(n.nodes[0].c.probes.is_empty());
    assert_eq!(n.nodes[0].c.probe_until, None);
    assert_eq!(n.regions(0), Vec::<String>::new(), "the probes closed");
    n.release(); // late answers: nothing opens
    assert_eq!(n.regions(0), Vec::<String>::new());
}
