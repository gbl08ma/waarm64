# SNAPZ: faster snapshots — kickoff

**The user's brief (2026-11-15), drafted by the session that measured it; confirmed by the user handing it over.**
Make saving and loading a snapshot of a big machine (a graphical session with programs loaded: hundreds of MB to GBs
of RAM) as fast as the hardware allows, at about today's compression ratio. Small machines may get slower if they must;
compatibility with existing snapshot files is not required. The measurements behind every choice here:
`bench/boot/REPORT.md` "SNAPZ: compression across the emulator, measured" (read it first), its tools in `bench/snapz/`
(README), its raw numbers in `bench/boot/results/snapz-eval/`.

## Where it starts (the desktop guest, `target/snapbench/pages.waarm64snap`, 689 MB)

- **Save: the machine pauses 4.2 s.** 2.9 s is the core's LZ on one thread, 0.42 s the frames' CRC in JS, 0.35 s the
  zero-page scan, 0.2 s the devices' state, 0.15 s the disk's blocks, 0.12 s the sink.
- **Load: 9.8 s.** ~3.3 s is compression's (the check pass's JS CRC, decompressing, copies), 2.25 s writing the disk's
  49 MB into the overlay one 4 KiB block at a time, ~4.3 s starting the machine (not broken down).
- Measured on one thread, then on a pool: 4 workers cut compression 3.6x (6: ~20% more); lz4_flex is 10-20% faster
  than the core's LZ at the same ratio and reads and writes the same format.

## Decisions (binding; the user's, 2026-11-15)

1. **lz4_flex replaces `core/src/lz.rs`** as codec 2 (the LZ4 block format: existing files stay readable; checked both
   ways, `bench/snapz/compat.mjs`). Its `safe-encode` and `safe-decode` features (pure safe Rust; within ~5% of the
   unsafe paths, REPORT). **crc32fast** takes the frames' CRC-32 into wasm. Both approved as dependencies; so is
   **miniz_oxide** as a normal dependency of the core (today a dev-dependency) for qcow2's clusters (loop 6), under
   the user's standing OK for safe, tested Rust dependencies. Each gets its `THIRD_PARTY.json` row (`about`: it ships;
   docs/third-party.md). No other dependency without asking; zstd (C) was considered and not taken.
