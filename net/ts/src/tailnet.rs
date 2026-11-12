//! The Tailscale client (docs/networking/tailnet.md "Tailscale"), sans I/O like the tailcat one
//! (client.rs), whose actions it shares: the control session (control.rs) and, on the netmap
//! it keeps, the data plane. A browser is DERP-only: every peer is a WireGuard peer
//! (`ts_tunnel`) reached through its home DERP region; ours is the region that answers
//! `/derp/probe` fastest. What comes in from the tailnet passes the packet filter
//! (`ts_packetfilter`), with the return traffic of the guest's own flows let through; the
//! guest's internet traffic goes to the exit node when one is selected. MagicDNS answers at
//! 100.100.100.100 and fd7a:115c:a1e0::53 from the netmap, forwarding other names to the
//! netmap's resolvers through the tunnel (or, where the tunnel doesn't reach them, to a
//! DNS-over-HTTPS service by `fetch`). Disco pings that come over DERP get pongs.

use std::{
    collections::{BTreeMap, VecDeque},
    net::{IpAddr, Ipv4Addr},
    time::{Duration, Instant},
};

use base64::Engine;
use ipnet::IpNet;
use serde_json::json;
use ts_keys::{
    DiscoPrivateKey, DiscoPublicKey, Export, ExportableKey, NodeKeyPair, NodePrivateKey,
    NodePublicKey,
};
use ts_packet::PacketMut;
use ts_packetfilter::{FilterExt, IpProto, PacketInfo};
use ts_tunnel::{Endpoint, PeerConfig, PeerId};

use crate::{
    client::{Action, pad, queue_frames, unpad},
    control::{self, Phase, Session, Update},
    derp, dns, dns_tcp, ip,
    netmap::Node,
    store::Store,
};

pub const MTU: usize = 1280;
/// `fetch` IDs: DERP probes (plus the region), DNS-over-HTTPS queries (plus a counter).
const PROBE: u32 = 1 << 29;
const DOH: u32 = 1 << 28;
/// How long probes may take before the home region is picked from those that answered.
const PROBE_WAIT: Duration = Duration::from_secs(3);
/// A region we only send to closes after this long unused.
const IDLE: Duration = Duration::from_secs(60);
/// How long a UDP or ICMP flow the guest started lets replies in.
const FLOW: Duration = Duration::from_secs(120);
const MAX_FLOWS: usize = 8192;
/// Ports of MagicDNS's own queries through the tunnel: above Linux's ephemeral range, so the
/// guest's own sockets don't use them.
const DNS_PORTS: std::ops::Range<u16> = 61000..62000;
const DNS_TIMEOUT: Duration = Duration::from_secs(10);
/// A route's resolvers MagicDNS asks at once, at most.
const MAX_RESOLVERS: usize = 4;
/// The node attribute that makes MagicDNS answer AAAA for peers (tailcfg.NodeAttrMagicDNSPeerAAAA).
const CAP_AAAA: &str = "https://tailscale.com/cap/magicdns-aaaa";
/// When an unanswered WireGuard handshake initiation goes again (milliseconds after it first
/// went), before ts_tunnel's own retry at 5 s: a peer that doesn't know our node yet (a new or
/// ephemeral node, before its map has us) drops the first, and its map catches up within about a
/// second (0.6–0.7 s on the Podman tailnet, 2026-10-24). The same bytes again: a responder that did
/// see the first drops a replay, so it costs nothing.
const RESEND_MS: [u64; 7] = [250, 500, 750, 1000, 1500, 2000, 3000];
/// A WireGuard handshake initiation's type and size.
const INITIATION: (u8, usize) = (1, 148);
/// Packets a relay connection keeps until it's up, at most.
const MAX_QUEUED: usize = 256;
/// A relay connection up this long worked: its loss reconnects at once.
const STABLE: Duration = Duration::from_secs(10);
/// Why a relay that was up went: its liveness check (derp.rs).
const LIVENESS: &str = "the relay stopped answering";
/// Disco's address for "over DERP" (magicsock's derpMagicIPAddr); the port is the region.
const DERP_MAGIC: Ipv4Addr = Ipv4Addr::new(127, 3, 3, 40);

pub struct Config {
    pub control: control::Config,
    /// The kept node: the store's entries (`<StateKey>` → bytes).
    pub state: BTreeMap<String, Vec<u8>>,
    /// A peer's stable ID to use as the exit node ('' for none).
    pub exit_node: String,
    /// Install peers' subnet routes (Tailscale's `RouteAll`).
    pub accept_routes: bool,
}

struct Peer {
    stable_id: String,
    key: [u8; 32],
    disco: Option<[u8; 32]>,
    home: Option<u32>,
    /// Its own addresses.
    addrs: Vec<IpNet>,
    /// The subnets it routes (approved: in its AllowedIPs; not its addresses or a default).
    subnets: Vec<IpNet>,
    /// What it may send from (and is sent to): its addresses, its subnets when routes are
    /// accepted, and the default routes when it's the exit node in use.
    allowed: Vec<IpNet>,
    exit_option: bool,
    caps: Vec<String>,
}

/// Packets for a relay: (destination node key, packet).
type Queued = Vec<([u8; 32], Vec<u8>)>;

/// A connection to one DERP region.
struct Relay {
    conn: u32,
    d: derp::Conn,
    /// Packets waiting for the handshake.
    queue: Queued,
    used: Instant,
    ready_at: Option<Instant>,
}

/// Who asked MagicDNS: a guest's UDP port (with the largest answer it takes), or a TCP
/// connection (dns_tcp.rs).
#[derive(Clone, Copy)]
enum Asker {
    Udp((IpAddr, u16), usize),
    Tcp(dns_tcp::Key),
}

/// A MagicDNS query being answered elsewhere: who asked at which MagicDNS address, how many
/// resolvers have yet to answer, and the last failure (what goes back if none does better).
struct Pending {
    asker: Asker,
    at: IpAddr,
    query: Vec<u8>,
    left: u32,
    failed: Option<Vec<u8>>,
    /// Over TCP: where to ask again if a resolver's answer over UDP was truncated (a well-known
    /// public resolver's DNS-over-HTTPS service, whose answers aren't).
    whole: Option<&'static str>,
    until: Instant,
}

pub struct Client {
    session: Session,
    exit_node: String,
    accept_routes: bool,
    /// Where packets go (from the peers' `allowed`): host addresses by address, the rest
    /// longest prefix first.
    hosts: BTreeMap<IpAddr, PeerId>,
    nets: Vec<(IpNet, PeerId)>,
    /// The node key the server last said expired (one re-registration for it).
    expired: Option<[u8; 32]>,
    disco: [u8; 32],
    /// WireGuard, for the node key it was made with.
    wg: Option<(Endpoint, [u8; 32])>,
    peers: BTreeMap<PeerId, Peer>,
    by_node: BTreeMap<i64, PeerId>,
    /// Handshake initiations waiting for an answer: the packet, when it first went, and how many
    /// times it went again (`RESEND_MS`).
    initiations: BTreeMap<PeerId, (Vec<u8>, Instant, usize)>,
    next_peer: u32,
    relays: BTreeMap<u32, Relay>,
    next_conn: u32,
    /// Our home region, once picked; the probes until then.
    home: Option<u32>,
    probes: BTreeMap<u32, (Instant, Option<Duration>)>,
    probe_until: Option<Instant>,
    /// Region → when to try connecting again.
    retry: BTreeMap<u32, Instant>,
    failures: BTreeMap<u32, u32>,
    /// What a lost connection had waiting, for the next one to the region.
    held: BTreeMap<u32, Queued>,
    /// The guest's UDP and ICMP flows: (proto, guest address and port, remote address and port).
    flows: BTreeMap<(u8, IpAddr, u16, IpAddr, u16), Instant>,
    /// MagicDNS's queries elsewhere, and which of them each of its ports and fetches answers.
    queries: BTreeMap<u32, Pending>,
    dns_udp: BTreeMap<u16, u32>,
    dns_doh: BTreeMap<u32, u32>,
    next_query: u32,
    next_dns: u32,
    dns_tcp: dns_tcp::Server,
    /// The state the page last heard (Go's `ipn.State` names).
    state: &'static str,
    sweep_at: Instant,
    actions: VecDeque<Action>,
}

