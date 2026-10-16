# M8 networking: the Rust tailnet client, handover after T5 (2026-10-16, cloud session)

The plan is [docs/plans/tailnet-client.md](docs/plans/tailnet-client.md). **T1 to T3 are done**;
**T4 (the control session, the kept node) and T5 (the data plane) are written and tested in a cloud
session** against headscale run natively (§7 says what each built, tested and found). What a cloud
session can't do is the dev VM's: the guest (Debian on the page) through the Rust client, the Podman
rig, `scripts/ci-net.sh`, the M4's numbers. Then **T6**, the switch. Read the plan's §2 (the
decisions; "Import, don't rewrite" is new), §5 and §7 T4 to T6, then this.

## The user's instructions that bind

- **The kept node carries over:** the Rust client reads and writes the Go client's IndexedDB store
  as it is, so nobody logs in again, and the Go client still works on a store the Rust one wrote
  (plan §2, §5; tested both ways, in Node and in Chromium).
- **IPv6 keeps working** as it does with the Go client: on the tailnet untranslated (T5 keeps
  `net-tailnet`'s IPv6 checks), through tailcat as the tunnel's own address (done).
- **The page's network UI is a wizard** (the user, 2026-10-16): new Tailscale options (an auth key's
  tags, Tailnet Lock's refusal, a custom DERP map) belong in the wizard's tailnet step or its
  Advanced part. The backend choice is internal (`?tsbackend=` only).
- **Import, don't rewrite** (the user, 2026-10-16, during T4): where a crate does the job, use it as
  it is, even at some size (`h2`, `ts_control_serde`, `ts_packetfilter`, `ts_disco_protocol` are in;
  the module is still ~1/10 of Go's). Only what needs sockets or tokio's runtime is ours (plan §2).
  New dependencies beyond the plan's list still need the user's OK.
- Go stays until the Rust client passes `scripts/ci-net.sh` (T6).

## What exists now (T4, T5)

- `net/ts/src/`: `noise.rs` (control's Noise channel: `ts_noise`'s handshake, our record framing),
  `h2pipe.rs` (`h2` over an in-memory pipe, no runtime), `netmap.rs` (`ts_control_serde`'s map
  responses into an owned netmap, the filter as `ts_packetfilter`'s), `store.rs` (the Go client's
  store, read and written), `control.rs` (key fetch, `/ts2021`, register, interactive login,
  key expiry, map stream, logout), `ip.rs`, `dns.rs` (MagicDNS's messages), `tailnet.rs` (the
  client: home DERP by probe, a WireGuard peer per netmap peer through its home region, the
  filter, the exit node, MagicDNS with forwarding, disco pongs, Tailnet Lock refused). `wasm.rs`:
  `ts_new`'s JSON with `control` makes a Tailscale client; new exports `ts_logout`, `ts_exit_node`.
  Module: **1.87 MB raw** (448 KB Brotli at T4's 1.68 MB; Go: 26.9 MB, 4.3 MB). 38 native tests.
- `web/ts-client.ts` (`TailnetConfig`, the new events, `logout`, `setExitNode`),
  `web/tailnet-worker.ts` (the page's worker for the Rust client, the Go worker's messages),
  `web/tailscale-state.ts` (the IndexedDB store, shared by both workers), `web/tailscale.ts`
  (`backend`, `DEFAULT_BACKEND = 'go'`, `?tsbackend=go|rust`).
- Tests: `tests/ts-tailnet.test.ts` (Node: the hand-over with the Go client run in a Node worker,
  `tests/net/go-client.ts`; netmap vs the peer's `tailscale status`; interactive login; a stand-in
  guest of crafted packets, `tests/net/packets.ts`), `tests/tailscale-browser.test.ts` (both clients
  in Chromium, no guest; kept node through reloads in either client; logout),
  `tests/net-tailnet.test.ts` with `WEBPC_TS_BACKEND=rust`. `scripts/ci-net.sh` runs all three in a
  last step, one at a time (they share the rig's ports).
- Rigs: `tests/net/tailnet.sh` gained `key lasting` (a non-ephemeral key: the hand-over's node must
  outlive the switch), `nodes` (headscale's, JSON), `peer …` (the peer's `tailscale …`), `register
  <id>` (approve an interactive login). `tests/net/tailnet-native.sh` is its Podman-free twin for
  cloud sessions (`WEBPC_TAILNET_SCRIPT=`), with `tests/net/tls-proxy.ts` as its Caddy.
- `bench/net/tailnet.ts`: the Rust client in Node against a control server, its netmap printed, its
  store in a JSON file.

## What the cloud session ran (x86_64, Chromium 141, headscale v0.29.4 and tailscaled v1.102.5 native)

| What | Result |
|---|---|
| `cargo test -p webpc_ts` (38), clippy, fmt | pass; planted: the filter letting everything in fails `the_filter_lets_in_…` |
| `tests/ts-tailnet.test.ts` (native rig) | 5 of 5: Go → Rust → Go and Rust → Go → Rust the same node; netmap = peer's view; data plane (pings v4/v6, MagicDNS, UDP, TCP, disco pong, inbound SYN, exit node selection); interactive login |
| `tests/tailscale-browser.test.ts` (native rig) | 3 of 3; numbers below |
| `tests/ts-client.test.ts` | pass |
| `scripts/ci.sh` | to `cargo test`, which fails only on `fp::tests::inline_fma_is_correctly_rounded`, the known x86_64-only failure of the base commit (previous handover); then by hand: `cargo test` skipping it, TestFloat, both wasm builds, tsc pass; `npm test`: 406 pass, 5 fail, the five WebGL2 tests (`virgl-browser`: glcomp, stream output, sway; the two H.264 `video` ones) that fail on the base commit in this container (SwiftShader; previous handover) |
| `tests/net-tailnet.test.ts` (either backend), `scripts/ci-net.sh`, `scripts/ci-debian.sh` | **not run**: no EDK2 (it needs Podman) and no Podman here |
| the Podman rig's new subcommands (`nodes`, `peer`, `register`, `key lasting`) | **not run** (written to match the native script, which ran) |

Cloud numbers (an indication only, not for REPORT.md): Rust loaded in 21 ms (Go 140), Running ~2 s
for both (headscale's first map), echo RTT 1.4 ms (Go 1.8), 34 Mbit/s each way (Go 17), 2,000 of
2,000 echoes for both.

## To do on the dev VM, in order

1. Pull; `scripts/ci.sh` (all images; it builds `ts.wasm`). `net/tailscale/build.sh` if
   `target/net/tailscale.wasm` is stale.
2. `WEBPC_TAILNET=1 node --test tests/ts-tailnet.test.ts`, then `tests/tailscale-browser.test.ts`,
   on the Podman rig (first runs of its new subcommands: fix them there if they differ).
3. **The guest on the Rust client:** `WEBPC_TAILNET=1 WEBPC_TS_BACKEND=rust node --test
   tests/net-tailnet.test.ts` (its first run: DHCP from the netmap, ping v4/v6, MagicDNS by name and
   by the search domain, the peer's `tailscale nc` to the guest's servers over both). Then once by hand
   with `WEBPC_TAILNET_INTERNET=1` (the exit node: the internet and DNS through it; our MagicDNS sends
   plain DNS to 1.1.1.1 through the exit node where Go uses its peerapi DoH: if that fails, it's the
   first thing to look at).
4. `scripts/ci-net.sh` whole (~8 min now), and `scripts/ci-debian.sh` (the page's network path).
5. **T6's measurements** (plan §6) on the M4 in Chromium 153, both clients alternating, into
   `bench/net/REPORT.md` with the JSON: size (raw, gzip, Brotli), load, time to `Running`, RTT,
   throughput both ways (tests/tailscale-browser.test.ts prints most; the N2 echo harness for the
   rest), the worker's memory (not measured yet for either: `performance.measureUserAgentSpecificMemory`
   needs cross-origin isolation, which the page has) and the worker's CPU per Mbit/s.
6. **The switch:** `DEFAULT_BACKEND = 'rust'` in `web/tailscale.ts` once 3–5 pass; `web/app/main.ts`'s
   "isn't built" message and `tools/tailscale.ts` (build Go only for `?tsbackend=go`?) follow; docs
   (frontend.md "Network", networking.md, PLAN.md, CLAUDE.md). Removing `net/tailscale/`, its build,
   `wasm_exec.js` and Go after a release with both is the user's call (the hand-over test and the
   tailcat rig use Go too: the tailcat rig would become a container image, plan §7 T6).

## On the dev VM, things to know (from T1–T3, still true)

- IPv6 tests need `sudo ip -6 addr add fd00:7e57::1/128 dev eth0 nodad`.
- Never run a CLI with `spawnSync` from a page test (the test serves the page's disk). The Node tests
  above use `execFile` for the peer's commands for the same reason: the client runs in the test's
  own event loop.
- The tailcat rig is on 8444, the tailnet's proxy on 8443.

## Found in T4–T5 (worth not re-discovering)

- Go's `net/http` in js/wasm refuses `fetch` under Node (it checks `process.argv0`); the Go client's
  test worker replaces `process` with an object whose `argv0` isn't "node". The rig's CA is made at
  `up`, after Node read `NODE_EXTRA_CA_CERTS`: the tests trust it with `tls.setDefaultCACertificates`
  (`trust()` in `tests/net/go-client.ts`), in the Go worker too.
- `ts_control_noise` and `ts_control` need tokio's multi-thread runtime: "Only features
  sync,macros,io-util,rt,time are supported on wasm".
- `h2`'s requests are written only when the connection is next polled: `h2pipe` keeps polling while
  a request starts, else a request made in an event handler waits for the next input.
- The first packet to a fresh peer right after the rig comes up waits ~4.5 s (WireGuard's retry);
  later ones 55 ms. The Go client's "5 s first ping" is the same thing (bench/net/REPORT.md).

## Known gaps (in docs/backlog.md "Network")

The Rust client's: subnet routes, IPv6 extension headers in the filter, MagicDNS's PTR/SRV/TXT and
retries, DoH untested against the real services, no disco of our own, Tailnet Lock refused, the
module's memory. tailcat's, from T2–T3, unchanged.
