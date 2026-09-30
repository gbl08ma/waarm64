# Booting unmodified images through UEFI (M8 phase B)

A plan, not a description: nothing here exists in the emulator yet. Phase B's brief is
`M8-PHASEB-KICKOFF.md`; this page holds what loop 0 found on the QEMU oracle and the design that
follows from it. Update it as loops land, and move what exists into platform.md, devices.md and
images.md.

## Loop 0: what the oracle showed (2026-09-30)

Set-up: `qemu-system-aarch64` 11.1.1 (TCG) in the dev VM, `-M virt,gic-version=3 -cpu
cortex-a57 -smp 2 -m 1G`, virtio-mmio disks (`-device virtio-blk-device`), no PCI devices,
EDK2 edk2-stable202608 (openSUSE's `qemu-uefi-aarch64` package, a DEBUG build, and our own
RELEASE builds of ArmVirtQemu and ArmVirtQemuKernel, made natively in an arm64 Debian 13
container in ~1 min each). Loop 0's ad-hoc scripts became `tools/uefi-oracle.ts` in loop 1
(testing.md "System-level oracles"). Timings below are QEMU TCG's, not ours.

**Images** (all unmodified, all boot on every configuration below):
- Debian 13 nocloud (`images/debian.json`): `\EFI\BOOT\BOOTAA64.EFI` is shim, which loads GRUB
  2.12 (no `fbaa64.efi` next to it, so no fallback run and no NV boot entries written). GRUB's
  menu waits 5 s. GRUB's command line is `root=PARTUUID=… ro`, nothing else.
- Alpine 3.24.2 `alpine-3.24.2-aarch64-tiny-r0.qcow2`: **Limine** on the ESP (kernel, initramfs
  and every arm64 DTB there too), `timeout: 10`, command line with `console=ttyAMA0 console=tty0`.
- Alpine 3.24.1 `generic_alpine-3.24.1-aarch64-uefi-tiny-r0.qcow2`: GRUB 2.14.
- Alpine's cloud images are all UEFI on aarch64 (`tiny` = tiny-cloud, `cloudinit` = cloud-init;
  `-metal` variants carry the non-virt kernel).

**Firmware:**
- **Stock ArmVirtQemu requires fw_cfg.** Without a `qemu,fw-cfg-mmio` node its PEI phase calls
  `QemuFwCfgIsAvailable`, which reads through a missing HOB (an ASSERT in DEBUG builds; a read
  through NULL, i.e. flash at PA 0, in RELEASE): `OvmfPkg/Library/QemuFwCfgLib/QemuFwCfgMmioPei.c`.
- **ArmVirtQemuKernel needs neither fw_cfg nor a code flash.** It is EDK2 linked as an arm64
  `Image`, entered like a kernel with the DT's address in x0: no PEI, no execution from flash, no
  reset vector at 0. Booted with `-kernel` and a DT with no fw_cfg node (QEMU's own, minus
  `fw-cfg`, `pcie` and `platform-bus`), it boots Debian to a login as ArmVirtQemu does. Its DXE
  fw_cfg library tolerates fw_cfg's absence (and uses it when present).
- **It does need a variable store:** with no `cfi-flash` node it takes a synchronous exception
  early in DXE. It finds the store in a `cfi-flash` bank that doesn't hold the firmware (QEMU's
  bank 1 at `0x0400_0000`); the store is three 256 KiB areas (variables, FTW working, spare).
  The boot manager writes it on the first boot (a `Boot0002 "UEFI Misc Device"` entry). EDK2
  sets the flash node's `status` to `disabled` in the DT it hands over, so Linux doesn't bind a
  flash driver to it (no `/proc/mtd` on Debian).
- Firmware start to the boot manager starting the disk: **3.3 s** (ArmVirtQemuKernel RELEASE),
  5.3 s (ArmVirtQemu RELEASE from flash), 5.6 s (the DEBUG package). Then the loader's menu (5 s
  Debian, 10 s Alpine's Limine) unless a key is pressed; the kernel starts ~1 s after the menu.
- **No GOP:** on this machine EDK2 has no graphics output (ArmVirtPkg's GOPs are ramfb, which
  needs fw_cfg, and virtio-gpu). GRUB's `terminal_output gfxterm` falls back to the serial
  console; the firmware and loader menus are on the serial console only.
