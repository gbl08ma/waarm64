//! A room's client (docs/plans/networking-p2p.md, docs/tailnet.md "Rooms"), sans I/O: VMs in
//! different browsers on one network, each a WireGuard node whose packets go browser to browser
//! over a WebRTC data channel when one is open and through DERP otherwise.
//!
//! - **The room** comes from its link ([`link`]): an ID its members agree on, its Nostr relays and
//!   its DERP regions. From the ID, by BLAKE2s, its /48, the tag salt and lookup key of its
//!   lookups, and the pre-shared key every pair in it uses ([`Room`]). A node's address is the /48
//!   plus the first 80 bits of its node key, and a peer's packets reach the guest only from that
//!   peer's own address.
//! - **Finding a peer** ([`lookup`]): the guest sends to a room address; the module publishes a
//!   sealed lookup under the target's tag of the hour, as an ephemeral Nostr event, on every relay
//!   of the link. The target, subscribed to its own tags, calls back: it joins the dialer's home
//!   region and starts the WireGuard handshake through DERP. No answer: ICMPv6 address unreachable.
//! - **WireGuard** (`ts_tunnel`, IKpsk2 with the room's key) is the same whichever path carries a
//!   packet, so the fallback and the address binding come from the code tailcat uses. One DERP
//!   connection per region in use: the home region always, another while a peer is reached there.
//! - **Signalling** goes inside the tunnel: UDP between the two nodes' addresses on
//!   [`SIGNAL_PORT`], which the guest can't use, acknowledged and resent. So a node shows its ICE
//!   candidates only to a member that completed a handshake with the room's key. The side with the
//!   lower key offers; the page holds the `RTCPeerConnection` (`Action::RtcOpen`, `RtcSignal`,
//!   `RtcClose`) and the worker the data channel (`RtcSend`, `rtc_message`). At most
//!   [`MAX_RTC`] channels, each closed after [`RTC_IDLE`] without the guests' traffic.
//! - **The resolver** at the room's `::53` answers `<key>.<tag>.p2p.internal` by computing the address,
//!   and remembers the key, so lookups to it are sealed to it.
//! - **Incoming connections** (on by default): a member we don't know may call us. Off, only the
//!   guest's own flows get their replies, and lookups for it go unanswered unless it has a flow
//!   with the dialer.

pub mod link;
pub mod lookup;

use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    net::{IpAddr, Ipv6Addr},
    time::{Duration, Instant, SystemTime},
};

use base64::Engine;
use blake2::{Blake2s256, Digest};
use serde::{Deserialize, Serialize};
use serde_json::json;
use ts_keys::{Export, ExportableKey, NodeKeyPair, NodePrivateKey, NodePublicKey};
use ts_packet::PacketMut;
use ts_tunnel::{Endpoint, PeerConfig, PeerId};

pub use self::link::{Link, Region};
use self::lookup::Lookup;
use crate::{
    client::{Action, GUEST4, pad, queue_frames, unpad},
    derp, dns, ip, nostr, tailcat,
};

const TUNNEL_MTU: usize = 1280;
/// The UDP port signalling uses between two nodes' addresses, both ends. The module keeps it:
/// the guest's packets to or from it are dropped.
pub const SIGNAL_PORT: u16 = 1;
/// The names' suffix under the room's tag: `.internal`, which ICANN reserved for private use and
/// never delegates (plan §5: systemd-resolved answers RFC 9476's `.alt` NXDOMAIN itself).
pub const SUFFIX: &str = "p2p.internal";
/// The ephemeral event kind of every room's lookups (R3: clear of every kind the NIPs list;
/// docs/plans/networking-p2p.md §2).
pub const KIND: u32 = 26354;
/// A WireGuard handshake initiation's type and size.
const INITIATION: (u8, usize) = (1, 148);
/// A peer let in by a handshake alone is forgotten this long without data that decrypts.
const TRIAL: Duration = Duration::from_secs(20);
/// At most this many peers come in on trial a second by our call backs, and as many by handshakes
/// that came unasked (each budget its own, and an unasked one counted only once WireGuard answered it).
/// A forged lookup costs one initiation through one of the room's regions, and trials last
/// [`TRIAL`], so at most 320 at once (R3: 4 a second let only 25 of 200 dialers at once in within
/// 15 s, bench/net/REPORT.md "Rooms at scale").
const TRIALS_PER_SECOND: usize = 16;
/// Call backs past the budget wait for it, first come first served, at most this many (served
/// within 4 s, before the dialers give up), and are dropped beyond.
const MAX_CALLS_WAITING: usize = 4 * TRIALS_PER_SECOND;
const MAX_PEERS: usize = 1024;
/// A lookup goes out at once and again after these waits while no call back comes; the guest's
/// packets wait until [`LOOKUP_GIVE_UP`], then get an ICMPv6 address unreachable, as do its
/// packets to that address for [`UNREACHABLE_HOLD`] after.
const LOOKUP_AT: [Duration; 3] = [
    Duration::ZERO,
    Duration::from_secs(1),
    Duration::from_secs(3),
];
const LOOKUP_GIVE_UP: Duration = Duration::from_secs(6);
const UNREACHABLE_HOLD: Duration = Duration::from_secs(5);
const LOOKUP_QUEUE: usize = 16;
/// Events under our tags are opened (an X25519 and up to two decryptions each) at most this many
/// a second through each Nostr relay, and dropped past it: anyone who sees a lookup to a node (a
/// subscription to [`KIND`] without a tag sees them all) can publish junk under its tag. A budget
/// per relay, so junk through some of the link's relays doesn't keep out a lookup through the
/// others; an event's copies (the same content, through each relay) are opened and charged once,
/// remembered for [`OPENED_FOR`] (at most [`MAX_OPENED`]). Well above the call backs' budget, since
/// a dialer sends each lookup up to three times.
const LOOKUP_EVENTS_PER_SECOND: usize = 128;
const OPENED_FOR: Duration = Duration::from_secs(10);
const MAX_OPENED: usize = 8192;
/// A target drops lookups this much older (or newer) than its clock: the tags' window, as a
/// dialer's clock may be off by most of an hour (plan §3); a copy within it is dropped by its
/// nonce, remembered for twice as long (at most [`MAX_NONCES`]).
const LOOKUP_MAX_AGE: u64 = 3600;
const MAX_NONCES: usize = 8192;
/// The guest's lookups: at most this many waiting at once (more get ICMPv6 unreachable at once),
/// published at most this many a second (more wait for their resend), unreachable addresses
/// remembered at most this many.
const MAX_PENDING: usize = 64;
const LOOKUPS_PER_SECOND: usize = 8;
const MAX_UNREACHABLE: usize = 1024;
/// A trial peer's initiation is sent again through a lookup's region at most this often.
const INIT_AGAIN: Duration = Duration::from_millis(500);
/// A Nostr relay's subscription is renewed this often, and must answer it (EOSE) within
/// [`NOSTR_ANSWER`], or the connection is presumed dead; after a CLOSED, renewed after
/// [`NOSTR_RESUBSCRIBE`].
const NOSTR_CHECK: Duration = Duration::from_secs(60);
const NOSTR_ANSWER: Duration = Duration::from_secs(15);
const NOSTR_RESUBSCRIBE: Duration = Duration::from_secs(10);
/// A lookup from a key we have a peer for doesn't re-route it (a member could forge one): it
/// probes the session with a signalling ping, and only a peer that answers nothing in this long
/// (its page reloaded, say) is forgotten and called back afresh, in the lookup's region.
const PROBE: Duration = Duration::from_secs(4);
/// A peer we sent the guest's packets to and heard nothing from this long is forgotten (the next
/// packet looks it up again); one without the guests' traffic this long, too. Past two of
/// WireGuard's passive keepalives (each 9 to 11 s after the data it answers) with a margin, so
/// one-way traffic doesn't lose its peer to one lost keepalive.
const PEER_LOST: Duration = Duration::from_secs(30);
const PEER_IDLE: Duration = Duration::from_secs(180);
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
/// A channel we sent on with nothing back for this long has stalled: back to DERP. Past two of
/// WireGuard's passive keepalives (each 9 to 11 s after the data it answers), so one lost on the
/// unreliable channel doesn't count.
const RTC_STALL: Duration = Duration::from_secs(25);
/// A peer's new WebRTC connection comes at most this often (an answerer ignores new attempts
/// sooner; an offerer waits), so a member's signalling can't make the page set up connections as
/// fast as it sends; our own offers, all peers', at most [`RTC_NEW_PER_SECOND`] a second (an
/// answerer doesn't apply that: an ignored offer costs its offerer 40 s).
const RTC_GAP: Duration = Duration::from_secs(2);
const RTC_NEW_PER_SECOND: usize = 4;
/// The most WebRTC connections open at once; peers beyond go through DERP.
pub const MAX_RTC: usize = 64;
/// A channel without the guests' traffic this long is closed (the next packet offers again).
pub const RTC_IDLE: Duration = Duration::from_secs(60);
/// A region other than the home one is left this long after no peer needs it.
const REGION_IDLE: Duration = Duration::from_secs(60);
/// The home region is the first of the link's regions to answer a probe (a DERP WebSocket's
/// first frame, the server's key: the nearest, as all are probed at once); none in this long,
/// the configured one.
const PROBE_WAIT: Duration = Duration::from_secs(3);
/// A region in a lookup or a `hello`: a map region by its ID (below this), else one of the link's
/// own derpers as this plus its index. So members whose maps differ (one loaded before a region
/// went or came) still name the same region; a member that hasn't it drops the lookup.
const INLINE_REGION: u16 = 0x8000;
/// Packets for a region's relay before its connection is up.
const REGION_QUEUE: usize = 64;
/// How many signalling sequence numbers a peer's are remembered (to drop resent copies).
const SEEN: usize = 256;
/// A relay connection up this long worked: its loss reconnects at once.
const STABLE: Duration = Duration::from_secs(10);
/// The guest's flows (incoming off): forgotten this long idle; at most this many.
const FLOW_IDLE: Duration = Duration::from_secs(300);
const MAX_FLOWS: usize = 4096;
const MAX_KNOWN: usize = 4096;
/// tailcat's ULA /48, which no room's may be (the guest may be on tailcat beside it).
const TAILCAT_PREFIX: [u8; 6] = [0xfd, 0x7a, 0x11, 0x5c, 0xa1, 0xe0];

