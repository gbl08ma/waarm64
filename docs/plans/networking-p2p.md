# Peer-to-peer rooms over WebRTC (proposed, not scheduled)

VMs in different browsers on one network that "just works": nobody copies keys around, nodes join
and leave at any time, and packets go browser to browser over WebRTC, with DERP only as the
fallback. A **room** is a human-picked ID that participants agree on (`gabriel-lan`, or something
long and secret), with no owner and no account. A room is only its secret: members share a WireGuard
pre-shared key and a way to find each other by address; nothing lists them. The only names are names
that are keys. Everything heavier (human-readable names, TLDs, a name system) is left for later (§8).

This replaces [networking.md](networking.md) §6's sketch (a layer-2 switch over a signalling
server, with TURN). What exists today, and what this reuses, is [tailnet.md](../tailnet.md): our
Rust client in `net/ts`, tailcat's data plane (WireGuard through DERP, an address from the node
key) and the Ethernet gateway ([devices.md](../devices.md) "net").

## 1. Decisions

- **Layer 3, not layer 2.** Each node's address is its key: IPv6 in a /48 of our own plus the first
  80 bits of its WireGuard node key, as tailcat does, and a node accepts packets from a peer only
  with that peer's own address as the source. So an address proves who sent a packet, which a MAC on
  a switched LAN can't, and nothing is broadcast to thousands of peers. The gateway, the lease and
  the guest side stay as they are for tailcat. What's lost: broadcast and multicast between guests
  (ARP-style discovery, mDNS, LAN games that broadcast), and IPv4 between guests (§8).
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
- **Who sees a node's real IP address:** the members it connects to directly (its public address
  and port from the candidates; a LAN address stays behind Chromium's `.local` name); the operators
  of its DERP regions (with its node key, so its room address, and which keys it exchanges packets
  with), of the room's Nostr relays (with its opaque tags; a relay can match a lookup to the
  subscriber of its tag, so which IP address looked up which, without the room or the addresses)
  and of the STUN servers (with no identity). Nobody else: lookups need the room's key, and
  candidates the handshake. Someone who ever had the room's ID stays a member: the secret can't be
  revoked. Accepted (2026-11-10); the page says so beside a room's privacy note, with one's own
  relays and derper (or a VPN under them) as the remedy.
- **Relay only**, a node's setting, off by default: no WebRTC, everything through DERP, as on a
  tailcat network, so peers never learn its address. Hiding it from DERP's operators too would take
  onion routing (§8).
- **Finding a peer is a live question over Nostr relays** (§3): the one thing DERP can't do is tell a
  node where a peer is. A dialer publishes a sealed lookup as an **ephemeral event** (kinds
  20000–29999, NIP-01: relays forward it to subscribers and store nothing, as Trystero's signalling
  does), and the peer, subscribed to its own address's tag, calls back through DERP. Nothing about a
  node stays on a relay, and a relay can't tell which room or address a tag stands for. A peer that
  is offline can't be found; nothing says it exists. Several independent public relays, or one's
  own, chosen per room. Pluggable: MQTT brokers could stand in (they forward to a topic the same way).
- **No TURN.** DERP is the relay. STUN only (public servers, configurable).
- **Not Trystero as a library** (checked at 0.26.0, 2026-11-10): it offers to every peer that
  announces in a room (a full mesh; its README says to split users into groups), its data channel is
  ordered and reliable and can't be configured, its peer IDs and Nostr keys are random per page load
  (no lookup by key), and its fallback is TURN. Its Nostr pattern is what §3 takes: ephemeral kinds,
  the topic in an `x` tag, several relays, a maintained relay list.
