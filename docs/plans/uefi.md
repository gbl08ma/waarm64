# Booting unmodified images through UEFI (M8 phase B)

A plan, and the record of its loops. Phase B (done 2026-10-01) had its brief in `M8-PHASEB-KICKOFF.md` (in git history); this page holds
what loop 0 found on the QEMU oracle, the design that follows from it, and what each loop found.
What exists is described in platform.md ("Boot", "The firmware configuration's devices"),
abi.md ("M8 phase B"), testing.md and images.md; update them when the area changes.

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

## Loop 2: the platform (done, 2026-09-30)
What was built is in platform.md and abi.md (ABI 29: `VmConfig.firmware`, the flash bank,
fw_cfg, `vm_flash`). What loop 2 found:
- **The DTB stays in the top 2 MiB.** ArmVirtQemuKernel's entry (`ArmVirtPkg/PrePi/
  ModuleEntryPoint.S` `DiscoverDramFromDt`) copies the DT into the 32 KiB after its own image
  header before it allocates anything, so EDK2 can't land on it first (the design below
  expected to move it low). The firmware goes at RAM + 512 KiB: its header's `text_offset`.
- **EDK2 needed nothing else** of our machine than the design's list, plus one fix: it reads
  the PL031's PrimeCell IDs with byte loads, which we aborted (QEMU allows them). With no disk
  it reaches "BdsDxe: No bootable option or device was found"; with `shell.img` (the UEFI Shell
  as the removable-media loader) it runs a script, keeps a variable in the flash bank, and
  powers off through `ResetSystem` (PSCI SYSTEM_OFF): ~540M steps, deterministic, the same in
  every runner (tests/steps.txt `edk2-shell`).
- **Firmware and bootloaders map global entries in TTBR0**, which parallel SMP didn't cache
  (the ASID skip of TLBI IS waits needed none there): every access walked, and Debian took 70 s
  from EDK2's boot manager to GRUB's menu in Node. They're cached now, with the vCPU waited for
  by every TLBI IS while it may hold one (platform.md "Broadcast maintenance"): 3 s.
- **Linux on our EDK2 and our DT** (Debian, both Alpine images, in Node, parallel on 2 vCPUs):
  `efi: EFI v2.7 by EDK II`, `/memory` as we set it (EDK2's memory map up to `0x7fbf_ffff`, the
  framebuffer at `0x7fc0_0000` above it), simplefb (Debian) or simpledrm (Alpine) bound to the
  framebuffer, `rtc-efi` with the right time, fw_cfg under `/sys/firmware/qemu_fw_cfg` with
  Debian's credentials (no first-boot questions, the timezone set from them), both vCPUs,
  a clean power-off. Alpine's root unlocked by a CIDATA seed disk that `web/fat.ts` writes (the
  generator loop 4's page needs too).
- **Stage times in Node** (one run each, parallel, 2 vCPUs, JIT, realtime; not a benchmark):
  Debian: boot manager 3.7 s, GRUB's menu 6.6 s (Enter pressed), kernel 9.4 s, login prompt
  41 s, power-off 50 s. Alpine (Limine or GRUB): 3.8, 3.9, 5.2, 25, 33 s. The UEFI oracle on
  QEMU TCG: the kernel at 8.4 s (Debian) and 4.2 s (Alpine). Today's direct boot of the same
  disk, timed the same way: login at 26 s with the page's command line, 32 s with GRUB's (the
  page masks networkd, resolved and timesyncd and turns AppArmor off). So through the firmware
  Debian pays ~8.5 s before its kernel (~3 s of it the busy wait in backlog "The firmware
  configuration") and ~6 s of userspace the page's command line skipped: loop 3's numbers to
  beat, measured in Chromium with bench/run.ts before any claim.

## The design for loops 2–3 (follows from loop 0)

This changes the kickoff's suggested loops 1–2 (a code flash at 0, a reset to the flash, the DTB
at RAM's base) to something smaller:
- **Firmware: ArmVirtQemuKernel** (loop 1). The page serves `QEMU_EFI.fd` (3 MiB, mostly
  compressed already) with its `LICENSES.txt`.
- **Boot: the existing direct boot.** The firmware is the `Image` (RAM + 512 KiB); no initrd;
  the DTB where it always was (loop 2: EDK2 copies it before it allocates). A new machine
  configuration for the page; the tests' guests keep direct kernel boot and their step counts.
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
  lets the tests and CI boot Debian unattended (the release build passes none: the user's answer
  below). It's also the door to SMBIOS (credentials as type 11
  strings) and ramfb (a GOP) if wanted later. Needs an ABI design note. ArmVirtQemuKernel then
  sees fw_cfg with no ACPI tables and keeps the DT.
- **Alpine's seed:** a small `CIDATA` FAT image the page generates, as a second virtio-blk, for
  Alpine's cloud images (loop 4, "disk in").
- **The PL031 in every firmware configuration** (EDK2's RTC and Linux's `rtc-efi` use it):
  realtime as now; for the deterministic firmware tests, its time from virtual time.

## Graphics in the firmware (the user asked, 2026-09-30)
Our firmware build already has both drivers that would give EDK2 a graphics output (GOP), so
the firmware's menus, the EFI setup screen and GRUB's `gfxterm` would appear on the screen:
- **ramfb** (`OvmfPkg/QemuRamfbDxe`, small): when fw_cfg has an `etc/ramfb` file, the firmware
  allocates a framebuffer in RAM and writes its address, format and size to that file; the host
  draws from there. Linux takes the framebuffer over from EFI (`efifb` or `simpledrm` through
  `screen_info`), so the firmware configuration would need no `simple-framebuffer` node. Needs
  fw_cfg's **DMA interface** (fw_cfg writes go only through DMA). A step after loop 2's fw_cfg.
- **virtio-gpu** (`OvmfPkg/VirtioGpuDxe`, over virtio-mmio): the graphics track's virtio-gpu 2D
  (docs/plans/graphics.md) would give a GOP too, and supersede ramfb.
Until then the menus are on the serial console, where input already works (the PL011's receive
path, M8 phase A).

## Loop 3: Debian unmodified on the page (done, 2026-10-01)
What it found, beyond what frontend.md "Debian through UEFI" says:
- **The serial console's size.** EDK2's TerminalDxe offers text modes up to 240×56; GRUB takes the
  largest and sends `CSI 8;56;240 t` (xterm's resize), which xterm.js ignores: on the page's
  80-column terminal only GRUB's countdown line was visible. Teaching xterm.js the sequence (a CSI
  handler, which needs `windowOptions.setWinSizeChars`: xterm.js gates custom `t` handlers), scaling
  the font and shrinking back at the kernel's hand-over worked but was the wrong fix. **The user
  suggested the right one: configure the firmware.** `images/build.sh edk2` deletes the larger rows
  of TerminalDxe's mode table, so the only mode is 80×25 and nothing asks for a resize (the page's
  terminal has 25 rows). **Remove the patch if the UEFI ever gets graphical modes** (backlog).
- **Keys** (`tests/page-uefi-keys.test.ts`): everything arrives except PageUp/PageDown; a lone Esc
  takes ~2 s (EDK2 waits to tell it from a sequence); a fast stream of arrows can lose bytes.
  GRUB's "UEFI Firmware Settings" resets the machine into EDK2's setup: the variable (OsIndications)
  is kept in the flash bank across the page's restart, which is the flash persistence working.
  After "Continue", EDK2 shows its boot device menu (ArmVirt's BDS) rather than booting on.
- **The cost:** 53 s to the login prompt against 33 s direct (bench/boot/REPORT.md); the
  suspected busy wait between the boot manager and GRUB is an LZMA decoder, not a wait.
- The flash bank is saved as it changes (a closed tab never runs a shutdown) in
  `<overlay>/flash`, so Reset disk clears it with the disk.

## The user's answers for the page (2026-09-30; loop 3)
- **Menus:** waiting for the loader's timeout is fine for now. The serial console with input is
  the way into the firmware and bootloader (EFI setup, boot entries, editing the command line);
  loop 3 checks those keys end to end (arrows, F-keys, Ctrl-X through xterm.js to EDK2's
  terminal driver and GRUB).
- **Debian's first boot runs as on a regular machine** in the release build: no credentials over
  fw_cfg or anything else outside CI and the tests (which keep using them, to boot unattended).
  Consequence for loop 3: with a DT and no `console=`, `/dev/console` is the serial port, so
  systemd-firstboot's questions appear on the serial view while the screen waits; the page must
  make that visible (e.g. show the serial view, or say where to look).
- **The switch (asked after loop 2):** the page's Debian may boot through UEFI, as long as users
  eventually get to supply a disk image that has already been through its first-boot
  configuration (loops 4–6 give them that: a disk in, a changes file or whole disk out).
- **The firmware for `npm start`:** built with Podman (`images/build.sh edk2`), for now.
- **The network card's settings go through fw_cfg** (a systemd credential with the `.network`
  file, passed when the Network menu connects a card): a device setting, not a first-boot
  credential.

## Gotchas (found while building it)
- `localhost/webpc-images` (images/Containerfile) is **amd64** under qemu-user on the dev VM: never
  build EDK2 in it. `edksetup.sh` fails under `set -u` and eats the positional parameters (`set --`
  first); an apostrophe inside `images/build.sh`'s single-quoted container scripts ends the script.
- `/tmp` is a 6.9 GB tmpfs: don't extract whole partitions there.
- QEMU: `-fw_cfg name=…,string=` rejects an empty value (use `file=`); with `-dtb` QEMU still
  rewrites `/memory` and `/chosen`.
- Menus: Debian's GRUB waits 5 s, Limine 10 s, on the serial console (no GOP). Limine draws its
  menu a character at a time between cursor escapes (match on stripped text). Debian's GRUB
  passes `quiet`: the kernel's own command-line echo isn't on the console.
- EDK2 with no `cfi-flash` node takes a synchronous exception early in DXE; with a PL031 that
  refuses byte reads, as ours did, a data abort in DXE ("Synchronous Exception at …" is all a
  RELEASE build prints: the native runner's summary has ESR/ELR/FAR).
- The UEFI Shell is an *application* boot option, which BDS's automatic boot skips: with no disk
  EDK2 stops at "No bootable option or device was found". `shell.img` makes it the
  removable-media loader instead.
- A test that passes credentials must read one back: with fw_cfg's directory planted off by one
  Debian still logged in (the shifted credentials happened to allow it).
- xterm.js gates custom `CSI t` handlers behind `windowOptions`; `page.waitForFunction` given a
  RegExp's `source` loses its flags (`m`); the DOM renderer's rows are joined with no separator
  and trailing spaces are trimmed (match `\s*`, not `\s`; `grub>`).
- Parallel SMP didn't cache global TLB entries in TTBR0, which firmware and bootloaders use
  everywhere (70 s → 3 s from the boot manager to GRUB; fixed in loop 2).
