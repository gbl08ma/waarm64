# Networking: the Tailscale wasm spike (N2)

> A dated journal (docs/plans/networking.md §7 N2). What exists now is in `net/ts/` (the page's
> client since T6), `bench/net/` and the plans. The Go client's N2 harness (`bench/net/spike.ts`,
> `node.ts`) left with the Go client (2026-10-17; git history has it).

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

The tailnet client's T1 (docs/networking/tailnet.md): `net/ts` (Rust, tailscale-rs's `ts_tunnel` for WireGuard) built to
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

## T6: the Go and Rust Tailscale clients in Chromium (2026-10-16)

`bench/net/clients.ts` on the dev VM (Lima `dev`, 8 vCPUs of the M4), Chromium 153.0.8010.52
headless, against `tests/net/tailnet.sh` (headscale v0.29.4 with its embedded DERP, a userspace
`tailscaled` v1.102.5 peer, both in Podman on the same VM). No guest: the page
`tests/browser/tailscale.html` plays it, UDP echoes to a Node echo server behind the peer. Five
runs per client, alternating (Go first in even runs), a fresh browser context each; Go is
`net/tailscale` at Tailscale v1.102.5, Rust `net/ts` at `1d8b184`. JSON in
`results/t6/clients-m4.json`.

| (5 runs: min / median / max) | Go | Rust |
|---|---|---|
| module, raw | 27,654,473 B | 1,874,287 B |
| gzip -9 | 6,367,615 B | 665,467 B |
| Brotli 11 | 4,528,207 B | **491,832 B** |
| load and instantiate (ms) | 33 / 34 / 43 | 5.4 / 5.8 / 6.3 |
| client started → `Running` (ms) | 2045 / 2149 / 2231 | 1664 / 1733 / 2102 |
| UDP echo RTT, 500 one at a time (ms) | 0.62 / 0.63 / 0.64 | 0.48 / 0.49 / 0.50 |
| 20,000 echoes of 1,228 B, 32 in flight (Mbit/s each way) | 61.6 / 61.8 / 62.4 | **134.9 / 137.7 / 140.9** |
| the worker thread's CPU during it (cores) | 0.97 / 0.97 / 0.98 | 0.86 / 0.86 / 0.88 |
| worker CPU per Mbit carried, both ways (core-ms) | 7.81 / 7.86 / 7.89 | **3.10 / 3.13 / 3.21** |
| worker memory at `Running` (MB) | 19.5 / 20.0 / 20.0 | 2.09 / 2.09 / 2.09 |
| worker memory after the echoes (MB) | 24.6 / 26.4 / 28.4 | 2.15 / 2.15 / 2.15 |

No echo lost by either. The Rust client: **a ninth of the download**, **2.2 times the
throughput at 2.5 times less CPU per Mbit**, a tenth of the memory, and it doesn't grow under
traffic; `Running` is headscale's first map (~2 s after registration) for both, Rust's ~0.4 s
sooner (not broken down). Go's worker is pinned at a core, so its 62 Mbit/s is
its ceiling here; Rust's isn't quite, and what else limits it (the page's echo loop, the peer, the
DERP) wasn't separated. *How:* memory is `performance.measureUserAgentSpecificMemory()`
(Chromium run with `--enable-blink-features=ForceEagerMeasureMemory`), the breakdown entries
attributed to the `DedicatedWorkerGlobalScope`; checked to include a worker's wasm linear memory
(a 100 MiB `WebAssembly.Memory` reported as 105 MB). CPU is the `utime + stime` of the renderer's
`DedicatedWorker` threads from `/proc` around the throughput run (the harness checks that there's
exactly one). The cloud session's indications (x86_64, Chromium 141: 34 vs 17 Mbit/s) had the
same ratio.

## Batches: what one relay message carries, both ways (2026-10-17)

`bench/net/transfer.ts` on the dev VM (Lima `dev`, 8 vCPUs of the M4), Chromium 153.0.8010.52 headless: the page's
Debian through `tests/net/tailcat.sh`'s exit node and derper (both on the VM), 8 MB down and 8 MB up over IPv4 (the
client's NAT46), two rounds per boot, one boot per row; virtio-net's offloads on (TSO hands the device up to 64 KB at
a time). Batch sizes came from temporary console counters, not in the tree: packets for the guest and WebSocket sends
per `pump` of the tailnet worker (`web/ts-client.ts`), frames per delivery of virtio-net (`web/devices.ts`). JSON in
`results/batches/`.

**What the relay already batches.** derper writes a client's queued packets into a 4 KB buffered writer and flushes
when its queue is empty (`derpserver.go`'s `sendLoop`; `bufio.NewWriter` over the WebSocket in `websocket.go`), and
each write is one WebSocket message. In a download a pump gave the guest 1 packet 2,095–2,666 times, 2 packets
1,681–2,257 times, 3 packets 2–569 times, 4 up to 31 times: ~1.7 per message, 60–70% of packets with others (the ACKs of an
upload: up to 17 per message). Before batching, the worker posted each packet on its own and virtio-net delivered
one frame at a time, always (7,186–7,256 deliveries for ~7,200 packets).

**The upload: one relay message per segment.** Each TSO packet's ~48 segments crossed the IP port one per message,
and each became its own WebSocket message: 6,979 and 6,995 for 8 MB (~9,000 a second). With the IP port's batches
(`batchSender`) a TSO packet's segments reach the client in one message and their frames are joined:

| relay message cap (8 MB up, 2 rounds) | WebSocket messages | Mbit/s | guest CPU (s) | JSON |
|---|---|---|---|---|
| none (one frame each) | 6,979 / 6,995 | 86 / 87 | 0.43 / 0.37 | `1-none.json` |
| 64 KiB | (stalled) | 0.67 / 0.67 (100 s timeouts) | | `2-64k.json` |
| **4 KiB** (built) | 2,682 / 2,641 | 86 / 131 | 0.36 / 0.28 | `3-4k.json` |
| 16 KiB | 1,185 / 1,108 | 86 / 131 | 0.37 / 0.43 | `4-16k.json` |

**The 64 KiB collapse:** derper queues at most 32 packets per destination client and drops the oldest past that
(`perClientSendQueueDepth`, `dropReasonQueueHead`); a whole TSO packet in one message lands ~48 at once, so every
burst lost packets and TCP backed off to nothing. 4 KiB (about three packets) is the size of the relay's own writes,
so we never send it bigger bursts than it sends us; 16 KiB (twelve) worked here, but a real relay shares that queue
with every other sender to the same exit node, which this rig can't show, so the cap stays at 4 KiB. Downloads
didn't change (the first download after a boot ran at ~65 Mbit/s in three of the four runs and 86 in the first;
not separated). Throughput here is the rig's (exit node, relay and browser on one VM), not the guest's: the guest's
CPU stays under its wall time.

**The download: merged into the guest.** With the batches kept to the device, virtio-net merges each batch's
consecutive TCP segments into one packet (`GUEST_TSO4`/`6` over `MRG_RXBUF`, web/offload.ts `receive`). The guest's
interface counts a merged packet once:

| (8 MB down, 2 rounds) | packets into the guest (`rx_packets`) | Mbit/s | guest CPU (s) | JSON |
|---|---|---|---|---|
| before (the 4 boots above) | 7,181–7,256 | 65–87 | 0.41–0.69 | `1-none.json` to `4-16k.json` |
| merged (3 boots) | 4,578–5,186 | 13.7 (once), 65 / 65, 86–88 | 0.37–0.84 | `5-merge-1.json` to `5-merge-3.json` |