impl Client {
    pub fn new(cfg: Config, now: Instant) -> Result<Self, String> {
        if cfg.control.url.trim().is_empty() {
            return Err("no control server".into());
        }
        let mut disco = [0u8; 32];
        getrandom::fill(&mut disco).map_err(|e| format!("no randomness: {e}"))?;
        let disco_public = *Export::<DiscoPrivateKey>::from_bytes(disco)
            .import()
            .public_key()
            .export()
            .as_bytes();
        let mut c = Client {
            session: Session::new(cfg.control, Store::new(cfg.state), disco_public),
            exit_node: cfg.exit_node,
            accept_routes: cfg.accept_routes,
            hosts: BTreeMap::new(),
            nets: Vec::new(),
            expired: None,
            disco,
            wg: None,
            peers: BTreeMap::new(),
            by_node: BTreeMap::new(),
            initiations: BTreeMap::new(),
            next_peer: 1,
            relays: BTreeMap::new(),
            next_conn: 1,
            home: None,
            probes: BTreeMap::new(),
            probe_until: None,
            retry: BTreeMap::new(),
            failures: BTreeMap::new(),
            held: BTreeMap::new(),
            flows: BTreeMap::new(),
            queries: BTreeMap::new(),
            dns_udp: BTreeMap::new(),
            dns_doh: BTreeMap::new(),
            next_query: 0,
            next_dns: 0,
            dns_tcp: dns_tcp::Server::default(),
            state: "",
            sweep_at: now + FLOW,
            actions: VecDeque::new(),
        };
        c.set_state("Starting");
        c.session.start(now);
        c.after(now);
        Ok(c)
    }

    fn event(&mut self, v: serde_json::Value) {
        self.actions.push_back(Action::Event(v.to_string()));
    }

    fn log(&mut self, msg: String) {
        self.event(json!({ "type": "log", "msg": msg }));
    }

    fn set_state(&mut self, s: &'static str) {
        if self.state != s {
            self.state = s;
            self.event(json!({ "type": "state", "state": s }));
        }
    }

    fn running(&self) -> bool {
        self.state == "Running"
    }

    /// Takes in what the session did.
    fn after(&mut self, now: Instant) {
        self.actions.extend(self.session.actions.drain(..));
        for u in std::mem::take(&mut self.session.updates) {
            match u {
                Update::Phase(Phase::NeedsLogin) => self.set_state("NeedsLogin"),
                Update::Phase(Phase::LoggedOut) => {
                    self.stop_data_plane();
                    self.set_state("NeedsLogin");
                    self.event(json!({ "type": "loggedout" }));
                }
                Update::Phase(_) => {}
                Update::Failed { code, detail } => {
                    self.stop_data_plane();
                    self.event(json!({ "type": "state", "state": "Failed", "code": code, "detail": detail }));
                    self.state = "Failed";
                }
                Update::Map(c) if c.tailnet_lock => {
                    self.session.close();
                    self.actions.extend(self.session.actions.drain(..));
                    self.stop_data_plane();
                    // The page words it (`web/ts-client.ts` `failureOf`): this client doesn't support
                    // Tailnet Lock (its node would need signing, and its peers' keys checking).
                    self.event(
                        json!({ "type": "state", "state": "Failed", "code": "tailnet-lock" }),
                    );
                    self.state = "Failed";
                }
                Update::Map(c) => {
                    if c.node && self.self_expired() {
                        // Our key expired while mapping: register again (a new key, or a login).
                        self.session.reauth(now);
                        self.actions.extend(self.session.actions.drain(..));
                        continue;
                    }
                    if c.derp || (c.peers && self.home.is_none()) {
                        self.derp_map_changed(now);
                    }
                    if c.node || c.peers {
                        self.sync_peers(now);
                    }
                    if c.node || c.peers || c.dns {
                        self.publish_netmap();
                    }
                }
            }
        }
    }

    /// The server says our node key expired (once per key).
    fn self_expired(&mut self) -> bool {
        let key = self.session.node_public();
        let expired = self
            .session
            .netmap
            .node
            .as_ref()
            .is_some_and(|n| n.expired && n.key == key);
        if !expired || self.expired == Some(key) {
            return false;
        }
        self.expired = Some(key);
        self.log("the node key expired".into());
        true
    }

    fn publish_netmap(&mut self) {
        let mut nm = self.session.netmap.page_json(MTU, &self.exit_node);
        if nm.is_null() {
            return;
        }
        // The subnets each peer routes, and whether they're installed.
        nm["acceptRoutes"] = json!(self.accept_routes);
        if let Some(peers) = nm["peers"].as_array_mut() {
            for v in peers {
                if let Some(p) = self.peers.values().find(|p| v["id"] == json!(p.stable_id)) {
                    v["routes"] =
                        json!(p.subnets.iter().map(|n| n.to_string()).collect::<Vec<_>>());
                }
            }
        }
        self.event(json!({ "type": "netmap", "netmap": nm }));
        self.set_state("Running");
    }

    fn stop_data_plane(&mut self) {
        for (_, r) in std::mem::take(&mut self.relays) {
            self.actions.push_back(Action::WsClose { conn: r.conn });
        }
        self.wg = None;
        self.peers.clear();
        self.by_node.clear();
        self.home = None;
        self.held.clear();
        self.initiations.clear();
    }

    // --- DERP -----------------------------------------------------------------------------

    /// The DERP map arrived or changed: pick a home region (by probing) if there's none.
    fn derp_map_changed(&mut self, now: Instant) {
        if let Some(h) = self.home
            && self.session.netmap.regions.contains_key(&h)
        {
            return;
        }
        self.home = None;
        let regions: Vec<(u32, Option<String>)> = self
            .session
            .netmap
            .regions
            .values()
            .map(|r| (r.id, r.nodes.iter().find_map(|n| n.browser_url())))
            .collect();
        if regions.is_empty() {
            return;
        }
        if regions.len() == 1 {
            return self.set_home(regions[0].0, now);
        }
        self.probes.clear();
        for (id, url) in regions {
            let Some(url) = url else { continue };
            let probe = url
                .replacen("wss://", "https://", 1)
                .replacen("ws://", "http://", 1)
                + "/probe";
            self.probes.insert(id, (now, None));
            self.actions.push_back(Action::Fetch {
                id: PROBE + id,
                url: probe,
            });
        }
        self.probe_until = Some(now + PROBE_WAIT);
        if self.probes.is_empty() {
            self.pick_home(now);
        }
    }

    /// The region that answered its probe fastest; the lowest ID if none did.
    fn pick_home(&mut self, now: Instant) {
        self.probe_until = None;
        let best = self
            .probes
            .iter()
            .filter_map(|(id, (_, rtt))| rtt.map(|r| (r, *id)))
            .min()
            .map(|(_, id)| id)
            .or_else(|| self.session.netmap.regions.keys().next().copied());
        self.probes.clear();
        if let Some(id) = best {
            self.set_home(id, now);
        }
    }

    fn set_home(&mut self, region: u32, now: Instant) {
        self.home = Some(region);
        self.log(format!("DERP: home region {region}"));
        self.session.set_home(region, now);
        self.actions.extend(self.session.actions.drain(..));
        self.relay(region, now);
    }

    /// The connection to `region`, opened if there's none (None if it can't be).
    fn relay(&mut self, region: u32, now: Instant) -> Option<&mut Relay> {
        if !self.relays.contains_key(&region) {
            if self.retry.get(&region).is_some_and(|t| *t > now) {
                return None;
            }
            let (private, public) = self.wg.as_ref().map(|(_, k)| (*k, control_public(k)))?;
            let nodes: Vec<String> = self
                .session
                .netmap
                .regions
                .get(&region)?
                .nodes
                .iter()
                .filter_map(|n| n.browser_url())
                .collect();
            if nodes.is_empty() {
                return None;
            }
            let n = *self.failures.get(&region).unwrap_or(&0) as usize;
            let url = nodes[n % nodes.len()].clone();
            let conn = self.next_conn;
            self.next_conn += 1;
            self.actions.push_back(Action::WsOpen {
                conn,
                url,
                protocol: "derp",
            });
            self.relays.insert(
                region,
                Relay {
                    conn,
                    d: derp::Conn::new(private, public, Some(region) == self.home, now),
                    queue: self.held.remove(&region).unwrap_or_default(),
                    used: now,
                    ready_at: None,
                },
            );
        }
        self.relays.get_mut(&region)
    }

    fn region_of_conn(&self, conn: u32) -> Option<u32> {
        self.relays
            .iter()
            .find(|(_, r)| r.conn == conn)
            .map(|(id, _)| *id)
    }

    fn flush_relay(&mut self, region: u32) {
        if let Some(r) = self.relays.get_mut(&region) {
            queue_frames(&mut self.actions, r.conn, r.d.take_output());
        }
    }

    /// Lost a region's connection: try again at once after one that was up (a server restart, a
    /// network change), after a growing backoff when it keeps failing (one up for under `STABLE`
    /// counts as failing). What it had waiting goes to the next connection.
    fn relay_lost(&mut self, region: u32, now: Instant, why: &str) {
        let (mut was_up, mut worked) = (false, false);
        if let Some(r) = self.relays.remove(&region) {
            self.actions.push_back(Action::WsClose { conn: r.conn });
            was_up = r.ready_at.is_some();
            worked = r
                .ready_at
                .is_some_and(|t| now.saturating_duration_since(t) >= STABLE);
            if !r.queue.is_empty() {
                self.held.insert(region, r.queue);
            }
        }
        let f = self.failures.entry(region).or_insert(0);
        if worked {
            *f = 0;
        }
        *f += 1;
        let backoff = match *f {
            1 if was_up => Duration::ZERO,
            f => Duration::from_millis(250u64 << f.min(7)).min(Duration::from_secs(30)),
        };
        self.retry.insert(region, now + backoff);
        self.log(format!("DERP region {region}: {why}"));
        if Some(region) == self.home && why == LIVENESS {
            // The path died without a word: the control connection likely did too.
            self.session.suspect(now);
        }
    }

