# Guest images

Test and benchmark guests, built by `images/build.sh [name…]` into `target/images/<name>/`
(downloads in `target/images/dl/`). **Build them only in rootless Podman through `images/`:**
never install cross toolchains or build dependencies on the host, never use Docker. (One exception:
without Podman, as in a cloud session, `agent` is built with the host's cargo and marked `HOST-BUILD`, for tests
only; `npm run dist` refuses it: "agent" below.) `images/`
commits the configs, scripts and `SHA256SUMS`, never binaries. Guest images carry their own GPL
obligations (publish the configs, point to the sources), separate from waarm64's MIT license.

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
  images (`linux`, `alpine`, `alpine-user`, `alpine-node`, `alpine-gl`, `alpine-demo`, `linux-crypto`, `linux-gpu`, `linux-snd`, `linux-usb`, `linux-usbhost`, `litmus`, `fptest`) build natively in Alpine's own arm64 container
  (`USERLAND_CONTAINER`, pinned by digest), as its root, needing neither qemu-user nor unshare.
- The Mac builds nothing; it gets artifacts by `scp` if it needs them.

## The images

| Name | What | Used by |
|---|---|---|
| `buildroot` | Buildroot 2026.08 (commit `d5180309b1b6`, `BR2_REPRODUCIBLE`) BusyBox root as `rootfs.ext4` (32 MiB, fixed UUID and hash seed), with Buildroot's own toolchain (gcc 15.3, binutils 2.45.1, glibc 2.44, Linux 6.18.49 headers, no C++) built natively in `images/buildroot/Containerfile`: ~10 min on the dev VM, most of it the toolchain (cold 13 min with the toolchain's downloads). It rebuilds bit for bit on the dev VM; the committed hash is the dev VM's (an x86_64 host is expected to match: same sources and configuration, a cross gcc either way, but unchecked). Until 2026-10-23 it used Bootlin's x86_64-hosted toolchain, so the whole build ran under qemu-user on the dev VM (`ltp` took ~1.5 h) | with `linux`: the Buildroot boot and device tests; `boot*` benchmarks; I/O benchmarks |
| `linux` | **Linux 6.18.54** built natively in Alpine's arm64 container (gcc 15): `Image` from `allnoconfig` + `images/linux.fragment` (platform, both GICs, virtio devices, ext4, net, 9p, input, `FB_SIMPLE` without fbcon, `SYSVIPC`), and `Image-defconfig` (arm64 defconfig + fragment, the distro-like kernel: 5.4× the steps). ~7 min; until M7 it was built with Buildroot's toolchain under qemu-user (an hour and more) | the Buildroot guests, LTP (`Image-defconfig`), the litmus image |
| `ltp` | the `linux` root plus Buildroot's LTP (20260529) pruned to the 93 syscall tests in `images/ltp/tests` (its Open POSIX testsuite not built: a minute of the build, then thrown away), the arm64 kselftests `abi`, `signal`, `tags` and `breakpoints/breakpoint_test_arm64` (built with Buildroot's toolchain), and `waarm64-debug` (`images/ltp/debug.c`: ptrace single step, perf breakpoints and watchpoints); boots `Image-defconfig` on 512 MiB and runs `/ltp.sh`. Built as `buildroot` (its own Buildroot tree and toolchain): ~11 min on the dev VM | `core/tests/ltp.rs`, Node |
| `linux-crypto` | allnoconfig + the fragment + `images/crypto/linux.fragment` (the arm64 CE drivers, sha3-ce among them, NEON and bit-sliced AES, `CRYPTO_SELFTESTS_FULL`, lib/crypto's SHA-1/224/256/384/512 KUnit suites autorun), with a static init (`images/crypto/init.c`) that waits for the self-tests and prints each implementation's result | Node (the crypto extensions' kernel test) |
| `linux-gpu` | allnoconfig + the fragment + `images/gpu/linux.fragment` (`DRM`, `DRM_VIRTIO_GPU` with `DRM_VIRTIO_GPU_KMS`, built in; no fbdev emulation or fbcon), with a static init (`images/gpu/init.c`) that drives KMS through ioctls: connector, mode set, damage, cursor, a display event (the gpu guest, [testing.md](testing.md)). Its kernel tree stays in `target/images/build/linux-gpu` between builds (make rebuilds what the config changed) | `core/tests/gpu_guest.rs`, Node, Chromium |
| `linux-snd` | allnoconfig + the fragment + `images/snd/linux.fragment` (`SOUND`, `SND`, `SND_PCM`, `SND_VIRTIO`, built in), with a static init (`images/snd/init.c`) that plays a known waveform through ALSA's ioctls (no alsa-lib) and prints its FNV-1a (the snd guest, [testing.md](testing.md)): 48 periods (1.024 s), or `snd_seconds=N` on the command line (an environment variable to init; the page's `snd` machine, frontend.md); then it records from the capture PCM (audio S4): 16 periods, or `snd_rec_seconds=N`, printing the hash, its own time and each channel's frequency by its zero crossings. Also `snd-play` (`images/snd/play.c`, static: a WAV player on the same ioctls with aplay's buffer, for guests without alsa-utils; page-debian's) and `snd-rec` (`images/snd/rec.c`, audio S4: a recorder the same way, arecord's buffer, printing its own time, overruns and each channel's frequency, optionally writing a WAV). Built as `linux-gpu`, with the kernel's build number pinned (`KBUILD_BUILD_VERSION=1`: a rebuild in the same tree is the same kernel, and its steps don't move; linux-gpu's counts up) | `core/tests/snd_guest.rs`, Node, Chromium |
| `linux-usb` | allnoconfig + the fragment + `images/usb/linux.fragment` (`USB`, `USB_XHCI_HCD` with `USB_XHCI_PLATFORM` for our DT's `generic-xhci` node, `USB_TEST`, new devices announced; and `PCI`, `PCI_HOST_GENERIC`, `USB_XHCI_PCI`, so the same kernel runs on QEMU's `qemu-xhci`, the oracle), with a static init (`images/usb/init.c`) and the kernel's own `testusb` (`tools/usb/testusb.c`, static, at `/testusb`; GPL, built and run, not copied). The init prints the two root hubs, then with `usb_devices=N` waits for N Gadget Zeros and runs `testusb` (`usb_args=…`, commas for spaces) once, and with `usb_unplug=1` again until a gadget goes away and once more after it is back (docs/usb.md, the usb guest in [testing.md](testing.md)). Built as `linux-snd` | `core/tests/usb_guest.rs`, Node, Chromium |
| `linux-usbhost` | `linux-usb`'s kernel and `images/usbhost/linux.fragment` (`USB_ACM`, `HID_SUPPORT`, `HID`, `HIDRAW`, `HID_GENERIC`, `USB_HID`), and an init (`images/usbhost/init.c`, around `images/usb/init.c`) whose `usb_mode=` runs testusb, a `cdc_acm` echo or the `hidraw` checks, beside the kernel's `testusb` | the guest-level tests through WebUSB and WebHID on the dev VM's rigs (`tests/usb-guest.test.ts`, `scripts/ci-usb.sh`; docs/usb.md "The usbhost guest") |
| `kvm-unit-tests` | commit `5a221342a025` (2026-09-08), the arm64 `.flat`s and `unittests.cfg`, built with Debian's `gcc-aarch64-linux-gnu` | `core/tests/kvm_unit_tests.rs`, Node |
| `alpine` | **Alpine 3.24.2, from its release media only** (they stay on the mirror for good; the repositories don't: Gotchas): the pinned aarch64 minirootfs plus `openrc` (0.63.2) from the pinned `alpine-virt-3.24.2-aarch64.iso`'s package repository (`apks/`, offline), with that ISO's kernel (`linux-virt` **6.18.52**, `Image` out of its EFI zboot `vmlinuz-virt`), its `initramfs-virt` as published, and its modloop's modules in `/lib/modules` (the files `linux-virt` would install; not `mkinitfs` or `kmod`: BusyBox's `modprobe`). Built natively in Alpine's arm64 container as its root (`alpine_release` unpacks the ISO into `target/images/dl/alpine-3.24.2-iso`; ~10 s); runlevels sysinit devfs dmesg, boot modules hostname, shutdown killprocs mount-ro, default local (no device manager: the initramfs loads virtio_mmio, virtio_blk, ext4). The test is `images/alpine/waarm64.start` (a local.d script writing to `/dev/console`, then `poweroff`) | the Alpine boot tests and `boot_alpine*` |
| `alpine-user` | alpine's root plus `xz`, `lua5.4`, `sqlite`, `openssl` (3.5.8, from the ISO's repository) and the workloads (`images/alpine/user/`), with its own local.d script, as `rootfs-user.ext4`; boots alpine's Image and initramfs | `alpine_user_jit`, `alpine_crypto*_jit`, Node |
| `alpine-node` | alpine's root plus Node 24.22.3 (Alpine's `nodejs`, the live repository's) and `jitjit.js` (`images/alpine/node/`: fixed work that keeps V8 writing, patching and dropping machine code; `waarm64.jj=N` scales it, `waarm64.par=N` runs N copies at once), with its own local.d script, as `rootfs-node.ext4`; boots alpine's Image and initramfs | the paired A/B's `node` and `smp` workloads (`bench/boot/pair.ts`) |
| `alpine-gl` | alpine's root plus Mesa 26.1.6 (EGL, GLES, llvmpipe), `glcomp` (`images/alpine/gl/`: a compositor's GLES load without a display, compiled in the container) and `glquery` (occlusion queries waited on each frame, `waarm64.glq=frames,queries,width,height` runs it instead: bench/gpu/query-wait.ts), with its own local.d script, as `rootfs-gl.ext4`; boots alpine's Image and initramfs. Not built by default users' paths (`images/build.sh alpine-gl`) | `gl_llvmpipe_jit*` |
| `alpine-virgl` | alpine-gl's root plus **Mesa 26.1.6 built from source with llvmpipe and virgl** in `/opt/mesa` (Alpine's Mesa has no virgl on any architecture: its APKBUILD leaves it out), so both renderers run one build; the local.d script loads `virtio-gpu` with `waarm64.gpu=1` and runs glcomp on `/opt/mesa`; `rootfs-virgl.ext4`. Not built by default users' paths (`images/build.sh alpine-virgl`, after alpine-gl; ~6 min) | `gl_virgl_jit*`, `gl_virgl_llvmpipe_jit*` |
| `litmus` | herdtools7 7.58 (CeCILL-B: built and run, never copied) in Alpine's arm64 container: `diyone7` makes each test in `images/litmus/tests.txt` (MP, SB, LB, 2+2W, IRIW, WRC, R, S and coherence shapes, plain and with DMB/DSB, dependencies, acquire/release), `herd7`'s `aarch64.cat` lists each one's allowed final states (`allowed.txt`), `litmus7` makes static C programs (`-mem direct -st 1 -barrier userfence -affinity incr0 -s 5k -r 200`, from herdtools7's Arm configs; the defaults showed the M4 no relaxed outcome at all); `images/litmus/stress.c`, the atomics stress, as `stress-lse` and `stress-llsc` (the build checks each has its atomics: [testing.md](testing.md) "Atomics stress"). Output: `initramfs.cpio` (BusyBox, `images/litmus/init`, the tests; booted with `linux/Image`, `waarm64.litmus=<options, commas for spaces>`, `waarm64.stress=<options>`) and `litmus.tar` (the same tests with `run.sh`, for the oracle VM) | the memory-model tests and the atomics stress (M7) |
| `fptest` | the FP suite ([testing.md](testing.md) "The FP suite"): Berkeley SoftFloat 3e (`a0c6494cdc11`, its ARM-VFPv2 build) and TestFloat 3e's `testfloat_gen` (`a9c849f1b0eb`, the commits `scripts/testfloat.sh` pins) and `images/fptest/fptest.c` with its form tables (`forms.py`), static, built natively in Alpine's arm64 container; `initramfs.cpio` (BusyBox, `images/fptest/init`, the programs; booted with `linux/Image`, `waarm64.fptest=<options, commas for spaces>`) and `fptest.tar` (the programs and `run.sh`, for the oracle VM) | `scripts/ci-fp.sh` (`tests/fptest.test.ts`) |
| `intro` | **the introduction's guest** (frontend.md "The introduction"; the one image the page itself serves): `intro.img`, a kernel of its own with its initramfs built in, and `intro.img.gz`, zopfli's gzip of it, what the page fetches (4,372,488 and 1,676,234 bytes), with `LICENSES.txt` (the page distributes these GPL binaries: `images/intro/LICENSES.head`, what is inside and where each source is, then the GPL's text from the kernel tree; `npm run dist` puts it beside the page as `INTRO-LICENSES.txt`, and `npm start` builds the image where Podman is). The kernel is `allnoconfig` + `images/intro/linux.fragment` and nothing of `images/linux.fragment`: `EXPERT` (so allnoconfig answers no to kallsyms, BUG's tables, core dumps, io_uring and the like), our platform (GICv3, the arch timer, PSCI, PL011), `FB_SIMPLE` through fbdev with no VT (nothing draws the boot log), proc, sysfs, tmpfs, `NO_HZ_IDLE`, 39-bit VAs, `NR_CPUS=2`, built for size; no block layer, no network, no virtio. The initramfs (uncompressed inside: the file is compressed whole) holds Alpine's static BusyBox with its applets linked at build time, `init`, `tour`, `cycle`, `typed`, `session` (the shell's session on the serial port, with Ctrl-C's signals at their defaults: init starts it in the background, whose jobs ignore them) and the three toys with their sources (`/toys`: `scope`, `ridges`, `life`, each a C program of ours over `screen.h`, static on musl, without stdio: 67 KB each). `init` mounts devtmpfs itself (the kernel mounts it only on a root it mounts), starts `scope` before anything else, runs the tour (the marks it sends are OSC 777 `waarm64;<mark>`: the page says its own words by them, the guest prints only commands and their output; a key ends it), then `cycle` (one toy after another, 20 s each, until somebody starts a toy by hand) and a shell on the serial port for good, and powers off or restarts when BusyBox's `poweroff`, `halt` or `reboot` signal it (PID 1 is this script); `waarm64.cols=` and `waarm64.rows=` size its terminal. A toy takes the screen from the one before (`/tmp/toy`: the process it names is stopped if it is still a toy). Built natively in Alpine's arm64 container with its own pins (`INTRO_TOOLS`: `KERNEL_TOOLS` less openssl-dev), ~1 min, the kernel tree kept in `target/images/build/intro`; it rebuilds bit for bit (`KBUILD_BUILD_VERSION=1`: a kept tree counts its builds into the banner otherwise). Command line: `console=ttyAMA0 quiet`; 64 MiB | the introduction's first screen (`web/app/intro/guest-worker.ts`), `tests/intro-guest.test.ts`, `bench/demo/` (`waarm64-intro-guest`, `intro-firefox.ts`) |
| `debian` | the official `debian-13-nocloud-arm64` qcow2 (20260914-2601), pinned by build date and SHA512 (`images/debian.json`) and served as published; the kernel (6.12.107) as `target/images/debian/disk.qcow2` (a link to the download: nothing is taken out of it), the same code `npm start` runs | the page's Debian tests |
| `edk2` | **EDK2 edk2-stable202608** (commit `2970e5699ba6`, submodules as pinned by it): `ArmVirtPkg/ArmVirtQemuKernel.dsc`, RELEASE, GCC, `NETWORK_ENABLE=FALSE`, as `QEMU_EFI.fd` (3 MiB: an arm64 `Image` entered like a kernel with the DT in x0) and `LICENSES.txt` (EDK2's BSD-2-Clause-Patent, OpenSSL's Apache-2.0, libfdt's BSD-2-Clause: the binary is distributed). Built natively in Debian's arm64 container (pinned digest, apt from snapshot.debian.org), ~1 min. **Reproducible:** BaseTools draws a random stack cookie per module into `StackCookieValues{32,64}.json` and picks by `hash(GUID)`; the build writes both lists from a fixed seed and sets `PYTHONHASHSEED=0` (the cookies are public in the binary either way). Also `shell.img`, the firmware tests' disk: 8 MiB of FAT (no partition table; a fixed volume ID, every timestamp `SOURCE_DATE_EPOCH`) with the build's UEFI Shell as `\EFI\BOOT\BOOTAA64.EFI` and `images/edk2/startup.nsh` | `tools/uefi-oracle.ts`; the firmware configuration's tests ([testing.md](testing.md)); M8 phase B's firmware boots ([firmware.md](firmware.md)) |
| `agent` | **the guest agent** (the clock, clipboard sharing), `waarm64-agent` (`agent/`, its own crate and toolchain: docs/devices.md "The guest's agent"), a static `aarch64-unknown-linux-musl` binary (`opt-level="z"`, LTO, `panic=abort`, stripped) linked by `rust-lld` with the target's own musl, built natively in the Rust project's Alpine image (`rust:1.99.0-alpine3.24`, pinned digest; the repository mounted at `/src`, the crates' cache under `target/images/build/agent`, so the binary doesn't depend on the checkout's path: it rebuilds bit for bit). ~5 s once the image is pulled (~1 GiB, the first time). **The one image with a fallback:** without Podman (`command -v podman`), the host's cargo builds it the same way (`rustup` installs `agent/rust-toolchain.toml`'s 1.99.0 with the musl target; `rust-lld` links it, so no cross gcc) and writes `HOST-BUILD` beside it: a build for tests, which `npm run dist` refuses and `npm start`, `npm run serve` and the tests take; its `.inputs` key says which way it was built, so where Podman is a host build is stale. Where Podman exists the fallback is never taken (no switch). `no_std` (`agent/src/rt.rs`: musl's `main`, `malloc` and `exit`), its unwind tables dropped at the link (`agent/no-unwind.ld`): 203,552 bytes (docs/clipboard.md "What it costs"). Beside it `waarm64-agent.gz`, what the page ships: zopfli's gzip (`AGENT_TOOLS`, apk'd in the same image as root, which rootless Podman maps to the user; 120,101 bytes, bit for bit too), `gzip -9n` without Podman | the page (a firmware machine with the agent on: web/app/guest-agent.ts), `tests/page-agent.test.ts` |
| `venus` | **Vulkan's renderer**, `venus.wasm` and its licences (`LICENSES.txt`; vk/README.md), not a guest image either: `vk/build.sh` in Node's Debian image (`node:26.13.0-trixie-slim`, pinned digest: Node for `vk/gen.ts`), with meson, ninja, glslang and Mesa's other build tools from snapshot.debian.org (`VENUS_SNAPSHOT`, as `edk2`), the repository mounted at `/src` and the work tree (wasi-sdk, Mesa, virglrenderer, the native and wasm builds) kept under `target/images/build/venus` (`VK_WORK`) for the next build. It rebuilds bit for bit. A few minutes from nothing on the dev VM, ~1 min after a change in `vk/` (the native builds kept). Its key takes `vk/build.sh --inputs`. After the build, `images/build.sh venus` also installs both files in `target/vk/` with vk/build.sh's stamp (`venus.wasm.inputs`), over whatever vk/build.sh left there: that is where the page, `npm run dist` and the tests take the module. A build by `vk/build.sh` on the host has the same objects and differs only in the paths it holds | `npm start`, `npm run dist` (docs/frontend.md "`npm start`" 5d); vk/build.sh's own builds serve the tests |
| `alpine-uefi` | Alpine's published UEFI cloud images, pinned by SHA512 (`images/alpine-uefi.json`) and served as published: `alpine.qcow2` (3.24.2 tiny, Limine) and `alpine-grub.qcow2` (3.24.1 generic UEFI tiny, GRUB), downloaded **on the host** (Node, `tools/debian.ts`'s downloader), hard links into the download cache | `tests/uefi.test.ts` (`WAARM64_DISTROS=alpine-uefi`); `tests/page-alpine-agent.test.ts` (ci-net.sh: the guest agent installed from fw_cfg, a template restored; devices.md "On OpenRC") |
| `alpine-demo` | **The Alpine demo's disk** (barebones, like unkernel's: the user's call, 2026-11-19; built from the pinned cloud image rather than the minirootfs, so nothing from the live repositories goes in and it's reproducible): Alpine's published Limine cloud image (3.24.4 tiny, its own pin in `images/alpine-demo/base.json`, apart from `alpine-uefi`'s, which stays CI's stock guest; downloaded on the host as `alpine-uefi`'s are) taken apart in Alpine's arm64 container as its root (qemu-img, sfdisk and mtools pinned on the live repositories in `DEMO_TOOLS`, e2fsprogs from the ISO's) and cut to **Alpine's base**: `apk del` of what the cloud image adds (`DEMO_DEL`: tiny-cloud, chrony, dhcpcd, doas, dosfstools, mount, nvme-cli, openssh, sgdisk, tzdata), leaving alpine-base, e2fsprogs, linux-virt and Limine, nothing installed from the network. Added (`images/alpine-demo/`): root logged in on the serial console (`inittab`: `login -f root` on ttyAMA0 with `TERM=xterm-256color`, the page's terminal, getty on tty1), `eth0` by DHCP through BusyBox's udhcpc (`interfaces`; `-t 3 -T 2 -A 3`: while it has no lease it asks every few seconds, not busybox's 20 s, so a template restored onto a network has an address ~10 s after it runs), `repositories` with `main` and `community` commented out (unkernel measured `apk` ~4× faster with `main` alone), a **command-not-found hook** for BusyBox ash (`/etc/profile.d/command-not-found.sh`: `command_not_found_handle` looks the name up with `apk search -q -x cmd:<name>`, in main and then community, which it enables when a command needs it, installs the package and runs the line typed again when it is the command alone (with plain-word arguments; else it says to run it again), taken from the shell's `history`, in a child shell; ash gives the hook the name alone; in a script or a subshell it says to run the command again; no pipelines or `$(builtin)` in it, which hang in ash 1.37's hook), the `motd` (what to try, what the demo network reaches, `curl http://192.168.127.1/status`), the guest agent's OpenRC service (`/etc/init.d/waarm64-agent`, `agentOpenrc()`'s text made on the host by Node, in the default runlevel), hostname `alpine`, no apk cache (the index is fetched at the first `apk`, ~0.5 MB for main); Limine's `limine.conf` with `timeout: 0` and the demo's command line (`init_on_free=1`: bench/demo/REPORT.md "DEMO loop 1"). Put together again on a **1 GiB** disk (GPT and filesystem UUIDs fixed, every time `SOURCE_DATE_EPOCH`): the EFI partition as published but `limine.conf`, the root a new ext4 of the rest; `alpine-demo.qcow2` (compressed, `qemu-img convert -m 1`: one coroutine, clusters in order) Its root uses ~75 MB of the ext4's ~835 MiB (3.24.4's EFI partition is 185 MiB, 3.24.2's was 96); mke2fs writes the inode tables and journal out (`lazy_itable_init=0`: a lazy init had the guest's first mount write 15 MB of zeros into a template's overlay). ~40 s; the file 62.1 MB, bit for bit | the Alpine demo's template (`tools/build-demos.ts`, which runs `bench/demo/make-template.ts`) |

