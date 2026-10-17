# M8 phase D, machines as the unit: handover from the cloud session to the dev VM

The brief is `M8-MACHINES-KICKOFF.md`; the plan is [docs/plans/machines.md](docs/plans/machines.md) (its decisions bind;
§11 records where the build settled what the plan left open). This file says what a Claude Code cloud session (an
x86_64 container, 4 vCPUs, 15 GiB, Playwright's Chromium 141) built and verified, and what only the dev VM can do. It
stands on its own: work from it, the plan and the kickoff's decisions.

## What was built (commits on `claude/confident-ramanujan-sf0e38`)

| Loop | What | Where |
|---|---|---|
| L0 | the model: records in IndexedDB, bytes in OPFS, the sweep, the shape and its hash, change notices between tabs; the firmware fetched and hash-checked in cloud sessions | `web/app/store.ts`, `web/app/shape.ts`, `scripts/cloud-setup.sh` |
| L1 | devices built from a disk list (16 at most, after the other devices), serials, blank disks, the ramdisk (1 MiB chunks), a stored machine opened by `?m=<id>` | `web/app/worker.ts`, `web/devices.ts`, `web/ramdisk.ts`, `web/app/main.ts` |
| L2 | the overlay's generation; overlays as named variants; stored disks (import, merge with resume, written in place); exports and changes-in on any disk | `web/overlay.ts`, `web/stored.ts`, `web/app/disks.ts`, `web/app/disk-worker.ts`, `web/app/sources.ts` |
| L3 | the Machines modal (Svelte, compiled in serve and dist); the URL check; file handles re-granted from a click; a dropped disk makes a machine | `web/app/Machines.svelte`, `tools/svelte.ts`, `web/app/machines.ts`, `web/app/urlcheck.ts` |
| L4 | snapshots: pins with generations, the ramdisk in the file, kept snapshots, orphaned ones (delete all, make a machine like it), fork-or-keep restores, Suspend on pins | `web/snapshot.ts`, `web/app/snapshots.ts`, `web/app/Snapshots.svelte` |
| L5 | machine definitions out and in (files re-picked, checked by identity, then hash) | `web/app/definitions.ts` |

The L2 commit also carries L3's groundwork (the compile step, the `svelte` dependency, the components not yet wired).

## What was verified in the cloud (Chromium 141), each Debian test alone

- Node: `store`, `ramdisk`, `stored`, `overlay`, `devices`, `snapshot-plan`, `snapshot`, `changes`: pass.
- Chromium, no guest: `store` (IndexedDB and OPFS), `page-disks` (stored-disk exports under `qemu-img check` and
  `compare`; overlay variants; the restore plan), `page-modal`, `page-definitions` (two fresh profiles), `dist` (the
  static copy's modal from `vendor/`): pass.
- Planted and caught, sources restored: the generation's bump left out; the epoch after a snapshot left out; an
  interrupted merge not resumed; a fork skipped when the generation differs.
- Debian on the page, each file alone: `page-machines` four disks (a URL, a blank disk formatted and kept, a ramdisk
  empty after the guest's reboot, a read-only disk refusing writes): 6.5 min; the stored disk, step 1 (import 94 s,
  1,043 MB stored, boots over its first overlay 156 s and over the loaded changes 115 s): 8.0 min, step 2 (a merge,
  a boot written in place 221 s, one over a new overlay on the merged disk 290 s): 9.7 min; `page-snapshots`: 5.5 min;
  `page-disk` (reworked: the chosen file makes a machine): 7 min. **The boots in place and on the merged disk were
  slower** than the overlay boots before them (221 and 290 s against 115–156): measure in the dev VM whether reads of a
  merged store (its blocks no longer in disk order after the merge's writes) or of a store in place cost that, before
  anyone relies on in-place disks for speed. (The cloud's boot times vary; one run is no measurement.)
- An earlier run of these tests timed out at a boot because other work ran beside it (unit tests, a Chromium test):
  run Debian page tests alone here, as `scripts/ci-debian.sh` does.
- `scripts/ci.sh`'s gates, run as their own commands at L0 (see below why): fmt, clippy, testfloat, the tailnet
  client, tsc, tsan pass; `npm test` 415 pass, 5 fail: the WebGL2 virgl and H.264 tests, which fail in cloud
  sessions as expected (software GL, no H.264 in Playwright's Chromium). The final run is in "At the exit" below.

**A pre-existing failure, not this work's:** `cargo test`'s `fp::tests::inline_fma_is_correctly_rounded` fails on
x86_64 (`0x7dffffffffaace66 * 0x41dfffffff54c27a + 0xffeffffffeff90e2`: the inline FMA gives `0x7feffffffffffffd`,
the soft reference `0xfcb0…`). No Rust was touched. The test builds some inputs with `powi`, which is compiler-rt's
`__powidf2` and may round differently per host, so x86 likely reaches a case the M4 never generates: possibly a real
edge case in the inline FMA's preconditions (the JIT's?). `scripts/ci.sh` stops there in the cloud, so its later
steps were run by hand. **Worth a look in the dev VM** (does the case reproduce on arm64 with these exact operands?).

## What only the dev VM can do (work through it in order)

1. **`scripts/ci.sh` with every image**, alone; then **`scripts/ci-debian.sh`** (now with `page-machines` and
   `page-snapshots`: budget its time and note it in docs/testing.md), **`scripts/ci-audio.sh`** and
   **`scripts/ci-net.sh`**, each alone. The device order changed for every page machine (the other devices, then the
   disks), which touches the sound card's and the network card's slots: expect those suites to pass, and treat a
   failure as this work's.
2. **The Buildroot tests written before this work and not run here** (no Buildroot in the cloud):
   `tests/browser.test.ts`'s page tests (Reset disk, the overlay hand-over), `page-save`, `page-snapshot` (Buildroot's
   snapshot and Suspend on a transient machine; its file's `devices` list is in the new order), `page-machine`'s
   Buildroot test,
   `dist`'s Buildroot boot, `start`. `page-debian` (needs linux-snd's `snd-play`) runs Debian's transient-machine
   snapshot and Suspend: it must still pass.
3. **The installer flow** (`tests/page-machines.test.ts`, Alpine's virt ISO into `target/iso/`, the command in the
   test's comment): (filled in at the exit: whether it ran here).
4. **Step counts:** none should move (the tests' Node and native guests build their own device lists; only the page's
   order changed). If `tests/steps.txt` moves anywhere, report it to the user before anything else.
5. **The exit's numbers** in Chromium 153 (`bench/boot/REPORT.md`, committed JSON): a restore whose pins match (RAM
   and state only) against one that forks; a stored disk's import (Debian); a merge; a kept snapshot's size and save
   time against a downloaded one's from before this work; the ramdisk's fio against one buffer (§4.3: kept if within
   noise).
6. **What needs the user:** a pass over the modal by hand; deploying the page (only when asked); the decisions below.

## Decisions the cloud session left open (each with a recommendation)

- **Save snapshot on a stored machine** keeps it in the browser after a name prompt; downloading the running machine
  is in the modal. Options: a two-choice menu in the header (recommended), or as is.
- **A 3D machine on a browser without WebGL2** runs 2D, which is another shape: its 3D snapshots show as orphaned
  there. Options: as is (recommended: the guest really sees other devices), or the shape ignores 2D/3D and the
  restore refuses instead.
- **Transient machines' overlay names** (`webpc-debian`, `webpc-disk-<hash>`) stay as they were for the tests;
  options: leave them (recommended), or move them under `overlays/` too.
