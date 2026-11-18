//! The registry's logic against a bus that carries its commands straight to the other servers
//! (no WireGuard, DERP or relay: room/tests/names.rs has those), with a pretend Bitcoin.

use std::{
    collections::BTreeMap,
    time::{Duration, Instant},
};

use super::{
    Invalid,
    entry::{Entry, Kind, Stamped},
    server::{
        ANSWERS_PER_SECOND, Cmd, Config, Input, MAX_BYTES, MAX_NAMES, REPLIES_PER_TAG, SPREADS,
        Server, Title, UNITS_PER_TURN, check_serve, in_share, rank, share_hash,
    },
    store::read_record,
    testkit::{Bitcoin, DAY, HOUR, Services, params},
    wire::{GetMode, Item, Msg, Question, Range, SyncAnswer, Transfers, WireEntry},
    zone::Zone,
};

const ROOM: &str = "bus room";
/// The bus's clock at its start.
const T: u64 = 1_800_000_000;

fn t(days_ago: u32) -> u32 {
    T as u32 - days_ago * DAY
}

fn cfg(titles: Vec<Title>) -> Config {
    Config {
        params: params(),
        titles,
        max_names: MAX_NAMES,
        max_bytes: MAX_BYTES,
    }
}

/// Servers whose commands reach each other at once: a datagram to a key reaches its server, a
/// question every subscribed server but the asker's.
struct Bus {
    s: Vec<Server>,
    keys: Vec<[u8; 32]>,
    sub: Vec<bool>,
    calls: Vec<Vec<[u8; 32]>>,
    stored: Vec<BTreeMap<[u8; 32], Option<Vec<u8>>>>,
    /// What the servers fetch is answered by these (none: no answer); each fetch by server, in order.
    svc: Option<Services>,
    fetched: Vec<(usize, String)>,
    t0: Instant,
    now: Instant,
    /// Datagrams take this long one way (zero: at once), and those on their way: (when, to, from, data).
    delay: Duration,
    flying: Vec<(Instant, usize, [u8; 32], Vec<u8>)>,
}

impl Bus {
    fn new(servers: Vec<Server>) -> Bus {
        let now = Instant::now();
        let n = servers.len();
        let mut b = Bus {
            keys: (0..n)
                .map(|i| {
                    let mut k = [0x5a; 32];
                    k[..8].copy_from_slice(&(i as u64 + 1).to_le_bytes());
                    k
                })
                .collect(),
            s: servers,
            sub: vec![false; n],
            calls: vec![Vec::new(); n],
            stored: vec![BTreeMap::new(); n],
            svc: None,
            fetched: Vec::new(),
            t0: now,
            now,
            delay: Duration::ZERO,
            flying: Vec::new(),
        };
        for i in 0..n {
            let k = b.keys[i];
            b.s[i].start(k, now);
        }
        b.run();
        b
    }

