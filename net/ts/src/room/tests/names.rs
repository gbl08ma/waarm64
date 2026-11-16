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
