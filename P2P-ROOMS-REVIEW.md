# P2P rooms: out-of-context review (2026-11-10)

A static review of peer-to-peer rooms as they stand at `9bcfb12a` (branch `claude/adoring-cannon-isn6dw`), with
`git diff 804d57ee..9bcfb12a` (R2, R3) read closely and R0/R1's code (`room.rs`, `room/link.rs`, `room/lookup.rs`,
`nostr.rs`, `web/room.ts`, `web/room-worker.ts`, `web/ts-client.ts`) read again around it. The method is
docs/testing.md "Out-of-context reviews". Nothing outside this file was changed. The confirming tests below were added
to `net/ts/src/room/tests.rs` for a run (`cargo test -q -p webpc_ts review_`) and then removed. The suite as committed
passes (`cargo test -q -p webpc_ts room`: 36 passed).

"Confirmed" means something I ran shows the defect. "By reading" means I traced the code and ran nothing.

## Findings, most severe first

### 1. Two room connections that share a key fight over the same DERP region (by reading)

- **Where:** web/app/connections.ts:150-157 (`keyOf` copies the other connection's `identityKey`),
  web/app/NetWizard.svelte (the key select under Advanced), net/ts/src/room.rs:662-680 (`relay_connect`: every
  room's client opens a DERP connection under its node key), link.rs:112-114 (every link without `derp=` gets
  `Region::Map(0)`).
- **Defect:** the feature that lets two rooms share a key ("the same identity in another room", plan §1,
  network-adapters.md §2.1) runs two `room::Client`s with the same WireGuard node key. Each opens its own DERP
  connection under that key. With the default link, and with any two links that name the same region or derper, both
  connections go to the same derper. A derper delivers a key's packets to one connection only. Tailscale's derper keeps
  a duplicate-client set and sends to the most recent writer, or, under its fighting policy, to neither (I am going by
  derper's `dupClientSet` behavior as I know it and did not check it against a live derper). Room A's packets then reach
  room B's client, which drops them: the key is unknown there, or the PSK is wrong and `peer_packet` forgets it. The
  same thing happens the other way. Each client also keeps writing keepalives and pings, so the active connection keeps
  flipping.
- **Trigger:** a machine with two adapters attached to two room connections, the second made with the first's key
  (both connect at start). It also happens with two machines in two tabs, because the Web Lock is per connection, not
  per key.
- **Consequence:** both rooms lose most packets through DERP: lookups' call backs, handshakes and signalling. That
  includes the WebRTC setup, which runs over DERP first. One room may work while the other is dead, and which one
  changes over time. The page reports both as Connected.
- **Confirm:** the fake DERP in room/tests.rs routes to the first node with a key (`find_map`), so it can't show this.
  Use a test against the rig's derper instead: two `room::Client`s with one key in two rooms on one region, each
  reaching a peer of its own room. Or model it in the harness: a region whose `handle` delivers a key's packets only to
  its last-opened connection, then `Net::new` with two configs of the same `key` and different `link.id`, each
  `reach`ing a third and fourth node. Fixes to consider: refuse a shared key on a region that the other room already
  uses, or let one DERP connection per region carry every room's packets for the key and route them by the sender's
  room (the PSK).

### 2. The edit wizard's Save undoes New name (by reading)

- **Where:** web/app/NetWizard.svelte:224-228 (`forget` calls `page.netNewAddress(editing)` and never refreshes
  `editing`), NetWizard.svelte:154-156 (`saveRoom` writes `{...editing, room: {...editing.room, incoming,
  relayOnly}}`), web/app/main.ts:1785-1797 (`netNewAddress` for a room changes the record: a new `identity` for an
  ephemeral connection, a new `identityKey` for a shared one).
- **Defect:** New name writes a new key reference into the connection record. `editing` is the snapshot taken when the
  wizard opened, and Save writes it back whole.
- **Trigger:** open a room connection's edit wizard, go to Advanced, press New name and confirm, then press Save (to
  change a switch, or just to close the dialog with its primary button).
- **Consequence:** for an ephemeral connection, the old `identity` (the old key) comes back, so the old name works
  again. The user was told it wouldn't ("Members who have the machine's current name won't be able to reach it any
  more"). For a stored connection that shared a key, `identityKey` goes back to the shared one: the connection is on
  the other connection's key again, and the key made for it is left orphaned in `webpc-room`. Pressing New name twice
  in one wizard also leaves an orphaned key. Only a stored, unshared connection comes out right, because its
  `identityKey` doesn't change.
- **Confirm:** a `wording`-free case in tests/page-network.test.ts style: an ephemeral room connection, Edit, New name,
  Save, then read the connection (`net.conns.get`) and check that `room.identity.key` differs from the one before.
  With a fake `PageNetwork`, this is a unit test in tests/connections.test.ts. Fix: re-read the connection after
  `netNewAddress` (`editing = await net.conns.get(editing.id)`), or make Save write only the two switches onto a fresh
  copy.

### 3. A failed room client keeps reconnecting to its Nostr relays forever (confirmed)

- **Where:** net/ts/src/room.rs:2099-2116 (`close` takes the Nostr connections and clears `reconnect_at`, but leaves
  `answer_by`, `check_at` and `sub`), room.rs:1897-1908 (`tick`'s Nostr loop has no `state != Failed` guard, unlike
  the DERP loop at 2033), room.rs:794-812 (`nostr_lost` sets `reconnect_at` again).
- **Defect:** `fail()` calls `close()`, and the room worker keeps the failed `TsClient` alive and ticking until the
  user presses Retry or Disconnect. web/app/network.ts `connect` keeps `client`, and room-worker.ts only posts
  `error`. If the client failed before a Nostr relay's EOSE (`answer_by` still set), 15 s later `tick` calls
  `nostr_lost`, which sets `reconnect_at`. The next tick opens a new WebSocket and subscribes again. From then on, the
  relay is renewed every 60 s, or retried with backoff, for as long as the page stays open.
- **Trigger:** any failure while a Nostr relay hasn't answered yet: `no-browser-relay` (inside `Client::new`, right
  after the REQ), `derp-map`, `derp-map-invalid`, `region-no-browser-relay`, or `relay` when the Nostr relay is slow.
