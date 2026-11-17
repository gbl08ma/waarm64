//! A names client's registry side (room-names.md "The registry"), sans I/O: a server's store and
//! its exchanges, and the question that finds servers. The transport (a room client of its own
//! under a session key, relay only: room.rs) hands it questions and datagrams ([`Input`]) and
//! carries out what it says ([`Cmd`]).
//!
//! - **Asking** "who serves the registry?": shares of 1/64, then 1/8 after 0.4 s, then everyone
//!   after 1 s, stopping at the first round that brings an answer; 0.3 s after the first answer,
//!   the two servers with the lowest `BLAKE2s(nonce, server's key)`. Nobody within 2.5 s: remembered
//!   for 30 s, doubling to 10 minutes, reset by an answer. At most one question a second.
//! - **Answering**: when the server's hash falls in the share, it has synced, it holds fewer than
//!   [`MAX_ASKERS`] askers and its own budget ([`ANSWERS_PER_SECOND`], apart from the node's call
//!   backs and trials) allows: a call back, then `serve`, signed by a live name's owner key over
//!   the asker's nonce and this names client's key.
//! - **Sync**: with the two servers a question found, at the start and every 5 minutes with
//!   jitter: range fingerprints by id, 16 sub-ranges where they differ, a listing where a range is
//!   small; `get` with what is held, so only what's missing crosses; `have` for what the other
//!   lacks. A server answers questions only once its first sync is done (or nobody answered it).
//! - **Verification** of everything taken, in slices of [`UNITS_PER_TURN`] a turn; what is stored
//!   was verified and is trusted at load.
//! - **The bound**: [`Config::max_names`] and bytes; past either, the names nobody asked for
//!   longest go first, never this node's own.

use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    time::{Duration, Instant},
};

use blake2::{Blake2s256, Digest};
use k256::schnorr::SigningKey;

use super::{
    Invalid, Params,
    chain::Name,
    entry::{Pow, Stamped, pending_ok, sign, tagged, verify},
    id::RoomNames,
    member::Answer,
    store::{Held, Registry, read_record, zone_tag},
    wire::{GetMode, Item, Msg, Proof, Question, Range, SyncAnswer, Transfers, WireEntry},
    zone::Zone,
};

/// The shares a question asks, as `spread` (top bits of the hash that must be zero), and when
/// each round goes out after the first.
pub const SPREADS: [u8; 3] = [6, 3, 0];
pub(super) const ROUND_AT: [Duration; 3] = [
    Duration::ZERO,
    Duration::from_millis(400),
    Duration::from_millis(1000),
];
/// While our own question is open, a call back to a lower key waits this long: that server may be
/// answering us at the same moment, and crossed handshakes both fail (rooms.md "Finding a peer");
/// by then its session may carry our `serve`.
const CROSSED_WAIT: Duration = Duration::from_millis(500);
/// The choice is made this long after the first answer.
pub(super) const CHOOSE_AFTER: Duration = Duration::from_millis(300);
/// No answer this long after the first round: nobody serves.
pub(super) const GIVE_UP: Duration = Duration::from_millis(2500);
pub(super) const NOBODY_FIRST: Duration = Duration::from_secs(30);
pub(super) const NOBODY_MAX: Duration = Duration::from_secs(600);
/// Incoming handshakes a question lets in (servers answering it), at most at once.
pub const ACCEPT_MAX: usize = 32;
/// A key let in that hasn't served this long after its handshake makes room for a newcomer (a server's `serve` comes
/// one round trip after it).
pub const ACCEPT_GRACE: Duration = Duration::from_secs(1);
/// Askers a server holds at once, how long one is held without a request, and at most.
pub const MAX_ASKERS: usize = 32;
const ASKER_IDLE: Duration = Duration::from_secs(60);
const ASKER_LIFE: Duration = Duration::from_secs(600);

/// An asker held: since when, and when it last made a request.
struct Asker {
    since: Instant,
    active: Instant,
}
/// A server's answers a second: a budget of the names client's own, apart from the node's call
/// backs and trials, so a flood of questions can't keep the node's own lookups out.
pub const ANSWERS_PER_SECOND: usize = 4;
pub(super) const QUESTIONS_PER_SECOND: usize = 1;
pub const SYNC_EVERY: Duration = Duration::from_secs(300);
const SYNC_JITTER_MS: u64 = 30_000;
/// A range this small (on the answering side) is listed.
pub const LIST_MAX: u32 = 64;
/// Sync requests in flight to one partner.
const SYNC_PARALLEL: usize = 4;
/// A `have` names at most this many ids (a run tells 32 at a time), and what `have`s make us ask a peer waits at most
/// this many at once.
const HAVE_MAX: usize = 32;
const HAVE_GETS: usize = 64;
/// `put`s waiting to be verified: a peer's, and everyone's.
const PUTS_PER_PEER: usize = 4;
const PUTS_MAX: usize = 64;
/// Entry ids remembered as refused.
const REFUSED_KEPT: usize = 4096;
/// The most `sync`s a run sends: a registry of 20,000 names each differing takes ~4,400 (1 + 16 + 256 + 4,096 ranges).
pub const MAX_RUN_SYNCS: usize = 8192;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
/// Verification a turn: an entry costs 4 (Argon2id dominates, ~0.66 ms in Chromium's wasm), an
/// anchor or a zone 1: ~6 entries, ~4 ms.
pub const UNITS_PER_TURN: u32 = 24;
/// A record's `asked` is stored again only once it moved this far.
const ASKED_STORE: u64 = 3600;
/// Names dropped by the bound aren't fetched again by sync for this long (unless asked for).
const DROPPED_FOR: u64 = 24 * 3600;
/// How often names are settled for time alone.
const SETTLE_EVERY: Duration = Duration::from_secs(60);
/// Servers that synced with us are told `have` for this long after.
const SYNCED_WITH_FOR: Duration = Duration::from_secs(600);

pub struct Title {
    /// The name's owner key (its secret).
    pub key: [u8; 32],
    pub item: Item,
}

pub struct Config {
    pub params: Params,
    pub titles: Vec<Title>,
    pub max_names: usize,
    pub max_bytes: usize,
}

/// The spec's bound (room-names.md "Servers").
pub const MAX_NAMES: usize = 20_000;
pub const MAX_BYTES: usize = 128 << 20;

/// What the transport hands the registry.
#[derive(Debug, Clone)]
pub enum Input {
    /// A question under the names tag, opened and checked (its MAC, the time, a fresh nonce, a
    /// region of the link's, not our own key); `region` is the link's index for a call back.
    Question { q: Question, region: usize },
    /// A datagram on [`super::wire::NAMES_PORT`] from the peer with key `from`.
    Datagram { from: [u8; 32], data: Vec<u8> },
    /// The transport forgot that peer.
    Gone([u8; 32]),
}

/// What the registry asks the transport (or the page) to do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Cmd {
    /// A question under the names tag of the hour.
    Publish {
        nonce: [u8; 16],
        spread: u8,
    },
    /// Let in handshakes from keys we don't know until `until`, at most `max`.
    Accept {
        until: Instant,
        max: usize,
    },
    CallBack {
        key: [u8; 32],
        region: usize,
    },
    /// The peer with this key answered our question with a `serve` that held: it keeps its place in the window.
    Served([u8; 32]),
    Send {
        to: [u8; 32],
        data: Vec<u8>,
    },
    Forget([u8; 32]),
    /// Subscribe to the names tag (a server) or not.
    Subscribe(bool),
    /// Store a name's record (None: delete it).
    Store {
        id: [u8; 32],
        record: Option<Vec<u8>>,
    },
    Log(String),
}

