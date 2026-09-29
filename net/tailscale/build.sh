#!/bin/sh
# Builds the Tailscale backend to wasm (docs/plans/networking.md §4): needs Go
# (go.mod pins the toolchain). Usage: build.sh [out.wasm]; TAGS overrides the
# features left out. Prints the raw size.
set -eu
OUT=${1:-$(cd "$(dirname "$0")/../.." && pwd)/target/net/tailscale.wasm}
case $OUT in /*) ;; *) OUT=$PWD/$OUT ;; esac
cd "$(dirname "$0")"
# Features a guest-carrying client doesn't need. Kept: dns (MagicDNS), netstack
# (Tailscale's own services), useexitnode, useroutes, health, usermetrics.
OMIT="ace acme advertiseexitnode advertiseroutes appconnectors aws bakedroots bird c2n cachenetmap \
captiveportal capture cli cliconndiag clientmetrics clientupdate cloud colorable completion \
completion_scripts conn25 dbus debug debugeventbus debugportmapper desktop_sessions doctor drive \
flashappliance gro hujsonconf identityfederation iptables kube linkspeed linuxdnsfight \
listenrawdisco logtail netlog networkmanager oauthkey osrouter outboundproxy peerapiclient \
peerapiserver portlist portmapper posture qrcodes relayserver remoteconfig resolved routecheck \
runtimemetrics sdnotify serve serviceclientprefs ssh synology syslog syspolicy systray taildrop \
tailnetlock tap tpm tundevstats unixsocketidentity useproxy wakeonlan webbrowser webclient"
TAGS=${TAGS-$(for f in $OMIT; do printf 'ts_omit_%s,' "$f"; done | sed 's/,$//')}
mkdir -p "$(dirname "$OUT")"
# One upstream file is replaced (overlay/, see its header): keep the control
# server's HTTPS port when dialing over WebSocket. Go refuses overlays inside
# the module cache, so the build uses a patched copy of the module through a
# temporary go.mod with a replace directive.
TS=$(go list -m -f '{{.Dir}}' tailscale.com)
VER=$(go list -m -f '{{.Version}}' tailscale.com)
SRC=$(dirname "$OUT")/tailscale-src-$VER
if [ ! -d "$SRC" ]; then
	rm -rf "$SRC.tmp" "$(dirname "$OUT")"/tailscale-src-*
	cp -r "$TS" "$SRC.tmp"
	chmod -R u+w "$SRC.tmp"
	cp overlay/controlhttp_client_js.go "$SRC.tmp/control/controlhttp/client_js.go"
	mv "$SRC.tmp" "$SRC"
fi
MOD=$(mktemp -d)
trap 'rm -rf "$MOD"' EXIT
cp go.mod "$MOD/go.mod"
cp go.sum "$MOD/go.sum"
go mod edit -modfile="$MOD/go.mod" -replace "tailscale.com=$SRC"
GOOS=js GOARCH=wasm go build -modfile="$MOD/go.mod" -trimpath -tags "$TAGS" -ldflags '-s -w' -o "$OUT" .
# Go's JS glue for the module (BSD-3, ships with the toolchain)
cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" "$(dirname "$OUT")/wasm_exec.js"
ls -l "$OUT" | awk '{print $5, $9}'
