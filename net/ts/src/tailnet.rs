//! The Tailscale client (docs/tailnet.md "Tailscale"), sans I/O like the tailcat one
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
    derp, dns, ip,
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
/// The node attribute that makes MagicDNS answer AAAA for peers (tailcfg.NodeAttrMagicDNSPeerAAAA).
const CAP_AAAA: &str = "https://tailscale.com/cap/magicdns-aaaa";
/// Disco's address for "over DERP" (magicsock's derpMagicIPAddr); the port is the region.
const DERP_MAGIC: Ipv4Addr = Ipv4Addr::new(127, 3, 3, 40);

pub struct Config {
    pub control: control::Config,
    /// The kept node: the store's entries (`<StateKey>` → bytes).
    pub state: BTreeMap<String, Vec<u8>>,
    /// A peer's stable ID to use as the exit node ('' for none).
    pub exit_node: String,
}

struct Peer {
    stable_id: String,
    key: [u8; 32],
    disco: Option<[u8; 32]>,
    home: Option<u32>,
    /// Its own addresses.
    addrs: Vec<IpNet>,
    /// What it may send from (and is sent to): its addresses, and the default routes when it's
    /// the exit node in use.
    allowed: Vec<IpNet>,
    exit_option: bool,
    caps: Vec<String>,
}

/// A connection to one DERP region.
struct Relay {
    conn: u32,
    d: derp::Conn,
    /// Packets waiting for the handshake: (destination node key, packet).
    queue: Vec<([u8; 32], Vec<u8>)>,
    used: Instant,
}

/// A MagicDNS query being answered elsewhere: who asked, at which MagicDNS address.
struct Pending {
    guest: (IpAddr, u16),
    at: IpAddr,
    until: Instant,
}

