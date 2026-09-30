**Handover, 2026-09-30: M8 phase B (your own disk). Loops 0–2 are done; loop 3 (Debian
unmodified on the page) is next.** The brief is `M8-PHASEB-KICKOFF.md` (confirmed by the user
2026-09-30: the outline is OK, **images in scope are Debian and Alpine only**). Phase A's handover
is in git history; networking has its own (`M8-PHASEC-NETWORKING-HANDOVER.md`).

**Read, in order:** CLAUDE.md, the kickoff, [docs/plans/uefi.md](docs/plans/uefi.md) (loop 0's
findings, DT vs ACPI, loops 1–2, the design, **the user's answers for the page**), docs/abi.md
"M8 phase B" (ABI 29), docs/platform.md ("Boot", "The firmware configuration's devices", "PL031"),
docs/frontend.md, `web/app/machine.ts`, `web/app/` (the page and its machine worker),
`tests/uefi.test.ts` (how a UEFI boot is driven over the serial console), `tests/page-debian.test.ts`.

## Where phase B stands
| Loop | Commit | What landed |
|---|---|---|
| 0 | `21eff2b` | The kickoff; the QEMU oracle study (docs only) |
| 1 | `918a8b8` | `images/build.sh edk2` (ArmVirtQemuKernel, reproducible), `tools/uefi-oracle.ts`, `images/alpine-uefi.json` |
| 2 | `bc7bd3a` | ABI 29, the firmware configuration: `VmConfig.firmware`, a CFI flash bank (`core/src/flash.rs`), fw_cfg (`core/src/fw_cfg.rs`), the PL031 always (virtual time when deterministic), `vm_flash`; `BootOptions.firmware` (web/vm.ts); TTBR0 global TLB entries cached in parallel SMP; `web/fat.ts`; in-memory overlays in Node; `shell.img` and `images/build.sh alpine-uefi`; tests |

Loop 2 in short: our machine boots `QEMU_EFI.fd` like a kernel (RAM + 512 KiB; the DTB stays in
the top 2 MiB, EDK2 copies it first), and EDK2 boots Debian's published qcow2 (shim, GRUB) and
both Alpine UEFI images (Limine, GRUB) to a root login in Node: Debian's kernel at 9.4 s, login at
41 s (parallel, 2 vCPUs, JIT). The deterministic test is the UEFI Shell from `shell.img` keeping an
EFI variable across two boots (`edk2-shell` in tests/steps.txt, native, Node interpreter and JIT).
The big finding: parallel SMP didn't cache global TLB entries in TTBR0, which firmware and
bootloaders use everywhere (70 s → 3 s from the boot manager to GRUB).

## Loop 3: Debian unmodified, end to end (the kickoff's loop 3)
**Goal:** the page boots Debian's published qcow2 through EDK2 and GRUB, with no extraction
(tools/debian.ts only downloads; the page's machine drops its `kernel`/`initrd`). **Check with the
user first:** the page's Debian switching to UEFI changes what the user sees (firmware and GRUB
before the kernel, first-boot questions on the serial console): the kickoff lists it.

What to do (the user's answers are in plans/uefi.md "The user's answers for the page"):
1. `web/app/machine.ts`: Debian's machine becomes `firmware` (the page serves `QEMU_EFI.fd` and
   its `LICENSES.txt`; `npm start` builds or fetches it: decide how, `images/build.sh edk2` needs
   Podman and ~1 min, which `npm start` users may not have: ask if a prebuilt download is wanted).
   The flash bank is kept per disk (OPFS, next to the overlay, keyed like it) and saved at
   power-off and on `close`.
2. **No credentials in the release build:** Debian's first boot runs systemd-firstboot on the
   serial console (no `console=` from GRUB: `/dev/console` is the PL011). The page must make that
   visible (show the serial view or say where to look). The network credential (`network.network.card`)
   that phase A put on the command line has to move (fw_cfg is only for tests: ask the user
   whether the network card's credential may go through fw_cfg, since it isn't a first-boot
   "hack" but a device setting).
3. Menus wait for their timeout (GRUB 5 s). Check keys end to end through xterm.js to EDK2's
   terminal and GRUB (arrows, F-keys, Esc, Ctrl-X).
4. Measure the page's boot against today's direct boot (bench/run.ts in Chromium, CLAUDE.md
   "Performance"). Before that, find the busy wait between EDK2's boot manager and GRUB's menu
   (5.4G steps in ~3 s, backlog "The firmware configuration").
5. Update tests/page-debian.test.ts, tests/start.test.ts (Debian's kernel/initrd identity check
   goes), docs/frontend.md, and say what changes for the user.

## Gotchas (loops 0–2)
- `localhost/webpc-images` (images/Containerfile) is **amd64** under qemu-user here: never build
  EDK2 in it. `edksetup.sh` fails under `set -u` and eats the positional parameters (`set --`
  first); an apostrophe inside build.sh's single-quoted container scripts ends the script.
- `/tmp` is a 6.9 GB tmpfs: don't extract whole partitions there.
- QEMU: `-fw_cfg name=…,string=` rejects an empty value (use `file=`); with `-dtb` QEMU still
  rewrites `/memory` and `/chosen`.
- Menus: Debian's GRUB waits 5 s, Limine 10 s, on the serial console (no GOP). Limine draws its
  menu a character at a time between cursor escapes (match on stripped text).
- EDK2 with no `cfi-flash` node takes a synchronous exception early in DXE; with a PL031 that
  refuses byte reads, as ours did, a data abort in DXE ("Synchronous Exception at …" is all a
  RELEASE build prints: the native runner's summary has ESR/ELR/FAR).
- The UEFI Shell is an *application* boot option, which BDS's automatic boot skips: with no
  disk EDK2 stops at "No bootable option or device was found". `shell.img` makes it the
  removable-media loader instead.
- A test that passes credentials must read one back: with fw_cfg's directory planted off by one
  Debian still logged in (the shifted credentials happened to allow it).
- `bench/results/local/uefi-node.ts` (untracked) is the ad-hoc driver: `debian`, `alpine`,
  `alpine-grub`, and direct boots `debian-page` / `debian-grubline` for comparison.

## Carried over (still true)
- The Debian page tests take turns (`tests/debian-lock.ts`), so does `tests/uefi.test.ts`'s
  Debian; every heavy run under `systemd-run --user --scope -q -p MemoryMax=10G -p
  MemorySwapMax=0 -- timeout N <cmd>`. CI isn't needed for docs-only changes (CLAUDE.md).
- The dev VM has no `diff` or `cmp`. `../webpc-base` is at `9e0209b` for A/B runs.
- Looking at the page from the desktop: `ssh -t -L 8080:127.0.0.1:8080 macmini.lan "ssh -t -F
  ~/.lima/dev/ssh.config -L 8080:127.0.0.1:8080 lima-dev 'cd ~/Development/webpc && npm start'"`,
  then `http://127.0.0.1:8080/`.
- From phase A for later loops: the overlay's Web Lock (`webpc-overlay:<name>`) is its
  ownership; importing a changes file that replaces the overlay takes the same lock. Keep the
  page's VM config (machine.ts) separate from the tests' guests. The worker protocol grows a disk
  (URL or `File`) in `start`, and export and import messages.