/// The window a names client's question opens for handshakes from keys it doesn't know (room-names.md "Finding a
/// server"): the servers answering it, [`ACCEPT_MAX`] at most at once.
#[derive(Debug, Default)]
pub struct AcceptWindow {
    until: Option<Instant>,
    max: usize,
    /// Who came in and when, and whether its `serve` held.
    admitted: Vec<([u8; 32], Instant, bool)>,
}

impl AcceptWindow {
    pub fn open(&mut self, until: Instant, max: usize) {
        self.until = Some(until);
        self.max = max;
        self.admitted.clear();
    }

    /// The oldest key let in that never served and has had [`ACCEPT_GRACE`] to.
    fn evictable(&self, now: Instant) -> Option<usize> {
        (self.admitted.iter().enumerate())
            .filter(|(_, (_, at, served))| {
                !served && now.saturating_duration_since(*at) >= ACCEPT_GRACE
            })
            .min_by_key(|(_, (_, at, _))| *at)
            .map(|(i, _)| i)
    }

    /// Whether a handshake from a key we don't know may come in now: the window is open, and it has room or holds a
    /// key that came in a while ago and never served (junk, which then makes room: a fixed number of places taken
    /// first come would let anyone who reads the question shut every server out).
    pub fn room(&self, now: Instant) -> bool {
        self.until.is_some_and(|u| now < u)
            && (self.admitted.len() < self.max || self.evictable(now).is_some())
    }

    /// `key`'s handshake came in (after [`AcceptWindow::room`]): the key let go to make room for it, if any.
    pub fn admit(&mut self, key: [u8; 32], now: Instant) -> Option<[u8; 32]> {
        let gone = if self.admitted.len() >= self.max {
            self.evictable(now).map(|i| self.admitted.remove(i).0)
        } else {
            None
        };
        self.admitted.push((key, now, false));
        gone
    }

    /// `key`'s `serve` held.
    pub fn served(&mut self, key: &[u8; 32]) {
        for a in &mut self.admitted {
            if a.0 == *key {
                a.2 = true;
            }
        }
    }
}

/// `BLAKE2s(nonce, key)` over a live name's owner key: who answers a question (its share) and whom the asker keeps.
/// Over the owner key, not the names client's: an owner key costs a registration, a names client's key nothing, so
/// keys made after the nonce is seen can't buy a place.
pub fn share_hash(nonce: &[u8; 16], key: &[u8; 32]) -> [u8; 32] {
    let mut h = Blake2s256::new();
    h.update(nonce);
    h.update(key);
    h.finalize().into()
}

/// Whether hash `h` falls in the share `spread` names.
pub fn in_share(h: &[u8; 32], spread: u8) -> bool {
    let top = u64::from_be_bytes(h[..8].try_into().unwrap());
    spread == 0 || top >> (64 - spread.min(63) as u32) == 0
}

/// What a server signs to prove to server `to` that it, names client `from`, holds a live name (a run's first `sync`).
pub fn peer_hash(names: &RoomNames, to: &[u8; 32], from: &[u8; 32]) -> [u8; 32] {
    tagged("waarm64/names/peer", &[&names.value, to, from])
}

fn serve_hash(names: &RoomNames, nonce: &[u8; 16], server: &[u8; 32]) -> [u8; 32] {
    tagged("waarm64/names/serve", &[&names.value, nonce, server])
}

/// Whether `serve` (a [`Msg::Serve`] from the server with key `server`) answers our question
/// `nonce`: a live name's entry (checked whole: signature, proof of work, its headers and anchor,
/// its chain covering now) whose owner key signed the nonce and the server's key. The name's
/// owner key and id.
pub fn check_serve(
    names: &RoomNames,
    params: &Params,
    pow: &mut Pow,
    nonce: &[u8; 16],
    server: &[u8; 32],
    serve: &Msg,
    unix: u64,
) -> Result<([u8; 32], [u8; 32]), Invalid> {
    let Msg::Serve {
        nonce: n,
        entry,
        sig,
    } = serve
    else {
        return Err(Invalid::Encoding);
    };
    if n != nonce {
        return Err(Invalid::Signature);
    }
    check_live(
        names,
        params,
        pow,
        entry,
        &serve_hash(names, nonce, server),
        sig,
        unix,
    )
}

/// Whether `entry` is a live name's (checked whole, its chain covering now) whose owner key signed `msg`: the owner key
/// and the name id.
fn check_live(
    names: &RoomNames,
    params: &Params,
    pow: &mut Pow,
    entry: &WireEntry,
    msg: &[u8; 32],
    sig: &[u8; 64],
    unix: u64,
) -> Result<([u8; 32], [u8; 32]), Invalid> {
    let mut s = Stamped::check(
        entry.entry.clone(),
        entry.ref_header,
        names,
        params,
        pow,
        unix,
    )?;
    let Some((a, h)) = entry.anchor.clone() else {
        return Err(Invalid::AnchorRoot);
    };
    s.offer_anchor(a, h, params, unix)?;
    let mut n = Name::new(s.entry.name);
    let owner = s.entry.owner;
    n.insert(s, params, unix);
    if !n.chains(params).iter().any(|c| c.covers(unix)) {
        return Err(Invalid::AnchorWindow); // a dead name's key
    }
    if !verify(&owner, msg, sig) {
        return Err(Invalid::Signature);
    }
    Ok((owner, n.id))
}

/// An answer to a question: the hash of the owner key it served with, the owner key, the name id.
pub(super) type Answered = ([u8; 32], [u8; 32], [u8; 32]);

/// A question of ours (a server's or a member's).
pub(super) struct Ask {
    pub nonce: [u8; 16],
    pub started: Instant,
    /// Rounds sent.
    pub round: usize,
    pub first: Option<Instant>,
    /// Servers whose `serve` held, by their names client's key: the hash of the owner key they served with, the owner
    /// key and the name id.
    pub answers: BTreeMap<[u8; 32], Answered>,
}

impl Ask {
    pub fn new(nonce: [u8; 16], now: Instant) -> Ask {
        Ask {
            nonce,
            started: now,
            round: 1,
            first: None,
            answers: BTreeMap::new(),
        }
    }

    /// A `serve` from `from` that held, with owner key `owner` on name `name`: counted when its hash is in the share of
    /// a round sent (an honest server answers only so), and once a name: a registration answering from many keys is
    /// one answer.
    pub fn offer(
        &mut self,
        from: [u8; 32],
        owner: [u8; 32],
        name: [u8; 32],
        now: Instant,
    ) -> Result<(), &'static str> {
        let h = share_hash(&self.nonce, &owner);
        let spread = SPREADS[self.round.clamp(1, SPREADS.len()) - 1];
        if !in_share(&h, spread) {
            return Err("outside the share asked");
        }
        if (self.answers.values()).any(|(_, o, n)| *o == owner || *n == name) {
            return Err("a name that answered already");
        }
        self.answers.insert(from, (h, owner, name));
        self.first.get_or_insert(now);
        Ok(())
    }

    /// The two answers with the lowest hash (not the fastest, which an attacker could always be), and the others.
    pub fn choose(&self) -> (Vec<[u8; 32]>, Vec<[u8; 32]>) {
        let mut by: Vec<([u8; 32], [u8; 32])> =
            self.answers.iter().map(|(k, a)| (a.0, *k)).collect();
        by.sort();
        let rest = by.split_off(by.len().min(2));
        (
            by.into_iter().map(|x| x.1).collect(),
            rest.into_iter().map(|x| x.1).collect(),
        )
    }
}

