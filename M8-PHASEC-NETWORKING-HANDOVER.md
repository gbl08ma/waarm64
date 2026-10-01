**Handover, 2026-10-01: the networking lane (docs/plans/networking.md) has N1 to N5 done: a VM on the
page connects to a tailnet (login, kept node, reconnect) and reaches the internet through an exit
node. IPv6 (N6) and the card for Alpine (N7) are done too. Only the smaller things below are left.**

Read docs/plans/networking.md (§3 for the gateway, §7 for the steps) and docs/frontend.md
"Network" first; this file is what they don't say.

## Decisions (the user, 2026-10-01)
- IPv6 is required: implemented and validated, in the gateway and through the tailnet.
- No test that needs a real exit node to the internet gates anything; no `apk add` smoke test. The
  Buildroot N3 boot (exact steps, Rust twin) is dropped: Debian's `net-guest` and the byte tests
  cover the gateway.
- A user-mode NAT relay is dropped; other backends and tailscale-rs (replacing the Go client) stay planned.
- `scripts/ci-net.sh` stays apart from `scripts/ci.sh` (only for changes that touch the network).

## Where things are
- Gateway: `web/gateway.ts` (IPv4 and, with `web/ip6.ts`, IPv6), `tests/gateway.test.ts`. Backends: the echo one (same
  file), the Tailscale one (`web/tailscale.ts`, `web/tailscale-worker.ts`, Go in `net/tailscale/`).
  `leaseFrom` in `web/tailscale.ts` takes the first IPv4 and IPv6 address and the IP resolvers.
- The page: `web/app/network.ts` (controller), `main.ts`, `machine.ts` (Debian's `network` entry:
  the networkd credential, `DHCP=yes`), `worker.ts` adds the `net` device from the IP port.
- Tests: `network` (controller, fake client), `gateway`, `net`, `devices` in `ci.sh`;
  `net-guest`, `page-network`, `net-tailnet` in `ci-net.sh` (~4 min; the last needs Podman).
  The test tailnet (`tests/net/tailnet.sh`: headscale behind Caddy for TLS and the CORS header on
  `/key`, a `tailscaled` peer that is an exit node) already hands out `fd7a:115c:a1e0::/48`
  addresses, so N6's tailnet test needs no new infrastructure.

## Next, in order
1. **N6 IPv6 (done 2026-10-01)**, see the plan. Things worth knowing: the gateway sends the
   advertisement when the lease gains an IPv6 address, so a late lease gives the guest its IPv6
   address in ~2 s (IPv4 ~25 s, networkd's retries); MagicDNS gives peers AAAA only with the
   `magicdns-aaaa` node attribute; IPv6 to the internet through an exit node is untested (no v6
   route here); IPv6 router advertisements repeat every 60 s only on a port backend (a timer).
2. **N7 Alpine's card (done 2026-10-01):** Alpine's UEFI images bring `eth0` up by themselves (DHCP, DHCPv6, RA), so
   nothing was needed: `tests/uefi.test.ts`'s Alpine boots have a card on the echo gateway and ping over IPv4 and IPv6.
3. **N8 (done):** the exit-node phase of `net-tailnet` is opt-in (`WEBPC_TAILNET_INTERNET=1`) and
   passed once on 2026-10-01. It guards three Go-client fixes (`ipn.NewPrefs()`, `peerapiclient`,
   the netstack dialer); run it when touching the client's DNS or routing. Not tested against a
   real Tailscale exit node and its own nameservers.
4. `net-tailnet` passed locally in Podman on 2026-09-30, exit-node phase included. The approval
   in `tests/net/tailnet.sh` assumes the peer is headscale node 1.

## Smaller things
- The menu's DOM is lightly tested (`page-network.test.ts`); login-URL and approval states are
  `viewOf` unit tests only.  The auth key field has a "Show" checkbox (done 2026-10-01). Firefox/Safari: PLAN.md.
- Buildroot's kernel *does* have virtio-net (`images/linux.fragment`; `test-devices.sh` pings the
  loopback adapter); the page's Buildroot machine just has no `network` entry. An earlier note
  here said the opposite.
- The work so far ran in cloud sessions (Chromium 141) as well as here (153); recheck the network
  tests with `scripts/ci-net.sh` in the dev VM after any change.
