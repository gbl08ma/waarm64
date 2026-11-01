# A local network helper (L0 and L1 done; L2 next)

A third kind of connection, beside a tailnet and tailcat ([network-adapters.md](../network-adapters.md) §1): a
small program the user runs on their own computer, which the page reaches over a WebSocket on loopback and which
puts the guest's traffic on the host's own sockets. It is for the user who runs their own machine for a long
while and wants a fast connection they trust; the demo's connection (a snapshot and a disk over HTTP, online with no
setup) is a separate problem, and one of the proxies, VPNs or Workers explored for it will serve it.

Why: a browser has no UDP, so tailcat and a tailnet always go through DERP. The public relays are far from many
users, rate-limited and best-effort: under 20 Mbit/s and a relay's round trip in the user's experience, and a
friend's tailcat connection behaves worse still. A helper on the user's machine has the latency of loopback and
the user's own uplink. Every name here (`webpc-net`, the subprotocol, the kind) is provisional: the project's
name may change. **Where it stands:** NET-HANDOVER.md in the repository's root while the track is open; the helper's own
README, THIRD_PARTY.md and CLAUDE.md are in `net/webpc-net/`.

## 1. Decisions (the user's, 2026-10-23)

- **A helper of ours, in Go, in its own repository** (`gbl08ma/webpc-net`, provisional). Users who don't want to
  trust us keep tailcat and Tailscale. **Until the bulk of it is done it lives in this repository**, in
  `net/webpc-net/` (the user's, 2026-11-01: page and helper change together while they're young), already under its
  final module path `github.com/gbl08ma/webpc-net` and with its own README, THIRD_PARTY.md, CLAUDE.md and
  `build.sh`, importing nothing of webpc's, so the move is a `git filter-repo` of one directory. What waits on the
  move: releases (GitHub's, built there), the second host's reproducibility check against them, and `go install`
  (which also waits on the IPv6 fork below). Trust comes from:
  - **Little code of our own:** the helper is glue over libraries users already run (§2). The README says what is
    ours and what is imported, honestly: about 650 lines of ours (the 250 first guessed grew with IPv6's reach, the
    refusals that tell the page why, and the frames' batching) on Podman's network stack, not "a small program".
  - **Reproducible binaries** for Linux, macOS and Windows, each on x86_64 and arm64, whose SHA-256 is published
    (the release, the README, the page's help). No code signing for now (Apple's or Authenticode would change the
    bytes; revisit if Gatekeeper, SmartScreen or Defender get in the way).
  - **Plain install lines**, one per platform and architecture: download with `curl` (PowerShell's
    `Invoke-WebRequest` on Windows) to `~/.local/bin` (`%LOCALAPPDATA%\Programs` on Windows), mark it executable,
    run it. No `curl | sh`. From source: `go install <module>@<version>`, checked against Go's checksum database
    (once the `replace` below is gone: `go install` refuses a module with one).
- **Go:** easier to read than Rust for a reviewer, it cross-compiles all six targets with `CGO_ENABLED=0` from
  one host, and the library that does the work is Go. Go is already an accepted build dependency here.
- **Ethernet frames over a WebSocket, and no gateway in the page** for this kind: the helper's own DHCP, DNS and
  gateway serve the guest, and the page only forwards frames. Less code competing with the VM in the tab.
- **IPv6 on by default (the user's, 2026-11-01)**, through gvisor-tap-vsock's unmerged
  [#745](https://github.com/containers/gvisor-tap-vsock/pull/745) (§2), **but never promised when the host can't
  route it**: the guest gets a default IPv6 route only while the helper's host reaches the internet over IPv6, as the
  page does for tailcat's and a tailnet's far end (§5). `--no-ipv6` gives IPv4 only. (This replaces "IPv4 only,
  because the library is".)
- **Chromium's Local Network Access prompt** (a public site reaching loopback) is acceptable: one click. In Chromium 153 the
  permission is `loopback-network`; bench/net/REPORT.md "The local helper" has what L0 found.
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
  length (QEMU's stream framing). v0.9.0's stack registers only IPv4, ARP and ICMPv4; IPv6 was an open pull request
  for years ([#59](https://github.com/containers/gvisor-tap-vsock/pull/59)), and
  **[#745](https://github.com/containers/gvisor-tap-vsock/pull/745)** (evidolob, built on #59 and karta0807913's
  fixes; open, unreviewed, last pushed 2026-10-21) makes it an opt-in `EnableIPv6`: the gateway's IPv6 address and a
  /64, router advertisements (answered to solicitations only, with the M and O flags, the prefix for SLAAC and a
  1000 s router lifetime), DHCPv6 with the gateway as the resolver, the DNS server on IPv6, AAAA by family. Its TCP
  and UDP forwarders dial the host's sockets by address, so IPv6 out needs no NAT66; its ICMP forwarder is IPv4's only
  (the gateway answers its own pings). **How go.mod takes it:** the fork's `go.mod` still says
  `module github.com/containers/gvisor-tap-vsock`, so it can't be required by its own path; `replace
  github.com/containers/gvisor-tap-vsock => github.com/evidolob/gvisor-tap-vsock v0.0.0-20261021084248-7fea9a947613`
  pins one commit of the branch (`guillaumerose-ipv62-fixes`), and Go's module proxy keeps that version once fetched,
  so the branch's force-pushes don't break builds; `go.sum` checks it. Weighed against a fork of our own (a stable
  branch, and `go install` if its module path were renamed, at the price of an import path to undo later) and
  vendoring (a large diff here): the `replace` is the smallest and the easiest to drop. Drop it, and require the
  release, when #745 lands. The fork needs Go 1.26.
- **coder/websocket** (ISC; v1.8.15 checked): `AcceptOptions.OriginPatterns` checks the page's origin, and
  `websocket.NetConn` makes the socket the `net.Conn` the network takes.

What that pulls in: 19 modules linked on Linux and Windows, 16 on macOS (gVisor, miekg/dns, insomniacslk/dhcp,
gopacket, inetaf/tcpproxy, logrus, golang.org/x/…; all permissive, listed with their licenses in
`net/webpc-net/THIRD_PARTY.md`). The helper (with #745) built for all six targets: 12.5–13.8 MB stripped, 4.7–5.3 MB
gzipped, byte-identical over two clean builds on one host (Go 1.27.3, `net/webpc-net/build.sh`: `CGO_ENABLED=0
-trimpath -buildvcs=false -ldflags='-s -w -buildid='`, 2026-11-01).

**Others looked at** (2026-10-23, from their docs; none verified in source): xjasonlyu/tun2socks (gVisor, IPv6,
reportedly MIT, a GPL-3 fork of a similar name exists) takes IP packets, not frames, so ARP, DHCP, router
advertisements and DNS would be ours, several times the code; tailcat's exit node (gVisor, IPv4 and IPv6,
reportedly BSD-3) is behind WireGuard, not a library for a LAN; majek/slirpnetstack looks dormant and is built
around Linux file descriptors; jtolio/tinyemu-go's `slirp` (MIT, pure Go, no gVisor: a far smaller binary) is old
slirp, IPv4 only, of unknown speed and upkeep. Writing the network ourselves on gVisor would be a thousand lines or
more of ours. IPv6 came from #745 (above); had it not, the choice was helping #59 land or an IPv6-only path beside it
with tun2socks-style forwarders.

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
- **Refuses with a reason:** the handshake completes and the socket closes with 4001 (another version), 4003 (origin
  not accepted) or 4004 (wrong token), so the page can say which (a browser shows a WebSocket no HTTP status). The
  cost: any page can learn that a helper listens (Chromium's Local Network Access prompt gates that first).
- **Frames:** each binary message one or more whole frames in QEMU's framing, both ways; the frames the switch writes
  while a message is on its way go out together as the next one. What waits for a slow page is bounded (4 MiB), and
  past it frames drop as a full NIC queue drops them: the library's switch writes to every link under one lock, so a
  link that blocked would stall the others.
- Logs a line per connect and disconnect; nothing about the traffic.

## 3. The page

- **A connection kind `local`** in the connections store (web/app/connections.ts), whose settings are the URL
  (with its token, so a stored connection keeps a secret as tailcat's `exit` does). The pairing link fills the
  wizard's new-connection step; the wizard also shows the install line for the user's platform
  (`navigator.userAgentData.getHighEntropyValues(["architecture", "platform"])`, the others listed too) and the
  published hashes.
- **The client** opens the WebSocket and moves frames between it and the adapter's machine port, with QEMU's
  framing, several frames per message (as DERP's are joined, tailnet.md "Transports and DERP"). **In a small worker,
  and batched** (measured, L0; bench/net/REPORT.md "The local helper"): a worker takes half a core off the main thread at no
  cost, and a worker's socket makes the permission's request as the page's does; flushing on `setTimeout(0)` instead of a microtask
  doubles the upload (357 to 766 Mbit/s) without moving the round trip. L0's spike does neither yet.
- **No gateway:** the machine port's frames go to the helper untouched, and the helper's DHCP gives the guest its
  lease, routes and resolvers.
- **The primary** ([network-adapters.md](../network-adapters.md) §4): a connected `local` adapter reaches the
  internet, so it can be primary. Its lease always carries a default route (the helper's DHCP), which a
  non-primary adapter's mustn't: a `local` adapter ranks first among those that reach the internet, so a tailcat
  or tailnet adapter beside it gets the routed lease. Two `local` adapters both offer a default route; say so,
  don't fix it.
- **Errors:** the helper not running (the socket fails at once on loopback), the wrong token or origin, the prompt
  refused, the helper's version: each a plain message in the Network menu, with Retry. A refused prompt and a helper
  that isn't running look the same to the socket (1006 within milliseconds): `navigator.permissions.query({ name:
  'loopback-network' })` tells them apart, and a refusal stays until the user changes the site's settings, so the message
  says where.
- **The MTU:** 1500 for now. A larger one isn't possible as things stand: `web/offload.ts` drops a plain frame past
  `MAX_FRAME`, so uploads stall (L0 saw 0.1 Mbit/s). With that raised, 65520 gave 1.4 Gbit/s up and 1 Gbit/s down on a sixth
  to a third of the CPU per Mbit (one boot each, unbatched). L2 raises it for frame ports and measures it with the worker and
  batching; the helper's TCP is terminated, so the guest's segments never reach the internet at that size, but its UDP does. Reconnecting after the
  helper restarts keeps the guest's lease if the helper kept its network; otherwise the guest's next renewal
  fixes it.
- Snapshots: a connection isn't in the shape, so nothing changes; after a load the guest renews its lease.

## 4. Steps

- **L0, the spike** (done 2026-11-01): the helper (`net/webpc-net`, with IPv6) and a throwaway adapter on the page
  (`?localnet=` or `#net=` at a machine's start puts its first adapter's frames on the helper: web/local-net.ts;
  `tests/browser/netguest.html?ws=` for the test).
  - **Done** (2026-11-01, a cloud session, then the dev VM: bench/net/REPORT.md "The local helper"): the helper and its Go tests; the spike
    adapter; `tests/net-local.test.ts`: Debian on the page gets the helper's lease at boot, resolves through it, moves
    8 MiB each way to a server on the host, runs `apt-get update`; IPv6 on the link without a default route on a host
    without IPv6 (§5); a wrong token and another origin refused from Chromium.
  - **Answered in the dev VM** (bench/net/REPORT.md "The local helper"): `scripts/ci-net.sh` passes with `net-local` in it
    (8 MiB at 432 and 291 Mbit/s); Local Network Access (the `loopback-network` permission gates a public page's socket, from
    a worker too; a stored grant survives restarts; CDP's `Browser.setPermission` for tests); against tailcat (1.8 ms and 556/355
    Mbit/s, against 2.0 ms and 123/218 through a relay here and 101 ms and 4/19 through a public one), which settled
    a worker and batching (§3) and the MTU's limit; IPv6 on the Mac, and the reach changing under a running guest (a
    namespace), the default following within a minute. That also found the gateway not saying it's a router (§5).
  - **Not seen:** the prompt itself, which needs a headed browser: the user's, at L2.
- **L1, the helper's repository:** flags, the kept token, origins, the subprotocol, logs; a README that states
  the code ours and imported, the install lines, the hashes and how to rebuild them; the pinned toolchain in
  `go.mod`; releases built here, checked by a second build elsewhere.
  - **Done** (2026-11-01, a cloud session): the flags as L0 made them, with a usage text, the MTU bounded (1280 to 65520,
    576 with `--no-ipv6`), no arguments, a taken port said as such (`main_test.go`); the README's install lines (one
    block per target: `curl` or `Invoke-WebRequest` to `~/.local/bin` or `%LOCALAPPDATA%\Programs\webpc-net`, the
    SHA-256 checked before it's made executable), the flags' table, the logs and where the token is kept; `build.sh`
    writes the release: the six binaries at the baseline levels (`GOAMD64=v1`, `GOARM64=v8.0`, so a host's environment
    can't change the bytes), `LICENSES.txt` (`licenses.sh`: every linked module's own license, notice and patent files,
    Go's first, failing on a module without one), SHA256SUMS over them, and `INSTALL.md` (the install lines with the
    hashes, for the release notes and the README); `--check` rebuilds a version and compares with published sums. The
    helper has its own `LICENSE` now. Two clean builds matched on x86_64 Linux
    (`bench/net/results/local-helper/build-x86_64.txt`); the Linux install line ran against a `file://` copy.
  - **Left:** the second host's check (the dev VM, arm64: `build.sh --check` against that file, from the same source);
    GitHub's releases wait on the move (L3/L4, and the download location in §6).
- **L2, the page:** the kind, the wizard's steps, the client, the primary's rule, the errors.
- **L3, tests and docs:** a Chromium test in `scripts/ci-net.sh` with the helper at a pinned version (`go
  install`, as `tests/net/tailcat.sh` pins tailcat): Debian's lease, a TCP transfer to a server on this machine, a
  wrong token and a wrong origin refused, and the IPv6 checks of §5 (`tests/net-local.test.ts` has most of these
  already, from L0, building the helper from its directory; `go install` once the repository is its own). The framing's unit tests in Node. How it
  works goes into tailnet.md's neighbor (a page of its own, or network-adapters.md), frontend.md "Network" and
  the backlog's loose ends.
- **L4, release:** the first release and the deploy, with the user.

## 5. IPv6 as far as the host has it

The guest always has IPv6 on the link: the helper's /64 (`fd77:6562:7063::/64`, a ULA of ours) by SLAAC and DHCPv6,
the gateway and its resolver at `::1`. **The default route is the question.** If the router advertisement offered one
while the host has no IPv6 out, the guest's IPv6 SYNs would go to the helper, whose forwarder can't dial and answers a
reset: better than tailcat's exit node (which accepts and closes empty, so curl and browsers never fell back,
network-adapters.md §4 "IPv6 out"), but each connection would still try IPv6 first and fail. So the helper does what
the page does for a tunnel's far end (web/reach6.ts), from the host's own sockets: a DNS query for the root's NS
records over IPv6 to Cloudflare's, Google's and Quad9's resolvers at once, any answer counting, at the start and every
minute; three lost in a row (3 s each) make IPv6 out, one answer brings it back, and until the first answer it is out.
While out, every router advertisement to a guest has its router lifetime rewritten to 0 (`ra.go`): the prefix stays on
the link and the default route goes, so the guest's IPv6 to the internet fails at once ("network unreachable") and
dual-stack programs use IPv4 without a wait. glibc's `AI_ADDRCONFIG` still asks for AAAA (the ULA counts as an
address), which costs nothing more since the connect fails at once.

The library answers router solicitations only (Linux sends them when the link comes up) with a 1000 s router lifetime
and sends nothing unsolicited, so the helper sends solicitations into the switch on each guest's behalf (their MACs,
learned from their frames): when the reach changes (the guest's default moves at once both ways), when a guest first
appears on a link (a page reconnected under a running guest), and every 5 minutes (else the default would lapse after
1000 s). `--no-ipv6` turns IPv6 off in the library: no router advertisement, only the link-local address, which
glibc's `AI_ADDRCONFIG` ignores, and DHCPv6 unanswered, which doesn't hold up boot (`systemd-networkd-wait-online` is
satisfied by IPv4).

**The gateway has to say it's a router.** gVisor sets a neighbor advertisement's Router flag only on a forwarding stack, and
the library's doesn't forward; Linux takes that as its router having become a host and drops the default route when it next
checks the neighbor, 5.4 s after traffic pauses, until the next router advertisement. So `markRouter` (`ra.go`) sets the flag on
the gateway's advertisements, and only the gateway's: another guest on the switch isn't one.

**Checked:** `helper_test.go` (a solicitation answered with a default route while the probe's resolver answers, an
unsolicited advertisement without one when it stops and with one when it answers again, valid checksums; nothing
with `--no-ipv6`); `tests/net-local.test.ts` on the cloud container, which has no IPv6 at all: the guest's address
in the /64, the gateway's ping, no default route, `curl` to an IPv6 address failing at once (exit 7), a dual-stack
name connecting over IPv4 at once. On the Mac, with its real IPv6: the default route, `curl` and `apt` over IPv6 out, the default still there after 40 s idle. In a
network namespace, the probe's address removed and put back under a running guest: the default gone in 48 s and back in 60 s, `curl`
failing at once in between (`bench/net/local-ipv6.ts`).

## 6. Open questions

- The kind's name on the page ("This computer", "Local helper", …) and the helper's.
- The default port.
- Where the install lines download from: GitHub's releases (one more party users already know) or vm.tny.im.
- Whether gvisor-tap-vsock's DNS forwarder follows the host's resolvers on every platform (Windows especially: it
  asks Go's `net.Resolver`, the system's own there, and forwards other types to `/etc/resolv.conf`'s servers, which
  Windows hasn't).
- When #745 lands, or whether it stalls: then a fork of ours with the module path renamed is what gives `go install`
  back (§2).
- What Defender and SmartScreen make of an unsigned Go binary fetched by `Invoke-WebRequest`; Firefox's and
  Safari's handling of `ws://127.0.0.1` from an https page (never blockers).