- **A lookup is a hint, WireGuard is the truth.** A lookup can't be checked against the key it names
  (a WireGuard key is X25519 and can't sign), and it doesn't need to be: a forged or replayed one can
  only make a peer call a key back, and the handshake (with the room's pre-shared key) decides.
  Impersonation needs the private key.
- **Connections on demand.** A node opens a WebRTC connection to a peer when the guest first sends to
  that peer's address (or the peer offers one), keeps at most 64 open (as tailcat's server keeps 64
  clients), and closes those idle for 60 s, as it does DERP regions. Peers beyond the cap go through
  DERP. So a room of thousands costs a node only the peers it talks to.
- **No room owner, no membership list, no directory in the protocol.** Anyone who knows a room's ID
  can join. A room is as private as its ID is hard to guess: `gabriel-lan` is effectively public, and
  the page says so. A node is reachable by whoever knows its address (80 bits of its key: not
  guessable) and its room, and by nobody else. A list of who's here, where a room wants one, is a
  service inside the network that members choose to sign up with (§3, "Who's here"), so being listed
  is each node's choice.
- Dependencies: Nostr events need BIP-340 Schnorr signatures on secp256k1 (RustCrypto's `k256`,
  MIT/Apache-2.0; **OK'd by the user, 2026-10-18**), with a THIRD_PARTY.json row when it lands. The
  signing key is random per session, never derived from the node key, so a relay can't link a node's
  sessions by author.
  Everything else is already in `net/ts` (`ts_tunnel`, BLAKE2s, ChaCha20-Poly1305, NaCl boxes).

## 2. A room

From the room's ID, BLAKE2s with distinct labels derives three things, so every member derives the
same ones and nobody hands anything out:

- **the tag salt** and **the event kind** (in 20000–29999) of the room's lookups (§3): a relay sees
  tags that are hashes, not addresses or the room's name;
- **the lookup key** (ChaCha20-Poly1305): lookups are sealed with it, so a relay, or anyone outside
  the room, sees opaque blobs and can't make one;
- **the WireGuard pre-shared key** for every pair in the room (IKpsk2, as a tailcat address carries
  one): a node outside the room can't complete a handshake with a member even if it knows the key.

A node has one identity across rooms: the kept node key (IndexedDB, as `webpc-tailcat` keeps the
tailcat server's), so its address and name don't change when it rejoins. "New identity" makes a new
key.

## 3. Finding a peer

- **A node's tag** in a room is a hash (BLAKE2s) of the tag salt, the node's address and the current
  hour. A node in a room keeps a subscription (`REQ` with the room's kind and an `#x` filter, as
  Trystero's) open on each of the room's relays for its tags of this hour and the next, so the tag a
  relay sees changes every hour and doesn't follow a node across sessions or days.
- **A lookup** is an ephemeral event of the room's kind with the target's tag, sealed with the
  lookup key: the dialer's node key, its home DERP region (an ID in the relay map, or
  inline for one's own derper, as a tailcat address carries it) and a time. A node publishes it to
  every relay the room lists (three public ones by default) and again after 1 s and 3 s while no
  answer comes, then gives up (§4).
- **The answer is a call back**, not an event: a target that accepts the dialer (§5, "Incoming
  connections"; a flow the target opened counts) joins the dialer's home region and starts the
  WireGuard handshake through DERP, and §4 goes on from there. One event per lookup, and the
  target's own region reaches only the dialer. A target ignores lookups older than a
  minute and answers one dialer's repeats once.
- **The relays' terms** (rate limits, proof of work as in NIP-13, payment, which kinds they accept)
  decide how far public relays carry a room; R3 checks. A serious room runs its own relay, as it
  would its own derper.
- **Who's here** isn't the protocol's. A room that wants a list runs it as a service on a member
  with a well-known key, so a well-known address: the room's link carries that key beside the room's
  ID (the directory's key can't come from the ID, or every member would hold its private key).
  Members that want to be listed sign up with it over the room itself, and the others don't; it can
  carry display names (marked unverified) and what each member serves. The first form is a guest's
  own: any web page on a member, browsed at its address, with nothing in webpc. A list on the page
  itself (a small protocol the module speaks to the directory) waits until rooms are used (§8).

## 4. Connecting to a peer

1. The guest sends a packet to a room address. The module publishes a lookup for it (§3). The packet
   waits, as a packet to a fresh tailnet peer waits for its handshake; with no answer, the guest gets
   an ICMPv6 "address unreachable".
2. The peer calls back: it joins the dialer's home region and starts the WireGuard handshake through
   DERP (accepted only from a key whose first 80 bits are the address looked up), so the first
   packets flow over the fallback while WebRTC is set up.
3. Once the handshake has completed (never before: §1, "Signalling"), and unless either side is relay
   only, the side with the lower key offers: the page creates an `RTCPeerConnection` and a negotiated
   data channel (`ordered: false`, `maxRetransmits: 0`, id 0, on both sides), and the offer, answer
   and candidates cross inside the tunnel. A node drops any signalling from a peer without a current
   session, and a relay-only node answers an offer with a refusal, so the other side stops asking.
4. When the channel opens, the peer's WireGuard packets move to it; when it closes or stalls (no
   packet back while WireGuard's keepalive expects one), back to DERP, and a new offer later.

**Where WebRTC runs.** Chromium has no `RTCPeerConnection` in workers, but a data channel can be
transferred to one, only at creation, before any `send` (both checked in Chromium 141). So the page's
main thread holds the peer connections and the SDP, and hands each negotiated channel to the client's
worker as it creates it; packets never touch the main thread.

## 5. The guest's view

- **The lease:** the room address as an IPv6 /128 (DHCPv6, the router advertisement), as for a
  tailcat client. No IPv4 inside a room. The room is the machine's only network until R4, so no
  internet either.
- **DNS:** a name is `<key>.p2p.alt`, the node key in base32 (52 characters, one label), under `.alt`
  (RFC 9476's suffix for names outside the DNS, so it can never collide with a real TLD). The module
  answers AAAA for it by computing the address: no lookup, nothing to trust. Anything else is
  NXDOMAIN until there's an exit (R4). The page shows a node's name and lets the user copy it.
- **Incoming connections:** on by default (the user, 2026-11-10): reaching a node already takes the
  room's secret and its address, which nothing lists unless the node signs up with a directory (§3).
  Turned off, members can't open connections to the guest and lookups for it go unanswered; the guest's
  own flows still get their replies (a flow table, as the Tailscale client keeps for UDP). The page
  says, where a node signs up with a directory, that the room can then reach it, and that what the
  guest serves (an SSH server, say) is then open to the room.
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

SDP size doesn't constrain signalling over DERP, but for the record (Chromium 153, 2026-11-10): with
both pages ours, a data-channel-only remote description rebuilds from 47 bytes per side (the ufrag,
3; the password, 18; a SHA-1 fingerprint, 20, which Chromium checks against the remote certificate
like SHA-256, the page taking its own certificate's DER from a loopback connection once; a public
IPv4 candidate, 6), plus 19 for a LAN `.local` candidate. Chromium draws fresh ICE credentials per
connection (168 bits) and is withdrawing the munging that would fix them, so no setup fits in fewer.

## 7. Steps

Each with tests at the cheapest layer (`cargo test -p webpc_ts` sans I/O first), as the tailnet
client was built.

- **R0 — The data path, measured.** Two pages, keys exchanged by hand (an address like tailcat's),
  signalling through the tailcat rig's derper (`tests/net/tailcat.sh`), WireGuard over the data
  channel, the fallback to DERP when the channel is blocked. A third client kind in `net/ts`
  (`room.rs`, sharing `derp.rs`, `ts_tunnel`, `ip.rs`); new ABI actions to open, signal, send on and
  close a peer's channel, inputs for its messages and state; `web/room.ts` on the page. Measure
  against the DERP path: throughput, RTT, time to the first packet and to the first direct packet,
  CPU per Mbit, with and without the inner WireGuard. **Gate:** if the direct path isn't clearly
  better than DERP, stop and write down why.
- **R1 — Rooms.** §2's derivations, §3's tags, lookups and call backs (with a minimal Nostr relay in
  the test harness, in TypeScript: EVENT, REQ, CLOSE, the kind and tag filters, forwarding without
  storing; no dependency), joining and leaving, connections on demand with the cap and idle close,
  §5's lease, DNS and incoming switch. Tests: the client against the fake relay and fake peers
  (stale and replayed lookups, the hour's turn); two pages joining a room by its ID alone and pinging
  by name.
- **R2 — The page.** The Network wizard gets "Join a room" (the room ID; relays and derper under
  advanced settings, and a directory's key if the room has one); one's own name to copy; the
  incoming switch; the relay-only switch; who sees one's IP address (§1), beside the room's privacy
  note; the kept identity and "new identity". Two Debian guests in one
  Chromium reach each other by name in `scripts/ci-net.sh` (frontend.md "Network" grows a section).
- **R3 — Scale and the real world.** A thousand synthetic members on the test relay: join time,
  lookup time, the worker's memory. By hand: public Nostr relays (ephemeral kinds forwarded, time
  from a lookup to its call back, Trystero's relay list as the start) and the public tailcat relays
  carrying a room (their limits; whether their operators allow this use), two browsers on different
  networks (the dev VM and a phone, say), how often ICE fails. The public tailcat relays are the
  first choice for DERP (the user, 2026-10-18: try them); they're rate-limited, best-effort and
  revocable (tailnet.md "tailcat"), so R3 finds out whether rooms fit their limits. The defaults (relays, STUN servers)
  come out of this.
- **R4 — The internet beside a room.** A room and a tailcat exit node at once, as the tailcat server
  and client already share a module: the room's /48 goes to the room, the rest (and NAT46's IPv4) to
  the exit node, DNS through it.

## 8. Left open (explore later, not planned)

- **Human-readable names.** The direction discussed (2026-10-18): several TLDs per room, each held
  first-come by a key, with names in a TLD signed by its holder in DNSSEC's formats; a did:plc-like
  signed log per TLD (rotations signed by the old key, a recovery key with a window, two successors
  of one key proving a fork); one append-only Merkle log on always-on relays with independent
  witnesses to settle which claim came first (optionally anchored with OpenTimestamps); claims on
  real TLDs refused, or everything under `.alt`. Browsers don't validate DNSSEC, so validation would
  be the page's (or a guest resolver's with per-TLD trust anchors). The keys TLD above stays
  reserved for names that are keys.
- **Onion routing**, so that neither peers nor relays see who talks to whom from where: circuits
  through other members (or volunteer nodes), the address still the key's, as only the outer path
  changes. A milestone of its own if wanted; relay only (§1) covers hiding from peers until then.
- **Broadcast and multicast** between guests (mDNS for service discovery), fanned out only to peers
  already connected.
- **IPv4 between guests.** Key-derived IPv4 addresses would collide (32 bits); a per-node mapping
  would need state nobody keeps.
- **Spam** in public rooms: any member can flood lookups (proof of work on them, NIP-13; relays'
  own rate limits).
- **Who's here on the page**: a small protocol between the module and a room's directory service
  (§3), so the page lists members without a browser in the guest.
- Firefox and Safari: whether they have `RTCPeerConnection` in workers or transfer channels as
  Chromium does is unchecked.

## 9. Open questions

- Which public Nostr relays by default (Trystero's maintained list is a start), and whether they
  forward a busy room's lookups.
- The names' suffix: `p2p.alt` is a placeholder until R1.
