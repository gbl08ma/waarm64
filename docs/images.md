# Guest images

Test and benchmark guests, built by `images/build.sh [name…]` into `target/images/<name>/`
(downloads in `target/images/dl/`). **Build them only in rootless Podman through `images/`:**
never install cross toolchains or build dependencies on the host, never use Docker. `images/`
commits the configs, scripts and `SHA256SUMS`, never binaries. Guest images carry their own GPL
obligations (publish the configs, point to the sources), separate from webpc's MIT license.

- `images/build.sh --check <name>` exits 0 if the image is current, else says how to rebuild;
  `scripts/ci.sh` and the tests skip loudly on stale or missing images.
- Each image hashes its own inputs (its files, the pins, its build function), so changing one
  doesn't rebuild the others. Outputs are compared with `images/SHA256SUMS`; reproducibility is
  best-effort (a mismatch warns). `SOURCE_DATE_EPOCH` is 2026-09-01. A failed build leaves the
  previous image in place (`build` moves it aside first and puts it back).
- **The containers:** `images/buildroot/Containerfile` (Debian 13 pinned by the digest of its
  multi-arch index, `trixie-20260918`, apt on `snapshot.debian.org` 20260924T000000Z) runs the
  host's own architecture, arm64 on the dev VM and amd64 on an x86_64 host, and Buildroot builds
  its own toolchain in it, so `buildroot` and `ltp` build natively on either with one recipe.
  `images/Containerfile` (the same Debian, pinned by its amd64 digest) is x86_64 and builds
  only `kvm-unit-tests` (Debian's `gcc-aarch64-linux-gnu`), under qemu-user on the dev VM, where
  `unshare` fails (every image's input key hashes that file, so changing it rebuilds them all:
  [backlog.md](backlog.md) "Tests and tools"). **Prefer the
  native container on the dev VM** (the user, M7: development stays on the M4). The Alpine-based
  images (`linux`, `alpine`, `alpine-user`, `alpine-gl`, `linux-crypto`, `linux-gpu`, `linux-snd`, `linux-usb`, `linux-usbhost`, `litmus`, `fptest`) build natively in Alpine's own arm64 container
  (`USERLAND_CONTAINER`, pinned by digest), as its root, needing neither qemu-user nor unshare.
- The Mac builds nothing; it gets artifacts by `scp` if it needs them.

## The images

| Name | What | Used by |
|---|---|---|
| `buildroot` | Buildroot 2026.08 (commit `d5180309b1b6`, `BR2_REPRODUCIBLE`) BusyBox root as `rootfs.ext4` (32 MiB, fixed UUID and hash seed), with Buildroot's own toolchain (gcc 15.3, binutils 2.45.1, glibc 2.44, Linux 6.18.49 headers, no C++) built natively in `images/buildroot/Containerfile`: ~10 min on the dev VM, most of it the toolchain (cold 13 min with the toolchain's downloads). It rebuilds bit for bit on the dev VM; the committed hash is the dev VM's (an x86_64 host is expected to match: same sources and configuration, a cross gcc either way, but unchecked). Until 2026-10-23 it used Bootlin's x86_64-hosted toolchain, so the whole build ran under qemu-user on the dev VM (`ltp` took ~1.5 h) | with `linux`: the Buildroot boot and device tests; `boot*` benchmarks; I/O benchmarks |
| `linux` | **Linux 6.18.54** built natively in Alpine's arm64 container (gcc 15): `Image` from `allnoconfig` + `images/linux.fragment` (platform, both GICs, virtio devices, ext4, net, 9p, input, `FB_SIMPLE` without fbcon, `SYSVIPC`), and `Image-defconfig` (arm64 defconfig + fragment, the distro-like kernel: 5.4× the steps). ~7 min; until M7 it was built with Buildroot's toolchain under qemu-user (an hour and more) | the Buildroot guests, LTP (`Image-defconfig`), the litmus image |
| `ltp` | the `linux` root plus Buildroot's LTP (20260529) pruned to the 93 syscall tests in `images/ltp/tests`, and the arm64 kselftests `abi`, `signal`, `tags` (built with Buildroot's toolchain); boots `Image-defconfig` on 512 MiB and runs `/ltp.sh`. Built as `buildroot` (its own Buildroot tree and toolchain): ~13 min on the dev VM | `core/tests/ltp.rs`, Node |
| `linux-crypto` | allnoconfig + the fragment + `images/crypto/linux.fragment` (the arm64 CE drivers, NEON and bit-sliced AES, `CRYPTO_SELFTESTS_FULL`, lib/crypto's SHA-1/224/256 KUnit suites autorun), with a static init (`images/crypto/init.c`) that waits for the self-tests and prints each implementation's result | Node (the crypto extensions' kernel test) |
| `linux-gpu` | allnoconfig + the fragment + `images/gpu/linux.fragment` (`DRM`, `DRM_VIRTIO_GPU` with `DRM_VIRTIO_GPU_KMS`, built in; no fbdev emulation or fbcon), with a static init (`images/gpu/init.c`) that drives KMS through ioctls: connector, mode set, damage, cursor, a display event (the gpu guest, [testing.md](testing.md)). Its kernel tree stays in `target/images/build/linux-gpu` between builds (make rebuilds what the config changed) | `core/tests/gpu_guest.rs`, Node, Chromium |
| `linux-snd` | allnoconfig + the fragment + `images/snd/linux.fragment` (`SOUND`, `SND`, `SND_PCM`, `SND_VIRTIO`, built in), with a static init (`images/snd/init.c`) that plays a known waveform through ALSA's ioctls (no alsa-lib) and prints its FNV-1a (the snd guest, [testing.md](testing.md)): 48 periods (1.024 s), or `snd_seconds=N` on the command line (an environment variable to init; the page's `snd` machine, frontend.md); then it records from the capture PCM (audio S4): 16 periods, or `snd_rec_seconds=N`, printing the hash, its own time and each channel's frequency by its zero crossings. Also `snd-play` (`images/snd/play.c`, static: a WAV player on the same ioctls with aplay's buffer, for guests without alsa-utils; page-debian's) and `snd-rec` (`images/snd/rec.c`, audio S4: a recorder the same way, arecord's buffer, printing its own time, overruns and each channel's frequency, optionally writing a WAV). Built as `linux-gpu`, with the kernel's build number pinned (`KBUILD_BUILD_VERSION=1`: a rebuild in the same tree is the same kernel, and its steps don't move; linux-gpu's counts up) | `core/tests/snd_guest.rs`, Node, Chromium |
| `linux-usb` | allnoconfig + the fragment + `images/usb/linux.fragment` (`USB`, `USB_XHCI_HCD` with `USB_XHCI_PLATFORM` for our DT's `generic-xhci` node, `USB_TEST`, new devices announced; and `PCI`, `PCI_HOST_GENERIC`, `USB_XHCI_PCI`, so the same kernel runs on QEMU's `qemu-xhci`, the oracle), with a static init (`images/usb/init.c`) and the kernel's own `testusb` (`tools/usb/testusb.c`, static, at `/testusb`; GPL, built and run, not copied). The init prints the two root hubs, then with `usb_devices=N` waits for N Gadget Zeros and runs `testusb` (`usb_args=…`, commas for spaces) once, and with `usb_unplug=1` again until a gadget goes away and once more after it is back (docs/usb.md, the usb guest in [testing.md](testing.md)). Built as `linux-snd` | `core/tests/usb_guest.rs`, Node, Chromium |
| `linux-usbhost` | `linux-usb`'s kernel and `images/usbhost/linux.fragment` (`USB_ACM`, `HID_SUPPORT`, `HID`, `HIDRAW`, `HID_GENERIC`, `USB_HID`), and an init (`images/usbhost/init.c`, around `images/usb/init.c`) whose `usb_mode=` runs testusb, a `cdc_acm` echo or the `hidraw` checks, beside the kernel's `testusb` | the guest-level tests through WebUSB and WebHID on the dev VM's rigs (`tests/usb-guest.test.ts`, `scripts/ci-usb.sh`; docs/usb.md "The usbhost guest") |
| `kvm-unit-tests` | commit `5a221342a025` (2026-09-08), the arm64 `.flat`s and `unittests.cfg`, built with Debian's `gcc-aarch64-linux-gnu` | `core/tests/kvm_unit_tests.rs`, Node |
| `alpine` | **Alpine 3.24.2, from its release media only** (they stay on the mirror for good; the repositories don't: Gotchas): the pinned aarch64 minirootfs plus `openrc` (0.63.2) from the pinned `alpine-virt-3.24.2-aarch64.iso`'s package repository (`apks/`, offline), with that ISO's kernel (`linux-virt` **6.18.52**, `Image` out of its EFI zboot `vmlinuz-virt`), its `initramfs-virt` as published, and its modloop's modules in `/lib/modules` (the files `linux-virt` would install; not `mkinitfs` or `kmod`: BusyBox's `modprobe`). Built natively in Alpine's arm64 container as its root (`alpine_release` unpacks the ISO into `target/images/dl/alpine-3.24.2-iso`; ~10 s); runlevels sysinit devfs dmesg, boot modules hostname, shutdown killprocs mount-ro, default local (no device manager: the initramfs loads virtio_mmio, virtio_blk, ext4). The test is `images/alpine/webpc.start` (a local.d script writing to `/dev/console`, then `poweroff`) | the Alpine boot tests and `boot_alpine*` |
| `alpine-user` | alpine's root plus `xz`, `lua5.4`, `sqlite`, `openssl` (3.5.8, from the ISO's repository) and the workloads (`images/alpine/user/`), with its own local.d script, as `rootfs-user.ext4`; boots alpine's Image and initramfs | `alpine_user_jit`, `alpine_crypto*_jit`, Node |
| `alpine-gl` | alpine's root plus Mesa 26.1.6 (EGL, GLES, llvmpipe) and `glcomp` (`images/alpine/gl/`: a compositor's GLES load without a display, compiled in the container), with its own local.d script, as `rootfs-gl.ext4`; boots alpine's Image and initramfs. Not built by default users' paths (`images/build.sh alpine-gl`) | `gl_llvmpipe_jit*` |
| `alpine-virgl` | alpine-gl's root plus **Mesa 26.1.6 built from source with llvmpipe and virgl** in `/opt/mesa` (Alpine's Mesa has no virgl on any architecture: its APKBUILD leaves it out), so both renderers run one build; the local.d script loads `virtio-gpu` with `webpc.gpu=1` and runs glcomp on `/opt/mesa`; `rootfs-virgl.ext4`. Not built by default users' paths (`images/build.sh alpine-virgl`, after alpine-gl; ~6 min) | `gl_virgl_jit*`, `gl_virgl_llvmpipe_jit*` |
| `litmus` | herdtools7 7.58 (CeCILL-B: built and run, never copied) in Alpine's arm64 container: `diyone7` makes each test in `images/litmus/tests.txt` (MP, SB, LB, 2+2W, IRIW, WRC, R, S and coherence shapes, plain and with DMB/DSB, dependencies, acquire/release), `herd7`'s `aarch64.cat` lists each one's allowed final states (`allowed.txt`), `litmus7` makes static C programs (`-mem direct -st 1 -barrier userfence -affinity incr0 -s 5k -r 200`, from herdtools7's Arm configs; the defaults showed the M4 no relaxed outcome at all); `images/litmus/stress.c`, the atomics stress, as `stress-lse` and `stress-llsc` (the build checks each has its atomics: [testing.md](testing.md) "Atomics stress"). Output: `initramfs.cpio` (BusyBox, `images/litmus/init`, the tests; booted with `linux/Image`, `webpc.litmus=<options, commas for spaces>`, `webpc.stress=<options>`) and `litmus.tar` (the same tests with `run.sh`, for the oracle VM) | the memory-model tests and the atomics stress (M7) |
| `fptest` | the FP suite ([testing.md](testing.md) "The FP suite"): Berkeley SoftFloat 3e (`a0c6494cdc11`, its ARM-VFPv2 build) and TestFloat 3e's `testfloat_gen` (`a9c849f1b0eb`, the commits `scripts/testfloat.sh` pins) and `images/fptest/fptest.c` with its form tables (`forms.py`), static, built natively in Alpine's arm64 container; `initramfs.cpio` (BusyBox, `images/fptest/init`, the programs; booted with `linux/Image`, `webpc.fptest=<options, commas for spaces>`) and `fptest.tar` (the programs and `run.sh`, for the oracle VM) | `scripts/ci-fp.sh` (`tests/fptest.test.ts`) |
| `debian` | the official `debian-13-nocloud-arm64` qcow2 (20260914-2601), pinned by build date and SHA512 (`images/debian.json`) and served as published; the kernel (6.12.107) as `target/images/debian/disk.qcow2` (a link to the download: nothing is taken out of it), the same code `npm start` runs | the page's Debian tests |
| `edk2` | **EDK2 edk2-stable202608** (commit `2970e5699ba6`, submodules as pinned by it): `ArmVirtPkg/ArmVirtQemuKernel.dsc`, RELEASE, GCC, `NETWORK_ENABLE=FALSE`, as `QEMU_EFI.fd` (3 MiB: an arm64 `Image` entered like a kernel with the DT in x0) and `LICENSES.txt` (EDK2's BSD-2-Clause-Patent, OpenSSL's Apache-2.0, libfdt's BSD-2-Clause: the binary is distributed). Built natively in Debian's arm64 container (pinned digest, apt from snapshot.debian.org), ~1 min. **Reproducible:** BaseTools draws a random stack cookie per module into `StackCookieValues{32,64}.json` and picks by `hash(GUID)`; the build writes both lists from a fixed seed and sets `PYTHONHASHSEED=0` (the cookies are public in the binary either way). Also `shell.img`, the firmware tests' disk: 8 MiB of FAT (no partition table; a fixed volume ID, every timestamp `SOURCE_DATE_EPOCH`) with the build's UEFI Shell as `\EFI\BOOT\BOOTAA64.EFI` and `images/edk2/startup.nsh` | `tools/uefi-oracle.ts`; the firmware configuration's tests ([testing.md](testing.md)); M8 phase B's firmware boots ([firmware.md](firmware.md)) |
| `alpine-uefi` | Alpine's published UEFI cloud images, pinned by SHA512 (`images/alpine-uefi.json`) and served as published: `alpine.qcow2` (3.24.2 tiny, Limine) and `alpine-grub.qcow2` (3.24.1 generic UEFI tiny, GRUB), downloaded **on the host** (Node, `tools/debian.ts`'s downloader), hard links into the download cache | `tests/uefi.test.ts` (`WEBPC_DISTROS=alpine-uefi`) |