    /// Servers started one after another, `starts[i]` after the bus's start (the first at once).
    fn staggered(servers: Vec<Server>, starts: &[Duration]) -> Bus {
        let n = servers.len();
        let mut b = Bus::new(Vec::new());
        b.keys = (0..n)
            .map(|i| {
                let mut k = [0x5a; 32];
                k[..8].copy_from_slice(&(i as u64 + 1).to_le_bytes());
                k
            })
            .collect();
        b.s = servers;
        b.sub = vec![false; n];
        b.calls = vec![Vec::new(); n];
        b.stored = vec![BTreeMap::new(); n];
        let mut order: Vec<usize> = (0..n).collect();
        order.sort_by_key(|i| starts[*i]);
        for i in order {
            let at = b.t0 + starts[i];
            if at > b.now {
                b.advance(at - b.now);
            }
            let (k, now) = (b.keys[i], b.now);
            b.s[i].start(k, now);
            b.run();
        }
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
                    self.carry(i, c);
                }
            }
            if !any {
                break;
            }
        }
    }

    fn carry(&mut self, i: usize, c: Cmd) {
        let (now, unix, from) = (self.now, self.unix(), self.keys[i]);
        match c {
            Cmd::Send { to, data } => {
                if let Some(j) = self.keys.iter().position(|k| *k == to) {
                    if self.delay.is_zero() {
                        self.s[j].input(Input::Datagram { from, data }, now, unix);
                    } else {
                        self.flying.push((now + self.delay, j, from, data));
                    }
                }
            }
            Cmd::Publish { nonce, spread } => {
                for j in 0..self.s.len() {
                    if j != i && self.sub[j] {
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
            Cmd::CallBack { key, .. } => self.calls[i].push(key),
            Cmd::Forget(k) => self.s[i].input(Input::Gone(k), now, unix),
            Cmd::Subscribe(on) => self.sub[i] = on,
            Cmd::Store { id, record } => {
                self.stored[i].insert(id, record);
            }
            Cmd::Fetch { id, url } => {
                self.fetched.push((i, url.clone()));
                let (status, body) = self.svc.as_mut().map_or((0, Vec::new()), |v| v.get(&url));
                self.s[i].input(Input::Fetched { id, status, body }, now, unix);
            }
            Cmd::Accept { .. }
            | Cmd::Log(_)
            | Cmd::Served(..)
            | Cmd::Replies(_)
            | Cmd::Ask { .. }
            | Cmd::Reply { .. }
            | Cmd::AcceptFrom { .. } => {}
        }
    }

    fn advance(&mut self, d: Duration) {
        let end = self.now + d;
        loop {
            self.run();
            let next = (self.s.iter().filter_map(Server::deadline))
                .chain(self.flying.iter().map(|f| f.0))
                .min();
            match next {
                Some(t) if t <= end => {
                    self.now = t.max(self.now);
                    let (now, unix) = (self.now, self.unix());
                    let (due, wait): (Vec<_>, Vec<_>) =
                        self.flying.drain(..).partition(|f| f.0 <= now);
                    self.flying = wait;
                    for (_, j, from, data) in due {
                        self.s[j].input(Input::Datagram { from, data }, now, unix);
                    }
                    for s in &mut self.s {
                        if s.deadline().is_some_and(|t| t <= now) {
                            s.tick(now, unix);
                        }
                    }
                }
                _ => break,
            }
        }
        self.now = end;
        self.run();
    }

    /// Server `i`'s registry: each name's version.
    fn reg(&self, i: usize) -> BTreeMap<[u8; 32], [u8; 8]> {
        self.s[i]
            .reg
            .items
            .iter()
            .map(|(id, h)| (*id, h.version))
            .collect()
    }

    /// Server `i` puts `item` to server `j`; the answer.
    fn put(&mut self, i: usize, j: usize, item: Item) -> Msg {
        let to = self.keys[j];
        let now = self.now;
        self.s[i].put(to, item, now);
        self.advance(Duration::from_secs(1));
        self.s[i].put_answers.pop().expect("an answer").1
    }
}

/// A stored record of `item`, asked for at `asked`.
fn record(item: &Item, asked: u64) -> Vec<u8> {
    let mut r = vec![1];
    r.extend_from_slice(&asked.to_le_bytes());
    r.extend(item.encode());
    r
}

/// An item's entry ids, in its own order (by id, as a server sends them).
fn ids(item: &Item) -> Vec<[u8; 32]> {
    let mut v: Vec<[u8; 32]> = item.entries.iter().map(|e| e.entry.id()).collect();
    v.sort();
    v
}

fn chain_ids(c: &super::chain::Chain) -> Vec<[u8; 32]> {
    let mut v = c.ids.clone();
    v.sort();
    v
}

#[test]
fn items_messages_and_transfers_round_trip() {
    let mut b = Bitcoin::new(ROOM, 1);
    let (_, item) = b.title(1, "test123", t(20), &[t(5)], [9; 32]);
    let enc = item.encode();
    assert_eq!(Item::decode(&enc), Ok(item.clone()));
    // Two entries, two headers (each anchor's block), one zone: headers once each. An entry is 175 bytes and its
    // anchor's block one header.
    assert_eq!(
        enc.len(),
        1 + 32
            + 2
            + 2 * 80
            + 2
            + 2 * (175 + 2 + item.entries[0].anchor.as_ref().unwrap().0.encode().len() + 2 + 2)
            + 2
            + 366
    );
    for m in [
        Msg::Put(item.clone()),
        Msg::Items(vec![item.clone(), Item::default()]),
        Msg::Have(vec![[1; 32], [2; 32]]),
        Msg::Get {
            mode: GetMode::All,
            id: vec![7; 8],
            zone: (3, [1, 2, 3, 4]),
            held: vec![([1; 8], [2; 4])],
        },
        Msg::Sync {
            range: Range::ALL.child(3).child(15),
            fp: Default::default(),
            proof: None,
        },
        Msg::SyncAnswer(SyncAnswer::Listing(vec![([1; 8], [2; 8])])),
        Msg::Serve {
            nonce: [5; 16],
            entries: item.entries[..1].to_vec(),
            sig: [6; 64],
        },
    ] {
        assert_eq!(Msg::decode(&m.encode(42)), Ok((m, 42)));
    }
    let r = Range::ALL.child(0xa).child(0x5);
    assert_eq!(r.bounds().0[0], 0xa5);
    assert!(r.contains(&[0xa5; 32]) && !r.contains(&[0xa6; 32]));
    // A long message in parts, at most `IN_FLIGHT` (16) in flight, a third of the datagrams lost, resent.
    let (mut a, mut z) = (Transfers::default(), Transfers::default());
    let (ka, kz) = ([1; 32], [2; 32]);
    let msg: Vec<u8> = (0..20_000u32).map(|i| i as u8).collect();
    let mut now = Instant::now();
    a.send(kz, &msg, now);
    assert_eq!(a.out.len(), super::wire::IN_FLIGHT, "16 in flight");
    assert_eq!(super::wire::IN_FLIGHT, 16);
    let mut got = None;
    let mut n = 0u64;
    for _ in 0..200 {
        for (_, d) in std::mem::take(&mut a.out) {
            n += 1;
            if n.is_multiple_of(3) {
                continue;
            }
            if let Some((_, m)) = z.input(ka, &d, now) {
                got = Some(m);
            }
        }
        for (_, d) in std::mem::take(&mut z.out) {
            n += 1;
            if !n.is_multiple_of(3) {
                a.input(kz, &d, now);
            }
        }
        now += Duration::from_millis(600);
        assert!(a.tick(now).is_empty(), "nothing lost thrice in a row here");
        if got.is_some() {
            break;
        }
    }
    assert!(got.as_ref().is_some_and(|g| *g == msg), "the message whole");
}

/// What answers a question, at 1, 20 and 500 servers: the rounds' shares (1/64, 1/8, everyone),
/// the asker stopping at the first round that brings an answer.
#[test]
fn the_answer_rules_counts() {
    let mut b = Bitcoin::new(ROOM, 2);
    // Each server its own name, held long enough for the top tier: the share goes by the owner key served with.
    let titles: Vec<([u8; 32], Item)> = (0..500u32)
        .map(|k| {
            b.title(
                (k % 250) as u8 + 1,
                &format!("server{k}"),
                t(95),
                &[t(80), t(65), t(50), t(35), t(20), t(5)],
                [9; 32],
            )
        })
        .collect();
    let owners: Vec<[u8; 32]> = titles
        .iter()
        .map(|(_, it)| it.entries[0].entry.owner)
        .collect();
    let mut rows = Vec::new();
    for n in [1usize, 20, 500] {
        let servers: Vec<Server> = (0..n)
            .map(|i| {
                let (key, item) = titles[i].clone();
                let mut s = Server::new(ROOM, cfg(vec![Title { key, item }]), T);
                s.synced = true;
                s
            })
            .collect();
        let mut bus = Bus::new(servers);
        while bus.s.iter_mut().any(|s| s.poll().is_some()) {}
        const QUESTIONS: usize = 200;
        let (mut at_round, mut counts) = ([0usize; 3], [0usize; 3]);
        let mut silent = 0;
        for k in 0..QUESTIONS {
            let mut asker = [0xee; 32]; // a names client asks rarely: each question another's
            asker[..8].copy_from_slice(&(k as u64).to_le_bytes());
            let nonce: [u8; 16] = std::array::from_fn(|i| (k * 31 + i * 7) as u8 ^ (k >> 3) as u8);
            bus.now += Duration::from_secs(1); // the budget refills between questions
            let (now, unix) = (bus.now, bus.unix());
            let mut answered = false;
            for (r, spread) in SPREADS.iter().enumerate() {
                let mut c = 0;
                for i in 0..n {
                    let q = Question {
                        key: asker,
                        region: 0,
                        time: unix,
                        nonce,
                        spread: *spread,
                    };
                    bus.s[i].input(Input::Question { q, region: 0 }, now, unix);
                    while let Some(cmd) = bus.s[i].poll() {
                        if matches!(cmd, Cmd::CallBack { .. }) {
                            c += 1;
                            // The rule's share, from outside.
                            assert!(in_share(rank(&share_hash(&nonce, &owners[i])), *spread));
                        }
                    }
                    bus.s[i].input(Input::Gone(asker), now, unix);
                    while bus.s[i].poll().is_some() {}
                }
                counts[r] += c;
                if c > 0 {
                    at_round[r] += 1;
                    answered = true;
                    break;
                }
            }
            if !answered {
                silent += 1;
            }
        }
        let mean = |r: usize| counts[r] as f64 / at_round[r].max(1) as f64;
        rows.push(format!(
            "{n} servers: answered in round 1/2/3: {}/{}/{} of {QUESTIONS}, by {:.1}/{:.1}/{:.1} servers on average; none: {silent}",
            at_round[0],
            at_round[1],
            at_round[2],
            mean(0),
            mean(1),
            mean(2)
        ));
        assert_eq!(silent, 0, "everyone is asked in the third round");
        match n {
            1 => {
                assert!(
                    at_round[2] > QUESTIONS * 3 / 4,
                    "one server: mostly the third round"
                );
                assert!(counts.iter().sum::<usize>() == QUESTIONS);
            }
            20 => {
                assert!(
                    at_round[1] > QUESTIONS / 2,
                    "twenty: mostly the second round"
                );
                assert!((1.0..5.0).contains(&mean(1)));
            }
            500 => {
                assert!(at_round[0] >= QUESTIONS - 2, "500: the first round");
                assert!((5.0..11.0).contains(&mean(0)), "about eight: {}", mean(0));
            }
            _ => unreachable!(),
        }
    }
    for r in rows {
        eprintln!("{r}");
    }
}

#[test]
fn a_server_answers_within_its_rule_only() {
    let mut b = Bitcoin::new(ROOM, 3);
    let (key, item) = b.title(1, "mine", t(20), &[t(5)], [9; 32]);
    let mut bus = Bus::new(vec![Server::new(ROOM, cfg(vec![Title { key, item }]), T)]);
    while bus.s[0].poll().is_some() {}
    let ask = |bus: &mut Bus, n: u8, asker: u8| -> bool {
        let (now, unix) = (bus.now, bus.unix());
        let q = Question {
            key: [asker; 32],
            region: 0,
            time: unix,
            nonce: [n; 16],
            spread: 0,
        };
        bus.s[0].input(Input::Question { q, region: 0 }, now, unix);
        let mut called = false;
        while let Some(c) = bus.s[0].poll() {
            called |= matches!(c, Cmd::CallBack { .. });
        }
        called
    };
    // Before its first sync: nothing.
    assert!(!bus.s[0].synced);
    assert!(!ask(&mut bus, 1, 100), "not before its first sync");
    bus.s[0].synced = true;
    assert!(ask(&mut bus, 2, 100));
    // Its own budget: 4 a second.
    let mut n = 1;
    for k in 0..10u8 {
        n += ask(&mut bus, 10 + k, 110 + k) as usize;
    }
    assert_eq!(n, ANSWERS_PER_SECOND, "the budget");
    // 32 askers held at once; a newcomer takes the place of the one held longest.
    for k in 0..40u8 {
        bus.now += Duration::from_millis(300);
        ask(&mut bus, 50 + k, 150 + k);
    }
    bus.now += Duration::from_secs(1);
    assert!(
        ask(&mut bus, 99, 250),
        "past 32 askers, the one held longest makes room"
    );
    // A name that lapsed: nothing to serve with.
    let mut b = Bitcoin::new(ROOM, 4);
    let (key, item) = b.title(1, "lapsed", t(80), &[], [9; 32]);
    let mut bus = Bus::new(vec![Server::new(ROOM, cfg(vec![Title { key, item }]), T)]);
    bus.s[0].synced = true;
    while bus.s[0].poll().is_some() {}
    assert!(bus.s[0].reg.is_empty(), "a dead title isn't held");
    assert!(!ask(&mut bus, 1, 100), "no live name, no serve");
}

#[test]
fn serve_is_a_live_names_signature_over_the_nonce_and_the_servers_key() {
    let mut b = Bitcoin::new(ROOM, 5);
    let (key, item) = b.title(1, "mine", t(20), &[t(5)], [9; 32]);
    let mut s = Server::new(ROOM, cfg(vec![Title { key, item }]), T);
    let me = [7u8; 32];
    let now = Instant::now();
    s.start(me, now);
    s.synced = true;
    let nonce = [3u8; 16];
    let q = Question {
        key: [8; 32],
        region: 0,
        time: T,
        nonce,
        spread: 0,
    };
    s.input(Input::Question { q, region: 0 }, now, T);
    let mut z = Transfers::default();
    let mut serve = None;
    while let Some(c) = s.poll() {
        if let Cmd::Send { data, .. } = c
            && let Some((_, m)) = z.input(me, &data, now)
        {
            serve = Some(Msg::decode(&m).unwrap().0);
        }
    }
    let Some(Msg::Serve {
        nonce: n,
        entries: entry,
        sig,
    }) = serve
    else {
        panic!("a serve")
    };
    assert_eq!(n, nonce);
    let (names, p) = (b.names.clone(), b.params.clone());
    let check =
        |b: &mut Bitcoin, nonce: &[u8; 16], server: &[u8; 32], e: &[WireEntry], sig: &[u8; 64]| {
            let m = Msg::Serve {
                nonce: *nonce,
                entries: e.to_vec(),
                sig: *sig,
            };
            check_serve(&names, &p, &mut b.pow, &[3; 16], server, &m, T)
        };
    assert_eq!(check(&mut b, &nonce, &me, &entry, &sig).map(|_| ()), Ok(()));
    assert!(
        check(&mut b, &[4; 16], &me, &entry, &sig).is_err(),
        "another nonce"
    );
    assert!(
        check(&mut b, &nonce, &[6; 32], &entry, &sig).is_err(),
        "another server's key"
    );
    let mut forged = sig;
    forged[5] ^= 1;
    assert_eq!(
        check(&mut b, &nonce, &me, &entry, &forged),
        Err(Invalid::Signature)
    );
    // A dead name's key, signing properly.
    let k = b.key(2, "dead");
    let dead = b.at(Kind::Claim, &k, "dead", [0; 32], t(60));
    let msg = super::entry::tagged("waarm64/names/serve", &[&b.names.value, &nonce, &me]);
    let dsig = super::entry::sign(&k, &msg);
    let w = WireEntry::of(&dead);
    assert!(
        check(&mut b, &nonce, &me, &[w], &dsig).is_err(),
        "a dead name's key"
    );
    // The same name alive, the same way: taken.
    let alive = b.at(Kind::Claim, &k, "dead", [0; 32], t(10));
    let w = WireEntry::of(&alive);
    assert_eq!(
        check(&mut b, &nonce, &me, std::slice::from_ref(&w), &dsig).map(|_| ()),
        Ok(())
    );
    // One entry, the owning chain's last (R3: no run, no tier): two refuse the serve, at the check and at the wire.
    assert_eq!(entry.len(), 1, "the last entry alone");
    assert_eq!(entry[0].entry.kind, Kind::Renew, "the title's last entry");
    let off = b.at(Kind::Claim, &k, "dead", [0; 32], t(12));
    let both = [w.clone(), WireEntry::of(&off)];
    assert!(
        check(&mut b, &nonce, &me, &both, &dsig).is_err(),
        "two entries"
    );
    let long = Msg::Serve {
        nonce,
        entries: vec![entry[0].clone(); 2],
        sig,
    };
    assert!(Msg::decode(&long.encode(0)).is_err(), "two entries");
}

/// R3 (docs/plans/room-names-r3.md): "who serves?" is the plain draw again. A server answers and is kept by the hash of
/// its owner key alone: a name held for months ranks no better than one claimed yesterday (N5a's tiers are out).
#[test]
fn who_serves_is_the_plain_draw() {
    let mut b = Bitcoin::new(ROOM, 44);
    let (ok, old) = b.title(
        1,
        "old",
        t(120),
        &(1..8).map(|r| t(120 - 15 * r)).collect::<Vec<_>>(),
        [9; 32],
    );
    let (yk, young) = b.title(2, "young", t(2), &[], [9; 32]);
    let mk = |key, item| {
        let mut s = Server::new(ROOM, cfg(vec![Title { key, item }]), T);
        s.start([1; 32], Instant::now());
        s.synced = true;
        while s.poll().is_some() {}
        s
    };
    let (mut so, mut sy) = (mk(ok, old.clone()), mk(yk, young.clone()));
    let owner = |it: &Item| it.entries[0].entry.owner;
    let (oo, yo) = (owner(&old), owner(&young));
    let mut now = Instant::now();
    let (mut young_first, mut young_answers) = (0, 0);
    for k in 0..200u32 {
        now += Duration::from_secs(2);
        let nonce: [u8; 16] =
            std::array::from_fn(|i| (k as usize * 37 + i * 11) as u8 ^ (k >> 2) as u8);
        let mut asker = [0xee; 32];
        asker[..4].copy_from_slice(&k.to_le_bytes());
        let q = Question {
            key: asker,
            region: 0,
            time: T,
            nonce,
            spread: 3,
        };
        let answered = |s: &mut Server| {
            s.input(Input::Question { q, region: 0 }, now, T);
            let mut c = false;
            while let Some(cmd) = s.poll() {
                c |= matches!(cmd, Cmd::CallBack { .. });
            }
            s.input(Input::Gone(asker), now, T);
            while s.poll().is_some() {}
            c
        };
        let (a_old, a_young) = (answered(&mut so), answered(&mut sy));
        assert_eq!(a_old, in_share(rank(&share_hash(&nonce, &oo)), 3));
        assert_eq!(a_young, in_share(rank(&share_hash(&nonce, &yo)), 3));
        young_answers += a_young as usize;
        // Of the two, the asker keeps the lower hash, whatever the ages.
        let mut ask = super::server::Ask::new(nonce, now);
        ask.round = SPREADS.len();
        let co = ask.offer([1; 32], oo, old.id, now).unwrap();
        let cy = ask.offer([2; 32], yo, young.id, now).unwrap();
        young_first += (cy < co) as usize;
    }
    eprintln!(
        "the young name answered {young_answers} of 200 at 1/8, ranked first {young_first} of 200"
    );
    assert!(
        (10..=45).contains(&young_answers),
        "{young_answers}: about 1/8"
    );
    assert!(
        (70..=130).contains(&young_first),
        "{young_first}: about half"
    );
}

#[test]
fn a_worse_chain_is_refused_and_a_better_one_taken() {
    let mut b = Bitcoin::new(ROOM, 6);
    let mut bus = Bus::new(vec![
        Server::new(ROOM, cfg(vec![]), T),
        Server::new(ROOM, cfg(vec![]), T),
    ]);
    let id = b.names.name_id("contested");
    // The owner now: claimed 20 days ago, renewed 5 days ago.
    let (_, c1) = b.title(1, "contested", t(20), &[t(5)], [1; 32]);
    assert_eq!(bus.put(1, 0, c1.clone()), Msg::Taken);
    assert_eq!(
        chain_ids(bus.s[0].reg.get(&id).unwrap().owner.as_ref().unwrap()),
        ids(&c1)
    );
    // Another key's claim 10 days ago, alive but younger: refused, and the better one shown.
    let (_, c2) = b.title(2, "contested", t(10), &[], [2; 32]);
    let Msg::Better(shown) = bus.put(1, 0, c2.clone()) else {
        panic!("refused")
    };
    assert_eq!(ids(&shown), ids(&c1));
    assert_eq!(shown.zone, c1.zone, "with its zone");
    let held = bus.s[0].reg.get(&id).unwrap();
    assert!(
        ids(&c2).iter().all(|e| held.name.get(e).is_none()),
        "nothing of it kept"
    );
    assert_eq!(held.zone, c1.zone, "the zone isn't another key's");
    // A dead chain: refused.
    let (_, c3) = b.title(3, "contested", t(90), &[], [3; 32]);
    assert!(matches!(bus.put(1, 0, c3), Msg::Better(_)));
    // A better one, older and unbroken: taken, and the old owner's entries dropped.
    let (_, c0) = b.title(4, "contested", t(60), &[t(35), t(6)], [4; 32]);
    assert_eq!(bus.put(1, 0, c0.clone()), Msg::Taken);
    let held = bus.s[0].reg.get(&id).unwrap();
    assert_eq!(chain_ids(held.owner.as_ref().unwrap()), ids(&c0));
    assert!(ids(&c1).iter().all(|e| held.name.get(e).is_none()));
    assert_eq!(held.zone, c0.zone);
    // A renewal waiting for its anchor, on the owner's last entry: kept, and a later anchor for it.
    let k4 = b.key(4, "contested");
    let last = c0.entries.last().unwrap().entry.id();
    let mut r = b.entry(Kind::Renew, &k4, "contested", last);
    let mut pend = super::anchor::Pending {
        calendar: super::anchor::Calendar::Alice,
        ops: vec![super::anchor::Op::Sha256],
        sig: [0; 64],
    };
    super::entry::sign_pending(&k4, &b.names, &r.id(), &mut pend);
    assert!(r.offer_pending(pend));
    let it = b.item("contested", &[r.clone()], None);
    assert!(
        matches!(bus.put(1, 0, it), Msg::Better(_)),
        "not the owner's last yet"
    );
    let held = bus.s[0].reg.get(&id).unwrap();
    assert!(
        held.name
            .get(&r.id())
            .is_some_and(|e| e.pending().is_some()),
        "kept, pending"
    );
    let (a, h) = b.anchor(&r.id(), t(1) + HOUR);
    r.offer_anchor(a, h, &b.params, T).unwrap();
    let it = b.item("contested", &[r.clone()], None);
    assert_eq!(
        bus.put(1, 0, it),
        Msg::Taken,
        "it continues the owner's chain"
    );
    let o = bus.s[0].reg.get(&id).unwrap().owner.clone().unwrap();
    assert_eq!(o.last(), r.id());
    assert_eq!(o.ids.len(), 4, "the whole run");
}

#[test]
fn forged_anchors_headers_and_signatures_are_refused() {
    let mut b = Bitcoin::new(ROOM, 7);
    let mut bus = Bus::new(vec![
        Server::new(ROOM, cfg(vec![]), T),
        Server::new(ROOM, cfg(vec![]), T),
    ]);
    let k = b.key(1, "forged");
    let id = b.names.name_id("forged");
    let good = b.at(Kind::Claim, &k, "forged", [0; 32], t(10));
    let item = |_: &Bitcoin, w: WireEntry| Item {
        id,
        entries: vec![w],
        zone: None,
    };
    let refused = |bus: &mut Bus, it: Item| {
        let a = bus.put(1, 0, it);
        assert!(
            matches!(a, Msg::Better(ref x) if x.entries.is_empty()),
            "{a:?}"
        );
        assert!(bus.s[0].reg.get(&id).is_none(), "nothing kept");
    };
    // A signature broken.
    let mut w = WireEntry::of(&good);
    w.entry.sig[3] ^= 1;
    refused(&mut bus, item(&b, w));
    // Signed, but its proof of work short.
    let mut e = Entry::new(&b.names, Kind::Claim, id, good.entry.owner, [0; 32]);
    e.nonce = (0..)
        .find(|n| {
            let mut x = e.clone();
            x.nonce = *n;
            !b.pow.ok(&x)
        })
        .unwrap();
    e.sign(&k, &b.names);
    let mut w = WireEntry::of(&good);
    w.entry = e;
    refused(&mut bus, item(&b, w));
    // Another room's.
    let mut other = Bitcoin::new("another room", 8);
    let ok = other.key(1, "forged");
    let mut x = other.at(Kind::Claim, &ok, "forged", [0; 32], t(10));
    x.entry.name = id;
    refused(&mut bus, item(&b, WireEntry::of(&x)));
    // An anchor header whose work is broken; one that doesn't reach the root: the entry is
    // unanchored, a claim without a time, so nothing is kept.
    let mut w = WireEntry::of(&good);
    w.anchor.as_mut().unwrap().1.0[40] ^= 1;
    refused(&mut bus, item(&b, w));
    let mut w = WireEntry::of(&good);
    w.anchor.as_mut().unwrap().0.ops[0] = super::anchor::Op::Append(vec![0; 16]);
    refused(&mut bus, item(&b, w));
    // A header from the future.
    let mut w = WireEntry::of(&good);
    let (a, h) = b.anchor(&good.id(), (T + 3 * HOUR as u64) as u32);
    w.anchor = Some((a, h));
    refused(&mut bus, item(&b, w));
    // The real one is taken; a zone signed by another key, or broken, isn't (the zone not taken: `better`).
    let other_key = b.key(2, "forged");
    let z = Zone::seal(&b.names, &other_key, "forged", 9, &[(None, [5; 32])], false).unwrap();
    let mut it = item(&b, WireEntry::of(&good));
    it.zone = Some(z);
    assert!(matches!(bus.put(1, 0, it), Msg::Better(_)));
    assert_eq!(bus.s[0].reg.get(&id).unwrap().zone, None);
    let mut z = Zone::seal(&b.names, &k, "forged", 9, &[(None, [5; 32])], false).unwrap();
    z.sig[0] ^= 1;
    let mut it = item(&b, WireEntry::of(&good));
    it.zone = Some(z);
    bus.put(1, 0, it);
    assert_eq!(bus.s[0].reg.get(&id).unwrap().zone, None);
    let z = Zone::seal(&b.names, &k, "forged", 9, &[(None, [5; 32])], false).unwrap();
    let mut it = item(&b, WireEntry::of(&good));
    it.zone = Some(z.clone());
    bus.put(1, 0, it);
    assert_eq!(bus.s[0].reg.get(&id).unwrap().zone, Some(z));
}

#[test]
fn verification_goes_in_slices() {
    let mut b = Bitcoin::new(ROOM, 9);
    let renewals: Vec<u32> = (1..20).map(|k| t(400) + k * 20 * DAY).collect();
    let (_, long) = b.title(1, "long", t(400), &renewals, [1; 32]);
    assert!(renewals.last().is_some_and(|r| *r > t(30)));
    let mut bus = Bus::new(vec![
        Server::new(ROOM, cfg(vec![]), T),
        Server::new(ROOM, cfg(vec![]), T),
    ]);
    let to = bus.keys[0];
    let now = bus.now;
    bus.s[1].put(to, long.clone(), now);
    bus.run();
    // Each tick checks a slice; count the ticks until it's kept.
    let mut ticks = 0;
    while bus.s[0].reg.is_empty() {
        assert!(bus.s[0].busy());
        let (now, unix) = (bus.now, bus.unix());
        bus.s[0].tick(now, unix);
        bus.run();
        ticks += 1;
        assert!(ticks < 100);
    }
    // About six entries a turn (~4 ms of Chromium's wasm), so 20 take four turns.
    assert_eq!(UNITS_PER_TURN, 24);
    assert!(ticks >= 4, "{ticks} ticks for 20 entries");
    assert_eq!(
        bus.s[0]
            .reg
            .items
            .values()
            .next()
            .unwrap()
            .owner
            .as_ref()
            .unwrap()
            .ids
            .len(),
        20
    );
}

#[test]
fn records_load_back_as_they_were() {
    let mut b = Bitcoin::new(ROOM, 10);
    let mut bus = Bus::new(vec![
        Server::new(ROOM, cfg(vec![]), T),
        Server::new(ROOM, cfg(vec![]), T),
    ]);
    for (k, n) in ["one", "two", "three"].iter().enumerate() {
        let (_, it) = b.title(k as u8 + 1, n, t(20), &[t(4)], [k as u8; 32]);
        assert_eq!(bus.put(1, 0, it), Msg::Taken);
    }
    let stored: Vec<Vec<u8>> = bus.stored[0].values().flatten().cloned().collect();
    assert_eq!(stored.len(), 3);
    let mut fresh = Server::new(ROOM, cfg(vec![]), T);
    for r in &stored {
        assert!(fresh.load(r, T));
        assert!(read_record(r).is_some());
    }
    let versions: BTreeMap<_, _> = fresh
        .reg
        .items
        .iter()
        .map(|(i, h)| (*i, h.version))
        .collect();
    assert_eq!(versions, bus.reg(0));
    assert_eq!(fresh.reg.bytes, bus.s[0].reg.bytes);
}

#[test]
fn the_bound_drops_the_longest_unasked_never_its_own() {
    let mut b = Bitcoin::new(ROOM, 11);
    let (key, own) = b.title(1, "own", t(20), &[t(4)], [1; 32]);
    let own_id = own.id;
    // Its own name was last asked for longest ago.
    let mut s = Server::new(
        ROOM,
        Config {
            max_names: 4,
            ..cfg(vec![Title { key, item: own }])
        },
        T - 10 * HOUR as u64,
    );
    let mut others = Vec::new();
    for k in 0..5u8 {
        let (_, it) = b.title(k + 2, &format!("other{k}"), t(20), &[t(4)], [k; 32]);
        others.push(it.id);
        assert!(s.load(&record(&it, T - (5 - k as u64) * HOUR as u64), T));
    }
    let held: Vec<[u8; 32]> = s.reg.items.keys().copied().collect();
    assert_eq!(held.len(), 4);
    assert!(held.contains(&own_id), "never its own");
    assert!(
        !held.contains(&others[0]) && !held.contains(&others[1]),
        "the longest unasked"
    );
    let mut deleted = Vec::new();
    while let Some(c) = s.poll() {
        if let Cmd::Store { id, record: None } = c {
            deleted.push(id);
        }
    }
    assert_eq!(
        deleted,
        vec![others[0], others[1]],
        "deleted from the store too"
    );
    // A member asks for other2; a new name comes: other3 (now the longest unasked) goes.
    let mut bus = Bus::new(vec![s, Server::new(ROOM, cfg(vec![]), T)]);
    let (to, now) = (bus.keys[0], bus.now);
    let get = Msg::Get {
        mode: GetMode::Owner,
        id: others[2].to_vec(),
        zone: (0, [0; 4]),
        held: vec![],
    };
    let mut x = Transfers::default();
    x.send(to, &get.encode(0), now);
    for (_, d) in x.out {
        let from = [0xdd; 32]; // a member
        let unix = bus.unix() + 3600;
        bus.s[0].input(Input::Datagram { from, data: d }, now, unix);
    }
    bus.run();
    let (_, it) = b.title(9, "newcomer", t(20), &[t(4)], [9; 32]);
    assert_eq!(bus.put(1, 0, it.clone()), Msg::Taken);
    let held: Vec<[u8; 32]> = bus.s[0].reg.items.keys().copied().collect();
    assert!(held.contains(&own_id) && held.contains(&others[2]) && held.contains(&it.id));
    assert!(!held.contains(&others[3]), "other3 went");
    // By bytes too.
    let mut s = Server::new(
        ROOM,
        Config {
            max_bytes: 3 * bus.s[0].reg.get(&own_id).unwrap().bytes + 10,
            ..cfg(vec![])
        },
        T,
    );
    for k in 0..5u8 {
        let (_, it) = b.title(k + 20, &format!("bytes{k}"), t(20), &[t(4)], [k; 32]);
        s.load(&record(&it, T - (5 - k as u64) * HOUR as u64), T);
    }
    assert!(s.reg.len() <= 3 && s.reg.bytes <= 3 * 2600);
}

/// Junk registered in bulk (young chains), arriving after the room's names and asked for lately by its registrant,
/// is what the bound drops: the youngest chains first, asks only between chains of one age (NAMES loop 6a: with the
/// longest unasked first, a bulk registration's arrival alone dropped the room's names that nobody had asked for
/// since they came).
#[test]
fn the_bound_drops_young_chains_before_old_ones_however_asked() {
    let mut b = Bitcoin::new(ROOM, 12);
    let mut s = Server::new(
        ROOM,
        Config {
            max_names: 6,
            ..cfg(vec![])
        },
        T,
    );
    // The room's names: claimed weeks ago, last asked for a day ago.
    let mut honest = Vec::new();
    for k in 0..4u8 {
        let (_, it) = b.title(
            k + 2,
            &format!("honest{k}"),
            t(20) + k as u32 * HOUR,
            &[t(4)],
            [k; 32],
        );
        honest.push(it.id);
        assert!(s.load(&record(&it, T - DAY as u64), T));
    }
    // Junk claimed in the last hour: two asked for lately by its registrant, two arriving now.
    let mut junk = Vec::new();
    for k in 0..2u8 {
        let (_, it) = b.title(
            50,
            &format!("junk{k}"),
            T as u32 - HOUR + k as u32 * 60,
            &[],
            [k; 32],
        );
        junk.push(it.id);
        s.load(&record(&it, T), T);
    }
    let mut bus = Bus::new(vec![s, Server::new(ROOM, cfg(vec![]), T)]);
    for k in 2..4u8 {
        let (_, it) = b.title(
            50,
            &format!("junk{k}"),
            T as u32 - HOUR + k as u32 * 60,
            &[],
            [k; 32],
        );
        junk.push(it.id);
        bus.put(1, 0, it);
    }
    let held: Vec<[u8; 32]> = bus.s[0].reg.items.keys().copied().collect();
    assert_eq!(held.len(), 6);
    for h in &honest {
        assert!(held.contains(h), "a room's name dropped for junk");
    }
    // Among the junk, one age: the latest claims go first.
    assert!(held.contains(&junk[0]) && held.contains(&junk[1]));
}

/// Servers that sync: everything each holds reaches the others; a server that leaves names out
/// (it never keeps them) takes nothing from the others and the newcomer gets them elsewhere.
#[test]
fn servers_sync_and_a_server_that_leaves_names_out() {
    let mut b = Bitcoin::new(ROOM, 12);
    let titles: Vec<(([u8; 32], Item), &str)> = ["alpha", "bravo", "charlie"]
        .iter()
        .enumerate()
        .map(|(k, n)| (b.title(k as u8 + 1, n, t(20), &[t(4)], [k as u8; 32]), *n))
        .collect();
    let mk = |k: usize| {
        let ((key, item), _) = &titles[k];
        Server::new(
            ROOM,
            cfg(vec![Title {
                key: *key,
                item: item.clone(),
            }]),
            T,
        )
    };
    let (mut liar, mut honest, newcomer) = (mk(0), mk(1), mk(2));
    // The honest server holds 40 more names, enough to descend into ranges; the liar leaves
    // them out.
    let mut extra = Vec::new();
    for k in 0..40u8 {
        let (_, it) = b.title(k + 10, &format!("extra{k}"), t(20), &[t(4)], [k; 32]);
        extra.push(it.id);
        honest.load(&record(&it, T), T);
        liar.refuse.insert(it.id);
    }
    let mut bus = Bus::new(vec![liar, honest, newcomer]);
    // The first round: nobody synced, nobody answers; the next, everyone finds everyone.
    bus.advance(Duration::from_secs(40));
    bus.advance(Duration::from_secs(12 * 60));
    let (l, h, n) = (bus.reg(0), bus.reg(1), bus.reg(2));
    assert_eq!(h, n, "the newcomer holds what the honest server holds");
    assert_eq!(h.len(), 43);
    assert!(
        extra.iter().all(|e| !l.contains_key(e)),
        "the liar still leaves them out"
    );
    assert_eq!(l.len(), 3, "it holds the titles");
    assert!(bus.s.iter().all(|s| s.synced));
    // A member's get for one of them: the liar says none, the honest server has it (the member,
    // asking two servers, takes the answer that has one: N3).
    let get = Msg::Get {
        mode: GetMode::Owner,
        id: extra[0].to_vec(),
        zone: (0, [0; 4]),
        held: vec![],
    };
    for (j, expect) in [(0usize, 0usize), (1, 1)] {
        let mut x = Transfers::default();
        let now = bus.now;
        x.send(bus.keys[j], &get.encode(0), now);
        let member = [0xdd; 32];
        let unix = bus.unix();
        for (_, d) in std::mem::take(&mut x.out) {
            bus.s[j].input(
                Input::Datagram {
                    from: member,
                    data: d,
                },
                now,
                unix,
            );
        }
        let mut answer = None;
        while let Some(c) = bus.s[j].poll() {
            if let Cmd::Send { to, data } = c
                && to == member
                && let Some((_, m)) = x.input(bus.keys[j], &data, now)
            {
                answer = Some(Msg::decode(&m).unwrap().0);
            }
        }
        let Some(Msg::Items(items)) = answer else {
            panic!("an answer")
        };
        assert_eq!(items.len(), expect, "server {j}");
    }
}

/// N0c found two servers that start within a second each waiting 30 s for the other: each one's question came while
/// the other's own was open and it wasn't synced yet, so both found nobody. A server that refused a question for that
/// asks again within seconds (room-names.md "Finding a server", "Nobody answered").
#[test]
fn servers_that_start_together_find_each_other_within_seconds() {
    let mut b = Bitcoin::new(ROOM, 52);
    let titles: Vec<([u8; 32], Item)> = ["alpha", "bravo"]
        .iter()
        .enumerate()
        .map(|(k, n)| b.title(k as u8 + 1, n, t(20), &[t(4)], [k as u8; 32]))
        .collect();
    for ms in [0u64, 100, 300, 700, 1000, 1400, 1900, 2400, 3000] {
        let mk = |k: usize| {
            let (key, item) = &titles[k];
            Server::new(
                ROOM,
                cfg(vec![Title {
                    key: *key,
                    item: item.clone(),
                }]),
                T,
            )
        };
        let skew = Duration::from_millis(ms);
        let mut bus = Bus::staggered(vec![mk(0), mk(1)], &[Duration::ZERO, skew]);
        let mut took = None;
        for step in 1..=60 {
            bus.advance(Duration::from_millis(500));
            if bus.reg(0).len() == 2 && bus.reg(1).len() == 2 {
                took = Some(Duration::from_millis(500 * step));
                break;
            }
        }
        let took = took.unwrap_or_else(|| panic!("started {ms} ms apart: not synced within 30 s"));
        eprintln!("started {ms} ms apart: both hold both names {took:?} after the second start");
        assert!(
            took <= Duration::from_secs(10),
            "started {ms} ms apart: each held the other's name {took:?} after the second start"
        );
    }
}

/// A first sync over a public region's round trip (95 ms) is bound by what is in flight: a run's `get`s (one name
/// each) and the transfer window under them (NAMES loop 6b: through the rig's derper behind a 95 ms shaper, 4 `get`s
/// and 8 parts moved 0.72 Mbit/s, 8 and 16 1.44, 16 and 32 2.9 with the derper's queue dropping). Items of two parts.
#[test]
fn a_first_sync_over_a_round_trip_keeps_eight_gets_in_flight() {
    let mut b = Bitcoin::new(ROOM, 54);
    let mut points: Vec<(Option<&str>, [u8; 32])> = vec![(None, [7; 32])];
    let labels = ["git", "www", "mail", "files", "chat", "wiki"];
    for (k, l) in labels.iter().enumerate() {
        points.push((Some(l), [k as u8 + 1; 32]));
    }
    let (ka, ia) = b.title(1, "alpha", t(20), &[t(4)], [1; 32]);
    let (kb, ib) = b.title(2, "bravo", t(20), &[t(4)], [2; 32]);
    let mut a = Server::new(ROOM, cfg(vec![Title { key: ka, item: ia }]), T);
    let n = 400;
    let mut bytes = 0;
    for k in 0..n {
        let name = format!("wide{k}");
        let key = b.key(9, &name);
        let claim = b.at(Kind::Claim, &key, &name, [0; 32], t(20));
        let renew = b.at(Kind::Renew, &key, &name, claim.id(), t(4));
        let zone = Zone::seal(&b.names, &key, &name, 1, &points, true).unwrap();
        let item = b.item(&name, &[claim, renew], Some(zone));
        bytes += item.encode().len();
        assert!(a.load(&record(&item, T), T));
    }
    assert!(bytes / n > super::wire::PART_DATA, "items of two parts");
    let nb = Server::new(ROOM, cfg(vec![Title { key: kb, item: ib }]), T);
    let mut bus = Bus::staggered(vec![a, nb], &[Duration::ZERO, Duration::from_secs(5)]);
    bus.delay = Duration::from_millis(47);
    let (mut first, mut all) = (None, None);
    for step in 1..=600u64 {
        bus.advance(Duration::from_millis(500));
        let held = bus.reg(1).len();
        if held > 2 && first.is_none() {
            first = Some(step);
        }
        if held == n + 2 {
            all = Some(step);
            break;
        }
    }
    let (first, all) = (first.expect("a first name"), all.expect("every name"));
    let took = Duration::from_millis(500 * (all - first));
    eprintln!(
        "{n} names of ~{} bytes over a 94 ms round trip: {took:?}",
        bytes / n
    );
    // 4 gets a round trip (as before N6b): ~9.5 s; 8: ~4.7 s.
    assert!(took <= Duration::from_secs(7), "{took:?}");
}

/// Quick rounds (a round that brought names is followed by the next within a minute) are a few in a row at most: a
/// partner that always has something new doesn't keep a server asking every 30 s.
#[test]
fn quick_rounds_are_a_few_in_a_row() {
    let mut b = Bitcoin::new(ROOM, 53);
    let mk = |b: &mut Bitcoin, k: u8, n: &str| {
        let (key, item) = b.title(k, n, t(20), &[t(4)], [k; 32]);
        Server::new(ROOM, cfg(vec![Title { key, item }]), T)
    };
    let (s0, s1) = (mk(&mut b, 1, "alpha"), mk(&mut b, 2, "bravo"));
    let mut bus = Bus::new(vec![s0, s1]);
    // Server 1 gets a new name every 20 s (its owner's put, say), for 30 minutes.
    let mut k = 0u32;
    while bus.now < bus.t0 + Duration::from_secs(1800) {
        let (_, it) = b.title(3, &format!("fresh{k}"), t(20), &[t(4)], [3; 32]);
        k += 1;
        let unix = bus.unix();
        assert!(bus.s[1].load(&record(&it, unix), unix));
        bus.advance(Duration::from_secs(20));
    }
    let rounds = bus.s[0].stats.rounds;
    eprintln!("a partner with a new name every 20 s: {rounds} rounds in 30 minutes");
    // 8 quick rounds (~5 minutes), then one every 5 minutes: ~13; each every 30 to 40 s would be ~50.
    assert!(rounds <= 18, "{rounds} rounds in 30 minutes");
    assert!(rounds >= 9, "{rounds} rounds: the quick ones came");
}

#[test]
fn an_entry_held_takes_a_new_anchor_only_when_earlier() {
    let mut b = Bitcoin::new(ROOM, 13);
    let k = b.key(1, "anchors");
    let mut late = b.entry(Kind::Claim, &k, "anchors", [0; 32]);
    let id = late.id();
    let mut early = late.clone();
    let (a, h) = b.anchor(&id, t(10) + 3 * HOUR);
    late.offer_anchor(a, h, &b.params, T).unwrap();
    let (a, h) = b.anchor(&id, t(10) + HOUR);
    early.offer_anchor(a, h, &b.params, T).unwrap();
    let mut bus = Bus::new(vec![
        Server::new(ROOM, cfg(vec![]), T),
        Server::new(ROOM, cfg(vec![]), T),
    ]);
    assert_eq!(
        bus.put(1, 0, b.item("anchors", &[late.clone()], None)),
        Msg::Taken
    );
    bus.put(1, 0, b.item("anchors", &[early.clone()], None));
    let held = |bus: &Bus| -> Stamped {
        bus.s[0]
            .reg
            .get(&b.names.name_id("anchors"))
            .unwrap()
            .name
            .get(&id)
            .unwrap()
            .clone()
    };
    assert_eq!(held(&bus).time(), early.time(), "the earlier anchor");
    bus.put(1, 0, b.item("anchors", &[late], None));
    assert_eq!(
        held(&bus).time(),
        early.time(),
        "a later one changes nothing"
    );
}

// ---- Review 1's findings (NAMES-REVIEW-1.md, deleted once all were fixed: git history has it) ----

/// A server with nothing of its own (`victim`) asks; a fake partner serves its question with a live name, then
/// answers each of its `sync`s with `answer(range)`, at most `max` of them, and nothing else. The victim, the syncs
/// and the `get`s the partner was sent.
fn partner_answers(answer: impl Fn(&Range) -> SyncAnswer, max: usize) -> (Server, usize, usize) {
    let (v, syncs, gets, _) = partner_answers_with(vec![], answer, max, &mut |_, _, _, _| {});
    (v, syncs, gets)
}

/// As [`partner_answers`], and `first_sync` is called when the victim's first `sync` comes. Also whether verification
/// was still waiting when the victim first counted as synced.
fn partner_answers_with(
    titles: Vec<Title>,
    answer: impl Fn(&Range) -> SyncAnswer,
    max: usize,
    first_sync: &mut dyn FnMut(&mut Server, &Msg, Instant, u64),
) -> (Server, usize, usize, bool) {
    let mut b = Bitcoin::new(ROOM, 40);
    let (key, item) = b.title(1, "partner", t(20), &[t(5)], [9; 32]);
    let sk = k256::schnorr::SigningKey::from_bytes(&key).unwrap();
    let last = item.entries.last().unwrap().clone();
    let mut v = Server::new(ROOM, cfg(titles), T);
    let (vk, pk) = ([0x11; 32], [0x22; 32]);
    let t0 = Instant::now();
    let mut now = t0;
    v.start(vk, now);
    let mut x = Transfers::default();
    let (mut syncs, mut gets) = (0, 0);
    for _ in 0..(4 * max + 2000) {
        let unix = T + now.duration_since(t0).as_secs();
        let mut moved = false;
        while let Some(c) = v.poll() {
            moved = true;
            match c {
                Cmd::Publish { nonce, spread: 0 } => {
                    let h =
                        super::entry::tagged("waarm64/names/serve", &[&b.names.value, &nonce, &pk]);
                    let m = Msg::Serve {
                        nonce,
                        entries: vec![last.clone()],
                        sig: super::entry::sign(&sk, &h),
                    };
                    x.send(vk, &m.encode(0), now);
                }
                Cmd::Send { to, data } if to == pk => {
                    if let Some((xid, m)) = x.input(vk, &data, now) {
                        let msg = Msg::decode(&m).unwrap().0;
                        match &msg {
                            Msg::Sync { range, .. } => {
                                let range = *range;
                                syncs += 1;
                                if syncs == 1 {
                                    first_sync(&mut v, &msg, now, unix);
                                }
                                if syncs <= max {
                                    x.send(vk, &Msg::SyncAnswer(answer(&range)).encode(xid), now);
                                }
                            }
                            Msg::Get { .. } => gets += 1,
                            _ => {}
                        }
                    }
                }
                _ => {}
            }
        }
        for (_, d) in std::mem::take(&mut x.out) {
            moved = true;
            v.input(Input::Datagram { from: pk, data: d }, now, unix);
        }
        if syncs > max || v.synced {
            break;
        }
        if !moved {
            now = v
                .deadline()
                .map_or(now + Duration::from_millis(100), |d| d.max(now));
            v.tick(now, T + now.duration_since(t0).as_secs());
        }
    }
    let busy = v.busy();
    (v, syncs, gets, busy)
}

#[test]
fn a_partner_answering_children_past_the_last_nibble_ends_the_run() {
    // One path down: the first sixteenth differs, the rest are empty as the victim's are. At depth 64 a range is one id
    // and has no sixteenths.
    let mut one = [super::wire::Fp::default(); 16];
    one[0] = super::wire::Fp {
        hash: [1; 8],
        count: 1,
    };
    let (v, syncs, _) = partner_answers(|_| SyncAnswer::Children(one), 200);
    assert!(syncs <= 64, "{syncs} syncs");
    let leaf = Range {
        depth: 64,
        prefix: [0xab; 32],
    };
    assert_eq!(leaf.child(3), leaf, "one id: no sixteenths");
    assert!(v.synced, "the round with it ended");
}

#[test]
fn a_partner_whose_ranges_never_stop_differing_is_bounded() {
    let all = [super::wire::Fp {
        hash: [1; 8],
        count: 1,
    }; 16];
    // Every sixteenth differs down to depth 4 (69,905 ranges), then the same.
    let answer = |r: &Range| {
        if r.depth < 4 {
            SyncAnswer::Children(all)
        } else {
            SyncAnswer::Same
        }
    };
    let (v, syncs, _) = partner_answers(answer, 20_000);
    assert!(syncs < 10_000, "{syncs} syncs");
    assert!(v.synced, "the round with it ended");
}

#[test]
fn a_listing_longer_than_a_listing_may_be_ends_the_run() {
    let long: Vec<([u8; 8], [u8; 8])> = (0..5000u64).map(|k| (k.to_be_bytes(), [1; 8])).collect();
    let (v, _, gets) = partner_answers(|_| SyncAnswer::Listing(long.clone()), 10);
    assert_eq!(gets, 0, "no gets for it");
    assert!(v.synced, "the round with it ended");
}

#[test]
fn a_peers_incomplete_transfers_hold_at_most_their_budget() {
    // 16 transfers of ~1 MiB each opened with one part, then filled: what is acknowledged (so buffered) stays within
    // 2 MiB and a bit.
    let mut z = Transfers::default();
    let from = [3u8; 32];
    let now = Instant::now();
    let parts = super::wire::MAX_MESSAGE / super::wire::PART_DATA;
    let part = |id: u32, k: usize| {
        let mut d = vec![0u8];
        d.extend_from_slice(&id.to_le_bytes());
        d.extend_from_slice(&(k as u16).to_le_bytes());
        d.extend_from_slice(&(parts as u16).to_le_bytes());
        d.extend_from_slice(&[7u8; super::wire::PART_DATA]);
        d
    };
    fn feed(z: &mut Transfers, from: [u8; 32], d: &[u8], now: Instant) -> usize {
        z.input(from, d, now);
        std::mem::take(&mut z.out).len()
    }
    let mut acked = 0usize;
    for id in 1..=16 {
        acked += feed(&mut z, from, &part(id, 0), now);
    }
    for id in 1..=16 {
        for k in 1..parts - 1 {
            acked += feed(&mut z, from, &part(id, k), now);
        }
    }
    let bytes = acked * super::wire::PART_DATA;
    assert!(
        bytes <= 2 * super::wire::MAX_MESSAGE + super::wire::PART_DATA,
        "{bytes} bytes buffered"
    );
    // Incomplete transfers expire: a minute later a new one is taken again.
    let later = now + Duration::from_secs(60);
    z.tick(later);
    assert_eq!(
        feed(&mut z, from, &part(100, 0), later),
        1,
        "room again once the stale ones expired"
    );
}

#[test]
fn a_lapsed_record_isnt_taken_at_load() {
    let mut b = Bitcoin::new(ROOM, 41);
    let (_, old) = b.title(1, "lapsed", t(200), &[], [1; 32]);
    let (_, live) = b.title(2, "alive", t(20), &[t(4)], [2; 32]);
    let mut s = Server::new(ROOM, cfg(vec![]), T);
    assert!(
        !s.load(&record(&old, T), T),
        "nothing of it is held, so the page deletes it"
    );
    assert!(s.load(&record(&live, T), T));
    assert_eq!(s.reg.len(), 1);
}

#[test]
fn a_chain_whose_first_time_is_a_little_ahead_is_kept() {
    // A block's time may run up to `drift` past now: a claim anchored 30 minutes ahead of the server's clock.
    let mut b = Bitcoin::new(ROOM, 42);
    let mut bus = Bus::new(vec![
        Server::new(ROOM, cfg(vec![]), T),
        Server::new(ROOM, cfg(vec![]), T),
    ]);
    let k = b.key(1, "early");
    let ahead = b.at(Kind::Claim, &k, "early", [0; 32], T as u32 + 1800);
    let it = b.item("early", std::slice::from_ref(&ahead), None);
    assert_eq!(bus.put(1, 0, it), Msg::Taken);
    let h = bus.s[0].reg.get(&b.names.name_id("early")).unwrap();
    assert_eq!(h.owner.as_ref().map(|o| o.last()), Some(ahead.id()));
}

/// A message's datagrams as a sender makes them, all at once (no window): kind 0, the transfer, the part, the parts.
fn datagrams(id: u32, payload: &[u8]) -> Vec<Vec<u8>> {
    let chunks: Vec<&[u8]> = payload.chunks(super::wire::PART_DATA).collect();
    let n = chunks.len();
    chunks
        .iter()
        .enumerate()
        .map(|(k, c)| {
            let mut d = vec![0u8];
            d.extend_from_slice(&id.to_le_bytes());
            d.extend_from_slice(&(k as u16).to_le_bytes());
            d.extend_from_slice(&(n as u16).to_le_bytes());
            d.extend_from_slice(c);
            d
        })
        .collect()
}

/// Server `s` gets message `m` (transfer `id`) from `from`; the messages it sends `from` back.
fn exchange(s: &mut Server, from: [u8; 32], id: u32, m: &Msg, now: Instant, unix: u64) -> Vec<Msg> {
    let mut x = Transfers::default();
    let mut got = Vec::new();
    for d in datagrams(id, &m.encode(0)) {
        s.input(Input::Datagram { from, data: d }, now, unix);
    }
    for _ in 0..100 {
        s.tick(now, unix);
        let mut any = false;
        while let Some(c) = s.poll() {
            if let Cmd::Send { to, data } = c
                && to == from
            {
                any = true;
                if let Some((_, p)) = x.input([0; 32], &data, now) {
                    got.push(Msg::decode(&p).unwrap().0);
                }
            }
        }
        // Our acknowledgements back, so the rest comes.
        for (_, d) in std::mem::take(&mut x.out) {
            s.input(Input::Datagram { from, data: d }, now, unix);
        }
        if !any && !s.busy() {
            break;
        }
    }
    got
}

#[test]
fn junk_handshakes_dont_shut_servers_out_of_a_questions_window() {
    use super::server::{ACCEPT_MAX, AcceptWindow};
    let mut w = AcceptWindow::default();
    let t0 = Instant::now();
    w.open(t0 + Duration::from_millis(2500), ACCEPT_MAX);
    // Junk handshakes fill the window as soon as the question is out; one of them is a real server's.
    for k in 0..ACCEPT_MAX as u8 {
        assert!(w.room(&[250; 32], t0));
        assert_eq!(w.admit([k; 32], t0), None);
    }
    w.served(&[0; 32], 5);
    // An honest server's call back a second later: a session that never served is let go for it.
    let t1 = t0 + Duration::from_millis(1100);
    assert!(w.room(&[250; 32], t1), "room for a server's call back");
    let gone = w.admit([200; 32], t1);
    assert!(
        gone.is_some_and(|g| g != [0; 32]),
        "{gone:?}: one that never served goes, not the one that did"
    );
    // Keys just let in hold their place for a while; the window closes with the question.
    for k in 0..(ACCEPT_MAX - 2) as u8 {
        assert!(w.room(&[250; 32], t1));
        w.admit([100 + k; 32], t1);
    }
    assert!(
        !w.room(&[250; 32], t1 + Duration::from_millis(100)),
        "everyone in it new or served"
    );
    assert!(!w.room(&[250; 32], t0 + Duration::from_millis(2500)));
}

/// Review 2's finding 2: cheap registrations that answer first and serve properly mustn't fill every place. With the
/// window full of keys that served, a newcomer takes the place of the worst ranked, never of the best two.
#[test]
fn served_keys_ranked_worst_make_room_but_the_best_two_stay() {
    use super::server::{ACCEPT_MAX, AcceptWindow};
    let mut w = AcceptWindow::default();
    let t0 = Instant::now();
    w.open(t0 + Duration::from_millis(2500), ACCEPT_MAX);
    for k in 0..ACCEPT_MAX as u8 {
        assert!(w.room(&[250; 32], t0));
        assert_eq!(w.admit([k; 32], t0), None);
        w.served(&[k; 32], 1000 - k as u128); // the later, the better
    }
    let t1 = t0 + Duration::from_millis(100);
    assert!(
        w.room(&[250; 32], t1),
        "room for an honest server answering late"
    );
    assert_eq!(
        w.admit([200; 32], t1),
        Some([0; 32]),
        "the worst ranked goes"
    );
    w.served(&[200; 32], 1);
    for _ in 0..40 {
        let g = w.admit([201; 32], t1).expect("room");
        assert!(
            g != [200; 32] && g != [ACCEPT_MAX as u8 - 1; 32],
            "{g:?}: one of the best two"
        );
        w.served(&[201; 32], 2000);
    }
}

#[test]
fn junk_doesnt_keep_an_asker_and_a_full_server_still_answers() {
    let mut b = Bitcoin::new(ROOM, 43);
    let (key, item) = b.title(1, "busy", t(20), &[t(5)], [9; 32]);
    let mut bus = Bus::new(vec![Server::new(ROOM, cfg(vec![Title { key, item }]), T)]);
    bus.s[0].synced = true;
    while bus.s[0].poll().is_some() {}
    let ask = |bus: &mut Bus, n: u8, asker: [u8; 32]| -> bool {
        bus.now += Duration::from_millis(300); // the budget: 4 a second
        let (now, unix) = (bus.now, bus.unix());
        let q = Question {
            key: asker,
            region: 0,
            time: unix,
            nonce: [n; 16],
            spread: 0,
        };
        bus.s[0].input(Input::Question { q, region: 0 }, now, unix);
        let mut called = false;
        while let Some(c) = bus.s[0].poll() {
            called |= matches!(c, Cmd::CallBack { .. });
        }
        called
    };
    let key = |k: u8| [k; 32];
    for k in 0..32u8 {
        assert!(ask(&mut bus, k, key(100 + k)));
    }
    // Each asker sends junk (no transfer part) every 30 s for 3 minutes.
    for _ in 0..6 {
        bus.now += Duration::from_secs(30);
        let (now, unix) = (bus.now, bus.unix());
        for k in 0..32u8 {
            bus.s[0].input(
                Input::Datagram {
                    from: key(100 + k),
                    data: vec![9; 20],
                },
                now,
                unix,
            );
        }
        bus.s[0].tick(now, unix);
        while bus.s[0].poll().is_some() {}
    }
    assert_eq!(bus.s[0].askers(), 0, "junk kept nobody");
    assert!(ask(&mut bus, 200, key(1)));
    // 31 more that ask the server something every 30 s (a member's `ids`): the next newcomer still gets an answer,
    // in place of the asker held longest.
    for k in 0..31u8 {
        assert!(ask(&mut bus, 201 + k, key(150 + k)));
    }
    let ids = Msg::Get {
        mode: GetMode::Ids,
        id: vec![0],
        zone: (0, [0; 4]),
        held: vec![],
    };
    for round in 0..4u32 {
        bus.now += Duration::from_secs(30);
        let (now, unix) = (bus.now, bus.unix());
        for k in (0..31u8).map(|k| key(150 + k)).chain([key(1)]) {
            exchange(&mut bus.s[0], k, 1000 + round, &ids, now, unix);
        }
        bus.s[0].tick(now, unix);
    }
    assert_eq!(bus.s[0].askers(), 32, "requests keep askers");
    assert!(ask(&mut bus, 240, key(240)), "a newcomer to a full server");
    assert_eq!(bus.s[0].askers(), 32);
}

/// A peer with a session that never proved a live name: no `sync`, `have` or `get` of everything is answered.
#[test]
fn only_a_server_that_proved_a_live_name_is_answered_sync_have_and_get_all() {
    let mut b = Bitcoin::new(ROOM, 44);
    let (key, item) = b.title(1, "mine", t(20), &[t(5)], [9; 32]);
    let id = item.id;
    let mut s = Server::new(ROOM, cfg(vec![Title { key, item }]), T);
    let now = Instant::now();
    s.start([0x10; 32], now);
    s.synced = true;
    while s.poll().is_some() {}
    let peer = [0x44; 32];
    let sync = |proof| Msg::Sync {
        range: Range::ALL,
        fp: Default::default(),
        proof,
    };
    assert!(
        exchange(&mut s, peer, 1, &sync(None), now, T).is_empty(),
        "no sync"
    );
    assert!(
        exchange(&mut s, peer, 2, &Msg::Have(vec![[7; 32]]), now, T).is_empty(),
        "no get for a have"
    );
    let all = Msg::Get {
        mode: GetMode::All,
        id: id.to_vec(),
        zone: (0, [0; 4]),
        held: vec![],
    };
    assert!(
        exchange(&mut s, peer, 3, &all, now, T).is_empty(),
        "no get of everything"
    );
    // A member's get is answered all the same.
    let owner = Msg::Get {
        mode: GetMode::Owner,
        id: id.to_vec(),
        zone: (0, [0; 4]),
        held: vec![],
    };
    assert!(
        matches!(&exchange(&mut s, peer, 4, &owner, now, T)[..], [Msg::Items(i)] if i.len() == 1)
    );
    // A proof by another name's owner key, over the server's key and the peer's: answered from then on.
    let (pkey, pitem) = b.title(2, "theirs", t(20), &[t(5)], [8; 32]);
    let sk = k256::schnorr::SigningKey::from_bytes(&pkey).unwrap();
    let entry = pitem.entries.last().unwrap().clone();
    let forged = super::wire::Proof {
        entry: entry.clone(),
        sig: super::entry::sign(
            &sk,
            &super::server::peer_hash(&b.names, &[0x10; 32], &[0x45; 32]),
        ),
    };
    assert!(
        exchange(&mut s, [0x46; 32], 5, &sync(Some(Box::new(forged))), now, T).is_empty(),
        "a proof made for another key"
    );
    let proof = super::wire::Proof {
        entry,
        sig: super::entry::sign(&sk, &super::server::peer_hash(&b.names, &[0x10; 32], &peer)),
    };
    assert!(matches!(
        &exchange(&mut s, peer, 6, &sync(Some(Box::new(proof))), now, T)[..],
        [Msg::SyncAnswer(_)]
    ));
    assert!(matches!(
        &exchange(&mut s, peer, 7, &all, now, T)[..],
        [Msg::Items(_)]
    ));
    // Its `have`s: 32 ids at most, and what they make the server ask, 64 at most at once.
    let ids = |k: u8| {
        (0..32u8)
            .map(|i| {
                [
                    k, i, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
                    1, 1, 1, 1, 1, 1,
                ]
            })
            .collect::<Vec<[u8; 32]>>()
    };
    let mut long = ids(1);
    long.push([9; 32]);
    assert!(
        exchange(&mut s, peer, 8, &Msg::Have(long), now, T).is_empty(),
        "33 ids"
    );
    let gets: usize = (0..3u8)
        .map(|k| exchange(&mut s, peer, 9 + k as u32, &Msg::Have(ids(k + 2)), now, T).len())
        .sum();
    assert_eq!(gets, 64, "what haves make it ask, at once");
    // Its syncs: a budget of what it may make the server fingerprint.
    let answered = (0..1000u32)
        .filter(|k| !exchange(&mut s, peer, 100 + k, &sync(None), now, T).is_empty())
        .count();
    assert!(answered < 1000, "{answered} syncs answered");
    assert!(answered > 100);
}

/// A message in, with no tick (nothing verified meanwhile): the messages the server sends back, with their transfer ids.
fn feed(
    s: &mut Server,
    from: [u8; 32],
    xid: u32,
    reply: u32,
    m: &Msg,
    now: Instant,
) -> Vec<(u32, Msg)> {
    let mut x = Transfers::default();
    for d in datagrams(xid, &m.encode(reply)) {
        s.input(Input::Datagram { from, data: d }, now, T);
    }
    let mut got = Vec::new();
    loop {
        while let Some(c) = s.poll() {
            if let Cmd::Send { to, data } = c
                && to == from
                && let Some((id, p)) = x.input([0; 32], &data, now)
            {
                got.push((id, Msg::decode(&p).unwrap().0));
            }
        }
        // Our acknowledgements back, so the rest comes.
        let acks = std::mem::take(&mut x.out);
        if acks.is_empty() {
            return got;
        }
        for (_, d) in acks {
            s.input(Input::Datagram { from, data: d }, now, T);
        }
    }
}

/// Review 3's finding 4: a peer that proved one live name answers the `get`s its `have`s make the server send. Items
/// for names it didn't ask about were all taken to be verified, and nothing bounded the queue: a peer could grow it
/// faster than 24 units a turn verify it, holding memory and the CPU, and a new server's first sync never ended. Now
/// an answer keeps only the name asked for, and a peer's share of the queue is bounded.
#[test]
fn a_peers_get_answers_keep_only_what_was_asked_in_a_bounded_queue() {
    use super::server::JOBS_PER_PEER;
    let mut b = Bitcoin::new(ROOM, 53);
    let (key, item) = b.title(1, "mine", t(20), &[t(5)], [9; 32]);
    let mut s = Server::new(ROOM, cfg(vec![Title { key, item }]), T);
    let now = Instant::now();
    s.start([0x10; 32], now);
    s.synced = true;
    while s.poll().is_some() {}
    let peer = [0x44; 32];
    let (pkey, pitem) = b.title(2, "theirs", t(20), &[t(5)], [8; 32]);
    let sk = k256::schnorr::SigningKey::from_bytes(&pkey).unwrap();
    let proof = super::wire::Proof {
        entry: pitem.entries.last().unwrap().clone(),
        sig: super::entry::sign(&sk, &super::server::peer_hash(&b.names, &[0x10; 32], &peer)),
    };
    let sync = Msg::Sync {
        range: Range::ALL,
        fp: Default::default(),
        proof: Some(Box::new(proof)),
    };
    assert!(matches!(
        &exchange(&mut s, peer, 1, &sync, now, T)[..],
        [Msg::SyncAnswer(_)]
    ));
    let n = JOBS_PER_PEER + 64;
    let junk: Vec<Item> = (0..n)
        .map(|k| {
            b.title(3 + (k % 200) as u8, &format!("junk{k}"), t(3), &[], [7; 32])
                .1
        })
        .collect();
    let mut xid = 10;
    // 32 names asked for, each answered with 40 items of other names besides its own.
    let haves: Vec<[u8; 32]> = junk[..32].iter().map(|i| i.id).collect();
    for (rid, m) in feed(&mut s, peer, xid, 0, &Msg::Have(haves), now) {
        let Msg::Get { id, .. } = m else { panic!() };
        let mut items: Vec<Item> = junk[32..72].to_vec();
        items.extend(junk.iter().find(|i| i.id[..] == id[..]).cloned());
        xid += 1;
        feed(&mut s, peer, xid, rid, &Msg::Items(items), now);
    }
    assert_eq!(s.jobs_len(), 32, "only the names asked for");
    // Asked and answered, again and again, faster than anything is verified: its share of the queue is bounded.
    for c in junk[32..].chunks(32) {
        xid += 1;
        let haves = c.iter().map(|i| i.id).collect();
        for (rid, m) in feed(&mut s, peer, xid, 0, &Msg::Have(haves), now) {
            let Msg::Get { id, .. } = m else { panic!() };
            let items = junk
                .iter()
                .filter(|i| i.id[..] == id[..])
                .cloned()
                .collect();
            xid += 1;
            feed(&mut s, peer, xid, rid, &Msg::Items(items), now);
        }
    }
    eprintln!("{n} names haved and answered: {} jobs", s.jobs_len());
    assert!(s.jobs_len() <= JOBS_PER_PEER, "{} jobs", s.jobs_len());
}

/// Review 3's finding 6: a job longer than a turn's units has its first entries checked (their anchors offered while
/// their block wasn't refused), then their block is refused (its anchors dropped from what is held), then the job is
/// kept: its anchors in the refused block were kept with it, for a day. Now `keep` drops them.
#[test]
fn an_anchor_in_a_block_refused_while_its_job_was_checked_isnt_kept() {
    let mut b = Bitcoin::new(ROOM, 54);
    let (key, item) = b.title(1, "mine", t(20), &[t(5)], [9; 32]);
    let mut s = Server::new(ROOM, cfg(vec![Title { key, item }]), T);
    let now = Instant::now();
    s.start([0x10; 32], now);
    s.synced = true;
    while s.poll().is_some() {}
    let renewals: Vec<u32> = (1..12).map(|k| t(40 - 3 * k)).collect();
    let (_, long) = b.title(9, "longname", t(40), &renewals, [9; 32]);
    assert!(long.entries.len() * 4 > super::server::UNITS_PER_TURN as usize);
    let block = long.entries[0].anchor.as_ref().unwrap().1.hash();
    assert_eq!(
        long.entries
            .iter()
            .filter(|w| w.anchor.as_ref().unwrap().1.hash() == block)
            .count(),
        1,
        "the claim's block is its own"
    );
    feed(&mut s, [0x44; 32], 1, 0, &Msg::Put(long.clone()), now);
    s.tick(now, T); // the job's first slice: the claim checked, its anchor offered
    let mut refusal = vec![super::server::BLOCK_RECORD, 2];
    refusal.extend_from_slice(&T.to_le_bytes());
    refusal.extend_from_slice(&block);
    assert!(s.load(&refusal, T), "the block refused mid-job");
    for _ in 0..100 {
        s.tick(now, T);
        while s.poll().is_some() {}
    }
    let held = s.reg.get(&long.id);
    let kept = held.map_or(0, |h| {
        (h.name.entries())
            .filter(|e| e.anchor().is_some_and(|a| a.header.hash() == block))
            .count()
    });
    assert_eq!(kept, 0, "no anchor in the refused block kept");
}

#[test]
fn a_put_of_one_junk_entry_many_times_costs_one_check() {
    let mut b = Bitcoin::new(ROOM, 45);
    let k = b.key(1, "junk");
    let good = b.at(Kind::Claim, &k, "junk", [0; 32], t(10));
    // Signed with the sender's own key, no work.
    let mut e = good.entry.clone();
    e.nonce = (0..)
        .find(|n| {
            let mut x = e.clone();
            x.nonce = *n;
            !b.pow.ok(&x)
        })
        .unwrap();
    e.sign(&k, &b.names);
    let mut w = WireEntry::of(&good);
    w.entry = e;
    let it = Item {
        id: good.entry.name,
        entries: vec![w; super::wire::MAX_ENTRIES],
        zone: None,
    };
    let mut s = Server::new(ROOM, cfg(vec![]), T);
    let now = Instant::now();
    s.start([0x10; 32], now);
    while s.poll().is_some() {}
    let put = |s: &mut Server, id: u32, it: &Item, from: [u8; 32]| {
        for d in datagrams(id, &Msg::Put(it.clone()).encode(0)) {
            s.input(Input::Datagram { from, data: d }, now, T);
        }
    };
    let drain = |s: &mut Server| {
        let mut ticks = 0;
        while s.busy() {
            s.tick(now, T);
            ticks += 1;
            assert!(ticks < 1000);
        }
        ticks
    };
    put(&mut s, 1, &it, [0x44; 32]);
    let ticks = drain(&mut s);
    assert!(
        ticks <= 2,
        "{ticks} turns for one junk entry sent 1,024 times"
    );
    assert_eq!(s.stats.checked, 1);
    // The same junk again, from another peer: remembered, not checked again.
    put(&mut s, 1, &it, [0x45; 32]);
    drain(&mut s);
    assert_eq!(s.stats.checked, 1, "refused before");
    // Junk that differs entry to entry: the first refused ends the job.
    let mut many = it.clone();
    for (k, w) in many.entries.iter_mut().enumerate().take(50) {
        w.entry.nonce ^= (k as u64 + 1) << 20;
        w.entry.sign(&k_of(&b), &b.names);
    }
    many.entries.truncate(50);
    put(&mut s, 2, &many, [0x47; 32]);
    drain(&mut s);
    assert_eq!(s.stats.checked, 2, "one check for a job of junk");
    // Ten puts at once from one peer, each of other junk: a few queued, the rest refused.
    for k in 0..10u32 {
        let mut x = it.clone();
        x.entries.truncate(1);
        x.entries[0].entry.nonce ^= 1 << (k + 40);
        x.entries[0].entry.sign(&k_of(&b), &b.names);
        put(&mut s, 10 + k, &x, [0x46; 32]);
    }
    drain(&mut s);
    assert!(s.stats.checked <= 2 + 4, "{} checked", s.stats.checked);
}

fn k_of(b: &Bitcoin) -> k256::schnorr::SigningKey {
    b.key(1, "junk")
}

/// What a `put` brings is verified after what the round's sync brought: a new server counts as synced without
/// waiting for it.
#[test]
fn a_new_server_counts_as_synced_without_waiting_for_puts() {
    let mut b = Bitcoin::new(ROOM, 46);
    let renewals: Vec<u32> = (1..200).map(|k| t(400) + k * 2 * DAY).collect();
    let (_, long) = b.title(1, "long", t(400), &renewals, [1; 32]);
    let put = Msg::Put(long).encode(0);
    let (v, _, _, busy) =
        partner_answers_with(vec![], |_| SyncAnswer::Same, 10, &mut |v, _, now, unix| {
            for d in datagrams(1, &put) {
                v.input(
                    Input::Datagram {
                        from: [0x44; 32],
                        data: d,
                    },
                    now,
                    unix,
                );
            }
        });
    assert!(v.synced);
    assert!(busy, "synced while the put still waits");
}

#[test]
fn a_peer_that_never_acknowledges_gets_a_bounded_queue() {
    let mut a = Transfers::default();
    let to = [5u8; 32];
    let now = Instant::now();
    let msg = vec![1u8; 100_000];
    for _ in 0..200 {
        a.send(to, &msg, now);
    }
    assert!(
        a.queued(&to) <= 8 * super::wire::MAX_MESSAGE + msg.len(),
        "{} bytes queued",
        a.queued(&to)
    );
    assert!(!a.tick(now).is_empty(), "the sends with no room fail");
}

#[test]
fn a_pending_anchor_not_signed_by_the_owner_is_refused() {
    use super::anchor::{Calendar, Op, Pending};
    let mut b = Bitcoin::new(ROOM, 47);
    let mut bus = Bus::new(vec![
        Server::new(ROOM, cfg(vec![]), T),
        Server::new(ROOM, cfg(vec![]), T),
    ]);
    let id = b.names.name_id("pending");
    let (key, c0) = b.title(1, "pending", t(20), &[t(5)], [1; 32]);
    let key = k256::schnorr::SigningKey::from_bytes(&key).unwrap();
    assert_eq!(bus.put(1, 0, c0.clone()), Msg::Taken);
    let last = c0.entries.last().unwrap().entry.id();
    let r = b.entry(Kind::Renew, &key, "pending", last);
    let mut good = Pending {
        calendar: Calendar::Bob,
        ops: vec![Op::Sha256],
        sig: [0; 64],
    };
    super::entry::sign_pending(&key, &b.names, &r.id(), &mut good);
    let with = |p: &Pending| {
        let mut s = r.clone();
        assert!(s.offer_pending(p.clone()));
        b.item("pending", &[s], None)
    };
    bus.put(1, 0, with(&good));
    let held = |bus: &Bus| {
        bus.s[0]
            .reg
            .get(&id)
            .unwrap()
            .name
            .get(&r.id())
            .and_then(|e| e.pending().cloned())
    };
    assert_eq!(held(&bus), Some(good.clone()), "the owner's, kept");
    // Anyone's lower pending for the owner's renewal: unsigned, or signed by another key.
    let forged = Pending {
        calendar: Calendar::Alice,
        ops: vec![],
        sig: [0; 64],
    };
    bus.put(1, 0, with(&forged));
    assert_eq!(
        held(&bus),
        Some(good.clone()),
        "an unsigned one changes nothing"
    );
    let mut other = forged.clone();
    super::entry::sign_pending(&b.key(2, "pending"), &b.names, &r.id(), &mut other);
    bus.put(1, 0, with(&other));
    assert_eq!(held(&bus), Some(good), "nor one by another key");
}

/// A run's first `sync` carries the asker's proof that it holds a live name, signed for the partner.
#[test]
fn a_runs_first_sync_carries_a_proof() {
    let mut b = Bitcoin::new(ROOM, 48);
    let (key, item) = b.title(1, "prover", t(20), &[t(5)], [9; 32]);
    let names = b.names.clone();
    let mut proof = None;
    partner_answers_with(
        vec![Title { key, item }],
        |_| SyncAnswer::Same,
        10,
        &mut |_, m, _, _| {
            if let Msg::Sync { proof: p, .. } = m {
                proof = p.clone();
            }
        },
    );
    let p = proof.expect("a proof");
    let msg = super::server::peer_hash(&names, &[0x22; 32], &[0x11; 32]);
    assert!(super::entry::verify(&p.entry.entry.owner, &msg, &p.sig));
}

/// Review 2's finding 7: valid entries of a dead chain, put again and again, are checked whole once: a server
/// remembers what it verified lately, as it remembers what it refused.
#[test]
fn valid_entries_put_again_are_checked_once() {
    let mut b = Bitcoin::new(ROOM, 46);
    let k = b.key(1, "dead");
    // A long title that lapsed long ago: each entry valid, the chain dead now.
    let mut run = vec![b.at(Kind::Claim, &k, "dead", [0; 32], t(400))];
    for r in 1..40 {
        let prev = run.last().unwrap().id();
        run.push(b.at(Kind::Renew, &k, "dead", prev, t(400 - 7 * r)));
    }
    let it = b.item("dead", &run, None);
    let mut s = Server::new(ROOM, cfg(vec![]), T);
    let now = Instant::now();
    s.start([0x10; 32], now);
    while s.poll().is_some() {}
    let mut checked = Vec::new();
    for (k, from) in [[0x44; 32], [0x44; 32], [0x45; 32]].into_iter().enumerate() {
        for d in datagrams(k as u32 + 1, &Msg::Put(it.clone()).encode(0)) {
            s.input(Input::Datagram { from, data: d }, now, T);
        }
        let mut ticks = 0;
        while s.busy() {
            s.tick(now, T);
            ticks += 1;
            assert!(ticks < 1000);
        }
        checked.push(s.stats.checked);
    }
    assert!(s.reg.is_empty(), "nothing of a dead chain is kept");
    assert_eq!(checked, vec![40, 40, 40], "checked whole once each");
}

/// The final review's finding 1: an entry's id takes its signature in and its proof of work doesn't, so the owner of
/// one mined entry signs it again as often as it likes (BIP-340's aux randomness) and gets valid entries, each with an
/// id of its own. A put of 1,024 such copies cost a server 1,024 Argon2ids (and pushed 1,024 ids through what it
/// remembers as verified); 64 of them held the put queue for minutes of a core.
#[test]
fn an_entry_signed_again_costs_no_more_work() {
    let mut b = Bitcoin::new(ROOM, 52);
    let k = b.key(1, "copies");
    let one = b.at(Kind::Claim, &k, "copies", [0; 32], t(10));
    let copies = |b: &Bitcoin, n: usize| {
        let mut it = b.item("copies", &[], None);
        it.entries = (0..n)
            .map(|_| {
                let mut w = WireEntry::of(&one);
                w.entry.sign(&k, &b.names);
                w.anchor = None;
                w
            })
            .collect();
        it
    };
    let it = copies(&b, 1024);
    let distinct: std::collections::BTreeSet<[u8; 32]> =
        it.entries.iter().map(|w| w.entry.id()).collect();
    assert_eq!(distinct.len(), 1024, "an id each");
    let mut s = Server::new(ROOM, cfg(vec![]), T);
    let now = Instant::now();
    s.start([0x10; 32], now);
    while s.poll().is_some() {}
    let drain = |s: &mut Server| {
        let mut ticks = 0;
        while s.busy() {
            s.tick(now, T);
            ticks += 1;
            assert!(ticks < 100_000);
        }
        ticks
    };
    for d in datagrams(1, &Msg::Put(it).encode(0)) {
        s.input(
            Input::Datagram {
                from: [0x44; 32],
                data: d,
            },
            now,
            T,
        );
    }
    let ticks = drain(&mut s);
    assert_eq!(
        s.stats.checked, 1,
        "one check for 1,024 signings of one entry"
    );
    assert_eq!(s.stats.work, 1, "one Argon2id");
    assert!(ticks <= 4, "{ticks} turns");
    // The put queue full of them (16 peers, 4 puts each, each of fresh signings): drained in a few turns a put, each
    // put's first signing a signature's check, and no proof of work again.
    for p in 0..16u8 {
        for q in 0..4u32 {
            for d in datagrams(q + 1, &Msg::Put(copies(&b, 256)).encode(0)) {
                s.input(
                    Input::Datagram {
                        from: [0x50 + p; 32],
                        data: d,
                    },
                    now,
                    T,
                );
            }
        }
    }
    let ticks = drain(&mut s);
    eprintln!("64 puts of 256 signings each: {ticks} turns");
    assert!(ticks <= 64, "{ticks} turns");
    assert_eq!((s.stats.checked, s.stats.work), (1 + 64, 1));
}

/// A peer forgotten on our side only (its session ended here, not there) and met again: our new transfers aren't ones
/// it remembers as done and drops (found while fixing review 2's finding 5: a member asking the same server again).
#[test]
fn a_peer_forgotten_and_met_again_gets_new_transfers() {
    let now = Instant::now();
    let (ka, kb) = ([1u8; 32], [2u8; 32]);
    let (mut a, mut b) = (Transfers::default(), Transfers::default());
    let deliver = |a: &mut Transfers, b: &mut Transfers, payload: &[u8]| -> bool {
        a.send(kb, payload, now);
        let mut got = false;
        for (_, d) in std::mem::take(&mut a.out) {
            got |= b.input(ka, &d, now).is_some_and(|(_, p)| p == payload);
        }
        for (_, d) in std::mem::take(&mut b.out) {
            a.input(kb, &d, now);
        }
        got
    };
    assert!(deliver(&mut a, &mut b, b"one"));
    assert!(deliver(&mut a, &mut b, b"two"));
    a.forget(&kb);
    assert!(
        deliver(&mut a, &mut b, b"three"),
        "dropped as a transfer done"
    );
}

/// Review 2's finding 10: a put whose zone the server doesn't take (within 10 minutes of the last, or not beating the
/// one held) isn't answered `taken`: `better`, with the zone held, so the agent knows to put it again or count past it.
#[test]
fn a_zone_the_server_doesnt_take_isnt_answered_taken() {
    let mut b = Bitcoin::new(ROOM, 47);
    let (_, item) = b.title(1, "zoned", t(20), &[t(5)], [9; 32]);
    let sk = b.key(1, "zoned");
    let zone = |seq: u64, to: u8| {
        Zone::seal(&b.names, &sk, "zoned", seq, &[(None, [to; 32])], false).unwrap()
    };
    let with = |z: Zone| Item {
        zone: Some(z),
        ..item.clone()
    };
    let mut bus = Bus::new(vec![
        Server::new(ROOM, cfg(vec![]), T),
        Server::new(ROOM, cfg(vec![]), T),
    ]);
    assert_eq!(bus.put(0, 1, item.clone()), Msg::Taken);
    let (z2, z3) = (zone(2, 2), zone(3, 3));
    assert!(
        matches!(bus.put(0, 1, with(z2.clone())), Msg::Better(it) if it.zone.as_ref().map(|z| z.seq) == Some(1)),
        "within 10 minutes"
    );
    bus.advance(Duration::from_secs(601));
    assert_eq!(bus.put(0, 1, with(z2.clone())), Msg::Taken, "past them");
    assert_eq!(bus.put(0, 1, with(z2)), Msg::Taken, "the zone held, again");
    bus.advance(Duration::from_secs(601));
    let older = zone(1, 7);
    assert!(
        matches!(bus.put(0, 1, with(older)), Msg::Better(it) if it.zone.as_ref().map(|z| z.seq) == Some(2)),
        "a lower seq"
    );
    assert_eq!(bus.put(0, 1, with(z3)), Msg::Taken);
}

/// Review 2's finding 12: the asker's key in a question proves nothing, so questions naming a victim's key would have
/// every server call it back (spending its incoming trials) and send it a `serve` on port 2, again and again. A server
/// calls back one key a few times a minute at most.
#[test]
fn questions_naming_one_key_get_few_call_backs() {
    let mut b = Bitcoin::new(ROOM, 48);
    let (key, item) = b.title(1, "mine", t(20), &[t(5)], [9; 32]);
    let mut bus = Bus::new(vec![Server::new(ROOM, cfg(vec![Title { key, item }]), T)]);
    bus.s[0].synced = true;
    while bus.s[0].poll().is_some() {}
    let victim = [0x66; 32];
    let mut calls = 0;
    for k in 0..30u8 {
        bus.now += Duration::from_secs(2); // the server's budget refills between questions
        let (now, unix) = (bus.now, bus.unix());
        let q = Question {
            key: victim,
            region: 0,
            time: unix,
            nonce: [k; 16],
            spread: 0,
        };
        bus.s[0].input(Input::Question { q, region: 0 }, now, unix);
        while let Some(c) = bus.s[0].poll() {
            calls += matches!(c, Cmd::CallBack { key, .. } if key == victim) as usize;
        }
    }
    assert!(calls <= 4, "{calls} call backs to one key in a minute");
    // Another key is answered meanwhile.
    let (now, unix) = (bus.now, bus.unix());
    let q = Question {
        key: [0x67; 32],
        region: 0,
        time: unix,
        nonce: [99; 16],
        spread: 0,
    };
    bus.s[0].input(Input::Question { q, region: 0 }, now, unix);
    let mut other = false;
    while let Some(c) = bus.s[0].poll() {
        other |= matches!(c, Cmd::CallBack { .. });
    }
    assert!(other);
}

/// Review 2's finding 13: an `ids` answer's "taken until" is rounded up to a week, so names renewed in one visit (one
/// block, one cover end) can't be grouped by it into one owner's.
#[test]
fn ids_answers_round_cover_ends_to_a_week() {
    const WEEK: u64 = 7 * DAY as u64;
    let mut b = Bitcoin::new(ROOM, 49);
    // Two names under one first byte.
    let mut names = Vec::new();
    for k in 0.. {
        let n = format!("same{k}");
        if b.names.name_id(&n)[0] == b.names.name_id("same0")[0] {
            names.push(n);
            if names.len() == 2 {
                break;
            }
        }
    }
    // Renewed two hours apart, their cover ends inside one week.
    let end = (T - 5 * DAY as u64 + 37 * DAY as u64).div_ceil(WEEK) * WEEK + 3600;
    let r1 = (end - 37 * DAY as u64) as u32;
    let mut s = Server::new(ROOM, cfg(vec![]), T);
    let mut ends = Vec::new();
    for (k, n) in names.iter().enumerate() {
        let (_, item) = b.title(
            k as u8 + 1,
            n,
            r1 - 20 * DAY,
            &[r1 + 7200 * k as u32],
            [9; 32],
        );
        assert!(s.load(&record(&item, T), T));
        ends.push(
            s.reg
                .get(&item.id)
                .unwrap()
                .owner
                .as_ref()
                .unwrap()
                .cover_end,
        );
    }
    let now = Instant::now();
    s.start([0x10; 32], now);
    while s.poll().is_some() {}
    let get = Msg::Get {
        mode: GetMode::Ids,
        id: vec![b.names.name_id(&names[0])[0]],
        zone: (0, [0; 4]),
        held: Vec::new(),
    };
    let got = exchange(&mut s, [0x30; 32], 1, &get, now, T);
    let Some(Msg::Ids(ids)) = got.into_iter().next() else {
        panic!("ids")
    };
    let untils: Vec<u64> = ids.iter().map(|(_, u)| *u).collect();
    assert_eq!(untils.len(), 2);
    assert_ne!(ends[0], ends[1]);
    assert_eq!(
        untils[0], untils[1],
        "one week's cover ends look alike: {untils:?}"
    );
    for (u, e) in untils.iter().zip(&ends) {
        assert!(*u % WEEK == 0 && *u >= *e && *u < *e + WEEK, "{u} for {e}");
    }
}

/// The final review's finding 7: `ids` was answered to anyone, as often as asked, so 256 gets from one session (made by
/// one "who serves?" under a fresh key) listed every id held with its cover end, to hash a dictionary against offline.
/// A session is answered twice at most (the dialog's checker asks once, a press), and a server answers four a minute
/// from everyone; past them an empty `items`, so the checker hears at once that this server can't say.
#[test]
fn ids_are_answered_twice_a_session_and_four_times_a_minute() {
    let mut b = Bitcoin::new(ROOM, 54);
    let mut s = Server::new(ROOM, cfg(vec![]), T);
    for k in 0..64u8 {
        let (_, item) = b.title(k + 1, &format!("name{k}"), t(20), &[t(5)], [9; 32]);
        assert!(s.load(&record(&item, T), T));
    }
    let mut now = Instant::now();
    s.start([0x10; 32], now);
    while s.poll().is_some() {}
    let get = |first: u8| Msg::Get {
        mode: GetMode::Ids,
        id: vec![first],
        zone: (0, [0; 4]),
        held: Vec::new(),
    };
    let answered = |got: Vec<Msg>| match got.into_iter().next() {
        Some(Msg::Ids(_)) => true,
        Some(Msg::Items(v)) if v.is_empty() => false,
        other => panic!("{other:?}"),
    };
    let mut n = 0;
    for first in 0..=255u8 {
        n += answered(exchange(
            &mut s,
            [0x30; 32],
            first as u32 + 1,
            &get(first),
            now,
            T,
        )) as usize;
        now += Duration::from_millis(500);
    }
    assert_eq!(n, 2, "one session's");
    now += Duration::from_secs(61);
    let mut n = 0;
    for k in 0..16u8 {
        n += answered(exchange(&mut s, [0x40 + k; 32], 1, &get(k), now, T)) as usize;
    }
    assert_eq!(n, 4, "a minute's, from sessions of their own");
    now += Duration::from_secs(61);
    assert!(
        answered(exchange(&mut s, [0x60; 32], 1, &get(0), now, T)),
        "a minute on"
    );
}

/// Review 2's finding 14: a sync partner that answers each request just before it times out, with sixteenths that
/// always differ, can't keep a new server unsynced for hours: a run is bounded by time too, and one ended by it ends
/// the round.
#[test]
fn a_slow_partner_doesnt_keep_a_server_unsynced() {
    let mut b = Bitcoin::new(ROOM, 50);
    let (key, item) = b.title(1, "partner", t(20), &[t(5)], [9; 32]);
    let sk = k256::schnorr::SigningKey::from_bytes(&key).unwrap();
    let last = item.entries.last().unwrap().clone();
    let mut v = Server::new(ROOM, cfg(vec![]), T);
    let (vk, pk) = ([0x11; 32], [0x22; 32]);
    let t0 = Instant::now();
    let mut now = t0;
    v.start(vk, now);
    let mut x = Transfers::default();
    let mut differ = [super::wire::Fp::default(); 16];
    for (k, f) in differ.iter_mut().enumerate() {
        *f = super::wire::Fp {
            hash: [k as u8 + 1; 8],
            count: 1000,
        };
    }
    // Answers the partner holds back: (when, transfer, answer).
    let mut later: Vec<(Instant, u32, Msg)> = Vec::new();
    let mut syncs = 0;
    // When it counted as synced, and its first question after that (the next round).
    let mut synced_at = None;
    let mut next_question = None;
    while now < t0 + Duration::from_secs(3 * 3600) && next_question.is_none() {
        if v.synced && synced_at.is_none() {
            synced_at = Some(now);
        }
        let unix = T + now.duration_since(t0).as_secs();
        while let Some(c) = v.poll() {
            match c {
                Cmd::Publish { spread: 6, .. } if synced_at.is_some() => {
                    next_question = Some(now);
                }
                Cmd::Publish { nonce, spread: 0 } => {
                    let h =
                        super::entry::tagged("waarm64/names/serve", &[&b.names.value, &nonce, &pk]);
                    let m = Msg::Serve {
                        nonce,
                        entries: vec![last.clone()],
                        sig: super::entry::sign(&sk, &h),
                    };
                    x.send(vk, &m.encode(0), now);
                }
                Cmd::Send { to, data } if to == pk => {
                    if let Some((xid, m)) = x.input(vk, &data, now)
                        && let Msg::Sync { range, .. } = Msg::decode(&m).unwrap().0
                    {
                        syncs += 1;
                        // Every sixteenth differs, three nibbles deep: 4,096 ranges, each answered late.
                        let a = if range.depth < 3 {
                            SyncAnswer::Children(differ)
                        } else {
                            SyncAnswer::Same
                        };
                        later.push((now + Duration::from_secs(8), xid, Msg::SyncAnswer(a)));
                    }
                }
                Cmd::Log(l) => eprintln!("DBG {:?} {l}", now - t0),
                _ => {}
            }
        }
        let (due, wait): (Vec<_>, Vec<_>) = later.drain(..).partition(|(t, _, _)| *t <= now);
        later = wait;
        for (_, xid, m) in due {
            x.send(vk, &m.encode(xid), now);
        }
        x.tick(now);
        let out = std::mem::take(&mut x.out);
        for (_, d) in &out {
            v.input(
                Input::Datagram {
                    from: pk,
                    data: d.clone(),
                },
                now,
                unix,
            );
        }
        if out.is_empty() {
            let next = [v.deadline(), later.iter().map(|l| l.0).min()]
                .into_iter()
                .flatten()
                .min();
            now = next.map_or(now + Duration::from_millis(100), |d| {
                d.max(now + Duration::from_millis(1))
            });
            v.tick(now, T + now.duration_since(t0).as_secs());
        }
    }
    let took = synced_at.map_or(now - t0, |t| t - t0);
    eprintln!(
        "a slow partner: synced after {took:?}, {syncs} syncs, {} runs; the next question {:?} after the start",
        v.stats.syncs,
        next_question.map(|t| t - t0)
    );
    assert!(synced_at.is_some(), "still unsynced after {took:?}");
    assert!(took <= Duration::from_secs(270), "{took:?}");
    // A run cut by its time goes on in a round that starts at once (N0c: 50 MB waited ~100 s for the next round), not
    // at the round's 5 minutes.
    let next = next_question.expect("a next question") - t0;
    assert!(
        next <= took + Duration::from_secs(10),
        "the next round {next:?} after the start, synced at {took:?}"
    );
}

/// A run ended by a breach of its bounds (not by its time) waits for the round's 5 minutes, as before.
#[test]
fn a_run_ended_by_a_breach_waits_for_the_next_round() {
    let mut differ = [super::wire::Fp::default(); 16];
    for (k, f) in differ.iter_mut().enumerate() {
        *f = super::wire::Fp {
            hash: [k as u8 + 1; 8],
            count: 1,
        };
    }
    let (mut v, _, _) = partner_answers(|_| SyncAnswer::Children(differ), 20_000);
    assert!(v.synced, "the round with it ended");
    // The harness's clock where it stopped: the server's first deadline after it.
    let t0 = v.deadline().expect("a deadline");
    let mut now = t0;
    let mut next = None;
    while now < t0 + Duration::from_secs(600) && next.is_none() {
        v.tick(now, T + 600 + now.duration_since(t0).as_secs());
        now = v.deadline().map_or(now + Duration::from_secs(1), |d| {
            d.max(now + Duration::from_millis(1))
        });
        while let Some(c) = v.poll() {
            if matches!(c, Cmd::Publish { spread: 6, .. }) && next.is_none() {
                next = Some(now - t0);
            }
        }
    }
    let next = next.expect("a next round");
    // The run took a while of the round's 5 minutes; what is left of them, not a round at once.
    assert!(
        next >= Duration::from_secs(60),
        "the next round after {next:?}"
    );
}

/// Review 2's finding 15: titles taken in from a pasted export reach the node's server through `set_titles`, and a
/// crafted export can carry forged entries: they are verified as anything from outside is, so a forged senior chain
/// doesn't displace the real owner's.
#[test]
fn titles_are_verified_before_the_registry_holds_them() {
    let mut b = Bitcoin::new(ROOM, 51);
    let (_, real) = b.title(1, "bank", t(20), &[t(5)], [1; 32]);
    // The crafted title: a claim "40 days ago" whose signature doesn't hold, renewed.
    let (key, mut forged) = b.title(2, "bank", t(30), &[t(10)], [2; 32]);
    forged.entries[0].entry.sig[3] ^= 1;
    let mut s = Server::new(ROOM, cfg(vec![]), T);
    assert!(s.load(&record(&real, T), T));
    let real_owner = real.entries[0].entry.owner;
    let now = Instant::now();
    s.start([0x10; 32], now);
    s.set_titles(
        vec![Title {
            key,
            item: forged.clone(),
        }],
        T,
    );
    let mut ticks = 0;
    while s.busy() && ticks < 1000 {
        s.tick(now, T);
        ticks += 1;
    }
    let h = s.reg.get(&real.id).unwrap();
    assert_eq!(
        h.owner.as_ref().map(|o| o.owner),
        Some(real_owner),
        "the real owner stands"
    );
    // An honest title is taken (once checked).
    let (key, own) = b.title(3, "mine", t(20), &[t(5)], [3; 32]);
    s.set_titles(
        vec![Title {
            key,
            item: own.clone(),
        }],
        T,
    );
    while s.busy() {
        s.tick(now, T);
    }
    assert!(s.reg.get(&own.id).is_some_and(|h| h.owner.is_some()));
}

/// The final review's finding 6: a title was taken as this node's own (its id in `own`, its zone answering the
/// resolver while the registry doesn't resolve the name) before it was checked, and kept when the check refused it; a
/// title with no entries passed, and its zone was never checked. An export can be crafted (review 2), so a title that
/// doesn't hold is refused whole: its entries and its zone the title key's, for its name, each holding.
#[test]
fn a_title_that_doesnt_hold_isnt_taken_as_this_nodes_own() {
    let mut b = Bitcoin::new(ROOM, 55);
    let attacker = [0x66; 32];
    let other = b.key(9, "elsewhere");
    let unix = T;
    // A zone only, signed by another key, pointing "bank" at the attacker's node.
    let (key1, _) = b.title(1, "bank", t(20), &[t(5)], [1; 32]);
    let zone_only = Item {
        id: b.names.name_id("bank"),
        entries: Vec::new(),
        zone: Some(Zone::seal(&b.names, &other, "bank", 1, &[(None, attacker)], false).unwrap()),
    };
    // An entry whose signature doesn't hold, with the title's own zone.
    let (key2, mut broken) = b.title(2, "shop", t(20), &[t(5)], attacker);
    broken.entries[1].entry.sig[5] ^= 1;
    // Entries of the title's name, but another key's (the title key isn't the owner).
    let (_, theirs) = b.title(3, "mail", t(20), &[t(5)], attacker);
    let key3 = b.key(4, "mail").to_bytes().into();
    // The title's entries and another key's zone.
    let (key4, mut zoned) = b.title(5, "news", t(20), &[t(5)], [5; 32]);
    zoned.zone = Some(Zone::seal(&b.names, &other, "news", 9, &[(None, attacker)], false).unwrap());
    let titles = vec![
        Title {
            key: key1,
            item: zone_only,
        },
        Title {
            key: key2,
            item: broken,
        },
        Title {
            key: key3,
            item: theirs,
        },
        Title {
            key: key4,
            item: zoned.clone(),
        },
    ];
    let s = Server::new(ROOM, cfg(titles), unix);
    for name in ["bank", "shop", "mail", "news"] {
        assert_eq!(s.resolve(name, name, unix), Answer::Wait, "{name}");
        assert_eq!(
            s.resolve(&format!("www.{name}"), name, unix),
            Answer::Wait,
            "{name}"
        );
    }
    for name in ["bank", "shop", "mail", "news"] {
        assert!(
            s.reg.get(&b.names.name_id(name)).is_none(),
            "{name}: nothing held"
        );
    }
    // An honest title is taken: resolved from the registry, and its own name not public yet from its zone.
    let (key, own) = b.title(6, "mine", t(20), &[t(5)], [6; 32]);
    let k = b.key(6, "pending");
    let claim = b.entry(Kind::Claim, &k, "pending", [0; 32]);
    let z = Zone::seal(&b.names, &k, "pending", 1, &[(None, [7; 32])], false).unwrap();
    let pending = b.item("pending", &[claim], Some(z));
    let s = Server::new(
        ROOM,
        cfg(vec![
            Title { key, item: own },
            Title {
                key: k.to_bytes().into(),
                item: pending,
            },
        ]),
        unix,
    );
    assert_eq!(s.resolve("mine", "mine", unix), Answer::Node([6; 32]));
    assert_eq!(s.resolve("pending", "pending", unix), Answer::Node([7; 32]));
}

// ---- Outside the room (outside.rs): renewals finished at a calendar, blocks checked at an explorer ----

use super::{
    Params,
    anchor::{Calendar, EXPLORERS},
    chain::Name,
    member::Answer,
    testkit::LATE,
};

fn cfg_with(params: Params, titles: Vec<Title>) -> Config {
    Config {
        params,
        titles,
        max_names: MAX_NAMES,
        max_bytes: MAX_BYTES,
    }
}

/// A name's owner as its page's agent keeps it (web/names.ts), on the pretend services: its entries, and the next
/// renewal made ahead (proof of work and signature done, not stamped).
struct Owner {
    key: k256::schnorr::SigningKey,
    name: String,
    entries: Vec<Stamped>,
    /// Its zone, sealed once (a seal draws fresh randomness: sealed again, the same `seq` would be another zone).
    zone: super::zone::Zone,
    ahead: Option<Stamped>,
    /// Visits at which proof of work had to be done (a renewal due with none made ahead).
    slow_visits: usize,
}

impl Owner {
    /// A claim stamped at `alice` and anchored at `at` (six blocks on), its next renewal made ahead.
    fn claimed(
        b: &mut Bitcoin,
        svc: &mut Services,
        secret: u8,
        name: &str,
        at: u32,
        node: [u8; 32],
    ) -> Owner {
        let key = b.key(secret, name);
        let claim = b.entry(Kind::Claim, &key, name, [0; 32]);
        let zone =
            super::zone::Zone::seal(&b.names, &key, name, 1, &[(None, node)], false).unwrap();
        let mut o = Owner {
            key,
            name: name.into(),
            zone,
            entries: vec![claim],
            ahead: None,
            slow_visits: 0,
        };
        o.stamp(b, svc, 0);
        svc.mine(1, at);
        svc.mine(6, at + 600);
        o.collect(b, svc);
        assert!(o.entries[0].time().is_some());
        o.make_ahead(b);
        o
    }

    fn stamp(&mut self, b: &Bitcoin, svc: &mut Services, k: usize) {
        let id = self.entries[k].id();
        let mut p = svc.stamp(&id, Calendar::Alice);
        super::entry::sign_pending(&self.key, &b.names, &id, &mut p);
        assert!(self.entries[k].offer_pending(p));
    }

    /// Finished anchors collected (the agent's visit does, as servers do).
    fn collect(&mut self, b: &Bitcoin, svc: &Services) {
        for e in &mut self.entries {
            if e.time().is_none()
                && let Some(p) = e.pending().cloned()
                && let Some((a, h)) = svc.anchor_of(&e.id(), &p)
            {
                e.offer_anchor(a, h, &b.params, LATE).unwrap();
            }
        }
    }

    fn chain(&self, params: &Params, now: u64) -> Option<super::chain::Chain> {
        let mut n = Name::new(self.entries[0].entry.name);
        for e in &self.entries {
            n.insert(e.clone());
        }
        n.owner(params, now)
    }

    /// The next renewal, after the newest entry (pending or not): proof of work and signature, kept for a later visit.
    fn make_ahead(&mut self, b: &mut Bitcoin) {
        let prev = self.entries.last().unwrap().id();
        self.ahead = Some(b.entry(Kind::Renew, &self.key, &self.name, prev));
    }

    /// A visit at `now`: what is finished collected; a renewal due stamped from the one made ahead (a few seconds:
    /// stamps), and the next made ahead after the item is handed over. The item to publish.
    fn visit(&mut self, b: &mut Bitcoin, svc: &mut Services, now: u64) -> Item {
        self.collect(b, svc);
        let o = self
            .chain(&b.params, now)
            .expect("the name owned at the visit");
        let last = *o.ids.last().unwrap();
        let last_t = self
            .entries
            .iter()
            .find(|e| e.id() == last)
            .unwrap()
            .time()
            .unwrap() as u64;
        let waiting = self
            .entries
            .iter()
            .any(|e| e.time().is_none() && e.entry.prev == last);
        if now >= last_t + b.params.term as u64 / 2 && !waiting {
            let r = match self.ahead.take() {
                Some(r) if r.entry.prev == last => r,
                _ => {
                    self.slow_visits += 1;
                    b.entry(Kind::Renew, &self.key, &self.name, last)
                }
            };
            self.entries.push(r);
            let k = self.entries.len() - 1;
            self.stamp(b, svc, k);
        }
        let item = b.item(&self.name, &self.entries, Some(self.zone.clone()));
        if self
            .ahead
            .as_ref()
            .is_none_or(|a| a.entry.prev != self.entries.last().unwrap().id())
        {
            self.make_ahead(b);
        }
        item
    }
}

/// Every URL fetched is a compiled calendar's or explorer's.
fn compiled_only(bus: &Bus) {
    for (_, u) in &bus.fetched {
        assert!(
            Calendar::ALL
                .iter()
                .any(|c| u.starts_with(&format!("{}/", c.url())))
                || EXPLORERS.iter().any(|e| u.starts_with(&format!("{e}/"))),
            "not a compiled service: {u}"
        );
    }
    assert!(bus.svc.as_ref().is_none_or(|s| s.foreign.is_empty()));
}

/// The redesign's promise (room-names-redesign.md §3, "Open this web app at least every 2 weeks"): an owner whose page
/// opens for a few seconds every 14 days, closed between, keeps its name resolving and owned throughout. Each visit
/// only stamps the renewal made ahead and hands it to a server; the calendar finishes it hours later, when no page is
/// open, and the servers finish it themselves. The claim is 5 days old at the start, so each renewal is stamped at a
/// visit 19 or 27 days after the entry before it: one learnt only at the next visit would come after the name lapsed
/// (30 days). Two servers, their own names kept the same way.
#[test]
fn visits_14_days_apart_and_seconds_long_keep_a_name_resolving_and_owned() {
    let params = Params::TEST_PACED;
    let mut b = Bitcoin::new(ROOM, 70);
    let mut svc = Services::new(70);
    let node = [0x42; 32];
    let mut owners = [
        Owner::claimed(&mut b, &mut svc, 1, "alpha", t(20), [1; 32]),
        Owner::claimed(&mut b, &mut svc, 2, "bravo", t(20), [2; 32]),
        Owner::claimed(&mut b, &mut svc, 3, "promise", t(5), node),
    ];
    // The servers' own names renewed once already (at day -4), as a server's agent would have.
    for o in owners.iter_mut().take(2) {
        let it = o.visit(&mut b, &mut svc, t(5) as u64);
        assert_eq!(it.entries.len(), 2);
        svc.mine(1, t(4));
        svc.mine(6, t(4) + 600);
        o.collect(&b, &svc);
    }
    let title = |o: &mut Owner, b: &mut Bitcoin, svc: &mut Services, now: u64| Title {
        key: o.key.to_bytes().into(),
        item: o.visit(b, svc, now),
    };
    let s0 = Server::new(
        ROOM,
        cfg_with(
            params.clone(),
            vec![title(&mut owners[0], &mut b, &mut svc, T)],
        ),
        T,
    );
    let s1 = Server::new(
        ROOM,
        cfg_with(
            params.clone(),
            vec![title(&mut owners[1], &mut b, &mut svc, T)],
        ),
        T,
    );
    let mut bus = Bus::new(vec![s0, s1]);
    bus.svc = Some(svc);
    bus.advance(Duration::from_secs(60));
    let unix = bus.unix();
    let first = owners[2].visit(&mut b, bus.svc.as_mut().unwrap(), unix);
    assert_eq!(bus.put(1, 0, first), Msg::Taken);
    let id = b.names.name_id("promise");
    let key: [u8; 32] = owners[2].key.verifying_key().to_bytes().into();
    let mut visit_hour = None;
    let mut finished_before_the_owner = 0;
    // Visits at 14, 28, 42 and 56 days (two renewals, each stamped at a visit and finished by the servers); checked
    // every hour to day 60.
    for hour in 1..=60 * 24u32 {
        bus.advance(Duration::from_secs(3600));
        let unix = bus.unix();
        // The calendars finish what was stamped at a visit: in a block two hours after it, six deep an hour later.
        if visit_hour.is_some_and(|v| hour == v + 2) {
            bus.svc.as_mut().unwrap().mine(1, unix as u32);
        }
        if visit_hour.is_some_and(|v| hour == v + 3) {
            bus.svc.as_mut().unwrap().mine(6, unix as u32);
        }
        for (i, s) in bus.s.iter().enumerate() {
            assert_eq!(
                s.resolve("promise", "promise", unix),
                Answer::Node(node),
                "server {i}, hour {hour} (day {})",
                hour / 24
            );
            let o = s.reg.get(&id).and_then(|h| h.owner.clone()).unwrap();
            assert_eq!(o.owner, key, "owned by its key, server {i}, hour {hour}");
            assert_eq!(
                o.first(),
                owners[2].entries[0].id(),
                "one chain from its claim"
            );
        }
        if hour % (14 * 24) == 0 {
            // What the owner stamped at its last visit, the servers hold anchored before it comes back.
            let held = bus.s[0].reg.get(&id).unwrap();
            for e in owners[2].entries.iter().filter(|e| e.time().is_none()) {
                assert!(
                    held.name.get(&e.id()).is_some_and(|h| h.time().is_some()),
                    "a renewal the servers didn't finish (hour {hour})"
                );
                finished_before_the_owner += 1;
            }
            // A visit: seconds long, the page closed right after.
            let svc = bus.svc.as_mut().unwrap();
            for i in 0..2 {
                let t = title(&mut owners[i], &mut b, svc, unix);
                bus.s[i].set_titles(vec![t], unix);
            }
            let item = owners[2].visit(&mut b, svc, unix);
            assert_eq!(bus.put(1, 0, item), Msg::Taken);
            visit_hour = Some(hour);
        }
    }
    assert_eq!(
        owners.iter().map(|o| o.slow_visits).sum::<usize>(),
        0,
        "every renewal stamped was one made ahead"
    );
    let chain = bus.s[0].reg.get(&id).unwrap().owner.clone().unwrap();
    assert_eq!(
        chain.ids.len(),
        3,
        "the claim and a renewal at every other visit"
    );
    assert!(
        finished_before_the_owner >= 2,
        "{finished_before_the_owner}"
    );
    compiled_only(&bus);
    let (cal, exp) = bus.svc.as_ref().unwrap().counts();
    let finished: usize = bus.s.iter().map(|s| s.stats.finished).sum();
    eprintln!(
        "# 60 days, 3 names, 2 servers: {cal} calendar asks, {exp} explorer asks, {finished} renewals finished by \
         servers, {} blocks checked",
        bus.s.iter().map(|s| s.stats.blocks_checked).sum::<usize>()
    );
}

/// Twenty servers hold a renewal pending at a calendar that never finishes it: together they ask a few times an hour
/// (a chance a slot of about one over the room's servers, each counting them from its questions), fewer as it waits.
#[test]
fn calendar_asks_stay_bounded_across_twenty_servers() {
    let params = Params::TEST_PACED;
    let mut b = Bitcoin::new(ROOM, 71);
    let mut svc = Services::new(71);
    let mut servers = Vec::new();
    for k in 0..20u8 {
        let mut o = Owner::claimed(
            &mut b,
            &mut svc,
            k + 1,
            &format!("server{k}"),
            t(10),
            [k; 32],
        );
        let item = o.visit(&mut b, &mut svc, T);
        let title = Title {
            key: o.key.to_bytes().into(),
            item,
        };
        servers.push(Server::new(ROOM, cfg_with(params.clone(), vec![title]), T));
    }
    let mut owner = Owner::claimed(&mut b, &mut svc, 99, "waiting", t(16), [9; 32]);
    let mut bus = Bus::new(servers);
    bus.svc = Some(svc);
    bus.advance(Duration::from_secs(20 * 60));
    // Due: the renewal is stamped and put; its calendar never mines it.
    let unix = bus.unix();
    let item = owner.visit(&mut b, bus.svc.as_mut().unwrap(), unix);
    assert_eq!(bus.put(1, 0, item), Msg::Taken);
    let id = b.names.name_id("waiting");
    bus.advance(Duration::from_secs(15 * 60));
    let holding = (bus.s.iter())
        .filter(|s| s.reg.get(&id).is_some_and(|h| h.name.len() == 2))
        .count();
    assert_eq!(holding, 20, "every server holds the renewal");
    let ests: Vec<u32> = bus.s.iter().map(Server::room_servers).collect();
    let asked = |bus: &Bus| {
        bus.fetched
            .iter()
            .filter(|(_, u)| u.contains("/timestamp/"))
            .count()
    };
    let mut by_hour = Vec::new();
    for _ in 0..24 {
        let before = asked(&bus);
        bus.advance(Duration::from_secs(3600));
        by_hour.push(asked(&bus) - before);
    }
    let first: usize = by_hour[..12].iter().sum();
    let later: usize = by_hour[12..].iter().sum();
    eprintln!(
        "# twenty servers, one renewal its calendar never finishes: calendar asks by hour {by_hour:?} \
         ({first} in the first 12 h, {later} in the next 12); the servers' counts of the room {ests:?}"
    );
    assert!(by_hour.iter().all(|n| *n <= 12), "{by_hour:?}");
    assert!((10..=80).contains(&first), "{first}");
    assert!(later <= first, "{later} after {first}");
    assert!(
        bus.fetched
            .iter()
            .filter(|(_, u)| u.contains("/timestamp/"))
            .map(|(i, _)| i)
            .collect::<std::collections::BTreeSet<_>>()
            .len()
            > 5,
        "spread over the servers"
    );
    compiled_only(&bus);
}

/// Two servers, each with a name of its own on the pretend services, and a third name forged on a header the services
/// never mined (one at the tests' floor: what 1/16 of a block's work buys in production).
fn forged_room(seed: u64, params: Params) -> (Bitcoin, Bus, Item, [u8; 32]) {
    let mut b = Bitcoin::new(ROOM, seed);
    let mut svc = Services::new(seed);
    let mut servers = Vec::new();
    for k in 0..2u8 {
        let mut o = Owner::claimed(
            &mut b,
            &mut svc,
            k + 1,
            &format!("honest{k}"),
            t(10),
            [k; 32],
        );
        let item = o.visit(&mut b, &mut svc, T);
        let title = Title {
            key: o.key.to_bytes().into(),
            item,
        };
        servers.push(Server::new(ROOM, cfg_with(params.clone(), vec![title]), T));
    }
    let (_, forged) = b.title(9, "forged", t(30), &[t(16)], [9; 32]);
    let hash = forged.entries[1].anchor.as_ref().unwrap().1.hash();
    let mut bus = Bus::new(servers);
    bus.svc = Some(svc);
    (b, bus, forged, hash)
}

#[test]
fn a_block_both_explorers_deny_is_refused_with_its_anchors() {
    let (b, mut bus, forged, hash) = forged_room(72, Params::TEST);
    bus.advance(Duration::from_secs(60));
    let id = forged.id;
    // While the explorers can't be reached, the forged anchors count on their headers' work, as a member's do.
    // Put to both servers: a server isn't told of what was put by it (the putter holds it, as an owner's agent does),
    // so server 1 would hear of the name only at its next sync, a round's jitter either side of server 0's check.
    bus.svc.as_mut().unwrap().explorers_down = [true, true];
    assert_eq!(bus.put(1, 0, forged.clone()), Msg::Taken);
    assert_eq!(bus.put(0, 1, forged.clone()), Msg::Taken);
    assert!(bus.s.iter().all(|s| s.reg.get(&id).is_some()));
    bus.advance(Duration::from_secs(10));
    assert_eq!(
        bus.s[0].resolve("forged", "forged", bus.unix()),
        Answer::Node([9; 32])
    );
    // Both explorers answer: neither knows the blocks. Refused, with every anchor in them: the name goes.
    bus.svc.as_mut().unwrap().explorers_down = [false, false];
    bus.advance(Duration::from_secs(20 * 60));
    for (i, s) in bus.s.iter().enumerate() {
        assert!(
            s.reg.get(&id).is_none(),
            "server {i} still holds the forged name"
        );
        assert_eq!(s.resolve("forged", "forged", bus.unix()), Answer::Nx);
        assert!(s.stats.blocks_refused >= 1, "server {i}");
    }
    // The refusal is stored under the block's hash.
    let r = bus.stored[0].get(&hash).cloned().flatten().expect("stored");
    assert_eq!((r[0], r[1]), (super::server::BLOCK_RECORD, 2));
    // The honest names' blocks were checked and kept.
    for k in 0..2 {
        assert_eq!(
            bus.s[0].resolve(&format!("honest{k}"), &format!("honest{k}"), bus.unix()),
            Answer::Node([k as u8; 32])
        );
    }
    // Offered again within the day: its anchors are refused at once, nothing asked.
    let asked = bus.fetched.len();
    let back = bus.put(1, 0, forged.clone());
    assert!(
        matches!(back, Msg::Better(ref it) if it.entries.is_empty()),
        "{back:?}"
    );
    assert!(bus.s[0].reg.get(&id).is_none());
    assert_eq!(
        bus.fetched.len(),
        asked,
        "a refused block isn't asked again within its day"
    );
    // A server started from the stored records refuses it too, the name's record loaded before the block's.
    let mut s = Server::new(ROOM, cfg_with(Params::TEST, vec![]), bus.unix());
    let name_record = record(&forged, bus.unix());
    assert!(s.load(&name_record, bus.unix()));
    assert!(s.reg.get(&id).is_some());
    let refusals: Vec<Vec<u8>> = (bus.stored[0].values().flatten())
        .filter(|r| r[..2] == [super::server::BLOCK_RECORD, 2])
        .cloned()
        .collect();
    assert_eq!(refusals.len(), 2, "the claim's block and the renewal's");
    for r in &refusals {
        assert!(s.load(r, bus.unix()));
    }
    assert!(
        s.reg.get(&id).is_none(),
        "the loaded name's anchors in the refused blocks dropped"
    );
    // A day on, a refusal stored is let go at load (the page deletes it).
    assert!(!s.load(&r, bus.unix() + 24 * 3600));
    let _ = b;
    compiled_only(&bus);
}

/// Review 3's finding 7: a block neither explorer can be asked about is asked again after 5 minutes, doubling to 6
/// hours. The retry read its tries from the state being checked, so every retry waited 5 minutes: 144 checks a block
/// in 12 hours for good, at every server.
#[test]
fn a_block_no_explorer_answers_for_is_asked_again_ever_less_often() {
    let (b, mut bus, forged, hash) = forged_room(74, Params::TEST);
    bus.advance(Duration::from_secs(60));
    bus.svc.as_mut().unwrap().explorers_down = [true, true];
    assert_eq!(bus.put(1, 0, forged.clone()), Msg::Taken);
    let mut shown = hash;
    shown.reverse();
    let shown: String = shown.iter().map(|b| format!("{b:02x}")).collect();
    let asked = |bus: &Bus| {
        (bus.fetched.iter())
            .filter(|(i, u)| *i == 0 && u.contains(&shown))
            .count()
    };
    bus.advance(Duration::from_secs(12 * 3600));
    let n = asked(&bus);
    eprintln!("a block no explorer answers for, 12 hours: {n} asks at one server");
    // 5, 10, 20, 40, 80, 160, 320 minutes: 8 checks of two explorers in 12 hours (and the first's).
    assert!((2..=2 * 10).contains(&n), "{n} asks");
    // Its transport closing and opening again every 2 hours: the doubling kept.
    for _ in 0..6 {
        bus.s[0].stop();
        let (k, now) = (bus.keys[0], bus.now);
        bus.s[0].start(k, now);
        bus.advance(Duration::from_secs(2 * 3600));
    }
    let restarts = asked(&bus) - n;
    eprintln!("then six restarts 2 hours apart: {restarts} asks");
    assert!(restarts <= 2 * 8, "{restarts} asks");
    let _ = b;
}

#[test]
fn a_block_one_explorer_denies_counts_until_the_other_answers_and_is_kept_when_it_confirms() {
    let (b, mut bus, _, _) = forged_room(73, Params::TEST);
    let name = "honest1";
    // Server 1's own name, as it checks it.
    let header = {
        let h = bus.s[1].reg.get(&b.names.name_id(name)).unwrap();
        h.name.entries().next().unwrap().anchor().unwrap().header
    };
    let shown = super::testkit::shown(&header);
    let asked = |bus: &Bus| {
        (bus.fetched.iter())
            .filter(|(i, u)| *i == 1 && u.contains(&shown))
            .count()
    };
    // The first explorer denies its block; the second can't be reached: no verdict, asked again later, and the name
    // counts meanwhile on its header's work.
    bus.svc.as_mut().unwrap().denied[0].insert(header.hash());
    bus.svc.as_mut().unwrap().explorers_down = [false, true];
    bus.advance(Duration::from_secs(60));
    assert_eq!(asked(&bus), 2, "asked of both explorers");
    assert_eq!(bus.s[1].stats.blocks_refused, 0);
    assert_eq!(
        bus.s[1].resolve(name, name, bus.unix()),
        Answer::Node([1; 32])
    );
    // The second explorer back: asked again after its wait (5 minutes); the first denies it, the second confirms it.
    // Checked: one explorer's word for a block is enough.
    bus.svc.as_mut().unwrap().explorers_down = [false, false];
    bus.advance(Duration::from_secs(3 * 60));
    assert_eq!(asked(&bus), 2, "not before its wait");
    let checked = bus.s[1].stats.blocks_checked;
    bus.advance(Duration::from_secs(3 * 60));
    assert_eq!(asked(&bus), 4, "asked again of both");
    assert_eq!(bus.s[1].stats.blocks_checked, checked + 1);
    assert_eq!(bus.s[1].stats.blocks_refused, 0);
    assert_eq!(
        bus.s[1].resolve(name, name, bus.unix()),
        Answer::Node([1; 32])
    );
    bus.advance(Duration::from_secs(60 * 60));
    assert_eq!(asked(&bus), 4, "checked: not asked again");
    compiled_only(&bus);
}

/// Checks run from the module's ticks: a lookup, a member's `get` and the resolver answer from what is held whatever
/// the explorers do, and nothing is fetched to answer one.
#[test]
fn a_check_is_never_on_a_lookups_path() {
    let mut b = Bitcoin::new(ROOM, 74);
    let (key, item) = b.title(1, "alpha", t(20), &[t(4)], [1; 32]);
    let mut s = Server::new(
        ROOM,
        cfg_with(
            Params::TEST,
            vec![Title {
                key,
                item: item.clone(),
            }],
        ),
        T,
    );
    let now = Instant::now();
    s.start([0x5a; 32], now);
    // Nobody answers; nothing the page fetches comes back.
    let mut fetches = 0;
    for k in 0..40u64 {
        let at = now + Duration::from_millis(100 * k);
        s.tick(at, T + k / 10);
        while let Some(c) = s.poll() {
            fetches += matches!(c, Cmd::Fetch { .. }) as usize;
        }
    }
    assert!(fetches >= 1, "its blocks are asked about");
    let unix = T + 4;
    let at = now + Duration::from_secs(4);
    assert_eq!(s.resolve("alpha", "alpha", unix), Answer::Node([1; 32]));
    let get = Msg::Get {
        mode: GetMode::Owner,
        id: item.id.to_vec(),
        zone: (0, [0; 4]),
        held: vec![],
    };
    let back = exchange(&mut s, [0xdd; 32], 1, &get, at, unix);
    assert!(
        matches!(back.first(), Some(Msg::Items(v)) if v.len() == 1 && !v[0].entries.is_empty()),
        "{back:?}"
    );
    let mut more = 0;
    while let Some(c) = s.poll() {
        more += matches!(c, Cmd::Fetch { .. }) as usize;
    }
    assert_eq!(more, 0, "nothing fetched for a lookup");
}

/// A new server's first sync brings many blocks: checked one every `check_every_ms` at most, the newest arrival first.
/// Checks are stored and loaded back: a server restarted asks nothing again.
#[test]
fn block_checks_are_paced_newest_first_and_load_back() {
    let params = Params::TEST_PACED;
    let mut b = Bitcoin::new(ROOM, 75);
    let mut svc = Services::new(75);
    let mut titles = Vec::new();
    for k in 0..2u8 {
        let mut o = Owner::claimed(
            &mut b,
            &mut svc,
            k + 1,
            &format!("server{k}"),
            t(10),
            [k; 32],
        );
        let item = o.visit(&mut b, &mut svc, T);
        titles.push(Title {
            key: o.key.to_bytes().into(),
            item,
        });
    }
    // Thirty names, each in a block of its own, loaded as a server's records.
    let mut records = Vec::new();
    for k in 0..30u8 {
        let mut o = Owner::claimed(
            &mut b,
            &mut svc,
            100 + k,
            &format!("name{k}"),
            t(5),
            [k; 32],
        );
        records.push(record(&o.visit(&mut b, &mut svc, T), T - 3600));
    }
    let mut late = Owner::claimed(&mut b, &mut svc, 99, "late", t(2), [7; 32]);
    let late_block = super::testkit::shown(&late.entries[0].anchor().unwrap().header);
    let mut s0 = Server::new(ROOM, cfg_with(params.clone(), vec![titles.remove(0)]), T);
    for r in &records {
        assert!(s0.load(r, T));
    }
    let s1 = Server::new(ROOM, cfg_with(params.clone(), titles), T);
    let mut bus = Bus::new(vec![s0, s1]);
    bus.svc = Some(svc);
    let checks = |bus: &Bus| -> Vec<String> {
        (bus.fetched.iter())
            .filter(|(i, u)| *i == 0 && u.contains("/block/"))
            .map(|(_, u)| u.clone())
            .collect()
    };
    bus.advance(Duration::from_secs(30));
    let n = checks(&bus).len();
    assert!((9..=11).contains(&n), "{n} checks in 30 s, one every 3 s");
    // Past the servers' first sync (a round, its jitter up to 6 s, after the 30 s nobody answered): it brings server
    // 1's block, an arrival newer than one put before it.
    bus.advance(Duration::from_secs(15));
    let n = checks(&bus).len();
    // A new arrival goes first.
    let unix = bus.unix();
    let item = late.visit(&mut b, bus.svc.as_mut().unwrap(), unix);
    bus.put(1, 0, item);
    bus.advance(Duration::from_secs(3));
    assert!(
        checks(&bus)[n..].iter().any(|u| u.contains(&late_block)),
        "the newest within one pace"
    );
    // All of them in time, then nothing more.
    bus.advance(Duration::from_secs(3 * 40));
    let all = checks(&bus).len();
    assert_eq!(
        bus.s[0].stats.blocks_checked, 33,
        "30 loaded, the two servers' own, the late one"
    );
    bus.advance(Duration::from_secs(10 * 60));
    assert_eq!(checks(&bus).len(), all, "each block once");
    // Restarted from what it stored: nothing asked again.
    let stored: Vec<Vec<u8>> = bus.stored[0].values().flatten().cloned().collect();
    assert!(
        stored
            .iter()
            .filter(|r| r[0] == super::server::BLOCK_RECORD)
            .count()
            >= 33
    );
    let mut again = Server::new(ROOM, cfg_with(params, vec![]), bus.unix());
    for r in &stored {
        again.load(r, bus.unix());
    }
    again.start([0x77; 32], bus.now);
    let mut asked = 0;
    for k in 0..100u64 {
        again.tick(bus.now + Duration::from_secs(3 * k), bus.unix() + 3 * k);
        while let Some(c) = again.poll() {
            asked += matches!(c, Cmd::Fetch { ref url, .. } if url.contains("/block/")) as usize;
        }
    }
    assert_eq!(asked, 0, "every block's check loaded back");
    compiled_only(&bus);
}

// ---- R3: asks and replies (docs/plans/room-names-r3.md) ----

/// What a server says to one ask: the reply (decoded), whether it called the asker back, and what it sent it.
fn ask_one(
    s: &mut Server,
    ask: super::wire::NameAsk,
    now: Instant,
    unix: u64,
) -> (Option<super::wire::Reply>, bool, Option<Msg>) {
    s.input(
        Input::Ask {
            ask,
            region: Some(0),
            via: [0; 16],
        },
        now,
        unix,
    );
    let (mut reply, mut called, mut sent) = (None, false, None);
    let mut z = Transfers::default();
    while let Some(c) = s.poll() {
        match c {
            Cmd::Reply { to, data, .. } => {
                assert_eq!(to, ask.key, "under the asker's reply tag");
                reply = Some(super::wire::Reply::decode(&data).unwrap());
            }
            Cmd::CallBack { key, .. } => called |= key == ask.key,
            Cmd::Send { data, .. } => {
                if let Some((_, m)) = z.input([7; 32], &data, now) {
                    sent = Some(Msg::decode(&m).unwrap().0);
                }
            }
            _ => {}
        }
    }
    (reply, called, sent)
}

fn an_ask(
    key: u8,
    n: u32,
    id: [u8; 32],
    mode: super::wire::AskMode,
    spread: u8,
    shown: [u8; 8],
) -> super::wire::NameAsk {
    let mut nonce = [key; 16];
    nonce[..4].copy_from_slice(&n.to_le_bytes());
    super::wire::NameAsk {
        key: [key; 32],
        region: 0,
        time: T,
        nonce,
        id,
        mode,
        spread,
        shown,
    }
}

/// A server's replies: a `share` in its share (with the owning chain's last entry and the zone, or none), a `dissent`
/// only where it holds another owner, a `fetch` only when it names this server (a call back and the whole run); once
/// a nonce; nothing before its first sync.
#[test]
fn a_server_replies_to_asks_by_their_mode() {
    use super::wire::{AskMode, ReplyItem};
    let mut b = Bitcoin::new(ROOM, 50);
    let (key, item) = b.title(1, "mine", t(20), &[t(5)], [9; 32]);
    let (_, alpha) = b.title(2, "alpha", t(30), &[t(15), t(2)], [0xa1; 32]);
    let owner = alpha.entries[0].entry.owner;
    let mut s = Server::new(ROOM, cfg(vec![Title { key, item }]), T);
    assert!(s.load(&record(&alpha, T), T));
    let me = [7u8; 32];
    let mut now = Instant::now();
    s.start(me, now);
    while s.poll().is_some() {}
    let none = [0u8; 8];
    let ask = |k, n, mode, spread, shown| an_ask(k, n, alpha.id, mode, spread, shown);
    assert!(
        ask_one(&mut s, ask(1, 0, AskMode::Share, 0, none), now, T)
            .0
            .is_none(),
        "not before its first sync"
    );
    s.synced = true;
    now += Duration::from_secs(2);
    let (r, called, _) = ask_one(&mut s, ask(1, 1, AskMode::Share, 0, none), now, T);
    let r = r.expect("everyone asked: a reply");
    assert!(!called, "a reply is no call back");
    assert_eq!((r.server, r.since), (me, t(30)));
    let ReplyItem::Item(it) = &r.item else {
        panic!("{:?}", r.item)
    };
    assert_eq!(it.entries.len(), 1, "the last entry alone");
    assert_eq!(it.entries[0], alpha.entries[2]);
    assert_eq!(it.zone, alpha.zone);
    assert!(
        ask_one(&mut s, ask(1, 1, AskMode::Share, 0, none), now, T)
            .0
            .is_none(),
        "once a nonce (an ask's rounds share it)"
    );
    // A name it doesn't hold: none.
    now += Duration::from_secs(2);
    let r = ask_one(
        &mut s,
        an_ask(3, 2, [5; 32], AskMode::Share, 0, none),
        now,
        T,
    )
    .0;
    assert_eq!(r.map(|r| r.item), Some(ReplyItem::None));
    // The share: by the hash of its own live names' owner keys, as "who serves?".
    let mine = s
        .reg
        .get(&b.names.name_id("mine"))
        .unwrap()
        .owner
        .as_ref()
        .unwrap()
        .owner;
    let mut inside = 0;
    for n in 10..74u32 {
        now += Duration::from_secs(1);
        let a = ask(4, n, AskMode::Share, 3, none);
        let replied = ask_one(&mut s, a, now, T).0.is_some();
        assert_eq!(
            replied,
            in_share(rank(&share_hash(&a.nonce, &mine)), 3),
            "{n}"
        );
        inside += replied as usize;
    }
    assert!((2..=20).contains(&inside), "{inside} of 64 at 1/8");
    // A dissent: silent when it holds what was shown (the owner key, its last entry and the zone), a reply when it
    // holds anything else (or none was shown).
    now += Duration::from_secs(1);
    let last = alpha.entries[2].entry.id();
    let shown = super::wire::shown(&owner, &last, alpha.zone.as_ref());
    assert!(
        ask_one(&mut s, ask(5, 100, AskMode::Dissent, 6, shown), now, T)
            .0
            .is_none()
    );
    // R3a: the owner's own last entry with an old zone or none, or its entry a renewal behind, is another thing shown.
    let key2 = b.key(2, "alpha");
    let old = Zone::seal(&b.names, &key2, "alpha", 0, &[(None, [1; 32])], false).unwrap();
    let before = alpha.entries[1].entry.id();
    for (n, other) in [
        (110, super::wire::shown(&owner, &last, Some(&old))),
        (111, super::wire::shown(&owner, &last, None)),
        (
            112,
            super::wire::shown(&owner, &before, alpha.zone.as_ref()),
        ),
        (113, owner[..8].try_into().unwrap()),
    ] {
        now += Duration::from_secs(1);
        assert!(
            ask_one(&mut s, ask(5, n, AskMode::Dissent, 6, other), now, T)
                .0
                .is_some(),
            "{n}"
        );
    }
    assert!(
        ask_one(&mut s, ask(5, 101, AskMode::Dissent, 6, [1; 8]), now, T)
            .0
            .is_some()
    );
    now += Duration::from_secs(1);
    assert!(
        ask_one(&mut s, ask(5, 102, AskMode::Dissent, 6, none), now, T)
            .0
            .is_some()
    );
    assert!(
        ask_one(
            &mut s,
            an_ask(5, 103, [5; 32], AskMode::Dissent, 6, none),
            now,
            T
        )
        .0
        .is_none(),
        "no owner held: nothing to dissent with"
    );
    // A fetch: only one naming this server; a call back and the owning chain's whole run.
    now += Duration::from_secs(1);
    let (r, called, _) = ask_one(&mut s, ask(6, 200, AskMode::Fetch, 0, [1; 8]), now, T);
    assert!(r.is_none() && !called, "another server's fetch");
    let (r, called, sent) = ask_one(
        &mut s,
        ask(6, 201, AskMode::Fetch, 0, me[..8].try_into().unwrap()),
        now,
        T,
    );
    assert!(r.is_none() && called);
    let Some(Msg::Items(items)) = sent else {
        panic!("{sent:?}")
    };
    assert_eq!(items[0].entries, alpha.entries, "the whole run");
    assert_eq!(s.stats.fetched, 1);
}

/// The final review's finding 5: a server holding a release (a tombstone) replies it, with what leads to it as far as
/// a reply carries: in place of none to a `share`, beside the owner's reply when the name has a next owner, and to a
/// `dissent` whatever it showed (the released chain's last entry, replayed, is alive by its own time).
#[test]
fn a_server_holding_a_release_replies_it() {
    use super::wire::{AskMode, Reply, ReplyItem};
    let mut b = Bitcoin::new(ROOM, 57);
    let (key, item) = b.title(1, "mine", t(20), &[t(5)], [9; 32]);
    let k = b.key(2, "shop");
    let claim = b.at(Kind::Claim, &k, "shop", [0; 32], t(30));
    let renew = b.at(Kind::Renew, &k, "shop", claim.id(), t(10));
    let release = b.at(Kind::Release, &k, "shop", renew.id(), t(1));
    let gone = b.item("shop", &[claim, renew.clone(), release.clone()], None);
    let mut s = Server::new(ROOM, cfg(vec![Title { key, item }]), T);
    assert!(s.load(&record(&gone, T), T));
    let mut now = Instant::now();
    s.start([7; 32], now);
    while s.poll().is_some() {}
    s.synced = true;
    let replies = |s: &mut Server, a: super::wire::NameAsk, now: Instant| -> Vec<Reply> {
        s.input(
            Input::Ask {
                ask: a,
                region: Some(0),
                via: [0; 16],
            },
            now,
            T,
        );
        let mut v = Vec::new();
        while let Some(c) = s.poll() {
            if let Cmd::Reply { data, .. } = c {
                v.push(Reply::decode(&data).unwrap());
            }
        }
        v
    };
    let ids = |r: &Reply| match &r.item {
        ReplyItem::Item(it) => it.entries.iter().map(|w| w.entry.id()).collect::<Vec<_>>(),
        other => panic!("{other:?}"),
    };
    let r = replies(
        &mut s,
        an_ask(1, 1, gone.id, AskMode::Share, 0, [0; 8]),
        now,
    );
    assert_eq!(r.len(), 1, "the release in place of none");
    assert_eq!(
        ids(&r[0]),
        [release.id(), renew.id(), gone.entries[0].entry.id()]
    );
    // What fits: none when not even the release does.
    s.reply_max = 1;
    now += Duration::from_secs(1);
    let r = replies(
        &mut s,
        an_ask(1, 2, gone.id, AskMode::Share, 0, [0; 8]),
        now,
    );
    assert_eq!(r.len(), 1);
    assert_eq!(r[0].item, ReplyItem::None, "nothing fits");
    s.reply_max = super::wire::REPLY_MAX;
    // A dissent naming the replayed last entry: the release.
    now += Duration::from_secs(1);
    let shown = super::wire::shown(&renew.entry.owner, &renew.id(), None);
    let r = replies(
        &mut s,
        an_ask(2, 3, gone.id, AskMode::Dissent, 6, shown),
        now,
    );
    assert_eq!(r.len(), 1);
    assert_eq!(ids(&r[0])[0], release.id());
    // Registered again since: the next owner's reply, and the release in one of its own.
    let (_, next) = b.title(3, "shop", t(0), &[], [3; 32]);
    assert!(s.load(&record(&next, T), T));
    now += Duration::from_secs(1);
    let r = replies(
        &mut s,
        an_ask(3, 4, gone.id, AskMode::Share, 0, [0; 8]),
        now,
    );
    assert_eq!(r.len(), 2, "{r:?}");
    assert_eq!(ids(&r[0]), [next.entries[0].entry.id()]);
    assert_eq!(ids(&r[1])[0], release.id());
    // Once a nonce and key, both.
    assert!(
        replies(
            &mut s,
            an_ask(3, 4, gone.id, AskMode::Share, 0, [0; 8]),
            now
        )
        .is_empty()
    );
}

/// The final review's finding 3: a first lookup's rounds share their nonce, and a server replied to a nonce once,
/// whoever asked. Anyone who read the first round could send its nonce under another key first (spread 0), and the
/// asker's later rounds and dissent went unreplied. Once a nonce and asker key: a copy through another relay is the
/// same key's, and is still replied to once.
#[test]
fn a_nonce_copied_under_another_key_doesnt_silence_the_asker() {
    use super::wire::AskMode;
    let mut b = Bitcoin::new(ROOM, 53);
    let (key, item) = b.title(1, "mine", t(20), &[t(5)], [9; 32]);
    let (_, alpha) = b.title(2, "alpha", t(30), &[t(15), t(2)], [0xa1; 32]);
    let mut s = Server::new(ROOM, cfg(vec![Title { key, item }]), T);
    assert!(s.load(&record(&alpha, T), T));
    let now = Instant::now();
    s.start([7; 32], now);
    while s.poll().is_some() {}
    s.synced = true;
    let honest = an_ask(1, 1, alpha.id, AskMode::Share, 0, [0; 8]);
    let forged = super::wire::NameAsk {
        key: [0x66; 32],
        ..honest
    };
    assert!(
        ask_one(&mut s, forged, now, T).0.is_some(),
        "the forger's own reply"
    );
    let r = ask_one(&mut s, honest, now, T).0;
    assert!(r.is_some(), "the asker still gets its reply");
    assert!(
        ask_one(&mut s, honest, now, T).0.is_none(),
        "once a nonce and key (a round again, a copy through another relay)"
    );
}

/// Reply budgets: 2 a second a server, 16 a minute under one reply tag, apart from "who serves?"'s answers. A flood of
/// forged asks (dissents naming a made-up owner, shares at spread 0) makes few replies, and questions are still
/// answered meanwhile.
#[test]
fn reply_budgets_bound_a_flood_of_forged_asks() {
    use super::wire::AskMode;
    let mut b = Bitcoin::new(ROOM, 51);
    let (key, item) = b.title(1, "mine", t(20), &[t(5)], [9; 32]);
    let (_, alpha) = b.title(2, "alpha", t(30), &[t(2)], [0xa1; 32]);
    let mut s = Server::new(ROOM, cfg(vec![Title { key, item }]), T);
    assert!(s.load(&record(&alpha, T), T));
    let mut now = Instant::now();
    s.start([7; 32], now);
    s.synced = true;
    while s.poll().is_some() {}
    // Per server: 200 forged asks from 200 keys within a second, for ten seconds.
    let mut replies = 0;
    for sec in 0..10u32 {
        for k in 0..200u32 {
            let mut a = an_ask(1, sec * 1000 + k, alpha.id, AskMode::Dissent, 0, [1; 8]);
            a.key[..4].copy_from_slice(&k.to_le_bytes());
            let a = if k % 2 == 0 {
                a
            } else {
                super::wire::NameAsk {
                    mode: AskMode::Share,
                    ..a
                }
            };
            replies += ask_one(&mut s, a, now + Duration::from_millis(k as u64 * 4), T)
                .0
                .is_some() as usize;
            if k == 100 {
                // "Who serves?" is answered from its own budget meanwhile.
                let q = Question {
                    key: [0xcc; 32],
                    region: 0,
                    time: T,
                    nonce: [sec as u8; 16],
                    spread: 0,
                };
                s.input(Input::Question { q, region: 0 }, now, T);
                let mut called = false;
                while let Some(c) = s.poll() {
                    called |= matches!(c, Cmd::CallBack { .. });
                }
                assert!(called || sec >= 4, "second {sec}: a question answered");
                s.input(Input::Gone([0xcc; 32]), now, T);
                while s.poll().is_some() {}
            }
        }
        now += Duration::from_secs(1);
    }
    eprintln!("2,000 forged asks over 10 s from 200 keys: {replies} replies");
    assert!(replies <= 2 * 10 + 2, "{replies}: 2 a second");
    // Per tag: one key's asks, spread out so the second's budget always has room, for two minutes.
    let mut one = 0;
    for n in 0..120u32 {
        now += Duration::from_secs(1);
        let a = an_ask(9, 5000 + n, alpha.id, AskMode::Dissent, 0, [1; 8]);
        one += ask_one(&mut s, a, now, T).0.is_some() as usize;
    }
    eprintln!("one reply tag's 120 asks over 2 minutes: {one} replies");
    assert!(
        (16..=REPLIES_PER_TAG * 2 + 1).contains(&one),
        "{one}: 16 a minute"
    );
    assert!(s.stats.replies_refused > 0);
}

/// A server is one draw in a `share` ask, however many names it owns: the spread is a share of the room's servers
/// (NAMES loop 6a: drawn over each of its names' owner keys, a server of 250 names fell in a spread of 6, 1/64, 98% of
/// the time, so every first lookup in a room of 20 such servers brought ~15 replies, and 500 members joining in a
/// minute spent the servers' reply budgets: 221 of their 500 lookups were NXDOMAIN).
#[test]
fn a_server_with_many_names_is_one_draw_in_a_share() {
    use super::wire::AskMode;
    let mut b = Bitcoin::new(ROOM, 53);
    let titles: Vec<Title> = (0..64u8)
        .map(|k| {
            let (key, item) = b.title(1, &format!("many{k}"), t(20), &[t(5)], [k; 32]);
            Title { key, item }
        })
        .collect();
    let mut s = Server::new(ROOM, cfg(titles), T);
    let mut now = Instant::now();
    s.start([7; 32], now);
    s.synced = true;
    while s.poll().is_some() {}
    let (_, alpha) = b.title(2, "alpha", t(30), &[t(2)], [0xa1; 32]);
    assert!(s.load(&record(&alpha, T), T));
    let mut replies = 0;
    for n in 0..256u32 {
        now += Duration::from_secs(4); // past both budgets
        let mut a = an_ask(3, n, alpha.id, AskMode::Share, 6, [0; 8]);
        a.key[..4].copy_from_slice(&n.to_le_bytes());
        replies += ask_one(&mut s, a, now, T).0.is_some() as usize;
    }
    // One draw: 256 / 64 = 4 expected; 64 draws: ~161.
    assert!(replies <= 16, "{replies} of 256 asks at spread 6 replied");
}

/// A reply's item is bounded: past the server's `reply_max` (4 KiB) it is left out, and the reply says so.
#[test]
fn an_item_past_the_reply_bound_is_left_out() {
    use super::wire::{AskMode, REPLY_MAX, ReplyItem};
    let mut b = Bitcoin::new(ROOM, 52);
    let (key, item) = b.title(1, "mine", t(20), &[t(5)], [9; 32]);
    let (_, alpha) = b.title(2, "alpha", t(30), &[t(2)], [0xa1; 32]);
    let mut s = Server::new(ROOM, cfg(vec![Title { key, item }]), T);
    assert!(s.load(&record(&alpha, T), T));
    assert_eq!(s.reply_max, REPLY_MAX);
    let mut now = Instant::now();
    s.start([7; 32], now);
    s.synced = true;
    while s.poll().is_some() {}
    let r = ask_one(
        &mut s,
        an_ask(1, 1, alpha.id, AskMode::Share, 0, [0; 8]),
        now,
        T,
    )
    .0
    .unwrap();
    let ReplyItem::Item(it) = r.item else {
        panic!()
    };
    let size = it.encode().len();
    s.reply_max = size - 1;
    now += Duration::from_secs(1);
    let r = ask_one(
        &mut s,
        an_ask(1, 2, alpha.id, AskMode::Share, 0, [0; 8]),
        now,
        T,
    )
    .0
    .unwrap();
    // The last entry alone, without the zone: something a member can check.
    assert_eq!(
        r.item,
        ReplyItem::TooBig(Box::new(Item {
            zone: None,
            ..*it.clone()
        })),
        "{size} bytes past {}",
        size - 1
    );
    assert_eq!(super::wire::Reply::decode(&r.encode()).unwrap(), r);
    // And a member refuses a reply whose item is past REPLY_MAX at the wire.
    let big = super::wire::Reply {
        item: ReplyItem::Item(Box::new(Item {
            zone: None,
            ..*it.clone()
        })),
        ..r.clone()
    };
    let mut bytes = big.encode();
    bytes.extend(vec![0; REPLY_MAX]);
    assert!(super::wire::Reply::decode(&bytes).is_err());
}

/// NAMES loop 6a (bench/net/REPORT.md "NAMES loop 6a"; a bench, not a check: `cargo test -p waarm64_ts --release
/// forged_asks_in_a_room_of_hundreds -- --ignored --nocapture`): a flood of forged asks (dissents showing a made-up
/// owner, from a fresh reply tag each) reaching every server of a room of 300 that holds the name: what the servers
/// reply together, a second and in bytes, against the flood's size.
#[test]
#[ignore]
fn forged_asks_in_a_room_of_hundreds() {
    use super::wire::AskMode;
    let mut b = Bitcoin::new(ROOM, 61);
    let (_, alpha) = b.title(2, "alpha", t(30), &[t(2)], [0xa1; 32]);
    let now0 = Instant::now();
    let mut servers: Vec<Server> = (0..300u32)
        .map(|k| {
            let (key, item) = b.title(
                3 + (k % 200) as u8,
                &format!("server{k}"),
                t(20),
                &[t(5)],
                [9; 32],
            );
            let mut s = Server::new(ROOM, cfg(vec![Title { key, item }]), T);
            assert!(s.load(&record(&alpha, T), T));
            let mut k32 = [0x77; 32];
            k32[..4].copy_from_slice(&k.to_le_bytes());
            s.start(k32, now0);
            s.synced = true;
            while s.poll().is_some() {}
            s
        })
        .collect();
    for per_second in [10u32, 100, 1000] {
        let (mut replies, mut bytes) = (0usize, 0usize);
        let mut now = now0 + Duration::from_secs(120 * per_second as u64);
        for sec in 0..10u32 {
            for n in 0..per_second {
                let mut a = an_ask(1, sec * 100_000 + n, alpha.id, AskMode::Dissent, 0, [1; 8]);
                a.key[..4]
                    .copy_from_slice(&(per_second * 1_000_000 + sec * 100_000 + n).to_le_bytes());
                let at = now + Duration::from_micros(1_000_000 * n as u64 / per_second as u64);
                for s in servers.iter_mut() {
                    s.input(
                        Input::Ask {
                            ask: a,
                            region: Some(0),
                            via: [0; 16],
                        },
                        at,
                        T,
                    );
                    while let Some(c) = s.poll() {
                        if let Cmd::Reply { data, .. } = c {
                            replies += 1;
                            bytes += data.len();
                        }
                    }
                }
            }
            now += Duration::from_secs(1);
        }
        eprintln!(
            "# 300 servers holding the name, {per_second} forged asks a second for 10 s: {replies} replies \
             ({} a second, {} KB a second unsealed; an ask's item here {} bytes)",
            replies / 10,
            bytes / 10 / 1000,
            alpha.encode().len()
        );
        assert!(replies <= 300 * 2 * 10 + 300);
    }
}
