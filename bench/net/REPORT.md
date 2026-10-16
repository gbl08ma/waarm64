# Networking: the Tailscale wasm spike (N2)

> A dated journal (docs/plans/networking.md §7 N2). What exists now is in `net/tailscale/`,
> `bench/net/` and the plan.

**Setup (2026-09-29).** Cloud session container (x86_64 Firecracker, 4 vCPUs, Node 26.10.0; not the
M4 VM, so the numbers don't compare with other reports). `tailscale.com` v1.102.5 built with Go
1.26.6 (`GOOS=js GOARCH=wasm`), headscale v0.29.4 with its embedded DERP over TLS and a peer
(`tailscaled` 1.102.5, userspace networking) in containers on the host network
(`tests/net/tailnet.sh`). The tailnet's range is 100.90.0.0/16, not the default. The module runs in
a Node worker thread (`bench/net/node.ts`); `bench/net/spike.ts` logs in with a pre-auth key, then
sends hand-built IPv4 ICMP echo packets through the Tun hook and reads the replies from the packet
handler: nothing but IP packets crosses between JS and the client. All traffic goes through DERP
(the peer and the module are on one host, but a browser has no UDP anyway).

## Size

| Build | Raw | gzip -9 | brotli -11 |
|---|---|---|---|
| no feature tags, no `-s -w` (the first build) | 35,225,379 | | |
| 71 `ts_omit_*` tags (`build.sh`), `-s -w`, `-trimpath` | **26,863,282** | 6,140,210 | **4,346,948** |
| the same plus `wasm-opt -Oz` (binaryen from npm) | 24,377,779 | 6,103,916 | 4,384,560 |

- The feature tags take 24% off the raw size; more tags (`health`, `usermetrics`, `ipnbus`) take
  0.1 to 0.2 MB each: not worth the risk. What's left is mostly the Go runtime, gVisor's netstack,
  `net/http`, the control protocol and WireGuard.
- **`wasm-opt` is not used:** -9% raw, **no gain on the wire** (brotli 4.38 MB against 4.35 MB),
  3.5 minutes of build, and one more tool between the Go linker and what runs. Decision (with the
  user): ship the linker's output unmodified.
- Over the wire it's **4.3 MB with Brotli** (6.1 MB gzip), against webvm's ~16 MB raw module.
  Acceptable for a download that only happens on "connect": **the Go path stays** (§5 is not pulled
  forward). Compile plus instantiate in Node: 70–90 ms (V8 compiles lazily; Chromium's number
  goes in N4).

## Startup and network (5 runs each, raw JSON in `results/n2/`)

| | min | median | max |
|---|---|---|---|
| module loaded → state `Running` (ms; key generation, registration, netmap, DERP) | 2,243 | 2,286 | 2,503 |
| ping RTT to the peer, 20 echoes (ms, run medians) | 1.4 | 1.6 | 2.0 |
| echo throughput, 1,280 B echoes, 32 in flight, 5 s (Mbit/s each way, through DERP) | 30.6 | 33.3 | 34.4 |

`opt` (the `wasm-opt` build) is indistinguishable: 2,211–2,437 ms, 1.7–2.0 ms, 28.5–33.7 Mbit/s.
Throughput is CPU-bound in the wasm (WireGuard's crypto in pure Go on one thread) and the local DERP
adds nothing: a real DERP adds its distance in latency, and the throughput here is the ceiling.
It's enough for interactive use and `apt`; not for bulk transfers at line rate.

**The first ping is bimodal:** ~32 ms in 3 of 5 runs, **~5.3 s in the other two** (both builds).
That's WireGuard's 5 s rekey timeout: the first handshake initiation reaches a peer that doesn't yet
know our node (or our DERP home) and is dropped, and the retry goes out 5 s later. A guest's first
TCP SYN retries after 1 s, so it sees a few seconds at worst; N4 looks at whether waiting for the
first peer-to-peer handshake before reporting `Running` (or nudging the peer with a disco ping)
removes it.

## In Chromium (N4, `tests/net-tailnet.test.ts`, 2026-09-29)
Playwright's Chromium 141 in the same cloud container: the module (26.9 MB, streamed) loads and
instantiates in **231–269 ms** (3 runs), the node is `Running` **2.5–2.6 s** after the start
(module load included), and the whole test, a Debian boot to a DHCP lease, a ping, two MagicDNS
lookups and a TCP connection from the peer into the guest, takes ~117 s. The CORS requirement on
the control server's `/key` is in docs/plans/networking.md (N4).

## What the spike found (don't re-discover)
- **Go's `net/http` turns `fetch` off when `process.argv0` starts with `node`**: in Node the
  control and DERP dials go through Go's fake network ("connection refused"). The Node harness
  gives the module a `process` whose `argv0` isn't "node". A page has no `process`.
- **Login needs `login()`:** `LocalBackend.Start` with an auth key does nothing until
  `StartLoginInteractive` runs (tsconnect's page calls it on `NeedsLogin`); with a key it logs in
  without a URL.
- **The JS control dialer ignores a control server's HTTPS port** (`wss://host/ts2021` on 443
  always). A headscale on :8443 fails. `net/tailscale/overlay/` holds a one-change copy of that
  file, and `build.sh` builds against a patched copy of the module (Go refuses overlays inside
  the module cache). Headscale behind a proxy on 443 doesn't need it.
- **Headscale's embedded DERP needs TLS** (`InsecureForTests` only skips the certificate check),
  so the test tailnet has a test CA; clients trust it through `SSL_CERT_FILE` (the peer) and
  `NODE_EXTRA_CA_CERTS` (Node). Chromium will need `ignoreHTTPSErrors` or the CA (N4).
- **netcheck probes `https://<derp host>/derp/probe` on port 443** whatever the DERP node's port
  is; the probe fails and logs an error, the DERP connection itself (on the node's port) works.
  Only the home-DERP latency choice is affected.
- **Logging:** upstream's wasm client sends logs to Tailscale's log server (logtail); ours logs to
  the console only, so a headscale user's node never talks to Tailscale's servers.
- **The netmap gives the addresses; the range isn't a constant.** Our node's addresses come from
  the client (`100.90.0.x/32`, `fd7a:…/128`), each peer's likewise; the gateway (N3) must not
  assume 100.64.0.0/10.
- **`IsTAP`** (§8): not looked at; the gateway route (packets on the Tun) works and is enough.

## T1: the Rust tailnet client, tailcat, in Node (2026-10-16)

docs/plans/tailnet-client.md T1: `net/ts` (Rust, tailscale-rs's `ts_tunnel` for WireGuard) built to
`wasm32-wasip1`, driven by `web/ts-client.ts`; `bench/net/tailcat.ts` against a tailcat exit node.
**Setup:** a cloud session container (x86_64, 4 vCPUs, Xeon @ 2.80 GHz, Node 26.11.1, no IPv6), not
the M4 VM; `derper` (from the `tailscale.com` tailcat v0.7.0 pins) on `derp.test:443` with a
self-signed certificate, and `tailcat serve exit-node` on it, both on the same host as the client.
The "guest" is the harness: it sends hand-built IP packets and reads the replies. Raw JSON in
`results/t1/`.

**Size:** 458,412 bytes raw, **153,882 Brotli** (`opt-level=3`, stripped); `opt-level=s`: 402,202 /
137,255. Against the Go client's 26.9 MB / 4.3 MB: **~28 times smaller on the wire**. Six WASI
imports (clocks, randomness, environment, stderr, exit).

| (5 runs, `opt-level=s`) | min | median | max |
|---|---|---|---|
| compile and instantiate (ms, bytes in hand) | 3.5 | 3.9 | 4.2 |
| client created → `Running` (ms: relay, meow, WireGuard handshake) | 64 | 67 | 75 |
| first echo, IPv4 through the translator and the exit node (ms) | 4.0 | 5.0 | 6.3 |
| UDP echo RTT, 20 echoes (ms, run medians) | 1.09 | 1.34 | 1.42 |
| echo throughput, 1,260 B, 32 in flight, 5 s (Mbit/s each way) | 62.0 | 64.5 | 71.1 |

**`opt-level` A/B** (`results/t1/opt/`, alternating, 3 pairs): `s` 58.2, 64.7, 66.6; `3` 74.4,
76.5, 78.6 Mbit/s: **~17% faster for 16 KB more Brotli**; the build uses 3.

The process runs at one core throughout (`cpuPercent`), and it is also the harness (packets built in
JavaScript) and the echo servers, so the client's own share is less; the tailcat server and derper
share the same 4 cores. So this is a floor. **Not comparable with N2's 33 Mbit/s** (another peer,
`tailscaled`, and another relay, headscale's), but both are the same kind of container and both
measure echoes through a local relay; T6 compares the two clients on one tailnet.

Findings:
- **One UDP flow per echo starves a tailcat exit node.** The first harness used a new source port
  per echo: ~15,000 flows per run, each proxied by the server for two minutes, and throughput fell
  run after run (50, 27, 12, 10, 0.24 Mbit/s, with losses) until the server restarted. A port per
  in-flight slot (as real traffic is) gives the table above. A guest that sprays UDP flows (a port
  scan, some games) will hit the same wall: it is the exit node's, not the client's.
- **ICMP isn't forwarded** by `tailcat serve exit-node` (it terminates TCP and UDP and proxies
  them): a ping from the guest gets no reply. As planned.
- `Running` takes ~65 ms against a warm server. A server that has just started answers the first
  meows only once its own relay connection is up (~2 s); the client meows every second meanwhile.
- No IPv6 here: the IPv6 echo is skipped; the dev VM runs it (below).

### T1 on the M4 (2026-10-16)

The same harness on the dev VM (Lima `dev`, 8 vCPUs of the M4, Node 26.7.0), against
`tests/net/tailcat.sh`'s derper (`127.0.0.1:8443`) and exit node on the same VM; `opt-level=3`
(459,855 bytes). Five runs, JSON in `results/t1/m4/`:

| (5 runs) | min | median | max |
|---|---|---|---|
| compile and instantiate (ms) | 1.0 | 1.1 | 1.2 |
| client created → `Running` (ms) | 31 | 32 | 32 |
| first echo, IPv4 through the translator (ms) | 1.0 | 1.0 | 1.1 |
| first echo, **IPv6** untranslated, to `fd00:7e57::1` (ms) | 1.4 | 1.5 | 1.6 |
| UDP echo RTT, 20 echoes (ms, run medians) | 0.64 | 0.71 | 0.83 |
| echo throughput, 1,260 B, 32 in flight, 5 s (Mbit/s each way) | 323 | 325 | 329 |

No echo lost; the process at ~107% of a core. **~5 times the cloud container's numbers**, on a
machine whose cores are much faster and where derper and tailcat have their own cores; still the
harness's floor, not the client's ceiling. Found: **the exit node doesn't answer IPv6 to its
`[::1]`** (the first harness's target: every echo timed out, nothing in tailcat's log). A loopback
destination arriving from the tunnel is dropped by its netstack, while `127.0.0.1` works because it
arrives as NAT64 `64:ff9b::7f00:1`. The harness now echoes to the machine's own non-link-local IPv6
address; Lima's VM has none, so the run adds one (`sudo ip -6 addr add fd00:7e57::1/128 dev eth0
nodad`; on `lo` Node calls it internal and the Debian test wouldn't pick it).

## Reproduce
```sh
net/tailscale/build.sh                       # target/net/tailscale.wasm, needs Go (go.mod pins the toolchain)
tests/net/tailnet.sh up                      # headscale + a peer in rootless Podman; prints the environment
eval "$(tests/net/tailnet.sh env | sed 's/^/export /')"
WEBPC_TS_AUTHKEY=$(tests/net/tailnet.sh key) node bench/net/spike.ts $WEBPC_TS_CONTROL $WEBPC_TS_PEER_IP 5
tests/net/tailnet.sh down
# T1: a tailcat exit node on derper, both on this machine
net/ts/build.sh
tests/net/tailcat.sh up && eval "$(tests/net/tailcat.sh env)"
sudo ip -6 addr add fd00:7e57::1/128 dev eth0 nodad    # only where the machine has no non-link-local IPv6
WEBPC_TS_JSON=… NODE_EXTRA_CA_CERTS=$WEBPC_TAILCAT_CA node bench/net/tailcat.ts $WEBPC_TAILCAT_ADDR 5
tests/net/tailcat.sh down
```
