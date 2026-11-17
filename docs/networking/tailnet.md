# The tailnet client: tailcat and Tailscale

The page's network backends behind the Ethernet gateway ([devices.md](../devices.md) "net": frames at
the device, IP packets on the gateway's port) are one client of our own: `net/ts` (crate `waarm64_ts`),
a small Rust wasm module that holds the protocols' state, driven by a TypeScript worker that does the
I/O. It speaks two protocols, and holds a room's member beside them ([rooms.md](rooms.md)):

- **tailcat** ([tailscale/tailcat](https://github.com/tailscale/tailcat)): Tailscale's data plane with
  no control plane. The guest goes online through a `tailcat serve exit-node` on a computer of the
  user's, and the VM can be a tailcat server itself (`tailcat ssh tc…` reaches the guest's sshd).
- **Tailscale**: a node on a tailnet (Tailscale's control server or a Headscale), with peers, the
  packet filter, exit nodes and MagicDNS.

What the user sees (the Network wizard and menu, the settings, the lease) is
[frontend.md](../frontend.md) "Network". Why our own client and not Tailscale's Go one built to wasm (the
page's until 2026-10-17): the Go module was 26.9 MB of wasm (4.3 MB Brotli), a Go runtime and heap of
20 to 26 MB in its worker, and WireGuard in pure Go on one thread; this one is about 0.6 MB Brotli (576 KB on 2026-11-10, rooms' lookups and `k256` 42 KB of it) and
2 MB of memory with twice the throughput ("Numbers"). The decisions that led here (frames at the
device, the gateway, the guest as the node) are [plans/networking.md](../plans/networking.md)'s.

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
  tests drive it natively (`cargo test -p waarm64_ts`) or in Node with no network.
- **The ABI** (`net/ts/src/wasm.rs` documents it). `ts_new(config JSON) → handle` makes a tailcat
  client (`addr`, `serve`) or, with `control`, a Tailscale one on the kept node `state`. Inputs:
  `ts_ws_message`, `ts_ws_closed`, `ts_fetched`, `ts_guest` (a packet from the guest), `ts_tick`;
  `ts_deadline` says when to tick next; `ts_poll` returns actions until none is left, read from
  `ts_buf()`: open, send on or close a WebSocket, `fetch` a URL, a packet for the guest, a JSON
  event (`state`, `lease`, `self`, `serving`, `client`, `netmap`, `login`, `store`, `exitnode`,
  `loggedout`, `log`); a `Failed` state and a refused `exitnode` say why as a stable `code` the page words
  (`web/ts-client.ts` `failureOf`, docs/i18n.md), with any technical `detail` beside it. Also `ts_exit_node`, `ts_accept_routes`, `ts_logout`, `ts_private_key`, `ts_close`, `ts_free`.
- **A room's registry** (docs/plans/room-names.md "The registry"): a room's config with `names` (`titles`: each a
  name's owner key, 64 hex digits, and its item, hex: `room/names/wire.rs`; `maxNames`, `maxBytes`) makes the node a
  server of the room's names; without it the node is a member, which asks servers for the names its guest wants
  (`room/names/member.rs`). Either's names client is a second room client inside the same handle (a member's only
  from its guest's first query for a name that isn't a key until 10 minutes after the last): its WebSocket
  connections are numbered from `0x40000000` (`room::NAMES_CONN`), so the worker opens, feeds and closes them as any
  other, and of its events only its log comes out (marked `names client:`). Action 11 stores a name's record (the
  name id, 32 bytes, then the record; the id alone: delete it), a server's (version 1) or a member's (version 2);
  `ts_room_names_load(h, ptr, len)` takes one back (1 when taken; a record of the other role's, or one whose
  chain lapsed, isn't), and the worker streams them all in before the first `ts_tick`: web/room-worker.ts keeps them
  in IndexedDB `waarm64-room`, store `names`, under the room and the connection and the id (web/room.ts
  `roomNamesStore`; a stored connection's only, written before the worker is closed), and deletes what the module didn't take. The room's `self` event says which parameters names
  are checked with (`params`: `production`; `test` only in the page tests' build, `net/ts/build.sh --test-params` →
  `target/net/ts-test.wasm`, never shipped: room-names.md "Tests' parameters"). The room's resolver answers registered
  names (room-names.md "The resolver") and logs each query for one (`resolver: …`).
  With `room.publish` the client is a **publisher** (the page's names agent, web/names.ts): a names client alone, no
  node and no guest, under a fresh key; `ts_room_names_put(h, item)` puts an item to the servers it finds, each answer a
  `names-put` event (`taken`, `better` with the server's item, `failed`, `nobody`). `ts_room_names_titles(h, json)` gives
  a running room node its titles as they change (a member given some becomes a server). The agent's operations are
  pure exports, `ts_names_<op>(ptr, len)` (JSON in, the length of JSON out in `ts_buf()`, minus that of why not;
  room/names/agent.rs): `key`, `make`, `mine`, `sign`, `add`, `pending`, `commitment`, `finish`, `anchor`, `zone`,
  `status`, `judge`, `drop`.
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
  died (tests/ts-tailcat.test.ts); before, never (the socket stayed open). Checked once in Chromium too (2026-11-12, a
  TCP forwarder on the rig's relay port freezing the page's connections): back 8.3 s after the freeze, and 0.55 s
  after a derper that was down 3 s came back.
- **Frames are joined** into messages of up to 4 KiB (`queue_frames`): the server reads the WebSocket
  as a byte stream (frames may straddle messages, as its own 4 KB writes do), so what was queued
  before the host takes the actions (an IP-port batch: `ts_guest` per packet, then one pump) leaves
  together, about three packets. **Not larger:** a relay queues 32 packets per destination and drops
  the oldest, so 64 KiB messages (a TSO packet's ~48 segments at once) dropped an upload through
  tailcat from 86 to under 1 Mbit/s ([bench/net/REPORT.md](../../bench/net/REPORT.md) "Batches").
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
  own address meaning its `localhost`. Two limits follow, the server's and not ours to lift: **no ICMP beyond it**
  (the guest's `ping` past the exit node gets no reply; test reachability with TCP, e.g. `curl`), and **many UDP
  flows starve it**: it keeps each flow's proxy for two minutes, so a guest that uses a new port per packet (a port
  scan, some games) slows it to nothing until the server restarts (bench/net/REPORT.md "T1"). **Pre-1.0**: no API, CLI or wire-format
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
server's machine reaches the internet over IPv6 (web/reach6.ts, probed by the worker: docs/networking/adapters.md §4
"IPv6 out"); otherwise the guest uses IPv4, with routes to the tailcat clients it lets in only. **NAT46 in the module** (`nat46.rs`,
stateless RFC 7915 for TCP, UDP and ICMP echo), so the gateway stays the same for both protocols: IPv4
from the guest becomes IPv6 from the tunnel address to `64:ff9b::<v4>`, and back. Translated IPv4 must
fit 1260 bytes, but the link stays at 1280 (under 1280 Linux turns IPv6 off on the interface), so the
translator clamps TCP's MSS in SYNs to 1220 and answers DF-set IPv4 over 1260 with "fragmentation
needed" from 192.0.0.1; fragments, DF-clear oversized packets and other ICMP types are dropped (checked once on the
wire, 2026-11-12: DF-clear 1,268- and 1,280-byte packets never reached the exit node's side, a DF-set one drew
"fragmentation needed" with MTU 1260, and 1,260 bytes passed either way). IPv6 goes as is.

**The VM as a server** (`Config.serve`). The kept identity (node key and pre-shared key, IndexedDB
`waarm64-tailcat`) makes a kept address: the disco key is derived from the node key (BLAKE2s).
`tailcat::encode_addr` writes the address: inline nodes for one's own relay, the short region form for
the public map, whose nearest region the page picks by `/derp/probe` timings. A meowing key becomes a
WireGuard peer, if `Serve.allow` (tailcat's `--allow`, the connection's `tailcat.allow`) is empty or has it; one not
on it gets no answer, as with tailcat. Its packets reach the guest only from its own tunnel address; the guest's
IPv6 to a client's address goes to that client and anything else to the exit node, or nowhere when
serving alone (on the relay of one's choice). Both at once share the exit node's relay. A client's disco pings get
pongs over the relay (`tailcat ping`; the disco key's private half is derived with it). **64 clients at once**, counting those that have shown the address's pre-shared key: IKpsk2 mixes it in only at
the handshake's response, so neither a meow nor an initiation proves it, and a client is proven once its first data
decrypts. A key that meows is announced (`client`, the page adds its route) and one that starts a handshake without
meowing is let in **on trial** (announced once proven, forgotten 20 s without), but neither takes anyone's place:
up to 16 newcomers wait beside the 64 (`MAX_NEWCOMERS`; past them the stalest goes if it has been quiet 20 s, or
else the next is refused). A newcomer proven when the 64 are full takes the place of the one heard from least
recently if that one has been quiet for 190 s (`CLIENT_IDLE`, past WireGuard's 180 s REJECT_AFTER_TIME, so its
session is dead), or else goes. One that made room is kept away, its key and its route (`MAX_AWAY`, 64; past them
the first to go is forgotten and the page drops its route: `client-gone`): its own next handshake lets it in again,
and so does the guest's next packet to it, the handshake starting from the VM (tailcat's clients take a fresh key
each run, so most such are gone for good; the handshake to one gives up after WireGuard's 90 s). Since a meow has no
secret in it, anyone on the relay who knows the machine's public key can keep the newcomers' places full and so
delay a new client; it can't push out one that is in.

## Rooms

A room's member is the module's third client (`room.rs`); how rooms work, their decisions and numbers:
[rooms.md](rooms.md).

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
  page kept it before the switch, IndexedDB `waarm64-tailscale`, object store `state`, keys
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
  (web/reach6.ts, docs/networking/adapters.md §4 "IPv6 out"). What comes in passes `ts_packetfilter` (with the sender's node attributes), except TCP
  that isn't a new connection (Go's rule) and replies to the guest's own UDP flows and pings (a flow
  table, 2 min, 8,192 flows): the guest is a node, and the tailnet's ACLs apply to it.
- **MagicDNS** at 100.100.100.100 and `fd7a:115c:a1e0::53`, over UDP and TCP (`dns_tcp.rs`: just enough
  TCP for RFC 7766's queries, what a resolver falls back to after a truncated answer; no
  retransmission, the gateway's link loses nothing): A and AAAA for the netmap's names
  (peers' AAAA only with the `magicdns-aaaa` node attribute, as Go) and its extra records; NXDOMAIN
  inside the tailnet's own domains; the rest by the longest matching route's resolvers, or the
  netmap's. Every resolver (up to 4) is asked at once and the first answer that isn't SERVFAIL or
  REFUSED goes back (a failure only when all failed), as Go's forwarder races them: a resolver that's
  down costs nothing while another answers. With no answer after 10 s the guest gets the failure one sent,
  or SERVFAIL (as Go's), not its resolver's timeout. A plain resolver the tunnel reaches (a peer, a subnet, or
  anything through the exit node; 1.1.1.1 through the exit node when the tailnet names none) is asked
  through it from the node's address (ports 61000–61999, above Linux's ephemeral range; 10 s);
  otherwise DNS over HTTPS by `fetch`: the route's own `https://` resolver, or the well-known
  resolver's service (Google, Quad9, Cloudflare), Cloudflare's otherwise. An answer over UDP fits the
  asker's EDNS(0) size (512 without) and the link: else its header and question with TC set, and the
  guest asks again over TCP; there, a truncated answer from a well-known public resolver is asked of
  its DoH service. Through an exit node, plain DNS where Go uses the exit node's peerapi DoH.
- **Disco:** pings from known peers over DERP get pongs (`ts_disco_protocol`), so peers see us
  properly; none sent and no CallMeMaybe (a browser has no direct path to offer).
- **Refused or left out:** a tailnet with Tailnet Lock on fails with that reason (not half-working);
  no direct connections, Taildrop, SSH server, serve/funnel or logtail.

The remaining gaps of both clients are in [backlog.md](../backlog.md) "Network".

## Numbers

From [bench/net/REPORT.md](../../bench/net/REPORT.md) ("T1", "T1 on the M4", "T6", "Batches"). On the M4
(Chromium 153, `bench/net/clients.ts`, the Podman tailnet's local DERP, five runs each, alternating
with the Go client): **492 KB Brotli** (Go: 4.5 MB), loaded in 6 ms (34), `Running` after 1.7 s (2.1:
headscale's first map), RTT 0.49 ms (0.63), **138 Mbit/s each way** (62) at 3.1 core-ms of the worker
per Mbit (7.9), the worker's memory 2.1 MB (20 to 26). tailcat in Chromium: `Running` 59 ms after
start, 137 Mbit/s each way; the module alone in Node, 323–329 Mbit/s each way.

## Tests

[testing.md](../testing.md) "The network on Debian" has the list and where each runs. In short:
`cargo test -p waarm64_ts` (everything sans I/O: CBOR, the address, NAT46, DERP against a fake relay,
both clients against fake servers, Noise against `ts_noise`'s responder, HTTP/2 against `h2`'s
server, the netmap, the store, the filter, MagicDNS); `tests/ts-client.test.ts` (the module's
boundary); the tailcat rig (`tests/net/tailcat.sh`: `derper` and `tailcat serve exit-node` built
natively by Go at pinned versions, the relay on `127.0.0.1:8444` with a self-signed certificate) under
`tests/tailcat-browser.test.ts`, `tests/net-tailcat.test.ts` and `tests/page-network.test.ts`; the
test tailnet (`tests/net/tailnet.sh`, headscale and a peer in rootless Podman; natively in a cloud
session, `tests/net/tailnet-native.sh`) under `tests/ts-tailnet.test.ts`,
`tests/tailscale-browser.test.ts` and `tests/net-tailnet.test.ts` (its peer also a subnet router for this machine's
address, approved only while the guest's first test checks it: not reached, reached through the peer, not with the
page's toggle off); the tailcat rig again under
`tests/ts-tailcat.test.ts` (a relay's path cut off while its WebSocket stays open), and its derper alone under
the rooms' tests ([rooms.md](rooms.md) "Tests"). Serving, against the real CLI
(`tests/net/tailcat-cli.ts`): `tailcat ping` (the rig's relay; tailcat's public ones opt-in), a kept key let in by a
second exit node's `--allow` and a fresh one not (`tests/tailcat-browser.test.ts`), and `tailcat ssh` into
images/debian-tools/build.sh's Debian with an allow list of the CLI's key (`tests/net-tailcat.test.ts`; over the
public relays with `WAARM64_TAILCAT_INTERNET=1`: 1.6 s to log in through Frankfurt, 2026-11-09). Because a tailcat exit node reaches
private addresses, a server on this machine stands in for the internet: the exit-node path is routine
there, where Tailscale's is opt-in.

**Keeping up:** a control server raising its minimum capability version means a tailscale-rs bump and
a run of `scripts/ci-net.sh`; a tailcat bump, a re-check of the address and the meow against its
`wire.go` and `disco.go`.

## Findings (don't re-discover)

- A test must never run the tailcat CLI with `spawnSync`: the test process serves the page's disk, and
  the guest's server read it lazily while the CLI waited on the guest (a 60 s timeout that looked like
  a routing bug).
- A tailcat exit node doesn't answer IPv6 to its own `[::1]`: the tests use the machine's non-link-local IPv6
  address (testing.md). A harness that used a new UDP port per echo starved it (above, "`serve exit-node`").
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
