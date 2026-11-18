//! A names client's registry side (room-names.md "The registry"), sans I/O: a server's store and
//! its exchanges, and the question that finds servers. The transport (a room client of its own
//! under a session key, relay only: room.rs) hands it questions and datagrams ([`Input`]) and
//! carries out what it says ([`Cmd`]).
//!
//! - **Asking** "who serves the registry?": shares of 1/64, then 1/8 after 0.4 s, then everyone
//!   after 1 s, stopping at the first round that brings an answer; 0.3 s after the first answer,
//!   the two servers with the lowest `BLAKE2s(nonce, server's key)`. Nobody within 2.5 s: remembered
//!   for 30 s, doubling to 10 minutes, reset by an answer; but a server that refused a question meanwhile for not
//!   being synced yet (another that started with it) asks again within 1.5 to 3 s. At most one question a second.
//! - **Answering**: when the server's hash falls in the share, it has synced, it holds fewer than
//!   [`MAX_ASKERS`] askers and its own budget ([`ANSWERS_PER_SECOND`], apart from the node's call
//!   backs and trials) allows: a call back, then `serve`, signed by a live name's owner key over
//!   the asker's nonce and this names client's key.
//! - **Sync**: with the two servers a question found, at the start and every 5 minutes with
//!   jitter: range fingerprints by id, 16 sub-ranges where they differ, a listing where a range is
//!   small; `get` with what is held, so only what's missing crosses; `have` for what the other
//!   lacks. A server answers questions only once its first sync is done (or nobody answered it). A run
//!   cut by [`RUN_MAX`] ends its round, and the next starts at once.
//! - **Verification** of everything taken, in slices of [`UNITS_PER_TURN`] a turn; what is stored
//!   was verified and is trusted at load.
//! - **The bound**: [`Config::max_names`] and bytes; past either, the names nobody asked for
//!   longest go first, never this node's own.
//! - **Outside the room** ([`outside`]): renewals pending at a calendar finished, each block the registry is anchored
//!   in checked at an explorer, through fetches the page makes ([`Cmd::Fetch`], [`Input::Fetched`]).

use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    time::{Duration, Instant},
};

use blake2::{Blake2s256, Digest};
use k256::schnorr::SigningKey;

#[path = "outside.rs"]
mod outside;
pub use outside::{BLOCK_RECORD, FETCH_WAIT};

use super::{
    Invalid, Params,
    chain::Name,
    entry::{Pow, Stamped, pending_ok, sign, tagged, verify},
    id::RoomNames,
    member::Answer,
    store::{Held, Registry, read_record, zone_tag},
    wire::{
        AskMode, GetMode, Item, Msg, NameAsk, Proof, Question, REPLY_MAX, Range, Reply, ReplyItem,
        SyncAnswer, Transfers, WireEntry, shown,
    },
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
/// A server whose question found nobody, but which refused a question meanwhile for not being synced yet, asks again
/// after this and as much again at random (two servers that started together: N0c's 30 s).
pub(super) const ASK_SOON: Duration = Duration::from_millis(1500);
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
/// An `ids` answer's cover ends are rounded up to this (seconds).
pub const IDS_UNTIL_STEP: u64 = 7 * 24 * 3600;
/// `ids` answered to one session at most (the dialog's checker asks once a press: a retry's room), and to everyone a
/// minute (final review, finding 7: answered to anyone as often as asked, 256 gets listed every id held).
pub const IDS_PER_SESSION: u32 = 2;
pub const IDS_PER_MINUTE: usize = 4;
const IDS_WINDOW: Duration = Duration::from_secs(60);
/// A server's replies to asks a second (room-names-r3.md): a budget of their own, apart from call backs and from answers
/// to "who serves?", so neither starves the other.
pub const REPLIES_PER_SECOND: usize = 2;
/// Replies under one reply tag (one asker's names key), a minute: a flood of forged asks naming one key reaches it
/// this often at most.
pub const REPLIES_PER_TAG: usize = 16;
const REPLIES_PER_TAG_WINDOW: Duration = Duration::from_secs(60);
/// Asks replied to lately, by nonce and asker key: an ask's rounds share a nonce, and a server in the first round's
/// share is in the next's too.
const REPLIED_KEPT: usize = 1024;
/// Answers to questions naming one key, a minute (an honest asker asks a question a second at most, and rarely).
pub const ANSWERS_PER_KEY: usize = 4;
const ANSWERS_PER_KEY_WINDOW: Duration = Duration::from_secs(60);
pub const SYNC_EVERY: Duration = Duration::from_secs(300);
const SYNC_JITTER_MS: u64 = 30_000;
/// A round whose runs brought names is followed by the next this soon (and up to a third more at random), at most
/// [`QUICK_ROUNDS`] in a row: servers that started together converge in a few of these, not in rounds of 5 minutes
/// (N6a: twenty servers held 3,100 to 3,700 of 5,000 names a minute in, then nothing until the next round).
pub const QUICK_ROUND: Duration = Duration::from_secs(30);
pub const QUICK_ROUNDS: u32 = 8;
/// A range this small (on the answering side) is listed.
pub const LIST_MAX: u32 = 64;
/// Sync requests in flight to one partner: a first sync's rate is these over the round trip (NAMES loop 6b: 4 moved
/// 0.72 Mbit/s over 95 ms, 8 with a window of 16 parts 1.44).
const SYNC_PARALLEL: usize = 8;
/// A `have` names at most this many ids (a run tells 32 at a time), and what `have`s make us ask a peer waits at most
/// this many at once.
const HAVE_MAX: usize = 32;
const HAVE_GETS: usize = 64;
/// Items taken from one peer's `get` answers waiting to be verified at most, and from every peer, by count and bytes
/// (review 3, finding 4): past them its `have`s ask nothing and its run's `get`s wait.
pub const JOBS_PER_PEER: usize = 256;
pub const JOBS_MAX: usize = 4096;
pub const JOB_BYTES_PER_PEER: usize = 4 << 20;
pub const JOB_BYTES_MAX: usize = 32 << 20;
/// `put`s waiting to be verified: a peer's, and everyone's.
const PUTS_PER_PEER: usize = 4;
const PUTS_MAX: usize = 64;
/// Entry ids remembered as refused.
const REFUSED_KEPT: usize = 4096;
/// Entries remembered as verified (~300 bytes each, ~5 MB).
const VERIFIED_KEPT: usize = 16_384;
/// Entries of one job signed again over the same fields as one it checked (only the owner's key makes them) are
/// skipped, a unit for this many.
const SIGNED_AGAIN_A_UNIT: u32 = 16;
/// The most `sync`s a run sends: a registry of 20,000 names each differing takes ~4,400 (1 + 16 + 256 + 4,096 ranges).
pub const MAX_RUN_SYNCS: usize = 8192;
/// A run's longest time (review 2: a partner answering each request just before it times out could stretch a run's
/// 8,192 requests to hours, the new server answering nobody meanwhile): under a round's 5 minutes, so one round's
/// run never meets the next's.
pub const RUN_MAX: Duration = Duration::from_secs(240);
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
    /// The page's answer to [`Cmd::Fetch`] `id`: the HTTP status (0: no answer, the fetch failed) and the body.
    Fetched { id: u32, status: u16, body: Vec<u8> },
    /// An ask under the names tag (a server's), opened and checked as a question is; `region` the link's index of the
    /// asker's region, for a `fetch`'s call back (None: a region outside the link); `via` the event's mark, which the
    /// reply names so the transport sends it through the relays that brought the ask.
    Ask {
        ask: NameAsk,
        region: Option<usize>,
        via: [u8; 16],
    },
    /// A reply under our reply tag (a member's), opened.
    Reply(Reply),
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
    Served([u8; 32], u128),
    Send {
        to: [u8; 32],
        data: Vec<u8>,
    },
    Forget([u8; 32]),
    /// Subscribe to the names tag (a server) or not.
    Subscribe(bool),
    /// Subscribe to our reply tag (a member: room-names-r3.md) or not.
    Replies(bool),
    /// An ask under the names tag of the hour (a member's first lookup).
    Ask {
        nonce: [u8; 16],
        id: [u8; 32],
        mode: AskMode,
        spread: u8,
        shown: [u8; 8],
    },
    /// A reply (encoded) to the ask marked `via`, under the reply tag of names key `to`.
    Reply {
        to: [u8; 32],
        via: [u8; 16],
        data: Vec<u8>,
    },
    /// Let in handshakes from these keys only (the servers a member sent `fetch` to) until `until`.
    AcceptFrom {
        keys: Vec<[u8; 32]>,
        until: Instant,
    },
    /// GET `url` (a compiled calendar's or explorer's, never one from a record: [`outside`]); the answer comes back as
    /// [`Input::Fetched`] with this `id`. Only a server asks: a member asks nothing outside the room.
    Fetch {
        id: u32,
        url: String,
    },
    /// Store a name's record (None: delete it); a block's check, under the block's hash ([`BLOCK_RECORD`]).
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
    /// Who came in and when, and its answer's [`rank`] key once its `serve` held.
    admitted: Vec<([u8; 32], Instant, Option<u128>)>,
    /// Keys let in by name until a time, apart from the question's places: the servers a member's `fetch` asked
    /// (room-names-r3.md), and nobody else.
    only: Vec<[u8; 32]>,
    only_until: Option<Instant>,
}