About 1.5 times fewer packets through the guest's stack (its driver, GRO, IP and TCP). Throughput didn't change
(the rig's limit), and the guest's CPU time is too noisy at this size to show a difference. One first download
after a boot took 4.9 s (13.7 Mbit/s); the other two first downloads ran at 65 Mbit/s like every earlier run's but
one; not explained from these runs.

## The local helper against tailcat (L0, 2026-11-01)

docs/plans/networking-local.md L0's questions, in Chromium 153.0.8010.52 on the dev VM (Lima, M4 Mac mini, 8 vCPUs, 18 GiB).
Raw JSON in `results/local-helper/`: `arms.json`, `variants.json`, `lna.json`, `ipv6-mac.json`, `ipv6-reach.json`.

**Setup.** The page's Debian, curl in the guest to a Node server on this machine's LAN address, so every arm crosses the
same path past its own tunnel: 32 MiB each way (8 MiB through the public relay, rate-limited), three rounds per boot, alternated
boots (`local`, `tailcat`, `public`; `arms.json` holds three boots of each, two of `public`: the run hit its 2000 s cap on the
stalled uploads below). Round trip is curl's TCP connect, 20 in a row, because a tailcat exit node doesn't forward ICMP. CPU
is in cores over the transfer, from /proc: the renderer's threads, the network service, and the helper apart. The server is a
hop away, so these are ceilings: a real connection stops at its uplink.

| Arm | Connect (ms) | Down (Mbit/s), median, IQR | Up | Page's and network service's CPU per 100 Mbit/s, down, up |
|---|---|---|---|---|
| The helper, MTU 1500 | 1.81 | 556, 479–605 | 355, 351–377 | 0.52, 0.67 |
| tailcat, relay on this machine | 2.03 | 123, 119–133 | 218, 217–225 | 2.13, 0.99 |
| tailcat, public relay | 101 | 4.2, 3.5–4.4 | 18.9, 18.8–18.9 | 15.7, 5.6 |

The relay's distance is the whole round-trip difference: a relay on this machine adds 0.2 ms. Against that relay the helper moves 4.5× more down
and 1.6× more up, at a quarter of the CPU per Mbit down, which fits the client's crypto being the limit (T1) but wasn't broken out here. The public relay's upload is flat at 18.9 Mbit/s, a
rate limit; its download is worse and noisy (2–19 Mbit/s). The helper's ping (3.6 ms) is worse than its TCP connect (1.8 ms) and
wasn't looked into; no tailcat arm has a ping to compare.

**Where the client runs, and batching** (`variants.json`, two boots of each, the patch in `variants.patch`):

| Client | Down | Up | Main thread, down, up (cores) | Network service, up | Frames per message from the guest, down, up |
|---|---|---|---|---|---|
| The page, a message per frame | 540, 405–580 | 357, 332–366 | 0.53, 0.62 | 0.36 | 1.0, 1.0 |
| The page, batched | 500, 409–544 | 766, 725–789 | 0.45, 0.53 | 0.13 | 1.7–2.9, 31–42 |
| A worker, a message per frame | 575, 482–604 | 363, 362–364 | 0.01, 0 | 0.40 | 1.0, 1.0 |
| A worker, batched | 606, 489–612 | 754, 750–757 | 0.01, 0 | 0.15 | 3.4–3.9, 28–33 |

"Batched" flushes on `setTimeout(0)` instead of a microtask, so the frames that arrive while a task runs share a message.
**Upload doubles** (its IQR doesn't overlap), the network service drops by 60%, and the round trip doesn't move (connect 1.8 ms in all
four). Down doesn't change: the helper batches already (15–19 frames a message). **A worker takes the client off the main thread** (half a
core off the thread the display and the UI share) at no cost in throughput or round trip. Decided: a worker, batched.

**The MTU.** (Past L0: "The stalled uploads" below.) The first run stalled every upload past 1500: `web/offload.ts` `transmit` drops a plain frame over `MAX_FRAME`
(1518), which is what a NIC does, so the guest's large non-GSO segments vanish while it believes the helper's lease. Downloads
worked (612, 687 and 1080 Mbit/s at 4000, 9000, 65520). With `MAX_FRAME` raised for the run, one boot each, unbatched, in the page:

| MTU | Down | Up | Main thread, down, up | All CPU per 100 Mbit/s, down, up |
|---|---|---|---|---|
| 1500 | 540 | 357 | 0.53, 0.62 | 0.59, 0.69 |
| 9000 | 702 | 821 | 0.48, 0.46 | 0.38, 0.27 |
| 65520 | 998 | 1410 | 0.35, 0.30 | 0.19, 0.11 |

One boot each is a direction, not a measurement, and a larger MTU wasn't run with batching or in a worker. It's a large win, past what most uplinks
need: the helper terminates TCP, so a guest's segments never reach the internet at that size.

**Local Network Access** (`lna.ts`, headless, so no prompt is seen: an ask ends denied at once):
- In Chromium 153 a page reaching loopback needs the permission **`loopback-network`**, not `local-network-access` (a grant of that or
  of `local-network` leaves the socket refused; `local-network` is for the LAN). `navigator.permissions.query` answers for all three.
- A public page's socket to `ws://127.0.0.1` is **gated**: on `https://vm.tny.im` as deployed (cross-origin isolated) and on a local
  copy that `--ip-address-space-overrides=127.0.0.1:<port>=public` calls public. Refused, it closes 1006 within 1–8 ms, indistinguishable from a
  helper that isn't running; `permissions.query` tells them apart (`denied`). Granted, it opens in 1–6 ms: no mixed-content block from an https page.
- **The same from a worker**, and a worker's socket alone makes the request (state `prompt` to `denied` with nothing from the page).
- A `127.0.0.1` page isn't gated at all, which is why the tests never saw any of this.
- A grant through CDP (`Browser.setPermission`) lasts through reloads but not a restart. A content setting in the profile's Preferences
  (`profile.content_settings.exceptions.loopback_network`, where a click on the prompt stores it) reads back as `granted` after a
  restart, page and worker. A refusal stays until the user changes it in the site's settings, so the page has to say where.
- **For tests:** Playwright 1.63's `grantPermissions` doesn't know `loopback-network`: use CDP's `Browser.setPermission`, or
  `--disable-features=LocalNetworkAccessChecks`.
- Not seen: the prompt itself, its words, and whether it appears over a page without a user gesture. That takes a headed browser: the user's, at L2.

**IPv6 on a host that has it.** `local-ipv6.ts mac`: the helper built for macOS, on the Mac with its real IPv6, over an ssh tunnel to
the page here. Default route at the lease; `curl -6` by name and over TLS, connect 55 ms; a dual-stack name chooses IPv6 by itself; `apt-get update` with
`ForceIPv6` exits 0. It found the bug below only in the second rig, since traffic kept the neighbor fresh.

`local-ipv6.ts netns` (`unshare -Urn`): everything in a namespace whose "internet" is a dummy interface holding the probe's address,
removed and put back under a running guest. Removed: the default goes in 48 s, on the helper's minute probe; `curl` exits 7 within 1 ms.
Back: the default returns in 60 s. Both bound by the minute, as designed.

**A bug that found:** the guest's default route vanished 5.4 s after each pause in its traffic (the same 5.4 s twice, nothing logged by networkd or the
helper). gVisor sets a neighbor advertisement's Router flag only on a forwarding stack, and the library's doesn't forward, so when Linux re-checked its
router the answer said "not a router", and it dropped the default (`ndisc_recv_na`) until the next router advertisement, up to 5 minutes. Every host
with IPv6 would have had it. The helper now sets the flag on the gateway's advertisements (`markRouter`, `TestGatewayIsARouter`, which failed first); both rigs check the default after 40 s idle.

