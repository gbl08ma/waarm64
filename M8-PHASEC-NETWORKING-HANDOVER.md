**Handover, 2026-09-29 (cloud session): the networking lane (docs/plans/networking.md) is at N4 done and
N5 half done: the Network menu on the page connects, logs in, keeps the node and reconnects. What's
left needs things this session couldn't have: images, a tailnet with an exit node, a real
control server's login, and the user's OK for a test-guest change.**

For whoever continues the lane. Read docs/plans/networking.md (§7 steps) and docs/frontend.md
"Network" first; this file is what they don't say.

## Done in this session (branch `claude/ecstatic-fermi-8amxam`)
- **N5, connect/login on the page** (`web/app/network.ts`, `main.ts`, `index.html`, `worker.ts`,
  `machine.ts`, `web/tailscale.ts`, `web/tailscale-worker.ts`, `net/tailscale/main_js.go`): a Network
  menu for Debian; Connect (control server, hostname, optional auth key) restarts the machine with a
  card (`ToWorker.start.ip`); the login link; state dot; Disconnect, Log out, Remove card; the
  node's state in IndexedDB (`ephemeral: false` in the Go client when state is kept) with automatic
  reconnect; a restarted machine's new port is handed to the running client (`attach`).
- **The card configures itself:** `machine.network.cmdline` unmasks networkd and resolved and
  passes a `network.network.card` credential. **`ip=dhcp` was tried first and is wrong**: Debian's
  initramfs reads it and waits for a lease before booting, so a machine not yet connected sat at the
  root mount for minutes (the page test found it).
- **Tests:** `tests/network.test.ts` (controller, fake client), `tests/net-guest.test.ts` (Debian,
  card on the echo gateway: configures itself, pings any address and the router: **this is the
  smoke test that pings from inside Debian without a tailnet**, ~1.5 min),
  `tests/page-network.test.ts` (the menu against an unreachable control server, ~3 min),
  `tests/serial-console.ts` (helpers shared with `tests/net-tailnet.test.ts`).
  All pass in Chromium 141 here. `tests/net-tailnet.test.ts` (N4: Debian pings a tailnet peer
  through headscale, resolves it by MagicDNS, the peer reaches a guest server) already existed and
  **could not run in this session** (see "Blocked").
- **`scripts/ci.sh` now sets `WEBPC_TAILNET=1` when `podman` exists and Debian is in
  `WEBPC_DISTROS`** (`WEBPC_TAILNET=0` skips it). It and the two new Debian tests take turns through
  the Debian lock, so CI grows by ~7 min: the user may want to gate them differently.
- **`tests/debian-lock.ts`:** the "EXPERIMENT: no lock" bypass, which loop 8 had committed by
  mistake, is removed (the lock is back). Full `npm test` with `WEBPC_DISTROS=debian`, both Debian page tests
  chained by the lock: 191 pass, 0 fail (`timer.bin` in parallel mode included). Read as "the
  experiment line goes"; if the user meant dropping the lock itself, that's a separate run with the
  lock bypassed (the earlier notes say the lock exists so two realtime Debian boots don't load the
  host into failing 1 ms windows).
- Cloud support (earlier in the session): `scripts/cloud-setup.sh`, `.claude/settings.json`,
  `docs/cloud.md`; merged to `main`.

## Follow-ups, in the order they matter
1. **N3's Buildroot boot** (docs/plans/networking.md N3): a Buildroot boot that takes a DHCP lease
   from the gateway and pings through it, deterministic with exact step counts (like
   `/test-devices.sh`), natively too with a Rust twin in `core/tests/common`. Not done: it needs the
   images (not buildable in the cloud) and changes the test guest's bytes, which needs the user's
   OK. The gateway itself and its byte-level tests are done (`web/gateway.ts`, `tests/gateway.test.ts`).
2. **The Alpine `apk add` smoke test** (N5): needs an Alpine image with a card and a tailnet whose
   exit node reaches the internet. The local test tailnet (`tests/net/tailnet.sh`) has no exit node,
   which is why it can't run there. Until then, the tailnet ping from Debian is the smoke test
   (above), and an Alpine variant of it (busybox `udhcpc`, `ping` a peer) is the cheap step: it needs
   only the Alpine image and the existing tailnet. To do `apk add` for real: make the headscale
   test peer an exit node (`--advertise-exit-node`, approve its routes, IP forwarding and NAT in its
   container) and set the exit node in the client (below).
3. **Exit-node selection:** the netmap lists `exitNodeOption` peers; the Go side has to set
   `ipn.Prefs.ExitNodeID` (a `setExitNode` call in `main_js.go`, `MaskedPrefs` through
   `lb.EditPrefs`) and the menu needs a list. The DNS of an exit node's resolvers changes the lease.
4. **A real interactive login, by hand:** against Tailscale's service and against a headscale
   (the tests only use auth keys and an unreachable server). Check that the login link opens, that
   the client comes up after it, the "waiting for approval" state, and that a reload reconnects
   without a login (the IndexedDB state; the `ephemeral: false` path in Go is untested for real).
   Note the CORS requirement on `/key` for a Headscale (frontend.md "Network").
5. **IPv6:** the netmap has the `fd7a:115c:a1e0::/48` address; the gateway drops IPv6 (routers
   advertisements plus a static address, after IPv4).
6. **The DOM of the menu is only lightly tested** (page-network.test.ts); the login-URL and
   approval states are covered by `viewOf` unit tests, not in Chromium.
7. **Page details left:** a per-machine "network" toggle for Buildroot doesn't exist (no card in
   its kernel); Reset disk and Remove card each restart; the auth key field is a plain password
   input (no reveal). A card-less boot is byte-for-byte the old command line: the measured boot
   times don't change.
8. **Chromium 141 vs 153:** everything here ran in the Playwright Chromium the cloud has (141),
   not the dev VM's 153.

## Blocked in this session, and why
- **Podman/Docker for the tailnet.** The cloud has no Podman; `docs/cloud.md` describes starting
  `dockerd` and a `podman` shim. The harness's permission check refused starting the daemon and
  creating the shim ("Security Weaken"), and I didn't work around it. So `tests/net-tailnet.test.ts`
  and N4's re-verification did not run after this session's changes to `web/tailscale*.ts` and
  `main_js.go`; only the build of the Go client (`net/tailscale/build.sh`, ok) and the tests above
  did. **Run `WEBPC_TAILNET=1 node --test tests/net-tailnet.test.ts` locally first**: the client
  worker changed (attach/detach, persisted state, the `ephemeral` config), and that test is what
  exercises them against a real control server. An alternative that avoids the daemon is building
  headscale and `tailscaled` from source with Go and running them natively; not tried, since it
  pursues the same outcome and the user should decide.
- The user's "images can't be built in the cloud" holds (arm64 images, no Podman): Alpine and
  Buildroot work are local.
