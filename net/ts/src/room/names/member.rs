//! A member's side of the registry (names.md "A member resolving a name"), sans I/O: what the
//! resolver asks for a name that isn't a key, and what the member keeps. The transport is a names client of its own, as
//! a server's is (room.rs), made when the guest first asks for such a name and closed after [`IDLE`] without one.
//!
//! - **A first lookup** (a name not kept: never resolved, or what was kept has ended) **asks the room through the
//!   relays** (names.md "A member resolving a name"): an `ask` under the room's names tag, mode `share` at the spread that last brought one
//!   to eight replies in this room (6 the first time), wider at 0.4 and 1 s while nothing comes; servers reply under
//!   this names client's reply tag with the owning chain's last entry and the zone, or none. Each reply is believed for
//!   what it holds, which is checked (signature, proof of work, header, anchor, alive; the zone's signature), never for
//!   who sent it: no session, no draw. At the first reply, unless everyone was asked, one more ask, mode `dissent`,
//!   naming what was shown, the owner key, its last entry and the zone hashed (`wire::shown`; zeros for none): every
//!   server holding anything else (another owner, a renewal, another zone) replies. 0.7 s after it (0.3 s
//!   after the first reply when everyone was asked): one owner key, that owner (its latest last entry); only none,
//!   NXDOMAIN for 60 s doubling to 10 minutes while the name stays unknown; two or more keys, or one shown only by
//!   items too big for an event (a "too big" carries the last entry, checked), a contest: `fetch` from one replier at a
//!   time per key (8 at once, the earliest `since` first), each calling back and sending the owning chain's run,
//!   checked as `history` is, until the best run checked is older than every `since` left, or [`CONTEST_FOR`] ran
//!   out; the owner by "Who owns a name" if every key shown is settled, else no answer. Silence through the last
//!   round: SERVFAIL (the guest's resolver asks again), at the resolver's wait when the room replied or "who serves?"
//!   found servers in the last minute (its replies were spent, by its own load or the guest's), else at once, and
//!   "who serves?" is asked: nobody within 2.5 s is nobody serves (30 s doubling to 10 minutes). A reply within 3 s
//!   after the decision is still checked: another owner starts a contest.
//! - **Finding servers** for what must not name an id (the refresh of kept names, the dialog's check, a publisher's
//!   puts): "who serves the registry?" as a server asks it (server.rs), the plain draw: shares of 1/64, 1/8, everyone;
//!   the two answers with the lowest `BLAKE2s(nonce, owner key)` 0.3 s after the first. Held while asked and for
//!   [`SERVERS_HELD`] after, redrawn every [`SERVERS_REDRAW`]; a server that fails is let go, and with none left the
//!   next refresh asks again. Nobody within 2.5 s: remembered for 30 s, doubling to 10 minutes, reset by an answer;
//!   meanwhile names not kept get NXDOMAIN at once and nothing goes out.
//! - **A refresh** (a kept name confirmed more than [`KEPT_REFRESH`] ago, [`KEPT_GRACE_REFRESH`] in its grace): `get`
//!   (owner mode, with the last entry and zone kept) to each server; each answers with the owning chain's last entry
//!   and the zone, those the member lacks, or none. The answers disagree, or one contests what the member keeps (chain.rs `Kept::offer` refuses it):
//!   `history` from each, and the owner by "Who owns a name" over everything shown, which `Kept::offer` then takes or
//!   refuses. **A refresh never sends an `ask`**: that would tell the room how long a name stays in use.
//! - **What is kept**: each name resolved, its chain's last entry, the earliest time verified for that chain, the
//!   zone and when servers last confirmed it, persisted (a record a name, version 3). It answers at once while its
//!   chain is alive.
//! - **The dialog's check**: `ids`, every id under one first byte ([`Member::ids`]), never an `ask`.

use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    time::{Duration, Instant},
};

use super::{
    Invalid, Params,
    chain::{Chain, Kept, Name},
    entry::{Kind, Pow, Stamped},
    id::{RoomNames, split},
    server::{
        ACCEPT_MAX, Ask, CHOOSE_AFTER, Cmd, GIVE_UP, Input, NOBODY_FIRST, NOBODY_MAX,
        QUESTIONS_PER_SECOND, ROUND_AT, SPREADS, UNITS_PER_TURN, check_serve, random, room_in,
    },
    store::{anchor_tag, zone_tag},
    wire::{AskMode, GetMode, Item, Msg, Rd, Reply, ReplyItem, Transfers, WireEntry, shown},
    zone::Zone,
};

/// What the resolver answers for a name that passed the rules.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Answer {
    /// The address of this node key.
    Node([u8; 32]),
    /// This node's own address (a name of its own, not public yet).
    Own,
    /// NXDOMAIN.
    Nx,
    /// Not known yet: the query waits (SERVFAIL after the resolver's wait).
    Wait,
    /// SERVFAIL now: a first lookup met silence (the guest's resolver asks again).
    ServFail,
}

/// A kept name is asked again in the background once servers last confirmed it this long ago (seconds).
pub const KEPT_REFRESH: u64 = 300;
/// ...and once this long ago while it is in its grace (NXDOMAIN meanwhile): a renewal the servers come to hold shows
/// this late at most (seconds).
pub const KEPT_GRACE_REFRESH: u64 = 60;
/// None, and no owner: NXDOMAIN at once for this long, twice as long each time after while the name stays unknown, up
/// to [`NEGATIVE_MAX`].
pub const NEGATIVE_FOR: Duration = Duration::from_secs(60);
pub const NEGATIVE_MAX: Duration = Duration::from_secs(600);
/// The servers a question chose are held this long after they were last asked...
pub const SERVERS_HELD: Duration = Duration::from_secs(180);
/// ...and redrawn this long after they were drawn, so a pair that serves a stale zone isn't kept for as long as the
/// guest goes on asking (names.md "A member resolving a name").
pub const SERVERS_REDRAW: Duration = Duration::from_secs(900);
/// A first lookup decides this long after its `dissent` ask...
pub const DISSENT_WAIT: Duration = Duration::from_millis(700);
/// ...or this long after the first reply when its round asked everyone (no dissent then).
pub const EVERYONE_WAIT: Duration = Duration::from_millis(300);
/// A reply this long after the decision is still checked: another owner starts a contest.
pub const LATE_FOR: Duration = Duration::from_secs(3);
/// Asks a member sends a second at most (rounds, dissents, fetches).
pub const ASKS_PER_SECOND: usize = 4;
/// A contest's fetches at once, and how long one waits for its run.
pub const FETCHES_AT_ONCE: usize = 8;
pub const FETCH_WAIT: Duration = Duration::from_secs(5);
/// A contest decides this long after it started at the latest, on the runs checked by then (review 3, finding 2:
/// repliers claiming `since` 0 mustn't hold it open).
pub const CONTEST_FOR: Duration = Duration::from_secs(10);
/// The repliers a first lookup keeps of one owner key: those with the earliest `since` (the first of equals).
pub const REPLIERS_A_KEY: usize = 32;
/// A first lookup's first spread in a room it never asked.
pub const FIRST_SPREAD: u8 = 6;
/// A round that brings more replies than this starts the next lookup 3 bits narrower (up to [`MAX_SPREAD`]).
const REPLIES_FEW: usize = 8;
/// Silence this soon after a reply counted, or "who serves?" found servers, isn't taken for "nobody serves".
const HEARD_FOR: Duration = Duration::from_secs(60);
/// A silence's SERVFAIL holds for the queries that waited on it this long at most (the resolver's wait).
const SERVFAIL_FOR: Duration = Duration::from_secs(4);
/// Replies under our reply tag to nonces we never sent (or sent more than [`STRAY_FOR`] ago), this many in
/// [`STRAY_FOR`]: someone spends servers' budgets under our tag ([`super::server::REPLIES_PER_TAG`] a minute each),
/// and silence, none or one key shown may be what it left (final review, finding 2). Half a server's budget: an
/// honest room sends none.
pub const STRAYS_MAX: usize = 8;
pub const STRAY_FOR: Duration = Duration::from_secs(60);
const MAX_SPREAD: u8 = 15;
/// A member's names client closes after this long without a query for a name that isn't a key.
pub const IDLE: Duration = Duration::from_secs(600);
/// A server's answer to a `get` is waited for this long (its transfer fails sooner, ~5.5 s, when nothing comes).
const REQUEST_TIMEOUT: Duration = Duration::from_secs(8);
/// Names kept at most (the least used go first), lookups at once, names remembered as none.
pub const MAX_KEPT: usize = 1024;
const MAX_LOOKUPS: usize = 64;
const MAX_NEGATIVE: usize = 1024;
/// The most entries a server's answer may show to lead from a kept last entry to its release.
const RELEASE_RUN: usize = 8;
/// A member's record's version byte (a server's is 1: store.rs).
const RECORD_VERSION: u8 = 3;

/// What a member keeps of a name it resolved.
#[derive(Debug, Clone)]
pub struct KeptName {
    /// The chain taken and the earliest time verified for it.
    pub kept: Kept,
    /// The chain's last entry, as verified.
    pub last: Stamped,
    pub zone: Option<Zone>,
    /// When servers last confirmed it (Unix seconds).
    pub checked: u64,
    /// When the guest last asked for it.
    used: u64,
}

impl KeptName {
    /// The stored record: its version byte, the earliest time, whether that is a claim's, when it was checked, an item
    /// of the last entry and the zone.
    pub fn record(&self) -> Vec<u8> {
        let mut r = vec![RECORD_VERSION];
        r.extend_from_slice(&self.kept.earliest.to_le_bytes());
        r.push(self.kept.whole as u8);
        r.extend_from_slice(&self.checked.to_le_bytes());
        r.extend(
            Item {
                id: self.last.entry.name,
                entries: vec![WireEntry::of(&self.last)],
                zone: self.zone.clone(),
            }
            .encode(),
        );
        r
    }
}

/// What a server said to one lookup.
#[derive(Debug, Clone)]
enum Said {
    Waiting,
    /// It has no live chain of the name.
    Nothing,
    Item(Box<Item>),
    /// No answer (its transfer failed, or the wait ran out).
    Failed,
}

struct Lookup {
    /// Each server asked, and what it said.
    asked: BTreeMap<[u8; 32], Said>,
    /// The asks are `history`.
    history: bool,
    /// Asked again once after every server failed.
    retried: bool,
    /// Every server has said: what they said being checked, a slice a turn.
    checking: Option<Checking>,
}

impl Lookup {
    fn new(asked: BTreeMap<[u8; 32], Said>, history: bool, retried: bool) -> Lookup {
        Lookup {
            asked,
            history,
            retried,
            checking: None,
        }
    }
}

/// The answers of a lookup being checked: those left, the views made, how many said none.
struct Checking {
    left: VecDeque<Check>,
    views: Vec<([u8; 32], View)>,
    nothing: usize,
}