impl AcceptWindow {
    pub fn open(&mut self, until: Instant, max: usize) {
        self.until = Some(until);
        self.max = max;
        self.admitted.clear();
    }

    /// Whom to let go for a newcomer: the oldest key let in that never served and has had [`ACCEPT_GRACE`] to; else,
    /// of those that served, the last by [`rank`] but the best two (cheap registrations answering first mustn't fill
    /// every place: review 2).
    fn evictable(&self, now: Instant) -> Option<usize> {
        let idle = (self.admitted.iter().enumerate())
            .filter(|(_, (_, at, served))| {
                served.is_none() && now.saturating_duration_since(*at) >= ACCEPT_GRACE
            })
            .min_by_key(|(_, (_, at, _))| *at)
            .map(|(i, _)| i);
        let mut served: Vec<(u128, usize)> = (self.admitted.iter().enumerate())
            .filter_map(|(i, a)| a.2.map(|r| (r, i)))
            .collect();
        served.sort();
        idle.or_else(|| (served.len() > 2).then(|| served.last().unwrap().1))
    }

    /// Whether a handshake from a key we don't know may come in now: the window is open, and it has room or holds a
    /// key that came in a while ago and never served (junk, which then makes room: a fixed number of places taken
    /// first come would let anyone who reads the question shut every server out), or a served one ranked below the
    /// best two.
    /// Keys named by [`AcceptWindow::open_for`] come in while it lasts.
    pub fn room(&self, key: &[u8; 32], now: Instant) -> bool {
        if self.named(key, now) {
            return true;
        }
        self.until.is_some_and(|u| now < u)
            && (self.admitted.len() < self.max || self.evictable(now).is_some())
    }

    fn named(&self, key: &[u8; 32], now: Instant) -> bool {
        self.only_until.is_some_and(|u| now < u) && self.only.contains(key)
    }

    /// Lets in handshakes from `keys` only, until `until` (replacing the last such list): a member's fetches.
    pub fn open_for(&mut self, keys: Vec<[u8; 32]>, until: Instant) {
        self.only = keys;
        self.only_until = Some(until);
    }

    /// `key`'s handshake came in (after [`AcceptWindow::room`]): the key let go to make room for it, if any.
    pub fn admit(&mut self, key: [u8; 32], now: Instant) -> Option<[u8; 32]> {
        if self.named(&key, now) {
            return None;
        }
        let gone = if self.admitted.len() >= self.max {
            self.evictable(now).map(|i| self.admitted.remove(i).0)
        } else {
            None
        };
        self.admitted.push((key, now, None));
        gone
    }

