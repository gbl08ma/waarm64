//! A member's side of the registry against servers on a bus (their commands carried straight to each other, as
//! server_tests.rs does; room/tests/names.rs has the resolver through the fake DERP and relay), with a pretend Bitcoin.

use std::{
    collections::{BTreeMap, BTreeSet},
    time::{Duration, Instant},
};

use super::{
    entry::Kind,
    member::{Answer, IdsDone, IdsResult, KEPT_REFRESH, Member},
    server::{Cmd, Config, Input, MAX_BYTES, MAX_NAMES, Server, Title},
    testkit::{Bitcoin, DAY, params},
    wire::{GetMode, Item, Msg, Question},
    zone::Zone,
};

const ROOM: &str = "member room";
const T: u64 = 1_800_000_000;

fn t(days_ago: u32) -> u32 {
    T as u32 - days_ago * DAY
}

fn record(item: &Item, asked: u64) -> Vec<u8> {
    let mut r = vec![1];
    r.extend_from_slice(&asked.to_le_bytes());
    r.extend(item.encode());
    r
}

/// A server with a title of its own (so it can serve), holding `items` too.
fn serving(b: &mut Bitcoin, seed: u8, items: &[&Item]) -> Server {
    let (key, item) = b.title(seed, &format!("server{seed}"), t(20), &[t(4)], [seed; 32]);
    let mut s = Server::new(
        ROOM,
        Config {
            params: params(),
            titles: vec![Title { key, item }],
            max_names: MAX_NAMES,
            max_bytes: MAX_BYTES,
        },
        T,
    );
    for it in items {
        assert!(s.load(&record(it, T), T));
    }
    s
}

/// Servers and one member: a datagram to a key reaches its owner; the member's question reaches the servers that are
/// up (servers' own questions reach nobody, so each is alone and serves).
struct Bus {
    s: Vec<Server>,
    keys: Vec<[u8; 32]>,
    up: Vec<bool>,
    /// Server `i` drops what the member sends it (it answered the question, then went quiet).
    mute: Vec<bool>,
    m: Member,
    mkey: [u8; 32],
    stored: BTreeMap<[u8; 32], Option<Vec<u8>>>,
    t0: Instant,
    now: Instant,
}

impl Bus {
    fn new(servers: Vec<Server>, m: Member) -> Bus {
        let now = Instant::now();
        let n = servers.len();
        let mut b = Bus {
            keys: (0..n)
                .map(|i| {
                    let mut k = [0x77; 32];
                    k[..8].copy_from_slice(&(i as u64 + 1).to_le_bytes());
                    k
                })
                .collect(),
            s: servers,
            up: vec![true; n],
            mute: vec![false; n],
            m,
            mkey: [0x99; 32],
            stored: BTreeMap::new(),
            t0: now,
            now,
        };
        for i in 0..n {
            let k = b.keys[i];
            b.s[i].start(k, now);
        }
        let mk = b.mkey;
        b.m.start(mk, now);
        // Each server asks, nobody answers, and it serves from then on.
        b.advance(Duration::from_secs(3));
        assert!(b.s.iter().all(|s| s.synced));
        b
    }

    fn unix(&self) -> u64 {
        T + self.now.duration_since(self.t0).as_secs()
    }

    fn run(&mut self) {
        loop {
            let mut any = false;
            for i in 0..self.s.len() {
                while let Some(c) = self.s[i].poll() {
                    any = true;
                    self.carry_server(i, c);
                }
            }
            while let Some(c) = self.m.poll() {
                any = true;
                self.carry_member(c);
            }
            if !any {
                break;
            }
        }
    }

    fn carry_server(&mut self, i: usize, c: Cmd) {
        let (now, unix) = (self.now, self.unix());
        if let Cmd::Send { to, data } = c
            && to == self.mkey
            && self.up[i]
        {
            let from = self.keys[i];
            self.m.input(Input::Datagram { from, data }, now, unix);
        }
    }

    fn carry_member(&mut self, c: Cmd) {
        let (now, unix, from) = (self.now, self.unix(), self.mkey);
        match c {
            Cmd::Publish { nonce, spread } => {
                for j in 0..self.s.len() {
                    if self.up[j] {
                        let q = Question {
                            key: from,
                            region: 0,
                            time: unix,
                            nonce,
                            spread,
                        };
                        self.s[j].input(Input::Question { q, region: 0 }, now, unix);
                    }
                }
            }
            Cmd::Send { to, data } => {
                if let Some(j) = self.keys.iter().position(|k| *k == to)
                    && self.up[j]
                    && !self.mute[j]
                {
                    self.s[j].input(Input::Datagram { from, data }, now, unix);
                }
            }
            Cmd::Forget(k) => self.m.input(Input::Gone(k), now, unix),
            Cmd::Store { id, record } => {
                self.stored.insert(id, record);
            }
            Cmd::Log(l) => eprintln!("member: {l}"),
            Cmd::Accept { .. } | Cmd::CallBack { .. } | Cmd::Subscribe(_) | Cmd::Served(..) => {}
        }
    }

    fn advance(&mut self, d: Duration) {
        let end = self.now + d;
        loop {
            self.run();
            let next = (self.s.iter().filter_map(Server::deadline))
                .chain(self.m.deadline())
                .min();
            match next {
                Some(t) if t <= end => {
                    self.now = t.max(self.now);
                    let (now, unix) = (self.now, self.unix());
                    for s in &mut self.s {
                        if s.deadline().is_some_and(|t| t <= now) {
                            s.tick(now, unix);
                        }
                    }
                    if self.m.deadline().is_some_and(|t| t <= now) {
                        self.m.tick(now, unix);
                    }
                }
                _ => break,
            }
        }
        self.now = end;
        self.run();
    }

