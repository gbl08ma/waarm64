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
  toolchains; on the arm64 dev VM it runs under qemu-user, where `unshare` fails. The Alpine-based
  images (`alpine-user`, `linux-crypto`) build natively in Alpine's own arm64 container
  (`USERLAND_CONTAINER`, pinned by digest), as its root, needing neither qemu-user nor unshare.
- The Mac builds nothing; it gets artifacts by `scp` if it needs them.

## The images

| Name | What | Used by |
|---|---|---|
| `linux` | Buildroot 2026.08 (commit `d5180309b1b6`, Bootlin aarch64 glibc stable 2025.08-1, `BR2_REPRODUCIBLE`) BusyBox root as `rootfs.ext4` (32 MiB, fixed UUID and hash seed); **Linux 6.18.54** as `Image` from `allnoconfig` + `images/linux.fragment` (platform, virtio devices, ext4, net, 9p, input, `FB_SIMPLE` without fbcon, `SYSVIPC`), and `Image-defconfig` (arm64 defconfig + fragment, the distro-like kernel: 5.4× the steps) | the Buildroot boot and device tests; `boot*` benchmarks; I/O benchmarks |
| `ltp` | the `linux` root plus Buildroot's LTP (20260529) pruned to the 93 syscall tests in `images/ltp/tests`, and the arm64 kselftests `abi`, `signal`, `tags`; boots `Image-defconfig` on 512 MiB and runs `/ltp.sh` | `core/tests/ltp.rs`, Node |
| `linux-crypto` | allnoconfig + the fragment + `images/crypto/linux.fragment` (the arm64 CE drivers, NEON and bit-sliced AES, `CRYPTO_SELFTESTS_FULL`, lib/crypto's SHA-1/224/256 KUnit suites autorun), with a static init (`images/crypto/init.c`) that waits for the self-tests and prints each implementation's result | Node (the crypto extensions' kernel test) |
| `kvm-unit-tests` | commit `5a221342a025` (2026-09-08), the arm64 `.flat`s and `unittests.cfg`, built with Debian's `gcc-aarch64-linux-gnu` | `core/tests/kvm_unit_tests.rs`, Node |
| `alpine` | **Alpine 3.24.2**: the pinned aarch64 minirootfs plus `apk add` of pinned `linux-virt` (6.18.53) and `openrc` (0.63.2), in a chroot under `qemu-aarch64-static` registered in a user namespace's own binfmt_misc; runlevels sysinit devfs dmesg, boot modules hostname, shutdown killprocs mount-ro, default local (no device manager: the initramfs loads virtio_mmio, virtio_blk, ext4). The test is `images/alpine/webpc.start` (a local.d script writing to `/dev/console`, then `poweroff`) | the Alpine boot tests and `boot_alpine*` |
| `alpine-user` | alpine's root plus `xz`, `lua5.4`, `sqlite`, `openssl` (3.5.8) and the workloads (`images/alpine/user/`), with its own local.d script, as `rootfs-user.ext4`; boots alpine's Image and initramfs | `alpine_user_jit`, `alpine_crypto*_jit`, Node |
| `debian` | the official `debian-13-nocloud-arm64` qcow2 (20260914-2601), pinned by build date and SHA512 and served as published; the kernel (6.12.107) and initrd (`MODULES=most`) taken out of its `/boot` | Debian boot tests, `boot_debian_jit` |

Command lines: Buildroot `console=ttyAMA0 earlycon panic=-1 root=/dev/vda ro init=/init` (a
script after `--`: `/test.sh` by default, `/test-devices.sh`, `/test-input.sh`, `/test-rw.sh`,
`/ltp.sh`, `/bench-*.sh`); Alpine `console=ttyAMA0 root=/dev/vda rootfstype=ext4 modules=ext4 ro`
(`webpc.phase=user|crypto` for alpine-user); Debian `console=ttyAMA0 root=/dev/vda1 ro
systemd.run="…" systemd.run_success_action=poweroff systemd.run_failure_action=poweroff
systemd.firstboot=off` (systemd-run-generator runs the test as a unit; `firstboot=off` because a
writable first boot waits on the console forever, on QEMU too). Distros get 1 GiB.

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
