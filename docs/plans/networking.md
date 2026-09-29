# webpc networking plan

**Status:** exploration, drafted 2026-09-27; the networking lane started 2026-09-29 (N1, N2 done; N3's gateway is in, its guest-level tests are pending). It feeds M8's "networking backend API"
(PLAN.md, M8). When a step here is scheduled, move it into PLAN.md and keep this file as the
background it came from.

The question: how does a VM in the page reach other networks, the internet included, **without
the guest knowing how**? Today the guest has virtio-net (`docs/devices.md` "net"):
the device hands the host raw Ethernet frames, and adapters in `web/net.ts` take them (a loopback
test adapter, or anything on the page behind a `MessagePort`).

## 1. Decisions

- **The device interface stays at raw Ethernet frames.** Frames are the most transparent layer:
  any guest OS, any protocol (IPv4, IPv6, ARP, DHCP, things we never thought of) and any backend
  (layer 2 or layer 3) fit behind it. Tailscale is a layer-3 network, and one small gateway
  (§3) bridges the two.
- **No v86 compatibility.** v86's network adapters (WebSocket relay, Wisp, `fetch`) are dropped as
  a goal. In practice they don't give a solid experience: the `fetch` adapter depends on hosts
  sending CORS headers, which most useful hosts (package mirrors among them) don't, so even
  `apt install` fails inside the VM; the relay and Wisp adapters need someone to run a server.
  `v86Bus` in `web/net.ts` goes away (N1), and the adapter API is ours to shape: frames on a
  `MessagePort`, one `ArrayBuffer` per message, as today.
- **The first real backend is Tailscale**, built on the upstream Go client (BSD-3), not a fork and
  not our own implementation (§4). **Go is an accepted build dependency.**
- **The main cost to fight is the optional download** (§4.4). That's also what makes
  `tailscale-rs` interesting later (§5).
- WebRTC peer-to-peer networks (M8's original idea) stay an experimental backend behind the same
  interface (§6).

## 2. What exists elsewhere (findings, 2026-09-27)

- **webvm / CheerpX** ([repo](https://github.com/leaningtech/webvm), Apache-2.0;
  [blog](https://labs.leaningtech.com/blog/webvm-virtual-machine-with-networking-via-tailscale)).
  The repo is a frontend: `src/lib/network.js` only passes `{authKey, controlUrl, loginUrlCb,
  stateUpdateCb, netmapUpdateCb}` into CheerpX, which is proprietary. Per the blog, they took
  Tailscale's `cmd/tsconnect` (the Go client built to wasm), added a custom TUN device that
  exchanges IP packets on a `MessageChannel`, and put lwIP (compiled with Cheerp) under CheerpX's
  socket syscalls. That works because CheerpX emulates syscalls, not a machine; we have a real
  kernel and a NIC, so the guest's own stack replaces lwIP. The Tailscale module is ~16 MB,
  loaded only when the user logs in; nodes are ephemeral and log in again after every reload;
  the internet is reached through an exit node on the user's tailnet. Their Tailscale changes are
  not published (the `leaningtech` org has only a `headscale` fork and `cheerpnet`, a 2019 MIT
  WebRTC virtual-LAN library).
- **`tailscale/tailscale` `cmd/tsconnect`** (BSD-3): Tailscale's own js/wasm client, in-tree
  (`cmd/tsconnect/wasm/wasm_js.go`, ~700 lines). It builds a `wgengine.NewUserspaceEngine` with no
  `Tun` and runs gVisor netstack on top for its own sockets (`ssh`, `fetch`). Traffic goes through
  DERP relays over WebSocket (browsers can't send UDP). **`wgengine.Config.Tun` takes any
  `tun.Device`**, which is all we need to hand the engine our guest's packets. There is also an
  `IsTAP` flag and an experimental `tap` feature tag (layer 2); unexplored, see §8.
- **[adrianosela/tailscale-web](https://github.com/adrianosela/tailscale-web)** (MIT): `tsnet`
  in wasm with a socket API (`fetch`, `dialTCP`, `listenTCP`, `ping`), ~35 MB, small (23 commits).
  No packet access, so it can't carry a guest; it shows the Go wasm build works.
- **[tailscale/tailscale-rs](https://github.com/tailscale/tailscale-rs)** (BSD-3; preview announced
  [2026-04-15](https://tailscale.com/blog/tailscale-rs-rust-tsnet-library-preview)): a Rust
  implementation by Tailscale, ~30 crates (`ts_control`, `ts_control_noise`, `ts_derp`,
  `ts_tunnel` (WireGuard), `ts_dataplane`, `ts_packetfilter`, `ts_netstack_smoltcp`, …) on tokio.
  All traffic goes through DERP for now (direct connections are a TODO), which is the only mode a
  browser has anyway. Unaudited, pre-1.0 with no compatibility promises, and requires an
  `TS_RS_EXPERIMENT` opt-in. No wasm support or plans stated.
- **Rolling our own client** would mean the control protocol (Noise IK to the coordination server,
  map polls, capability versions, packet filters), WireGuard, DERP and disco: what `tailscale-rs`
  needs ~30 crates for, tracking a protocol that isn't a stable public API. Rejected.
- **Direct Sockets API** (Chromium): raw TCP/UDP, but only for Isolated Web Apps. Not a page
  feature; noted, not planned.

## 3. The Ethernet gateway (backend-independent)

A layer-3 backend (Tailscale, later maybe others) sees IP packets; the guest sees a LAN. Between
them sits a small gateway, in TypeScript, running in the device worker (so a synchronous test
backend keeps deterministic mode exact, as the loopback adapter does now):

- **Proxy ARP:** it answers every ARP request for an address other than the guest's with one
  gateway MAC, so the guest can use a wide netmask (e.g. the tailnet's `100.64.0.0/10`) and reach
  any peer without extra routes.
- **DHCP server** (the guest just runs `udhcpc`/`dhclient`/`systemd-networkd`): the backend's
  address for the guest, netmask, router = the gateway, DNS (Tailscale: `100.100.100.100`,
  MagicDNS), and **MTU** (option 26; Tailscale's is 1280, and without it large packets vanish).
  The lease follows the backend: no lease until the backend has an address.
- **Framing:** strip the Ethernet header on the way out (IPv4/IPv6 only; everything else is
  answered by the gateway or dropped), add it (gateway MAC → guest MAC) on the way in.
- **IPv6** (Tailscale gives each node an `fd7a:115c:a1e0::/48` address): router advertisements plus
  a static or DHCPv6 address; after IPv4 works.
- The backend side is an IP-packet port: `{send(packet), receive(packet)}`, one packet per
  message. (Built: the guest's mask is 0.0.0.0 with the gateway at 169.254.0.1 and option 121
  routes, not the tailnet's range; see docs/devices.md.) The device worker and the backend's worker talk directly (a transferred
  `MessagePort`), not through the page's main thread.

## 4. The Tailscale backend

### 4.1 Shape
- **A Go program built with `GOOS=js GOARCH=wasm`** (new top-level directory, e.g. `net/tailscale/`,
  its own `go.mod` pinning `tailscale.com`). It mirrors `tsconnect`'s engine setup (~60 lines of
  `wasm_js.go`: `tsd.NewSystem`, `wgengine.NewUserspaceEngine`, `netstack.Create`,
  `ipnlocal.NewLocalBackend`) with one change: `wgengine.Config.Tun` is a `tun.Device` whose
  packets cross a `MessagePort` to the gateway. netstack stays, but only for Tailscale's own
  services (`100.100.100.100` DNS); `ProcessLocalIPs`/`ProcessSubnets` off, so the guest's traffic
  isn't terminated in gVisor.
- **Its own Worker.** Go's wasm is single-threaded and WireGuard's crypto runs in pure Go there;
  it must not share a thread with a vCPU or the device worker.
- **The guest is the tailnet node.** Traffic flows both ways: peers reach the guest's own services
  (`ssh` into a browser VM from a laptop), and tailnet ACLs apply to it like any other node. The
  internet is reached through an exit node on the tailnet (the user's choice; we only expose the
  setting), subnet routers work the same way.
- **JS API** (page side): `connect({controlURL?, authKey?, hostname?, exitNode?, state})`, callbacks
  for the login URL, state changes and the network map (our address, peers, exit nodes), `logout()`.
  Custom `controlURL` gives Headscale for self-hosters.
- **State persistence:** unlike webvm, keep the node's state (keys) in origin storage (IndexedDB or
  OPFS) so a reload is the same node with the same address, without logging in again. Ephemeral
  login stays an option (and the default for auth keys). The state holds a private key: document
  that, and never put it in a URL.

### 4.2 Licensing
`tailscale.com` is a Go dependency (BSD-3), not copied code; Go's `wasm_exec.js` (BSD-3) ships
with the build. Both get rows in `THIRD_PARTY.md`. Adapting `tsconnect`'s setup code keeps its
header.

### 4.3 Maintenance
- Pin `tailscale.com` in `go.mod`. Bump deliberately, every few months or when the coordination
  server starts warning about the client's capability version (old clients keep working for a
  long time, not forever).
- Our Go surface is what `tsconnect` calls (`tsd.System`, `wgengine.Config`, `netstack.Create`,
  `ipnlocal`), which changes between releases. Since `tsconnect` is in-tree, Tailscale keeps it
  building: a bump is a diff of `cmd/tsconnect/wasm/wasm_js.go` between the two tags, applied to
  our ~60 lines.
- The Go toolchain: from zypper in the dev VM (note it in CLAUDE.md), with go.mod's `toolchain`
  line pinning the version.

### 4.4 The download
webvm's Tailscale module is ~16 MB and tailscale-web's ~35 MB (uncompressed). It's optional and
loaded only on "connect", but it's still the biggest cost. Levers, each to be measured (N2):
- **Feature tags:** Tailscale's `feature/featuretags` lets a build omit features with `ts_omit_*`
  tags (`ssh`, `taildrop`, `drive`, `portmapper`, `webclient`, `serve`, `capture`, `tpm`,
  `clientupdate`, `relayserver`, `aws`, `kube`, `syspolicy`, …). A guest-carrying client needs
  almost none of them.
- **Compression:** Go wasm compresses well; serve it Brotli- or gzip-compressed and report both
  sizes.
- **`wasm-opt`** (Binaryen) on the output, and `-ldflags=-s -w`.
- **Caching:** a long-lived cache (immutable, versioned URL), so it's a one-time cost per version.
- **Streaming compilation** (`WebAssembly.instantiateStreaming`) so startup overlaps the download.
- TinyGo is unlikely to build `tailscale.com` (reflection, `net/http`); try only if the size is
  still the blocker.

## 5. Later: tailscale-rs

`tailscale-rs` may be the answer to §4.4, and it fits the project: Rust like our core, smoltcp
instead of gVisor, DERP-first (which is all a browser gets anyway), BSD-3. A Rust wasm module of
only the crates we need (control, Noise, DERP, WireGuard, packet filter, no netstack) could be a
fraction of the Go build. It could even share our toolchain and build.

Not now: it's a preview (unaudited, pre-1.0, gated behind an env-var opt-in), it's tokio-based
with no wasm support, and its DERP client uses HTTP upgrade, while a browser needs WebSocket.
**Re-evaluate** when it has an external security audit and a 1.0 (or at least a stable API), or
when the Go module's size (after §4.4) is the reason people don't connect. What's needed then:
a wasm32 build of the protocol crates (a single-threaded executor instead of tokio, `fetch`/
WebSocket transports for control and DERP), a packet-level entry point (the equivalent of our
`Tun`; `ts_dataplane` is where it would attach), and a size and throughput comparison against
the Go module. The gateway (§3) and the backend's port interface don't change, so the two
backends can coexist and be compared.

## 6. WebRTC peer-to-peer networks (experimental)

M8's original idea: VMs in different browsers on one virtual LAN over WebRTC data channels
(unordered, unreliable channels match Ethernet's semantics). It's layer 2, so it sits directly on
the frame interface: a switch (learning MAC table, broadcast to all peers) with no gateway,
though one VM or a gateway instance can offer DHCP to the rest. It needs a signaling server, and
TURN when peers can't connect directly. No commitment: explore after the Tailscale backend, and
drop it if it doesn't pan out.

## 7. Steps

Each step comes with tests at the cheapest layer that catches it (`docs/testing.md`).

- **N1 — Adapter API cleanup (done).** Drop `v86Bus` (`web/net.ts`) and the v86 wording in `docs/devices.md`;
  document the frame port as the API. Define the IP-packet port for layer-3 backends.
- **N2 — Tailscale wasm spike, measured (done: [bench/net/REPORT.md](../../bench/net/REPORT.md)).** The Go module with the `Tun` hook, built with the
  feature tags, in a worker; log in with an auth key and ping a tailnet peer from JS alone. Record
  raw, compressed and `wasm-opt` sizes, startup time, and throughput through DERP. If the size is
  unacceptable even after §4.4, stop here and move to §5 earlier.
  *Outcome:* 26.9 MB raw, **4.3 MB Brotli** with 71 omit tags (`wasm-opt` gains nothing on the wire
  and is not used); Running in ~2.3 s; ~33 Mbit/s and 1.6 ms through a local DERP. The Go path
  stays. Code: `net/tailscale/` (`build.sh`, `main_js.go`, a one-change overlay for the control
  dialer's HTTPS port), `bench/net/` (Node harness, spike), `tests/net/tailnet.sh` (headscale and a
  peer in rootless Podman). Findings in the report: Go's fetch off in Node, `login()`, custom HTTPS
  ports, DERP needs TLS, the 5 s first-ping mode, logtail dropped.
- **N3 — The gateway** (§3; the gateway and its byte-level tests are done in `web/gateway.ts`, `tests/gateway.test.ts`, docs/devices.md "net"; the Buildroot boot with exact steps and the Rust twin wait for the user's OK to change the test guest and for the images), IPv4, in the device worker, with a synchronous test backend that
  echoes at the IP level: Node unit tests for its ARP, DHCP and framing bytes, and a Buildroot
  boot that takes a DHCP lease and pings through it, deterministic and with exact step counts like
  `/test-devices.sh` (natively too, with a Rust twin in `core/tests/common`).
- **N4 — Gateway + Tailscale.** End to end in Chromium without a Tailscale account: Headscale (with
  its embedded DERP) and a peer (`tailscaled` with userspace networking) in rootless Podman; the
  guest gets a DHCP lease with its tailnet address, pings the peer, resolves it through MagicDNS,
  and the peer `ssh`es into the guest. Realtime mode only. Also once by hand against the real
  Tailscale service.
  *Done (2026-09-29, cloud session, Chromium 141): the test passes in ~117 s.* The guest gets
  `100.90.0.2/0` from systemd-networkd (the all-on-link mask and option 121 routes are accepted),
  a default route via 169.254.0.1, pings the peer (0% loss), resolves `peer.tail.test` and `peer`
  through MagicDNS, and the peer reaches a server in the guest. Not yet done: the manual run
  against the real Tailscale service, and the `ssh` variant (no sshd in the image). What's built:
  `web/tailscale.ts` + `web/tailscale-worker.ts` (the client in its own worker,
  an IP port to the gateway, the lease from the client's netmap), `tests/browser/tailnet.*` (a
  page and a Debian machine worker) and `tests/net-tailnet.test.ts` (opt-in, `WEBPC_TAILNET=1`;
  the peer reaches a Python server in the guest through `tailscale nc` instead of ssh: the guest
  has no sshd). In Chromium the module loads in ~240 ms and the node is Running ~2.5 s after the
  start. **Requirement found: the control server must answer `GET /key` with CORS headers**
  (`Access-Control-Allow-Origin`): the page fetches it cross-origin, and headscale sends none, so
  behind its reverse proxy (Caddy in the test tailnet) that header has to be added; Tailscale's
  own control server sends it. Everything else the client does is WebSocket (control, DERP).
- **N5 — Product surface** (with M8): connect/login UI, persisted node state, exit-node selection,
  Alpine `apk add` through an exit node as the smoke test; IPv6.
  *In progress.* Done: the Network menu on the page (connect with a control server, hostname and
  optional auth key; the login link; status; Disconnect, Log out, Remove card), the node kept in
  IndexedDB with automatic reconnect, a card that survives machine restarts, the page's Debian
  configuring the card itself (`ip=dhcp`); docs/frontend.md "Network". Left: exit-node selection
  (the netmap already lists `exitNodeOption` peers; the Go side needs `SetExitNode` in its prefs),
  the `apk add` smoke test (needs an Alpine image with a card and a tailnet with an exit node to
  the internet), IPv6, a real interactive login checked by hand against Tailscale's service and
  against a headscale (the test tailnet uses auth keys), and Buildroot's N3 boot.
- Later: §5 (tailscale-rs) and §6 (WebRTC), each behind the same interfaces.

## 8. Open questions

- Throughput and latency through Tailscale's DERP servers from a browser (N2 measures them); the
  guest's traffic is all relayed.
- The `IsTAP` / `tap` layer-2 mode in `wgengine`: could it replace part of the gateway? It's
  marked experimental and was built for Linux TAP devices; look at it in N2, but don't depend
  on it.
- Headscale's embedded DERP over WebSocket from a browser: expected to work (the DERP handler
  accepts WebSocket upgrades), to confirm in N4.
- Several VMs in one page: one node each (simplest), or one node with a subnet route? One node
  each until someone needs otherwise.
