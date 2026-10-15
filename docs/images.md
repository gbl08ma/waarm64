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
- **Two containers:** `images/Containerfile` (Debian 13, pinned by digest, apt on
  `snapshot.debian.org` 20260924T000000Z) is x86_64, because Buildroot uses Bootlin's x86_64-hosted
  toolchains; on the arm64 dev VM it runs under qemu-user, where `unshare` fails. **Prefer the
  native container on the dev VM** (the user, M7: development stays on the M4). The Alpine-based
  images (`linux`, `alpine`, `alpine-user`, `alpine-gl`, `linux-crypto`, `linux-gpu`, `linux-snd`, `litmus`) build natively in Alpine's own arm64 container
  (`USERLAND_CONTAINER`, pinned by digest), as its root, needing neither qemu-user nor unshare.
- The Mac builds nothing; it gets artifacts by `scp` if it needs them.

## The images

| Name | What | Used by |
|---|---|---|
| `buildroot` | Buildroot 2026.08 (commit `d5180309b1b6`, Bootlin aarch64 glibc stable 2025.08-1, `BR2_REPRODUCIBLE`) BusyBox root as `rootfs.ext4` (32 MiB, fixed UUID and hash seed), in the x86_64 images container (qemu-user on the dev VM: slow; its bytes differ between hosts, so the committed hash is the x86_64 desktop's) | with `linux`: the Buildroot boot and device tests; `boot*` benchmarks; I/O benchmarks |
| `linux` | **Linux 6.18.54** built natively in Alpine's arm64 container (gcc 15): `Image` from `allnoconfig` + `images/linux.fragment` (platform, both GICs, virtio devices, ext4, net, 9p, input, `FB_SIMPLE` without fbcon, `SYSVIPC`), and `Image-defconfig` (arm64 defconfig + fragment, the distro-like kernel: 5.4× the steps). ~7 min; until M7 it was built with Buildroot's toolchain under qemu-user (an hour and more) | the Buildroot guests, LTP (`Image-defconfig`), the litmus image |
| `ltp` | the `linux` root plus Buildroot's LTP (20260529) pruned to the 93 syscall tests in `images/ltp/tests`, and the arm64 kselftests `abi`, `signal`, `tags`; boots `Image-defconfig` on 512 MiB and runs `/ltp.sh` | `core/tests/ltp.rs`, Node |
| `linux-crypto` | allnoconfig + the fragment + `images/crypto/linux.fragment` (the arm64 CE drivers, NEON and bit-sliced AES, `CRYPTO_SELFTESTS_FULL`, lib/crypto's SHA-1/224/256 KUnit suites autorun), with a static init (`images/crypto/init.c`) that waits for the self-tests and prints each implementation's result | Node (the crypto extensions' kernel test) |
| `linux-gpu` | allnoconfig + the fragment + `images/gpu/linux.fragment` (`DRM`, `DRM_VIRTIO_GPU` with `DRM_VIRTIO_GPU_KMS`, built in; no fbdev emulation or fbcon), with a static init (`images/gpu/init.c`) that drives KMS through ioctls: connector, mode set, damage, cursor, a display event (the gpu guest, [testing.md](testing.md)). Its kernel tree stays in `target/images/build/linux-gpu` between builds (make rebuilds what the config changed) | `core/tests/gpu_guest.rs`, Node, Chromium |
| `linux-snd` | allnoconfig + the fragment + `images/snd/linux.fragment` (`SOUND`, `SND`, `SND_PCM`, `SND_VIRTIO`, built in), with a static init (`images/snd/init.c`) that plays a known waveform through ALSA's ioctls (no alsa-lib) and prints its FNV-1a (the snd guest, [testing.md](testing.md)): 48 periods (1.024 s), or `snd_seconds=N` on the command line (an environment variable to init; the page's `snd` machine, frontend.md); then it records from the capture PCM (audio S4): 16 periods, or `snd_rec_seconds=N`, printing the hash, its own time and each channel's frequency by its zero crossings. Also `snd-play` (`images/snd/play.c`, static: a WAV player on the same ioctls with aplay's buffer, for guests without alsa-utils; page-debian's) and `snd-rec` (`images/snd/rec.c`, audio S4: a recorder the same way, arecord's buffer, printing its own time, overruns and each channel's frequency, optionally writing a WAV). Built as `linux-gpu`, with the kernel's build number pinned (`KBUILD_BUILD_VERSION=1`: a rebuild in the same tree is the same kernel, and its steps don't move; linux-gpu's counts up) | `core/tests/snd_guest.rs`, Node, Chromium |
| `kvm-unit-tests` | commit `5a221342a025` (2026-09-08), the arm64 `.flat`s and `unittests.cfg`, built with Debian's `gcc-aarch64-linux-gnu` | `core/tests/kvm_unit_tests.rs`, Node |
| `alpine` | **Alpine 3.24.2, from its release media only** (they stay on the mirror for good; the repositories don't: Gotchas): the pinned aarch64 minirootfs plus `openrc` (0.63.2) from the pinned `alpine-virt-3.24.2-aarch64.iso`'s package repository (`apks/`, offline), with that ISO's kernel (`linux-virt` **6.18.52**, `Image` out of its EFI zboot `vmlinuz-virt`), its `initramfs-virt` as published, and its modloop's modules in `/lib/modules` (the files `linux-virt` would install; not `mkinitfs` or `kmod`: BusyBox's `modprobe`). Built natively in Alpine's arm64 container as its root (`alpine_release` unpacks the ISO into `target/images/dl/alpine-3.24.2-iso`; ~10 s); runlevels sysinit devfs dmesg, boot modules hostname, shutdown killprocs mount-ro, default local (no device manager: the initramfs loads virtio_mmio, virtio_blk, ext4). The test is `images/alpine/webpc.start` (a local.d script writing to `/dev/console`, then `poweroff`) | the Alpine boot tests and `boot_alpine*` |
| `alpine-user` | alpine's root plus `xz`, `lua5.4`, `sqlite`, `openssl` (3.5.8, from the ISO's repository) and the workloads (`images/alpine/user/`), with its own local.d script, as `rootfs-user.ext4`; boots alpine's Image and initramfs | `alpine_user_jit`, `alpine_crypto*_jit`, Node |
| `alpine-gl` | alpine's root plus Mesa 26.1.6 (EGL, GLES, llvmpipe) and `glcomp` (`images/alpine/gl/`: a compositor's GLES load without a display, compiled in the container), with its own local.d script, as `rootfs-gl.ext4`; boots alpine's Image and initramfs. Not built by default users' paths (`images/build.sh alpine-gl`) | `gl_llvmpipe_jit*` |
| `alpine-virgl` | alpine-gl's root plus **Mesa 26.1.6 built from source with llvmpipe and virgl** in `/opt/mesa` (Alpine's Mesa has no virgl on any architecture: its APKBUILD leaves it out), so both renderers run one build; the local.d script loads `virtio-gpu` with `webpc.gpu=1` and runs glcomp on `/opt/mesa`; `rootfs-virgl.ext4`. Not built by default users' paths (`images/build.sh alpine-virgl`, after alpine-gl; ~6 min) | `gl_virgl_jit*`, `gl_virgl_llvmpipe_jit*` |
| `litmus` | herdtools7 7.58 (CeCILL-B: built and run, never copied) in Alpine's arm64 container: `diyone7` makes each test in `images/litmus/tests.txt` (MP, SB, LB, 2+2W, IRIW, WRC, R, S and coherence shapes, plain and with DMB/DSB, dependencies, acquire/release), `herd7`'s `aarch64.cat` lists each one's allowed final states (`allowed.txt`), `litmus7` makes static C programs (`-mem direct -st 1 -barrier userfence -affinity incr0 -s 5k -r 200`, from herdtools7's Arm configs; the defaults showed the M4 no relaxed outcome at all); `images/litmus/stress.c`, the atomics stress, as `stress-lse` and `stress-llsc` (the build checks each has its atomics: [testing.md](testing.md) "Atomics stress"). Output: `initramfs.cpio` (BusyBox, `images/litmus/init`, the tests; booted with `linux/Image`, `webpc.litmus=<options, commas for spaces>`, `webpc.stress=<options>`) and `litmus.tar` (the same tests with `run.sh`, for the oracle VM) | the memory-model tests and the atomics stress (M7) |
| `debian` | the official `debian-13-nocloud-arm64` qcow2 (20260914-2601), pinned by build date and SHA512 (`images/debian.json`) and served as published; the kernel (6.12.107) as `target/images/debian/disk.qcow2` (a link to the download: nothing is taken out of it), the same code `npm start` runs | the page's Debian tests |
| `edk2` | **EDK2 edk2-stable202608** (commit `2970e5699ba6`, submodules as pinned by it): `ArmVirtPkg/ArmVirtQemuKernel.dsc`, RELEASE, GCC, `NETWORK_ENABLE=FALSE`, as `QEMU_EFI.fd` (3 MiB: an arm64 `Image` entered like a kernel with the DT in x0) and `LICENSES.txt` (EDK2's BSD-2-Clause-Patent, OpenSSL's Apache-2.0, libfdt's BSD-2-Clause: the binary is distributed). Built natively in Debian's arm64 container (pinned digest, apt from snapshot.debian.org), ~1 min. **Reproducible:** BaseTools draws a random stack cookie per module into `StackCookieValues{32,64}.json` and picks by `hash(GUID)`; the build writes both lists from a fixed seed and sets `PYTHONHASHSEED=0` (the cookies are public in the binary either way). Also `shell.img`, the firmware tests' disk: 8 MiB of FAT (no partition table; a fixed volume ID, every timestamp `SOURCE_DATE_EPOCH`) with the build's UEFI Shell as `\EFI\BOOT\BOOTAA64.EFI` and `images/edk2/startup.nsh` | `tools/uefi-oracle.ts`; the firmware configuration's tests ([testing.md](testing.md)); M8 phase B's firmware boots ([plans/uefi.md](plans/uefi.md)) |
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
surfaceless target, built natively for Arch Linux ARM in rootless Podman from Arch's own tarball (the Arch image's
download, cached in `target/archarm`; `images/deqp/Containerfile`, ~10 min). Results: `target/deqp/deqp.ext4` (113
MiB: the binaries, their data and the GLES2/GLES3 mustpass lists under `/deqp`), the page's second disk for
`bench/gpu/deqp-run.ts`; and the image `localhost/webpc-deqp`, which runs the same binaries on Mesa's virpipe against
the vtest oracle (`tools/virgl-oracle/deqp.sh`). It then makes the guest that runs them, `target/deqp/guest.qcow2`
(`images/archarm/build.sh --packages "mesa libpng"`, ~4 min; `--guest-only` makes it alone), `scripts/ci-deqp.sh`'s. A case's capture (`CAPTURE=`) replays on Chromium with
`bench/gpu/virgl-pairs.ts`, which diffs each read-back with the next (dEQP's result and its reference). The surfaceless target takes EGL's default display:
`EGL_PLATFORM=surfaceless` picks it.

## Arch Linux ARM for UEFI (`images/archarm/build.sh`)

**On demand only**: not in `images/build.sh` or `SHA256SUMS` (its `--packages` form makes dEQP's guest, `scripts/ci-deqp.sh`'s). It turns Arch Linux ARM's
rootfs tarball (no bootloader, no partition table) into a qcow2 that boots through UEFI, for trying
a distro the project doesn't ship. `images/archarm/build.sh [--out f.qcow2] [--root-mib 7500]
[--esp-mib 256] [--packages "p1 p2"] [--modules dir]` (`--packages`: `pacman -Syu` them in the container first, from Arch Linux ARM's mirrors; `--modules`: out-of-tree `dir/*.ko` into `/usr/lib/modules/<release>/updates`, `depmod`ed, each one's vermagic checked against the image's kernel) (~3 min, ~6 GiB of disk while it runs; the result is `target/archarm/archlinuxarm-uefi.qcow2`,
804 MiB, 8 GiB virtual):

- Downloads `ArchLinuxARM-aarch64-latest.tar.gz` (the *latest*, so the result changes over time;
  checked against the published `.md5`, a cached copy is reused) and imports it into rootless Podman
  (it runs natively on arm64). The host needs `podman`, `curl`, `sgdisk`, `mkfs.vfat` + mtools, `qemu-img`; no root, no loop devices.
- **The initramfs is regenerated** in the container: the shipped one is built with `autodetect` and
  has no `virtio_mmio`/`virtio_blk`, so it can't find our disk. The new one lists `virtio_mmio
  virtio_blk ext4 vfat` and drops `autodetect`.
- The container's rootfs is copied into an ext4 image with `mke2fs -d` (ownership and xattrs kept);
  Podman's injected `/etc/hostname`, `/etc/hosts`, `/etc/resolv.conf` and `/run/.containerenv` are
  replaced by the tarball's originals.
- GPT: a 256 MiB FAT32 ESP (mounted at `/boot`) with systemd-boot (the one in the tarball) as
  `\EFI\BOOT\BOOTAA64.EFI`, the kernel `Image` (an EFI-stub kernel, which systemd-boot starts with
  the initrd via LoadFile2) and a loader entry, then the ext4 root (type GUID Linux root aarch64).
  Fixed PARTUUIDs; command line `root=PARTUUID=… rw console=tty0 console=ttyAMA0`.
- Logins: `root`/`root`, `alarm`/`alarm` (Arch ARM's stock); hostname `alarm`.
- Checked on QEMU through our EDK2: `node tools/uefi-oracle.ts $PWD/target/archarm/archlinuxarm-uefi.qcow2`
  (absolute path) reaches `login:` in ~25 s (the tool reports FAIL, since it expects a passwordless
  root).
- **In webpc itself (the user, 2026-10-01, at commit `1e0cc58`):** Arch Linux ARM with kernel 7.2.8-1 boots
  and runs fine in the emulator, networking included. Networking needed the gateway's /32 lease mask:
  with the earlier 0.0.0.0 mask Arch's systemd-networkd logged `DHCP error: no netmask` and never
  configured IPv4 (IPv6 worked); see [devices.md](devices.md) "net". Reported by hand, not a test.
- It works under `target/archarm/work` (removed at the end), not `/tmp`: the dev VM's `/tmp` is a small tmpfs that the 8 GiB disk overflows.
- **Sound (`images/archarm/virtio-snd.sh [--kernel 7.2.9-1]`, on demand, ~1 min):** ALARM's `linux-aarch64` doesn't
  build `CONFIG_SND_VIRTIO`, so this builds `virtio_snd` out of tree in rootless Podman (`localhost/archarm-base`)
  against the mirror's current `linux-aarch64-headers`, from `sound/virtio/` of the matching kernel.org release
  (`linux-<X.Y.Z>.tar.xz`, sha256 against kernel.org's `sha256sums.asc`, cached in `target/archarm/`; GPL-2.0 code
  built for the guest, nothing in the repo). Result: `target/archarm/virtio-snd/<release>/virtio_snd.ko` (48 KB).
  An image with it and ALSA's tools: `images/archarm/build.sh --packages alsa-utils --modules
  target/archarm/virtio-snd/7.2.9-1-aarch64-ARCH`; build both the same day (the mirror keeps only the latest kernel,
  and the module must match the image's exactly). udev loads it when the device is there. Checked under QEMU's
  `virtio-sound-device` (with `-global virtio-mmio.force-legacy=false`): [audio.md](audio.md) "The guests".
- **The DKMS package (`images/archarm/virtio-snd-dkms/`, `images/archarm/virtio-snd-dkms.sh`, on demand, ~3 min):**
  a PKGBUILD for `virtio-snd-dkms` ([audio.md](audio.md) "The guests"): one stable release's `sound/virtio` (its `pkgver`, now 7.2.9),
  fetched file by file from git.kernel.org's `plain` view at `makepkg` time with their sha256s, and a `dkms.conf` that
  builds it with the upstream Makefile (`CONFIG_SND_VIRTIO=m`); `depends=(dkms)`, the headers are the user's. The
  script makes and installs it as a user would, in a container of `localhost/archarm-base` upgraded with
  `base-devel dkms linux-aarch64-headers`: DKMS's pacman hook builds the module for the headers' kernel (checked:
  `dkms status` installed, the vermagic). Result `target/archarm/pkg/virtio-snd-dkms-<ver>-any.pkg.tar.xz`. Not
  published anywhere. A user's Arch Linux ARM: `makepkg -si` in that directory (with `linux-aarch64-headers`).
- **The desktop guest (`images/archarm/desktop.sh [--out f.qcow2]`, on demand, ~15 min; audio S3):** sway, foot,
  Firefox, PipeWire (WirePlumber, `pipewire-pulse`, `pipewire-alsa`), alsa-utils, mpv, libva-utils (`vainfo`), our
  `webpc-va` package (`images/archarm/webpc-va.sh`: webpc's VA-API driver, Mesa's virgl with NV12 decode surfaces only
  and AV1 film grain decoded into the shown surface, `LIBVA_DRIVER_NAME=webpc` for every session; [plans/video.md](plans/video.md)), and the DKMS package above
  installed (so the image carries `dkms`, gcc and the headers: the module is built in the image's container by the
  package's hook, as on a user's machine); Firefox's policies allow autoplay with sound and skip the first-run pages.
  `images/archarm/media.sh` makes `/home/alarm/media` in Podman (Alpine's ffmpeg): `avsync.webm` (a white frame and a
  1 kHz beep each second, VP8/Opus, 60 s), `sintel.webm` and `sintel-silent.webm` (the Sintel trailer, Blender
  Foundation, CC BY 3.0, downloaded from download.blender.org with its sha256, as VP9/Opus 480p), and `avsync.html`
  (plays `?v=<clip>`). Built with `build.sh`'s `--files <dir>` (a tree copied onto the root; a user's home made theirs)
  and `--setup <script>` (`images/archarm/desktop-setup.sh`, run as root in the container). Result
  `target/archarm/desktop.qcow2`; `bench/audio/avsync.ts` measures on it.

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
  `npm start` keeps its own stamp (`target/images/debian/.prepared`: the pin), since it can't run
  `build.sh` (bash 4 syntax; macOS has bash 3.2).