    /// The resolver's way: the query, then looked at again every 10 ms until it doesn't wait, for at most 4 s. The
    /// answer and how long it took.
    fn resolve(&mut self, full: &str) -> (Answer, Duration) {
        let start = self.now;
        let (now, unix) = (self.now, self.unix());
        let mut a = self.m.query(full, now, unix, true);
        while a == Answer::Wait && self.now - start < Duration::from_secs(4) {
            self.advance(Duration::from_millis(10));
            let (now, unix) = (self.now, self.unix());
            a = self.m.query(full, now, unix, false);
        }
        (a, self.now - start)
    }

    fn gets(&self) -> usize {
        self.m.stats.gets
    }
}

fn member() -> Member {
    Member::new(ROOM, params())
}

/// A title of `secret`'s for `name`, claimed `claim` days ago and renewed at `renewals`, pointing the name at `node`
/// and `git.<name>` at `git`.
fn title(
    b: &mut Bitcoin,
    secret: u8,
    name: &str,
    claim: u32,
    renewals: &[u32],
    node: [u8; 32],
    git: [u8; 32],
) -> Item {
    let key = b.key(secret, name);
    let mut run = vec![b.at(Kind::Claim, &key, name, [0; 32], t(claim))];
    for r in renewals {
        let prev = run.last().unwrap().id();
        run.push(b.at(Kind::Renew, &key, name, prev, t(*r)));
    }
    let zone = Zone::seal(
        &b.names,
        &key,
        name,
        1,
        &[(None, node), (Some("git"), git)],
        false,
    )
    .unwrap();
    b.item(name, &run, Some(zone))
}

#[test]
fn a_member_resolves_a_name_keeps_it_and_asks_again_after_five_minutes() {
    let mut b = Bitcoin::new(ROOM, 1);
    let alpha = title(&mut b, 1, "alpha", 20, &[4], [0xa1; 32], [0xa2; 32]);
    let (s0, s1) = (serving(&mut b, 1, &[&alpha]), serving(&mut b, 2, &[&alpha]));
    let mut bus = Bus::new(vec![s0, s1], member());
    let (a, took) = bus.resolve("alpha");
    eprintln!("a cold lookup on the bus: {took:?}");
    assert_eq!(a, Answer::Node([0xa1; 32]));
    assert_eq!(bus.m.servers().len(), 2, "two servers held");
    assert_eq!(bus.gets(), 2, "a get to each");
    // A label under it: from what is kept, at once.
    assert_eq!(
        bus.resolve("git.alpha"),
        (Answer::Node([0xa2; 32]), Duration::ZERO)
    );
    assert_eq!(bus.resolve("www.alpha").0, Answer::Nx, "no slot opens");
    assert_eq!(bus.gets(), 2, "nothing asked");
    // Stored: a member made from the record answers at once, with no names client.
    let rec = bus.stored[&alpha.id].clone().unwrap();
    assert_eq!(rec[0], 2, "a member's record");
    let mut m = member();
    assert!(m.load(&rec, bus.unix()));
    assert!(!m.load(&record(&alpha, T), bus.unix()), "not a server's");
    assert_eq!(
        m.query("alpha", bus.now, bus.unix(), true),
        Answer::Node([0xa1; 32])
    );
    // Older than 5 minutes: answered at once, and asked again in the background.
    bus.advance(Duration::from_secs(KEPT_REFRESH + 1));
    assert_eq!(
        bus.resolve("alpha"),
        (Answer::Node([0xa1; 32]), Duration::ZERO)
    );
    bus.advance(Duration::from_secs(2));
    assert!(bus.gets() > 2, "asked again");
}

#[test]
fn both_servers_saying_none_is_nxdomain_remembered_for_a_minute() {
    let mut b = Bitcoin::new(ROOM, 2);
    let (s0, s1) = (serving(&mut b, 1, &[]), serving(&mut b, 2, &[]));
    let mut bus = Bus::new(vec![s0, s1], member());
    let (a, took) = bus.resolve("nobody");
    assert_eq!(a, Answer::Nx);
    assert!(took < Duration::from_secs(2), "{took:?}");
    let gets = bus.gets();
    bus.advance(Duration::from_secs(30));
    assert_eq!(bus.resolve("nobody"), (Answer::Nx, Duration::ZERO));
    assert_eq!(bus.gets(), gets, "within the minute: nothing asked");
    bus.advance(Duration::from_secs(31));
    assert_eq!(bus.resolve("nobody").0, Answer::Nx);
    assert!(bus.gets() > gets, "past the minute: asked again");
}

#[test]
fn one_server_saying_none_and_the_other_holding_it_the_answer_stands() {
    let mut b = Bitcoin::new(ROOM, 3);
    let alpha = title(&mut b, 1, "alpha", 20, &[4], [0xa1; 32], [0xa2; 32]);
    let mut liar = serving(&mut b, 1, &[]);
    liar.refuse.insert(alpha.id);
    let honest = serving(&mut b, 2, &[&alpha]);
    let mut bus = Bus::new(vec![liar, honest], member());
    assert_eq!(bus.resolve("alpha").0, Answer::Node([0xa1; 32]));
}

#[test]
fn reserved_and_ill_formed_names_ask_nothing() {
    let mut b = Bitcoin::new(ROOM, 4);
    let s0 = serving(&mut b, 1, &[]);
    let mut bus = Bus::new(vec![s0], member());
    for n in [
        "wpad",
        "com",
        "de",
        "localhost",
        "a.b.alpha",
        "-x",
        "xn--abc",
        "Alpha_",
    ] {
        assert_eq!(bus.resolve(n), (Answer::Nx, Duration::ZERO), "{n}");
    }
    assert_eq!((bus.m.stats.questions, bus.gets()), (0, 0));
}