/// A request of ours waiting for its answer.
enum Req {
    Sync(Range),
    /// A `get`, part of a sync run with that peer or not.
    Get(bool),
    Put,
}

/// A sync with one partner.
#[derive(Default)]
struct Run {
    stack: Vec<Range>,
    /// The listed ids to `get` (8 bytes each), sent as the stack's ranges are, [`SYNC_PARALLEL`] at once.
    gets: VecDeque<[u8; 8]>,
    outstanding: usize,
    /// Requests sent: `sync`s and `get`s (each bounded).
    syncs: usize,
    got: usize,
    /// Ids the partner lacks or holds otherwise: told `have` at the end.
    have: BTreeSet<[u8; 32]>,
}

/// Something taken to be verified: where it came from, the item, how far it got.
struct Job {
    /// The peer and the transfer to answer (a `put`), or just the peer it came from.
    from: Option<([u8; 32], Option<u32>)>,
    item: Item,
    next: usize,
    checked: Vec<Stamped>,
    zone_checked: bool,
    /// An entry of it failed a check only a forgery fails: nothing of it is kept.
    forged: bool,
}

impl Job {
    fn new(from: Option<([u8; 32], Option<u32>)>, item: Item) -> Job {
        Job {
            from,
            item,
            next: 0,
            checked: Vec::new(),
            zone_checked: false,
            forged: false,
        }
    }

    fn peer(&self) -> Option<[u8; 32]> {
        self.from.map(|f| f.0)
    }
}

pub struct Server {
    names: RoomNames,
    params: Params,
    pow: Pow,
    pub reg: Registry,
    titles: Vec<(SigningKey, [u8; 32])>,
    own: BTreeSet<[u8; 32]>,
    /// The zones of this node's titles, as the titles carry them: a name not public yet answers from them.
    title_zones: BTreeMap<[u8; 32], Zone>,
    max_names: usize,
    max_bytes: usize,
    /// The names client's key, once its transport runs.
    key: Option<[u8; 32]>,
    xf: Transfers,
    reqs: BTreeMap<([u8; 32], u32), (Req, Instant)>,
    ask: Option<Ask>,
    nobody: Option<(Instant, Duration)>,
    questions: VecDeque<Instant>,
    answers: VecDeque<Instant>,
    askers: BTreeMap<[u8; 32], Asker>,
    /// Call backs waiting out [`CROSSED_WAIT`].
    deferred: Vec<(Instant, [u8; 32], usize)>,
    /// The first sync is done (or nobody answered): only then does it answer questions.
    pub synced: bool,
    next_round: Option<Instant>,
    runs: BTreeMap<[u8; 32], Run>,
    synced_with: BTreeMap<[u8; 32], Instant>,
    /// What sync (and `have`) brought from servers, verified first: a first sync is over once these are.
    jobs: VecDeque<Job>,
    /// What anyone `put`, verified after, a slice of one job a turn in turn.
    puts: VecDeque<Job>,
    /// Entry ids that failed a check only a forgery fails, lately: not checked again.
    refused: BTreeSet<[u8; 32]>,
    refused_order: VecDeque<[u8; 32]>,
    /// Peers that proved a live name: the servers our questions chose, and those whose `sync` carried a proof.
    proven: BTreeSet<[u8; 32]>,
    /// Peers whose proof was checked this session.
    proof_tried: BTreeSet<[u8; 32]>,
    /// What each peer's syncs cost us this sync round: since when, and how many items fingerprinted.
    sync_spent: BTreeMap<[u8; 32], (Instant, u64)>,
    dropped: BTreeMap<[u8; 32], u64>,
    settle_at: Option<Instant>,
    cmds: VecDeque<Cmd>,
    /// The answers to our `put`s, for whoever made them (the agent; the tests).
    pub put_answers: Vec<([u8; 32], Msg)>,
    /// Counters for the page's details and the tests.
    pub stats: Stats,
    /// The clock as the last tick or input gave it.
    now: Instant,
    last_unix: u64,
    /// The round's runs are over: synced once what they brought is verified.
    round_over: bool,
    /// The tests' lying server: names it never keeps (so never lists or serves).
    #[cfg(test)]
    pub refuse: BTreeSet<[u8; 32]>,
}

#[derive(Debug, Default, Clone)]
pub struct Stats {
    pub answered: usize,
    pub refused: usize,
    pub rounds: usize,
    pub syncs: usize,
    /// Entries checked whole.
    pub checked: usize,
}

pub(super) fn random<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    let _ = getrandom::fill(&mut b);
    b
}

impl Server {
    pub fn new(room_id: &str, cfg: Config, unix: u64) -> Server {
        let names = RoomNames::derive(room_id);
        let mut s = Server {
            pow: Pow::new(&cfg.params),
            params: cfg.params,
            names,
            reg: Registry::default(),
            titles: Vec::new(),
            own: BTreeSet::new(),
            title_zones: BTreeMap::new(),
            max_names: cfg.max_names,
            max_bytes: cfg.max_bytes,
            key: None,
            xf: Transfers::default(),
            reqs: BTreeMap::new(),
            ask: None,
            nobody: None,
            questions: VecDeque::new(),
            answers: VecDeque::new(),
            askers: BTreeMap::new(),
            deferred: Vec::new(),
            synced: false,
            next_round: None,
            runs: BTreeMap::new(),
            synced_with: BTreeMap::new(),
            jobs: VecDeque::new(),
            puts: VecDeque::new(),
            refused: BTreeSet::new(),
            refused_order: VecDeque::new(),
            proven: BTreeSet::new(),
            proof_tried: BTreeSet::new(),
            sync_spent: BTreeMap::new(),
            dropped: BTreeMap::new(),
            settle_at: None,
            cmds: VecDeque::new(),
            put_answers: Vec::new(),
            stats: Stats::default(),
            now: Instant::now(),
            last_unix: unix,
            round_over: false,
            #[cfg(test)]
            refuse: BTreeSet::new(),
        };
        s.set_titles(cfg.titles, unix);
        s
    }

    /// This node's titles (the page's names agent keeps them): those given replace those held, each taken as stored
    /// (the agent made and checked it), so a title's renewals, anchors and zone reach the registry as they change.
    pub fn set_titles(&mut self, titles: Vec<Title>, unix: u64) {
        self.titles.clear();
        self.own.clear();
        self.title_zones.clear();
        for t in titles {
            let Ok(key) = SigningKey::from_bytes(&t.key) else {
                continue;
            };
            let id = t.item.id;
            self.titles.push((key, id));
            self.own.insert(id);
            if let Some(z) = t.item.zone.clone() {
                self.title_zones.insert(id, z);
            }
            self.take_trusted(t.item, unix, unix);
        }
    }