- **Consequence:** the page shows "Couldn't connect" while the worker keeps a WebSocket to every Nostr relay of the
  link and its subscription to the node's tags. Lookups are ignored (`on_lookup` needs `Running`), but the relays
  still see the node's tags and IP address. This is a silent leak of connections and of who is there.
- **Confirmed by** (in room/tests.rs; it failed with WsOpens at 17, 36, 59, 90, … 587 s):

  ```rust
  #[test]
  fn a_failed_client_stays_off_nostr() {
      let mut cfg = config(1);
      cfg.link.derp = vec![Region::Map(0)];
      let now = Instant::now();
      let mut c = Client::new(cfg, now).unwrap();
      while c.poll().is_some() {}
      c.fetched(1, false, b"", now); // the map doesn't load: Failed, before the relay's EOSE
      while c.poll().is_some() {}
      assert_eq!(c.state, State::Failed);
      let mut t = now;
      for _ in 0..30 {
          let Some(d) = c.deadline() else { break };
          t = d.max(t);
          c.tick(t);
          while let Some(a) = c.poll() {
              assert!(!matches!(a, Action::WsOpen { .. }), "opened again at {:?}", t - now);
          }
      }
  }
  ```

  Fix: clear the Nostr fields in `close()` (or guard the loop as the DERP one is), and have `deadline()` return None
  once the client has failed.

### 4. A room member can make the page create RTCPeerConnections as fast as it sends (confirmed, module side)

- **Where:** net/ts/src/room.rs:1574-1593 (`on_sig`: any `sig` with `o > attempt` closes the current connection and
  pushes `RtcOpen` and `RtcSignal`), room.rs:1446-1468 (a changed epoch `n` closes the channel, resets `attempt` to 0,
  and makes the offerer offer at once), web/room.ts:94-110 (each `rtc-open` creates an `RTCPeerConnection` with STUN).
- **Defect:** nothing limits how often a peer's signalling makes us set up a connection. A confirmed member, meaning
  anyone with the room's ID who completed a handshake with us, can send `sig` messages with `o` rising by one each
  time. Each message makes the answerer's page create a new `RTCPeerConnection`, close the previous one, and start ICE
  gathering against the STUN servers. Changing `n` on every message does the same to an offerer, through the next
  tick's `offer`. Every message is also acked, and `refuse`/`bye` replies are queued in the outbox with three resends.
- **Trigger:** a malicious or buggy member sending signalling in a loop. Each message is one small UDP packet inside
  the tunnel.
- **Consequence:** CPU and network on the victim's page: STUN binding requests to Cloudflare and Google for every
  attempt, Chromium's limit on peer connections (closed ones count until they are collected), and jank on the page's
  main thread. The `MAX_RTC` cap doesn't help, because each new attempt closes the last one first, so the count stays
  at 1.
