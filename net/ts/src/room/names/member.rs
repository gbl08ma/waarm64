//! A member's side of the registry (room-names.md "A member resolving a name"), sans I/O: what the resolver asks for a
//! name that isn't a key, the servers that answer it, and what the member keeps. The transport is a names client of its
//! own, as a server's is (room.rs), made when the guest first asks for such a name and closed after
//! [`IDLE`] without one.
//!
//! - **Finding servers**: "who serves the registry?" as a server asks it (server.rs): shares of 1/64, 1/8, everyone;
//!   the two answers with the lowest `BLAKE2s(nonce, server's key)` 0.3 s after the first. Held while asked and for
//!   [`SERVERS_HELD`] after; a server that fails is let go, and with none left the next lookup asks again. Nobody
//!   within 2.5 s: remembered for 30 s, doubling to 10 minutes, reset by an answer; meanwhile names not kept get
//!   NXDOMAIN at once and no question goes out.
//! - **A lookup**: `get` (owner mode, with the last entry and zone kept, if any) to each server; each answers with the
//!   owning chain's last entry and the zone, those the member lacks, or none. The member checks the last entry only
//!   (signature, proof of work, its headers and anchor, alive by its clock). Both say none: NXDOMAIN, kept
//!   [`NEGATIVE_FOR`]. One says none: the other's answer stands. The answers disagree, or one contests what the member
//!   keeps (chain.rs `Kept::offer` refuses it): `history` from each, the whole run, and the owner by "Who owns a name"
//!   over everything shown, which `Kept::offer` then takes or refuses.
//! - **What is kept**: each name resolved, its chain's last entry, the earliest time verified for that chain, the
//!   zone and when servers last confirmed it, persisted (a record a name, version 2). It answers at once while its
//!   chain is alive; one older than [`KEPT_REFRESH`] is asked again in the background.
//! - **The dialog's check**: `ids`, every id under one first byte ([`Member::ids`]).

use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    time::{Duration, Instant},
};

use super::{
    Invalid, Params,
    chain::{Chain, Kept, Name},
    entry::{Pow, Stamped},
    id::{RoomNames, split},
    server::{
        ACCEPT_MAX, Ask, CHOOSE_AFTER, Cmd, GIVE_UP, Input, NOBODY_FIRST, NOBODY_MAX,
        QUESTIONS_PER_SECOND, ROUND_AT, SPREADS, UNITS_PER_TURN, check_serve, random, room_in,
    },
    store::{anchor_tag, zone_tag},
    wire::{GetMode, Item, Msg, Rd, Transfers, WireEntry},
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
}

/// A kept name is asked again in the background once servers last confirmed it this long ago (seconds).
pub const KEPT_REFRESH: u64 = 300;
/// Both servers said none: NXDOMAIN at once for this long.
pub const NEGATIVE_FOR: Duration = Duration::from_secs(60);
/// The servers a question chose are held this long after they were last asked.
pub const SERVERS_HELD: Duration = Duration::from_secs(180);
/// A member's names client closes after this long without a query for a name that isn't a key.
pub const IDLE: Duration = Duration::from_secs(600);
/// A server's answer to a `get` is waited for this long (its transfer fails sooner, ~5.5 s, when nothing comes).
const REQUEST_TIMEOUT: Duration = Duration::from_secs(8);
/// Names kept at most (the least used go first), lookups at once, names remembered as none.
pub const MAX_KEPT: usize = 1024;
const MAX_LOOKUPS: usize = 64;
const MAX_NEGATIVE: usize = 1024;
/// A member's record's version byte (a server's is 1: store.rs).
const RECORD_VERSION: u8 = 2;

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
    /// The stored record: its version byte, the earliest time, when it was checked, an item of the last entry and the
    /// zone.
    pub fn record(&self) -> Vec<u8> {
        let mut r = vec![RECORD_VERSION];
        r.extend_from_slice(&self.kept.earliest.to_le_bytes());
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
}

enum Req {
    Get([u8; 32]),
    History([u8; 32]),
    Ids(u8),
}