/// The member kept the owner's chain; the room forgot it (a reset) and an impostor registered the name since: its
/// younger chain, shown by both servers, doesn't replace what is kept, even after `history`.
#[test]
fn a_kept_name_isnt_replaced_by_a_younger_chain() {
    let mut b = Bitcoin::new(ROOM, 5);
    let alpha = title(&mut b, 1, "alpha", 20, &[4], [0xa1; 32], [0xa2; 32]);
    let fake = title(&mut b, 66, "alpha", 2, &[], [0x66; 32], [0x66; 32]);
    let (s0, s1) = (serving(&mut b, 1, &[&alpha]), serving(&mut b, 2, &[&alpha]));
    let mut bus = Bus::new(vec![s0, s1], member());
    assert_eq!(bus.resolve("alpha").0, Answer::Node([0xa1; 32]));
    let kept = bus.m.kept[&alpha.id].clone();
    // The reset: new servers that hold only the impostor's chain.
    let (s2, s3) = (serving(&mut b, 3, &[&fake]), serving(&mut b, 4, &[&fake]));
    let mut m = std::mem::replace(&mut bus.m, member());
    m.stop(); // its names client closed: the servers it held are gone
    let mut bus = Bus::new(vec![s2, s3], m);
    bus.advance(Duration::from_secs(KEPT_REFRESH + 1));
    assert_eq!(
        bus.resolve("alpha").0,
        Answer::Node([0xa1; 32]),
        "answered from what is kept"
    );
    bus.advance(Duration::from_secs(2));
    assert!(bus.m.stats.histories >= 2, "the contest asked for history");
    assert_eq!(bus.m.kept[&alpha.id].kept, kept.kept, "what is kept stands");
    assert_eq!(bus.resolve("alpha").0, Answer::Node([0xa1; 32]));
    // A member that never knew the name takes the impostor: what the protocol can't help (room-names.md "What it
    // does not give").
    let mut fresh = Bus::new(vec![serving(&mut b, 5, &[&fake])], member());
    assert_eq!(fresh.resolve("alpha").0, Answer::Node([0x66; 32]));
}

/// One server lost the name, the other shows a younger chain against what the member keeps: the one answer isn't
/// trusted against it.
#[test]
fn one_servers_answer_isnt_trusted_against_a_contesting_kept_chain() {
    let mut b = Bitcoin::new(ROOM, 6);
    let alpha = title(&mut b, 1, "alpha", 20, &[4], [0xa1; 32], [0xa2; 32]);
    let fake = title(&mut b, 66, "alpha", 2, &[], [0x66; 32], [0x66; 32]);
    let (s0, s1) = (serving(&mut b, 1, &[&alpha]), serving(&mut b, 2, &[&alpha]));
    let mut bus = Bus::new(vec![s0, s1], member());
    assert_eq!(bus.resolve("alpha").0, Answer::Node([0xa1; 32]));
    let (s2, s3) = (serving(&mut b, 3, &[]), serving(&mut b, 4, &[&fake]));
    let mut m = std::mem::replace(&mut bus.m, member());
    m.stop(); // its names client closed: the servers it held are gone
    let mut bus = Bus::new(vec![s2, s3], m);
    bus.advance(Duration::from_secs(KEPT_REFRESH + 1));
    bus.resolve("alpha");
    bus.advance(Duration::from_secs(2));
    assert_eq!(bus.resolve("alpha").0, Answer::Node([0xa1; 32]));
    assert_eq!(
        bus.m.kept[&alpha.id].zone.as_ref().unwrap().owner,
        alpha.zone.as_ref().unwrap().owner
    );
}

/// The servers disagree: one holds the owner's chain, the other (which never got it) an impostor's claimed before the
/// owner's last renewal. Their last entries alone would pick the impostor; `history` shows the owner's run.
#[test]
fn servers_that_disagree_are_asked_for_history() {
    let mut b = Bitcoin::new(ROOM, 7);
    let alpha = title(&mut b, 1, "alpha", 20, &[4], [0xa1; 32], [0xa2; 32]);
    let fake = title(&mut b, 66, "alpha", 10, &[], [0x66; 32], [0x66; 32]);
    let (s0, s1) = (serving(&mut b, 1, &[&alpha]), serving(&mut b, 2, &[&fake]));
    let mut bus = Bus::new(vec![s0, s1], member());
    assert_eq!(bus.resolve("alpha").0, Answer::Node([0xa1; 32]));
    assert_eq!(bus.m.stats.histories, 2);
    assert_eq!(
        bus.m.kept[&alpha.id].kept.earliest,
        t(20),
        "the run's start is what is kept"
    );
}

/// In a room of two servers a member holds both: a round that brings one answer widens once more.
#[test]
fn a_member_holds_two_servers_where_the_room_has_two() {
    let mut b = Bitcoin::new(ROOM, 14);
    let alpha = title(&mut b, 1, "alpha", 20, &[4], [0xa1; 32], [0xa2; 32]);
    let (s0, s1) = (serving(&mut b, 1, &[&alpha]), serving(&mut b, 2, &[&alpha]));
    let mut bus = Bus::new(vec![s0, s1], member());
    for k in 0..16 {
        // A new names client each time (a new key), as after the member's closed for idling.
        bus.m.stop();
        bus.mkey = [0x40 + k as u8; 32];
        let (mk, now) = (bus.mkey, bus.now);
        bus.m.start(mk, now);
        bus.m.kept.clear();
        assert_eq!(bus.resolve("alpha").0, Answer::Node([0xa1; 32]));
        assert_eq!(bus.m.servers().len(), 2, "question {k}");
    }
}