**The stalled uploads (2026-11-02).** `mtu.json`, the worker and the batching at 1500, 9000 and 65520, 64 MiB each way with `curl -m 60`:
1.0-1.25 Gbit/s down and 1.35 up at 65520 against 0.5-0.75 and 0.8-0.9 at 1500, but 4 of about 21 uploads stalled, at every MTU (3.8 to
8.9 Mbit/s over the 60 s), and every connection after one failed within 2-3 s until the next boot. **The cause:** the page's client
batches what comes before a `setTimeout(0)` with no bound, and the helper reads at most `MaxMessage` (1 MiB). A burst past that (16 frames
at 65520, about 700 at 1500; what holds the worker's timer back that long wasn't looked into) made coder/websocket close the socket
("read limited at 1048577 bytes"), so the guest's card went on sending to nothing: the transfer hung until curl's limit, and new
connections failed in the 2-3 s (ARP's retries, by the timing; not traced). It looked like a stall because nothing in the bench showed the helper's log or the page's error; `local.ts` prints both now.
Once they were printed the first run named it: 2 boots of 2 lost the link, at the first upload at 65520 (`stall-before.json`) and the second
at 1500 (the run was stopped there, so the file holds only the first), each with the helper's "disconnected" and the page's "read limited".
**The fix:** a batch goes out early at `LOCAL_MAX_MESSAGE` (web/local-net.ts); a test pins that number to the helper's and that frames
stay whole and in order, and `TestMessageAtTheLimit` that the helper takes a message of exactly that size. After it (`stall-after.json`:
one boot each, 12 rounds): 36 uploads with no disconnect or stall, the slowest 857 Mbit/s:

| MTU | Down, mean (slowest) | Up, mean (slowest) |
|---|---|---|
| 1500 | 627 (466) | 947 (857) |
| 9000 | 722 (111) | 1322 (1172) |
| 65520 | 1082 (458) | 1481 (1350) |

(The slowest downloads are one transfer each in a boot of 24; not looked into.) A closed socket still leaves the guest's link up, by design
(a reconnect keeps its lease, plan §3): the Network menu says why and offers Retry; the bench's harness has no such hand.

**`ci-net.sh` on the dev VM:** passes, 582 s. `tests/net-local.test.ts`: login 31 s, 8 MiB at 432 Mbit/s down, 291 up, IPv4 only here. The first run failed in
the helper's Go tests: under `-race` an idle gVisor stack keeps every core busy (0 CPU without it), and the stacks the earlier tests left starved
`TestTCPToHost` into its deadline. They're now destroyed in cleanup. Not a defect of the helper.

## Rooms: the direct path against DERP (R0, 2026-11-10)

the P2P track's R0 (docs/networking/rooms.md): is a room's direct path (WireGuard inside a WebRTC data channel) clearly better
than DERP? `bench/net/room.ts`, 5 rounds alternating three arms, fresh pages each: **direct** (two members of a room
in two pages, tests/browser/room.html, the dialer given the other's key, on the tailcat rig's derper; the first echo
goes through the relay, then the data channel opens), **relay** (the same, the dialer relay only: no WebRTC) and
**raw** (bench/net/rtc-raw.html: the same echoes over a bare data channel between two workers, no WireGuard, no
module, no IP port). Echoes of 1,280-byte IPv6 packets, 32 in flight, 10,000 per arm; RTT one echo at a time; CPU
of every Chromium process and the derper over the throughput run, per Mbit/s of both directions. **A cloud session**
(x86_64, 4 vCPUs, Chromium 153.0.8010.12 headless, everything on loopback): absolute numbers aren't comparable with
the dev VM's (docs/cloud.md), the arms are with each other. JSON: `results/r0/room-2026-11-10.json`.

| Arm | Mbit/s each way, median (IQR) [rounds] | core-ms per Mbit/s | RTT | first echo after `Running` | channel open after the handshake |
|---|---|---|---|---|---|
| direct | **50.9** (43.2–56.2) [42.4–63.3] | **23.5** (22.7–23.9) | 0.77 ms | 23 ms (through DERP) | 23 ms |
| relay | 35.1 (32.6–35.9) [30.8–36.8] | 34.3 (34.1–34.4) | 0.95 ms | 22 ms | — |
| raw | 70.6 (57.9–74.6) | 16.6 (16.4–16.7) | 0.24 ms | — | 35 ms (setup) |

- **The gate holds**: the direct path's slowest round is faster than the relay's fastest (+45% at the medians), at
  31% less CPU per Mbit, with a derper on the same machine, DERP's best case; a real relay adds its distance to
  every packet and caps what it forwards (docs/networking/tailnet.md "tailcat": the public relays are rate-limited). R0's other
  questions left for R3: setup time across real NATs, and how often ICE fails.
- **The inner WireGuard and the plumbing** (the module, the worker, the gateway's port) cost about 28% of raw's
  throughput and 40% more CPU per Mbit; the RTT difference (0.77 against 0.24 ms) is mostly the hops between the
  harness's page, the worker and the channel, which a guest's packets also take. Not worth a second encryption
  scheme: WireGuard's binding of address to key and the fallback are what the design rests on (plan §1).
- Every arm brought back all 10,000 echoes: the unordered, unretransmitted channel lost nothing on loopback at 32 in
  flight (§6 saw 0.7% at saturation).

**Again in the dev VM** (R4, 2026-11-10: openSUSE Tumbleweed aarch64 under Lima on the M4 Mac mini, 8 vCPUs,
Chromium 155.0.8059.84 headless; `node bench/net/room.ts 5 10000`; JSON: `results/r0/room-2026-11-10-devvm.json`).
The CPU column counts every process the harness started and the derper (it matched `/usr/bin/chromium`'s command
line before, which on this VM is a wrapper script, so it read 0 for Chromium):

| Arm | Mbit/s each way, median (IQR) [rounds] | core-ms per Mbit/s | RTT | first echo after `Running` | channel open after the handshake |
|---|---|---|---|---|---|
| direct | **183.4** (183.3–184.3) [183.0–186.6] | **13.6** (13.5–13.6) | 0.42 ms | 13.6 ms (through DERP) | 13.8 ms |
| relay | 125.9 (124.8–126.0) [123.8–130.5] | 19.9 (19.7–20.1) | 0.48 ms | 13.1 ms | — |
| raw | 239.2 (237.5–240.5) | 6.4 (6.4–6.6) | 0.24 ms | — | 15.8 ms (setup) |

- The cloud's picture holds: direct +46% over relay at the medians (rounds don't overlap), 32% less CPU per Mbit, all
  10,000 echoes back in every arm. Direct keeps 77% of raw's throughput (the cloud: 72%) at twice its CPU per Mbit.

## Rooms at scale (R3, 2026-11-10)

the P2P track's R3 (docs/networking/rooms.md): what a room costs as it grows, with nothing outside the test harness.
`bench/net/room-scale.ts` starts **1,000 members** in 4 Node processes (`bench/net/room-member.ts`: the Rust client
in a module instance each, as a page's worker holds one, relay only since Node has no WebRTC, its guest an echo on
UDP port 7) at 100 a second, on the tests' Nostr relay (tests/net/nostr-relay.ts, a process of its own; it matches
filters by scanning, so its CPU isn't a real relay's, but what it carries is) and the tailcat rig's derper, then
runs phases: a minute idle, random new pairs at 10 and then 50 a second (the time from the dialer's first packet to
the first echo back: the lookup, the call back through DERP, the handshake and the echo), 20 and then 200 members
dialing one member at once, and the hour's turn (the members' clocks shifted so it falls in the run). **A cloud
session** (x86_64, 4 vCPUs, Node 26, all on loopback): absolute times are loopback's, without a public relay's or
DERP's distance (R4's). JSON: `results/r3/scale-before-2026-11-10.json` (the code before R3's two fixes) and
`results/r3/scale-2026-11-10.json` (after); the phases that the fixes don't touch agree within a few percent.

| Phase | |
|---|---|
| join, a member's first REQ at the relay after its start | p50 4 ms, p99 23 ms; the last hundred as fast as the first (4 against 5 ms) |
| join, `Running` (home region connected) | p50 6.6 ms, p99 30 ms; none failed |
| idle, a thousand members | relay 16.9 REQs/s (each renews a minute), 2.8 KB/s in; the workers' CPU under 0.05 ms a member a second |
| a member's memory | 1,408 KiB of linear memory (each instance, unchanged by the lookups' peers); ~1.13 MiB RSS a member in Node; the derper ~85 MiB for 1,000 connections |
| lookups, 10 new pairs/s | 300 of 300; p50 5.5 ms, p99 14 ms; 10 events/s in and forwarded (one each) |
| lookups, 50 new pairs/s | 1,500 of 1,500; p50 5.0 ms, p99 11 ms; 50 events/s, 32 KB/s in |

