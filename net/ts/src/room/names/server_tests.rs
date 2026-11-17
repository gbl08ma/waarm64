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
        ANSWERS_PER_SECOND, Cmd, Config, Input, MAX_BYTES, MAX_NAMES, SPREADS, Server, Title,
        UNITS_PER_TURN, check_serve, in_share, share_hash,
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
            Cmd::Accept { .. } | Cmd::Log(_) => {}
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
    // Two entries, four headers (each `ref` and each anchor's), one zone: headers once each.
    assert_eq!(
        enc.len(),
        1 + 32
            + 2
            + 4 * 80
            + 2
            + 2 * (207 + 2 + 2 + item.entries[0].anchor.as_ref().unwrap().0.encode().len() + 2 + 2)
            + 2
            + 362
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
        },
        Msg::SyncAnswer(SyncAnswer::Listing(vec![([1; 8], [2; 8])])),
        Msg::Serve {
            nonce: [5; 16],
            entry: Box::new(item.entries[1].clone()),
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
    let (key, item) = b.title(1, "shared", t(20), &[t(5)], [9; 32]);
    let mut rows = Vec::new();
    for n in [1usize, 20, 500] {
        let servers: Vec<Server> = (0..n)
            .map(|_| {
                let mut s = Server::new(
                    ROOM,
                    cfg(vec![Title {
                        key,
                        item: item.clone(),
                    }]),
                    T,
                );
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
                            assert!(in_share(&share_hash(&nonce, &bus.keys[i]), *spread));
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
    // Room for 32 askers at once.
    for k in 0..40u8 {
        bus.now += Duration::from_millis(300);
        ask(&mut bus, 50 + k, 150 + k);
    }
    assert!(!ask(&mut bus, 99, 250), "no room past 32 askers");
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
        entry,
        sig,
    }) = serve
    else {
        panic!("a serve")
    };
    assert_eq!(n, nonce);
    let (names, p) = (b.names.clone(), b.params.clone());
    let check =
        |b: &mut Bitcoin, nonce: &[u8; 16], server: &[u8; 32], e: &WireEntry, sig: &[u8; 64]| {
            let m = Msg::Serve {
                nonce: *nonce,
                entry: Box::new(e.clone()),
                sig: *sig,
            };
            check_serve(&names, &p, &mut b.pow, &[3; 16], server, &m, T)
        };
    assert_eq!(check(&mut b, &nonce, &me, &entry, &sig), Ok(()));
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
        check(&mut b, &nonce, &me, &w, &dsig).is_err(),
        "a dead name's key"
    );
    // The same name alive, the same way: taken.
    let alive = b.at(Kind::Claim, &k, "dead", [0; 32], t(10));
    let w = WireEntry::of(&alive);
    assert_eq!(check(&mut b, &nonce, &me, &w, &dsig), Ok(()));
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
    let pend = super::anchor::Pending {
        calendar: super::anchor::Calendar::Alice,
        ops: vec![super::anchor::Op::Sha256],
    };
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
    w.anchor.as_mut().unwrap().1.0[40] ^= 1;
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
    assert!(s.reg.len() <= 3 && s.reg.bytes <= 3 * 2000);
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

// ---- Review 1's findings (NAMES-REVIEW-1.md) ----

/// A server with nothing of its own (`victim`) asks; a fake partner serves its question with a live name, then
/// answers each of its `sync`s with `answer(range)`, at most `max` of them, and nothing else. The victim, the syncs
/// and the `get`s the partner was sent.
fn partner_answers(answer: impl Fn(&Range) -> SyncAnswer, max: usize) -> (Server, usize, usize) {
    let mut b = Bitcoin::new(ROOM, 40);
    let (key, item) = b.title(1, "partner", t(20), &[t(5)], [9; 32]);
    let sk = k256::schnorr::SigningKey::from_bytes(&key).unwrap();
    let last = item.entries.last().unwrap().clone();
    let mut v = Server::new(ROOM, cfg(vec![]), T);
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
                        entry: Box::new(last.clone()),
                        sig: super::entry::sign(&sk, &h),
                    };
                    x.send(vk, &m.encode(0), now);
                }
                Cmd::Send { to, data } if to == pk => {
                    if let Some((xid, m)) = x.input(vk, &data, now) {
                        match Msg::decode(&m).unwrap().0 {
                            Msg::Sync { range, .. } => {
                                syncs += 1;
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
    (v, syncs, gets)
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