/// A renewal and a zone change reach a member at its next look after 5 minutes.
#[test]
fn a_renewal_and_a_zone_change_show_one_query_late() {
    let mut b = Bitcoin::new(ROOM, 8);
    let key = b.key(1, "alpha");
    let claim = b.at(Kind::Claim, &key, "alpha", [0; 32], t(20));
    let zone1 = Zone::seal(&b.names, &key, "alpha", 1, &[(None, [0xa1; 32])], false).unwrap();
    let v1 = b.item("alpha", std::slice::from_ref(&claim), Some(zone1));
    let renew = b.at(Kind::Renew, &key, "alpha", claim.id(), t(1));
    let zone2 = Zone::seal(&b.names, &key, "alpha", 2, &[(None, [0xb2; 32])], false).unwrap();
    let v2 = b.item("alpha", &[claim.clone(), renew.clone()], Some(zone2));
    let (s0, s1) = (serving(&mut b, 1, &[&v1]), serving(&mut b, 2, &[&v1]));
    let mut bus = Bus::new(vec![s0, s1], member());
    assert_eq!(bus.resolve("alpha").0, Answer::Node([0xa1; 32]));
    // The servers now hold the renewal and the new zone.
    let (s2, s3) = (serving(&mut b, 3, &[&v2]), serving(&mut b, 4, &[&v2]));
    let mut m = std::mem::replace(&mut bus.m, member());
    m.stop(); // its names client closed: the servers it held are gone
    let mut bus = Bus::new(vec![s2, s3], m);
    assert_eq!(
        bus.resolve("alpha").0,
        Answer::Node([0xa1; 32]),
        "fresh: what is kept"
    );
    bus.advance(Duration::from_secs(KEPT_REFRESH + 1));
    assert_eq!(
        bus.resolve("alpha").0,
        Answer::Node([0xa1; 32]),
        "the one query late"
    );
    bus.advance(Duration::from_secs(2));
    assert_eq!(bus.resolve("alpha").0, Answer::Node([0xb2; 32]));
    let k = &bus.m.kept[&v1.id];
    assert_eq!(
        k.last.id(),
        renew.id(),
        "the renewal continues what is kept"
    );
    assert_eq!(k.kept.earliest, t(20));
    assert_eq!(bus.m.stats.histories, 0, "a continuation needs no history");
}

/// Nobody serves: the query waits 2.5 s, then NXDOMAIN; remembered 30 s, doubling; a server that appears is found at
/// the next question after the memory.
#[test]
fn with_nobody_serving_nxdomain_is_remembered_and_doubles_until_a_server_appears() {
    let mut b = Bitcoin::new(ROOM, 9);
    let alpha = title(&mut b, 1, "alpha", 20, &[4], [0xa1; 32], [0xa2; 32]);
    let s0 = serving(&mut b, 1, &[&alpha]);
    let mut bus = Bus::new(vec![s0], member());
    bus.up[0] = false;
    let (a, took) = bus.resolve("alpha");
    assert_eq!(a, Answer::Nx);
    assert!(
        (Duration::from_millis(2400)..Duration::from_millis(2700)).contains(&took),
        "{took:?}"
    );
    assert_eq!(bus.m.stats.questions, 1);
    bus.advance(Duration::from_secs(20));
    assert_eq!(
        bus.resolve("alpha"),
        (Answer::Nx, Duration::ZERO),
        "remembered"
    );
    assert_eq!(bus.m.stats.questions, 1, "no question meanwhile");
    bus.advance(Duration::from_secs(10));
    assert_eq!(bus.resolve("alpha").0, Answer::Nx);
    assert_eq!(bus.m.stats.questions, 2, "asked again after 30 s");
    bus.advance(Duration::from_secs(40));
    assert_eq!(
        bus.resolve("alpha"),
        (Answer::Nx, Duration::ZERO),
        "now 60 s"
    );
    // The server appears; the guest keeps asking every 2 s: found once the memory is over.
    bus.up[0] = true;
    let start = bus.now;
    loop {
        let (a, _) = bus.resolve("alpha");
        if a == Answer::Node([0xa1; 32]) {
            break;
        }
        assert!(
            bus.now - start < Duration::from_secs(60),
            "found within the memory"
        );
        bus.advance(Duration::from_secs(2));
    }
    eprintln!("a server that appeared found in {:?}", bus.now - start);
    assert!(bus.m.nobody_until().is_none(), "an answer resets it");
}

/// A server that answers the question but never a `get`: the query waits (the resolver's SERVFAIL at 4 s); the server
/// is let go, and the next query asks again.
#[test]
fn a_server_that_answers_nothing_is_let_go() {
    let mut b = Bitcoin::new(ROOM, 10);
    let alpha = title(&mut b, 1, "alpha", 20, &[4], [0xa1; 32], [0xa2; 32]);
    let s0 = serving(&mut b, 1, &[&alpha]);
    let mut bus = Bus::new(vec![s0], member());
    bus.mute[0] = true;
    assert_eq!(bus.resolve("alpha"), (Answer::Wait, Duration::from_secs(4)));
    bus.advance(Duration::from_secs(20));
    bus.mute[0] = false;
    assert_eq!(bus.resolve("alpha").0, Answer::Node([0xa1; 32]));
}