pub struct Client {
    session: Session,
    exit_node: String,
    disco: [u8; 32],
    /// WireGuard, for the node key it was made with.
    wg: Option<(Endpoint, [u8; 32])>,
    peers: BTreeMap<PeerId, Peer>,
    by_node: BTreeMap<i64, PeerId>,
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
    /// The guest's UDP and ICMP flows: (proto, guest address and port, remote address and port).
    flows: BTreeMap<(u8, IpAddr, u16, IpAddr, u16), Instant>,
    dns_udp: BTreeMap<u16, Pending>,
    dns_doh: BTreeMap<u32, Pending>,
    next_dns: u32,
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
            disco,
            wg: None,
            peers: BTreeMap::new(),
            by_node: BTreeMap::new(),
            next_peer: 1,
            relays: BTreeMap::new(),
            next_conn: 1,
            home: None,
            probes: BTreeMap::new(),
            probe_until: None,
            retry: BTreeMap::new(),
            failures: BTreeMap::new(),
            flows: BTreeMap::new(),
            dns_udp: BTreeMap::new(),
            dns_doh: BTreeMap::new(),
            next_dns: 0,
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
                Update::Failed(why) => {
                    self.stop_data_plane();
                    self.event(json!({ "type": "state", "state": "Failed", "error": why }));
                    self.state = "Failed";
                }
                Update::Map(c) if c.tailnet_lock => {
                    self.session.close();
                    self.actions.extend(self.session.actions.drain(..));
                    self.stop_data_plane();
                    let why = "this tailnet uses Tailnet Lock, which this client doesn't support: its node would need signing, and its peers' keys checking";
                    self.event(json!({ "type": "state", "state": "Failed", "error": why }));
                    self.state = "Failed";
                }
                Update::Map(c) => {
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

    fn publish_netmap(&mut self) {
        let nm = self.session.netmap.page_json(MTU, &self.exit_node);
        if nm.is_null() {
            return;
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
                    d: derp::Conn::new(private, public, Some(region) == self.home),
                    queue: Vec::new(),
                    used: now,
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

    /// Lost a region's connection: try again after a backoff (at once for the home region's
    /// first loss, so a server restart costs little).
    fn relay_lost(&mut self, region: u32, now: Instant, why: &str) {
        if let Some(r) = self.relays.remove(&region) {
            self.actions.push_back(Action::WsClose { conn: r.conn });
        }
        let f = self.failures.entry(region).or_insert(0);
        *f += 1;
        let backoff = Duration::from_millis(250u64 << (*f).min(7)).min(Duration::from_secs(30));
        self.retry.insert(region, now + backoff);
        self.log(format!("DERP region {region}: {why}"));
    }

    /// Sends `packet` to the node with key `dst` through `region`.
    fn send_via(&mut self, region: u32, dst: [u8; 32], packet: Vec<u8>, now: Instant) {
        let Some(r) = self.relay(region, now) else {
            return;
        };
        r.used = now;
        if r.d.is_ready() {
            r.d.send(&dst, &packet);
        } else if r.queue.len() < 256 {
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
            for (_, r) in std::mem::take(&mut self.relays) {
                self.actions.push_back(Action::WsClose { conn: r.conn });
            }
            if let Some(h) = self.home {
                self.relay(h, now);
            }
        }
        let nodes: Vec<Node> = self.session.netmap.peers.values().cloned().collect();
        let live: Vec<i64> = nodes.iter().map(|n| n.id).collect();
        for (node, id) in self.by_node.clone() {
            if !live.contains(&node) {
                self.by_node.remove(&node);
                self.peers.remove(&id);
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
            let changed_key = self.peers.get(&id).is_none_or(|p| p.key != n.key);
            let peer = Peer {
                stable_id: n.stable_id.clone(),
                key: n.key,
                disco: n.disco,
                home: n.home_derp,
                addrs: n.addresses.clone(),
                allowed: Vec::new(),
                exit_option: n.exit_node_option(),
                caps: n.caps.clone(),
            };
            self.peers.insert(id, peer);
            if changed_key && let Some((wg, _)) = self.wg.as_mut() {
                wg.upsert_peer(PeerConfig::new(
                    id,
                    NodePublicKey::from_bytes(n.key),
                    [0; 32],
                ));
            }
        }
        self.route();
    }

    /// Each peer's allowed IPs: its own addresses, and the default routes for the exit node.
    fn route(&mut self) {
        let exit = self.exit_node.clone();
        for p in self.peers.values_mut() {
            p.allowed = p.addrs.clone();
            if !exit.is_empty() && p.stable_id == exit && p.exit_option {
                p.allowed
                    .extend(["0.0.0.0/0", "::/0"].map(|n| n.parse::<IpNet>().unwrap()));
            }
        }
    }

    /// The peer a packet to `dst` goes to: the one whose own address it is, or the exit node.
    fn peer_for(&self, dst: IpAddr) -> Option<PeerId> {
        let mut best: Option<(u8, PeerId)> = None;
        for (id, p) in &self.peers {
            for n in &p.allowed {
                if n.contains(&dst) && best.is_none_or(|(len, _)| n.prefix_len() > len) {
                    best = Some((n.prefix_len(), *id));
                }
            }
        }
        best.map(|(_, id)| id)
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
                self.send_via(region, key, pkt.as_ref().to_vec(), now);
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
        if (i.dst == ip::MAGIC_DNS4 || i.dst == ip::MAGIC_DNS6)
            && i.proto == ip::UDP
            && i.dport == 53
        {
            if let Some(q) = ip::udp_payload(p, &i) {
                let q = q.to_vec();
                self.magic_dns(&q, (i.src, i.sport), i.dst, now);
            }
            return;
        }
        if (i.proto == ip::UDP || matches!(i.icmp_type, Some(8 | 128)))
            && self.flows.len() < MAX_FLOWS
        {
            self.flows
                .insert((i.proto, i.src, i.sport, i.dst, i.dport), now + FLOW);
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
                self.dns_reply(q, &a);
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
            .map(|p| p.caps.clone())
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

    /// A query to MagicDNS from the guest at `from`, to MagicDNS's address `at`.
    fn magic_dns(&mut self, q: &[u8], from: (IpAddr, u16), at: IpAddr, now: Instant) {
        let Some(query) = dns::parse(q) else { return };
        let reply = |c: &mut Self, rcode, addrs: &[IpAddr]| {
            let a = dns::answer(q, &query, rcode, addrs, 600);
            c.actions
                .push_back(Action::ToGuest(ip::udp((at, 53), from, &a)));
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
        let pending = Pending {
            guest: from,
            at,
            until: now + DNS_TIMEOUT,
        };
        // A plain resolver the tunnel reaches (a peer, or anywhere through the exit node) is asked
        // through it, from the node's own address; else DNS over HTTPS.
        let plain: Option<IpAddr> = resolvers.iter().find_map(|r| r.parse::<IpAddr>().ok());
        let exit = !self.exit_node.is_empty();
        let through = match plain {
            Some(r) if self.peer_for(r).is_some() => Some(r),
            None if exit && resolvers.is_empty() => Some(IpAddr::from([1, 1, 1, 1])),
            _ => None,
        };
        if let Some(r) = through
            && let Some(src) = self.self_addr(r.is_ipv4())
        {
            let port = DNS_PORTS.start + (self.next_dns % DNS_PORTS.len() as u32) as u16;
            self.next_dns = self.next_dns.wrapping_add(1);
            self.dns_udp.insert(port, pending);
            let p = ip::udp((src, port), (r, 53), q);
            self.send_tunnel(p, r, now);
            return;
        }
        let url = resolvers
            .iter()
            .find(|r| r.starts_with("https://"))
            .cloned()
            .unwrap_or_else(|| dns::doh_url(plain).to_string());
        let id = DOH + (self.next_dns & 0xffff);
        self.next_dns = self.next_dns.wrapping_add(1);
        self.dns_doh.insert(id, pending);
        let b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(q);
        self.actions.push_back(Action::Fetch {
            id,
            url: format!("{url}?dns={b64}"),
        });
    }

    fn dns_reply(&mut self, q: Pending, answer: &[u8]) {
        self.actions
            .push_back(Action::ToGuest(ip::udp((q.at, 53), q.guest, answer)));
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
            && ok
        {
            self.dns_reply(q, body);
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
        let events = r.d.input(data);
        self.flush_relay(region);
        match events {
            Err(e) => self.relay_lost(region, now, &e),
            Ok(events) => {
                for e in events {
                    match e {
                        derp::Event::Ready => {
                            self.failures.remove(&region);
                            if let Some(r) = self.relays.get_mut(&region) {
                                for (dst, p) in std::mem::take(&mut r.queue) {
                                    r.d.send(&dst, &p);
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
            self.relays.remove(&region);
            self.relay_lost(region, now, "the connection closed");
        }
        self.after(now);
    }

    /// Uses the peer with this stable ID as the exit node ('' for none); the answer is an
    /// `exitnode` event (its error, '' when it took).
    pub fn set_exit_node(&mut self, id: &str, now: Instant) {
        let ok = id.is_empty()
            || self
                .peers
                .values()
                .any(|p| p.stable_id == id && p.exit_option);
        if !ok {
            return self.event(json!({ "type": "exitnode", "error": format!("no peer {id} offers to be an exit node") }));
        }
        self.exit_node = id.to_string();
        self.route();
        self.event(json!({ "type": "exitnode", "error": "" }));
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
            self.dns_udp.retain(|_, q| q.until > now);
            self.dns_doh.retain(|_, q| q.until > now);
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
        [
            self.session.deadline(),
            self.wg
                .as_ref()
                .and_then(|(wg, _)| wg.next_event().map(|r| r.start())),
            self.probe_until,
            home_retry,
            idle,
            (!self.flows.is_empty() || !self.dns_udp.is_empty() || !self.dns_doh.is_empty())
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
                .any(|a| matches!(a, Action::Event(e) if e.contains("no peer nope")))
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
}
