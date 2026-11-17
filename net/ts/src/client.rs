//! The tailcat client (docs/networking/tailnet.md "tailcat"), sans I/O: the host
//! feeds it WebSocket messages, `fetch` results, guest packets and the time,
//! and carries out the actions it queues. It connects to a tailcat server (an
//! exit node), lets tailcat clients in to the guest (the VM as a server, T3),
//! or both, through one DERP region; WireGuard by tailscale-rs's `ts_tunnel`.

use std::{
    collections::{BTreeMap, VecDeque},
    time::{Duration, Instant},
};

use blake2::{Blake2s256, Digest};
use crypto_box::SecretKey;
use serde_json::json;
use ts_keys::{Export, ExportableKey, NodeKeyPair, NodePrivateKey, NodePublicKey};
use ts_packet::PacketMut;
use ts_tunnel::{Endpoint, PeerConfig, PeerId};

use crate::{derp, nat46, tailcat};

/// What the host must do.
#[derive(Debug, PartialEq)]
pub enum Action {
    /// Open a WebSocket to `url` with subprotocol `protocol`; its messages go to `ws_message(conn, …)`.
    WsOpen {
        conn: u32,
        url: String,
        protocol: &'static str,
    },
    WsSend {
        conn: u32,
        data: Vec<u8>,
    },
    WsClose {
        conn: u32,
    },
    /// GET `url`; the body goes to `fetched(id, …)`.
    Fetch {
        id: u32,
        url: String,
    },
    /// An IP packet for the guest.
    ToGuest(Vec<u8>),
    /// A JSON event for the page: `{"type": "state" | "lease" | "self" | "serving" | "client" | "log", …}`.
    Event(String),
    /// A room's direct path (room.rs): set up WebRTC connection `rtc` with its negotiated data
    /// channel, making the offer when `offer`; its descriptions and candidates go to `rtc_signal`.
    RtcOpen {
        rtc: u32,
        offer: bool,
    },
    /// The peer's description or candidate (JSON, the page's own from the other side) for `rtc`.
    RtcSignal {
        rtc: u32,
        data: String,
    },
    /// A message on `rtc`'s data channel.
    RtcSend {
        rtc: u32,
        data: Vec<u8>,
    },
    RtcClose {
        rtc: u32,
    },
    /// A room's registry (room/names/store.rs): store name `id`'s record, or delete it (None).
    NamesStore {
        id: [u8; 32],
        record: Option<Vec<u8>>,
    },
    /// A room's server asks outside the room (room/names/outside.rs): GET `url`, a compiled calendar's or explorer's;
    /// the status and body go to `names_fetched(id, …)`.
    NamesFetch {
        id: u32,
        url: String,
    },
}

/// The most a relay message carries when frames are joined (see [`queue_frames`]): about three
/// 1,280-byte packets, the size of the relay's own writes to us (derper's WebSocket writer buffers
/// 4 KiB). A relay queues at most 32 packets per destination and drops the oldest past that
/// (derpserver's `perClientSendQueueDepth`), so big joined messages land bursts it drops: at 64 KiB
/// (a whole TSO packet's ~48 segments) an upload through tailcat fell from 86 to under 1 Mbit/s.
/// 16 KiB worked on a local relay, but a real one shares that queue with every other sender.
const MAX_RELAY_MESSAGE: usize = 4 << 10;

/// Queues DERP frames for the relay on `conn`. A relay reads its WebSocket as a byte stream, so frames
/// queued before the host takes the actions (a batch of the guest's packets, the segments of one large
/// packet) are joined into messages of up to [`MAX_RELAY_MESSAGE`]: a message each costs the browser and
/// the relay more than the bytes do.
pub(crate) fn queue_frames(actions: &mut VecDeque<Action>, conn: u32, frames: Vec<Vec<u8>>) {
    for f in frames {
        match actions.back_mut() {
            Some(Action::WsSend { conn: c, data })
                if *c == conn && data.len() + f.len() <= MAX_RELAY_MESSAGE =>
            {
                data.extend_from_slice(&f)
            }
            _ => actions.push_back(Action::WsSend { conn, data: f }),
        }
    }
}

pub struct Config {
    /// A tailcat server's `tc…` address to connect to (its exit node); empty: none, serving only.
    pub addr: String,
    /// Let tailcat clients in to the guest at the node's tunnel address.
    pub serve: Option<Serve>,
    /// Where to look up a region given by its ID only.
    pub derp_map_url: String,
    /// The node's private key; a fresh one when None. Kept, it keeps the served address.
    pub key: Option<[u8; 32]>,
    /// The guest's IPv4 address, translated to and from the tunnel's IPv6.
    pub guest4: [u8; 4],
    /// Resolvers for the guest's lease (reached through the server).
    pub dns4: Vec<[u8; 4]>,
    pub dns6: Vec<[u8; 16]>,
}

/// The VM as a tailcat server (docs/networking/tailnet.md "tailcat").
pub struct Serve {
    /// The address's pre-shared key: a client needs it (tailcat's default).
    pub psk: [u8; 32],
    /// The relay when there's no server to connect to (with one, its relay serves too): its
    /// nodes, or a region of the DERP map by ID.
    pub nodes: Vec<tailcat::DerpNode>,
    pub region_id: i64,
    /// The clients' node keys let in (`tailcat serve --allow`); empty: any with the address.
    pub allow: Vec<[u8; 32]>,
}

pub const DEFAULT_DERP_MAP: &str = "https://tailcat.dev/derpmap.json";
/// RFC 7335's address for the IPv4 side of a host's translator (464XLAT's CLAT).
pub const GUEST4: [u8; 4] = [192, 0, 0, 2];
const TUNNEL_MTU: usize = 1280;
const SERVER: PeerId = PeerId(1);
/// How many tailcat clients a served VM takes at once (each is a WireGuard peer), counting those
/// that have shown the address's pre-shared key (their first data decrypted). Past it, the one
/// heard from least recently makes room for another that has, if it has been quiet for
/// [`CLIENT_IDLE`]; a newcomer that hasn't takes no one's place.
const MAX_CLIENTS: usize = 64;
/// Newcomers that haven't shown the pre-shared key yet, beside [`MAX_CLIENTS`]: past them, the one
/// heard from least recently goes if it has been quiet for [`HANDSHAKE_TIMEOUT`], or else the next
/// is refused.
const MAX_NEWCOMERS: usize = 16;
/// Clients that made room, kept (key and route) so the guest's next packet to one lets it in again
/// and starts the handshake from here. Past it, the one that made room first is forgotten
/// (`client-gone`).
const MAX_AWAY: usize = 64;
/// A client quiet this long can make room for a new one: past WireGuard's REJECT_AFTER_TIME (180 s)
/// its session is dead, so if it's still there its next packet is a handshake initiation, which
/// lets it in again (tailcat's clients take a fresh key each run, so most are gone for good).
const CLIENT_IDLE: Duration = Duration::from_secs(190);
/// A WireGuard handshake initiation's type and size.
const INITIATION: (u8, usize) = (1, 148);
/// Disco's address for "over DERP" (magicsock's derpMagicIPAddr); the port is the region.
const DERP_MAGIC: std::net::Ipv4Addr = std::net::Ipv4Addr::new(127, 3, 3, 40);
const MEOW_EVERY: Duration = Duration::from_secs(1);
const MEOW_TIMEOUT: Duration = Duration::from_secs(15);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(20);
/// A relay connection up this long worked: its loss reconnects at once.
const STABLE: Duration = Duration::from_secs(10);
const DISCO_MAGIC: &[u8; 6] = b"TS\xf0\x9f\x92\xac";

#[derive(Debug, Clone, Copy, PartialEq)]
enum State {
    FetchingMap,
    Connecting,
    Meowing,
    Handshaking,
    Running,
    Failed,
}

/// A tailcat client of the served VM.
struct Peer {
    key: [u8; 32],
    addr: [u8; 16],
    /// When it was last heard from.
    heard: Instant,
    /// Its first data decrypted, which proves it has the address's pre-shared key (IKpsk2 mixes
    /// it in only at the response, so neither a meow nor an initiation can).
    proven: bool,
    /// The page has heard of it (`client`). One let in by a handshake alone is on trial until
    /// proven, and forgotten after `HANDSHAKE_TIMEOUT` without; one that meowed is announced at once.
    announced: bool,
}