Command lines: Buildroot `console=ttyAMA0 earlycon panic=-1 root=/dev/vda ro init=/init` (a
script after `--`: `/test.sh` by default, `/test-devices.sh`, `/test-input.sh`, `/test-rw.sh`,
`/ltp.sh`, `/bench-*.sh`); Alpine `console=ttyAMA0 root=/dev/vda rootfstype=ext4 modules=ext4 ro`
(`waarm64.phase=user|crypto` for alpine-user). Alpine gets 1 GiB.

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

**On demand only**, like the Arch image below: dEQP, the 3D correctness gate (graphics.md "Testing"). VK-GL-CTS
`opengl-es-cts-3.2.14.1` (Apache-2.0: built and run, nothing copied), `deqp-gles2` and `deqp-gles3` with EGL's
surfaceless target, built natively for Arch Linux in rootless Podman from `localhost/arch-base` (`images/arch/base.sh`;
`images/deqp/Containerfile`, ~10 min). Results: `target/deqp/deqp.ext4` (113
MiB: the binaries, their data and the GLES2/GLES3 mustpass lists under `/deqp`), the page's second disk for
`bench/gpu/deqp-run.ts`; and the image `localhost/waarm64-deqp`, which runs the same binaries on Mesa's virpipe against
the vtest oracle (`tools/virgl-oracle/deqp.sh`). It then makes the guest that runs them, `target/deqp/guest.qcow2`
(`images/arch/build.sh --packages "mesa libpng"`, ~4 min; `--guest-only` makes it alone), `scripts/ci-deqp.sh`'s. A case's capture (`CAPTURE=`) replays on Chromium with
`bench/gpu/virgl-pairs.ts`, which diffs each read-back with the next (dEQP's result and its reference). The surfaceless target takes EGL's default display:
`EGL_PLATFORM=surfaceless` picks it.
`images/deqp/venus-icd.sh [mesa tag]` (VK4 T24, ~2 min) builds another Mesa's Venus guest driver (26.3.0-rc3 by
default, which passed `maintenance8` on before the guest had 26.3) in a container of `localhost/arch-base` and puts it, with an ICD manifest, in
`/venus` of a copy of dEQP-VK's disk, `target/deqp/deqp-vk-venus.ext4` (debugfs: no root), for `deqp-run.ts`'s `DISK2`
and `GUEST_ENV` (testing.md "dEQP-VK").

