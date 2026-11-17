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
    entry::{Pow, Stamped, sign, tagged, verify},
    id::RoomNames,
    member::Answer,
    store::{Held, Registry, read_record, zone_tag},
    wire::{GetMode, Item, Msg, Question, Range, SyncAnswer, Transfers, WireEntry},
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
/// Incoming handshakes a question lets in (servers answering it), at most.
pub const ACCEPT_MAX: usize = 32;
/// Askers a server holds at once, and how long one is held without a message.
pub const MAX_ASKERS: usize = 32;
const ASKER_IDLE: Duration = Duration::from_secs(60);
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

/// `BLAKE2s(nonce, key)`: who answers a question (its share) and whom the asker keeps.
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

fn serve_hash(names: &RoomNames, nonce: &[u8; 16], server: &[u8; 32]) -> [u8; 32] {
    tagged("waarm64/names/serve", &[&names.value, nonce, server])
}

/// Whether `serve` (a [`Msg::Serve`] from the server with key `server`) answers our question
/// `nonce`: a live name's entry (checked whole: signature, proof of work, its headers and anchor,
/// its chain covering now) whose owner key signed the nonce and the server's key.
pub fn check_serve(
    names: &RoomNames,
    params: &Params,
    pow: &mut Pow,
    nonce: &[u8; 16],
    server: &[u8; 32],
    serve: &Msg,
    unix: u64,
) -> Result<(), Invalid> {
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
    if !verify(&owner, &serve_hash(names, nonce, server), sig) {
        return Err(Invalid::Signature);
    }
    Ok(())
}

