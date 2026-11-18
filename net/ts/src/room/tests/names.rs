//! The registry through the room's fake DERP and Nostr relay: servers' names clients finding each
//! other with "who serves the registry?", syncing, and the node's own key carrying none of it.

use super::*;
use crate::room::names::{
    server::{Config as NamesConfig, MAX_BYTES, MAX_NAMES, Server, Title},
    testkit::{Bitcoin, DAY, params},
    wire::Item,
};

const ROOM: &str = "test room";

/// `d` days before the tests' clock starts.
fn day(d: u32) -> u32 {
    T0 as u32 - d * DAY
}

fn server_config(seed: u8, titles: Vec<([u8; 32], Item)>) -> Config {
    let mut c = config(seed);
    c.names = Some(NamesConfig {
        params: params(),
        titles: titles
            .into_iter()
            .map(|(key, item)| Title { key, item })
            .collect(),
        max_names: MAX_NAMES,
        max_bytes: MAX_BYTES,
    });
    c
}

/// A name of node `seed`'s, claimed 20 days before the tests' clock, renewed 4 days before,
/// pointing at its node key.
fn title(b: &mut Bitcoin, seed: u8, name: &str) -> ([u8; 32], Item) {
    b.title(seed, name, day(20), &[day(4)], public(seed))
}

fn record(item: &Item, asked: u64) -> Vec<u8> {
    let mut r = vec![1];
    r.extend_from_slice(&asked.to_le_bytes());
    r.extend(item.encode());
    r
}

impl Net {
    fn server(&self, i: usize) -> &Server {
        &self.nodes[i].c.names.as_ref().unwrap().server
    }

    /// Node `i`'s registry: each name's version.
    fn registry(&self, i: usize) -> BTreeMap<[u8; 32], [u8; 8]> {
        (self.server(i).reg.items.iter())
            .map(|(id, h)| (*id, h.version))
            .collect()
    }

    /// Node `i`'s names client's key.
    fn names_key(&self, i: usize) -> [u8; 32] {
        let h = self.nodes[i].c.names.as_ref().unwrap();
        h.transport.as_ref().unwrap().public
    }

    /// Runs until every node's registry is `expect`'s ids, all at the same versions, checking
    /// every 10 s for at most `limit`: how long it took.
    fn converge(
        &mut self,
        nodes: &[usize],
        expect: &BTreeSet<[u8; 32]>,
        limit: Duration,
    ) -> Duration {
        let start = self.now;
        loop {
            let first = self.registry(nodes[0]);
            let ids: BTreeSet<[u8; 32]> = first.keys().copied().collect();
            if ids == *expect && nodes.iter().all(|i| self.registry(*i) == first) {
                return self.now - start;
            }
            if self.now - start >= limit {
                for i in nodes.iter().take(3) {
                    for l in self.logs(*i) {
                        eprintln!("{i}: {l}");
                    }
                }
            }
            assert!(
                self.now - start < limit,
                "not converged in {limit:?}: {:?}",
                nodes
                    .iter()
                    .map(|i| self.registry(*i).len())
                    .collect::<Vec<_>>()
            );
            self.advance(Duration::from_secs(10));
        }
    }
}

/// NAMES loop 6b: a server's first question waits for its names client's home region. It went out at once, before that
/// DERP connection was up (a public region takes a second or more: TLS, the DERP handshake), so the servers' call backs
/// found nobody there to reach, and the server took nobody answering for 30 s (the rig's derper dropped them as an
/// unknown destination).
#[test]
fn a_servers_first_question_waits_for_its_names_clients_home_region() {
    let mut b = Bitcoin::new(ROOM, 61);
    let (ta, tb) = (title(&mut b, 1, "alpha"), title(&mut b, 2, "bravo"));
    let faults = Faults {
        hold_names: vec![1],
        ..Faults::default()
    };
    let mut n = Net::build(
        vec![
            server_config(1, vec![ta.clone()]),
            server_config(2, vec![tb.clone()]),
        ],
        faults,
    );
    // Node 1's names client's region connects 8 s on.
    n.advance(Duration::from_secs(8));
    n.release();
    let expect: BTreeSet<[u8; 32]> = [ta.1.id, tb.1.id].into();
    let took = n.converge(&[0, 1], &expect, Duration::from_secs(120));
    eprintln!("a server whose names client connected 8 s late: converged {took:?} after");
    assert!(
        took <= Duration::from_secs(10),
        "converged {took:?} after its names client's region was up"
    );
}

