# Our own Tailscale client, and tailcat (proposed, not scheduled)

**Status:** accepted 2026-10-16 (the user: all the dependencies it needs are fine). **T1 and T2
done** (the module and tailcat in Node, measured; tailcat on the page, Debian through it: §7). It continues
[networking.md](networking.md) (its §5, "Later: tailscale-rs"), which holds the decisions that
stay: frames at the device, the Ethernet gateway (§3), the IP-packet port, the guest as the node.
What exists: `net/ts/` (the module), `web/ts-client.ts` and `web/ts-wasi.ts` (its I/O),
`bench/net/tailcat.ts`, `tests/ts-client.test.ts`.

**Why.** The Go client (`net/tailscale/`, N2 to N8) works, but it is heavy: 26.9 MB of wasm
(4.3 MB Brotli) downloaded on "connect", a Go runtime and heap in its own worker (its memory was
never measured: [backlog.md](../backlog.md) "Network"), and WireGuard in pure Go on one thread,
which tops out at ~33 Mbit/s through a local DERP with that worker's core busy
([bench/net/REPORT.md](../../bench/net/REPORT.md)). The user wants something lighter, and the
security audit that networking.md §5 waited for is no longer a condition.

**The proposal.** A client of our own: a small Rust wasm module that holds the protocols'
state (WireGuard, DERP, Noise, the control protocol, the packet filter), built from the sans-I/O
crates of [tailscale-rs](https://github.com/tailscale/tailscale-rs), driven by a TypeScript
worker that does all the I/O (WebSockets, `fetch`, timers, IndexedDB). It speaks **two
protocols** over the same pieces:

1. **tailcat** first (§4): no control plane, no account. Someone runs
   `tailcat serve exit-node` on a machine they have, pastes the printed `tc…` address into the
   page, and the VM is on that machine's network. It is the smallest whole client (DERP,
   WireGuard, one peer), so it proves the module before the control protocol is written, and
   it's the "network without a tailnet" the user asked for.
2. **Tailscale** next (§5): the control protocol on top, until the module passes the network
   tests the Go client passes; then it replaces the Go client (§7).

## 1. Findings (2026-10-16)

### tailscale-rs (v0.6.1, BSD-3; `main` at 0d41a6f)
- **The audit happened.** v0.6.0 (2026-09-17): "a third-party security audit of the
  cryptography in ts_tunnel", all security-relevant findings fixed, the `TS_RS_EXPERIMENT`
  opt-in gone. Still pre-1.0, no API promises; DERP-only (no direct connections), as networking.md
  said.
- **The protocol cores are sans-I/O and tokio-free; the drivers aren't.** By crate (lines of
  Rust, without tests):

  | Crate | Lines | tokio | What we'd take |
  |---|---|---|---|
  | `ts_tunnel` (WireGuard, *audited*) | 3,568 | dev only | all: `Endpoint` takes packets and returns actions and timers ("Sans I/O" in its README) |
  | `ts_noise` (Noise IK, IKpsk2) | 818 | no | all |
  | `ts_keys`, `ts_packet`, `ts_time` | 2,121 | no | all |
  | `ts_control_serde` (map/register wire types) | 2,720 | no | all: the control protocol's JSON types |
  | `ts_capabilityversion`, `ts_nodecapability`, `ts_peercapability` | 691 | no | all |
  | `ts_packetfilter`, `_serde`, `_state`, `ts_bart_packetfilter`, `ts_bart`, bitsets | ~10,100 | no | the filter, and BART as the routing table |
  | `ts_disco_protocol` | 998 | no | answering disco pings over DERP (optional, §5) |
  | `ts_derp` | 1,963 | yes | its frame codec (`frame/`, ~570 lines); not `client.rs`/`dial.rs` (HTTP upgrade over TCP and TLS) |
  | `ts_control_noise` | 701 | `io-util`, `codec` | the handshake and framing; the tokio codec wrapper replaced |
  | `ts_dataplane` | 1,397 | optional | probably the routers and the filter step; it reads `Instant::now()` (below) |
  | `ts_control` (connect, register, map stream) | 2,390 | yes, and hyper | **not used**: TCP dialing, HTTP/1 upgrade, hyper's HTTP/2. Ours, smaller (§5) |
  | `ts_runtime`, `ts_netstack_smoltcp`, `ts_netmon`, `ts_netcheck`, `ts_http_util`, `ts_tls_util` | ~19,000 | yes | none: the guest's kernel is our netstack; the browser has no sockets to monitor |

