# BENCH loop 2's sessions (bench/boot/REPORT.md "BENCH loop 2")

Each directory is one run of `bench/ab-mac.sh` on the M4 Mac mini: `ab.json` (every sample in the order run) and
`verdict.txt`. `node bench/ab.ts --analyze <dir>` prints a verdict again (not `aa1`'s: see below).

- `aa1`: four pages of one core kept alive for 20 rounds (the driver's first draft: its rows have `round`, not
  `block`, and round 0 is the warm-up; `place.mjs` reads it).
- `warm-none`, `warm-boot`, `warm-user`: four identical arms, 14 fresh-browser pairs, by warm-up.
- `names`: the arm called `base` moved off the first slot, two blocks of ten rounds.
- `r16`: `block::REGION` 16 against 64, the defaults, both workloads.
- `aa-s1` to `aa-s3`: the base alone (its A/A arm holds the stop), the defaults, both workloads.
- `noise.ts <dir>/ab.json`: an A/A session's spreads, each arm against the base, by place, against the P-core share.
- `place.mjs <dir>...`: each arm's deviation from its round's mean by place.
- `replay.ts <dir>...` → `replay.txt`: the stopping rule replayed over the A/A pairs.