What the crowds and the turn found, before and after the fixes in room.rs:

| | before (4 trials/s, the rest dropped; renewed at the turn) | after (16/s, the rest waiting, 64 at most; renewed at the next minute's check) |
|---|---|---|
| 20 dialers at once | all 20 in, but 4 within 1 s, 8 within 3 s, the last at 12 s | 16 within 1 s, all 20 within 1.01 s |
| 200 dialers at once | **25** in within 15 s (5 within 1 s, 13 within 6 s) | **193** (17 within 1 s, 49 within 3 s, 97 within 6 s, the rest through their retries) |
| the relay at the hour's turn | **1,000 REQs and 1,000 CLOSEs in one second** (from 17 a second) | none at the turn; the renewals in each member's minute slot (here the 10 s they joined in, ~100/s, as in every minute) |
| 30 pairs dialing from 10 s before the turn to 20 s after | 30 of 30 | 30 of 30 |

- **Nothing grows with the room**: a member's subscription matches only its own tags, so its worker sees only the
  lookups for it, and a lookup is one event forwarded to one subscriber. The relay's load is the members' renewals
  (one REQ a member a minute) plus one event per new pair; DERP's, one connection a member.
- **Crowds** were limited by the target's trial budget: past it, a lookup was dropped and that dialer got in only on
  its resend (1 s, 3 s) or its next try after giving up (6 s, then 5 s unreachable). A forged lookup costs a target
  one 148-byte initiation through one of the room's own regions, and a trial lasts 20 s, so 16 a second keeps at
  most 320 on trial (under the 1,024 peers); the call backs past it now wait their turn, so a crowd gets in at the
  budget's rate. 200 at once still take ~13 s, which only a busier budget would shorten.
- **The hour's turn** fell on the same Unix second for every member of every room, on every relay: a room of a
  thousand sent a thousand REQs and CLOSEs at once, and a public relay carrying many rooms would see them all. The
  subscription covers the next hour's tag already, so the turn now waits for each relay's next renewal (within a
  minute), spread as the members' joins are; a dialer more than ~59 minutes ahead of the target misses it for that
  minute at most.
- What a room needs from a relay (the kind, the filter, the rates above) is written in docs/networking/rooms.md "What a room needs from a Nostr relay".

## Reproduce
```sh
# T1: a tailcat exit node on derper, both on this machine
net/ts/build.sh
tests/net/tailcat.sh up && eval "$(tests/net/tailcat.sh env)"
sudo ip -6 addr add fd00:7e57::1/128 dev eth0 nodad    # only where the machine has no non-link-local IPv6
WAARM64_TS_JSON=… NODE_EXTRA_CA_CERTS=$WAARM64_TAILCAT_CA node bench/net/tailcat.ts $WAARM64_TAILCAT_ADDR 5
tests/net/tailcat.sh down
# Batches: 8 MB down and up through tailcat (the batch histograms need the counters described above)
node bench/net/transfer.ts <label> bench/results/local/<label>.json    # brings tests/net/tailcat.sh's rig up and down itself
# T6: the Tailscale client in Chromium (brings the Podman tailnet up and down itself; the only Chromium running;
# the Go column came from the same harness before the Go client left the page: git show 762cadc:bench/net/clients.ts)
net/ts/build.sh
WAARM64_TS_JSON=bench/net/results/t6/clients-m4.json node bench/net/clients.ts 5 20000
# Rooms (R0): direct, relay only and a bare data channel, alternating (brings tests/net/tailcat.sh's rig up and down itself)
node bench/net/room.ts 5 10000 bench/net/results/r0/room-<date>.json
# Rooms at scale (R3): a thousand members in four processes on the tests' relay and the rig's derper (~10 min; brings the rig up and down itself)
node bench/net/room-scale.ts 1000 4 bench/net/results/r3/scale-<date>.json
# The local helper: the arms, then (with results/local-helper/variants.patch applied) the client's variants and the MTU
node bench/net/local.ts bench/net/results/local-helper/arms.json local tailcat public local tailcat public --rounds 3 --mib 32
node bench/net/local.ts bench/net/results/local-helper/variants.json local local::batch local::worker local::worker,batch local:9000 local:65520 --rounds 3 --mib 32
node bench/net/lna.ts bench/net/results/local-helper/lna.json
node bench/net/local-ipv6.ts mac bench/net/results/local-helper/ipv6-mac.json
(cd net/waarm64-net && go build -o ../../target/net/waarm64-net .) && unshare -Urn node bench/net/local-ipv6.ts netns bench/net/results/local-helper/ipv6-reach.json
```

## Rooms on public servers (R4, 2026-11-11)

the P2P track's R4 (docs/networking/rooms.md), from the dev VM (Lima on the M4 Mac mini, on a home connection in Europe; no
IPv6): `bench/net/room-public.ts`, Node members (bench/net/room-member.ts: the module, relay only). JSON:
`results/r4/nostr-2026-11-11.json`, `results/r4/derp-2026-11-11.json`.

**Nostr relays** (our three defaults, then Trystero 0.26.0's maintained list), each alone in a fresh private room, DERP
through tailcat's Frankfurt region (303): the first echo, in ms, after the members are `Running` (the lookup, the
call back, the handshake and the echo over DERP, whose RTT here is 98 ms); the same with both members' clocks 60 s
and 600 s fast; and a real lookup right after 16 lookups to absent members at the guest's cap (8 a second). "no":
no echo in 15 s.

