# M8 networking: the Rust tailnet client, handover after T1 and half of T2 (2026-10-16)

The plan is [docs/plans/tailnet-client.md](docs/plans/tailnet-client.md) (accepted by the user on
2026-10-16 with every dependency it needs); read it, then [docs/plans/networking.md](docs/plans/networking.md)
§3 (the gateway, which doesn't change) and [bench/net/REPORT.md](bench/net/REPORT.md) "T1". This
work was done in a **cloud session** (x86_64, no Podman, no EDK2, no IPv6); what's left needs the
dev VM. The user's instructions that bind it:

- **The kept node carries over:** the Rust client reads and writes the Go client's IndexedDB store
  as it is, so nobody logs in again (plan §2, §5 "The kept node"; T4's test).
- **IPv6 keeps working** as it does with the Go client: on the tailnet untranslated (T5 keeps
  `net-tailnet`'s IPv6 checks), through tailcat as the tunnel's own address (plan §2).

## What exists

- `net/ts/` (crate `webpc_ts`, in the workspace): the client's protocol state, sans I/O, built by
  `net/ts/build.sh` for **`wasm32-wasip1`** (std's clocks and `getrandom` through six WASI imports,
  `web/ts-wasi.ts`; no patch to tailscale-rs). `cbor.rs`, `tailcat.rs` (addresses, meow, tunnel
  addresses), `derp.rs` (DERP over a byte stream), `nat46.rs` (IPv4 ↔ the tunnel's IPv6, MSS clamp,
  frag-needed), `client.rs` (the tailcat client on tailscale-rs's `ts_tunnel`), `wasm.rs` (the ABI,
  documented at its top). 17 native tests, one of them the client against a fake tailcat server
  with its own `ts_tunnel`.
- `web/ts-client.ts` (the I/O: WebSockets, fetch, timers; Node or a worker), `web/tailcat.ts` +
  `web/tailcat-worker.ts` (the page's backend, same `Tailscale` handle as the Go client's),
  `web/app/network.ts` and `main.ts`/`index.html` (the menu's **Connect to** choice and the tailcat
  address field), `tools/tailscale.ts` `prepareTailnetClient` (serve/start build `ts.wasm`).
- `tests/net/tailcat.sh up|env|down`: derper on `127.0.0.1:8443` and `tailcat serve exit-node`,
  native, Go-built once at pinned versions into `target/net/tailcat-test/bin`.
- `bench/net/tailcat.ts`: the module in Node against that exit node (startup, RTT, echo throughput).
- Tests: `tests/ts-client.test.ts` (always), `tests/network.test.ts` (the controller, two new
  tests), `tests/tailcat-browser.test.ts` and `tests/net-tailcat.test.ts` (`WEBPC_TAILCAT=1`, which
  `scripts/ci-net.sh` sets when Go is there).

## What ran, where

| | cloud session | dev VM |
|---|---|---|
| `cargo test -p webpc_ts`, clippy, fmt | passed | **to run** (with `scripts/ci.sh`) |
| `tests/ts-client.test.ts`, `tests/network.test.ts` | passed | to run |
| `bench/net/tailcat.ts` (5 runs, JSON committed) | 62–71 Mbit/s each way, `Running` ~65 ms | **to run** and record (the M4's numbers; with IPv6 there) |
| `tests/tailcat-browser.test.ts` (Chromium 141) | passed: loaded 16 ms, `Running` 122 ms, 2,000/2,000 echoes | to run (Chromium 153) |
| `tests/net-tailcat.test.ts` (Debian through tailcat) | **never run** (no EDK2 here) | **to run: its first run** |
| `scripts/ci-net.sh`, `scripts/ci-debian.sh` | not run | **to run** (network and page changes) |
| `scripts/ci.sh` | its steps by hand: fmt, clippy, `cargo test` (all pass but `fp::tests::inline_fma_is_correctly_rounded`), TestFloat, both wasm builds, tsc pass; `npm test` passes but five WebGL2 tests (`virgl-browser`: glcomp, stream output, sway; the H.264 `video` ones). **All six failures fail identically on the base commit `53c603b` in the same container** (x86_64, Chromium 141 on SwiftShader): not this work's | must pass |

## To do on the dev VM, in order

1. `cargo fmt --all`, then **`scripts/ci.sh`** (alone, background). If `inline_fma_is_correctly_rounded`
   fails here too, it's not this work's (it failed on `53c603b` in the cloud); say so to the user.
2. **The rig:** `tests/net/tailcat.sh up` (needs Go, python3, openssl; builds tailcat v0.7.0 and the
   derper its `tailscale.com` pins, ~2 min the first time). Then
   `eval "$(tests/net/tailcat.sh env)"; NODE_EXTRA_CA_CERTS=$WEBPC_TAILCAT_CA node bench/net/tailcat.ts $WEBPC_TAILCAT_ADDR 5`:
   the IPv6 echo to the exit node's `[::1]` runs here (it was skipped in the cloud). Record five
   runs in `bench/net/REPORT.md` (a new "T1 on the M4" paragraph, JSON in `results/t1/m4/`).
3. `WEBPC_TAILCAT=1 node --test tests/tailcat-browser.test.ts`, then
   **`WEBPC_TAILCAT=1 WEBPC_DISTROS=debian node --test tests/net-tailcat.test.ts`**. Expect to fix
   things; what it checks first time:
   - networkd takes `192.0.0.2` as a /32 with option 121's routes (as it does the tailnet's address);
     DHCPv6 gives the tunnel's `fd7a:115c:a1e0:…` address (both come from the gateway, unchanged).
   - HTTP and 2 MB over IPv4 to this machine's LAN address (the guest's 127.0.0.1 is its own) through
     the translator: the 2 MB is the MSS clamp's test. If it stalls, look at `nat46.rs` `clamp_mss`
     and whether the guest sends IPv4 over 1,260 bytes with DF (it gets frag-needed from 192.0.0.1).
   - **IPv6 needs a non-link-local IPv6 address on the dev VM**; Lima's may have none. If the test
     says SKIPPED for IPv6, add one for the run (`sudo ip -6 addr add fd00:7e57::1/128 dev lo`, then
     the test finds it) and note in docs/testing.md that the IPv6 part needs it.
4. **`scripts/ci-net.sh`** (the whole network suite, the Go client's tests included: nothing of
   theirs should move) and **`scripts/ci-debian.sh`** (the page changed: the Network menu).
5. **The menu in the page test:** extend `tests/page-network.test.ts` with the tailcat kind: the
   **Connect to** select swaps the fields; a bad address shows the error; a well-formed address of a
   server that isn't there shows "Waiting for the tailcat server…" then the error (≈15 s); Disconnect
   gives the form back with the kind remembered and the address field empty. Then look at the menu
   once (a screenshot) for layout: the hint paragraph is long.
6. Update the plan (T2 done, numbers), docs/frontend.md (drop "being finished"), CLAUDE.md's status
   line, docs/backlog.md for what's left (below), and commit with the results.

## Known gaps (decide, or put in docs/backlog.md)

- **A kept client key** (plan §4: so a server can `--allow` it): the module takes `key` and exposes
  `privateKey()`, but the page never keeps one; every connection is a fresh client.
- **An address that names only a region** (the public relays' short form) fetches
  `https://tailcat.dev/derpmap.json`: unit-tested parsing, never run against the real map (the
  internet; it sends CORS headers). Opt-in check: `tailcat serve exit-node` with no `--key` on a
  machine with the internet, its address into the page.
- **Reconnects while running:** the client retries the relay with a backoff and meows again;
  `relay_loss_while_running` covers it natively (checked with a planted bug), not yet in a browser
  (kill derper mid-test, restart it: the guest should carry on after a few seconds).
- A guest that sprays UDP flows (one port per packet) slows a tailcat exit node to nothing (REPORT
  "T1"): the exit node's limit, worth a line in docs/frontend.md if users hit it.
- ICMP isn't forwarded by tailcat's exit node: `ping` from the guest gets no reply, by design.
- `tcpdump`-level check of the guest's PMTU behavior with oversized UDP (DF clear is dropped, not
  fragmented: `nat46.rs` says so).

## After T2

T3 (the VM as a tailcat server: `tailcat ssh` into the guest) is optional: **ask the user**. Then T4
(the control session in Node against headscale, including the kept-node hand-over test) and T5, T6
(plan §7). tailscale-rs's `ts_control`, `ts_control_noise`, `ts_control_serde` are T4's reference
and, where sans I/O, its dependencies; the Go client's overlay (`net/tailscale/overlay/`) documents
the WebSocket control dial.