    /// Sends `packet` to the node with key `dst` through `region`.
    fn send_via(&mut self, region: u32, dst: [u8; 32], packet: Vec<u8>, now: Instant) {
        let Some(r) = self.relay(region, now) else {
            // Between connections (a backoff): for the next one.
            if self.retry.get(&region).is_some_and(|t| *t > now) {
                let held = self.held.entry(region).or_default();
                if held.len() < MAX_QUEUED {
                    held.push((dst, packet));
                }
            }
            return;
        };
        r.used = now;
        if r.d.is_ready() {
            r.d.send(&dst, &packet, now);
        } else if r.queue.len() < MAX_QUEUED {
            r.queue.push((dst, packet));
        }
        self.flush_relay(region);
    }

    // --- WireGuard and peers ---------------------------------------------------------------

    /// Makes the WireGuard endpoint for the node's key (again if the key changed), and the
    /// peers from the netmap.
    fn sync_peers(&mut self, now: Instant) {
        let key = self.session.node_private();
        if self.wg.as_ref().is_none_or(|(_, k)| *k != key) {
            // A new node key: everything keyed by the old one goes.
            let pair = NodeKeyPair::from(Export::<NodePrivateKey>::from_bytes(key).import());
            self.wg = Some((Endpoint::new(pair), key));
            self.peers.clear();
            self.by_node.clear();
            self.held.clear();
            self.initiations.clear();
            for (_, r) in std::mem::take(&mut self.relays) {
                self.actions.push_back(Action::WsClose { conn: r.conn });
            }
            if let Some(h) = self.home {
                self.relay(h, now);
            }
        }
        let nodes: Vec<Node> = self.session.netmap.peers.values().cloned().collect();
        for (node, id) in self.by_node.clone() {
            if !self.session.netmap.peers.contains_key(&node) {
                self.by_node.remove(&node);
                self.peers.remove(&id);
                self.initiations.remove(&id);
                if let Some((wg, _)) = self.wg.as_mut() {
                    wg.remove_peer(id);
                }
            }
        }
        for n in nodes {
            let id = match self.by_node.get(&n.id) {
                Some(id) => *id,
                None => {
                    let id = PeerId(self.next_peer);
                    self.next_peer += 1;
                    self.by_node.insert(n.id, id);
                    id
                }
            };
            // A new key (a re-registered peer) or a new disco key (a restarted one): what
            // WireGuard has for it is stale (handshake MACs keyed to the old key, or a session the
            // peer forgot, which would swallow our packets until it expired), so it starts over.
            let old = self.peers.get(&id);
            let restarted = |p: &Peer| p.disco.is_some() && n.disco.is_some() && p.disco != n.disco;
            let fresh = old.is_none_or(|p| p.key != n.key || restarted(p));
            let known = old.is_some();
            let peer = Peer {
                stable_id: n.stable_id.clone(),
                key: n.key,
                disco: n.disco,
                home: n.home_derp,
                addrs: n.addresses.clone(),
                subnets: n
                    .allowed_ips
                    .iter()
                    .filter(|a| a.prefix_len() > 0 && !n.addresses.contains(a))
                    .copied()
                    .collect(),
                allowed: Vec::new(),
                exit_option: n.exit_node_option(),
                caps: n.caps.clone(),
            };
            self.peers.insert(id, peer);
            if fresh && let Some((wg, _)) = self.wg.as_mut() {
                if known {
                    wg.remove_peer(id);
                }
                self.initiations.remove(&id);
                // A key another peer still has (a node re-registered under a new ID before the
                // old one's removal arrives): the old one's goes, WireGuard keys peers by it.
                if let Some(other) = wg.peer_id(NodePublicKey::from_bytes(n.key))
                    && other != id
                {
                    wg.remove_peer(other);
                }
                wg.upsert_peer(PeerConfig::new(
                    id,
                    NodePublicKey::from_bytes(n.key),
                    [0; 32],
                ));
            }
        }
        self.route();
    }

    /// Each peer's allowed IPs: its own addresses, its subnets when routes are accepted, and the
    /// default routes for the exit node; and the table `peer_for` looks in.
    fn route(&mut self) {
        let exit = self.exit_node.clone();
        self.hosts.clear();
        self.nets.clear();
        for (id, p) in self.peers.iter_mut() {
            p.allowed = p.addrs.clone();
            if self.accept_routes {
                p.allowed.extend(p.subnets.iter().copied());
            }
            if !exit.is_empty() && p.stable_id == exit && p.exit_option {
                p.allowed
                    .extend(["0.0.0.0/0", "::/0"].map(|n| n.parse::<IpNet>().unwrap()));
            }
            for n in &p.allowed {
                if n.prefix_len() == n.max_prefix_len() {
                    self.hosts.entry(n.addr()).or_insert(*id);
                } else {
                    self.nets.push((*n, *id));
                }
            }
        }
        // Longest prefix first; among equals, the first peer's.
        self.nets
            .sort_by_key(|(n, _)| std::cmp::Reverse(n.prefix_len()));
    }

    /// The peer a packet to `dst` goes to: the longest prefix of the peers' allowed IPs (its own
    /// address, a subnet it routes, or the exit node's default).
    fn peer_for(&self, dst: IpAddr) -> Option<PeerId> {
        if let Some(id) = self.hosts.get(&dst) {
            return Some(*id);
        }
        self.nets
            .iter()
            .find(|(n, _)| n.contains(&dst))
            .map(|(_, id)| *id)
    }

    /// Sends WireGuard's packets to their peers, each through its home region (ours if it has
    /// none yet).
    fn send_to_peers(
        &mut self,
        to_peers: impl IntoIterator<Item = (PeerId, Vec<PacketMut>)>,
        now: Instant,
    ) {
        for (id, packets) in to_peers {
            let Some(p) = self.peers.get(&id) else {
                continue;
            };
            let (key, region) = (p.key, p.home.or(self.home));
            let Some(region) = region else { continue };
            for pkt in packets {
                let pkt = pkt.as_ref().to_vec();
                if (pkt.first().copied(), pkt.len()) == (Some(INITIATION.0), INITIATION.1) {
                    self.initiations.insert(id, (pkt.clone(), now, 0));
                }
                self.send_via(region, key, pkt, now);
            }
        }
    }

    /// Sends an IP packet into the tunnel.
    fn send_tunnel(&mut self, mut p: Vec<u8>, dst: IpAddr, now: Instant) -> bool {
        let Some(id) = self.peer_for(dst) else {
            return false;
        };
        let Some((wg, _)) = self.wg.as_mut() else {
            return false;
        };
        pad(&mut p);
        let r = wg.send(now, [(id, vec![PacketMut::from(p)])]);
        self.send_to_peers(r.to_peers, now);
        true
    }

    fn self_addrs(&self) -> Vec<IpAddr> {
        self.session
            .netmap
            .node
            .as_ref()
            .map(|n| n.addresses.iter().map(|a| a.addr()).collect())
            .unwrap_or_default()
    }

    fn self_addr(&self, v4: bool) -> Option<IpAddr> {
        self.self_addrs().into_iter().find(|a| a.is_ipv4() == v4)
    }

    /// A packet from the guest.
    pub fn guest_packet(&mut self, p: &[u8], now: Instant) {
        if !self.running() || p.len() > MTU {
            return;
        }
        let Some(i) = ip::parse(p) else { return };
        if !self.self_addrs().contains(&i.src) {
            return; // only from the node's own addresses
        }
        if (i.dst == ip::MAGIC_DNS4 || i.dst == ip::MAGIC_DNS6) && i.dport == 53 {
            if i.proto == ip::UDP
                && let Some(q) = ip::udp_payload(p, &i)
            {
                let q = q.to_vec();
                let size = dns::parse(&q).map_or(512, |q| q.udp_size);
                // Within the link's MTU too: no fragments.
                let max = size.min(MTU - if i.src.is_ipv4() { 28 } else { 48 });
                self.magic_dns(&q, Asker::Udp((i.src, i.sport), max), i.dst, now);
            } else if i.proto == ip::TCP {
                for out in self.dns_tcp.input(p, &i, now) {
                    match out {
                        dns_tcp::Out::Packet(p) => self.actions.push_back(Action::ToGuest(p)),
                        dns_tcp::Out::Query(key, q) => {
                            self.magic_dns(&q, Asker::Tcp(key), i.dst, now)
                        }
                    }
                }
            }
            return;
        }
        if i.proto == ip::UDP || matches!(i.icmp_type, Some(8 | 128)) {
            // A flow the table has is kept alive even when the table is full.
            let flow = (i.proto, i.src, i.sport, i.dst, i.dport);
            if let Some(t) = self.flows.get_mut(&flow) {
                *t = now + FLOW;
            } else if self.flows.len() < MAX_FLOWS {
                self.flows.insert(flow, now + FLOW);
            }
        }
        self.send_tunnel(p.to_vec(), i.dst, now);
    }

