#!/usr/bin/env bash
# The network tests on Debian (docs/testing.md "The network on Debian"): run it, besides
# scripts/ci.sh, when a change touches the network: the gateway, virtio-net, the tailnet client
# (net/ts, web/tailscale*.ts, web/tailnet-worker.ts, web/tailcat*.ts, web/ts-*.ts), the page's Network menu
# or Debian's network command line. ~8 min. Needs the Debian image and the wasm core (scripts/ci.sh
# builds it); the tailnet tests also need Podman (WEBPC_TAILNET=0 skips them), and the hand-over
# test Go (the Go client, net/tailscale, is its fixture); the tailcat tests need Go (tests/net/tailcat.sh builds tailcat and
# derper; WEBPC_TAILCAT=0 skips them).
set -euo pipefail
cd "$(dirname "$0")/.."
step() { printf '\n== %s (at %d s)\n' "$*" "$SECONDS"; }

images/build.sh --check debian > /dev/null || { echo 'ci-net: the Debian image is missing or stale (images/build.sh debian)'; exit 1; }
export WEBPC_DISTROS=debian WEBPC_NET_TESTS=1
export WEBPC_TAILNET=${WEBPC_TAILNET-$(command -v podman > /dev/null && echo 1)}
export WEBPC_TAILCAT=${WEBPC_TAILCAT-$(command -v go > /dev/null && echo 1)}
step tailscale;   node --disable-warning=ExperimentalWarning tools/tailscale.ts # the Network menu's client, and the hand-over test's Go one
step 'network tests'
node --disable-warning=ExperimentalWarning --test tests/net-guest.test.ts tests/page-network.test.ts tests/net-tailnet.test.ts tests/tailcat-browser.test.ts tests/net-tailcat.test.ts tests/net-local.test.ts
# The tailnet client without a guest: in Node (a node the Go client kept handed over both ways, the
# data plane) and in the page. One at a time: each brings up the test tailnet (tests/net/tailnet.sh)
# on the same ports as the guest's test above.
step 'the tailnet client in Node and the page'
node --disable-warning=ExperimentalWarning --test --test-concurrency=1 tests/ts-tailnet.test.ts tests/tailscale-browser.test.ts tests/ts-tailcat.test.ts
printf '\nCI-NET OK (%d s)\n' "$SECONDS"