| Relay | now | +60 s | +600 s | after a burst | What it said |
|---|---|---|---|---|---|
| nos.lol (ours) | no | | | | nothing: takes the REQ (EOSE) and the events, forwards none; from Chromium too |
| relay.damus.io (ours) | no | | | | closes Node's WebSocket in its handshake (Cloudflare); from Chromium, 1 lookup of 4 came through (3.5 s) |
| relay.primal.net (ours) | 378 | 392 | 386 | 1,395 | |
| bendernostur.duckdns.org:8443 | 294 | 294 | 293 | 1,296 | asks for NIP-42 auth, carries the room anyway |
| cdn.satellite.earth | 369 | 360 | 351 | 1,355 | asks for NIP-42 auth, carries the room anyway |
| nostr.chaima.info | 305 | 304 | 308 | 1,326 | |
| nostr.christiansass.de | 443 | 320 | 318 | 1,333 | |
| nostr.rblb.it | 409 | 408 | 324 | 1,383 | |
| nostr.red5d.dev | 361 | 376 | 367 | 1,378 | |
| nostr.stakey.net | 417 | 406 | 409 | no | rate-limited: too many requests |
| nostrcity-club.fly.dev | 1,409 | 401 | 390 | 1,391 | |
| relay-dev.gulugulu.moe | 1,445 | 1,436 | 440 | 1,457 | |
| relay.aarpia.com | 599 | 616 | 1,417 | 1,417 | |
| relay.agentry.com | 879 | 427 | 409 | 1,437 | |
| relay.degmods.com | 1,416 | 414 | 413 | 1,388 | |
| relay.grigic.org | 331 | 337 | 332 | 1,335 | |
| relay.hackshed.dev | 1,478 | 473 | 482 | 1,443 | |
| relay.layer.systems | 308 | 310 | 305 | no | "mute: no one was listening", then rate-limited |
| relay.nostr.blockhenge.com | 941 | 491 | 442 | 1,466 | |
| relay.nostr.dev.br | 944 | 324 | 394 | 1,332 | |
| relay.nostrmap.net | 605 | 430 | 431 | 1,403 | |
| relay.novospes.com | 398 | 415 | 427 | 1,393 | |
| relay.piazza.today | 1,507 | 370 | no | 1,483 | "ephemeral event is in the future" at +600 s |
| relay.routstr.com | 376 | 439 | 408 | 1,410 | |
| testr.nymble.world | 837 | 460 | 459 | 1,425 | |
| 0x-nostr-relay.fly.dev, nostr.robosats.org, relay.flashapp.me, relay.bullishbounty.com | no | | | | close the connection (from Chromium too) |
| relay.bitmacro.cloud | no (2.5 s on a second run) | | | | |
| relay.kaleidoswap.com | no | | | | NIP-42 auth, and "event kind 26354 not allowed" |

