# waarm64 networking plan

**Status:** refined 2026-10-01. N1 to N5 are done: the IPv4 gateway, the Tailscale client, the
Network menu on the page, a kept node, exit-node selection; a VM on the page reaches its tailnet and,
through an exit node, the internet (checked by hand with a real login). IPv6 (N6) and the card for Alpine (N7, it needs nothing) are done. It feeds M8's "networking backend
API" (PLAN.md, M8). What exists is described in [devices.md](../devices.md) "net",
[networking/tailnet.md](../networking/tailnet.md) and [frontend.md](../frontend.md) "Network"; this file holds the decisions and what's left.

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
  *Reopened 2026-11-18 (the user):* a hosted way out for the first demo, with a destination allowlist, and everything else
  only through a heavily throttled slow lane the owner turns on: a hosted local helper, not a stream proxy such as Wisp ([networking/demo-network.md](../networking/demo-network.md)). v86
  compatibility itself stays dropped.
- **The first real backend is Tailscale**, built on the upstream Go client (BSD-3), not a fork and
  not our own implementation (§4). **Go is an accepted build dependency.**
- **The main cost to fight is the optional download** (§4.4). That's also what makes
  `tailscale-rs` interesting later (§5). *Proposed 2026-10-16:* our own client, a Rust wasm module
  built from tailscale-rs's sans-I/O crates, speaking tailcat first and then Tailscale, to replace
  the Go client. *Done 2026-10-16:* the Rust client ([networking/tailnet.md](../networking/tailnet.md)) is
  the page's Tailscale client, and the Go one left the page (2026-10-17; `net/tailscale` stays as a
  test fixture).
