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
| N1 | Records and rules, pure Rust in `net/ts/src/room/names/` | queued (needs no N0 number; the real anchored vector from N0a's stamps once collected) |
| N0b | Collect N0a's stamps' proofs (`node bench/net/ots-stamps.ts collect`, then `sizes`): anchor sizes raw and shared, the size table, the model's check (did a stamp land in the next mined calendar transaction or the one after: `REF_WINDOW` and the dialog's words follow), N1's real vector | queued: **collect from 2026-11-18** (any session, `NODE_USE_ENV_PROXY=1` in a cloud one); ~70 GETs a calendar |
| N2 | The names client and the servers' side | queued |
| N3 | The member's side and the resolver; tests/page-room.test.ts | queued |
| Review 1 | Out-of-context review of `net/ts/src/room/names/` → `NAMES-REVIEW-1.md` | after N3 |
| CI mid | `scripts/ci.sh`, `scripts/ci-net.sh` alone | *dev VM* (a cloud `ci.sh` skips the image tests) |
| N4 | Review 1's findings, then the names agent | queued |
| N5 | The page | queued |
| N0c | N0's items 5 and 6 (public DERP transfer, cold lookup) and the GPU figure | *dev VM* |
| N6 | Scale and abuse; days on the public services | *dev VM* |
| End | Final review, full scripts, docs, deletions | partly *dev VM* |

## Open questions

None yet.