- **Confirmed by** (it failed: 200 `RtcOpen`s within one instant from one member):

  ```rust
  #[test]
  fn a_member_cant_churn_our_peer_connections() {
      let mut n = Net::new(configs(&[1, 2]));
      n.reach(0, 1, b"a");
      let o = if public(1) < public(2) { 0 } else { 1 };
      let a = 1 - o;
      let id = n.nodes[o].c.by_addr[&n.addr(a)];
      let before = n.nodes[a].c.next_rtc;
      let now = n.now;
      for k in 0..200u32 {
          let m = Msg { t: "sig".into(), o: 1000 + k, d: json!({ "candidate": "x" }).to_string(), ..Msg::default() };
          n.nodes[o].c.signal(id, m, now);
          n.run();
      }
      assert!(n.nodes[a].c.next_rtc - before <= 2, "{}", n.nodes[a].c.next_rtc - before);
  }
  ```

  Fix: give a peer's new attempts (as answerer) and epoch changes the same backoff the offerer applies to itself,
  for example at most one new connection per peer per `RTC_BACKOFF`.

### 5. The link the menu copies pins the module's placeholder defaults (confirmed)

- **Where:** net/ts/src/room.rs:577-580 (the `self` event's `link` is `cfg.link.encode()`), link.rs:109-114
  (`parse` fills in `DEFAULT_NOSTR` and `derp=0` when the link names none), web/room.ts:379 (`link: me.link ??
  c.link`, so Copy room link copies the module's form), web/app/Network.svelte:113.
- **Defect:** a room created with empty relay fields is stored as `webpc-room:<id>` and gets whatever the defaults are
  at each connect. The link copied from the menu is
  `webpc-room:<id>?nostr=wss%3A%2F%2Fnos.lol&nostr=…relay.damus.io&nostr=…relay.primal.net&derp=0`, which fixes
  today's placeholders ("Placeholders until R4 picks the defaults") into every link handed out.
- **Trigger:** R4 changing `DEFAULT_NOSTR` or the default DERP map, or the public map reordering its regions (`derp=0`
  means "its first"). Members who joined by a copied link keep the old relays. The creator, and anyone who joined by
  the bare ID or by a link written by `roomLink`, moves to the new ones.
- **Consequence:** one room's members end up on disjoint Nostr relays, or in a region that a call back can't reach, and
  they silently stop finding each other. It is also "the same room" with different link text in two places.
- **Confirmed by:** `assert_eq!(Link::parse("webpc-room:abc").unwrap().encode(), "webpc-room:abc")` fails. The left
  side has the three relays and `derp=0`. Fix: keep a flag (or an `Option`) for "defaults" in `Link`, so that `encode`
  writes back what was given, or make the menu copy the stored `c.link`.

### 6. The page's peer list only grows, so "N members reached" counts every key ever confirmed (confirmed, module side)

- **Where:** web/room.ts:370 and :401 (`startRoomNet`'s `peers` map, only `set`), web/room.ts:78 and :164
  (`startRoom`'s, the same), web/app/network.ts:157 (`count: c.netmap.peers.length`), room.rs:1160-1166 (`forget`
  emits no event).
- **Defect:** the module says `peer` when a session is confirmed and says nothing when it forgets the peer (after
  3 min idle, 20 s lost, a failed probe, or a trial that ran out). The page never removes anyone.
- **Trigger:** ordinary use: the count goes up and never down, and the docs' "the members whose data decrypted" and
  the catalog's note ("members the machine has exchanged traffic with") read as current. Or abuse: a member with the
  room's ID makes fresh keys and calls in (16 a second are let in on trial, and each confirms by sending one packet).
- **Consequence:** a wrong status line. Under abuse, the page's map and the `netmap` grow without bound, and each
  `peer` event rebuilds and re-renders the whole list (quadratic).
- **Confirmed by:** after `n.reach(0, 1, …)` and `n.advance(PEER_IDLE + 5 s)`, `n.nodes[0].c.peers` is empty and the
  only non-log event since was a `path`. Fix: a `peer-gone` event from `forget` (for a confirmed peer), removed from
  both maps. Then a `room/tests.rs` case: `a_forgotten_peer_says_so`.

### 7. Two workers sharing a key race to create it on its first start (by reading)

- **Where:** web/room.ts:218-224 (`roomIdentity`: a readonly `get` transaction, then a separate readwrite `put`),
  web/room-worker.ts:63.
- **Defect:** a check-then-act across two IndexedDB transactions. If two room workers start with the same
  `identityKey` before either has stored it, both read `undefined`, both make a key, and the second `put` overwrites
  the first.
- **Trigger:** two adapters of a machine attached to a room connection and to another one made with its key (`keyOf`),
  both connecting at start before either has ever connected. This is the setup network-adapters.md §2.1 describes.
- **Consequence:** in the first session, room 1 runs on a key that isn't stored, so the name it showed and gave out
  stops working at the next start. It is also not the shared identity the user asked for. This is state that differs
  between the first run and later runs.
- **Confirm:** a Node test with fake-indexeddb is not available (no dependency). In Chromium: two `roomIdentity(k)`
  calls started together, then `hasRoomIdentity` and a second `roomIdentity(k)`, checking that both first results
  equal the kept one. Fix: one readwrite transaction that gets and, if absent, puts (`add` and, on a ConstraintError,
  read back).

### 8. Lookup events cost the target its crypto before any budget (by reading)

- **Where:** net/ts/src/room.rs:978-985 (`on_lookup`: tag match, then `Lookup::open`, which does an X25519 and up to
  two ChaCha20-Poly1305 decryptions for each event), lookup.rs:136-156.
- **Defect:** the only filter before the crypto is "its `x` is one of our three tags". The tag needs only the room's ID
  (the salt) and the node's address, which every member who has the node's name knows. Nothing limits events per
  second before decrypting. The relay knows the tags anyway, from our REQ.
- **Trigger:** a member, or a relay, publishing junk 106-byte contents under a node's tag on the room's relays as fast
  as the relays accept them. Each relay of the link forwards its own copy.
- **Consequence:** worker CPU on the target in proportion to the flood. In wasm, an X25519 is tens of microseconds, so a
  few thousand events a second takes a whole core. The packet path shares that worker. The budgets (`TRIALS_PER_SECOND`,
  `MAX_NONCES`) only start after an event has opened.
- **Confirm:** a room/tests.rs case that `inject`s 10,000 junk events under node 1's tag in one instant and checks that
  at most N reach `Lookup::open` (a counter, or time the loop natively). Fix: a per-second budget on events taken into
  `on_lookup` (dropping the excess), sized above the budget for real lookups.

### 9. The page's link checks disagree with link.rs in both directions (confirmed)

- **Port:** web/room.ts:292 (`DERP` takes `(:\d{1,5})?`, so `derp.example:99999`), against tailcat.rs:181
  (`parse::<u16>`). The wizard creates and stores such a connection, and every connect then fails in `ts_new` with
  link.rs's raw English ("…: the port isn't a number") instead of a catalog message. Confirmed: `Link::parse(
  "webpc-room:a?derp=derp.example%3A99999")` is an `Err`.
- **Escapes:** web/room.ts:272-288 (`dec` walks UTF-8 bytes `b[i]` but reads the two hex digits with
  `s.slice(i + 1, i + 3)`, which counts UTF-16 units). Once a link has a raw non-ASCII character, the indices drift.
  Confirmed with `dec` copied into a Node script: `webpc-room:café%20lan` is refused as a bad link (link.rs reads
  `café lan`). `webpc-room:é%4142` is accepted as the ID `é\x1442`, while link.rs reads `éA42`. The page then writes
  its own reading back with `roomLink`, so the connection joins a different room from the one the pasted link names.
  Raw non-ASCII appears when a chat app or a person decodes the link for display. link.rs never writes one.
- **Fix:** take the hex digits from the bytes (`String.fromCharCode(b[i+1], b[i+2])`), and bound the port to 65535
  in `DERP`. Add cases for both to tests/room-link.test.ts.

### 10. Copy room link's fallback selects the name, not the link (by reading)

- **Where:** web/app/Network.svelte:69-71 and :113. `copyRoom` selects `net-room-name` whenever the clipboard refuses,
  including for the link. The link has no field of its own in the menu.
- **Consequence:** when `navigator.clipboard.writeText` rejects (for example, the document isn't focused), the user
  pressing Ctrl+C after Copy room link copies the machine's name and gives that out as the room's link. Low.

## Smaller notes (not defects as such)

- **Cost:** room.rs:1658-1663 `peer_of_rtc` scans every peer on each data-channel message (`rtc_message`,
  `rtc_signal`, `rtc_open`, `rtc_closed`), and room.rs:1986 calls `rtc_count()` (another scan) for each peer in
  `tick`. At the 1,024-peer cap with 64 channels, that is about a thousand map lookups per WireGuard packet on the
  direct path. A `BTreeMap<u32, PeerId>` from rtc to peer would remove it. This is unmeasured, so it is no claim of a
  regression.
- **Backoff:** a failed offer's backoff is bypassed when the peer goes idle. `tick` turns `Idle { next: Some(t) }`
  into `Idle { next: None }` when `idle` (room.rs:1986-1988), and the next guest packet offers at once (`touch`,
  room.rs:1387). This is harmless, but it means "the next waits 30 s, doubling" holds only for a busy peer.
- **Typed public room names** are matched by their bytes: an NFC and an NFD "Café", or different case, are different
  rooms with no warning. The page could NFC-normalize what it types into a link.
- **Labels:** `isPrivateRoom` (web/room.ts:240) labels any ID ending in `-` plus 26 base32 letters as private, even a
  public name typed that way. This is cosmetic.

## Checked and found fine

- **Packet parsing:** `unpad` guarantees 40 bytes before `on_tunnel_packet` indexes them (an IPv4 plaintext is
  stopped by the version check first). `guest_packet` checks length, version and source. ICMPv6 errors are at most
  1,280 bytes. Every `relays[...]` index comes from a checked source (`on_lookup`'s region, hello's `g < regions`, the
  relay a packet came in on). `peers`/`by_addr`/`wg` stay in step through `add_peer` and `forget`.
- **WireGuard:** keepalives decrypt to an empty `to_local`, which clears `waiting`, so a one-way UDP stream isn't
  "lost" after 20 s (checked in ts_tunnel 0.6.1 `recv_transport_data`). Handshake messages always go through DERP.
  The address binding (source equals the peer's own address, destination equals ours) holds on both paths.
- **Lookups:** the tag is the AEAD's associated data in both seals. Both seals mix the room's lookup key. A sealed
  lookup can't be opened by another member (lookup.rs's test). The time window, the nonce memory (three hours, 8,192)
  and the "own key" check hold. Crossed dials call back only from the lower key. A forged lookup for a confirmed peer
  only probes it. One for a waiting call back can redirect it to another region of the link, but the dialer's resend
  goes through the right region again (`INIT_AGAIN`).
- **Budgets:** call backs (16 a second, 64 waiting, the deadline wakes at the window's front plus 1 s while some
  wait, `serve_calls` skips keys that already have a peer), unasked trials (charged only once WireGuard answered),
  `MAX_PEERS`, `MAX_PENDING`, `LOOKUPS_PER_SECOND`, flows, known keys, the unreachable list.
- **The hour's turn (R3):** `self.hour` moves at each relay's renewal. The subscription's h-1..h+1 covers the new
  hour until then, `on_lookup`'s tag check uses the same hour, and with several relays the stale one's window still
  covers the current hour.
- **NIP-01:** the event id is SHA-256 of `[0,pubkey,created_at,kind,tags,content]`, and serde_json's escaping is
  NIP-01's for the base64/hex content used. BIP-340 matches vector 0. REQ, CLOSE, EOSE, CLOSED, OK and NOTICE are
  handled. A REQ under the same ID replaces it, and the hour's ID change sends CLOSE then REQ.
- **Signalling:** the resend schedule (0.5, 1.5, 3.5 s, dropped at 5.5 s) matches the docs. Acks are idempotent, and
  `seen` is bounded. A restarted peer's epoch resets attempts and the outbox. Relay-only refusals stop the offerer.
  A candidate that arrives before its offer creates the answerer's connection, and the offer is applied to it.
- **DNS:** names are lowercased by `dns::parse`, so case doesn't matter. Answers are filtered by qtype (A gives an
  empty answer), and `fit` respects the EDNS size.
- **Incoming off:** the flow keys of `note_flow` and `reply_allowed` mirror each other. Extension headers and unknown
  protocols are dropped. ICMPv6 errors pass only from a peer the guest has a flow with.
- **Page and worker:** the worker's `detach` during module load or identity read returns before making a client.
  `ts-client`'s stale-channel guard (`live()`, `rtcClosed(rtc, dc)`) holds. A `rtc-close` that races a just-transferred
  channel ends in a no-op `ts_rtc_closed`. `remote()` queues candidates until the description. Connections:
  `delete`/`sharesKey` keep a shared key until the last user goes, the wizard offers only stored connections' keys,
  and New name on an unshared stored connection forgets the key before the restart makes a new one.
- **Not checked:** bench/net/room-scale.ts's statistics beyond a skim. The test relay (tests/net/nostr-relay.ts) is
  fine for its use; its frame parser waits forever on a declared length it never gets and keeps `events` unbounded
  with `keep`, which only matters for a long run with `keep` on.
