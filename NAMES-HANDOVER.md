# NAMES: registered names in a room — handover

The brief: [NAMES-KICKOFF.md](NAMES-KICKOFF.md) (binding; it wins over the spec). The design:
[docs/plans/room-names.md](docs/plans/room-names.md). This file: where the track is, the queue, open questions.

## State

- **Branch:** `claude/awesome-dijkstra-lq66ad` (a cloud session's). Every loop commits and pushes here; nothing is
  rebased onto `origin/main`; the user merges it into `main` once, at the end. A session taking the track over on
  another branch merges this one into its own first and writes its branch's name here.
- **Session kind:** cloud (x86_64, 4 vCPUs, 15 GiB; no `systemd-run`: `timeout` only, one heavy run at a time;
  docs/cloud.md). What only a dev VM session can run is marked *dev VM* in the queue.
- Supervisor started 2026-11-16. N0a done (cloud); its stamps wait for N0b.

## The queue

| Loop | What | State |
|---|---|---|
| N0a | Measure, cloud part (2026-11-16, bench/net/REPORT.md "NAMES loop 0, cloud part"): 80 random digests stamped at the three calendars 2026-11-16 19:11–21:04 UTC (bursts and singles; receipts and commitments committed in `bench/net/results/names0/stamps.json`; the 17 earliest already anchored at alice and bob, in the first transaction mined after them); time to anchor from the calendars' complete last days and a year's samples (a calendar pays from several coins with fresh change addresses, so a whole year is ~16,000 requests: sampled, an upper bound): stamp to proof median ~1 h at alice/bob, ~4 h at finney, first of three p99 2.4 h; `REF_WINDOW` 48 h; proof of work Argon2id 1 MiB t=1, `POW_BITS` 16 (GPU lead ≤ ~280x against BLAKE2s's ~3,900x; 60k entries ~30 s in wasm); an entry's whole check ~0.66 ms in wasm. All provisional (cloud times; the model's "next/second" reading waits for N0b) | done |
| N1 | Records and rules, pure Rust in `net/ts/src/room/names/` (2026-11-16, cloud): `id.rs` (rules, reserved list, ids, owner keys), `entry.rs` (207-byte entries, BIP-340 over a tagged hash with the room's value, Argon2id via the new `argon2` dependency; `Stamped`: one earliest anchor, at most one pending), `anchor.rs` (OpenTimestamps verifier from the format; pending anchors), `header.rs` (work, floor 1/16 of block 976,177's difficulty, 2 h ahead), `zone.rs`, `chain.rs` (`Name` holds every entry of a name, so merge order can't matter; `order`, `owner`, `prune`; `Kept`); `Params` with `PRODUCTION`. 26 tests: alice's real proof of block 976,177 as the vector (from N0a's proofs.json, so N0b isn't needed for it), merge-order property over 60 scenarios (forks, releases, stale copies, partial anchors), 24 planted bugs all caught. Spec brought in line; loose ends in docs/backlog.md (newer gTLDs, a zone's `seq` reuse, N2's one-chain-a-name with partial copies) | done |
| N0b | Collect N0a's stamps' proofs (`node bench/net/ots-stamps.ts collect`, then `sizes`): anchor sizes raw and shared, the size table, the model's check (did a stamp land in the next mined calendar transaction or the one after: `REF_WINDOW` and the dialog's words follow), N1's real vector | queued: **collect from 2026-11-18** (any session, `NODE_USE_ENV_PROXY=1` in a cloud one); ~70 GETs a calendar |
| N2 | The names client and the servers' side (2026-11-16, cloud): `room.rs` names mode (a second `Client` in the handle, fresh key, relay only, no guest or signalling, connections from `NAMES_CONN`, handshakes in only while its question is open) and `NamesHost`; `names/wire.rs` (items, the question, transfers in parts with 8 in flight, messages), `names/store.rs` (one chain a name: the owner's run, its pending renewals, tombstones; versions, fingerprints, the bound, records), `names/server.rs` (asking, the answer rule with its own 4/s budget, `serve`, range sync, `get`/`put`/`have`, verification in slices); module: config `room.names.titles`, action 11, `ts_room_names_load`. Choice: a server keeps one chain a name as a function of what it holds, and sync's `get` says everything held, so a run cut short is filled whole and servers converge (spec "Servers"). Tests: answer counts at 1/20/500 (third/second/first round; 7.8 servers at 500), two servers converge in 40 s, twenty in 6 min, a reset in 40 s, a flood leaves the node's lookups and call backs alone (12 answers in 3 s), nothing under the node key, no WebRTC; 18 planted bugs all caught. Page side of persistence stops at the module's interface (N3/N4). The module +92 KB Brotli with names linked (backlog). `tests/room-browser.test.ts`'s "stops making direct paths" case fails in this cloud container on N1's commit too (the others pass) | done |
| N3 | The member's side and the resolver (2026-11-16/17, cloud): `names/member.rs` (questions as a server's, but a member with one answer asks everyone at once; `get` owner mode to two servers, last entry checked; `history` when they disagree or contest what is kept; kept names answer at once and refresh after 5 min; NXDOMAIN 60 s; nobody 30 s doubling to 10 min; `ids` by first byte; records version 2), wire modes `history`/`ids`, `Server::resolve` (own pending name → own address); room.rs `MemberHost` (names client from the first non-key query, closed after 10 min idle) and the resolver's new cases (wait, SERVFAIL at 4 s, TTL 60, one log line a query); page side of persistence (`waarm64-room` v2 store `names`, web/room.ts `roomNamesStore`, worker streams records in, deletes refused ones; stored connections only); tests' parameters compiled in by the `test-params` feature (`net/ts/build.sh --test-params` → ts-test.wasm, never shipped; `self` event `params`), titles by `examples/names-title.rs`; `tests/net/ots-calendar.ts` (pretend calendars + explorer). Tests: member_tests.rs (14), room/tests/names.rs (+4), tests/room-names.test.ts (4), tests/page-room.test.ts grown (passes alone here, ~3 min): no server NXDOMAIN 2.6 s, then 0.07 s; first server found 16–21 s after it ran while the guest kept asking; cold lookup 1.3 s fake / 1.4 s page; Debian takes the search domain by default and asks nothing unprompted. 14 planted bugs all caught (idle-close bug caught only as a hang). Spec: "A member resolving a name", "The resolver", "Persist", "Tests' parameters" | done |
| Review 1 | Out-of-context review of `net/ts/src/room/names/` → `NAMES-REVIEW-1.md` | after N3 |
| CI mid | `scripts/ci.sh`, `scripts/ci-net.sh` alone | *dev VM* (a cloud `ci.sh` skips the image tests) |
| N4 | Review 1's findings, then the names agent | queued |
| N5 | The page | queued |
| N0c | N0's items 5 and 6 (public DERP transfer, cold lookup) and the GPU figure | *dev VM* |
| N6 | Scale and abuse; days on the public services | *dev VM* |
| End | Final review, full scripts, docs, deletions | partly *dev VM* |

## Open questions

- **A year of the calendars' history** (the kickoff's N0): reading it whole through the explorers is ~16,000+
  requests (a calendar pays from rotating coins, so no address lists it), far past "a few hundred". N0a took the
  complete last days plus year-long samples (an upper bound). The supervisor accepts that for `REF_WINDOW` (48 h has
  margin over the samples' worst); the user is told, and asked only if they want the full year (a bigger budget or
  another source).
- **Argon2id's GPU lead** is ~280x at checkable sizes (the spec's estimate said ~10x): a million names is tens of
  GPU-hours a term either way. Within the decisions (proof of work prices a term; the bound keeps junk out); noted.