    /// A decrypted packet from peer `from`: to the guest if the filter lets it in.
    fn tunnel_packet(&mut self, from: PeerId, plaintext: &[u8], now: Instant) {
        let Some(p) = unpad(plaintext) else { return };
        let Some(i) = ip::parse(p) else { return };
        let Some(peer) = self.peers.get(&from) else {
            return;
        };
        if !peer.allowed.iter().any(|n| n.contains(&i.src)) || !self.self_addrs().contains(&i.dst) {
            return;
        }
        // Answers to MagicDNS's own queries.
        if i.proto == ip::UDP && DNS_PORTS.contains(&i.dport) && i.sport == 53 {
            if let Some(q) = self.dns_udp.remove(&i.dport)
                && let Some(answer) = ip::udp_payload(p, &i)
            {
                let a = answer.to_vec();
                self.dns_answer(q, Some(&a));
            }
            return;
        }
        let allowed = match i.proto {
            // Not a new connection: the guest's stack judges it (as Go's filter does).
            ip::TCP if !i.syn => true,
            ip::UDP => {
                self.flows
                    .get(&(i.proto, i.dst, i.dport, i.src, i.sport))
                    .is_some_and(|t| *t > now)
                    || self.filter_allows(&i, from)
            }
            ip::ICMP | ip::ICMP6 => match i.icmp_type {
                // Echo replies to the guest's pings.
                Some(0 | 129) => self
                    .flows
                    .contains_key(&(i.proto, i.dst, i.dport, i.src, i.sport)),
                // Errors (unreachable, too big, time exceeded) about the guest's traffic.
                Some(3 | 11 | 1 | 2) => true,
                _ => self.filter_allows(&i, from),
            },
            _ => self.filter_allows(&i, from),
        };
        if allowed {
            self.actions.push_back(Action::ToGuest(p.to_vec()));
        }
    }

    fn filter_allows(&self, i: &ip::Info, from: PeerId) -> bool {
        let Some(f) = self.session.netmap.filter.as_ref() else {
            return false;
        };
        let caps = self
            .peers
            .get(&from)
            .map(|p| p.caps.as_slice())
            .unwrap_or_default();
        let info = PacketInfo {
            src: i.src,
            dst: i.dst,
            ip_proto: IpProto::from(i.proto as i64),
            port: i.dport,
        };
        f.can_access(&info, caps.iter().map(String::as_str))
    }

    /// A packet from a relay: WireGuard, or disco.
    fn on_relay_packet(&mut self, region: u32, src: [u8; 32], packet: Vec<u8>, now: Instant) {
        if ts_disco_protocol::is_disco_message(&packet) {
            return self.disco(region, src, packet, now);
        }
        if packet.first() != Some(&INITIATION.0) {
            // An answer, or data: the peer has us; our initiation (if any) got through.
            if let Some(id) = self
                .peers
                .iter()
                .find(|(_, p)| p.key == src)
                .map(|(id, _)| *id)
            {
                self.initiations.remove(&id);
            }
        }
        let Some((wg, _)) = self.wg.as_mut() else {
            return;
        };
        let r = wg.recv(now, [PacketMut::from(packet)]);
        self.send_to_peers(r.to_peers, now);
        for (id, packets) in r.to_local {
            for p in packets {
                self.tunnel_packet(id, p.as_ref(), now);
            }
        }
    }

    /// Answers a disco ping from a peer with a pong, so it sees the path through DERP work.
    fn disco(&mut self, region: u32, src: [u8; 32], mut packet: Vec<u8>, now: Instant) {
        use ts_disco_protocol::{Encrypted, Packet, Ping, Pong};
        let private = Export::<DiscoPrivateKey>::from_bytes(self.disco).import();
        let Ok(enc) = Packet::<Encrypted>::from_encrypted_bytes_mut(&mut packet) else {
            return;
        };
        let sender = *enc.sender_pubkey().export().as_bytes();
        // Only from a peer, with the disco key the netmap gives it.
        if !self
            .peers
            .values()
            .any(|p| p.key == src && p.disco == Some(sender))
        {
            return;
        }
        let Ok(plain) = enc.decrypt_in_place(&private) else {
            return;
        };
        let Some(ping) = plain.as_msg::<Ping>() else {
            return;
        };
        if *ping.node_key.export().as_bytes() != src {
            return;
        }
        let tx_id = ping.tx_id;
        let mut out = Packet::<ts_disco_protocol::Plaintext>::vec_for_message(Pong::size());
        let at = std::net::SocketAddr::from((DERP_MAGIC, region as u16));
        let Ok(pong) =
            Packet::<ts_disco_protocol::Plaintext>::init_from_bytes::<Pong>(&mut out, |m| {
                m.tx_id = tx_id;
                m.src = ts_disco_protocol::Endpoint::from_socket_addr(at);
            })
        else {
            return;
        };
        let mut nonce = [0u8; 24];
        getrandom::fill(&mut nonce).expect("randomness");
        if pong
            .encrypt_in_place(&private, &DiscoPublicKey::from_bytes(sender), nonce)
            .is_ok()
        {
            self.send_via(region, src, out, now);
        }
    }

    // --- MagicDNS --------------------------------------------------------------------------

    /// The addresses MagicDNS has for `name`, if it's a name it answers for: a node's
    /// (`host.tailnet.`), or an extra record.
    fn lookup(&self, name: &str) -> Option<Vec<IpAddr>> {
        let nm = &self.session.netmap;
        let aaaa = nm
            .node
            .as_ref()
            .is_some_and(|n| n.caps.iter().any(|c| c == CAP_AAAA));
        let node = nm
            .node
            .iter()
            .chain(nm.peers.values())
            .find(|n| n.name.trim_end_matches('.').eq_ignore_ascii_case(name));
        if let Some(n) = node {
            let is_self = nm.node.as_ref().is_some_and(|s| s.id == n.id);
            return Some(
                n.addresses
                    .iter()
                    .map(|a| a.addr())
                    .filter(|a| a.is_ipv4() || aaaa || is_self)
                    .collect(),
            );
        }
        let extra: Vec<IpAddr> = nm
            .dns
            .extra
            .iter()
            .filter(|(n, _)| n.eq_ignore_ascii_case(name))
            .map(|(_, a)| *a)
            .collect();
        (!extra.is_empty()).then_some(extra)
    }

    /// A query to MagicDNS from `asker`, to MagicDNS's address `at`.
    fn magic_dns(&mut self, q: &[u8], asker: Asker, at: IpAddr, now: Instant) {
        let Some(query) = dns::parse(q) else { return };
        let reply = |c: &mut Self, rcode, addrs: &[IpAddr]| {
            let a = dns::answer(q, &query, rcode, addrs, 600);
            c.dns_reply(asker, at, &a);
        };
        if let Some(addrs) = self.lookup(&query.name) {
            return reply(self, dns::NOERROR, &addrs);
        }
        // Routes: the longest suffix of the name decides; one with no resolvers is MagicDNS's own
        // domain, where an unknown name doesn't exist.
        let routes = &self.session.netmap.dns.routes;
        let route = routes
            .iter()
            .filter(|(suffix, _)| {
                query.name == **suffix || query.name.ends_with(&format!(".{suffix}"))
            })
            .max_by_key(|(suffix, _)| suffix.len())
            .map(|(_, r)| r.clone());
        let resolvers = match route {
            Some(r) if r.is_empty() => return reply(self, dns::NXDOMAIN, &[]),
            Some(r) => r,
            None => self.session.netmap.dns.resolvers.clone(),
        };
        // Every resolver at once (as Go's forwarder races them), the first good answer wins: a
        // resolver that's down (a peer offline) costs nothing while another answers. A plain
        // resolver the tunnel reaches (a peer, a subnet, or anywhere through the exit node) is
        // asked through it, from the node's own address; else DNS over HTTPS by `fetch`.
        let exit = !self.exit_node.is_empty();
        let mut plain: Vec<IpAddr> = Vec::new();
        let mut doh: Vec<String> = Vec::new();
        for r in resolvers.iter().take(MAX_RESOLVERS) {
            match r.parse::<IpAddr>() {
                Ok(a) if self.peer_for(a).is_some() && self.self_addr(a.is_ipv4()).is_some() => {
                    plain.push(a)
                }
                Ok(a) => doh.push(dns::doh_url(Some(a)).to_string()),
                Err(_) if r.starts_with("https://") => doh.push(r.clone()),
                Err(_) => {}
            }
        }
        if resolvers.is_empty() {
            // None named: 1.1.1.1 through the exit node, or Cloudflare's DNS over HTTPS.
            let one = IpAddr::from([1, 1, 1, 1]);
            match exit && self.peer_for(one).is_some() && self.self_addr(true).is_some() {
                true => plain.push(one),
                false => doh.push(dns::doh_url(None).to_string()),
            }
        }
        doh.sort();
        doh.dedup();
        let whole = match asker {
            Asker::Tcp(_) => plain.iter().find_map(|a| dns::known_doh(*a)),
            Asker::Udp(..) => None,
        };
        let id = self.next_query;
        self.next_query = self.next_query.wrapping_add(1);
        self.queries.insert(
            id,
            Pending {
                asker,
                at,
                query: q.to_vec(),
                left: (plain.len() + doh.len()) as u32,
                failed: None,
                whole,
                until: now + DNS_TIMEOUT,
            },
        );
        if plain.is_empty() && doh.is_empty() {
            return self.dns_answer(id, None);
        }
        for r in plain {
            let src = self.self_addr(r.is_ipv4()).expect("checked");
            let port = DNS_PORTS.start + (self.next_dns % DNS_PORTS.len() as u32) as u16;
            self.next_dns = self.next_dns.wrapping_add(1);
            self.dns_udp.insert(port, id);
            let p = ip::udp((src, port), (r, 53), q);
            self.send_tunnel(p, r, now);
        }
        for url in doh {
            self.doh(id, &url, q);
        }
    }