#[test]
fn two_servers_converge_and_the_node_key_carries_none_of_it() {
    let mut b = Bitcoin::new(ROOM, 1);
    let (ta, tb) = (title(&mut b, 1, "alpha"), title(&mut b, 2, "bravo"));
    let (_, x) = title(&mut b, 9, "xray");
    let expect: BTreeSet<[u8; 32]> = [ta.1.id, tb.1.id, x.id].into();
    let mut n = Net::new(vec![
        server_config(1, vec![ta.clone()]),
        server_config(2, vec![tb.clone()]),
    ]);
    // Node 0 had a name of someone else's stored.
    assert!(n.nodes[0].c.names_load(&record(&x, T0)));
    let took = n.converge(&[0, 1], &expect, Duration::from_secs(120));
    eprintln!("two servers converged in {took:?}");
    assert!(n.server(0).synced && n.server(1).synced);
    // The registry went between the names clients' keys, and the node keys carried nothing at
    // all (their guests are idle): no port 2, no handshake, under the node's key.
    let (k0, k1) = (public(1), public(2));
    let (m0, m1) = (n.names_key(0), n.names_key(1));
    assert!(m0 != k0 && m1 != k1);
    assert!(n.by_keys.get(&(m0, m1)).is_some_and(|c| *c > 0));
    assert!(n.by_keys.get(&(m1, m0)).is_some_and(|c| *c > 0));
    assert!(
        n.by_keys
            .keys()
            .all(|(s, d)| ![k0, k1].contains(s) && ![k0, k1].contains(d)),
        "the node keys carried nothing"
    );
    // No WebRTC from a names client.
    assert_eq!((n.nodes[0].rtc_opens, n.nodes[1].rtc_opens), (0, 0));
    // A names client lets in handshakes only while its own question is open: a member that
    // read its key in a question and calls it later gets nothing.
    let (now, at) = (n.now, n.names_key(0));
    n.nodes[1].c.call_back(at, 0, now);
    n.advance(Duration::from_secs(1));
    let t0 = n.nodes[0]
        .c
        .names
        .as_ref()
        .unwrap()
        .transport
        .as_ref()
        .unwrap();
    assert!(!t0.peers.values().any(|p| p.key == public(2)), "refused");
    assert!(
        n.by_keys.get(&(public(2), at)).is_some_and(|c| *c > 0),
        "it came"
    );
    // A guest's UDP on port 2 is the guest's own: it reaches the other guest, untouched.
    let p = ip::udp(
        (IpAddr::V6(n.addr(0).into()), NAMES_PORT),
        (IpAddr::V6(n.addr(1).into()), NAMES_PORT),
        b"the guest's",
    );
    let now = n.now;
    n.nodes[0].c.guest_packet(&p, now);
    n.advance(Duration::from_millis(50));
    assert_eq!(n.got(1), vec![b"the guest's".to_vec()]);
    assert_eq!(
        n.registry(0),
        n.registry(1),
        "and the registry took nothing of it"
    );
    // Node 1 stored the two that came from elsewhere (its own is its title); restarted with
    // them and its title, it holds all three before it hears anything.
    let records: Vec<Vec<u8>> = n.nodes[1].stored.values().cloned().collect();
    assert_eq!(records.len(), 2);
    let before = n.registry(1);
    n.restart(1, server_config(2, vec![tb]));
    for r in &records {
        assert!(n.nodes[1].c.names_load(r));
    }
    assert_eq!(n.registry(1), before);
}

#[test]
fn twenty_servers_converge() {
    let mut b = Bitcoin::new(ROOM, 2);
    let mut cfgs = Vec::new();
    let mut expect = BTreeSet::new();
    for seed in 1..=20u8 {
        let t = title(&mut b, seed, &format!("server{seed}"));
        expect.insert(t.1.id);
        cfgs.push(server_config(seed, vec![t]));
    }
    let mut n = Net::new(cfgs);
    // Four of them had five names each of owners who are away.
    for (i, k) in [(0usize, 0u8), (6, 1), (12, 2), (19, 3)] {
        for j in 0..5u8 {
            let (_, it) = title(&mut b, 100 + 5 * k + j, &format!("away{k}x{j}"));
            expect.insert(it.id);
            assert!(n.nodes[i].c.names_load(&record(&it, T0)));
        }
    }
    let nodes: Vec<usize> = (0..20).collect();
    let took = n.converge(&nodes, &expect, Duration::from_secs(30 * 60));
    let packets: usize = n.by_keys.values().sum();
    eprintln!(
        "twenty servers, {} names: converged in {took:?}; {packets} DERP packets; a registry of {} bytes",
        expect.len(),
        n.server(0).reg.bytes
    );
    assert!(nodes.iter().all(|i| n.server(*i).synced));
    // NAMES loop 6b: a round whose runs brought names is followed by the next within a minute, not at the round's 5
    // (N6a: twenty servers started at once held 3,100 to 3,700 of 5,000 names a minute in, then nothing for 5 minutes).
    assert!(took <= Duration::from_secs(180), "converged in {took:?}");
    let nodes_keys: Vec<[u8; 32]> = (1..=20).map(public).collect();
    assert!(
        n.by_keys
            .keys()
            .all(|(s, d)| !nodes_keys.contains(s) && !nodes_keys.contains(d))
    );
    assert!(n.nodes.iter().all(|x| x.rtc_opens == 0));
}