/// A question of ours.
struct Ask {
    nonce: [u8; 16],
    started: Instant,
    /// Rounds sent.
    round: usize,
    first: Option<Instant>,
    /// Servers whose `serve` held, by their hash.
    answers: BTreeMap<[u8; 32], [u8; 32]>,
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
    askers: BTreeMap<[u8; 32], Instant>,
    /// Call backs waiting out [`CROSSED_WAIT`].
    deferred: Vec<(Instant, [u8; 32], usize)>,
    /// The first sync is done (or nobody answered): only then does it answer questions.
    pub synced: bool,
    next_round: Option<Instant>,
    runs: BTreeMap<[u8; 32], Run>,
    synced_with: BTreeMap<[u8; 32], Instant>,
    jobs: VecDeque<Job>,
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
        for t in cfg.titles {
            let Ok(key) = SigningKey::from_bytes(&t.key) else {
                continue;
            };
            let id = t.item.id;
            s.titles.push((key, id));
            s.own.insert(id);
            if let Some(z) = t.item.zone.clone() {
                s.title_zones.insert(id, z);
            }
            s.take_trusted(t.item, unix, unix);
        }
        s
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
    }

    pub fn names(&self) -> &RoomNames {
        &self.names
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
        let jobs = self.jobs.front().map(|_| self.now);
        [
            ask,
            self.next_round,
            self.xf.deadline(),
            self.reqs.values().map(|(_, t)| *t).min(),
            self.askers.values().map(|t| *t + ASKER_IDLE).min(),
            self.settle_at,
            self.deferred.iter().map(|(t, _, _)| *t).min(),
            jobs,
        ]
        .into_iter()
        .flatten()
        .min()
    }

    /// Whether verification is waiting (the transport ticks again at once).
    pub fn busy(&self) -> bool {
        !self.jobs.is_empty()
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
            .filter(|(_, t)| now >= **t + ASKER_IDLE)
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
        self.ask = Some(Ask {
            nonce,
            started: now,
            round: 1,
            first: None,
            answers: BTreeMap::new(),
        });
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
        if let Err(e) = ok {
            self.log(format!("a serve refused: {e:?}"));
            return self.cmds.push_back(Cmd::Forget(from));
        }
        let a = self.ask.as_mut().unwrap();
        a.answers.insert(from, share_hash(&nonce, &from));
        a.first.get_or_insert(now);
    }

    /// The two answers with the lowest hash are kept (not the fastest, which an attacker could
    /// always be); the others are let go. A server syncs with both.
    fn choose(&mut self, now: Instant, _unix: u64) {
        let a = self.ask.take().unwrap();
        self.nobody = None;
        let mut by: Vec<([u8; 32], [u8; 32])> = a.answers.iter().map(|(k, h)| (*h, *k)).collect();
        by.sort();
        self.cmds.push_back(Cmd::Accept { until: now, max: 0 });
        for (i, (_, k)) in by.iter().enumerate() {
            if i < 2 {
                self.start_run(*k, now);
            } else {
                self.cmds.push_back(Cmd::Forget(*k));
            }
        }
        let jitter = u64::from_le_bytes(random()) % (2 * SYNC_JITTER_MS);
        self.next_round = Some(
            now + SYNC_EVERY + Duration::from_millis(jitter)
                - Duration::from_millis(SYNC_JITTER_MS),
        );
    }

    // ---- Answering ----

    /// Whether we would answer a question with `nonce` and `spread` now (the share, synced, room
    /// for askers, the budget): the answer rule, apart from holding a live name.
    fn answers_rule(&mut self, q: &Question, now: Instant) -> Result<(), &'static str> {
        let Some(key) = self.key else {
            return Err("not running");
        };
        if !in_share(&share_hash(&q.nonce, &key), q.spread) {
            return Err("outside the share");
        }
        if !self.synced {
            return Err("not synced yet");
        }
        if self.askers.len() >= MAX_ASKERS && !self.askers.contains_key(&q.key) {
            return Err("no room");
        }
        if !room_in(&mut self.answers, ANSWERS_PER_SECOND, now) {
            return Err("over the budget");
        }
        Ok(())
    }

    /// A live name of ours to serve with: its owning chain's last entry and the key.
    fn live_title(&self, unix: u64) -> Option<(SigningKey, WireEntry)> {
        self.titles.iter().find_map(|(k, id)| {
            let h = self.reg.get(id)?;
            let o = h.owner.as_ref()?;
            let pk: [u8; 32] = k.verifying_key().to_bytes().into();
            (o.owner == pk && o.covers(unix))
                .then(|| h.name.get(&o.last()).map(|e| (k.clone(), WireEntry::of(e))))
                .flatten()
        })
    }

    fn on_question(&mut self, q: Question, region: usize, now: Instant, unix: u64) {
        if let Err(why) = self.answers_rule(&q, now) {
            if why != "outside the share" {
                self.stats.refused += 1;
            }
            return;
        }
        let Some((k, entry)) = self.live_title(unix) else {
            self.stats.refused += 1;
            return;
        };
        self.answers.push_back(now);
        self.stats.answered += 1;
        let me = self.key.unwrap();
        let sig = sign(&k, &serve_hash(&self.names, &q.nonce, &me));
        self.askers.insert(q.key, now);
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
                if let Some(t) = self.askers.get_mut(&from) {
                    *t = now;
                }
                if let Some((xid, payload)) = self.xf.input(from, &data, now) {
                    match Msg::decode(&payload) {
                        Ok((m, reply)) => self.on_msg(from, xid, reply, m, now, unix),
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
        match m {
            m @ Msg::Serve { .. } => self.on_serve(from, m, now, unix),
            Msg::Sync { range, fp } => {
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
                self.send(from, &Msg::SyncAnswer(a), xid, now);
            }
            Msg::Get {
                mode: GetMode::Ids,
                id,
                ..
            } => {
                let ids = self.reg.matching(&id);
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
                for id in ids {
                    if self.dropped.contains_key(&id) {
                        continue;
                    }
                    let get = self.get_for(&id[..]);
                    self.request(from, &get, Req::Get(false), now);
                }
            }
            Msg::Put(item) => self.jobs.push_back(Job {
                from: Some((from, Some(xid))),
                item,
                next: 0,
                checked: Vec::new(),
                zone_checked: false,
            }),
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
                        self.jobs.push_back(Job {
                            from: Some((from, None)),
                            item,
                            next: 0,
                            checked: Vec::new(),
                            zone_checked: false,
                        });
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
            self.request(partner, &Msg::Sync { range, fp }, Req::Sync(range), now);
        }
        let run = &self.runs[&partner];
        if run.outstanding == 0 && run.stack.is_empty() {
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
    }

    // ---- Verification and keeping ----

    fn verify_slice(&mut self, _now: Instant, unix: u64) {
        self.last_unix = unix;
        let mut units = 0;
        while units < UNITS_PER_TURN
            && let Some(mut job) = self.jobs.pop_front()
        {
            while units < UNITS_PER_TURN && job.next < job.item.entries.len() {
                let w = job.item.entries[job.next].clone();
                job.next += 1;
                units += self.check_entry(&mut job, w, unix);
            }
            if job.next < job.item.entries.len() {
                self.jobs.push_front(job);
                break;
            }
            if !job.zone_checked && job.item.zone.is_some() {
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

    /// Checks one entry of a job (or only its anchor, when the entry is held): its cost.
    fn check_entry(&mut self, job: &mut Job, w: WireEntry, unix: u64) -> u32 {
        let id = job.item.id;
        if w.entry.name != id {
            self.log("an entry refused: another name's".into());
            return 0;
        }
        let eid = w.entry.id();
        let held = self
            .reg
            .get(&id)
            .and_then(|h| h.name.get(&eid))
            .cloned()
            .or_else(|| job.checked.iter().find(|s| s.id() == eid).cloned());
        let (mut s, mut cost) = match held {
            Some(s) => (s, 0),
            None => match Stamped::check(
                w.entry,
                w.ref_header,
                &self.names,
                &self.params,
                &mut self.pow,
                unix,
            ) {
                Ok(s) => (s, 4),
                Err(e) => {
                    self.log(format!("an entry refused: {e:?}"));
                    return 4;
                }
            },
        };
        if let Some((a, h)) = w.anchor {
            let better = s.anchor().is_none_or(|b| b.anchor != a || b.header != h);
            if better {
                cost += 1;
                if let Err(e) = s.offer_anchor(a, h, &self.params, unix) {
                    self.log(format!("an anchor refused: {e:?}"));
                }
            }
        }
        if let Some(p) = w.pending {
            s.offer_pending(p, &self.params, unix);
        }
        job.checked.retain(|c| c.id() != eid);
        job.checked.push(s);
        cost
    }

    /// A verified job's entries and zone merged into the item held, settled; stored, told to
    /// the other servers, answered.
    fn keep(&mut self, job: Job, unix: u64) {
        let id = job.item.id;
        #[cfg(test)]
        if self.refuse.contains(&id) {
            return;
        }
        let put_ids: BTreeSet<[u8; 32]> = job.checked.iter().map(Stamped::id).collect();
        let mut h = self.reg.take(&id).unwrap_or_else(|| Held::new(id, unix));
        let before = h.version;
        let was_empty = h.is_empty();
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