2. **A pool of workers** compresses the save and decompresses the load: `min(navigator.hardwareConcurrency - 1, 6)`
   workers (the paused machine's vCPU threads are idle), each scanning, gathering, compressing and CRC-ing its frames
   straight from guest RAM (shared memory), chunk c to worker c mod n; the machine worker writes the frames in order.
   **The file's bytes don't depend on the pool's size** (each frame is compressed alone). The pool starts before the
   pause (its start isn't paused time). If it can't start (no worker, a failed instance), the save and the load run on
   one thread as today: a fallback, tested.
3. **A picked file is staged through OPFS** (the file stream measured ~430 MB/s, half a pool's output): during the
   pause the snapshot goes to a staging file in OPFS (a sync access handle, ~3 GB/s), the machine resumes, and the
   staging file is then copied into the picked file and removed. **When the storage hasn't room** (`navigator.storage
   .estimate()` against a bound of the file's size, with a margin), or the staging write is refused partway, the
   snapshot is written **directly** to the picked file's stream, as today (a refusal partway restarts the write
   directly, still paused). A copy that fails after the resume says so and leaves nothing behind; a staging file left by
   a crash is removed at the next start. While the copy runs the machine runs, but it counts as the save in progress
   (one save at a time, as now). Kept snapshots and Suspend already write to OPFS directly: they don't stage.
4. **The ABI:** new or changed core exports (the LZ's, a CRC, inflate/deflate for qcow2) bump `ABI_VERSION`, with the
   design note in docs/abi.md first (CLAUDE.md). This kickoff is the user's OK for those exports; any other host ABI
   change is asked.
5. Not guest-visible: step counts (tests/steps.txt) don't move. If something does move them, stop and ask.
6. **Measure with a persistent profile.** Playwright's default context is off the record, where OPFS costs ~250 µs a
   call: it inflated the bench's save to 6.6-7.5 s. Every snapshot timing in this track uses `WAARM64_PROFILE=<dir
   under target/>`; the off-the-record cost is a finding (loop 5 takes what's cheap of it).

## How the track runs

**The session is a supervisor**, as PERF-HANDOVER.md "How the track is worked" describes (read it; the same rules hold
unless this file says otherwise). It opens the track first: a row in PLAN.md ("In progress since <date>", links to
this file and SNAPZ-HANDOVER.md), and `SNAPZ-HANDOVER.md` (lean: state, the queue, open questions; CLAUDE.md), committed
and pushed. Then it runs **one general-purpose subagent at a time, one loop each**, in the main checkout (no
worktrees), waits for it to finish, checks its report against the repo (`git log`, the pushed commit, `git status`
clean, `ps` for leftovers), updates the handover's queue, and starts the next. It works through to the end without
check-ins: choices are settled by measurement; it asks the user only what can't be measured (a dependency not listed
above, a host ABI change past decision 4, anything guest-visible, a memory cost past a few tens of MiB). The user is
often watching: a short status line between loops.

**A loop's brief** (the subagent knows only what's in it; written fresh, neutral, never the supervisor's theory):
- Read CLAUDE.md and follow it exactly (bounded runs with `timeout`; `systemd-run` memory caps on every node, cargo
  and Chromium run; CI scripts alone, in the background, waited on inside its turn; no self-matching `pkill`). Then
  this file, SNAPZ-HANDOVER.md, the REPORT entry above, and the docs of its area: docs/platform.md "Snapshots" and
  "The snapshot file", docs/frontend.md "Snapshots" and "Suspend", docs/machines.md §5, docs/abi.md; for loop 6
  docs/devices.md (qcow2) and docs/frontend.md (export).
- The loop's goal and its done (below), the files it touches, what earlier loops changed that bears on it.
- How to decide: measure the part first (bench/snapz's harness, the page probe of loop 0); build what the numbers
  justify; if a loop's goal needs a redesign out of proportion to its measured gain, stop and write the finding.
- Measurement: the page's own timings (loop 0's), ≥3 rounds alternated between arms in one session, medians and
  ranges; the desktop guest's warm snapshot as the big case and Debian (`bench/gpu/warm-snapshots.sh debian`, 176 MB)
  as the small one (it may get slower: say by how much). State memory next to every speedup (the pool's instances:
  RSS before and during a save). The dev VM ranks these (no JIT code-size effects); a Mac confirmation run is
  optional, at the end (`bench/gpu/sway-mac.sh` with `FROM_SNAPSHOT=`, then `bench/gpu/mac-leftovers.sh`).
- Correctness: tests at the cheapest layer (tests/snapshot-file.test.ts, tests/snapshot.test.ts, tests/snapshot-plan
  .test.ts in Node; the page tests in Chromium); a planted bug for each new rule a test must catch (a frame written out
  of order, a worker's frame dropped, a stale staging file kept), source restored afterwards. Tests never
  `assert.deepEqual` large buffers (`Buffer.compare`, a short message).
- The finish: a REPORT entry "SNAPZ loop N" in bench/boot/REPORT.md with its JSON committed in
  `bench/boot/results/snapz-<n>/`; the docs page describing what exists now (with the finding, if something lost);
  loose ends in docs/backlog.md; the handover's queue row updated; `cargo fmt --all`; `scripts/ci.sh`, plus
  `scripts/ci-debian.sh` and `scripts/ci-machines.sh` for every loop that touches snapshots or disks, and
  `scripts/ci-graphics.sh` for a loop that touches what a 3D machine's snapshot carries; `git fetch`, rebase onto
  origin/main, commit, push to origin main. The reply: a short report with the numbers, what was built or why not,
  memory, tests and planted bugs, CI results, the commit hash.

**Out-of-context reviews** (CLAUDE.md): after loop 3 (the pool, save and load: new subsystem) and at the track's end, a
fresh agent with only the area and "find real defects" reviews statically, findings on a `review/snapz-<n>` branch; the
next loop fixes them first, each with its confirming test failing first.

## The loops (in order; the supervisor may reorder by measurement, saying why in the handover)

0. **The probe and the baseline.** Make the save's and load's phase timings permanent and cheap (the save's in
   `#message`'s `data-snapshot` JSON, the load's somewhere tools can read: `bench/snapz/phases.patch` shows the points),
   and a tracked page probe (from `bench/snapz/probe-save.ts`) that loads a warm snapshot and saves it as a kept
   snapshot, as a suspend and as a download, with a persistent profile, printing the phases. Baseline numbers for both
   guests. *Done:* the probe committed and documented in docs/benchmarking.md; the baseline in the REPORT.
1. **lz4_flex and crc32fast in the core.** lz4_flex (safe features) behind codec 2's exports in place of `lz.rs`
   (removed, with its tests ported where they test the codec's contract: total on any input, never a panic or an
   out-of-bounds; `bound`); the frames' CRC through the core (writer and reader; the JS CRC kept only where no core
   instance exists, e.g. reading a header). Files the old codec wrote still load (a test with a frame from it). *Done:*
   one-thread save and load faster by about the REPORT's margin; ABI bumped with its note.
2. **The save's pool** (decision 2), for Snapshot, kept snapshots and Suspend. *Done:* the desktop guest's pause near
   the REPORT's projection (~1.2-1.3 s at 4 workers), the file byte-identical for any pool size (a test), the
   one-thread fallback tested, the progress line still right.
3. **The load's pool:** the check pass's CRC and the RAM frames' CRC, decompression and placement in workers, writing
   straight into guest RAM (and the spill memories). *Done:* the load's compression share near the REPORT's ~0.8 s; a
   damaged frame still refused before anything is touched. Then the out-of-context review.
4. **The review's findings fixed**, then **a picked file staged through OPFS** (decision 3). *Done:* the picked-file
   pause equal to a kept snapshot's within the noise, the fallback paths tested (no room; refused partway; a failed
   copy; a stale staging file), docs/frontend.md says what the user sees.
5. **The disk's blocks:** a restore writes 11,952 blocks one 4 KiB overlay write at a time (2.25 s with a persistent
   profile); a save reads them one sync read at a time (cheap on disk, 2.4 s off the record). Batch both (runs of
   consecutive blocks, the overlay's map updated once a run) if the measurement says so. *Done:* the numbers before
   and after, both profiles.
6. **qcow2's clusters:** inflate through miniz_oxide in the core (synchronous: 160 µs a 64 KiB cluster against
   DecompressionStream's ~400), in the read path and the inflate pool (keep the pool only where it still pays:
   measure a 1 MiB read); the export's deflate through miniz_oxide at level 6 (66 µs a 4 KiB cluster against
   CompressionStream's 307, same ratio) in the deflate pool. Valid qcow2 for QEMU (`qemu-img check` and a read of the
   exported image by QEMU, as the export tests do). *Done:* an export's and a compressed image's read speed before
   and after.
7. **The load's machine start** (~4.3 s): break it down (workers, the core's compile, the 3D state's restore, the
   first frames), fix what is cheap and plainly the load's, put the rest in docs/backlog.md with its numbers.

## The end

Every test layer green (`scripts/ci.sh`, `ci-debian.sh --platform`, `ci-graphics.sh`, `ci-machines.sh`), the
final review's findings fixed or filed, the numbers in the REPORT (a closing entry: the save's pause and the load, both
guests, against loop 0's baseline), docs/platform.md "The snapshot file" and the other pages describing what exists,
loose ends in docs/backlog.md (and its SNAPZ entry removed), PLAN.md's row set to done with its links, and this file
and SNAPZ-HANDOVER.md deleted in that commit.
