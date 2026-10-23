# A local network helper (proposed, not started)

A third kind of connection, beside a tailnet and tailcat ([network-adapters.md](../network-adapters.md) §1): a
small program the user runs on their own computer, which the page reaches over a WebSocket on loopback and which
puts the guest's traffic on the host's own sockets. It is for the user who runs their own machine for a long
while and wants a fast connection they trust; the demo's connection (a snapshot and a disk over HTTP, online with no
setup) is a separate problem, and one of the proxies, VPNs or Workers explored for it will serve it.

Why: a browser has no UDP, so tailcat and a tailnet always go through DERP. The public relays are far from many
users, rate-limited and best-effort: under 20 Mbit/s and a relay's round trip in the user's experience, and a
friend's tailcat connection behaves worse still. A helper on the user's machine has the latency of loopback and
the user's own uplink. Every name here (`webpc-net`, the subprotocol, the kind) is provisional: the project's
name may change.

## 1. Decisions (the user's, 2026-10-23)

- **A helper of ours, in Go, in its own repository** (`gbl08ma/webpc-net`, provisional). Users who don't want to
  trust us keep tailcat and Tailscale. Trust comes from:
  - **Little code of our own:** the helper is glue, about 250 lines, over libraries users already run (§2). The
    README says what is ours and what is imported, honestly: about 250 lines of ours on Podman's network stack,
    not "a small program".
  - **Reproducible binaries** for Linux, macOS and Windows, each on x86_64 and arm64, whose SHA-256 is published
    (the release, the README, the page's help). No code signing for now (Apple's or Authenticode would change the
    bytes; revisit if Gatekeeper, SmartScreen or Defender get in the way).
  - **Plain install lines**, one per platform and architecture: download with `curl` (PowerShell's
    `Invoke-WebRequest` on Windows) to `~/.local/bin` (`%LOCALAPPDATA%\Programs` on Windows), mark it executable,
    run it. No `curl | sh`. From source: `go install <module>@<version>`, checked against Go's checksum database.
- **Go:** easier to read than Rust for a reviewer, it cross-compiles all six targets with `CGO_ENABLED=0` from
  one host, and the library that does the work is Go. Go is already an accepted build dependency here.
- **Ethernet frames over a WebSocket, and no gateway in the page** for this kind: the helper's own DHCP, DNS and
  gateway serve the guest, and the page only forwards frames. Less code competing with the VM in the tab.
- **IPv4 only**, because the library is (§2), as long as the guest sees it cleanly: no router advertisement, so
  no IPv6 route, so nothing waits on IPv6 (§5).
