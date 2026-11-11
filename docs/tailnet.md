# The tailnet client: tailcat and Tailscale

The page's network backends behind the Ethernet gateway ([devices.md](devices.md) "net": frames at
the device, IP packets on the gateway's port) are one client of our own: `net/ts` (crate `webpc_ts`),
a small Rust wasm module that holds the protocols' state, driven by a TypeScript worker that does the
I/O. It speaks two protocols, and holds a room's member beside them ("Rooms"):

- **tailcat** ([tailscale/tailcat](https://github.com/tailscale/tailcat)): Tailscale's data plane with
  no control plane. The guest goes online through a `tailcat serve exit-node` on a computer of the
  user's, and the VM can be a tailcat server itself (`tailcat ssh tc…` reaches the guest's sshd).
- **Tailscale**: a node on a tailnet (Tailscale's control server or a Headscale), with peers, the
  packet filter, exit nodes and MagicDNS.

What the user sees (the Network wizard and menu, the settings, the lease) is
[frontend.md](frontend.md) "Network". Why our own client and not Tailscale's Go one built to wasm (the
page's until 2026-10-17): the Go module was 26.9 MB of wasm (4.3 MB Brotli), a Go runtime and heap of
20 to 26 MB in its worker, and WireGuard in pure Go on one thread; this one is about 0.6 MB Brotli (576 KB on 2026-11-10, rooms' lookups and `k256` 42 KB of it) and
2 MB of memory with twice the throughput ("Numbers"). The decisions that led here (frames at the
device, the gateway, the guest as the node) are [plans/networking.md](plans/networking.md)'s.

**The files.** `net/ts/src/`: `wasm.rs` (the exports), `client.rs` (the tailcat client, and the
actions the clients share), `tailcat.rs` (the address), `room.rs` (a room's member; `room/link.rs`, `room/lookup.rs`, `nostr.rs`), `cbor.rs`, `nat46.rs`, `derp.rs`, `ip.rs`
(packet builders), `tailnet.rs` (the Tailscale client's data plane), `control.rs` (the control
session), `noise.rs`, `h2pipe.rs`, `netmap.rs`, `store.rs` (the kept node), `dns.rs`, `dns_tcp.rs` (MagicDNS over TCP). The page's
side: `web/ts-client.ts` (the module's I/O: WebSockets, `fetch`, timers), `web/ts-wasi.ts`,
`web/tailcat.ts` and `web/tailcat-worker.ts`, `web/tailscale.ts` and `web/tailnet-worker.ts`,
`web/tailscale-state.ts` (the kept node in IndexedDB), `web/room.ts` and `web/room-worker.ts`. Built by `net/ts/build.sh` to
`target/net/ts.wasm`; `npm start` and `npm run serve` build it when it's missing or stale
(`tools/tailscale.ts`, frontend.md "Network").

## The module

- **Sans I/O.** The module never opens a socket or waits: the worker feeds it WebSocket messages,
  guest packets, `fetch` results and timer firings, and carries out the actions it returns. So the
  tests drive it natively (`cargo test -p webpc_ts`) or in Node with no network.
- **The ABI** (`net/ts/src/wasm.rs` documents it). `ts_new(config JSON) → handle` makes a tailcat
  client (`addr`, `serve`) or, with `control`, a Tailscale one on the kept node `state`. Inputs:
  `ts_ws_message`, `ts_ws_closed`, `ts_fetched`, `ts_guest` (a packet from the guest), `ts_tick`;
  `ts_deadline` says when to tick next; `ts_poll` returns actions until none is left, read from
  `ts_buf()`: open, send on or close a WebSocket, `fetch` a URL, a packet for the guest, a JSON
  event (`state`, `lease`, `self`, `serving`, `client`, `netmap`, `login`, `store`, `exitnode`,
  `loggedout`, `log`); a `Failed` state and a refused `exitnode` say why as a stable `code` the page words
  (`web/ts-client.ts` `failureOf`, docs/i18n.md), with any technical `detail` beside it. Also `ts_exit_node`, `ts_accept_routes`, `ts_logout`, `ts_private_key`, `ts_close`, `ts_free`.
  Bytes cross through the module's memory (`ts_alloc`), one copy each way. One thread, no shared
  memory, no atomics: one worker per client.
- **`wasm32-wasip1`, not the core's target.** On `wasm32-unknown-unknown` std's `Instant::now()` and
  `SystemTime::now()` panic and `getrandom` has no backend, and `ts_tunnel` (TAI64N timestamps) and
  `ts_time` read the clock. Under WASI std works through six imports the worker provides
  (`web/ts-wasi.ts`: `clock_time_get`, `random_get`, an empty environment, stderr, `proc_exit`): no
  patch to tailscale-rs, no wasm-bindgen. The module reads the clock itself, so the ABI has no `now`;
  natively the tests pass their own `Instant`s. Our pinned nightly, no `simd128`, `opt-level=3`
  (~17% faster than `s` for 16 KB more Brotli), stripped.
- **tailscale-rs's crates as dependencies, not a fork** (crates.io, pinned by `Cargo.lock`,
  THIRD_PARTY.json). **Import, don't rewrite** (the user, 2026-10-16): where a crate does the job it's
  used as it is, even at some size: `ts_tunnel` (WireGuard, audited in v0.6.0), `ts_noise`,
  `ts_keys`, `ts_packet`, `ts_control_serde` (the control protocol's types; +144 KB Brotli, most of it
  `url`'s IDNA tables), `h2` (+~100 KB Brotli), `ts_packetfilter`, `ts_disco_protocol`,
  `ed25519-dalek` (the network-lock key), the RustCrypto crates. Ours is only what can't run in a
  browser: tailscale-rs's `ts_control`, `ts_derp`'s client, `ts_runtime` and `ts_control_noise`'s
  framing need sockets or tokio's runtime (which doesn't build for wasm), so their few hundred lines
  of protocol logic are ours, over the worker's transports.
- **Not TypeScript alone:** WebCrypto has X25519 but not ChaCha20-Poly1305, BLAKE2s or
  XSalsa20-Poly1305 (DERP's client info and disco use NaCl boxes), and every call is a promise: a
  promise per packet. Those primitives in TypeScript would be slower than scalar wasm and unaudited.

## Transports and DERP

A browser has no UDP, so the client is **DERP-only** (no direct paths, no endpoints of its own), over
WebSockets:

- **DERP** is `wss://<derp>/derp` with subprotocol `derp`, the same frames as over TCP (`derp.rs`: the
  server's key, our client info sealed to it with a NaCl box, the server's info, then send/recv
  packet, keep-alive, ping/pong, peer-gone, health, restarting). One
  connection per region in use: the home region, and each peer's home region when we send to it,
  closed after 60 s unused.
- **Liveness** (`derp.rs`): a browser's WebSocket can stay open for minutes on a path that died (a
  laptop that slept, a network that changed, a NAT that forgot the flow; the server's keep-alives come
  every 60 s), so each connection pings its server after 25 s with nothing heard (which also keeps
  idle-closing proxies away), or after 2 s of sending with nothing back, and is dropped when 6 s pass
  with nothing at all from the server; a connection whose handshake isn't done 10 s after it was
  asked for is dropped too. A dropped connection that was up comes back at once (one up for under
  10 s counts as failing: a growing backoff, 0.5 s to 30 s), with what it had queued. The home relay
  dropped by its liveness check also has the control connection reconnect, unless it brought
  something in the last 15 s. Measured against the tailcat rig: traffic back ~8.3 s after the path
  died (tests/ts-tailcat.test.ts); before, never (the socket stayed open).
- **Frames are joined** into messages of up to 4 KiB (`queue_frames`): the server reads the WebSocket
  as a byte stream (frames may straddle messages, as its own 4 KB writes do), so what was queued
  before the host takes the actions (an IP-port batch: `ts_guest` per packet, then one pump) leaves
  together, about three packets. **Not larger:** a relay queues 32 packets per destination and drops
  the oldest, so 64 KiB messages (a TSO packet's ~48 segments at once) dropped an upload through
  tailcat from 86 to under 1 Mbit/s ([bench/net/REPORT.md](../bench/net/REPORT.md) "Batches").
- **Control** is `wss://<control>/ts2021` with subprotocol `tailscale-control-protocol` and the Noise
  initiation in the `X-Tailscale-Handshake` query parameter (a browser can't set headers), as
  Tailscale's own js/wasm client does. Inside the Noise channel, HTTP/2.
- **`fetch`** for the rest: the control server's key (`/key`, which needs CORS headers: frontend.md
  "Network"), DERP maps, `/derp/probe` timings (derpers send CORS headers, as tailcat's map does) and
  DNS over HTTPS.

## tailcat

**The protocol** (tailcat v0.7.0; `wire.go` and `disco.go` are the whole of it):

- **The address** is `"tc"` + base64url(CBOR, our own small decoder): the server's node public key
  (`p`), its disco key (`k`), a WireGuard pre-shared key (`q`: so the address is a secret, a bearer
  capability), and either a region ID of the public DERP map (`i`, `https://tailcat.dev/derpmap.json`,
  CORS-enabled) or the region inline (`r`: host names, IPs, ports; one's own derper).
- **The handshake:** the client joins the server's DERP region with an ephemeral node key and sends a
  raw DERP packet `"meow" 0x01 <node pub 32> <disco pub 32>`; the server adds it as a peer and answers
  `"meow" 0x02` (retried every second until a timeout); then WireGuard (IKpsk2 with the address's PSK)
  through DERP.
- **Addresses:** IPv6 only inside the tunnel: each side is `fd7a:115c:a1e0::/48` plus the first 80 bits
  of its node key, and the server accepts only a client's own address as source. IPv4 destinations
  travel as NAT64 (`64:ff9b::/96`). Tunnel MTU 1280.
- **`serve exit-node`** isn't IP forwarding: it terminates TCP and UDP flows in its gVisor netstack and
  proxies each to its destination, private addresses included (unlike Tailscale's exit nodes), its
  own address meaning its `localhost`. No ICMP beyond it. **Pre-1.0**: no API, CLI or wire-format
  promises; the tests pin the version (`tests/net/tailcat.sh`), re-checked on bumps.
- **The public relays** are rate-limited, best-effort and revocable; the page recommends one's own
  derper (`tailcat genkey --region=<host>`).

**Going online through a server** (`client.rs`). The connection's node key (`Config.key`, its kept identity's: so a
server can `--allow` it; a fresh one per connect only when none is given). Each new relay
connection meows again (the server may have forgotten us), and so does the server's `PeerGone`
(it left the relay: a restart forgets its clients), every second until it answers; after a
`PeerGone` the answer also starts a new WireGuard session, since the server lost ours. The guest's lease: IPv6
the tunnel address as a /128 (DHCPv6 and the router advertisement), IPv4 `192.0.0.2` (RFC 7335's
address for a host translator's IPv4 side; nothing outside sees it), resolvers 1.1.1.1 and
2606:4700:4700::1111 reached through the exit node (no MagicDNS). The IPv6 default route and resolver only while the
server's machine reaches the internet over IPv6 (web/reach6.ts, probed by the worker: docs/network-adapters.md §4
"IPv6 out"); otherwise the guest uses IPv4, with routes to the tailcat clients it lets in only. **NAT46 in the module** (`nat46.rs`,
stateless RFC 7915 for TCP, UDP and ICMP echo), so the gateway stays the same for both protocols: IPv4
from the guest becomes IPv6 from the tunnel address to `64:ff9b::<v4>`, and back. Translated IPv4 must
fit 1260 bytes, but the link stays at 1280 (under 1280 Linux turns IPv6 off on the interface), so the
translator clamps TCP's MSS in SYNs to 1220 and answers DF-set IPv4 over 1260 with "fragmentation
needed" from 192.0.0.1; fragments, DF-clear oversized packets and other ICMP types are dropped. IPv6
goes as is.

**The VM as a server** (`Config.serve`). The kept identity (node key and pre-shared key, IndexedDB
`webpc-tailcat`) makes a kept address: the disco key is derived from the node key (BLAKE2s).
`tailcat::encode_addr` writes the address: inline nodes for one's own relay, the short region form for
the public map, whose nearest region the page picks by `/derp/probe` timings. A meowing key becomes a
WireGuard peer, if `Serve.allow` (tailcat's `--allow`, the connection's `tailcat.allow`) is empty or has it; one not
on it gets no answer, as with tailcat. Its packets reach the guest only from its own tunnel address; the guest's
IPv6 to a client's address goes to that client and anything else to the exit node, or nowhere when
serving alone (on the relay of one's choice). Both at once share the exit node's relay. A client's disco pings get
pongs over the relay (`tailcat ping`; the disco key's private half is derived with it). **64 clients at once**: past
that, the one heard from least recently makes room if it has been quiet for 190 s (`CLIENT_IDLE`, past WireGuard's
180 s REJECT_AFTER_TIME, so its session is dead), and the page drops its route (`client-gone`); tailcat's clients take
a fresh key each run, so most such are gone for good. One that is still there comes back by its next packet, a
handshake initiation: a key with no peer that starts one is let in **on trial** (IKpsk2 mixes the pre-shared key in
only at the response, so its initiation can't prove it), announced once its first data decrypts and forgotten 20 s
without, so a key without the address gets nothing in.

## Rooms

Peer-to-peer rooms ([plans/networking-p2p.md](plans/networking-p2p.md), in progress: R0 to R3 done). `room.rs` is a
third client of the module (with `room/link.rs`, `room/lookup.rs` and `nostr.rs`); `web/room.ts` and
`web/room-worker.ts` are its page and worker. A room is a connection kind on the page ([frontend.md](frontend.md)
"Network": the wizard's Create a room and Join a room, the menu's name and link to copy); the node key a connection
keeps is in `webpc-room` ([network-adapters.md](network-adapters.md) §2.1), which the worker reads at the start
(`identityKey`; an ephemeral connection's comes as `identity`).

- **A room's link** (`room::Link`): `webpc-room:<id>?nostr=<wss URL>&…&derp=<region>&…`, each part percent-encoded; a
  `derp` is a region ID of the DERP map (0: its first) or a derper inline (`host[:port]`). Anything without the scheme
  is a bare ID, with the defaults: six public Nostr relays (`DEFAULT_NOSTR`: relay.primal.net and five of Trystero's
  list, those that carried every case R4 measured, bench/net/REPORT.md "Rooms on public servers"), and every region of the DERP map with DERP nodes a browser can reach and an ID from 1 to 0x7FFF, lowest ID first (at most 8; taken
  once the map loads). At
  most 8 relays and 8 regions, an ID of at most 256 bytes. The `self` event carries the link the client read, without
  the parts that were the defaults (`Link::encode`), so a link copied from the menu follows the defaults as they change.
- **What the ID derives:** BLAKE2s with labels of their own gives the room's /48 (`fd` and 40 bits; one that would be
  tailcat's `fd7a:115c:a1e0::/48` takes the next label), its tag (those 40 bits in base32), the tag salt and lookup key
  of its lookups, and the WireGuard pre-shared key every pair in the room uses (`room::Room`). A node's address is the
  /48 plus the first 80 bits of its node key, as tailcat's; its name is `<key in base32, 52 characters>.<tag>.p2p.internal`.
- **Finding a peer** (`room/lookup.rs`, `nostr.rs`): a node's tag in an hour is BLAKE2s of the tag salt, its address
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
  data, and both look alike (106 bytes: 32 of an ephemeral key or of random bytes, then the ciphertext; the target
  tries the seal first). Again after 1 s and 3 s; at 6 s the waiting packets get ICMPv6 address unreachable (type 1, code 3, from the
  room's `::53`), as does anything to that address for 5 s more. At most 64 lookups wait at once (past that, the
  guest's packet gets the ICMPv6 at once) and 8 go out a second (more wait for their resend), so a guest sweeping the
  /48 can't grow the worker or flood the relays. The Nostr relays are plain WebSockets in text mode (`WsOpen` with an
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
  own key, and 1,024 peers at most. Events under our tags are opened (an X25519 and up to two decryptions) at most 256
  a second, the rest dropped unread: anyone with a node's name, or the relay, can publish junk under its tag. Call backs are 16 a second; past that they wait their turn (first come first
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
- **WireGuard** (`ts_tunnel`, IKpsk2 with the room's key) carries the guest's IPv6 between members, whichever path
  carries its packets. A peer's packets reach the guest only from that peer's own address to ours. A key we don't
  know that starts a handshake is let in **on trial** (incoming connections, on by default) and forgotten 20 s after it
  came in unless its data decrypted, which only the room's key allows; 16 such a second, a budget apart from call
  backs', charged only once WireGuard answered the handshake (its MAC1 right), so junk from anyone who knows the key
  can't use it up. DERP proves a packet's sender, so a peer's packets go back through the region its last one came
  from (our response to its new initiation too). A peer is forgotten after 3 minutes without the
  guests' traffic, or 20 s after we sent it the guest's packets with nothing back (the next packet looks it up again).
- **Incoming off** (`incoming: false`): lookups go unanswered and handshakes from unknown keys are refused, unless the
  guest has a flow with that address; a flow table (the peer's address, the protocol, both ports or an echo's
  identifier; 5 minutes idle, 4,096 at most) lets in only replies to the guest's own flows (and ICMPv6 errors from a
  peer it has one with).
- **The resolver** at the room's `<prefix>::53` (the lease's `dns6`, with the room's `<tag>.p2p.internal` as its domain):
  `<key>.<tag>.p2p.internal` AAAA is the address computed from the key, which the module remembers to seal lookups to it;
  A for such a name is an empty answer, anything else NXDOMAIN. The suffix is `.internal`, not RFC 9476's `.alt`: systemd-resolved
  answers `.alt` names NXDOMAIN without asking any server (tests/page-room.test.ts found it). The lease: the room address as a /128, IPv4
  `192.0.0.2` with no IPv4 routes, and the /48 as the route on an adapter that isn't the guest's primary (`prefix6`,
  web/room-worker.ts).
- **Signalling inside the tunnel:** UDP between the two members' addresses, port 1 both ends (`SIGNAL_PORT`; the
  guest's packets to or from it are dropped), JSON: `hello` (the home region, relay only), `sig` (the page's
  description or ICE candidate for attempt `o`, opaque to the module), `bye` (attempt `o` closed, or refused by an
  answerer with too many), `refuse` (relay only), `ping` (the probe above). Each message carries the sender's
  epoch with us (random per peer it makes, so a restart, or a peer forgotten and made again on one side, resets what
  the other knew of its sequence numbers and attempts) and a sequence number, and is acknowledged and resent after 0.5, 1 and 2 s. Candidates go only to a member whose data decrypted.
- **The direct path:** the member with the lower key offers once the session is confirmed. The module asks the host
  for a connection (`RtcOpen`, actions 7–10 and `ts_rtc_*` in `wasm.rs`); web/room.ts makes an `RTCPeerConnection`
  (STUN only: `STUN_SERVERS`, Cloudflare's and Google's) with a negotiated data channel (id 0, unordered, no
  retransmits) and transfers the channel to the worker before anything is sent on it (Chromium has no
  `RTCPeerConnection` in a worker, but transfers a channel), so packets never touch the page's thread. Once it
  opens, the peer's WireGuard packets take it, one message each, except handshake messages, which always go
  through DERP (rare, and a peer that restarted has no channel to take ours). An attempt not open in 10 s is closed
  and the next waits 30 s, doubling to 5 min; a closed channel, or one we sent on with nothing back for 15 s (past
  WireGuard's 10 s passive keepalive), sends the peer back to DERP, and a new offer comes after 30 s. At most 64
  connections (`MAX_RTC`): past that the offerer waits for the guests' next packet, and an answerer refuses with a
  `bye`; a channel without the guests' traffic for 60 s (`RTC_IDLE`) is closed, and the offerer offers again at the
  next packet either way (a `bye` for an open channel isn't a failure: no backoff); a full channel drops the packet
  (`send` throws, `web/ts-client.ts` catches it). A peer's new connection comes at most every 2 s (`RTC_GAP`: an
  answerer ignores a newer attempt sooner, so a member's signalling can't make the page set up connections as fast as
  it sends; an offerer, after a restart's epoch, waits), and our own offers, all peers', at most 4 a second. Relay only
  (`relayOnly`) never opens a connection and refuses offers. The `path` event says which path a peer's packets take;
  `peer` says a session is confirmed, and `peer-gone` that such a peer was forgotten (the page's list of members
  reached follows both).
- **DERP:** one connection per region in use (`Relay`): the home region (`home`, an index into the link's; the
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
- **Tests:** `cargo test -p webpc_ts room` and `nostr` (the client against fake DERP regions, which route a packet only
  to a key on the same region, a fake Nostr relay and a fake WebRTC: lookups, names, sealing, stale, replayed, forged
  and misdirected lookups, the trial rate, incoming off and its flows, two regions, the hour's turn and a clock 40
  minutes off, a forged lookup that doesn't move a live peer and one that names another region, a reloaded peer
  called back, a peer made again on one side, both dialing at once, a lost call back, junk handshakes, a guest sweeping
  the /48, a relay's CLOSED and silence, a failed map with an inline home, the channel cap and the idle close, the R0
  cases; BIP-340's first vector); `tests/nostr-relay.test.ts` (the tests' relay, `tests/net/nostr-relay.ts`:
  NIP-01's EVENT, REQ, CLOSE, kind and `#x` filters, forwarding without storing, ids checked, signatures not, a small
  RFC 6455 server, no dependency); `tests/room-browser.test.ts` (Chromium, `WEBPC_TAILCAT=1`: pages joining one room
  by its link on the rig's derper and that relay, by address and by name, relay only, incoming off).

## Tailscale

`tailnet.rs` on `control.rs`; tailscale-rs's `ts_control` and Tailscale's `controlclient` are the
reference, the Go client (`net/tailscale`, now a test fixture) and the tests the oracle.

- **The control session** (`control.rs`): the server's Noise key by `fetch` (`/key?v=<capver>`), the
  Noise IK handshake (`ts_noise`; the record framing ours, `noise.rs`), HTTP/2 inside (`h2pipe.rs`:
  `h2`'s client over an in-memory pipe, polled with a no-op waker after every input, no runtime), the
  early payload skipped. Register with the auth key only for a node the server doesn't know; without
  one, the `AuthURL` goes to the page (`login`) and the follow-up long-poll waits for it (up to 10 min
  quiet); an auth key's node is ephemeral. Key expiry (at registration, and when the map says our key
  expired: a registration again); logout is a registration with an expiry in the past. The map stream
  (`/machine/map`, `Stream: true`, `Compress: ""`, frames as 32-bit little-endian lengths): the full
  netmap, then deltas applied as `controlclient` does (`netmap.rs`; each stream starts the packet
  filter afresh, as Go's map session); a stream silent for 150 s is presumed dead, a key fetch or
  handshake after 30 s; reconnect with backoff. A node with an address in one family only (headscale
  with only `prefixes.v4`) parses: `ts_control_serde` takes exactly an IPv4 then an IPv6 prefix, so such
  a response is fixed up before it's read again (`netmap.rs` `one_family`). Our `Hostinfo` has the hostname and `PreferredDERP`, no
  endpoints. The capability version is tailscale-rs's (`CapabilityVersion::CURRENT`).
- **The kept node** (`store.rs`, `web/tailscale-state.ts`): the Go client's own `ipn.StateStore` as the
  page kept it before the switch, IndexedDB `webpc-tailscale`, object store `state`, keys
  `<profile>/<StateKey>` (one profile per control server), values the hex of the bytes: `_machinekey`
  (`privkey:<hex>`), `_current-profile` (`profile-<4 hex>`), `_profiles` (the `LoginProfile` map), and
  the profile's `ipn.Prefs`, whose `Config` (Persist) holds `PrivateNodeKey`, `OldPrivateNodeKey`,
  `UserProfile`, `NetworkLockKey` (`nlpriv:`, a 64-byte ed25519 key: seed, then public key) and
  `NodeID`. Read and written in Go's format (as v1.102.5 wrote it, read in Node, not assumed), leaving
  entries and fields it doesn't use as they are; changes leave as `store` events. So a node made by
  either client is the same node in the other, and no migration is ever needed;
  `tests/ts-tailnet.test.ts` hands a node between the two both ways.
- **The home region** is the one answering `/derp/probe` fastest (a `fetch` per region, 3 s at most;
  the map's first otherwise), told to the server in a non-streaming map request.
- **The data plane:** a `ts_tunnel` peer per netmap peer, each reached through its home region. A
  peer's new node key (it re-registered) or new disco key (it restarted) makes its WireGuard state
  anew: ts_tunnel's `upsert_peer` keeps the old handshake, whose MACs are keyed to the old key, and a
  session the restarted peer forgot would swallow our packets until it expired (up to 3 min). An
  initiation nobody answered goes again, the same bytes, after 0.25, 0.5, 0.75, 1, 1.5, 2 and 3 s
  (ts_tunnel's own retry is at 5 s): a peer whose map doesn't have our node yet (a new node, an auth
  key's ephemeral one at every start) drops it, and a responder that did see it drops the copy as a
  replay. The first packet to the Podman tailnet's peer: 4.5 s before (5 of 6 runs), 0.76 s (5 of 5). Routes
  by longest prefix (a table rebuilt on each netmap: host addresses by address, prefixes longest
  first) over each peer's addresses, its approved subnet routes (its AllowedIPs that aren't its
  addresses or a default; unless the page turned them off, `ts_accept_routes`, as Tailscale's apps
  accept them by default) and, for the selected exit node only, the default
  routes (`ts_exit_node`, the peer's stable ID); while one is in use the worker probes its IPv6 reach and leases no IPv6 default without it
  (web/reach6.ts, docs/network-adapters.md §4 "IPv6 out"). What comes in passes `ts_packetfilter` (with the sender's node attributes), except TCP
  that isn't a new connection (Go's rule) and replies to the guest's own UDP flows and pings (a flow
  table, 2 min, 8,192 flows): the guest is a node, and the tailnet's ACLs apply to it.
- **MagicDNS** at 100.100.100.100 and `fd7a:115c:a1e0::53`, over UDP and TCP (`dns_tcp.rs`: just enough
  TCP for RFC 7766's queries, what a resolver falls back to after a truncated answer; no
  retransmission, the gateway's link loses nothing): A and AAAA for the netmap's names
  (peers' AAAA only with the `magicdns-aaaa` node attribute, as Go) and its extra records; NXDOMAIN
  inside the tailnet's own domains; the rest by the longest matching route's resolvers, or the
  netmap's. Every resolver (up to 4) is asked at once and the first answer that isn't SERVFAIL or
  REFUSED goes back (a failure only when all failed), as Go's forwarder races them: a resolver that's
  down costs nothing while another answers. A plain resolver the tunnel reaches (a peer, a subnet, or
  anything through the exit node; 1.1.1.1 through the exit node when the tailnet names none) is asked
  through it from the node's address (ports 61000–61999, above Linux's ephemeral range; 10 s);
  otherwise DNS over HTTPS by `fetch`: the route's own `https://` resolver, or the well-known
  resolver's service (Google, Quad9, Cloudflare), Cloudflare's otherwise. An answer over UDP fits the
  asker's EDNS(0) size (512 without) and the link: else its header and question with TC set, and the
  guest asks again over TCP; there, a truncated answer from a well-known public resolver is asked of
  its DoH service. Through an exit node, plain DNS where Go uses the exit node's peerapi DoH.
- **Disco:** pings from known peers over DERP get pongs (`ts_disco_protocol`), so peers see us
  properly; none sent (no direct path to offer).
- **Refused or left out:** a tailnet with Tailnet Lock on fails with that reason (not half-working);
  no direct connections, Taildrop, SSH server, serve/funnel or logtail.

The remaining gaps of both clients are in [backlog.md](backlog.md) "Network".

## Numbers

From [bench/net/REPORT.md](../bench/net/REPORT.md) ("T1", "T1 on the M4", "T6", "Batches"). On the M4
(Chromium 153, `bench/net/clients.ts`, the Podman tailnet's local DERP, five runs each, alternating
with the Go client): **492 KB Brotli** (Go: 4.5 MB), loaded in 6 ms (34), `Running` after 1.7 s (2.1:
headscale's first map), RTT 0.49 ms (0.63), **138 Mbit/s each way** (62) at 3.1 core-ms of the worker
per Mbit (7.9), the worker's memory 2.1 MB (20 to 26). tailcat in Chromium: `Running` 59 ms after
start, 137 Mbit/s each way; the module alone in Node, 323–329 Mbit/s each way.

## Tests

[testing.md](testing.md) "The network on Debian" has the list and where each runs. In short:
`cargo test -p webpc_ts` (everything sans I/O: CBOR, the address, NAT46, DERP against a fake relay,
both clients against fake servers, Noise against `ts_noise`'s responder, HTTP/2 against `h2`'s
server, the netmap, the store, the filter, MagicDNS); `tests/ts-client.test.ts` (the module's
boundary); the tailcat rig (`tests/net/tailcat.sh`: `derper` and `tailcat serve exit-node` built
natively by Go at pinned versions, the relay on `127.0.0.1:8444` with a self-signed certificate) under
`tests/tailcat-browser.test.ts`, `tests/net-tailcat.test.ts` and `tests/page-network.test.ts`; the
test tailnet (`tests/net/tailnet.sh`, headscale and a peer in rootless Podman; natively in a cloud
session, `tests/net/tailnet-native.sh`) under `tests/ts-tailnet.test.ts`,
`tests/tailscale-browser.test.ts` and `tests/net-tailnet.test.ts`; the tailcat rig again under
`tests/ts-tailcat.test.ts` (a relay's path cut off while its WebSocket stays open), and its derper alone under
`tests/room-browser.test.ts` (two members of a room in two pages: through the relay at once, then over their data
channel, back to the relay when it drops; relay only). Serving, against the real CLI
(`tests/net/tailcat-cli.ts`): `tailcat ping` (the rig's relay; tailcat's public ones opt-in), a kept key let in by a
second exit node's `--allow` and a fresh one not (`tests/tailcat-browser.test.ts`), and `tailcat ssh` into
images/debian-tools/build.sh's Debian with an allow list of the CLI's key (`tests/net-tailcat.test.ts`; over the
public relays with `WEBPC_TAILCAT_INTERNET=1`: 1.6 s to log in through Frankfurt, 2026-11-09). Because a tailcat exit node reaches
private addresses, a server on this machine stands in for the internet: the exit-node path is routine
there, where Tailscale's is opt-in.

**Keeping up:** a control server raising its minimum capability version means a tailscale-rs bump and
a run of `scripts/ci-net.sh`; a tailcat bump, a re-check of the address and the meow against its
`wire.go` and `disco.go`.

## Findings (don't re-discover)

- A test must never run the tailcat CLI with `spawnSync`: the test process serves the page's disk, and
  the guest's server read it lazily while the CLI waited on the guest (a 60 s timeout that looked like
  a routing bug).
- A tailcat exit node slows to nothing under one UDP flow per packet (a harness's mistake; a guest
  spraying flows would do the same). It doesn't answer IPv6 to its own `[::1]`: the tests use the
  machine's non-link-local IPv6 address (testing.md).
- The first packet to a fresh peer after the tailnet comes up waited ~4.5 s for a WireGuard retry
  (the Go client's "5 s first ping", bench/net/REPORT.md, too): the peer's map doesn't have our node
  yet, and drops our initiation. On 2026-10-24 (tests/ts-tailnet.test.ts's first echo, a new auth-key
  node each run, alternated): the old build 4.5 s in 5 of 6 runs (11 ms in the other), and a log of the
  answer's time with a resend every 100 ms showed the peer taking us 0.6–0.7 s after our first
  initiation, every time (the first runs of the day answered in ~10 ms: how often it shows varies).
  With the resends (above), 0.76 s in 5 of 5. Headscale answers the first map ~2 s after registration,
  for both clients.
- A netmap delta that gives a peer its disco key (none before) isn't a restart: resetting WireGuard
  then lost the handshake in flight, the first echo at 1 s instead of 10 ms in 2 of 3 runs. Only a
  disco key that changes from one to another resets it.
- Go's `net/http` in wasm refuses `fetch` under Node: it looks at `process.argv0` (the hand-over test's
  worker gives Go a `process` whose `argv0` isn't "node"). `ts_control_serde`'s `RegisterResponse`
  needs every field of the user (read as JSON instead).
- The guest must take the lease's search domain (`UseDomains=yes` for systemd-networkd), or `.local`
  MagicDNS names go to mDNS and short names to LLMNR (frontend.md "Network").