/// One server's item being checked, an entry at a time (each once, however often the item repeats it).
struct Check {
    server: [u8; 32],
    entries: VecDeque<WireEntry>,
    zone: Option<Zone>,
    name: Name,
    last: Option<[u8; 32]>,
}

/// A server's answer, checked: the entries it showed (with the member's kept last entry), and the chain it says owns
/// the name.
struct View {
    name: Name,
    chain: Chain,
    zone: Option<Zone>,
    /// The chain is the one kept, ended by its owner's release.
    released: bool,
}

enum Req {
    Get([u8; 32]),
    History([u8; 32]),
    Ids(u8),
    Put([u8; 32]),
}

/// What a server said to an item put (an owner's agent publishing its title through a names client of its own: the
/// page's publisher, room.rs `Config::publish`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PutResult {
    /// The server's owning chain ends at the put's entry.
    Taken,
    /// The server holds a better chain: its item (empty when it holds nothing of the name).
    Better(Box<Item>),
    /// No answer (its transfer failed, or the wait ran out).
    Failed,
    /// Nobody serves the registry: there was nobody to put to.
    Nobody,
}

/// An answer to a put: the name id, the server (none for [`PutResult::Nobody`]) and what it said.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PutDone {
    pub id: [u8; 32],
    pub server: Option<[u8; 32]>,
    pub result: PutResult,
}

/// What a server said to the dialog's check ([`Member::ids`]): the ids it holds under the first byte asked, each
/// with until when its owner holds it (Unix seconds, 0: nobody now).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IdsResult {
    Ids(Vec<([u8; 32], u64)>),
    /// No answer (its transfer failed, or the wait ran out, or the names client stopped).
    Failed,
    /// Nobody serves the registry: nobody can say.
    Nobody,
}

/// An answer to the dialog's check: the first byte asked, the server (none: [`IdsResult::Nobody`], or a check that
/// never went out), what it said.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdsDone {
    pub first: u8,
    pub server: Option<[u8; 32]>,
    pub result: IdsResult,
}

/// An ask waiting for the rate: its fields as [`Cmd::Ask`] carries them.
struct AskOut {
    nonce: [u8; 16],
    id: [u8; 32],
    mode: AskMode,
    spread: u8,
    shown: [u8; 8],
}

/// A server that replied to a first lookup: its names key, its `since`, the owner key its item showed (checked).
#[derive(Debug, Clone, Copy)]
struct Replier {
    server: [u8; 32],
    since: u32,
    key: [u8; 32],
}

/// A first lookup (names.md "A member resolving a name").
struct First {
    /// The `share` ask's nonce (its rounds share it), the spreads of its rounds, how many went.
    nonce: [u8; 16],
    spreads: Vec<u8>,
    round: usize,
    /// The rounds' asks that left (past [`ASKS_PER_SECOND`]), and when the last did: the next round and the silence
    /// count from it, not from the start (NAMES loop 6a: names asked at once timed their rounds out in the queue).
    sent: usize,
    sent_at: Instant,
    /// When the first reply counted (an item that held, none, or too big), and the spread asked by then.
    first: Option<Instant>,
    spread_at_first: u8,
    /// Replies counted to the `share` ask.
    share_count: usize,
    /// The `dissent` ask's nonce, once sent.
    dissent: Option<[u8; 16]>,
    decide_at: Option<Instant>,
    /// When it was decided: replies are still checked [`LATE_FOR`] after.
    decided: Option<Instant>,
    /// Replies waiting to be checked.
    queue: VecDeque<Reply>,
    /// What the replies that held showed, by owner key: the latest last entry and the zones.
    keys: BTreeMap<[u8; 32], (Stamped, Vec<Zone>)>,
    /// The keys shown by an item with its zone (not only "too big": its zone is fetched to be known).
    zoned: BTreeSet<[u8; 32]>,
    nones: usize,
    repliers: Vec<Replier>,
    contest: Option<Contest>,
    /// Entries checked whole (signature, proof of work) by id: each once, however many replies carry it (None: it
    /// failed). Anchors are checked with each copy: a forged anchor on a copied entry mustn't refuse the honest copy.
    entries: BTreeMap<[u8; 32], Option<Stamped>>,
    /// Releases replied by their holders, with what leads to them, checked: a key shown whose last entry one of them
    /// releases shows nothing (final review, finding 5).
    released: Vec<Stamped>,
}

impl First {
    /// When the next round goes, or (every round gone) silence is taken for an answer: from when the last round's ask
    /// left; None while one waits for the rate.
    fn round_due(&self) -> Option<Instant> {
        if self.sent < self.round || self.round == 0 {
            return None;
        }
        let last = ROUND_AT[self.round - 1];
        let next = ROUND_AT
            .get(self.round)
            .filter(|_| self.round < self.spreads.len());
        Some(self.sent_at + next.map_or(GIVE_UP, |d| *d) - last)
    }
}

/// A contest (two owner keys shown, or a key shown only by items too big for an event): runs fetched from repliers,
/// the earliest `since` first, until the best run checked is older than every `since` left, or [`CONTEST_FOR`] ran out.
struct Contest {
    until: Instant,
    /// Fetches out: the server and until when its run is waited for (None: the ask waits for the rate).
    flying: BTreeMap<[u8; 32], Option<Instant>>,
    fetched: BTreeSet<[u8; 32]>,
    /// Runs being checked.
    runs: VecDeque<Check>,
    /// Every entry of every run that held, and their zones.
    name: Name,
    zones: Vec<Zone>,
    /// The earliest run checked for each owner key.
    best: BTreeMap<[u8; 32], u32>,
}

/// The most items waiting to be put at once.
pub const MAX_PUTS: usize = 64;

#[derive(Debug, Default, Clone)]
pub struct MemberStats {
    /// Asks sent (every mode), replies taken in, `fetch`es sent, contests run.
    pub asks: usize,
    pub replies: usize,
    pub fetches: usize,
    pub contests: usize,
    pub questions: usize,
    pub nobody: usize,
    pub gets: usize,
    pub histories: usize,
    /// Answers refused (a forged or broken entry or zone, a dead chain).
    pub refused: usize,
    /// Entries checked whole (signature, proof of work, anchor and its header).
    pub checked: usize,
}

pub struct Member {
    names: RoomNames,
    params: Params,
    pow: Pow,
    /// The names client's key, while its transport runs.
    key: Option<[u8; 32]>,
    xf: Transfers,
    reqs: BTreeMap<([u8; 32], u32), (Req, Instant)>,
    ask: Option<Ask>,
    nobody: Option<(Instant, Duration)>,
    questions: VecDeque<Instant>,
    next_question: Option<Instant>,
    servers: Vec<[u8; 32]>,
    servers_until: Option<Instant>,
    /// When the servers held were drawn.
    servers_since: Option<Instant>,
    pub kept: BTreeMap<[u8; 32], KeptName>,
    /// Names known to have no owner: NXDOMAIN until the first time; the second is the last wait, doubled at the next.
    negative: BTreeMap<[u8; 32], (Instant, Duration)>,
    /// Refreshes of kept names (through servers found by "who serves?").
    lookups: BTreeMap<[u8; 32], Lookup>,
    /// First lookups (asks through the relays).
    firsts: BTreeMap<[u8; 32], First>,
    /// The ask nonces of first lookups, and their ids.
    ask_nonces: BTreeMap<[u8; 16], [u8; 32]>,
    /// Ask nonces sent in the last [`STRAY_FOR`] (a late reply to one isn't a stray), and when strays came.
    sent_nonces: VecDeque<([u8; 16], Instant)>,
    strays: VecDeque<Instant>,
    /// Asks waiting for the rate ([`ASKS_PER_SECOND`]), and those sent lately.
    asks_out: VecDeque<AskOut>,
    asks_sent: VecDeque<Instant>,
    /// The spread a first lookup starts at: where the last one found the room.
    spread: u8,
    /// The names client's home region is up: call backs reach it ("who serves?", `fetch`).
    ready: bool,
    /// Its reply tag is subscribed to (at its first lookup that asks the room: a publisher's never does).
    replies_on: bool,
    /// When a reply last counted: silence soon after isn't "nobody serves".
    heard: Option<Instant>,
    /// When "who serves?" last found servers: silence soon after isn't "nobody serves" either.
    served: Option<Instant>,
    /// A first lookup met silence that nothing heard explains: "who serves?" is asked, and decides whether anybody does.
    probe: bool,
    /// First lookups that met silence, and when: their waiting queries get SERVFAIL now.
    servfail: BTreeMap<[u8; 32], Instant>,
    /// The `ids` checks wanted (first bytes), and what came back: the ids servers hold under each.
    ids_wanted: BTreeSet<u8>,
    pub ids_answers: BTreeMap<u8, BTreeMap<[u8; 32], u64>>,
    /// Each server's answer to an `ids` check as it comes (a publisher's are `names-ids` events).
    pub ids_done: VecDeque<IdsDone>,
    /// Items waiting for servers to be put to (a publisher's), and the answers that came.
    puts: BTreeMap<[u8; 32], Item>,
    pub put_done: VecDeque<PutDone>,
    cmds: VecDeque<Cmd>,
    pub stats: MemberStats,
    /// The clock as the last tick or input gave it.
    now: Instant,
}

impl Member {
    pub fn new(room_id: &str, params: Params) -> Member {
        Member {
            names: RoomNames::derive(room_id),
            pow: Pow::new(&params),
            params,
            key: None,
            xf: Transfers::default(),
            reqs: BTreeMap::new(),
            ask: None,
            nobody: None,
            questions: VecDeque::new(),
            next_question: None,
            servers: Vec::new(),
            servers_until: None,
            servers_since: None,
            kept: BTreeMap::new(),
            negative: BTreeMap::new(),
            lookups: BTreeMap::new(),
            firsts: BTreeMap::new(),
            ask_nonces: BTreeMap::new(),
            sent_nonces: VecDeque::new(),
            strays: VecDeque::new(),
            asks_out: VecDeque::new(),
            asks_sent: VecDeque::new(),
            spread: FIRST_SPREAD,
            ready: false,
            replies_on: false,
            heard: None,
            served: None,
            probe: false,
            servfail: BTreeMap::new(),
            ids_wanted: BTreeSet::new(),
            ids_answers: BTreeMap::new(),
            ids_done: VecDeque::new(),
            puts: BTreeMap::new(),
            put_done: VecDeque::new(),
            cmds: VecDeque::new(),
            stats: MemberStats::default(),
            now: Instant::now(),
        }
    }

