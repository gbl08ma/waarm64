# The firmware: booting unmodified images through UEFI

The page's machines boot a disk's own loader (shim and GRUB, Limine) through our EDK2 build, so
images run as published. Where the rest lives: the boot itself and the firmware configuration's
devices (flash bank, fw_cfg, SMBIOS, PL031) in [platform.md](platform.md) ("Boot", "The firmware
configuration's devices"), its ABI in [abi.md](abi.md) ("M8 phase B"), the build in
[images.md](images.md) (`edk2`), the page's side in [frontend.md](frontend.md) ("Debian through
UEFI", "Your own disk", "The serial terminal"), the tests and the UEFI oracle in
[testing.md](testing.md), the numbers in `bench/boot/REPORT.md` ("M8 phase B loop 3", "M8: the
firmware on the screen"). Loose ends: [backlog.md](backlog.md) "Platform and devices".

## Which EDK2, and what it needs of the machine

**ArmVirtQemuKernel** (`ArmVirtPkg/ArmVirtQemuKernel.dsc`, RELEASE, `NETWORK_ENABLE=FALSE`: no PXE
or HTTP boot, and the network stack linked TLS). It is EDK2 linked as an arm64 `Image`, entered like
a kernel with the DT in x0: no PEI, no execution from flash, no reset vector at 0, so it goes through
our direct boot unchanged. Found on QEMU 11.1.1 (TCG, `virt`, GICv3) before anything was built:
- **Stock ArmVirtQemu requires fw_cfg:** without a `qemu,fw-cfg-mmio` node its PEI phase calls
  `QemuFwCfgIsAvailable` through a missing HOB (an ASSERT in DEBUG, a read through NULL, i.e. flash
  at PA 0, in RELEASE; `OvmfPkg/Library/QemuFwCfgLib/QemuFwCfgMmioPei.c`). ArmVirtQemuKernel's DXE
  fw_cfg library tolerates its absence and uses it when present.
- **It needs a variable store:** with no `cfi-flash` node it takes a synchronous exception early in
  DXE. It takes a `cfi-flash` bank that doesn't hold the firmware (QEMU's bank 1, `0x0400_0000`): three
  256 KiB areas (variables, FTW working, spare). An erased (all-ones) bank works: EDK2 formats it.
  The boot manager writes it on the first boot; EDK2 sets the node `disabled` in the DT it hands
  over, so Linux binds no flash driver to it.
- **The DTB may stay in RAM's top 2 MiB:** the entry (`ArmVirtPkg/PrePi/ModuleEntryPoint.S`
  `DiscoverDramFromDt`) copies the DT into the 32 KiB after its own image header before it
  allocates anything. The firmware goes at RAM + 512 KiB, its header's `text_offset`.
- **ArmVirtPkg ignores `/reserved-memory`** (only RISC-V virt parses it) and allocates down from
  `/memory`'s top, where our framebuffer sat; hence `/memory` ends at the framebuffer.
- **The PL031 must exist** whenever the firmware runs (EDK2's RTC, and Linux's `rtc-efi`), and EDK2
  reads its PrimeCell IDs with byte loads (QEMU allows them; ours aborted at first).
- **Firmware and bootloaders map global entries in TTBR0:** parallel SMP didn't cache them, and Debian
  took 70 s from the boot manager to GRUB's menu in Node; with them cached, 3 s (platform.md
  "Broadcast maintenance").
- Without a disk EDK2 stops at "BdsDxe: No bootable option or device was found". The UEFI Shell is an
  *application* boot option, which BDS's automatic boot skips, so the firmware tests' `shell.img` has
  it as the removable-media loader (`\EFI\BOOT\BOOTAA64.EFI`).