    /// What the resolver answers on a server's node for `full` (relative to the room's domain, passed the rules),
    /// whose registered name is `name`: from the registry, which a server holds whole; a name of this node's own not
    /// public yet (or lapsed) from its title's zone, or this node's address; a name not held waits until the first
    /// sync is over, then is NXDOMAIN.
    pub fn resolve(&self, full: &str, name: &str, unix: u64) -> Answer {
        let id = self.names.name_id(name);
        let held = self
            .reg
            .get(&id)
            .filter(|h| h.owner.as_ref().is_some_and(|o| o.resolves(unix)));
        if let Some(h) = held {
            let node = h.zone.as_ref().and_then(|z| z.open(&self.names, full));
            return node.map_or(Answer::Nx, Answer::Node);
        }
        if self.own.contains(&id) {
            if let Some(k) = self
                .title_zones
                .get(&id)
                .and_then(|z| z.open(&self.names, full))
            {
                return Answer::Node(k);
            }
            return if full == name {
                Answer::Own
            } else {
                Answer::Nx
            };
        }
        if self.synced {
            Answer::Nx
        } else {
            Answer::Wait
        }
    }

    /// The names client's key: the transport runs. Subscribes and starts the first round.
    pub fn start(&mut self, key: [u8; 32], now: Instant) {
        self.now = now;
        self.key = Some(key);
        self.cmds.push_back(Cmd::Subscribe(true));
        self.next_round = Some(now);
        self.settle_at = Some(now + SETTLE_EVERY);
    }

    /// The transport is gone (it failed, or closed): everything tied to its key goes.
    pub fn stop(&mut self) {
        self.key = None;
        self.xf = Transfers::default();
        self.reqs.clear();
        self.ask = None;
        self.askers.clear();
        self.runs.clear();
        self.synced_with.clear();
        self.proven.clear();
        self.proof_tried.clear();
        self.sync_spent.clear();
    }

    pub fn names(&self) -> &RoomNames {
        &self.names
    }

    /// The servers it synced with lately (the page's details: "servers held").
    pub fn partners(&self) -> usize {
        self.synced_with.len()
    }

    pub fn poll(&mut self) -> Option<Cmd> {
        self.cmds.pop_front()
    }

    fn log(&mut self, s: String) {
        self.cmds.push_back(Cmd::Log(s));
    }

    /// A stored record, streamed in at the start: verified when it was taken, so trusted. False when nothing of it is
    /// held (not a server's record, or a lapsed name's): the page deletes it.
    pub fn load(&mut self, record: &[u8], unix: u64) -> bool {
        let Some((asked, item)) = read_record(record) else {
            return false;
        };
        let id = item.id;
        self.take_trusted(item, asked, unix);
        self.bound(unix);
        self.reg.get(&id).is_some()
    }

    /// The bound: what it drops is deleted from the store and not fetched again by sync for a
    /// while.
    fn bound(&mut self, unix: u64) {
        for d in self.reg.bound(self.max_names, self.max_bytes, &self.own) {
            self.dropped.insert(d, unix);
            self.cmds.push_back(Cmd::Store {
                id: d,
                record: None,
            });
        }
    }

    fn take_trusted(&mut self, item: Item, asked: u64, unix: u64) {
        let id = item.id;
        let mut h = self.reg.take(&id).unwrap_or_else(|| Held::new(id, asked));
        h.asked = h.asked.max(asked);
        for e in item.entries {
            if e.entry.name == id {
                h.name.insert(e.trusted(), &self.params, unix);
            }
        }
        h.settle(&self.params, unix);
        if let Some(z) = item.zone
            && z.room == self.names.room
        {
            h.offer_zone(z, unix, false);
        }
        h.settle(&self.params, unix);
        if !h.is_empty() {
            self.reg.put(h);
        }
    }

    // ---- Time ----

    pub fn deadline(&self) -> Option<Instant> {
        let ask = self.ask.as_ref().map(|a| match a.first {
            Some(f) => f + CHOOSE_AFTER,
            None => match ROUND_AT.get(a.round) {
                Some(d) => a.started + *d,
                None => a.started + GIVE_UP,
            },
        });
        // Verification waits: the next turn at once (a slice a turn).
        let jobs = (self.jobs.front().or(self.puts.front())).map(|_| self.now);
        [
            ask,
            self.next_round,
            self.xf.deadline(),
            self.reqs.values().map(|(_, t)| *t).min(),
            (self.askers.values())
                .map(|a| (a.active + ASKER_IDLE).min(a.since + ASKER_LIFE))
                .min(),
            self.settle_at,
            self.deferred.iter().map(|(t, _, _)| *t).min(),
            jobs,
        ]
        .into_iter()
        .flatten()
        .min()
    }

    /// The askers held now.
    pub fn askers(&self) -> usize {
        self.askers.len()
    }

    /// Whether verification is waiting (the transport ticks again at once).
    pub fn busy(&self) -> bool {
        !self.jobs.is_empty() || !self.puts.is_empty()
    }

    pub fn tick(&mut self, now: Instant, unix: u64) {
        if self.key.is_none() {
            return;
        }
        self.now = now;
        self.last_unix = unix;
        self.verify_slice(now, unix);
        if self.round_over && self.jobs.is_empty() {
            self.round_over = false;
            if !self.synced {
                self.log("synced: answering questions".into());
            }
            self.synced = true;
        }
        // Our question's rounds, its choice, or nobody.
        if let Some(a) = &self.ask {
            if let Some(f) = a.first {
                if now >= f + CHOOSE_AFTER {
                    self.choose(now, unix);
                }
            } else if a.round < SPREADS.len() {
                if now >= a.started + ROUND_AT[a.round] {
                    let (nonce, spread) = (a.nonce, SPREADS[a.round]);
                    self.ask.as_mut().unwrap().round += 1;
                    self.cmds.push_back(Cmd::Publish { nonce, spread });
                }
            } else if now >= a.started + GIVE_UP {
                self.nobody_answered(now);
            }
        }
        let (due, wait): (Vec<_>, Vec<_>) =
            self.deferred.drain(..).partition(|(t, _, _)| *t <= now);
        self.deferred = wait;
        for (_, key, region) in due {
            self.cmds.push_back(Cmd::CallBack { key, region });
        }
        if self.next_round.is_some_and(|t| t <= now) && self.ask.is_none() {
            self.next_round = None;
            self.start_question(now);
        }
        for (k, id) in self.xf.tick(now) {
            self.failed(k, id);
        }
        let late: Vec<([u8; 32], u32)> = self
            .reqs
            .iter()
            .filter(|(_, (_, t))| *t <= now)
            .map(|(k, _)| *k)
            .collect();
        for (k, id) in late {
            self.failed(k, id);
        }
        let idle: Vec<[u8; 32]> = self
            .askers
            .iter()
            .filter(|(_, a)| now >= a.active + ASKER_IDLE || now >= a.since + ASKER_LIFE)
            .map(|(k, _)| *k)
            .collect();
        for k in idle {
            self.askers.remove(&k);
            if !self.runs.contains_key(&k) {
                self.cmds.push_back(Cmd::Forget(k));
            }
        }
        self.synced_with
            .retain(|_, t| now.saturating_duration_since(*t) < SYNCED_WITH_FOR);
        if self.settle_at.is_some_and(|t| t <= now) {
            self.settle_at = Some(now + SETTLE_EVERY);
            for id in self.reg.settle_due(&Range::ALL, &self.params, unix) {
                self.stored(&id);
            }
            self.dropped.retain(|_, t| unix < *t + DROPPED_FOR);
        }
        self.flush();
    }

