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
        ANSWERS_PER_SECOND, Cmd, Config, Input, MAX_BYTES, MAX_NAMES, SPREADS, Server, TIERS,
        Title, UNITS_PER_TURN, check_serve, in_share, rank, share_hash,
    },
    store::read_record,
    testkit::{Bitcoin, DAY, EASY, HOUR, header, params},
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
    t0: Instant,
    now: Instant,
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
            t0: now,
            now,
        };
        for i in 0..n {
            let k = b.keys[i];
            b.s[i].start(k, now);
        }
        b.run();
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
                    self.s[j].input(Input::Datagram { from, data }, now, unix);
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
            Cmd::Accept { .. } | Cmd::Log(_) | Cmd::Served(..) => {}
        }
    }

    fn advance(&mut self, d: Duration) {
        let end = self.now + d;
        loop {
            self.run();
            let next = self.s.iter().filter_map(Server::deadline).min();
            match next {
                Some(t) if t <= end => {
                    self.now = t.max(self.now);
                    let (now, unix) = (self.now, self.unix());
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
    // Two entries, sixteen headers (each `ref`, each anchor's block and the six after it), one zone: headers once
    // each. An anchor adds 13 bytes for its followers (a count and six indices), a distinct block 480 (six headers).
    assert_eq!(
        enc.len(),
        1 + 32
            + 2
            + (2 + 2 * 7) * 80
            + 2
            + 2 * (207
                + 2
                + 2
                + item.entries[0].anchor.as_ref().unwrap().0.encode().len()
                + 2
                + 1
                + 6 * 2
                + 2)
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
            entries: item.entries.clone(),
            sig: [6; 64],
        },
    ] {
        assert_eq!(Msg::decode(&m.encode(42)), Ok((m, 42)));
    }
    let r = Range::ALL.child(0xa).child(0x5);
    assert_eq!(r.bounds().0[0], 0xa5);
    assert!(r.contains(&[0xa5; 32]) && !r.contains(&[0xa6; 32]));
    // A long message in parts, at most 8 in flight, a third of the datagrams lost, resent.
    let (mut a, mut z) = (Transfers::default(), Transfers::default());
    let (ka, kz) = ([1; 32], [2; 32]);
    let msg: Vec<u8> = (0..20_000u32).map(|i| i as u8).collect();
    let mut now = Instant::now();
    a.send(kz, &msg, now);
    assert_eq!(a.out.len(), 8, "8 in flight");
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
        let asker = [0xee; 32];
        for k in 0..QUESTIONS {
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
                            assert!(in_share(
                                rank(&share_hash(&nonce, &owners[i]), TIERS),
                                *spread
                            ));
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
    // The run shown is the chain's tail, and its age is the tier: the server's title (20 days) is tier 1; a claim
    // made yesterday tier 0; an entry off the run, or another name's, refuses the serve.
    assert_eq!(
        entry.len(),
        2,
        "the whole title: it's younger than the top tier"
    );
    assert_eq!(check(&mut b, &nonce, &me, &entry, &sig).map(|x| x.2), Ok(1));
    assert_eq!(
        check(&mut b, &nonce, &me, &entry[1..], &sig).map(|x| x.2),
        Ok(0),
        "the last entry alone: its own age"
    );
    let off = b.at(Kind::Claim, &k, "dead", [0; 32], t(12));
    let both = [w.clone(), WireEntry::of(&off)];
    assert!(
        check(&mut b, &nonce, &me, &both, &dsig).is_err(),
        "off the run"
    );
    let other = b.at(Kind::Claim, &k, "other", [0; 32], t(10));
    let both = [w, WireEntry::of(&other)];
    assert!(
        check(&mut b, &nonce, &me, &both, &dsig).is_err(),
        "another name"
    );
    let long = Msg::Serve {
        nonce,
        entries: vec![entry[0].clone(); super::server::SERVE_RUN + 1],
        sig,
    };
    assert!(
        Msg::decode(&long.encode(0)).is_err(),
        "past SERVE_RUN entries"
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
    let mut r = b.entry(Kind::Renew, &k4, "contested", last, t(1));
    let mut pend = super::anchor::Pending {
        calendar: super::anchor::Calendar::Alice,
        ops: vec![super::anchor::Op::Sha256],
        sig: [0; 64],
    };
    super::entry::sign_pending(&k4, &b.names, &r.id(), &mut pend);
    assert!(r.offer_pending(pend, &b.params, T));
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
    let mut e = Entry::new(
        &b.names,
        Kind::Claim,
        id,
        good.entry.owner,
        [0; 32],
        good.entry.refb,
    );
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
    // `ref`'s header not `ref`'s block.
    let mut w = WireEntry::of(&good);
    w.ref_header = header(&mut b.rng, t(10), [0; 32], EASY);
    refused(&mut bus, item(&b, w));
    // An anchor header whose work is broken; one that doesn't reach the root; one past the
    // window: the entry is unanchored, a claim without a time, so nothing is kept.
    let mut w = WireEntry::of(&good);
    w.anchor.as_mut().unwrap().1.block.0[40] ^= 1;
    refused(&mut bus, item(&b, w));
    let mut w = WireEntry::of(&good);
    w.anchor.as_mut().unwrap().0.ops[0] = super::anchor::Op::Append(vec![0; 16]);
    refused(&mut bus, item(&b, w));
    let mut w = WireEntry::of(&good);
    let (a, h) = b.anchor(&good.id(), t(10) + 50 * HOUR);
    w.anchor = Some((a, h));
    refused(&mut bus, item(&b, w));
    // A header from the future.
    let mut w = WireEntry::of(&good);
    let (a, h) = b.anchor(&good.id(), (T + 3 * HOUR as u64) as u32);
    w.anchor = Some((a, h));
    refused(&mut bus, item(&b, w));
    // The real one is taken; a zone signed by another key, or broken, isn't.
    let other_key = b.key(2, "forged");
    let z = Zone::seal(&b.names, &other_key, "forged", 9, &[(None, [5; 32])], false).unwrap();
    let mut it = item(&b, WireEntry::of(&good));
    it.zone = Some(z);
    assert_eq!(bus.put(1, 0, it), Msg::Taken);
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

#[test]
fn an_entry_held_takes_a_new_anchor_only_when_earlier() {
    let mut b = Bitcoin::new(ROOM, 13);
    let k = b.key(1, "anchors");
    let mut late = b.entry(Kind::Claim, &k, "anchors", [0; 32], t(10));
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
        assert!(w.room(t0));
        assert_eq!(w.admit([k; 32], t0), None);
    }
    w.served(&[0; 32], 5);
    // An honest server's call back a second later: a session that never served is let go for it.
    let t1 = t0 + Duration::from_millis(1100);
    assert!(w.room(t1), "room for a server's call back");
    let gone = w.admit([200; 32], t1);
    assert!(
        gone.is_some_and(|g| g != [0; 32]),
        "{gone:?}: one that never served goes, not the one that did"
    );
    // Keys just let in hold their place for a while; the window closes with the question.
    for k in 0..(ACCEPT_MAX - 2) as u8 {
        assert!(w.room(t1));
        w.admit([100 + k; 32], t1);
    }
    assert!(
        !w.room(t1 + Duration::from_millis(100)),
        "everyone in it new or served"
    );
    assert!(!w.room(t0 + Duration::from_millis(2500)));
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
        assert!(w.room(t0));
        assert_eq!(w.admit([k; 32], t0), None);
        w.served(&[k; 32], 1000 - k as u128); // the later, the better
    }
    let t1 = t0 + Duration::from_millis(100);
    assert!(w.room(t1), "room for an honest server answering late");
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

#[test]
fn a_put_of_one_junk_entry_many_times_costs_one_check() {
    let mut b = Bitcoin::new(ROOM, 45);
    let k = b.key(1, "junk");
    let good = b.at(Kind::Claim, &k, "junk", [0; 32], t(10));
    // Signed with the sender's own key, a real `ref` header, no work.
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
    let r = b.entry(Kind::Renew, &key, "pending", last, t(1));
    let mut good = Pending {
        calendar: Calendar::Bob,
        ops: vec![Op::Sha256],
        sig: [0; 64],
    };
    super::entry::sign_pending(&key, &b.names, &r.id(), &mut good);
    let with = |p: &Pending| {
        let mut s = r.clone();
        assert!(s.offer_pending(p.clone(), &b.params, T));
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
