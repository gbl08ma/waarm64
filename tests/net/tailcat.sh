#!/bin/sh
# A tailcat exit node for the tailnet client's tests (docs/networking/tailnet.md "tailcat"):
# derper on 127.0.0.1:8444 with a self-signed certificate for that address, and
# `tailcat serve exit-node` on it, both native and unprivileged (Go builds them once, at the
# versions pinned below, into target/net/tailcat-test/bin; derper has no official image).
# The exit node's machine is this one: what the guest reaches through it is this machine's
# network, 127.0.0.1 included.
#
#   tests/net/tailcat.sh up     # starts both; prints WAARM64_TAILCAT_ADDR=… and WAARM64_TAILCAT_CA=…
#   tests/net/tailcat.sh env    # prints them again
#   tests/net/tailcat.sh down
#
# Shared: tests run concurrently (node --test runs files in parallel), so `up` while the rig runs
# only counts one more user and prints its environment, and `down` stops it when the last user
# leaves (`down --force` at once). Both hold a lock.
#
# Clients trust the relay's certificate through NODE_EXTRA_CA_CERTS=$WAARM64_TAILCAT_CA (Node) or
# ignoreHTTPSErrors (Chromium).
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
DIR=$ROOT/target/net/tailcat-test
BIN=$DIR/bin
TAILCAT_VERSION=v0.7.0
# The tailscale.com tailcat v0.7.0's go.mod pins (derper comes from it).
TAILSCALE_VERSION=v1.103.0-pre.0.20260929142145-a0e471a35b8f
PORT=8444 # not 8443: tests/net/tailnet.sh's proxy has it, and ci-net runs both side by side

build() {
	[ -x "$BIN/tailcat" ] && [ -x "$BIN/derper" ] && return
	mkdir -p "$BIN"
	echo "building tailcat $TAILCAT_VERSION and derper (Go, once)..." >&2
	GOBIN=$BIN GOTOOLCHAIN=auto go install "github.com/tailscale/tailcat/cmd/tailcat@$TAILCAT_VERSION" >&2
	GOBIN=$BIN GOTOOLCHAIN=auto go install "tailscale.com/cmd/derper@$TAILSCALE_VERSION" >&2
}

stop() {
	for p in serve derper; do
		[ -f "$DIR/run/$p.pid" ] && kill "$(cat "$DIR/run/$p.pid")" 2>/dev/null || true
		rm -f "$DIR/run/$p.pid"
	done
}

running() {
	for p in serve derper; do
		[ -f "$DIR/run/$p.pid" ] && kill -0 "$(cat "$DIR/run/$p.pid")" 2>/dev/null || return 1
	done
}

env_out() {
	echo "WAARM64_TAILCAT_ADDR=$(cat "$DIR/addr")"
	echo "WAARM64_TAILCAT_CA=$DIR/certs/127.0.0.1.crt"
}

case ${1:-} in
up)
	build
	mkdir -p "$DIR/run"
	exec 9> "$DIR/run/lock"
	flock 9
	if running; then
		echo $(($(cat "$DIR/run/users" 2>/dev/null || echo 0) + 1)) > "$DIR/run/users"
		env_out
		exit 0
	fi
	stop
	mkdir -p "$DIR/certs" "$DIR/run"
	[ -f "$DIR/certs/127.0.0.1.crt" ] || openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 \
		-subj /CN=127.0.0.1 -addext subjectAltName=IP:127.0.0.1 \
		-keyout "$DIR/certs/127.0.0.1.key" -out "$DIR/certs/127.0.0.1.crt" 2>/dev/null
	"$BIN/derper" -a "127.0.0.1:$PORT" -certmode manual -certdir "$DIR/certs" -hostname 127.0.0.1 -stun=false \
		-c "$DIR/run/derper.key" > "$DIR/run/derper.log" 2>&1 9>&- &
	echo $! > "$DIR/run/derper.pid"
	# A fresh server key whose region is that relay (an IP, so the address carries its port).
	rm -f "$DIR/run/server.json"
	SSL_CERT_FILE=$DIR/certs/127.0.0.1.crt "$BIN/tailcat" genkey --key="$DIR/run/server.json" --region=127.0.0.1 > /dev/null 2>&1
	python3 - "$DIR/run/server.json" "$PORT" <<'EOF'
import json, sys
p, port = sys.argv[1], int(sys.argv[2])
k = json.load(open(p))
for r in k["Public"]["Region"]:
    for n in r["Nodes"]:
        n["DERPPort"] = port
json.dump(k, open(p, "w"))
EOF
	SSL_CERT_FILE=$DIR/certs/127.0.0.1.crt NO_PROXY=127.0.0.1 no_proxy=127.0.0.1 \
		"$BIN/tailcat" --verbose serve --key="$DIR/run/server.json" exit-node > "$DIR/run/serve.log" 2>&1 9>&- &
	echo $! > "$DIR/run/serve.pid"
	i=0
	# The listening line is written in parts (its address after the words): read it once a line follows it.
	until sed -n '/Server listening/{n;p;}' "$DIR/run/serve.log" | grep -q .; do
		i=$((i + 1))
		[ $i -lt 60 ] || { echo "tailcat didn't start:" >&2; tail -20 "$DIR/run/serve.log" >&2; exit 1; }
		sleep 0.5
	done
	grep -o 'tc[A-Za-z0-9_-]\{40,\}' "$DIR/run/serve.log" | tail -1 > "$DIR/addr"
	[ -s "$DIR/addr" ] || { echo "tailcat printed no address:" >&2; tail -20 "$DIR/run/serve.log" >&2; exit 1; }
	# The server answers meows only once its own relay connection is up.
	until grep -q 'derp-1 connected' "$DIR/run/serve.log"; do
		i=$((i + 1))
		[ $i -lt 60 ] || break
		sleep 0.5
	done
	echo 1 > "$DIR/run/users"
	env_out
	;;
env) env_out ;;
down)
	mkdir -p "$DIR/run"
	exec 9> "$DIR/run/lock"
	flock 9
	n=$(($(cat "$DIR/run/users" 2>/dev/null || echo 1) - 1))
	if [ "${2:-}" = --force ] || [ $n -le 0 ]; then
		stop
		rm -f "$DIR/run/users"
	else
		echo $n > "$DIR/run/users"
	fi
	;;
*) echo "usage: $0 up|env|down" >&2; exit 2 ;;
esac
