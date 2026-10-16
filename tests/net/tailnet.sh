#!/bin/sh
# A throwaway tailnet for the networking tests (docs/plans/networking.md, N2/N4):
# headscale with its embedded DERP behind a Caddy reverse proxy that does the
# TLS (a test CA, 127.0.0.1, the way headscale is deployed) and adds the CORS header
# a page's fetch of /key needs (headscale sends none), and one peer, `tailscaled` in userspace networking
# that is also an exit node (its 0.0.0.0/0 is approved), both in rootless Podman on the
# host network (never Docker, docs/images.md). Usage:
#   tests/net/tailnet.sh up      start it; prints the environment for the tests
#   tests/net/tailnet.sh env     print it again
#   tests/net/tailnet.sh key     print a new reusable, ephemeral auth key (`key lasting`: not ephemeral)
#   tests/net/tailnet.sh nodes   headscale's nodes, JSON
#   tests/net/tailnet.sh peer …  the peer's `tailscale …`
#   tests/net/tailnet.sh down    remove the containers and the state
# The state lives in $TAILNET_DIR (default target/net/tailnet). The tailnet's
# IPv4 range is $HEADSCALE_V4 (default 100.90.0.0/16, on purpose not the
# default 100.64.0.0/10): tests take addresses from the clients, never assume.
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
DIR=${TAILNET_DIR:-$ROOT/target/net/tailnet}
HS_IMAGE=docker.io/headscale/headscale:v0.29.4
TS_IMAGE=docker.io/tailscale/tailscale:v1.102.5
CADDY_IMAGE=${CADDY_IMAGE:-docker.io/library/caddy:2.10}
PORT=${TAILNET_PORT:-8443} # what clients use (TLS, the proxy)
INNER=${TAILNET_INNER_PORT:-18080} # headscale's own, plain HTTP
V4=${HEADSCALE_V4:-100.90.0.0/16}
HS=webpc-headscale
PEER=webpc-peer
PROXY=webpc-proxy

hs() { podman exec "$HS" headscale "$@"; }
peerts() { podman exec "$PEER" tailscale --socket=/tmp/ts.sock "$@"; }

# The guest's keys are ephemeral (`key`); the peer's isn't (`authkey lasting`): headscale deletes an ephemeral node
# that drops off for a moment, and a loaded machine made the peer do that during setup.
authkey() { hs preauthkeys create -u 1 --reusable $([ "${1:-}" = lasting ] || echo --ephemeral) -e 24h -o json | sed -n 's/.*"key": *"\([^"]*\)".*/\1/p'; }

