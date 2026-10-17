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
- `scripts/ci.sh`'s gates, run as their own commands (it stops at `cargo test`, below): at L0 fmt, clippy,
  testfloat, the tailnet client, tsc, tsan passed; at the exit (no Rust changed since L0) fmt, clippy and tsc pass,
  and `npm test` has 428 pass, 5 fail, 165 skipped. The five are the WebGL2 virgl and H.264 tests, which fail in
  cloud sessions as expected (software GL, no H.264 in Playwright's Chromium); the skips are images the cloud can't
  build and the Debian tests, run separately above. `cargo test` stops at its first failing target (the library's),
  so the native integration targets after it didn't run here.

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
3. **The installer flow** (`tests/page-machines.test.ts`, skipped with no variable to enable it): written, not
   finished. With Alpine's virt ISO (read-only) and a blank 2 GiB disk, the live system boots on the page in about a
   minute, root logs in, and `setup-disk -m sys` starts, then stops: **neither the virt nor the standard ISO carries
   `grub-efi` or `dosfstools`** (only e2fsprogs; checked in the images' file lists), and the tests' guest has no network.
   To finish it: give the guest the internet (the tailnet of `scripts/ci-net.sh`, or the tailcat exit node) so
   `setup-disk` fetches them, or a third read-only disk with those packages and their APKINDEX (`web/fat.ts` makes
   FAT images in Node). Then: install, power off, detach the ISO (`editAttachment`), boot the disk (EDK2 finds its
   boot entry in the machine's own variable store). Debian's netinst needs the network too.
   **It found a page bug, fixed:** busybox's getty writes `\n\r` before `localhost login: `, which the page's ready
   marker didn't take, so an Alpine machine never showed `running` (`web/app/machine.ts`, a unit case in
   `tests/page-debian.test.ts`'s always-run marker test).
4. **Step counts:** none should move (the tests' Node and native guests build their own device lists; only the page's
   order changed). If `tests/steps.txt` moves anywhere, report it to the user before anything else.
5. **The exit's numbers** in Chromium 153 (`bench/boot/REPORT.md`, committed JSON): a restore whose pins match (RAM
   and state only) against one that forks; a stored disk's import (Debian); a merge; a kept snapshot's size and save
   time against a downloaded one's from before this work; the ramdisk's fio against one buffer (§4.3: kept if within
   noise).
6. **What needs the user:** a pass over the modal by hand; deploying the page (only when asked) (the decisions are settled, below).

## The dev VM's pass so far

- `tests/page-snapshots.test.ts` (with the header menu): passed 4 times in a row (~66 s each, ~550 MB in OPFS against a
  ~3.7 GB quota; three kept snapshots ~170 MB each). Its first run failed once at Suspend with "the browser's storage
  is full" (a short write in `fileWriter`, `web/overlay.ts`), after 420 s waiting: not reproduced since. If
  `scripts/ci-debian.sh` hits it again, log `navigator.storage.estimate()` at the failure.

- `scripts/ci.sh` passes (372 s, Chromium 153; `tests/steps.txt` unmoved; `cargo test` whole, the FMA case above
  included, passes on arm64). Its first runs failed four page tests the cloud couldn't run, fixed:
  - **A bug:** a transient machine's snapshot named its own image as the disk (`disk: 'rootfs.ext4'` for
    Buildroot), so loading it was refused ("taken on the disk rootfs.ext4"). The page now marks the machine's own
    image (`StartDisk.own`) and the header says `null` again.
  - The header wraps to two rows at 1280 px (the Machines button), and Save disk's panel opened past the window's
    left edge: a header menu's panel now opens under its left edge when the right one doesn't fit.
  - Chromium 153 crashes (the browser, SIGTRAP) reading a file handle back from IndexedDB in an off-the-record
    context: `page-definitions` uses on-disk profiles; backlog entry (it would hit Incognito users).
  - `page-snapshot`'s expectations moved to the new device order; `browser.test.ts` waits for the view (the
    module awaits the store before setting it).
- **Decided by the user:** snapshot files saved before this work are refused on the page (their `devices` list has
  `blk` second; the disks now come last), with "its machine had other devices". No compatibility with them.
- `scripts/ci-debian.sh`: everything passed (6 min 46 s, budgeted in docs/testing.md) but `start`, fixed and rerun alone: `npm start` on a fresh
  clone imported `tools/serve.ts`, which imports the Svelte compiler, before its `npm ci` installed it
  (`tools/start.ts` now imports it after).
- `scripts/ci-audio.sh` passes (44 s) once its waits allow `window.__audio` not set yet (the page's module awaits the
  store first: a race, as `browser.test.ts`'s view was).
- Still to run: `ci-net.sh`, then the rest of the list above.

## Decisions the cloud session left open: settled (2026-10-17)

The user took the three recommendations: Save snapshot on a stored machine is a two-choice menu in the header (built:
`#snapshot-menu`, Keep in this browser… or Save to a file…); a 3D machine on a browser without WebGL2 stays another
shape (its 3D snapshots orphaned there); the transient machines' overlay names stay. Recorded in docs/plans/machines.md
§11.