/// The dialog's check: every id under one first byte, from each server; not counted as asked.
#[test]
fn ids_by_first_byte() {
    let mut b = Bitcoin::new(ROOM, 11);
    let items: Vec<Item> = (0..40)
        .map(|k| {
            title(
                &mut b,
                k as u8 + 1,
                &format!("name{k}"),
                20,
                &[4],
                [k as u8; 32],
                [0; 32],
            )
        })
        .collect();
    let refs: Vec<&Item> = items.iter().collect();
    let s0 = serving(&mut b, 1, &refs);
    let asked: Vec<u64> = refs
        .iter()
        .map(|i| s0.reg.get(&i.id).unwrap().asked)
        .collect();
    let mut bus = Bus::new(vec![s0], member());
    let first = items[7].id[0];
    let now = bus.now;
    bus.m.ids(first, now);
    bus.advance(Duration::from_secs(4));
    let expect: BTreeSet<[u8; 32]> = items
        .iter()
        .map(|i| i.id)
        .filter(|i| i[0] == first)
        .collect();
    let got = &bus.m.ids_answers[&first];
    assert_eq!(got.keys().copied().collect::<BTreeSet<_>>(), expect);
    // Each with until when its owner holds it: claimed 20 days ago, renewed 4 days ago, so a term and the grace after
    // the renewal, in the future.
    let unix = bus.unix();
    for (id, until) in got {
        assert!(*until > unix, "{} held until {until}, now {unix}", id[0]);
    }
    // The answer as it came, for the page (a publisher's `names-ids` event).
    let done: Vec<_> = bus.m.ids_done.drain(..).collect();
    assert_eq!(done.len(), 1, "one server, one answer");
    assert!(matches!(&done[0].result, IdsResult::Ids(v) if v.len() == expect.len()));
    assert_eq!(done[0].first, first);
    let after: Vec<u64> = refs
        .iter()
        .map(|i| bus.s[0].reg.get(&i.id).unwrap().asked)
        .collect();
    assert_eq!(asked, after, "an ids check isn't a name asked for");
    // One first byte, never every id at once (the user's decision, 2026-11-17: the dialog asks one byte a press of
    // Register, so nothing on the wire asks for the whole registry) and never the id.
    for n in [0usize, 2, 32] {
        let m = Msg::Get {
            mode: GetMode::Ids,
            id: vec![first; n],
            zone: (0, [0; 4]),
            held: vec![],
        };
        assert!(
            Msg::decode(&m.encode(1)).is_err(),
            "an ids get of {n} bytes"
        );
    }
}

/// The dialog's check with nobody serving: nobody can say, as an answer of its own.
#[test]
fn ids_with_nobody_serving() {
    let mut b = Bitcoin::new(ROOM, 12);
    let alpha = title(&mut b, 1, "alpha", 20, &[4], [0xa1; 32], [0xa2; 32]);
    let s0 = serving(&mut b, 1, &[&alpha]);
    let mut bus = Bus::new(vec![s0], member());
    bus.up[0] = false;
    let now = bus.now;
    bus.m.ids(7, now);
    bus.advance(Duration::from_secs(4));
    let done: Vec<_> = bus.m.ids_done.drain(..).collect();
    assert_eq!(
        done,
        [IdsDone {
            first: 7,
            server: None,
            result: IdsResult::Nobody
        }]
    );
}

/// A server's answer that doesn't hold up is refused: here a zone whose signature was altered (in the server's
/// registry, as a lying server would send it).
#[test]
fn a_forged_answer_is_refused() {
    let mut b = Bitcoin::new(ROOM, 12);
    let alpha = title(&mut b, 1, "alpha", 20, &[4], [0xa1; 32], [0xa2; 32]);
    let mut forged = alpha.zone.clone().unwrap();
    forged.sig[0] ^= 1;
    let mut s0 = serving(&mut b, 1, &[&alpha]);
    s0.reg.items.get_mut(&alpha.id).unwrap().zone = Some(forged);
    let mut bus = Bus::new(vec![s0], member());
    assert_ne!(bus.resolve("alpha").0, Answer::Node([0xa1; 32]));
    assert!(bus.m.stats.refused >= 1, "the forged zone refused");
    assert!(!bus.m.kept.contains_key(&alpha.id));
}

/// The module runs on production's parameters (no configuration chooses others): a title made on the tests' pretend
/// Bitcoin is refused under them (its headers are under the floor). Only a `test-params` build runs on others.
#[cfg(not(feature = "test-params"))]
#[test]
fn the_module_runs_on_production_parameters() {
    use super::{Invalid, Params, entry::Stamped, testkit::LATE};
    assert_eq!(Params::BUILT, Params::PRODUCTION);
    assert_eq!(Params::BUILT.label(), "production");
    assert_eq!(Params::TEST.label(), "test");
    let mut b = Bitcoin::new(ROOM, 13);
    let key = b.key(1, "alpha");
    let s = b.at(Kind::Claim, &key, "alpha", [0; 32], t(20));
    let mut pow = super::entry::Pow::new(&Params::BUILT);
    // The tests' proof of work is short of production's, and their headers under its floor.
    let r = Stamped::check(s.entry.clone(), &b.names, &mut pow);
    assert_eq!(r, Err(Invalid::Work));
    let a = s.anchor().unwrap();
    let mut bare = Stamped::trusted(s.entry.clone(), None, None);
    assert_eq!(
        bare.offer_anchor(a.anchor.clone(), a.header, &Params::BUILT, LATE),
        Err(Invalid::HeaderFloor)
    );
}

// ---- Review 1's findings (NAMES-REVIEW-1.md, deleted once all were fixed: git history has it) ----

/// A server the tests play by hand: its names client's key, the live name it serves with, its transfers.
struct Fake {
    key: [u8; 32],
    sk: k256::schnorr::SigningKey,
    /// Its title's whole run, which it serves.
    entries: Vec<super::wire::WireEntry>,
    /// It serves a question's round whose `spread` is this or less.
    spread: u8,
    /// It serves only rounds whose share its owner key falls outside of (as no honest server does).
    outside: bool,
    xf: super::wire::Transfers,
}

impl Fake {
    fn new(b: &mut Bitcoin, secret: u8, key: [u8; 32], spread: u8) -> Fake {
        let name = format!("fake{secret}");
        let sk = b.key(secret, &name);
        let it = title(b, secret, &name, 20, &[4], [secret; 32], [secret; 32]);
        Fake {
            key,
            sk,
            entries: it.entries.clone(),
            spread,
            outside: false,
            xf: Default::default(),
        }
    }

    fn owner(&self) -> [u8; 32] {
        self.entries[0].entry.owner
    }