- **wasm32-unknown-unknown blockers, all small.** `std::time::{Instant, SystemTime}::now()`
  panic on that target, and `ts_tunnel` (TAI64N timestamps in the handshake, `time.rs`),
  `ts_time` and `ts_dataplane` call them; `rand`/`getrandom` need a backend there.
  *Settled in T1:* the module is built for **`wasm32-wasip1`** instead, where std's clocks and
  `getrandom` work through WASI; the worker provides the six imports it uses
  (`web/ts-wasi.ts`: `clock_time_get`, `random_get`, an empty environment, stderr, `proc_exit`).
  No patch to tailscale-rs, no wasm-bindgen.
- **The transports a browser needs are known** (the Go js/wasm client uses them today, and
  `net/tailscale/overlay/controlhttp_client_js.go` is a copy of its control dialer): control is
  `wss://<control>/ts2021` with subprotocol `tailscale-control-protocol` and the Noise initiation
  in the `X-Tailscale-Handshake` query parameter (a browser can't set headers); DERP is
  `wss://<derp>/derp` with subprotocol `derp`, the same frames as over TCP. Inside the Noise
  channel, control is HTTP/2 (register, the map long-poll), and map responses are
  length-prefixed JSON, uncompressed when the request's `Compress` is `""`.
- tailscale-rs claims capability version 130 (`CapabilityVersion::CURRENT`).

### tailcat ([repo](https://github.com/tailscale/tailcat), BSD-3, v0.7.0; open-sourced 2026-08)
- "Tailscale without Tailscale, by Tailscale": Tailscale's data plane (WireGuard, magicsock,
  DERP) with **no control plane**. A server prints a `tc…` address; a client that has it
  connects. Its own js/wasm build (the web demo) is Go too, **~27 MB raw**, like ours: running
  it as is would not make anything lighter.
