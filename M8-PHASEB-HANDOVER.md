**Handover, 2026-09-30: M8 phase B (your own disk). Loops 0 and 1 are done; loop 2 (the
platform) is next and starts in a fresh session.** The brief is `M8-PHASEB-KICKOFF.md` (confirmed
by the user 2026-09-30: the outline is OK, **images in scope are Debian and Alpine only**). The
user asked for loop 2 to start fresh: this file is its kickoff. Phase A's handover is in git
history; networking has its own (`M8-PHASEC-NETWORKING-HANDOVER.md`).

**Read, in order:** CLAUDE.md, the kickoff, [docs/plans/uefi.md](docs/plans/uefi.md) (all of it:
loop 0's findings, DT vs ACPI, loop 1, the design), then `docs/abi.md` (a change needs a design
note first), `docs/platform.md` ("Memory map", "Boot", "PL031"), `docs/devices.md` (the
framebuffer, the device worker), `docs/testing.md` ("Step counts", "System-level oracles": the
UEFI oracle), `core/src/boot.rs`, `core/src/fdt.rs`, `core/src/vm.rs` (`VmConfig`, `Io`),
`core/src/pl031.rs`, `web/vm.ts` (`BootOptions`), `web/app/machine.ts`.

## Where phase B stands
| Loop | Commit | What landed |
|---|---|---|
| 0 | `21eff2b` | The kickoff; the QEMU oracle study (docs only): ArmVirtQemuKernel through our direct boot, a CFI variable bank, fw_cfg for Debian's credentials, a seed disk for Alpine, the framebuffer out of `/memory`, the DT stays |
| 1 | (this commit) | `images/build.sh edk2` (reproducible, `LICENSES.txt`, THIRD_PARTY.md row), `tools/uefi-oracle.ts`, `images/alpine-uefi.json`; the KASLR finding (backlog) |

Loop 1 in short: ArmVirtQemuKernel RELEASE without the network stack, built natively in Debian's
arm64 container in ~1 min, reproducible (`QEMU_EFI.fd` `a1e92a5f…`). The oracle boots `debian`,
`alpine` (Limine) and `alpine-grub` through it on QEMU with a DT like ours, logs in as root and
powers off: `node tools/uefi-oracle.ts debian alpine alpine-grub` (~30 s). The apparent "DT 1.8×
slower than ACPI" was QEMU's `kaslr-seed` (KASLR), now dropped from the oracle's DT; it's a
backlog warning for `rng-seed`/`kaslr-seed` and for RNDR (under UEFI an RNG brings KASLR).

## Loop 2: the platform (the brief for the next session)
**Goal:** our machine boots `target/images/edk2/QEMU_EFI.fd` the way the oracle does, in Node
first: EDK2 runs, finds its variable store, and reaches its boot manager (with no disk, the UEFI
shell or "no bootable device"); with Debian's or Alpine's disk it gets to GRUB or Limine and on
into the kernel. The page switch is loop 3, not this one.

**What to build** (details and reasons in plans/uefi.md "The design for loops 2–3"):
1. **ABI design notes first** in docs/abi.md, then `ABI_VERSION` 29: the firmware machine
   configuration (a `VmConfig` field or a boot flag), the CFI flash bank (its backing buffer and
   how the host persists it), fw_cfg's files from the host.