    /// Its answer's rank for `nonce` (its run is 20 days old).
    fn rank(&self, nonce: &[u8; 16]) -> u128 {
        let tier = super::server::tier(&params(), t(20), T);
        super::server::rank(&super::server::share_hash(nonce, &self.owner()), tier)
    }
}

/// A member and fake servers, its commands carried by hand; `answer(fake, get)` answers the member's requests. Runs
/// for `d`; each call into the member is passed to `watch` after it returns. The publishes seen, (time, spread).
fn drive(
    b: &Bitcoin,
    m: &mut Member,
    fakes: &mut [Fake],
    d: Duration,
    query: &str,
    answer: &mut dyn FnMut(usize, &super::wire::Msg) -> Option<super::wire::Msg>,
    watch: &mut dyn FnMut(&Member),
) -> Vec<(Duration, u8)> {
    use super::wire::Msg;
    let t0 = Instant::now();
    let mkey = [0x99; 32];
    let mut now = t0;
    let unix = |now: Instant| T + now.duration_since(t0).as_secs();
    m.start(mkey, now);
    m.query(query, now, unix(now), true);
    watch(m);
    let mut published = Vec::new();
    while now < t0 + d {
        let mut moved = false;
        while let Some(c) = m.poll() {
            moved = true;
            match c {
                Cmd::Publish { nonce, spread } => {
                    published.push((now - t0, spread));
                    let off = |f: &Fake| !super::server::in_share(f.rank(&nonce), spread);
                    for f in fakes
                        .iter_mut()
                        .filter(|f| spread <= f.spread && (!f.outside || off(f)))
                    {
                        let h = super::entry::tagged(
                            "waarm64/names/serve",
                            &[&b.names.value, &nonce, &f.key],
                        );
                        let s = Msg::Serve {
                            nonce,
                            entries: f.entries.clone(),
                            sig: super::entry::sign(&f.sk, &h),
                        };
                        f.xf.send(mkey, &s.encode(0), now);
                    }
                }
                Cmd::Send { to, data } => {
                    if let Some(i) = fakes.iter().position(|f| f.key == to)
                        && let Some((xid, p)) = fakes[i].xf.input(mkey, &data, now)
                        && let Some(a) = answer(i, &Msg::decode(&p).unwrap().0)
                    {
                        fakes[i].xf.send(mkey, &a.encode(xid), now);
                    }
                }
                Cmd::Forget(k) => {
                    m.input(Input::Gone(k), now, unix(now));
                    watch(m);
                }
                _ => {}
            }
        }
        for f in fakes.iter_mut() {
            for (_, d) in std::mem::take(&mut f.xf.out) {
                moved = true;
                m.input(
                    Input::Datagram {
                        from: f.key,
                        data: d,
                    },
                    now,
                    unix(now),
                );
                watch(m);
            }
        }
        if !moved {
            now = m
                .deadline()
                .map_or(now + Duration::from_millis(50), |t| t.max(now));
            m.tick(now, unix(now));
            m.query(query, now, unix(now), false);
            watch(m);
        }
    }
    published
}

/// A `serve` from outside the share of every round sent so far doesn't count: the rounds go on as if none came.
#[test]
fn a_serve_outside_the_share_sent_isnt_counted() {
    let mut b = Bitcoin::new(ROOM, 30);
    // Fakes that serve the first round only if their owner key falls outside its share.
    let mut fakes: Vec<Fake> = (0..4)
        .map(|k| Fake::new(&mut b, 40 + k, [0x30 + k; 32], 6))
        .collect();
    for f in &mut fakes {
        f.outside = true;
    }
    let mut m = member();
    let published = drive(
        &b,
        &mut m,
        &mut fakes,
        Duration::from_millis(600),
        "alpha",
        &mut |_, _| None,
        &mut |_| {},
    );
    assert_eq!(published[0].1, 6);
    assert_eq!(
        published.get(1).map(|p| p.1),
        Some(3),
        "the second round as usual, not everyone at once after an answer: {published:?}"
    );
}

type Keys = Vec<[u8; 32]>;

/// Two honest servers and an attacker's registration answering from two names-client keys ground (after it saw the
/// nonce) to hash below both honest servers' keys; the registration ranking `first` or last by its owner key's hash
/// among the three. The servers the member holds, the honest servers' keys and the attacker's.
fn many_keys(first: bool) -> (Keys, Keys, Keys) {
    let mut b = Bitcoin::new(ROOM, 31);
    let pool: Vec<Fake> = (0..3u8)
        .map(|k| Fake::new(&mut b, 100 + k, [0x61; 32], 0))
        .collect();
    let mut m = member();
    // The member asks; the attacker sees the nonce (here: the last round's).
    let mut nonce = None;
    let mut now = Instant::now();
    m.start([0x99; 32], now);
    m.query("alpha", now, T, true);
    loop {
        while let Some(c) = m.poll() {
            if let Cmd::Publish {
                nonce: n,
                spread: 0,
            } = c
            {
                nonce = Some(n);
            }
        }
        if nonce.is_some() {
            break;
        }
        now = m.deadline().unwrap_or(now + Duration::from_millis(50));
        m.tick(now, T);
    }
    let nonce = nonce.unwrap();
    // Three registrations by their owner key's hash for this nonce: the attacker's the first or the last.
    let mut pool = pool;
    pool.sort_by_key(|f| f.rank(&nonce));
    let a = if first {
        pool.remove(0)
    } else {
        pool.remove(2)
    };
    let mut fakes = pool;
    fakes[0].key = [0x51; 32];
    fakes[1].key = [0x52; 32];
    let below = super::server::share_hash(&nonce, &fakes[0].key)
        .min(super::server::share_hash(&nonce, &fakes[1].key));
    let mut ground = Vec::new();
    for k in 0u64.. {
        let mut key = [0x62; 32];
        key[..8].copy_from_slice(&k.to_le_bytes());
        if super::server::share_hash(&nonce, &key) < below {
            ground.push(key);
            if ground.len() == 2 {
                break;
            }
        }
        assert!(k < 1 << 24, "grinding");
    }
    for key in &ground {
        fakes.push(Fake {
            key: *key,
            sk: a.sk.clone(),
            entries: a.entries.clone(),
            spread: 0,
            outside: false,
            xf: Default::default(),
        });
    }
    // The serves for that nonce, to the member still asking: the attacker's first.
    let mkey = [0x99; 32];
    for f in fakes.iter_mut().rev() {
        let h = super::entry::tagged("waarm64/names/serve", &[&b.names.value, &nonce, &f.key]);
        let s = super::wire::Msg::Serve {
            nonce,
            entries: f.entries.clone(),
            sig: super::entry::sign(&f.sk, &h),
        };
        f.xf.send(mkey, &s.encode(0), now);
        for (_, d) in std::mem::take(&mut f.xf.out) {
            m.input(
                Input::Datagram {
                    from: f.key,
                    data: d,
                },
                now,
                T,
            );
        }
    }
    m.tick(now + Duration::from_secs(1), T);
    (
        m.servers().to_vec(),
        vec![fakes[0].key, fakes[1].key],
        ground,
    )
}