    /// `key`'s `serve` held, its [`rank`] key `c`.
    pub fn served(&mut self, key: &[u8; 32], c: u128) {
        for a in &mut self.admitted {
            if a.0 == *key {
                a.2 = Some(c);
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

/// An answer's rank (lower is better): the share hash's top 64 bits. A server answers a round when its rank falls in the
/// share, and an asker keeps the two lowest: the plain draw (R3 took N5a's tiers of a chain's age out: a first lookup
/// asks the room and believes what is shown for its content, docs/plans/room-names-r3.md), used now only for what must
/// not name an id: the dialog's check, puts, sync partners, the refresh of kept names.
pub fn rank(h: &[u8; 32]) -> u128 {
    u64::from_be_bytes(h[..8].try_into().unwrap()) as u128
}

/// Whether an answer of rank `r` falls in the share `spread` names (0: everyone, whatever the rank).
pub fn in_share(r: u128, spread: u8) -> bool {
    spread == 0 || r >> (64 - spread.min(63) as u32) == 0
}

/// What a server signs to prove to server `to` that it, names client `from`, holds a live name (a run's first `sync`).
pub fn peer_hash(names: &RoomNames, to: &[u8; 32], from: &[u8; 32]) -> [u8; 32] {
    tagged("waarm64/names/peer", &[&names.value, to, from])
}

fn serve_hash(names: &RoomNames, nonce: &[u8; 16], server: &[u8; 32]) -> [u8; 32] {
    tagged("waarm64/names/serve", &[&names.value, nonce, server])
}

/// Whether `serve` (a [`Msg::Serve`] from the server with key `server`) answers our question
/// `nonce`: one entry of a live name (checked whole: signature, proof of work, its header and anchor; its chain
/// covering now) whose owner key signed the nonce and the server's key. The name's owner key and id.
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
        entries,
        sig,
    } = serve
    else {
        return Err(Invalid::Encoding);
    };
    if n != nonce {
        return Err(Invalid::Signature);
    }
    let [entry] = &entries[..] else {
        return Err(Invalid::Encoding);
    };
    // The signature first: it is cheap, the proof of work isn't.
    if !verify(&entry.entry.owner, &serve_hash(names, nonce, server), sig) {
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
    let mut s = Stamped::check(entry.entry.clone(), names, pow)?;
    let Some((a, h)) = entry.anchor.clone() else {
        return Err(Invalid::AnchorRoot);
    };
    s.offer_anchor(a, h, params, unix)?;
    let mut n = Name::new(s.entry.name);
    let owner = s.entry.owner;
    n.insert(s);
    if !n.chains(params).iter().any(|c| c.covers(unix)) {
        return Err(Invalid::Dead);
    }
    if !verify(&owner, msg, sig) {
        return Err(Invalid::Signature);
    }
    Ok((owner, n.id))
}

/// An answer to a question: its [`rank`] key, the owner key it served with, the name id.
pub(super) type Answered = (u128, [u8; 32], [u8; 32]);

/// A question of ours (a server's or a member's).
pub(super) struct Ask {
    pub nonce: [u8; 16],
    pub started: Instant,
    /// Rounds sent.
    pub round: usize,
    pub first: Option<Instant>,
    /// Servers whose `serve` held, by their names client's key: the answer's [`rank`] key, the owner key it served
    /// with and the name id.
    pub answers: BTreeMap<[u8; 32], Answered>,
    /// A server's: it refused a question meanwhile for not being synced yet (another new server's, perhaps).
    pub heard_unsynced: bool,
}

impl Ask {
    pub fn new(nonce: [u8; 16], now: Instant) -> Ask {
        Ask {
            nonce,
            started: now,
            round: 1,
            first: None,
            answers: BTreeMap::new(),
            heard_unsynced: false,
        }
    }

    /// Whether a `serve` with owner key `owner` on name `name` would be one more answer (a registration answering from
    /// many keys is one answer): asked before its check.
    pub fn new_name(&self, owner: &[u8; 32], name: &[u8; 32]) -> bool {
        !(self.answers.values()).any(|(_, o, n)| o == owner || n == name)
    }

    /// A `serve` from `from` that held, with owner key `owner` on name `name`: counted when its rank is in the share
    /// of a round sent (an honest server answers only so), and once a name. Its [`rank`].
    pub fn offer(
        &mut self,
        from: [u8; 32],
        owner: [u8; 32],
        name: [u8; 32],
        now: Instant,
    ) -> Result<u128, &'static str> {
        let c = rank(&share_hash(&self.nonce, &owner));
        let spread = SPREADS[self.round.clamp(1, SPREADS.len()) - 1];
        if !in_share(c, spread) {
            return Err("outside the share asked");
        }
        if !self.new_name(&owner, &name) {
            return Err("a name that answered already");
        }
        self.answers.insert(from, (c, owner, name));
        self.first.get_or_insert(now);
        Ok(c)
    }

    /// The two answers first by [`rank`] (not the fastest, which an attacker could always be), and the others.
    pub fn choose(&self) -> (Vec<[u8; 32]>, Vec<[u8; 32]>) {
        let mut by: Vec<(u128, [u8; 32])> = self.answers.iter().map(|(k, a)| (a.0, *k)).collect();
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
    /// A `get`, part of a sync run with that peer or not, and the id (or 8-byte prefix) it asks for.
    Get(bool, Vec<u8>),
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
    /// When it started: a run ends [`RUN_MAX`] after, whatever is left (the next round goes on from what came).
    started: Option<Instant>,
}

/// Something taken to be verified: where it came from, the item, how far it got.
struct Job {
    /// The peer and the transfer to answer (a `put`), or just the peer it came from.
    from: Option<([u8; 32], Option<u32>)>,
    item: Item,
    next: usize,
    checked: Vec<Stamped>,
    /// The work keys of the entries checked, and their ids: another entry over the same fields (signed again) is
    /// skipped (final review, finding 1); how many were.
    bodies: BTreeMap<[u8; 32], [u8; 32]>,
    again: u32,
    zone_checked: bool,
    /// An entry of it failed a check only a forgery fails: nothing of it is kept.
    forged: bool,
    /// The item's size, as it came.
    bytes: usize,
}

impl Job {
    fn new(from: Option<([u8; 32], Option<u32>)>, item: Item) -> Job {
        Job {
            from,
            bytes: item.encode().len(),
            item,
            next: 0,
            checked: Vec::new(),
            bodies: BTreeMap::new(),
            again: 0,
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
    /// Answers lately by the key a question named: a question's key proves nothing, so a key is called back
    /// [`ANSWERS_PER_KEY`] times a minute at most (review 2: questions naming a victim's key).
    answered_keys: BTreeMap<[u8; 32], VecDeque<Instant>>,
    askers: BTreeMap<[u8; 32], Asker>,
    /// Replies to asks lately: every one ([`REPLIES_PER_SECOND`]), by reply tag ([`REPLIES_PER_TAG`]), by nonce and
    /// asker key.
    replies: VecDeque<Instant>,
    reply_tags: BTreeMap<[u8; 32], VecDeque<Instant>>,
    replied: BTreeSet<([u8; 16], [u8; 32])>,
    replied_order: VecDeque<([u8; 16], [u8; 32])>,
    /// The largest item a reply carries (the tests' lower it): [`REPLY_MAX`].
    pub reply_max: usize,
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
    /// Entries checked whole lately (signature, proof of work), without their anchors, by their work key
    /// ([`super::entry::Entry::work_key`]): a valid entry put again (a dead chain's, say) costs only its anchor's check
    /// (review 2), and the same fields signed again only a signature's check, taking no place of their own (final
    /// review, finding 1: by id, each signing took one and flushed the rest).
    verified: BTreeMap<[u8; 32], Stamped>,
    verified_order: VecDeque<[u8; 32]>,
    /// Peers that proved a live name: the servers our questions chose, and those whose `sync` carried a proof.
    proven: BTreeSet<[u8; 32]>,
    /// Peers whose proof was checked this session.
    proof_tried: BTreeSet<[u8; 32]>,
    /// `ids` answered: to each peer this session, and to everyone lately ([`IDS_PER_SESSION`], [`IDS_PER_MINUTE`]).
    ids_asked: BTreeMap<[u8; 32], u32>,
    ids_answered: VecDeque<Instant>,
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
    /// Names the round's sync changed (from its runs and `have`s), and the quick rounds in a row so far.
    round_brought: usize,
    quick: u32,
    /// What it asks outside the room: blocks checked, renewals finished ([`outside`]).
    out: outside::Outside,
    /// The tests' lying server: names it never keeps (so never lists or serves).
    #[cfg(test)]
    pub refuse: BTreeSet<[u8; 32]>,
    /// The tests' liar about `since` (a reply's claim of how old its chain is).
    #[cfg(test)]
    pub lie_since: Option<u32>,
}

#[derive(Debug, Default, Clone)]
pub struct Stats {
    /// Fetches asked of the page: calendars, explorers ([`outside`]).
    pub fetches: usize,
    /// Renewals this server finished; blocks it checked, and refused.
    pub finished: usize,
    pub blocks_checked: usize,
    pub blocks_refused: usize,
    pub answered: usize,
    pub refused: usize,
    /// Replies to asks sent (with an item or none), and asks left unreplied for a budget.
    pub replied: usize,
    pub replies_refused: usize,
    /// `fetch`es answered (a call back and the run).
    pub fetched: usize,
    pub rounds: usize,
    pub syncs: usize,
    /// Entries checked whole (their signature, and their proof of work unless the same fields held lately).
    pub checked: usize,
    /// Proofs of work computed (Argon2id runs).
    pub work: u64,
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
            answered_keys: BTreeMap::new(),
            askers: BTreeMap::new(),
            replies: VecDeque::new(),
            reply_tags: BTreeMap::new(),
            replied: BTreeSet::new(),
            replied_order: VecDeque::new(),
            reply_max: REPLY_MAX,
            deferred: Vec::new(),
            synced: false,
            next_round: None,
            runs: BTreeMap::new(),
            synced_with: BTreeMap::new(),
            jobs: VecDeque::new(),
            puts: VecDeque::new(),
            refused: BTreeSet::new(),
            refused_order: VecDeque::new(),
            verified: BTreeMap::new(),
            verified_order: VecDeque::new(),
            proven: BTreeSet::new(),
            proof_tried: BTreeSet::new(),
            ids_asked: BTreeMap::new(),
            ids_answered: VecDeque::new(),
            sync_spent: BTreeMap::new(),
            dropped: BTreeMap::new(),
            settle_at: None,
            cmds: VecDeque::new(),
            put_answers: Vec::new(),
            stats: Stats::default(),
            now: Instant::now(),
            last_unix: unix,
            round_over: false,
            round_brought: 0,
            quick: 0,
            out: outside::Outside::default(),
            #[cfg(test)]
            refuse: BTreeSet::new(),
            #[cfg(test)]
            lie_since: None,
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
            let pk: [u8; 32] = key.verifying_key().to_bytes().into();
            // Verified as anything from outside is, now (a title is a few entries), and before it counts as this node's
            // own: it may have come in a pasted export, which anyone can craft (review 2). A title is its key's claim
            // and what follows it, and that key's zone of its name: one with no entries, another key's entry or zone,
            // or one that doesn't hold is refused whole (final review, finding 6: it answered the resolver from its
            // zone, unchecked, while the registry didn't resolve the name). Entries held already, or checked lately,
            // cost nothing.
            let theirs = t.item.entries.is_empty()
                || t.item.entries.iter().any(|w| w.entry.owner != pk)
                || (t.item.zone.as_ref())
                    .is_some_and(|z| z.owner != pk || z.name != id || !z.verify(&self.names));
            if theirs {
                self.log("a title refused: not its key's".into());
                continue;
            }
            let mut job = Job::new(None, t.item);
            while !job.forged && job.next < job.item.entries.len() {
                let w = job.item.entries[job.next].clone();
                job.next += 1;
                self.check_entry(&mut job, w, unix);
            }
            if job.forged {
                self.log("a title refused: an entry doesn't hold".into());
                continue;
            }
            self.titles.push((key, id));
            self.own.insert(id);
            let zone = job.item.zone.take();
            if let Some(z) = zone.clone() {
                self.title_zones.insert(id, z);
            }
            let mut h = self.reg.take(&id).unwrap_or_else(|| Held::new(id, unix));
            h.asked = h.asked.max(unix);
            for e in job.checked {
                h.name.insert(e);
            }
            h.settle(&self.params, unix);
            if let Some(z) = zone {
                h.offer_zone(z, unix, false);
                h.settle(&self.params, unix);
            }
            if !h.is_empty() {
                self.reg.put(h);
                self.note(&id, unix);
            }
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

    /// Whether it runs (started with its names client's key, not stopped since).
    pub fn running(&self) -> bool {
        self.key.is_some()
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
        self.ids_asked.clear();
        self.sync_spent.clear();
        self.out.stop();
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
        if record.first() == Some(&BLOCK_RECORD) {
            return self.load_block(record, unix);
        }
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
                let mut s = e.trusted();
                if s.anchor()
                    .is_some_and(|a| self.out.refused(&a.header.hash()))
                {
                    s.drop_anchor();
                }
                h.name.insert(s);
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
            self.note(&id, asked.min(unix));
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
            self.runs
                .values()
                .filter_map(|r| r.started)
                .min()
                .map(|t| t + RUN_MAX),
            jobs,
            self.outside_deadline(),
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
        self.outside_tick(now, unix);
        let long: Vec<[u8; 32]> = (self.runs.iter())
            .filter(|(_, r)| r.started.is_some_and(|t| now >= t + RUN_MAX))
            .map(|(k, _)| *k)
            .collect();
        let cut = !long.is_empty();
        for k in long {
            self.end_run(k, "a run past its time");
        }
        // A run cut by its time (not by a breach) goes on in a round that starts at once: what's held counts as synced
        // (review 2: a slow partner mustn't keep a new server silent), and the round's `get`s ask only what's missing
        // (N0c: 50 MB waited ~100 s for the next round at the round's 5 minutes).
        if cut && self.runs.is_empty() && self.ask.is_none() {
            self.next_round = Some(now);
        }
        // Runs whose `get`s waited for room in the queue.
        let waiting: Vec<[u8; 32]> = (self.runs.iter())
            .filter(|(_, r)| r.outstanding == 0 && !r.gets.is_empty())
            .map(|(k, _)| *k)
            .collect();
        for k in waiting {
            if self.job_room(&k) > 0 {
                self.run_step(k, now);
            }
        }
        if self.round_over && self.jobs.is_empty() {
            self.round_over = false;
            if !self.synced {
                self.log("synced: answering questions".into());
            }
            self.synced = true;
            // A round that brought names: the next soon, while there is more to find (a few in a row at most).
            if self.round_brought > 0 && self.quick < QUICK_ROUNDS {
                self.quick += 1;
                let jitter =
                    u64::from_le_bytes(random()) % (QUICK_ROUND.as_millis() as u64 / 3 + 1);
                let soon = now + QUICK_ROUND + Duration::from_millis(jitter);
                self.next_round = Some(self.next_round.map_or(soon, |t| t.min(soon)));
            } else if self.round_brought == 0 {
                self.quick = 0;
            }
            self.round_brought = 0;
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
            self.outside_scan(unix);
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
        let heard = self.ask.take().is_some_and(|a| a.heard_unsynced);
        self.out.heard(0, 0);
        if heard {
            // Someone asked while we weren't synced, and we refused it as it may have refused us: two servers that
            // started together. Both serve now; the next question, within seconds, finds the other (N0c: 30 s).
            let soon = ASK_SOON
                + Duration::from_millis(
                    u64::from_le_bytes(random()) % (ASK_SOON.as_millis() as u64 + 1),
                );
            self.log(format!(
                "nobody answered, but someone asked meanwhile; asking again in {} ms",
                soon.as_millis()
            ));
            self.synced = true;
            self.next_round = Some(now + soon);
            return;
        }
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
        if let Msg::Serve { entries, .. } = &m
            && let Some(e) = entries.first()
            && !a.new_name(&e.entry.owner, &e.entry.name)
        {
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
                self.log(format!("a serve refused: {e:?}"));
                return self.cmds.push_back(Cmd::Forget(from));
            }
        };
        match self.ask.as_mut().unwrap().offer(from, owner, name, now) {
            Ok(c) => self.cmds.push_back(Cmd::Served(from, c)),
            Err(why) => {
                self.log(format!("a serve refused: {why}"));
                self.cmds.push_back(Cmd::Forget(from));
            }
        }
    }

    /// The two answers with the lowest hash are kept (not the fastest, which an attacker could
    /// always be); the others are let go. A server syncs with both.
    fn choose(&mut self, now: Instant, _unix: u64) {
        let a = self.ask.take().unwrap();
        self.nobody = None;
        self.out.heard(
            a.answers.len(),
            SPREADS[a.round.clamp(1, SPREADS.len()) - 1],
        );
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

    /// Whether we would answer a question with `nonce` and `spread` now with a live name whose answer's rank is `r`
    /// (the share, synced, the budget): the answer rule. With every asker's place taken, the one held longest makes
    /// room.
    fn answers_rule(&mut self, q: &Question, r: u128, now: Instant) -> Result<(), &'static str> {
        if self.key.is_none() {
            return Err("not running");
        }
        if !in_share(r, q.spread) {
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

    /// The live names of ours to serve with: each one's key and its owning chain's last entry.
    fn live_titles(&self, unix: u64) -> Vec<(SigningKey, WireEntry)> {
        (self.titles.iter())
            .filter_map(|(k, id)| {
                let h = self.reg.get(id)?;
                let o = h.owner.as_ref()?;
                let pk: [u8; 32] = k.verifying_key().to_bytes().into();
                if o.owner != pk || !o.covers(unix) {
                    return None;
                }
                Some((k.clone(), WireEntry::of(h.name.get(&o.last())?)))
            })
            .collect()
    }

    /// The live name of ours whose answer ranks lowest for `nonce`, and that rank.
    fn live_title(&self, nonce: &[u8; 16], unix: u64) -> Option<(SigningKey, WireEntry, u128)> {
        (self.live_titles(unix).into_iter())
            .map(|(k, e)| {
                let r = rank(&share_hash(nonce, &e.entry.owner));
                (k, e, r)
            })
            .min_by_key(|x| x.2)
    }

    fn on_question(&mut self, q: Question, region: usize, now: Instant, unix: u64) {
        let Some((k, entry, r)) = self.live_title(&q.nonce, unix) else {
            self.stats.refused += 1;
            return;
        };
        if let Err(why) = self.answers_rule(&q, r, now) {
            if why != "outside the share" {
                self.stats.refused += 1;
            }
            // Another server (or a member) asking while our own first question is open: if ours finds nobody, it may
            // be that one, refused here as we were there; ask again soon, not after `NOBODY_FIRST`.
            if why == "not synced yet"
                && let Some(a) = &mut self.ask
            {
                a.heard_unsynced = true;
            }
            return;
        }
        if !self.key_allows(&q.key, now) || !self.asker_room(&q.key) {
            self.stats.refused += 1;
            return;
        }
        self.answers.push_back(now);
        self.stats.answered += 1;
        let me = self.key.unwrap();
        let sig = sign(&k, &serve_hash(&self.names, &q.nonce, &me));
        self.hold_asker(q.key, now);
        if self.ask.is_some() && me > q.key {
            self.deferred.push((now + CROSSED_WAIT, q.key, region));
        } else {
            self.cmds.push_back(Cmd::CallBack { key: q.key, region });
        }
        let m = Msg::Serve {
            nonce: q.nonce,
            entries: vec![entry],
            sig,
        };
        self.xf.send(q.key, &m.encode(0), now);
        self.flush();
    }

    /// Whether a call back to `key` (named by a question or a `fetch`, which prove nothing of it) is within
    /// [`ANSWERS_PER_KEY`] a minute; counted when it is.
    fn key_allows(&mut self, key: &[u8; 32], now: Instant) -> bool {
        self.answered_keys.retain(|_, w| {
            w.back()
                .is_some_and(|t| now.saturating_duration_since(*t) < ANSWERS_PER_KEY_WINDOW)
        });
        let w = self.answered_keys.entry(*key).or_default();
        while w
            .front()
            .is_some_and(|t| now.saturating_duration_since(*t) >= ANSWERS_PER_KEY_WINDOW)
        {
            w.pop_front();
        }
        if w.len() >= ANSWERS_PER_KEY {
            return false;
        }
        w.push_back(now);
        true
    }

    /// Whether `key` may be held as an asker: with every place taken, the one held longest goes (junk can't keep them
    /// all for good), but never a sync partner of this round.
    fn asker_room(&mut self, key: &[u8; 32]) -> bool {
        if self.askers.len() >= MAX_ASKERS && !self.askers.contains_key(key) {
            let old = (self.askers.iter())
                .filter(|(k, _)| !self.runs.contains_key(*k))
                .min_by_key(|(_, a)| a.since)
                .map(|(k, _)| *k);
            let Some(old) = old else {
                return false;
            };
            self.askers.remove(&old);
            self.cmds.push_back(Cmd::Forget(old));
        }
        true
    }

    fn hold_asker(&mut self, key: [u8; 32], now: Instant) {
        self.askers
            .entry(key)
            .or_insert(Asker {
                since: now,
                active: now,
            })
            .active = now;
    }

    // ---- Asks (room-names-r3.md) ----

    /// An ask under the names tag: a `share` in our share, or a `dissent` where we hold another owner, is replied
    /// through the relays (its own budgets); a `fetch` naming us is called back and sent the owning chain's run.
    fn on_ask(
        &mut self,
        a: NameAsk,
        region: Option<usize>,
        via: [u8; 16],
        now: Instant,
        unix: u64,
    ) {
        let Some(me) = self.key else { return };
        if !self.synced || a.key == me {
            return;
        }
        match a.mode {
            AskMode::Share => {
                // The share is ours to keep (the reply proves nothing): one draw a server, however many names it
                // owns, over its live name of the lowest id's owner key, so that a spread is a share of the room's
                // servers (NAMES loop 6a: the best of every name's draw made a server of 250 names reply to nearly
                // every first lookup).
                let r = (self.live_titles(unix).iter())
                    .min_by_key(|(_, e)| e.entry.name)
                    .map_or(u128::MAX, |(_, e)| {
                        rank(&share_hash(&a.nonce, &e.entry.owner))
                    });
                if in_share(r, a.spread) {
                    self.reply(&a, via, now, unix);
                }
            }
            AskMode::Dissent => {
                // Another owner, or the owner's later entry or another zone (R3a): whatever differs from what was shown.
                // A release held: always (final review, finding 5: what was shown may be the released chain's last
                // entry, alive by its own time, and only the release says it isn't).
                let held = self.shown_of(&a.id, unix);
                if held.is_some_and(|h| a.shown == [0; 8] || h != a.shown)
                    || self.released_item(&a.id, unix).is_some()
                {
                    self.reply(&a, via, now, unix);
                }
            }
            AskMode::Fetch => {
                if a.shown != me[..8] {
                    return;
                }
                let Some(region) = region else { return };
                // A call back, as a question's answer is: from the answers' budget, a key's few a minute.
                if !room_in(&mut self.answers, ANSWERS_PER_SECOND, now)
                    || !self.key_allows(&a.key, now)
                    || !self.asker_room(&a.key)
                {
                    self.stats.refused += 1;
                    return;
                }
                self.answers.push_back(now);
                self.stats.fetched += 1;
                self.hold_asker(a.key, now);
                let params = self.params.clone();
                let item = (self.settled(&a.id, unix))
                    .and_then(|h| h.owner_answer(&[], (0, [0; 4]), true, &params));
                self.note_asked(&a.id, unix);
                if self.ask.is_some() && me > a.key {
                    self.deferred.push((now + CROSSED_WAIT, a.key, region));
                } else {
                    self.cmds.push_back(Cmd::CallBack { key: a.key, region });
                }
                // Nothing held: an item of the id with no entries, so the asker knows which of its fetches this answers.
                let item = item.unwrap_or(Item {
                    id: a.id,
                    entries: Vec::new(),
                    zone: None,
                });
                let m = Msg::Items(vec![item]);
                self.xf.send(a.key, &m.encode(0), now);
                self.flush();
            }
        }
    }

    /// The item held for `id`, settled first if time made it stale.
    fn settled(&mut self, id: &[u8; 32], unix: u64) -> Option<&mut Held> {
        if self.reg.get(id).is_some_and(|h| h.stale(unix))
            && self.reg.settle(id, &self.params, unix)
        {
            self.stored(id);
        }
        self.reg.items.get_mut(id)
    }

    /// What a `dissent` would name for what we hold of `id` ([`shown`]): the owner key, the owning chain's last entry
    /// and the zone. None when no chain owns it now.
    fn shown_of(&mut self, id: &[u8; 32], unix: u64) -> Option<[u8; 8]> {
        let h = self.settled(id, unix)?;
        let o = h.owner.as_ref().filter(|o| o.covers(unix) && !o.released)?;
        Some(shown(&o.owner, &o.last(), h.zone.as_ref()))
    }

    /// A name asked for (by a `get` or an ask): what the bound keeps longest, fetched again by sync if it was dropped.
    fn note_asked(&mut self, id: &[u8; 32], unix: u64) {
        self.dropped.remove(id);
        if let Some(h) = self.reg.items.get_mut(id) {
            let moved = unix.saturating_sub(h.asked) >= ASKED_STORE;
            h.asked = h.asked.max(unix);
            if moved {
                self.stored(id);
            }
        }
    }

    /// Released chains held as tombstones (store.rs `Held::settle`): each one's release and as much of what leads to
    /// it as a reply carries ([`Server::reply_max`]), in one item without a zone. None when none is held.
    fn released_item(&mut self, id: &[u8; 32], unix: u64) -> Option<Item> {
        let params = self.params.clone();
        let reply_max = self.reply_max;
        let h = self.settled(id, unix)?;
        let mut it = Item {
            id: *id,
            entries: Vec::new(),
            zone: None,
        };
        for c in h.name.chains(&params) {
            if !c.released || c.keep_until <= unix {
                continue;
            }
            // The release, then the entries before it, last first, while the reply has room.
            for e in c.ids.iter().rev().filter_map(|i| h.name.get(i)) {
                it.entries.push(WireEntry::of(e));
                if it.encode().len() > reply_max {
                    it.entries.pop();
                    break;
                }
            }
        }
        (!it.entries.is_empty()).then_some(it)
    }

    /// Replies to ask `a` (once a nonce and asker key, within [`REPLIES_PER_SECOND`] and [`REPLIES_PER_TAG`]): the
    /// owning chain's last entry and the zone, none, or that its item is past [`Server::reply_max`]; and, with a
    /// release held, the release in a reply of its own (in place of none, when no chain owns the name: final review,
    /// finding 5).
    fn reply(&mut self, a: &NameAsk, via: [u8; 16], now: Instant, unix: u64) {
        // Once a nonce and asker key (final review, finding 3: by nonce alone, a copy of a round under another key,
        // sent first, had the asker's later rounds and dissent go unreplied).
        if self.replied.contains(&(a.nonce, a.key)) || !self.reply_budget(&a.key, now) {
            return;
        }
        self.replied.insert((a.nonce, a.key));
        self.replied_order.push_back((a.nonce, a.key));
        if self.replied_order.len() > REPLIED_KEPT
            && let Some(old) = self.replied_order.pop_front()
        {
            self.replied.remove(&old);
        }
        let params = self.params.clone();
        let (item, since) = match self.settled(&a.id, unix) {
            Some(h) => (
                h.owner_answer(&[], (0, [0; 4]), false, &params),
                h.owner.as_ref().map_or(0, |o| o.seniority),
            ),
            None => (None, 0),
        };
        let released = self.released_item(&a.id, unix);
        self.note_asked(&a.id, unix);
        #[cfg(test)]
        let since = self.lie_since.filter(|_| item.is_some()).unwrap_or(since);
        let item = match item {
            None if released.is_some() => None,
            None => Some(ReplyItem::None),
            // Past the bound: the last entry alone, so the reply holds something checkable.
            Some(it) if it.encode().len() > self.reply_max => {
                Some(ReplyItem::TooBig(Box::new(Item { zone: None, ..it })))
            }
            Some(it) => Some(ReplyItem::Item(Box::new(it))),
        };
        // The first within the budget already counted; the next only if it fits too.
        let replies = item
            .map(|i| (i, since))
            .into_iter()
            .chain(released.map(|r| (ReplyItem::Item(Box::new(r)), 0)));
        for (k, (item, since)) in replies.enumerate() {
            if k > 0 && !self.reply_budget(&a.key, now) {
                return;
            }
            self.send_reply(a, via, since, item);
        }
    }

    /// Whether a reply under `key`'s tag fits the budgets (counted when it does).
    fn reply_budget(&mut self, key: &[u8; 32], now: Instant) -> bool {
        let tag = self.reply_tags.entry(*key).or_default();
        while tag
            .front()
            .is_some_and(|t| now.saturating_duration_since(*t) >= REPLIES_PER_TAG_WINDOW)
        {
            tag.pop_front();
        }
        if tag.len() >= REPLIES_PER_TAG || !room_in(&mut self.replies, REPLIES_PER_SECOND, now) {
            self.stats.replies_refused += 1;
            return false;
        }
        tag.push_back(now);
        self.replies.push_back(now);
        self.reply_tags.retain(|_, w| {
            w.back()
                .is_some_and(|t| now.saturating_duration_since(*t) < REPLIES_PER_TAG_WINDOW)
        });
        true
    }

    fn send_reply(&mut self, a: &NameAsk, via: [u8; 16], since: u32, item: ReplyItem) {
        let me = self.key.unwrap();
        self.stats.replied += 1;
        let r = Reply {
            nonce: a.nonce,
            server: me,
            region: 0, // the transport fills in its home region
            since,
            item,
        };
        self.cmds.push_back(Cmd::Reply {
            to: a.key,
            via,
            data: r.encode(),
        });
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
            Input::Ask { ask, region, via } => self.on_ask(ask, region, via, now, unix),
            Input::Reply(_) => {}
            Input::Gone(k) => self.gone(k),
            Input::Fetched { id, status, body } => self.fetched(id, status, &body, now, unix),
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
                // Twice a session, four a minute from everyone: past them an empty `items`, so the checker hears at
                // once that this server can't say (final review, finding 7; not closed: docs/backlog.md).
                let n = self.ids_asked.entry(from).or_default();
                while (self.ids_answered.front())
                    .is_some_and(|t| now.saturating_duration_since(*t) >= IDS_WINDOW)
                {
                    self.ids_answered.pop_front();
                }
                if *n >= IDS_PER_SESSION || self.ids_answered.len() >= IDS_PER_MINUTE {
                    self.stats.refused += 1;
                    self.send(from, &Msg::Items(Vec::new()), xid, now);
                    return self.log("an ids get refused: past its budget".into());
                }
                *n += 1;
                self.ids_answered.push_back(now);
                // Each with until when its owner holds it (its cover's end; 0: nobody does now), for the dialog's
                // "taken until about".
                let ids = (self.reg.matching(&id).into_iter())
                    .map(|i| {
                        let owner = self.reg.get(&i).and_then(|h| h.owner.as_ref());
                        // Rounded up to a week: names renewed in one visit share a cover end, which would group an
                        // owner's names (review 2); "taken until about" needs no more.
                        let until = owner
                            .filter(|o| !o.released && o.covers(unix))
                            .map_or(0, |o| o.cover_end.div_ceil(IDS_UNTIL_STEP) * IDS_UNTIL_STEP);
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
                            items.extend(h.owner_answer(&held, zone, history, &self.params));
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
                        .filter(|((p, _), (r, _))| *p == from && matches!(r, Req::Get(false, _)))
                        .count();
                    if self.dropped.contains_key(&id)
                        || waiting >= HAVE_GETS
                        || self.job_room(&from) == 0
                    {
                        continue;
                    }
                    let get = self.get_for(&id[..]);
                    self.request(from, &get, Req::Get(false, id.to_vec()), now);
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

    /// How many more items from `peer`'s `get` answers the queue takes.
    fn job_room(&self, peer: &[u8; 32]) -> usize {
        let theirs = self.jobs.iter().filter(|j| j.peer() == Some(*peer)).count();
        JOBS_PER_PEER
            .saturating_sub(theirs)
            .min(JOBS_MAX.saturating_sub(self.jobs.len()))
    }

    /// Whether an item of `bytes` from `peer` fits the queue's bytes.
    fn job_bytes_room(&self, peer: &[u8; 32], bytes: usize) -> bool {
        let all: usize = self.jobs.iter().map(|j| j.bytes).sum();
        let theirs: usize = (self.jobs.iter())
            .filter(|j| j.peer() == Some(*peer))
            .map(|j| j.bytes)
            .sum();
        theirs + bytes <= JOB_BYTES_PER_PEER && all + bytes <= JOB_BYTES_MAX
    }

    /// Tests' view: items waiting to be verified (sync's and `have`'s, not puts).
    #[cfg(test)]
    pub fn jobs_len(&self) -> usize {
        self.jobs.len()
    }

    fn on_answer(&mut self, from: [u8; 32], r: Req, m: Msg, now: Instant) {
        match (r, m) {
            (Req::Sync(range), Msg::SyncAnswer(a)) => {
                self.on_sync_answer(from, range, a);
                self.run_done(from, now);
            }
            (Req::Get(in_run, asked), Msg::Items(items)) => {
                // Only the name asked for (an 8-byte prefix may match two), and within the peer's share of the queue.
                let mut dropped = 0;
                for item in (items.into_iter())
                    .filter(|i| {
                        i.id.starts_with(&asked) && (!i.entries.is_empty() || i.zone.is_some())
                    })
                    .take(2)
                {
                    let job = Job::new(Some((from, None)), item);
                    if self.job_room(&from) == 0 || !self.job_bytes_room(&from, job.bytes) {
                        dropped += 1;
                        continue;
                    }
                    self.jobs.push_back(job);
                }
                if dropped > 0 {
                    self.log(format!(
                        "{dropped} items of a get answer dropped: the queue is full"
                    ));
                }
                if in_run {
                    self.run_done(from, now);
                }
            }
            (Req::Put, m @ (Msg::Taken | Msg::Better(_))) => self.put_answers.push((from, m)),
            (Req::Sync(_) | Req::Get(true, _), _) => self.run_done(from, now),
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
                started: Some(now),
                ..Run::default()
            },
        );
        self.run_done(partner, now);
    }

    /// A request of run `partner`'s finished (or it starts): the next ones go out; with none
    /// left, the partner is told what it lacks, and the round is over.
    fn run_done(&mut self, partner: [u8; 32], now: Instant) {
        if let Some(run) = self.runs.get_mut(&partner) {
            run.outstanding = run.outstanding.saturating_sub(1);
        }
        self.run_step(partner, now);
    }

    /// A run's next requests: its `get`s only while the partner's share of the queue has room (a run waiting on it
    /// goes on at a tick once verification made room).
    fn run_step(&mut self, partner: [u8; 32], now: Instant) {
        let waiting = (self.reqs.iter())
            .filter(|((p, _), (r, _))| *p == partner && matches!(r, Req::Get(..)))
            .count();
        let mut room = self.job_room(&partner).saturating_sub(waiting);
        let Some(run) = self.runs.get_mut(&partner) else {
            return;
        };
        let mut send = Vec::new();
        let mut gets = Vec::new();
        while run.outstanding < SYNC_PARALLEL {
            if room > 0
                && let Some(i) = run.gets.pop_front()
            {
                room -= 1;
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
            self.request(partner, &get, Req::Get(true, i.to_vec()), now);
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
            && matches!(r, Req::Sync(_) | Req::Get(true, _))
        {
            if let Some(run) = self.runs.get_mut(&k) {
                // A partner that doesn't answer: the round with it ends.
                run.stack.clear();
            }
            self.run_done(k, self.now);
        }
    }

    fn gone(&mut self, k: [u8; 32]) {
        if let Some(a) = &mut self.ask {
            a.answers.remove(&k); // let go by the accept window for a better one
        }
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
        self.ids_asked.remove(&k);
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

    /// Entry `s` was just checked whole (it has no anchor yet): remembered by its work key, so a copy of it costs only
    /// its anchor's check. One signed again over fields remembered takes no place of its own.
    fn remember_verified(&mut self, s: &Stamped) {
        let k = s.entry.work_key();
        if let std::collections::btree_map::Entry::Vacant(v) = self.verified.entry(k) {
            v.insert(s.clone());
            self.verified_order.push_back(k);
            if self.verified_order.len() > VERIFIED_KEPT
                && let Some(old) = self.verified_order.pop_front()
            {
                self.verified.remove(&old);
            }
        }
    }

    /// An entry checked whole (counted).
    fn check_whole(&mut self, e: super::entry::Entry) -> Result<Stamped, Invalid> {
        self.stats.checked += 1;
        let runs = self.pow.runs;
        let r = Stamped::check(e, &self.names, &mut self.pow);
        self.stats.work += self.pow.runs - runs;
        r
    }

    /// Checks one entry of a job (or only its anchor, when the entry is held): its cost. An entry that fails a check
    /// (only a forgery fails one: the entry's own bytes decide them all) marks the job forged: the rest of it isn't
    /// checked, and nothing of it is kept.
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
        // The same fields as an entry of this job, signed again (only its owner key does that): skipped, whatever it
        // carries (final review, finding 1: 1,024 signings of one mined entry, each valid, cost 1,024 Argon2ids).
        let wk = w.entry.work_key();
        if job.bodies.get(&wk).is_some_and(|i| *i != eid) {
            job.again += 1;
            return u32::from(job.again.is_multiple_of(SIGNED_AGAIN_A_UNIT));
        }
        job.bodies.insert(wk, eid);
        let held = self
            .reg
            .get(&id)
            .and_then(|h| h.name.get(&eid))
            .cloned()
            .or_else(|| job.checked.iter().find(|s| s.id() == eid).cloned())
            .or_else(|| self.verified.get(&wk).filter(|s| s.id() == eid).cloned());
        // Fields verified lately under another signature: its proof of work held, only the signature is checked.
        let known = self.verified.contains_key(&wk);
        let (mut s, mut cost) = match held {
            Some(s) => (s, 0),
            None => match self.check_whole(w.entry) {
                Ok(s) => {
                    self.remember_verified(&s);
                    (s, if known { 1 } else { 4 })
                }
                Err(e) => {
                    self.log(format!("an entry refused: {e:?}"));
                    self.refuse(eid);
                    job.forged = true;
                    return 4;
                }
            },
        };
        if let Some((a, h)) = w.anchor {
            let better = s.anchor().is_none_or(|b| b.anchor != a || b.header != h);
            if better && self.out.refused(&h.hash()) {
                self.log("an anchor refused: both explorers denied its block".into());
            } else if better {
                cost += 1;
                if let Err(e) = s.offer_anchor(a, h, &self.params, unix) {
                    self.log(format!("an anchor refused: {e:?}"));
                }
            }
        }
        if let Some(p) = w.pending {
            // Only the owner says which pending anchor a server is to finish: anyone's would replace it.
            if pending_ok(&self.names, &s.entry.owner, &eid, &p) {
                s.offer_pending(p);
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
        for mut s in job.checked {
            // An anchor offered while its block wasn't refused, the block refused since (a job of many turns): dropped,
            // as the refusal dropped those held (review 3, finding 6).
            if s.anchor()
                .is_some_and(|a| self.out.refused(&a.header.hash()))
            {
                s.drop_anchor();
            }
            h.name.insert(s);
        }
        h.settle(&self.params, unix);
        // A zone put and not taken (within 10 minutes of the last, or not beating the one held), unless it is the one
        // held: `better`, so that the agent puts it again later or counts past the room's (review 2).
        let mut zone_refused = false;
        if let Some(z) = job.item.zone {
            let held = h.zone.as_ref().is_some_and(|x| x.encode() == z.encode());
            zone_refused = !h.offer_zone(z, unix, true) && !held;
            h.settle(&self.params, unix);
        }
        let changed = h.version != before || was_empty != h.is_empty();
        let answer = match &h.owner {
            Some(o) if put_ids.contains(&o.last()) && !zone_refused => Msg::Taken,
            _ => Msg::Better(h.item()),
        };
        if !h.is_empty() {
            self.reg.put(h);
            self.note(&id, unix);
        }
        if let Some((peer, Some(xid))) = job.from {
            self.send(peer, &answer, xid, self.now);
            if matches!(answer, Msg::Better(_)) {
                self.log("a put refused: a better chain is held".into());
            }
        }
        if changed {
            // Sync's (a run's `get`, a `have`'s), not a `put`: counted for the round's next ([`QUICK_ROUND`]).
            if matches!(job.from, Some((_, None))) {
                self.round_brought += 1;
            }
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
