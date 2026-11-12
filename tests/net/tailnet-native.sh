#!/bin/sh
# tests/net/tailnet.sh without Podman, for cloud sessions (docs/cloud.md): the same tailnet
# (headscale v0.29.4 with its embedded DERP, a TLS proxy that adds CORS on /key, one peer that is
# an approved exit node) as native processes. Go builds headscale and tailscale once, at the
# versions tailnet.sh pins, into target/net/tailnet-bin. The proxy is tests/net/tls-proxy.ts.
# Same usage and output: up | env | key [lasting] | nodes | peer <tailscale args> | routes [prefixes] | register <auth ID> | down. The peer's socket is /tmp/ts.sock, so a `podman`
# shim that turns `podman exec webpc-peer tailscale …` into the native `tailscale …` serves the
# tests that talk to the peer (tests/net/podman-shim, put first on PATH).
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
DIR=${TAILNET_DIR:-$ROOT/target/net/tailnet}
BIN=$ROOT/target/net/tailnet-bin
PORT=${TAILNET_PORT:-8443}
INNER=${TAILNET_INNER_PORT:-18080}
V4=${HEADSCALE_V4:-100.90.0.0/16}
DOMAIN=${HEADSCALE_DOMAIN:-tail.test} # MagicDNS's domain
SOCK=/tmp/ts.sock

build() {
	[ -x "$BIN/headscale" ] && [ -x "$BIN/tailscaled" ] && [ -x "$BIN/tailscale" ] && return
	mkdir -p "$BIN"
	echo "building headscale and tailscale (Go, once)..." >&2
	tmp=$(mktemp -d)
	(cd "$tmp" && GOBIN=$BIN GOTOOLCHAIN=auto go install github.com/juanfont/headscale/cmd/headscale@v0.29.4 >&2 &&
		GOBIN=$BIN GOTOOLCHAIN=auto go install tailscale.com/cmd/tailscaled@v1.102.5 tailscale.com/cmd/tailscale@v1.102.5 >&2)
	rm -rf "$tmp"
}

hs() { "$BIN/headscale" -c "$DIR/config/config.yaml" "$@"; }
peerts() { "$BIN/tailscale" --socket=$SOCK "$@"; }
authkey() { hs preauthkeys create -u 1 --reusable $([ "${1:-}" = lasting ] || echo --ephemeral) -e 24h -o json | sed -n 's/.*"key": *"\([^"]*\)".*/\1/p'; }

# This machine's IPv4 address: the peer advertises it as a /32 subnet route, approved only by `routes` (a test that
# wants it), so a guest reaches a server here through the peer as through a subnet router.
LAN=$(ip -4 -o addr show scope global 2>/dev/null | awk '{split($4, a, "/"); print a[1]; exit}')
[ -n "$LAN" ] || LAN=$(hostname -I | awk '{print $1}')

# Approves the peer's exit-node routes and these others (comma-separated; none: back to the exit node's only).
approve() {
	id=$(hs nodes list -o json 2>/dev/null | python3 -c 'import json, sys; print(next(n["id"] for n in json.load(sys.stdin) if "peer" in (n.get("name"), n.get("given_name"))))' 2>/dev/null) &&
		hs nodes approve-routes -i "$id" -r "0.0.0.0/0,::/0${1:+,$1}" >/dev/null 2>&1
}