- **The address** is `"tc"` + base64url(CBOR): the server's node public key (`p`), its disco
  public key (`k`), a WireGuard pre-shared key (`q`, the default: the address is a secret, a
  bearer capability), and either a region ID of the public DERP map (`i`,
  `https://tailcat.dev/derpmap.json`, which sends `Access-Control-Allow-Origin: *`) or the DERP
  region inline (`r`: host names, IPs, ports; `serve --full-address`, or `--region=<host>` for
  one's own derper). `wire.go` is the whole format (113 lines).
- **The handshake:** the client makes an ephemeral node key, joins the server's DERP region and
  sends the server a raw DERP packet `"meow" 0x01 <node pub 32> <disco pub 32>`; the server adds
  the client as a peer and answers `"meow" 0x02`; then a WireGuard handshake (IKpsk2 with the
  address's PSK) through DERP. `disco.go` is the whole of it (70 lines). The disco key tailcat
  derives (HMAC-SHA256 of the node key) is for direct paths, which a browser never gets.
- **Addresses:** IPv6 only inside the tunnel. Each side is `fd7a:115c:a1e0::/48` plus the first
  80 bits of its node key; the server accepts only the client's own address as source.
  **IPv4 destinations travel as NAT64 `64:ff9b::/96`** (`DialTCP` maps them; the server unmaps
  them). Tunnel MTU 1280.
- **`serve exit-node`** terminates TCP and UDP in the server's gVisor netstack and proxies each
  flow to its destination (`OnTCPForward`, `OnUDPForward`); it is not IP forwarding. So: TCP and
  UDP to anywhere the server can reach, **private addresses included** (no `AllowProxy` by
  default, unlike Tailscale's exit nodes); ICMP to the internet probably not (to be checked);
  TCP/UDP to the server's own address go to its `localhost`. `serve 8080,3306` exposes chosen
  ports only.
- **The public DERP relays are rate-limited**, best-effort, revocable; a browser is DERP-only,
  so every byte goes through one. For real use: `tailcat genkey --region=derp.example.com` with
  one's own `derper` (it needs a TLS certificate; derper gets one).

### Why not TypeScript alone
Possible, and the I/O half is TypeScript anyway; the protocol half isn't, because of crypto.
WebCrypto has X25519 (Chromium 133+) but not ChaCha20-Poly1305, BLAKE2s or XSalsa20-Poly1305
(DERP's client info and disco use NaCl boxes), and its calls are asynchronous: a promise per
packet. We would write those primitives in TypeScript, slower than scalar wasm, with no audit,
plus Noise, HTTP/2 with HPACK, and the filter. In Rust they're the audited `ts_tunnel` and
RustCrypto crates. JSON is the one thing TypeScript does better (`JSON.parse`); `serde_json` in
wasm is fast enough for netmaps.

## 2. Decisions (proposed; the user's to confirm)

- **A Rust wasm module of our own, protocol state only; the TypeScript worker does the I/O.**
  The module never opens a socket or waits: the worker feeds it WebSocket messages, guest
  packets, `fetch` results and timer firings, and carries out what it returns (bytes to send on
  which WebSocket, packets for the guest, events for the page, the next timer). Sans-I/O like
  `ts_tunnel`, so the tests drive it in Node or natively with no network.
- **tailscale-rs crates as dependencies, not a fork:** from crates.io, pinned by `Cargo.lock`;
  no patches (`wasm32-wasip1`, §1). We write the drivers it has for tokio: the
  control session (§5), the DERP client (§3), the glue. **New crate dependencies need the user's
  OK** (CLAUDE.md): this plan asks for the tailscale-rs crates above and their RustCrypto
  dependencies (`chacha20poly1305`, `blake2`, `x25519-dalek`, `crypto_box`, `hkdf`), `serde`,
  `serde_json`, and maybe `h2` (§5). *Granted 2026-10-16* ("all the dependencies needed").
- **Where:** `net/ts/` (crate `webpc_ts`), a member of the root workspace (so `cargo test` and
  clippy cover it), built by `net/ts/build.sh` to `target/net/ts.wasm` for `wasm32-wasip1`. Not
  shared memory, no atomics, no threads: one worker, like the Go module now. Raw `extern "C"`
  exports and a TypeScript shim, as the core does (`net/ts/src/wasm.rs` documents the ABI). Our
  pinned nightly; no `simd128`; `opt-level=3` (T1: ~17% faster than `s` for 16 KB).
- **IPv6 keeps working (the user, 2026-10-16).** The Go client gives the guest IPv6 on the tailnet
  (N6), and so must this one. With Tailscale the guest's IPv6 is the node's `fd7a:…` address and
  its packets go through untranslated, as now; T5 keeps `net-tailnet`'s IPv6 checks. With tailcat
  the guest's IPv6 address is the tunnel's own, so IPv6 needs no translation either: the exit node
  proxies IPv6 TCP and UDP flows to wherever its machine reaches over IPv6 (and IPv4 travels as
  NAT64). Checked where the exit node's machine has IPv6 (the dev VM; the cloud container has none).
- **One worker, the same messages.** The new worker speaks `web/tailscale.ts`'s `ToTailscale`/
  `FromTailscale` and the gateway's IP port, so the page and the gateway don't change for
  Tailscale. tailcat adds a connect variant (§4).
- **tailcat comes first.** It needs only DERP, WireGuard and a 70-line handshake, so it
  validates the module, the WebSocket transport and the measurements before the control
  protocol is written; and it gives users a network with no account and no tailnet.
- **The kept node carries over (the user, 2026-10-16).** A page that logged in with the Go client
  comes back on the Rust client as the same node, with the same address and no new login. The
  Rust client reads the Go client's store as it is (§5, "The kept node") and writes it in the
  same format, so the switch goes both ways while both clients exist.
- **Go stays until the Rust client passes the same tests** (`scripts/ci-net.sh`), then goes (§7).

## 3. The module (shared by both protocols)

- **API (built for tailcat, `net/ts/src/wasm.rs`).** `ts_new(config json) → handle`; inputs
  `ts_ws_message`, `ts_ws_closed`, `ts_fetched`, `ts_guest` (a packet from the guest), `ts_tick`;
  `ts_deadline` (when to tick next); `ts_poll` returns actions until none is left: open, send on
  or close a WebSocket, fetch, a packet for the guest, a JSON event (state, lease, self, log).
  The module reads the clock itself (WASI), so the API has no `now`; natively the tests pass it.
  Bytes cross through the module's memory, one copy each way. T4 adds `store(key, bytes)`.
- **DERP client over WebSocket:** the server-key frame, our client info (NaCl box to the
  server's key), send/recv packet, keep-alive, ping/pong, peer-gone, health; reconnect with
  backoff. One connection per region in use: the home region, and each peer's home region when
  we send to a peer (as Tailscale's clients do), closed when idle.
- **WireGuard:** `ts_tunnel`'s `Endpoint`, a peer per node, PSK where tailcat gives one; its
  timers go into `deadline`.
- **Routing:** outbound by destination (BART over each peer's AllowedIPs), inbound checked
  against the sending peer's AllowedIPs, then the packet filter (§5).
- **Time and randomness** from WASI (`performance.now`, `crypto.getRandomValues`). The native
  tests drive the client with their own `Instant`s.

## 4. tailcat (step T1 to T3)

- **Connect:** parse the address (CBOR, our own small decoder: maps of short keys, byte
  strings, integers, strings), fetch the DERP map if the address only names a region, open the
  region's DERP, meow, wait for meowed (retry every second, give up after a timeout), then the
  WireGuard handshake. State: `Connecting`, `Running`, `Failed(reason)`.
- **Keys:** a fresh client key per connect by default (tailcat's own default). An optional kept
  client key (in IndexedDB, like the Tailscale node's), so a server can `--allow` it: its public
  key is shown on the page for the server's owner to copy.
- **The guest's lease.** IPv6: the client's tailcat address, as a /128, through DHCPv6 and the
  router advertisement as today. IPv4: `192.0.0.2`, RFC 7335's address for the IPv4 side of a
  host's translator (464XLAT's CLAT; nothing outside sees it), with the gateway as router. DNS: no MagicDNS here; the lease names resolvers
  the exit node reaches (`1.1.1.1` and `2606:4700:4700::1111` by default; settable), queried
  over UDP through the tunnel.
- **NAT46 in the module (tailcat mode only),** so the gateway stays backend-independent:
  - Out: an IPv4 packet from the guest becomes IPv6, source the tailcat address, destination
    `64:ff9b::<v4>` (stateless, RFC 7915: TTL to hop limit, the transport checksum adjusted
    for the new pseudo-header; ICMP echo to ICMPv6 echo). In: the reverse.
  - **MTU:** the tunnel carries 1280-byte IPv6 packets, so translated IPv4 must stay at 1260.
    The link's MTU can't be 1260 (under 1280, Linux turns IPv6 off on the interface), so the
    lease keeps 1280 and the translator **clamps the TCP MSS** in SYNs (1220) and answers
    larger IPv4 packets with ICMP "fragmentation needed" (MTU 1260) if DF is set, and fragments
    them if not.
  - IPv6 from the guest goes as is (source checked, as the gateway does now).
- **What the guest gets:** TCP and UDP to everything the server machine reaches (its LAN, the
  internet, its `localhost` at the server's tailcat address); the server's ports when it serves
  ports only. No inbound connections (tailcat clients don't take any). Ping beyond the server
  probably not (T1 checks). Throughput: what the DERP relay allows.
- **Page:** the Network menu gets a second kind, "tailcat address" (a password-type field; the
  address is a secret: never in a URL, kept only if the user asks, like the node state), a
  short how-to (`tailcat serve exit-node` on a machine of yours; your own derper for speed), and
  the same status lines.
- **Tests, without the internet:** `tests/net/tailcat.sh up|env|down` runs `derper` on
  `127.0.0.1:8443` (a self-signed certificate for the address) and `tailcat serve exit-node` on it,
  both native: Go builds them once at pinned versions (derper has no official image, and native
  binaries run in a cloud session too). The relay is an IP so the address carries its port (the
  key file's region is edited; `--region=` takes a dotted host name only). The servers the guest
  reaches are on this machine (its LAN address: the guest's 127.0.0.1 is its own). **Because a tailcat exit node does reach private addresses, a local server
  stands in for the internet**: the exit-node test that Tailscale's exit nodes forced into
  opt-in (N8) is routine here. Layers: the CBOR parser and NAT46 by bytes
  (`tests/ts-*.test.ts`, Node); the module against the container in Node (connect, UDP echo, a
  TCP download, the MSS clamp); the guest on the page (Debian takes both leases, `curl`s the
  echo server over IPv4 and IPv6, resolves a name through the configured resolver: the
  container answers DNS too).

## 5. Tailscale (steps T4 to T6)

What the Go client does for us now, in order of need; tailscale-rs's `ts_control` and
`ts_runtime` are the reference for each, and the Go client's behavior (and our tests) the
oracle.

- **Control session.** `GET <control>/key?v=<capver>` through `fetch` (the server's Noise key;
  the CORS requirement found in N4 stays), the Noise IK handshake over the `/ts2021`
  WebSocket, then HTTP/2 inside it. **HTTP/2:** the `h2` crate is poll-based over an
  `AsyncRead`/`AsyncWrite` that can be an in-memory pipe fed by the Noise layer (no tokio
  runtime); if it costs too much size, a minimal client of our own (SETTINGS, HEADERS with
  literal HPACK out and a full HPACK decoder in, DATA, WINDOW_UPDATE, PING, GOAWAY, RST): T4
  measures and picks.
- **Registration:** with an auth key; or interactive (the `AuthURL` to the page, then the
  follow-up long-poll); node key expiry and re-registration; logout (registration with an
  expiry in the past); ephemeral nodes.
- **The kept node (inherited from the Go client).** Today `web/tailscale-worker.ts` gives the Go
  client Tailscale's own `ipn.StateStore`: IndexedDB database `webpc-tailscale`, object store
  `state`, keys `<profile>/<StateKey>` (one profile per control server, `web/tailscale.ts`'s
  `persist`), values the hex of the bytes Go wrote. What a node needs from it: the **machine
  key** (`_machinekey`, text `privkey:<hex>`) and, under the current profile (`_current-profile`
  names it; `_profiles` lists them), the `ipn.Prefs` JSON whose `Persist` holds the **node key**
  (`PrivateNodeKey`, plus `OldPrivateNodeKey` during a rotation), the node and user IDs, and
  `NetworkLockKey`. With the same machine key and node key the control server sees the same
  node: no login until the key expires. The Rust client reads exactly these at start, writes
  them back in the same encoding (and the same keys) when they change, and leaves the entries
  it doesn't use untouched; the Go client keeps working on that store until it is removed
  (T6), and after that the store stays as it is, so no migration is ever needed. Field names
  and encodings are checked against the pinned `tailscale.com` (`ipn/prefs.go`,
  `types/persist`, `types/key`) in T4, not assumed from this paragraph.
- **Map stream:** the long-poll `/machine/map` with `Stream: true`, `Compress: ""`: the full
  netmap, then deltas (`PeersChanged`, `PeersRemoved`, `PeersChangedPatch`, `PacketFilter(s)`,
  `DNSConfig`, `DERPMap`, keep-alives), reconnect and resume. Our `Hostinfo` (`OS`, hostname,
  `NetInfo.PreferredDERP`: the home region, so peers know where to find us) and no endpoints
  (DERP only). Capability version: the one tailscale-rs claims, bumped with it.
- **Home DERP:** the lowest latency region by `fetch` timing of each region's
  `https://<derp>/derp/probe` (what the Go client's netcheck does in a browser; the Go client
  currently probes port 443 whatever the node's port, bench/net/REPORT.md); fall back to the
  first region.
- **Data plane:** a WireGuard peer and routes per netmap peer; **the packet filter on what
  comes in** from the tailnet, with return traffic of the guest's own connections allowed (a
  flow table: the guest is a node, and the tailnet's ACLs must apply to it as to any other);
  the exit node (the selected peer's `0.0.0.0/0`, `::/0` AllowedIPs used; the rest ignored),
  subnet routes when the user accepts them.
- **MagicDNS** at `100.100.100.100` and `fd7a:115c:a1e0::53` (UDP; TCP only if a test asks):
  peer names (A, AAAA when the node attribute says so, as found in N6), the search domain, the
  netmap's extra records; other names forwarded through the tunnel (the exit node when one is
  selected) to the netmap's resolvers as UDP, from the node's own address; with no exit node,
  well-known resolvers (Cloudflare, Google, Quad9) over DoH by `fetch`, which is what the Go
  client ends up doing in a browser. The peerapi DoH route the Go client uses with an exit node
  needs a TCP client inside the module; not planned unless UDP through the exit node fails.
- **Disco:** answering disco pings that arrive over DERP with pongs (`ts_disco_protocol`, NaCl
  box): cheap, and peers then see us properly; perhaps the fix for the 5 s first ping
  (bench/net/REPORT.md). Sending none.
- **Left out:** direct connections (no UDP in a browser), Taildrop, SSH server, serve/funnel,
  Tailnet Lock (a node that requires it can't use this client: say so in the menu), logtail
  (as now).

## 6. Measurements (each step that changes them records them in `bench/net/REPORT.md`)

Against the Go client, in one session, alternating, Chromium, on the test tailnet's local DERP:
the module's size (raw, gzip, Brotli), load and instantiate time, time to `Running`, the
worker's memory (`performance.measureUserAgentSpecificMemory` or the heap snapshot sizes),
ping RTT, throughput both ways (the N2 echo harness), and **the worker's CPU per Mbit/s**.
Expected, to be checked: well under 1 MB Brotli, and throughput limited by the guest and DERP,
not by WireGuard (scalar ChaCha20-Poly1305 in wasm runs at hundreds of MB/s).

## 7. Steps

- **T1 — The module skeleton and tailcat in Node, measured (done 2026-10-16).** `net/ts/` with the
  tailscale-rs crates building to wasm32; the DERP client, WireGuard, the tailcat
  handshake and NAT46; a Node harness against `tests/net/tailcat.sh`'s server (UDP and TCP
  echo, ICMP checked). Sizes, startup, throughput against the Go module's N2 numbers. **Gate:**
  if the module's size or throughput isn't clearly better than Go's, stop and report.
  *Outcome* ([bench/net/REPORT.md](../../bench/net/REPORT.md) "T1"): **458 KB raw, 154 KB Brotli**
  (Go: 26.9 MB, 4.3 MB); `Running` ~65 ms after start; 1.3 ms echo RTT; **62–71 Mbit/s each way**
  (`opt-level=s`; `3` ~17% more) with the client, the harness and the echo servers on one core
  (Go in N2: 33, another peer and relay). The gate passes. Built in a cloud session against a
  locally built `derper` and `tailcat`; tests: `cargo test -p webpc_ts` (CBOR, the address, DERP
  against a fake relay, NAT46 checksums, the client against a fake tailcat server with its own
  `ts_tunnel`), `tests/ts-client.test.ts` (the module's boundary with a stub WebSocket).
  *Found:* a tailcat exit node slows to nothing under one UDP flow per packet (the first
  harness's mistake; a guest spraying flows would do the same); ICMP isn't forwarded; TCP and
  IPv6 through the exit node are untested here (no TCP stack in the harness, no IPv6 in the
  container): T2's Debian test covers them.
- **T2 — tailcat on the page.** The worker, the menu's second kind, the leases, the MSS clamp;
  Debian on the page reaches the echo server over IPv4 and IPv6 and resolves names
  (`tests/net-tailcat.test.ts`, in `ci-net.sh`). docs/frontend.md "Network", devices.md if the
  lease changes. *Written 2026-10-16:* `web/tailcat.ts` (the `Tailscale` handle, so
  `web/app/network.ts` drives either backend), `web/tailcat-worker.ts`, the menu's **Connect to**
  choice, `tools/tailscale.ts` building `ts.wasm` for `npm run serve`/`npm start`,
  `tests/net/tailcat.sh`. *Run in the cloud session:* `tests/network.test.ts` (the controller),
  `tests/tailcat-browser.test.ts` (Chromium 141, no guest: module loaded in 16 ms, `Running`
  122 ms after start against the Go client's ~2.5 s, 2,000 of 2,000 1,260-byte UDP echoes back).
  *Done on the dev VM (2026-10-16):* `tests/tailcat-browser.test.ts` on Chromium 153 (`Running`
  59 ms after start, 2,000 of 2,000 echoes, 137 Mbit/s each way); **`tests/net-tailcat.test.ts`
  passed its first run** with no change to the client: networkd takes `192.0.0.2`/32 and the
  tunnel's `fd7a:…`/128, HTTP and 2 MB over IPv4 (~12 MB/s: the MSS clamp holds) and over IPv6 to
  this machine, and with `WEBPC_TAILCAT_INTERNET=1` example.com resolved and fetched through the
  exit node. The menu's tailcat kind is in `tests/page-network.test.ts`. T1's harness on the M4:
  323–329 Mbit/s each way (bench/net/REPORT.md "T1 on the M4"). *Found:* the exit node doesn't
  answer IPv6 to its own `[::1]` (the harness's first target; the tests use the machine's
  non-link-local IPv6 address, which Lima's VM lacks: docs/testing.md); and where the exit node's
  machine has no IPv6 route out, the guest's IPv6 connections to the internet are accepted by
  tailcat's netstack and then closed empty, so a client that prefers IPv6 (curl) fails instead of
  falling back (docs/backlog.md "Network").
- **T3 — Optional: the VM as a tailcat server.** The module answers meows (accepting clients,
  optionally only `--allow`ed keys), and the page shows the VM's own `tc…` address: anyone with
  the tailcat CLI runs `tailcat ssh tc…` (port 22 of the guest's sshd) or `tailcat tc… 8080`.
  The guest's IPv6 address *is* the server address, so packets go straight in; the filter
  admits only connections to the guest from clients. Small once T1 exists; do it if the user
  wants it.
- **T4 — The control session in Node against headscale.** Key fetch, Noise over WebSocket,
  HTTP/2 (the `h2` question settled by size), registration with an auth key, the map stream
  parsed into peers, routes and the filter, the kept node's store read and written. Tests: the
  node appears in headscale with its hostname, and the netmap matches `tailscale status` on the
  peer; **the store hand-over**: the Go client registers and keeps its node, the Rust client
  starts on that store and is the same node (headscale's node ID and the address unchanged, no
  new registration), then the Go client starts on the store the Rust client wrote and is still
  that node.
- **T5 — The tailnet data plane.** Home DERP, peers, the packet filter, the exit node, MagicDNS,
  disco pongs, interactive login, persistence and logout; `tests/net-tailnet.test.ts` runs
  against either backend (`WEBPC_TS_BACKEND=go|rust`) and passes with both, the opt-in internet
  phase (N8) once by hand with a real exit node.
- **T6 — Switch.** The measurements of §6 for both clients; the Rust client becomes the page's
  default; after a release with both, `net/tailscale/`, its Go build, `wasm_exec.js` and Go as
  a dependency go (the tailcat test server is a container image: no Go left). The kept nodes in
  users' IndexedDB stay as they are: the Rust client already uses them (§5). THIRD_PARTY.md,
  CLAUDE.md, networking.md and PLAN.md follow.

## 8. Risks and open questions

- **Tracking the control protocol** was why networking.md §2 rejected our own client. It is
  smaller now: tailscale-rs's wire types and capability version are maintained by Tailscale,
  and we own the drivers (an estimated 3,000 to 5,000 lines of Rust and a few hundred of
  TypeScript). A control server raising its minimum capability version means a tailscale-rs bump
  and a re-run of `ci-net.sh`. Headscale tracks the Go client too; tested in `ci-net.sh`.
- **tailcat is pre-1.0** ("no API or CLI stability promises: the Go API, the CLI flags and
  output, and the wire format may all change"). Our implementation is ~200 lines of it
  (address, meow); pin the version the tests run and re-check on bumps.
- **The public tailcat relays:** rate-limited and revocable; the page says so and recommends
  one's own derper. Heavy VM traffic through them is not what they're for.
- **The `[patch]` for time and random** may be refused by a future tailscale-rs layout; upstreaming
  a host-supplied clock to `ts_tunnel` (it's sans-I/O otherwise) would remove it.
- `h2` or our own HTTP/2: settled by size in T4.
- Does the module run in the device worker instead of its own (one worker less, no extra hop)?
  Only if T6's CPU numbers show it costs the device worker little; its own worker first.
- Tailnet Lock and other features the netmap may require that we don't implement: the client
  must fail clearly, not half-work.