- On the oracle, firmware start to the boot manager starting the disk: 3.3 s (ArmVirtQemuKernel
  RELEASE), 5.3 s (ArmVirtQemu RELEASE from flash), 5.6 s (openSUSE's DEBUG package).

## Our patches (`images/edk2/`, `images/build.sh edk2`)

- **The serial console offers 80×25 only** (a `sed` on TerminalDxe's mode table, which the build
  checks). EDK2 offers text modes up to 240×56; GRUB takes the largest and sends xterm's resize
  (`CSI 8;56;240 t`), which xterm.js ignores, so on the page's 80-column terminal only GRUB's
  countdown line showed. Teaching xterm.js the sequence (a CSI handler, gated behind
  `windowOptions.setWinSizeChars`) and scaling the font worked but was the wrong fix; configuring
  the firmware was the right one (the user's). When it can go: backlog "EDK2's terminal modes".
- **`virtio-gpu-console.patch`** (`OvmfPkg/Library/PlatformBootManagerLibLight`): the boot manager
  connects display devices before the console exists and puts their GOPs in ConOut, but looked
  only for PCI ones. Ours is on virtio-mmio, so `VirtioGpuDxe` was bound only by the later
  connect-all: GRUB found its GOP, but it was never a console and the logo never showed. The patch
  connects virtio-mmio GPU devices beside PCI displays. A machine without a virtio-gpu
  (`?display=simple`, the simple-framebuffer machines) has no GOP and its firmware is unchanged.
- **`boot-logo-progress.patch`** (`MdeModulePkg/Library/BootLogoLib`): the boot timeout's progress
  bar drew one `Blt` per block, redrawn from the first block each second (the boot manager's
  callback passes 0 as the previous value): 199 `Blt`s in 3 s, each a transfer and a flush the
  driver waits for, and the page answers one flush a frame, so the bar cost 3.4 s. The patch reads
  the bar's area back (the GOP keeps a copy), paints the new blocks and writes it in one `Blt`.
- **`virtio-gpu-deferred-flush.patch`** (`OvmfPkg/VirtioGpuDxe`): the form browser draws a
  character or a run per `Blt`, so under the page's pacing a setup screen took 130–180 flushes and
  ~2.4 s, an arrow key ~0.7 s. Now a `Blt` transfers at once (transfers aren't paced) and leaves
  the flush to a 16 ms `TPL_NOTIFY` timer, for the union of what was written meanwhile, as Linux's
  damage worker does: the setup screen takes 0.18 s, an arrow key one flush 10–20 ms after its last
  transfer, as unpaced. `Blt` and `SetMode` raise to the timer's TPL around their requests (the
  virtqueue is one, unlocked), a mode set flushes what waits first, and after ExitBootServices (the
  device reset) the timer sends nothing.
- **`usb-xhci.patch`** and **`Waarm64XhciDxe`** (ours, MIT, in `images/edk2/`): EDK2 finds xHCI controllers on
  PCI, and ours is a DT node (`generic-xhci`). The driver reads the DT through ArmVirtPkg's FdtClient and
  registers each such node with `RegisterNonDiscoverableMmioDevice` (an xHCI, coherent DMA); the patch adds it and
  `NonDiscoverablePciDeviceDxe` to ArmVirtQemuKernel's build, so EDK2's own XhciDxe, UsbBusDxe and UsbKbDxe drive
  the machine's controller. A machine with the controller gets the page's built-in USB keyboard in the firmware
  (docs/usb.md "The keyboard"). The drivers dispatch on every machine, so the firmware's own boots take ~0.3% more
  steps (`edk2-shell`, `edk2-shell-again`).

What the screen shows: the TianoCore logo, the progress bar, BdsDxe's lines and anything else on the
console (boot manager, setup screens, the Shell), then GRUB (`gfxterm`) and "Loading Linux…". Keys
come from the built-in USB keyboard on a machine with the USB controller (docs/usb.md "The keyboard"), and
otherwise only from the serial terminal (EDK2 has no virtio-input driver). **The kernel's first seconds
stay dark** (backlog "The screen is dark from the EFI stub"): the GOP has no linear framebuffer, so
Linux has no `efifb`. **ramfb is not the fix:** it would give `efifb`/`simpledrm` a framebuffer, but
`virtio_gpu` removes a conflicting firmware framebuffer only on PCI (`virtgpu_drv.c`,
`virtio_gpu_pci_quirk`), so on virtio-mmio it would stay as card0/fb0 for the whole session, where
desktops would pick it. That is also why fw_cfg has no DMA interface.

## Linux under the firmware

- `efi: EFI v2.7 by EDK II`, `/memory` as we set it, simplefb (Debian) or simpledrm (Alpine) on a
  simple framebuffer, `virtio_gpu` on a virtio-gpu machine, both vCPUs through PSCI, a clean
  power-off (`ResetSystem` becomes PSCI SYSTEM_OFF).
- **The RTC is `rtc-efi`:** Linux asks EFI's `GetTime`, which EDK2 answers from the PL031. Other
  runtime services Linux uses: `GetVariable`/`SetVariable` (efivarfs: 28–33 variables on Alpine;
  `grub-install` on a Debian kernel update writes boot entries) and `ResetSystem`.
- **The variable store is the flash bank,** kept per disk beside its overlay (frontend.md), rewritten in place (a
  write that fails or falls short puts the old bytes back, so a full storage leaves the last one whole: `writeWhole`); GRUB's
  "UEFI Firmware Settings" sets OsIndications there and resets into EDK2's setup. After "Continue"
  EDK2 shows its boot device menu (ArmVirt's BDS) rather than booting on.
- **The firmware's own boot cost** on the page's Debian (bench/boot/REPORT.md "M8 phase B loop 3"):
  ~9 s from EDK2 to the kernel, GRUB's 5 s menu, and a few seconds of userspace the old direct
  boot's command line skipped. Between the boot manager and GRUB's menu Debian retires 5.4G steps
  in ~3 s: not a busy wait but an LZMA range decoder, most likely GRUB unpacking its core image.

## DT or ACPI (decided 2026-09-30: the DT)

The case against device trees comes from embedded boards, where a DT is written per board, ships
with the kernel and drifts from the hardware. Here the core generates it from the VM's
configuration, as QEMU `virt` does, describing only standard parts (GICv3, generic timer, PL011,
PL031, PSCI, virtio-mmio, the framebuffer), and EDK2 passes it on unchanged (with fw_cfg present and
no ACPI tables in it). Measured on the oracle: Debian's and both Alpine images' kernels behave the
same under QEMU's ACPI tables as under the DT (SMP, power-off, the root disk, boot time; a first
1.8× gap was QEMU's `kaslr-seed` enabling KASLR in the DT boots only: testing.md "The UEFI
oracle"). The DT gives `tty0` and `ttyAMA0` (fbcon and `stdout-path`); ACPI's SPCR gives `ttyAMA0`.

- **ACPI** would mean two descriptions (Linux on arm64 uses ACPI only through UEFI, so the tests'
  direct boots keep the DT), MADT, GTDT, SPCR, FADT (hardware-reduced, PSCI) and a DSDT in AML with a
  device per virtio-mmio transport. EDK2's DynamicTablesPkg builds tables from a DT (the kvmtool
  platform), but its parser covers the GIC, timer, serial port and PCI, not virtio-mmio; and ACPI
  can't describe a `simple-framebuffer`, so the screen would need a GOP with a framebuffer.
- **virtio-pci behind an ECAM host bridge** lets devices enumerate themselves (and hot-plug), but
  costs a PCI host bridge and config space in the core and still needs a DT or ACPI.
- Only an ACPI-only guest needs it (Windows, which needs much more: PCIe, SBSA; an enterprise distro
  that won't boot from a DT). None is in scope; the path then is backlog "ACPI".

## The guests

- **Debian 13 nocloud:** `\EFI\BOOT\BOOTAA64.EFI` is shim, which loads GRUB 2.12 (no `fbaa64.efi`, so
  no fallback run and no NV boot entries written); GRUB waits 5 s and passes `root=PARTUUID=… ro
  quiet`, nothing else. The published image has `root:!unprovisioned` and no
  `systemd.firstboot=off`, so **its first boot runs systemd-firstboot** (timezone, then root's
  password) on `/dev/console`, the serial port (DT, no `console=`). The page leaves it so, as on a
  regular machine (the user's choice); the tests boot it unattended with **systemd credentials over
  fw_cfg** (`opt/io.systemd.credentials/*`, `tests/debian-unattended.ts`: `login.noauth`,
  `firstboot.timezone`, `firstboot.locale`, an empty `passwd.hashed-password.root`), imported by
  systemd through Linux's `qemu_fw_cfg`. The network card's settings take the same route on every
  machine (a `.network` credential: frontend.md "Debian through UEFI").
- **Alpine's UEFI cloud images** (`images/alpine-uefi.json`: 3.24.2 tiny with **Limine**, its kernel,
  initramfs and every arm64 DTB on the ESP, `timeout: 10`; 3.24.1 generic with GRUB 2.14) lock root
  and create users from cloud metadata (tiny-cloud, which doesn't read fw_cfg). A **NoCloud seed**
  unlocks them: a small FAT disk labelled `CIDATA` with `meta-data` and a `#!/bin/sh` `user-data`
  (`passwd -d root`) as a second virtio-blk, written by `web/fat.ts` (`tests/uefi.test.ts`).
  `tiny` is tiny-cloud, `cloudinit` cloud-init; `-metal` variants carry the non-virt kernel.

## Gotchas

- `localhost/waarm64-images` (images/Containerfile) is amd64 under qemu-user on the dev VM: never build
  EDK2 in it. `edksetup.sh` fails under `set -u` and eats the positional parameters (`set --` first);
  an apostrophe inside `images/build.sh`'s single-quoted container scripts ends the script.
- QEMU: `-fw_cfg name=…,string=` rejects an empty value (use `file=`); with `-dtb` QEMU still rewrites
  `/memory` and `/chosen` (so a DT placement test needs our machine, not QEMU's).
- A RELEASE build prints only "Synchronous Exception at …"; the native runner's summary has ESR,
  ELR and FAR.
- Limine draws its menu a character at a time between cursor escapes (match on stripped text);
  Debian's GRUB passes `quiet`, so the kernel's command-line echo isn't on the console.
- A test that passes credentials must read one back: with fw_cfg's directory planted off by one,
  Debian still logged in (the shifted credentials happened to allow it).
- xterm.js gates custom `CSI t` handlers behind `windowOptions`; `page.waitForFunction` given a
  RegExp's `source` loses its flags (`m`); the DOM renderer's rows are joined with no separator and
  trailing spaces trimmed (match `\s*`, not `\s`: `grub>`).
- The dev VM's `/tmp` is a 6.9 GB tmpfs: don't extract whole partitions there.
