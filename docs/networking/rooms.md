# Peer-to-peer rooms

Machines in different browsers on one network, their packets going browser to browser over WebRTC and through DERP
only as the fallback. Reaching a peer takes two things: **being in its room**, and **knowing its name**. A room is
an ID its members agree on (`gabriel-lan`, or a name with a random suffix), with the relays they meet on; it has no
owner and no account, and nothing lists who is in it. A node's address and name come from its key and can't be
guessed, so a node is reachable only by those its user gives its name to, even in a room everyone is in (the global
room, below). The only names are names that are keys. What's left open (human-readable names, onion routing,
broadcast, IPv4 between guests, a directory on the page) is [plans/networking-p2p.md](../plans/networking-p2p.md).

**The files.** `net/ts/src/room.rs` is a third client of the tailnet module ([tailnet.md](tailnet.md) "The module"),
with `room/link.rs` (the link), `room/lookup.rs` (lookups) and `nostr.rs` (NIP-01 and BIP-340 over `k256`);
`web/room.ts` and `web/room-worker.ts` are its page and worker, sharing `web/ts-client.ts`'s I/O. A room is a
connection kind on the page ([frontend.md](../frontend.md) "Network": the wizard's Join the global public room, Create
a room and Join a room, the menu's name and link to copy); the node key a connection keeps is in `waarm64-room`
([adapters.md](adapters.md) §2.1), which the worker reads at the start (`identityKey`; an ephemeral connection's comes
as `identity`). It reuses tailcat's data plane (WireGuard through DERP, an address from the node key), the Ethernet
gateway ([devices.md](../devices.md) "net") and network adapters ([adapters.md](adapters.md)). Measurements:
bench/net/REPORT.md "Rooms", "Rooms at scale", "Again in the dev VM", "Rooms on public servers".

## Decisions

The user's, or taken with them, 2026-10-18 to 2026-11-12; they bind.

- **Layer 3, not layer 2.** A node's address is its room's /48 plus the first 80 bits of its WireGuard node key, as
  tailcat's is its own /48 plus 80 bits, and a node accepts packets from a peer only with that peer's own address as
  the source. So an address proves who sent a packet, which a MAC on a switched LAN can't, and nothing is broadcast to
  thousands of peers. The gateway and the guest side are tailcat's. Lost: broadcast and multicast between guests
  (ARP-style discovery, mDNS, LAN games that broadcast) and IPv4 between guests.
- **A room membership is a connection, on an adapter**, beside tailnets, tailcat and the local helper
  ([adapters.md](adapters.md) §1): the room's link, its switches and a node key, kept with the connection as tailcat's
  identity is, so it travels with a machine. A new room connection makes a fresh key; under Advanced it can take
  another stored room connection's (the same identity in another room) or a pasted one. **One running at a time per
  key** (the user, 2026-11-10): a derper delivers a key's packets to one connection, so two clients under one key on
  one region take turns failing (pings 1 ms in one room, 6.5 s in the other, then the other way, confirmed against
  the rig's derper); a running room connection holds its key's lock (`roomKeyLock`, web/app/net-live.ts). Each room
  has its own /48, so rooms on two adapters route apart.
- **WireGuard inside the data channel.** A peer's packets are the same WireGuard packets whichever path carries them
  (a data channel when one is open, DERP otherwise), so the address binding, the pre-shared key and the fallback come
  from the code tailcat has. The second layer of encryption over DTLS costs less than the path gains ("Numbers").
- **Signalling inside the WireGuard tunnel**, over DERP, which routes by node key already: the offer, answer and ICE
  candidates are messages in the tunnel to the peer (not disco boxes, whose seal doesn't involve the room), so they
  exist only after a handshake with the room's pre-shared key. A node shows its candidates, and so its real IP
  address, only to a member it talks to; the relay sees neither the SDP nor who offers what. No new kind of server.
- **Finding a peer is a live question over Nostr relays**, the one thing DERP can't do: a dialer publishes a sealed
  lookup as an **ephemeral event** (NIP-01's kinds 20000–29999: relays forward to subscribers and store nothing, as
  Trystero's signalling does), and the peer, subscribed to its own address's tag, calls back through DERP. Nothing
  about a node stays on a relay, and a relay without the room's ID can't tell which room or address a tag stands for.
  An offline peer can't be found; nothing says it exists. (MQTT brokers could stand in: they forward to a topic the
  same way.)
- **Lookups are sealed to the WireGuard node key itself**, no second key (the user, 2026-11-10, after R1's review):
  an X25519 box from an ephemeral key, its key derived by BLAKE2s with a label of its own from the room's lookup key,
  the shared secret and both public keys. Sound: the target reveals only whether a lookup opened (by calling back),
  which takes the shared secret to make, so it's no oracle against the key, and Noise's own KDF chain is separated by
  its protocol name. Not given, by design: the sender isn't authenticated, and recorded lookups have no forward
  secrecy if the key leaks.
- **A lookup is a hint, WireGuard is the truth.** A lookup can't be checked against the key it names (an X25519 key
  can't sign), and needn't be: a forged or replayed one can only make a peer call a key back in one of the room's own
  regions, and the handshake with the room's pre-shared key decides. Impersonation needs the private key.
- **Connections on demand.** A WebRTC connection opens when the guest first sends to a peer (or the peer offers
  one), at most 64 open, those idle 60 s closed; peers past the cap go through DERP. A room of thousands costs a node
  only the peers it talks to (bench/net/REPORT.md "Rooms at scale": nothing grows with the room's size).
- **No room owner, no membership list, no directory in the protocol.** Anyone with a room's ID can join; joining
  reaches nobody until one has a name. Talking to a node gives it one's own address, as an IP address does. A
  directory is the participants' own: an application on a member whose name they agree on (and can't come from the
  room's ID, or every member would hold its key).
- **Names stay full keys** (the user, 2026-11-11, asked whether a name could carry only the address's 80 bits): only
  the full key lets a lookup be sealed to its target and the handshake accept that one key rather than any key with
  its first 80 bits. Nicer names are plans/networking-p2p.md's.
- **Public and private rooms, and fast derivation.** A room's secrets come from its ID by BLAKE2s, fast, so a relay
  that keeps lookups can guess a short ID offline and read them. The page makes the trade-off plain instead of
  slowing it: Create a room asks whether the room is private, and a private room's ID is the chosen name plus a
  random suffix of 128 bits in base32, the only form the page calls private; anything else is public, and the page
  says what that means (anyone can join; names still protect each node). Creating and joining are the same
  underneath: a link.
- **The global public room** (the user, 2026-11-12): one public room, `global` (web/room.ts `GLOBAL_ROOM`) on the
  default relays, the wizard's first choice for a room, which skips the name and the link and has both switches on.
  It's suggested, not joined by default. It's safe because a name stays unguessable and a lookup to a name is sealed
  to its target; what a public room still allows (any member, so anyone, can flood lookups or fill a node's trial
  budget) is [plans/networking-p2p.md](../plans/networking-p2p.md) "Spam".
- **Incoming connections on by default** (the user, 2026-11-10): reaching a node already takes the room and its
  name, which nothing lists. Off, members can't open connections to the guest; the guest's own flows still get their
  replies.
- **Relay only**, a connection's switch, off by default: no WebRTC, everything through DERP, so peers never learn the
  node's IP address. Hiding it from DERP's operators too would take onion routing.
- **Who sees a node's real IP address** (accepted 2026-11-10; the wizard says so beside the switch): the members it
  connects to directly, either way round (its public address and port from the candidates; a LAN address stays behind
  Chromium's `.local` name), since a direct connection starts once a handshake is confirmed and a guest sent through
  it, unless either side is relay only; the operators of its DERP regions (with its node key, so its room address,
  and which keys it exchanges packets with), of the room's Nostr relays (with its opaque tags; a relay can match a
  lookup to the subscriber of its tag, so which IP address looked up which, without the room or the addresses) and of
  the STUN servers (with no identity). Nobody else: lookups need the room's key, call backs go only to the room's
  regions, candidates need the handshake. Someone who ever had a room's ID stays able to join: the secret can't be
  revoked. The remedy is one's own relays and derper (or a VPN under them).
- **No TURN.** DERP is the relay; STUN only (Cloudflare's and Google's, `STUN_SERVERS`).
- **The defaults** (the user, 2026-11-11 and 2026-11-12): six public Nostr relays, relay.primal.net,
  relay.novospes.com, relay.routstr.com, nostr.rblb.it, relay.degmods.com and relay.nostrmap.net (link.rs
  `DEFAULT_NOSTR`): of those that carried every case measured (bench/net/REPORT.md "Rooms on public servers"), the
  ones that also answer each REQ with an EOSE. A relay that behaves strangely is dropped, there are plenty
  (nostr.chaima.info, relay.grigic.org and nostr.red5d.dev, first chosen, never answer a `limit: 0` REQ, and members
  reconnected to them every few seconds; nos.lol and relay.damus.io carry no room). DERP is tailcat's public
  relays: a room uses them as tailcat's and a tailnet's browser clients do, and goes direct where it can, which
  Tailscale's browser clients can't, so it leans on them less (tailcat's README sets no terms for them). They're
  rate-limited, best-effort and revocable ([tailnet.md](tailnet.md) "tailcat"); a serious room runs its own Nostr
  relay and derper and puts them in its link.
- **Not Trystero as a library** (checked at 0.26.0, 2026-11-10): it offers to every peer that announces in a room (a
  full mesh; its README says to split users into groups), its data channel is ordered and reliable and can't be
  configured, its peer IDs and Nostr keys are random per page load (no lookup by key), and its fallback is TURN. Its
  Nostr pattern is what rooms take: ephemeral events, the topic in an `x` tag, several relays, a maintained relay list.
- **Dependencies:** `k256` (RustCrypto, MIT/Apache-2.0; the user, 2026-10-18) for BIP-340 on secp256k1. The Nostr
  signing key is random per session, never derived from the node key, so a relay can't link a node's sessions by
  author. Everything else was in `net/ts` already (`ts_tunnel`, BLAKE2s, ChaCha20-Poly1305, NaCl boxes). The key
  miner's dev-dependencies `curve25519-dalek` and `regex` (the user's ask, 2026-11-12).

## The room and its names

- **A room's link** (`room::Link`): `waarm64-room:<id>?nostr=<wss URL>&…&derp=<region>&…`, each part percent-encoded; a
  `derp` is a region ID of the DERP map (0: its first) or a derper inline (`host[:port]`). Anything without the scheme
  is a bare ID, with the defaults: six public Nostr relays (`DEFAULT_NOSTR`: relay.primal.net and five of Trystero's
  list, those that carried every case R4 measured, bench/net/REPORT.md "Rooms on public servers"), and every region of the DERP map with DERP nodes a browser can reach and an ID from 1 to 0x7FFF, lowest ID first (at most 8; taken
  once the map loads). At
  most 8 relays and 8 regions, an ID of at most 256 bytes. The `self` event carries the link the client read, without
  the parts that were the defaults (`Link::encode`), so a link copied from the menu follows the defaults as they change.
- **The global public room** is the link `waarm64-room:global`: a bare ID, so the defaults, as they change.
- **An ID is matched by its bytes**, as the page writes it: trimmed and in Unicode's NFC (web/room.ts `roomLink`, for
  a typed name, a pasted link and a private room's alike), so a name typed with a composed "é" and one with "e" and a
  combining accent are one room. Case still counts ("Café" and "café" are two rooms), as in the name shown.
- **What the ID derives:** BLAKE2s with labels of their own gives the room's /48 (`fd` and 40 bits; one that would be
  tailcat's `fd7a:115c:a1e0::/48` takes the next label), its tag (those 40 bits in base32), the tag salt and lookup key
  of its lookups, and the WireGuard pre-shared key every pair in the room uses (`room::Room`). A node's address is the
  /48 plus the first 80 bits of its node key, as tailcat's; its name is `<key in base32, 52 characters>.<tag>.p2p.internal`.
  So a key can be mined for an address: `cargo run --release -p waarm64_ts --example room-key-mine -- <link> --prefix
  HEX | --suffix HEX | --regex RE` (all given must hold) prints keys whose address has those digits after the room's /48
  at its start or end (compared as bits, no text), or matches the expression on the address written out whole (8 groups
  of 4; `--compressed`: as the page writes it, where `::` moves with the zeros), with the address and the name, and the
  average time to a match (16 to the digits fixed, times the expression's odds from a sample of random addresses). Each
  thread draws one random clamped scalar and steps it by 8 (clamping clears the low three bits) as a point addition of
  8·B, converting 512 points to Montgomery form with one inversion (`EdwardsPoint::to_montgomery_batch`); a match is
  derived again by X25519 before it's printed. 26–34 M keys a second on the dev VM's 8 vCPUs (2026-11-12): 6 digits in
  under a second, 7 in ~10 s, 8 in ~3 minutes, 9 in ~45 minutes. The wizard takes the key as [A key to paste](ui:network:NetRoomStep.room.key.paste)
  ([frontend.md](../frontend.md) "Network"), for a member others type the address of (a directory service). Its tests (`cargo test`)
  check the stepping against X25519 key by key, the address and name against what the module said for a key in a
  room, and that a mined key matches; `tests/net/room-keys.ts` is the derivation for the page's tests.
- **The event kind:** every room's lookups share one ephemeral kind, `room::KIND` = 26354, so relays can't group
  lookups by room and no room's ID lands on a kind relays treat specially; clear of every kind the NIPs listed
  (2026-11-10, their ephemeral ones 21059, 22242, 23194, 23195, 24133, 24242, 27235, 28934–28936). No ephemeral kind
  is clear of Trystero's, which hashes each topic onto one of 20000–29999 (`strToNum(topic, 1e4) + 2e4`, 0.26.0);
  sharing one is harmless, as a relay forwards by the `#x` filter too.

## Finding a peer

- **Tags and lookups** (`room/lookup.rs`, `nostr.rs`): a node's tag in an hour is BLAKE2s of the tag salt, its address
  and the Unix hour (16 bytes, hex); it keeps one subscription on each of the link's Nostr relays (`REQ`, the kind
  `room::KIND` = 26354, and its tags of the previous, current and next hour; after the hour turns, the next renewal is a
  `CLOSE` and a new `REQ` with the new hour's tags, not at the turn itself, so a room's members don't all renew in the
  same second), so a dialer's clock may be off by most of an hour. When the guest sends to a room address nobody
  has, the packet waits (16 at most) and a **lookup** goes out as an ephemeral event under the target's tag of the
  dialer's hour, signed with BIP-340 (`k256`) by a key random per session, on every relay: the dialer's node key, its
  home region (`INLINE_REGION`: a map region by its ID, one of the link's own derpers as `0x8000` plus its index, so
  members whose maps differ, one loaded before a region went or came, name the same region; a member that hasn't it
  drops the lookup; one whose link names the region twice takes the entry that's home or connected; the same in
  `hello`. Since 2026-11-11: a page from before, which sent an index, and one after don't reach each other in a room,
  nothing versioning the field; accepted while rooms are pre-release), the time and a random nonce, sealed with ChaCha20-Poly1305 to the
  target's own key when the dialer knows it (an X25519 box from an ephemeral key; a name the resolver answered, or
  `known` keys) and with the room's lookup key otherwise; both mix in the lookup key, the tag is the associated
  data, and both look alike (122 bytes: 32 of an ephemeral key or of random bytes, then the ciphertext, then a 16-byte
  MAC over the tag and those bytes under a key of the room's, `lookup::authentic`; the target checks the MAC, then
  tries the seal first). Again after 1 s and 3 s; at 6 s the waiting packets get ICMPv6 address unreachable (type 1, code 3, from the
  room's `::53`), as does anything to that address for 5 s more. At most 64 lookups wait at once (past that, the
  guest's packet gets the ICMPv6 at once) and 8 go out a second (more wait for room, first sends before resends; a send
  counts only once it went out, and the 6 s run from a lookup's first), so a guest sweeping the /48 can't grow the
  worker or flood the relays, and one dialing 30 members at once reaches them all. The Nostr relays are plain WebSockets in text mode (`WsOpen` with an
  empty protocol; `web/ts-client.ts` opens it without one, carries the module's bytes as UTF-8 and holds at most 256
  messages before it opens). The subscription is renewed every 60 s and must be answered (EOSE) within 15 s, or the
  connection is presumed dead (half open after a network change, say); a relay's CLOSED of it is subscribed again
  after 10 s; a lost connection comes back after 2 s doubling to 60 s, reset by an answered REQ. The hour is the
  wall clock's, read each time (`Date.now()` through WASI, `web/ts-wasi.ts`: `performance.now()` stands still while
  some computers sleep).
- **The call back:** a target that opens a lookup joins the dialer's home region and starts the WireGuard handshake
  through it, its signalling `hello` queued behind the handshake (so the first data is acknowledged and resent: the
  dialer, the responder, can't send until something comes, and a lone keepalive lost would leave it unable to). It
  drops lookups more than an hour off its clock, a nonce it has seen (remembered for three hours, 8,192 at most, the
  oldest let go first; a reloaded target forgets them, so a relay may replay a recent lookup to it, which costs one
  unwanted call back that the dialer refuses unless it takes incoming connections), a region outside the link, its
  own key, and 1,024 peers at most. An event's copies (the same tag and content, one through each relay) are opened
  once: one remembered for 10 s (8,192 at most) is dropped before anything else. Anyone who sees a lookup to the node
  (a subscription to the kind with no tag filter gets every room's) can publish junk under its tag for the rest of that
  hour, so an event's MAC is checked first (one BLAKE2s): an outsider's junk is dropped there and costs nothing more.
  Events whose MAC holds (a member's) are opened (an X25519 and up to two decryptions) at most 128 a second through
  each relay, the rest dropped unread, so a member's junk through some of the link's relays doesn't keep out a lookup
  through the others (a member flooding every relay of the link still can: in a public room anyone,
  [plans/networking-p2p.md](../plans/networking-p2p.md) "Spam"). Call backs are 16 a second; past that they wait their turn (first come first
  served, a key's later lookup only updating its region; 64 at most, so served within 4 s, before the dialer gives
  up; more are dropped), so a crowd of dialers gets in at that rate. When each dials the other at once, only the lower
  key calls back (crossed handshakes each abandon their own for the other's in `ts_tunnel`, and neither completes). A
  lookup from a key whose call back is still on trial sends its initiation again through that lookup's region (at most
  every 0.5 s): a lost one goes again with the dialer's resend, and a forged lookup naming a region the key isn't on
  can't keep the real one out. A lookup from a key with a confirmed peer doesn't move that peer (a member could
  forge one): it probes the session with a signalling `ping`, and only if nothing decrypts in 4 s (that key's page
  reloaded, say) forgets it and calls back. The dialer lets in the handshake of a key whose address its lookup waits
  on, and the waiting packets go into that peer's session as soon as it exists, however it came (a call back, its
  handshake); the lookup goes on until the session is confirmed, so a peer a forged lookup made doesn't stand in for
  our own. A lookup is a hint; the handshake with the room's key decides.

## The tunnel and the guest's side

- **WireGuard** (`ts_tunnel`, IKpsk2 with the room's key) carries the guest's IPv6 between members, whichever path
  carries its packets. A peer's packets reach the guest only from that peer's own address to ours. A key we don't
  know that starts a handshake is let in **on trial** (incoming connections, on by default) and forgotten 20 s after it
  came in unless its data decrypted, which only the room's key allows; 16 such a second, a budget apart from call
  backs', charged only once WireGuard answered the handshake (its MAC1 right), so junk that isn't a handshake can't use
  it up. **Every handshake initiation carries the room's proof** (`Room::prove`): in IKpsk2 the pre-shared key enters
  only at the response, so an initiation alone needs nothing but the responder's public key, which its name carries;
  the sender writes a MAC under a key of the room's over the initiation into its `mac2` (the cookie's field, which
  WireGuard leaves zero without a cookie, and ts_tunnel 0.6.1 refuses non-zero: it never asks for cookies), and the
  receiver checks it before anything else and clears it for WireGuard (`proven`, on both paths, a known peer's too).
  So an outsider with a node's name gets nothing answered and takes no trial's place; a member can still send 16
  initiations a second from fresh keys, each let in on trial for 20 s (up to 320 at once), and the node refuses other
  members' unasked handshakes meanwhile (call backs keep their own budget; in a public room a member is anyone:
  [plans/networking-p2p.md](../plans/networking-p2p.md) "Spam"). DERP proves a packet's sender, so a peer's packets go back through the region its last one came
  from (our response to its new initiation too). A peer is forgotten after 3 minutes without the
  guests' traffic, or 30 s after we sent it the guest's packets with nothing back (the next packet looks it up again;
  past two of WireGuard's passive keepalives, each 9 to 11 s after the data it answers, so a guest's one-way traffic
  doesn't lose its peer to one lost keepalive).
- **Incoming off** (`incoming: false`): lookups go unanswered and handshakes from unknown keys are refused, unless the
  guest has a flow with that address; a flow table (the peer's address, the protocol, both ports or an echo's
  identifier; 5 minutes idle, 4,096 at most) lets in only replies to the guest's own flows (and ICMPv6 errors from a
  peer it has one with).
- **The resolver** at the room's `<prefix>::53` (the lease's `dns6`, with the room's `<tag>.p2p.internal` as its domain):
  `<key>.<tag>.p2p.internal` AAAA is the address computed from the key, which the module remembers to seal lookups to it;
  A for such a name is an empty answer, anything else NXDOMAIN. The suffix is `.internal` (which ICANN reserved in 2024 for private use and will never
  delegate), not RFC 9476's `.alt` ("Findings"). The lease: the room address as a /128, IPv4
  `192.0.0.2` with no IPv4 routes, and the /48 as the route on an adapter that isn't the guest's primary (`prefix6`,
  web/room-worker.ts).

## The direct path

- **Signalling inside the tunnel:** UDP between the two members' addresses, port 1 both ends (`SIGNAL_PORT`; the
  guest's packets to or from it are dropped), JSON: `hello` (the home region, relay only, `b`: the browser makes no
  direct paths now; sent again whenever that changes, and one older than the last taken is ignored), `sig` (the page's
  description or ICE candidate for attempt `o`, opaque to the module), `bye` (attempt `o` closed, or refused by an
  answerer with too many), `refuse` (relay only), `ping` (the probe above). Each message carries the sender's
  epoch with us (random per peer it makes, so a restart, or a peer forgotten and made again on one side, resets what
  the other knew of its sequence numbers and attempts) and a sequence number, and is acknowledged and resent after 0.5, 1 and 2 s. Candidates go only to a member whose data decrypted.
- **The direct path:** the member with the lower key offers once the session is confirmed and the guests exchanged a
  packet through it (so a session that a member's forged lookup made between two others carries no offer, and neither
  learns the other's IP address unless a guest asked). The module asks the host
  for a connection (`RtcOpen`, actions 7–10 and `ts_rtc_*` in `wasm.rs`); web/room.ts makes an `RTCPeerConnection`
  (STUN only: `STUN_SERVERS`, Cloudflare's and Google's) with a negotiated data channel (id 0, unordered, no
  retransmits) and transfers the channel to the worker before anything is sent on it (Chromium has no
  `RTCPeerConnection` in a worker, but transfers a channel), so packets never touch the page's thread. Once it
  opens, the peer's WireGuard packets take it, one message each, except handshake messages, which always go
  through DERP (rare, and a peer that restarted has no channel to take ours). An attempt not open in 10 s is closed
  and the next waits 30 s, doubling to 5 min; a closed channel, or one we sent on with nothing back for 25 s (past
  two of WireGuard's passive keepalives, so one lost on the unreliable channel doesn't count), sends the peer back to DERP, and a new offer comes after 30 s. At most 64
  connections (`MAX_RTC`): past that the offerer waits for the guests' next packet, and an answerer refuses with a
  `bye`; a channel without the guests' traffic for 60 s (`RTC_IDLE`) is closed, and the offerer offers again at the
  next packet either way (a `bye` for an open channel isn't a failure: no backoff); a full channel drops the packet:
  one holding more than 64 KiB unsent (`bufferedAmount`; `RTC_BUFFER`, `rtcSend` in `web/ts-client.ts`), so the loss is
  at the path's rate and not seconds of queue in front of every flow and keepalive (Chromium queues megabytes before
  `send` throws, which drops it too). A peer's new connection comes at most every 2 s (`RTC_GAP`: an
  answerer ignores a newer attempt sooner, so a member's signalling can't make the page set up connections as fast as
  it sends; an offerer, after a restart's epoch, waits), and our own offers, all peers', at most 4 a second. Relay only
  (`relayOnly`) never opens a connection and refuses offers. The `path` event says which path a peer's packets take;
  `no-direct` why a peer has none (`failed`: an attempt failed, `blocked`: its browser makes none, `relay-only`; `none`
  when one may be made again);
  `peer` says a session is confirmed, and `peer-gone` that such a peer was forgotten, after the `path` of its channel's
  close (the page's list of members reached follows them).
- **A browser without direct paths:** a browser that uses no UDP for WebRTC gathers no candidate at all, not even a
  host one, and can only take the relay. Chromium does this with the WebRTC IP handling policy
  `disable_non_proxied_udp`: ungoogled-chromium's default (its `#webrtc-ip-handling-policy` flag), or the profile's
  `webrtc.ip_handling_policy` (which an extension can set); its log says "UDP ports disabled". The answerer then
  answers but trickles no candidate, the offer times out, and the backoff repeats (found 2026-11-11 between two of the
  user's machines; first taken for mDNS between two windows of one desktop, which worked only because the other side's
  candidates were enough there). web/room.ts watches each connection's gathering: completed without a candidate, it
  emits `direct` `blocked` (the network map's `room.directBlocked`) and tells the module (`ts_rtc_blocked`), which
  closes what it has, makes and answers no connection, and sends each confirmed peer a new `hello` with `b`, so the
  peers stop offering too (an older peer that doesn't know `b` keeps offering; its offers go unanswered). **Not for
  good:** the policy can change live (an extension sets `webrtc.ip_handling_policy`), and a browser with no network
  gathers nothing either, so while blocked the page probes: a connection of its own, with no peer and nothing sent,
  gathers every 30 s (`PROBE_EVERY`), and at once on `online` and on the Network Information API's `change`. The
  first that gathers a candidate unblocks: a `hello` without `b` goes to every peer, and both sides offer again at
  once with no backoff behind them (`direct_changed`). A probe costs nothing on the wire while blocked (nothing is
  gathered, so nothing is sent).
- **Why the menu says nothing is direct:** the Network menu puts a small warning after a room's count of connections
  when members go through the relay where a direct path was wanted (never for relay only, which chose it); it opens
  the adapter's details ([Why some members aren't reached directly](ui:network:NetAdapter.room.warn)), which say why
  and what may fix it (NetDetails.svelte): this browser blocks (the flag to change in ungoogled-chromium), members' browsers do (`no-direct` `blocked`, `room.peersBlocked`), or attempts failed though this browser gathers
  (`no-direct` `failed`, `room.directFailed`: a firewall that drops UDP, a router that doesn't hairpin, a network that
  isolates its clients, mDNS dropped between two machines of one LAN). Which of those it is between two browsers that
  both gather can't be told apart from here.
  `tests/room-browser.test.ts` seeds the preference in a profile (upstream has no switch for it), and turns gathering
  off and on live in one (`iceTransportPolicy: 'relay'` with no TURN server: no candidate, as with no UDP).

## DERP

- **Regions:** one connection per region in use (`Relay`): the home region (`home`, an index into the link's; the
  `preferred` one) always, another while a peer is reached through it (the dialer's home region a call back joined;
  where a peer's data last came from) and for 60 s after; packets for a region wait (64 at most) until its connection
  is up. Each has tailcat's liveness and reconnects; before `Running`, a home region that keeps failing hands over to
  the best usable one not yet tried (`best_untried`: one that may be home first, then by its probe, answered, still
  out, not probed, failed, then the link's order; a usable configured home is kept and fails the client), and the
  client fails only when none is left. A DERP map that doesn't load, or lacks a region, fails the client only when no
  region is usable: a configured home is a preference, and an unusable one (not on the map, or past the link's
  regions) is chosen past as if there were none.
  A peer that left a region (`PeerGone`) is sent to its home region, if its `hello` said one. **The home region** is
  chosen before the first connection, after the map when the link has map regions and no configured home (so they're
  candidates): the configured one (`Config.home`, the page's `home`) if it's usable; else, with several usable
  candidates (not regions the map marks `Avoid` or `NoMeasureNoHome`, unless only those are usable), a probe to each
  at once (a `derp` WebSocket, which counts once its first frame is a DERP server's key, `derp::is_server_key`), the
  first to answer being home (the nearest), the others closed; none in 3 s (`PROBE_WAIT`), or every probe closed, the
  best by the same ranking (a probe still out before one that failed), the log saying which. `close` ends the probes too. In
  the module, not the page's `/derp/probe` fetches as tailcat's client picks by (`nearestRegion`, web/tailcat.ts), so a
  link's own derpers are probed too and nothing new crosses the ABI. Lookups and incoming lookups wait for `Running`,
  so none names a region before the choice. A failed client closes
  its DERP and Nostr connections and keeps nothing scheduled (no reconnects while the page shows the error).

## What a room needs from a Nostr relay

NIP-01 over a plain WebSocket, with no NIP-42 AUTH and no NIP-13 proof of work (a relay that requires either carries
no room); ephemeral kind 26354 accepted and forwarded; filters by a single-letter tag (`#x`, three values) with
`limit: 0`, each REQ answered with an EOSE (a renewal under the same ID too: 15 s without one and the member takes the
connection for dead and reconnects); `created_at` within the relay's tolerance of the dialer's clock (some public
relays refuse events dated ahead, so a clock off by most of an hour may hold only on a room's own relays). A member
holds one connection and one subscription a relay, renewed every minute (one REQ; after the hour's turn, a CLOSE and
a REQ under a new subscription ID); a lookup is one event of ~570 bytes on the wire, forwarded to one subscriber (a
tag is one node's), again after 1 s and 3 s only while no call back comes, at most 8 lookups a second a member. A
thousand members: 17 REQs a second steady, 2.8 KB/s in; each new pair a second, one event (bench/net/REPORT.md "Rooms
at scale"). The relays' own terms (rate limits, proof of work, payment) decide how far public relays carry a room.

## Numbers

From bench/net/REPORT.md. **The direct path against DERP** (`bench/net/room.ts`, two members in two pages through the
module, 1,280-byte echoes 32 in flight, 5 alternated rounds): in the dev VM (2026-11-10) **183 Mbit/s each way**
direct against DERP's 126 on loopback, at 32% less CPU per Mbit; in a cloud session 50.9 against 35.1, a bare channel
between two workers 70.6. The first echo 23 ms after `Running` (through DERP), the channel open 23 ms after the
handshake. A bare negotiated channel (Chromium 141, loopback): set up in 92 ms; 1,280-byte messages 142 Mbit/s from
the main thread, 173 from a worker it was transferred to (0.7% lost at saturation, as unreliable channels drop).
**Scale** (`bench/net/room-scale.ts`, a thousand members in worker processes, relay only, on the tests' relay, which
counts what it carries at `GET /stats`; `unixTime` in a room's config shifts the clock): joining, idling and lookups
at 10 and 50 new pairs a second don't move with the room's size; a member costs ~1.4 MiB and no measurable CPU idle;
a lookup to its echo ~5 ms on loopback. **Public servers** (`bench/net/room-public.ts`, 2026-11-11): 21 of Trystero's
29 Nostr relays carry a room; tailcat's four regions measured. Loopback hides how often ICE fails across real NATs:
the user's two machines on one network went direct once the browser allowed it ("A browser without direct paths").

## Tests

`cargo test -p waarm64_ts room` and `nostr` (the client against fake DERP regions, which route a packet only
to a key on the same region, fake Nostr relays and a fake WebRTC: lookups, names, sealing, stale, replayed, forged
and misdirected lookups, the trial rate, incoming off and its flows, two regions, the hour's turn and a clock 40
minutes off, a forged lookup that doesn't move a live peer and one that names another region, outsiders' initiations without the
room's proof and their junk lookups (neither charged to a budget), a reloaded peer
called back, a peer made again on one side, both dialing at once, a lost call back, junk handshakes, a lookup's
copies through six relays and junk through one, a guest sweeping the /48, a relay's CLOSED and silence, a failed map with an inline home, the channel cap and the idle close, the R0
cases; BIP-340's first vector); `tests/nostr-relay.test.ts` (the tests' relay, `tests/net/nostr-relay.ts`:
NIP-01's EVENT, REQ, CLOSE, kind and `#x` filters, forwarding without storing, ids checked, signatures not, a small
RFC 6455 server, no dependency; a message past 1 MiB closes the connection, `events` keeps the last 65,536); `tests/room-browser.test.ts` (Chromium, `WAARM64_TAILCAT=1`: pages joining one room
by its link on the rig's derper and that relay, by address and by name, relay only, incoming off); `tests/room-link.test.ts` (the page's link and
key checks against link.rs's); `tests/connections.test.ts`'s (another tab's ephemeral connection on a stored one's key) and `tests/network.test.ts`'s room cases;
`tests/net-live.test.ts` (the key's lock); `tests/page-connections.test.ts` (the global room in the wizard); and, in
`scripts/ci-net.sh`, `tests/page-room.test.ts` (two Debian guests in one Chromium: Create, Join by link, the wizard's
refusals, the resolver asked directly and through resolved, pings both ways by name; ~2 min) and
`tests/net-local.test.ts`'s second case (a room on a second adapter beside the local helper keeping the internet).
The key miner's own tests run under `cargo test`. Ad hoc: `bench/results/local/room-probe.ts` joins any link and
logs every candidate (`KEY=` picks the role).

## Findings (don't re-discover)

- **systemd-resolved refuses `.alt`.** The names were first under RFC 9476's `.alt`; systemd-resolved (Debian 13's,
  2026-11-10) answers any `.alt` name NXDOMAIN itself, whatever the link's DNS server and routing domain, so a guest
  with resolved, as Debian's and Arch's are, never asks the room's resolver (which answered the same query sent to it
  directly; tests/page-room.test.ts found it). It's in resolved's source since v255: `dns_scope_good_domain()` refuses a
  name `dns_name_dont_resolve()` matches (`*.alt`, with `*.invalid` and a few RFC 6303 reverse zones) before it looks
  at any link's servers or routing domains, so nothing in a lease (DHCPv6's domain list, the RA's DNSSL) can route it.
  Other unofficial TLDs (a home LAN's `.lan`) aren't on that list.
- **A browser with no UDP for WebRTC looks like ICE failing.** The user's first tries (2026-11-11, ungoogled-chromium)
  never went direct, first taken for mDNS between two windows of one desktop; it was the WebRTC IP handling policy
  ("A browser without direct paths"). Trystero's demo got through only on Cloudflare's TURN over TCP. With the flag at
  Default, the user's two machines went direct.
- **The nearest DERP region by probe, not the map's first.** Rooms first took the map's first region (New York): 200 ms
  pings between two machines in Europe. A link without regions now takes all of the map's and probes them ("DERP").
  A region's wire meaning changed then from an index to a map ID, so pages from before 2026-11-11 and after don't
  reach each other in a room (accepted while rooms were pre-release).
- **Lookups and initiations changed form on 2026-11-14** (the lookup's MAC, the initiation's proof): pages from before
  and after don't reach each other in a room (accepted: rooms had only testers then). Both close what an outsider with
  a node's name could do; nothing a member can do changed.
- **SDP's size doesn't constrain signalling over DERP**, but for the record (Chromium 153, 2026-11-10): with both
  pages ours, a data-channel-only remote description rebuilds from 47 bytes per side (the ufrag, 3; the password, 18;
  a SHA-1 fingerprint, 20, which Chromium checks against the remote certificate like SHA-256; a public IPv4
  candidate, 6), plus 19 for a LAN `.local` candidate. Chromium draws fresh ICE credentials per connection (168 bits)
  and is withdrawing the munging that would fix them, so no setup fits in fewer.
- **Where WebRTC runs:** Chromium has no `RTCPeerConnection` in workers, but a data channel can be transferred to one,
  only at creation, before any `send` (both checked in Chromium 141); so the page's thread holds the connections and
  the SDP, and packets never touch it. Firefox and Safari are unchecked.
