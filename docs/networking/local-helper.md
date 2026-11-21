# The local network helper

The third kind of connection, beside a tailnet and tailcat ([adapters.md](adapters.md) §1): **waarm64-net**,
a program the user runs on their own computer. The page reaches it over a WebSocket on loopback, and the guest's
traffic goes out through that computer's sockets, at loopback's latency and the user's own uplink. tailcat and
Tailscale always go through DERP, because a page has no UDP.

The helper is its own repository, [`github.com/gbl08ma/waarm64-net`](https://github.com/gbl08ma/waarm64-net) (private
until the user makes it public). Its README covers the flags, the network it serves, the protocol and the trust
argument, its THIRD_PARTY.md what it links, and its CLAUDE.md its rules. This page covers waarm64's side. The decisions
and their history are in [plans/networking-local.md](../plans/networking-local.md).

## The helper, briefly

- **Go glue over gvisor-tap-vsock** (Podman machine's and Lima's network, on gVisor's netstack), about 1,050 lines of
  ours. Its IPv6 comes from the unmerged [#745](https://github.com/containers/gvisor-tap-vsock/pull/745), taken by a
  `replace` to its author's fork at one commit. Because of that `replace`, `go install` refuses the module.
- **Listens on `127.0.0.1:8740`** (`--listen`). It accepts a WebSocket only on `/<token>`, only from an allowed origin
  (`https://waarm64.com`, plus each `--origin`, matched exactly), and only with the subprotocol `waarm64-net.v1`. A refusal
  completes the handshake and closes with 4001 (another version), 4003 (the origin) or 4004 (the token), so the page
  can say which. The token is kept in the user's config directory, so a paired page keeps working across restarts.
- **Prints the pairing link**, `https://waarm64.com/#net=ws://127.0.0.1:<port>/<token>`, and one for each `--origin`.
- **One network per helper:** DHCP on `192.168.127.0/24` with the gateway and resolver at `.1`, and IPv6 on
  `fd77:6562:7063::/64` unless `--no-ipv6`. Every page connected to one helper is on the same switch. The guest
  reaches the internet and the LAN, and reaches the host's own loopback only with `--host-loopback`
  (`192.168.127.254`). The helper drops the guest's packets to `0.0.0.0/8`, `127.0.0.0/8`, `::`, `::1` and
  IPv4-mapped addresses, which the forwarders would dial as this computer's own loopback. The network knows a guest
  by its MAC, so two machines need different MACs to get different addresses.
- **Each guest's address is kept across a restart** (`leases-<address>` beside the token, the 100 most recently
  connected MACs): the library's DHCP pool lives in memory and hands out addresses in order, and a page reconnecting
  to a restarted helper doesn't make its guest ask again, so two running guests could otherwise swap or share an
  address. What's kept comes from the pool, for MACs seen on a link, never from frames a guest could make up.
- **IPv6 out only while the host has it.** The helper asks three public resolvers over IPv6 every minute. While none
  answers, its router advertisements carry no default route, so the guest's IPv6 to the internet fails at once and
  programs fall back to IPv4 without waiting, as the page does for a tunnel's far end ([adapters.md](adapters.md)
  §4 "IPv6 out"). The helper also solicits advertisements on each guest's behalf, and sets the Router flag on its
  gateway's neighbor advertisements. Upstream does neither, so without them the guest's default route would lapse.
- **The MTU is 1500** (`--mtu` takes 1280 to 65520). 65520 is about 1.7× faster down and 1.6× up here
  (bench/net/REPORT.md "The stalled uploads"), but 1500 is what every protocol expects (the user's call, 2026-11-02).

## The page's side

- **The kind `local`** (web/app/connections.ts). Its record holds the link, `local.url`, which carries the token: a
  secret, as tailcat's `exit` is ([adapters.md](adapters.md) §2.1).
- **The pairing link** (web/app/areas/page-window.ts `takePairing`): `#net=ws://…` is taken out of the address at once and opens the Network
  wizard on [Your computer (waarm64-net)](ui:network:NetKindStep.kind.pickLocal) with the link filled in. Pasting the
  link, or just its `ws://` part, does the same (web/local-net.ts `parseLocalURL`). The wizard's steps are in
  [frontend.md](../frontend.md) "Network".
- **The install lines** (web/local-release.ts): the release the page offers (`RELEASE`: its version and SHA256SUMS),
  and for each of the six targets the same lines as the release's `INSTALL.md`: download, check the SHA-256, make it
  executable, run it. The browser's platform is picked from its client hints, with a choice of the others.
- **The client** runs in a worker (web/local-net-worker.ts, started by web/local-net.ts `startLocal`). It moves frames
  between the adapter's frame port and the WebSocket in QEMU's framing (each frame after its 4-byte big-endian length,
  several per message). A batch flushes on `setTimeout(0)`, or early at `LOCAL_MAX_MESSAGE` (1 MiB): past that the
  helper closes the socket.
- **No gateway in the page.** The card goes onto a frame port (web/gateway.ts `FramePath`), and the helper's DHCP,
  DNS and gateway serve the guest. Switching between the page's gateway and the helper flaps the card's link, so the
  guest asks for a new lease at once; a reconnect to the same helper doesn't flap it ([devices.md](../devices.md) "net",
  [adapters.md](adapters.md) §4).
- **The primary:** a connected `local` adapter ranks first among the adapters that reach the internet (`primaryOf`).
  Its lease always carries a default route, so a tailcat or tailnet adapter beside it gets the routes-only lease.
