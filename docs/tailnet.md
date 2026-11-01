# The tailnet client: tailcat and Tailscale

The page's network backends behind the Ethernet gateway ([devices.md](devices.md) "net": frames at
the device, IP packets on the gateway's port) are one client of our own: `net/ts` (crate `webpc_ts`),
a small Rust wasm module that holds the protocols' state, driven by a TypeScript worker that does the
I/O. It speaks two protocols:

- **tailcat** ([tailscale/tailcat](https://github.com/tailscale/tailcat)): Tailscale's data plane with
  no control plane. The guest goes online through a `tailcat serve exit-node` on a computer of the
  user's, and the VM can be a tailcat server itself (`tailcat ssh tc…` reaches the guest's sshd).
- **Tailscale**: a node on a tailnet (Tailscale's control server or a Headscale), with peers, the
  packet filter, exit nodes and MagicDNS.

What the user sees (the Network wizard and menu, the settings, the lease) is
[frontend.md](frontend.md) "Network". Why our own client and not Tailscale's Go one built to wasm (the
page's until 2026-10-17): the Go module was 26.9 MB of wasm (4.3 MB Brotli), a Go runtime and heap of
20 to 26 MB in its worker, and WireGuard in pure Go on one thread; this one is about 0.5 MB Brotli (511 KB on 2026-10-24) and
2 MB of memory with twice the throughput ("Numbers"). The decisions that led here (frames at the
device, the gateway, the guest as the node) are [plans/networking.md](plans/networking.md)'s.

**The files.** `net/ts/src/`: `wasm.rs` (the exports), `client.rs` (the tailcat client, and the
actions both clients share), `tailcat.rs` (the address), `cbor.rs`, `nat46.rs`, `derp.rs`, `ip.rs`
(packet builders), `tailnet.rs` (the Tailscale client's data plane), `control.rs` (the control
session), `noise.rs`, `h2pipe.rs`, `netmap.rs`, `store.rs` (the kept node), `dns.rs`, `dns_tcp.rs` (MagicDNS over TCP). The page's
side: `web/ts-client.ts` (the module's I/O: WebSockets, `fetch`, timers), `web/ts-wasi.ts`,
`web/tailcat.ts` and `web/tailcat-worker.ts`, `web/tailscale.ts` and `web/tailnet-worker.ts`,
`web/tailscale-state.ts` (the kept node in IndexedDB). Built by `net/ts/build.sh` to
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
  `loggedout`, `log`). Also `ts_exit_node`, `ts_accept_routes`, `ts_logout`, `ts_private_key`, `ts_close`, `ts_free`.
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
  THIRD_PARTY.md). **Import, don't rewrite** (the user, 2026-10-16): where a crate does the job it's
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

**Going online through a server** (`client.rs`). A fresh node key per connect. Each new relay
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
WireGuard peer (up to 64); its packets reach the guest only from its own tunnel address; the guest's
IPv6 to a client's address goes to that client and anything else to the exit node, or nowhere when
serving alone (on the relay of one's choice). Both at once share the exit node's relay.

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
`tests/ts-tailcat.test.ts` (a relay's path cut off while its WebSocket stays open). Because a tailcat exit node reaches
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