Command lines: Buildroot `console=ttyAMA0 earlycon panic=-1 root=/dev/vda ro init=/init` (a
script after `--`: `/test.sh` by default, `/test-devices.sh`, `/test-input.sh`, `/test-rw.sh`,
`/ltp.sh`, `/bench-*.sh`); Alpine `console=ttyAMA0 root=/dev/vda rootfstype=ext4 modules=ext4 ro`
(`webpc.phase=user|crypto` for alpine-user). Alpine gets 1 GiB.

**Debian for interaction** (the page boots the image through UEFI with GRUB's own command line,
frontend.md "Debian through UEFI"; the direct boot with an extracted kernel and initrd, its
`systemd.run=` test line and its benchmarks were dropped when UEFI became the production path:
git history has them, e.g. `bench/boot/REPORT.md` "M8 loop 0"):
**The published image locks root** (`root:!unprovisioned` in `/etc/shadow`; the nocloud image has
no provisioning of its own): `login.noauth` is a credential util-linux's `login` reads (both getty
units import `login.*`), so `root` logs in with no password on every console without touching the
image. The kernel has `simplefb` and `fbcon` built in: fbcon draws on the framebuffer from the
first kernel line.

## dEQP for the Arch image (`images/deqp/build.sh`)

**On demand only**, like the Arch image below: G4's conformance subset (graphics.md §21). VK-GL-CTS
`opengl-es-cts-3.2.14.1` (Apache-2.0: built and run, nothing copied), `deqp-gles2` and `deqp-gles3` with EGL's
surfaceless target, built natively for Arch Linux in rootless Podman from `localhost/arch-base` (`images/arch/base.sh`;
`images/deqp/Containerfile`, ~10 min). Results: `target/deqp/deqp.ext4` (113
MiB: the binaries, their data and the GLES2/GLES3 mustpass lists under `/deqp`), the page's second disk for
`bench/gpu/deqp-run.ts`; and the image `localhost/webpc-deqp`, which runs the same binaries on Mesa's virpipe against
the vtest oracle (`tools/virgl-oracle/deqp.sh`). It then makes the guest that runs them, `target/deqp/guest.qcow2`
(`images/arch/build.sh --packages "mesa libpng"`, ~4 min; `--guest-only` makes it alone), `scripts/ci-deqp.sh`'s. A case's capture (`CAPTURE=`) replays on Chromium with
`bench/gpu/virgl-pairs.ts`, which diffs each read-back with the next (dEQP's result and its reference). The surfaceless target takes EGL's default display:
`EGL_PLATFORM=surfaceless` picks it.

## Arch Linux for UEFI (`images/arch/`)

**On demand only**: not in `images/build.sh` or `SHA256SUMS` (its `--packages` form makes dEQP's guest,
`scripts/ci-deqp.sh`'s; `desktop.sh` the desktop guest). The distribution is **arch.bens.haus's aarch64 port**
(<https://arch.bens.haus/>, listed on <https://ports.archlinux.page/aarch64/>): Arch's own PKGBUILDs built for ARMv8.0-A
and later (our CPU's baseline), mirrored `[core]` and `[extra]`, with Arch's own kernel configuration (`linux`, not a
board kernel). Until 2026-10-16 it was Arch Linux ARM (archlinuxarm.org); we moved because ALARM's generic
`linux-aarch64` is built for boards and debugging (`DEBUG_PREEMPT` on, no `SND_VIRTIO`: [backlog.md](backlog.md) "A
guest kernel"), while the port's `linux` 7.2.9.arch1 has `DEBUG_PREEMPT` off and `virtio_snd` as a module.

- **The base container** (`images/arch/base.sh [--rebuild]`, ~3 min once; the others call it): the port's latest
  bootstrap tarball (named on its home page with its SHA256, which is checked; cached in `target/arch`) imported into
  rootless Podman as `localhost/arch-base`, with the mirror, pacman's keyring (Arch's keys and the port's own,
  `images/arch/bens.haus.asc`, fingerprint `C43E3B9B9CE3F35E97AEF93873556FFF735F691D` pinned and locally signed; it signs
  every `arch=aarch64` package, `arch=any` ones keep Arch's signatures), pacman's download sandbox off (it fails in a
  rootless container; the images get it back), and **every package reinstalled** from the mirror: the tarball keeps
  file capabilities as libarchive xattrs, which GNU tar and Podman's import drop (`newuidmap` lost its caps).
- **The image** (`images/arch/build.sh [--out f.qcow2] [--root-mib 8192] [--esp-mib 512] [--packages "p1 p2"]
  [--files dir] [--setup script]`, ~2 min; `target/arch/arch-uefi.qcow2`, 687 MiB, 8.5 GiB virtual): in a container
  of the base, `pacman -Syu` with `base linux e2fsprogs dosfstools sudo` and `--packages` (the mirror's packages of the
  day), the settings below, `--files` (a tree copied onto the root; a user's home made theirs) and `--setup` (a script
  run as root). The initramfs has no `autodetect` and lists `virtio_mmio virtio_blk ext4 vfat`
  (`/etc/mkinitcpio.conf.d/webpc.conf`, so the guest's own kernel updates build the same). The rootfs goes into an
  ext4 image with `mke2fs -d` (ownership and xattrs kept); the host lays out the GPT, the ESP (mtools) and a compressed
  qcow2 (the root's free space costs nothing in it). No root, no loop devices; host tools `podman`, `curl`, `sgdisk`,
  `mkfs.vfat` + mtools, `qemu-img`. Works under `target/arch/work` (not `/tmp`: the dev VM's is a small tmpfs).
- GPT: a FAT32 ESP mounted at `/boot` with systemd-boot as `\EFI\BOOT\BOOTAA64.EFI` and what Arch's `linux` puts in
  `/boot`: `vmlinuz-linux` (an EFI zboot kernel: it decompresses itself; systemd-boot starts it with the initrd via
  LoadFile2) and `initramfs-linux.img`, so **`pacman -Syu` in the guest updates the kernel that boots**; then the ext4
  root (type GUID Linux root aarch64). Fixed PARTUUIDs; command line `root=PARTUUID=… rw console=tty0 console=ttyAMA0`.
- Settings: logins `root`/`root` and `arch`/`arch` (in `wheel`, which sudo allows); hostname `archlinux`;
  `LANG=C.UTF-8`; UTC; systemd-networkd (DHCP on `en*` and `eth*`, with `UseDomains=yes` and `UseMTU=yes`: MagicDNS's search domain, the tunnel's MTU), -resolved (the stub as `/etc/resolv.conf`) and
  -timesyncd; `/etc/machine-id` empty, as ALARM's was (a transient id each boot, no first-boot presets).
- Checked on QEMU through our EDK2: `node tools/uefi-oracle.ts $PWD/target/arch/arch-uefi.qcow2` (absolute path)
  reaches `login:` in ~23 s with no failed unit (the tool reports FAIL, since it expects a passwordless root).
- **Networking in webpc** needed the gateway's /32 lease mask: with the earlier 0.0.0.0 mask Arch's systemd-networkd
  logged `DHCP error: no netmask` and never configured IPv4 (found on ALARM, 2026-10-01); see [devices.md](devices.md) "net".
- **The `webpc-va` package** (`images/arch/webpc-va/`, built and checked by `images/arch/webpc-va.sh` in a container of
  the base as a user would: `makepkg`, `pacman -U`; ~1 min): webpc's VA-API driver, Mesa's virgl with NV12 decode
  surfaces only and AV1 film grain decoded into the shown surface, `LIBVA_DRIVER_NAME=webpc` for every session
  ([plans/video.md](plans/video.md)). `options=('!debug')`: Arch's `makepkg.conf` makes debug packages by default.
  Result `target/arch/pkg/webpc-va-<ver>-aarch64.pkg.tar.zst`; not published anywhere.
- **The desktop guest** (`images/arch/desktop.sh [--out f.qcow2]`, on demand, ~8 min; audio S3): sway, foot, Firefox, Chromium (since 2026-10-22, graphics.md §24),
  htop, nano, lsof, PipeWire (WirePlumber, `pipewire-pulse`, `pipewire-alsa`), alsa-utils, mpv, libva-utils (`vainfo`),
  gtk4-demos (`gtk4-demo`, for `bench/gpu/gtk4-load.ts`), mesa-utils (`eglinfo`, `glxgears`) and `webpc-va`; sound is the kernel's own `virtio_snd` (udev loads it); Firefox's policies allow autoplay with sound and
  skip the first-run pages. A **20 GiB root**, mostly free, for packages installed by hand. `images/arch/media.sh`
  makes `/home/arch/media` in Podman (Alpine's ffmpeg): `avsync.webm` (a white frame and a 1 kHz beep each second,
  VP8/Opus, 60 s), `sintel.webm` and `sintel-silent.webm` (the Sintel trailer, Blender Foundation, CC BY 3.0,
  downloaded from download.blender.org with its sha256, as VP9/Opus 480p), and `avsync.html` (plays `?v=<clip>`);
  `desktop-setup.sh` is the `--setup`. Result `target/arch/desktop.qcow2`; `bench/audio/avsync.ts` measures on it, and
  the page's session scripts (`bench/gpu/guest-session.ts`) log in as `arch` (`WEBPC_GUEST_USER=alarm` for an older
  Arch Linux ARM disk).

## Debian with Chromium (`images/debian-chromium/build.sh`)

**On demand only** (not `images/build.sh`, `SHA256SUMS` or CI): the disk of the complex-app benchmark
(`bench/apps/`, [benchmarking.md](benchmarking.md)). It boots the pinned Debian (`node tools/debian.ts` first)
in QEMU through our EDK2 (`tools/uefi-oracle.ts`, TCG, 4 vCPUs, 4 GiB, user-mode networking), points apt at
snapshot.debian.org at `images/Containerfile`'s date, installs `chromium` (153.0.8010.52, no recommends) and
`fonts-dejavu-core`, and writes the overlay flattened and compressed: `target/images/debian-chromium/disk.qcow2`,
732 MiB (3 GiB virtual, 1.1 GB free in the guest), in ~2 min. The page boots it with `?disk=`.

## Stress workloads in the Debian guest (`images/stress/`)

**Not usable at the moment:** these tools replace Debian's initrd (`target/images/debian/initrd.img`)
through a page route, which needs the direct boot of an extracted kernel and initrd; the page
boots Debian through UEFI since M8 phase B loop 3 (the route has no effect) and the extraction
was dropped with the direct-boot tests. To revive them, put the binaries on a second disk
(as the Go compiler's below) instead of in the initrd.

A load with the character of a Go compile on 4 vCPUs: many threads, spinning
Ms (`procyield`, `osyield`), heavy mmap/mprotect/munmap (so many TLBI IS), the GC and scavenger,
futexes, fork/exec. Not part of `images/build.sh` or CI; built on demand.

- `images/stress/build.sh [debian-dir]` (~1 min): in Go's arm64 container (`golang:1.26.8-trixie`,
  pinned by digest, rootless Podman, native) builds `gostress` (static Go, `images/stress/gostress.go`)
  and `cstress` (static glibc C, `cstress.c`) into `target/images/stress/`, then
  `mkinitrd.ts` writes `target/images/stress/initrd.img`: Debian's initrd plus one more cpio
  segment (the kernel unpacks concatenated segments), with the binaries and an init-bottom hook.
  The hook exists because the initramfs has klibc's `mount` (no remount), no `cp`, `chmod` or
  `find`, and `/run` is `noexec`: it mounts a tmpfs on `/run/stress` and `cpio -i`s the binaries in
  (`/run` is what survives `switch_root`). `debian-dir` defaults to `target/images/debian`.
- **Guest command:** `/run/stress/gostress <seconds> [procs]` or `/run/stress/cstress <seconds>
  [threads]` (defaults 60 s, 4). One heartbeat line per second (`gostress: t=N allocs=... mmaps=...
  mprotects=... execs=... chan=... spins=... gc=... threads=...`; `cstress: t=N ...`), then
  `gostress: done` / `cstress: done`, exit 0. Natively gostress does ~60 k mmap/munmap cycles and ~3 k execs per second on 8 cores.
- **How the guest gets it:** no core or page change. Serve the variant initrd in place of
  `target/images/debian/initrd.img`: Playwright `page.route('**/target/images/debian/initrd.img', r =>
  r.fulfill({ path }))` on the page (`?machine=debian`), or `initrd:` in `runToPowerOff` in Node. The
  other mechanisms were weighed: the 9p device takes only string contents, isn't in the page's
  machines and is in-memory (a binary would need `P9Files` to take bytes plus a page device);
  the disk overlay is OPFS blocks under a qcow2 (no host-side writer of ext4); typing the file
  over the serial terminal takes minutes; the network needs a tailnet peer.
- `node images/stress/run-page.ts [seconds] [gostress|cstress] [ncpus]` boots the page in headless
  Chromium with that route, logs in on the serial terminal, runs the command and reports the
  heartbeats seen, the longest gap between them (wall ms; a stalled vCPU shows as a gap), the page's
  state and dmesg's lockup/stall/WARNING lines. `gostress 60` on 4 vCPUs: login at ~38 s, 60 heartbeats,
  longest gap 1.2 s, no dmesg warnings; `cstress 30`: longest gap 1.0 s, none (Chromium 153, the dev VM).
- **The real Go compiler** (`images/stress/build-goroot.sh`, ~1 min): `target/images/stress/goroot.ext4`,
  160 MiB (106 MiB used), a trimmed GOROOT (`go`, `compile`, `link`, `asm`, std sources without
  tests; `go.env` has `CGO_ENABLED=0`, since the guest has no gcc) and `/work/{hello,web}` (the latter
  imports `net/http`, `crypto/tls`, `encoding/json`: ~100 packages). The build proves the trimmed tree
  builds `web` cold before packing. Natively a cold `hello` is 3 s wall and 6 s CPU, so in the
  guest it is a real multi-thread compile load. It doesn't fit the initrd (`/run` is 10% of RAM) and
  needs a **second virtio-blk** (`{ type: 'blk', url }` beside the root in `web/app/worker.ts`; not in
  any machine yet, untested in the guest): `mount -o ro /dev/vdb /mnt; GOROOT=/mnt/go GOCACHE=/tmp/gc
  GOFLAGS=-mod=mod /mnt/go/bin/go build -o /tmp/web /mnt/work/web` (module cache and the work dir
  must be writable: copy `/mnt/work` to `/tmp`). Debian's `golang-go` package would need the network and
  ~250 MB installed, the overlay's writes included.
  **Under the stress test** (`node bench/stress/stress.ts --initrd target/images/stress/initrd.img --disk2
  target/images/stress/goroot.ext4 --guest-cmd ...`, docs/testing.md; `?disk2=` in docs/frontend.md): a cold
  `go build` of `/work/web` alone takes **349 s** on 4 vCPUs in Chromium (the dev VM), and no build
  (not even `hello`) finished in 300 s beside the stress test's own 10 background loads plus
  `gostress`. Size a Go loop for that: a long run's builds take 10 minutes or more each. The
  `gostress` load and `?disk2=` mount (`/dev/vdb`, ext4, read-only) work under `stress.ts`. The
  harness logs `GOBUILD rc=<n> <s>s` lines a guest loop echoes as `gobuild` events.

## Gotchas

- **Alpine keeps only the latest build of each package** (there is no snapshot archive), so pins on
  its repositories fail loudly once superseded; bump them deliberately (the image's bytes, and so a
  step count, change). A release's media (minirootfs, ISOs, netboot) stay on the mirror for good,
  so `alpine` comes only from them and the other Alpine images take what they can (`openssl`,
  `e2fsprogs`) from the virt ISO's repository first (`-X target/images/dl/alpine-3.24.2-iso/apks`).
  What remains on the live repositories: alpine-user's `xz`, `lua5.4`, `sqlite`, and the build
  tools of `linux*`, `litmus`, `alpine-gl`, `alpine-virgl`. The ISO's repository is what an
  installer needs (95 packages: no `mkinitfs`, `kmod`, compilers). The `linux-virt` 6.18.53 image
  (from the repository, with `mkinitfs`'s initramfs) was lost in October 2026 when 6.18.56 had
  replaced it; the release's 6.18.52 took its place (steps 2,856,663,287 → 2,821,209,020).
- Alpine's image reproducibility needs: apk's timestamped log dropped, mtimes clamped, mke2fs with
  `E2FSPROGS_FAKE_TIME` and `no_copy_xattrs` (the host's SELinux labels would reach the image),
  owners kept by extracting as the container's root. The ISO's files unpack read-only: made
  writable, or only `podman unshare rm` removes them.
- **The kernel is built by `build.sh`, not by Buildroot** (Buildroot's kernel package has no
  allnoconfig base): `make allnoconfig KCONFIG_ALLCONFIG=linux.fragment`, and the build fails if
  any fragment line didn't take effect. The tarball is pinned by sha256. Check Kconfig names
  against the pinned kernel when adding options (self-tests and lib/crypto's KUnit suites were
  reorganized recently).
- Debian's published image is 95% compressed qcow2 clusters: it's served as is (deflate in the
  blk backend) rather than converted.
- Debian isn't built but prepared, so its `.inputs` key covers `images/debian.json` and
  `build_debian`; `SHA256SUMS` lists the disk.
  `tools/debian.ts` keeps its own stamp (`target/images/debian/.prepared`: the pin), from when `npm start` ran it
  (until 2026-10-17), which can't run `build.sh` (bash 4 syntax; macOS has bash 3.2).