    // ---- Asking ----

    fn start_question(&mut self, now: Instant) {
        if !room_in(&mut self.questions, QUESTIONS_PER_SECOND, now) {
            self.next_round = Some(now + Duration::from_secs(1));
            return;
        }
        self.questions.push_back(now);
        let nonce = random();
        self.ask = Some(Ask::new(nonce, now));
        self.stats.rounds += 1;
        self.cmds.push_back(Cmd::Accept {
            until: now + GIVE_UP,
            max: ACCEPT_MAX,
        });
        self.cmds.push_back(Cmd::Publish {
            nonce,
            spread: SPREADS[0],
        });
    }

    fn nobody_answered(&mut self, now: Instant) {
        self.ask = None;
        let wait = self
            .nobody
            .map_or(NOBODY_FIRST, |(_, w)| (w * 2).min(NOBODY_MAX));
        self.nobody = Some((now + wait, wait));
        // Servers that started together don't ask together again.
        let again = wait.min(SYNC_EVERY);
        let jitter = Duration::from_millis(
            u64::from_le_bytes(random()) % (again.as_millis() as u64 / 5 + 1),
        );
        self.log(format!(
            "nobody serves the registry; asking again in {} s",
            (again + jitter).as_secs()
        ));
        // Alone: there is nothing to sync with, so it serves.
        self.synced = true;
        self.next_round = Some(now + again + jitter);
    }

    /// Whether we remember that nobody serves (a member's queries get NXDOMAIN at once: N3).
    pub fn nobody_until(&self) -> Option<Instant> {
        self.nobody.map(|(t, _)| t)
    }

    fn on_serve(&mut self, from: [u8; 32], m: Msg, now: Instant, unix: u64) {
        let Some(a) = &self.ask else {
            return self.cmds.push_back(Cmd::Forget(from));
        };
        let nonce = a.nonce;
        if a.answers.contains_key(&from) {
            return;
        }
        let ok = check_serve(
            &self.names,
            &self.params,
            &mut self.pow,
            &nonce,
            &from,
            &m,
            unix,
        );
        let (owner, name) = match ok {
            Ok(x) => x,
            Err(e) => {
                self.log(format!("a serve refused: {e:?}"));
                return self.cmds.push_back(Cmd::Forget(from));
            }
        };
        if let Err(why) = self.ask.as_mut().unwrap().offer(from, owner, name, now) {
            self.log(format!("a serve refused: {why}"));
            return self.cmds.push_back(Cmd::Forget(from));
        }
        self.cmds.push_back(Cmd::Served(from));
    }

    /// The two answers with the lowest hash are kept (not the fastest, which an attacker could
    /// always be); the others are let go. A server syncs with both.
    fn choose(&mut self, now: Instant, _unix: u64) {
        let a = self.ask.take().unwrap();
        self.nobody = None;
        let (keep, rest) = a.choose();
        self.cmds.push_back(Cmd::Accept { until: now, max: 0 });
        for k in keep {
            self.proven.insert(k);
            self.start_run(k, now);
        }
        for k in rest {
            self.cmds.push_back(Cmd::Forget(k));
        }
        let jitter = u64::from_le_bytes(random()) % (2 * SYNC_JITTER_MS);
        self.next_round = Some(
            now + SYNC_EVERY + Duration::from_millis(jitter)
                - Duration::from_millis(SYNC_JITTER_MS),
        );
    }

    // ---- Answering ----

