# Peer-to-peer rooms over WebRTC (in progress: R0 to R3 done 2026-11-10)

VMs in different browsers on one network, with packets going browser to browser over WebRTC and DERP
only as the fallback. Reaching a peer takes two steps: **joining its room**, and **knowing its
address**. A room is a human-picked ID that participants agree on (`gabriel-lan`, or something long
and secret), with the relays its members meet on; it has no owner and no account, and nothing lists
who is in it. An address comes from a node's key and can't be guessed, so a node is reachable only
by those its user gives its name to; that should hold even in a room everyone is in (§9). The only
names are names that are keys. Everything heavier (human-readable names, TLDs, a name system,
directories) is left for later (§8).

This replaces [networking.md](networking.md) §6's sketch (a layer-2 switch over a signalling
server, with TURN). What exists today, and what this reuses, is [tailnet.md](../tailnet.md): our
Rust client in `net/ts`, tailcat's data plane (WireGuard through DERP, an address from the node
key), the Ethernet gateway ([devices.md](../devices.md) "net") and network adapters
([network-adapters.md](../network-adapters.md)).

## 1. Decisions

- **Layer 3, not layer 2.** A node's address is its room's /48 (§2) plus the first 80 bits of its
  WireGuard node key, as tailcat's is its own /48 plus 80 bits, and a node accepts packets from a
  peer only with that peer's own address as the source. So an address proves who sent a packet,
  which a MAC on a switched LAN can't, and nothing is broadcast to thousands of peers. The gateway
  and the guest side stay as they are for tailcat (§5). What's lost: broadcast and multicast between
  guests (ARP-style discovery, mDNS, LAN games that broadcast), and IPv4 between guests (§8).
- **A room membership is a connection, on an adapter.** A room is a connection kind beside tailnets,
  tailcat and the local helper ([network-adapters.md](../network-adapters.md) §2): the room's link
  and a node key, kept with the connection as tailcat's identity is, so it travels with a machine as
  its connections do. Keys and rooms are managed apart: adding a room makes a fresh key; under
  advanced settings, a connection can take another connection's key (the same identity in another
  room; one of them running at a time, the user's call of 2026-11-10: two DERP connections under one
  key break each other, §9's question as it was) or a second connection can join the same room with
  another key. Each room has its own /48,
  so two rooms on two adapters route apart.
- **WireGuard stays inside the data channel.** A peer's packets are the same WireGuard packets
  whichever path carries them (a data channel when one is open, DERP otherwise), so the address
  binding, the PSK and the fallback come from the code that exists. That costs a second layer of
  encryption over DTLS; R0 measures whether it matters.
