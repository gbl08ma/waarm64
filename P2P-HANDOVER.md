# P2P: peer-to-peer rooms over WebRTC — handover

The plan and its decisions: [docs/plans/networking-p2p.md](docs/plans/networking-p2p.md) (§1 binds). How it works
now: [docs/tailnet.md](docs/tailnet.md) "Rooms". There's no kickoff file: the user's brief is the plan, and their
word of 2026-11-10: R0's measurements weren't essential to deciding on the track ("I highly doubt the path will be
significantly less performant than DERP"); do them if a cloud session can, else go straight to the implementation.

## State

**R0 is done** (2026-11-10, a cloud session):

- `net/ts/src/room.rs` (a third client of the module, `Any::Room` in `wasm.rs`): §2's derivations (the /48, its tag,
  the pre-shared key; the tag salt and lookup key wait for R1), WireGuard to peers given by key (`room.peers`),
  incoming connections on trial (`incoming`, default on), signalling inside the tunnel on UDP port 1 (hello, sig,
  bye, refuse; an instance nonce, acknowledgements and resends), the lower key offers, ABI actions 7–10 and
  `ts_rtc_signal/open/message/closed`, the fallback on a closed, stalled (15 s) or never-opened (10 s) channel with
  the 30 s → 5 min backoff, relay only. Handshake messages always go through DERP (a decision R0 added to plan §4:
  a restarted peer has no channel to take our response; found by the restart test).
- `web/room.ts` (the page: `RTCPeerConnection`s, STUN only, the channel transferred to the worker at creation) and
  `web/room-worker.ts`; `web/ts-client.ts` carries the new actions. Not on the page's menus (R2).
- Tests: `cargo test -p webpc_ts room` (13 cases on a fake relay and a fake WebRTC; a planted bug in the address
  binding caught); `tests/room-browser.test.ts` (opt-in `WEBPC_TAILCAT=1`, in `scripts/ci-net.sh`'s list).
- Measured: bench/net/REPORT.md "Rooms: the direct path against DERP" (`bench/net/room.ts`, JSON in
  `bench/net/results/r0/`): direct 50.9 Mbit/s each way against DERP's 35.1 on loopback, 31% less CPU per Mbit;
  the gate holds. Numbers from the cloud's x86_64 container: **repeat `node bench/net/room.ts 5 10000 <json>` in
  the dev VM** at some point (not blocking).

**CI in this session:** `scripts/ci.sh` OK (1,392 s; JS 955 passed, 0 failed, 567 skipped) but for the agent's `cargo test`, whose two root-only failures (docs/cloud.md) stop it here and were left out of the run; the cloud skips the image-based native tests; `scripts/ci-net.sh` not run whole (the cloud has
no Podman, and `tests/net-tailcat.test.ts` hangs on its missing IPv6, docs/cloud.md): `tests/room-browser.test.ts`,
`tests/tailcat-browser.test.ts` and `tests/ts-client.test.ts` ran here. **Run `scripts/ci-net.sh` in the dev VM**
before R1's end.

## Next: R1 (plan §7)

In order, each a loop with its tests first:

1. §2's remaining derivations (tag salt, lookup key) and the link's format (the room's ID, its Nostr relays, its DERP
   map: region IDs or a derper inline); `JsRoom` takes a link.
2. The test harness's Nostr relay in TypeScript (EVENT, REQ, CLOSE, kind and `#x` filters, forwarding without
   storing; no dependency), and `k256` for BIP-340 signatures (OK'd 2026-10-18; add its THIRD_PARTY.json row).
   The module needs a WebSocket per Nostr relay (the same `WsOpen` actions, protocol "" or none: check what
   `web/ts-client.ts` passes for an empty protocol).
3. §3: tags by the hour (subscriptions for the previous, current and next hour), lookups (sealed to the key when
   known, else with the lookup key; resent after 1 s and 3 s), call backs into the dialer's home region (so the
   client needs more than one DERP connection: one per region in use, the home region preferred, 60 s idle close,
   as tailnet.rs does), the target's checks (age, nonce, a key with a session, a rate of new trials).
4. Connections on demand: the 64-peer cap, the 60 s idle close; packets waiting for a lookup, ICMPv6 address
   unreachable when none answers.
5. §5: the resolver at the room's `::53` (`<key>.<tag>.p2p.alt` AAAA by computing it, NXDOMAIN else), the lease's
   `dns6` and `domains`, the incoming switch's flow table.
6. Tests the plan lists (stale, replayed and forged lookups, a region outside the map, the hour's turn, lost
   signalling) and two pages joining by link, pinging by name. Then an out-of-context review of `room.rs` and
   `web/room*.ts` (CLAUDE.md "Out-of-context reviews").

Open questions for the user stay in plan §9.