    /// The tests' view: lookups whose answers are being checked.
    #[cfg(test)]
    pub fn checking(&self) -> usize {
        self.lookups
            .values()
            .filter(|l| l.checking.is_some())
            .count()
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

    /// Whether its names client runs (`start` was called).
    pub fn running(&self) -> bool {
        self.key.is_some()
    }

    /// The servers held now.
    pub fn servers(&self) -> &[[u8; 32]] {
        &self.servers
    }

    /// Until when it remembers that nobody serves.
    pub fn nobody_until(&self) -> Option<Instant> {
        self.nobody.map(|(t, _)| t)
    }

    /// Whether it needs its names client: a lookup or a question under way, an `ids` check, or a put.
    pub fn busy(&self) -> bool {
        !self.lookups.is_empty()
            || !self.firsts.is_empty()
            || self.ask.is_some()
            || !self.ids_wanted.is_empty()
            || !self.puts.is_empty()
            || self.reqs.values().any(|(r, _)| matches!(r, Req::Put(_)))
    }

    /// A stored record (a member's, version 3), streamed in at the start: verified when it was taken, so trusted. False
    /// for a record that isn't a member's or whose chain no longer covers `unix` (the page deletes it).
    pub fn load(&mut self, record: &[u8], unix: u64) -> bool {
        let Some((earliest, whole, checked, item)) = read_record(record) else {
            return false;
        };
        let [w]: [WireEntry; 1] = match item.entries.try_into() {
            Ok(e) => e,
            Err(_) => return false,
        };
        let last = w.trusted();
        if last.entry.name != item.id {
            return false;
        }
        let mut name = Name::new(item.id);
        name.insert(last.clone());
        let Some(chain) = name.owner(&self.params, unix) else {
            return false;
        };
        let zone = item
            .zone
            .filter(|z| z.owner == chain.owner && z.name == item.id);
        self.kept.insert(
            item.id,
            KeptName {
                kept: Kept {
                    earliest: earliest.min(chain.seniority),
                    whole: whole || chain.claimed,
                    chain,
                },
                last,
                zone,
                checked,
                used: checked,
            },
        );
        true
    }

    // ---- The resolver's side ----

    /// What the resolver answers for `full` (relative to the room's domain: `test123`, `git.test123`) at `now`.
    /// `start`: a query that just came (a lookup may start); re-evaluating a waiting one starts nothing.
    pub fn query(&mut self, full: &str, now: Instant, unix: u64, start: bool) -> Answer {
        let Some((_, name)) = split(full) else {
            return Answer::Nx;
        };
        let id = self.names.name_id(name);
        if let Some(k) = self.kept.get_mut(&id) {
            if !k.kept.chain.covers(unix) {
                self.kept.remove(&id);
                self.cmds.push_back(Cmd::Store { id, record: None });
            } else {
                k.used = unix;
                let resolves = k.kept.chain.resolves(unix);
                // In its grace a name is NXDOMAIN while fresh, so it is confirmed sooner: a renewal the servers come
                // to hold shows a minute late at most, not five.
                let refresh = if resolves {
                    KEPT_REFRESH
                } else {
                    KEPT_GRACE_REFRESH
                };
                let fresh = unix < k.checked + refresh;
                let answer = if resolves {
                    let node = k.zone.as_ref().and_then(|z| z.open(&self.names, full));
                    Some(node.map_or(Answer::Nx, Answer::Node))
                } else if fresh {
                    Some(Answer::Nx) // in its grace: the name resolves for nobody
                } else {
                    None // in its grace, not checked lately: wait for a renewal the servers may hold
                };
                if start && !fresh {
                    self.lookup(id, now);
                }
                if let Some(a) = answer {
                    return a;
                }
            }
        }
        if self.negative.get(&id).is_some_and(|(t, _)| *t > now) {
            return Answer::Nx;
        }
        if self.nobody.is_some_and(|(t, _)| t > now) {
            return Answer::Nx;
        }
        if start {
            self.servfail.remove(&id); // asked again
            self.lookup(id, now);
        } else if self.servfail.contains_key(&id) {
            return Answer::ServFail;
        }
        Answer::Wait
    }

    /// A lookup of `id`: a kept name's refresh goes to servers found by "who serves?" (it must not name the id to the
    /// room); a name not kept asks the room ([`Member::first`]).
    fn lookup(&mut self, id: [u8; 32], now: Instant) {
        if self.lookups.contains_key(&id)
            || self.firsts.contains_key(&id)
            || self.lookups.len() + self.firsts.len() >= MAX_LOOKUPS
            || self.nobody.is_some_and(|(t, _)| t > now)
        {
            return;
        }
        if !self.kept.contains_key(&id) {
            return self.first(id, now);
        }
        self.lookups
            .insert(id, Lookup::new(BTreeMap::new(), false, false));
        self.dispatch(now);
    }

    /// The dialog's `ids` check, one a press of Register (the user's decision, 2026-11-17): every id under `first` (the
    /// name's id's first byte, never the id), from each server.
    pub fn ids(&mut self, first: u8, now: Instant) {
        self.ids_answers.remove(&first);
        self.ids_wanted.insert(first);
        self.dispatch(now);
    }

    /// Puts `item` to the servers held (or found): each answer comes in [`Member::put_done`]. An item of the same name
    /// waiting replaces it. False when too many wait.
    pub fn put(&mut self, item: Item, now: Instant) -> bool {
        if self.puts.len() >= MAX_PUTS && !self.puts.contains_key(&item.id) {
            return false;
        }
        self.puts.insert(item.id, item);
        self.dispatch(now);
        self.flush();
        true
    }

    /// Sends what waits for servers, or asks for servers.
    fn dispatch(&mut self, now: Instant) {
        if self.key.is_none() {
            return; // the transport starts and calls again
        }
        self.flush_asks(now);
        if !self.ready {
            return; // servers' call backs need the home region: it calls again once up
        }
        if self.servers.is_empty() {
            // Only what must not name an id needs servers: refreshes, the dialog's check, puts (a first lookup asks the
            // room).
            let needs = !self.lookups.is_empty()
                || !self.ids_wanted.is_empty()
                || !self.puts.is_empty()
                || self.probe;
            if self.ask.is_none() && needs && self.next_question.is_none() {
                self.start_question(now);
            }
            return;
        }
        let todo: Vec<([u8; 32], bool)> = self
            .lookups
            .iter()
            // Not one whose answers are being checked: its `asked` is empty then too (review 2).
            .filter(|(_, l)| l.asked.is_empty() && l.checking.is_none())
            .map(|(id, l)| (*id, l.history))
            .collect();
        for (id, history) in todo {
            for s in self.servers.clone() {
                self.send_get(id, s, history, now);
            }
        }
        for (id, item) in std::mem::take(&mut self.puts) {
            let m = Msg::Put(item).encode(0);
            for s in self.servers.clone() {
                let x = self.xf.send(s, &m, now);
                self.reqs
                    .insert((s, x), (Req::Put(id), now + REQUEST_TIMEOUT));
            }
        }
        for first in std::mem::take(&mut self.ids_wanted) {
            let m = Msg::Get {
                mode: GetMode::Ids,
                id: vec![first],
                zone: (0, [0; 4]),
                held: Vec::new(),
            };
            for s in self.servers.clone() {
                let x = self.xf.send(s, &m.encode(0), now);
                self.reqs
                    .insert((s, x), (Req::Ids(first), now + REQUEST_TIMEOUT));
            }
        }
        self.servers_until = Some(now + SERVERS_HELD);
        self.flush();
    }

    fn send_get(&mut self, id: [u8; 32], server: [u8; 32], history: bool, now: Instant) {
        // `history` holds nothing: the whole run, the kept last entry too, so the run's last is the server's.
        let (held, zone) = match self.kept.get(&id) {
            Some(k) if !history => (
                vec![(k.last.id()[..8].try_into().unwrap(), anchor_tag(&k.last))],
                zone_tag(k.zone.as_ref()),
            ),
            _ => (Vec::new(), (0, [0; 4])),
        };
        let mode = if history {
            GetMode::History
        } else {
            GetMode::Owner
        };
        let m = Msg::Get {
            mode,
            id: id.to_vec(),
            zone,
            held,
        };
        let x = self.xf.send(server, &m.encode(0), now);
        let req = if history {
            self.stats.histories += 1;
            Req::History(id)
        } else {
            self.stats.gets += 1;
            Req::Get(id)
        };
        self.reqs.insert((server, x), (req, now + REQUEST_TIMEOUT));
        if let Some(l) = self.lookups.get_mut(&id) {
            l.asked.insert(server, Said::Waiting);
        }
    }

    fn flush(&mut self) {
        for (to, data) in std::mem::take(&mut self.xf.out) {
            self.cmds.push_back(Cmd::Send { to, data });
        }
    }

    // ---- The transport ----

    /// The names client's key: the transport runs (its relays; its home region may not be up yet). It subscribes to
    /// its reply tag, and first lookups' asks go out.
    pub fn start(&mut self, key: [u8; 32], now: Instant) {
        self.key = Some(key);
        self.now = now;
        if !self.firsts.is_empty() {
            self.replies_on = true;
            self.cmds.push_back(Cmd::Replies(true));
        }
        self.dispatch(now);
    }

    /// The names client's home region is up: servers' call backs reach it, so "who serves?" and `fetch` go out.
    pub fn ready(&mut self, now: Instant) {
        if self.key.is_some() && !self.ready {
            self.ready = true;
            self.dispatch(now);
        }
    }

    /// Whether its home region is up ([`Member::ready`]).
    pub fn is_ready(&self) -> bool {
        self.ready
    }

    /// The transport is gone: everything tied to its key goes; what is kept stays.
    pub fn stop(&mut self) {
        self.key = None;
        self.ready = false;
        self.replies_on = false;
        self.firsts.clear();
        self.ask_nonces.clear();
        self.asks_out.clear();
        self.xf = Transfers::default();
        for ((k, _), (r, _)) in std::mem::take(&mut self.reqs) {
            if let Req::Put(id) = r {
                self.put_done.push_back(PutDone {
                    id,
                    server: Some(k),
                    result: PutResult::Failed,
                });
            }
            if let Req::Ids(first) = r {
                self.ids_done.push_back(IdsDone {
                    first,
                    server: Some(k),
                    result: IdsResult::Failed,
                });
            }
        }
        self.ask = None;
        self.servers.clear();
        self.servers_until = None;
        self.servers_since = None;
        self.lookups.clear();
        for first in std::mem::take(&mut self.ids_wanted) {
            self.ids_done.push_back(IdsDone {
                first,
                server: None,
                result: IdsResult::Failed,
            });
        }
        self.next_question = None;
        for (id, _) in std::mem::take(&mut self.puts) {
            self.put_done.push_back(PutDone {
                id,
                server: None,
                result: PutResult::Failed,
            });
        }
    }

    pub fn deadline(&self) -> Option<Instant> {
        let ask = self.ask.as_ref().map(|a| match a.first {
            Some(f) => f + CHOOSE_AFTER,
            None => match ROUND_AT.get(a.round) {
                Some(d) => a.started + *d,
                None => a.started + GIVE_UP,
            },
        });
        // Answers being checked: the next turn at once (a slice a turn).
        let checking = (self.lookups.values())
            .any(|l| l.checking.is_some())
            .then_some(self.now);
        let asks = (!self.asks_out.is_empty())
            .then(|| self.asks_sent.front().map(|t| *t + Duration::from_secs(1)))
            .flatten();
        let redraw = self.servers_since.map(|t| t + SERVERS_REDRAW);
        [
            ask,
            checking,
            asks,
            redraw,
            self.firsts_deadline(),
            self.next_question,
            self.xf.deadline(),
            self.reqs.values().map(|(_, t)| *t).min(),
            self.servers_until,
        ]
        .into_iter()
        .flatten()
        .min()
    }

    pub fn tick(&mut self, now: Instant, unix: u64) {
        if self.key.is_none() {
            return;
        }
        self.now = now;
        self.verify_slice(now, unix);
        self.flush_asks(now);
        self.firsts_tick(now, unix);
        if let Some(a) = &self.ask {
            if let Some(f) = a.first {
                if now >= f + CHOOSE_AFTER {
                    if a.answers.len() < 2 && a.round < SPREADS.len() {
                        // One server so far: a member asks everyone at once, so that it holds two where the room
                        // has two (a lone server could leave a name out, or show a younger chain, unseen).
                        let (nonce, spread) = (a.nonce, SPREADS[SPREADS.len() - 1]);
                        let a = self.ask.as_mut().unwrap();
                        a.round = SPREADS.len();
                        a.first = Some(now);
                        self.cmds.push_back(Cmd::Publish { nonce, spread });
                    } else {
                        self.choose(now);
                    }
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
        if self.next_question.is_some_and(|t| t <= now) {
            self.next_question = None;
            self.dispatch(now);
        }
        for (k, id) in self.xf.tick(now) {
            self.failed(k, id, now, unix);
        }
        let late: Vec<([u8; 32], u32)> = (self.reqs.iter())
            .filter(|(_, (_, t))| *t <= now)
            .map(|(k, _)| *k)
            .collect();
        for (k, id) in late {
            self.failed(k, id, now, unix);
        }
        let held_out = self.servers_until.is_some_and(|t| t <= now);
        let redraw = self
            .servers_since
            .is_some_and(|t| now >= t + SERVERS_REDRAW);
        let asking = self.reqs.keys().any(|(k, _)| self.servers.contains(k));
        if (held_out && self.lookups.is_empty()) || (redraw && !asking) {
            self.servers_until = None;
            self.servers_since = None;
            for k in std::mem::take(&mut self.servers) {
                self.cmds.push_back(Cmd::Forget(k));
            }
        }
        // The doubling is remembered while the name stays unknown: past its wait and as long again unasked, forgotten.
        self.negative.retain(|_, (t, w)| *t + *w > now);
        self.flush();
    }

    pub fn input(&mut self, i: Input, now: Instant, unix: u64) {
        if self.key.is_none() {
            return;
        }
        self.now = now;
        match i {
            // A member answers nobody, and asks nothing outside the room.
            Input::Question { .. } | Input::Fetched { .. } | Input::Ask { .. } => {}
            Input::Reply(r) => self.on_reply(r, now, unix),
            Input::Gone(k) => self.gone(k, now, unix),
            Input::Datagram { from, data } => {
                if let Some((_, payload)) = self.xf.input(from, &data, now) {
                    match Msg::decode(&payload) {
                        Ok((m, reply)) => self.on_msg(from, reply, m, now, unix),
                        Err(e) => self.log(format!("a message refused: {e:?}")),
                    }
                }
            }
        }
        self.flush();
    }

    // ---- Asking "who serves?" ----

    fn start_question(&mut self, now: Instant) {
        if !room_in(&mut self.questions, QUESTIONS_PER_SECOND, now) {
            self.next_question = Some(now + Duration::from_secs(1));
            return;
        }
        self.questions.push_back(now);
        self.stats.questions += 1;
        let nonce = random();
        self.ask = Some(Ask::new(nonce, now));
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
        self.probe = false;
        self.stats.nobody += 1;
        let wait = self
            .nobody
            .map_or(NOBODY_FIRST, |(_, w)| (w * 2).min(NOBODY_MAX));
        self.nobody = Some((now + wait, wait));
        self.log(format!(
            "nobody serves the registry; NXDOMAIN for {} s",
            wait.as_secs()
        ));
        // The queries that waited get NXDOMAIN now (`query` says so while it is remembered); puts, nobody to put to;
        // checks, nobody can say.
        self.lookups.clear();
        for first in std::mem::take(&mut self.ids_wanted) {
            self.ids_done.push_back(IdsDone {
                first,
                server: None,
                result: IdsResult::Nobody,
            });
        }
        for (id, _) in std::mem::take(&mut self.puts) {
            self.put_done.push_back(PutDone {
                id,
                server: None,
                result: PutResult::Nobody,
            });
        }
    }

    fn on_serve(&mut self, from: [u8; 32], m: Msg, now: Instant, unix: u64) {
        let Some(a) = &self.ask else {
            if !self.servers.contains(&from) {
                self.cmds.push_back(Cmd::Forget(from));
            }
            return;
        };
        let nonce = a.nonce;
        if a.answers.contains_key(&from) {
            return;
        }
        if let Msg::Serve { entries, .. } = &m
            && let Some(e) = entries.first()
            && !a.new_name(&e.entry.owner, &e.entry.name)
        {
            self.stats.refused += 1;
            self.log("a serve refused: a name that answered already".into());
            return self.cmds.push_back(Cmd::Forget(from));
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
                self.stats.refused += 1;
                self.log(format!("a serve refused: {e:?}"));
                return self.cmds.push_back(Cmd::Forget(from));
            }
        };
        match self.ask.as_mut().unwrap().offer(from, owner, name, now) {
            Ok(c) => self.cmds.push_back(Cmd::Served(from, c)),
            Err(why) => {
                self.stats.refused += 1;
                self.log(format!("a serve refused: {why}"));
                self.cmds.push_back(Cmd::Forget(from));
            }
        }
    }

    /// The two answers with the lowest rank are kept; the others are let go.
    fn choose(&mut self, now: Instant) {
        let a = self.ask.take().unwrap();
        self.nobody = None;
        self.probe = false;
        self.served = Some(now);
        let (keep, rest) = a.choose();
        self.cmds.push_back(Cmd::Accept { until: now, max: 0 });
        self.servers.extend(keep);
        self.servers_since = Some(now);
        for k in rest {
            self.cmds.push_back(Cmd::Forget(k));
        }
        self.dispatch(now);
    }

    // ---- Answers ----

    fn on_msg(&mut self, from: [u8; 32], reply: u32, m: Msg, now: Instant, unix: u64) {
        if reply == 0 {
            match m {
                m @ Msg::Serve { .. } => self.on_serve(from, m, now, unix),
                Msg::Items(items) => self.on_fetched(from, items, now, unix),
                _ => {} // a member serves nothing
            }
            return;
        }
        let Some((r, _)) = self.reqs.remove(&(from, reply)) else {
            return;
        };
        match (r, m) {
            (r @ (Req::Get(id) | Req::History(id)), Msg::Items(items)) => {
                let said = match items.into_iter().find(|i| i.id == id) {
                    Some(it) => Said::Item(Box::new(it)),
                    None => Said::Nothing,
                };
                // Only into a lookup asking in the same mode, and waiting for this server.
                let history = matches!(r, Req::History(_));
                if let Some(l) = self.lookups.get_mut(&id)
                    && l.history == history
                    && l.asked.contains_key(&from)
                {
                    l.asked.insert(from, said);
                }
                self.settle(id, now, unix);
            }
            (Req::Put(id), m) => {
                let result = match m {
                    Msg::Taken => PutResult::Taken,
                    Msg::Better(it) => PutResult::Better(Box::new(it)),
                    _ => PutResult::Failed,
                };
                self.put_done.push_back(PutDone {
                    id,
                    server: Some(from),
                    result,
                });
            }
            (Req::Ids(first), Msg::Ids(ids)) => {
                let ids: Vec<([u8; 32], u64)> =
                    ids.into_iter().filter(|(i, _)| i[0] == first).collect();
                let got = self.ids_answers.entry(first).or_default();
                for (i, until) in &ids {
                    let u = got.entry(*i).or_default();
                    *u = (*u).max(*until);
                }
                self.ids_done.push_back(IdsDone {
                    first,
                    server: Some(from),
                    result: IdsResult::Ids(ids),
                });
            }
            (Req::Ids(first), _) => self.ids_done.push_back(IdsDone {
                first,
                server: Some(from),
                result: IdsResult::Failed,
            }),
            (Req::Get(id) | Req::History(id), _) => {
                if let Some(l) = self.lookups.get_mut(&id) {
                    l.asked.insert(from, Said::Failed);
                }
                self.settle(id, now, unix);
            }
        }
    }

    fn failed(&mut self, k: [u8; 32], x: u32, now: Instant, unix: u64) {
        let Some((r, _)) = self.reqs.remove(&(k, x)) else {
            return;
        };
        self.drop_server(k);
        if let Req::Put(id) = r {
            self.put_done.push_back(PutDone {
                id,
                server: Some(k),
                result: PutResult::Failed,
            });
        }
        if let Req::Ids(first) = r {
            self.ids_done.push_back(IdsDone {
                first,
                server: Some(k),
                result: IdsResult::Failed,
            });
        }
        if let Req::Get(id) | Req::History(id) = r {
            if let Some(l) = self.lookups.get_mut(&id) {
                l.asked.insert(k, Said::Failed);
            }
            self.settle(id, now, unix);
        }
    }

    fn gone(&mut self, k: [u8; 32], now: Instant, unix: u64) {
        self.xf.forget(&k);
        self.fetch_gone(&k, now, unix);
        if let Some(a) = &mut self.ask {
            a.answers.remove(&k); // let go by the accept window for a better one
        }
        let mine: Vec<([u8; 32], u32)> =
            self.reqs.keys().filter(|(p, _)| *p == k).copied().collect();
        for (p, x) in mine {
            self.failed(p, x, now, unix);
        }
        self.drop_server(k);
    }

    fn drop_server(&mut self, k: [u8; 32]) {
        if let Some(i) = self.servers.iter().position(|s| *s == k) {
            self.servers.remove(i);
            self.cmds.push_back(Cmd::Forget(k));
        }
    }

    /// A lookup whose servers have all answered (or failed): what they said is checked (a slice a turn: `history` may
    /// carry a thousand entries), then decided.
    fn settle(&mut self, id: [u8; 32], now: Instant, unix: u64) {
        let Some(l) = self.lookups.get_mut(&id) else {
            return;
        };
        if l.checking.is_some() || l.asked.values().any(|s| matches!(s, Said::Waiting)) {
            return;
        }
        let history = l.history;
        let kept_last = self.kept.get(&id).map(|k| k.last.clone());
        let mut c = Checking {
            left: VecDeque::new(),
            views: Vec::new(),
            nothing: 0,
        };
        let mut refused = 0;
        for (server, said) in std::mem::take(&mut l.asked) {
            match said {
                Said::Nothing => c.nothing += 1,
                Said::Item(it) => {
                    // A member checks the last entry only, unless it asked for the run, or the server shows the kept
                    // chain's release (and what leads to it from the kept last entry).
                    let release = kept_last.is_some()
                        && it.entries.len() <= RELEASE_RUN
                        && it
                            .entries
                            .last()
                            .is_some_and(|w| w.entry.kind == Kind::Release);
                    if (!history && it.entries.len() > 1 && !release) || it.id != id {
                        refused += 1;
                        continue;
                    }
                    let mut seen = BTreeSet::new();
                    let entries = (it.entries.into_iter())
                        .filter(|w| seen.insert(w.entry.id()))
                        .collect();
                    let mut name = Name::new(id);
                    let mut last = None;
                    // Owner mode: the kept last entry joins what the server showed (a renewal continues it; no entry
                    // means the server's last is the one kept). A history is taken as shown: what is kept judges it.
                    if let Some(k) = kept_last.clone().filter(|_| !history) {
                        last = Some(k.id());
                        name.insert(k);
                    }
                    c.left.push_back(Check {
                        server,
                        entries,
                        zone: it.zone,
                        name,
                        last,
                    });
                }
                Said::Waiting | Said::Failed => {}
            }
        }
        l.checking = Some(c);
        if refused > 0 {
            self.stats.refused += refused;
            self.log("an answer refused: Encoding".into());
        }
        self.verify_slice(now, unix);
    }

    /// Checks a slice of what servers said (an entry costs 4 units of [`UNITS_PER_TURN`], as a server's), and decides
    /// the lookups whose answers are all checked.
    fn verify_slice(&mut self, now: Instant, unix: u64) {
        let mut units = 0;
        let ids: Vec<[u8; 32]> = (self.lookups.iter())
            .filter(|(_, l)| l.checking.is_some())
            .map(|(id, _)| *id)
            .collect();
        for id in ids {
            loop {
                let l = self.lookups.get_mut(&id).unwrap();
                let c = l.checking.as_mut().unwrap();
                let Some(mut check) = c.left.pop_front() else {
                    break;
                };
                let mut verdict = None;
                while units < UNITS_PER_TURN {
                    let Some(w) = check.entries.pop_front() else {
                        break;
                    };
                    units += 4;
                    self.stats.checked += 1;
                    if let Err(e) = self.check_one(&mut check, w, unix) {
                        verdict = Some(Err(e));
                        break;
                    }
                }
                if verdict.is_none() && !check.entries.is_empty() {
                    let c = self
                        .lookups
                        .get_mut(&id)
                        .unwrap()
                        .checking
                        .as_mut()
                        .unwrap();
                    c.left.push_front(check);
                    return;
                }
                let server = check.server;
                let verdict = verdict.unwrap_or_else(|| self.view(id, check, unix));
                let c = self
                    .lookups
                    .get_mut(&id)
                    .unwrap()
                    .checking
                    .as_mut()
                    .unwrap();
                match verdict {
                    Ok(Some(v)) => c.views.push((server, v)),
                    Ok(None) => c.nothing += 1,
                    Err(e) => {
                        self.stats.refused += 1;
                        self.log(format!("an answer refused: {e:?}"));
                    }
                }
            }
            let l = self.lookups.remove(&id).unwrap();
            let c = l.checking.unwrap();
            self.decide(id, l.history, l.retried, c.views, c.nothing, now, unix);
            if units >= UNITS_PER_TURN {
                return;
            }
        }
    }

    /// One entry of a server's item: checked whole (signature, proof of work, anchor and its header).
    fn check_one(&mut self, check: &mut Check, w: WireEntry, unix: u64) -> Result<(), Invalid> {
        if w.entry.name != check.name.id {
            return Err(Invalid::Name);
        }
        let mut s = Stamped::check(w.entry, &self.names, &mut self.pow)?;
        let (a, h) = w.anchor.ok_or(Invalid::AnchorRoot)?;
        s.offer_anchor(a, h, &self.params, unix)?;
        check.last = Some(s.id());
        check.name.insert(s);
        Ok(())
    }

    /// A server's item checked: its zone, and the chain whose last entry is the server's (the one it says owns the
    /// name), which must cover now.
    fn view(&self, id: [u8; 32], check: Check, unix: u64) -> Result<Option<View>, Invalid> {
        let Some(last) = check.last else {
            return Ok(None);
        };
        let zone = match check.zone {
            Some(z) if z.name != id || !z.verify(&self.names) => return Err(Invalid::Zone),
            z => z,
        };
        let chains = check.name.chains(&self.params);
        // The kept chain released: it holds the kept last entry and ends at the server's.
        let kept = self.kept.get(&id).map(|k| k.last.id());
        if let Some(c) = (chains.iter())
            .find(|c| c.released && c.last() == last && kept.is_some_and(|k| c.ids.contains(&k)))
        {
            return Ok(Some(View {
                chain: c.clone(),
                name: check.name,
                zone: None,
                released: true,
            }));
        }
        let chain = (chains.into_iter()).find(|c| c.last() == last && c.covers(unix));
        Ok(chain.map(|chain| View {
            name: check.name,
            chain,
            zone,
            released: false,
        }))
    }

    /// A lookup whose answers are checked: decided, or asked again for `history`.
    #[allow(clippy::too_many_arguments)]
    fn decide(
        &mut self,
        id: [u8; 32],
        history: bool,
        retried: bool,
        views: Vec<([u8; 32], View)>,
        nothing: usize,
        now: Instant,
        unix: u64,
    ) {
        // A server showed the kept chain's release: what is kept ends there (the release is the owner's own, signed and
        // anchored, so one server's word is enough), and the name is asked for again, holding nothing.
        if views.iter().any(|(_, v)| v.released) {
            if self.kept.remove(&id).is_some() {
                self.log("a kept name was let go by its owner".into());
                self.cmds.push_back(Cmd::Store { id, record: None });
            }
            // Not kept now: asked for as a first lookup, holding nothing.
            self.first(id, now);
            return;
        }
        if views.is_empty() {
            if nothing == 0 {
                // Nobody answered: once more, with servers found again if need be.
                if !retried {
                    self.lookups
                        .insert(id, Lookup::new(BTreeMap::new(), false, true));
                    self.dispatch(now);
                }
                return;
            }
            // None: a kept chain still alive answers throughout (a server that lost it says nothing against it).
            if let Some(k) = self.kept.get_mut(&id)
                && k.kept.chain.covers(unix)
            {
                k.checked = unix;
                let record = Some(k.record());
                self.cmds.push_back(Cmd::Store { id, record });
            } else {
                self.none_known(id, now);
            }
            return;
        }
        if !history {
            let lasts: BTreeSet<[u8; 32]> = views.iter().map(|(_, v)| v.chain.last()).collect();
            let contested = self.kept.get(&id).is_some_and(|k| {
                views.iter().any(|(_, v)| {
                    v.chain.last() != k.kept.chain.last() && !k.kept.clone().offer(&v.chain, unix)
                })
            });
            if lasts.len() > 1 || contested {
                // The servers disagree, or one contests what is kept: each one's whole run.
                let asked = views.iter().map(|(s, _)| (*s, Said::Waiting)).collect();
                self.lookups.insert(id, Lookup::new(asked, true, retried));
                for (s, _) in &views {
                    self.send_get(id, *s, true, now);
                }
                self.flush();
                return;
            }
        }
        // The owner by "Who owns a name" over everything shown.
        let mut all = Name::new(id);
        let mut zones = Vec::new();
        for (_, v) in views {
            for e in v.name.entries() {
                all.insert(e.clone());
            }
            zones.extend(v.zone);
        }
        let Some(owner) = all.owner(&self.params, unix) else {
            return;
        };
        let last = all.get(&owner.last()).unwrap().clone();
        self.take(id, owner, last, zones, unix);
    }

    /// The chain the answers make the owner, offered to what is kept (or kept, when nothing is).
    fn take(&mut self, id: [u8; 32], chain: Chain, last: Stamped, zones: Vec<Zone>, unix: u64) {
        let best_zone = |current: Option<Zone>, owner: &[u8; 32]| {
            let mut best = current.filter(|z| z.owner == *owner);
            for z in zones.iter().filter(|z| z.owner == *owner) {
                if best.as_ref().is_none_or(|b| z.beats(b)) {
                    best = Some(z.clone());
                }
            }
            best
        };
        let k = match self.kept.remove(&id) {
            Some(mut k) => {
                // The same chain (a zone may have changed), one that continues it, or one that replaces it.
                let same = chain.last() == k.kept.chain.last();
                // Offered even when the same: a run that holds the kept last entry lowers the earliest time.
                if k.kept.offer(&chain, unix) || same {
                    let zone = if k.last.entry.owner == chain.owner {
                        k.zone.take()
                    } else {
                        None
                    };
                    k.zone = best_zone(zone, &chain.owner);
                    k.last = last;
                } else {
                    self.log("a kept name stands against a younger chain".into());
                }
                k.checked = unix;
                k
            }
            None => {
                if self.kept.len() >= MAX_KEPT
                    && let Some((&old, _)) = self.kept.iter().min_by_key(|(_, k)| k.used)
                {
                    self.kept.remove(&old);
                    self.cmds.push_back(Cmd::Store {
                        id: old,
                        record: None,
                    });
                }
                KeptName {
                    zone: best_zone(None, &chain.owner),
                    kept: Kept::new(chain),
                    last,
                    checked: unix,
                    used: unix,
                }
            }
        };
        self.negative.remove(&id);
        let record = Some(k.record());
        self.kept.insert(id, k);
        self.cmds.push_back(Cmd::Store { id, record });
    }
}

// ---- First lookups (names.md "A member resolving a name"): the room asked through the relays ----

impl Member {
    /// Tests' view: the first lookups under way.
    #[cfg(test)]
    pub fn firsts(&self) -> usize {
        self.firsts.len()
    }

    /// The spread the next first lookup starts at.
    pub fn spread(&self) -> u8 {
        self.spread
    }

    /// Starts a first lookup of `id`: its `share` ask at the spread the room last answered at.
    fn first(&mut self, id: [u8; 32], now: Instant) {
        if self.firsts.contains_key(&id) {
            return;
        }
        if self.key.is_some() && !self.replies_on {
            // Subscribed before the first ask goes: on each relay, the subscription comes first.
            self.replies_on = true;
            self.cmds.push_back(Cmd::Replies(true));
        }
        // Three rounds whatever the start: from everyone, everyone again (a server whose reply budget was spent, or a
        // relay that lost the ask, answers the next).
        let s = self.spread;
        let spreads = vec![s, s.saturating_sub(3), 0];
        let nonce = random();
        self.ask_nonces.insert(nonce, id);
        self.firsts.insert(
            id,
            First {
                nonce,
                spreads,
                round: 0,
                sent: 0,
                sent_at: now,
                first: None,
                spread_at_first: 0,
                share_count: 0,
                dissent: None,
                decide_at: None,
                decided: None,
                queue: VecDeque::new(),
                keys: BTreeMap::new(),
                zoned: BTreeSet::new(),
                nones: 0,
                repliers: Vec::new(),
                contest: None,
                entries: BTreeMap::new(),
                released: Vec::new(),
            },
        );
        self.next_round(id, now);
    }

    /// The `share` ask's next round.
    fn next_round(&mut self, id: [u8; 32], now: Instant) {
        let f = self.firsts.get_mut(&id).unwrap();
        let (nonce, spread) = (f.nonce, f.spreads[f.round]);
        f.round += 1;
        self.send_ask(nonce, id, AskMode::Share, spread, [0; 8], now);
    }

    fn send_ask(
        &mut self,
        nonce: [u8; 16],
        id: [u8; 32],
        mode: AskMode,
        spread: u8,
        shown: [u8; 8],
        now: Instant,
    ) {
        self.asks_out.push_back(AskOut {
            nonce,
            id,
            mode,
            spread,
            shown,
        });
        self.flush_asks(now);
    }

    /// Sends the asks waiting, [`ASKS_PER_SECOND`] at most; a `fetch` waits for the home region (its call back).
    fn flush_asks(&mut self, now: Instant) {
        if self.key.is_none() {
            return;
        }
        while let Some(a) = self.asks_out.front() {
            if a.mode == AskMode::Fetch && !self.ready {
                break;
            }
            if !room_in(&mut self.asks_sent, ASKS_PER_SECOND, now) {
                break;
            }
            let a = self.asks_out.pop_front().unwrap();
            self.asks_sent.push_back(now);
            self.sent_nonces.push_back((a.nonce, now));
            if a.mode == AskMode::Share
                && let Some(f) = self.firsts.get_mut(&a.id).filter(|f| f.nonce == a.nonce)
            {
                f.sent += 1;
                f.sent_at = now;
            }
            self.stats.asks += 1;
            if a.mode == AskMode::Fetch {
                self.stats.fetches += 1;
                let mut server = None;
                if let Some(c) = self.firsts.get_mut(&a.id).and_then(|f| f.contest.as_mut()) {
                    for (k, t) in c.flying.iter_mut() {
                        if t.is_none() && k[..8] == a.shown {
                            *t = Some(now + FETCH_WAIT);
                            server = Some(*k);
                        }
                    }
                }
                if server.is_none() {
                    continue; // the contest ended meanwhile
                }
                self.accept_fetched(now);
            }
            self.cmds.push_back(Cmd::Ask {
                nonce: a.nonce,
                id: a.id,
                mode: a.mode,
                spread: a.spread,
                shown: a.shown,
            });
        }
    }

    /// The window for handshakes: only from the servers a `fetch` went to.
    fn accept_fetched(&mut self, now: Instant) {
        let keys: Vec<[u8; 32]> = (self.firsts.values())
            .filter_map(|f| f.contest.as_ref())
            .flat_map(|c| {
                c.flying
                    .iter()
                    .filter(|(_, t)| t.is_some())
                    .map(|(k, _)| *k)
            })
            .collect();
        let until = (self.firsts.values())
            .filter_map(|f| f.contest.as_ref())
            .flat_map(|c| c.flying.values().flatten().copied())
            .max()
            .unwrap_or(now);
        self.cmds.push_back(Cmd::AcceptFrom { keys, until });
    }

    fn firsts_deadline(&self) -> Option<Instant> {
        (self.firsts.values())
            .flat_map(|f| {
                let checking = (!f.queue.is_empty()
                    || f.contest.as_ref().is_some_and(|c| !c.runs.is_empty()))
                .then_some(self.now);
                let round = (f.first.is_none()).then(|| f.round_due()).flatten();
                let fetch = (f.contest.as_ref())
                    .and_then(|c| c.flying.values().flatten().chain([&c.until]).min().copied());
                let decide = f.decide_at.filter(|_| f.decided.is_none());
                let late = (f.decided)
                    .filter(|_| f.contest.is_none())
                    .map(|t| t + LATE_FOR);
                [checking, round, decide, late, fetch]
            })
            .flatten()
            .min()
    }

    /// A reply under our reply tag: to a first lookup's ask, it waits for its check.
    fn on_reply(&mut self, r: Reply, now: Instant, unix: u64) {
        let Some(id) = self.ask_nonces.get(&r.nonce).copied() else {
            // Not ours: an ask naming our key, which a server replied to from our tag's budget.
            while (self.sent_nonces.front())
                .is_some_and(|(_, t)| now.saturating_duration_since(*t) >= STRAY_FOR)
            {
                self.sent_nonces.pop_front();
            }
            if !self.sent_nonces.iter().any(|(n, _)| *n == r.nonce) {
                self.strays.push_back(now);
            }
            return;
        };
        let Some(f) = self.firsts.get_mut(&id) else {
            return;
        };
        self.stats.replies += 1;
        f.queue.push_back(r);
        self.check_replies(now, unix);
    }

    /// One entry of a reply or a run, checked whole: the entry itself once (by id), its anchor with each copy.
    #[allow(clippy::too_many_arguments)]
    fn check_entry(
        names: &RoomNames,
        params: &Params,
        pow: &mut Pow,
        stats: &mut MemberStats,
        seen: &mut BTreeMap<[u8; 32], Option<Stamped>>,
        w: WireEntry,
        id: &[u8; 32],
        unix: u64,
        units: &mut u32,
    ) -> Result<Stamped, Invalid> {
        if w.entry.name != *id {
            return Err(Invalid::Name);
        }
        let eid = w.entry.id();
        let mut s = match seen.get(&eid) {
            Some(Some(s)) => s.clone(),
            Some(None) => return Err(Invalid::Signature),
            None => {
                *units += 4;
                stats.checked += 1;
                match Stamped::check(w.entry, names, pow) {
                    Ok(s) => {
                        seen.insert(eid, Some(s.clone()));
                        s
                    }
                    Err(e) => {
                        seen.insert(eid, None);
                        return Err(e);
                    }
                }
            }
        };
        *units += 1;
        let (a, h) = w.anchor.ok_or(Invalid::AnchorRoot)?;
        s.offer_anchor(a, h, params, unix)?;
        Ok(s)
    }

    /// Checks first lookups' replies and runs, [`UNITS_PER_TURN`] a turn (an entry 4, an anchor or a zone 1).
    fn check_replies(&mut self, now: Instant, unix: u64) {
        let mut units = 0u32;
        let ids: Vec<[u8; 32]> = self.firsts.keys().copied().collect();
        for id in ids {
            while units < UNITS_PER_TURN {
                let f = self.firsts.get_mut(&id).unwrap();
                let Some(r) = f.queue.pop_front() else { break };
                // A release, and what leads to it (a holder's: final review, finding 5): every entry checked; it says
                // none, and ends what it releases.
                if let ReplyItem::Item(it) = &r.item
                    && it.entries.iter().any(|w| w.entry.kind == Kind::Release)
                {
                    let ReplyItem::Item(it) = r.item else {
                        unreachable!()
                    };
                    let (names, params) = (&self.names, &self.params);
                    let checked = Self::check_release(
                        names,
                        params,
                        &mut self.pow,
                        &mut self.stats,
                        &mut f.entries,
                        *it,
                        &id,
                        unix,
                        &mut units,
                    );
                    match checked {
                        Err(e) => {
                            self.stats.refused += 1;
                            self.log(format!("a release replied refused: {e:?}"));
                        }
                        Ok(run) => {
                            self.released(id, run);
                            self.counted(id, r.nonce, r.server, 0, None, now, unix);
                        }
                    }
                    continue;
                }
                let it = match r.item {
                    ReplyItem::None => None,
                    ReplyItem::Item(it) => Some((it, false)),
                    // "Too big" carries the last entry alone, checked as an item's (a forged one weighs nothing).
                    ReplyItem::TooBig(it) => Some((it, true)),
                };
                let checked = match it {
                    None => Ok(None),
                    Some((it, big)) => {
                        let (names, params) = (&self.names, &self.params);
                        Self::check_item(
                            names,
                            params,
                            &mut self.pow,
                            &mut self.stats,
                            &mut f.entries,
                            *it,
                            &id,
                            unix,
                            &mut units,
                        )
                        .map(|(s, z)| Some((s, z, big)))
                    }
                };
                match checked {
                    Err(e) => {
                        self.stats.refused += 1;
                        self.log(format!("a reply refused: {e:?}"));
                    }
                    Ok(item) => self.counted(id, r.nonce, r.server, r.since, item, now, unix),
                }
            }
            // Runs fetched for a contest.
            while units < UNITS_PER_TURN {
                let f = self.firsts.get_mut(&id).unwrap();
                let Some(c) = f.contest.as_mut() else { break };
                let Some(mut run) = c.runs.pop_front() else {
                    break;
                };
                let mut failed = None;
                while units < UNITS_PER_TURN {
                    let Some(w) = run.entries.pop_front() else {
                        break;
                    };
                    match Self::check_entry(
                        &self.names,
                        &self.params,
                        &mut self.pow,
                        &mut self.stats,
                        &mut f.entries,
                        w,
                        &id,
                        unix,
                        &mut units,
                    ) {
                        Ok(s) => {
                            run.last = Some(s.id());
                            run.name.insert(s);
                        }
                        Err(e) => {
                            failed = Some(e);
                            break;
                        }
                    }
                }
                if failed.is_none() && !run.entries.is_empty() {
                    f.contest.as_mut().unwrap().runs.push_front(run);
                    break;
                }
                if let Some(e) = failed {
                    self.stats.refused += 1;
                    self.log(format!("a fetched run refused: {e:?}"));
                    continue;
                }
                units += 1;
                self.run_checked(id, run, unix);
            }
            self.contest_step(id, now, unix);
            if units >= UNITS_PER_TURN {
                return;
            }
        }
    }

    /// A release replied (final review, finding 5): the release of a chain its holder keeps as a tombstone, and the
    /// entries before it that fit, each checked whole with its anchor. Any that fails refuses the reply.
    #[allow(clippy::too_many_arguments)]
    fn check_release(
        names: &RoomNames,
        params: &Params,
        pow: &mut Pow,
        stats: &mut MemberStats,
        seen: &mut BTreeMap<[u8; 32], Option<Stamped>>,
        it: Item,
        id: &[u8; 32],
        unix: u64,
        units: &mut u32,
    ) -> Result<Vec<Stamped>, Invalid> {
        if it.id != *id || it.zone.is_some() || it.entries.len() > 2 * RELEASE_RUN {
            return Err(Invalid::Encoding);
        }
        (it.entries.into_iter())
            .map(|w| Self::check_entry(names, params, pow, stats, seen, w, id, unix, units))
            .collect()
    }

    /// Whether `s` (a key's last entry shown) is on a chain one of `released` ends: the release links to it (what leads
    /// to it was replied with it, or `s` is the entry it names).
    fn is_released(params: &Params, released: &[Stamped], s: &Stamped) -> bool {
        let mut n = Name::new(s.entry.name);
        n.insert(s.clone());
        for e in released.iter().filter(|e| e.entry.owner == s.entry.owner) {
            n.insert(e.clone());
        }
        (n.chains(params).iter()).any(|c| c.released && c.ids.contains(&s.id()))
    }

    /// A release replied for first lookup `id`, checked: the keys shown whose last entry it releases show nothing, and
    /// a name taken from one of them meanwhile (a late release) is kept no more.
    fn released(&mut self, id: [u8; 32], run: Vec<Stamped>) {
        let params = self.params.clone();
        let f = self.firsts.get_mut(&id).unwrap();
        f.released.extend(run);
        let gone: Vec<[u8; 32]> = (f.keys.iter())
            .filter(|(_, (s, _))| Self::is_released(&params, &f.released, s))
            .map(|(k, _)| *k)
            .collect();
        for k in &gone {
            f.keys.remove(k);
            f.zoned.remove(k);
            f.repliers.retain(|r| r.key != *k);
        }
        if !gone.is_empty() {
            self.log("a key shown is released: it shows nothing".into());
        }
        let ended = (self.kept.get(&id))
            .is_some_and(|k| Self::is_released(&params, &self.firsts[&id].released, &k.last));
        if ended {
            self.kept.remove(&id);
            self.cmds.push_back(Cmd::Store { id, record: None });
        }
    }

    /// A reply's item checked: exactly the owning chain's last entry, alive, and its zone (the owner's, for this name).
    #[allow(clippy::too_many_arguments)]
    fn check_item(
        names: &RoomNames,
        params: &Params,
        pow: &mut Pow,
        stats: &mut MemberStats,
        seen: &mut BTreeMap<[u8; 32], Option<Stamped>>,
        it: Item,
        id: &[u8; 32],
        unix: u64,
        units: &mut u32,
    ) -> Result<(Stamped, Option<Zone>), Invalid> {
        let ([w], true) = (
            <[WireEntry; 1]>::try_from(it.entries).map_err(|_| Invalid::Encoding)?,
            it.id == *id,
        ) else {
            return Err(Invalid::Name);
        };
        let s = Self::check_entry(names, params, pow, stats, seen, w, id, unix, units)?;
        let mut n = Name::new(*id);
        n.insert(s.clone());
        if !n.chains(params).iter().any(|c| c.covers(unix)) {
            return Err(Invalid::Dead);
        }
        let zone = match it.zone {
            Some(z) => {
                *units += 1;
                if z.name != *id || z.owner != s.entry.owner || !z.verify(names) {
                    return Err(Invalid::Zone);
                }
                Some(z)
            }
            None => None,
        };
        Ok((s, zone))
    }

    /// A reply that held (`item`: None, said none; else the last entry checked, the zone, and whether the item was too
    /// big for an event) counts: the first asks for dissent or sets the decision; after the decision, another owner
    /// starts a contest.
    #[allow(clippy::too_many_arguments)]
    fn counted(
        &mut self,
        id: [u8; 32],
        nonce: [u8; 16],
        server: [u8; 32],
        since: u32,
        item: Option<(Stamped, Option<Zone>, bool)>,
        now: Instant,
        unix: u64,
    ) {
        self.nobody = None; // someone answers
        self.heard = Some(now);
        let params = self.params.clone();
        let f = self.firsts.get_mut(&id).unwrap();
        if nonce == f.nonce {
            f.share_count += 1;
        }
        // An entry a release replied already ends (final review, finding 5): it shows nothing.
        let item = item.filter(|(s, _, _)| !Self::is_released(&params, &f.released, s));
        let mut new_key = false;
        match item {
            None => f.nones += 1,
            Some((s, zone, big)) => {
                let k = s.entry.owner;
                new_key = !f.keys.contains_key(&k);
                let e = f.keys.entry(k).or_insert_with(|| (s.clone(), Vec::new()));
                // Of one key's last entries (a server a renewal behind, a title forked), the latest.
                if (s.time(), s.id()) > (e.0.time(), e.0.id()) {
                    e.0 = s;
                }
                e.1.extend(zone);
                if !big {
                    f.zoned.insert(k);
                }
                add_replier(
                    &mut f.repliers,
                    Replier {
                        server,
                        since,
                        key: k,
                    },
                );
            }
        }
        if f.first.is_none() {
            f.first = Some(now);
            f.spread_at_first = f.spreads[f.round.max(1) - 1];
            if f.spread_at_first == 0 {
                // Everyone was asked: nobody is left to dissent.
                f.decide_at = Some(now + EVERYONE_WAIT);
            } else {
                // The best item so far, checked (zeros when every reply so far said none): its owner key, that key's
                // latest last entry and best zone, as they would be kept (R3a: the key alone let the owner's own
                // entry with an old zone, or none, silence every holder).
                let mut all = Name::new(id);
                for (s, _) in f.keys.values() {
                    all.insert(s.clone());
                }
                let shown = all.owner(&self.params, unix).map_or([0; 8], |c| {
                    let (last, zones) = &f.keys[&c.owner];
                    let zone = zones.iter().fold(None, |b: Option<&Zone>, z| {
                        if b.is_none_or(|b| z.beats(b)) {
                            Some(z)
                        } else {
                            b
                        }
                    });
                    shown(&c.owner, &last.id(), zone)
                });
                let d = random();
                f.dissent = Some(d);
                f.decide_at = Some(now + DISSENT_WAIT);
                self.ask_nonces.insert(d, id);
                self.send_ask(d, id, AskMode::Dissent, 0, shown, now);
            }
            return;
        }
        let f = self.firsts.get_mut(&id).unwrap();
        // In a contest, a replier that came is among those its next step may fetch.
        if f.decided.is_some() && f.contest.is_none() {
            if self.interfered(now) {
                return;
            }
            let f = self.firsts.get_mut(&id).unwrap();
            if new_key && f.keys.len() > 1 {
                self.log("a late reply shows another owner: a contest".into());
                self.start_contest(id, now, unix);
            } else if f.keys.len() == 1 && !self.kept.contains_key(&id) {
                // Decided none; an owner came late (its zone fetched when only "too big" showed it).
                if f.zoned.is_empty() {
                    self.start_contest(id, now, unix);
                } else {
                    self.decide_one(id, unix);
                }
            }
        }
    }

    /// First lookups' time: rounds, silence, the decision, the late window.
    fn firsts_tick(&mut self, now: Instant, unix: u64) {
        self.check_replies(now, unix);
        let ids: Vec<[u8; 32]> = self.firsts.keys().copied().collect();
        for id in ids {
            let f = &self.firsts[&id];
            if !f.queue.is_empty() {
                continue; // what came is checked first
            }
            if f.first.is_none() {
                if f.round_due().is_some_and(|t| now >= t) {
                    if f.round < f.spreads.len() {
                        self.next_round(id, now);
                    } else {
                        self.silence(id, now);
                    }
                }
                continue;
            }
            if f.decided.is_none() && f.decide_at.is_some_and(|t| now >= t) {
                self.decide_first(id, now, unix);
                continue;
            }
            if let Some(c) = &f.contest {
                if now >= c.until {
                    self.contest_step(id, now, unix); // out of time: decided on the runs checked
                    continue;
                }
                let late: Vec<[u8; 32]> = (c.flying.iter())
                    .filter(|(_, t)| t.is_some_and(|t| now >= t))
                    .map(|(k, _)| *k)
                    .collect();
                for k in late {
                    self.fetch_late(id, k, now, unix);
                }
                continue;
            }
            if f.decided.is_some_and(|t| now >= t + LATE_FOR) {
                self.end_first(id);
            }
        }
    }

    /// Whether servers' reply budgets under our tag are being spent by others: [`STRAYS_MAX`] strays in the last
    /// [`STRAY_FOR`]. A first lookup then decides nothing (final review, finding 2): what it heard may be what the
    /// spending left, an impostor alone or a forged none.
    fn interfered(&mut self, now: Instant) -> bool {
        while (self.strays.front()).is_some_and(|t| now.saturating_duration_since(*t) >= STRAY_FOR)
        {
            self.strays.pop_front();
        }
        self.strays.len() >= STRAYS_MAX
    }

    /// Nobody replied through the last round. The room replied lately, or "who serves?" found servers lately: its
    /// servers' reply budgets were spent (its own load, or a guest asking many names at once), and the query gets the
    /// resolver's SERVFAIL; the next asks again. Else SERVFAIL at once, and "who serves?" is asked (it names no name,
    /// and servers answer it from a budget of their own): nobody within 2.5 s is nobody serves
    /// ([`Member::nobody_answered`]: NXDOMAIN for 30 s doubling, the queries waiting too); servers that answer keep
    /// the silences SERVFAIL for [`HEARD_FOR`].
    fn silence(&mut self, id: [u8; 32], now: Instant) {
        self.end_first(id);
        if self.interfered(now) {
            return self.log("no reply to an ask, while our replies are spent by others".into());
        }
        if self.nobody.is_some_and(|(t, _)| t > now) {
            return; // "who serves?" found nobody meanwhile: the queries waiting get NXDOMAIN
        }
        let lately =
            |t: Option<Instant>| t.is_some_and(|t| now.saturating_duration_since(t) < HEARD_FOR);
        if lately(self.heard) {
            return self.log("no reply to an ask, from a room that replied lately".into());
        }
        if lately(self.served) || !self.servers.is_empty() {
            return self
                .log("no reply to an ask, from a room whose servers answered lately".into());
        }
        // NAMES2 loop 5b: N6a's joiners, never having heard the room, took a silence its own load made for "nobody
        // serves" (30 of 500; 20 still when only the second silence was): SERVFAIL at once, and "who serves?" decides.
        self.servfail
            .retain(|_, t| now.saturating_duration_since(*t) < SERVFAIL_FOR);
        self.servfail.insert(id, now);
        self.probe = true;
        self.dispatch(now);
        self.log(
            "no reply to an ask, from a room not heard lately: SERVFAIL; asking who serves".into(),
        );
    }

    fn end_first(&mut self, id: [u8; 32]) {
        if let Some(f) = self.firsts.remove(&id) {
            self.ask_nonces.remove(&f.nonce);
            if let Some(d) = f.dissent {
                self.ask_nonces.remove(&d);
            }
            for k in (f.contest.iter()).flat_map(|c| c.flying.keys().chain(&c.fetched)) {
                self.forget_fetched(*k);
            }
        }
    }

    /// The decision: one owner key, that owner; only none, NXDOMAIN; more keys, or one shown only by items too big, a
    /// contest.
    fn decide_first(&mut self, id: [u8; 32], now: Instant, unix: u64) {
        if self.interfered(now) {
            self.log("a first lookup undecided: our replies are spent by others; asked again at the next query".into());
            return self.end_first(id);
        }
        let f = self.firsts.get_mut(&id).unwrap();
        f.decided = Some(now);
        // Where the room was found: the spread that brought one to eight replies, narrower past eight.
        self.spread = if f.share_count > REPLIES_FEW {
            (f.spread_at_first + 3).min(MAX_SPREAD)
        } else if f.share_count > 0 {
            f.spread_at_first
        } else {
            self.spread
        };
        // One key, and its zone came with an item: that owner. A key shown only "too big" has its zone fetched.
        match f.keys.len() {
            0 => self.none_known(id, now),
            1 if !f.zoned.is_empty() => self.decide_one(id, unix),
            _ => self.start_contest(id, now, unix),
        }
    }

    /// One owner key shown: its latest last entry is the owner (one key, one owner: no history needed).
    fn decide_one(&mut self, id: [u8; 32], unix: u64) {
        let f = &self.firsts[&id];
        let Some((s, zones)) = f.keys.values().next().cloned() else {
            return;
        };
        let mut n = Name::new(id);
        n.insert(s.clone());
        let Some(chain) = n.owner(&self.params, unix) else {
            return;
        };
        self.take(id, chain, s, zones, unix);
    }

    /// None, and no owner: NXDOMAIN for 60 s, doubling to 10 minutes while the name stays unknown.
    fn none_known(&mut self, id: [u8; 32], now: Instant) {
        let wait =
            (self.negative.get(&id)).map_or(NEGATIVE_FOR, |(_, w)| (*w * 2).min(NEGATIVE_MAX));
        if self.negative.len() >= MAX_NEGATIVE && !self.negative.contains_key(&id) {
            self.negative.pop_first();
        }
        self.negative.insert(id, (now + wait, wait));
    }

    /// A contest: every replier's `since` in order, each key's run fetched until the best is older than what's left.
    fn start_contest(&mut self, id: [u8; 32], now: Instant, unix: u64) {
        self.stats.contests += 1;
        let f = self.firsts.get_mut(&id).unwrap();
        f.contest = Some(Contest {
            until: now + CONTEST_FOR,
            flying: BTreeMap::new(),
            fetched: BTreeSet::new(),
            runs: VecDeque::new(),
            name: Name::new(id),
            zones: Vec::new(),
            best: BTreeMap::new(),
        });
        self.contest_step(id, now, unix);
    }

    /// The next fetches, or the contest's end: the best run checked older than every `since` left (a replier whose
    /// key already has a run as old as it claims can show nothing better, and is skipped), or [`CONTEST_FOR`] past.
    fn contest_step(&mut self, id: [u8; 32], now: Instant, unix: u64) {
        let Some(f) = self.firsts.get_mut(&id) else {
            return;
        };
        let Some(c) = f.contest.as_mut() else { return };
        let best = c.name.owner(&self.params, unix);
        let mut left: Vec<Replier> = (f.repliers.iter())
            .filter(|r| {
                !c.fetched.contains(&r.server)
                    && !c.flying.contains_key(&r.server)
                    && c.best.get(&r.key).is_none_or(|b| *b > r.since)
            })
            .copied()
            .collect();
        left.sort_by_key(|r| (r.since, r.server));
        let older = |b: &Option<Chain>, since: u32| b.as_ref().is_some_and(|b| b.seniority < since);
        let mut fetch = Vec::new();
        let mut rest = left.iter().peekable();
        while c.flying.len() + fetch.len() < FETCHES_AT_ONCE
            && let Some(r) = rest.next_if(|r| !older(&best, r.since))
        {
            if !fetch.contains(&r.server) {
                fetch.push(r.server); // a server that replied twice (a share and a dissent) is fetched once
            }
        }
        let timed_out = now >= c.until;
        let done = timed_out
            || fetch.is_empty()
                && c.flying.is_empty()
                && c.runs.is_empty()
                && rest.peek().is_none_or(|r| older(&best, r.since));
        if timed_out {
            fetch.clear();
        }
        for k in &fetch {
            c.flying.insert(*k, None);
        }
        for k in fetch {
            let nonce = random();
            self.send_ask(
                nonce,
                id,
                AskMode::Fetch,
                0,
                k[..8].try_into().unwrap(),
                now,
            );
        }
        if !done {
            return;
        }
        let f = self.firsts.get_mut(&id).unwrap();
        let c = f.contest.take().unwrap();
        f.decided.get_or_insert(now);
        for k in c.fetched.iter().chain(c.flying.keys()) {
            self.forget_fetched(*k);
        }
        if self.interfered(now) {
            self.log("a contest undecided: our replies are spent by others".into());
            return self.end_first(id);
        }
        let f = &self.firsts[&id];
        let Some(owner) = best else {
            self.log("a contest without a run that held: asked again at the next query".into());
            return self.end_first(id);
        };
        // Every key shown is settled: its run checked, or each of its repliers claims a run younger than the best
        // (one that can't win unless it lied, to its own loss). A key whose repliers were never fetched (they didn't
        // answer, or the time ran out) decides nothing: no answer, rather than another owner's.
        let settled = f.keys.keys().all(|k| {
            c.best.contains_key(k)
                || (f.repliers.iter())
                    .filter(|r| r.key == *k)
                    .all(|r| owner.seniority < r.since)
        });
        if !settled {
            self.log(format!(
                "a contest {}: a key shown without its run checked; asked again at the next query",
                if timed_out { "out of time" } else { "over" }
            ));
            return self.end_first(id);
        }
        let last = c.name.get(&owner.last()).unwrap().clone();
        let mut zones = c.zones;
        zones.extend(
            f.keys
                .get(&owner.owner)
                .into_iter()
                .flat_map(|(_, z)| z.clone()),
        );
        self.take(id, owner, last, zones, unix);
    }

    /// A fetched run came (a `fetch`'s answer: `Items` on a session the server opened). Each item goes to the contest
    /// of its own id that waits on this server (review 3, finding 3: a server fetched by two contests answers each in
    /// a transfer of its own, so the first contest waiting mustn't take the other's run); the session is let go once
    /// no contest waits on it.
    fn on_fetched(&mut self, from: [u8; 32], items: Vec<Item>, now: Instant, unix: u64) {
        let mut any = false;
        for it in items {
            let Some(c) = (self.firsts.get_mut(&it.id))
                .and_then(|f| f.contest.as_mut())
                .filter(|c| c.flying.contains_key(&from))
            else {
                continue;
            };
            any = true;
            c.flying.remove(&from);
            c.fetched.insert(from);
            if !it.entries.is_empty() {
                let mut seen = BTreeSet::new();
                let entries = (it.entries.into_iter())
                    .filter(|w| seen.insert(w.entry.id()))
                    .collect();
                c.runs.push_back(Check {
                    server: from,
                    entries,
                    zone: it.zone,
                    name: Name::new(it.id),
                    last: None,
                });
            }
        }
        if !any && self.fetch_waited(&from) {
            return; // nothing for a contest waiting on it: what it waits for comes in a transfer of its own
        }
        self.forget_fetched(from);
        self.check_replies(now, unix);
    }

    /// Whether a contest still waits on a fetch from `k`.
    fn fetch_waited(&self, k: &[u8; 32]) -> bool {
        (self.firsts.values())
            .filter_map(|f| f.contest.as_ref())
            .any(|c| c.flying.contains_key(k))
    }

    /// A fetched server's session let go, unless a contest still waits on it or it is a server held.
    fn forget_fetched(&mut self, k: [u8; 32]) {
        if !self.fetch_waited(&k) && !self.servers.contains(&k) {
            self.cmds.push_back(Cmd::Forget(k));
        }
    }

    /// A fetched run checked: its chain (ending at its last entry, covering now) joins the contest.
    fn run_checked(&mut self, id: [u8; 32], run: Check, unix: u64) {
        let f = self.firsts.get_mut(&id).unwrap();
        let c = f.contest.as_mut().unwrap();
        let Some(last) = run.last else { return };
        let Some(chain) = (run.name.chains(&self.params).into_iter())
            .find(|ch| ch.last() == last && ch.covers(unix))
        else {
            return;
        };
        let b = c.best.entry(chain.owner).or_insert(chain.seniority);
        *b = (*b).min(chain.seniority);
        for e in run.name.entries().filter(|e| chain.ids.contains(&e.id())) {
            c.name.insert(e.clone());
        }
        if let Some(z) = run.zone
            && z.name == id
            && z.owner == chain.owner
            && z.verify(&self.names)
        {
            c.zones.push(z);
        }
    }

    /// A fetch's server went (its session): every contest waiting on it goes on without it.
    fn fetch_gone(&mut self, k: &[u8; 32], now: Instant, unix: u64) {
        let ids: Vec<[u8; 32]> = (self.firsts.iter_mut())
            .filter_map(|(id, f)| {
                let c = f.contest.as_mut()?;
                c.flying.remove(k)?;
                c.fetched.insert(*k);
                Some(*id)
            })
            .collect();
        for id in ids {
            self.contest_step(id, now, unix);
        }
    }

    /// One contest's wait for a fetch from `k` ran out: it goes on without it (another contest's wait is its own).
    fn fetch_late(&mut self, id: [u8; 32], k: [u8; 32], now: Instant, unix: u64) {
        if let Some(c) = self.firsts.get_mut(&id).and_then(|f| f.contest.as_mut())
            && c.flying.remove(&k).is_some()
        {
            c.fetched.insert(k);
            self.forget_fetched(k);
            self.contest_step(id, now, unix);
        }
    }
}

/// A replier added to a first lookup's: once a server and key (the lower `since`), and [`REPLIERS_A_KEY`] of a key at
/// most, those with the earliest `since` (a replier past them, claiming a later run, could show nothing better).
fn add_replier(rs: &mut Vec<Replier>, r: Replier) {
    if let Some(x) = rs
        .iter_mut()
        .find(|x| x.server == r.server && x.key == r.key)
    {
        x.since = x.since.min(r.since);
        return;
    }
    let of_key = || rs.iter().enumerate().filter(|(_, x)| x.key == r.key);
    if of_key().count() >= REPLIERS_A_KEY {
        let Some((worst, w)) = of_key().max_by_key(|(i, x)| (x.since, *i)) else {
            return;
        };
        if w.since <= r.since {
            return;
        }
        rs.remove(worst);
    }
    rs.push(r);
}

/// A member's stored record read back: the earliest time, whether it is a claim's, when it was checked, the item.
fn read_record(b: &[u8]) -> Option<(u32, bool, u64, Item)> {
    let mut r = Rd::new(b);
    if r.u8().ok()? != RECORD_VERSION {
        return None;
    }
    let earliest = r.u32().ok()?;
    let whole = match r.u8().ok()? {
        0 => false,
        1 => true,
        _ => return None,
    };
    let checked = r.u64().ok()?;
    Some((earliest, whole, checked, Item::decode(r.rest()).ok()?))
}