    /// Asks `url` (DNS over HTTPS, RFC 8484's GET) on behalf of query `id`.
    fn doh(&mut self, id: u32, url: &str, q: &[u8]) {
        let fetch = DOH + (self.next_dns & 0xffff);
        self.next_dns = self.next_dns.wrapping_add(1);
        self.dns_doh.insert(fetch, id);
        let b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(q);
        self.actions.push_back(Action::Fetch {
            id: fetch,
            url: format!("{url}?dns={b64}"),
        });
    }

    /// A resolver's answer to query `id` (None: it couldn't be asked, or didn't answer).
    fn dns_answer(&mut self, id: u32, answer: Option<&[u8]>) {
        let Some(p) = self.queries.get_mut(&id) else {
            return; // answered already
        };
        let good = answer.is_some_and(|a| {
            a.len() >= 12 && !matches!(dns::rcode(a), dns::SERVFAIL | dns::REFUSED)
        });
        if good
            && answer.is_some_and(dns::truncated)
            && let Some(url) = p.whole.take()
        {
            // Over TCP the guest wants all of it: the same resolver's DNS over HTTPS has it (and
            // the truncated answer goes back if that fails).
            p.failed = answer.map(<[u8]>::to_vec);
            let q = p.query.clone();
            return self.doh(id, url, &q);
        }
        if !good {
            p.left = p.left.saturating_sub(1);
            if let Some(a) = answer {
                p.failed = Some(a.to_vec());
            }
            if p.left > 0 {
                return;
            }
        }
        let p = self.queries.remove(&id).expect("there");
        let msg = match (good, answer, p.failed) {
            (true, Some(a), _) => a.to_vec(),
            (_, _, Some(f)) => f,
            _ => match dns::parse(&p.query) {
                Some(q) => dns::answer(&p.query, &q, dns::SERVFAIL, &[], 0),
                None => return,
            },
        };
        self.dns_reply(p.asker, p.at, &msg);
    }

    fn dns_reply(&mut self, asker: Asker, at: IpAddr, msg: &[u8]) {
        match asker {
            Asker::Udp(guest, max) => {
                let p = ip::udp((at, 53), guest, &dns::fit(msg, max));
                self.actions.push_back(Action::ToGuest(p));
            }
            Asker::Tcp(key) => {
                for p in self.dns_tcp.answer(key, msg) {
                    self.actions.push_back(Action::ToGuest(p));
                }
            }
        }
    }

    // --- The host's inputs -----------------------------------------------------------------

    pub fn fetched(&mut self, id: u32, ok: bool, body: &[u8], now: Instant) {
        if id == control::KEY_FETCH {
            self.session.fetched(ok, body, now);
        } else if id >= PROBE {
            let region = id - PROBE;
            if let Some((sent, rtt)) = self.probes.get_mut(&region) {
                *rtt = ok.then(|| now.saturating_duration_since(*sent));
            }
            if self.probe_until.is_some() && self.probes.values().all(|(_, r)| r.is_some()) {
                self.pick_home(now);
            }
        } else if id >= DOH
            && let Some(q) = self.dns_doh.remove(&id)
        {
            self.dns_answer(q, ok.then_some(body));
        }
        self.after(now);
    }

    pub fn ws_message(&mut self, conn: u32, data: &[u8], now: Instant) {
        if self.session.owns(conn) {
            self.session.ws_message(conn, data, now);
            return self.after(now);
        }
        let Some(region) = self.region_of_conn(conn) else {
            return;
        };
        let r = self.relays.get_mut(&region).unwrap();
        let events = r.d.input(data, now);
        self.flush_relay(region);
        match events {
            Err(e) => self.relay_lost(region, now, &e),
            Ok(events) => {
                for e in events {
                    match e {
                        derp::Event::Ready => {
                            if let Some(r) = self.relays.get_mut(&region) {
                                r.ready_at = Some(now);
                                for (dst, p) in std::mem::take(&mut r.queue) {
                                    r.d.send(&dst, &p, now);
                                }
                            }
                            self.flush_relay(region);
                        }
                        derp::Event::Recv { src, packet } => {
                            self.on_relay_packet(region, src, packet, now)
                        }
                        derp::Event::Restarting { .. } => {
                            self.relay_lost(region, now, "the server is restarting")
                        }
                        derp::Event::Health(h) if !h.is_empty() => {
                            self.log(format!("DERP health: {h}"))
                        }
                        derp::Event::Health(_) | derp::Event::PeerGone(_) => {}
                    }
                }
            }
        }
        self.after(now);
    }

    pub fn ws_closed(&mut self, conn: u32, now: Instant) {
        if self.session.owns(conn) {
            self.session.ws_closed(conn, now);
        } else if let Some(region) = self.region_of_conn(conn) {
            self.relay_lost(region, now, "the connection closed");
        }
        self.after(now);
    }

    /// Uses the peer with this stable ID as the exit node ('' for none); the answer is an
    /// `exitnode` event: with a `code` (`no-exit-node`, and the `id`) when it didn't take.
    pub fn set_exit_node(&mut self, id: &str, now: Instant) {
        let ok = id.is_empty()
            || self
                .peers
                .values()
                .any(|p| p.stable_id == id && p.exit_option);
        if !ok {
            return self.event(json!({ "type": "exitnode", "code": "no-exit-node", "id": id }));
        }
        self.exit_node = id.to_string();
        self.route();
        self.event(json!({ "type": "exitnode" }));
        self.publish_netmap();
        self.after(now);
    }

    /// Installs peers' subnet routes, or stops; the netmap follows.
    pub fn set_accept_routes(&mut self, on: bool, now: Instant) {
        self.accept_routes = on;
        self.route();
        self.publish_netmap();
        self.after(now);
    }

    pub fn tick(&mut self, now: Instant) {
        self.session.tick(now);
        if let Some((wg, _)) = self.wg.as_mut() {
            let r = wg.dispatch_events(now);
            self.send_to_peers(r.to_peers, now);
        }
        if self.probe_until.is_some_and(|t| t <= now) {
            self.pick_home(now);
        }
        // Handshake initiations nobody answered yet go again.
        let due: Vec<PeerId> = self
            .initiations
            .iter()
            .filter(|(_, (_, sent, n))| resend_at(*sent, *n) <= now)
            .map(|(id, _)| *id)
            .collect();
        for id in due {
            let Some((pkt, _, n)) = self.initiations.get_mut(&id) else {
                continue;
            };
            let pkt = pkt.clone();
            *n += 1;
            if *n == RESEND_MS.len() {
                self.initiations.remove(&id);
            }
            if let Some(p) = self.peers.get(&id)
                && let Some(region) = p.home.or(self.home)
            {
                let key = p.key;
                self.send_via(region, key, pkt, now);
            }
        }
        // Relays that died quietly (or never answered) go.
        let mut dead = Vec::new();
        for (id, r) in self.relays.iter_mut() {
            match r.d.tick(now) {
                Ok(()) => queue_frames(&mut self.actions, r.conn, r.d.take_output()),
                Err(e) => dead.push((
                    *id,
                    if r.d.is_ready() {
                        LIVENESS.to_string()
                    } else {
                        e
                    },
                )),
            }
        }
        for (id, why) in dead {
            self.relay_lost(id, now, &why);
        }
        // The home region comes back after a loss.
        if let Some(h) = self.home
            && !self.relays.contains_key(&h)
            && self.retry.get(&h).is_none_or(|t| *t <= now)
        {
            self.retry.remove(&h);
            self.relay(h, now);
        }
        // Other regions close when unused.
        let idle: Vec<u32> = self
            .relays
            .iter()
            .filter(|(id, r)| {
                Some(**id) != self.home && now.saturating_duration_since(r.used) > IDLE
            })
            .map(|(id, _)| *id)
            .collect();
        for id in idle {
            if let Some(r) = self.relays.remove(&id) {
                self.actions.push_back(Action::WsClose { conn: r.conn });
            }
        }
        if self.sweep_at <= now {
            self.sweep_at = now + Duration::from_secs(30);
            self.flows.retain(|_, t| *t > now);
            self.queries.retain(|_, q| q.until > now);
            let queries = &self.queries;
            self.dns_udp.retain(|_, q| queries.contains_key(q));
            self.dns_doh.retain(|_, q| queries.contains_key(q));
            self.dns_tcp.sweep(now);
        }
        self.after(now);
    }

