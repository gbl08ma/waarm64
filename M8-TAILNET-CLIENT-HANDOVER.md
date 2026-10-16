# M8 networking: the Rust tailnet client, handover after T3 (2026-10-16)

The plan is [docs/plans/tailnet-client.md](docs/plans/tailnet-client.md) (accepted by the user on
2026-10-16 with every dependency it needs). **T1, T2 and T3 are done** (§7 says what each built,
measured and found); **T4 is next**, then T5 and T6. Read the plan (§2 the decisions, §5 Tailscale,
§7 T4 to T6), then [docs/plans/networking.md](docs/plans/networking.md) §3 (the gateway, which
doesn't change), [docs/frontend.md](docs/frontend.md) "Network" (the wizard and the menu) and
[bench/net/REPORT.md](bench/net/REPORT.md) "T1" and "T1 on the M4".

## The user's instructions that bind

- **The kept node carries over:** the Rust client reads and writes the Go client's IndexedDB store
  as it is, so nobody logs in again, and the Go client still works on a store the Rust one wrote
  (plan §2, §5 "The kept node"; T4's hand-over test).
- **IPv6 keeps working** as it does with the Go client: on the tailnet untranslated (T5 keeps
  `net-tailnet`'s IPv6 checks), through tailcat as the tunnel's own address (done).
- **The page's network UI is a wizard** (the user, 2026-10-16): the Network menu shows only the
  current connection and what can be done with it; setting a connection up happens in the
  Network wizard (a dialog: the choice, then the kind's settings), which is also where advanced
  options go (a custom relay is the first). New Tailscale options (an auth key's tags, Tailnet Lock's
  refusal, a custom DERP map) belong in the wizard's tailnet step or its Advanced part.
- Dependencies the plan names are granted (tailscale-rs crates, RustCrypto, serde, `h2` if T4
  picks it). Anything beyond them: ask.
- Go stays until the Rust client passes `scripts/ci-net.sh` (T6).

## What exists (T1 to T3)

- `net/ts/` (crate `webpc_ts`, `wasm32-wasip1`, 493 KB raw): `cbor.rs` (read and write), `tailcat.rs`
  (addresses read and written, relays, meow, tunnel addresses), `derp.rs` (DERP over a byte stream),
  `nat46.rs`, `client.rs` (the tailcat client: connecting to an exit node, serving tailcat clients,
  or both; one `ts_tunnel::Endpoint`, peers by `PeerId`), `wasm.rs` (the ABI; its top comment).
  23 native tests (`cargo test -p webpc_ts`).
- `web/ts-client.ts` (the I/O: WebSockets, fetch, timers; Node or a worker), `web/ts-wasi.ts`,
  `web/tailcat.ts` (the `Tailscale` handle, the served identity in IndexedDB `webpc-tailcat`,
  `nearestRegion`), `web/tailcat-worker.ts`, `web/app/network.ts` (the controller, DOM-free),
  `web/app/main.ts` and `index.html` (the wizard and the menu).
- Tests: `tests/ts-client.test.ts`, `tests/network.test.ts` (always); `tests/tailcat-browser.test.ts`,
  `tests/net-tailcat.test.ts`, `tests/page-network.test.ts`'s tailcat part (`WEBPC_TAILCAT=1`, which
  `scripts/ci-net.sh` sets when Go is there).
- Rigs: `tests/net/tailcat.sh up|env|down` (derper on `127.0.0.1:8444` and `tailcat serve exit-node`,
  native, Go-built once into `target/net/tailcat-test/bin`; **shared** under a lock with a user count,
  because `node --test` runs files side by side) and `tests/net/tailnet.sh up|env|key|down`
  (headscale behind Caddy and a `tailscaled` peer that is an exit node, rootless Podman).

## On the dev VM, things to know

- **IPv6 tests need `sudo ip -6 addr add fd00:7e57::1/128 dev eth0 nodad`** (gone after the VM
  restarts; on `lo` Node calls it internal). Without it the IPv6 parts say SKIPPED. The VM has no
  IPv6 route out, which is why the internet checks are IPv4 (docs/backlog.md "Network").
- **Never run a CLI with `spawnSync` from a page test**: the test process serves the page's disk,
  and a guest that reads it while the CLI waits on the guest deadlocks until the timeout (T3 lost
  an hour to it). Use `spawn` and await it (`tailcat()` in `tests/net-tailcat.test.ts`).
- The xterm rows' `textContent` has no line breaks: match `1READY`, not `\n1\nREADY`.
- `scripts/ci-net.sh` runs five Debian/Chromium test files side by side (~5 min), so the rigs run
  at once: **the tailcat rig is on 8444 because the tailnet's proxy is on 8443** (sharing 8443
  made net-tailnet's setup fail in ways that looked like load: headscale "didn't come up", the
  peer "no longer existed"). Its waits are long and fail loudly, and its peer's key isn't
  ephemeral (headscale deleted the peer when it dropped off for a moment).

## T4: the control session in Node against headscale

The plan's §5 (control session, registration, the kept node, map stream) and §7 T4. In order:

1. **Key fetch and Noise.** `GET <control>/key?v=<capver>` by `fetch` (the server's Noise key;
   headscale's needs CORS on `/key`, `tests/net/tailnet.sh`'s Caddy adds it), then the Noise IK
   handshake over a WebSocket to `/ts2021` with subprotocol `tailscale-control-protocol` and the
   initiation in the `X-Tailscale-Handshake` query parameter (a browser can't set headers):
   `net/tailscale/overlay/controlhttp_client_js.go` is the Go client's version of exactly this.
   `ts_noise`, `ts_control_noise` (its framing, without the tokio codec) are the reference and,
   where sans-I/O, dependencies. The machine key is the node's (kept, below).
2. **HTTP/2 inside Noise.** The `h2` crate over an in-memory pipe, or a minimal client of our
   own: build `h2` into the module and measure the size first (the plan's gate: "settled by size").
   Record the choice and the numbers in the plan.
3. **Registration** with an auth key (`ts_control_serde`'s `RegisterRequest`); interactive login
   (the `AuthURL` event) can wait for T5 but keep it in the shape of the API.
4. **The map stream:** `/machine/map` with `Stream: true`, `Compress: ""`, parsed into peers (keys,
   addresses, AllowedIPs, home DERP), the packet filter, DNS config, DERP map. A Node harness like
   `bench/net/tailcat.ts` prints the netmap and compares it with `tailscale status --json` on the
   rig's peer (`tests/net/tailnet.sh`'s `peerts`).
5. **The kept node:** the module takes and emits store entries (`store(key, bytes)` in, a `store`
   action out); the worker maps them onto `webpc-tailscale` exactly as `web/tailscale-worker.ts`
   does for Go (keys `<profile>/<StateKey>`, values the hex of Go's bytes). Field names and
   encodings checked against the pinned `tailscale.com` (`ipn/prefs.go`, `types/persist`,
   `types/key`), not assumed. **The hand-over test:** the Go client registers and keeps its node;
   the Rust client starts on that store and is the same node (headscale's node ID and address
   unchanged, no new registration); then the Go client starts on the store the Rust one wrote and
   is still that node. In Node, the store is a file-backed map shared by both.

Where the code goes: a `control` module (or a few) in `net/ts/src/`, a second client type beside
`client::Client` (or a mode of it) behind the same ABI (`ts_new`'s JSON says which), and the I/O
in `web/ts-client.ts` (it already does WebSockets with a subprotocol, and fetch). The Tailscale
data plane (DERP to many regions, peers, the filter, MagicDNS) is T5; T4 ends with a registered
node whose netmap is right and whose store hands over both ways.

## After T4

T5 (the tailnet data plane: home DERP by `/derp/probe` (`nearestRegion` in `web/tailcat.ts` is the
same probe), peers, the packet filter, the exit node, MagicDNS, disco pongs, interactive login,
persistence, logout; `tests/net-tailnet.test.ts` against either backend with
`WEBPC_TS_BACKEND=go|rust`), then T6 (the switch: §6's measurements for both clients, the Rust
client as the page's default, Go removed after a release with both). The wizard's tailnet step
stays as it is; the backend choice is internal.

## Known gaps (in docs/backlog.md "Network")

tailcat IPv6 where the exit node's machine has none out (a fix is sketched there); T2's loose ends
(the public map's short addresses never used through the internet, the relay's loss while running
not tested in a browser, UDP flow spraying, no ICMP); T3's (no `--allow` list, clients never
dropped, disco pings unanswered so `tailcat ping` gets no pong, `tailcat ssh` itself not run, the
public relays not used by a client in a test).