env_() {
	echo "WEBPC_TS_CONTROL=https://127.0.0.1:$PORT"
	echo "WEBPC_TS_PEER_IP=$(peerts ip -4)"
	echo "WEBPC_TS_PEER_IP6=$(peerts ip -6)"
	echo "WEBPC_TS_PEER_NAME=$(peerts status --json | sed -n 's/.*"DNSName": *"\([^"]*\)".*/\1/p' | head -1)"
	echo "NODE_EXTRA_CA_CERTS=$DIR/tls/ca.pem"
}

case ${1:-} in
up)
	"$0" down >/dev/null 2>&1 || true
	mkdir -p "$DIR/config/tls" "$DIR/lib"
	cd "$DIR/config/tls"
	openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout ca.key -out ca.pem -subj "/CN=webpc test CA" -days 30 2>/dev/null
	openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout srv.key -out srv.csr -subj "/CN=127.0.0.1" 2>/dev/null
	printf 'subjectAltName=IP:127.0.0.1,DNS:localhost\nbasicConstraints=CA:FALSE\n' > ext
	openssl x509 -req -in srv.csr -CA ca.pem -CAkey ca.key -CAcreateserial -out srv.pem -days 30 -extfile ext 2>/dev/null
	chmod 644 ./*
	ln -sf "$DIR/config/tls" "$DIR/tls"
	cat > "$DIR/config/config.yaml" <<YAML
server_url: https://127.0.0.1:$PORT
listen_addr: 127.0.0.1:$INNER
metrics_listen_addr: 127.0.0.1:19090
grpc_listen_addr: 127.0.0.1:15443
noise:
  private_key_path: /var/lib/headscale/noise_private.key
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
    private_key_path: /var/lib/headscale/derp_server_private.key
    automatically_add_embedded_derp_region: true
    ipv4: 127.0.0.1
  urls: []
  paths: []
  auto_update_enabled: false
disable_check_updates: true
database:
  type: sqlite
  sqlite:
    path: /var/lib/headscale/db.sqlite
policy:
  mode: file
  path: /etc/headscale/policy.json
dns:
  magic_dns: true
  base_domain: tail.test
  override_local_dns: false
  nameservers:
    global: []
unix_socket: /var/run/headscale/headscale.sock
unix_socket_permission: "0770"
logtail:
  enabled: false
YAML
	# An explicit allow-all policy (what a tailnet without ACLs means), so the tests never depend on headscale's default
	# for an empty one.
	cat > "$DIR/config/policy.json" <<'POLICY'
{"acls": [{"action": "accept", "src": ["*"], "dst": ["*:*"]}]}
POLICY
	cat > "$DIR/config/Caddyfile" <<CADDY
{
	auto_https off
	admin off
}
https://127.0.0.1:$PORT {
	tls /etc/caddy/tls/srv.pem /etc/caddy/tls/srv.key
	# A page can't read /key from another origin without this (only /key is fetched; the rest is WebSocket).
	@key path /key
	header @key Access-Control-Allow-Origin *
	reverse_proxy 127.0.0.1:$INNER
}
CADDY
	podman run -d --name "$HS" --network host -v "$DIR/config:/etc/headscale" -v "$DIR/lib:/var/lib/headscale" "$HS_IMAGE" serve >/dev/null
	podman run -d --name "$PROXY" --network host -v "$DIR/config/Caddyfile:/etc/caddy/Caddyfile:ro" -v "$DIR/config/tls:/etc/caddy/tls:ro" "$CADDY_IMAGE" >/dev/null
	# Generous waits, each failing loudly: scripts/ci-net.sh starts this beside Debian boots, and under that load a
	# 20 s wait passed silently with headscale not up, so the user, the key and the peer never were.
	healthy=
	for _ in $(seq 120); do
		curl -sf --cacert "$DIR/config/tls/ca.pem" "https://127.0.0.1:$PORT/health" >/dev/null 2>&1 && { healthy=1; break; }
		sleep 0.5
	done
	[ -n "$healthy" ] || { echo "tailnet: headscale didn't come up:" >&2; podman logs --tail 20 "$HS" >&2; exit 1; }
	for _ in $(seq 20); do hs users create tailnet >/dev/null 2>&1 && break; sleep 1; done
	podman run -d --name "$PEER" --network host -v "$DIR/config/tls/ca.pem:/ca.pem:ro" -e SSL_CERT_FILE=/ca.pem \
		-e TS_AUTHKEY="$(authkey lasting)" -e TS_HOSTNAME=peer -e TS_USERSPACE=true -e TS_STATE_DIR=/var/lib/tailscale \
		-e TS_SOCKET=/tmp/ts.sock -e TS_EXTRA_ARGS="--login-server=https://127.0.0.1:$PORT --advertise-exit-node" "$TS_IMAGE" >/dev/null
	for _ in $(seq 180); do
		peerts ip -4 >/dev/null 2>&1 && break
		sleep 0.5
	done
	peerts ip -4 >/dev/null 2>&1 || { echo "tailnet: the peer didn't join:" >&2; podman logs --tail 20 "$PEER" >&2; exit 1; }
	# The peer is the tailnet's exit node once an admin approves the routes it advertises.
	for _ in $(seq 30); do
		hs nodes list-routes 2>/dev/null | grep -q '0\.0\.0\.0/0' && break
		sleep 0.5
	done
	# By its ID, looked up by name: the peer isn't always node 1 (a re-registration takes the next), and under load
	# it can take a while to be listed (both found when scripts/ci-net.sh ran the Debian tests side by side).
	approved=
	for _ in $(seq 60); do
		id=$(hs nodes list -o json 2>/dev/null | python3 -c 'import json, sys; print(next(n["id"] for n in json.load(sys.stdin) if "peer" in (n.get("name"), n.get("given_name"))))' 2>/dev/null) &&
			hs nodes approve-routes -i "$id" -r 0.0.0.0/0,::/0 >/dev/null 2>&1 && { approved=1; break; }
		sleep 1
	done
	[ -n "$approved" ] || { echo "tailnet: couldn't approve the peer's routes:" >&2; hs nodes list >&2; exit 1; }
	env_
	;;
env) env_ ;;
key) authkey "${2:-}" ;;
nodes) hs nodes list -o json ;;
peer) shift; peerts "$@" ;;
down)
	podman rm -f "$PEER" "$PROXY" "$HS" >/dev/null 2>&1 || true
	rm -rf "$DIR"
	;;
*) echo "usage: $0 up|env|key [lasting]|nodes|peer <tailscale args>|down" >&2; exit 2 ;;
esac