#[test]
fn a_reset_recovers_from_each_owners_title() {
    let mut b = Bitcoin::new(ROOM, 3);
    let titles: Vec<([u8; 32], Item)> = (1..=3u8)
        .map(|s| title(&mut b, s, &format!("owner{s}")))
        .collect();
    let (_, away) = title(&mut b, 50, "away");
    let cfgs = |titles: &[([u8; 32], Item)]| -> Vec<Config> {
        (0..3)
            .map(|i| server_config(i as u8 + 1, vec![titles[i].clone()]))
            .collect()
    };
    let mut n = Net::new(cfgs(&titles));
    assert!(n.nodes[2].c.names_load(&record(&away, T0)));
    let mut all: BTreeSet<[u8; 32]> = titles.iter().map(|t| t.1.id).collect();
    all.insert(away.id);
    n.converge(&[0, 1, 2], &all, Duration::from_secs(15 * 60));
    // The room empties: every page reloads with nothing stored, only its owner's title.
    for i in 0..3 {
        n.restart(i, cfgs(&titles).remove(i));
    }
    let back: BTreeSet<[u8; 32]> = titles.iter().map(|t| t.1.id).collect();
    let took = n.converge(&[0, 1, 2], &back, Duration::from_secs(15 * 60));
    eprintln!("after a reset, three owners' names back everywhere in {took:?}");
    // Each name came back whole, from its owner's title alone: its run from the claim.
    for (_, it) in &titles {
        let o = n.server(1).reg.get(&it.id).unwrap().owner.clone().unwrap();
        assert_eq!((o.ids.len(), o.seniority), (2, day(20)));
    }
    assert!(
        n.server(0).reg.get(&away.id).is_none(),
        "an absent owner's name is gone"
    );
}

#[test]
fn a_flood_of_questions_leaves_the_nodes_own_lookups_and_call_backs_alone() {
    let mut b = Bitcoin::new(ROOM, 4);
    let t = title(&mut b, 1, "busy");
    let mut n = Net::new(vec![server_config(1, vec![t]), config(2), config(3)]);
    // Alone, the server learns nobody else serves, and answers from then on.
    n.advance(Duration::from_secs(5));
    assert!(n.server(0).synced);
    let room = Room::derive(ROOM);
    let region = n.nodes[0].c.wire_region(n.nodes[0].c.home);
    let mut rng = crate::room::names::testkit::Rng(7);
    let start = n.now;
    // A member floods "who serves?" with everyone asked, 100 a second from made-up keys, for
    // 3 s; meanwhile node 1 dials node 0 (a call back of node 0's) and node 0 dials node 2 (its
    // own lookup).
    for step in 0..30 {
        let unix = n.nodes[0].c.unix(n.now);
        let tag = room.names_tag(unix / 3600);
        for _ in 0..10 {
            let q = Question {
                key: rng.bytes(),
                region,
                time: unix,
                nonce: rng.bytes(),
                spread: 0,
            };
            let content = b64().encode(lookup::seal_bare(&room, &tag, &q.plain()));
            let e = nostr::Author::random()
                .unwrap()
                .event(KIND, &tag, &content, unix);
            n.forward(&e);
        }
        n.run();
        if step == 5 {
            n.send(1, 0, 9, b"to the busy one");
            n.send(0, 2, 9, b"from the busy one");
        }
        n.advance(Duration::from_millis(100));
    }
    let took = n.now - start;
    assert_eq!(n.got(0), vec![b"to the busy one".to_vec()], "its call back");
    assert_eq!(
        n.got(2),
        vec![b"from the busy one".to_vec()],
        "its own lookup"
    );
    let answered = n.server(0).stats.answered;
    eprintln!("300 questions in {took:?}: {answered} answered");
    assert!(
        answered <= 4 * (took.as_secs() as usize + 1),
        "the names budget: {answered}"
    );
    assert!(answered > 0);
    assert!(n.nodes[0].c.calls_waiting.is_empty());
    assert!(
        n.nodes
            .iter()
            .all(|x| x.rtc_opens == 0 || x.c.cfg.names.is_none())
    );
}

#[test]
fn two_servers_asking_at_once_still_find_each_other() {
    let mut b = Bitcoin::new(ROOM, 5);
    let (ta, tb) = (title(&mut b, 1, "alpha"), title(&mut b, 2, "bravo"));
    let mut n = Net::new(vec![server_config(1, vec![ta]), server_config(2, vec![tb])]);
    // Both alone at first: nobody answers either, both serve from then on.
    n.advance(Duration::from_secs(3));
    assert!(n.server(0).synced && n.server(1).synced);
    assert_eq!((n.server(0).stats.syncs, n.server(1).stats.syncs), (0, 0));
    // They ask at the same moment, each answering the other: crossed call backs would both
    // fail; the higher key waits, so each finds the other.
    let now = n.now;
    for x in &mut n.nodes {
        x.c.names.as_mut().unwrap().server.ask_at(now);
    }
    n.advance(Duration::from_secs(5));
    assert_eq!((n.server(0).stats.syncs, n.server(1).stats.syncs), (1, 1));
}

// ---- A member resolving names (room-names.md "A member resolving a name", "The resolver") ----

/// A title of node `seed`'s for `name`: the name points at `node`, `git.<name>` at `git`.
fn title_to(
    b: &mut Bitcoin,
    seed: u8,
    name: &str,
    node: [u8; 32],
    git: [u8; 32],
) -> ([u8; 32], Item) {
    use crate::room::names::{entry::Kind, zone::Zone};
    let key = b.key(seed, name);
    let claim = b.at(Kind::Claim, &key, name, [0; 32], day(20));
    let renew = b.at(Kind::Renew, &key, name, claim.id(), day(4));
    let zone = Zone::seal(
        &b.names,
        &key,
        name,
        1,
        &[(None, node), (Some("git"), git)],
        false,
    )
    .unwrap();
    (
        key.to_bytes().into(),
        b.item(name, &[claim, renew], Some(zone)),
    )
}