/// Keys ground for a low hash win nothing (the choice goes by the owner key served with): a registration that ranks
/// last isn't held.
#[test]
fn keys_ground_for_a_low_hash_win_nothing() {
    let (mut held, mut honest, _) = many_keys(false);
    held.sort();
    honest.sort();
    assert_eq!(held, honest, "the honest servers are held");
}

/// One registration answering from many keys counts once: ranking first, it takes one place, not both.
#[test]
fn one_name_answering_from_many_keys_counts_once() {
    let (held, honest, attacker) = many_keys(true);
    assert_eq!(held.len(), 2);
    assert_eq!(
        held.iter().filter(|k| attacker.contains(k)).count(),
        1,
        "{held:?}"
    );
    assert_eq!(held.iter().filter(|k| honest.contains(k)).count(), 1);
}

/// A `history` answer of one long chain's entries, each many times over: each entry is checked once, and a turn checks
/// a slice (the room's worker isn't stalled).
#[test]
fn a_history_is_checked_once_an_entry_in_slices() {
    let mut b = Bitcoin::new(ROOM, 32);
    // What the member keeps: alpha's owner.
    let alpha = title(&mut b, 1, "alpha", 20, &[4], [0xa1; 32], [0xa2; 32]);
    let last = alpha.entries.last().unwrap().clone();
    let mut rec = vec![2u8];
    rec.extend_from_slice(&t(20).to_le_bytes());
    rec.extend_from_slice(&(T - KEPT_REFRESH - 10).to_le_bytes()); // checked a while ago: asked again
    rec.extend(
        Item {
            id: alpha.id,
            entries: vec![last],
            zone: alpha.zone.clone(),
        }
        .encode(),
    );
    let mut m = member();
    assert!(m.load(&rec, T));
    // A fake server contests it with an impostor's renewal, then shows a long run, 50 copies of each entry.
    let renewals: Vec<u32> = (1..20).map(|k| 400 - 20 * k).collect();
    let long = title(&mut b, 66, "alpha", 400, &renewals, [0x66; 32], [0x66; 32]);
    let mut fakes = vec![Fake::new(&mut b, 70, [0x71; 32], 6)];
    let (owner_answer, history) = {
        let mut o = long.clone();
        o.entries = vec![long.entries.last().unwrap().clone()];
        let mut h = long.clone();
        h.entries = (0..50).flat_map(|_| long.entries.clone()).collect();
        (o, h)
    };
    assert!(history.entries.len() <= super::wire::MAX_ENTRIES);
    let (mut most, mut before) = (0usize, 0usize);
    drive(
        &b,
        &mut m,
        &mut fakes,
        Duration::from_secs(KEPT_REFRESH + 20),
        "alpha",
        &mut |_, msg| match msg {
            super::wire::Msg::Get { mode, .. } => Some(super::wire::Msg::Items(vec![if *mode
                == super::wire::GetMode::History
            {
                history.clone()
            } else {
                owner_answer.clone()
            }])),
            _ => None,
        },
        &mut |m| {
            most = most.max(m.stats.checked - before);
            before = m.stats.checked;
        },
    );
    assert!(m.stats.histories >= 1, "asked for history");
    assert!(m.stats.checked <= 2 * 20 + 4, "{} checked", m.stats.checked);
    assert!(most <= 6, "{most} entries checked in one turn");
}

