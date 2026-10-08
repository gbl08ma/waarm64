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
  best-effort (a mismatch warns). `SOURCE_DATE_EPOCH` is 2026-09-01.
- **Two containers:** `images/Containerfile` (Debian 13, pinned by digest, apt on
  `snapshot.debian.org` 20260924T000000Z) is x86_64, because Buildroot uses Bootlin's x86_64-hosted
  toolchains; on the arm64 dev VM it runs under qemu-user, where `unshare` fails. **Prefer the
  native container on the dev VM** (the user, M7: development stays on the M4). The Alpine-based
  images (`linux`, `alpine-user`, `alpine-gl`, `linux-crypto`, `litmus`) build natively in Alpine's own arm64 container
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
| `kvm-unit-tests` | commit `5a221342a025` (2026-09-08), the arm64 `.flat`s and `unittests.cfg`, built with Debian's `gcc-aarch64-linux-gnu` | `core/tests/kvm_unit_tests.rs`, Node |
| `alpine` | **Alpine 3.24.2**: the pinned aarch64 minirootfs plus `apk add` of pinned `linux-virt` (6.18.53) and `openrc` (0.63.2), in a chroot under `qemu-aarch64-static` registered in a user namespace's own binfmt_misc; runlevels sysinit devfs dmesg, boot modules hostname, shutdown killprocs mount-ro, default local (no device manager: the initramfs loads virtio_mmio, virtio_blk, ext4). The test is `images/alpine/webpc.start` (a local.d script writing to `/dev/console`, then `poweroff`) | the Alpine boot tests and `boot_alpine*` |
| `alpine-user` | alpine's root plus `xz`, `lua5.4`, `sqlite`, `openssl` (3.5.8) and the workloads (`images/alpine/user/`), with its own local.d script, as `rootfs-user.ext4`; boots alpine's Image and initramfs | `alpine_user_jit`, `alpine_crypto*_jit`, Node |
| `alpine-gl` | alpine's root plus Mesa 26.1.6 (EGL, GLES, llvmpipe) and `glcomp` (`images/alpine/gl/`: a compositor's GLES load without a display, compiled in the container), with its own local.d script, as `rootfs-gl.ext4`; boots alpine's Image and initramfs. Not built by default users' paths (`images/build.sh alpine-gl`) | `gl_llvmpipe_jit*` |
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

## Arch Linux ARM for UEFI (`images/archarm/build.sh`)

**On demand only**: not in `images/build.sh`, `SHA256SUMS`, CI or any test. It turns Arch Linux ARM's
rootfs tarball (no bootloader, no partition table) into a qcow2 that boots through UEFI, for trying
a distro the project doesn't ship. `images/archarm/build.sh [--out f.qcow2] [--root-mib 7500]
[--esp-mib 256]` (~3 min, ~6 GiB of disk while it runs; the result is `target/archarm/archlinuxarm-uefi.qcow2`,
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

- **Alpine keeps only the latest build of each package**, so the pins fail loudly once
  superseded; bump them deliberately (the image's bytes, and so a step count, change).
- Alpine's image reproducibility needed: mkinitfs re-run with `SOURCE_DATE_EPOCH` (apk scrubs its
  triggers' environment), apk's timestamped log dropped, mtimes clamped, `/etc/shadow`'s group put
  back (the user namespace has one uid).
- The committed `alpine` image came from the x86_64 desktop; `images/build.sh alpine` can't rebuild
  it on the arm64 VM (qemu-user + unshare). Move it to the Alpine container if it ever needs
  rebuilding here (its bytes would change: a new step count).
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
