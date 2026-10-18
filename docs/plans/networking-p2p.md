# Peer-to-peer rooms over WebRTC (proposed, not scheduled)

VMs in different browsers on one network that "just works": nobody copies keys around, nodes join
and leave at any time, and packets go browser to browser over WebRTC, with DERP only as the
fallback. A **room** is a human-picked ID that participants agree on (`gabriel-lan`, or something
long and secret), with no owner and no account. The only names are names that are keys. Everything
heavier (human-readable names, TLDs, a name system) is left for later (§8).

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
- **Signalling goes over DERP**, which routes by node key already: a WebRTC offer, answer and ICE
  candidates travel as raw DERP packets to the peer's key in its home region, sealed with a NaCl box
  to its disco key (as tailcat's meow and Tailscale's disco are). The relay sees neither the SDP's
  addresses nor who offers what. No new kind of server: a room needs DERP for the fallback anyway.
- **The directory is Nostr relays** (§3): the one thing DERP can't do is tell a node who is in a room
  and where they are. Several independent public relays, or one's own, chosen per room. Pluggable:
  WebTorrent's WebSocket trackers or MQTT brokers could stand in, but a tracker hands back a random
  ~50 peers per announce, which is a swarm, not a directory that can be asked about one key.
- **No TURN.** DERP is the relay. STUN only (public servers, configurable).
- **The directory is a hint, WireGuard is the truth.** An entry can't be checked against the key it
  names (a WireGuard key is X25519 and can't sign), and it doesn't need to be: a forged entry can
  only send a connection to the wrong region, and the handshake fails. Impersonation needs the
  private key.
- **Connections on demand.** A node opens a WebRTC connection to a peer when the guest first sends to
  that peer's address (or the peer offers one), keeps at most 64 open (as tailcat's server keeps 64
  clients), and closes those idle for 60 s, as it does DERP regions. Peers beyond the cap go through
  DERP. So a room of thousands costs a node only the peers it talks to.
- **No room owner, no membership list.** Anyone who knows a room's ID can join. A room is as private
  as its ID is hard to guess: `gabriel-lan` is effectively public, and the page says so.
- Dependencies: the Nostr side needs BIP-340 Schnorr signatures on secp256k1 (RustCrypto's `k256`,
  MIT/Apache-2.0; **OK'd by the user, 2026-10-18**), with a THIRD_PARTY.md row when it lands.
  Everything else is already in `net/ts` (`ts_tunnel`, BLAKE2s, ChaCha20-Poly1305, NaCl boxes).

## 2. A room

From the room's ID, BLAKE2s with distinct labels derives three things, so every member derives the
same ones and nobody hands anything out:

- **the topic**, the public tag a room's directory entries carry (a hash: a relay sees a room's
  entries together but not its name);
- **the directory key** (ChaCha20-Poly1305): entries are sealed with it, so a relay that doesn't
  know the ID sees opaque blobs;
- **the WireGuard pre-shared key** for every pair in the room (IKpsk2, as a tailcat address carries
  one): a node outside the room can't complete a handshake with a member even if it knows the key.

A node has one identity across rooms: the kept node key (IndexedDB, as `webpc-tailcat` keeps the
tailcat server's), so its address and name don't change when it rejoins. "New identity" makes a new
key.

## 3. The directory

- **An entry** (sealed with the directory key): the node's public key, its disco key, its home DERP
  region (an ID in the relay map, or inline for one's own derper, as a tailcat address carries it),
  a self-chosen display name (shown with the key's fingerprint and marked unverified; never in DNS),
  optionally the ports it serves, and a time.
- **As a Nostr event:** an addressable event (kinds 30000–39999, NIP-01) whose `d` tag is a hash of
  the topic and the node's address (the key's first 80 bits, all a guest's packet carries), so a
  node's newer entry replaces its older one; the topic as a tag, so
  one query lists a room; an expiration (NIP-40) a few minutes out, refreshed while the node is in
  the room. Leaving is letting it expire (or deleting it, NIP-09). The event is signed by a
  secp256k1 key derived from the node key, so a node's entries are always the same author.
- **Lookups:** by address (the `d` tag: "where is this node?", what connecting needs) and by topic,
  newest first with a limit ("who's here", for the page's list; not all of a room of thousands).
  A node publishes to every relay the room lists (three public ones by default) and merges what they
  return. When several entries claim one key, the newest that leads to a working handshake wins.
- **The relays' terms** (rate limits, proof of work as in NIP-13, payment) decide how far public
  relays carry a big room; R3 checks. A serious room runs its own relay, as it would its own derper.

## 4. Connecting to a peer

1. The guest sends a packet to a room address. The module looks the address up in the directory
   (§3's `d` tag) and takes the entry whose key starts with the address's 80 bits; entries whose key
   doesn't match are ignored. The packet waits, as a packet to a fresh tailnet peer waits for its
   handshake.
2. The node joins the peer's home region and sends the WireGuard handshake through DERP at once, so
   the first packets flow over the fallback while WebRTC is set up.
3. The side with the lower key offers: the page creates an `RTCPeerConnection` and a negotiated data
   channel (`ordered: false`, `maxRetransmits: 0`, id 0, on both sides), and the offer, answer and
   candidates cross through DERP, sealed.
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
- **Incoming connections:** off by default. Members can't open connections to the guest; the
  guest's own flows get their replies (a flow table, as the Tailscale client keeps for UDP). "Allow
  incoming from the room" turns it on, and is what a node that serves something sets.

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
- **R1 — Rooms.** §2's derivations, §3's directory (with a minimal Nostr relay in the test harness,
  in TypeScript: EVENT, REQ, CLOSE, EOSE, the filters and replacement this uses; no dependency),
  joining and leaving, lookups, connections on demand with the cap and idle close, §5's lease, DNS
  and incoming switch. Tests: the client against the fake relay and fake peers; two pages joining a
  room by its ID alone and pinging by name.
- **R2 — The page.** The Network wizard gets "Join a room" (the room ID; relays and derper under
  advanced settings); the list of who's here (display names marked unverified, keys); one's own
  name to copy; the incoming switch; the kept identity and "new identity". Two Debian guests in one
  Chromium reach each other by name in `scripts/ci-net.sh` (frontend.md "Network" grows a section).
- **R3 — Scale and the real world.** A thousand synthetic members on the test relay: join time,
  lookup time, the worker's memory. By hand: public Nostr relays and the public tailcat relays
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
- **Broadcast and multicast** between guests (mDNS for service discovery), fanned out only to peers
  already connected.
- **IPv4 between guests.** Key-derived IPv4 addresses would collide (32 bits); a per-node mapping
  would need state nobody keeps.
- **Spam and Sybil resistance** in public rooms: proof of work on directory entries, entries
  checkable against their key (XEdDSA signatures with the X25519 key).
- Firefox and Safari: whether they have `RTCPeerConnection` in workers or transfer channels as
  Chromium does is unchecked.

## 9. Open questions

- Which public Nostr relays by default, and whether they keep up with a busy room.
- The names' suffix: `p2p.alt` is a placeholder until R1.
- Whether incoming connections should default on in a room whose ID is long and secret.
