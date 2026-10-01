**Handover, 2026-10-01: the networking lane (docs/plans/networking.md) has N1 to N5 done: a VM on the
page connects to a tailnet (login, kept node, reconnect) and reaches the internet through an exit
node. What's left is IPv6 (N6, the main item) and the card for Alpine (N7).**

Read docs/plans/networking.md (§3 for the IPv6 design, §7 for the steps) and docs/frontend.md
"Network" first; this file is what they don't say.

## Decisions (the user, 2026-10-01)
- IPv6 is required: implemented and validated, in the gateway and through the tailnet.
- No test that needs a real exit node to the internet gates anything; no `apk add` smoke test. The
  Buildroot N3 boot (exact steps, Rust twin) is dropped: Debian's `net-guest` and the byte tests
  cover the gateway.
- A user-mode NAT relay is dropped; other backends and tailscale-rs (replacing the Go client) stay planned.
- `scripts/ci-net.sh` stays apart from `scripts/ci.sh` (only for changes that touch the network).

## Where things are
- Gateway: `web/gateway.ts` (IPv4 only), `tests/gateway.test.ts`. Backends: the echo one (same
  file), the Tailscale one (`web/tailscale.ts`, `web/tailscale-worker.ts`, Go in `net/tailscale/`).
  `leaseFrom` in `web/tailscale.ts` keeps the first IPv4 address and IPv4 resolvers only.
- The page: `web/app/network.ts` (controller), `main.ts`, `machine.ts` (Debian's `network` entry:
  the networkd credential, `DHCP=ipv4`), `worker.ts` adds the `net` device from the IP port.
- Tests: `network` (controller, fake client), `gateway`, `net`, `devices` in `ci.sh`;
  `net-guest`, `page-network`, `net-tailnet` in `ci-net.sh` (~4 min; the last needs Podman).
  The test tailnet (`tests/net/tailnet.sh`: headscale behind Caddy for TLS and the CORS header on
  `/key`, a `tailscaled` peer that is an exit node) already hands out `fd7a:115c:a1e0::/48`
  addresses, so N6's tailnet test needs no new infrastructure.

## Next, in order
1. **N6 IPv6**, as laid out in the plan: gateway bytes first (RA with M/O and no prefix, DHCPv6
   IA_NA /128, ICMPv6, source filtering, timers only in realtime), the echo backend's v6 echo and
   `net-guest`, then `net-tailnet` (ping6 to the peer, AAAA through MagicDNS, the peer reaching the
   guest over v6). Things to watch: the checksum pseudo-headers; networkd's `DHCP=yes` vs
   `ipv6` + `IPv6AcceptRA`; an RA sent when the lease appears, since the card exists before the
   client connects (IPv4's late lease takes ~20 s); the Packet Too Big rule at the 1280 MTU.
2. **N7 Alpine's card:** what Alpine's UEFI cloud image does with a virtio-net card by itself; if
   nothing is needed, a ping check in `tests/uefi.test.ts`'s Alpine boot on the echo gateway.
   The page offers every machine with a `network` entry a card, and a user-chosen disk (Alpine)
   boots under Debian's entry, whose credential only systemd reads.
3. **N8 (done):** the exit-node phase of `net-tailnet` is opt-in (`WEBPC_TAILNET_INTERNET=1`) and
   passed once on 2026-10-01. It guards three Go-client fixes (`ipn.NewPrefs()`, `peerapiclient`,
   the netstack dialer); run it when touching the client's DNS or routing. Not tested against a
   real Tailscale exit node and its own nameservers.
4. `net-tailnet` passed locally in Podman on 2026-09-30, exit-node phase included. The approval
   in `tests/net/tailnet.sh` assumes the peer is headscale node 1.

## Smaller things
- The menu's DOM is lightly tested (`page-network.test.ts`); login-URL and approval states are
  `viewOf` unit tests only. The auth key field has no reveal. Firefox/Safari: PLAN.md.
- Buildroot's kernel *does* have virtio-net (`images/linux.fragment`; `test-devices.sh` pings the
  loopback adapter); the page's Buildroot machine just has no `network` entry. An earlier note
  here said the opposite.
- The work so far ran in cloud sessions (Chromium 141) as well as here (153); recheck the network
  tests with `scripts/ci-net.sh` in the dev VM after any change.