    pub fn deadline(&self) -> Option<Instant> {
        let home_retry = self
            .home
            .filter(|h| !self.relays.contains_key(h))
            .and_then(|h| self.retry.get(&h).copied());
        let idle = self
            .relays
            .iter()
            .filter(|(id, _)| Some(**id) != self.home)
            .map(|(_, r)| r.used + IDLE)
            .min();
        let liveness = self.relays.values().filter_map(|r| r.d.deadline()).min();
        let resend = self
            .initiations
            .values()
            .map(|(_, sent, n)| resend_at(*sent, *n))
            .min();
        [
            self.session.deadline(),
            self.wg
                .as_ref()
                .and_then(|(wg, _)| wg.next_event().map(|r| r.start())),
            self.probe_until,
            home_retry,
            idle,
            liveness,
            resend,
            (!self.flows.is_empty() || !self.queries.is_empty() || !self.dns_tcp.is_empty())
                .then_some(self.sweep_at),
        ]
        .into_iter()
        .flatten()
        .min()
    }

    pub fn poll(&mut self) -> Option<Action> {
        self.actions.pop_front()
    }

    pub fn logout(&mut self, now: Instant) {
        self.session.logout(now);
        self.after(now);
    }

    pub fn close(&mut self) {
        self.session.close();
        self.actions.extend(self.session.actions.drain(..));
        self.stop_data_plane();
        self.state = "Failed";
    }
}

/// When an initiation first sent at `sent`, and sent again `n` times since, goes next.
fn resend_at(sent: Instant, n: usize) -> Instant {
    sent + Duration::from_millis(RESEND_MS[n.min(RESEND_MS.len() - 1)])
}

