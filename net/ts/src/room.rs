//! A room's client (docs/networking/rooms.md), sans I/O: VMs in
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
//!   and remembers the key, so lookups to it are sealed to it; every name also under the room's name
//!   (`<key>.<room ID>.p2p.internal`) when the ID is a label that doesn't look derived ([`room_label`]).
//! - **Incoming connections** (on by default): a member we don't know may call us. Off, only the
//!   guest's own flows get their replies, and lookups for it go unanswered unless it has a flow
//!   with the dialer.
//! - **Names** ([`names`], docs/plans/room-names.md "The registry"): a node that holds titles is a
//!   server. Its registry traffic goes through a **names client**: a second `Client` in the same
//!   worker, under a key made new each session, relay only, with no guest, its own DERP and Nostr
//!   connections ([`NAMES_CONN`] up), subscribed to the room's names tag, letting in handshakes only
//!   while its own question is open, and carrying registry datagrams on [`names::wire::NAMES_PORT`]
//!   ([`NamesHost`]). The node's own key carries none of it. Any other node is a member: its guest's
//!   query for a name that isn't a key starts a names client of its own, which asks servers for that
//!   name ([`names::member`], [`MemberHost`]) and closes after [`names::member::IDLE`] without one.
//! - **The resolver** answers a registered name (`<name>.<tag>.p2p.internal`, or a label under it) after
//!   the key names: from what the member keeps (TTL 60), its own pending name with its own address, or
//!   once the names client hears; SERVFAIL after [`DNS_WAIT`]; NXDOMAIN at once for a reserved or
//!   ill-formed name, a name both servers lack, and while nobody serves.

pub mod link;
pub mod lookup;
pub mod names;

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
use self::{
    lookup::Lookup,
    names::{
        Params,
        member::{self, Answer, Member},
        server::{Cmd, Input, Server},
        wire::{ASK_SIZE, NAMES_PORT, NameAsk, QUESTION_SIZE, Question, REPLY_SEALED_MAX, Reply},
    },
};
use crate::{
    client::{Action, GUEST4, pad, queue_frames, unpad},
    derp, dns, ip, nostr, tailcat,
};

const TUNNEL_MTU: usize = 1280;
/// The UDP port signalling uses between two nodes' addresses, both ends. The module keeps it:
/// the guest's packets to or from it are dropped.
pub const SIGNAL_PORT: u16 = 1;
/// The names' suffix under the room's tag: `.internal`, which ICANN reserved for private use and
/// never delegates (docs/networking/rooms.md "Findings": systemd-resolved answers RFC 9476's `.alt` NXDOMAIN itself).
pub const SUFFIX: &str = "p2p.internal";
/// The ephemeral event kind of every room's lookups (R3: clear of every kind the NIPs list;
/// docs/networking/rooms.md "The room and its names").
pub const KIND: u32 = 26354;
/// A WireGuard handshake initiation's type and size.
const INITIATION: (u8, usize) = (1, 148);

fn is_initiation(p: &[u8]) -> bool {
    p.first() == Some(&INITIATION.0) && p.len() == INITIATION.1
}

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
/// A server's reply to an ask goes through the relay that brought the ask and the one whose copy came next; with no
/// copy this long after the reply, through another relay (room-names-r3.md: replies through two relays).
const REPLY_SECOND_WAIT: Duration = Duration::from_secs(1);
/// An ask's copies are remembered this long.
const ASK_COPIES_FOR: Duration = Duration::from_secs(5);
const MAX_OPENED: usize = 8192;
/// A target drops lookups this much older (or newer) than its clock: the tags' window, as a
/// dialer's clock may be off by most of an hour (rooms.md "Finding a peer"); a copy within it is dropped by its
/// nonce, remembered for twice as long (at most [`MAX_NONCES`]).
const LOOKUP_MAX_AGE: u64 = 3600;
const MAX_NONCES: usize = 8192;
/// The guest's lookups: at most this many waiting at once (more get ICMPv6 unreachable at once),
/// published at most this many a second (more wait for room, first sends before resends; one is
/// given up [`LOOKUP_GIVE_UP`] after its first send), unreachable addresses remembered at most
/// this many.
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
/// A names client's WebSocket connections are numbered from here, so the worker's one set of
/// connection numbers routes to the node or to its names client.
pub const NAMES_CONN: u32 = 0x4000_0000;
/// A names client that failed is made again after this long.
const NAMES_RETRY: Duration = Duration::from_secs(60);
/// A query for a name the member doesn't know waits this long for its names client (finding servers takes 1 to 3 s on
/// public relays, room-names.md "The resolver"), then gets SERVFAIL (a guest's resolver asks again).
pub const DNS_WAIT: Duration = Duration::from_secs(4);
/// Queries waiting at once; past it, SERVFAIL at once.
const MAX_DNS_WAITING: usize = 64;
/// A registered name's answer's TTL: a zone change or a lost name shows within a minute of the member's knowing.
const NAME_TTL: u32 = 60;
/// tailcat's ULA /48, which no room's may be (the guest may be on tailcat beside it).
const TAILCAT_PREFIX: [u8; 6] = [0xfd, 0x7a, 0x11, 0x5c, 0xa1, 0xe0];

/// What a room's ID derives (rooms.md "The room and its names"): every member derives the same,
/// nobody hands anything out.
#[derive(Debug, Clone, PartialEq)]
pub struct Room {
    /// The room's /48: `fd` and 40 bits of a hash (RFC 4193's form).
    pub prefix: [u8; 6],
    /// Those 40 bits in base32, for names.
    pub tag: String,
    /// The room's ID as a DNS label, when it gets a domain by it ([`room_label`]): lower case.
    pub label: Option<String>,
    /// The salt of the nodes' tags (lookup.rs).
    pub salt: [u8; 32],
    /// The key of lookups to a bare address (lookup.rs), mixed into sealed ones too.
    pub lookup: [u8; 32],
    /// The WireGuard pre-shared key of every pair in the room.
    pub psk: [u8; 32],
    /// The key of a lookup's MAC (lookup.rs): checked before anything costly.
    pub lookup_mac: [u8; 32],
    /// The key of a handshake initiation's proof of the room ([`Room::prove`]).
    pub proof: [u8; 32],
}

/// The first 16 bytes of BLAKE2s over `key` and then `parts` (BLAKE2 is a sound MAC with the
/// key in front: no length extension).
pub(crate) fn mac16(key: &[u8; 32], parts: &[&[u8]]) -> [u8; 16] {
    let mut h = Blake2s256::new();
    h.update(key);
    for p in parts {
        h.update(p);
    }
    h.finalize()[..16].try_into().unwrap()
}