2. **Firmware boot:** the firmware is loaded like an `Image` (RAM + 2 MiB, the existing path; it
   has the arm64 header), no initrd. **The DTB must not sit in the top 2 MiB** in this
   configuration (EDK2 allocates from RAM's top down): put it where EDK2 won't allocate before it
   copies it (e.g. RAM's base, as QEMU does for firmware; check what ArmVirtQemuKernel reserves:
   `ArmVirtPkg/PrePi`, the "kernel" variant's memory init). Direct kernel boot and every test
   guest stay exactly as they are (their step counts must not move).
3. **The framebuffer above `/memory`:** in the firmware configuration `/memory` stops short of
   the framebuffer, which sits right above at the same linear offset in the same wasm memory (so
   `vm_framebuffer`, the display and PA-to-host translation don't change). No `/reserved-memory`.
   Check Linux's simplefb binds (`/dev/fb0`, fbcon on the screen). QEMU can't check this (it
   rewrites `/memory`), so this is the first thing to verify on our machine.
4. **A CFI flash bank for variables** (`cfi-flash`, bank-width 4, at `0x0400_0000`; ≥ 768 KiB,
   1 MiB proposed; QEMU's bank is 64 MiB): an MMIO device in the core (reads in array mode are
   plain reads; writes are commands). Implement what EDK2's `OvmfPkg/VirtNorFlashDxe` issues:
   read array (0xFF), read status (0x70), clear status (0x50), block erase (0x20/0xD0), word
   program (0x40/0x10), buffered program (0xE8 … 0xD0), CFI query (0x98) if probed. QEMU's
   `hw/block/pflash_cfi01.c` is the behavioral reference (GPL: read it, never copy it). Note
   that the JIT and interpreter fault non-RAM PAs to `vm::Io`, so array-mode reads go through Io
   too (fine for a store read a few times a boot; measure if not). Linux must not bind its own
   driver to it while EFI runtime services own it: EDK2 sets the node's `status` to `disabled`
   before handing the DT over (checked on the oracle: Debian has no `/proc/mtd`); keep it so.
5. **A minimal fw_cfg** (`qemu,fw-cfg-mmio` at `0x0902_0000`, as QEMU `virt`): selector (16-bit
   BE), data (8-bit reads suffice for Linux's `qemu_fw_cfg` and EDK2; DMA only if one of them
   needs it), items: signature `QEMU`, ID, the file directory, and named files from the host.
   First files: Debian's systemd credentials for **the tests only**
   (`opt/io.systemd.credentials/login.noauth`, `firstboot.timezone`, `firstboot.locale`,
   `passwd.hashed-password.root` empty): **the user decided the release build's Debian boots as
   on a regular machine** (systemd-firstboot asks), so the page passes none. Leave room for the
   DMA interface: ramfb (a firmware GOP, plans/uefi.md "Graphics in the firmware") needs it, as a
   later step. QEMU's `docs/specs/fw_cfg.rst` is the spec (a doc: fine to follow).
6. **The PL031 in the firmware configuration always** (EDK2's RTC and Linux's `rtc-efi`): in
   deterministic mode its time from virtual time (a fixed epoch plus the counter), so firmware
   tests are exact.
7. Whatever else our machine lacks that EDK2 touches: watch for external aborts at unknown PAs,
   UNDEFINED system registers (EDK2 at EL1 reads ID registers, `CNTFRQ`, maybe PMU or debug
   registers), cache maintenance by set/way (NOPs for us: fine). EDK2 uses no RNDR here.

**Tests** (the kickoff's list, the loop-2 part):
- A bare-metal CFI test (`tests/baremetal/`, oracle-checked on QEMU with a flash bank: erase,
  program, status, read back) and native unit tests for the flash and fw_cfg.
- **EDK2 to its boot manager in Node, deterministic, with a new `tests/steps.txt` entry** (a new
  test, not a change to an existing guest), e.g. boot with no disk and stop at the shell or the
  "no bootable option" message; and the same through Chromium if cheap.
- A variable written by one boot is there on the next (the flash bank's bytes carried over).
- Planted bugs: a flash write that doesn't stick (the variable test fails), a fw_cfg directory
  entry off by one (the credentials test or EDK2's probe fails). Restore and rebuild the wasm.
- Debian and Alpine through our EDK2 to a login in Node under the JIT (realtime), Debian with the
  credentials over fw_cfg and Alpine with a seed disk: the same result as the oracle. Their
  boot times against today's direct boot of Debian (bench/run.ts in Chromium only if claiming a
  number: CLAUDE.md "Performance").
- `scripts/ci.sh`, and `scripts/ci-long.sh` if the change touches the JIT or the memory model.

**Check with the user first** (from the kickoff): any dependency; any change to an existing test
guest. For loop 3 the user has answered (plans/uefi.md "The user's answers for the page"):
menus wait for their timeout for now, the serial console with input is the way into the
firmware and bootloader, and Debian's first boot runs normally in the release build (its
questions land on the serial console: the page must show that).

## Gotchas (loops 0–1)
- `localhost/webpc-images` (images/Containerfile) is **amd64** under qemu-user here: never build
  EDK2 in it (and an amd64 build leaves x86 dependency files in the tree: `git clean -fdx` in
  every submodule).
- `edksetup.sh` fails under `set -u`, and reads the caller's positional parameters as its own
  options (`set --` before sourcing it). An apostrophe inside build.sh's single-quoted container
  scripts ends the script (use none in their comments).
- `/tmp` is a 6.9 GB tmpfs: don't extract whole partitions there; read files from images with
  `web/qcow2.ts` + `web/bootfs.ts` in Node, or `mtools` at an offset (`mdir -i img@@<bytes>`).
- QEMU: `-fw_cfg name=…,string=` rejects an empty value (use `file=` on an empty file); with
  `-dtb`, QEMU still rewrites `/memory` and `/chosen`; with `acpi=off` its DT gains a PL061 and
  `gpio-keys`. The oracle removes what our machine lacks; keep it in step with our DT.
- Menus: Debian's GRUB waits 5 s, Limine 10 s, on the serial console (no GOP on this machine).
  Limine draws its menu a character at a time between cursor escapes (match on stripped text).
- EDK2 with no `cfi-flash` node takes a synchronous exception early in DXE.

## Carried over (still true)
- The Debian page tests take turns (`tests/debian-lock.ts`); every heavy run under `systemd-run
  --user --scope -q -p MemoryMax=10G -p MemorySwapMax=0 -- timeout N <cmd>`. CI isn't needed for
  docs-only changes (CLAUDE.md).
- The dev VM has no `diff` or `cmp`. `../webpc-base` is at `9e0209b` for A/B runs.
- Looking at the page from the desktop: `ssh -t -L 8080:127.0.0.1:8080 macmini.lan "ssh -t -F
  ~/.lima/dev/ssh.config -L 8080:127.0.0.1:8080 lima-dev 'cd ~/Development/webpc && npm start'"`,
  then `http://127.0.0.1:8080/`.
- From phase A for later loops: the overlay's Web Lock (`webpc-overlay:<name>`) is its
  ownership; importing a changes file that replaces the overlay takes the same lock. Keep the
  page's VM config (machine.ts) separate from the tests' guests. The worker protocol grows a disk
  (URL or `File`) in `start`, and export and import messages.