/// A DNS answer: its rcode, its AAAA addresses and their TTL.
#[derive(Debug, PartialEq)]
struct Dns {
    rcode: u8,
    addrs: Vec<[u8; 16]>,
    ttl: Option<u32>,
}

impl Net {
    /// Node `i`'s guest asks the room's resolver for `rel` under the room's domain, and the time runs until the answer
    /// comes (10 s at most): the answer and how long it took.
    fn ask(&mut self, i: usize, rel: &str, qtype: u16) -> (Dns, Duration) {
        let domain = self.nodes[i].c.room.domain();
        self.ask_full(i, &format!("{rel}.{domain}"), qtype)
    }

    /// [`Net::ask`] for the whole name `name`.
    fn ask_full(&mut self, i: usize, name: &str, qtype: u16) -> (Dns, Duration) {
        let rel = name;
        let mut q = vec![0x56, 0x78, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0];
        for l in name.split('.') {
            q.push(l.len() as u8);
            q.extend_from_slice(l.as_bytes());
        }
        q.extend_from_slice(&[0]);
        q.extend_from_slice(&qtype.to_be_bytes());
        q.extend_from_slice(&[0, 1]);
        let to = self.nodes[i].c.resolver;
        let p = ip::udp(
            (IpAddr::V6(self.addr(i).into()), 5353),
            (IpAddr::V6(to.into()), 53),
            &q,
        );
        let start = self.now;
        self.nodes[i].guest.clear();
        let now = self.now;
        self.nodes[i].c.guest_packet(&p, now);
        self.run();
        loop {
            if let Some(a) = self.nodes[i]
                .guest
                .iter()
                .find(|a| a[6] == ip::UDP && a[48..50] == [0x56, 0x78])
            {
                let m = &a[48..];
                let n = u16::from_be_bytes([m[6], m[7]]) as usize;
                let addrs = (0..n)
                    .map(|k| m[m.len() - 16 * (n - k)..][..16].try_into().unwrap())
                    .collect();
                let ttl = (n > 0)
                    .then(|| u32::from_be_bytes(m[m.len() - 22..m.len() - 18].try_into().unwrap()));
                let d = Dns {
                    rcode: dns::rcode(m),
                    addrs,
                    ttl,
                };
                self.nodes[i].guest.clear();
                return (d, self.now - start);
            }
            assert!(
                self.now - start < Duration::from_secs(10),
                "no answer to {rel}"
            );
            self.advance(Duration::from_millis(10));
        }
    }

    /// Node `i`'s open names-client connections.
    fn names_conns(&self, i: usize) -> usize {
        self.nodes[i]
            .conns
            .keys()
            .filter(|c| **c >= NAMES_CONN)
            .count()
    }
}

fn aaaa(addr: [u8; 16]) -> Dns {
    Dns {
        rcode: dns::NOERROR,
        addrs: vec![addr],
        ttl: Some(60),
    }
}

fn nx() -> Dns {
    Dns {
        rcode: dns::NXDOMAIN,
        addrs: vec![],
        ttl: None,
    }
}

