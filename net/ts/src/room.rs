//! A room's client (docs/plans/networking-p2p.md, docs/tailnet.md "Rooms"), sans I/O: VMs in
//! different browsers on one network, each a WireGuard node whose packets go browser to browser
//! over a WebRTC data channel when one is open and through DERP otherwise.
//!
//! - **The room** is an ID its members agree on; from it, by BLAKE2s, its /48 and the pre-shared
//!   key every pair in it uses ([`Room`]). A node's address is the /48 plus the first 80 bits of
//!   its node key, and a peer's packets reach the guest only from that peer's own address.
//! - **WireGuard** (`ts_tunnel`, IKpsk2 with the room's key) is the same whichever path carries a
//!   packet, so the fallback and the address binding come from the code tailcat uses.
//! - **Signalling** goes inside the tunnel: UDP between the two nodes' addresses on
//!   [`SIGNAL_PORT`], which the guest can't use, acknowledged and resent. So a node shows its ICE
//!   candidates only to a member that completed a handshake with the room's key. The side with the
//!   lower key offers; the page holds the `RTCPeerConnection` (`Action::RtcOpen`, `RtcSignal`,
//!   `RtcClose`) and the worker the data channel (`RtcSend`, `rtc_message`).
//! - **Peers** are given by key (R0: keys exchanged by hand), or come in with a handshake and stay
//!   on trial until their first data decrypts (incoming connections, on by default).

use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    net::{IpAddr, Ipv6Addr},
    time::{Duration, Instant},
};

use blake2::{Blake2s256, Digest};
use serde::{Deserialize, Serialize};
use serde_json::json;
use ts_keys::{Export, ExportableKey, NodeKeyPair, NodePrivateKey, NodePublicKey};
use ts_packet::PacketMut;
use ts_tunnel::{Endpoint, PeerConfig, PeerId};

use crate::{
    client::{Action, GUEST4, pad, queue_frames, unpad},
    derp, ip, tailcat,
};

const TUNNEL_MTU: usize = 1280;
/// The UDP port signalling uses between two nodes' addresses, both ends. The module keeps it:
/// the guest's packets to or from it are dropped.
pub const SIGNAL_PORT: u16 = 1;
/// A WireGuard handshake initiation's type and size.
const INITIATION: (u8, usize) = (1, 148);
/// A peer let in by a handshake alone is forgotten this long without data that decrypts.
const TRIAL: Duration = Duration::from_secs(20);
/// Signalling resends: after these waits, then the message is dropped.
const RESENDS: [Duration; 3] = [
    Duration::from_millis(500),
    Duration::from_secs(1),
    Duration::from_secs(2),
];
/// An offer not answered with an open channel in this long is dropped.
const RTC_CONNECT: Duration = Duration::from_secs(10);
/// The wait before the next offer after one failed, doubling up to [`RTC_BACKOFF_MAX`].
const RTC_BACKOFF: Duration = Duration::from_secs(30);
const RTC_BACKOFF_MAX: Duration = Duration::from_secs(300);
/// A channel we sent on with nothing back for this long has stalled (WireGuard's passive
/// keepalive answers data within 10 s): back to DERP.
const RTC_STALL: Duration = Duration::from_secs(15);
/// How many signalling sequence numbers a peer's are remembered (to drop resent copies).
const SEEN: usize = 256;
/// A relay connection up this long worked: its loss reconnects at once.
const STABLE: Duration = Duration::from_secs(10);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// tailcat's ULA /48, which no room's may be (the guest may be on tailcat beside it).
const TAILCAT_PREFIX: [u8; 6] = [0xfd, 0x7a, 0x11, 0x5c, 0xa1, 0xe0];

/// What a room's ID derives (plan §2): every member derives the same, nobody hands anything out.
#[derive(Debug, Clone, PartialEq)]
pub struct Room {
    /// The room's /48: `fd` and 40 bits of a hash (RFC 4193's form).
    pub prefix: [u8; 6],
    /// Those 40 bits in base32, for names.
    pub tag: String,
    /// The WireGuard pre-shared key of every pair in the room.
    pub psk: [u8; 32],
}

fn hash(label: &str, id: &str) -> [u8; 32] {
    let mut h = Blake2s256::new();
    h.update(label.as_bytes());
    h.update([0]);
    h.update(id.as_bytes());
    h.finalize().into()
}

