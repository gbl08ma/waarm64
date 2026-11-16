//! A member's side of the registry against servers on a bus (their commands carried straight to each other, as
//! server_tests.rs does; room/tests/names.rs has the resolver through the fake DERP and relay), with a pretend Bitcoin.

use std::{
    collections::{BTreeMap, BTreeSet},
    time::{Duration, Instant},
};

use super::{
    entry::Kind,
    member::{Answer, KEPT_REFRESH, Member},
    server::{Cmd, Config, Input, MAX_BYTES, MAX_NAMES, Server, Title},
    testkit::{Bitcoin, DAY, params},
    wire::{Item, Question},
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
            Cmd::Accept { .. } | Cmd::CallBack { .. } | Cmd::Subscribe(_) => {}
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
    assert_eq!(bus.m.ids_answers[&first], expect);
    let after: Vec<u64> = refs
        .iter()
        .map(|i| bus.s[0].reg.get(&i.id).unwrap().asked)
        .collect();
    assert_eq!(asked, after, "an ids check isn't a name asked for");
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
    let r = Stamped::check(
        s.entry.clone(),
        s.ref_header,
        &b.names,
        &Params::BUILT,
        &mut pow,
        LATE,
    );
    assert_eq!(r, Err(Invalid::HeaderFloor));
}