- EDK2 uses `RNDR` when the CPU has it (`-cpu max`); ours doesn't (backlog "CPU and ISA").
- **ArmVirtPkg ignores `/reserved-memory`** (only RISC-V virt parses it) and allocates from the
  top of RAM down: with 1 GiB it had "reserved" pages at `0x7fb1_2000–0x7fc1_4fff`, where our
  framebuffer sits today (the 2 MiB under the DTB's top 2 MiB). QEMU rewrites `/memory` to match
  `-m`, so the alternative placement (below) can't be tried there.

**Linux under the firmware:**
- **DT or ACPI, the same result** for all three images: with QEMU's ACPI tables (fw_cfg's
  `etc/table-loader`) EDK2 installs ACPI and withholds the DT ("EFI stub: Generating empty
  DTB"); with `acpi=off` it passes the DT through. Both: SMP through PSCI, power-off, the root
  disk, the same boot time (loop 1 first measured DT 1.8× slower: that was QEMU's `kaslr-seed`
  in the DT, KASLR, which the ACPI boots lacked; without it they're equal). The DT gives `tty0` and `ttyAMA0` (fbcon plus `stdout-path`); ACPI's
  SPCR gives `ttyAMA0` only.
- **The RTC is `rtc-efi` either way:** Linux asks EFI's `GetTime`, which EDK2 answers from the
  PL031 (so the PL031 must exist whenever the firmware runs). Other runtime services Linux uses:
  `GetVariable`/`SetVariable` (efivarfs: 28–33 variables on Alpine; `grub-install` on a Debian
  kernel update writes boot entries), `ResetSystem` (EDK2 turns it into PSCI).
- **Debian's first boot stops at `systemd-firstboot`** (timezone, then root password), because
  the published image has `root:!unprovisioned` and GRUB's command line has no
  `systemd.firstboot=off`. Skipping the password leaves root locked. Phase A avoided this with
  command-line credentials (`systemd.firstboot=off systemd.set_credential=login.noauth:yes`,
  web/app/machine.ts), which GRUB doesn't pass.
- **systemd credentials through fw_cfg solve it without touching the image:** with
  `opt/io.systemd.credentials/{login.noauth=yes, firstboot.timezone=UTC, firstboot.locale=C.UTF-8,
  passwd.hashed-password.root=<empty>}` there were no prompts, `/etc/shadow` got `root::`, and
  root logged in without a password (Linux's `qemu_fw_cfg` driver binds to the DT node; systemd
  imports `opt/io.systemd.credentials/*`). The network credential the page uses today would go
  the same way.
- **Alpine's cloud images lock root** and create users from cloud metadata (tiny-cloud). A
  NoCloud seed works: a 2 MiB FAT disk labelled `CIDATA` with `meta-data` and a `#!/bin/sh`
  `user-data` (here `passwd -d root`), as a second virtio-blk; root then logs in without a
  password. tiny-cloud doesn't read fw_cfg.

## DT or ACPI (the user asked, 2026-09-30)

Some love device trees, some hate them. The case against them comes from embedded boards, where
a DT is written per board, ships with the kernel, and drifts from the hardware. That doesn't
apply here: we generate the DT from the VM's configuration at start, as QEMU `virt` does, and
it only describes standard, discoverable parts (GICv3, generic timer, PL011, PL031, PSCI,
virtio-mmio, a framebuffer). The alternatives:
- **ACPI:** what Arm's SystemReady servers and Windows on Arm use. On arm64, Linux uses ACPI only
  when booted through UEFI, so the tests' direct boots would keep the DT and we'd maintain two
  descriptions. It needs MADT, GTDT, SPCR, FADT (hardware-reduced, PSCI), and a DSDT in AML with
  a device per virtio-mmio transport. EDK2's DynamicTablesPkg can build tables from a DT (the
  kvmtool platform does), but its parser covers the GIC, timer, serial port and PCI, not
  virtio-mmio. And ACPI can't describe a `simple-framebuffer`: the screen would need a firmware
  GOP (virtio-gpu, or ramfb over fw_cfg), then efifb or simpledrm.
- **Discovery on a bus (virtio-pci behind an ECAM host bridge):** devices enumerate themselves,
  so DT or ACPI describes only the root complex, and hot-plug becomes possible. It costs a PCI
  host bridge and config space in the core, and doesn't remove the need for a DT or ACPI.
- **Measured on the images in scope:** Debian's and Alpine's kernels run the same way on either.
  An ACPI-only guest would need it: Windows (which needs much more: PCIe, SBSA) or an
  enterprise distro that won't boot from a DT. None is in scope.

**Decision (settled by the measurement above): keep the DT**, generated by the core as now and
passed through EDK2 unchanged. Revisit when an ACPI-only guest comes into scope. Then EDK2's
DynamicTablesPkg building the tables from our DT, plus AML for virtio-mmio (or a move to
virtio-pci), keeps AML generation out of the core (backlog "Platform and devices").

## Loop 1: the firmware as a guest workload (done, 2026-09-30)
- `images/build.sh edk2`: ArmVirtQemuKernel RELEASE with `NETWORK_ENABLE=FALSE` (no PXE or HTTP
  boot: nothing to boot from a network, and the network stack linked TLS), natively in Debian's
  arm64 container, ~1 min, **reproducible** (a fixed stack-cookie list and hash seed: images.md),
  `QEMU_EFI.fd` `a1e92a5f…` plus `LICENSES.txt`. THIRD_PARTY.md has its row.
- `tools/uefi-oracle.ts` boots it on QEMU with a DT like ours (also without the PMU, the PL061
  and `gpio-keys` QEMU adds with `acpi=off`, the ITS, and the seeds), Debian with the fw_cfg
  credentials and Alpine with a generated seed disk, pressing Enter at the loader's menu. All
  three log in and power off. An erased (all-ones) variable bank works: EDK2 formats it.
- Stage times on the oracle (TCG, 2 vCPUs, the three at once): the boot manager starts the disk at
  3.3 s, the kernel at 4.2 s (Alpine, GRUB or Limine) and 8.4 s (Debian: shim, then GRUB loads a
  larger kernel and initrd); logins at 17 s (Alpine) and 25 s (Debian).
- `images/alpine-uefi.json` pins the two Alpine images (SHA512).

## The design for loops 2–3 (follows from loop 0)

This changes the kickoff's suggested loops 1–2 (a code flash at 0, a reset to the flash, the DTB
at RAM's base) to something smaller:
- **Firmware: ArmVirtQemuKernel** (loop 1). The page serves `QEMU_EFI.fd` (3 MiB, mostly
  compressed already) with its `LICENSES.txt`.
- **Boot: the existing direct boot.** The firmware is the `Image` (RAM + 2 MiB); no initrd; the
  DTB goes low in RAM, not in the top 2 MiB where EDK2 allocates (placement settled in loop 2:
  EDK2 must not allocate over it before copying it). A new machine configuration for the page;
  the tests' guests keep direct kernel boot and their step counts.
- **The framebuffer moves out of `/memory`:** `/memory` stops short of it and it sits right
  above, still in the same wasm memory at the same linear offset (so the display and the
  guest's PA-to-host translation don't change), invisible to EDK2's allocator, and Linux maps it
  as non-RAM. `/reserved-memory` goes for the firmware configuration. To confirm in loop 2 on our
  machine (Linux's simplefb must bind: `/dev/fb0`).
- **A variable store: one CFI flash bank** (`cfi-flash`, 1 MiB is enough for the 768 KiB store,
  at `0x0400_0000` like QEMU's bank 1), with the CFI command set EDK2's `VirtNorFlashDxe` uses
  (read array, read status, clear status, block erase, word/buffered program). Reads are plain
  reads, writes are commands, so it's an MMIO device, not RAM. The page keeps it in OPFS per disk
  (the kickoff's "EFI variables keyed by the base image's identity"). Needs an ABI design note.
- **fw_cfg, minimal:** the MMIO interface (selector, data, and DMA only if EDK2 or Linux needs
  it), the signature, ID and file directory, and named files from the host. Its first use is
  systemd credentials for Debian (no firstboot prompts, passwordless root, the network), which
  keeps the page's Debian as it is today. It's also the door to SMBIOS (credentials as type 11
  strings) and ramfb (a GOP) if wanted later. Needs an ABI design note. ArmVirtQemuKernel then
  sees fw_cfg with no ACPI tables and keeps the DT.
- **Alpine's seed:** a small `CIDATA` FAT image the page generates, as a second virtio-blk, for
  Alpine's cloud images (loop 4, "disk in").
- **The PL031 in every firmware configuration** (EDK2's RTC and Linux's `rtc-efi` use it):
  realtime as now; for the deterministic firmware tests, its time from virtual time.

## Open questions for the user (the page's Debian, loop 3)
- **Menus and timeouts:** the loader's 5 s (Debian) or 10 s (Limine) menu is on the serial
  console only (no GOP): should the page press Enter for the user, show the serial view until
  the kernel takes the screen, or leave it? (A GOP via ramfb would put firmware and GRUB on the
  screen; it needs fw_cfg's file writes and a GOP-backed framebuffer: likely its own step.)
- **Credentials:** keep today's passwordless root and UTC through fw_cfg (proposed), or let
  first boot ask?
