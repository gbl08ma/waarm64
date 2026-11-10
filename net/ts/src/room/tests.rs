//! The room client against fake relays (derp.rs's test server, one per node, packets routed
//! between them by key) and a fake WebRTC: an offer is answered, an answer opens both ends'
//! channels, and a channel's messages reach the other end, unless a test blocks or drops them.

use std::collections::BTreeMap;

use serde_json::Value;

use super::*;
use crate::derp::testserver::Server as Relay;

struct Node {
    c: Client,
    relay: Relay,
    conn: u32,
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
    /// Every second relay packet is lost.
    lossy_relay: bool,
}

struct Net {
    nodes: Vec<Node>,
    ends: BTreeMap<(usize, u32), End>,
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

fn config(seed: u8, peers: &[u8]) -> Config {
    Config {
        room: "test room".into(),
        key: Some(key(seed)),
        nodes: vec![tailcat::parse_relay("derp.test").unwrap()],
        region_id: 900,
        derp_map_url: String::new(),
        peers: peers.iter().map(|s| public(*s)).collect(),
        relay_only: false,
        incoming: true,
    }
}

impl Net {
    fn new(cfgs: Vec<Config>) -> Net {
        let now = Instant::now();
        let nodes = cfgs
            .into_iter()
            .enumerate()
            .map(|(i, cfg)| Node {
                c: Client::new(cfg, now).unwrap(),
                relay: Relay::new([100 + i as u8; 32]),
                conn: 0,
                guest: Vec::new(),
                events: Vec::new(),
                derp_packets: 0,
                rtc_packets: 0,
            })
            .collect();
        let mut n = Net {
            nodes,
            ends: BTreeMap::new(),
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

    fn signal(&mut self, i: usize, rtc: u32, v: Value) {
        let now = self.now;
        self.nodes[i]
            .c
            .rtc_signal(rtc, v.to_string().as_bytes(), now);
    }

    fn handle(&mut self, i: usize, a: Action) {
        let now = self.now;
        match a {
            Action::WsOpen {
                conn,
                url,
                protocol,
            } => {
                assert_eq!((url.as_str(), protocol), ("wss://derp.test/derp", "derp"));
                let n = &mut self.nodes[i];
                n.conn = conn;
                let hello = n.relay.hello();
                n.c.ws_message(conn, &hello, now);
            }
            Action::WsSend { conn, data } => {
                let mut sent = Vec::new();
                let replies = self.nodes[i].relay.input(&data, &mut sent);
                for r in replies {
                    self.nodes[i].c.ws_message(conn, &r, now);
                }
                let src = self.nodes[i].c.public;
                for (dst, p) in sent {
                    self.relayed += 1;
                    // A third lost, at random (a fixed sequence).
                    if self.faults.lossy_relay
                        && (self.relayed as u64).wrapping_mul(0x9e37_79b9_7f4a_7c15) >> 61 < 3
                    {
                        continue;
                    }
                    let Some(j) = self.nodes.iter().position(|n| n.c.public == dst) else {
                        continue;
                    };
                    self.nodes[i].derp_packets += 1;
                    let n = &mut self.nodes[j];
                    let frame = n.relay.deliver(&src, &p);
                    n.c.ws_message(n.conn, &frame, now);
                }
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
            Action::Fetch { .. } | Action::WsClose { .. } => {}
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

    /// A UDP packet from node `i`'s guest to node `j`'s address, port `port`.
    fn send(&mut self, i: usize, j: usize, port: u16, payload: &[u8]) {
        let p = udp(self.nodes[i].c.addr, self.nodes[j].c.addr, port, payload);
        let now = self.now;
        self.nodes[i].c.guest_packet(&p, now);
        self.run();
    }

    /// The payloads node `i`'s guest got, taken.
    fn got(&mut self, i: usize) -> Vec<Vec<u8>> {
        std::mem::take(&mut self.nodes[i].guest)
            .into_iter()
            .map(|p| p[48..].to_vec())
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
    assert_ne!(&r.psk[..5], &r.prefix[1..], "distinct labels");
    let k = public(1);
    let a = r.addr(&k);
    assert_eq!(&a[..6], &r.prefix);
    assert_eq!(&a[6..], &k[..10]);
    assert!(r.contains(&a));
    assert_eq!(base32(b"\x00\x44\x32\x14\xc7"), "abcdefgh");
    assert_eq!(base32(b"f"), "my", "RFC 4648's vector, lower case");
    assert_eq!(base32(b"fooba"), "mzxw6ytb");
}

#[test]
fn peers_talk_through_the_relay_then_over_their_channel() {
    let mut n = Net::new(vec![config(1, &[2]), config(2, &[1])]);
    n.send(0, 1, 9, b"first");
    assert_eq!(n.got(1), [b"first".to_vec()], "through the relay at once");
    assert!(n.nodes[0].derp_packets > 0);
    // The handshake is done: the lower key offers, the channel opens on both sides.
    n.advance(Duration::from_millis(10));
    let offerer = if public(1) < public(2) { 0 } else { 1 };
    assert_eq!(n.paths(0), ["direct"], "{:?}", n.nodes[0].events);
    assert_eq!(n.paths(1), ["direct"]);
    assert!(n.ends.keys().any(|(i, _)| *i == offerer));
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
}

#[test]
fn a_member_comes_in_by_its_handshake_unless_incoming_is_off() {
    // Node 1 knows nobody; node 0 knows its key.
    let mut n = Net::new(vec![config(1, &[2]), config(2, &[])]);
    n.send(0, 1, 9, b"knock");
    assert_eq!(n.got(1), [b"knock".to_vec()]);
    assert!(n.nodes[1].events.iter().any(|e| e["type"] == "peer"));
    n.advance(Duration::from_millis(10));
    n.send(1, 0, 9, b"back");
    assert_eq!(n.got(0), [b"back".to_vec()], "it answers the newcomer");

    let mut cfg = config(2, &[]);
    cfg.incoming = false;
    let mut n = Net::new(vec![config(1, &[2]), cfg]);
    n.send(0, 1, 9, b"knock");
    n.advance(Duration::from_secs(1));
    assert!(n.got(1).is_empty());
    assert!(n.nodes[1].c.peers.is_empty(), "no peer made");
}

#[test]
fn a_handshake_without_the_rooms_key_lets_nobody_in() {
    let mut other = config(1, &[]);
    other.room = "another room".into();
    let mut n = Net::new(vec![other, config(2, &[])]);
    // Node 0's address is another room's: the packet goes to node 1's key by hand.
    let to = n.nodes[1].c.room.addr(&public(2));
    let from = n.nodes[0].c.addr;
    let mut p = udp(from, to, 9, b"in?");
    pad(&mut p);
    let peer = n.nodes[0]
        .c
        .wg
        .peer_id(NodePublicKey::from_bytes(public(2)));
    assert!(
        peer.is_none(),
        "node 0 only knows its own room's address for it"
    );
    let id = n.nodes[0].c.add_peer(public(2), false, n.now);
    let now = n.now;
    let r = n.nodes[0].c.wg.send(now, [(id, vec![PacketMut::from(p)])]);
    n.nodes[0].c.send_to_peers(r.to_peers, now);
    n.advance(Duration::from_secs(19));
    assert_eq!(n.nodes[1].c.peers.len(), 1, "on trial");
    n.advance(Duration::from_secs(2));
    assert!(n.nodes[1].c.peers.is_empty(), "forgotten after 20 s");
    // Its retries come in on trial again, and never further.
    n.advance(Duration::from_secs(120));
    assert!(n.got(1).is_empty());
    assert!(!n.nodes[1].events.iter().any(|e| e["type"] == "peer"));
}

#[test]
fn a_peer_reaches_the_guest_only_from_its_own_address() {
    let mut n = Net::new(vec![config(1, &[2]), config(2, &[1])]);
    n.send(0, 1, 9, b"ok");
    assert_eq!(n.got(1).len(), 1);
    // Node 0 sends, inside its session, a packet with another source address.
    let mut forged = n.nodes[0].c.room.addr(&public(3));
    let id = n.nodes[0].c.by_addr[&n.nodes[1].c.addr];
    for src in [forged, [0xfd; 16]] {
        let mut p = udp(src, n.nodes[1].c.addr, 9, b"forged");
        pad(&mut p);
        let now = n.now;
        let r = n.nodes[0].c.wg.send(now, [(id, vec![PacketMut::from(p)])]);
        n.nodes[0].c.send_to_peers(r.to_peers, now);
        n.run();
    }
    assert!(n.got(1).is_empty());
    forged[15] ^= 1;
    let _ = forged;
}

#[test]
fn the_guest_cant_use_the_signalling_port() {
    let mut n = Net::new(vec![config(1, &[2]), config(2, &[1])]);
    n.send(0, 1, 9, b"ok");
    n.got(1);
    let before = n.nodes[0].derp_packets + n.nodes[0].rtc_packets;
    n.send(0, 1, SIGNAL_PORT, br#"{"n":1,"s":99,"t":"refuse"}"#);
    let p = ip::udp(
        (IpAddr::V6(n.nodes[0].c.addr.into()), SIGNAL_PORT),
        (IpAddr::V6(n.nodes[1].c.addr.into()), 9),
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
        let mut cfgs = vec![config(1, &[2]), config(2, &[1])];
        cfgs[side].relay_only = true;
        let mut n = Net::new(cfgs);
        n.send(0, 1, 9, b"a");
        n.advance(Duration::from_secs(120));
        n.send(1, 0, 9, b"b");
        assert_eq!(n.got(1), [b"a".to_vec()]);
        assert_eq!(n.got(0), [b"b".to_vec()]);
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
    let mut n = Net::new(vec![config(1, &[2]), config(2, &[1])]);
    n.faults.block_rtc = true;
    n.send(0, 1, 9, b"a");
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
    n.advance(Duration::from_secs(10));
    assert_eq!(n.paths(0), ["direct"]);
}

#[test]
fn a_closed_channel_falls_back_to_the_relay_then_opens_again() {
    let mut n = Net::new(vec![config(1, &[2]), config(2, &[1])]);
    n.send(0, 1, 9, b"a");
    n.advance(Duration::from_millis(10));
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
    let mut n = Net::new(vec![config(1, &[2]), config(2, &[1])]);
    n.send(0, 1, 9, b"a");
    n.advance(Duration::from_millis(10));
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
    let mut n = Net::new(vec![config(1, &[2]), config(2, &[1])]);
    n.faults.lossy_relay = true;
    n.send(0, 1, 9, b"a");
    n.advance(Duration::from_secs(20));
    assert_eq!(n.paths(0), ["direct"], "{:?}", n.nodes[0].events);
    assert_eq!(n.paths(1), ["direct"]);
}

#[test]
fn a_restarted_peer_gets_a_new_channel() {
    let mut n = Net::new(vec![config(1, &[2]), config(2, &[1])]);
    n.send(0, 1, 9, b"a");
    n.advance(Duration::from_millis(10));
    assert_eq!(n.paths(0), ["direct"]);
    // Node 1's page reloads: same key, a new instance; its old channel is gone.
    n.ends.retain(|(i, _), _| *i != 1);
    let now = n.now;
    n.nodes[1].c = Client::new(config(2, &[1]), now).unwrap();
    n.run();
    n.send(1, 0, 9, b"back");
    assert_eq!(n.got(0), [b"back".to_vec()]);
    n.advance(Duration::from_secs(1));
    assert_eq!(
        n.paths(0),
        ["direct", "relay", "direct"],
        "{:?}",
        n.nodes[0].events
    );
    n.send(0, 1, 9, b"b");
    assert!(n.got(1).contains(&b"b".to_vec()));
}

#[test]
fn a_peer_that_was_relay_only_and_restarted_without_gets_a_channel() {
    let mut cfgs = vec![config(1, &[2]), config(2, &[1])];
    cfgs[1].relay_only = true;
    let mut n = Net::new(cfgs);
    n.send(0, 1, 9, b"a");
    n.advance(Duration::from_secs(1));
    assert_eq!(n.rtc_state(0), [Rtc::Off]);
    let now = n.now;
    n.nodes[1].c = Client::new(config(2, &[1]), now).unwrap();
    n.run();
    n.send(1, 0, 9, b"back");
    n.advance(Duration::from_secs(1));
    assert_eq!(n.paths(0), ["direct"], "{:?}", n.nodes[0].events);
}