- **Chromium's Local Network Access prompt** (a public site reaching loopback) is acceptable: one click.
- **Not WebSocket relays or Wisp** (v86's; [networking.md](networking.md) §1 stands), not a hosted proxy (the
  user won't operate an open proxy), not a WebTransport or LAN helper (served by tailnets), not the Direct Sockets
  API (Isolated Web Apps only, not a user path yet), not a helper assembled from QEMU and websockify or websocat
  (no good Windows story).

## 2. The helper

**What it imports:**
- **gvisor-tap-vsock** (`github.com/containers/gvisor-tap-vsock`, Apache-2.0; v0.9.0 checked): the networking of
  Podman machine on macOS, Windows and Linux, of Lima and CRC. `virtualnetwork.New(config)` is a userspace
  network on gVisor's netstack with a switch, ARP, DHCP, DNS and TCP, UDP and ICMP forwarders to the host's
  sockets; `vn.AcceptQemu(ctx, conn)` takes a `net.Conn` carrying Ethernet frames, each after a 4-byte big-endian
  length (QEMU's stream framing). Its stack registers only IPv4, ARP and ICMPv4 (`createStack` in
  `pkg/virtualnetwork/virtualnetwork.go`); IPv6 has been an open pull request for years
  ([#59](https://github.com/containers/gvisor-tap-vsock/pull/59)).
- **coder/websocket** (ISC; v1.8.15 checked): `AcceptOptions.OriginPatterns` checks the page's origin, and
  `websocket.NetConn` makes the socket the `net.Conn` the network takes.

What that pulls in: 19 modules (gVisor, miekg/dns, insomniacslk/dhcp, gopacket, inetaf/tcpproxy, logrus,
golang.org/x/…). A sketch of the whole helper built for all six targets: 11.9–13.1 MB stripped, 4.4–5.0 MB
gzipped, and byte-identical over two clean builds (Go 1.27.1, `CGO_ENABLED=0 -trimpath -ldflags='-s -w
-buildid='`). It carried no traffic yet.

**Others looked at** (2026-10-23, from their docs; none verified in source): xjasonlyu/tun2socks (gVisor, IPv6,
reportedly MIT, a GPL-3 fork of a similar name exists) takes IP packets, not frames, so ARP, DHCP, router
advertisements and DNS would be ours, several times the code; tailcat's exit node (gVisor, IPv4 and IPv6,
reportedly BSD-3) is behind WireGuard, not a library for a LAN; majek/slirpnetstack looks dormant and is built
around Linux file descriptors; jtolio/tinyemu-go's `slirp` (MIT, pure Go, no gVisor: a far smaller binary) is old
slirp, IPv4 only, of unknown speed and upkeep. Writing the network ourselves on gVisor would be a thousand lines or
more of ours. **If IPv6 is wanted later:** help #59 land upstream, or add an IPv6-only path beside it with
tun2socks-style forwarders.

**What it does:**
- Listens on `127.0.0.1` only (a port with a fixed default; `--listen` changes it).
- Accepts a WebSocket only on the path `/<token>` and only from allowed origins: `https://vm.tny.im` by default,
  `--origin` for a self-hosted copy (`npm run dist`) or the dev server. Without both, any site the user visits
  could use it as a way into their LAN. The token is random, kept in the user's config directory so a stored
  connection survives a restart of the helper (`--new-token` replaces it).
- Checks a subprotocol with a version (`webpc-net.v1`, provisional) so page and helper can refuse each other
  clearly.
- Prints the pairing link, `https://vm.tny.im/#net=ws://127.0.0.1:<port>/<token>`. The fragment never reaches the
  page's server or its logs.
- **One network per helper**, every WebSocket on its switch: two adapters or two machines attached to the same
  helper share a LAN and see each other (one user's machines; MACs are random per adapter).
- What the guest reaches: the internet and the host's LAN, as the user (as a tailcat exit node does). Not the
  host's own loopback unless `--host-loopback` (gvisor-tap-vsock's NAT table maps a gateway address to
  `127.0.0.1`). No guest-reachable API: gvproxy serves the library's port-forward endpoints on the gateway
  (`GatewayMux`); we don't. Ports from the host into the guest, if ever, are flags, not a guest API.
- Logs a line per connect and disconnect; nothing about the traffic.

## 3. The page

- **A connection kind `local`** in the connections store (web/app/connections.ts), whose settings are the URL
  (with its token, so a stored connection keeps a secret as tailcat's `exit` does). The pairing link fills the
  wizard's new-connection step; the wizard also shows the install line for the user's platform
  (`navigator.userAgentData.getHighEntropyValues(["architecture", "platform"])`, the others listed too) and the
  published hashes.
- **The client** opens the WebSocket and moves frames between it and the adapter's machine port, with QEMU's
  framing, several frames per message (as DERP's are joined, tailnet.md "Transports and DERP"). Where it runs (a
  small worker, or the page) is L0's question: the prompt's behavior in a worker and the CPU per Mbit decide.
- **No gateway:** the machine port's frames go to the helper untouched, and the helper's DHCP gives the guest its
  lease, routes and resolvers.
- **The primary** ([network-adapters.md](../network-adapters.md) §4): a connected `local` adapter reaches the
  internet, so it can be primary. Its lease always carries a default route (the helper's DHCP), which a
  non-primary adapter's mustn't: a `local` adapter ranks first among those that reach the internet, so a tailcat
  or tailnet adapter beside it gets the routed lease. Two `local` adapters both offer a default route; say so,
  don't fix it.
- **Errors:** the helper not running (the socket fails at once on loopback), the wrong token or origin, the prompt
  refused, the helper's version: each a plain message in the Network menu, with Retry. Reconnecting after the
  helper restarts keeps the guest's lease if the helper kept its network; otherwise the guest's next renewal
  fixes it.
- Snapshots: a connection isn't in the shape, so nothing changes; after a load the guest renews its lease.

## 4. Steps

- **L0, the spike** (not started): the sketch helper and a throwaway adapter on the page. Debian on the page gets a
  lease, resolves and runs `apt update` through it. Check in Chromium 153 whether the Local Network Access prompt
  appears for a WebSocket from the page and from a worker, whether a grant persists, and how Playwright grants it
  for tests. Measure, against tailcat through a public relay and against a tailcat exit node on this machine
  through a local `derper -dev` (what the relay costs apart from the crypto): round trip, throughput each way,
  the page's CPU per Mbit, the MTU (1500 against larger). Report in bench/net/REPORT.md with its JSON.
- **L1, the helper's repository:** flags, the kept token, origins, the subprotocol, logs; a README that states
  the code ours and imported, the install lines, the hashes and how to rebuild them; the pinned toolchain in
  `go.mod`; releases built here, checked by a second build elsewhere.
- **L2, the page:** the kind, the wizard's steps, the client, the primary's rule, the errors.
- **L3, tests and docs:** a Chromium test in `scripts/ci-net.sh` with the helper at a pinned version (`go
  install`, as `tests/net/tailcat.sh` pins tailcat): Debian's lease, a TCP transfer to a server on this machine, a
  wrong token and a wrong origin refused, and the IPv6 checks of §5. The framing's unit tests in Node. How it
  works goes into tailnet.md's neighbor (a page of its own, or network-adapters.md), frontend.md "Network" and
  the backlog's loose ends.
- **L4, release:** the first release and the deploy, with the user.

## 5. IPv6 absent, cleanly

Without the page's gateway nothing sends a router advertisement, so the guest has only its link-local IPv6
address and no IPv6 route. glibc's `getaddrinfo` with `AI_ADDRCONFIG` (most programs) then asks for no AAAA
records, and a program that tries an IPv6 address anyway gets "network unreachable" at once, so dual-stack
programs fall back without waiting. DHCPv6 goes unanswered, which shouldn't hold up boot
(`systemd-networkd-wait-online` is satisfied by an IPv4 route). To check (L0, then L3): `curl` and `apt update`
against dual-stack hosts (Debian's mirrors have AAAA records) with the time to the first byte close to an
IPv4-only run's, `getent ahosts` returning only IPv4, boot time to the network unchanged. The dev VM has no IPv6
of its own, so IPv6 beyond it couldn't be tested here anyway.

## 6. Open questions

- The kind's name on the page ("This computer", "Local helper", …) and the helper's.
- The default port.
- Where the install lines download from: GitHub's releases (one more party users already know) or vm.tny.im.
- Whether gvisor-tap-vsock's DNS forwarder follows the host's resolvers on every platform (Windows especially).
- What Defender and SmartScreen make of an unsigned Go binary fetched by `Invoke-WebRequest`; Firefox's and
  Safari's handling of `ws://127.0.0.1` from an https page (never blockers).
