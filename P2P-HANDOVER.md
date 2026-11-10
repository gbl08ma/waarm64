# P2P: peer-to-peer rooms over WebRTC — handover

The plan and its decisions: [docs/plans/networking-p2p.md](docs/plans/networking-p2p.md) (§1 binds). How it works
now: [docs/tailnet.md](docs/tailnet.md) "Rooms". There's no kickoff file: the user's brief is the plan, and their
word of 2026-11-10: R0's measurements weren't essential to deciding on the track ("I highly doubt the path will be
significantly less performant than DERP"); do them if a cloud session can, else go straight to the implementation.

## State

**R0, R1 and R2 are done** (2026-11-10, cloud sessions; how it works: docs/tailnet.md "Rooms", docs/frontend.md
"Network"). The plan split R3 on 2026-11-10 (the user's call: the dev VM is unavailable for a while): R3 is what a
cloud session can measure, R4 what needs a person or the dev VM.

- R0: `net/ts/src/room.rs`, WireGuard over WebRTC data channels with DERP as the fallback, signalling inside the
  tunnel, `web/room.ts` and `web/room-worker.ts`; measured, the gate held (bench/net/REPORT.md "Rooms").
- R1: the link (`room/link.rs`), lookups over Nostr (`room/lookup.rs`, `nostr.rs`, `k256`), call backs into the
  dialer's region, connections on demand, the resolver, incoming off's flow table; its out-of-context review's 16
  fixes. Left from it: public relays refusing events dated far ahead (R4), a replay to a target that just reloaded
  (accepted).
- R2: the `room` connection kind (web/app/connections.ts: `link`, `incoming`, `relayOnly`, `identityKey`; the key in
  IndexedDB `webpc-room`, shared by `keyOf` with another stored room connection, forgotten by the last one using
  it); the wizard's room steps (web/app/NetWizard.svelte: Create a room with its private suffix and relays under
  Advanced, Join a room by link or public name, the switches, the key, the IP-address note; editing: the switches
  and New name); the menu's name and link to copy (web/app/Network.svelte); web/room.ts's link (`roomLink`,
  `parseRoomLink`, the same text link.rs writes) and `startRoomNet` (the `Tailscale` handle the controller drives,
  a network map of `via: 'room'`). Words in the catalog under docs/copy.md. **The names' suffix is now
  `p2p.internal`**: systemd-resolved answers any `.alt` name NXDOMAIN itself (found by the Debian test; the room's
  resolver answered the same query sent to it directly), plan §5 says so (and why no lease can route `.alt`: resolved's source); the user accepted it, 2026-11-10.
- Tests: `cargo test -p webpc_ts room` (34), `tests/room-link.test.ts`, `tests/network.test.ts`'s and
  `tests/connections.test.ts`'s room cases, `tests/room-browser.test.ts`, and `tests/page-room.test.ts` (two Debian
  guests in one Chromium: Create, Join by link, the wizard's refusals, the resolver asked directly and through
  resolved, pings both ways by name; ~2 min; in `scripts/ci-net.sh`'s list). All passed in this session.

**CI:** `scripts/ci.sh` OK on R2 (1,506 s; JS 971 passed, 0 failed, 559 skipped; the agent's two root-only tests skipped, docs/cloud.md); `tests/page-room.test.ts`, `tests/room-browser.test.ts` passed alone (`WEBPC_NET_TESTS=1 WEBPC_DISTROS=debian WEBPC_TAILCAT=1`). **Not done here** (R4's first runs): `scripts/ci-net.sh` whole, `node bench/net/room.ts
5 10000 <json>` (R0's numbers), and R2's room on a second adapter beside the local helper (webpc-net is a private
repository a cloud session can't fetch).

## Next: R3 (plan §7)

Scale, with nothing outside the test harness: a thousand synthetic members on the tests' Nostr relay (join time,
lookup time, the worker's memory and CPU, the relay's load); the lookup's event kind picked from the NIPs' ranges
(`room::KIND`, 26354 a placeholder); what the defaults need from a public relay written down for R4. Then R4 when the
dev VM is back.

Open questions for the user stay in plan §9 (the default public room, the relays); the seal's reuse of the WireGuard key is decided (plan §1, 2026-11-10).