pub(crate) fn hash(label: &str, id: &str) -> [u8; 32] {
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

/// The label a room's ID is under `p2p.internal` beside its tag (rooms.md "The resolver"): the ID itself when it is
/// in lower case and a DNS label (IDs that differ only in case are two rooms, so one with a capital gets none: the
/// user's call, 2026-11-18) (`[a-z0-9]` and inner `-`, 63 at most, no `--` third and fourth: the registered names' rule,
/// [`names::id`]), unless it looks derived: 8 characters of base32's alphabet (any room's tag is one: a room named
/// so would answer under that room's domain), or a private room's form (a hyphen and 26 of them at its end: that ID is
/// the room's secret, and its name alone would be the public room's of that name). None: the tag's domain alone.
pub fn room_label(id: &str) -> Option<String> {
    let l = id.to_string();
    let b = l.as_bytes();
    let b32 = |s: &[u8]| s.iter().all(|c| B32.contains(c));
    let tag_shaped = b.len() == 8 && b32(b);
    let private = b.len() >= 27 && b[b.len() - 27] == b'-' && b32(&b[b.len() - 26..]);
    (names::id::label_ok(&l, 63) && !tag_shaped && !private).then_some(l)
}

impl Room {
    pub fn derive(id: &str) -> Room {
        let mut prefix = [0u8; 6];
        for n in 0.. {
            let label = match n {
                0 => "waarm64 room prefix v1".to_string(),
                n => format!("waarm64 room prefix v1 {n}"),
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
            label: room_label(id),
            salt: hash("waarm64 room tag salt v1", id),
            lookup: hash("waarm64 room lookup key v1", id),
            psk: hash("waarm64 room psk v1", id),
            lookup_mac: hash("waarm64 room lookup mac v1", id),
            proof: hash("waarm64 room handshake proof v1", id),
        }
    }

    /// Writes the room's proof into a WireGuard handshake initiation's `mac2` (its last 16 bytes,
    /// which WireGuard leaves zero without a cookie and ts_tunnel requires zero): a MAC under a key
    /// from the room's ID over everything before it, so a node answers only a member's initiation
    /// (in IKpsk2 an initiation needs only the responder's public key: the pre-shared key enters
    /// at the response). A cookie WireGuard wrote is overwritten: ts_tunnel never asks for one.
    pub fn prove(&self, initiation: &mut [u8]) {
        let n = initiation.len() - 16;
        let m = mac16(&self.proof, &[&initiation[..n]]);
        initiation[n..].copy_from_slice(&m);
    }

    /// Whether an initiation carries the room's proof; if so it's cleared, as WireGuard wants it.
    pub fn check_proof(&self, initiation: &mut [u8]) -> bool {
        let n = initiation.len() - 16;
        let m = mac16(&self.proof, &[&initiation[..n]]);
        // A plain comparison: the nanoseconds it varies by are lost behind DERP and the worker, and
        // all a sender sees is whether a response ever comes.
        if initiation[n..] != m {
            return false;
        }
        initiation[n..].fill(0);
        true
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

    /// The names' domain the page shows and a lease gives first: `<room name>.p2p.internal` when the room's ID is a
    /// label of its own ([`room_label`]), else `<tag>.p2p.internal`.
    pub fn domain(&self) -> String {
        format!("{}.{SUFFIX}", self.label.as_deref().unwrap_or(&self.tag))
    }

    /// Every domain the resolver answers under, [`Room::domain`] first: the room name's, if any, and the tag's, always.
    pub fn domains(&self) -> Vec<String> {
        let tag = format!("{}.{SUFFIX}", self.tag);
        match &self.label {
            Some(l) => vec![format!("{l}.{SUFFIX}"), tag],
            None => vec![tag],
        }
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
    /// The node's titles: it serves the registry through a names client.
    pub names: Option<names::server::Config>,
    /// The clock's and proof of work's parameters a member checks names with (the module's: [`Params::BUILT`]).
    pub params: Params,
    /// A publisher (room-names.md "The names agent"): not a node but a names client alone, under this fresh key, relay
    /// only, no guest, that finds servers and puts the items the page gives it ([`Client::names_put`]). The page's
    /// names agent publishes titles through one with no machine running.
    pub publish: bool,
}

/// A node's registry: the server's logic and the names client that carries it (made once the
/// node runs, and again after [`NAMES_RETRY`] if it fails).
pub struct NamesHost {
    pub server: Server,
    pub transport: Option<Box<Client>>,
    retry_at: Option<Instant>,
}

/// A member's side of the registry (any node without titles): what it keeps and asks, and its names client, made at
/// the guest's query for a name that isn't a key and closed after [`member::IDLE`] without one.
pub struct MemberHost {
    pub member: Member,
    pub transport: Option<Box<Client>>,
    /// The guest's last query for a name that isn't a key.
    last_query: Option<Instant>,
    retry_at: Option<Instant>,
}

/// An ask a server's names client opened ([`Client::ask_copies`]).
struct AskCopy {
    at: Instant,
    first: usize,
    second: Option<usize>,
    /// The replies made (an item or none, and a release held: final review, finding 5), until they went through a
    /// second relay.
    reply: Vec<String>,
}

/// A query to the room's resolver waiting for the names client.
struct DnsWait {
    m: Vec<u8>,
    sport: u16,
    /// The name asked, relative to the room's domain.
    rel: String,
    until: Instant,
}

/// The registry's side a names client carries: a server's or a member's.
trait Side {
    fn input(&mut self, i: Input, now: Instant, unix: u64);
    fn poll(&mut self) -> Option<Cmd>;
}

impl Side for Server {
    fn input(&mut self, i: Input, now: Instant, unix: u64) {
        Server::input(self, i, now, unix)
    }
    fn poll(&mut self) -> Option<Cmd> {
        Server::poll(self)
    }
}

impl Side for Member {
    fn input(&mut self, i: Input, now: Instant, unix: u64) {
        Member::input(self, i, now, unix)
    }
    fn poll(&mut self) -> Option<Cmd> {
        Member::poll(self)
    }
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
    /// Never: one side is relay only; or, until it says otherwise, one side's browser makes no
    /// direct paths.
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
    /// It's relay only (its hello, or a `refuse`).
    relay_only: bool,
    /// Its browser makes no direct paths, as its last hello said.
    blocked: bool,
    /// The sequence number of its last hello taken (an older one resent late is ignored).
    hello_seq: u32,
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
    /// hello: the home region (an index into the link's), whether the sender is relay only, and
    /// whether its browser makes no direct paths now (`b`; a later hello says when it does).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    g: Option<i64>,
    #[serde(default, skip_serializing_if = "is_false")]
    r: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    b: bool,
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
    /// When it first went out (None: not yet, past the publish rate).
    started: Option<Instant>,
    /// How many times it went out.
    sent: usize,
    /// When it goes out next, or (sent [`LOOKUP_AT`]'s times) is given up.
    next: Instant,
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
    /// The WebRTC connections set up or open, and whose they are (a peer's `Rtc::Connecting` or
    /// `Rtc::Open` and nothing else): a channel's message finds its peer without a scan.
    rtcs: BTreeMap<u32, PeerId>,
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
    /// The page's word that this browser makes no direct paths now ([`Client::rtc_blocked`]).
    blocked: bool,
    published: VecDeque<Instant>,
    /// The DERP map is awaited.
    map_pending: bool,
    /// A names client (the transport of [`NamesHost`]), not a node: no guest, no signalling,
    /// relay only; questions and registry datagrams go to `names_events`.
    names_mode: bool,
    names_subscribed: bool,
    /// A member's names client: subscribed to its reply tag (room-names-r3.md).
    names_replies: bool,
    /// Asks opened lately (by the event's mark): the relay that brought each first, the one whose copy came next, and
    /// the reply waiting for that copy.
    ask_copies: BTreeMap<[u8; 16], AskCopy>,
    /// Handshakes from unknown keys are let in until then, this many at most (our question's
    /// answers), and how many came.
    names_window: names::server::AcceptWindow,
    pub names_events: VecDeque<Input>,
    /// A node's registry, when it holds titles.
    pub names: Option<Box<NamesHost>>,
    /// A member's side, when it holds none.
    pub member: Option<Box<MemberHost>>,
    /// A publisher's side ([`Config::publish`]): this client is its own names client.
    pub publisher: Option<Box<Member>>,
    /// The names line last told the page (`names` event): serving, names resolved or held, servers held.
    names_told: Option<(bool, usize, usize)>,
    dns_waiting: Vec<DnsWait>,
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
    pub fn new(mut cfg: Config, now: Instant) -> Result<Self, String> {
        if cfg.publish {
            // A names client alone: a key of its own, relay only, nothing let in but its question's answers.
            cfg.key = None;
            cfg.relay_only = true;
            cfg.incoming = false;
            cfg.names = None;
            cfg.known.clear();
        }
        let mut c = Client::build(cfg, now)?;
        if c.cfg.publish {
            c.names = None;
            c.names_mode = true;
            c.publisher = Some(Box::new(Member::new(&c.cfg.link.id, c.cfg.params.clone())));
        } else if c.names.is_none() {
            c.member = Some(Box::new(MemberHost {
                member: Member::new(&c.cfg.link.id, c.cfg.params.clone()),
                transport: None,
                last_query: None,
                retry_at: None,
            }));
        }
        c.event(json!({
            "type": "self", "key": format!("nodekey:{}", hex(&c.public)), "address6": c.addr,
            "tag": c.room.tag, "name": c.room.name(&c.public), "link": c.cfg.link.encode(),
            "params": c.cfg.params.label(),
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

    /// A names client for this node: its own key, relay only, no guest, the node's regions as
    /// the map gave them and its home region; its connections numbered from [`NAMES_CONN`].
    fn names_client(&self, now: Instant) -> Result<Client, String> {
        let cfg = Config {
            link: self.cfg.link.clone(),
            key: None,
            home: Some(self.home),
            derp_map_url: String::new(),
            known: Vec::new(),
            relay_only: true,
            incoming: false,
            unix_time: self.cfg.unix_time.map(|_| self.unix(now)),
            names: None,
            params: self.cfg.params.clone(),
            publish: false,
        };
        let mut c = Client::build(cfg, now)?;
        c.names_mode = true;
        c.next_conn = NAMES_CONN;
        for (g, h) in c.relays.iter_mut().zip(&self.relays) {
            g.nodes = h.nodes.clone();
            g.map_id = h.map_id;
            g.home_ok = h.home_ok;
        }
        for i in 0..c.nostr.len() {
            c.nostr_connect(i, now);
        }
        c.home = self.home;
        c.connect_home(now);
        Ok(c)
    }

    /// The client's state, nothing started.
    fn build(mut cfg: Config, now: Instant) -> Result<Self, String> {
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
        let names = cfg.names.take().map(|n| {
            Box::new(NamesHost {
                server: Server::new(&cfg.link.id, n, unix0),
                transport: None,
                retry_at: None,
            })
        });
        let c = Client {
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
            rtcs: BTreeMap::new(),
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
            blocked: false,
            published: VecDeque::new(),
            map_pending: false,
            names_mode: false,
            names_subscribed: false,
            names_replies: false,
            ask_copies: BTreeMap::new(),
            names_window: Default::default(),
            names_events: VecDeque::new(),
            names,
            member: None,
            publisher: None,
            names_told: None,
            dns_waiting: Vec::new(),
            flows: BTreeMap::new(),
            next_conn: 1,
            state: State::Connecting,
            actions: VecDeque::new(),
            cfg,
        };
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
            "dns": [], "dns6": [self.resolver], "domains": self.room.domains(),
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
        self.ws_closed_in(conn, now);
        self.pump_publisher(now);
    }

    fn ws_closed_in(&mut self, conn: u32, now: Instant) {
        if self.state == State::Failed {
            return;
        }
        if conn >= NAMES_CONN && !self.names_mode {
            if let Some(t) = self.names_transport() {
                t.ws_closed(conn, now);
            }
            return self.pump_names(now);
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
        self.ws_message_in(conn, data, now);
        self.pump_publisher(now);
    }

    fn ws_message_in(&mut self, conn: u32, data: &[u8], now: Instant) {
        if self.state == State::Failed {
            return;
        }
        if conn >= NAMES_CONN && !self.names_mode {
            if let Some(t) = self.names_transport() {
                t.ws_message(conn, data, now);
            }
            return self.pump_names(now);
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
                    self.start_names(now);
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

    /// The tags we subscribe to: our address's of the previous, current and next hour (a names
    /// client: the room's names tag's).
    fn tags(&self) -> Vec<String> {
        let h = self.hour;
        let hours = [h.saturating_sub(1), h, h + 1];
        if !self.names_mode {
            return hours.map(|h| self.room.tag_for(&self.addr, h)).to_vec();
        }
        let mut t = Vec::new();
        if self.names_subscribed {
            t.extend(hours.map(|h| self.room.names_tag(h)));
        }
        if self.names_replies {
            t.extend(self.reply_tags());
        }
        t
    }

    /// A member's names client's reply tags: the previous, current and next hour's.
    fn reply_tags(&self) -> [String; 3] {
        let h = self.hour;
        [h.saturating_sub(1), h, h + 1].map(|h| self.room.reply_tag(&self.public, h))
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
        if self.names_mode && !self.names_subscribed && !self.names_replies {
            // An asker only publishes: nothing comes to it through a relay.
            if let Some(old) = self.nostr[i].sub.take() {
                self.nostr_send(i, nostr::unsubscribe(&old));
            }
            let n = &mut self.nostr[i];
            n.check_at = None;
            n.answer_by = None;
            return;
        }
        let sub = format!("waarm64-{}", self.hour);
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

    /// Publishes a lookup for `addr` on every relay of the link, unless the rate's window is full.
    fn publish_lookup(&mut self, addr: &[u8; 16], now: Instant) -> bool {
        if !Self::take(&mut self.published, LOOKUPS_PER_SECOND, now) {
            return false; // a guest sweeping the /48, say
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
        true
    }

    /// Sends the guest's lookup for `addr` (out again at [`LOOKUP_AT`]'s times after the first),
    /// or, past the rate, when the window has room (it counts only once it went out).
    fn send_lookup(&mut self, addr: [u8; 16], now: Instant) {
        let out = self.publish_lookup(&addr, now);
        let room = self.published.front().map(|t| *t + Duration::from_secs(1));
        let Some(w) = self.pending.get_mut(&addr) else {
            return;
        };
        if out {
            w.sent += 1;
            let s = *w.started.get_or_insert(now);
            w.next = s + LOOKUP_AT.get(w.sent).copied().unwrap_or(LOOKUP_GIVE_UP);
        } else {
            let room = room.unwrap_or(now + Duration::from_secs(1)).max(now);
            w.next = w.started.map_or(room, |s| room.min(s + LOOKUP_GIVE_UP));
        }
    }

    /// An event under tag `x` through Nostr relay `i`: a lookup for us, if it opens, is called back.
    fn on_lookup(&mut self, i: usize, x: &str, content: &str, now: Instant) {
        // A names client hears its relays before its home region is up (a member's first lookup doesn't wait for it).
        let up = self.state == State::Running || self.names_mode && self.state != State::Failed;
        if !up || !self.tags().iter().any(|t| t == x) {
            return;
        }
        if self.names_mode {
            return self.on_names_event(i, x, content, now);
        }
        // Only a member's lookup goes further: an outsider's junk under our tag (anyone who saw a
        // lookup to us can publish under the tag) costs a BLAKE2s and takes no budget.
        let Ok(b) = b64().decode(content) else { return };
        if !lookup::authentic(&self.room, x, &b) {
            return;
        }
        if !self.admit(i, x, content, now) {
            return;
        }
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

    /// An event under a names client's tags: a question or an ask under the names tag (a server's), a reply under its
    /// reply tag (a member's).
    fn on_names_event(&mut self, i: usize, x: &str, content: &str, now: Instant) {
        if self.names_replies && self.reply_tags().iter().any(|t| t == x) {
            return self.on_reply(i, x, content, now);
        }
        if !self.names_subscribed {
            return;
        }
        // A copy of an ask we opened, through another relay: the relay a reply goes through too.
        let seen = event_mark(x, content);
        if let Some(c) = self.ask_copies.get_mut(&seen) {
            if c.first != i && c.second.is_none() {
                c.second = Some(i);
                for text in std::mem::take(&mut c.reply) {
                    self.nostr_send(i, text);
                }
            }
            return;
        }
        if content.len() == ASK_SIZE.div_ceil(3) * 4 {
            return self.on_ask(i, x, content, seen, now);
        }
        if self.state == State::Running {
            self.on_question(i, x, content, now);
        }
    }

    /// An ask under the names tag (a server's names client): checked as a question is (the MAC first, copies and the
    /// relay's budget, the time, not our own key) and handed to the registry, with the region it names if the link
    /// has it (a `fetch`'s call back).
    fn on_ask(&mut self, i: usize, x: &str, content: &str, seen: [u8; 16], now: Instant) {
        let Ok(b) = b64().decode(content) else { return };
        if !lookup::authentic_len(&self.room, x, &b, ASK_SIZE) || !self.admit(i, x, content, now) {
            return;
        }
        let Some(ask) =
            lookup::open_bare(&self.room, x, &b, ASK_SIZE).and_then(|p| NameAsk::from_plain(&p))
        else {
            return;
        };
        let unix = self.unix(now);
        if ask.key == self.public || unix.abs_diff(ask.time) > LOOKUP_MAX_AGE {
            return;
        }
        let region = self.local_region(ask.region);
        self.ask_copies.insert(
            seen,
            AskCopy {
                at: now,
                first: i,
                second: None,
                reply: Vec::new(),
            },
        );
        self.names_events.push_back(Input::Ask {
            ask,
            region,
            via: seen,
        });
    }

    /// A reply under our reply tag (a member's names client): the MAC, copies and the relay's budget, then opened.
    fn on_reply(&mut self, i: usize, x: &str, content: &str, now: Instant) {
        if content.len() > REPLY_SEALED_MAX.div_ceil(3) * 4 {
            return; // past what a server sends: dropped unread
        }
        let Ok(b) = b64().decode(content) else { return };
        if b.len() < 64 || !lookup::authentic_len(&self.room, x, &b, b.len()) {
            return;
        }
        if !self.admit(i, x, content, now) {
            return;
        }
        let Some(r) = lookup::open_bare_var(&self.room, x, &b, REPLY_SEALED_MAX)
            .and_then(|p| Reply::decode(&p).ok())
        else {
            return;
        };
        self.names_events.push_back(Input::Reply(r));
    }

    /// A question under the names tag through Nostr relay `i` (a names client subscribed to it,
    /// a server's): checked as a lookup is (the MAC first, copies and the relay's budget, the
    /// time, a fresh nonce, a region of the link's, not our own) and handed to the registry.
    fn on_question(&mut self, i: usize, x: &str, content: &str, now: Instant) {
        let Ok(b) = b64().decode(content) else { return };
        if !lookup::authentic_len(&self.room, x, &b, QUESTION_SIZE) {
            return;
        }
        if !self.admit(i, x, content, now) {
            return;
        }
        let Some(q) = lookup::open_bare(&self.room, x, &b, QUESTION_SIZE)
            .and_then(|p| Question::from_plain(&p))
        else {
            return;
        };
        let unix = self.unix(now);
        let region = self.local_region(q.region);
        // A question's rounds share its nonce: each round is remembered apart, and each asker's (final review, finding
        // 3: by nonce and round alone, a copy under another key sent first had the asker's own round dropped). A copy
        // of one event through another relay carries the same key.
        let seen = mac16(&[q.spread; 32], &[&q.key, &q.nonce]);
        if q.key == self.public
            || unix.abs_diff(q.time) > LOOKUP_MAX_AGE
            || self.nonces.contains(&seen)
        {
            return;
        }
        let Some(region) = region else { return };
        if self.nonce_order.len() >= MAX_NONCES
            && let Some((old, _)) = self.nonce_order.pop_front()
        {
            self.nonces.remove(&old);
        }
        self.nonces.insert(seen);
        self.nonce_order.push_back((seen, now));
        self.names_events.push_back(Input::Question { q, region });
    }

    /// Whether an event (its tag and content) through Nostr relay `i` is opened: not a copy of
    /// one opened lately (through another relay), and within that relay's budget.
    fn admit(&mut self, i: usize, x: &str, content: &str, now: Instant) -> bool {
        // A copy of an event opened already (through another relay): dropped before the budget.
        let seen = event_mark(x, content);
        while let Some(&(old, t)) = self.opened_order.front()
            && (now.saturating_duration_since(t) >= OPENED_FOR
                || self.opened_order.len() >= MAX_OPENED)
        {
            self.opened_order.pop_front();
            self.opened.remove(&old);
        }
        if self.opened.contains(&seen) {
            return false;
        }
        if self.lookups_in.len() < self.nostr.len() {
            self.lookups_in.resize_with(self.nostr.len(), VecDeque::new);
        }
        if !Self::take(&mut self.lookups_in[i], LOOKUP_EVENTS_PER_SECOND, now) {
            return false;
        }
        self.opened.insert(seen);
        self.opened_order.push_back((seen, now));
        true
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
                relay_only: false,
                blocked: false,
                hello_seq: 0,
                probe: None,
                epoch: random_u32(),
                init: None,
                nonce: None,
                seen: BTreeSet::new(),
                next_seq: 1,
                outbox: VecDeque::new(),
                // The offerer offers at the guests' first packet (`touch`).
                rtc: match self.cfg.relay_only || self.blocked {
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
            if self.names_mode {
                self.names_events.push_back(Input::Gone(p.key));
            }
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

    /// Why peer `id` has no direct path, for the page to say (`failed`: an attempt failed, with
    /// gathering in this browser working; `blocked`: its browser makes none; `relay-only`: it
    /// chose so; `none`: a path may be made again). A `path` `direct` clears it too.
    fn no_direct_event(&mut self, id: PeerId, why: &str) {
        let Some(p) = self.peers.get(&id) else { return };
        let v = json!({
            "type": "no-direct", "key": format!("nodekey:{}", hex(&p.key)), "address6": p.addr,
            "why": why,
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

    fn on_relay_packet(&mut self, r: usize, src: [u8; 32], mut packet: Vec<u8>, now: Instant) {
        if !self.proven(&mut packet) {
            return;
        }
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
                if src == self.public || !is_initiation(&packet) {
                    return;
                }
                // A member we don't know calls: the one a lookup of ours waits on, or (incoming
                // on, or a flow of the guest's with it) one that opens a connection, on trial.
                let addr = self.room.addr(&src);
                // A names client lets in only the servers answering its own question.
                let names = self.names_mode && self.names_window.room(&src, now);
                let expected = self.pending.contains_key(&addr) || names;
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
                    if names
                        && let Some(k) = self.names_window.admit(src, now)
                        && let Some(old) = self.wg.peer_id(NodePublicKey::from_bytes(k))
                    {
                        self.forget(old);
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
        let (region, relay_only, blocked) = (
            self.wire_region(self.home) as i64,
            self.cfg.relay_only,
            self.blocked,
        );
        let Some(p) = self.peers.get_mut(&id) else {
            return;
        };
        if p.hello_sent || self.names_mode {
            return; // a names client has no signalling: registry datagrams carry its traffic
        }
        p.hello_sent = true;
        self.signal(
            id,
            Msg {
                t: "hello".into(),
                g: Some(region),
                r: relay_only,
                b: blocked,
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
        if self.names_mode {
            // Registry datagrams, and nothing else: a names client has no guest.
            if info.proto == ip::UDP
                && (info.sport, info.dport) == (NAMES_PORT, NAMES_PORT)
                && let Some(body) = ip::udp_payload(p, &info)
            {
                let (key, data) = (peer.key, body.to_vec());
                self.touch(from, now);
                self.names_events
                    .push_back(Input::Datagram { from: key, data });
            }
            return;
        }
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
                let (public, off) = (self.public, self.cfg.relay_only || self.blocked);
                let p = self.peers.get_mut(&id).unwrap();
                p.backoff = RTC_BACKOFF;
                p.relay_only = false;
                p.blocked = false;
                p.hello_seq = 0;
                p.rtc = match off {
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
                if m.s < p.hello_seq {
                    return; // an older hello, resent after a newer one came
                }
                p.hello_seq = m.s;
                p.region = region;
                p.relay_only |= m.r;
                p.blocked = m.b;
                self.direct_changed(id, now);
            }
            "refuse" => {
                self.peers.get_mut(&id).unwrap().relay_only = true;
                self.direct_changed(id, now);
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

    /// Whether a direct path to peer `id` may be made: neither side is relay only, and neither's
    /// browser said it makes none.
    fn direct_allowed(&self, id: PeerId) -> bool {
        self.peers
            .get(&id)
            .is_some_and(|p| !(self.cfg.relay_only || self.blocked || p.relay_only || p.blocked))
    }

    /// What may reach peer `id` directly changed: a path no longer allowed closes (telling the
    /// peer, which may not know yet), and one allowed again is offered at once if the guests
    /// spoke, with no failures behind it.
    fn direct_changed(&mut self, id: PeerId, now: Instant) {
        let public = self.public;
        if !self.direct_allowed(id) {
            let had = self.rtc_attempt(id).is_some();
            self.close_rtc(id, had.then_some(now));
            let Some(p) = self.peers.get_mut(&id) else {
                return;
            };
            p.rtc = Rtc::Off;
            let why = match (p.blocked, p.relay_only) {
                (true, _) => Some("blocked"),
                (_, true) => Some("relay-only"),
                _ => None, // ours: the page knows
            };
            if let Some(why) = why {
                self.no_direct_event(id, why);
            }
            return;
        }
        let Some(p) = self.peers.get_mut(&id) else {
            return;
        };
        if p.rtc == Rtc::Off {
            p.backoff = RTC_BACKOFF;
            p.rtc = Rtc::Idle {
                next: (public < p.key && p.spoke).then_some(now),
            };
            self.no_direct_event(id, "none");
        }
    }

    /// The page's word on whether this browser makes direct paths (web/room.ts watches each
    /// connection's ICE gathering, and while none is made, a probe's): blocked, no offers are made
    /// or answered, and every confirmed peer is told in a new hello so it stops offering; again
    /// able, each is told so and paths are offered again at once (a setting changed, or the
    /// browser moved to a network it can use).
    pub fn rtc_blocked(&mut self, blocked: bool, now: Instant) {
        if self.blocked == blocked || self.cfg.relay_only {
            return;
        }
        self.blocked = blocked;
        let ids: Vec<PeerId> = self.peers.keys().copied().collect();
        for id in ids {
            self.direct_changed(id, now);
            let p = self.peers.get_mut(&id).unwrap();
            if p.confirmed {
                p.hello_sent = false;
                self.hello(id, now);
            }
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
        self.rtcs.len()
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
        self.rtcs.insert(rtc, id);
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
        self.rtcs.remove(&rtc);
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
        if p.rtc == Rtc::Off || self.cfg.relay_only || self.blocked || p.relay_only || p.blocked {
            p.rtc = Rtc::Off;
            return;
        }
        let next = (public < p.key).then(|| now + p.backoff);
        if grow {
            p.backoff = (p.backoff * 2).min(RTC_BACKOFF_MAX);
        }
        p.rtc = Rtc::Idle { next };
        if grow {
            self.no_direct_event(id, "failed");
        }
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
        self.rtcs.insert(rtc, id);
        let p = self.peers.get_mut(&id).unwrap();
        p.attempt += 1;
        p.rtc = Rtc::Connecting {
            id: rtc,
            attempt: p.attempt,
            since: now,
        };
        self.actions.push_back(Action::RtcOpen { rtc, offer: true });
    }

    /// The tests' check that `rtcs` is the peers' connections, no more, no less.
    #[cfg(test)]
    fn check_rtcs(&self) {
        let from_peers: BTreeMap<u32, PeerId> = self
            .peers
            .keys()
            .filter_map(|id| self.rtc_id(*id).map(|rtc| (rtc, *id)))
            .collect();
        assert_eq!(self.rtcs, from_peers, "rtcs out of step with the peers");
    }

    fn peer_of_rtc(&self, rtc: u32) -> Option<PeerId> {
        self.rtcs.get(&rtc).copied()
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
        let mut data = data.to_vec();
        if !self.proven(&mut data) {
            return;
        }
        if matches!(self.peers[&id].rtc, Rtc::Connecting { .. }) {
            self.rtc_open(rtc, now); // its first message can come before its open event
        }
        if let Rtc::Open { unanswered, .. } = &mut self.peers.get_mut(&id).unwrap().rtc {
            *unanswered = None;
        }
        self.peer_packet(id, false, data, now);
    }

    /// Whether a peer's WireGuard packet may go in: anything but a handshake initiation, or an
    /// initiation with the room's proof (cleared for WireGuard), whoever it's from. So an
    /// outsider who has only a node's name gets nothing answered, and takes no trial's place.
    fn proven(&self, packet: &mut [u8]) -> bool {
        match packet.first() {
            Some(&t) if t == INITIATION.0 => {
                packet.len() == INITIATION.1 && self.room.check_proof(packet)
            }
            _ => true,
        }
    }

    /// Sends WireGuard's packets: on a peer's data channel when it's open, else through the relay
    /// of its region.
    fn send_to_peers(
        &mut self,
        to_peers: impl IntoIterator<Item = (PeerId, Vec<PacketMut>)>,
        now: Instant,
    ) {
        for (id, mut packets) in to_peers {
            let Some(p) = self.peers.get_mut(&id) else {
                continue;
            };
            let (key, via) = (p.key, p.via);
            for pkt in &mut packets {
                if is_initiation(pkt.as_ref()) {
                    self.room.prove(pkt.as_mut());
                }
            }
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

    /// The guest's DNS query `p` to the room's resolver: a name that is a key, its address computed; a registered name
    /// (room-names.md "The resolver"), from what this node holds or once its names client hears.
    fn resolve(&mut self, p: &[u8], info: &ip::Info, now: Instant) {
        let Some(m) = ip::udp_payload(p, info) else {
            return;
        };
        let Some(q) = dns::parse(m) else { return };
        let rel = self
            .room
            .domains()
            .iter()
            .find_map(|d| q.name.strip_suffix(d.as_str())?.strip_suffix('.'))
            .map(str::to_string);
        let key = rel
            .as_deref()
            .filter(|k| k.len() == 52)
            .and_then(unbase32)
            .and_then(|k| <[u8; 32]>::try_from(k).ok());
        let m = m.to_vec();
        match (key, rel) {
            (Some(k), _) => self.dns_answer(&m, info.sport, Answer::Node(k), 3600),
            (None, Some(rel)) => {
                let a = self.resolve_name(&rel, now, true);
                self.log(format!("resolver: {rel} (type {}): {a:?}", q.qtype));
                if a != Answer::Wait {
                    self.dns_answer(&m, info.sport, a, NAME_TTL);
                } else if self.dns_waiting.len() >= MAX_DNS_WAITING {
                    self.dns_answer(&m, info.sport, Answer::Wait, 0);
                } else {
                    self.dns_waiting.push(DnsWait {
                        m,
                        sport: info.sport,
                        rel,
                        until: now + DNS_WAIT,
                    });
                }
            }
            (None, None) => self.dns_answer(&m, info.sport, Answer::Nx, 0),
        }
    }

    /// What a registered name `rel` (relative to the room's domain) answers now. `start`: the guest just asked (the
    /// member may look it up); else a waiting query is looked at again.
    fn resolve_name(&mut self, rel: &str, now: Instant, start: bool) -> Answer {
        let unix = self.unix(now);
        let Some((_, name)) = names::id::split(rel) else {
            return Answer::Nx; // reserved, or not a name
        };
        if let Some(h) = self.names.as_ref() {
            return h.server.resolve(rel, name, unix);
        }
        let Some(h) = self.member.as_mut() else {
            return Answer::Nx;
        };
        if start {
            h.last_query = Some(now);
        }
        let a = h.member.query(rel, now, unix, start);
        if start {
            self.start_member(now);
        }
        a
    }

    /// The answer to the guest's query `m` from port `sport`: `Wait` as SERVFAIL.
    fn dns_answer(&mut self, m: &[u8], sport: u16, a: Answer, ttl: u32) {
        let Some(q) = dns::parse(m) else { return };
        let (rcode, addrs) = match a {
            Answer::Node(k) => {
                let a = self.room.addr(&k);
                if k != self.public {
                    self.learn(a, k);
                }
                (dns::NOERROR, vec![IpAddr::V6(a.into())])
            }
            Answer::Own => (dns::NOERROR, vec![IpAddr::V6(self.addr.into())]),
            Answer::Nx => (dns::NXDOMAIN, Vec::new()),
            Answer::Wait => (dns::SERVFAIL, Vec::new()),
        };
        let answer = dns::fit(&dns::answer(m, &q, rcode, &addrs, ttl), q.udp_size);
        let r = ip::udp(
            (IpAddr::V6(self.resolver.into()), 53),
            (IpAddr::V6(self.addr.into()), sport),
            &answer,
        );
        self.actions.push_back(Action::ToGuest(r));
    }

    /// The queries that wait, looked at again: answered, or SERVFAIL once their wait is over.
    fn answer_waiting(&mut self, now: Instant) {
        if self.dns_waiting.is_empty() {
            return;
        }
        for w in std::mem::take(&mut self.dns_waiting) {
            let a = self.resolve_name(&w.rel, now, false);
            if a == Answer::Wait && now < w.until {
                self.dns_waiting.push(w);
                continue;
            }
            if a == Answer::Wait {
                self.log(format!(
                    "resolver: {}: no answer in {} s",
                    w.rel,
                    DNS_WAIT.as_secs()
                ));
            }
            self.dns_answer(&w.m, w.sport, a, NAME_TTL);
        }
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
                self.resolve(p, &info, now);
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
                started: None,
                sent: 0,
                next: now,
            },
        );
        self.send_lookup(dst, now);
    }

    pub fn tick(&mut self, now: Instant) {
        self.tick_in(now);
        let unix = self.unix(now);
        if let Some(p) = self.publisher.as_mut()
            && p.deadline().is_some_and(|d| d <= now)
        {
            p.tick(now, unix);
        }
        self.pump_publisher(now);
    }

    fn tick_in(&mut self, now: Instant) {
        #[cfg(test)]
        self.check_rtcs();
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
        // Lookups: sent (first sends before resends, the earliest first), then given up.
        let mut due: Vec<(usize, Instant, [u8; 16])> = self
            .pending
            .iter()
            .filter(|(_, w)| w.next <= now)
            .map(|(a, w)| (w.sent, w.next, *a))
            .collect();
        due.sort();
        for (_, _, addr) in due {
            let w = &self.pending[&addr];
            if !w.started.is_some_and(|s| now >= s + LOOKUP_GIVE_UP) {
                self.send_lookup(addr, now);
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
        if self.names_mode {
            self.ask_copies_tick(now);
        }
        self.names_tick(now);
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
        let names = self.names.as_ref().and_then(|h| {
            [
                h.transport.as_ref().and_then(|t| t.deadline()),
                h.server.deadline().filter(|_| h.transport.is_some()),
                h.retry_at,
            ]
            .into_iter()
            .flatten()
            .min()
        });
        let member = self.member.as_ref().and_then(|h| {
            let t = h.transport.as_ref()?;
            [
                t.deadline(),
                h.member.deadline(),
                h.last_query.map(|q| q + member::IDLE),
            ]
            .into_iter()
            .flatten()
            .min()
        });
        let waiting = self.dns_waiting.iter().map(|w| w.until).min();
        let copies = (self.ask_copies.values())
            .map(|c| {
                if c.reply.is_empty() {
                    c.at + ASK_COPIES_FOR
                } else {
                    c.at + REPLY_SECOND_WAIT
                }
            })
            .min();
        let publisher = self.publisher.as_ref().and_then(|p| p.deadline());
        [
            publisher,
            self.wg.next_event().map(|r| r.start()),
            calls,
            self.probe_until,
            names,
            member,
            waiting,
            copies,
        ]
        .into_iter()
        .chain(peers)
        .chain(relays)
        .chain(
            self.nostr
                .iter()
                .flat_map(|n| [n.reconnect_at, n.answer_by, n.check_at]),
        )
        .flatten()
        .chain(self.pending.values().map(|w| w.next))
        .min()
    }

    pub fn poll(&mut self) -> Option<Action> {
        self.actions.pop_front()
    }

    // ---- Names (names/server.rs carries the registry; this, its transport) ----

    /// A stored record of the registry, streamed in at the start (before the first tick): a server's (a name it
    /// holds) or a member's (a name it resolved). False for one this node doesn't take (the page deletes it).
    pub fn names_load(&mut self, record: &[u8]) -> bool {
        let unix = self.unix(self.t0);
        if let Some(h) = self.names.as_mut() {
            return h.server.load(record, unix);
        }
        self.member
            .as_mut()
            .is_some_and(|h| h.member.load(record, unix))
    }

    /// The page's answer to a server's fetch ([`Action::NamesFetch`] `id`): the HTTP status (0: it failed) and the
    /// body. Ignored by anything but a server.
    pub fn names_fetched(&mut self, id: u32, status: u16, body: &[u8], now: Instant) {
        let unix = self.unix(now);
        if let Some(h) = self.names.as_mut() {
            let body = body.to_vec();
            h.server
                .input(Input::Fetched { id, status, body }, now, unix);
            self.pump_names(now);
        }
    }

    /// A publisher's item to put ([`Config::publish`]): to the two servers it finds, each answer a `names-put` event.
    /// False when it isn't a publisher, the item isn't one, or too many wait.
    pub fn names_put(&mut self, item: &[u8], now: Instant) -> bool {
        let Ok(item) = names::wire::Item::decode(item) else {
            return false;
        };
        let Some(p) = self.publisher.as_mut() else {
            return false;
        };
        let ok = p.put(item, now);
        self.pump_publisher(now);
        ok
    }

    /// A publisher's check for the dialog: every id under `first` (a name id's first byte) the servers it finds hold,
    /// each answer a `names-ids` event (the name id itself never leaves the page). False when it isn't a publisher.
    pub fn names_ids(&mut self, first: u8, now: Instant) -> bool {
        let Some(p) = self.publisher.as_mut() else {
            return false;
        };
        p.ids(first, now);
        self.pump_publisher(now);
        true
    }

    /// The node's titles as they change (the page's names agent): a server's are replaced; a member with titles now
    /// becomes a server (its member side and names client go), its names client made at once if the node runs.
    pub fn set_titles(&mut self, titles: Vec<names::server::Title>, now: Instant) {
        if self.names_mode || self.publisher.is_some() {
            return;
        }
        let unix = self.unix(now);
        if let Some(h) = self.names.as_mut() {
            h.server.set_titles(titles, unix);
            return self.pump_names(now);
        }
        if titles.is_empty() {
            return;
        }
        if let Some(mut m) = self.member.take() {
            m.member.stop();
            if let Some(mut t) = m.transport.take() {
                t.close();
                while let Some(a) = t.poll() {
                    if !matches!(a, Action::Event(_)) {
                        self.actions.push_back(a);
                    }
                }
            }
        }
        self.names = Some(Box::new(NamesHost {
            server: Server::new(
                &self.cfg.link.id,
                names::server::Config {
                    params: self.cfg.params.clone(),
                    titles,
                    max_names: names::server::MAX_NAMES,
                    max_bytes: names::server::MAX_BYTES,
                },
                unix,
            ),
            transport: None,
            retry_at: None,
        }));
        self.log("names: titles given: this node serves the room's names".into());
        self.start_names(now);
    }

    /// A publisher's side and its transport (this client) talk; its answers go out as `names-put` events.
    fn pump_publisher(&mut self, now: Instant) {
        let Some(mut p) = self.publisher.take() else {
            return;
        };
        let unix = self.unix(now);
        if self.state == State::Running && !p.running() {
            p.start(self.public, now);
            p.ready(now);
        }
        if self.state == State::Failed && p.running() {
            p.stop();
        }
        loop {
            let mut moved = false;
            while let Some(i) = self.names_events.pop_front() {
                p.input(i, now, unix);
                moved = true;
            }
            while let Some(c) = p.poll() {
                moved = true;
                match c {
                    Cmd::Log(s) => self.log(format!("names: {s}")),
                    Cmd::Store { .. } => {}
                    c => self.names_cmd(c, now),
                }
            }
            if !moved {
                break;
            }
        }
        while let Some(d) = p.put_done.pop_front() {
            let (result, item) = match d.result {
                member::PutResult::Taken => ("taken", None),
                member::PutResult::Better(it) => ("better", Some(hex(&it.encode()))),
                member::PutResult::Failed => ("failed", None),
                member::PutResult::Nobody => ("nobody", None),
            };
            self.event(json!({
                "type": "names-put", "id": hex(&d.id), "server": d.server.map(|k| hex(&k)),
                "result": result, "item": item,
            }));
        }
        while let Some(d) = p.ids_done.pop_front() {
            let (result, ids) = match d.result {
                member::IdsResult::Ids(v) => (
                    "ids",
                    Some(
                        v.iter()
                            .map(|(i, u)| json!([hex(i), u]))
                            .collect::<Vec<_>>(),
                    ),
                ),
                member::IdsResult::Failed => ("failed", None),
                member::IdsResult::Nobody => ("nobody", None),
            };
            self.event(json!({
                "type": "names-ids", "first": d.first, "server": d.server.map(|k| hex(&k)),
                "result": result, "ids": ids,
            }));
        }
        self.publisher = Some(p);
    }

    /// The names client that carries this node's registry side, if it runs.
    fn names_transport(&mut self) -> Option<&mut Client> {
        let s = self.names.as_mut().and_then(|h| h.transport.as_deref_mut());
        match s {
            Some(t) => Some(t),
            None => self
                .member
                .as_mut()
                .and_then(|h| h.transport.as_deref_mut()),
        }
    }

    /// The node runs: a node with titles makes its names client.
    fn start_names(&mut self, now: Instant) {
        if self.names_mode
            || self.state != State::Running
            || self.names.as_ref().is_none_or(|h| h.transport.is_some())
        {
            return;
        }
        match self.names_client(now) {
            Ok(t) => {
                let key = t.public;
                let h = self.names.as_mut().unwrap();
                h.retry_at = None;
                // The server starts once its home region is up (`pump_names`).
                h.transport = Some(Box::new(t));
                self.log(format!("names: a names client, nodekey:{}", hex(&key)));
            }
            Err(e) => {
                self.names.as_mut().unwrap().retry_at = Some(now + NAMES_RETRY);
                self.log(format!("names: no names client: {e}"));
            }
        }
        self.pump_names(now);
    }

    /// A member that needs its names client (a lookup waits) makes it; the member starts once it runs.
    fn start_member(&mut self, now: Instant) {
        let running = self.state == State::Running;
        let Some(h) = self.member.as_ref() else {
            return;
        };
        if self.names_mode
            || !running
            || h.transport.is_some()
            || h.retry_at.is_some_and(|t| t > now)
            || !h.member.busy()
        {
            return;
        }
        match self.names_client(now) {
            Ok(t) => {
                let key = t.public;
                let h = self.member.as_mut().unwrap();
                h.retry_at = None;
                h.transport = Some(Box::new(t));
                self.log(format!(
                    "names: a member's names client, nodekey:{}",
                    hex(&key)
                ));
            }
            Err(e) => {
                self.member.as_mut().unwrap().retry_at = Some(now + NAMES_RETRY);
                self.log(format!("names: no names client: {e}"));
            }
        }
        self.pump_names(now);
    }

    fn names_tick(&mut self, now: Instant) {
        let unix = self.unix(now);
        if let Some(h) = self.names.as_mut() {
            if h.transport.is_none() {
                if h.retry_at.is_some_and(|t| t <= now) {
                    h.retry_at = None;
                    self.start_names(now);
                }
            } else {
                if let Some(t) = h.transport.as_mut()
                    && t.deadline().is_some_and(|d| d <= now)
                {
                    t.tick(now);
                }
                if h.server.deadline().is_some_and(|d| d <= now) {
                    h.server.tick(now, unix);
                }
            }
        }
        let mut idle = false;
        if let Some(h) = self.member.as_mut()
            && let Some(t) = h.transport.as_mut()
        {
            if t.deadline().is_some_and(|d| d <= now) {
                t.tick(now);
            }
            if h.member.deadline().is_some_and(|d| d <= now) {
                h.member.tick(now, unix);
            }
            idle = h.last_query.is_none_or(|q| now >= q + member::IDLE) && !h.member.busy();
        }
        if idle {
            let h = self.member.as_mut().unwrap();
            let mut t = h.transport.take().unwrap();
            h.member.stop();
            t.close();
            while let Some(a) = t.poll() {
                if !matches!(a, Action::Event(_)) {
                    self.actions.push_back(a);
                }
            }
            self.log(format!(
                "names: the member's names client closes, no name asked for {} s",
                member::IDLE.as_secs()
            ));
        }
        self.pump_names(now);
    }

    /// Carries what the names clients and the registry's sides say to each other, and the names clients' actions
    /// out; then the queries that wait are looked at again.
    fn pump_names(&mut self, now: Instant) {
        if let Some(mut h) = self.names.take() {
            // The server starts (subscribes and asks "who serves?") once its names client's home region is up: the
            // answers' call backs come through it (NAMES loop 6b: asked before, on a public region that takes a second or
            // more to connect, they found nobody, and the server took nobody answering for 30 s).
            if let Some(t) = h.transport.as_ref()
                && t.state == State::Running
                && !h.server.running()
            {
                let key = t.public;
                h.server.start(key, now);
            }
            if self.pump_side(&mut h.transport, &mut h.server, now) {
                h.transport = None;
                h.server.stop();
                h.retry_at = Some(now + NAMES_RETRY);
                self.log(format!(
                    "names: the names client failed; again in {} s",
                    NAMES_RETRY.as_secs()
                ));
            }
            self.names = Some(h);
        }
        if let Some(mut h) = self.member.take() {
            // The member starts with its names client (its relays: a first lookup asks the room at once), and is ready
            // once its home region is up (servers' call backs reach it: "who serves?", `fetch`).
            if let Some(t) = h.transport.as_ref() {
                if !h.member.running() && t.state != State::Failed {
                    let key = t.public;
                    h.member.start(key, now);
                }
                if t.state == State::Running && !h.member.is_ready() {
                    h.member.ready(now);
                }
            }
            if self.pump_side(&mut h.transport, &mut h.member, now) {
                h.transport = None;
                h.member.stop();
                h.retry_at = Some(now + NAMES_RETRY);
                self.log(format!(
                    "names: the member's names client failed; again at a query in {} s",
                    NAMES_RETRY.as_secs()
                ));
            }
            self.member = Some(h);
        }
        self.tell_names();
        self.answer_waiting(now);
    }

    /// The adapter's details' names line, when it changed: a server's names held and the servers it synced with
    /// lately, or a member's names resolved (kept) and servers held now.
    fn tell_names(&mut self) {
        let now = match (self.names.as_ref(), self.member.as_ref()) {
            (Some(h), _) => (true, h.server.reg.len(), h.server.partners()),
            (None, Some(h)) => (false, h.member.kept.len(), h.member.servers().len()),
            (None, None) => return,
        };
        if self.names_told != Some(now) {
            self.names_told = Some(now);
            self.event(json!({
                "type": "names", "serving": now.0, "names": now.1, "servers": now.2,
            }));
        }
    }

    /// One side's commands to its names client and its events back, until neither moves; the names client's actions
    /// out (its WebSockets; of its events, only its log, marked). True when the names client failed.
    fn pump_side(
        &mut self,
        transport: &mut Option<Box<Client>>,
        side: &mut dyn Side,
        now: Instant,
    ) -> bool {
        let unix = self.unix(now);
        loop {
            let mut moved = false;
            if let Some(t) = transport.as_mut() {
                while let Some(i) = t.names_events.pop_front() {
                    side.input(i, now, unix);
                    moved = true;
                }
            }
            while let Some(c) = side.poll() {
                moved = true;
                match c {
                    Cmd::Store { id, record } => {
                        self.actions.push_back(Action::NamesStore { id, record })
                    }
                    // Only a server's side asks (outside.rs); the page fetches.
                    Cmd::Fetch { id, url } => {
                        self.actions.push_back(Action::NamesFetch { id, url })
                    }
                    Cmd::Log(s) => self.log(format!("names: {s}")),
                    c => {
                        if let Some(t) = transport.as_mut() {
                            t.names_cmd(c, now);
                        }
                    }
                }
            }
            if !moved {
                break;
            }
        }
        let mut failed = false;
        if let Some(t) = transport.as_mut() {
            while let Some(a) = t.poll() {
                match a {
                    Action::Event(e) => {
                        let v: serde_json::Value = serde_json::from_str(&e).unwrap_or_default();
                        if v["type"] == "log" {
                            self.log(format!("names client: {}", v["msg"].as_str().unwrap_or("")));
                        }
                        failed |= v["type"] == "state" && v["state"] == "Failed";
                    }
                    a => self.actions.push_back(a),
                }
            }
        }
        failed
    }

    /// What the registry asks of its names client.
    fn names_cmd(&mut self, c: Cmd, now: Instant) {
        match c {
            Cmd::Publish { nonce, spread } => self.publish_question(nonce, spread, now),
            Cmd::Accept { until, max } => self.names_window.open(until, max),
            Cmd::Served(k, r) => self.names_window.served(&k, r),
            Cmd::CallBack { key, region } => {
                // A peer we have (a server of ours asking again) is answered on its session.
                if !self.peers.values().any(|p| p.key == key) {
                    self.call_back(key, region, now);
                }
            }
            Cmd::Send { to, data } => self.names_send(to, &data, now),
            Cmd::Forget(k) => {
                if let Some(id) = self.wg.peer_id(NodePublicKey::from_bytes(k)) {
                    self.forget(id);
                }
            }
            Cmd::Subscribe(on) => {
                self.names_subscribed = on;
                self.resubscribe(now);
            }
            Cmd::Replies(on) => {
                self.names_replies = on;
                self.resubscribe(now);
            }
            Cmd::Ask {
                nonce,
                id,
                mode,
                spread,
                shown,
            } => self.publish_ask(nonce, id, mode, spread, shown, now),
            Cmd::Reply { to, via, data } => self.publish_reply(to, via, data, now),
            Cmd::AcceptFrom { keys, until } => self.names_window.open_for(keys, until),
            // A publisher's and a member's sides ask nothing outside the room.
            Cmd::Store { .. } | Cmd::Log(_) | Cmd::Fetch { .. } => {}
        }
    }

    fn resubscribe(&mut self, now: Instant) {
        for i in 0..self.nostr.len() {
            if self.nostr[i].conn.is_some() {
                self.nostr_subscribe(i, now);
            }
        }
    }

    /// An ask (a member's first lookup) under the names tag of the hour, on every relay of the link.
    fn publish_ask(
        &mut self,
        nonce: [u8; 16],
        id: [u8; 32],
        mode: names::wire::AskMode,
        spread: u8,
        shown: [u8; 8],
        now: Instant,
    ) {
        let unix = self.unix(now);
        let a = NameAsk {
            key: self.public,
            region: self.wire_region(self.home),
            time: unix,
            nonce,
            id,
            mode,
            spread,
            shown,
        };
        let tag = self.room.names_tag(unix / 3600);
        let content = b64().encode(lookup::seal_bare(&self.room, &tag, &a.plain()));
        let text = nostr::publish(&self.author.event(KIND, &tag, &content, unix));
        for i in 0..self.nostr.len() {
            self.nostr_send(i, text.clone());
        }
    }

    /// A reply (a server's) under names key `to`'s reply tag of the hour: through the relay that brought the ask
    /// (`via`) and the one whose copy came next, or another after [`REPLY_SECOND_WAIT`].
    fn publish_reply(&mut self, to: [u8; 32], via: [u8; 16], mut data: Vec<u8>, now: Instant) {
        // Our home region, which the registry's side doesn't know.
        let region = self.wire_region(self.home).to_be_bytes();
        if let Some(r) = data.get_mut(48..50) {
            r.copy_from_slice(&region);
        }
        let unix = self.unix(now);
        let tag = self.room.reply_tag(&to, unix / 3600);
        let content = b64().encode(lookup::seal_bare(&self.room, &tag, &data));
        let text = nostr::publish(&self.author.event(KIND, &tag, &content, unix));
        let (first, second) = match self.ask_copies.get_mut(&via) {
            Some(c) => {
                if c.second.is_none() {
                    c.reply.push(text.clone());
                }
                (Some(c.first), c.second)
            }
            None => (None, None),
        };
        let mut sent = 0;
        for i in [first, second].into_iter().flatten() {
            self.nostr_send(i, text.clone());
            sent += 1;
        }
        if first.is_none() {
            let up: Vec<usize> = (0..self.nostr.len())
                .filter(|i| self.nostr[*i].conn.is_some())
                .collect();
            for i in up {
                if sent == 2 {
                    break;
                }
                self.nostr_send(i, text.clone());
                sent += 1;
            }
        }
    }

    /// Replies whose ask's copy didn't come go through another relay; old asks are forgotten.
    fn ask_copies_tick(&mut self, now: Instant) {
        let due: Vec<(usize, Vec<String>)> = (self.ask_copies.values_mut())
            .filter(|c| now >= c.at + REPLY_SECOND_WAIT && !c.reply.is_empty())
            .map(|c| (c.first, std::mem::take(&mut c.reply)))
            .collect();
        for (first, texts) in due {
            if let Some(i) =
                (0..self.nostr.len()).find(|i| *i != first && self.nostr[*i].conn.is_some())
            {
                for text in texts {
                    self.nostr_send(i, text);
                }
            }
        }
        self.ask_copies
            .retain(|_, c| now.saturating_duration_since(c.at) < ASK_COPIES_FOR);
    }

    /// "Who serves the registry?" under the names tag of the hour, on every relay of the link.
    fn publish_question(&mut self, nonce: [u8; 16], spread: u8, now: Instant) {
        let unix = self.unix(now);
        let q = Question {
            key: self.public,
            region: self.wire_region(self.home),
            time: unix,
            nonce,
            spread,
        };
        let tag = self.room.names_tag(unix / 3600);
        let content = b64().encode(lookup::seal_bare(&self.room, &tag, &q.plain()));
        let text = nostr::publish(&self.author.event(KIND, &tag, &content, unix));
        for i in 0..self.nostr.len() {
            self.nostr_send(i, text.clone());
        }
    }

    /// A registry datagram to the peer with key `to` (a names client's), on [`NAMES_PORT`].
    fn names_send(&mut self, to: [u8; 32], data: &[u8], now: Instant) {
        let Some(id) = self.wg.peer_id(NodePublicKey::from_bytes(to)) else {
            return;
        };
        let Some(p) = self.peers.get_mut(&id) else {
            return;
        };
        p.waiting.get_or_insert(now);
        let (me, them) = (
            IpAddr::V6(Ipv6Addr::from(self.addr)),
            IpAddr::V6(Ipv6Addr::from(p.addr)),
        );
        let mut pkt = ip::udp((me, NAMES_PORT), (them, NAMES_PORT), data);
        pad(&mut pkt);
        self.touch(id, now);
        let r = self.wg.send(now, [(id, vec![PacketMut::from(pkt)])]);
        self.send_to_peers(r.to_peers, now);
    }

    pub fn close(&mut self) {
        let mut transports = Vec::new();
        if let Some(h) = self.names.as_mut() {
            h.retry_at = None;
            transports.extend(h.transport.take());
            h.server.stop();
        }
        if let Some(h) = self.member.as_mut() {
            h.retry_at = None;
            transports.extend(h.transport.take());
            h.member.stop();
        }
        for mut t in transports {
            t.close();
            while let Some(a) = t.poll() {
                if !matches!(a, Action::Event(_)) {
                    self.actions.push_back(a);
                }
            }
        }
        self.dns_waiting.clear();
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

/// An event's mark: a hash of its tag and content, the same through every relay.
fn event_mark(x: &str, content: &str) -> [u8; 16] {
    let mut h = Blake2s256::new();
    h.update(x.as_bytes());
    h.update([0]);
    h.update(content.as_bytes());
    h.finalize()[..16].try_into().unwrap()
}

#[cfg(test)]
mod tests;
