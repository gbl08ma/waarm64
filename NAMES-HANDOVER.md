# NAMES: registered names in a room — handover

The brief: [NAMES-KICKOFF.md](NAMES-KICKOFF.md) (binding; it wins over the spec). The design:
[docs/plans/room-names.md](docs/plans/room-names.md). This file: where the track is, the queue, open questions.

## State

- **Branch:** `claude/awesome-dijkstra-lq66ad` (a cloud session's). Every loop commits and pushes here; nothing is
  rebased onto `origin/main`; the user merges it into `main` once, at the end. A session taking the track over on
  another branch merges this one into its own first and writes its branch's name here.
- **Session kind:** cloud (x86_64, 4 vCPUs, 15 GiB; no `systemd-run`: `timeout` only, one heavy run at a time;
  docs/cloud.md). What only a dev VM session can run is marked *dev VM* in the queue.
- Supervisor started 2026-11-16. No loop run yet.

## The queue

| Loop | What | State |
|---|---|---|
| N0a | Measure, cloud part: the batch of real stamps made and their commitments committed (first); a year of each calendar's transactions through the two explorers (time to anchor, `REF_WINDOW`); proof of work (BLAKE2s against Argon2id: make, check 10k/60k entries in wasm; the GPU side from published figures, marked as such); verification rate in wasm | next |
| N1 | Records and rules, pure Rust in `net/ts/src/room/names/` | queued (needs no N0 number; the real anchored vector from N0a's stamps once collected) |
| N0b | Collect N0a's stamps' proofs: anchor sizes, the model's check, the size table | queued (hours after N0a) |
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
