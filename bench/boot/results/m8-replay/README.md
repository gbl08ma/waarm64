# Budget flushes: replay, then carrying the hot set (2026-10-19)

The data behind `bench/boot/REPORT.md` "M8: carrying the hot set across a flush" and docs/jit.md "Tried and not
kept". The dev VM, Chromium 153.0.8010.52, Arch Linux ARM's desktop disk (`target/archarm/desktop.qcow2`,
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
- `flushes.ts`, `steady.ts`: the analyses (usage in their headers); `diag.patch`: the diagnostic build (apply,
  `scripts/build-wasm.sh`, measure, then restore the source and rebuild), now against commit 57a42a7 (the carry's
  last; marks exist only during a probe, so it starts one 5 s before each forced flush, and its `E` lines add, at the
  last carry, the regions marked, their bytes, the slots kept and the bytes alive). Its first version, against the
  commit that added this directory, is in git history.
- `r2/` (2026-10-20, `bench/boot/REPORT.md` "M8: the carry timed, and a larger code cache"): the second round timed
  on the dev VM and the budgets, each session with `JITLOG=1` (bench/gpu/guest-session.ts: the counters once a
  second, `<name>.jit.jsonl.gz`, which `counts.ts report` reads) and `r2/rss.sh` beside it (`<name>.rss.txt`: the
  biggest renderer's RSS and executable anonymous mappings, MiB, every 5 s).
  - `steady/`: the WebGL page with `diag.patch` as above: `base-*` the default, `carry-*` `?jit=replay`, `carryv-1`
    `?jit=replay&emitter=0`; `results.json`, `summary.json` (`steady.ts --summary`), the `E` lines (`evict.txt.gz`).
  - `pages/`: the pages session. Round 1 (the carry's core, ABI 42): `base-1`, `-2` the default, `carry-*`
    `?jit=replay`, `carryv-1` with `&emitter=0`, `b240-*`, `b320-*` the same core built with `MAX_BYTES` 240 and 320
    MiB, with `?jit=replay`. Round 2: `base-3`, `carry-3`, `rmax2-1` (`REPLAY_MAX` 2), `rm128-1` (`REPLAY_MODULE`
    128). Final: the landed core (ABI 43, no carry), `final320-*` as committed, `final160-*` the same with
    `MAX_BYTES` 160 MiB, by core swap (their timelines have no `flushes` field, so no `flushes.json`).
    `results.json`, `stalls.json`, `flushes.json`, `counts.json` (`counts.ts report --json` of the counters).
  - `go/`: the `go build` loop (`r1-*`: `base`, `carry`, `b320` as in round 1; `final-*`: `f160`, `f320`), the
    stress tool's logs and samples.
  - `gates/`: the gates, three rounds alternating (`r1-*`: `base`, `carry`, `b320`; `final-*`: `f160`, `f320`);
    `summary.txt` the medians by round.
