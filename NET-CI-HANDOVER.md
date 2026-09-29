# Tailnet CI handover

Goal: `scripts/ci.sh` tests the tailnet for real (default on when Podman and Debian are there).

## Found
- The `net-tailnet` exit-node failure (curl exit 28) was **the test, not the environment**. Tailscale's
  exit nodes never forward RFC 1918 (nor CGNAT, link-local, multicast) destinations, the exit node's own
  LAN included (`ipn/ipnlocal/local.go`, `removeFromDefaultRoute`; the peer counted them as
  `tailscaled_inbound_dropped_packets_total{reason="acl"}`). The test used this host's LAN address
  (192.168.5.15 here) as "the internet". The cloud session's host had a public-looking address.
  Fix: the phase uses the real internet (1.1.1.1 and example.com), skipped loudly if the host has none.
- `tests/net/tailnet.sh` used headscale's inner port 8080, which `npm run serve` (the dev server) holds:
  the headscale container died at start. Now 18080/19090/15443. A policy file (allow all) is explicit.

## State
See `git log`; update this file with each commit.