## Vulkan programs' frames (`images/vkframes/build.sh`)

**On demand only**: the frames that check the Venus renderer's driver (vk/README.md "Checking frames"). Each program
in the script's list is captured with GFXReconstruct's layer on the dev VM's lavapipe (`tools/vulkan-tools/build-gfxr.sh`,
under a headless sway), its chosen frames replayed natively on lavapipe offscreen as the references, and
GFXReconstruct's replay is built for Debian 13 (arm64, at images/'s snapshot date) in rootless Podman
(`images/vkframes/Containerfile`, ~4 min the first time). Result: `target/vkframes/vkframes.ext4` (55 MiB: the replay,
`run.sh`, the captures and the references), the second disk of `tests/page-venus.test.ts` and
`bench/vulkan/venus-run.ts` (`REPLAY=`).

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
  of the base, `pacman -Syu` with `base linux e2fsprogs dosfstools sudo polkit` (polkit: logind's policy lets the active session
  power off and restart without sudo) and `--packages` (the mirror's packages of the
  day), the settings below, `--files` (a tree copied onto the root; a user's home made theirs) and `--setup` (a script
  run as root). The initramfs has no `autodetect` and lists `virtio_mmio virtio_blk ext4 vfat`
  (`/etc/mkinitcpio.conf.d/waarm64.conf`, so the guest's own kernel updates build the same). The rootfs goes into an
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
- **Networking in waarm64** needed the gateway's /32 lease mask: with the earlier 0.0.0.0 mask Arch's systemd-networkd
  logged `DHCP error: no netmask` and never configured IPv4 (found on ALARM, 2026-10-01); see [devices.md](devices.md) "net".
- **The `waarm64-va` package** (`images/arch/waarm64-va/`, built and checked by `images/arch/waarm64-va.sh` in a container of
  the base as a user would: `makepkg`, `pacman -U`; ~1 min): waarm64's VA-API driver, Mesa's virgl with NV12 decode
  surfaces only, AV1 film grain decoded into the shown surface and (version 3, VK2 L6) exported surfaces' objects
  sized by what their planes span (a Vulkan importer checks; vk/README.md "Imports"), `LIBVA_DRIVER_NAME=waarm64` for every session
  ([graphics.md](graphics.md) "Video"). `options=('!debug')`: Arch's `makepkg.conf` makes debug packages by default.
  Result `target/arch/pkg/waarm64-va-<ver>-aarch64.pkg.tar.zst`; not published anywhere.
- **The desktop guest** (`images/arch/desktop.sh [--out f.qcow2]`, on demand, ~8 min; audio S3): sway, foot, Firefox, Chromium (since 2026-10-22, graphics.md "The call queue"),
  htop, nano, lsof, PipeWire (WirePlumber, `pipewire-pulse`, `pipewire-alsa`), alsa-utils, mpv, libva-utils (`vainfo`),
  gtk4-demos (`gtk4-demo`, for `bench/gpu/gtk4-load.ts`), mesa-utils (`eglinfo`, `glxgears`), Mesa's Venus driver
  (`vulkan-virtio`) with vulkan-tools (`vkcube`, `vulkaninfo`: Vulkan on a machine with it, devices.md "Venus"; `VN_PERF=no_async_present` for every session: Mesa's async present drops frames, vk/README.md "The guest's Mesa") and `waarm64-va`
  (`EXTRA_PACKAGES` adds more, e.g. `gdb` for a debugging copy), Xwayland (sway runs it for X11 programs: Godot's editor picks X11 where `DISPLAY` is set, its Vulkan frames through Mesa's prime blit, vk/README.md "Presentation"; GD G7); sound is the kernel's own `virtio_snd` (udev loads it); Firefox's policies allow autoplay with sound and
  skip the first-run pages. A **20 GiB root**, mostly free, for packages installed by hand. `images/arch/media.sh`
  makes `/home/arch/media` in Podman (Alpine's ffmpeg): `avsync.webm` (a white frame and a 1 kHz beep each second,
  VP8/Opus, 60 s), `sintel.webm` and `sintel-silent.webm` (the Sintel trailer, Blender Foundation, CC BY 3.0,
  downloaded from download.blender.org with its sha256, as VP9/Opus 480p), `sintel_trailer-480p.mp4` (the trailer's
  original H.264 file: Chromium's H.264 path, graphics.md "Video's findings"), and `avsync.html` (plays `?v=<clip>`);
  `desktop-setup.sh` is the `--setup`. **sway as a conventional desktop** (2026-11-22, the user's call): the tree
  `images/arch/desktop/` copied onto the root, with `fuzzel` (the application menu) and `jq` (the taskbar's script)
  installed. `/etc/sway/config.d/60-waarm64.conf`, read after sway's stock config (whose keys it keeps): windows float
  (`for_window [all] floating enable`) and take the focus by a click; Firefox and Chromium open maximized, a floating
  window the screen's size (a tiled one stays below every floating window, clicked or not); no wallpaper
  (`swaybg_command -`); conventional keys on Alt, since a host's desktop keeps many Super keys (KDE's Super+Up moves
  the host's window), and none an application uses (Firefox's Alt+arrows and Alt+digits): Alt+F1/F2 the menu, Alt+F4,
  Alt+F9 minimize (to the scratchpad), Alt+F10 maximize or restore (`waarm64-maximize`; a title bar's right click too, its middle click closes: sway has no
  double click, and a floating window's title bar pressed starts a move whose release the move takes), Alt+Tab, Alt+drag and
  right-drag (`floating_modifier Mod1`), Ctrl+Alt+T, Ctrl+Alt+arrows and 1–4, Ctrl+Alt+Delete, F1; sway's Super keys
  stay too; a 4 px border, the floating windows' resize handle (`default_border` too: the rule floats windows that
  were made tiled, which keep the tiled border). The taskbar is sway's own bar (`bar-0`, at the bottom), its blocks from
  `/usr/local/bin/waarm64-bar` (i3bar protocol with click events; no GTK bar such as waybar, whose files a demo's
  remote disk would read before the desktop shows): Applications at the left end, a block per window (click: to the
  front, or minimized when in front, or back when minimized; middle click closes), the workspaces with more than one,
  the volume (`wpctl`: click mutes, the wheel
  changes it), the clock, Keys (`waarm64-keys`, `/usr/local/share/waarm64/keys.txt` in foot) and Power
  (`waarm64-power`, swaynag at the bottom edge on the overlay layer: at the top it moved every window down by its
  height). It draws on sway's window and workspace events, PulseAudio's sink changes, clicks and each minute, nothing
  in between (no CPU at idle, 2026-11-22; swaybar ~17 MB). swaybar draws its status from the right end, so the script fills the bar: each block
  has a width (`min_width`, its text cut to fit), a gap block takes what's left, and swaybar's own workspace buttons,
  binding mode and tray, whose width the script can't know, are off. `/etc/xdg/fuzzel/fuzzel.ini` puts the menu above the
  taskbar's left end; `/usr/local/share/applications/` hides helpers and test tools from it (`NoDisplay`). Result `target/arch/desktop.qcow2`; with `--kde`, `target/arch/desktop-kde.qcow2`
  (~20 min, 3.3 GB): KDE Plasma too (`plasma-meta`, `konsole`) and plasma-login-manager on the screen at boot
  (`plasmalogin.service`, the graphical target), for reproducing what KDE does (no test uses it); `bench/audio/avsync.ts` measures on it, and
  the page's session scripts (`bench/gpu/guest-session.ts`) log in as `arch` (`WAARM64_GUEST_USER=alarm` for an older
  Arch Linux ARM disk). `desktop.qcow2` is also the desktop demos' image (`arch-desktop`, `arch-3d`; in deploy/disks/demos.json: their templates resume a session on it, docs/remote-disks.md "Building the demos"): a new
  build of it is a new image (another content id), so those demos need new ids with `replaces`.

## Debian with a compiler (`images/debian-tools/build.sh`)

On demand, as the next section's: the pinned Debian with `gcc`, `libc6-dev`, `make`, `git` and `openssh-server` installed
by apt in QEMU (~5 min): `target/images/debian-tools/disk.qcow2`, what `tests/page-folders.test.ts` builds and commits in a
shared folder on, and what `tests/net-tailcat.test.ts`'s `tailcat ssh` logs in to (both skipped without it). Its SSH host
keys were made at the install, so every copy has the same ones: a test image, never one to expose.

## Debian with sway (`images/debian-sway/build.sh`)

On demand, as the one above: the pinned Debian with `sway` (1.10.1, wlroots 0.18.2), `wl-clipboard` (2.2.1) and `grim`
(1.4.0, the screenshots of the clipboard's image test), and for X11 `xvfb`, `xauth` and `xclip` (test-only)
installed by apt in QEMU without recommends (~2 min), then `images/debian-sway/setup.sh` run in the guest: the user
`user` (uid 1000, no password), logged in on tty1 at boot by getty (`--autologin`, a drop-in of `getty@tty1`), whose
`~/.bash_profile` there `exec`s a headless sway (`WLR_BACKENDS=headless WLR_RENDERER=pixman WLR_LIBINPUT_NO_DEVICES=1`,
its log `/tmp/sway.log`; `/tmp/no-sway` stops it starting) with a config of one line (no bar, nothing on a timer).
With `/tmp/x11` (which `tests/page-clipboard-x11.test.ts` makes before it ends sway: the next login takes it), the login
shell runs an X session instead, as startx makes one: a cookie added to `~/.Xauthority` by xauth, then
`Xvfb :1 -auth ~/.Xauthority -nolisten tcp` (its log and its end in `/tmp/x11.log`).
Its session is a tty's (`TYPE=tty`, seat0), as on the Arch desktop, so the clipboard agent's way to it is the real one;
sway's end ends the session and getty logs the user in again. `target/images/debian-sway/disk.qcow2`, what
`tests/page-clipboard.test.ts` and `tests/page-clipboard-x11.test.ts` run on (skipped without it). Its wlroots has `zwlr_data_control_manager_v1` but not
yet `ext_data_control_manager_v1` (0.19), so the agent's ext path is the Arch desktop's to check.

## Debian with Chromium (`images/debian-chromium/build.sh`)

**On demand only** (not `images/build.sh`, `SHA256SUMS` or CI): the disk of the complex-app benchmark
(`bench/apps/`, [benchmarking.md](benchmarking.md)). It boots the pinned Debian (`node tools/debian.ts` first)
in QEMU through our EDK2 (`tools/uefi-oracle.ts`, TCG, 4 vCPUs, 4 GiB, user-mode networking), points apt at
snapshot.debian.org at `images/Containerfile`'s date, installs `chromium` (153.0.8010.52, no recommends) and
`fonts-dejavu-core`, and writes the overlay flattened and compressed: `target/images/debian-chromium/disk.qcow2`,
732 MiB (3 GiB virtual, 1.1 GB free in the guest), in ~2 min. The page boots it with `?disk=`.

## The Go compiler on a second disk (`images/stress/build-goroot.sh`)

A real multi-thread compile load for the Debian guest; not part of `images/build.sh` or CI, built on demand (~1 min):
`target/images/stress/goroot.ext4`, 160 MiB (106 MiB used), a trimmed GOROOT (`go`, `compile`, `link`, `asm`, std
sources without tests; `go.env` has `CGO_ENABLED=0`, since the guest has no gcc) and `/work/{hello,web}` (the latter
imports `net/http`, `crypto/tls`, `encoding/json`: ~100 packages). The build proves the trimmed tree builds `web` cold
before packing. Natively a cold `hello` is 3 s wall and 6 s CPU.

The page serves it as the second disk (`?disk2=`, docs/frontend.md; `/dev/vdb`, ext4, read-only): `mount -o ro
/dev/vdb /mnt; GOROOT=/mnt/go GOCACHE=/tmp/gc GOFLAGS=-mod=mod /mnt/go/bin/go build -o /tmp/web /mnt/work/web` (module
cache and the work dir must be writable: copy `/mnt/work` to `/tmp`). Debian's `golang-go` package would need the
network and ~250 MB installed, the overlay's writes included. Its users: `bench/stress/stress.ts --disk2` (whose
harness logs the `GOBUILD rc=<n> <s>s` lines a guest loop echoes as `gobuild` events), `bench/stress/go-ab.sh`,
`bench/mem/memsample.ts` (`GO=1`) and `bench/gpu/warm-snapshots.sh`. A cold `go build` of `/work/web` alone takes
**349 s** on 4 vCPUs in Chromium (the dev VM); beside the stress test's own background loads, a long run's builds take
10 minutes or more each.

## Gotchas

- **Alpine keeps only the latest build of each package** (there is no snapshot archive), so pins on
  its repositories fail loudly once superseded; bump them deliberately (the image's bytes, and so a
  step count, change). A release's media (minirootfs, ISOs, netboot) stay on the mirror for good,
  so `alpine` comes only from them and the other Alpine images take what they can (`openssl`,
  `e2fsprogs`) from the virt ISO's repository first (`-X target/images/dl/alpine-3.24.2-iso/apks`).
  What remains on the live repositories: alpine-user's `xz`, `lua5.4`, `sqlite`, alpine-node's `nodejs`, and the build
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
- **The dev VM's clock steps backwards** (~110 ms, as often as every 10 s: `lima-guestagent`'s
  SyncTime sets it from the host while chronyd steers it too; the journal's "Time jumped
  backwards"), and make trusts mtimes: a Buildroot stamp can come out older than the one before it
  (busybox's `.stamp_patched` 22 ms before its `.stamp_extracted`), and a later `make` runs that
  step again. `build_ltp`'s second `make` (after the kselftests) rechecks every stamp, so `ltp`
  is the exposed one: on 2026-10-23 three of nine `ltp` builds failed (twice busybox's patches
  applied again, "duplicate filename"; once glibc's parallel `make install` remaking
  `linkobj/libc_pic.a` and racing itself, most likely the same cause), none of three `buildroot`
  builds. A failed build leaves the previous image: run it again. One time sync in the VM, not
  two, would end it; the kselftests in a post-build script (one `make`) would shrink it.
- Debian's published image is 95% compressed qcow2 clusters: it's served as is (deflate in the
  blk backend) rather than converted.
- Debian isn't built but prepared, so its `.inputs` key covers `images/debian.json` and
  `build_debian`; `SHA256SUMS` lists the disk.
  `tools/debian.ts` keeps its own stamp (`target/images/debian/.prepared`: the pin), from when `npm start` ran it
  (until 2026-10-17), which can't run `build.sh` (bash 4 syntax; macOS has bash 3.2).