#[test]
fn a_member_resolves_a_registered_name_through_a_names_client_of_its_own() {
    let mut b = Bitcoin::new(ROOM, 6);
    let alpha = title_to(&mut b, 1, "alpha", public(2), public(1));
    let bravo = title(&mut b, 2, "bravo");
    let mut n = Net::new(vec![
        server_config(1, vec![alpha.clone()]),
        server_config(2, vec![bravo]),
        config(3),
    ]);
    // The servers find each other (the first question of each finds nobody).
    n.converge(
        &[0, 1],
        &[alpha.1.id, bravo_id(&b)].into(),
        Duration::from_secs(120),
    );
    assert_eq!(
        n.names_conns(2),
        0,
        "no names client before a name is asked for"
    );
    // Reserved and ill-formed names: NXDOMAIN at once, nothing asked.
    for r in ["wpad", "com", "localhost", "isatap", "a.b.alpha", "xn--abc"] {
        assert_eq!(n.ask(2, r, dns::AAAA), (nx(), Duration::ZERO), "{r}");
    }
    assert_eq!(n.names_conns(2), 0, "nothing asked");
    // A first lookup: the names client starts and asks the room through the relays (room-names-r3.md); the replies
    // come back through them too: no question, no DERP, no session.
    let (a, took) = n.ask(2, "alpha", dns::AAAA);
    eprintln!("a member's first lookup through the fake DERP and relay: {took:?}");
    assert_eq!(a, aaaa(n.addr(1)));
    let mk = n.nodes[2]
        .c
        .member
        .as_ref()
        .unwrap()
        .transport
        .as_ref()
        .unwrap()
        .public;
    assert!(
        n.by_keys.keys().all(|(s, d)| *s != mk && *d != mk),
        "the member's names client sent and got nothing through DERP"
    );
    let st = n.nodes[2].c.member.as_ref().unwrap().member.stats.clone();
    assert_eq!((st.questions, st.gets, st.fetches), (0, 0, 0));
    assert!(st.asks >= 1 && st.replies >= 1, "{st:?}");
    assert!(
        n.nodes[2].c.known.get(&n.addr(1)) == Some(&public(2)),
        "the module learned the key"
    );
    assert!(n.names_conns(2) > 0, "a names client of its own");
    // A label under it, at once from what is kept; A is an empty answer; a name nobody holds is NXDOMAIN.
    assert_eq!(
        n.ask(2, "git.alpha", dns::AAAA),
        (aaaa(n.addr(0)), Duration::ZERO)
    );
    let (a, _) = n.ask(2, "alpha", dns::A);
    assert_eq!((a.rcode, a.addrs.len()), (dns::NOERROR, 0));
    let (a, took) = n.ask(2, "charlie", dns::AAAA);
    eprintln!("a second first lookup in that room (a name nobody holds): {took:?}");
    assert_eq!(a, nx());
    assert_eq!(
        n.ask(2, "charlie", dns::AAAA),
        (nx(), Duration::ZERO),
        "remembered"
    );
    // The node's own key carried none of it: no packet under it at all.
    let me = public(3);
    assert!(
        n.by_keys.keys().all(|(s, d)| *s != me && *d != me),
        "the member's node key carried nothing"
    );
    assert_eq!(n.nodes[2].rtc_opens, 0);
    // Decision 4 as amended: the servers ask the explorers about their blocks (the compiled ones only); the member
    // asks nothing outside the room.
    assert_eq!(n.nodes[2].fetches, Vec::<String>::new(), "a member fetched");
    for (i, node) in n.nodes.iter().enumerate().take(2) {
        assert!(!node.fetches.is_empty(), "server {i} checked no block");
        for u in &node.fetches {
            assert!(
                crate::room::names::anchor::EXPLORERS
                    .iter()
                    .any(|e| u.starts_with(&format!("{e}/block/"))),
                "{u}"
            );
        }
    }
    // Kept, and stored.
    let records: Vec<Vec<u8>> = n.nodes[2].stored.values().cloned().collect();
    assert_eq!(records.len(), 1);
    // Ten minutes without a query: the names client closes.
    n.advance(Duration::from_secs(9 * 60));
    assert!(n.names_conns(2) > 0);
    n.advance(Duration::from_secs(70));
    assert_eq!(
        n.names_conns(2),
        0,
        "closed after 10 minutes without a name asked"
    );
    // The page reloads with its records: answered at once, with no names client.
    n.restart(2, config(3));
    for r in &records {
        assert!(n.nodes[2].c.names_load(r));
    }
    let n2 = n.addr(1);
    assert_eq!(n.ask(2, "alpha", dns::AAAA), (aaaa(n2), Duration::ZERO));
}

fn bravo_id(b: &Bitcoin) -> [u8; 32] {
    b.names.name_id("bravo")
}

#[test]
fn with_no_server_nxdomain_then_a_server_that_appears_is_found_while_the_guest_keeps_asking() {
    let mut b = Bitcoin::new(ROOM, 7);
    let alpha = title_to(&mut b, 1, "alpha", public(2), public(1));
    let mut n = Net::new(vec![config(1), config(2)]);
    let (a, took) = n.ask(1, "alpha", dns::AAAA);
    eprintln!("nobody serves: NXDOMAIN in {took:?}");
    assert_eq!(a, nx());
    assert!(
        (Duration::from_millis(2400)..Duration::from_secs(4)).contains(&took),
        "{took:?}"
    );
    assert_eq!(
        n.ask(1, "alpha", dns::AAAA),
        (nx(), Duration::ZERO),
        "remembered: at once"
    );
    // The room's first server appears; the guest asks every 2 s.
    n.restart(0, server_config(1, vec![alpha]));
    n.advance(Duration::from_secs(3)); // it learns it's alone, and serves
    let start = n.now;
    loop {
        let (a, _) = n.ask(1, "alpha", dns::AAAA);
        if a.rcode == dns::NOERROR {
            assert_eq!(a, aaaa(n.addr(1)));
            break;
        }
        assert!(n.now - start < Duration::from_secs(60), "found");
        n.advance(Duration::from_secs(2));
    }
    eprintln!(
        "the room's first server found {:?} after it appeared",
        n.now - start
    );
}

#[test]
fn a_query_that_gets_no_answer_in_four_seconds_is_servfail() {
    let mut b = Bitcoin::new(ROOM, 8);
    let alpha = title_to(&mut b, 1, "alpha", public(2), public(1));
    let mut n = Net::new(vec![server_config(1, vec![alpha]), config(2)]);
    n.advance(Duration::from_secs(3));
    assert_eq!(n.ask(1, "alpha", dns::AAAA).0, aaaa(n.addr(1)));
    // The server's page goes away; the member still holds it as its server.
    n.restart(0, config(1));
    let (a, took) = n.ask(1, "bravo", dns::AAAA);
    assert_eq!((a.rcode, took), (dns::SERVFAIL, DNS_WAIT));
}