- **Each REQ's EOSE** (2026-11-12, ad hoc from the dev VM, twice: the room's own REQ, `limit: 0` and three `#x`
  values, then the same ID again 2 s later on that connection): nostr.chaima.info, relay.grigic.org, nostr.red5d.dev,
  nostr.christiansass.de, nostrcity-club.fly.dev, relay.aarpia.com, relay.nostr.dev.br and bendernostur (AUTH) never
  answer with an EOSE, though they forward events, so a member takes them for dead every 15 s and reconnects (the
  rooms' logs, "didn't answer"); primal.net, novospes.com, routstr.com, rblb.it, degmods.com, nostrmap.net,
  hackshed.dev, agentry.com, blockhenge.com, nymble.world, gulugulu.moe and satellite.earth (AUTH asked, not needed)
  answer both, 0.3–1.6 s. The defaults are now the first six (plan §9).
- **Two of our three defaults don't carry rooms**: nos.lol forwards nothing, damus.io refuses Node and is unreliable
  from Chromium; relay.primal.net alone carried the user's first try. 21 of Trystero's 29 carry a room, most in
  300–450 ms to the first echo (about two DERP RTTs of it); about 1.4 s is a lookup lost (the subscription not yet
  active, or the relay slow) and its resend after 1 s.
- **Clocks ahead:** one relay of those that carry rooms refuses events 600 s ahead (piazza.today); none refused 60 s.
- **After a burst** every relay takes ~1.4 s: our own cap (`LOOKUPS_PER_SECOND`) holds the real lookup until the
  burst's second has passed (the resend after 1 s), not the relays. Two relays rate-limit the burst itself
  (stakey.net, layer.systems) and then drop the real lookup.

**tailcat's public DERP regions** (each the room's only region; lookups on the tests' own relay, on loopback): two
members on this machine, so every echo crosses the region twice each way. 20 echoes one at a time, then 4 MB each way
at 32 packets of 1,232 bytes in flight.

| Region | `Running` | first echo | RTT | Mbit/s each way | lost |
|---|---|---|---|---|---|
| 301 New York | 1,453 ms | 713 ms | 211 ms | 1.5 | 0 |
| 302 San Francisco | 1,943 ms | 845 ms | 335 ms | 0.9 | 0 |
| 303 Frankfurt | 857 ms | 255 ms | 99 ms | 3.1 | 0 |
| 304 Tokyo | 2,286 ms | 1,489 ms | 482 ms | 0.6 | 0 |

- All four carry a room, nothing lost. Throughput is the window over the RTT (32 × 1,232 bytes per RTT), so it says
  nothing about the relays' rate limits. Not measured further on purpose: tailcat's README calls them "free
  rate-limited DERP relays" with "no uptime SLAs or throughput targets", and `tailcat perf` refuses to run through
  them, so throughput tests belong on one's own derper.
- **The home region by latency** (the user's 200 ms pings, 2026-11-10: a link without `derp=` used only the map's
  first region, New York): a link without regions now takes all of the map's, and a member's home is the first to
  answer a probe (docs/networking/rooms.md "DERP"). Two members on such a link from this machine: 99 ms RTT (Frankfurt), up in
  1.2 s.


## NAMES loop 0, cloud part (N0a, 2026-11-16)

The NAMES track's measurements (docs/plans/room-names.md "Measure first", items 1 to 4; items 5 and 6 and a GPU of our
own are the dev VM's). **A cloud session** (x86_64 Firecracker, 4 vCPUs, Intel Xeon @ 2.30 GHz, shared; Node
26.13.1, Playwright's Chromium 153.0.8010.12 headless, the pinned nightly): **its times are cloud figures, provisional
until a dev VM run**; they are good for ratios and for choices a 20% error can't move. JSON under
`results/names0/`: `stamps.json` (the batch), `history.json` (time to anchor), `pow-verify.json` (proof of work and
verification), `requests.json` (what was asked of each public service).

### A batch of real stamps (for N0b)

`bench/net/ots-stamps.ts stamp` POSTed random 32-byte digests (not names) to `alice`, `bob` (opentimestamps.org) and
`finney` (eternitywall.com), with a generic User-Agent: **80 digests, 2026-11-16 19:11 to 21:04 UTC**, every one at all three (240
receipts, none refused). Made together: seven bursts of 8 POSTed at once (19:11:11 and 19:11:32, then 19:33, 19:55,
20:17, 20:39, 21:01), which a calendar aggregates into one tree; apart: 23 single digests every 5 minutes between
them, and one test digest (19:11:01), so the batch spans one or two transactions at `finney` and several at `alice` and
`bob`, where stamps share the tail from the calendar's tip. Every receipt is in `stamps.json` with its
commitment (the message the calendar timestamps) and the time it was made; a receipt came in a median of 1.1 s at alice, 2.3 s at bob, 1.4 s at finney (3.0 s at worst).
**Collecting** (N0b, any session, from the committed files alone): `NODE_USE_ENV_PROXY=1 node bench/net/ots-stamps.ts
collect` (once a run per unfinished receipt; reruns ask only for what is still pending), then `node
bench/net/ots-stamps.ts sizes` for the anchors' sizes, raw and with what proofs in one block share (the calendar's
tail; the header once). The proofs and their headers (from both explorers, which must agree, and checked against the
proofs' Merkle roots) go to `results/names0/proofs.json`; one of them, with its header, is N1's vector. **Collect from 2026-11-18 on** (finney's slowest is about a day); the calendars keep proofs for years.

**A first look** (21:04, the 17 digests made before 19:12): all finished at alice (block 976,177, 19:25 UTC) and at bob
(976,178, 19:38), pending at finney. Each was in its calendar's first transaction mined after the stamp (the status
pages show no alice or bob transaction in the blocks between): the **next** reading of the model below, 14 and 27
minutes to the block. Their anchors were 1,068 to 1,208 bytes whole (digest to Merkle root), as the stamp of
2026-11-15 had it.

### Time to anchor (`bench/net/ots-history.ts`)

**The calendars' addresses.** Each calendar's status page names a donation address and lists its latest transactions
(alice: `bc1qep2un4…`, bob `bc1q83zmv…`, finney `bc1q9gmuj…`). Those transactions (one input, the change back and an
`OP_RETURN` with the Merkle tip) showed that **a calendar pays from a new change address every time, and from several
coins in turn**: each transaction spends the change of an earlier one on the same coin (alice's every other
transaction, bob's about one in five). So no address lists a calendar's history, and **a year can't be read within a
few hundred requests**: it is one request a transaction (alice alone ~16,000 a year). What was read instead:

- **The complete record of the last days**, from the status pages (every transaction with its confirmations, so its
  height): alice 143 transactions over 457 blocks (2026-11-13 to 16), bob 105 over 462, finney 103 over 4,052 (from
  2026-10-19). Fee rates 0.12 to 3.4 sat/vB.
- **A year's samples**: windows of consecutive transactions **on one coin** (so an upper bound on the calendar's
  waits, its other coins' transactions falling between), walked forward through the explorers' `outspends` from the
  transactions that spent gifts to the donation address (the address's history lists them, at whatever dates people
  gave): alice 9 windows of 24 (dates from 2025-12-10 to 2026-11-16), bob 7 of 18, finney 4 of up to 8 (it spent
  gifts on few dates).
- **A year of block times and fees**: mempool.space's fee-rate series (an average every 48 blocks), which also gives a
  height's time. No day of the year had blocks whose 10th-percentile fee rate passed 5 sat/vB (2026-02-05), so no
  long stall the samples could have missed was likely.

The model: a stamp at a uniform time goes into the calendar's first transaction mined after it (**next**; the
calendar replaces its unconfirmed transaction with one carrying the newer tip), or, slowly, the one after (**second**);
the proof is served once that block is 6 deep (five more blocks, drawn as exponential intervals at the time's mean).
The first proofs of the batch fit **next**; N0b checks it over all of them. Hours, stamp to proof:

| | median | p90 | p99 | worst |
|---|---|---|---|---|
| alice, last 3 days (complete) | 1.04 | 1.82 | 2.75 | 4.1 |
| bob, last 3 days | 1.11 | 2.10 | 3.58 | 4.7 |
| finney, last 4 weeks | 4.24 | 7.52 | 9.71 | 12.2 |
| **the first of the three**, last 3 days | **0.86** | **1.52** | **2.39** | **3.1** |
| alice, year samples (one coin), next / second | 1.26 / 1.94 | 2.30 / 3.41 | 3.59 / 5.55 | 6.2 / 7.2 |
| bob, year samples | 2.48 / 5.83 | 6.32 / 11.9 | 10.8 / 17.8 | 14.0 / 21.8 |
| finney, year samples | 4.87 / 13.5 | 9.07 / 19.5 | 12.5 / 24.1 | 14.2 / 26.4 |
| the first of the three, year samples (taken as independent) | 1.11 / 1.87 | 1.93 / 3.21 | 2.90 / 5.11 | 4.8 / 7.0 |

Gaps between transactions on one coin, year samples: alice median 3 blocks (worst 13), bob 9 (49), finney 49 (74);
in the complete record: alice 3 (8), bob 4 (11), finney 40 (65). It agrees with the one stamp of 2026-11-15
(anchored at alice and bob between 1.3 and 2.8 hours).

**`REF_WINDOW`** bounds the time from `ref`'s block (6 deep when the entry is made: ~1.0 hour old, p99 2.3) to the
anchor's block. With all three calendars up it is a few hours (the first of the three: p99 ~3, worst ~5). The slowest
case is finney alone (alice and bob are one operator): 27 hours at worst through the year's samples under the
"second" reading (~16 under "next", which the first proofs fit), plus up to 2 hours that a block's time may run
ahead. **Set to 48 hours** (provisional until N0b
checks the model): that with half again to spare for days the samples missed; two days ahead is no difference against
a 30-day term. The dialog's **"about 2 hours"** stands (90% of stamps within 1.5 to 1.9 hours at the first calendar).

### Proof of work and verification (a scratch crate, native and wasm)

A scratch crate under `bench/results/local/` (outside the workspace, not committed): `blake2` 0.10.6, `sha2` 0.10.9,
`k256` 0.13.4 as net/ts's Cargo.lock has them, and `argon2` 0.5.3 (only there); built as net/ts/build.sh builds
(`wasm32-wasip1`, release with LTO, one codegen unit, opt-level 3, `panic = "abort"`), timed natively and in
Chromium's wasm (and Node's, which agreed within ~10%). µs per operation, median of 7:

| | native | Chromium wasm | tries a minute in a tab | 60,000 entries checked in wasm |
|---|---|---|---|---|
| BLAKE2s, a 143-byte entry (3 compressions) | 0.32 | 0.35 | 1.7·10⁸ (2²⁷·⁴; 2²⁸·⁹ with the first two blocks precomputed) | 0.02 s |
| Argon2id 8 KiB, t = 1 | 12.4 | 19.1 | 3.1·10⁶ | 1.1 s |
| Argon2id 64 KiB, t = 1 | 29.0 | 46.1 | 1.3·10⁶ | 2.8 s |
| Argon2id 64 KiB, t = 3 | 67.9 | 105 | 5.7·10⁵ | 6.3 s |
| Argon2id 256 KiB, t = 1 | 84.1 | 159 | 3.8·10⁵ | 9.6 s |
| **Argon2id 1 MiB, t = 1** | **309** | **488** | **1.2·10⁵ (2¹⁶·⁹)** | **29 s** |
| Argon2id 4 MiB, t = 1 | 1,339 | 2,050 | 2.9·10⁴ | 123 s |
| Argon2id 16 MiB, t = 1 | 6,270 | 8,800 | 6.8·10³ | 528 s |

**A GPU's side: published figures and estimates, not measured.** hashcat's RTX 5090 benchmark (Chick3nman's gist,
hashcat v6.2.6-851, `-O`) gives BLAKE2s-256 (mode 31000) **33.6 GH/s** (one compression: an attacker precomputes an
entry's first two blocks, as a tab could), against a tab's ~8.6 M/s: a lead of **~3,900x**. No published Argon2
figure at these sizes was found (hashcat's mode 34000 benchmarks run large parameters; a vendor's 8x RTX 5090 rig at
490 H/s doesn't say its parameters), so for Argon2id it is an *estimate* from the card's memory bandwidth (1.79 TB/s;
~3 KiB of traffic per 1 KiB block a pass): **~570,000/s at 1 MiB, ~280x a tab**, and the same ratio at 4 MiB. That is
an upper bound on the card: the same gist's scrypt (N = 16,384, 16 MiB) runs at 7,760 H/s, ~7x under the same
bound. At 64 to 256 KiB an instance fits in the card's on-chip memory and the bound is compute (BLAKE2b at 17.3 GH/s
on the card, ~2 BLAKE2b compressions per Argon2 block), a lead in the thousands, like BLAKE2s.

| A million names, two entries each a term, at a minute of a tab per entry | GPU time a term (RTX 5090) | a server checking 60,000 entries |
|---|---|---|
| BLAKE2s, 29 bits | ~9 hours | 0.02 s |
| Argon2id 1 MiB, 16 bits | **≥ ~64 hours** (*estimate*; scrypt's ratio suggests ~5x more) | ~29 s |
| Argon2id 4 MiB, 14 bits | ≥ ~64 hours | ~2 minutes |

**Chosen: Argon2id, 1 MiB, t = 1, p = 1, `POW_BITS` 16** (provisional: the dev VM re-times the tab; the bits move by
one if its tab is twice as fast). The knee: past 1 MiB the card is bandwidth-bound and the ratio stops improving while
the check grows; under it the card's chips hold an instance. Neither function makes a dictionary expensive (tens of
GPU-hours, a few hundred euros at rental rates at most), which is what the spec claims of it (a price every term), not
more. **The draw** (hashcash): at 2,050 tries a second in Chromium a mean of 32 s; half within 22 s, 90% within 74 s,
99% within 2.5 minutes.

**Verification in Chromium's wasm** (Node's agreed within ~3%): BIP-340 (`k256` `verify_raw`) **151 µs**; an anchor's
operations (46 SHA-256s over ~1.2 KB: a calendar tree of 20 levels, the transaction, a block's path of 12, double
SHA-256) **15.2 µs** (a SHA-256 of 64 bytes 0.36 µs; natively 0.10, SHA extensions); an 80-byte header's double
SHA-256 and target **0.53 µs**. A whole entry with Argon2id: **~0.66 ms**, so a 4 ms slice of a module's turn checks
~6 entries, a 1,000-name registry's 10,000 entries ~6.6 s and a 5,000-name one's 60,000 ~40 s of one core; a member's
lookup (the last entry only) under a millisecond.

### Requests to public services

All with a generic User-Agent, nothing about the user or the project; counts in `results/names0/requests.json`.

| Service | Requests | What |
|---|---|---|
| alice.btc.calendar.opentimestamps.org | 100 | 80 stamps, 17 proofs, 3 status pages |
| bob.btc.calendar.opentimestamps.org | 100 | the same |
| finney.calendar.eternitywall.com | 99 | 80 stamps, 17 proofs, 2 status pages |
| blockstream.info | 210 | transactions, outspends, address histories, block hashes and headers |
| mempool.space | 208 | the same, and the fee-rate series |

N0b's collection adds ~70 GETs at each calendar and a few at each explorer (a block hash from both, a header from one,
per block).

