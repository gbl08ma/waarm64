# M8 phase B kickoff: your own disk

**Confirmed by the user 2026-09-30** (drafted in M8-PHASEB-HANDOVER.md). Covers **phase B** of
M8: your own disk. CLAUDE.md's conventions and working rules apply; `scripts/ci.sh` must pass at
every commit that isn't docs only. Work as in M5–M8 phase A: short loops (one slice, one commit, a short report each),
and continue unless something needs the user's decision.

## The user's answers (2026-09-30; don't re-ask)
- **The outline below is OK.**
- **Images: Debian and Alpine only** for now; no Ubuntu, Fedora, openSUSE or others. Alpine's
  UEFI images are in scope (it publishes them: `alpine-<v>-aarch64-{tiny,cloudinit}-r0.qcow2`
  with Limine, and `generic_alpine-<v>-aarch64-uefi-{tiny,cloudinit}-r0.qcow2`).
- UEFI through EDK2, not a loader in the page (decided earlier the same day).
- **Later the same day, after loops 0–1:** waiting at the loader's menu is OK for now. The serial
  console with input is how advanced users reach the firmware and bootloader (EFI setup, other
  boot entries, editing the kernel command line): one of the reasons for booting through UEFI
  instead of extracting a kernel. **The release build's Debian behaves as on a regular machine:
  its first boot runs normally** (systemd-firstboot asks its questions); no credentials or other
  "hacks" outside CI and the tests. The user asked whether the firmware's lack of graphics can be
  worked around (answer in docs/plans/uefi.md "Graphics in the firmware").

## The brief
**Why before snapshots** (the user, 2026-09-30): the basic loop has to be right first: load a disk
into the VM, boot it, work, shut down, take the modified disk away. For that the VM should boot
unmodified disk images, not a kernel and initrd extracted ahead of time. PLAN.md §3 phase B has the
scope.

**Done when:** on the page, the user picks an image (a URL, or a local qcow2 or raw file by picker or
drop), and it boots through UEFI and its own bootloader, with no preparation step. They work and shut down, then download either **just
their changes** (a qcow2 over the base image as its backing file) or **the whole disk**. In a fresh
browser profile, the same base plus the uploaded changes boots with their files there.

**Decided (the user, 2026-09-30): UEFI, not a loader in the page.** A loader that reads `/boot`
and guesses the boot entry isn't standardized, would break with distro layouts, and takes the
bootloader away from the user. The image boots through EDK2 and its own GRUB, as on real hardware.

Loops (a suggestion):
0. **The oracle first:** EDK2's ArmVirtQemu on `qemu-system-aarch64` in the dev VM, set up the way
   our machine is: virtio-mmio disks (`-device virtio-blk-device`), no PCI devices, the PL011,
   the PL031, the flash pair. It should boot Debian 13's unmodified qcow2, and then Alpine's UEFI images (the
   only other images in scope; 16K/64K kernels aren't supported, PLAN.md "Deferred"). Settle there, where it's cheap to see:
   - whether ArmVirtQemu needs `fw_cfg`: it probes the DT for it, and without it there are no
     ACPI tables, so Linux gets our DT, which is what we want;
   - what it expects of the flash and the DTB handover (the DT at RAM's base);
   - where its console goes;
   - which EFI services Linux calls at runtime;
   - how long each stage takes.
   This is also where to find whether our `simple-framebuffer` node reaches Linux through EDK2's
   DT configuration table.
1. **The firmware as a guest workload:** `images/build.sh edk2` in Podman (pinned tag, reproducible,
   `images/SHA256SUMS`), and a THIRD_PARTY.md row (a binary we build and run, not code we copy).
2. **The platform:** a CFI flash (QEMU `virt`'s two 64 MiB banks at 0: code read-only; variables
   written with the CFI command set, kept in OPFS per disk), a reset to the flash with the DTB at
   RAM's base (a new VM configuration: the tests' guests keep direct boot and their step counts),
   whatever loop 0 found missing. The core's flash is an ABI change: design note in docs/abi.md
   first. Tests: a bare-metal flash test, and EDK2's boot to its shell in Node, deterministic
   (a new `tests/steps.txt` entry).
3. **Debian unmodified, end to end:** the page boots Debian's published qcow2 through EDK2 and
   GRUB, with no extraction (tools/debian.ts only downloads; the page's machine drops its
   `kernel`/`initrd`). Measure the boot against today's direct boot. The kernel's command line is
   now GRUB's: the page's console settings (serial vs screen) move to what GRUB passes, or to EFI
   variables. Say what changes for the user.
4. **Disk in:** a local `File` as a blk backend (the device worker reads slices synchronously;
   `FileReaderSync` works in workers), next to the HTTP range backend; qcow2 or raw by magic. The
   OPFS overlay (and the EFI variables) are keyed by the base image's identity.
5. **Disk out:**
   - Just the changes: a qcow2 writer (4 KiB clusters, the overlay's block size) with a
     backing-file name and the base's SHA-256 in a header extension.
   - The whole disk: the base merged with the overlay, streamed as qcow2 (zero clusters left out)
     or raw.
   - Both are written through `showSaveFilePicker`, with a Blob download as the fallback.
     `qemu-img check` and `qemu-img compare` are the oracle.
6. **Changes in:** our qcow2 reader learns backing files. An uploaded changes file is checked
   against the base's SHA-256 (a mismatch is refused with a message a user can act on) and becomes
   the overlay, under the overlay's Web Lock.

**Tests:** EDK2 to its shell and a small UEFI-bootable disk image from `images/` (Podman) through
GRUB to a power-off, in Node and Chromium (exact steps in deterministic mode); the flash's command
set against QEMU's behavior;
the qcow2 writer's output checked by `qemu-img` (check, compare against the merged raw); a changes
file round-trip (write, export, reset, import, the file is back); a mismatched base refused. The
page: pick a file, boot, write, export the changes, then in a fresh profile the same base plus the
upload has the file. Planted bugs: a block left out of the export, a wrong backing hash accepted,
a flash write that doesn't stick.

**Check with the user first:** any dependency; changes to the tests' guests (a new test disk image
and the EDK2 build are new, not changes); the page's Debian switching to UEFI (what the user sees
changes: firmware and GRUB before the kernel).

**Out of scope:** a catalog of hosted images and settings (phase D), snapshots (phase C lane),
16K/64K kernels, Secure Boot, ACPI.