#[derive(Debug, Default, Clone)]
pub struct MemberStats {
    pub questions: usize,
    pub nobody: usize,
    pub gets: usize,
    pub histories: usize,
    /// Answers refused (a forged or broken entry or zone, a dead chain).
    pub refused: usize,
    /// Entries checked whole (signature, proof of work, headers, anchor).
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
    pub kept: BTreeMap<[u8; 32], KeptName>,
    negative: BTreeMap<[u8; 32], Instant>,
    lookups: BTreeMap<[u8; 32], Lookup>,
    /// The `ids` checks wanted (first bytes), and what came back: the ids servers hold under each.
    ids_wanted: BTreeSet<u8>,
    pub ids_answers: BTreeMap<u8, BTreeSet<[u8; 32]>>,
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
            kept: BTreeMap::new(),
            negative: BTreeMap::new(),
            lookups: BTreeMap::new(),
            ids_wanted: BTreeSet::new(),
            ids_answers: BTreeMap::new(),
            cmds: VecDeque::new(),
            stats: MemberStats::default(),
            now: Instant::now(),
        }
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

    /// Whether it needs its names client: a lookup or a question under way, or an `ids` check.
    pub fn busy(&self) -> bool {
        !self.lookups.is_empty() || self.ask.is_some() || !self.ids_wanted.is_empty()
    }

    /// A stored record (a member's, version 2), streamed in at the start: verified when it was taken, so trusted. False
    /// for a record that isn't a member's or whose chain no longer covers `unix` (the page deletes it).
    pub fn load(&mut self, record: &[u8], unix: u64) -> bool {
        let Some((earliest, checked, item)) = read_record(record) else {
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
        name.insert(last.clone(), &self.params, unix);
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
                let fresh = unix < k.checked + KEPT_REFRESH;
                let answer = if k.kept.chain.resolves(unix) {
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
        if let Some(t) = self.negative.get(&id) {
            if *t > now {
                return Answer::Nx;
            }
            self.negative.remove(&id);
        }
        if self.nobody.is_some_and(|(t, _)| t > now) {
            return Answer::Nx;
        }
        if start {
            self.lookup(id, now);
        }
        Answer::Wait
    }

    fn lookup(&mut self, id: [u8; 32], now: Instant) {
        if self.lookups.contains_key(&id)
            || self.lookups.len() >= MAX_LOOKUPS
            || self.nobody.is_some_and(|(t, _)| t > now)
        {
            return;
        }
        self.lookups
            .insert(id, Lookup::new(BTreeMap::new(), false, false));
        self.dispatch(now);
    }

    /// The `ids` check for a name being typed: every id under `first` (its id's first byte), from each server.
    pub fn ids(&mut self, first: u8, now: Instant) {
        self.ids_answers.remove(&first);
        self.ids_wanted.insert(first);
        self.dispatch(now);
    }

    /// Sends what waits for servers, or asks for servers.
    fn dispatch(&mut self, now: Instant) {
        if self.key.is_none() {
            return; // the transport starts and calls again
        }
        if self.servers.is_empty() {
            if self.ask.is_none() && self.busy() && self.next_question.is_none() {
                self.start_question(now);
            }
            return;
        }
        let todo: Vec<([u8; 32], bool)> = self
            .lookups
            .iter()
            .filter(|(_, l)| l.asked.is_empty())
            .map(|(id, l)| (*id, l.history))
            .collect();
        for (id, history) in todo {
            for s in self.servers.clone() {
                self.send_get(id, s, history, now);
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

    /// The names client's key: the transport runs. What waits is sent.
    pub fn start(&mut self, key: [u8; 32], now: Instant) {
        self.key = Some(key);
        self.dispatch(now);
    }

    /// The transport is gone: everything tied to its key goes; what is kept stays.
    pub fn stop(&mut self) {
        self.key = None;
        self.xf = Transfers::default();
        self.reqs.clear();
        self.ask = None;
        self.servers.clear();
        self.servers_until = None;
        self.lookups.clear();
        self.ids_wanted.clear();
        self.next_question = None;
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
        [
            ask,
            checking,
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
        if self.servers_until.is_some_and(|t| t <= now) && self.lookups.is_empty() {
            self.servers_until = None;
            for k in std::mem::take(&mut self.servers) {
                self.cmds.push_back(Cmd::Forget(k));
            }
        }
        self.negative.retain(|_, t| *t > now);
        self.flush();
    }

    pub fn input(&mut self, i: Input, now: Instant, unix: u64) {
        if self.key.is_none() {
            return;
        }
        self.now = now;
        match i {
            Input::Question { .. } => {} // a member answers nobody
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
        self.stats.nobody += 1;
        let wait = self
            .nobody
            .map_or(NOBODY_FIRST, |(_, w)| (w * 2).min(NOBODY_MAX));
        self.nobody = Some((now + wait, wait));
        self.log(format!(
            "nobody serves the registry; NXDOMAIN for {} s",
            wait.as_secs()
        ));
        // The queries that waited get NXDOMAIN now (`query` says so while it is remembered).
        self.lookups.clear();
        self.ids_wanted.clear();
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
        if let Err(why) = self.ask.as_mut().unwrap().offer(from, owner, name, now) {
            self.stats.refused += 1;
            self.log(format!("a serve refused: {why}"));
            return self.cmds.push_back(Cmd::Forget(from));
        }
        self.cmds.push_back(Cmd::Served(from));
    }

    /// The two answers with the lowest hash are kept; the others are let go.
    fn choose(&mut self, now: Instant) {
        let a = self.ask.take().unwrap();
        self.nobody = None;
        let (keep, rest) = a.choose();
        self.cmds.push_back(Cmd::Accept { until: now, max: 0 });
        self.servers.extend(keep);
        for k in rest {
            self.cmds.push_back(Cmd::Forget(k));
        }
        self.dispatch(now);
    }

    // ---- Answers ----

    fn on_msg(&mut self, from: [u8; 32], reply: u32, m: Msg, now: Instant, unix: u64) {
        if reply == 0 {
            if let m @ Msg::Serve { .. } = m {
                self.on_serve(from, m, now, unix);
            }
            return; // a member serves nothing
        }
        let Some((r, _)) = self.reqs.remove(&(from, reply)) else {
            return;
        };
        match (r, m) {
            (Req::Get(id) | Req::History(id), Msg::Items(items)) => {
                let said = match items.into_iter().find(|i| i.id == id) {
                    Some(it) => Said::Item(Box::new(it)),
                    None => Said::Nothing,
                };
                if let Some(l) = self.lookups.get_mut(&id) {
                    l.asked.insert(from, said);
                }
                self.settle(id, now, unix);
            }
            (Req::Ids(first), Msg::Ids(ids)) => {
                let got = self.ids_answers.entry(first).or_default();
                got.extend(ids.into_iter().filter(|i| i[0] == first));
            }
            (Req::Get(id) | Req::History(id), _) => {
                if let Some(l) = self.lookups.get_mut(&id) {
                    l.asked.insert(from, Said::Failed);
                }
                self.settle(id, now, unix);
            }
            _ => {}
        }
    }

    fn failed(&mut self, k: [u8; 32], x: u32, now: Instant, unix: u64) {
        let Some((r, _)) = self.reqs.remove(&(k, x)) else {
            return;
        };
        self.drop_server(k);
        if let Req::Get(id) | Req::History(id) = r {
            if let Some(l) = self.lookups.get_mut(&id) {
                l.asked.insert(k, Said::Failed);
            }
            self.settle(id, now, unix);
        }
    }

    fn gone(&mut self, k: [u8; 32], now: Instant, unix: u64) {
        self.xf.forget(&k);
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
                    // A member checks the last entry only, unless it asked for the run.
                    if (!history && it.entries.len() > 1) || it.id != id {
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
                        name.insert(k, &self.params, unix);
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

    /// One entry of a server's item: checked whole (signature, proof of work, headers, anchor).
    fn check_one(&mut self, check: &mut Check, w: WireEntry, unix: u64) -> Result<(), Invalid> {
        if w.entry.name != check.name.id {
            return Err(Invalid::Name);
        }
        let mut s = Stamped::check(
            w.entry,
            w.ref_header,
            &self.names,
            &self.params,
            &mut self.pow,
            unix,
        )?;
        let (a, h) = w.anchor.ok_or(Invalid::AnchorRoot)?;
        s.offer_anchor(a, h, &self.params, unix)?;
        check.last = Some(s.id());
        check.name.insert(s, &self.params, unix);
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
        let chain = (check.name.chains(&self.params).into_iter())
            .find(|c| c.last() == last && c.covers(unix));
        Ok(chain.map(|chain| View {
            name: check.name,
            chain,
            zone,
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
                if self.negative.len() >= MAX_NEGATIVE {
                    self.negative.pop_first();
                }
                self.negative.insert(id, now + NEGATIVE_FOR);
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
                all.insert(e.clone(), &self.params, unix);
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
                if same || k.kept.offer(&chain, unix) {
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

/// A member's stored record read back: the earliest time, when it was checked, the item.
fn read_record(b: &[u8]) -> Option<(u32, u64, Item)> {
    let mut r = Rd::new(b);
    if r.u8().ok()? != RECORD_VERSION {
        return None;
    }
    let earliest = r.u32().ok()?;
    let checked = r.u64().ok()?;
    Some((earliest, checked, Item::decode(r.rest()).ok()?))
}
