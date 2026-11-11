# P2P: peer-to-peer rooms over WebRTC — handover

The plan and its decisions: [docs/plans/networking-p2p.md](docs/plans/networking-p2p.md) (§1 binds). How it works
now: [docs/tailnet.md](docs/tailnet.md) "Rooms". There's no kickoff file: the user's brief is the plan, and their
word of 2026-11-10: R0's measurements weren't essential to deciding on the track ("I highly doubt the path will be
significantly less performant than DERP"); do them if a cloud session can, else go straight to the implementation.

## State

**R0 to R3 are done** (2026-11-10, cloud sessions; how it works: docs/tailnet.md "Rooms", docs/frontend.md
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
- R3: `bench/net/room-scale.ts` (a thousand members, `bench/net/room-member.ts` in worker processes, on the tests'
  relay, which now counts what it carries at `GET /stats`; `unixTime` in a room's config shifts the clock), REPORT.md
  "Rooms at scale", JSON in `bench/net/results/r3/`. Nothing grows with the room's size; two fixes from it in room.rs,
  each with its test (planted bugs caught): call backs past the trial budget wait (16 a second, 64 waiting; 200 dialers
  at once: 25 → 193 in), and the hour's turn waits for each relay's minute renewal (no thousand REQs in one second).
  The event kind decided (26354, plan §2); what a room needs from a relay written in plan §7 for R4.
- Tests: `cargo test -p webpc_ts room` (36), `tests/room-link.test.ts`, `tests/network.test.ts`'s and
  `tests/connections.test.ts`'s room cases, `tests/room-browser.test.ts`, and `tests/page-room.test.ts` (two Debian
  guests in one Chromium: Create, Join by link, the wizard's refusals, the resolver asked directly and through
  resolved, pings both ways by name; ~2 min; in `scripts/ci-net.sh`'s list). All passed in this session.

**CI:** in the dev VM, 2026-11-10, on the merge and R4's first runs: `scripts/ci.sh` OK (712 s; JS 1,397 passed, 0 failed, 140 skipped), `scripts/ci-net.sh` OK (885 s; 27 tests, the room beside the local helper among them).

## The review of R2–R3 (2026-11-10)

An out-of-context review (a fresh agent, branch `review/p2p-rooms`, `P2P-ROOMS-REVIEW.md`) found ten defects; nine are
fixed, each with its test failing first: a failed client kept reconnecting to its Nostr relays; a member's signalling
could make the page create RTCPeerConnections as fast as it sent (a peer's new connection now at most every 2 s, our
offers 4 a second); the copied link wrote the module's placeholder defaults into it; the page's members-reached list
only grew (a `peer-gone` event now); events under our tags were opened without a budget (256 a second); two workers
sharing a key raced to make it on its first start (one `add`); the page's link checks disagreed with link.rs (escapes
after raw non-ASCII, ports past 65535); the edit wizard's Save undid New name, and Save of an ephemeral room
connection always failed (a Svelte proxy `structuredClone` refused, found by the new test); Copy room link's fallback
selected the name. The smaller notes are in docs/backlog.md "Rooms' loose ends". The tenth, two room connections sharing a key
breaking each other on one DERP region (confirmed against the rig's derper), went to the user, who chose one at a
time: a running room connection holds its key's lock (`roomKeyLock`, web/app/net-live.ts; `tests/net-live.test.ts`).

## R4 (plan §7)

**Done in the dev VM** (2026-11-10): `scripts/ci-net.sh` whole; R0's numbers again (bench/net/REPORT.md "Again in the
dev VM": the gate holds; `bench/net/room.ts` now counts the CPU of every process it started, as `/usr/bin/chromium`
is a wrapper there); the room on a second adapter beside the local helper (`tests/net-local.test.ts`'s second case,
`tests/browser/adapters.html?local=&room=`; planted: the room's worker offering its lease as the primary's, caught).
Attribution checked for the track (THIRD_PARTY.json: `k256` and `sha2` rows, k256's RustCrypto dependencies under the
section's Cargo.lock rule; Trystero as a technique, Nostr's NIP-01 and BIP-340 as references).

**Done 2026-11-11** (after the user's first try on vm.tny.im: 200 ms pings through New York, ICE failing between
two windows of one desktop, mDNS the likely cause: docs/backlog.md): the public Nostr relays and tailcat's four regions
measured (bench/net/REPORT.md "Rooms on public servers", `bench/net/room-public.ts`): nos.lol and relay.damus.io,
two of our three defaults, carry no room; 21 of Trystero's 29 do. The home region by latency (room.rs `start_home`,
`probed`; tailnet.md "DERP"): a link without regions takes all of the map's, and the first to answer a probe is home.
The page: the room's status line and active connections, spacing; the Machines page's attach on a machine that's off. A review
of the home-region change (a fresh agent, static) found eight defects, all fixed with tests (planted bugs caught):
regions travel by map ID (`INLINE_REGION`), not index; the map waited for when it holds candidates; a missing region
fails only a configured home; probes count only a DERP server key; a failing home hands over before `Running`;
`close` ends the probes; the map's `Avoid`/`NoMeasureNoHome` respected. A second review of the fixes found nine more, fixed the
same way: the fallback and the hand-over ranked (`best_untried`: may be home, then the probe's outcome), a configured
home only a preference, a map ID named twice resolving to ours, the map's IDs and nodes filtered to what a room can
name and reach; `cargo test -p webpc_ts room` 58. **Accepted:** pages from before and after this change
don't reach each other in a room (a region's wire meaning changed from an index to an ID; rooms are pre-release, and a
reload fixes it).

**Decided 2026-11-11** (plan §9): the default Nostr relays (primal.net and five of Trystero's list, in link.rs), and
rooms on tailcat's public DERP relays (the user: a room uses them as tailcat's browser clients do, and less, going
direct where it can).

**Next:** two browsers on different networks (the dev VM and a phone), how often ICE fails. Then the track's end: its out-of-context review,
`scripts/ci-debian.sh`, the outcome into docs/ and PLAN.md §3.

Open questions for the user stay in plan §9 (the default public room); the seal's reuse of the WireGuard key is decided (plan §1, 2026-11-10).
