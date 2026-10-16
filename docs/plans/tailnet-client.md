# Our own Tailscale client, and tailcat (proposed, not scheduled)

**Status:** accepted 2026-10-16 (the user: all the dependencies it needs are fine). **T1 to T6
done** (2026-10-16): the module and tailcat in Node, measured; tailcat on the page, Debian through
it; the VM as a tailcat server, and the page's Network wizard; the Tailscale control session, the
kept node handed over both ways with the Go client, the data plane; and the switch: **the Rust
client is the page's Tailscale client** (§7). Left: removing the Go client from the page, on the
user's OK after their manual test (Go stays for development and CI), and the loose ends in [backlog.md](../backlog.md) "Network". It continues
[networking.md](networking.md) (its §5, "Later: tailscale-rs"), which holds the decisions that
stay: frames at the device, the Ethernet gateway (§3), the IP-packet port, the guest as the node.
What exists: `net/ts/` (the module), `web/ts-client.ts` and `web/ts-wasi.ts` (its I/O),
`web/tailcat-worker.ts` and `web/tailnet-worker.ts` (the page's workers for tailcat and Tailscale),
`bench/net/tailcat.ts`, `bench/net/tailnet.ts`, the tests of §7.

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
- **Import, don't rewrite (the user, 2026-10-16, during T4).** Where a crate does the job it is
  used as it is, even at some size: `ts_control_serde` for the control protocol's types (+540 KB
  raw, +144 KB Brotli, most of it `url`'s IDNA tables), `h2` for HTTP/2 (+406 KB raw, ~+100 KB
  Brotli), `ts_packetfilter` for the filter, `ts_disco_protocol` for pongs, `ed25519-dalek` for
  the network-lock key. The module is still about a tenth of the Go one (T4/T5: 1.87 MB raw,
  ~0.5 MB Brotli, against 26.9 MB and 4.3 MB). What isn't imported is what can't run in a browser:
  `ts_control`, `ts_derp`'s client, `ts_runtime` and `ts_control_noise`'s framing need sockets or
  tokio's runtime (which doesn't build for wasm), so their few hundred lines of protocol logic are
  ours over the worker's transports.
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
  `127.0.0.1:8444` (a self-signed certificate for the address) and `tailcat serve exit-node` on it,
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
not by WireGuard (scalar ChaCha20-Poly1305 in wasm runs at hundreds of MB/s). *Measured (T6):*
492 KB Brotli; 138 Mbit/s each way with the worker at 0.86 of a core (Go: 62 at a full core).

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
- **T3 — The VM as a tailcat server (done 2026-10-16; the user wanted it).** The module answers
  meows and the page shows the VM's own `tc…` address: anyone with the tailcat CLI runs
  `tailcat ssh tc…` (port 22 of the guest's sshd) or `tailcat tc… 8080`. The guest's IPv6
  address *is* the server address, so packets go straight in. *Built:* `Config.serve` (the
  address's pre-shared key; the relay without an exit node: nodes, or a region of the map by ID)
  in `client.rs`: a meowing key becomes a WireGuard peer (up to 64), its packets reach the guest
  only from its own tunnel address, the guest's IPv6 to a client's address goes to that client
  and anything else to the exit node (or nowhere, serving alone); the disco key is derived from
  the node key (BLAKE2s), so a kept key is a kept address; `tailcat::encode_addr` writes the
  address (inline nodes for one's own relay, the short region form for the public map),
  `parse_relay` reads `host[:port]`. Serving works alone (the machine reaches only its clients)
  or beside an exit node (on its relay). The page keeps the identity in IndexedDB
  (`webpc-tailcat`) and picks the public map's nearest region by timing each relay's
  `/derp/probe` (it sends CORS headers, as the map does). **The Network wizard** came with it
  (the user's request): the menu's form had outgrown a popup, so a dialog picks a tailnet or
  tailcat and takes the settings, and the menu keeps only the current connection
  (frontend.md "Network"). *Tests:* `cargo test` (a fake tailcat client meows, handshakes and
  reaches the guest; spoofed sources, unknown destinations and keys that never meowed get
  nothing through; beside an exit node; a kept key keeps the address; addresses round-trip;
  planted: the source check removed fails it), `tests/net-tailcat.test.ts` (the real tailcat
  CLI parses the VM's address and fetches a page from a server in the guest, the VM online
  through the exit node at the same time), `tests/page-network.test.ts` (serving alone on the
  test relay from the wizard, the CLI reaching the guest, the same address after a reload,
  New address). *Found:* a test must never run the CLI with `spawnSync`: the test process
  serves the page's disk, and the guest's server read it lazily while the CLI waited on the
  guest (a 60 s timeout that looked like a routing bug). Module: 493 KB raw (from 460).
- **T4 — The control session in Node against headscale.** Key fetch, Noise over WebSocket,
  HTTP/2 (the `h2` question settled by size), registration with an auth key, the map stream
  parsed into peers, routes and the filter, the kept node's store read and written. Tests: the
  node appears in headscale with its hostname, and the netmap matches `tailscale status` on the
  peer; **the store hand-over**: the Go client registers and keeps its node, the Rust client
  starts on that store and is the same node (headscale's node ID and the address unchanged, no
  new registration), then the Go client starts on the store the Rust client wrote and is still
  that node.
  *Written and passed in a cloud session (2026-10-16)*, against headscale v0.29.4 and a userspace
  `tailscaled` peer run natively (`tests/net/tailnet-native.sh`, the Podman rig's twin; its TLS
  proxy `tests/net/tls-proxy.ts`). *Built:* `noise.rs` (the handshake is `ts_noise`'s; the record
  framing ours: `ts_control_noise` needs tokio's runtime), `h2pipe.rs` (`h2`'s client over an
  in-memory pipe, polled with a no-op waker after every input: no runtime), `netmap.rs` (map
  responses parsed by `ts_control_serde`, deltas applied as `controlclient` does), `store.rs` (the
  kept node), `control.rs` (the session: the early payload skipped, register with the auth key
  only for a node the server doesn't know, the follow-up long-poll of an interactive login, key
  expiry, logout as a registration with an expiry in the past, map frames as 32-bit little-endian
  lengths, a silent stream presumed dead after 150 s, reconnect with backoff). *The store, as the
  Go client v1.102.5 wrote it (read in Node, not assumed):* `_machinekey` = `privkey:<hex>`,
  `_current-profile` = `profile-<4 hex>`, `_profiles` = the `LoginProfile` map, and the profile's
  `ipn.Prefs` whose `Config` (Persist) holds `PrivateNodeKey`, `OldPrivateNodeKey` (zero),
  `UserProfile`, `NetworkLockKey` (`nlpriv:`, a 64-byte ed25519 key: seed, then public key),
  `NodeID`. *Tests:* `cargo test` (Noise against `ts_noise`'s responder, HTTP/2 against `h2`'s
  server with a body past the flow-control window, a full map and its deltas, the store read from
  Go's and written fresh, the session against a fake control server: register, map, the kept node
  back without its key, interactive login, logout); `tests/ts-tailnet.test.ts` (the Go client run
  in a Node worker, `tests/net/go-client.ts`: Go → Rust → Go and Rust → Go → Rust on one store, the
  same headscale node and addresses each time; the netmap against the peer's `tailscale status
  --json`; interactive login approved by `headscale auth register`). *Found:* Go's `net/http` in
  wasm refuses `fetch` under Node (it looks at `process.argv0`; the worker hands Go a `process`
  whose `argv0` isn't "node"); `ts_control_serde`'s `RegisterResponse` needs every field of the
  user (read as JSON instead).
- **T5 — The tailnet data plane.** Home DERP, peers, the packet filter, the exit node, MagicDNS,
  disco pongs, interactive login, persistence and logout; `tests/net-tailnet.test.ts` runs
  against either backend (`WEBPC_TS_BACKEND=go|rust`) and passes with both, the opt-in internet
  phase (N8) once by hand with a real exit node.
  *Written in the cloud session (2026-10-16); the guest's half (Debian on the page) is the dev
  VM's.* `tailnet.rs`: the home region is the one answering `/derp/probe` fastest (a `fetch` per
  region, 3 s at most; the first region otherwise), told to the server in a non-streaming map
  request; a `ts_tunnel` peer per netmap peer, each reached through its home region (connections to
  other regions close after 60 s unused); routes by longest prefix over each peer's addresses and,
  for the selected exit node only, the default routes; what comes in passes `ts_packetfilter`
  (with the sender's node attributes), except TCP that isn't a new connection (Go's rule) and
  replies to the guest's own UDP flows and pings (a flow table, 2 min); MagicDNS (`dns.rs`) answers
  the netmap's names (AAAA only with the `magicdns-aaaa` attribute, as Go), NXDOMAIN inside the
  tailnet's domains, and forwards the rest: through the tunnel from the node's address when a peer
  or the exit node reaches the resolver (1.1.1.1 through the exit node when the tailnet names
  none), else DNS over HTTPS by `fetch` (the resolver's own service when it's a well-known one,
  Cloudflare's otherwise); disco pings from known peers over DERP get pongs (`ts_disco_protocol`);
  a tailnet with Tailnet Lock on fails with that reason. The page: `web/tailnet-worker.ts` speaks the
  Go worker's messages (`ToTailscale`/`FromTailscale`), the store helpers moved to
  `web/tailscale-state.ts`, `startTailscale` takes `backend` (default `DEFAULT_BACKEND`, `go` until
  T6; the page's `?tsbackend=go|rust` overrides it). *Tests:* `cargo test` (the filter: allowed
  and refused new connections, replies to the guest's flows, spoofed sources; the exit node used
  only when selected; MagicDNS; planted: the filter letting everything in fails them);
  `tests/ts-tailnet.test.ts` (a stand-in guest of crafted packets, `tests/net/packets.ts`: ping the
  peer over IPv4 and IPv6, MagicDNS's answer and NXDOMAIN, UDP and TCP to servers behind the peer,
  the peer's `tailscale ping` answered over DERP, its connection let in by the filter, the exit
  node selected and cleared); `tests/tailscale-browser.test.ts` (both clients in Chromium, no guest:
  Running, the lease, 2,000 echoes; a kept node through reloads in Rust, Go and Rust again; logout
  empties the store and headscale shows the key expired). *Cloud numbers* (Chromium 141 on the
  cloud's x86_64, not comparable with the M4's: an indication only): Rust loaded in 21 ms (Go
  140), Running after ~2 s for both (headscale's first map), echo RTT 1.4 ms (Go 1.8), 34 Mbit/s
  each way (Go 17) through the userspace peer. *Found:* the first packet to the peer after the rig
  comes up waits ~4.5 s (a WireGuard retry), later clients' first packets 55 ms: the peer's
  warm-up, the Go client's "5 s first ping" too (bench/net/REPORT.md).
  *Checked on the dev VM (2026-10-16):* on the Podman rig, `tests/ts-tailnet.test.ts` (5 of 5; the
  rig's new subcommands' first runs) and `tests/tailscale-browser.test.ts` (3 of 3); Debian on the
  page through the Rust client, `tests/net-tailnet.test.ts` with `WEBPC_TS_BACKEND=rust`: the lease,
  ping and MagicDNS over IPv4 and IPv6, the peer reaching the guest's servers over both, and the
  opt-in internet phase (1.1.1.1 and example.com through the exit node: our plain DNS through it
  works where Go uses the exit node's DoH); `scripts/ci-net.sh` and `scripts/ci-debian.sh` whole.
- **T6 — Switch.** The measurements of §6 for both clients; the Rust client becomes the page's
  default; after a release with both, `net/tailscale/`, its Go build, `wasm_exec.js` and Go as
  a dependency go (the tailcat test server is a container image: no Go left). The kept nodes in
  users' IndexedDB stay as they are: the Rust client already uses them (§5). THIRD_PARTY.md,
  CLAUDE.md, networking.md and PLAN.md follow.
  *Prepared in the cloud session (2026-10-16):* the backend is a `startTailscale` option
  (`DEFAULT_BACKEND`, still `go`), both workers share the store (`web/tailscale-state.ts`), and
  `tests/tailscale-browser.test.ts` runs both clients side by side in one session. The switch waits
  for the guest's test on the Rust client and `scripts/ci-net.sh` on the dev VM, and the M4's numbers.
  *Done on the dev VM (2026-10-16).* The numbers (`bench/net/clients.ts`, Chromium 153, five runs
  each alternating; [bench/net/REPORT.md](../../bench/net/REPORT.md) "T6"): Rust 492 KB Brotli
  (Go 4.5 MB), loaded in 6 ms (34), `Running` after 1.7 s (2.1: headscale's first map), RTT 0.49 ms
  (0.63), 138 Mbit/s each way (62) at 3.1 core-ms of the worker per Mbit (7.9), the worker's memory
  2.1 MB (20 to 26). `DEFAULT_BACKEND` is `rust`; the Go client stays behind `?tsbackend=go`, and
  `scripts/ci-net.sh` runs the guest's test on both. `npm start` now builds `target/net/ts.wasm`
  (it never did: tailcat from a fresh `npm start` said the client wasn't built since T2), and the Go
  client only where Go is installed, without a word otherwise. Removing the Go client from the page
  follows the user's manual test and OK (2026-10-17: no release with both, there are no other users
  yet); Go stays for development and CI (the tailcat rig, the hand-over test).

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
- `h2` or our own HTTP/2: settled in T4 (the user: import it; §2).
- Does the module run in the device worker instead of its own (one worker less, no extra hop)?
  Only if T6's CPU numbers show it costs the device worker little; its own worker first.
- Tailnet Lock and other features the netmap may require that we don't implement: the client
  must fail clearly, not half-work.