env_() {
	echo "WEBPC_TS_CONTROL=https://127.0.0.1:$PORT"
	echo "WEBPC_TS_PEER_IP=$(peerts ip -4)"
	echo "WEBPC_TS_PEER_IP6=$(peerts ip -6)"
	echo "WEBPC_TS_PEER_NAME=$(peerts status --json | sed -n 's/.*"DNSName": *"\([^"]*\)".*/\1/p' | head -1)"
	echo "WEBPC_TS_SUBNET=$LAN"
	echo "NODE_EXTRA_CA_CERTS=$DIR/tls/ca.pem"
}

start() { # name, command...
	n=$1
	shift
	nohup "$@" > "$DIR/run/$n.log" 2>&1 &
	echo $! > "$DIR/run/$n.pid"
}

case ${1:-} in
up)
	build
	"$0" down >/dev/null 2>&1 || true
	mkdir -p "$DIR/config/tls" "$DIR/lib" "$DIR/run" "$DIR/peer"
	cd "$DIR/config/tls"
	openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout ca.key -out ca.pem -subj "/CN=webpc test CA" -days 30 2>/dev/null
	openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout srv.key -out srv.csr -subj "/CN=127.0.0.1" 2>/dev/null
	printf 'subjectAltName=IP:127.0.0.1,DNS:localhost\nbasicConstraints=CA:FALSE\n' > ext
	openssl x509 -req -in srv.csr -CA ca.pem -CAkey ca.key -CAcreateserial -out srv.pem -days 30 -extfile ext 2>/dev/null
	ln -sf "$DIR/config/tls" "$DIR/tls"
	cat > "$DIR/config/config.yaml" <<YAML
server_url: https://127.0.0.1:$PORT
listen_addr: 127.0.0.1:$INNER
metrics_listen_addr: 127.0.0.1:19090
grpc_listen_addr: 127.0.0.1:15443
noise:
  private_key_path: $DIR/lib/noise_private.key
prefixes:
  v4: $V4
  v6: fd7a:115c:a1e0::/48
  allocation: sequential
derp:
  server:
    enabled: true
    region_id: 999
    region_code: headscale
    region_name: Headscale Embedded DERP
    verify_clients: true
    stun_listen_addr: 0.0.0.0:3478
    private_key_path: $DIR/lib/derp_server_private.key
    automatically_add_embedded_derp_region: true
    ipv4: 127.0.0.1
  urls: []
  paths: []
  auto_update_enabled: false
disable_check_updates: true
database:
  type: sqlite
  sqlite:
    path: $DIR/lib/db.sqlite
policy:
  mode: file
  path: $DIR/config/policy.json
dns:
  magic_dns: true
  base_domain: $DOMAIN
  override_local_dns: false
  nameservers:
    global: []
unix_socket: $DIR/run/headscale.sock
unix_socket_permission: "0770"
logtail:
  enabled: false
YAML
	echo '{"acls": [{"action": "accept", "src": ["*"], "dst": ["*:*"]}]}' > "$DIR/config/policy.json"
	start headscale "$BIN/headscale" -c "$DIR/config/config.yaml" serve
	start proxy node "$ROOT/tests/net/tls-proxy.ts" "$PORT" "$INNER" "$DIR/config/tls/srv.pem" "$DIR/config/tls/srv.key"
	healthy=
	for _ in $(seq 120); do
		curl -sf --cacert "$DIR/config/tls/ca.pem" "https://127.0.0.1:$PORT/health" >/dev/null 2>&1 && { healthy=1; break; }
		sleep 0.5
	done
	[ -n "$healthy" ] || { echo "tailnet: headscale didn't come up:" >&2; tail -20 "$DIR/run/headscale.log" >&2; exit 1; }
	for _ in $(seq 20); do hs users create tailnet >/dev/null 2>&1 && break; sleep 1; done
	SSL_CERT_FILE=$DIR/config/tls/ca.pem start peer "$BIN/tailscaled" --tun=userspace-networking --socket=$SOCK --statedir="$DIR/peer" --port=0
	for _ in $(seq 40); do [ -S $SOCK ] && break; sleep 0.25; done
	peerts up --login-server="https://127.0.0.1:$PORT" --authkey="$(authkey lasting)" --hostname=peer --advertise-exit-node --advertise-routes=$LAN/32 >/dev/null
	peerts ip -4 >/dev/null 2>&1 || { echo "tailnet: the peer didn't join:" >&2; tail -20 "$DIR/run/peer.log" >&2; exit 1; }
	approved=
	for _ in $(seq 60); do
		approve && { approved=1; break; }
		sleep 1
	done
	[ -n "$approved" ] || { echo "tailnet: couldn't approve the peer's routes:" >&2; hs nodes list >&2; exit 1; }
	env_
	;;
env) env_ ;;
key) authkey "${2:-}" ;;
nodes) hs nodes list -o json ;;
peer) shift; peerts "$@" ;;
routes) approve "${2:-}" || { echo "tailnet: couldn't approve the peer's routes" >&2; exit 1; } ;;
register) hs auth register --auth-id "$2" --user tailnet ;;
hs) shift; hs "$@" ;;
down)
	for p in peer proxy headscale; do
		[ -f "$DIR/run/$p.pid" ] && kill "$(cat "$DIR/run/$p.pid")" 2>/dev/null || true
	done
	sleep 0.5
	rm -rf "$DIR" $SOCK
	;;
*) echo "usage: $0 up|env|key [lasting]|nodes|peer <tailscale args>|routes [prefixes]|register <auth ID>|hs <args>|down" >&2; exit 2 ;;
esac
