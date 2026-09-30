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
  images (`linux`, `alpine-user`, `linux-crypto`, `litmus`) build natively in Alpine's own arm64 container
  (`USERLAND_CONTAINER`, pinned by digest), as its root, needing neither qemu-user nor unshare.
- The Mac builds nothing; it gets artifacts by `scp` if it needs them.

## The images

| Name | What | Used by |
|---|---|---|
| `buildroot` | Buildroot 2026.08 (commit `d5180309b1b6`, Bootlin aarch64 glibc stable 2025.08-1, `BR2_REPRODUCIBLE`) BusyBox root as `rootfs.ext4` (32 MiB, fixed UUID and hash seed), in the x86_64 images container (qemu-user on the dev VM: slow; its bytes differ between hosts, so the committed hash is the x86_64 desktop's) | with `linux`: the Buildroot boot and device tests; `boot*` benchmarks; I/O benchmarks |
| `linux` | **Linux 6.18.54** built natively in Alpine's arm64 container (gcc 15): `Image` from `allnoconfig` + `images/linux.fragment` (platform, both GICs, virtio devices, ext4, net, 9p, input, `FB_SIMPLE` without fbcon, `SYSVIPC`), and `Image-defconfig` (arm64 defconfig + fragment, the distro-like kernel: 5.4× the steps). ~7 min; until M7 it was built with Buildroot's toolchain under qemu-user (an hour and more) | the Buildroot guests, LTP (`Image-defconfig`), the litmus image |
| `ltp` | the `linux` root plus Buildroot's LTP (20260529) pruned to the 93 syscall tests in `images/ltp/tests`, and the arm64 kselftests `abi`, `signal`, `tags`; boots `Image-defconfig` on 512 MiB and runs `/ltp.sh` | `core/tests/ltp.rs`, Node |
| `linux-crypto` | allnoconfig + the fragment + `images/crypto/linux.fragment` (the arm64 CE drivers, NEON and bit-sliced AES, `CRYPTO_SELFTESTS_FULL`, lib/crypto's SHA-1/224/256 KUnit suites autorun), with a static init (`images/crypto/init.c`) that waits for the self-tests and prints each implementation's result | Node (the crypto extensions' kernel test) |
| `kvm-unit-tests` | commit `5a221342a025` (2026-09-08), the arm64 `.flat`s and `unittests.cfg`, built with Debian's `gcc-aarch64-linux-gnu` | `core/tests/kvm_unit_tests.rs`, Node |
| `alpine` | **Alpine 3.24.2**: the pinned aarch64 minirootfs plus `apk add` of pinned `linux-virt` (6.18.53) and `openrc` (0.63.2), in a chroot under `qemu-aarch64-static` registered in a user namespace's own binfmt_misc; runlevels sysinit devfs dmesg, boot modules hostname, shutdown killprocs mount-ro, default local (no device manager: the initramfs loads virtio_mmio, virtio_blk, ext4). The test is `images/alpine/webpc.start` (a local.d script writing to `/dev/console`, then `poweroff`) | the Alpine boot tests and `boot_alpine*` |
| `alpine-user` | alpine's root plus `xz`, `lua5.4`, `sqlite`, `openssl` (3.5.8) and the workloads (`images/alpine/user/`), with its own local.d script, as `rootfs-user.ext4`; boots alpine's Image and initramfs | `alpine_user_jit`, `alpine_crypto*_jit`, Node |
| `litmus` | herdtools7 7.58 (CeCILL-B: built and run, never copied) in Alpine's arm64 container: `diyone7` makes each test in `images/litmus/tests.txt` (MP, SB, LB, 2+2W, IRIW, WRC, R, S and coherence shapes, plain and with DMB/DSB, dependencies, acquire/release), `herd7`'s `aarch64.cat` lists each one's allowed final states (`allowed.txt`), `litmus7` makes static C programs (`-mem direct -st 1 -barrier userfence -affinity incr0 -s 5k -r 200`, from herdtools7's Arm configs; the defaults showed the M4 no relaxed outcome at all); `images/litmus/stress.c`, the atomics stress, as `stress-lse` and `stress-llsc` (the build checks each has its atomics: [testing.md](testing.md) "Atomics stress"). Output: `initramfs.cpio` (BusyBox, `images/litmus/init`, the tests; booted with `linux/Image`, `webpc.litmus=<options, commas for spaces>`, `webpc.stress=<options>`) and `litmus.tar` (the same tests with `run.sh`, for the oracle VM) | the memory-model tests and the atomics stress (M7) |
| `debian` | the official `debian-13-nocloud-arm64` qcow2 (20260914-2601), pinned by build date and SHA512 (`images/debian.json`) and served as published; the kernel (6.12.107) and initrd (`MODULES=most`) taken out of its `/boot` **in Node, on the host** (`tools/debian.ts`: a partition table and ext4 reader over the qcow2 reader, [frontend.md](frontend.md) "The disk reader"; no container, no `qemu-img`, `sfdisk` or `debugfs`), the same code `npm start` runs; ~2 s with the download cached | Debian boot tests, `boot_debian_jit`, the page |

Command lines: Buildroot `console=ttyAMA0 earlycon panic=-1 root=/dev/vda ro init=/init` (a
script after `--`: `/test.sh` by default, `/test-devices.sh`, `/test-input.sh`, `/test-rw.sh`,
`/ltp.sh`, `/bench-*.sh`); Alpine `console=ttyAMA0 root=/dev/vda rootfstype=ext4 modules=ext4 ro`
(`webpc.phase=user|crypto` for alpine-user); Debian `console=ttyAMA0 root=/dev/vda1 ro
systemd.run="…" systemd.run_success_action=poweroff systemd.run_failure_action=poweroff
systemd.firstboot=off` (systemd-run-generator runs the test as a unit; `firstboot=off` because a
writable first boot waits on the console forever, on QEMU too). Distros get 1 GiB.

**Debian for interaction** (the page's VM, M8; `bench/boot/REPORT.md` "M8 loop 0"): `console=ttyAMA0
console=tty0 root=/dev/vda1 ro systemd.firstboot=off systemd.set_credential=login.noauth:yes
apparmor=0` and `systemd.mask=` for `systemd-networkd.service`, `systemd-networkd.socket`,
`systemd-resolved.service`, `systemd-timesyncd.service`, `systemd-network-generator.service` (no
guest network in M8 phase A: they only cost boot time). The last `console=` gets `/dev/console`,
so systemd's status lines go to the screen; the kernel log goes to both. systemd's getty generator
starts `getty@tty1` and `serial-getty@ttyAMA0` (and `serial-getty@hvc0` for the virtio console).
**The published image locks root** (`root:!unprovisioned` in `/etc/shadow`; the nocloud image has
no provisioning of its own): `login.noauth` is a credential util-linux's `login` reads (both getty
units import `login.*`), so `root` logs in with no password on every console without touching the
image. The kernel has `simplefb` and `fbcon` built in: fbcon draws on the framebuffer from the
first kernel line.

## Stress workloads in the Debian guest (`images/stress/`)

A load with the character of a Go compile on 4 vCPUs (BUG1-HANDOVER.md): many threads, spinning
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
  `build_debian`, not the reader's code (an edit to `web/ext4.ts` shouldn't mark the image stale
  and skip Debian's tests); the reader is checked by its tests and by `SHA256SUMS` on a rebuild.
  `npm start` keeps its own stamp (`target/images/debian/.prepared`: the pin), since it can't run
  `build.sh` (bash 4 syntax; macOS has bash 3.2).
