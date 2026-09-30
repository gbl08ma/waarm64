**Handover, 2026-09-29 (cloud sessions): the networking lane (docs/plans/networking.md) is at N4 done
and N5 mostly done: the Network menu on the page connects, logs in (checked by hand), keeps the node,
reconnects and selects an exit node, with the internet and its DNS through it. What's left needs
images (Alpine, Buildroot) and the user's OK for a test-guest change.**

For whoever continues the lane. Read docs/plans/networking.md (§7 steps) and docs/frontend.md
"Network" first; this file is what they don't say.

## Done in this session (branch `claude/ecstatic-fermi-8amxam`)
- **N5, connect/login on the page** (`web/app/network.ts`, `main.ts`, `index.html`, `worker.ts`,
  `machine.ts`, `web/tailscale.ts`, `web/tailscale-worker.ts`, `net/tailscale/main_js.go`): a Network
  menu for Debian; Connect (control server, hostname, optional auth key); the login link; state dot;
  Disconnect, Log out; the network card is **always present** in Debian (`ToWorker.start.ip`), so
  Connect never restarts the machine (boot to login 81.3 s median without the card, 79.7 s with it:
  noise; a lease arriving after the boot is taken in ~20 s); the
  node's state in IndexedDB (`ephemeral: false` in the Go client when state is kept) with automatic
  reconnect; a restarted machine's new port is handed to the running client (`attach`).
- **The card configures itself:** `machine.network.cmdline` unmasks networkd and resolved and
  passes a `network.network.card` credential. **`ip=dhcp` was tried first and is wrong**: Debian's
  initramfs reads it and waits for a lease before booting, so a machine not yet connected sat at the
  root mount for minutes (the page test found it).
- **Tests:** `tests/network.test.ts` (controller, fake client), `tests/net-guest.test.ts` (Debian,
  card on the echo gateway: configures itself, pings any address and the router: **this is the
  smoke test that pings from inside Debian without a tailnet**, ~1.5 min),
  `tests/page-network.test.ts` (the menu against an unreachable control server, no restart on Connect, ~3 min),
  `tests/serial-console.ts` (helpers shared with `tests/net-tailnet.test.ts`).
  All pass in Chromium 141 here. `tests/net-tailnet.test.ts` (N4: Debian pings a tailnet peer
  through headscale, resolves it by MagicDNS, the peer reaches a guest server) already existed and
  **could not run in this session** (see "Blocked").
- **The network tests on Debian run in `scripts/ci-net.sh`** (the user, 2026-09-30: only when a
  change touches the network): `net-guest`, `page-network` and `net-tailnet` (with Podman), ~4 min.
  `scripts/ci.sh` keeps the cheap ones (`network`, `gateway`, `net`, `devices`). On 2026-09-30,
  `net-tailnet` passed locally in Podman, the exit-node phase through the real internet included.
- **`tests/debian-lock.ts`:** the "EXPERIMENT: no lock" bypass, which loop 8 had committed by
  mistake, is removed (the lock is back). Full `npm test` with `WEBPC_DISTROS=debian`, both Debian page tests
  chained by the lock: 191 pass, 0 fail (`timer.bin` in parallel mode included). Read as "the
  experiment line goes"; if the user meant dropping the lock itself, that's a separate run with the
  lock bypassed (the earlier notes say the lock exists so two realtime Debian boots don't load the
  host into failing 1 ms windows).
- Cloud support (earlier in the session): `scripts/cloud-setup.sh`, `.claude/settings.json`,
  `docs/cloud.md`; merged to `main`.

## Done in the follow-up session (exit nodes; branch `claude/ecstatic-fermi-8amxam`)
- **Exit-node selection** (the old follow-up 3), end to end: the Go client (`net/tailscale/main_js.go`)
  reports each peer's stable ID and the exit node in use and takes `setExitNode(id, done)`
  (`ipn.Prefs.ExitNodeID` through `lb.EditPrefs`); the menu lists the approved exit nodes
  ("Internet through"), the choice is remembered (`exitNode` in the settings) and given to the client
  at the next connect. The user's own report was that the VM couldn't reach the internet through their
  tailnet's exit nodes: the menu had no way to select one. Selecting one wasn't enough, though: the
  client also needed (all three found by running the guest against a real exit node, details in
  docs/frontend.md "Network"): `ipn.NewPrefs()` as its start prefs (`CorpDNS` was off, so no tailnet DNS
  at all), the `peerapiclient` feature (DNS via the exit node's DoH), and its own connections dialed in
  the netstack with `CheckLocalTransportEndpoints`.
- **Test:** `tests/net-tailnet.test.ts` has an exit-node phase (the guest can't reach a server on the
  host, can once it uses the peer as its exit node, its DNS is answered by the exit node's resolver,
  and it can't again after "Nothing: directly"). It passed here, natively (see below), not in Podman.
  Unit tests for the view and controller in `tests/network.test.ts`.
- The user confirmed by hand that Tailscale login works, closing the old follow-up 4 (a real
  interactive login).
- **How the tailnet ran in the cloud without Podman:** natively, see docs/cloud.md ("Networking work").
  `WEBPC_TAILNET_SCRIPT` and a `podman` shim on `PATH` made the unchanged test use it. **Still worth
  running locally in Podman:** `WEBPC_TAILNET=1 node --test tests/net-tailnet.test.ts` (the peer's
  `--advertise-exit-node` and the route approval in `tests/net/tailnet.sh` are only exercised
  there; the approval assumes the peer is headscale node 1). Not tested against a real Tailscale
  exit node either: a DoH query to a stock `tailscaled` exit node is what the test's peer is, but the
  tailnet's own nameservers with an exit node (which the client now reaches through it) weren't.

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
   only the Alpine image and the existing tailnet. For `apk add`: the test tailnet's
   peer is now an exit node (`tests/net/tailnet.sh` advertises it and approves its routes; a
   userspace `tailscaled` connects to the destination itself, no forwarding or NAT needed) and the
   menu selects it, so what is missing is the Alpine image with a card.
3. **IPv6:** the netmap has the `fd7a:115c:a1e0::/48` address; the gateway drops IPv6 (routers
   advertisements plus a static address, after IPv4).
4. **The DOM of the menu is only lightly tested** (page-network.test.ts); the login-URL and
   approval states are covered by `viewOf` unit tests, not in Chromium.
5. **Page details left:** Buildroot has no card (its kernel has no virtio-net; not needed); the
   auth key field is a plain password input (no reveal); a Firefox/Safari pass is still the
   PLAN.md item. Debian's command line changed for the page (units unmasked, the credential): the
   guest-visible change is in `web/app/machine.ts`, not in a test guest, so no step counts move.
   `npm run serve` and `npm start` build the Tailscale client (`tools/tailscale.ts`).
6. **Chromium 141 vs 153:** everything here ran in the Playwright Chromium the cloud has (141),
   not the dev VM's 153.

## Blocked in this session, and why
- **Podman/Docker for the tailnet** (first session): the cloud has no Podman and the harness refused
  starting `dockerd`, so `tests/net-tailnet.test.ts` did not run then. The exit-node session ran the
  tailnet natively instead (above, docs/cloud.md), which covers the client worker's changes
  (attach/detach, persisted state, the `ephemeral` config) against a real control server; only the
  Podman script itself is unexercised.
- The user's "images can't be built in the cloud" holds (arm64 images, no Podman): Alpine and
  Buildroot work are local.