/// Review 2's finding 2: claims on junk ids are cheap, so a Sybil with 128 fresh registrations against five honest
/// servers that have held their names for months must not be both of most askers' servers. An answer ranks by its
/// owner key's hash and its chain's age (what the `serve` shows of it), so tickets cost time, not only work.
#[test]
fn cheap_fresh_registrations_dont_buy_both_of_an_askers_servers() {
    let mut b = Bitcoin::new(ROOM, 40);
    let mut servers = Vec::new();
    // Five honest servers, each a name held 120 days, renewed every 15.
    for k in 0..5u8 {
        let renewals: Vec<u32> = (1..8).map(|r| 120 - 15 * r).chain([2]).collect();
        let (key, item) = {
            let key = b.key(200 + k, &format!("old{k}"));
            let mut run = vec![b.at(Kind::Claim, &key, &format!("old{k}"), [0; 32], t(120))];
            for r in &renewals {
                let prev = run.last().unwrap().id();
                run.push(b.at(Kind::Renew, &key, &format!("old{k}"), prev, t(*r)));
            }
            (
                key.to_bytes().into(),
                b.item(&format!("old{k}"), &run, None),
            )
        };
        servers.push(Server::new(
            ROOM,
            Config {
                params: params(),
                titles: vec![Title { key, item }],
                max_names: MAX_NAMES,
                max_bytes: MAX_BYTES,
            },
            T,
        ));
    }
    // 128 junk registrations, claimed two days ago.
    for k in 0..128u32 {
        let (key, item) = b.title((k % 200) as u8 + 1, &format!("junk{k}"), t(2), &[], [1; 32]);
        servers.push(Server::new(
            ROOM,
            Config {
                params: params(),
                titles: vec![Title { key, item }],
                max_names: MAX_NAMES,
                max_bytes: MAX_BYTES,
            },
            T,
        ));
    }
    let mut bus = Bus::new(servers, member());
    let honest: BTreeSet<[u8; 32]> = bus.keys[..5].iter().copied().collect();
    const QUESTIONS: usize = 40;
    let (mut both_junk, mut asked) = (0, 0);
    for k in 0..QUESTIONS {
        bus.m.stop();
        bus.advance(Duration::from_secs(2)); // a question a second
        bus.mkey = [0x40 + k as u8; 32];
        let (mk, now) = (bus.mkey, bus.now);
        bus.m.start(mk, now);
        assert_eq!(bus.resolve(&format!("ask{k}")).0, Answer::Nx);
        let held = bus.m.servers().to_vec();
        if held.len() == 2 {
            asked += 1;
            both_junk += held.iter().all(|s| !honest.contains(s)) as usize;
        }
    }
    eprintln!("both servers junk: {both_junk} of {asked}");
    assert!(asked >= QUESTIONS - 2, "two servers held: {asked}");
    assert!(
        both_junk <= QUESTIONS / 10,
        "both junk: {both_junk} of {asked}"
    );
}

/// Review 2's finding 5: a release the servers hold ends what a member keeps (the servers show it, continuing the
/// kept last entry), and the name's next owner is taken then.
#[test]
fn a_release_ends_a_kept_name_and_its_next_owner_is_taken() {
    let mut b = Bitcoin::new(ROOM, 41);
    let key = b.key(1, "alpha");
    let claim = b.at(Kind::Claim, &key, "alpha", [0; 32], t(20));
    let renew = b.at(Kind::Renew, &key, "alpha", claim.id(), t(4));
    let zone = Zone::seal(&b.names, &key, "alpha", 1, &[(None, [0xa1; 32])], false).unwrap();
    let alpha = b.item("alpha", &[claim.clone(), renew.clone()], Some(zone));
    let (s0, s1) = (serving(&mut b, 1, &[&alpha]), serving(&mut b, 2, &[&alpha]));
    let mut bus = Bus::new(vec![s0, s1], member());
    assert_eq!(bus.resolve("alpha").0, Answer::Node([0xa1; 32]));
    // The owner lets it go: both servers hold the release.
    let release = b.at(Kind::Release, &key, "alpha", renew.id(), t(1));
    let gone = b.item("alpha", &[claim, renew, release], None);
    let unix = bus.unix();
    for s in &mut bus.s {
        assert!(s.load(&record(&gone, unix), unix));
    }
    bus.advance(Duration::from_secs(KEPT_REFRESH + 1));
    bus.resolve("alpha"); // from what is kept, asked again in the background
    bus.advance(Duration::from_secs(2));
    assert_eq!(bus.resolve("alpha").0, Answer::Nx, "released: kept no more");
    assert!(!bus.m.kept.contains_key(&alpha.id));
    // Someone registers it: both servers hold the new claim, and the member takes it.
    let newcomer = title(&mut b, 9, "alpha", 0, &[], [0x99; 32], [0x99; 32]);
    let unix = bus.unix();
    for s in &mut bus.s {
        assert!(s.load(&record(&newcomer, unix), unix));
    }
    bus.advance(Duration::from_secs(61));
    assert_eq!(
        bus.resolve("alpha").0,
        Answer::Node([0x99; 32]),
        "the next owner"
    );
}

/// Review 2's finding 9: a lookup whose answers are being checked (its `asked` emptied) isn't asked again by whatever
/// else sends: stray owner answers would fill the `history` lookup it may start, deciding it on last entries.
#[test]
fn a_lookup_being_checked_isnt_asked_again() {
    let mut b = Bitcoin::new(ROOM, 42);
    let alpha = title(&mut b, 1, "alpha", 20, &[4], [0xa1; 32], [0xa2; 32]);
    // The other server holds another chain of alpha, a long one: the servers disagree, and its history takes turns.
    let renewals: Vec<u32> = (1..20).map(|k| 400 - 20 * k).collect();
    let long = title(&mut b, 66, "alpha", 400, &renewals, [0x66; 32], [0x66; 32]);
    let (s0, s1) = (serving(&mut b, 1, &[&alpha]), serving(&mut b, 2, &[&long]));
    let mut bus = Bus::new(vec![s0, s1], member());
    let (now, unix) = (bus.now, bus.unix());
    bus.m.query("alpha", now, unix, true);
    let mut seen = false;
    for _ in 0..4000 {
        bus.run();
        if bus.m.stats.histories >= 2 && bus.m.checking() > 0 {
            seen = true;
            break;
        }
        // One turn each, not as many as it takes.
        bus.now += Duration::from_millis(1);
        let (now, unix) = (bus.now, bus.unix());
        for s in &mut bus.s {
            if s.deadline().is_some_and(|t| t <= now) {
                s.tick(now, unix);
            }
        }
        if bus.m.deadline().is_some_and(|t| t <= now) {
            bus.m.tick(now, unix);
        }
    }
    assert!(seen, "alpha's history being checked");
    let asks = |m: &Member| m.stats.gets + m.stats.histories;
    let before = asks(&bus.m);
    let (now, unix) = (bus.now, bus.unix());
    bus.m.query("beta", now, unix, true);
    bus.run();
    assert_eq!(asks(&bus.m), before + 2, "beta's gets alone");
}