/// RFC 4648's base32 alphabet, lower case, no padding.
pub fn base32(b: &[u8]) -> String {
    const A: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";
    let (mut out, mut acc, mut bits) = (String::new(), 0u32, 0);
    for &x in b {
        acc = acc << 8 | x as u32;
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(A[(acc >> bits & 31) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(A[(acc << (5 - bits) & 31) as usize] as char);
    }
    out
}

impl Room {
    pub fn derive(id: &str) -> Room {
        let mut prefix = [0u8; 6];
        for n in 0.. {
            let label = match n {
                0 => "webpc room prefix v1".to_string(),
                n => format!("webpc room prefix v1 {n}"),
            };
            prefix[0] = 0xfd;
            prefix[1..].copy_from_slice(&hash(&label, id)[..5]);
            if prefix != TAILCAT_PREFIX {
                break;
            }
        }
        Room {
            prefix,
            tag: base32(&prefix[1..]),
            psk: hash("webpc room psk v1", id),
        }
    }

    /// A node's address in the room: the /48 and the first 80 bits of its key.
    pub fn addr(&self, key: &[u8; 32]) -> [u8; 16] {
        let mut a = [0u8; 16];
        a[..6].copy_from_slice(&self.prefix);
        a[6..].copy_from_slice(&key[..10]);
        a
    }

    pub fn contains(&self, a: &[u8]) -> bool {
        a.len() >= 6 && a[..6] == self.prefix
    }
}

pub struct Config {
    /// The room's ID.
    pub room: String,
    /// The node's private key; a fresh one when None.
    pub key: Option<[u8; 32]>,
    /// The home relay: one's own derper's nodes, or a region of the DERP map by ID (0: its first).
    pub nodes: Vec<tailcat::DerpNode>,
    pub region_id: i64,
    pub derp_map_url: String,
    /// The peers' node keys, given by hand (R0).
    pub peers: Vec<[u8; 32]>,
    /// No WebRTC: everything through DERP, so no peer learns the node's IP address.
    pub relay_only: bool,
    /// Members may open connections to the guest (a handshake from a key we don't know).
    pub incoming: bool,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum State {
    FetchingMap,
    Connecting,
    Running,
    Failed,
}

/// The direct path to a peer.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Rtc {
    /// None. The offerer offers again at `next` (the answerer waits for an offer: None).
    Idle { next: Option<Instant> },
    /// The page sets up attempt `attempt` as connection `id`.
    Connecting {
        id: u32,
        attempt: u32,
        since: Instant,
    },
    /// Its data channel carries the peer's packets; `unanswered`: when we first sent on it since
    /// it last brought something.
    Open {
        id: u32,
        attempt: u32,
        unanswered: Option<Instant>,
    },
    /// Never: one side is relay only.
    Off,
}

/// A signalling message waiting for its acknowledgement.
struct Out {
    seq: u32,
    body: Vec<u8>,
    /// When to resend, and how many resends are left.
    at: Instant,
    tries: usize,
}

struct Peer {
    key: [u8; 32],
    addr: [u8; 16],
    heard: Instant,
    /// When it was let in.
    added: Instant,
    /// Let in by a handshake alone: on trial until its first data decrypts, forgotten [`TRIAL`]
    /// after it was let in without.
    trial: bool,
    /// Its data decrypted: the session (with the room's key) is confirmed both ways.
    confirmed: bool,
    hello_sent: bool,
    /// Its home region, from its hello.
    region: Option<i64>,
    /// Its signalling's instance (a restart changes it) and the sequence numbers seen of it.
    nonce: Option<u32>,
    seen: BTreeSet<u32>,
    next_seq: u32,
    outbox: VecDeque<Out>,
    rtc: Rtc,
    /// The offerer's attempts so far (the answerer: the last one it took).
    attempt: u32,
    backoff: Duration,
}

/// What signalling carries, as JSON inside the tunnel.
#[derive(Serialize, Deserialize, Debug, Default)]
struct Msg {
    /// The sender's instance.
    n: u32,
    /// The message's sequence number (0: an acknowledgement, `a`).
    #[serde(default, skip_serializing_if = "is_zero")]
    s: u32,
    #[serde(default, skip_serializing_if = "is_zero")]
    a: u32,
    /// `hello`, `sig` (the page's description or candidate, `d`, of attempt `o`), `bye` (attempt
    /// `o` closed), `refuse` (relay only).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    t: String,
    #[serde(default, skip_serializing_if = "is_zero")]
    o: u32,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    d: String,
    /// hello: the home region, and whether the sender is relay only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    g: Option<i64>,
    #[serde(default, skip_serializing_if = "is_false")]
    r: bool,
}

fn is_zero(x: &u32) -> bool {
    *x == 0
}
fn is_false(x: &bool) -> bool {
    !*x
}

pub struct Client {
    cfg: Config,
    room: Room,
    private: [u8; 32],
    public: [u8; 32],
    addr: [u8; 16],
    /// This instance's signalling nonce.
    nonce: u32,
    wg: Endpoint,
    peers: BTreeMap<PeerId, Peer>,
    by_addr: BTreeMap<[u8; 16], PeerId>,
    next_peer: u32,
    next_rtc: u32,
    region_id: i64,
    nodes: Vec<String>,
    node: usize,
    derp: Option<(u32, derp::Conn)>,
    derp_ready: Option<Instant>,
    next_conn: u32,
    state: State,
    phase_deadline: Option<Instant>,
    reconnect_at: Option<Instant>,
    failures: u32,
    actions: VecDeque<Action>,
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|b| format!("{b:02x}")).collect()
}

impl Client {
    pub fn new(cfg: Config, now: Instant) -> Result<Self, String> {
        if cfg.room.trim().is_empty() {
            return Err("a room needs an ID".into());
        }
        let room = Room::derive(&cfg.room);
        let private = match cfg.key {
            Some(k) => k,
            None => {
                let mut k = [0u8; 32];
                getrandom::fill(&mut k).map_err(|e| format!("no randomness: {e}"))?;
                k
            }
        };
        let mut n = [0u8; 4];
        getrandom::fill(&mut n).map_err(|e| format!("no randomness: {e}"))?;
        let pair = NodeKeyPair::from(Export::<NodePrivateKey>::from_bytes(private).import());
        let public = *pair.public.export().as_bytes();
        let nodes = cfg
            .nodes
            .iter()
            .filter_map(tailcat::DerpNode::browser_url)
            .collect();
        let mut c = Client {
            addr: room.addr(&public),
            room,
            private,
            public,
            nonce: u32::from_le_bytes(n).max(1),
            wg: Endpoint::new(pair),
            peers: BTreeMap::new(),
            by_addr: BTreeMap::new(),
            next_peer: 1,
            next_rtc: 1,
            region_id: cfg.region_id,
            nodes,
            node: 0,
            derp: None,
            derp_ready: None,
            next_conn: 1,
            state: State::Connecting,
            phase_deadline: None,
            reconnect_at: None,
            failures: 0,
            actions: VecDeque::new(),
            cfg,
        };
        c.event(json!({
            "type": "self", "key": format!("nodekey:{}", hex(&public)), "address6": c.addr,
            "tag": c.room.tag,
        }));
        for k in c.cfg.peers.clone() {
            if k != public {
                c.add_peer(k, false, now);
            }
        }
        if c.cfg.nodes.is_empty() {
            c.state = State::FetchingMap;
            c.state_event();
            c.actions.push_back(Action::Fetch {
                id: 1,
                url: c.cfg.derp_map_url.clone(),
            });
        } else if c.nodes.is_empty() {
            c.fail("no-browser-relay", "");
        } else {
            c.connect(now);
        }
        Ok(c)
    }

    pub fn private_key(&self) -> [u8; 32] {
        self.private
    }

    fn event(&mut self, v: serde_json::Value) {
        self.actions.push_back(Action::Event(v.to_string()));
    }

    fn log(&mut self, msg: String) {
        self.event(json!({ "type": "log", "msg": msg }));
    }

    fn state_event(&mut self) {
        let name = format!("{:?}", self.state);
        self.event(json!({ "type": "state", "state": name }));
    }

    fn set_running(&mut self) {
        if self.state == State::Running {
            return;
        }
        self.state = State::Running;
        self.failures = 0;
        self.state_event();
        let mut prefix = [0u8; 16];
        prefix[..6].copy_from_slice(&self.room.prefix);
        // No resolver yet (R1's), no IPv4 routes: the room's /48 is all it reaches.
        let lease = json!({
            "address": GUEST4, "address6": self.addr, "mtu": TUNNEL_MTU,
            "dns": [], "dns6": [], "domains": [], "prefix6": [prefix, 48],
        });
        self.event(json!({ "type": "lease", "lease": lease }));
    }

    fn fail(&mut self, code: &'static str, detail: &str) {
        self.close_derp();
        self.phase_deadline = None;
        self.reconnect_at = None;
        self.state = State::Failed;
        self.event(json!({ "type": "state", "state": "Failed", "code": code, "detail": detail }));
    }

    fn close_derp(&mut self) {
        if let Some((conn, _)) = self.derp.take() {
            self.actions.push_back(Action::WsClose { conn });
        }
    }

    fn connect(&mut self, now: Instant) {
        self.close_derp();
        let conn = self.next_conn;
        self.next_conn += 1;
        let url = self.nodes[self.node % self.nodes.len()].clone();
        self.derp = Some((conn, derp::Conn::new(self.private, self.public, true, now)));
        self.derp_ready = None;
        self.actions.push_back(Action::WsOpen {
            conn,
            url,
            protocol: "derp",
        });
        if self.state != State::Running {
            self.phase_deadline = Some(now + CONNECT_TIMEOUT);
        }
    }

    /// Lost the relay: the next node, at once after one that was up, else after a growing backoff.
    fn retry(&mut self, now: Instant, why: String) {
        self.close_derp();
        let was_up = self.derp_ready.is_some();
        if self
            .derp_ready
            .take()
            .is_some_and(|t| now.saturating_duration_since(t) >= STABLE)
        {
            self.failures = 0;
        }
        self.failures += 1;
        self.node += 1;
        self.log(format!("DERP: {why}"));
        if self.state != State::Running && self.failures as usize > 2 * self.nodes.len().max(2) {
            return self.fail("relay", &why);
        }
        let backoff = match self.failures {
            1 if was_up => Duration::ZERO,
            f => Duration::from_millis(250u64 << f.min(7)).min(Duration::from_secs(30)),
        };
        self.reconnect_at = Some(now + backoff);
    }

    pub fn fetched(&mut self, id: u32, ok: bool, body: &[u8], now: Instant) {
        if id != 1 || self.state != State::FetchingMap {
            return;
        }
        if !ok {
            let url = self.cfg.derp_map_url.clone();
            return self.fail("derp-map", &url);
        }
        match tailcat::region_nodes(body, self.region_id) {
            Ok((id, nodes)) => {
                self.region_id = id;
                self.nodes = nodes
                    .iter()
                    .filter_map(tailcat::DerpNode::browser_url)
                    .collect();
                if self.nodes.is_empty() {
                    return self.fail("region-no-browser-relay", "");
                }
                self.state = State::Connecting;
                self.state_event();
                self.connect(now);
            }
            Err(e) => self.fail("derp-map-invalid", &e),
        }
    }

    pub fn ws_closed(&mut self, conn: u32, now: Instant) {
        if self.derp.as_ref().is_some_and(|(c, _)| *c == conn) {
            self.derp = None;
            self.retry(now, "the connection closed".into());
        }
    }

    pub fn ws_message(&mut self, conn: u32, data: &[u8], now: Instant) {
        let Some((c, d)) = self.derp.as_mut() else {
            return;
        };
        if *c != conn {
            return;
        }
        let events = d.input(data, now);
        self.flush_derp();
        match events {
            Err(e) => self.retry(now, e),
            Ok(events) => {
                for e in events {
                    self.derp_event(e, now);
                }
            }
        }
    }

    fn flush_derp(&mut self) {
        if let Some((conn, d)) = self.derp.as_mut() {
            queue_frames(&mut self.actions, *conn, d.take_output());
        }
    }

    fn derp_event(&mut self, e: derp::Event, now: Instant) {
        match e {
            derp::Event::Ready => {
                self.derp_ready = Some(now);
                self.phase_deadline = None;
                self.set_running();
            }
            derp::Event::Recv { src, packet } => self.on_relay_packet(src, packet, now),
            derp::Event::Restarting { reconnect_ms } => {
                self.close_derp();
                self.reconnect_at =
                    Some(now + Duration::from_millis(reconnect_ms.clamp(100, 30_000) as u64));
            }
            derp::Event::Health(h) if !h.is_empty() => self.log(format!("DERP health: {h}")),
            derp::Event::Health(_) | derp::Event::PeerGone(_) => {}
        }
    }

    /// A WireGuard peer for `key` (`trial`: let in by its handshake alone).
    fn add_peer(&mut self, key: [u8; 32], trial: bool, now: Instant) -> PeerId {
        let id = PeerId(self.next_peer);
        self.next_peer += 1;
        self.wg.upsert_peer(PeerConfig::new(
            id,
            NodePublicKey::from_bytes(key),
            self.room.psk,
        ));
        let addr = self.room.addr(&key);
        let offerer = self.public < key;
        self.peers.insert(
            id,
            Peer {
                key,
                addr,
                heard: now,
                added: now,
                trial,
                confirmed: false,
                hello_sent: false,
                region: None,
                nonce: None,
                seen: BTreeSet::new(),
                next_seq: 1,
                outbox: VecDeque::new(),
                rtc: match (self.cfg.relay_only, offerer) {
                    (true, _) => Rtc::Off,
                    (false, true) => Rtc::Idle { next: Some(now) },
                    (false, false) => Rtc::Idle { next: None },
                },
                attempt: 0,
                backoff: RTC_BACKOFF,
            },
        );
        self.by_addr.insert(addr, id);
        id
    }

    fn forget(&mut self, id: PeerId) {
        self.close_rtc(id, None);
        self.wg.remove_peer(id);
        if let Some(p) = self.peers.remove(&id) {
            self.by_addr.remove(&p.addr);
        }
    }

    fn peer_event(&mut self, id: PeerId, kind: &str) {
        let Some(p) = self.peers.get(&id) else { return };
        let v =
            json!({ "type": kind, "key": format!("nodekey:{}", hex(&p.key)), "address6": p.addr });
        self.event(v);
    }

    fn path_event(&mut self, id: PeerId, direct: bool) {
        let Some(p) = self.peers.get(&id) else { return };
        let v = json!({
            "type": "path", "key": format!("nodekey:{}", hex(&p.key)), "address6": p.addr,
            "path": if direct { "direct" } else { "relay" },
        });
        self.event(v);
    }

    fn on_relay_packet(&mut self, src: [u8; 32], packet: Vec<u8>, now: Instant) {
        let known = self.wg.peer_id(NodePublicKey::from_bytes(src));
        let Some(id) = known.or_else(|| {
            // A member we don't know opens a connection: its handshake lets it in on trial.
            (self.cfg.incoming
                && src != self.public
                && packet.first() == Some(&INITIATION.0)
                && packet.len() == INITIATION.1)
                .then(|| self.add_peer(src, true, now))
        }) else {
            return;
        };
        self.peer_packet(id, known.is_none(), packet, now);
    }

    /// A WireGuard packet from peer `id` (over the relay or its channel).
    fn peer_packet(&mut self, id: PeerId, new: bool, packet: Vec<u8>, now: Instant) {
        if let Some(p) = self.peers.get_mut(&id) {
            p.heard = now;
        }
        let r = self.wg.recv(now, [PacketMut::from(packet)]);
        if new && r.to_peers.is_empty() {
            // Not a handshake it could start: not let in.
            return self.forget(id);
        }
        self.send_to_peers(r.to_peers, now);
        for (from, packets) in r.to_local {
            self.confirm(from, now);
            for p in packets {
                self.on_tunnel_packet(from, p.as_ref(), now);
            }
        }
    }

    /// Peer `id`'s data decrypted: the session is confirmed; signalling may start.
    fn confirm(&mut self, id: PeerId, now: Instant) {
        let Some(p) = self.peers.get_mut(&id) else {
            return;
        };
        if p.confirmed {
            return;
        }
        p.confirmed = true;
        p.trial = false;
        self.peer_event(id, "peer");
        self.hello(id, now);
    }

    fn hello(&mut self, id: PeerId, now: Instant) {
        let (region, relay_only) = (self.region_id, self.cfg.relay_only);
        let Some(p) = self.peers.get_mut(&id) else {
            return;
        };
        if p.hello_sent {
            return;
        }
        p.hello_sent = true;
        self.signal(
            id,
            Msg {
                t: "hello".into(),
                g: Some(region),
                r: relay_only,
                ..Msg::default()
            },
            now,
        );
    }

    /// Sends signalling message `m` to peer `id`, to be acknowledged (an acknowledgement isn't).
    fn signal(&mut self, id: PeerId, mut m: Msg, now: Instant) {
        let nonce = self.nonce;
        let Some(p) = self.peers.get_mut(&id) else {
            return;
        };
        m.n = nonce;
        if m.a == 0 {
            m.s = p.next_seq;
            p.next_seq += 1;
        }
        let body = serde_json::to_vec(&m).unwrap();
        if m.a == 0 {
            p.outbox.push_back(Out {
                seq: m.s,
                body: body.clone(),
                at: now + RESENDS[0],
                tries: RESENDS.len(),
            });
        }
        self.send_signal(id, &body, now);
    }

    fn send_signal(&mut self, id: PeerId, body: &[u8], now: Instant) {
        let Some(p) = self.peers.get(&id) else { return };
        let me = IpAddr::V6(Ipv6Addr::from(self.addr));
        let to = IpAddr::V6(Ipv6Addr::from(p.addr));
        let mut pkt = ip::udp((me, SIGNAL_PORT), (to, SIGNAL_PORT), body);
        pad(&mut pkt);
        let r = self.wg.send(now, [(id, vec![PacketMut::from(pkt)])]);
        self.send_to_peers(r.to_peers, now);
    }

    fn on_tunnel_packet(&mut self, from: PeerId, plaintext: &[u8], now: Instant) {
        let Some(p) = unpad(plaintext) else { return };
        let Some(peer) = self.peers.get(&from) else {
            return;
        };
        // IPv6 from the peer's own address to ours only: the address is what its key implies.
        if p[0] >> 4 != 6 || p[8..24] != peer.addr || p[24..40] != self.addr {
            return;
        }
        let Some(info) = ip::parse(p) else { return };
        if info.proto == ip::UDP && (info.sport == SIGNAL_PORT || info.dport == SIGNAL_PORT) {
            if (info.sport, info.dport) == (SIGNAL_PORT, SIGNAL_PORT)
                && let Some(body) = ip::udp_payload(p, &info)
            {
                let body = body.to_vec();
                self.on_signal(from, &body, now);
            }
            return;
        }
        self.actions.push_back(Action::ToGuest(p.to_vec()));
    }

    fn on_signal(&mut self, id: PeerId, body: &[u8], now: Instant) {
        let Ok(m) = serde_json::from_slice::<Msg>(body) else {
            return;
        };
        let Some(p) = self.peers.get_mut(&id) else {
            return;
        };
        if p.nonce != Some(m.n) {
            // Its first message, or it restarted: what we knew of its signalling is gone.
            let restarted = p.nonce.is_some();
            p.nonce = Some(m.n);
            p.seen.clear();
            if restarted {
                p.outbox.clear();
                p.hello_sent = false;
                p.attempt = 0;
                self.close_rtc(id, None);
                // A new instance has no failed attempts behind it (and may no longer be relay only):
                // offer again at once.
                let (public, relay_only) = (self.public, self.cfg.relay_only);
                let p = self.peers.get_mut(&id).unwrap();
                p.backoff = RTC_BACKOFF;
                p.rtc = match relay_only {
                    true => Rtc::Off,
                    false => Rtc::Idle {
                        next: (public < p.key).then_some(now),
                    },
                };
                self.hello(id, now);
            }
        }
        let Some(p) = self.peers.get_mut(&id) else {
            return;
        };
        if m.a != 0 {
            p.outbox.retain(|o| o.seq != m.a);
            return;
        }
        if m.s == 0 {
            return;
        }
        let ack = Msg {
            a: m.s,
            ..Msg::default()
        };
        if !p.seen.insert(m.s) {
            return self.signal(id, ack, now); // a resent copy: its ack was lost
        }
        if p.seen.len() > SEEN {
            p.seen.pop_first();
        }
        self.signal(id, ack, now);
        match m.t.as_str() {
            "hello" => {
                let p = self.peers.get_mut(&id).unwrap();
                p.region = m.g;
                if m.r {
                    self.close_rtc(id, None);
                    self.peers.get_mut(&id).unwrap().rtc = Rtc::Off;
                }
            }
            "refuse" => {
                self.close_rtc(id, None);
                self.peers.get_mut(&id).unwrap().rtc = Rtc::Off;
            }
            "bye" => {
                if self.rtc_attempt(id) == Some(m.o) {
                    self.close_rtc(id, None);
                    self.idle(id, now, true);
                }
            }
            "sig" => self.on_sig(id, m.o, m.d, now),
            _ => {}
        }
    }

    /// The attempt the peer's current direct path belongs to.
    fn rtc_attempt(&self, id: PeerId) -> Option<u32> {
        match self.peers.get(&id)?.rtc {
            Rtc::Connecting { attempt, .. } | Rtc::Open { attempt, .. } => Some(attempt),
            _ => None,
        }
    }

    fn rtc_id(&self, id: PeerId) -> Option<u32> {
        match self.peers.get(&id)?.rtc {
            Rtc::Connecting { id, .. } | Rtc::Open { id, .. } => Some(id),
            _ => None,
        }
    }

    /// The page's description or candidate `d` of attempt `o` from the peer.
    fn on_sig(&mut self, id: PeerId, o: u32, d: String, now: Instant) {
        let p = &self.peers[&id];
        let offerer = self.public < p.key;
        if p.rtc == Rtc::Off {
            if self.cfg.relay_only {
                self.signal(
                    id,
                    Msg {
                        t: "refuse".into(),
                        ..Msg::default()
                    },
                    now,
                );
            }
            return;
        }
        if self.rtc_attempt(id) == Some(o) {
            let rtc = self.rtc_id(id).unwrap();
            self.actions.push_back(Action::RtcSignal { rtc, data: d });
            return;
        }
        if offerer || o <= p.attempt {
            return; // not ours to answer, or an older attempt's
        }
        // A new offer: the page answers it on a new connection.
        self.close_rtc(id, None);
        let rtc = self.next_rtc;
        self.next_rtc += 1;
        let p = self.peers.get_mut(&id).unwrap();
        p.attempt = o;
        p.rtc = Rtc::Connecting {
            id: rtc,
            attempt: o,
            since: now,
        };
        self.actions
            .push_back(Action::RtcOpen { rtc, offer: false });
        self.actions.push_back(Action::RtcSignal { rtc, data: d });
    }

    /// Closes the peer's direct path, if any (`bye`: tell the peer).
    fn close_rtc(&mut self, id: PeerId, bye: Option<Instant>) {
        let Some(p) = self.peers.get_mut(&id) else {
            return;
        };
        let (rtc, attempt, open) = match p.rtc {
            Rtc::Connecting { id, attempt, .. } => (id, attempt, false),
            Rtc::Open { id, attempt, .. } => (id, attempt, true),
            _ => return,
        };
        p.rtc = Rtc::Idle { next: None };
        self.actions.push_back(Action::RtcClose { rtc });
        if open {
            self.path_event(id, false);
        }
        if let Some(now) = bye {
            self.signal_at(id, "bye", attempt, now);
        }
    }

    fn signal_at(&mut self, id: PeerId, t: &str, o: u32, now: Instant) {
        self.signal(
            id,
            Msg {
                t: t.into(),
                o,
                ..Msg::default()
            },
            now,
        );
    }

    /// The peer's path is closed: the offerer offers again after the backoff (`grow`: it failed).
    fn idle(&mut self, id: PeerId, now: Instant, grow: bool) {
        let public = self.public;
        let Some(p) = self.peers.get_mut(&id) else {
            return;
        };
        if p.rtc == Rtc::Off || self.cfg.relay_only {
            p.rtc = Rtc::Off;
            return;
        }
        let next = (public < p.key).then(|| now + p.backoff);
        if grow {
            p.backoff = (p.backoff * 2).min(RTC_BACKOFF_MAX);
        }
        p.rtc = Rtc::Idle { next };
    }

    fn offer(&mut self, id: PeerId, now: Instant) {
        let rtc = self.next_rtc;
        self.next_rtc += 1;
        let p = self.peers.get_mut(&id).unwrap();
        p.attempt += 1;
        p.rtc = Rtc::Connecting {
            id: rtc,
            attempt: p.attempt,
            since: now,
        };
        self.actions.push_back(Action::RtcOpen { rtc, offer: true });
    }

    fn peer_of_rtc(&self, rtc: u32) -> Option<PeerId> {
        self.peers
            .iter()
            .find(|(id, _)| self.rtc_id(**id) == Some(rtc))
            .map(|(id, _)| *id)
    }

    /// The page's local description or candidate (JSON) of connection `rtc`, for the peer.
    pub fn rtc_signal(&mut self, rtc: u32, data: &[u8], now: Instant) {
        let Some(id) = self.peer_of_rtc(rtc) else {
            return;
        };
        let o = self.rtc_attempt(id).unwrap();
        self.signal(
            id,
            Msg {
                t: "sig".into(),
                o,
                d: String::from_utf8_lossy(data).into_owned(),
                ..Msg::default()
            },
            now,
        );
    }

    /// Connection `rtc`'s data channel opened: the peer's packets take it.
    pub fn rtc_open(&mut self, rtc: u32, _now: Instant) {
        let Some(id) = self.peer_of_rtc(rtc) else {
            return;
        };
        let p = self.peers.get_mut(&id).unwrap();
        if let Rtc::Connecting { id: r, attempt, .. } = p.rtc {
            p.rtc = Rtc::Open {
                id: r,
                attempt,
                unanswered: None,
            };
            p.backoff = RTC_BACKOFF;
            self.path_event(id, true);
        }
    }

    /// Connection `rtc` closed or failed (the page's or the channel's word): back to DERP.
    pub fn rtc_closed(&mut self, rtc: u32, now: Instant) {
        let Some(id) = self.peer_of_rtc(rtc) else {
            return;
        };
        let failed = matches!(self.peers[&id].rtc, Rtc::Connecting { .. });
        self.close_rtc(id, Some(now));
        self.idle(id, now, failed);
    }

    /// A message on connection `rtc`'s data channel: a WireGuard packet of its peer's.
    pub fn rtc_message(&mut self, rtc: u32, data: &[u8], now: Instant) {
        let Some(id) = self.peer_of_rtc(rtc) else {
            return;
        };
        if matches!(self.peers[&id].rtc, Rtc::Connecting { .. }) {
            self.rtc_open(rtc, now); // its first message can come before its open event
        }
        if let Rtc::Open { unanswered, .. } = &mut self.peers.get_mut(&id).unwrap().rtc {
            *unanswered = None;
        }
        self.peer_packet(id, false, data.to_vec(), now);
    }

    /// Sends WireGuard's packets: on a peer's data channel when it's open, else through the relay.
    fn send_to_peers(
        &mut self,
        to_peers: impl IntoIterator<Item = (PeerId, Vec<PacketMut>)>,
        now: Instant,
    ) {
        for (id, packets) in to_peers {
            let Some(mut p) = self.peers.get_mut(&id) else {
                continue;
            };
            // Handshake messages (initiation, response, cookie reply) always go through the relay:
            // they're rare, and a peer that restarted has no channel to take ours.
            let (packets, relayed): (Vec<_>, Vec<_>) = packets
                .into_iter()
                .partition(|pkt| !matches!(pkt.as_ref().first(), Some(1..=3)));
            if !relayed.is_empty() {
                let key = p.key;
                if let Some((_, d)) = self.derp.as_mut() {
                    for pkt in relayed {
                        d.send(&key, pkt.as_ref(), now);
                    }
                }
                p = self.peers.get_mut(&id).unwrap();
            }
            if let Rtc::Open {
                id: rtc,
                unanswered,
                ..
            } = &mut p.rtc
            {
                unanswered.get_or_insert(now);
                for pkt in packets {
                    self.actions.push_back(Action::RtcSend {
                        rtc: *rtc,
                        data: pkt.as_ref().to_vec(),
                    });
                }
                continue;
            }
            let key = p.key;
            let Some((_, d)) = self.derp.as_mut() else {
                continue;
            };
            for pkt in packets {
                d.send(&key, pkt.as_ref(), now);
            }
        }
        self.flush_derp();
    }

    /// An IP packet from the guest.
    pub fn guest_packet(&mut self, p: &[u8], now: Instant) {
        if self.state != State::Running
            || p.len() < 40
            || p.len() > TUNNEL_MTU
            || p[0] >> 4 != 6
            || p[8..24] != self.addr
        {
            return; // IPv6 from the guest's room address only: no IPv4 routes, nothing else
        }
        let Some(info) = ip::parse(p) else { return };
        if info.proto == ip::UDP && (info.sport == SIGNAL_PORT || info.dport == SIGNAL_PORT) {
            return; // the module's own
        }
        let dst: [u8; 16] = p[24..40].try_into().unwrap();
        // R0: peers known by key only (R1 looks addresses up).
        let Some(&id) = self.by_addr.get(&dst) else {
            return;
        };
        let mut out = p.to_vec();
        pad(&mut out);
        let r = self.wg.send(now, [(id, vec![PacketMut::from(out)])]);
        self.send_to_peers(r.to_peers, now);
        self.hello(id, now);
    }

    pub fn tick(&mut self, now: Instant) {
        let r = self.wg.dispatch_events(now);
        self.send_to_peers(r.to_peers, now);
        let ids: Vec<PeerId> = self.peers.keys().copied().collect();
        for id in ids {
            let Some(p) = self.peers.get_mut(&id) else {
                continue;
            };
            if p.trial && now.saturating_duration_since(p.added) >= TRIAL {
                self.forget(id);
                continue;
            }
            // Signalling's resends.
            let mut resend = Vec::new();
            p.outbox.retain_mut(|o| {
                if o.at > now {
                    return true;
                }
                if o.tries == 0 {
                    return false;
                }
                resend.push(o.body.clone());
                o.tries -= 1;
                o.at = now + RESENDS[RESENDS.len() - o.tries.max(1)];
                true
            });
            let (confirmed, rtc) = (p.confirmed, p.rtc);
            for b in resend {
                self.send_signal(id, &b, now);
            }
            match rtc {
                Rtc::Idle { next: Some(t) }
                    if confirmed && t <= now && self.state == State::Running =>
                {
                    self.offer(id, now)
                }
                Rtc::Connecting { since, .. }
                    if now.saturating_duration_since(since) >= RTC_CONNECT =>
                {
                    self.log(format!("WebRTC: no channel to peer {} in time", id.0));
                    self.close_rtc(id, Some(now));
                    self.idle(id, now, true);
                }
                Rtc::Open {
                    unanswered: Some(t),
                    ..
                } if now.saturating_duration_since(t) >= RTC_STALL => {
                    self.log(format!("WebRTC: the channel to peer {} stalled", id.0));
                    self.close_rtc(id, Some(now));
                    self.idle(id, now, false);
                }
                _ => {}
            }
        }
        if let Some((_, d)) = self.derp.as_mut() {
            match d.tick(now) {
                Ok(()) => self.flush_derp(),
                Err(e) => self.retry(now, e),
            }
        }
        if self.reconnect_at.is_some_and(|t| t <= now) {
            self.reconnect_at = None;
            self.connect(now);
        }
        if self.phase_deadline.is_some_and(|t| t <= now) {
            self.phase_deadline = None;
            if self.state == State::Connecting {
                self.retry(now, "no answer from the relay".into());
            }
        }
    }

    pub fn deadline(&self) -> Option<Instant> {
        let running = self.state == State::Running;
        let peers = self.peers.values().flat_map(|p| {
            [
                p.trial.then(|| p.added + TRIAL),
                p.outbox.iter().map(|o| o.at).min(),
                match p.rtc {
                    Rtc::Idle { next } if p.confirmed && running => next,
                    Rtc::Connecting { since, .. } => Some(since + RTC_CONNECT),
                    Rtc::Open { unanswered, .. } => unanswered.map(|t| t + RTC_STALL),
                    _ => None,
                },
            ]
        });
        [
            self.wg.next_event().map(|r| r.start()),
            self.derp.as_ref().and_then(|(_, d)| d.deadline()),
            self.reconnect_at,
            self.phase_deadline,
        ]
        .into_iter()
        .chain(peers)
        .flatten()
        .min()
    }

    pub fn poll(&mut self) -> Option<Action> {
        self.actions.pop_front()
    }

    pub fn close(&mut self) {
        let ids: Vec<PeerId> = self.peers.keys().copied().collect();
        for id in ids {
            self.close_rtc(id, None);
        }
        self.close_derp();
        self.phase_deadline = None;
        self.reconnect_at = None;
        self.state = State::Failed;
    }
}

#[cfg(test)]
mod tests;