    /// Whether we would answer a question with `nonce` and `spread` now with a live name whose owner key's hash is `h`
    /// (the share, synced, the budget): the answer rule. With every asker's place taken, the one held longest makes
    /// room.
    fn answers_rule(
        &mut self,
        q: &Question,
        h: &[u8; 32],
        now: Instant,
    ) -> Result<(), &'static str> {
        if self.key.is_none() {
            return Err("not running");
        }
        if !in_share(h, q.spread) {
            return Err("outside the share");
        }
        if !self.synced {
            return Err("not synced yet");
        }
        if !room_in(&mut self.answers, ANSWERS_PER_SECOND, now) {
            return Err("over the budget");
        }
        Ok(())
    }

    /// The live names of ours to serve with: each one's owning chain's last entry and the key.
    fn live_titles(&self, unix: u64) -> Vec<(SigningKey, WireEntry)> {
        (self.titles.iter())
            .filter_map(|(k, id)| {
                let h = self.reg.get(id)?;
                let o = h.owner.as_ref()?;
                let pk: [u8; 32] = k.verifying_key().to_bytes().into();
                (o.owner == pk && o.covers(unix))
                    .then(|| h.name.get(&o.last()).map(|e| (k.clone(), WireEntry::of(e))))
                    .flatten()
            })
            .collect()
    }

    /// The live name of ours whose owner key has the lowest hash for `nonce`, and that hash.
    fn live_title(&self, nonce: &[u8; 16], unix: u64) -> Option<(SigningKey, WireEntry, [u8; 32])> {
        (self.live_titles(unix).into_iter())
            .map(|(k, e)| {
                let h = share_hash(nonce, &e.entry.owner);
                (k, e, h)
            })
            .min_by_key(|x| x.2)
    }

    fn on_question(&mut self, q: Question, region: usize, now: Instant, unix: u64) {
        let Some((k, entry, h)) = self.live_title(&q.nonce, unix) else {
            self.stats.refused += 1;
            return;
        };
        if let Err(why) = self.answers_rule(&q, &h, now) {
            if why != "outside the share" {
                self.stats.refused += 1;
            }
            return;
        }
        // Every asker's place taken: the one held longest goes (junk can't keep them all for good), but never a sync
        // partner of this round.
        if self.askers.len() >= MAX_ASKERS && !self.askers.contains_key(&q.key) {
            let old = (self.askers.iter())
                .filter(|(k, _)| !self.runs.contains_key(*k))
                .min_by_key(|(_, a)| a.since)
                .map(|(k, _)| *k);
            let Some(old) = old else {
                self.stats.refused += 1;
                return;
            };
            self.askers.remove(&old);
            self.cmds.push_back(Cmd::Forget(old));
        }
        self.answers.push_back(now);
        self.stats.answered += 1;
        let me = self.key.unwrap();
        let sig = sign(&k, &serve_hash(&self.names, &q.nonce, &me));
        self.askers
            .entry(q.key)
            .or_insert(Asker {
                since: now,
                active: now,
            })
            .active = now;
        if self.ask.is_some() && me > q.key {
            self.deferred.push((now + CROSSED_WAIT, q.key, region));
        } else {
            self.cmds.push_back(Cmd::CallBack { key: q.key, region });
        }
        let m = Msg::Serve {
            nonce: q.nonce,
            entry: Box::new(entry),
            sig,
        };
        self.xf.send(q.key, &m.encode(0), now);
        self.flush();
    }

    // ---- Messages ----

    pub fn input(&mut self, i: Input, now: Instant, unix: u64) {
        if self.key.is_none() {
            return;
        }
        self.now = now;
        self.last_unix = unix;
        match i {
            Input::Question { q, region } => self.on_question(q, region, now, unix),
            Input::Gone(k) => self.gone(k),
            Input::Datagram { from, data } => {
                if let Some((xid, payload)) = self.xf.input(from, &data, now) {
                    match Msg::decode(&payload) {
                        Ok((m, reply)) => {
                            // Only a request keeps an asker: junk, or a part of one, doesn't.
                            if let Some(a) = self.askers.get_mut(&from) {
                                a.active = now;
                            }
                            self.on_msg(from, xid, reply, m, now, unix)
                        }
                        Err(e) => self.log(format!("a message refused: {e:?}")),
                    }
                }
            }
        }
        self.flush();
    }

    fn send(&mut self, to: [u8; 32], m: &Msg, reply: u32, now: Instant) -> u32 {
        self.xf.send(to, &m.encode(reply), now)
    }

    fn request(&mut self, to: [u8; 32], m: &Msg, r: Req, now: Instant) {
        let id = self.send(to, m, 0, now);
        self.reqs.insert((to, id), (r, now + REQUEST_TIMEOUT));
    }

    fn flush(&mut self) {
        for (to, data) in std::mem::take(&mut self.xf.out) {
            self.cmds.push_back(Cmd::Send { to, data });
        }
    }

    fn on_msg(&mut self, from: [u8; 32], xid: u32, reply: u32, m: Msg, now: Instant, unix: u64) {
        if reply != 0 {
            let Some((r, _)) = self.reqs.remove(&(from, reply)) else {
                return;
            };
            return self.on_answer(from, r, m, now);
        }
        // A server's requests (sync, have, get of everything) only from a server that proved a live name: an asker's
        // session is anyone's, and each of those costs this one work.
        let server_only = matches!(
            m,
            Msg::Sync { .. }
                | Msg::Have(_)
                | Msg::Get {
                    mode: GetMode::All,
                    ..
                }
        );
        if server_only && !self.proven.contains(&from) {
            if let Msg::Sync { proof: Some(p), .. } = &m
                && self.check_proof(from, p, unix)
            {
                self.proven.insert(from);
            } else {
                return self.log("a server's request refused: no live name shown".into());
            }
        }
        match m {
            m @ Msg::Serve { .. } => self.on_serve(from, m, now, unix),
            Msg::Sync { range, fp, .. } => {
                // A budget of what it may make us fingerprint, renewed every sync round: a run over all of a
                // registry costs about 8 items a name.
                let budget = 16 * (self.reg.len() as u64 + LIST_MAX as u64);
                let spent = self.sync_spent.entry(from).or_insert((now, 0));
                if now.saturating_duration_since(spent.0) >= SYNC_EVERY {
                    *spent = (now, 0);
                }
                if spent.1 > budget {
                    return self.log("a sync refused: past its budget".into());
                }
                self.synced_with.insert(from, now);
                for id in self.reg.settle_due(&range, &self.params, unix) {
                    self.stored(&id);
                }
                let mine = self.reg.fp(&range);
                let a = if mine == fp {
                    SyncAnswer::Same
                } else if mine.count <= LIST_MAX || range.depth >= 64 {
                    SyncAnswer::Listing(self.reg.listing(&range))
                } else {
                    SyncAnswer::Children(self.reg.children(&range))
                };
                if let Some(x) = self.sync_spent.get_mut(&from) {
                    x.1 += 2 * mine.count as u64 + 1;
                }
                self.send(from, &Msg::SyncAnswer(a), xid, now);
            }
            Msg::Get {
                mode: GetMode::Ids,
                id,
                ..
            } => {
                // Each with until when its owner holds it (its cover's end; 0: nobody does now), for the dialog's
                // "taken until about".
                let ids = (self.reg.matching(&id).into_iter())
                    .map(|i| {
                        let owner = self.reg.get(&i).and_then(|h| h.owner.as_ref());
                        let until = owner
                            .filter(|o| !o.released && o.covers(unix))
                            .map_or(0, |o| o.cover_end);
                        (i, until)
                    })
                    .collect();
                self.send(from, &Msg::Ids(ids), xid, now);
            }
            Msg::Get {
                mode,
                id,
                zone,
                held,
            } => {
                let mut items = Vec::new();
                for i in self.reg.matching(&id) {
                    if self.reg.get(&i).is_some_and(|h| h.stale(unix))
                        && self.reg.settle(&i, &self.params, unix)
                    {
                        self.stored(&i);
                    }
                    let Some(h) = self.reg.items.get_mut(&i) else {
                        continue;
                    };
                    match mode {
                        GetMode::All => items.push(h.lacking(&held, zone)),
                        GetMode::Ids => {}
                        GetMode::Owner | GetMode::History => {
                            let history = mode == GetMode::History;
                            items.extend(h.owner_answer(&held, zone, history));
                            let moved = unix.saturating_sub(h.asked) >= ASKED_STORE;
                            h.asked = h.asked.max(unix);
                            if moved {
                                self.stored(&i);
                            }
                        }
                    }
                }
                if matches!(mode, GetMode::Owner | GetMode::History) && id.len() == 32 {
                    self.dropped.remove(&<[u8; 32]>::try_from(&id[..]).unwrap());
                }
                self.send(from, &Msg::Items(items), xid, now);
            }
            Msg::Have(ids) => {
                // A run tells 32 at a time; what it makes us ask, at most HAVE_GETS at once.
                if ids.len() > HAVE_MAX {
                    return self.log("a have refused: too long".into());
                }
                for id in ids {
                    let waiting = (self.reqs.iter())
                        .filter(|((p, _), (r, _))| *p == from && matches!(r, Req::Get(false)))
                        .count();
                    if self.dropped.contains_key(&id) || waiting >= HAVE_GETS {
                        continue;
                    }
                    let get = self.get_for(&id[..]);
                    self.request(from, &get, Req::Get(false), now);
                }
            }
            Msg::Put(item) => {
                // Anyone may put (an owner's agent, a member): its own few at a time, and a bounded queue.
                let theirs = self.puts.iter().filter(|j| j.peer() == Some(from)).count();
                if theirs >= PUTS_PER_PEER || self.puts.len() >= PUTS_MAX {
                    return self.log("a put refused: its queue is full".into());
                }
                self.puts.push_back(Job::new(Some((from, Some(xid))), item));
            }
            // Answers without a request (ours timed out): nothing to do.
            Msg::Items(_) | Msg::Taken | Msg::Better(_) | Msg::SyncAnswer(_) | Msg::Ids(_) => {}
        }
    }

    /// A `get` of everything held under `id` (an 8- or 32-byte prefix) that we lack.
    fn get_for(&self, id: &[u8]) -> Msg {
        let mine = self.reg.matching(id);
        let h = mine.first().and_then(|i| self.reg.get(i));
        Msg::Get {
            mode: GetMode::All,
            id: id.to_vec(),
            zone: zone_tag(h.and_then(|h| h.zone.as_ref())),
            held: h.map(Held::held_tags).unwrap_or_default(),
        }
    }

    fn on_answer(&mut self, from: [u8; 32], r: Req, m: Msg, now: Instant) {
        match (r, m) {
            (Req::Sync(range), Msg::SyncAnswer(a)) => {
                self.on_sync_answer(from, range, a);
                self.run_done(from, now);
            }
            (Req::Get(in_run), Msg::Items(items)) => {
                for item in items {
                    if !item.entries.is_empty() || item.zone.is_some() {
                        self.jobs.push_back(Job::new(Some((from, None)), item));
                    }
                }
                if in_run {
                    self.run_done(from, now);
                }
            }
            (Req::Put, m @ (Msg::Taken | Msg::Better(_))) => self.put_answers.push((from, m)),
            (Req::Sync(_) | Req::Get(true), _) => self.run_done(from, now),
            (_, _) => {}
        }
    }

    fn on_sync_answer(&mut self, from: [u8; 32], range: Range, a: SyncAnswer) {
        let Some(run) = self.runs.get_mut(&from) else {
            return;
        };
        match a {
            SyncAnswer::Same => {}
            // A range of 63 nibbles holds at most 16 ids, which an honest partner lists.
            SyncAnswer::Children(_) if range.depth >= 63 => {
                self.end_run(from, "sixteenths of a range past the last nibble")
            }
            SyncAnswer::Listing(l) if l.len() > LIST_MAX as usize => {
                self.end_run(from, "a listing longer than a listing may be")
            }
            SyncAnswer::Children(theirs) => {
                for (k, t) in theirs.iter().enumerate() {
                    let c = range.child(k as u8);
                    let mine = self.reg.fp(&c);
                    if mine == *t {
                        continue;
                    }
                    if t.count == 0 {
                        let (lo, hi) = c.bounds();
                        run.have
                            .extend(self.reg.items.range(lo..=hi).map(|(id, _)| *id));
                    } else {
                        run.stack.push(c);
                    }
                }
            }
            SyncAnswer::Listing(theirs) => {
                let (lo, hi) = range.bounds();
                let mine: BTreeMap<[u8; 8], ([u8; 32], [u8; 8])> = self
                    .reg
                    .items
                    .range(lo..=hi)
                    .map(|(id, h)| (id[..8].try_into().unwrap(), (*id, h.version)))
                    .collect();
                let theirs: BTreeMap<[u8; 8], [u8; 8]> = theirs.into_iter().collect();
                let mut gets = Vec::new();
                for (i, v) in &theirs {
                    let differs = mine.get(i).is_none_or(|(_, mv)| mv != v);
                    let dropped = self.dropped.range(lo..=hi).any(|(d, _)| d[..8] == i[..]);
                    if differs && !dropped {
                        gets.push(*i);
                    }
                }
                for (i, (id, v)) in &mine {
                    if theirs.get(i).is_none_or(|tv| tv != v) {
                        run.have.insert(*id);
                    }
                }
                run.gets.extend(gets);
            }
        }
    }

    /// Whether `p`, in a `sync` from `from`, proves a live name: checked once a session (a refused proof isn't
    /// checked again, so junk proofs cost one check).
    fn check_proof(&mut self, from: [u8; 32], p: &Proof, unix: u64) -> bool {
        let Some(me) = self.key else { return false };
        if !self.proof_tried.insert(from) {
            return false;
        }
        let msg = peer_hash(&self.names, &me, &from);
        let ok = check_live(
            &self.names,
            &self.params,
            &mut self.pow,
            &p.entry,
            &msg,
            &p.sig,
            unix,
        );
        if let Err(e) = &ok {
            self.log(format!("a server's proof refused: {e:?}"));
        }
        ok.is_ok()
    }

    /// Our proof to server `to` that we hold a live name, for a run's first `sync`.
    fn proof_for(&self, to: &[u8; 32], unix: u64) -> Option<Box<Proof>> {
        let me = self.key?;
        let (k, entry) = self.live_titles(unix).into_iter().next()?;
        let sig = sign(&k, &peer_hash(&self.names, to, &me));
        Some(Box::new(Proof { entry, sig }))
    }

    /// A partner that broke the protocol: the round with it ends (what it sent so far stays, checked as anything is).
    fn end_run(&mut self, partner: [u8; 32], why: &str) {
        self.log(format!("a sync partner refused: {why}"));
        if self.runs.remove(&partner).is_some() && self.runs.is_empty() {
            self.round_over = true;
        }
    }

    // ---- Sync ----

    fn start_run(&mut self, partner: [u8; 32], now: Instant) {
        self.stats.syncs += 1;
        self.runs.insert(
            partner,
            Run {
                stack: vec![Range::ALL],
                ..Run::default()
            },
        );
        self.run_done(partner, now);
    }

    /// A request of run `partner`'s finished (or it starts): the next ones go out; with none
    /// left, the partner is told what it lacks, and the round is over.
    fn run_done(&mut self, partner: [u8; 32], now: Instant) {
        let Some(run) = self.runs.get_mut(&partner) else {
            return;
        };
        run.outstanding = run.outstanding.saturating_sub(1);
        let mut send = Vec::new();
        let mut gets = Vec::new();
        while run.outstanding < SYNC_PARALLEL {
            if let Some(i) = run.gets.pop_front() {
                run.got += 1;
                gets.push(i);
            } else if let Some(r) = run.stack.pop() {
                run.syncs += 1;
                send.push(r);
            } else {
                break;
            }
            run.outstanding += 1;
        }
        if run.syncs > MAX_RUN_SYNCS || run.got > self.max_names + LIST_MAX as usize {
            return self.end_run(partner, "a run past its bound");
        }
        for i in gets {
            let get = self.get_for(&i);
            self.request(partner, &get, Req::Get(true), now);
        }
        for range in send {
            // Settled first, so both sides compare what time has made of the same entries.
            let unix = self.reg_now();
            for id in self.reg.settle_due(&range, &self.params, unix) {
                self.stored(&id);
            }
            let fp = self.reg.fp(&range);
            // The run's first carries our proof that we serve.
            let proof = (range == Range::ALL)
                .then(|| self.proof_for(&partner, unix))
                .flatten();
            self.request(
                partner,
                &Msg::Sync { range, fp, proof },
                Req::Sync(range),
                now,
            );
        }
        let run = &self.runs[&partner];
        if run.outstanding == 0 && run.stack.is_empty() && run.gets.is_empty() {
            let run = self.runs.remove(&partner).unwrap();
            let ids: Vec<[u8; 32]> = run.have.into_iter().collect();
            for c in ids.chunks(32) {
                self.send(partner, &Msg::Have(c.to_vec()), 0, now);
            }
            if self.runs.is_empty() {
                self.round_over = true;
            }
        }
    }

    /// The clock for settling inside sync: the last one a tick or input gave.
    fn reg_now(&self) -> u64 {
        self.last_unix
    }

    fn failed(&mut self, k: [u8; 32], id: u32) {
        if let Some((r, _)) = self.reqs.remove(&(k, id))
            && matches!(r, Req::Sync(_) | Req::Get(true))
        {
            if let Some(run) = self.runs.get_mut(&k) {
                // A partner that doesn't answer: the round with it ends.
                run.stack.clear();
            }
            self.run_done(k, self.now);
        }
    }

    fn gone(&mut self, k: [u8; 32]) {
        for id in self.xf.forget(&k) {
            self.reqs.remove(&(k, id));
        }
        self.reqs.retain(|(p, _), _| *p != k);
        if self.runs.remove(&k).is_some() && self.runs.is_empty() {
            self.round_over = true;
        }
        self.askers.remove(&k);
        self.synced_with.remove(&k);
        self.proven.remove(&k);
        self.proof_tried.remove(&k);
        self.sync_spent.remove(&k);
    }

    // ---- Verification and keeping ----

    fn verify_slice(&mut self, _now: Instant, unix: u64) {
        self.last_unix = unix;
        let mut units = 0;
        // What sync brought first (a first sync is over once it is verified); then the puts, one job's slice in turn.
        while units < UNITS_PER_TURN {
            let (mut job, put) = match self.jobs.pop_front() {
                Some(j) => (j, false),
                None => match self.puts.pop_front() {
                    Some(j) => (j, true),
                    None => break,
                },
            };
            while units < UNITS_PER_TURN && !job.forged && job.next < job.item.entries.len() {
                let w = job.item.entries[job.next].clone();
                job.next += 1;
                units += self.check_entry(&mut job, w, unix);
            }
            if !job.forged && job.next < job.item.entries.len() {
                if put {
                    self.puts.push_back(job);
                } else {
                    self.jobs.push_front(job);
                }
                break;
            }
            if !job.forged && !job.zone_checked && job.item.zone.is_some() {
                job.zone_checked = true;
                units += 1;
                if !job.item.zone.as_ref().unwrap().verify(&self.names) {
                    self.log("a zone refused: its signature".into());
                    job.item.zone = None;
                }
            }
            self.keep(job, unix);
        }
    }

    /// Entry `id` failed a check only a forgery fails: remembered, so copies of it cost nothing.
    fn refuse(&mut self, id: [u8; 32]) {
        if self.refused.insert(id) {
            self.refused_order.push_back(id);
            if self.refused_order.len() > REFUSED_KEPT
                && let Some(old) = self.refused_order.pop_front()
            {
                self.refused.remove(&old);
            }
        }
    }

    /// An entry checked whole (counted).
    fn check_whole(
        &mut self,
        e: super::entry::Entry,
        ref_header: super::header::Header,
        unix: u64,
    ) -> Result<Stamped, Invalid> {
        self.stats.checked += 1;
        Stamped::check(
            e,
            ref_header,
            &self.names,
            &self.params,
            &mut self.pow,
            unix,
        )
    }

    /// Checks one entry of a job (or only its anchor, when the entry is held): its cost. An entry that fails a check
    /// only a forgery fails (all but a `ref` header from the future, which a clock behind can make) marks the job
    /// forged: the rest of it isn't checked, and nothing of it is kept.
    fn check_entry(&mut self, job: &mut Job, w: WireEntry, unix: u64) -> u32 {
        let id = job.item.id;
        if w.entry.name != id {
            self.log("an entry refused: another name's".into());
            job.forged = true;
            return 0;
        }
        let eid = w.entry.id();
        if self.refused.contains(&eid) {
            job.forged = true;
            return 0;
        }
        let held = self
            .reg
            .get(&id)
            .and_then(|h| h.name.get(&eid))
            .cloned()
            .or_else(|| job.checked.iter().find(|s| s.id() == eid).cloned());
        let (mut s, mut cost) = match held {
            Some(s) => (s, 0),
            None => match self.check_whole(w.entry, w.ref_header, unix) {
                Ok(s) => (s, 4),
                Err(e) => {
                    self.log(format!("an entry refused: {e:?}"));
                    // Remembered only for what the entry's own bytes decide (not its `ref` header, which travels
                    // beside it: anyone could otherwise send an honest entry with a broken header to have it refused).
                    if matches!(
                        e,
                        Invalid::Prev | Invalid::Room | Invalid::Signature | Invalid::Work
                    ) {
                        self.refuse(eid);
                    }
                    job.forged |= e != Invalid::HeaderFuture;
                    return 4;
                }
            },
        };
        if let Some((a, h)) = w.anchor {
            let better = s.anchor().is_none_or(|b| b.anchor != a || b.run != h);
            if better {
                cost += 1;
                if let Err(e) = s.offer_anchor(a, h, &self.params, unix) {
                    self.log(format!("an anchor refused: {e:?}"));
                }
            }
        }
        if let Some(p) = w.pending {
            // Only the owner says which pending anchor a server is to finish: anyone's would replace it.
            if pending_ok(&self.names, &s.entry.owner, &eid, &p) {
                s.offer_pending(p, &self.params, unix);
            } else {
                self.log("a pending anchor refused: not the owner's".into());
            }
        }
        job.checked.retain(|c| c.id() != eid);
        job.checked.push(s);
        cost
    }

    /// A verified job's entries and zone merged into the item held, settled; stored, told to
    /// the other servers, answered.
    fn keep(&mut self, mut job: Job, unix: u64) {
        let id = job.item.id;
        #[cfg(test)]
        if self.refuse.contains(&id) {
            return;
        }
        let put_ids: BTreeSet<[u8; 32]> = job.checked.iter().map(Stamped::id).collect();
        let mut h = self.reg.take(&id).unwrap_or_else(|| Held::new(id, unix));
        let before = h.version;
        let was_empty = h.is_empty();
        if job.forged {
            job.checked.clear();
            job.item.zone = None;
        }
        for s in job.checked {
            h.name.insert(s, &self.params, unix);
        }
        h.settle(&self.params, unix);
        if let Some(z) = job.item.zone {
            h.offer_zone(z, unix, true);
            h.settle(&self.params, unix);
        }
        let changed = h.version != before || was_empty != h.is_empty();
        let answer = match &h.owner {
            Some(o) if put_ids.contains(&o.last()) => Msg::Taken,
            _ => Msg::Better(h.item()),
        };
        if !h.is_empty() {
            self.reg.put(h);
        }
        if let Some((peer, Some(xid))) = job.from {
            self.send(peer, &answer, xid, self.now);
            if matches!(answer, Msg::Better(_)) {
                self.log("a put refused: a better chain is held".into());
            }
        }
        if changed {
            self.stored(&id);
            let source = job.from.map(|(p, _)| p);
            self.tell(id, source);
        }
        self.bound(unix);
    }

    /// Tells the servers we sync with (but `source`) that item `id` changed.
    fn tell(&mut self, id: [u8; 32], source: Option<[u8; 32]>) {
        let now = self.now;
        let to: BTreeSet<[u8; 32]> = self
            .synced_with
            .keys()
            .chain(self.runs.keys())
            .copied()
            .filter(|k| Some(*k) != source)
            .collect();
        for k in to {
            self.send(k, &Msg::Have(vec![id]), 0, now);
        }
        self.flush();
    }

    /// Item `id`'s record changed: stored again (or deleted, gone).
    fn stored(&mut self, id: &[u8; 32]) {
        let record = self.reg.get(id).map(Held::record);
        self.cmds.push_back(Cmd::Store { id: *id, record });
    }

    /// The tests' way to make servers ask at the same moment.
    #[cfg(test)]
    pub fn ask_at(&mut self, t: Instant) {
        self.next_round = Some(t);
    }

    /// Offers `item` to the server with key `to` (an owner's agent's publishing, N4; the tests).
    pub fn put(&mut self, to: [u8; 32], item: Item, now: Instant) {
        self.now = now;
        self.request(to, &Msg::Put(item), Req::Put, now);
        self.flush();
    }
}

/// Whether `window` (times in the last second) has room for one more, under `max` a second.
pub(super) fn room_in(window: &mut VecDeque<Instant>, max: usize, now: Instant) -> bool {
    while window
        .front()
        .is_some_and(|t| now.saturating_duration_since(*t) >= Duration::from_secs(1))
    {
        window.pop_front();
    }
    window.len() < max
}