- **Errors**, each a sentence in the Network menu with Retry (web/local-net.ts): the helper not reached
  ([Couldn't reach the helper. Check that waarm64-net is running on your computer.](ui:network:local-net.unreached)), the close codes, the helper closing, and Chromium refusing
  this origin loopback.

## Local Network Access

A public page reaching loopback is gated by Chromium's Local Network Access. The permission is `loopback-network`
(Chromium 153), asked once by a prompt, from the page or from a worker. A refused socket closes with 1006 within
milliseconds, the same as a helper that isn't running, so the page asks `navigator.permissions.query({ name:
'loopback-network' })` (`loopbackRefused`) and says where the setting is ([This browser doesn't let this site reach the helper on your computer. Click the icon left of the address, choose Site settings, allow “Local network access”, and connect again.](ui:network:local-net.refused)).
A refusal sticks until the user changes the site's settings. The user saw the prompt on the deployed page, in an
Incognito window too (2026-11-02).

A page on `127.0.0.1` isn't gated, which is why most tests never meet it. To test the gate, Chromium is launched with
`--ip-address-space-overrides=127.0.0.1:<port>=public`, and a grant goes through CDP's `Browser.setPermission`
(Playwright 1.63's `grantPermissions` doesn't know the name). bench/net/REPORT.md "The local helper" has what L0
measured.

## Releases and the pinned commit

The helper's releases are built by its own GitHub Actions, separately from waarm64's deploy (the user's, 2026-11-02).
A `v*` tag is built on an x86_64 and an arm64 Linux runner, and the release is published only when the two builds
are byte-identical. **The page offers a release** once `web/local-release.ts` takes its version and SHA256SUMS, in a
change of waarm64's. v0.4.0 is the current one (its default origin `https://waarm64.com`; v0.1.0's and v0.3.0's sums also matched a build in the dev VM: `bench/net/results/local-helper/build-v0.3.0-aarch64.txt`). A release is cut only
after an out-of-context review of what it adds (the user's, 2026-11-03: each one costs runner minutes).

**waarm64's tests build the helper at the commit `tests/waarm64-net.ts` pins** (v0.4.0's). The commit is fetched with git
into `target/net/waarm64-net-src`, over HTTPS or else SSH, and built into `target/net/waarm64-net`. With
`WAARM64_NET_SRC=../waarm64-net` they build a checkout of yours instead, which is how to work on the page and the helper
together. Where the commit can't be fetched (a cloud session, while the repository is private), those tests say
SKIPPED. Move the pin when the page needs a change of the helper's, after the helper's CI has passed.

**Taking a release:** tag it in waarm64-net, wait for its release workflow, then put the version and the sums in
`RELEASE` (`tests/local-release.test.ts` checks the page's lines against `build.sh --install`'s for them), and usually
move the pin to the tag's commit.

## Tests

[testing.md](../testing.md)'s row for the local network helper lists them all. In short:
- `tests/local-net.test.ts` and `tests/local-release.test.ts` (`npm test`): the framing, the batches under the limit,
  the pairing link, the lease read from the helper's DHCP, and the install lines.
- `tests/page-local.test.ts` (`npm test`, ~30 s): the page with the real helper, from the pairing link through the
  wizard to a connected adapter, a stopped helper, and Retry. Also a public origin: connected once the permission is
  granted, and the refusal said.
- `tests/net-local.test.ts` (`scripts/ci-net.sh`, ~2 min): Debian on the page through the helper, covering the
  switch from the page's gateway, DNS, 8 MiB each way, `apt-get update`, IPv6 as the host has it, and the refusals.
- The helper's own `go test -race`, in its repository and its CI.

## Numbers

From bench/net/REPORT.md "The local helper" and "The stalled uploads", Debian on the page in the dev VM, one boot each:
about 0.6 Gbit/s down and 0.95 Gbit/s up at MTU 1500 with the worker and batching (1.1 and 1.5 at 65520). For
comparison, tailcat on this machine gave 556/355 Mbit/s at 1.8 ms, and through a public DERP relay 4/19 at 101 ms.

## Found (worth not re-discovering)

- **systemd-networkd ignores a carrier loss under 5 s** when the lease's MTU isn't the link's original one (systemd
  257's `link_carrier_lost`), so a link flap lasts 7 s (`FLAP_MS`).
- **A message past the helper's 1 MiB closes the socket.** The card then stays up on frames to nothing, which looks
  to the guest like a stall, then new connections failing.
- **gVisor's neighbor advertisements lack the Router flag** on a non-forwarding stack, and Linux then drops the
  default route 5.4 s after traffic pauses. A default route that vanishes with nothing logged is this kind of thing.
- **The guest's UDP to `0.0.0.0` reached the host's `127.0.0.1`** (and `::ffff:0.0.0.0` too), without
  `--host-loopback`: gVisor drops other loopback destinations, not these, and the forwarders dial what they're given.
  A static review found it, after v0.1.0. The helper's `TestNoHostLoopbackUDP` covers each address.
- **A browser fails a WebSocket handshake whose answer names no protocol it offered** (1006, no close code), so a
  refusal of another version needs that version answered first. The helper does so since v0.1.1.
- **#745's ICMP forwarder is IPv4's only:** the guest can't ping the internet over IPv6 (the gateway answers its own pings).
- **Lima forwards the dev VM's loopback ports to the Mac's:** a tunnel's local port and a helper on the Mac need
  different ports.