#[test]
fn a_servers_own_name_not_public_yet_answers_its_own_address() {
    use crate::room::names::entry::Kind;
    let mut b = Bitcoin::new(ROOM, 9);
    let key = b.key(1, "mine");
    let claim = b.entry(Kind::Claim, &key, "mine", [0; 32]); // no anchor yet
    let item = b.item("mine", &[claim], None);
    let mut n = Net::new(vec![
        server_config(1, vec![(key.to_bytes().into(), item)]),
        config(2),
    ]);
    n.advance(Duration::from_secs(3));
    let me = n.addr(0);
    assert_eq!(n.ask(0, "mine", dns::AAAA), (aaaa(me), Duration::ZERO));
    assert_eq!(n.ask(0, "git.mine", dns::AAAA).0, nx());
    // Nobody else sees it: it isn't public.
    assert_eq!(n.ask(1, "mine", dns::AAAA).0, nx());
}

/// Node `seed`'s config in the room whose ID is `id`.
fn in_room(id: &str, mut c: Config) -> Config {
    c.link.id = id.into();
    c
}

#[test]
fn a_registered_name_resolves_under_the_rooms_name_and_its_tag() {
    const LAN: &str = "Names-LAN";
    let mut b = Bitcoin::new(LAN, 10);
    let alpha = title_to(&mut b, 1, "alpha", public(2), public(1));
    let mut n = Net::new(vec![
        in_room(LAN, server_config(1, vec![alpha])),
        in_room(LAN, config(2)),
    ]);
    n.advance(Duration::from_secs(3));
    let tag = n.nodes[1].c.room.tag.clone();
    assert_eq!(n.nodes[1].c.room.domain(), "names-lan.p2p.internal");
    for i in [0, 1] {
        for name in [
            "alpha.names-lan.p2p.internal".to_string(),
            "ALPHA.Names-LAN.p2p.internal".to_string(),
            format!("alpha.{tag}.p2p.internal"),
        ] {
            assert_eq!(
                n.ask_full(i, &name, dns::AAAA).0,
                aaaa(n.addr(1)),
                "{i}: {name}"
            );
        }
        for name in [
            "git.alpha.names-lan.p2p.internal".to_string(),
            format!("git.alpha.{tag}.p2p.internal"),
        ] {
            assert_eq!(
                n.ask_full(i, &name, dns::AAAA).0,
                aaaa(n.addr(0)),
                "{i}: {name}"
            );
        }
        assert_eq!(
            n.ask_full(i, "wpad.names-lan.p2p.internal", dns::AAAA).0,
            nx()
        );
    }
}

#[test]
fn a_registered_name_in_a_room_named_like_a_tag_resolves_under_its_tag_alone() {
    let other = Room::derive(ROOM).tag;
    let mut b = Bitcoin::new(&other, 11);
    let alpha = title_to(&mut b, 1, "alpha", public(2), public(1));
    let mut n = Net::new(vec![
        in_room(&other, server_config(1, vec![alpha])),
        in_room(&other, config(2)),
    ]);
    n.advance(Duration::from_secs(3));
    let tag = n.nodes[1].c.room.tag.clone();
    assert_ne!(tag, other);
    for i in [0, 1] {
        assert_eq!(
            n.ask_full(i, &format!("alpha.{other}.p2p.internal"), dns::AAAA)
                .0,
            nx(),
            "{i}: not under the other room's tag"
        );
        assert_eq!(
            n.ask_full(i, &format!("alpha.{tag}.p2p.internal"), dns::AAAA)
                .0,
            aaaa(n.addr(1)),
            "{i}"
        );
    }
}

// ---- The names agent's publisher (room-names.md "The names agent") and titles as they change ----

fn publisher(seed: u8) -> Config {
    let mut c = config(seed);
    c.publish = true;
    c
}

impl Net {
    /// Node `i`'s `names-put` events so far: (id, server, result, item).
    fn put_events(&self, i: usize) -> Vec<(String, Option<String>, String, Option<String>)> {
        (self.nodes[i].events.iter())
            .filter(|e| e["type"] == "names-put")
            .map(|e| {
                (
                    e["id"].as_str().unwrap().to_string(),
                    e["server"].as_str().map(str::to_string),
                    e["result"].as_str().unwrap().to_string(),
                    e["item"].as_str().map(str::to_string),
                )
            })
            .collect()
    }

    /// Runs until node `i` has `n` `names-put` events, for at most `limit`.
    fn puts_answered(&mut self, i: usize, n: usize, limit: Duration) {
        let start = self.now;
        while self.put_events(i).len() < n {
            assert!(self.now - start < limit, "{:?}", self.put_events(i));
            self.advance(Duration::from_millis(100));
        }
    }
}

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len() / 2)
        .map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap())
        .collect()
}

