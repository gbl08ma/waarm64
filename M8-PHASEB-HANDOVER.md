**Handover, 2026-10-01: M8 phase B (your own disk). Loops 0–6, the kickoff's last, are done:
what's left is the phase's wrap-up (below).** The brief is `M8-PHASEB-KICKOFF.md` (confirmed by the user
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

| 3 | `98de8e9` | Debian unmodified on the page: `firmware` machine, flash persistence, `npm start` with Podman-built EDK2, 80×25 firmware console, keys test, credentials over fw_cfg |
| 4 | `27c95b3` | Disk in: `File` blk backend (`blobSource`, FileReaderSync), `diskIdentity`, `diskOverlay`, `start.disk`, Open disk… / drop / `?disk=`, `tests/page-disk.test.ts` |
| 5 | `62d3bb5` | Disk out: `web/qcow2-write.ts`, `web/sha256.ts`, `web/app/export-worker.ts` + `export.ts`, the Save disk menu; tests against `qemu-img` and the pages |
| 6 | (this commit) | Changes in: `readChanges`/`changesHeader` (web/qcow2.ts), `loadChanges` + `hashSource` (web/changes.ts), `web/app/import-worker.ts` + `import.ts`, the Load changes… button (and Open disk/drop routing a changes file there), `removeOverlay` in Node; `tests/changes.test.ts`, page-save and page-disk extended |

Loop 2 in short: our machine boots `QEMU_EFI.fd` like a kernel (RAM + 512 KiB; the DTB stays in
the top 2 MiB, EDK2 copies it first), and EDK2 boots Debian's published qcow2 (shim, GRUB) and
both Alpine UEFI images (Limine, GRUB) to a root login in Node: Debian's kernel at 9.4 s, login at
41 s (parallel, 2 vCPUs, JIT). The deterministic test is the UEFI Shell from `shell.img` keeping an
EFI variable across two boots (`edk2-shell` in tests/steps.txt, native, Node interpreter and JIT).
The big finding: parallel SMP didn't cache global TLB entries in TTBR0, which firmware and
bootloaders use everywhere (70 s → 3 s from the boot manager to GRUB).

## Loop 6 (done 2026-10-01): changes in, and what's left
Documented in docs/frontend.md "Your own disk" ("Loading changes"). The planted bug (a wrong backing
hash accepted) fails `tests/changes.test.ts`. The fresh-profile round trip passes on Debian
(`tests/page-disk.test.ts`, ~200 s now). Loading deletes the overlay **and the variable store**
(the changes file doesn't carry it); Debian boots by the fallback path anyway.
Choices that stand: the file name of the base isn't compared, only its SHA-256; a qcow2 with a
backing file but no `WPC1` extension (another tool's) is refused; compressed clusters and
clusters under 4 KiB in a changes file are refused.

**What's left of phase B** (the kickoff lists no loop 7): run `scripts/ci.sh` on the final commit
(done for loop 6 before its commit), update PLAN.md's milestone row and CLAUDE.md's status line if
the user calls phase B finished, delete this handover and `M8-PHASEB-KICKOFF.md` in the commit
that supersedes them (CLAUDE.md), and ask the user what comes next (phase C lanes, backlog items:
the chosen file isn't remembered across reloads; EDK2's 0 MB RAM screen; Esc latency; Debian
GRUB's 5 s timeout). **No first-boot credentials in the release page.**

## Loop 3 (done 2026-10-01): what landed
`MACHINES.debian` is `firmware: true` (web/app/machine.ts: `kernel` is `QEMU_EFI.fd`, no initrd or
command line, `network.credentials` instead of a command line); the worker loads and saves the
flash bank (web/overlay.ts `loadFlash`/`saveFlash`, every 5 s when changed and at shutdown);
`?credential=name:value` and `StartMessage.credentials` pass fw_cfg credentials; the boot card
says the menus and the first boot's questions are on the serial console ("Show it"); `npm start`
links the disk only (`tools/debian.ts` `extract: false`) and builds the firmware with Podman
(`tools/start.ts` `firmwareStale`, `podmanProblem`); `images/build.sh edk2` patches TerminalDxe's
mode table to 80×25 (**remove if the UEFI ever gets graphical modes**, backlog), the page's
terminal is 80×25; `tests/page-uefi-keys.test.ts` drives EDK2 and GRUB through xterm.js;
`tests/page-debian.test.ts`, `page-network.test.ts`, `net-guest`, `net-tailnet` (via
`tests/browser/tailnet-worker.ts`) and `start.test.ts` boot/serve the firmware path;
`tests/debian-unattended.ts` has the test credentials. Numbers: 53 s to the login prompt against
33 s direct, and the "busy wait" is an LZMA decoder (bench/boot/REPORT.md "M8 phase B loop 3").
The user's suggestion that fixed the terminal size: configure the firmware rather than teach
xterm.js to resize.

Open after loop 3: the firmware's `0 MB RAM` in its setup screen (no SMBIOS; cosmetic);
a lone Esc takes ~2 s and PageUp/PageDown aren't decoded by EDK2's terminal driver
(frontend.md "The serial terminal"); Debian's GRUB has a 5 s timeout on every boot.

## Gotchas (loops 0–3)
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
- xterm.js gates custom `CSI t` handlers behind `windowOptions`; `page.waitForFunction` given a
  RegExp's `source` loses its flags (`m`); a DOM row's trailing spaces are trimmed (`grub>`).
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