fn control_public(private: &[u8; 32]) -> [u8; 32] {
    *Export::<NodePrivateKey>::from_bytes(*private)
        .import()
        .public_key()
        .export()
        .as_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SELF4: [u8; 4] = [100, 90, 0, 2];
    const PEER4: [u8; 4] = [100, 90, 0, 1];

    /// A client on a netmap with one peer that offers to be an exit node, under a filter that lets
    /// in only TCP to port 22 from it.
    fn client() -> (Client, PeerId, Instant) {
        let now = Instant::now();
        let cfg = Config {
            control: control::Config {
                url: "https://control.test".into(),
                auth_key: None,
                hostname: "guest".into(),
                ephemeral: false,
            },
            state: BTreeMap::new(),
            exit_node: String::new(),
            accept_routes: true,
        };
        let mut c = Client::new(cfg, now).unwrap();
        let map = serde_json::json!({
            "Node": {"ID": 2, "StableID": "self", "Name": "guest.tail.test.", "Key": format!("nodekey:{}", "01".repeat(32)),
                "Addresses": ["100.90.0.2/32", "fd7a:115c:a1e0::2/128"], "Created": "2026-10-16T00:00:00Z"},
            "Peers": [{"ID": 1, "StableID": "exit", "Name": "peer.tail.test.", "Key": format!("nodekey:{}", "04".repeat(32)),
                "Addresses": ["100.90.0.1/32", "fd7a:115c:a1e0::1/128"],
                "AllowedIPs": ["100.90.0.1/32", "fd7a:115c:a1e0::1/128", "0.0.0.0/0", "::/0"], "Created": "2026-10-16T00:00:00Z"}],
            "DNSConfig": {"Proxied": true, "Routes": {"tail.test.": null}},
            "PacketFilter": [{"SrcIPs": ["100.90.0.1"], "IPProto": [6], "DstPorts": [{"IP": "*", "Ports": {"First": 22, "Last": 22}}]}],
        });
        c.session.netmap.apply(map.to_string().as_bytes()).unwrap();
        c.sync_peers(now);
        c.publish_netmap();
        assert!(c.running());
        let id = c.by_node[&1];
        while c.poll().is_some() {}
        (c, id, now)
    }

    fn tcp(src: [u8; 4], dst: [u8; 4], dport: u16, flags: u8) -> Vec<u8> {
        let mut p = vec![0x45, 0, 0, 40, 0, 0, 0x40, 0, 64, ip::TCP, 0, 0];
        p.extend_from_slice(&src);
        p.extend_from_slice(&dst);
        p.extend_from_slice(&[0x9c, 0x40]);
        p.extend_from_slice(&dport.to_be_bytes());
        p.extend_from_slice(&[0, 0, 0, 1, 0, 0, 0, 0, 0x50, flags, 0xff, 0xff, 0, 0, 0, 0]);
        p
    }

    fn to_guest(c: &mut Client) -> Vec<Vec<u8>> {
        std::iter::from_fn(|| c.poll())
            .filter_map(|a| {
                if let Action::ToGuest(p) = a {
                    Some(p)
                } else {
                    None
                }
            })
            .collect()
    }

    #[test]
    fn the_filter_lets_in_what_the_tailnet_allows_and_replies_to_the_guest() {
        let (mut c, peer, now) = client();
        // New connections: only what the rule allows.
        c.tunnel_packet(peer, &tcp(PEER4, SELF4, 22, 0x02), now);
        assert_eq!(to_guest(&mut c).len(), 1, "SYN to 22: allowed");
        c.tunnel_packet(peer, &tcp(PEER4, SELF4, 80, 0x02), now);
        assert!(to_guest(&mut c).is_empty(), "SYN to 80: not allowed");
        c.tunnel_packet(peer, &tcp(PEER4, SELF4, 80, 0x12), now);
        assert_eq!(
            to_guest(&mut c).len(),
            1,
            "a SYN-ACK (the guest's connection) goes in"
        );
        // UDP: only replies to the guest's own flows.
        let reply = ip::udp(
            (IpAddr::from(PEER4), 5000),
            (IpAddr::from(SELF4), 4000),
            b"answer",
        );
        c.tunnel_packet(peer, &reply, now);
        assert!(to_guest(&mut c).is_empty(), "unasked UDP: dropped");
        c.guest_packet(
            &ip::udp(
                (IpAddr::from(SELF4), 4000),
                (IpAddr::from(PEER4), 5000),
                b"ask",
            ),
            now,
        );
        while c.poll().is_some() {}
        c.tunnel_packet(peer, &reply, now);
        assert_eq!(to_guest(&mut c).len(), 1, "the reply: in");
        // Not to the node's address, or from an address the peer doesn't have: dropped.
        c.tunnel_packet(peer, &tcp(PEER4, [100, 90, 0, 9], 22, 0x02), now);
        c.tunnel_packet(peer, &tcp([1, 1, 1, 1], SELF4, 22, 0x02), now);
        assert!(to_guest(&mut c).is_empty());
    }

    #[test]
    fn the_exit_node_carries_the_rest_only_when_selected() {
        let (mut c, peer, now) = client();
        let world = IpAddr::from([1, 1, 1, 1]);
        assert_eq!(c.peer_for(IpAddr::from(PEER4)), Some(peer));
        assert_eq!(
            c.peer_for(world),
            None,
            "its default route isn't used unselected"
        );
        c.set_exit_node("nope", now);
        assert!(
            std::iter::from_fn(|| c.poll())
                .any(|a| matches!(a, Action::Event(e) if e.contains(r#""code":"no-exit-node""#) && e.contains(r#""id":"nope""#)))
        );
        c.set_exit_node("exit", now);
        assert_eq!(c.peer_for(world), Some(peer));
        assert_eq!(c.peer_for("2606:4700::1111".parse().unwrap()), Some(peer));
        // The internet's replies come in from it, to the guest's flows.
        c.guest_packet(
            &ip::udp((IpAddr::from(SELF4), 4001), (world, 53), b"q"),
            now,
        );
        while c.poll().is_some() {}
        c.tunnel_packet(
            peer,
            &ip::udp((world, 53), (IpAddr::from(SELF4), 4001), b"a"),
            now,
        );
        assert_eq!(to_guest(&mut c).len(), 1);
        c.set_exit_node("", now);
        assert_eq!(c.peer_for(world), None);
    }

    #[test]
    fn magic_dns_answers_for_the_tailnet() {
        let (mut c, _, now) = client();
        let query = |name: &str| {
            let mut m = vec![0, 7, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0];
            for l in name.split('.') {
                m.push(l.len() as u8);
                m.extend_from_slice(l.as_bytes());
            }
            m.extend_from_slice(&[0, 0, 1, 0, 1]);
            ip::udp((IpAddr::from(SELF4), 40000), (ip::MAGIC_DNS4, 53), &m)
        };
        c.guest_packet(&query("peer.tail.test"), now);
        let a = to_guest(&mut c);
        assert_eq!(a.len(), 1);
        assert_eq!(&a[0][a[0].len() - 4..], &PEER4, "the peer's address");
        c.guest_packet(&query("nope.tail.test"), now);
        let nx = to_guest(&mut c);
        assert_eq!(nx[0][28 + 3] & 15, dns::NXDOMAIN);
        // Elsewhere, with no exit node and no resolvers: DNS over HTTPS.
        c.guest_packet(&query("example.com"), now);
        assert!(std::iter::from_fn(|| c.poll()).any(|a| matches!(a, Action::Fetch { url, .. } if url.starts_with("https://cloudflare-dns.com/dns-query?dns="))));
    }

    use crate::derp::testserver::Server as Relay;

    fn hex(b: &[u8]) -> String {
        b.iter().map(|b| format!("{b:02x}")).collect()
    }

    fn pair(seed: u8) -> NodeKeyPair {
        NodeKeyPair::from(Export::<NodePrivateKey>::from_bytes([seed; 32]).import())
    }

    /// `client()` with a DERP region (home) whose relay `relay` plays, connected; what the client
    /// sends through it lands in `sent`.
    fn on_relay(relay: &mut Relay) -> (Client, PeerId, Instant, u32) {
        let (mut c, peer, now) = client();
        c.session
            .netmap
            .apply(br#"{"DERPMap": {"Regions": {"1": {"RegionID": 1, "RegionCode": "t", "RegionName": "t",
                "Nodes": [{"Name": "1a", "RegionID": 1, "HostName": "derp.test"}]}}}}"#)
            .unwrap();
        c.set_home(1, now);
        let mut sent = Vec::new();
        let conn = pump(&mut c, relay, now, &mut sent).expect("a relay connection");
        (c, peer, now, conn)
    }

    /// Carries out the client's relay actions; returns the connection it opened, if any.
    fn pump(
        c: &mut Client,
        relay: &mut Relay,
        now: Instant,
        sent: &mut Vec<([u8; 32], Vec<u8>)>,
    ) -> Option<u32> {
        let mut opened = None;
        let mut actions: VecDeque<Action> = std::iter::from_fn(|| c.poll()).collect();
        while let Some(a) = actions.pop_front() {
            match a {
                Action::WsOpen { conn, .. } => {
                    opened = Some(conn);
                    c.ws_message(conn, &relay.hello(), now);
                }
                Action::WsSend { conn, data } => {
                    for reply in relay.input(&data, sent) {
                        c.ws_message(conn, &reply, now);
                    }
                }
                _ => {}
            }
            actions.extend(std::iter::from_fn(|| c.poll()));
        }
        opened
    }

    fn initiations(sent: &[([u8; 32], Vec<u8>)]) -> usize {
        sent.iter()
            .filter(|(_, p)| (p[0], p.len()) == (INITIATION.0, INITIATION.1))
            .count()
    }

    #[test]
    fn an_unanswered_first_handshake_goes_again_within_seconds() {
        let mut relay = Relay::new([43; 32]);
        let (mut c, _, now, _) = on_relay(&mut relay);
        let mut sent = Vec::new();
        c.guest_packet(&tcp(SELF4, PEER4, 22, 0x02), now);
        pump(&mut c, &mut relay, now, &mut sent);
        assert_eq!(initiations(&sent), 1);
        let first = sent[0].1.clone();
        for ms in RESEND_MS.into_iter().chain([4000]) {
            let t = now + Duration::from_millis(ms);
            assert!(ms > 3000 || c.deadline().unwrap() <= t);
            c.tick(t);
            pump(&mut c, &mut relay, t, &mut sent);
        }
        assert_eq!(
            initiations(&sent),
            1 + RESEND_MS.len(),
            "by 4 s, before WireGuard's 5 s retry"
        );
        assert!(sent.iter().all(|(_, p)| *p == first), "the same initiation");
        // An answer from the peer stops them.
        let mut relay2 = Relay::new([43; 32]);
        let (mut c, _, now, conn) = on_relay(&mut relay2);
        let mut sent = Vec::new();
        c.guest_packet(&tcp(SELF4, PEER4, 22, 0x02), now);
        pump(&mut c, &mut relay2, now, &mut sent);
        c.ws_message(
            conn,
            &relay2.deliver(&[4; 32], &[4, 0, 0, 0, 1, 2, 3, 4]),
            now,
        );
        let t = now + Duration::from_secs(2);
        c.tick(t);
        pump(&mut c, &mut relay2, t, &mut sent);
        assert_eq!(initiations(&sent), 1);
    }

    #[test]
    fn a_relay_that_dies_quietly_is_replaced_at_once() {
        let mut relay = Relay::new([43; 32]);
        let (mut c, _, now, first) = on_relay(&mut relay);
        let t = now + derp::IDLE_PING;
        c.tick(t);
        let pings: Vec<Action> = std::iter::from_fn(|| c.poll()).collect();
        assert!(
            pings
                .iter()
                .any(|a| matches!(a, Action::WsSend { conn, .. } if *conn == first))
        );
        // No answer.
        let t = t + derp::PONG_WAIT;
        c.tick(t);
        let mut sent = Vec::new();
        let again = pump(&mut c, &mut relay, t, &mut sent).expect("a new connection");
        assert_ne!(again, first);
        assert!(c.relays[&1].d.is_ready());
    }

    #[test]
    fn a_peer_with_a_new_key_is_reached_with_it() {
        let mut relay = Relay::new([43; 32]);
        let (mut c, peer, now, _) = on_relay(&mut relay);
        // The peer re-registers: same node, a new key (and its WireGuard endpoint has it).
        let new = pair(5);
        let new_pub = *new.public.export().as_bytes();
        let mut b = Endpoint::new(new);
        let ours = control_public(&c.session.node_private());
        b.upsert_peer(PeerConfig::new(
            PeerId(1),
            NodePublicKey::from_bytes(ours),
            [0; 32],
        ));
        // First a handshake with the old key, so WireGuard has state for it.
        let mut sent = Vec::new();
        c.guest_packet(&tcp(SELF4, PEER4, 22, 0x02), now);
        pump(&mut c, &mut relay, now, &mut sent);
        let changed = format!(
            r#"{{"PeersChanged": [{{"ID": 1, "StableID": "exit", "Name": "peer.tail.test.", "Key": "nodekey:{}",
                "Addresses": ["100.90.0.1/32", "fd7a:115c:a1e0::1/128"], "Created": "2026-10-16T00:00:00Z"}}]}}"#,
            hex(&new_pub)
        );
        c.session.netmap.apply(changed.as_bytes()).unwrap();
        c.sync_peers(now);
        assert_eq!(c.by_node[&1], peer);
        let mut sent = Vec::new();
        let t = now + Duration::from_millis(100);
        c.guest_packet(&tcp(SELF4, PEER4, 22, 0x02), t);
        pump(&mut c, &mut relay, t, &mut sent);
        let init: Vec<_> = sent
            .into_iter()
            .filter(|(dst, p)| *dst == new_pub && p[0] == INITIATION.0)
            .collect();
        assert_eq!(init.len(), 1, "an initiation to the new key");
        let r = b.recv(t, [PacketMut::from(init[0].1.clone())]);
        assert!(
            !r.to_peers.is_empty(),
            "the peer answers it (its MACs check out)"
        );
    }

    #[test]
    fn subnet_routes_are_installed_unless_turned_off() {
        let (mut c, peer, now) = client();
        let lan: IpAddr = "192.168.1.5".parse().unwrap();
        c.session
            .netmap
            .apply(br#"{"PeersChanged": [{"ID": 1, "StableID": "exit", "Name": "peer.tail.test.", "Key": "nodekey:0404040404040404040404040404040404040404040404040404040404040404",
                "Addresses": ["100.90.0.1/32", "fd7a:115c:a1e0::1/128"],
                "AllowedIPs": ["100.90.0.1/32", "fd7a:115c:a1e0::1/128", "192.168.1.0/24", "0.0.0.0/0", "::/0"], "Created": "2026-10-16T00:00:00Z"}]}"#)
            .unwrap();
        c.sync_peers(now);
        assert_eq!(c.peer_for(lan), Some(peer), "routes accepted by default");
        assert_eq!(
            c.peer_for("192.168.2.1".parse().unwrap()),
            None,
            "not the exit node's default unselected"
        );
        c.publish_netmap();
        let nm = std::iter::from_fn(|| c.poll())
            .find_map(|a| match a {
                Action::Event(e) if e.contains("\"netmap\"") => Some(e),
                _ => None,
            })
            .unwrap();
        assert!(nm.contains(r#""routes":["192.168.1.0/24"]"#), "{nm}");
        // A host on the subnet answering the guest comes in from the router.
        c.guest_packet(&ip::udp((IpAddr::from(SELF4), 4000), (lan, 53), b"q"), now);
        while c.poll().is_some() {}
        c.tunnel_packet(
            peer,
            &ip::udp((lan, 53), (IpAddr::from(SELF4), 4000), b"a"),
            now,
        );
        assert_eq!(to_guest(&mut c).len(), 1);
        // Off: neither way.
        c.set_accept_routes(false, now);
        assert_eq!(c.peer_for(lan), None);
        c.tunnel_packet(
            peer,
            &ip::udp((lan, 53), (IpAddr::from(SELF4), 4000), b"a"),
            now,
        );
        assert!(to_guest(&mut c).is_empty());
        // The exit node's default still yields to a more specific route.
        c.set_accept_routes(true, now);
        c.set_exit_node("exit", now);
        assert_eq!(c.peer_for(lan), Some(peer));
        assert_eq!(c.peer_for(IpAddr::from(PEER4)), Some(peer));
    }

    #[test]
    fn a_full_flow_table_keeps_its_flows_alive() {
        let (mut c, peer, now) = client();
        let world = IpAddr::from([1, 1, 1, 1]);
        c.set_exit_node("exit", now);
        c.guest_packet(
            &ip::udp((IpAddr::from(SELF4), 4000), (world, 53), b"q"),
            now,
        );
        // Fill the table.
        for k in 1..MAX_FLOWS as u16 {
            c.flows.insert(
                (ip::UDP, IpAddr::from(SELF4), 10000 + k % 50000, world, k),
                now + FLOW,
            );
        }
        while c.flows.len() < MAX_FLOWS {
            let n = c.flows.len() as u16;
            c.flows
                .insert((ip::UDP, IpAddr::from(SELF4), 1, world, n), now + FLOW);
        }
        let later = now + FLOW - Duration::from_secs(1);
        c.guest_packet(
            &ip::udp((IpAddr::from(SELF4), 4000), (world, 53), b"q"),
            later,
        );
        while c.poll().is_some() {}
        let t = now + FLOW + Duration::from_secs(1);
        c.tunnel_packet(
            peer,
            &ip::udp((world, 53), (IpAddr::from(SELF4), 4000), b"a"),
            t,
        );
        assert_eq!(
            to_guest(&mut c).len(),
            1,
            "refreshed though the table was full"
        );
    }

    fn dns_query(name: &str) -> Vec<u8> {
        let mut m = vec![0, 7, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0];
        for l in name.split('.') {
            m.push(l.len() as u8);
            m.extend_from_slice(l.as_bytes());
        }
        m.extend_from_slice(&[0, 0, 1, 0, 1]);
        m
    }

    /// An answer to `q` with this RCODE, padded to `len` bytes.
    fn dns_response(q: &[u8], rcode: u8, len: usize) -> Vec<u8> {
        let mut a = dns::answer(q, &dns::parse(q).unwrap(), rcode, &[], 0);
        a.resize(len.max(a.len()), 0);
        a
    }

    /// The client with two resolvers: a peer (through the tunnel) and one it can't reach (DNS over
    /// HTTPS); the DoH fetch a query made.
    fn two_resolvers() -> (Client, Instant) {
        let (mut c, _, now) = client();
        c.session
            .netmap
            .apply(br#"{"DNSConfig": {"Resolvers": [{"Addr": "100.90.0.1"}, {"Addr": "192.0.2.53"}], "Proxied": true, "Routes": {"tail.test.": null}}}"#)
            .unwrap();
        (c, now)
    }

    fn fetches(c: &mut Client) -> Vec<(u32, String)> {
        std::iter::from_fn(|| c.poll())
            .filter_map(|a| match a {
                Action::Fetch { id, url } => Some((id, url)),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn magic_dns_asks_every_resolver_and_takes_the_first_good_answer() {
        let (mut c, now) = two_resolvers();
        let q = dns_query("example.com");
        c.guest_packet(
            &ip::udp((IpAddr::from(SELF4), 40000), (ip::MAGIC_DNS4, 53), &q),
            now,
        );
        let f = fetches(&mut c);
        assert_eq!(f.len(), 1, "the unreachable one over HTTPS");
        assert!(
            f[0].1
                .starts_with("https://cloudflare-dns.com/dns-query?dns=")
        );
        assert_eq!(c.dns_udp.len(), 1, "the peer through the tunnel");
        // The peer is down (no answer); the other's comes: that's the guest's.
        c.fetched(f[0].0, true, &dns_response(&q, dns::NOERROR, 0), now);
        let a = to_guest(&mut c);
        assert_eq!(a.len(), 1);
        assert_eq!(a[0][28 + 3] & 15, dns::NOERROR);
        let late = *c.dns_udp.values().next().unwrap();
        c.dns_answer(late, Some(&dns_response(&q, dns::NOERROR, 0)));
        assert!(to_guest(&mut c).is_empty(), "one answer only");

        // One fails (SERVFAIL), the other answers: the answer, not the failure.
        let (mut c, now) = two_resolvers();
        c.guest_packet(
            &ip::udp((IpAddr::from(SELF4), 40000), (ip::MAGIC_DNS4, 53), &q),
            now,
        );
        let f = fetches(&mut c);
        c.fetched(f[0].0, true, &dns_response(&q, dns::SERVFAIL, 0), now);
        assert!(to_guest(&mut c).is_empty(), "the other may do better");
        let id = *c.dns_udp.values().next().unwrap();
        c.dns_answer(id, Some(&dns_response(&q, dns::NXDOMAIN, 0)));
        let a = to_guest(&mut c);
        assert_eq!(a[0][28 + 3] & 15, dns::NXDOMAIN);

        // Both fail: the failure.
        let (mut c, now) = two_resolvers();
        c.guest_packet(
            &ip::udp((IpAddr::from(SELF4), 40000), (ip::MAGIC_DNS4, 53), &q),
            now,
        );
        let f = fetches(&mut c);
        c.fetched(f[0].0, false, b"", now);
        let id = *c.dns_udp.values().next().unwrap();
        c.dns_answer(id, Some(&dns_response(&q, dns::REFUSED, 0)));
        let a = to_guest(&mut c);
        assert_eq!(a[0][28 + 3] & 15, dns::REFUSED);
    }

    #[test]
    fn magic_dns_truncates_over_udp_and_answers_over_tcp() {
        let (mut c, now) = two_resolvers();
        let q = dns_query("example.com");
        c.guest_packet(
            &ip::udp((IpAddr::from(SELF4), 40000), (ip::MAGIC_DNS4, 53), &q),
            now,
        );
        let f = fetches(&mut c);
        c.fetched(f[0].0, true, &dns_response(&q, dns::NOERROR, 900), now);
        let a = to_guest(&mut c);
        let msg = &a[0][28..];
        assert!(
            dns::truncated(msg) && msg.len() < 512,
            "no EDNS: 512 at most, so TC"
        );

        // The guest asks again over TCP: the whole answer comes back.
        let (guest, magic) = ((IpAddr::from(SELF4), 40001), (ip::MAGIC_DNS4, 53));
        c.guest_packet(&ip::tcp(guest, magic, 5000, 0, ip::SYN, &[]), now);
        let syn_ack = to_guest(&mut c);
        let i = ip::parse(&syn_ack[0]).unwrap();
        let (isn, _, flags, _) = ip::tcp_segment(&syn_ack[0], &i).unwrap();
        assert_eq!(flags, ip::SYN | ip::ACK);
        let mut framed = (q.len() as u16).to_be_bytes().to_vec();
        framed.extend_from_slice(&q);
        c.guest_packet(
            &ip::tcp(guest, magic, 5001, isn + 1, ip::ACK | ip::PSH, &framed),
            now,
        );
        let f = fetches(&mut c);
        c.fetched(f[0].0, true, &dns_response(&q, dns::NOERROR, 900), now);
        let segs = to_guest(&mut c);
        let data: Vec<u8> = segs
            .iter()
            .flat_map(|p| {
                ip::tcp_segment(p, &ip::parse(p).unwrap())
                    .unwrap()
                    .3
                    .to_vec()
            })
            .collect();
        assert_eq!(data.len(), 2 + 900, "the 2-byte length and all of it");

        // MagicDNS's own names over TCP too.
        let q = dns_query("peer.tail.test");
        let mut framed = (q.len() as u16).to_be_bytes().to_vec();
        framed.extend_from_slice(&q);
        let guest = (IpAddr::from(SELF4), 40002);
        c.guest_packet(&ip::tcp(guest, magic, 9000, 0, ip::SYN, &[]), now);
        let p = to_guest(&mut c);
        let (isn, ..) = ip::tcp_segment(&p[0], &ip::parse(&p[0]).unwrap()).unwrap();
        c.guest_packet(
            &ip::tcp(guest, magic, 9001, isn + 1, ip::ACK | ip::PSH, &framed),
            now,
        );
        let p = to_guest(&mut c);
        let answer = ip::tcp_segment(&p[1], &ip::parse(&p[1]).unwrap())
            .unwrap()
            .3
            .to_vec();
        assert_eq!(&answer[answer.len() - 4..], &PEER4);
    }
}