#[test]
fn a_publisher_puts_a_title_to_two_servers_with_no_node_of_its_own() {
    let mut b = Bitcoin::new(ROOM, 10);
    let (ta, tb) = (title(&mut b, 1, "alpha"), title(&mut b, 2, "bravo"));
    let mut n = Net::new(vec![
        server_config(1, vec![ta.clone()]),
        server_config(2, vec![tb.clone()]),
    ]);
    n.converge(
        &[0, 1],
        &[ta.1.id, tb.1.id].into(),
        Duration::from_secs(120),
    );
    // The page's agent, no machine running: a publisher, a names client alone.
    n.nodes
        .push(node(Client::new(publisher(3), n.now).unwrap()));
    n.run();
    n.advance(Duration::from_secs(1));
    let (_, charlie) = title(&mut b, 9, "charlie");
    let now = n.now;
    assert!(n.nodes[2].c.names_put(&charlie.encode(), now));
    n.puts_answered(2, 2, Duration::from_secs(20));
    let puts = n.put_events(2);
    assert!(puts.iter().all(|p| p.2 == "taken"), "{puts:?}");
    let servers: BTreeSet<Option<String>> = puts.iter().map(|p| p.1.clone()).collect();
    assert_eq!(servers.len(), 2, "two servers");
    for i in [0, 1] {
        assert!(
            n.server(i).reg.get(&charlie.id).is_some(),
            "server {i} holds it"
        );
    }
    // Its key is a fresh one, never the node key of its seed, and it opened no WebRTC.
    let me = public(3);
    assert!(n.by_keys.keys().all(|(s, d)| *s != me && *d != me));
    assert_eq!(n.nodes[2].rtc_opens, 0);
    // A worse chain (a younger claim of alpha's by another key): the server's better item comes back.
    use crate::room::names::entry::Kind;
    let other = b.key(8, "alpha");
    let young = b.at(Kind::Claim, &other, "alpha", [0; 32], day(1));
    let worse = b.item("alpha", &[young], None);
    let now = n.now;
    assert!(n.nodes[2].c.names_put(&worse.encode(), now));
    n.puts_answered(2, 4, Duration::from_secs(20));
    let better: Vec<_> = n.put_events(2).into_iter().skip(2).collect();
    assert!(better.iter().all(|p| p.2 == "better"), "{better:?}");
    let shown = Item::decode(&unhex(better[0].3.as_ref().unwrap())).unwrap();
    let ids =
        |it: &Item| -> BTreeSet<[u8; 32]> { it.entries.iter().map(|w| w.entry.id()).collect() };
    assert_eq!(ids(&shown), ids(&ta.1), "the owner's chain");
    // The dialog's check: alpha's first byte, never its id; each server answers with the ids under it, each with
    // until when its owner holds it.
    let first = ta.1.id[0];
    let now = n.now;
    assert!(n.nodes[2].c.names_ids(first, now));
    let start = n.now;
    while n.id_events(2).len() < 2 {
        assert!(
            n.now - start < Duration::from_secs(20),
            "{:?}",
            n.id_events(2)
        );
        n.advance(Duration::from_millis(100));
    }
    let unix = n.nodes[2].c.unix(n.now);
    for e in n.id_events(2) {
        assert_eq!(e["result"], "ids", "{e}");
        assert_eq!(e["first"], first as u64);
        let held: Vec<(String, u64)> = (e["ids"].as_array().unwrap().iter())
            .map(|x| (x[0].as_str().unwrap().to_string(), x[1].as_u64().unwrap()))
            .collect();
        let alpha = held
            .iter()
            .find(|(i, _)| unhex(i) == ta.1.id)
            .expect("alpha's id under its byte");
        assert!(alpha.1 > unix, "held until {} (now {unix})", alpha.1);
        assert!(
            held.iter()
                .all(|(i, _)| i.starts_with(&format!("{first:02x}")))
        );
    }
    // Not a publisher: refused. The servers tell the page their names line (`names`): serving, names held.
    assert!(!n.nodes[0].c.names_ids(first, now));
    let told = (n.nodes[0].events.iter())
        .rfind(|e| e["type"] == "names")
        .unwrap();
    assert_eq!(
        (told["serving"].as_bool(), told["names"].as_u64()),
        (Some(true), Some(3)),
        "{told}"
    );
}

impl Net {
    /// Node `i`'s `names-ids` events so far.
    fn id_events(&self, i: usize) -> Vec<serde_json::Value> {
        (self.nodes[i].events.iter())
            .filter(|e| e["type"] == "names-ids")
            .cloned()
            .collect()
    }
}

#[test]
fn a_publisher_with_nobody_serving_says_so() {
    let mut b = Bitcoin::new(ROOM, 11);
    let mut n = Net::new(vec![config(1), publisher(2)]);
    n.advance(Duration::from_secs(1));
    let (_, it) = title(&mut b, 9, "lonely");
    let now = n.now;
    assert!(n.nodes[1].c.names_put(&it.encode(), now));
    n.puts_answered(1, 1, Duration::from_secs(10));
    assert_eq!(n.put_events(1)[0].2, "nobody");
    // The dialog's check: nobody can say.
    let now = n.now;
    assert!(n.nodes[1].c.names_ids(it.id[0], now));
    let start = n.now;
    while n.id_events(1).is_empty() {
        assert!(n.now - start < Duration::from_secs(10));
        n.advance(Duration::from_millis(100));
    }
    assert_eq!(n.id_events(1)[0]["result"], "nobody");
    let now = n.now;
    // Not a publisher, or not an item: refused.
    assert!(!n.nodes[0].c.names_put(&it.encode(), now));
    assert!(!n.nodes[1].c.names_put(b"junk", now));
}