pub struct Client {
    cfg: Config,
    /// The server we connect to, if any.
    exit: Option<tailcat::ConnInfo>,
    /// The served address's pre-shared key, when serving.
    serve_psk: Option<[u8; 32]>,
    /// The clients let in when serving (empty: any), and the last key refused (said once, not at each meow).
    allow: Vec<[u8; 32]>,
    refused: Option<[u8; 32]>,
    /// Our relay region: its ID and nodes (what the served address names).
    region_id: i64,
    region: Vec<tailcat::DerpNode>,
    /// The relays' WebSocket URLs.
    nodes: Vec<String>,
    node: usize,
    private: [u8; 32],
    public: [u8; 32],
    disco: [u8; 32],
    /// The disco key's private half: a served VM answers its clients' disco pings (`tailcat ping`).
    disco_private: [u8; 32],
    tc6: [u8; 16],
    wg: Endpoint,
    /// The served VM's clients, by WireGuard peer and by tunnel address.
    peers: BTreeMap<PeerId, Peer>,
    by_addr: BTreeMap<[u8; 16], PeerId>,
    /// The clients that made room (key, address), the first to go first.
    away: VecDeque<([u8; 32], [u8; 16])>,
    next_peer: u32,
    derp: Option<(u32, derp::Conn)>,
    /// When the relay connection became ready.
    derp_ready: Option<Instant>,
    /// The server left the relay: once it meows back, a new WireGuard session (it lost ours).
    server_gone: bool,
    next_conn: u32,
    state: State,
    /// Whether the page has heard of any state yet.
    announced: bool,
    /// When the current phase gives up (meow, handshake), and when to meow next.
    phase_deadline: Option<Instant>,
    meow_at: Option<Instant>,
    reconnect_at: Option<Instant>,
    failures: u32,
    actions: VecDeque<Action>,
}

/// Pads a WireGuard plaintext to a multiple of 16 bytes within the MTU, as
/// wireguard-go does; `ts_tunnel` leaves padding to its caller.
pub(crate) fn pad(p: &mut Vec<u8>) {
    let n = ((16 - p.len() % 16) % 16).min(TUNNEL_MTU.saturating_sub(p.len()));
    p.resize(p.len() + n, 0);
}

/// The IP packet in a decrypted, maybe padded, plaintext.
pub(crate) fn unpad(p: &[u8]) -> Option<&[u8]> {
    let len = match p.first()? >> 4 {
        4 if p.len() >= 20 => u16::from_be_bytes([p[2], p[3]]) as usize,
        6 if p.len() >= 40 => 40 + u16::from_be_bytes([p[4], p[5]]) as usize,
        _ => return None,
    };
    // At least its header (a total length under it isn't a packet).
    p.get(..len)
        .filter(|q| q.len() >= if p[0] >> 4 == 4 { 20 } else { 40 })
}

/// The disco key a node key implies (private, public), so a kept node key keeps its served
/// address. tailcat derives its own the same way in spirit (`discoPrivateForNode`); the private
/// half only answers pings (a browser has no direct paths for disco to find).
fn disco_for(private: &[u8; 32]) -> ([u8; 32], [u8; 32]) {
    let mut h = Blake2s256::new();
    h.update(b"waarm64 tailcat disco key v1");
    h.update(private);
    let secret: [u8; 32] = h.finalize().into();
    (secret, *SecretKey::from(secret).public_key().as_bytes())
}