- WebRTC peer-to-peer networks (M8's original idea) stay an experimental backend behind the same
  interface (§6; *proposed 2026-10-18:* rooms, [networking/rooms.md](../networking/rooms.md)).

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
  browser has anyway. Pre-1.0 with no compatibility promises; no wasm support or plans stated.
  *Since (v0.6.0, 2026-09-17):* its WireGuard crypto (`ts_tunnel`) had a third-party audit and the
  `TS_RS_EXPERIMENT` opt-in is gone; which of its crates we use, and why not the rest, is in
  [networking/tailnet.md](../networking/tailnet.md) "The module".
- **Rolling our own client** would mean the control protocol (Noise IK to the coordination server,
  map polls, capability versions, packet filters), WireGuard, DERP and disco: what `tailscale-rs`
  needs ~30 crates for, tracking a protocol that isn't a stable public API. Rejected (2026-09-27);
  reopened 2026-10-16 on top of tailscale-rs's protocol crates ([networking/tailnet.md](../networking/tailnet.md)).
- **[tailcat](https://github.com/tailscale/tailcat)** (BSD-3, found 2026-10-16): Tailscale's data
  plane without its control plane; `tailcat serve exit-node` on any machine prints an address a
  client connects to, no account. The basis of [networking/tailnet.md](../networking/tailnet.md) "tailcat".
- **Direct Sockets API** (Chromium): raw TCP/UDP, but only for Isolated Web Apps. Not a page
  feature; noted, not planned.
- **[Rings](https://github.com/RingsNetwork/rings)** (checked 2026-10-18 at v0.33.0, `cf6c0ed`, as
  a backend for decentralized LANs over WebRTC; **rejected**). A Chord DHT whose nodes, browser tabs
  included, are addressed by a DID (20 bytes from a wallet-style key: secp256k1, P-256, ed25519)
  and talk over WebRTC data channels, joined through a seed node's HTTP JSON-RPC (`node.rings.rs`),
  STUN only. Why not:
  - **AGPL-3.0-only** (relicensed from GPL-3.0 on 2026-09-09), so not a dependency of this MIT
    project; at most a behavioral reference, like QEMU.
  - **Pre-1.0 with an unversioned wire protocol**: 0.22 to 0.33 in five weeks, each "cutover" a
    network-wide upgrade. The npm package's `latest` is still 0.2.1 (2023).
  - **Every message is a signed, admitted transaction**, built for an open overlay, not packets: two
    secp256k1 ECDSA signatures (origin and hop, re-checked at every hop), a persisted replay record
    on both ends under one global lock (its own measurement: ~50/s with the native flushed store;
    IndexedDB in a browser), a per-(origin, destination, class) quota of **8 messages/s** (burst 32)
    by default, credit counted in frames (16 per lane per round trip). Its own throughput target
    (#843) is 1 MB/s per link.
  - **Measured** (its relay example built natively on a cloud session's x86_64, two nodes on
    loopback, in-memory replay store, one ad-hoc run each): with default quotas a UDP tunnel echoed
    1% of 1,000 packets/s and a TCP tunnel stalled after 750 KB and reset. With the quota lifted
    (`ProcessorBuilder::origin_quota`): TCP **124 Mbit/s** (30 KB messages), but 1,200-byte
    datagrams top out at **~1,060 packets/s (10 Mbit/s) each way**, the rest dropped; echo RTT 3.7 ms.
    A guest's packets are one message each (batching them reintroduces head-of-line blocking on its
    ordered, reliable channels); our tailnet client does 138 Mbit/s through DERP
    ([networking/tailnet.md](../networking/tailnet.md) "Numbers"). A browser node would be slower still (one thread,
    IndexedDB per message; not measured).
  - **No IP layer to reuse**: `crates/gateway` is native-only (it refuses to build for wasm) and
    terminates IPv4/TCP flows in smoltcp toward onion exits; nothing assigns addresses. Payloads are
    readable by every hop without its E2E mode (ElGamal on secp256k1, 2.3× expansion, a signed
    message per 464 bytes). Membership is only a `network_id` in the signatures: no allowlist, Sybil
    resistance a stated non-goal, and a node picks its own ring position (its DID).
  - Size: rings.rs's page wasm (node and UI) is 13.0 MB, 3.2 MB Brotli (ours: 0.49 MB). A node keeps up
    to 328 connections (160 fingers); the public overlay's size isn't published.

  What carries over to §6: the DID-to-address idea is what tailcat already does (an address from the
  node key, accepted only from that key), and a signed DHT record per name is how rings publishes
  its online nodes (`online_nodes`).

## 3. The Ethernet gateway (backend-independent)

A layer-3 backend (Tailscale, later maybe others) sees IP packets; the guest sees a LAN. Between
them sits a small gateway, in TypeScript, running in the device worker (so a synchronous test
backend keeps deterministic mode exact, as the loopback adapter does now):

- **Proxy ARP:** it answers every ARP request for an address other than the guest's with one
  gateway MAC, so the guest reaches any peer through the one default route (its mask is a /32: option 121 gives the gateway on-link; a 0.0.0.0 mask was tried first and current systemd-networkd rejects it as no netmask).
- **DHCP server** (the guest just runs `udhcpc`/`dhclient`/`systemd-networkd`): the backend's
  address for the guest, netmask, router = the gateway, DNS (Tailscale: `100.100.100.100`,
  MagicDNS), and **MTU** (option 26; Tailscale's is 1280, and without it large packets vanish).
  The lease follows the backend: no lease until the backend has an address.
- **Framing:** strip the Ethernet header on the way out (IPv4/IPv6 only; everything else is
  answered by the gateway or dropped), add it (gateway MAC → guest MAC) on the way in.
- **IPv6 (N6, done 2026-10-01; what's built is in devices.md "net").** Tailscale gives each node an
  address in `fd7a:115c:a1e0::/48` (a headscale: its configured prefix), and the client's TUN
  already passes IPv6 packets untouched. The guest must use *exactly* the node's address (the
  gateway drops other sources, as for IPv4), which SLAAC can't produce for a /128, so:
  - **Router advertisements** from a link-local address derived from the gateway's MAC, answered to
    router solicitations and sent when a lease appears or changes and every few minutes (a timer in
    the device worker; realtime only: the synchronous echo backend answers solicitations and has no
    timers, so deterministic mode stays exact). Flags M (managed) and O; **no prefix information**
    (no SLAAC, nothing on-link), a router lifetime so the guest has a default route via the gateway,
    the MTU option, RDNSS.
  - **DHCPv6** (SOLICIT/REQUEST/RENEW/REBIND, stateful IA_NA, the Information-Request too): the
    node's address as a /128, DNS (option 23: Tailscale's MagicDNS is `fd7a:115c:a1e0::53` as well
    as `100.100.100.100`) and the search domain (24). No lease, no advertise, as for DHCPv4.
  - **NDP** only for the gateway's own link-local address (neighbor solicitations for it; all other
    destinations go through the router, so there is no proxy NDP); duplicate-address-detection
    probes from `::` ignored, like ARP probes.
  - **Framing and the rest:** ethertype 0x86dd both ways; sources other than the leased address
    dropped; ICMPv6 echo to the gateway; Packet Too Big over the MTU (IPv6 doesn't fragment in the
    network; Tailscale's 1280 is IPv6's minimum, so it's rare); multicast other than NDP and DHCPv6
    (`ff02::1:2`) dropped; the pseudo-header checksums for ICMPv6 and UDP.
  - `Lease` gains `address6`, `dns6`; the page's `leaseFrom` takes the netmap's `fd7a` address and
    the IPv6 resolvers (it keeps only IPv4 ones today). A lease needs the IPv4 address; the IPv6 one is optional
    (without it nothing is advertised and DHCPv6 stays silent).
- The backend side is an IP-packet port: `{send(packet), receive(packet)}`, one packet per
  message. (Built: the guest's mask is 255.255.255.255 with the gateway at 169.254.0.1 and option 121
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
with the build. Both get rows in `THIRD_PARTY.json`. Adapting `tsconnect`'s setup code keeps its
header.

### 4.3 Maintenance
- Pin `tailscale.com` in `go.mod`. Bump deliberately, every few months or when the coordination
  server starts warning about the client's capability version (old clients keep working for a
  long time, not forever).
- Our Go surface is what `tsconnect` calls (`tsd.System`, `wgengine.Config`, `netstack.Create`,
  `ipnlocal`), which changes between releases. Since `tsconnect` is in-tree, Tailscale keeps it
  building: a bump is a diff of `cmd/tsconnect/wasm/wasm_js.go` between the two tags, applied to
  our ~60 lines.
- The Go toolchain: from zypper in the dev VM (noted in docs/devenv.md), with go.mod's `toolchain`
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

*Superseded 2026-10-16 by [networking/tailnet.md](../networking/tailnet.md)* (the user: the Go module is too
heavy; the audit is no longer a condition). What follows is the original reasoning.

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

*Superseded 2026-10-18 by [networking/rooms.md](../networking/rooms.md)* (rooms: layer 3 with addresses
from keys, WireGuard over data channels, DERP for signalling and fallback, a Nostr directory; since 2026-11-10 live lookups over Nostr ephemeral events instead). The
original sketch: M8's original idea: VMs in different browsers on one virtual LAN over WebRTC data channels
(unordered, unreliable channels match Ethernet's semantics). It's layer 2, so it sits directly on
the frame interface: a switch (learning MAC table, broadcast to all peers) with no gateway,
though one VM or a gateway instance can offer DHCP to the rest. It needs a signaling server, and
TURN when peers can't connect directly. No commitment: explore after the Tailscale backend, and
drop it if it doesn't pan out. Rings, a ready-made decentralized overlay, was checked for this and
rejected (§2).

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
- **N3 — The gateway (done)**, IPv4, in the device worker, with a synchronous test backend that
  echoes at the IP level: `web/gateway.ts`, byte-level tests in `tests/gateway.test.ts`, and the
  guest-level check in `tests/net-guest.test.ts` (the page's Debian takes the lease and pings any
  address). *Dropped (the user, 2026-10-01):* a Buildroot boot with exact step counts and its Rust
  twin. It would change the test guest's bytes and add a native copy of a gateway that exists in
  TypeScript only, for coverage the Debian test and the byte tests already give.
- **N4 — Gateway + Tailscale (done).** End to end in Chromium without a Tailscale account: Headscale
  (with its embedded DERP) and a peer (`tailscaled`, userspace networking) in rootless Podman,
  `tests/net-tailnet.test.ts`: the guest gets a lease with its tailnet address, pings the peer,
  resolves it through MagicDNS, and the peer reaches a server in the guest (`tailscale nc`; the
  Debian image has no sshd, so no `ssh` variant). `web/tailscale.ts` + `web/tailscale-worker.ts`
  held the client in its own worker (since T6 `web/tailnet-worker.ts`, the Rust client). **Requirement found: the control server must answer
  `GET /key` with CORS headers** (headscale sends none: the test tailnet's Caddy adds it;
  Tailscale's own control server sends it). Module load ~240 ms, node Running ~2.5 s after start.
- **N5 — Product surface (done).** The Network menu (connect with a control server, hostname and
  optional auth key; the login link; status; Disconnect, Log out), the node kept in IndexedDB with
  automatic reconnect, the card always present, the guest configuring it from a systemd credential
  over fw_cfg, exit-node selection with DNS through the exit node, and a real interactive login
  checked by hand. docs/frontend.md "Network". *Dropped (the user, 2026-10-01):* the `apk add`
  smoke test and any other test that needs a real exit node on the internet.
- **N6 — IPv6 (done 2026-10-01).** §3 as built: `web/ip6.ts`, the gateway's IPv6 half, `Lease.address6`
  and `dns6`, Debian's credential `DHCP=yes`, the Go client reporting MagicDNS's IPv6 service address.
  Tests: `tests/gateway.test.ts` (the bytes), `tests/net.test.ts` (`leaseFrom`), `tests/net-guest.test.ts`
  (the echo backend answers ICMPv6: the guest has the address, a default route `proto ra`, pings
  any address and the gateway's link-local, gets the resolver; a late lease brings the IPv6 address
  in ~2 s, IPv4's takes ~25 s), `tests/net-tailnet.test.ts` (both addresses, ping6 to the peer, the
  peer reaches a server in the guest over IPv6). *Found:* MagicDNS answers AAAA for peers only when
  the control server sends the `magicdns-aaaa` node attribute (the client's `magicDNSAddrs`), so
  headscale's default gives names IPv4 only; the test checks IPv6 by address. Not done: IPv6 to
  the internet through an exit node (needs a v6 route on the exit node; by hand, once, when one exists).
- **N7 — The card for other guests (Alpine; done 2026-10-01: it needs nothing).** *Found:* Alpine's UEFI cloud images (Limine and GRUB) bring `eth0` up by themselves with DHCP, DHCPv6 and the router advertisement: with the echo gateway's card the guest has 198.18.0.15, `fd00:5eb0::f`, both default routes, and pings over IPv4 and IPv6, with no seed-disk file and nothing from the page's Debian `.network` credential (which Alpine ignores). `tests/uefi.test.ts` (opt-in, `WAARM64_DISTROS=alpine-uefi`) asserts it. The plan as written: The page offers a card to every machine with a
  `network` entry, and a disk chosen by the user (Alpine's UEFI cloud images are in scope since phase
  B) boots under that machine's configuration; but the `.network` credential only works for
  systemd guests. Find out what Alpine's images do by default with a virtio-net card (tiny-cloud
  brings `eth0` up with DHCP, to be checked, IPv6 included) and whether the seed disk or the image's
  own config needs anything. If it needs nothing, the step is a test: `tests/uefi.test.ts`'s Alpine
  boot gets a card on the echo gateway and pings (cheap: the seed disk is already there); if it does,
  the page's per-machine `network` entry grows a way to say it (a seed-disk file, not a credential).
  Not an `apk add`.
- **N8 — Tests and CI cleanup (done 2026-10-01).** The exit-node phase of `tests/net-tailnet.test.ts`
  needs the real internet (1.1.1.1, example.com); it guards three fixes found against a real exit
  node (`ipn.NewPrefs()`, `peerapiclient`, the netstack dialer). It is now opt-in
  (`WAARM64_TAILNET_INTERNET=1`) and passed once. Exit nodes refuse private, CGNAT and link-local
  destinations, so no local server can stand in for the internet. Left, only if cheap: the menu's
  login-URL and approval states in Chromium against headscale. `ci-net.sh` stays separate from
  `ci.sh` (the user, 2026-09-30: only when a change touches the network).
- Later: our own client with tailcat and Tailscale ([networking/tailnet.md](../networking/tailnet.md), done: it replaced §5's Go client as the default) and §6 (WebRTC), and further backends, each behind the same interfaces.

## 8. Open questions

- **Settled by N2/N4:** throughput and latency through DERP ([bench/net/REPORT.md](../../bench/net/REPORT.md):
  ~33 Mbit/s, 1.6 ms through a local DERP; Tailscale's own relays not measured); headscale's DERP over
  WebSocket from a browser works.
- The `IsTAP` / `tap` layer-2 mode in `wgengine`: not looked at, and the gateway has worked; it would
  not remove the IPv6 work above (RA and DHCPv6 would still be ours). Drop unless something asks.
- Several VMs in one page: one node each (simplest), until someone needs otherwise.