### Reproduce
```sh
export NODE_USE_ENV_PROXY=1                            # a session behind a proxy (docs/cloud.md)
node bench/net/ots-stamps.ts stamp --minutes 115 --burst-every 22    # the batch (~2 hours; ~80 POSTs a calendar)
node bench/net/ots-stamps.ts collect                   # N0b: hours later, until nothing is pending; then `sizes`
node bench/net/ots-history.ts fetch                    # the pages, the fee series, ~400 requests over both explorers; cached under bench/results/local/names0/
node bench/net/ots-history.ts model                    # -> results/names0/history.json
```
The proof-of-work crate isn't committed (it names `argon2`, which enters the project only in the loop that builds the
function): its kernels are the table's rows over a 143-byte entry with the nonce last, timed in a loop natively and
from JavaScript around the wasm (`performance.now`), the wasm instantiated with stub WASI imports.

## NAMES loop 0b (cloud), 2026-11-17

N0a's batch collected, and what it says now that R1 has removed `ref` and `REF_WINDOW` (an anchor is its
OpenTimestamps proof and its block's one 80-byte header). A cloud session (as N0a's); nothing here is a time
measured on the host. JSON under `results/names0/`: `proofs.json` (every proof and its block's header, both
explorers agreeing on the hash, checked against the Merkle roots), `anchors.json` (sizes, times, the calendars'
transactions, the blocks' times, each stamp's row), `history-lead.json` (N0a's model again with the correction
below), `requests.json`.

### Collected

`NODE_USE_ENV_PROXY=1 node bench/net/ots-stamps.ts collect` once, 2026-11-17 14:45 UTC (17.7 hours after the last
stamp): **all 240 receipts finished, none pending**. They are in eight calendar transactions over six blocks:

| Calendar | Block (time, UTC 2026-11-16) | Anchors | Stamp groups in it |
|---|---|---|---|
| alice | 976,177 (19:25:21) | 19 | test, burst-pre, burst0, two singles |
| bob | 976,178 (19:38:05) | 20 | the same and a third single |
| alice | 976,183 (20:47:59) | 39 | bursts 1 to 3, 15 singles |
| alice | 976,185 (21:03:49) | 12 | burst 4, 4 singles |
| bob | 976,185 | 50 | bursts 1 to 4, 18 singles |
| alice | 976,187 (21:25:57) | 10 | burst 5, 2 singles |
| bob | 976,193 (22:33:07) | 10 | burst 5, 2 singles |
| finney | 976,193 | 80 | all of them: one transaction for the whole batch |

Then `node bench/net/ots-stamps.ts anchors` (new) set each proof against its calendar's status page of the moment
(every transaction of the last days with its confirmations, so its height; each proof's transaction, found as the
double SHA-256 over the first message longer than 64 bytes, is on it at the proof's height) and the blocks' times
(blockstream.info's block lists, checked against the six headers' own times).

### Anchor sizes

An anchor as the module encodes it (anchor.rs `Anchor::encode`: the operations from the 32-byte entry id to the Merkle
root, then the attestation and the height, 13 bytes):

| | min | median | p90 | max | mean |
|---|---|---|---|---|---|
| all 240 | **905** | **1,185** | 1,245 | **1,256** | 1,169 |
| alice | 905 | 1,151 | 1,221 | 1,256 | 1,144 |
| bob | 1,045 | 1,150 | 1,221 | 1,256 | 1,156 |
| finney | 1,105 | 1,210 | 1,245 | 1,245 | 1,207 |

The spec's estimate of "300 to 1,250" assumed sharing; the raw range is narrow and close to its top: about 20
levels of the calendar's tree (35 bytes each), the transaction (~235 bytes), a block's path of ~12 levels.

**Shared, if anchors through one calendar transaction were stored as one tree** (each operation once for all the
anchors whose paths run through it; nothing built does this): 234 to 325 bytes an anchor over the batch's eight
transactions (raw 1,054 to 1,218), because 10 to 80 of them share each transaction. What decides it is what a second
anchor in the same transaction adds of its own: **made apart (another moment), 304 to 713 bytes, median 619**; made in
the same second (one burst), 58 to 444, median 128. By the time apart, at alice: under a second 45 to 291 (median
115), 10 to 60 s 291 to 606 (396), 1 to 10 minutes 361 to 641 (501), over 10 minutes 396 to 676 (606); bob and
finney alike. **Headers**: one 80-byte header a block, six for the 240 anchors.

### Time to anchor, against the real stamps

**The 6-deep wait holds.** Both status pages read (N0a's at height 976,175, this loop's at 976,285) count as
"Transactions waiting for confirmation" exactly the calendar's mined transactions with fewer than 6 confirmations
(alice 2 and 4 then, 3 now; bob 2 then, 2 now) and not the one with 6: a proof is served from the sixth confirmation,
the anchor's block and five more. N0a's first look fits: alice's 976,177 and bob's 976,178 were 6 deep at 20:35 and
20:48, and both were served at 21:04. Block to sixth confirmation in the batch: alice 1.05 to 1.17 hours, bob 1.08 to
1.56, finney 1.56 (blocks were slow that evening: 976,177 to 976,183 took 83 minutes).

**Next or later transaction.** finney: all 80 in its next transaction (its first after the batch, 3.4 hours after
the first stamp). alice: 60 of 80 in the next; bob 61 of 80. **Every one of the 39 that missed was made 1.4 to 9.1
minutes before the block that mined the transaction it missed**; every stamp made 9.8 minutes or more before such a
block made it, and one made 6.4 minutes before (alice, 976,177). So neither of N0a's readings: the transaction a block
mines carries the calendar's tip of some minutes before it, and a stamp in those minutes waits for the calendar's
transaction after. None waited two.

**N0a's model with that correction** (`ots-history.ts model --lead 600`: a stamp misses a calendar transaction mined
less than 10 minutes after it), hours from stamp to proof:

