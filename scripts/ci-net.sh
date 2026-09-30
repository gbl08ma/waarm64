#!/usr/bin/env bash
# The network tests on Debian (docs/testing.md "The network on Debian"): run it, besides
# scripts/ci.sh, when a change touches the network: the gateway, virtio-net, the Tailscale client
# (net/tailscale, web/tailscale*.ts), the page's Network menu or Debian's network command line.
# ~4 min. Needs the Debian image and the wasm core (scripts/ci.sh builds it); the tailnet test also
# needs Podman (WEBPC_TAILNET=0 skips it) and Go or a built target/net/tailscale.wasm.
set -euo pipefail
cd "$(dirname "$0")/.."
step() { printf '\n== %s (at %d s)\n' "$*" "$SECONDS"; }

images/build.sh --check debian > /dev/null || { echo 'ci-net: the Debian image is missing or stale (npm start, or images/build.sh debian)'; exit 1; }
export WEBPC_DISTROS=debian WEBPC_NET_TESTS=1
export WEBPC_TAILNET=${WEBPC_TAILNET-$(command -v podman > /dev/null && echo 1)}
step tailscale;   node --disable-warning=ExperimentalWarning tools/tailscale.ts # the client the Network menu and the tailnet test load
step 'network tests'
node --disable-warning=ExperimentalWarning --test tests/net-guest.test.ts tests/page-network.test.ts tests/net-tailnet.test.ts
printf '\nCI-NET OK (%d s)\n' "$SECONDS"