/// What a room's ID derives (plan §2): every member derives the same, nobody hands anything out.
#[derive(Debug, Clone, PartialEq)]
pub struct Room {
    /// The room's /48: `fd` and 40 bits of a hash (RFC 4193's form).
    pub prefix: [u8; 6],
    /// Those 40 bits in base32, for names.
    pub tag: String,
    /// The salt of the nodes' tags (lookup.rs).
    pub salt: [u8; 32],
    /// The key of lookups to a bare address (lookup.rs), mixed into sealed ones too.
    pub lookup: [u8; 32],
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

const B32: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";

/// RFC 4648's base32 alphabet, lower case, no padding.
pub fn base32(b: &[u8]) -> String {
    let (mut out, mut acc, mut bits) = (String::new(), 0u32, 0);
    for &x in b {
        acc = acc << 8 | x as u32;
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(B32[(acc >> bits & 31) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(B32[(acc << (5 - bits) & 31) as usize] as char);
    }
    out
}

/// [`base32`] read back: None unless `s` is exactly what it writes for some bytes.
pub fn unbase32(s: &str) -> Option<Vec<u8>> {
    let (mut out, mut acc, mut bits) = (Vec::new(), 0u32, 0);
    for c in s.bytes() {
        let v = B32.iter().position(|&a| a == c.to_ascii_lowercase())? as u32;
        acc = (acc << 5 | v) & 0xffff;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    (bits < 5 && acc & ((1 << bits) - 1) == 0).then_some(out)
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
            salt: hash("webpc room tag salt v1", id),
            lookup: hash("webpc room lookup key v1", id),
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

    /// The module's own address in the room, its resolver's: `<prefix>::53`.
    pub fn resolver(&self) -> [u8; 16] {
        let mut a = [0u8; 16];
        a[..6].copy_from_slice(&self.prefix);
        a[15] = 0x53;
        a
    }

    /// The names' domain: `<tag>.p2p.internal`.
    pub fn domain(&self) -> String {
        format!("{}.{SUFFIX}", self.tag)
    }

    /// A node's name: its key in base32, then the room's domain.
    pub fn name(&self, key: &[u8; 32]) -> String {
        format!("{}.{}", base32(key), self.domain())
    }
}

pub struct Config {
    pub link: Link,
    /// The node's private key; a fresh one when None.
    pub key: Option<[u8; 32]>,
    /// The home region: an index into the link's DERP regions; None: the first of them to
    /// answer a probe (the link's first if none does).
    pub home: Option<usize>,
    pub derp_map_url: String,
    /// Node keys known by hand (as names the resolver answered): lookups to them are sealed to them.
    pub known: Vec<[u8; 32]>,
    /// No WebRTC: everything through DERP, so no peer learns the node's IP address.
    pub relay_only: bool,
    /// Members may open connections to the guest (a handshake from a key we don't know).
    pub incoming: bool,
    /// The wall clock (Unix seconds) at the `now` [`Client::new`] gets; None: the system's.
    pub unix_time: Option<u64>,
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
    /// None. The offerer offers again at `next` (None: at the guests' next packet; the answerer
    /// waits for an offer).
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
    /// When its WireGuard last brought something (a handshake message, data).
    heard: Instant,
    /// When the guests last exchanged a packet through it (or it was let in).
    active: Instant,
    /// The guests exchanged a packet through it: only then is a direct path offered (a forged
    /// lookup makes a session between two members, and neither should learn the other's IP
    /// address unless a guest asked).
    spoke: bool,
    /// When we first sent it the guest's packets since it last brought data.
    waiting: Option<Instant>,
    /// When it was let in.
    added: Instant,
    /// Let in by a handshake or a lookup: on trial until its first data decrypts, forgotten
    /// [`TRIAL`] after it was let in without.
    trial: bool,
    /// Its data decrypted: the session (with the room's key) is confirmed both ways.
    confirmed: bool,
    hello_sent: bool,
    /// The region its packets go through (an index into the link's).
    via: usize,
    /// Its home region, from its hello.
    region: Option<usize>,
    /// A lookup came from its key: its session is probed until then, and called back in that
    /// region if nothing decrypts.
    probe: Option<(Instant, usize)>,
    /// Our signalling's epoch with it: random per peer, so a peer forgotten and made again looks
    /// like a restart to the other side, which resets what it knew of our sequence and attempts.
    epoch: u32,
    /// The last handshake initiation we sent it, and when (sent again through a lookup's region).
    init: Option<(Vec<u8>, Instant)>,
    /// Its signalling's epoch (a restart changes it) and the sequence numbers seen of it.
    nonce: Option<u32>,
    seen: BTreeSet<u32>,
    next_seq: u32,
    outbox: VecDeque<Out>,
    rtc: Rtc,
    /// The offerer's attempts so far (the answerer: the last one it took).
    attempt: u32,
    backoff: Duration,
    /// When we last made a WebRTC connection for it ([`RTC_GAP`]).
    rtc_made: Option<Instant>,
}

/// What signalling carries, as JSON inside the tunnel.
#[derive(Serialize, Deserialize, Debug, Default)]
struct Msg {
    /// The sender's epoch with us (random per peer it makes).
    n: u32,
    /// The message's sequence number (0: an acknowledgement, `a`).
    #[serde(default, skip_serializing_if = "is_zero")]
    s: u32,
    #[serde(default, skip_serializing_if = "is_zero")]
    a: u32,
    /// `hello`, `sig` (the page's description or candidate, `d`, of attempt `o`), `bye` (attempt
    /// `o` closed, or refused: the answerer has too many), `refuse` (relay only), `ping` (a
    /// probe: only its acknowledgement matters).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    t: String,
    #[serde(default, skip_serializing_if = "is_zero")]
    o: u32,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    d: String,
    /// hello: the home region (an index into the link's), and whether the sender is relay only.
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

/// One of the link's DERP regions, and our connection to it while it's in use.
/// A region's probe ([`Client::start_home`]), ranked: a region to fall back on or hand over to is
/// the best of these (after being allowed as home).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Probe {
    /// Closed, or not a DERP server.
    Failed,
    NotProbed,
    /// Sent, not answered.
    Pending,
    Answered,
}

impl Relay {
    fn new(r: &Region, now: Instant) -> Relay {
        Relay {
            nodes: match r {
                Region::Inline(n) => n.browser_url().into_iter().collect(),
                Region::Map(_) => Vec::new(),
            },
            map_id: match r {
                Region::Map(id) if *id != 0 => Some(*id),
                _ => None,
            },
            home_ok: true,
            probe: Probe::NotProbed,
            node: 0,
            conn: None,
            ready: None,
            failures: 0,
            reconnect_at: None,
            used: now,
            queue: Vec::new(),
        }
    }
}

struct Relay {
    /// Its nodes' URLs (from the map, for a region of it); empty: unusable.
    nodes: Vec<String>,
    /// A map region's ID (`Map(0)`'s once the map says it).
    map_id: Option<i64>,
    /// It may be home: not a region the map marks `Avoid` or `NoMeasureNoHome`.
    home_ok: bool,
    /// What its probe found, while the home region is chosen.
    probe: Probe,
    node: usize,
    conn: Option<(u32, derp::Conn)>,
    ready: Option<Instant>,
    failures: u32,
    reconnect_at: Option<Instant>,
    /// When something last needed it.
    used: Instant,
    /// Packets (to a key) before the connection is up.
    queue: Vec<([u8; 32], Vec<u8>)>,
}

/// One of the link's Nostr relays.
struct Nostr {
    url: String,
    conn: Option<u32>,
    /// Our subscription's ID on it.
    sub: Option<String>,
    failures: u32,
    reconnect_at: Option<Instant>,
    /// When to renew the subscription (or subscribe again after a CLOSED).
    check_at: Option<Instant>,
    /// The relay must answer our last REQ (EOSE) by then.
    answer_by: Option<Instant>,
}

/// A lookup the guest's packets wait on.
struct Pending {
    packets: VecDeque<Vec<u8>>,
    started: Instant,
    /// How many times it went out.
    sent: usize,
}

/// A flow of the guest's: the peer's address, the protocol, the peer's port and the guest's (an
/// ICMPv6 echo's identifier as both).
type Flow = ([u8; 16], u8, u16, u16);

pub struct Client {
    cfg: Config,
    room: Room,
    private: [u8; 32],
    public: [u8; 32],
    addr: [u8; 16],
    resolver: [u8; 16],
    wg: Endpoint,
    peers: BTreeMap<PeerId, Peer>,
    by_addr: BTreeMap<[u8; 16], PeerId>,
    next_peer: u32,
    next_rtc: u32,
    home: usize,
    relays: Vec<Relay>,
    /// The home region's probes while it is chosen: (connection, region), and until when.
    probes: Vec<(u32, usize)>,
    probe_until: Option<Instant>,
    /// The regions that were home before `Running` (one that fails then hands over to another).
    tried: Vec<usize>,
    nostr: Vec<Nostr>,
    author: nostr::Author,
    /// The clock: Unix seconds at `t0`.
    t0: Instant,
    unix0: u64,
    /// The hour our subscriptions are for.
    hour: u64,
    /// Node keys by address, to seal lookups to them.
    known: BTreeMap<[u8; 16], [u8; 32]>,
    pending: BTreeMap<[u8; 16], Pending>,
    unreachable: BTreeMap<[u8; 16], Instant>,
    /// Lookups' nonces seen, until they're too old to matter.
    nonces: BTreeSet<[u8; 16]>,
    /// The same, oldest first, for their expiry.
    nonce_order: VecDeque<([u8; 16], Instant)>,
    /// When the last call backs and unasked trials came in, and the last lookups went out.
    trials_out: VecDeque<Instant>,
    trials_in: VecDeque<Instant>,
    /// Call backs waiting for room in `trials_out`: the dialer's key and region.
    calls_waiting: VecDeque<([u8; 32], usize)>,
    /// When the last events under our tags were opened, through each Nostr relay, and the last
    /// WebRTC connections made.
    lookups_in: Vec<VecDeque<Instant>>,
    /// The events opened lately (a hash of the tag and content), to drop their copies; oldest first.
    opened: BTreeSet<[u8; 16]>,
    opened_order: VecDeque<([u8; 16], Instant)>,
    rtc_new: VecDeque<Instant>,
    published: VecDeque<Instant>,
    /// The DERP map is awaited.
    map_pending: bool,
    flows: BTreeMap<Flow, Instant>,
    next_conn: u32,
    state: State,
    actions: VecDeque<Action>,
}

fn random_u32() -> u32 {
    let mut n = [0u8; 4];
    let _ = getrandom::fill(&mut n);
    u32::from_le_bytes(n).max(1)
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|b| format!("{b:02x}")).collect()
}

fn b64() -> base64::engine::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

impl Client {
    pub fn new(cfg: Config, now: Instant) -> Result<Self, String> {
        let room = Room::derive(&cfg.link.id);
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
        let unix0 = cfg.unix_time.unwrap_or_else(|| {
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .map_or(0, |d| d.as_secs())
        });
        let relays = cfg.link.derp.iter().map(|r| Relay::new(r, now)).collect();
        let nostr = cfg
            .link
            .nostr
            .iter()
            .map(|url| Nostr {
                url: url.clone(),
                conn: None,
                sub: None,
                failures: 0,
                reconnect_at: None,
                check_at: None,
                answer_by: None,
            })
            .collect();
        let known = cfg
            .known
            .iter()
            .filter(|k| **k != public)
            .map(|k| (room.addr(k), *k))
            .collect();
        let mut c = Client {
            addr: room.addr(&public),
            resolver: room.resolver(),
            home: cfg.home.filter(|h| *h < cfg.link.derp.len()).unwrap_or(0),
            room,
            private,
            public,
            wg: Endpoint::new(pair),
            peers: BTreeMap::new(),
            by_addr: BTreeMap::new(),
            next_peer: 1,
            next_rtc: 1,
            relays,
            probes: Vec::new(),
            probe_until: None,
            tried: Vec::new(),
            nostr,
            author: nostr::Author::random()?,
            t0: now,
            unix0,
            hour: unix0 / 3600,
            known,
            pending: BTreeMap::new(),
            unreachable: BTreeMap::new(),
            nonces: BTreeSet::new(),
            nonce_order: VecDeque::new(),
            trials_out: VecDeque::new(),
            trials_in: VecDeque::new(),
            calls_waiting: VecDeque::new(),
            lookups_in: Vec::new(),
            opened: BTreeSet::new(),
            opened_order: VecDeque::new(),
            rtc_new: VecDeque::new(),
            published: VecDeque::new(),
            map_pending: false,
            flows: BTreeMap::new(),
            next_conn: 1,
            state: State::Connecting,
            actions: VecDeque::new(),
            cfg,
        };
        c.event(json!({
            "type": "self", "key": format!("nodekey:{}", hex(&public)), "address6": c.addr,
            "tag": c.room.tag, "name": c.room.name(&public), "link": c.cfg.link.encode(),
        }));
        for i in 0..c.nostr.len() {
            c.nostr_connect(i, now);
        }
        // The map first, when the home region is the map's or is to be chosen among regions some
        // of which are the map's; a configured home of the link's own connects at once.
        let wait_for_map = c.cfg.link.needs_map()
            && (c.configured().is_none() || matches!(c.cfg.link.derp[c.home], Region::Map(_)));
        if c.cfg.link.needs_map() {
            c.map_pending = true;
            c.actions.push_back(Action::Fetch {
                id: 1,
                url: c.cfg.derp_map_url.clone(),
            });
        }
        if wait_for_map {
            c.state = State::FetchingMap;
            c.state_event();
        } else if c.relays.iter().all(|g| g.nodes.is_empty()) {
            c.fail("no-browser-relay", "");
        } else {
            c.state_event();
            c.start_home(now);
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

    /// The wall clock, Unix seconds: the system's, read each time (a monotonic clock may stand
    /// still while the computer sleeps); the tests' from their `unix_time` and `now`.
    fn unix(&self, now: Instant) -> u64 {
        match self.cfg.unix_time {
            Some(_) => self.unix0 + now.saturating_duration_since(self.t0).as_secs(),
            None => SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .map_or(self.unix0, |d| d.as_secs()),
        }
    }

    fn set_running(&mut self) {
        if self.state == State::Running {
            return;
        }
        self.state = State::Running;
        self.state_event();
        let mut prefix = [0u8; 16];
        prefix[..6].copy_from_slice(&self.room.prefix);
        // No IPv4 routes: the room's /48 is all it reaches; its names, at the room's resolver.
        let lease = json!({
            "address": GUEST4, "address6": self.addr, "mtu": TUNNEL_MTU,
            "dns": [], "dns6": [self.resolver], "domains": [self.room.domain()],
            "prefix6": [prefix, 48],
        });
        self.event(json!({ "type": "lease", "lease": lease }));
    }

    fn fail(&mut self, code: &'static str, detail: &str) {
        self.close();
        self.event(json!({ "type": "state", "state": "Failed", "code": code, "detail": detail }));
    }

    // ---- DERP regions ----

    fn relay_close(&mut self, r: usize) {
        if let Some((conn, _)) = self.relays[r].conn.take() {
            self.actions.push_back(Action::WsClose { conn });
        }
    }

    fn relay_connect(&mut self, r: usize, now: Instant) {
        self.relay_close(r);
        let conn = self.next_conn;
        self.next_conn += 1;
        let (private, public, home) = (self.private, self.public, r == self.home);
        let g = &mut self.relays[r];
        g.reconnect_at = None;
        if g.nodes.is_empty() {
            return;
        }
        let url = g.nodes[g.node % g.nodes.len()].clone();
        g.conn = Some((conn, derp::Conn::new(private, public, home, now)));
        g.ready = None;
        self.actions.push_back(Action::WsOpen {
            conn,
            url,
            protocol: "derp",
        });
    }

    /// Whether region `r` is in use: the home one, one a peer is reached through, or one used lately.
    fn wanted(&self, r: usize, now: Instant) -> bool {
        r == self.home
            || self.peers.values().any(|p| p.via == r)
            || now.saturating_duration_since(self.relays[r].used) < REGION_IDLE
    }

    /// Lost region `r`'s relay: the next node, at once after one that was up, else after a backoff.
    fn relay_lost(&mut self, r: usize, now: Instant, why: String) {
        self.relay_close(r);
        let g = &mut self.relays[r];
        let was_up = g.ready.is_some();
        if g.ready
            .take()
            .is_some_and(|t| now.saturating_duration_since(t) >= STABLE)
        {
            g.failures = 0;
        }
        g.failures += 1;
        g.node += 1;
        let (failures, nodes) = (g.failures, g.nodes.len());
        let backoff = match failures {
            1 if was_up => Duration::ZERO,
            f => Duration::from_millis(250u64 << f.min(7)).min(Duration::from_secs(30)),
        };
        g.reconnect_at = Some(now + backoff);
        self.log(format!("DERP region {r}: {why}"));
        if r == self.home
            && self.state != State::Running
            && failures as usize > 2 * nodes.max(2)
            && !self.next_home(now)
        {
            self.fail("relay", &why);
        }
    }

    /// Sends `packet` to the node with key `dst` through region `r`, connecting to it if need be.
    fn relay_send(&mut self, r: usize, dst: &[u8; 32], packet: &[u8], now: Instant) {
        let g = &mut self.relays[r];
        g.used = now;
        match g.conn.as_mut() {
            Some((_, d)) if d.is_ready() => {
                d.send(dst, packet, now);
                return;
            }
            Some(_) => {}
            None if g.reconnect_at.is_none() => self.relay_connect(r, now),
            None => {}
        }
        let g = &mut self.relays[r];
        if g.queue.len() < REGION_QUEUE {
            g.queue.push((*dst, packet.to_vec()));
        }
    }

    fn flush_relays(&mut self) {
        for g in &mut self.relays {
            if let Some((conn, d)) = g.conn.as_mut() {
                queue_frames(&mut self.actions, *conn, d.take_output());
            }
        }
    }

    pub fn fetched(&mut self, id: u32, ok: bool, body: &[u8], now: Instant) {
        if id != 1 || !self.map_pending || self.state == State::Failed {
            return;
        }
        self.map_pending = false;
        let waiting = self.state == State::FetchingMap;
        let url = self.cfg.derp_map_url.clone();
        if !ok {
            self.log(format!(
                "the DERP map {url} didn't load: only the link's own derpers"
            ));
            // Waiting, what's usable starts (a configured home on the map is only a preference).
            if waiting && self.relays.iter().all(|g| g.nodes.is_empty()) {
                return self.fail("derp-map", &url);
            }
            if waiting {
                self.start(now);
            }
            return;
        }
        // A link without its own regions takes the map's, lowest ID first (at most
        // [`link::MAX_RELAYS`]); lookups and hellos name a map region by its ID.
        if self.cfg.link.default_derp && waiting {
            match tailcat::region_ids(body) {
                Ok(ids) if !ids.is_empty() => {
                    let derp: Vec<Region> = ids
                        .iter()
                        .take(link::MAX_RELAYS)
                        .map(|(id, _)| Region::Map(*id))
                        .collect();
                    self.relays = derp.iter().map(|r| Relay::new(r, now)).collect();
                    for (g, (_, home_ok)) in self.relays.iter_mut().zip(&ids) {
                        g.home_ok = *home_ok;
                    }
                    self.cfg.link.derp = derp;
                    self.home = self.configured().unwrap_or(0);
                }
                Ok(_) => return self.fail("derp-map-invalid", "the DERP map has no regions"),
                Err(e) => return self.fail("derp-map-invalid", &e),
            }
        }
        for r in 0..self.relays.len() {
            let Region::Map(id) = self.cfg.link.derp[r] else {
                continue;
            };
            match tailcat::region_nodes(body, id) {
                Ok((id, nodes)) => {
                    self.relays[r].map_id = Some(id);
                    self.relays[r].nodes = nodes
                        .iter()
                        .filter_map(tailcat::DerpNode::browser_url)
                        .collect();
                }
                // Not there: unusable, a configured home too (the others are chosen from).
                Err(e) => self.log(format!("DERP region {r}: {e}")),
            }
        }
        if waiting {
            self.start(now);
        }
    }

    /// The regions known (the map loaded, or not to be waited for): the home one is chosen and
    /// connects, or the client fails with none usable.
    fn start(&mut self, now: Instant) {
        if self.relays.iter().all(|g| g.nodes.is_empty()) {
            return self.fail("region-no-browser-relay", "");
        }
        self.state = State::Connecting;
        self.state_event();
        self.start_home(now);
    }

    /// Chooses the home region and connects it: the configured one, if usable; else, with several
    /// usable regions that may be home, a probe to each at once, the first to answer being home
    /// ([`PROBE_WAIT`]); else the first usable one.
    fn start_home(&mut self, now: Instant) {
        let usable: Vec<usize> = (0..self.relays.len())
            .filter(|r| !self.relays[*r].nodes.is_empty())
            .collect();
        if let Some(h) = self.configured().filter(|h| usable.contains(h)) {
            self.home = h;
            return self.connect_home(now);
        }
        let mut candidates: Vec<usize> = usable
            .iter()
            .copied()
            .filter(|r| self.relays[*r].home_ok)
            .collect();
        if candidates.is_empty() {
            candidates = usable;
        }
        self.home = candidates[0];
        if candidates.len() < 2 {
            return self.connect_home(now);
        }
        for r in candidates {
            self.relays[r].probe = Probe::Pending;
            let conn = self.next_conn;
            self.next_conn += 1;
            let url = self.relays[r].nodes[0].clone();
            self.actions.push_back(Action::WsOpen {
                conn,
                url,
                protocol: "derp",
            });
            self.probes.push((conn, r));
        }
        self.probe_until = Some(now + PROBE_WAIT);
    }

    fn connect_home(&mut self, now: Instant) {
        self.tried.push(self.home);
        self.relay_connect(self.home, now);
    }

    /// Ends the probes: none left open, no deadline.
    fn end_probes(&mut self) {
        for (conn, _) in std::mem::take(&mut self.probes) {
            self.actions.push_back(Action::WsClose { conn });
        }
        self.probe_until = None;
    }

    /// The home region is chosen (`r`; None: no probe answered, for `why`, and the first
    /// candidate is home): the probes close, and its relay connects.
    fn probed(&mut self, r: Option<usize>, why: &str, now: Instant) {
        self.end_probes();
        match r {
            Some(r) => {
                self.relays[r].probe = Probe::Answered;
                self.home = r;
            }
            None => {
                if let Some(b) = self.best_untried() {
                    self.home = b;
                }
                self.log(format!("DERP: {why}; home is region {}", self.home));
            }
        }
        self.connect_home(now);
    }

    /// Before `Running`, a home region that keeps failing hands over to the next usable one not
    /// tried (unless the home was configured): whether one took over.
    fn next_home(&mut self, now: Instant) -> bool {
        if self.configured() == Some(self.home) {
            return false;
        }
        let Some(r) = self.best_untried() else {
            return false;
        };
        let old = self.home;
        self.relay_close(old);
        self.relays[old].reconnect_at = None;
        self.log(format!(
            "DERP: region {old} keeps failing; home is region {r}"
        ));
        self.home = r;
        self.connect_home(now);
        true
    }

    /// The configured home, if the link has it (only a preference: an unusable one is chosen past).
    fn configured(&self) -> Option<usize> {
        self.cfg.home.filter(|h| *h < self.relays.len())
    }

    /// The usable region not yet home that's best to try: allowed as home first, then by what its
    /// probe found ([`Probe`]), then the link's order.
    fn best_untried(&self) -> Option<usize> {
        (0..self.relays.len())
            .filter(|r| !self.relays[*r].nodes.is_empty() && !self.tried.contains(r))
            .min_by_key(|r| {
                let g = &self.relays[*r];
                (!g.home_ok, std::cmp::Reverse(g.probe), *r)
            })
    }

    /// How lookups and hellos name region `r` ([`INLINE_REGION`]).
    fn wire_region(&self, r: usize) -> u16 {
        match self.relays[r].map_id {
            Some(id) if (1..INLINE_REGION as i64).contains(&id) => id as u16,
            _ => INLINE_REGION | r as u16,
        }
    }

    /// The region a lookup or hello names, if we have it and it's usable.
    fn local_region(&self, w: u16) -> Option<usize> {
        let r = if w & INLINE_REGION != 0 {
            Some((w & !INLINE_REGION) as usize).filter(|r| *r < self.relays.len())
        } else {
            // Two of the link's entries may name one map region: ours if it's home or connected.
            let ids: Vec<usize> = (0..self.relays.len())
                .filter(|r| self.relays[*r].map_id == Some(w as i64))
                .collect();
            ids.iter()
                .copied()
                .find(|r| *r == self.home)
                .or_else(|| ids.iter().copied().find(|r| self.relays[*r].conn.is_some()))
                .or_else(|| ids.first().copied())
        }?;
        (!self.relays[r].nodes.is_empty()).then_some(r)
    }

    // ---- WebSockets ----

    pub fn ws_closed(&mut self, conn: u32, now: Instant) {
        if self.state == State::Failed {
            return;
        }
        if let Some(k) = self.probes.iter().position(|(c, _)| *c == conn) {
            let (_, r) = self.probes.remove(k);
            self.relays[r].probe = Probe::Failed;
            if self.probes.is_empty() {
                self.probed(None, "every region's probe closed", now);
            }
        } else if let Some(r) = self.relay_of(conn) {
            self.relays[r].conn = None;
            self.relay_lost(r, now, "the connection closed".into());
        } else if let Some(i) = self.nostr.iter().position(|n| n.conn == Some(conn)) {
            self.nostr_lost(i, now);
        }
    }

    /// Nostr relay `i`'s connection is gone: again after a backoff (reset by an answered REQ).
    fn nostr_lost(&mut self, i: usize, now: Instant) {
        {
            let n = &mut self.nostr[i];
            if let Some(conn) = n.conn.take() {
                self.actions.push_back(Action::WsClose { conn });
            }
            n.sub = None;
            n.check_at = None;
            n.answer_by = None;
            n.failures += 1;
            let wait = Duration::from_secs(1u64 << n.failures.min(6)).min(Duration::from_secs(60));
            n.reconnect_at = Some(now + wait);
            let url = n.url.clone();
            self.log(format!(
                "Nostr: {url} closed; again in {} s",
                wait.as_secs()
            ));
        }
    }

    fn relay_of(&self, conn: u32) -> Option<usize> {
        self.relays
            .iter()
            .position(|g| g.conn.as_ref().is_some_and(|(c, _)| *c == conn))
    }

    pub fn ws_message(&mut self, conn: u32, data: &[u8], now: Instant) {
        if self.state == State::Failed {
            return;
        }
        if let Some(&(_, r)) = self.probes.iter().find(|(c, _)| *c == conn) {
            // A DERP server's key answers; anything else isn't a derper: that probe is done.
            if derp::is_server_key(data) {
                self.probed(Some(r), "", now);
            } else {
                self.log(format!("DERP region {r}: not a DERP server"));
                self.actions.push_back(Action::WsClose { conn });
                self.ws_closed(conn, now);
            }
        } else if let Some(r) = self.relay_of(conn) {
            let (_, d) = self.relays[r].conn.as_mut().unwrap();
            let events = d.input(data, now);
            self.flush_relays();
            match events {
                Err(e) => self.relay_lost(r, now, e),
                Ok(events) => {
                    for e in events {
                        self.derp_event(r, e, now);
                    }
                }
            }
        } else if let Some(i) = self.nostr.iter().position(|n| n.conn == Some(conn)) {
            match nostr::parse(data) {
                nostr::FromRelay::Event {
                    kind, x, content, ..
                } if kind == KIND => self.on_lookup(i, &x, &content, now),
                nostr::FromRelay::Eose(sub) if self.nostr[i].sub.as_ref() == Some(&sub) => {
                    // It answers: alive, and the backoff starts afresh.
                    let n = &mut self.nostr[i];
                    n.failures = 0;
                    n.answer_by = None;
                    n.check_at = Some(now + NOSTR_CHECK);
                }
                nostr::FromRelay::Closed(sub, why) if self.nostr[i].sub.as_ref() == Some(&sub) => {
                    let n = &mut self.nostr[i];
                    n.sub = None;
                    n.answer_by = None;
                    n.check_at = Some(now + NOSTR_RESUBSCRIBE);
                    let url = n.url.clone();
                    self.log(format!(
                        "Nostr: {url} closed our subscription ({why}); again in {} s",
                        NOSTR_RESUBSCRIBE.as_secs()
                    ));
                }
                nostr::FromRelay::Said(s) => {
                    let url = self.nostr[i].url.clone();
                    self.log(format!("Nostr: {url} {s}"));
                }
                _ => {}
            }
        }
    }

    fn derp_event(&mut self, r: usize, e: derp::Event, now: Instant) {
        match e {
            derp::Event::Ready => {
                let g = &mut self.relays[r];
                g.ready = Some(now);
                let queue = std::mem::take(&mut g.queue);
                if let Some((_, d)) = g.conn.as_mut() {
                    for (dst, p) in queue {
                        d.send(&dst, &p, now);
                    }
                }
                self.flush_relays();
                if r == self.home {
                    self.set_running();
                }
            }
            derp::Event::Recv { src, packet } => self.on_relay_packet(r, src, packet, now),
            derp::Event::Restarting { reconnect_ms } => {
                self.relay_close(r);
                self.relays[r].reconnect_at =
                    Some(now + Duration::from_millis(reconnect_ms.clamp(100, 30_000) as u64));
            }
            derp::Event::PeerGone(k) => {
                // The peer left this region: its home one, if it said, may reach it.
                if let Some(id) = self.wg.peer_id(NodePublicKey::from_bytes(k))
                    && let Some(p) = self.peers.get_mut(&id)
                    && p.via == r
                    && let Some(g) = p.region.filter(|g| *g != r)
                {
                    p.via = g;
                }
            }
            derp::Event::Health(h) if !h.is_empty() => {
                self.log(format!("DERP region {r} health: {h}"))
            }
            derp::Event::Health(_) => {}
        }
    }

    // ---- Nostr ----

    fn tags(&self) -> [String; 3] {
        let h = self.hour;
        [h.saturating_sub(1), h, h + 1].map(|h| self.room.tag_for(&self.addr, h))
    }

    fn nostr_send(&mut self, i: usize, text: String) {
        if let Some(conn) = self.nostr[i].conn {
            self.actions.push_back(Action::WsSend {
                conn,
                data: text.into_bytes(),
            });
        }
    }

    /// Subscribes to our tags on Nostr relay `i` (a REQ with the same ID renews it), to be
    /// answered within [`NOSTR_ANSWER`].
    /// The hour's tags are taken here, so a turned hour waits for a renewal.
    fn nostr_subscribe(&mut self, i: usize, now: Instant) {
        self.hour = self.unix(now) / 3600;
        let sub = format!("webpc{}", self.hour);
        if let Some(old) = self.nostr[i].sub.take()
            && old != sub
        {
            self.nostr_send(i, nostr::unsubscribe(&old));
        }
        let req = nostr::subscribe(&sub, KIND, &self.tags());
        self.nostr_send(i, req);
        let n = &mut self.nostr[i];
        n.sub = Some(sub);
        n.check_at = None;
        n.answer_by = Some(now + NOSTR_ANSWER);
    }

    /// Opens Nostr relay `i` (a plain WebSocket, text) and subscribes to our tags.
    fn nostr_connect(&mut self, i: usize, now: Instant) {
        let conn = self.next_conn;
        self.next_conn += 1;
        let n = &mut self.nostr[i];
        n.conn = Some(conn);
        n.reconnect_at = None;
        let url = n.url.clone();
        self.actions.push_back(Action::WsOpen {
            conn,
            url,
            protocol: "",
        });
        self.nostr_subscribe(i, now);
    }

    /// Publishes a lookup for `addr` on every relay of the link.
    fn publish_lookup(&mut self, addr: &[u8; 16], now: Instant) {
        if !Self::take(&mut self.published, LOOKUPS_PER_SECOND, now) {
            return; // a guest sweeping the /48: this one waits for its resend
        }
        let mut nonce = [0u8; 16];
        let _ = getrandom::fill(&mut nonce);
        let unix = self.unix(now);
        let l = Lookup {
            key: self.public,
            region: self.wire_region(self.home),
            time: unix,
            nonce,
        };
        let tag = self.room.tag_for(addr, unix / 3600);
        let content = b64().encode(l.seal(&self.room, self.known.get(addr), &tag));
        let text = nostr::publish(&self.author.event(KIND, &tag, &content, unix));
        for i in 0..self.nostr.len() {
            self.nostr_send(i, text.clone());
        }
    }

    /// An event under tag `x` through Nostr relay `i`: a lookup for us, if it opens, is called back.
    fn on_lookup(&mut self, i: usize, x: &str, content: &str, now: Instant) {
        if self.state != State::Running || !self.tags().iter().any(|t| t == x) {
            return;
        }
        // A copy of an event opened already (through another relay): dropped before the budget.
        let mut h = Blake2s256::new();
        h.update(x.as_bytes());
        h.update([0]);
        h.update(content.as_bytes());
        let seen: [u8; 16] = h.finalize()[..16].try_into().unwrap();
        while let Some(&(old, t)) = self.opened_order.front()
            && (now.saturating_duration_since(t) >= OPENED_FOR
                || self.opened_order.len() >= MAX_OPENED)
        {
            self.opened_order.pop_front();
            self.opened.remove(&old);
        }
        if self.opened.contains(&seen) {
            return;
        }
        if self.lookups_in.len() < self.nostr.len() {
            self.lookups_in.resize_with(self.nostr.len(), VecDeque::new);
        }
        if !Self::take(&mut self.lookups_in[i], LOOKUP_EVENTS_PER_SECOND, now) {
            return;
        }
        self.opened.insert(seen);
        self.opened_order.push_back((seen, now));
        let Ok(b) = b64().decode(content) else { return };
        let Some(l) = Lookup::open(&self.room, &self.private, &self.public, x, &b) else {
            return;
        };
        let unix = self.unix(now);
        let addr = self.room.addr(&l.key);
        let why = if l.key == self.public || addr == self.addr {
            Some("our own key")
        } else if unix.abs_diff(l.time) > LOOKUP_MAX_AGE {
            Some("too old")
        } else if self.nonces.contains(&l.nonce) {
            Some("seen")
        } else if self.local_region(l.region).is_none() {
            Some("a region outside the link")
        } else if !self.cfg.incoming && !self.has_flow(&addr, now) {
            Some("incoming connections are off")
        } else {
            None
        };
        if let Some(why) = why {
            return self.log(format!("lookup dropped: {why}"));
        }
        let Some(region) = self.local_region(l.region) else {
            return;
        };
        if self.nonce_order.len() >= MAX_NONCES
            && let Some((old, _)) = self.nonce_order.pop_front()
        {
            self.nonces.remove(&old);
        }
        self.nonces.insert(l.nonce);
        self.nonce_order.push_back((l.nonce, now));
        if let Some(&id) = self.by_addr.get(&addr) {
            let p = self.peers.get_mut(&id).unwrap();
            if p.key != l.key {
                return; // another key of that address
            }
            if !p.confirmed {
                // Our call back is on its way: its initiation goes through this region too (a
                // forged lookup may have named another; a lost initiation goes again).
                if let Some((init, at)) = p.init.clone()
                    && now.saturating_duration_since(at) >= INIT_AGAIN
                {
                    p.init = Some((init.clone(), now));
                    self.relay_send(region, &l.key, &init, now);
                    self.flush_relays();
                }
                return;
            }
            if p.probe.is_some() {
                return;
            }
            p.probe = Some((now + PROBE, region));
            return self.signal_at(id, "ping", 0, now);
        }
        if self.pending.contains_key(&addr) && self.public > l.key {
            // Each dials the other: only the lower key calls back (crossed handshakes would each
            // abandon its own for the other's, and neither complete); our lookup brings its call.
            return;
        }
        self.call_back(l.key, region, now);
    }

    /// Answers a lookup from `key`: our handshake through the dialer's home region `r`, or, past
    /// the budget, once it has room.
    fn call_back(&mut self, key: [u8; 32], r: usize, now: Instant) {
        if self.peers.len() >= MAX_PEERS {
            return self.log("lookup dropped: too many peers".into());
        }
        if !self.calls_waiting.is_empty()
            || !Self::take(&mut self.trials_out, TRIALS_PER_SECOND, now)
        {
            if let Some(w) = self.calls_waiting.iter_mut().find(|(k, _)| *k == key) {
                w.1 = r; // its latest lookup's region
            } else if self.calls_waiting.len() < MAX_CALLS_WAITING {
                self.calls_waiting.push_back((key, r));
            } else {
                self.log("lookup dropped: too many new peers".into());
            }
            return;
        }
        self.call_now(key, r, now);
    }

    /// A call back the budget has room for (taken).
    fn call_now(&mut self, key: [u8; 32], r: usize, now: Instant) {
        let id = self.add_peer(key, true, r, now);
        let r = self.wg.send(now, [(id, Vec::new())]);
        self.send_to_peers(r.to_peers, now);
        self.drain_pending(id, now); // the guest dialed it too
        // Our hello waits for the session, then is acknowledged and resent: the responder can't
        // send until data comes from us, and a lone keepalive lost would leave it unable to.
        self.hello(id, now);
    }

    /// The call backs that waited, as the budget has room (one that has a peer by now is done).
    fn serve_calls(&mut self, now: Instant) {
        while !self.calls_waiting.is_empty()
            && Self::room_in(&mut self.trials_out, TRIALS_PER_SECOND, now)
        {
            let (key, r) = self.calls_waiting.pop_front().unwrap();
            if self.peers.len() < MAX_PEERS && !self.peers.values().any(|p| p.key == key) {
                self.trials_out.push_back(now);
                self.call_now(key, r, now);
            }
        }
    }

    /// Whether `window` (times in the last second) has room for one more, under `max` a second.
    fn room_in(window: &mut VecDeque<Instant>, max: usize, now: Instant) -> bool {
        while window
            .front()
            .is_some_and(|t| now.saturating_duration_since(*t) >= Duration::from_secs(1))
        {
            window.pop_front();
        }
        window.len() < max
    }

    /// Takes a place in `window`, if it has room.
    fn take(window: &mut VecDeque<Instant>, max: usize, now: Instant) -> bool {
        let ok = Self::room_in(window, max, now);
        if ok {
            window.push_back(now);
        }
        ok
    }

    // ---- Peers ----

    /// A WireGuard peer for `key` (`trial`: let in by its handshake or our call back), reached
    /// through region `via`.
    fn add_peer(&mut self, key: [u8; 32], trial: bool, via: usize, now: Instant) -> PeerId {
        let id = PeerId(self.next_peer);
        self.next_peer += 1;
        self.wg.upsert_peer(PeerConfig::new(
            id,
            NodePublicKey::from_bytes(key),
            self.room.psk,
        ));
        let addr = self.room.addr(&key);
        self.peers.insert(
            id,
            Peer {
                key,
                addr,
                heard: now,
                active: now,
                spoke: false,
                waiting: None,
                added: now,
                trial,
                confirmed: false,
                hello_sent: false,
                via,
                region: None,
                probe: None,
                epoch: random_u32(),
                init: None,
                nonce: None,
                seen: BTreeSet::new(),
                next_seq: 1,
                outbox: VecDeque::new(),
                // The offerer offers at the guests' first packet (`touch`).
                rtc: match self.cfg.relay_only {
                    true => Rtc::Off,
                    false => Rtc::Idle { next: None },
                },
                attempt: 0,
                backoff: RTC_BACKOFF,
                rtc_made: None,
            },
        );
        self.by_addr.insert(addr, id);
        self.relays[via].used = now;
        id
    }

    fn forget(&mut self, id: PeerId) {
        // Its channel first: a `path` event after `peer-gone` would bring it back in a list of peers.
        self.close_rtc(id, None);
        if self.peers.get(&id).is_some_and(|p| p.confirmed) {
            self.peer_event(id, "peer-gone");
        }
        self.wg.remove_peer(id);
        if let Some(p) = self.peers.remove(&id) {
            self.by_addr.remove(&p.addr);
        }
    }

    fn peer_event(&mut self, id: PeerId, kind: &str) {
        let Some(p) = self.peers.get(&id) else { return };
        let v = json!({
            "type": kind, "key": format!("nodekey:{}", hex(&p.key)), "address6": p.addr,
            "name": self.room.name(&p.key),
        });
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

    fn on_relay_packet(&mut self, r: usize, src: [u8; 32], packet: Vec<u8>, now: Instant) {
        let known = self.wg.peer_id(NodePublicKey::from_bytes(src));
        let id = match known {
            Some(id) => {
                // DERP proves the sender's key: where its packets come from reaches it (our
                // response to its new initiation, say, goes back the way it came).
                if let Some(p) = self.peers.get_mut(&id) {
                    p.via = r;
                }
                id
            }
            None => {
                if src == self.public
                    || packet.first() != Some(&INITIATION.0)
                    || packet.len() != INITIATION.1
                {
                    return;
                }
                // A member we don't know calls: the one a lookup of ours waits on, or (incoming
                // on, or a flow of the guest's with it) one that opens a connection, on trial.
                let addr = self.room.addr(&src);
                let expected = self.pending.contains_key(&addr);
                if !expected && !(self.cfg.incoming || self.has_flow(&addr, now)) {
                    return;
                }
                // An unasked one takes a place only once WireGuard answered it (its MAC checked,
                // its handshake one we could respond to): junk can't use up the budget.
                if (!expected && !Self::room_in(&mut self.trials_in, TRIALS_PER_SECOND, now))
                    || self.peers.len() >= MAX_PEERS
                {
                    return;
                }
                let id = self.add_peer(src, true, r, now);
                self.peer_packet(id, true, packet, now);
                if self.peers.contains_key(&id) {
                    if !expected {
                        self.trials_in.push_back(now);
                    }
                    self.drain_pending(id, now);
                }
                return;
            }
        };
        self.peer_packet(id, false, packet, now);
    }

    /// The guest's packets that waited on a lookup for peer `id`'s address go into its session
    /// (WireGuard sends them once it's confirmed); the lookup ends once the peer is confirmed.
    fn drain_pending(&mut self, id: PeerId, now: Instant) {
        let Some(p) = self.peers.get(&id) else {
            return;
        };
        let (addr, key, confirmed) = (p.addr, p.key, p.confirmed);
        let Some(w) = self.pending.get_mut(&addr) else {
            return;
        };
        let packets = std::mem::take(&mut w.packets);
        if confirmed {
            self.pending.remove(&addr);
        }
        self.learn(addr, key);
        for pkt in packets {
            self.send_guest(id, pkt, now);
        }
    }

    fn learn(&mut self, addr: [u8; 16], key: [u8; 32]) {
        if self.known.len() >= MAX_KNOWN && !self.known.contains_key(&addr) {
            self.known.pop_first();
        }
        self.known.insert(addr, key);
    }

    /// A WireGuard packet from peer `id` (through a relay or over its channel).
    fn peer_packet(&mut self, id: PeerId, new: bool, packet: Vec<u8>, now: Instant) {
        let r = self.wg.recv(now, [PacketMut::from(packet)]);
        if new && r.to_peers.is_empty() {
            // Not a handshake it could start: not let in.
            return self.forget(id);
        }
        if let Some(p) = self.peers.get_mut(&id)
            && (!r.to_peers.is_empty() || !r.to_local.is_empty())
        {
            p.heard = now;
            if !r.to_local.is_empty() {
                p.waiting = None;
                p.probe = None;
            }
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
        self.drain_pending(id, now);
        self.peer_event(id, "peer");
        self.hello(id, now);
    }

    fn hello(&mut self, id: PeerId, now: Instant) {
        let (region, relay_only) = (self.wire_region(self.home) as i64, self.cfg.relay_only);
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
        let Some(p) = self.peers.get_mut(&id) else {
            return;
        };
        m.n = p.epoch;
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
        let src = peer.addr;
        if !self.cfg.incoming && !self.reply_allowed(&src, &info, now) {
            return; // not a reply to a flow of the guest's
        }
        self.touch(from, now);
        self.actions.push_back(Action::ToGuest(p.to_vec()));
    }

    /// The guests exchanged a packet through peer `id`: its channel isn't idle; the offerer offers
    /// one if it has none.
    fn touch(&mut self, id: PeerId, now: Instant) {
        let public = self.public;
        let Some(p) = self.peers.get_mut(&id) else {
            return;
        };
        p.active = now;
        p.spoke = true;
        if p.rtc == (Rtc::Idle { next: None }) && public < p.key {
            p.rtc = Rtc::Idle { next: Some(now) };
        }
    }

    // ---- The guest's flows (incoming off) ----

    fn has_flow(&self, addr: &[u8; 16], now: Instant) -> bool {
        self.flows
            .range((*addr, 0, 0, 0)..=(*addr, u8::MAX, u16::MAX, u16::MAX))
            .any(|(_, t)| now.saturating_duration_since(*t) < FLOW_IDLE)
    }

    /// The guest's packet `info` to a peer: a flow whose replies come in.
    fn note_flow(&mut self, dst: [u8; 16], info: &ip::Info, now: Instant) {
        let key = match (info.proto, info.icmp_type) {
            (ip::TCP | ip::UDP, _) => (dst, info.proto, info.dport, info.sport),
            (ip::ICMP6, Some(128)) => (dst, ip::ICMP6, info.sport, info.sport),
            _ => return,
        };
        if self.flows.len() >= MAX_FLOWS && !self.flows.contains_key(&key) {
            self.flows
                .retain(|_, t| now.saturating_duration_since(*t) < FLOW_IDLE);
            if self.flows.len() >= MAX_FLOWS
                && let Some(oldest) = self.flows.iter().min_by_key(|(_, t)| **t).map(|(k, _)| *k)
            {
                self.flows.remove(&oldest);
            }
        }
        self.flows.insert(key, now);
    }

    /// Whether a peer's packet `info` from `src` answers a flow of the guest's.
    fn reply_allowed(&mut self, src: &[u8; 16], info: &ip::Info, now: Instant) -> bool {
        let key = match (info.proto, info.icmp_type) {
            (ip::TCP | ip::UDP, _) => (*src, info.proto, info.sport, info.dport),
            (ip::ICMP6, Some(129)) => (*src, ip::ICMP6, info.sport, info.sport),
            // An error about the guest's traffic to it.
            (ip::ICMP6, Some(t)) if t < 128 => return self.has_flow(src, now),
            _ => return false,
        };
        match self.flows.get_mut(&key) {
            Some(t) if now.saturating_duration_since(*t) < FLOW_IDLE => {
                *t = now;
                true
            }
            _ => false,
        }
    }

    // ---- Signalling ----

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
                // offer again at once, if the guests spoke.
                let (public, relay_only) = (self.public, self.cfg.relay_only);
                let p = self.peers.get_mut(&id).unwrap();
                p.backoff = RTC_BACKOFF;
                p.rtc = match relay_only {
                    true => Rtc::Off,
                    false => Rtc::Idle {
                        next: (public < p.key && p.spoke).then_some(now),
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
                let region =
                    m.g.and_then(|g| u16::try_from(g).ok())
                        .and_then(|g| self.local_region(g));
                let p = self.peers.get_mut(&id).unwrap();
                p.region = region;
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
                    // An attempt that never opened failed; an open channel the peer closed (idle,
                    // stalled) is offered again at the guests' next packet.
                    let failed = matches!(self.peers[&id].rtc, Rtc::Connecting { .. });
                    self.close_rtc(id, None);
                    match failed {
                        true => self.idle(id, now, true),
                        false => {
                            let p = self.peers.get_mut(&id).unwrap();
                            if p.rtc != Rtc::Off {
                                p.rtc = Rtc::Idle { next: None };
                            }
                        }
                    }
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

    /// How many WebRTC connections are set up or open.
    fn rtc_count(&self) -> usize {
        self.peers
            .values()
            .filter(|p| matches!(p.rtc, Rtc::Connecting { .. } | Rtc::Open { .. }))
            .count()
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
        if self.peers[&id].rtc_made.is_some_and(|t| now < t + RTC_GAP) {
            return; // too soon: the offerer's attempt runs out and it backs off
        }
        self.close_rtc(id, None);
        self.peers.get_mut(&id).unwrap().attempt = o;
        if self.rtc_count() >= MAX_RTC {
            // Too many: the offerer backs off, its packets go through DERP.
            return self.signal_at(id, "bye", o, now);
        }
        // A new offer: the page answers it on a new connection.
        self.rtc_made(id, now);
        let rtc = self.next_rtc;
        self.next_rtc += 1;
        self.peers.get_mut(&id).unwrap().rtc = Rtc::Connecting {
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

    /// When a new WebRTC connection for peer `id` may be made, if not now ([`RTC_GAP`],
    /// [`RTC_NEW_PER_SECOND`]).
    fn rtc_wait(&mut self, id: PeerId, now: Instant) -> Option<Instant> {
        let gap = self.peers[&id]
            .rtc_made
            .map(|t| t + RTC_GAP)
            .filter(|t| *t > now);
        let all = (!Self::room_in(&mut self.rtc_new, RTC_NEW_PER_SECOND, now))
            .then(|| self.rtc_new.front().map(|t| *t + Duration::from_secs(1)))
            .flatten();
        gap.max(all)
    }

    fn rtc_made(&mut self, id: PeerId, now: Instant) {
        self.peers.get_mut(&id).unwrap().rtc_made = Some(now);
        self.rtc_new.push_back(now);
    }

    fn offer(&mut self, id: PeerId, now: Instant) {
        if let Some(t) = self.rtc_wait(id, now) {
            self.peers.get_mut(&id).unwrap().rtc = Rtc::Idle { next: Some(t) };
            return;
        }
        self.rtc_made(id, now);
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

    /// Sends WireGuard's packets: on a peer's data channel when it's open, else through the relay
    /// of its region.
    fn send_to_peers(
        &mut self,
        to_peers: impl IntoIterator<Item = (PeerId, Vec<PacketMut>)>,
        now: Instant,
    ) {
        for (id, packets) in to_peers {
            let Some(p) = self.peers.get_mut(&id) else {
                continue;
            };
            let (key, via) = (p.key, p.via);
            if let Some(init) = packets
                .iter()
                .rev()
                .find(|k| k.as_ref().first() == Some(&INITIATION.0))
            {
                p.init = Some((init.as_ref().to_vec(), now));
            }
            // Handshake messages (initiation, response, cookie reply) always go through the relay:
            // they're rare, and a peer that restarted has no channel to take ours.
            let (packets, relayed): (Vec<_>, Vec<_>) = packets
                .into_iter()
                .partition(|pkt| !matches!(pkt.as_ref().first(), Some(1..=3)));
            let relayed = match &mut p.rtc {
                Rtc::Open {
                    id: rtc,
                    unanswered,
                    ..
                } => {
                    if !packets.is_empty() {
                        unanswered.get_or_insert(now);
                    }
                    for pkt in packets {
                        self.actions.push_back(Action::RtcSend {
                            rtc: *rtc,
                            data: pkt.as_ref().to_vec(),
                        });
                    }
                    relayed
                }
                _ => relayed.into_iter().chain(packets).collect(),
            };
            for pkt in relayed {
                self.relay_send(via, &key, pkt.as_ref(), now);
            }
        }
        self.flush_relays();
    }

    /// The guest's packet `pkt` (an IPv6 packet from its room address) to peer `id`.
    fn send_guest(&mut self, id: PeerId, mut pkt: Vec<u8>, now: Instant) {
        pad(&mut pkt);
        if let Some(p) = self.peers.get_mut(&id) {
            p.waiting.get_or_insert(now);
        }
        self.touch(id, now);
        let r = self.wg.send(now, [(id, vec![PacketMut::from(pkt)])]);
        self.send_to_peers(r.to_peers, now);
    }

    /// An ICMPv6 address unreachable for the guest's packet `p`, from the room's resolver address.
    fn send_unreachable(&mut self, p: &[u8]) {
        let mut body = vec![0u8; 4];
        body.extend_from_slice(&p[..p.len().min(TUNNEL_MTU - 48)]);
        let m = ip::icmp6(self.resolver.into(), self.addr.into(), 1, 3, &body);
        self.actions.push_back(Action::ToGuest(m));
    }

    /// The guest's DNS query `p` to the room's resolver: a name is a key, its address computed.
    fn resolve(&mut self, p: &[u8], info: &ip::Info) {
        let Some(m) = ip::udp_payload(p, info) else {
            return;
        };
        let Some(q) = dns::parse(m) else { return };
        let key = q
            .name
            .strip_suffix(&self.room.domain())
            .and_then(|s| s.strip_suffix('.'))
            .filter(|k| k.len() == 52)
            .and_then(unbase32)
            .and_then(|k| <[u8; 32]>::try_from(k).ok());
        let (rcode, addrs) = match key {
            Some(k) => {
                let a = self.room.addr(&k);
                if k != self.public {
                    self.learn(a, k);
                }
                (dns::NOERROR, vec![IpAddr::V6(a.into())])
            }
            None => (dns::NXDOMAIN, Vec::new()),
        };
        let answer = dns::fit(&dns::answer(m, &q, rcode, &addrs, 3600), q.udp_size);
        let r = ip::udp(
            (IpAddr::V6(self.resolver.into()), 53),
            (IpAddr::V6(self.addr.into()), info.sport),
            &answer,
        );
        self.actions.push_back(Action::ToGuest(r));
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
        if dst == self.resolver {
            if info.proto == ip::UDP && info.dport == 53 {
                self.resolve(p, &info);
            }
            return;
        }
        if !self.room.contains(&dst) || dst == self.addr {
            return;
        }
        if !self.cfg.incoming {
            self.note_flow(dst, &info, now);
        }
        if let Some(&id) = self.by_addr.get(&dst) {
            let confirmed = self.peers[&id].confirmed;
            self.send_guest(id, p.to_vec(), now);
            // A peer a lookup made (perhaps forged, naming a region it isn't on) doesn't stand in
            // for our own: until its session is confirmed, ours goes out too.
            if !confirmed && !self.pending.contains_key(&dst) && self.pending.len() < MAX_PENDING {
                self.start_lookup(dst, VecDeque::new(), now);
            }
            return;
        }
        // Nobody by that address yet: look it up, the packet waits.
        if let Some(w) = self.pending.get_mut(&dst) {
            if w.packets.len() < LOOKUP_QUEUE {
                w.packets.push_back(p.to_vec());
            }
            return;
        }
        if self.unreachable.get(&dst).is_some_and(|t| *t > now) || self.pending.len() >= MAX_PENDING
        {
            return self.send_unreachable(p);
        }
        self.unreachable.remove(&dst);
        self.start_lookup(dst, VecDeque::from([p.to_vec()]), now);
    }

    fn start_lookup(&mut self, dst: [u8; 16], packets: VecDeque<Vec<u8>>, now: Instant) {
        self.pending.insert(
            dst,
            Pending {
                packets,
                started: now,
                sent: 1,
            },
        );
        self.publish_lookup(&dst, now);
    }

    pub fn tick(&mut self, now: Instant) {
        if self.state == State::Failed {
            return;
        }
        if self.probe_until.is_some_and(|t| t <= now) {
            let why = format!("no region answered in {} s", PROBE_WAIT.as_secs());
            self.probed(None, &why, now);
        }
        let r = self.wg.dispatch_events(now);
        self.send_to_peers(r.to_peers, now);
        let running = self.state == State::Running;
        self.serve_calls(now);
        // The hour's turn waits for each relay's next renewal (within [`NOSTR_CHECK`]): the
        // subscription has the next hour's tags already, and every member renewing at the same
        // second would hit the relays at once (R3: a thousand REQs and CLOSEs in one second).
        for i in 0..self.nostr.len() {
            let n = &self.nostr[i];
            if n.reconnect_at.is_some_and(|t| t <= now) {
                self.nostr_connect(i, now);
            } else if n.answer_by.is_some_and(|t| t <= now) {
                let url = n.url.clone();
                self.log(format!("Nostr: {url} didn't answer"));
                self.nostr_lost(i, now);
            } else if n.conn.is_some() && n.check_at.is_some_and(|t| t <= now) {
                self.nostr_subscribe(i, now);
            }
        }
        // Lookups: resent, then given up.
        let due: Vec<[u8; 16]> = self
            .pending
            .iter()
            .filter(|(_, w)| self.lookup_due(w).is_some_and(|t| t <= now))
            .map(|(a, _)| *a)
            .collect();
        for addr in due {
            let w = self.pending.get_mut(&addr).unwrap();
            if w.sent < LOOKUP_AT.len() {
                w.sent += 1;
                self.publish_lookup(&addr, now);
            } else {
                let w = self.pending.remove(&addr).unwrap();
                if self.by_addr.contains_key(&addr) {
                    continue; // a peer of that address is still on its way: its packets went in
                }
                self.log(format!("lookup: no answer from {}", Ipv6Addr::from(addr)));
                if self.unreachable.len() >= MAX_UNREACHABLE {
                    self.unreachable.pop_first();
                }
                self.unreachable.insert(addr, now + UNREACHABLE_HOLD);
                for p in w.packets {
                    self.send_unreachable(&p);
                }
            }
        }
        self.unreachable.retain(|_, t| *t > now);
        while let Some(&(old, t)) = self.nonce_order.front()
            && now.saturating_duration_since(t) >= Duration::from_secs(3 * LOOKUP_MAX_AGE)
        {
            self.nonce_order.pop_front();
            self.nonces.remove(&old);
        }
        let ids: Vec<PeerId> = self.peers.keys().copied().collect();
        for id in ids {
            let Some(p) = self.peers.get_mut(&id) else {
                continue;
            };
            if p.trial && now.saturating_duration_since(p.added) >= TRIAL
                || p.waiting
                    .is_some_and(|t| now.saturating_duration_since(t) >= PEER_LOST)
                || now.saturating_duration_since(p.active) >= PEER_IDLE
            {
                self.forget(id);
                continue;
            }
            if let Some((t, r)) = p.probe
                && t <= now
            {
                // Its session answered nothing: a new instance of that key called.
                let key = p.key;
                self.forget(id);
                self.call_back(key, r, now);
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
            let (confirmed, rtc, active) = (p.confirmed, p.rtc, p.active);
            let idle = now.saturating_duration_since(active) >= RTC_IDLE;
            for b in resend {
                self.send_signal(id, &b, now);
            }
            match rtc {
                Rtc::Idle { next: Some(t) } if confirmed && t <= now && running => {
                    if idle || self.rtc_count() >= MAX_RTC {
                        // Nothing to carry, or no room: at the guests' next packet.
                        self.peers.get_mut(&id).unwrap().rtc = Rtc::Idle { next: None };
                    } else {
                        self.offer(id, now)
                    }
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
                Rtc::Open { .. } if idle => {
                    self.close_rtc(id, Some(now));
                    // The guests' next packet offers again.
                    self.peers.get_mut(&id).unwrap().rtc = Rtc::Idle { next: None };
                }
                _ => {}
            }
        }
        for r in 0..self.relays.len() {
            let wanted = self.wanted(r, now);
            let g = &mut self.relays[r];
            if !wanted {
                g.reconnect_at = None;
                g.queue.clear();
                g.failures = 0;
                if g.conn.is_some() {
                    self.relay_close(r);
                }
                continue;
            }
            if let Some((_, d)) = g.conn.as_mut()
                && let Err(e) = d.tick(now)
            {
                self.relay_lost(r, now, e);
            }
            if self.relays[r].reconnect_at.is_some_and(|t| t <= now) && self.state != State::Failed
            {
                self.relay_connect(r, now);
            }
        }
        self.flush_relays();
    }

    fn lookup_due(&self, w: &Pending) -> Option<Instant> {
        Some(match LOOKUP_AT.get(w.sent) {
            Some(d) => w.started + *d,
            None => w.started + LOOKUP_GIVE_UP,
        })
    }

    pub fn deadline(&self) -> Option<Instant> {
        if self.state == State::Failed {
            return None; // closed: nothing comes back
        }
        let running = self.state == State::Running;
        let peers = self.peers.values().flat_map(|p| {
            [
                p.trial.then(|| p.added + TRIAL),
                p.waiting.map(|t| t + PEER_LOST),
                p.probe.map(|(t, _)| t),
                Some(p.active + PEER_IDLE),
                p.outbox.iter().map(|o| o.at).min(),
                match p.rtc {
                    Rtc::Idle { next } if p.confirmed && running => next,
                    Rtc::Connecting { since, .. } => Some(since + RTC_CONNECT),
                    Rtc::Open { unanswered, .. } => {
                        Some(unanswered.map_or(p.active + RTC_IDLE, |t| {
                            (t + RTC_STALL).min(p.active + RTC_IDLE)
                        }))
                    }
                    _ => None,
                },
            ]
        });
        let relays = self.relays.iter().enumerate().flat_map(|(r, g)| {
            let idle =
                g.conn.is_some() && r != self.home && !self.peers.values().any(|p| p.via == r);
            [
                g.conn.as_ref().and_then(|(_, d)| d.deadline()),
                g.reconnect_at,
                idle.then(|| g.used + REGION_IDLE),
            ]
        });
        let calls = (!self.calls_waiting.is_empty())
            .then(|| self.trials_out.front().map(|t| *t + Duration::from_secs(1)))
            .flatten();
        [
            self.wg.next_event().map(|r| r.start()),
            calls,
            self.probe_until,
        ]
        .into_iter()
        .chain(peers)
        .chain(relays)
        .chain(
            self.nostr
                .iter()
                .flat_map(|n| [n.reconnect_at, n.answer_by, n.check_at]),
        )
        .chain(self.pending.values().map(|w| self.lookup_due(w)))
        .flatten()
        .min()
    }

    pub fn poll(&mut self) -> Option<Action> {
        self.actions.pop_front()
    }

    pub fn close(&mut self) {
        self.end_probes();
        let ids: Vec<PeerId> = self.peers.keys().copied().collect();
        for id in ids {
            self.close_rtc(id, None);
        }
        for r in 0..self.relays.len() {
            self.relay_close(r);
            self.relays[r].reconnect_at = None;
        }
        for n in &mut self.nostr {
            if let Some(conn) = n.conn.take() {
                self.actions.push_back(Action::WsClose { conn });
            }
            n.reconnect_at = None;
            n.answer_by = None;
            n.check_at = None;
            n.sub = None;
        }
        self.pending.clear();
        self.state = State::Failed;
    }
}

#[cfg(test)]
mod tests;
