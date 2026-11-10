# P2P: peer-to-peer rooms over WebRTC — handover

The plan and its decisions: [docs/plans/networking-p2p.md](docs/plans/networking-p2p.md) (§1 binds). How it works
now: [docs/tailnet.md](docs/tailnet.md) "Rooms". There's no kickoff file: the user's brief is the plan, and their
word of 2026-11-10: R0's measurements weren't essential to deciding on the track ("I highly doubt the path will be
significantly less performant than DERP"); do them if a cloud session can, else go straight to the implementation.

## State

**R0 and R1 are done** (2026-11-10, cloud sessions; how it works: docs/tailnet.md "Rooms"):

- R0: `net/ts/src/room.rs` (a third client of the module), WireGuard over WebRTC data channels with DERP as the
  fallback, signalling inside the tunnel, `web/room.ts` and `web/room-worker.ts`; measured, the gate held
  (bench/net/REPORT.md "Rooms").
- R1: the link (`room/link.rs`), §2's remaining derivations and §3's lookups (`room/lookup.rs`; Nostr events in
  `nostr.rs` with `k256`, rows in THIRD_PARTY.json), call backs into the dialer's home region (one DERP connection per
  region in use), the probe of a live peer named by a lookup, connections on demand (lookups for unknown addresses,
  ICMPv6 unreachable, the 64-channel cap, 60 s idle close, peers forgotten when idle or lost), the resolver at the
  room's `::53` and the lease's `dns6`/`domains`, incoming off's flow table. `web/ts-client.ts` opens text WebSockets
  for an empty protocol. `JsRoom` takes `link`, `home`, `known`, `relayOnly`, `incoming` (no more `peers`, `relay`,
  `region`). Plan §3 amended (the lookup's age window, the probe, the caller's hello).
- Tests: `cargo test -p webpc_ts room` (26 cases, planted: no nonce check, flows ignored: each caught);
  `tests/nostr-relay.test.ts` (the tests' relay, `tests/net/nostr-relay.ts`); `tests/room-browser.test.ts` (3 cases:
  by address, relay only, by name and incoming off; passed in this session, `WEBPC_TAILCAT=1`). The module is 576 KB
  Brotli (R0's 533).

**Not done here:** `scripts/ci-net.sh` whole and `node bench/net/room.ts 5 10000 <json>` (R0's numbers) want the dev
VM (docs/cloud.md: no Podman, no IPv6); run both there before R2's end. The out-of-context review of R1 (CLAUDE.md):
see the commit after R1's for its findings, if it ran.

## Next: R2 (plan §7)

The page: a room as a connection kind (docs/network-adapters.md "Connections"), "Create a room" (name, private and its
suffix, relays and derper under advanced settings: builds the link with `room::Link`'s format) and "Join a room";
one's own name to copy (the `self` event's `name`), the incoming and relay-only switches, the key under advanced
settings, who sees one's IP address beside the privacy note; the node key kept in IndexedDB as tailcat's identity.
Then two Debian guests reaching each other by name in `scripts/ci-net.sh`. Words come from the catalog (docs/i18n.md).

Open questions for the user stay in plan §9 (the default public room, the relays, the seal's reuse of the WireGuard
key, the `p2p.alt` suffix, the event kind).