impl Client {
    pub fn new(mut cfg: Config, now: Instant) -> Result<Self, String> {
        let exit = match cfg.addr.trim() {
            "" => None,
            a => Some(tailcat::parse_addr(a)?),
        };
        let serve = cfg.serve.take();
        let (region_id, region) = match (&exit, &serve) {
            (Some(ci), _) => (ci.region_id, ci.nodes.clone()),
            (None, Some(s)) => (s.region_id, s.nodes.clone()),
            (None, None) => return Err("nothing to do: no tailcat address and not serving".into()),
        };
        let private = match cfg.key {
            Some(k) => k,
            None => {
                let mut k = [0u8; 32];
                getrandom::fill(&mut k).map_err(|e| format!("no randomness: {e}"))?;
                k
            }
        };
        let pair = NodeKeyPair::from(Export::<NodePrivateKey>::from_bytes(private).import());
        let public = *pair.public.export().as_bytes();
        let mut wg = Endpoint::new(pair);
        if let Some(ci) = &exit {
            wg.upsert_peer(PeerConfig::new(
                SERVER,
                NodePublicKey::from_bytes(ci.server),
                ci.psk.unwrap_or_default(),
            ));
        }
        let nodes = region
            .iter()
            .filter_map(tailcat::DerpNode::browser_url)
            .collect();
        let (disco_private, disco) = disco_for(&private);
        let allow = serve.as_ref().map(|s| s.allow.clone()).unwrap_or_default();
        let mut c = Client {
            tc6: tailcat::addr_for_key(&public),
            disco,
            disco_private,
            cfg,
            exit,
            serve_psk: serve.map(|s| s.psk),
            allow,
            refused: None,
            region_id,
            region,
            nodes,
            node: 0,
            private,
            public,
            wg,
            peers: BTreeMap::new(),
            by_addr: BTreeMap::new(),
            away: VecDeque::new(),
            next_peer: SERVER.0 + 1,
            derp: None,
            derp_ready: None,
            server_gone: false,
            next_conn: 1,
            state: State::Connecting,
            announced: false,
            phase_deadline: None,
            meow_at: None,
            reconnect_at: None,
            failures: 0,
            actions: VecDeque::new(),
        };
        c.event(json!({ "type": "self", "key": format!("nodekey:{}", hex(&public)), "address6": c.tc6 }));
        if !c.region.is_empty() || c.region_id > 0 {
            c.publish();
        }
        if c.region.is_empty() {
            c.set_state(State::FetchingMap, None);
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

    /// The served address, once the region is known: the region's nodes when we were given
    /// them, its ID in the map otherwise (the short form, as `tailcat serve` prints).
    fn publish(&mut self) {
        let Some(psk) = self.serve_psk else { return };
        let addr = tailcat::encode_addr(&tailcat::ConnInfo {
            server: self.public,
            server_disco: Some(self.disco),
            psk: Some(psk),
            region_id: self.region_id,
            nodes: self.region.clone(),
        });
        self.event(json!({ "type": "serving", "addr": addr }));
    }

    /// The node's private key (to keep it, so a server can `--allow` it).
    pub fn private_key(&self) -> [u8; 32] {
        self.private
    }

    fn event(&mut self, v: serde_json::Value) {
        self.actions.push_back(Action::Event(v.to_string()));
    }

    /// Announces state `s`; `failed`: why it failed, a stable code the page words
    /// (`web/ts-client.ts` `failureOf`) and the technical detail, if any.
    fn set_state(&mut self, s: State, failed: Option<(&'static str, &str)>) {
        if self.state == s && failed.is_none() && self.announced {
            return;
        }
        self.state = s;
        self.announced = true;
        let name = format!("{s:?}");
        self.event(match failed {
            Some((code, "")) => json!({ "type": "state", "state": name, "code": code }),
            Some((code, detail)) => {
                json!({ "type": "state", "state": name, "code": code, "detail": detail })
            }
            None => json!({ "type": "state", "state": name }),
        });
        if s == State::Running {
            self.failures = 0;
            // Serving only, nothing beyond the clients is reachable: no resolvers.
            let (dns4, dns6) = if self.exit.is_some() {
                (self.cfg.dns4.clone(), self.cfg.dns6.clone())
            } else {
                (Vec::new(), Vec::new())
            };
            let lease = json!({
                "address": self.cfg.guest4, "address6": self.tc6, "mtu": TUNNEL_MTU,
                "dns": dns4, "dns6": dns6, "domains": [],
            });
            self.event(json!({ "type": "lease", "lease": lease }));
        }
    }

    /// Gives up: `code` says why (the page has its words), `detail` is a developer's.
    fn fail(&mut self, code: &'static str, detail: &str) {
        self.close_derp();
        self.phase_deadline = None;
        self.meow_at = None;
        self.reconnect_at = None;
        self.set_state(State::Failed, Some((code, detail)));
    }

    fn log(&mut self, msg: String) {
        self.event(json!({ "type": "log", "msg": msg }));
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
        self.phase_deadline = Some(now + MEOW_TIMEOUT);
        if self.state != State::Running {
            self.set_state(State::Connecting, None);
        }
    }

    /// Lost the relay (or never got it): try the next node, at once after one that was up, after a
    /// growing backoff when it keeps failing (one up for under `STABLE` counts as failing).
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
            // The detail is the map's URL, which the page's words name.
            let url = self.cfg.derp_map_url.clone();
            return self.fail("derp-map", &url);
        }
        match tailcat::region_nodes(body, self.region_id) {
            Ok((id, nodes)) => {
                if self.region_id == 0 {
                    self.region_id = id;
                    self.publish();
                }
                self.nodes = nodes
                    .iter()
                    .filter_map(tailcat::DerpNode::browser_url)
                    .collect();
                if self.nodes.is_empty() {
                    return self.fail("region-no-browser-relay", "");
                }
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
        if e == derp::Event::Ready {
            self.derp_ready = Some(now);
        }
        match e {
            derp::Event::Ready if self.exit.is_some() => {
                // Each new relay connection says hello again: the server may have
                // forgotten us, and it's how it learns where we are.
                self.meow(now);
                self.phase_deadline = Some(now + MEOW_TIMEOUT);
                if self.state != State::Running {
                    self.set_state(State::Meowing, None);
                }
            }
            derp::Event::Ready => {
                // Serving only: up once the relay knows us, clients find us there.
                self.phase_deadline = None;
                self.set_state(State::Running, None);
            }
            derp::Event::Recv { src, packet } => self.on_relay_packet(src, packet, now),
            derp::Event::Restarting { reconnect_ms } => {
                self.close_derp();
                self.reconnect_at =
                    Some(now + Duration::from_millis(reconnect_ms.clamp(100, 30_000) as u64));
            }
            derp::Event::PeerGone(k)
                if self.state == State::Running
                    && self.exit.as_ref().is_some_and(|ci| ci.server == k) =>
            {
                // The server left the relay (a restart forgets its clients): hello again until
                // it's back, then a new session.
                self.log("tailcat: the server left the relay; waiting for it".into());
                self.server_gone = true;
                self.meow(now);
                self.phase_deadline = Some(now + MEOW_TIMEOUT);
            }
            derp::Event::Health(h) if !h.is_empty() => self.log(format!("DERP health: {h}")),
            derp::Event::Health(_) | derp::Event::PeerGone(_) => {}
        }
    }

    fn meow(&mut self, now: Instant) {
        let Some(server) = self.exit.as_ref().map(|ci| ci.server) else {
            return;
        };
        let ping = tailcat::meow_ping(&self.public, &self.disco);
        if let Some((_, d)) = self.derp.as_mut() {
            d.send(&server, &ping, now);
        }
        self.flush_derp();
        self.meow_at = Some(now + MEOW_EVERY);
    }

    fn on_relay_packet(&mut self, src: [u8; 32], packet: Vec<u8>, now: Instant) {
        if self.exit.as_ref().is_some_and(|ci| ci.server == src) {
            return self.on_server_packet(packet, now);
        }
        if self.serve_psk.is_none() {
            return;
        }
        let known = self.peer_of(&src);
        if let Some(id) = known {
            self.peers.get_mut(&id).unwrap().heard = now;
        }
        if tailcat::parse_meow_ping(&packet).is_some() {
            // A client says hello (tailcat takes the relay's word for its key, as here): it
            // becomes a WireGuard peer with the address's pre-shared key, and is told so. One
            // not on the allow list gets no answer, as with tailcat's `--allow`.
            if known.is_none() {
                let Some(id) = self.admit(src, now) else {
                    return;
                };
                self.peers.get_mut(&id).unwrap().announced = true;
                self.announce_client(id);
            }
            if let Some((conn, d)) = self.derp.as_mut() {
                d.send(&src, tailcat::MEOWED, now);
                queue_frames(&mut self.actions, *conn, d.take_output());
            }
            return;
        }
        if packet.starts_with(DISCO_MAGIC) {
            if known.is_some() {
                self.disco_pong(src, packet, now);
            }
            return;
        }
        if tailcat::is_meow(&packet) {
            return;
        }
        let Some(id) = known.or_else(|| {
            // A key that never meowed, or a client that made room for another (quiet past
            // `CLIENT_IDLE`) and came back: its handshake lets it in, on trial unless it made room.
            (packet.first() == Some(&INITIATION.0) && packet.len() == INITIATION.1)
                .then(|| self.admit(src, now))
                .flatten()
        }) else {
            return; // not a client of ours: it never meowed
        };
        let r = self.wg.recv(now, [PacketMut::from(packet)]);
        if known.is_none() && r.to_peers.is_empty() {
            // Not a handshake it could start: it isn't let in.
            return self.forget(id);
        }
        self.send_to_peers(r.to_peers, now);
        for (id, packets) in r.to_local {
            if !self.prove(id, now) {
                continue;
            }
            for p in packets {
                self.on_tunnel_packet(id, p.as_ref());
            }
        }
    }

    fn peer_of(&self, key: &[u8; 32]) -> Option<PeerId> {
        self.wg.peer_id(NodePublicKey::from_bytes(*key))
    }

    /// Lets client `key` in as a WireGuard peer, if the allow list has it and there's room: a
    /// newcomer among the `MAX_NEWCOMERS`, one that made room among the clients (it was proven
    /// before). A meow announces a newcomer at once; a handshake, once its data decrypts.
    fn admit(&mut self, key: [u8; 32], now: Instant) -> Option<PeerId> {
        if !self.allow.is_empty() && !self.allow.contains(&key) {
            if self.refused.replace(key) != Some(key) {
                self.log(format!(
                    "tailcat: nodekey:{} isn't on the allow list",
                    hex(&key)
                ));
            }
            return None;
        }
        let psk = self.serve_psk?;
        let back = self.away.iter().position(|(k, _)| *k == key);
        if let Some(at) = back {
            if !self.make_room(None, now) {
                return None;
            }
            self.away.remove(at);
        } else if self.peers.values().filter(|p| !p.proven).count() >= MAX_NEWCOMERS {
            let stale = self
                .peers
                .iter()
                .filter(|(_, p)| !p.proven)
                .min_by_key(|(_, p)| p.heard)
                .filter(|(_, p)| now.saturating_duration_since(p.heard) >= HANDSHAKE_TIMEOUT)
                .map(|(id, _)| *id);
            match stale {
                Some(id) => self.forget(id),
                None => {
                    self.log(format!(
                        "tailcat: {MAX_NEWCOMERS} newcomers already, one more refused"
                    ));
                    return None;
                }
            }
        }
        let id = PeerId(self.next_peer);
        self.next_peer += 1;
        self.wg
            .upsert_peer(PeerConfig::new(id, NodePublicKey::from_bytes(key), psk));
        let addr = tailcat::addr_for_key(&key);
        self.peers.insert(
            id,
            Peer {
                key,
                addr,
                heard: now,
                proven: back.is_some(),
                announced: back.is_some(),
            },
        );
        self.by_addr.insert(addr, id);
        Some(id)
    }

    /// Whether there's room among the proven clients (but `except`), made by the one quiet
    /// longest if that's past `CLIENT_IDLE`.
    fn make_room(&mut self, except: Option<PeerId>, now: Instant) -> bool {
        let proven = || {
            self.peers
                .iter()
                .filter(|(id, p)| p.proven && Some(**id) != except)
        };
        if proven().count() < MAX_CLIENTS {
            return true;
        }
        let quiet = proven()
            .min_by_key(|(_, p)| p.heard)
            .filter(|(_, p)| now.saturating_duration_since(p.heard) >= CLIENT_IDLE)
            .map(|(id, _)| *id);
        match quiet {
            Some(id) => {
                self.forget(id);
                true
            }
            None => {
                self.log(format!(
                    "tailcat: {MAX_CLIENTS} clients already, one more refused"
                ));
                false
            }
        }
    }

    /// Client `id`'s data decrypted: it has the pre-shared key, so it is a client if there's room
    /// (else it goes). Whether its packets go on to the guest.
    fn prove(&mut self, id: PeerId, now: Instant) -> bool {
        match self.peers.get(&id) {
            None => return false,
            Some(p) if p.proven => return true,
            Some(_) => {}
        }
        if !self.make_room(Some(id), now) {
            self.forget(id);
            return false;
        }
        let p = self.peers.get_mut(&id).unwrap();
        p.proven = true;
        if !std::mem::replace(&mut p.announced, true) {
            self.announce_client(id);
        }
        true
    }

    fn announce_client(&mut self, id: PeerId) {
        let Some(p) = self.peers.get(&id) else { return };
        let (key, addr) = (p.key, p.addr);
        self.event(
            json!({ "type": "client", "key": format!("nodekey:{}", hex(&key)), "address6": addr }),
        );
    }

    /// Drops client `id`. A proven one is kept away (its key, and the page keeps its route), so
    /// the guest's next packet to it lets it in again; else the page hears it went, if it heard
    /// it came.
    fn forget(&mut self, id: PeerId) {
        self.wg.remove_peer(id);
        let Some(p) = self.peers.remove(&id) else {
            return;
        };
        self.by_addr.remove(&p.addr);
        let gone = if p.proven {
            self.away.push_back((p.key, p.addr));
            if self.away.len() > MAX_AWAY {
                self.away.pop_front()
            } else {
                None
            }
        } else {
            p.announced.then_some((p.key, p.addr))
        };
        if let Some((key, addr)) = gone {
            self.event(json!({ "type": "client-gone", "key": format!("nodekey:{}", hex(&key)), "address6": addr }));
        }
    }

    /// Answers a client's disco ping with a pong over the relay, as tailcat's server does, so
    /// `tailcat ping` sees the path through DERP work.
    fn disco_pong(&mut self, src: [u8; 32], mut packet: Vec<u8>, now: Instant) {
        use ts_disco_protocol::{Encrypted, Packet, Ping, Pong};
        use ts_keys::{DiscoPrivateKey, DiscoPublicKey};
        let private = Export::<DiscoPrivateKey>::from_bytes(self.disco_private).import();
        let Ok(enc) = Packet::<Encrypted>::from_encrypted_bytes_mut(&mut packet) else {
            return;
        };
        let sender = *enc.sender_pubkey().export().as_bytes();
        let Ok(plain) = enc.decrypt_in_place(&private) else {
            return;
        };
        let Some(ping) = plain.as_msg::<Ping>() else {
            return;
        };
        // The ping names the key the relay says sent it.
        if *ping.node_key.export().as_bytes() != src {
            return;
        }
        let tx_id = ping.tx_id;
        let mut out = Packet::<ts_disco_protocol::Plaintext>::vec_for_message(Pong::size());
        let at = std::net::SocketAddr::from((DERP_MAGIC, self.region_id as u16));
        let Ok(pong) =
            Packet::<ts_disco_protocol::Plaintext>::init_from_bytes::<Pong>(&mut out, |m| {
                m.tx_id = tx_id;
                m.src = ts_disco_protocol::Endpoint::from_socket_addr(at);
            })
        else {
            return;
        };
        let mut nonce = [0u8; 24];
        if getrandom::fill(&mut nonce).is_err()
            || pong
                .encrypt_in_place(&private, &DiscoPublicKey::from_bytes(sender), nonce)
                .is_err()
        {
            return;
        }
        if let Some((conn, d)) = self.derp.as_mut() {
            d.send(&src, &out, now);
            queue_frames(&mut self.actions, *conn, d.take_output());
        }
    }

    fn on_server_packet(&mut self, packet: Vec<u8>, now: Instant) {
        if tailcat::is_meowed(&packet) {
            self.meow_at = None;
            if self.state == State::Meowing {
                self.set_state(State::Handshaking, None);
                self.phase_deadline = Some(now + HANDSHAKE_TIMEOUT);
                // An empty packet starts the handshake now rather than at the guest's first packet.
                let r = self.wg.send(now, [(SERVER, vec![PacketMut::new(0)])]);
                self.send_to_peers(r.to_peers, now);
            } else if self.state == State::Running {
                self.phase_deadline = None;
                if std::mem::take(&mut self.server_gone) {
                    self.new_server_session(now);
                }
            }
            return;
        }
        if tailcat::is_meow(&packet) || packet.starts_with(DISCO_MAGIC) {
            return; // disco is for direct paths; a browser has none
        }
        let response = packet.first() == Some(&2);
        let r = self.wg.recv(now, [PacketMut::from(packet)]);
        if response && !r.to_peers.is_empty() && self.state == State::Handshaking {
            // ts_tunnel answers a valid handshake response with the queued (or a keepalive) packet.
            self.phase_deadline = None;
            self.set_state(State::Running, None);
        }
        self.send_to_peers(r.to_peers, now);
        for (id, packets) in r.to_local {
            for p in packets {
                self.on_tunnel_packet(id, p.as_ref());
            }
        }
    }

    /// The server lost our WireGuard session: drop ours and start another.
    fn new_server_session(&mut self, now: Instant) {
        let Some(ci) = self.exit.as_ref() else { return };
        let cfg = PeerConfig::new(
            SERVER,
            NodePublicKey::from_bytes(ci.server),
            ci.psk.unwrap_or_default(),
        );
        self.wg.remove_peer(SERVER);
        self.wg.upsert_peer(cfg);
        let r = self.wg.send(now, [(SERVER, vec![PacketMut::new(0)])]);
        self.send_to_peers(r.to_peers, now);
    }

    /// Sends WireGuard's packets to their peers through the relay.
    fn send_to_peers(
        &mut self,
        to_peers: impl IntoIterator<Item = (PeerId, Vec<PacketMut>)>,
        now: Instant,
    ) {
        let Some((conn, d)) = self.derp.as_mut() else {
            return;
        };
        let conn = *conn;
        for (id, packets) in to_peers {
            let key = match (id, &self.exit) {
                (SERVER, Some(ci)) => ci.server,
                _ => match self.peers.get(&id) {
                    Some(p) => p.key,
                    None => continue,
                },
            };
            for p in packets {
                d.send(&key, p.as_ref(), now);
            }
        }
        queue_frames(&mut self.actions, conn, d.take_output());
    }

    fn on_tunnel_packet(&mut self, from: PeerId, plaintext: &[u8]) {
        let Some(p) = unpad(plaintext) else { return };
        if p[0] >> 4 != 6 || p[24..40] != self.tc6 {
            return;
        }
        if from != SERVER || self.exit.is_none() {
            // A client of the served VM: IPv6 from its own tunnel address only (WireGuard says
            // who sent it; the address is what its key implies), to the guest as is.
            if self.peers.get(&from).is_some_and(|c| p[8..24] == c.addr) {
                self.actions.push_back(Action::ToGuest(p.to_vec()));
            }
            return;
        }
        match nat46::in6(p, self.cfg.guest4) {
            Some(v4) => self.actions.push_back(Action::ToGuest(v4)),
            None if p[8..20] != nat46::PREFIX => {
                self.actions.push_back(Action::ToGuest(p.to_vec()))
            }
            None => {} // from the prefix, but nothing we translate
        }
    }

    /// An IP packet from the guest.
    pub fn guest_packet(&mut self, p: &[u8], now: Instant) {
        if self.state != State::Running {
            return; // no lease yet: nothing should come
        }
        let (to, mut out) = match p.first().map(|b| b >> 4) {
            Some(4) if self.exit.is_some() => match nat46::out4(p, &self.tc6) {
                nat46::Out::Tunnel(v6) => (SERVER, v6),
                nat46::Out::Guest(icmp) => return self.actions.push_back(Action::ToGuest(icmp)),
                nat46::Out::Drop => return,
            },
            Some(6) if p.len() >= 40 && p.len() <= TUNNEL_MTU && p[8..24] == self.tc6 => {
                // To a client of the served VM, or else out through the server, if any.
                let dst: [u8; 16] = p[24..40].try_into().unwrap();
                // One that made room is let in again, the handshake from here.
                let back = || self.away.iter().find(|(_, a)| *a == dst).map(|(k, _)| *k);
                match self.by_addr.get(&dst).copied() {
                    Some(id) => (id, p.to_vec()),
                    None => match back() {
                        Some(key) => match self.admit(key, now) {
                            Some(id) => (id, p.to_vec()),
                            None => return,
                        },
                        None if self.exit.is_some() => (SERVER, p.to_vec()),
                        None => return,
                    },
                }
            }
            _ => return,
        };
        pad(&mut out);
        let r = self.wg.send(now, [(to, vec![PacketMut::from(out)])]);
        self.send_to_peers(r.to_peers, now);
    }

    /// Runs what's due at `now`.
    pub fn tick(&mut self, now: Instant) {
        let r = self.wg.dispatch_events(now);
        self.send_to_peers(r.to_peers, now);
        let failed: Vec<_> = self
            .peers
            .iter()
            .filter(|(_, p)| {
                !p.announced && now.saturating_duration_since(p.heard) >= HANDSHAKE_TIMEOUT
            })
            .map(|(id, _)| *id)
            .collect();
        for id in failed {
            self.forget(id);
        }
        // A relay that died quietly (or never answered) goes.
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
        if self.meow_at.is_some_and(|t| t <= now) {
            self.meow(now);
        }
        if self.phase_deadline.is_some_and(|t| t <= now) {
            self.phase_deadline = None;
            match self.state {
                State::Connecting => self.retry(now, "no answer from the relay".into()),
                State::Meowing => self.fail("server-silent", ""),
                State::Handshaking => self.fail("handshake", ""),
                // A hello while running that the server ignores (it's away, or restarting):
                // keep saying it, it answers once it's back.
                State::Running => self.phase_deadline = Some(now + MEOW_TIMEOUT),
                State::FetchingMap | State::Failed => {}
            }
        }
    }

    /// When `tick` must run next.
    pub fn deadline(&self) -> Option<Instant> {
        [
            self.wg.next_event().map(|r| r.start()),
            self.derp.as_ref().and_then(|(_, d)| d.deadline()),
            self.meow_at,
            self.reconnect_at,
            self.phase_deadline,
            self.peers
                .values()
                .filter(|p| !p.announced)
                .map(|p| p.heard + HANDSHAKE_TIMEOUT)
                .min(),
        ]
        .into_iter()
        .flatten()
        .min()
    }

    pub fn poll(&mut self) -> Option<Action> {
        self.actions.pop_front()
    }

    /// Closes everything; the client does nothing after.
    pub fn close(&mut self) {
        self.close_derp();
        self.phase_deadline = None;
        self.meow_at = None;
        self.reconnect_at = None;
        self.state = State::Failed;
    }
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use base64::Engine;

    use super::*;
    use crate::derp::testserver::Server as Relay;

    /// A tailcat address for `server` with pre-shared key `psk` on relay derp.test.
    fn address(server: &[u8; 32], psk: &[u8; 32]) -> String {
        let mut b = vec![0xa3, 0x61, b'p', 0x58, 32];
        b.extend_from_slice(server);
        b.extend_from_slice(&[0x61, b'q', 0x58, 32]);
        b.extend_from_slice(psk);
        b.extend_from_slice(&[
            0x61, b'r', 0x81, 0xa1, 0x61, b'N', 0x81, 0xa1, 0x61, b'h', 0x69,
        ]);
        b.extend_from_slice(b"derp.test");
        format!(
            "tc{}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b)
        )
    }

    /// The tailcat server's side: a relay, and a WireGuard endpoint that
    /// learns the client from its meow.
    struct Server {
        relay: Relay,
        public: [u8; 32],
        psk: [u8; 32],
        wg: Endpoint,
        /// Decrypted packets the server got.
        got: Vec<Vec<u8>>,
        meows: usize,
        /// The client's current WebSocket.
        conn: u32,
    }

    impl Server {
        fn new() -> Self {
            let pair = NodeKeyPair::from(Export::<NodePrivateKey>::from_bytes([42; 32]).import());
            let public = *pair.public.export().as_bytes();
            Server {
                relay: Relay::new([43; 32]),
                public,
                psk: [7; 32],
                wg: Endpoint::new(pair),
                got: Vec::new(),
                meows: 0,
                conn: 0,
            }
        }

        /// Carries out the client's actions until it has nothing left; the
        /// guest's packets come back.
        fn run(&mut self, c: &mut Client, now: Instant) -> Vec<Vec<u8>> {
            let mut guest = Vec::new();
            while let Some(a) = c.poll() {
                match a {
                    Action::WsOpen {
                        conn,
                        url,
                        protocol,
                    } => {
                        assert_eq!((url.as_str(), protocol), ("wss://derp.test/derp", "derp"));
                        self.conn = conn;
                        c.ws_message(conn, &self.relay.hello(), now);
                    }
                    Action::WsSend { conn, data } => {
                        let mut sent = Vec::new();
                        for reply in self.relay.input(&data, &mut sent) {
                            c.ws_message(conn, &reply, now);
                        }
                        for (dst, p) in sent {
                            assert_eq!(dst, self.public);
                            for reply in self.on_client_packet(p, now) {
                                c.ws_message(conn, &self.relay.deliver(&self.public, &reply), now);
                            }
                        }
                    }
                    Action::ToGuest(p) => guest.push(p),
                    _ => {}
                }
            }
            guest
        }

        fn on_client_packet(&mut self, p: Vec<u8>, now: Instant) -> Vec<Vec<u8>> {
            if let Some((key, _)) = tailcat::parse_meow_ping(&p) {
                self.meows += 1;
                self.wg.upsert_peer(PeerConfig::new(
                    PeerId(2),
                    NodePublicKey::from_bytes(key),
                    self.psk,
                ));
                return vec![b"meow\x02".to_vec()];
            }
            let r = self.wg.recv(now, [PacketMut::from(p)]);
            for (_, ps) in r.to_local {
                self.got
                    .extend(ps.into_iter().map(|p| unpad(p.as_ref()).unwrap().to_vec()));
            }
            r.to_peers
                .into_values()
                .flatten()
                .map(|p| p.as_ref().to_vec())
                .collect()
        }

        /// Sends `p` to the client through the tunnel.
        fn send(&mut self, c: &mut Client, mut p: Vec<u8>, now: Instant) -> Vec<Vec<u8>> {
            pad(&mut p);
            let r = self.wg.send(now, [(PeerId(2), vec![PacketMut::from(p)])]);
            for p in r.to_peers.into_values().flatten() {
                c.ws_message(
                    self.conn,
                    &self.relay.deliver(&self.public, p.as_ref()),
                    now,
                );
            }
            self.run(c, now)
        }
    }

    fn config(addr: String) -> Config {
        Config {
            addr,
            serve: None,
            derp_map_url: String::new(),
            key: None,
            guest4: GUEST4,
            dns4: vec![[1, 1, 1, 1]],
            dns6: vec![],
        }
    }

    #[test]
    fn connects_and_carries_packets_both_ways() {
        let now = Instant::now();
        let mut s = Server::new();
        let mut c = Client::new(config(address(&s.public, &s.psk)), now).unwrap();
        s.run(&mut c, now);
        assert_eq!(c.state, State::Running);
        assert_eq!(s.meows, 1);
        // A UDP packet from the guest's IPv4 address to 1.1.1.1:53 leaves as IPv6.
        let mut udp = vec![
            0x45, 0, 0, 33, 0, 0, 0x40, 0, 64, 17, 0, 0, 192, 0, 0, 2, 1, 1, 1, 1,
        ];
        udp.extend_from_slice(&[0x30, 0x39, 0, 53, 0, 13, 0, 0, b'h', b'e', b'l', b'l', b'o']);
        c.guest_packet(&udp, now);
        s.run(&mut c, now);
        let v6 = s.got.pop().expect("the server got the packet");
        assert_eq!(&v6[8..24], &c.tc6);
        assert_eq!(
            &v6[24..40],
            &[0, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1]
        );
        assert_eq!(&v6[48..], b"hello");
        // The reply comes back to the guest as IPv4.
        let mut reply = v6.clone();
        reply[8..24].copy_from_slice(&v6[24..40]);
        reply[24..40].copy_from_slice(&v6[8..24]);
        reply.swap(40, 42);
        reply.swap(41, 43);
        let guest = s.send(&mut c, reply, now);
        assert_eq!(guest.len(), 1);
        assert_eq!(&guest[0][12..20], &[1, 1, 1, 1, 192, 0, 0, 2]);
        assert_eq!(&guest[0][28..], b"hello");
        // IPv6 from the server's own address reaches the guest as is.
        let mut native = v6.clone();
        native[8..24].copy_from_slice(&tailcat::addr_for_key(&s.public));
        native[24..40].copy_from_slice(&c.tc6);
        assert_eq!(s.send(&mut c, native.clone(), now), vec![native]);
    }

    #[test]
    fn packets_queued_together_leave_in_one_relay_message() {
        let now = Instant::now();
        let mut s = Server::new();
        let mut c = Client::new(config(address(&s.public, &s.psk)), now).unwrap();
        s.run(&mut c, now);
        for k in 0..3u8 {
            c.guest_packet(&udp(&[k; 100]), now);
        }
        let sends: Vec<_> = std::iter::from_fn(|| c.poll()).collect();
        assert_eq!(sends.len(), 1, "one message: {sends:?}");
        let Action::WsSend { conn, data } = &sends[0] else {
            panic!("{sends:?}")
        };
        let mut sent = Vec::new();
        s.relay.input(data, &mut sent);
        assert_eq!(sent.len(), 3, "the relay reads three frames out of it");
        for (_, p) in sent {
            s.on_client_packet(p, now);
        }
        let got: Vec<_> = s.got.iter().map(|p| p[48]).collect();
        assert_eq!(got, [0, 1, 2], "in order");
        assert_eq!(*conn, s.conn);
    }

    #[test]
    fn frames_join_only_on_one_connection_and_up_to_the_cap() {
        let mut a = VecDeque::new();
        queue_frames(&mut a, 1, vec![vec![1; 10], vec![2; 10]]);
        queue_frames(&mut a, 2, vec![vec![3; 10]]);
        a.push_back(Action::ToGuest(vec![]));
        queue_frames(
            &mut a,
            2,
            vec![vec![4; MAX_RELAY_MESSAGE - 10], vec![5; 10], vec![6; 1]],
        );
        let sizes: Vec<_> = a
            .iter()
            .map(|x| match x {
                Action::WsSend { conn, data } => (*conn, data.len()),
                _ => (0, 0),
            })
            .collect();
        assert_eq!(
            sizes,
            [(1, 20), (2, 10), (0, 0), (2, MAX_RELAY_MESSAGE), (2, 1)]
        );
    }

    /// A UDP packet from the guest's IPv4 address to 1.1.1.1:53 carrying `payload`.
    fn udp(payload: &[u8]) -> Vec<u8> {
        let n = payload.len() as u8;
        let mut p = vec![
            0x45,
            0,
            0,
            28 + n,
            0,
            0,
            0x40,
            0,
            64,
            17,
            0,
            0,
            192,
            0,
            0,
            2,
            1,
            1,
            1,
            1,
        ];
        p.extend_from_slice(&[0x30, 0x39, 0, 53, 0, 8 + n, 0, 0]);
        p.extend_from_slice(payload);
        p
    }

    #[test]
    fn relay_loss_while_running() {
        let mut now = Instant::now();
        let mut s = Server::new();
        let mut c = Client::new(config(address(&s.public, &s.psk)), now).unwrap();
        s.run(&mut c, now);
        assert_eq!(c.state, State::Running);
        let first = s.conn;
        // The relay goes away: the client stays Running (the guest keeps its
        // lease) and comes back at once.
        c.ws_closed(first, now);
        assert_eq!(c.state, State::Running);
        let at = c.deadline().unwrap();
        assert!(at <= now, "no backoff for the first loss");
        now = at;
        c.tick(now);
        s.run(&mut c, now);
        assert_ne!(s.conn, first, "a new connection");
        assert_eq!(s.meows, 2, "it said hello again");
        // Traffic flows on the same WireGuard session.
        c.guest_packet(&udp(b"again"), now);
        s.run(&mut c, now);
        assert_eq!(&s.got.pop().expect("the server got it")[48..], b"again");
    }

    #[test]
    fn a_relay_that_dies_quietly_or_never_answers_is_replaced() {
        let now = Instant::now();
        let mut s = Server::new();
        let mut c = Client::new(config(address(&s.public, &s.psk)), now).unwrap();
        s.run(&mut c, now);
        assert_eq!(c.state, State::Running);
        let first = s.conn;
        // Quiet: a ping; nothing comes back (the path died, the socket didn't say).
        let t = now + derp::IDLE_PING;
        assert!(c.deadline().unwrap() <= t);
        c.tick(t);
        while c.poll().is_some() {}
        let t = t + derp::PONG_WAIT;
        c.tick(t);
        let opened = std::iter::from_fn(|| c.poll())
            .filter_map(|a| match a {
                Action::WsOpen { conn, .. } => Some(conn),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(opened.len(), 1, "a new connection at once");
        assert_ne!(opened[0], first);
        assert_eq!(c.state, State::Running);
        // That one never answers: replaced too, though the client stays Running.
        let t = t + derp::CONNECT_WAIT;
        assert!(c.deadline().unwrap() <= t);
        c.tick(t);
        let t = c.deadline().unwrap().max(t);
        c.tick(t);
        s.run(&mut c, t);
        assert_eq!(s.meows, 2, "a working relay again, and a hello on it");
        c.guest_packet(&udp(b"again"), t);
        s.run(&mut c, t);
        assert_eq!(&s.got.pop().expect("the server got it")[48..], b"again");
    }

    #[test]
    fn a_server_restart_gets_a_new_session() {
        let now = Instant::now();
        let mut s = Server::new();
        let mut c = Client::new(config(address(&s.public, &s.psk)), now).unwrap();
        s.run(&mut c, now);
        assert_eq!(c.state, State::Running);
        // The server restarts with the same key: it knows neither our key nor our session.
        let pair = NodeKeyPair::from(Export::<NodePrivateKey>::from_bytes([42; 32]).import());
        s.wg = Endpoint::new(pair);
        let t = now + Duration::from_secs(3);
        c.ws_message(s.conn, &s.relay.peer_gone(&s.public), t);
        s.run(&mut c, t);
        assert_eq!(s.meows, 2, "it said hello again");
        c.guest_packet(&udp(b"after"), t);
        s.run(&mut c, t);
        assert_eq!(&s.got.pop().expect("the server got it")[48..], b"after");
    }

    #[test]
    fn an_empty_ip_packet_is_not_one() {
        assert_eq!(
            unpad(&[
                0x45, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
            ]),
            None
        );
        let mut v6 = [0u8; 40];
        v6[0] = 0x60;
        assert_eq!(
            unpad(&v6).map(|p| p.len()),
            Some(40),
            "a bare IPv6 header is"
        );
    }

    #[test]
    fn gives_up_when_the_server_doesnt_meow() {
        let now = Instant::now();
        let mut s = Server::new();
        let mut c = Client::new(config(address(&[9; 32], &s.psk)), now).unwrap();
        let mut sent = 0;
        let mut t = now;
        while c.state != State::Failed && t < now + Duration::from_secs(60) {
            while let Some(a) = c.poll() {
                match a {
                    Action::WsOpen { conn, .. } => c.ws_message(conn, &s.relay.hello(), t),
                    Action::WsSend { conn, data } => {
                        let mut out = Vec::new();
                        for r in s.relay.input(&data, &mut out) {
                            c.ws_message(conn, &r, t);
                        }
                        sent += out.len();
                    }
                    _ => {}
                }
            }
            t = c.deadline().unwrap().max(t);
            c.tick(t);
        }
        assert_eq!(c.state, State::Failed);
        assert!(sent >= 10, "it meowed every second meanwhile ({sent})");
        assert!(t - now >= MEOW_TIMEOUT && t - now < MEOW_TIMEOUT + Duration::from_secs(2));
    }

    /// A tailcat client of the served VM, as `tailcat tc… 22` is: it meows, then talks
    /// WireGuard to the VM's key with the address's pre-shared key.
    struct TcClient {
        public: [u8; 32],
        wg: Endpoint,
        meowed: bool,
        got: Vec<Vec<u8>>,
        /// Disco packets from the VM.
        disco: Vec<Vec<u8>>,
    }

    impl TcClient {
        fn new(seed: u8, server: [u8; 32], psk: [u8; 32]) -> Self {
            let pair = NodeKeyPair::from(Export::<NodePrivateKey>::from_bytes([seed; 32]).import());
            let public = *pair.public.export().as_bytes();
            let mut wg = Endpoint::new(pair);
            wg.upsert_peer(PeerConfig::new(
                PeerId(1),
                NodePublicKey::from_bytes(server),
                psk,
            ));
            TcClient {
                public,
                wg,
                meowed: false,
                got: Vec::new(),
                disco: Vec::new(),
            }
        }

        fn addr(&self) -> [u8; 16] {
            tailcat::addr_for_key(&self.public)
        }

        /// What it answers to a packet from the VM.
        fn input(&mut self, p: Vec<u8>, now: Instant) -> Vec<Vec<u8>> {
            if tailcat::is_meowed(&p) {
                self.meowed = true;
                return Vec::new();
            }
            if p.starts_with(DISCO_MAGIC) {
                self.disco.push(p);
                return Vec::new();
            }
            let r = self.wg.recv(now, [PacketMut::from(p)]);
            for (_, ps) in r.to_local {
                self.got
                    .extend(ps.into_iter().map(|p| unpad(p.as_ref()).unwrap().to_vec()));
            }
            r.to_peers
                .into_values()
                .flatten()
                .map(|p| p.as_ref().to_vec())
                .collect()
        }

        fn send(&mut self, mut p: Vec<u8>, now: Instant) -> Vec<Vec<u8>> {
            pad(&mut p);
            let r = self.wg.send(now, [(PeerId(1), vec![PacketMut::from(p)])]);
            r.to_peers
                .into_values()
                .flatten()
                .map(|p| p.as_ref().to_vec())
                .collect()
        }
    }

    /// An IPv6 UDP packet from `src` to `dst` carrying `payload`.
    fn udp6(src: [u8; 16], dst: [u8; 16], payload: &[u8]) -> Vec<u8> {
        let len = 8 + payload.len() as u16;
        let mut p = vec![0x60, 0, 0, 0];
        p.extend_from_slice(&len.to_be_bytes());
        p.extend_from_slice(&[17, 64]);
        p.extend_from_slice(&src);
        p.extend_from_slice(&dst);
        p.extend_from_slice(&[0x30, 0x39, 0, 22]);
        p.extend_from_slice(&len.to_be_bytes());
        p.extend_from_slice(&[0, 0]);
        p.extend_from_slice(payload);
        p
    }

    /// Runs the served VM's actions through the relay to the tailcat clients and back until
    /// nothing is left; the guest's packets and the events come back.
    fn shuttle(
        c: &mut Client,
        relay: &mut Relay,
        clients: &mut [&mut TcClient],
        now: Instant,
    ) -> (Vec<Vec<u8>>, Vec<serde_json::Value>) {
        let (mut guest, mut events) = (Vec::new(), Vec::new());
        while let Some(a) = c.poll() {
            match a {
                Action::WsOpen { conn: n, url, .. } => {
                    assert_eq!(url, "wss://derp.test/derp");
                    c.ws_message(n, &relay.hello(), now);
                }
                Action::WsSend { conn: n, data } => {
                    let mut sent = Vec::new();
                    for reply in relay.input(&data, &mut sent) {
                        c.ws_message(n, &reply, now);
                    }
                    for (dst, p) in sent {
                        let Some(tc) = clients.iter_mut().find(|t| t.public == dst) else {
                            continue;
                        };
                        let src = tc.public;
                        for reply in tc.input(p, now) {
                            c.ws_message(n, &relay.deliver(&src, &reply), now);
                        }
                    }
                }
                Action::ToGuest(p) => guest.push(p),
                Action::Event(e) => events.push(serde_json::from_str(&e).unwrap()),
                _ => {}
            }
        }
        (guest, events)
    }

    fn serving() -> Config {
        Config {
            serve: Some(Serve {
                psk: [7; 32],
                nodes: vec![tailcat::DerpNode {
                    host_name: "derp.test".into(),
                    ..Default::default()
                }],
                region_id: 0,
                allow: Vec::new(),
            }),
            ..config(String::new())
        }
    }

    #[test]
    fn serves_tailcat_clients() {
        let now = Instant::now();
        let mut relay = Relay::new([43; 32]);
        let mut c = Client::new(serving(), now).unwrap();
        let (_, events) = shuttle(&mut c, &mut relay, &mut [], now);
        assert_eq!(
            c.state,
            State::Running,
            "serving only, up once on the relay"
        );
        // The address it serves at: its key, the pre-shared key, the relay.
        let addr = events.iter().find(|e| e["type"] == "serving").unwrap()["addr"]
            .as_str()
            .unwrap()
            .to_string();
        let ci = tailcat::parse_addr(&addr).unwrap();
        assert_eq!((ci.server, ci.psk), (c.public, Some([7; 32])));
        assert_eq!(ci.nodes[0].url(), "wss://derp.test/derp");
        let lease = &events.iter().find(|e| e["type"] == "lease").unwrap()["lease"];
        assert_eq!(lease["dns"], json!([]), "no resolvers without an exit node");

        // A client meows, is meowed, then its packet to the VM's address reaches the guest.
        let mut a = TcClient::new(50, c.public, [7; 32]);
        c.ws_message(
            1,
            &relay.deliver(&a.public, &tailcat::meow_ping(&a.public, &[1; 32])),
            now,
        );
        let (_, events) = shuttle(&mut c, &mut relay, &mut [&mut a], now);
        assert!(a.meowed);
        assert!(events.iter().any(|e| e["type"] == "client"));
        let hello = udp6(a.addr(), c.tc6, b"ssh?");
        let mut guest = Vec::new();
        for p in a.send(hello.clone(), now) {
            c.ws_message(1, &relay.deliver(&a.public, &p), now);
            guest.extend(shuttle(&mut c, &mut relay, &mut [&mut a], now).0);
        }
        // The handshake's first data, or the packet queued behind it once it completes.
        if guest.is_empty() {
            for p in a.send(hello.clone(), now) {
                c.ws_message(1, &relay.deliver(&a.public, &p), now);
                guest.extend(shuttle(&mut c, &mut relay, &mut [&mut a], now).0);
            }
        }
        assert_eq!(
            guest,
            vec![hello],
            "the client's packet, as is, to the guest"
        );

        // The guest's answer goes back to that client.
        c.guest_packet(&udp6(c.tc6, a.addr(), b"yes"), now);
        shuttle(&mut c, &mut relay, &mut [&mut a], now);
        assert_eq!(
            a.got.pop().as_deref(),
            Some(&udp6(c.tc6, a.addr(), b"yes")[..])
        );

        // Not from its own address: dropped. To an address nobody has: dropped (no exit node).
        for p in a.send(udp6([0xfd; 16], c.tc6, b"spoof"), now) {
            c.ws_message(1, &relay.deliver(&a.public, &p), now);
        }
        assert!(shuttle(&mut c, &mut relay, &mut [&mut a], now).0.is_empty());
        c.guest_packet(&udp6(c.tc6, [0xfd; 16], b"nowhere"), now);
        c.guest_packet(&udp(b"v4 without an exit node"), now);
        let before = a.got.len();
        shuttle(&mut c, &mut relay, &mut [&mut a], now);
        assert_eq!(a.got.len(), before);

        // A key that never meowed but has the address gets in by its handshake, as by a meow (one
        // that made room for another comes back this way: below). Without the pre-shared key: below.
        let mut b = TcClient::new(51, c.public, [7; 32]);
        let me = udp6(b.addr(), c.tc6, b"me too");
        assert_eq!(send_in(&mut c, &mut relay, &mut b, &me, now).0, vec![me]);
    }

    #[test]
    fn serves_while_connected_to_an_exit_node() {
        let now = Instant::now();
        let mut s = Server::new();
        let mut cfg = config(address(&s.public, &s.psk));
        cfg.serve = serving().serve;
        let mut c = Client::new(cfg, now).unwrap();
        s.run(&mut c, now);
        assert_eq!(c.state, State::Running);
        // The served address names the exit node's relay.
        let mut a = TcClient::new(52, c.public, [7; 32]);
        // The test server relays every packet to its own key: deliver the client's by hand.
        c.ws_message(
            s.conn,
            &s.relay
                .deliver(&a.public, &tailcat::meow_ping(&a.public, &[1; 32])),
            now,
        );
        let mut out = Vec::new();
        while let Some(act) = c.poll() {
            if let Action::WsSend { data, .. } = act {
                s.relay.input(&data, &mut out);
            }
        }
        assert!(
            out.iter()
                .any(|(dst, p)| *dst == a.public && tailcat::is_meowed(p))
        );
        // Guest IPv6 to the client goes to the client; to anywhere else, to the exit node.
        let mut guest = Vec::new();
        let hello = udp6(a.addr(), c.tc6, b"hi");
        for _ in 0..2 {
            for p in a.send(hello.clone(), now) {
                c.ws_message(s.conn, &s.relay.deliver(&a.public, &p), now);
            }
            let mut out = Vec::new();
            while let Some(act) = c.poll() {
                match act {
                    Action::WsSend { data, .. } => {
                        s.relay.input(&data, &mut out);
                    }
                    Action::ToGuest(p) => guest.push(p),
                    _ => {}
                }
            }
            for (dst, p) in out {
                if dst == a.public {
                    a.input(p, now);
                }
            }
            if !guest.is_empty() {
                break;
            }
        }
        assert_eq!(guest, vec![hello]);
        let to_world = udp6(
            c.tc6,
            [0x26, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
            b"out",
        );
        c.guest_packet(&to_world, now);
        s.run(&mut c, now);
        assert_eq!(
            s.got.pop().as_deref(),
            Some(&to_world[..]),
            "through the exit node"
        );
    }

    #[test]
    fn a_kept_key_keeps_the_served_address() {
        let now = Instant::now();
        let addr = |c: &mut Client| loop {
            match c.poll() {
                Some(Action::Event(e)) if e.contains("\"serving\"") => break e,
                Some(_) => {}
                None => panic!("no address"),
            }
        };
        let mut cfg = serving();
        cfg.key = Some([9; 32]);
        let one = addr(&mut Client::new(cfg, now).unwrap());
        let mut cfg = serving();
        cfg.key = Some([9; 32]);
        assert_eq!(addr(&mut Client::new(cfg, now).unwrap()), one);
        assert_ne!(addr(&mut Client::new(serving(), now).unwrap()), one);
    }

    /// Client `a` says hello to the served VM; the events that follow.
    fn meow_in(
        c: &mut Client,
        relay: &mut Relay,
        a: &mut TcClient,
        now: Instant,
    ) -> Vec<serde_json::Value> {
        c.ws_message(
            1,
            &relay.deliver(&a.public, &tailcat::meow_ping(&a.public, &[1; 32])),
            now,
        );
        shuttle(c, relay, &mut [a], now).1
    }

    /// Sends `p` from client `a` until it reaches the guest (the first send may only start the
    /// handshake); what reached the guest and the events.
    fn send_in(
        c: &mut Client,
        relay: &mut Relay,
        a: &mut TcClient,
        p: &[u8],
        now: Instant,
    ) -> (Vec<Vec<u8>>, Vec<serde_json::Value>) {
        let (mut guest, mut events) = (Vec::new(), Vec::new());
        for _ in 0..2 {
            for w in a.send(p.to_vec(), now) {
                c.ws_message(1, &relay.deliver(&a.public, &w), now);
                let (g, e) = shuttle(c, relay, &mut [&mut *a], now);
                guest.extend(g);
                events.extend(e);
            }
            if !guest.is_empty() {
                break;
            }
        }
        (guest, events)
    }

    fn node_public(seed: u8) -> [u8; 32] {
        let pair = NodeKeyPair::from(Export::<NodePrivateKey>::from_bytes([seed; 32]).import());
        *pair.public.export().as_bytes()
    }

    #[test]
    fn the_disco_key_is_the_same_by_either_crate() {
        let (secret, public) = disco_for(&[9; 32]);
        let k = Export::<ts_keys::DiscoPrivateKey>::from_bytes(secret).import();
        assert_eq!(*k.public_key().export().as_bytes(), public);
    }

    #[test]
    fn lets_in_only_the_allowed_keys() {
        let now = Instant::now();
        let mut relay = Relay::new([43; 32]);
        let mut cfg = serving();
        cfg.serve.as_mut().unwrap().allow = vec![node_public(50)];
        let mut c = Client::new(cfg, now).unwrap();
        shuttle(&mut c, &mut relay, &mut [], now);
        // Not on the list: no answer, not a peer, and its handshake isn't answered either.
        let mut b = TcClient::new(51, c.public, [7; 32]);
        let events = meow_in(&mut c, &mut relay, &mut b, now);
        assert!(!b.meowed && !events.iter().any(|e| e["type"] == "client"));
        let me = udp6(b.addr(), c.tc6, b"me?");
        assert!(send_in(&mut c, &mut relay, &mut b, &me, now).0.is_empty());
        assert!(c.peers.is_empty());
        // On it: in.
        let mut a = TcClient::new(50, c.public, [7; 32]);
        let events = meow_in(&mut c, &mut relay, &mut a, now);
        assert!(a.meowed && events.iter().any(|e| e["type"] == "client"));
        let hello = udp6(a.addr(), c.tc6, b"hi");
        assert_eq!(
            send_in(&mut c, &mut relay, &mut a, &hello, now).0,
            vec![hello]
        );
    }

    #[test]
    fn answers_a_clients_disco_ping() {
        use ts_disco_protocol::{Encrypted, Packet, Ping, Plaintext, Pong};
        use ts_keys::{DiscoPrivateKey, DiscoPublicKey};
        let now = Instant::now();
        let mut relay = Relay::new([43; 32]);
        let mut cfg = serving();
        cfg.serve.as_mut().unwrap().region_id = 900;
        let mut c = Client::new(cfg, now).unwrap();
        shuttle(&mut c, &mut relay, &mut [], now);
        let mine = Export::<DiscoPrivateKey>::from_bytes([3; 32]).import();
        let ping = |from: [u8; 32], to: [u8; 32]| {
            let mut b = Packet::<Plaintext>::vec_for_message(Ping::size_with_padding(0));
            Packet::<Plaintext>::init_from_bytes::<Ping>(&mut b, |m| {
                m.tx_id = [5; 12];
                m.node_key = NodePublicKey::from_bytes(from);
            })
            .unwrap()
            .encrypt_in_place(&mine, &DiscoPublicKey::from_bytes(to), [1; 24])
            .unwrap();
            b
        };
        let mut a = TcClient::new(50, c.public, [7; 32]);
        // Not a client yet (it never meowed): no pong.
        c.ws_message(1, &relay.deliver(&a.public, &ping(a.public, c.disco)), now);
        shuttle(&mut c, &mut relay, &mut [&mut a], now);
        assert!(a.disco.is_empty());
        meow_in(&mut c, &mut relay, &mut a, now);
        // A ping that names another key than the relay's sender: no pong.
        c.ws_message(1, &relay.deliver(&a.public, &ping([8; 32], c.disco)), now);
        shuttle(&mut c, &mut relay, &mut [&mut a], now);
        assert!(a.disco.is_empty());
        // Its own: a pong with the ping's transaction, from the relay's region.
        c.ws_message(1, &relay.deliver(&a.public, &ping(a.public, c.disco)), now);
        shuttle(&mut c, &mut relay, &mut [&mut a], now);
        let mut pong = a.disco.pop().expect("a pong");
        let enc = Packet::<Encrypted>::from_encrypted_bytes_mut(&mut pong).unwrap();
        assert_eq!(*enc.sender_pubkey().export().as_bytes(), c.disco);
        let plain = enc.decrypt_in_place(&mine).unwrap();
        let p = plain.as_msg::<Pong>().unwrap();
        assert_eq!(p.tx_id, [5; 12]);
        assert_eq!(
            p.src,
            ts_disco_protocol::Endpoint::from_socket_addr(std::net::SocketAddr::from((
                DERP_MAGIC, 900
            )))
        );
    }

    #[test]
    fn a_quiet_client_makes_room_and_comes_back_by_its_handshake() {
        let t0 = Instant::now();
        let mut relay = Relay::new([43; 32]);
        let mut c = Client::new(serving(), t0).unwrap();
        shuttle(&mut c, &mut relay, &mut [], t0);
        let tc6 = c.tc6;
        let hi = |a: &TcClient, w: &[u8]| udp6(a.addr(), tc6, w);
        let mut first = TcClient::new(1, c.public, [7; 32]);
        let p = hi(&first, b"first");
        assert_eq!(send_in(&mut c, &mut relay, &mut first, &p, t0).0, vec![p]);
        let t1 = t0 + Duration::from_secs(60);
        for seed in 2..=MAX_CLIENTS as u8 {
            let mut x = TcClient::new(seed, c.public, [7; 32]);
            let p = hi(&x, b"x");
            assert_eq!(send_in(&mut c, &mut relay, &mut x, &p, t1).0, vec![p]);
        }
        assert_eq!(c.peers.len(), MAX_CLIENTS);
        // One more while every client was heard from lately: refused once its data shows the key.
        let mut late = TcClient::new(200, c.public, [7; 32]);
        let p = hi(&late, b"late");
        assert!(send_in(&mut c, &mut relay, &mut late, &p, t1).0.is_empty());
        assert_eq!(c.peers.len(), MAX_CLIENTS);
        // The first has been quiet for CLIENT_IDLE: a key without the address's pre-shared key
        // doesn't push it out, by a meow or a handshake, nor do newcomers that never show it (they
        // fill the newcomers' places at most: here they leave one).
        let t2 = t0 + CLIENT_IDLE;
        let mut stranger = TcClient::new(201, c.public, [8; 32]);
        meow_in(&mut c, &mut relay, &mut stranger, t2);
        assert!(stranger.meowed);
        let x = hi(&stranger, b"x");
        let (guest, _) = send_in(&mut c, &mut relay, &mut stranger, &x, t2);
        assert!(guest.is_empty());
        for seed in 202..202 + MAX_NEWCOMERS as u8 - 2 {
            let mut x = TcClient::new(seed, c.public, [8; 32]);
            meow_in(&mut c, &mut relay, &mut x, t2);
        }
        assert!(c.by_addr.contains_key(&first.addr()));
        assert_eq!(c.peers.values().filter(|p| p.proven).count(), MAX_CLIENTS);
        // One with the key takes the first's place; the page keeps the first's route (no
        // `client-gone`).
        let p = hi(&late, b"late");
        let (guest, events) = send_in(&mut c, &mut relay, &mut late, &p, t2);
        assert_eq!(guest, vec![p]);
        assert!(!c.by_addr.contains_key(&first.addr()));
        assert!(
            !events
                .iter()
                .any(|e| e["type"] == "client-gone" && e["address6"] == json!(first.addr()))
        );
        // The guest's packet to the first lets it in again: the handshake starts here.
        let t3 = t1 + CLIENT_IDLE;
        c.guest_packet(&udp6(c.tc6, first.addr(), b"there?"), t3);
        shuttle(&mut c, &mut relay, &mut [&mut first], t3);
        assert_eq!(
            first.got.pop().as_deref(),
            Some(&udp6(c.tc6, first.addr(), b"there?")[..])
        );
        let p = hi(&first, b"back");
        assert_eq!(send_in(&mut c, &mut relay, &mut first, &p, t3).0, vec![p]);
        // A key without the pre-shared key on trial is forgotten when its handshake's time is up,
        // quietly; one that meowed is announced, so the page hears it go when a newcomer needs
        // its place.
        let mut trial = TcClient::new(230, c.public, [8; 32]);
        let x = hi(&trial, b"x");
        let t4 = t3 + HANDSHAKE_TIMEOUT;
        assert!(send_in(&mut c, &mut relay, &mut trial, &x, t4).0.is_empty());
        assert!(c.by_addr.contains_key(&trial.addr()));
        let t5 = t4 + HANDSHAKE_TIMEOUT;
        c.tick(t5);
        assert!(!c.by_addr.contains_key(&trial.addr()));
        // The newcomers' places full again, one more takes the stalest's.
        let mut fill = TcClient::new(232, c.public, [8; 32]);
        meow_in(&mut c, &mut relay, &mut fill, t5);
        assert_eq!(
            c.peers.values().filter(|p| !p.proven).count(),
            MAX_NEWCOMERS
        );
        let mut next = TcClient::new(231, c.public, [7; 32]);
        let events = meow_in(&mut c, &mut relay, &mut next, t5);
        assert!(next.meowed);
        let gone: Vec<_> = events
            .iter()
            .filter(|e| e["type"] == "client-gone")
            .collect();
        assert_eq!(gone.len(), 1);
        assert_ne!(gone[0]["address6"], json!(trial.addr()));
        assert!(c.peers.values().filter(|p| !p.proven).count() <= MAX_NEWCOMERS);
    }

    #[test]
    fn forgets_the_clients_that_made_room_first_past_max_away() {
        let t0 = Instant::now();
        let mut relay = Relay::new([43; 32]);
        let mut c = Client::new(serving(), t0).unwrap();
        shuttle(&mut c, &mut relay, &mut [], t0);
        let mut events = Vec::new();
        // Each round of clients makes room for the next, CLIENT_IDLE apart.
        for round in 0..2u8 {
            let at = t0 + CLIENT_IDLE * round as u32;
            for k in 0..MAX_CLIENTS as u8 {
                let mut x = TcClient::new(1 + round * MAX_CLIENTS as u8 + k, c.public, [7; 32]);
                let p = udp6(x.addr(), c.tc6, b"x");
                let (guest, e) = send_in(&mut c, &mut relay, &mut x, &p, at);
                assert_eq!(guest, vec![p]);
                events.extend(e);
            }
        }
        assert_eq!(c.away.len(), MAX_AWAY);
        assert!(!events.iter().any(|e| e["type"] == "client-gone"));
        let mut x = TcClient::new(250, c.public, [7; 32]);
        let p = udp6(x.addr(), c.tc6, b"x");
        let (_, e) = send_in(&mut c, &mut relay, &mut x, &p, t0 + CLIENT_IDLE * 3);
        let gone: Vec<_> = e.iter().filter(|e| e["type"] == "client-gone").collect();
        assert_eq!(gone.len(), 1);
        assert_eq!(c.away.len(), MAX_AWAY);
    }
}
