# Budget flushes: replay, then carrying the hot set (2026-10-19)

The data behind `bench/boot/REPORT.md` "M8: carrying the hot set across a flush" and docs/jit.md "Replay after a
flush". The dev VM, Chromium 153.0.8010.52, Arch Linux ARM's desktop disk (`target/archarm/desktop.qcow2`,
`WEBPC_GUEST_USER=alarm`), 4 vCPUs. The builds: the replay as the cloud built it (`unpaced`), paced (`replay-*`,
`s2`/`s3` `jit_replay`), the floor not doubled at a flush (`nodouble-*`), and the carry (`replay-c*`, `s4`/`s5`
`jit_replay`); `base-*` the default of the same build, by `?jit=replay` or not (`nodouble` by core swap).

- `pages/`: Firefox's pages session (`PHASES=pages TIMELINE_ALL=1`). `<session>.results.json` as firefox-load.ts
  writes it; `flushes.json` (`flushes.ts --json`): per flush the compiled share before, the slow phase (`slowS`,
  `slow2S`: seconds until the share is back within 5 and 2 points), the interpreted steps over 10 and 60 s, the
  regions replayed; `stalls.json` (`bench/gpu/stalls.ts --json`). `base-4` and `base-c2` waited out their first
  page (the backlog's "A Firefox session whose first page times out") and don't count.
- `steady/`: Firefox's WebGL page for 150 s with `diag.patch` (a flush for room every 30 s from the dispatcher;
  per-table `E` lines of what's interpreted, compiled and installed, gzipped). `s1`: the floor doubling at each
  forced flush, replay without carry; `s2`, `s3`: the floor kept (a first flush each time), replay without carry;
  `s4`, `s5`: the floor kept, carry. `summary.jsonl` (`steady.ts --summary`): per flush the slow phase, the frames
  a second before and after, the worst second, seconds with a gap of 250 ms or more.
- `gates/`: `smp_alpine_jit` and `smp_user_jit_4`, the default and `--query=jit=replay` (the carry) alternating,
  three rounds; `summary.txt` the medians by round.
- `go/`: the 4-vCPU `go build` loop of `bench/stress` (`--seconds 420 --no-load --disk2 …goroot.ext4`), the default
  and the carry, one each (the stress tool's log and samples).
- `cloud/` (**from a cloud session**, 2026-10-19: counts only, no times): Debian on the page at a 24 MiB budget
  (`MAX_BYTES`, a local edit), 4 vCPUs, its boot and `counts.ts`'s userspace load, one session each: `default`,
  `main-carry` (the core before the round that replays only what was marked and emits outside the lock),
  `carry` (that round, the compile worker emitting) and `carry-vcpu` (`?emitter=0`). `<name>.json.gz`: the page's
  counters once a second; `report.json`: `counts.ts report --json` of them (docs/jit.md "Counted in the cloud").
- `counts.ts`: that session and its per-flush report (usage in its header).
- `flushes.ts`, `steady.ts`: the analyses (usage in their headers); `diag.patch`: the diagnostic build, against the
  commit that adds this directory (apply, `scripts/build-wasm.sh`, measure, then restore the source and rebuild).