- **Signalling goes inside the WireGuard tunnel**, over DERP, which routes by node key already: a
  WebRTC offer, answer and ICE candidates are messages in the tunnel to the peer (UDP between the
  two nodes' addresses on a port the module keeps for itself and the guest can't use; not disco
  boxes, whose seal doesn't involve the room), so they exist only after a handshake with the room's
  pre-shared key has completed. A node shows its candidates, and so its real IP address, only to a
  member it is talking to. The relay sees neither the SDP's addresses nor who offers what. No new
  kind of server: a room needs DERP for the fallback anyway.
- **Finding a peer is a live question over Nostr relays** (§3): the one thing DERP can't do is tell a
  node where a peer is. A dialer publishes a sealed lookup as an **ephemeral event** (NIP-01's kinds
  20000–29999: relays forward it to subscribers and store nothing, as Trystero's signalling does),
  and the peer, subscribed to its own address's tag, calls back through DERP. Nothing about a node
  stays on a relay, and a relay without the room's ID can't tell which room or address a tag stands
  for. A peer that is offline can't be found; nothing says it exists. MQTT brokers could stand in
  (they forward to a topic the same way).
- **A room's link carries where its members meet:** the room's ID, its Nostr relays and its DERP map
  (region IDs in the public tailcat relays' map, or a derper's URL inline). Members with the same link
  find each other; a call back goes only to a region in the link's map (§3). The page builds the link
  ([Create a room](ui:network:NetRoomPickStep.room.create)) and takes one ([Join a room](ui:network:NetRoomPickStep.room.join)); a bare ID gets the defaults (R4 picks them).
- **Who sees a node's real IP address:** the members it connects to directly, either way round (its public address
  and port from the candidates; a LAN address stays behind Chromium's `.local` name): one whose guest reaches it, with
  incoming on, and every one its own guest reaches, which learn it as it learns theirs, since a direct connection
  starts once the handshake is confirmed, unless either side is relay only; the operators
  of its DERP regions (with its node key, so its room address, and which keys it exchanges packets
  with), of the room's Nostr relays (with its opaque tags; a relay can match a lookup to the
  subscriber of its tag, so which IP address looked up which, without the room or the addresses)
  and of the STUN servers (with no identity). Nobody else: lookups need the room's key, call backs
  go only to the room's regions, and candidates need the handshake. Someone who ever had the room's
  ID stays a member: the secret can't be revoked. Accepted (2026-11-10); the page says so beside a
  room's privacy note, with one's own relays and derper (or a VPN under them) as the remedy.
- **Relay only**, a connection's setting, off by default: no WebRTC, everything through DERP, as on a
  tailcat network, so peers never learn its address. Hiding it from DERP's operators too would take
  onion routing (§8).
- **No TURN.** DERP is the relay. STUN only (public servers, configurable).
- **Not Trystero as a library** (checked at 0.26.0, 2026-11-10): it offers to every peer that
  announces in a room (a full mesh; its README says to split users into groups), its data channel is
  ordered and reliable and can't be configured, its peer IDs and Nostr keys are random per page load
  (no lookup by key), and its fallback is TURN. Its Nostr pattern is what §3 takes: ephemeral events,
  the topic in an `x` tag, several relays, a maintained relay list.
- **Lookups are sealed to the WireGuard node key itself**, no second key (the user, 2026-11-10, after R1's review):
  an X25519 box from an ephemeral key, its key derived by BLAKE2s with a label of its own, the room's lookup key, the
  shared secret and both public keys. The review found it sound: the target reveals only whether a lookup opened (by
  calling back), which takes the shared secret to make, so it's no oracle against the key, and Noise's own KDF chain is
  separated by its protocol name. So a name stays one key, and nothing more is kept. What it doesn't give, by design:
  the sender isn't authenticated (a hint, below), and recorded lookups have no forward secrecy if the key leaks.
- **A lookup is a hint, WireGuard is the truth.** A lookup can't be checked against the key it names
  (a WireGuard key is X25519 and can't sign), and it doesn't need to be: a forged or replayed one can
  only make a peer call a key back in one of the room's own regions, and the handshake (with the
  room's pre-shared key) decides. Impersonation needs the private key.
- **Connections on demand.** A node opens a WebRTC connection to a peer when the guest first sends to
  that peer's address (or the peer offers one), keeps at most 64 open (as tailcat's server keeps 64
  clients), and closes those idle for 60 s, as it does DERP regions. Peers beyond the cap go through
  DERP. So a room of thousands costs a node only the peers it talks to.
- **No room owner, no membership list, no directory in the protocol.** Anyone with a room's ID can
  join; joining reaches nobody until one has an address. A node is reachable by whoever knows its
  address (80 bits of its key: not guessable) and its room, and by nobody else; talking to a node
  gives it one's own address, as an IP address does. A list of who's here isn't part of this plan
  (§3, §8).
- **Public and private rooms, and fast derivation.** A room's secrets come from its ID by BLAKE2s
  (§2), fast, so a relay that keeps its lookups can guess a short ID offline and read them. The page
  makes the trade-off plain instead of slowing it: [Create a room](ui:network:NetRoomPickStep.room.create) asks whether the room is
  private, and a private room's ID is the chosen name plus a random suffix the page generates
  (128 bits, base32), the only form it accepts as private; anything else is public, and the page
  says what that means (anyone can join; addresses still protect each node). Creating and joining
  are the same thing underneath: a link.
- Dependencies: Nostr events need BIP-340 Schnorr signatures on secp256k1 (RustCrypto's `k256`,
  MIT/Apache-2.0; **OK'd by the user, 2026-10-18**), with a THIRD_PARTY.json row when it lands. The
  signing key is random per session, never derived from the node key, so a relay can't link a node's
  sessions by author. Everything else is already in `net/ts` (`ts_tunnel`, BLAKE2s,
  ChaCha20-Poly1305, NaCl boxes).

## 2. A room

From the room's ID, BLAKE2s with distinct labels derives, so every member derives the same ones and
nobody hands anything out:

- **the room's /48**, `fd` plus 40 bits (RFC 4193's form, the global ID from the hash; one that would
  be tailcat's `fd7a:115c:a1e0::/48` is skipped by the next label), and its **tag**, those 40 bits in
  base32 (8 characters) for names (§5);
- **the tag salt** of the room's lookups (§3): a relay sees tags that are hashes, not addresses or
  the room's name;
- **the lookup key** (ChaCha20-Poly1305), for lookups to a bare address (§3), so a relay, or anyone
  outside the room, sees opaque blobs and can't make one;
- **the WireGuard pre-shared key** for every pair in the room (IKpsk2, as a tailcat address carries
  one): a node outside the room can't complete a handshake with a member even if it knows the key.

All rooms' lookups share one ephemeral event kind, fixed, so relays can't group lookups by room
and no room's ID lands on a kind that relays treat specially: **26354** (R3, 2026-11-10), clear of
every kind the NIPs list (their ephemeral ones on that day: 21059, 22242, 23194, 23195, 24133, 24242,
27235, 28934–28936). No ephemeral kind is clear of Trystero's, which hashes each topic onto one of
20000–29999 (`strToNum(topic, 1e4) + 2e4`, 0.26.0); sharing a kind is harmless, since a relay
forwards by the `#x` filter too.

A connection's node key is kept in IndexedDB (as `webpc-tailcat` keeps tailcat's identity), so its
address and name don't change when it rejoins. "New identity" makes a new key.

## 3. Finding a peer

- **A node's tag** in a room is a hash (BLAKE2s) of the tag salt, the node's address and the hour.
  A node keeps a subscription (`REQ` with the kind and an `#x` filter, as Trystero's) open on each of
  the room's relays for its tags of the previous, current and next hour, so a dialer's clock may be
  off by most of an hour. It's renewed each minute (a liveness check), and a turned hour waits for
  that renewal (R3): the subscription has the new hour's tag already, and renewing at the turn put
  every member's REQ and CLOSE on the relay in the same second. The tag a relay sees changes every hour; a relay without the room's ID
  can't tie it to an address, though one that sees the same connection's subscriptions can chain a
  session's tags.
- **A lookup** is an ephemeral event of that kind with the target's tag, carrying the dialer's node
  key, its home region (an ID in the link's DERP map), a time and a random nonce. It is sealed to
  the target's own key (an X25519 box from an ephemeral key, with a label of its own) when the dialer
  knows that key, as it does for an address it resolved from a name (§5); only to a bare address,
  which a member who knows it could read, with the lookup key. A node publishes it to every relay of
  the link and again after 1 s and 3 s while no answer comes, then gives up (§4).
- **The answer is a call back**, not an event: a target that takes incoming connections (§5; a flow
  the target opened counts) joins the dialer's home region, if the link's map has it, and starts the
  WireGuard handshake through DERP, and §4 goes on from there. One event per lookup, and the target's
  own region reaches only the dialer. A target drops lookups older than a minute, lookups whose
  nonce it has seen, lookups from a key it has a session with (which can only re-route a live peer),
  and beyond a few new on-trial peers a second, so a member can't make it call out without bound.
  (R3: 16 a second, those past it waiting their turn, 64 at most, so a crowd of dialers gets in at
  that rate instead of on their resends; 4 a second and dropping let 25 of 200 dialers at once in
  within 15 s, bench/net/REPORT.md "Rooms at scale".)
  (R1: "older than a minute" became "more than an hour off its clock", the tags' window, since a
  dialer's clock may be off by most of an hour and a copy within it is dropped by its nonce, kept
  three hours; a lookup from a key with a session probes it with a signalling ping and calls back
  only if nothing decrypts in 4 s, so a member whose page reloaded is reached again at once while a
  forged lookup moves nothing; the caller's signalling hello is queued behind its handshake, as the
  responder can't send until data comes and a lone keepalive lost would leave it unable to. R1's
  out-of-context review added: only the lower key calls back when both dial at once; a lookup for
  a key whose call back is on trial sends its initiation through that region too; the dialer's
  lookup goes on until its peer is confirmed; budgets for call backs and unasked handshakes apart;
  caps on the guest's lookups; the subscription renewed and checked. Open for R4: public relays
  refuse events dated far ahead, so a skewed clock may hold only on a room's own relays.)
- **The relays' terms** (rate limits, proof of work as in NIP-13, payment, which kinds they accept)
  decide how far public relays carry a room; R4 checks. A serious room runs its own relay, as it
  would its own derper, and puts them in its link.
- **Who's here** isn't this plan's: a node's address reaches others the way the user gives it out
  (§5, "DNS": the name to copy). A room's participants can run a directory themselves, as an
  application on a member whose identity they agree on among themselves (so a well-known address),
  with nothing in webpc; anything on the page is left for later (§8).

## 4. Connecting to a peer

1. The guest sends a packet to a room address. The module publishes a lookup for it (§3). The packet
   waits, as a packet to a fresh tailnet peer waits for its handshake; with no answer, the guest gets
   an ICMPv6 "address unreachable".
2. The peer calls back: it joins the dialer's home region and starts the WireGuard handshake through
   DERP (accepted only from a key whose first 80 bits are the address looked up), and sends a
   keepalive as soon as the response arrives, so the dialer, the responder, holds a confirmed session
   (IKpsk2 proves the PSK only through data) and can send at once. The first packets flow over the
   fallback while WebRTC is set up. Each side gives the other its home region inside the tunnel.
3. Once the handshake has completed (never before: §1, "Signalling"), and unless either side is relay
   only, the side with the lower key offers: the page creates an `RTCPeerConnection` and a negotiated
   data channel (`ordered: false`, `maxRetransmits: 0`, id 0, on both sides), and the offer, answer
   and candidates cross inside the tunnel. Signalling messages carry a sequence number and are
   acknowledged and resent (after 0.5, 1 and 2 s), since DERP drops when a peer's queue fills; an
   offer not answered with an open channel in 10 s is dropped, and the next waits 30 s, doubling to
   5 minutes. A node drops any signalling from a peer without a current session, and a relay-only
   node answers an offer with a refusal, so the other side stops asking. (R0: the port is 1; each
   message carries the sender's instance, a random number per client, so a peer that restarted is
   seen as one and its signalling starts afresh.)
4. When the channel opens, the peer's WireGuard packets move to it, except handshake messages, which
   always go through DERP (R0: they're rare, and a peer that restarted has no channel to take our
   response); when it closes or stalls (nothing back 15 s after we sent, past WireGuard's 10 s passive
   keepalive), back to DERP, and a new offer 30 s later. Both
   sides stay joined to a region that reaches the other while the peer is open, so that fallback
   never needs a new lookup.

**Where WebRTC runs.** Chromium has no `RTCPeerConnection` in workers, but a data channel can be
transferred to one, only at creation, before any `send` (both checked in Chromium 141). So the page's
main thread holds the peer connections and the SDP, and hands each negotiated channel to the client's
worker as it creates it; packets never touch the main thread.

## 5. The guest's view

- **The lease:** the room address as an IPv6 /128 (DHCPv6, the router advertisement) and IPv4
  `192.0.0.2` with no IPv4 routes, as tailcat's lease carries it (the gateway's lease needs an IPv4
  address; nothing outside sees this one). A room reaches no internet: on the primary adapter its
  /48 and resolver are the guest's only network; on another adapter (`routedLease`,
  [network-adapters.md](../network-adapters.md) §4) it offers its /48 as its route, so a tailnet or
  tailcat on another adapter keeps the default route and the internet. A machine in several rooms
  has an adapter per room, with distinct /48s.
- **DNS:** a name is `<key>.<tag>.p2p.internal`: the node key in base32 (52 characters, one label),
  the room's tag (§2), under `.internal` (which ICANN reserved in 2024 for private use and will never
  delegate, so it can never collide with a real TLD). Not RFC 9476's `.alt`, the first choice: R2 found
  that systemd-resolved (Debian 13's, 2026-11-10) answers any `.alt` name NXDOMAIN itself, whatever the
  link's DNS server and routing domain, so a guest with resolved, as Debian's and Arch's are, never
  asks the room's resolver (which answered the same query sent to it directly). It's in resolved's
  source since v255: `dns_scope_good_domain()` refuses a name that `dns_name_dont_resolve()` matches
  (`*.alt`, with `*.invalid` and a few RFC 6303 reverse zones) before it looks at any link's servers or
  routing domains, so no answer in a lease (DHCPv6's domain list, the RA's DNSSL) can route it. Other
  unofficial TLDs (a home LAN's `.lan`, say) aren't on that list and resolve normally. `.internal`
  is the suffix (the user, 2026-11-10). The module answers at
  the room's `::53` (in its /48, as `MAGIC_DNS6` is
  tailnets' resolver), the lease's `dns6`, with `<tag>.p2p.internal` its routing domain (`domains`): AAAA
  by computing the address, no lookup, nothing to trust, and the module remembers the key for that
  address, to seal lookups to it (§3). Anything else is NXDOMAIN. The page shows a node's name and
  lets the user copy it.
- **Incoming connections:** on by default (the user, 2026-11-10): reaching a node already takes the
  room's ID and its address, which nothing lists: only those the user gives it to have it. Turned
  off, members can't open connections to the guest and lookups for it go unanswered; the guest's own
  flows still get their replies (a flow table, as the Tailscale client keeps for UDP). The page says,
  beside the name to copy, that whoever has it can reach what the guest serves (an SSH server, say).
- **Relay only** (§1): the node's packets all go through DERP; its address reaches no peer.

## 6. Numbers so far

Ad hoc, in a cloud session (x86_64 container, Playwright's Chromium 141 headless, two peer
connections in one page on loopback, no WireGuard), not the dev VM: a negotiated channel set up in
92 ms; 1,280-byte messages (a WireGuard packet at the tunnel's MTU is ~1,312 bytes) carried
**142 Mbit/s** (~13,900 a second, 0.7% lost at saturation, as unreliable channels drop) sent from
the main thread, **173 Mbit/s** from a worker the channel was transferred to; 16 KB messages
244–250 Mbit/s; RTT 0.2 ms. For scale: our tailcat client does 137 Mbit/s through a local DERP in
Chromium on the M4 ([tailnet.md](../tailnet.md) "Numbers"), and Rings managed ~10 Mbit/s of
packets (networking.md §2). Loopback hides what matters most: setup time across real NATs, and how
often ICE fails and DERP carries the room.

**R0** (2026-11-10, the same kind of cloud session, Chromium 153; bench/net/REPORT.md "Rooms: the direct path
against DERP"): two members in two pages through our module, 1,280-byte echoes 32 in flight, 5 alternated rounds.
The direct path **50.9 Mbit/s each way** (rounds 42–63) at 23.5 core-ms per Mbit, DERP on loopback 35.1 (31–37) at
34.3, a bare channel between two workers 70.6 at 16.6. The first echo 23 ms after `Running` (through DERP), the
channel open 23 ms after the handshake. The gate holds.

SDP size doesn't constrain signalling over DERP, but for the record (Chromium 153, 2026-11-10): with
both pages ours, a data-channel-only remote description rebuilds from 47 bytes per side (the ufrag,
3; the password, 18; a SHA-1 fingerprint, 20, which Chromium checks against the remote certificate
like SHA-256, the page taking its own certificate's DER from a loopback connection once; a public
IPv4 candidate, 6), plus 19 for a LAN `.local` candidate. Chromium draws fresh ICE credentials per
connection (168 bits) and is withdrawing the munging that would fix them, so no setup fits in fewer.

## 7. Steps

Each with tests at the cheapest layer (`cargo test -p webpc_ts` sans I/O first), as the tailnet
client was built.

- **R0 — The data path, measured.** *Done 2026-11-10* (docs/tailnet.md "Rooms"; §6): `room.rs` with §2's
  derivations already, peers given by key, incoming connections on trial, one home region; ABI actions 7–10 and
  `ts_rtc_*`; `web/room.ts` and `web/room-worker.ts`; `cargo test -p webpc_ts room` (a fake relay and a fake WebRTC:
  the fallbacks, loss, a restart, relay only, address binding) and `tests/room-browser.test.ts` (two pages on the
  rig's derper). CPU per Mbit and "without the inner WireGuard" measured as a bare channel's arm; the numbers from
  a cloud session, to repeat in the dev VM. The brief as it was: Two pages, keys exchanged by hand (an address like tailcat's),
  signalling through the tailcat rig's derper (`tests/net/tailcat.sh`), WireGuard over the data
  channel, the fallback to DERP when the channel is blocked. A fourth connection kind's client in
  `net/ts` (`room.rs`, sharing `derp.rs`, `ts_tunnel`, `ip.rs`); new ABI actions to open, signal, send
  on and close a peer's channel, inputs for its messages and state; `web/room.ts` on the page.
  Measure against the DERP path: throughput, RTT, time to the first packet and to the first direct
  packet, CPU per Mbit, with and without the inner WireGuard. **Gate:** if the direct path isn't
  clearly better than DERP, stop and write down why.
- **R1 — Rooms.** *Done 2026-11-10* (docs/tailnet.md "Rooms"; §3's amendments): the link
  (`webpc-room:<id>?nostr=…&derp=…`), lookups on Nostr (`k256`, `nostr.rs`, the kind 26354 a placeholder), call backs
  into a dialer's home region with a DERP connection per region in use, the probe, the caps and idle closes, the
  resolver, incoming off's flow table, the review's fixes; `cargo test -p webpc_ts room` (34 cases), `tests/nostr-relay.test.ts`,
  `tests/room-browser.test.ts` by link and by name. The brief as it was: §2's derivations, the link's format, §3's tags, lookups and call backs (with a
  minimal Nostr relay in the test harness, in TypeScript: EVENT, REQ, CLOSE, the kind and tag
  filters, forwarding without storing; no dependency), signalling's resends, joining and leaving,
  connections on demand with the cap and idle close, §5's lease, resolver and incoming switch.
  Tests: the client against the fake relay and fake peers (stale, replayed and forged lookups, a
  lookup naming a region outside the map, the hour's turn, lost signalling); two pages joining a
  room by its link, one given the other's name, pinging by name.
- **R2 — The page.** *Done 2026-11-10* (frontend.md "Network", network-adapters.md §2.1): the `room` kind, the
  wizard's [Create a room](ui:network:NetRoomPickStep.room.create) (a private room's 128-bit suffix, relays under Advanced)
  and [Join a room](ui:network:NetRoomPickStep.room.join), the switches, another connection's key, the IP-address note, the
  menu's name and link to copy, New name; the key in `webpc-room`; the names' suffix moved to `.internal` (§5).
  `tests/page-room.test.ts` (two Debian guests in one Chromium, in `scripts/ci-net.sh`), `tests/room-link.test.ts`,
  and the controller's, the connections' cases. Left to R4: the room on a second adapter beside the local helper,
  whose source (a private repository) a cloud session can't fetch; the unit layer checks that a room is never the
  default way out (`primaryOf`). The brief as it was: A room as a connection kind (network-adapters.md "Connections" grows its
  record): [Create a room](ui:network:NetRoomPickStep.room.create) (a name, "private" and its suffix, relays and derper under advanced
  settings) and [Join a room](ui:network:NetRoomPickStep.room.join) (a link or a public ID); one's own name to copy; the incoming switch;
  the relay-only switch; the key under advanced settings (another connection's, or new); who sees
  one's IP address (§1), beside the room's privacy note. Two Debian guests in one Chromium reach each
  other by name in `scripts/ci-net.sh`, and a room on a second adapter beside the local helper
  keeps the internet (frontend.md "Network" grows a section).
- **R3 — Scale.** *Done 2026-11-10* (bench/net/REPORT.md "Rooms at scale", `bench/net/room-scale.ts`): a
  thousand members (the module, an instance each, relay only, in Node) on the tests' relay and the rig's
  derper. Joining, idling and lookups at 10 and 50 new pairs a second don't move with the room's size (a
  member costs ~1.4 MiB and no measurable CPU idle; a lookup to its echo ~5 ms on loopback, one event);
  two fixes from what it found: a crowd of dialers waits for the target's trial budget (16 a second)
  instead of being dropped (§3), and the hour's turn waits for each relay's renewal (§3); the event kind
  decided (§2). The brief as it was: What a cloud session can measure, with nothing outside the test
  harness: a thousand synthetic members on the test relay (join time, lookup time, the worker's memory
  and CPU, the relay's load), the lookup's event kind chosen from the NIPs' reserved ranges (§2), and
  what the defaults need from a relay (the kinds, the `#x` filter, the rate of events a busy room sends)
  written down for R4 to check against real ones.
- **What a room needs from a Nostr relay** (R3, for R4 to check public ones against): NIP-01 over a
  plain WebSocket, no NIP-42 AUTH and no NIP-13 proof of work (a relay that requires either carries no
  room); ephemeral kind 26354 accepted and forwarded; filters by a single-letter tag (`#x`, three
  values) with `limit: 0`, each REQ answered with an EOSE (a renewal under the same ID too: 15 s without one and the
  member takes the connection for dead and reconnects); `created_at` within the relay's tolerance of the dialer's clock (R1: some
  refuse events dated ahead). A member holds one connection and one subscription a relay, renewed
  every minute (one REQ; at the hour's turn, within the next minute, a CLOSE and a REQ under a new
  subscription ID); a lookup is one event of ~550 bytes on the wire, forwarded to one subscriber (a tag
  is one node's), again after 1 s and 3 s only while no call back comes, at most 8 lookups a second a
  member. A thousand members: 17 REQs a second steady, 2.8 KB/s in; each new pair a second one event.
- **R4 — The real world, by hand and in the dev VM** (split from R3 on 2026-11-10, the user's call: the dev
  VM is unavailable for a while, so what needs it or a person waits here). First the runs the cloud can't
  do: `scripts/ci-net.sh` whole (the cloud has no Podman or IPv6, docs/cloud.md), R0's numbers again
  (`node bench/net/room.ts 5 10000 <json>`), and R2's room on a second adapter beside the local helper keeping
  the internet (a Debian test beside `tests/net-local.test.ts`'s). *Those three done 2026-11-10 in the dev VM*:
  `scripts/ci-net.sh` OK (885 s), R0's gate holds there too (direct 183 Mbit/s each way against DERP's 126, 32%
  less CPU per Mbit; bench/net/REPORT.md), and `tests/net-local.test.ts`'s second case (the helper's adapter the
  primary, the room's member by name on the second card). *2026-11-11*: the public Nostr relays and tailcat's regions
  measured from the dev VM (bench/net/REPORT.md "Rooms on public servers"; two of our three default Nostr relays
  carry no room), and the DERP choice fixed after the user's first try (200 ms pings through New York): a link
  without regions takes all of the map's, and the home region is the first to answer a probe (tailnet.md "DERP").
  By hand: public
  Nostr relays (the fixed kind forwarded, time from a lookup to its call back, Trystero's relay list as
  the start, events dated ahead of their clocks) and the public tailcat relays carrying a room (their
  limits; whether their operators allow this use), two browsers on different networks (the dev VM and a
  phone, say), how often ICE fails. The public tailcat relays are the first choice for DERP (the user,
  2026-10-18: try them); they're rate-limited, best-effort and revocable (tailnet.md "tailcat"), so R4
  finds out whether rooms fit their limits. The defaults (relays, DERP map, STUN servers) come out of
  this, and §9's public room is decided with them.

## 8. Left open (explore later, not planned)

- **Human-readable names.** The direction discussed (2026-10-18): several TLDs per room, each held
  first-come by a key, with names in a TLD signed by its holder in DNSSEC's formats; a did:plc-like
  signed log per TLD (rotations signed by the old key, a recovery key with a window, two successors
  of one key proving a fork); one append-only Merkle log on always-on relays with independent
  witnesses to settle which claim came first (optionally anchored with OpenTimestamps); claims on
  real TLDs refused, or everything under `.alt`. Browsers don't validate DNSSEC, so validation would
  be the page's (or a guest resolver's with per-TLD trust anchors). The keys TLD above stays
  reserved for names that are keys.
  *Names stay full keys* (the user, 2026-11-11, asked whether a name could carry only the address's 80 bits, as long
  as the address): kept at 52 characters, since only the full key lets a lookup be sealed to its target (§3) and the
  handshake accept that one key rather than any key with its first 80 bits. Shorter, nicer names belong here, and
  likely to a DNS system run within the guests' world (no directory in the protocol, §1) rather than to the room.
- **Onion routing**, so that neither peers nor relays see who talks to whom from where: circuits
  through other members (or volunteer nodes), the address still the key's, as only the outer path
  changes. A milestone of its own if wanted; relay only (§1) covers hiding from peers until then.
- **Broadcast and multicast** between guests (mDNS for service discovery), fanned out only to peers
  already connected.
- **IPv4 between guests.** Key-derived IPv4 addresses would collide (32 bits); a per-node mapping
  would need state nobody keeps.
- **Spam** in public rooms: any member can flood lookups (proof of work on them, NIP-13; relays'
  own rate limits).
- **Who's here on the page**: a directory stays the participants' own (§3: they operate it and
  agree on its identity, which can't come from the room's ID, or every member would hold its private
  key); the page could list it if the user gives it that identity's name, through a small protocol
  such directories would speak.
- Firefox and Safari: whether they have `RTCPeerConnection` in workers or transfer channels as
  Chromium does is unchecked.

## 9. Open questions

- **A public room every machine joins by default** (the user's direction, 2026-11-10): safe if an
  address stays unguessable and lookups to a name stay sealed to the target. Whether public relays
  and DERP carry everyone (R4), and what the page says, decide it.
- *Decided 2026-11-10, the user: one at a time (a lock per key).* **Two rooms on one key** (the review of R2–R3, 2026-11-10, confirmed against the rig's derper,
  `bench/net/room-member.ts` with a `key`): §1's "a connection can take another connection's key"
  runs two clients with one WireGuard key, and each opens its own DERP connection under it; a derper
  delivers a key's packets to one connection, so with both on one region (the default `derp=0`, or
  any shared region) the rooms take turns failing (pings 1 ms in one, 6.5 s in the other, then the
  other way). Separate regions would work. The ways out: one DERP connection per key carrying every
  room on it (one worker per key, the module routing by the room's PSK); a key a running connection
  holds can't start in another (a lock per key, an error naming the holder); or the option goes.
- *Decided 2026-11-11, the user:* **the default Nostr relays** are relay.primal.net, relay.novospes.com,
  relay.routstr.com, nostr.rblb.it, relay.degmods.com and relay.nostrmap.net (link.rs `DEFAULT_NOSTR`): of those that
  carried every case R4 measured (bench/net/REPORT.md "Rooms on public servers"), the ones that also answer each REQ
  with an EOSE (2026-11-12: nostr.chaima.info, relay.grigic.org and nostr.red5d.dev, first chosen, never do with
  `limit: 0`, so members reconnected to them every few seconds; the user: a relay that behaves strangely is dropped,
  there are plenty); nos.lol and relay.damus.io, two of the placeholders, carried no room. **Rooms use tailcat's public DERP relays** by default: a room's client uses DERP
  as tailcat's and a tailnet's browser clients do, and tries direct WebRTC first, which Tailscale's browser clients
  can't, so it leans on the relays less than they do (the user's reasoning; tailcat's README sets no terms for them).