| | median | p90 | p99 | worst |
|---|---|---|---|---|
| alice, last 3 days (complete) | 1.19 (N0a 1.04) | 2.00 (1.82) | 2.91 (2.75) | 3.9 (4.1) |
| bob, last 3 days | 1.28 (1.11) | 2.23 (2.10) | 3.77 (3.58) | 4.8 (4.7) |
| finney, last 4 weeks | 4.39 (4.24) | 7.69 (7.52) | 9.84 (9.71) | 12.9 (12.2) |
| **the first of the three**, last 3 days | **1.03** (0.86) | **1.69** (1.52) | **2.53** (2.39) | **3.2** (3.1) |
| the first of the three, year samples | 1.28 (1.11) | 2.10 (1.93) | 3.08 (2.90) | 5.3 (4.8) |
| finney, year samples | 5.03 (4.87) | 9.21 (9.07) | 12.65 (12.49) | 15.0 (14.2) |

**The batch itself** (stamp to the sixth confirmation of its block; one evening, four transactions at alice, so one
draw rather than a distribution):

| | min | median | p90 | max |
|---|---|---|---|---|
| alice | 1.24 | 1.48 | 2.31 | 2.47 |
| bob | 1.24 | 1.85 | 3.08 | 3.13 |
| finney | 3.04 | 4.18 | 4.92 | 4.93 |
| **the first of the three** (alice for 78, bob for 2) | **1.24** | **1.48** | **2.31** | **2.39** |

Inside the model's spread (the first of the three's p90 1.7 to 2.1 hours, its p99 2.5 to 3.1); higher in the median
for the slow blocks and alice's six-block gap at 976,177 to 976,183.

**What it bears on now that `REF_WINDOW` is gone.**
- *The dialog's "public in about 2 hours"* (`PUBLIC_IN_MS`): the proof itself is there in about 1 to 1.5 hours,
  90% within 1.7 to 2.3. But the agent, page open, asks 5 minutes after stamping and then waits 5 minutes doubling to
  an hour (`RETRY_MS`, `PASS_MS`): it asks at 5, 10, 20, 40, 80, 140, 200 minutes. A proof that comes at 81 to 140
  minutes is collected at 140 (2.33 hours), past the two hours the dialog counts down, and the line turns to "public
  once this web app has been open a while" with the page open. In the batch that was **76 of 80** (collected at 1.33
  hours for 4, 2.33 for 75, 3.33 for 1); by the corrected model fewer than half (the first of the three's median,
  1.03 hours, is inside 80 minutes; its p90, 1.69, isn't). docs/backlog.md has it: asks spaced around the expected proof (a
  first at an hour, then every 10 to 15 minutes to 3 hours) would make "about 2 hours" true.
- *Servers finishing renewals* (R2: from 30 minutes after a server first holds the renewal, then a 15-minute slot):
  the earliest proof in the batch came 1.24 hours after its stamp and the 6-deep rule held, so the first 3 to 4 slots
  ask in vain (404s, a few a renewal a room) and the room has the anchor within a slot or two of its sixth
  confirmation. The pending anchor servers finish is the lowest, alice's when alice stamped (`Calendar`'s order), which
  was the first of the three for 78 of the 80.
- *The pending anchor's staleness and renewals made ahead*: a renewal is stamped 15 to 29 days after the entry before
  it and can link until 37 days after it; the slowest anchor anywhere here (finney alone, a year's samples, missing a
  transaction) is about a day. Nothing in either rule depends on these hours.

### Sizes for the spec

A name's item (wire.rs, version 4) carries per entry 175 bytes, the anchor with its 2-byte length, a 2-byte header
index and a 2-byte pending length, and its block's header once an item: a name's entries are two weeks apart, so in
practice one header each. **1,166 to 1,517 bytes an entry, median 1,446**; two a month **2.3 to 3.0 KB a name a month
(2.9 typical)**, where the spec said 1.1 to 3.0 from the estimated 300-byte low end. Six months held and its zone
(~0.4 KB): 14 to 19 KB a name, so 14 to 19 MB at 1,000 names, 72 to 93 MB at 5,000, 290 to 370 MB at 20,000; the
spec's "where it stops" holds (the table there is replaced). Storing a registry's anchors by calendar transaction (not
built) would save in proportion to the entries a transaction carries: about 2 entries a name a month, so a room of
N names stamps N/360 entries an hour and alice's transaction (every ~1.2 hours) carries ~N/300: at 1,000 names ~3
(an anchor ~790 bytes on average, an entry ~1.0 KB, about 30% less), at 5,000 ~17 (~650, an entry ~0.84 KB, about
40% less), headers shared across names included. A constant factor: it doesn't move where a registry stops.

**Stamps made in the same second are near-siblings in the calendar's tree** (under ~450 bytes apart, where stamps 10
seconds or more apart differ by 290 to 700), so a server that holds two names' anchors can tell whether they were
stamped within the same second or so: a finer grouping than "one block" (room-names.md "What a server still
learns"). The agent stamps a visit's due renewals one title after another, seconds apart (the 1 to 10 s pairs here
were 291 to 641); docs/backlog.md's "spreading one owner's renewals" covers both.

### Requests to public services

| Service | collect | anchors | N0b | N0a and N0b |
|---|---|---|---|---|
| alice.btc.calendar.opentimestamps.org | 63 proofs | 1 status page | 64 | 164 |
| bob.btc.calendar.opentimestamps.org | 63 | 1 | 64 | 164 |
| finney.calendar.eternitywall.com | 80 | 1 | 81 | 180 |
| blockstream.info | 8 (4 block hashes, 4 headers) | 7 block lists | 15 | 225 |
| mempool.space | 4 block hashes | | 4 | 212 |

### Reproduce
```sh
export NODE_USE_ENV_PROXY=1                            # a session behind a proxy (docs/cloud.md)
node bench/net/ots-stamps.ts collect                   # nothing left to ask: every receipt is finished
node bench/net/ots-stamps.ts anchors                   # -> results/names0/anchors.json (pages and block lists cached under bench/results/local/names0b/)
node bench/net/ots-history.ts model --lead 600 --out bench/net/results/names0/history-lead.json   # needs N0a's cache
```