#[test]
fn titles_given_while_the_room_runs_make_a_member_a_server_and_change_its_registry() {
    let mut b = Bitcoin::new(ROOM, 12);
    let alpha = title_to(&mut b, 1, "alpha", public(1), public(1));
    let mut n = Net::new(vec![config(1), config(2)]);
    n.advance(Duration::from_secs(2));
    assert!(n.nodes[0].c.names.is_none(), "a member");
    let now = n.now;
    n.nodes[0].c.set_titles(
        vec![Title {
            key: alpha.0,
            item: alpha.1.clone(),
        }],
        now,
    );
    assert!(
        n.nodes[0].c.member.is_none() && n.nodes[0].c.names.is_some(),
        "a server"
    );
    n.advance(Duration::from_secs(4));
    let (a, _) = n.ask(1, "alpha", dns::AAAA);
    assert_eq!(a, aaaa(n.addr(0)));
    // The title renewed elsewhere (the agent's): the server's registry follows.
    use crate::room::names::entry::Kind;
    let key = b.key(1, "alpha");
    let last = alpha.1.entries.last().unwrap().entry.id();
    let renew = b.at(Kind::Renew, &key, "alpha", last, day(0) - 3600);
    let mut item = alpha.1.clone();
    item.entries
        .push(crate::room::names::wire::WireEntry::of(&renew));
    let now = n.now;
    n.nodes[0]
        .c
        .set_titles(vec![Title { key: alpha.0, item }], now);
    let o = n
        .server(0)
        .reg
        .get(&alpha.1.id)
        .unwrap()
        .owner
        .clone()
        .unwrap();
    assert_eq!(o.last(), renew.id());
}

/// A first lookup of a contested name through the fake DERP and relays: the replies show two owner keys, and the
/// member fetches each one's run through a session its server opens (a call back to the member's names client, which
/// lets in those keys only); the owner wins. Each reply goes out through two relays.
#[test]
fn a_contested_first_lookup_fetches_through_sessions_and_the_owner_wins() {
    use crate::room::names::{entry::Kind, zone::Zone};
    let mut b = Bitcoin::new(ROOM, 9);
    let alpha = title_to(&mut b, 5, "alpha", public(1), public(1));
    let fake = {
        let key = b.key(66, "alpha");
        let claim = b.at(Kind::Claim, &key, "alpha", [0; 32], day(10));
        let zone = Zone::seal(&b.names, &key, "alpha", 1, &[(None, public(2))], false).unwrap();
        b.item("alpha", &[claim], Some(zone))
    };
    let relays: Vec<String> = (0..3).map(|k| format!("wss://nostr{k}.test")).collect();
    let mut cfgs = vec![
        server_config(1, vec![title(&mut b, 1, "one")]),
        server_config(2, vec![title(&mut b, 2, "two")]),
        config(3),
    ];
    for c in &mut cfgs {
        c.link.nostr = relays.clone();
    }
    let mut n = Net::new(cfgs);
    // Each server holds one of the chains, and keeps it whatever sync brings (the tests' lying servers).
    for (i, it) in [(0, &alpha.1), (1, &fake)] {
        assert!(n.nodes[i].c.names_load(&record(it, T0)));
        let h = n.nodes[i].c.names.as_mut().unwrap();
        h.server.refuse.insert(it.id);
    }
    n.advance(Duration::from_secs(40));
    assert!(n.server(0).synced && n.server(1).synced);
    let (a, took) = n.ask(2, "alpha", dns::AAAA);
    eprintln!("a contested first lookup through the fake DERP and relays: {took:?}");
    assert_eq!(a, aaaa(n.addr(0)), "the owner's");
    let h = n.nodes[2].c.member.as_ref().unwrap();
    let mk = h.transport.as_ref().unwrap().public;
    let st = h.member.stats.clone();
    assert_eq!((st.contests, st.fetches, st.questions), (1, 2, 0), "{st:?}");
    assert_eq!(h.member.kept[&alpha.1.id].kept.earliest, day(20));
    let (k0, k1) = (n.names_key(0), n.names_key(1));
    for k in [k0, k1] {
        assert!(
            n.by_keys.get(&(k, mk)).is_some_and(|c| *c > 0),
            "a session from each fetched server"
        );
    }
    // Every reply went out through two relays (the one that brought its ask, and its copy's).
    let hour = T0 / 3600;
    let tags: Vec<String> = (hour - 1..=hour + 1)
        .map(|h| n.nodes[2].c.room.reply_tag(&mk, h))
        .collect();
    let mut by_event: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for (url, e) in &n.published_on {
        if tags.iter().any(|t| e["tags"][0][1] == *t) {
            by_event
                .entry(e["id"].as_str().unwrap().into())
                .or_default()
                .insert(url.clone());
        }
    }
    assert!(!by_event.is_empty());
    for (id, urls) in &by_event {
        assert_eq!(urls.len(), 2, "reply {id}: {urls:?}");
    }
}
