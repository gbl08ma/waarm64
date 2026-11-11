# The development environment

Where development happens, what's installed and why, and every command worth knowing. CLAUDE.md keeps the
essentials and the CI scripts; this page has the rest. Cloud sessions differ: [cloud.md](cloud.md).

## The dev VM

Development happens in the Lima VM **`dev`** on the M4 Mac mini (`macmini.lan`: 10 cores, 24 GiB, macOS 26), not on
the x86_64 desktop (which the user needs for other work).
- openSUSE Tumbleweed aarch64, Lima `vz`, 8 vCPUs, 18 GiB, 150 GiB disk, no host mounts, from
  `template:experimental/opensuse-tumbleweed` with Lima's containerd off. Home is `/home/gabriel.guest`; the repo is
  `~/Development/webpc` (remote `origin` on GitHub).
- From outside: `ssh macmini.lan /opt/homebrew/bin/limactl shell dev`. Inside, `macmini.lan` points at the Mac host
  (`~/.ssh/config`). The `oracle` VM (Debian 13, 4 vCPUs, 4 GiB) shares the Mac:
  `ssh macmini.lan /opt/homebrew/bin/limactl shell oracle <cmd>`.
- The Mac host runs real-GPU benchmarks from `~/webpc-gpu-bench` (`bench/gpu/sway-mac.sh` copies what they need;
  nothing is installed there; its disk has little room: keep it small). Their browser is the current Stable Chrome
  for Testing, which `bench/mac-chrome.sh` (every `*-mac.sh` sources it) fetches into `~/webpc-chrome/<version>/` when
  Stable moves, not Playwright's own download: that lags Stable and is an early build of its milestone (153.0.8010.12
  read clobbered immediates in indirect dispatches, which 153's release didn't: GD G4). After every run on the Mac (not the VM's own CI,
  which can't use its GPU), `bench/gpu/mac-leftovers.sh` says the Mac's GPU utilization, its load and any Chrome for Testing no run owns
  (`--kill` ends those, by PID): a run that hangs the GPU leaves its browser behind (the harness's alarm ends node,
  not Chrome), and a GPU held at 100% throttles the whole Mac, the dev VM's CI with it (GD G4: five such browsers made
  CI's timing tests fail for an hour). A GPU process stuck exiting can't be ended: only a restart of the Mac frees it.
- Side checkouts: `../webpc-exp` and `../webpc-base` (detached worktrees for A/B experiments).
- Benchmark numbers from the x86_64 desktop (M0 to M5 step 7) aren't comparable with the VM's.

## Worktrees

A session's worktree (`.claude/worktrees/<name>`) has none of the main checkout's untracked trees, and the page can't
run on symlinks to them: Vite serves with `fs.strict`, which answers 403 for a file reached through a link out of the
worktree (pages then fail in ways that look like code bugs). **`scripts/worktree-setup.sh [worktree]`** makes one
ready: `node_modules` and `tools/lint/node_modules` copied, `target/images/*` and `target/deqp/*`
hard-linked (their builders delete or rename before writing, so a rebuild in the worktree never writes into the main
checkout's copy), except `target/images/build/`: `images/build.sh`'s work trees (kernels, Buildroot, venus's Mesa and
wasi-sdk), which `make` writes in place and which are partly owned by Podman's subordinate uids (so
`fs.protected_hardlinks` refuses links to them; the hook once failed on 18,000 such files); a worktree's image build
starts its own. An entry that can't be linked is left out with a warning, not a failure. And `package-lock.json`'s mtime set old while it is the main checkout's (git resets it at checkout,
and `scripts/ci.sh` runs `npm ci` when the lockfile is newer than `node_modules`; a branch that changed it keeps its
mtime, so CI installs the branch's packages). Idempotent, and it never replaces what's there. Not linked: Cargo's and Vite's outputs (the wasm
core, `venus.wasm`, `ts.wasm`), which a build could rewrite in place and which can be stale for the branch:
`scripts/ci.sh` builds them, and `scripts/build-wasm.sh` (and `vk/build.sh`) before a page test run alone.

It runs once, when the worktree is made: Claude Code's **`WorktreeCreate` hook**, `scripts/worktree-hook.sh
create` (`.claude/settings.json`). CI doesn't run it: a worktree's own changes to `node_modules` or the
lockfile are the work's. After a rebase resets the lockfile's mtime, `scripts/worktree-setup.sh` again saves CI an
`npm ci` (it's harmless either way). That hook replaces Claude Code's own `git worktree add`, so it does the same (the
worktree at `.claude/worktrees/<name>` on a new branch `worktree-<name>`, from origin's default branch after a
fetch) and then the setup; `scripts/worktree-hook.sh remove` is its `WorktreeRemove` (the worktree removed, its
branch kept). A worktree made with plain `git worktree add` gets the setup by hand.

## Packages

From zypper (add what's missing with `sudo zypper in`, and note it here):
- Node 26, Chromium 155 (`/usr/bin/chromium`: Tumbleweed's, the newest Chromium released for Linux arm64 there; keep
  it current with `sudo zypper in chromium`; Google builds no Chrome for Testing for Linux arm64), clang/lld/llvm, qemu (user, system, tools), podman (rootless), dtc,
  capstone, qemu-uefi-aarch64 (EDK2 for the UEFI oracle), mtools, dosfstools, dejavu-fonts (headless Chromium draws no
  page text without a font: screenshots of the page need it); Rust through rustup and `rust-toolchain.toml`.
- Graphics: qemu-hw-display-virtio-gpu (QEMU's virtio-gpu device is a separate package) and edid-decode (the graphics
  oracle); for the virgl oracle virglrenderer-test-server (`virgl_test_server`, vtest), Mesa-demo (`eglinfo`,
  `es2_info`) and Mesa-libGLESv2-devel, Mesa-libEGL-devel, Mesa-KHR-devel (glcomp builds natively); glmark2, xvfb-run
  (glmark2-es2 on virpipe under Xvfb), meson, ninja, libepoxy-devel, libdrm-devel, libgbm-devel (a debug
  virglrenderer for the oracle, graphics.md "Tools"), sway and foot, and wl-clipboard (the clipboard agent's native test
  against a headless sway, `agent/src/sway_test.rs`), and xclip (its X11 test against Xvfb, `agent/src/x11_test.rs`;
  Xvfb and xauth were there already). qemu-ui-opengl is installed but QEMU's
  `virtio-gpu-gl` can't run (no DRM render node in the VM: graphics.md "Findings").
- Vulkan, for VK0 (bench/vulkan/REPORT.md): vulkan-devel, vulkan-tools, vulkan-validationlayers, shaderc (glslc),
  spirv-tools, spirv-cross, Mesa-libGLESv3-devel, 7zip (unpacks the macOS SDK); for its tools (`tools/venus-oracle/`,
  `tools/vulkan-tools/`: Venus on lavapipe over vtest, GFXReconstruct, the Profiles layer) cmake, python313-Mako,
  python313-packaging, bison, flex, glslang-devel, libxshmfence-devel, liblz4-devel, xcb-util-keysyms-devel, gdb,
  wayland-protocols-devel (the oracle's Wayland WSI), valgrind (callgrind counts the guest's encoding); for question
  A's programs gtk4-devel-tools, vkmark, vkd3d-demos, vkquake, supertuxkart (mpv and ffmpeg 8 would move Chromium on:
  they were unpacked into target/vk0a/root instead). The Venus oracle needs `/dev/udmabuf` open to the user (lavapipe
  exports host-visible memory through it).
- dash (tests/keyboard.test.ts runs the keyboard script under it).
- **Go** (`net/tailscale/go.mod` pins the toolchain) builds the Go Tailscale client, `net/tailscale/build.sh` (no
  longer the page's: a test fixture, tests/ts-tailnet.test.ts's hand-over), the tailcat rig, and the local network
  helper, `github.com/gbl08ma/webpc-net` (its own repository, checked out at `../webpc-net`; its `go.mod` pins go1.27.3; **go1.27-race** too, or `go test -race` doesn't link: `relocation target
  __tsan_free not defined`). The networking tests'
  headscale and peer run in rootless Podman: `tests/net/tailnet.sh up|down`. Never Docker in scripts or CI.

## The USB rigs

testing.md "USB" has how they're used. The VM runs `kernel-default` (7.2.9) with `kernel-default-devel`, so
`tests/usb/gadget.sh install` can build `dummy_hcd` out of tree (openSUSE doesn't ship it; the source comes from
kernel.org's stable tree for the running version) into `/lib/modules/<kver>/updates/`. Run it again after a kernel
update. It also installs `/etc/udev/rules.d/70-webpc-usb.rules` (the 0525 gadgets' usbfs nodes, `/dev/uhid`, uhid's
`hidraw` nodes and the ACM gadget's `/dev/ttyGS*` open to the user), `/etc/modprobe.d/50-webpc-usb.conf` (blocks
`usbtest` and `cdc_acm` on the host, so the gadgets stay free) and Chromium's managed policy
`/etc/chromium/policies/managed/webpc-usb.json` (WebUSB grants the 0525 gadgets, and WebHID every HID device, to
`http://127.0.0.1:8190`–`8197`). `qemu-hw-usb-host` (QEMU's `usb-host`, for `tests/usb/oracle.sh`): installing it
moved QEMU from 11.1.1 to 11.1.2 on 2026-10-18, while `qemu-linux-user` (the corpus oracle) and `qemu-img` stay at
11.1.1.

## Deploying

The page and the disk images' host `vmdisks.tny.im` (`deploy/disks/`), only when the user asks; images never on R2
(remote-disks.md): wrangler in `~/.local/bin`, the Cloudflare token in `~/.config/cloudflare/webpc.env` (never print
it); frontend.md "Deployed at vm.tny.im".

## Dev-only tools

Not repo dependencies, not in tests or CI: `perf` (with V8's `--perf-prof`; `perf_event_paranoid` is 2, so profile
your own processes) and `wasm-tools` (`cargo +stable install --locked wasm-tools`, in `~/.cargo/bin`). Node's
`--print-wasm-code` prints V8's machine code without either. gdb can't run in the dev VM (the M4's SME/SVE registers
under Lima): use ASan builds and valgrind.

## Commands

The CI scripts, and when each must run, are in CLAUDE.md. The rest:

```sh
scripts/build-wasm.sh          # wasm core -> target/wasm32-unknown-unknown/release/webpc_core.wasm
cargo test                     # native core tests
npm test                       # JS tests (tests/**/*.test.ts, incl. Chromium; needs the wasm build)
WEBPC_CORPUS=dp_imm,dp_reg node --test tests/corpus-wasm.test.ts   # corpus groups only (fast JIT iteration)
node --test tests/jit-diff.test.ts                                 # JIT vs interpreter on random words (WEBPC_JIT_DIFF=<n>)
WEBPC_LOCKSTEP_STEPS=300000000 node --test tests/jit-lockstep.test.ts   # long lockstep (CI runs 20M)
WEBPC_DISTROS=alpine,alpine-user scripts/ci.sh   # which distro tests run (default: the current Alpine images; Debian is ci-debian.sh's)
WEBPC_INTERP=1 node --test tests/boot-node*.test.ts     # also the long guests' interpreter runs in Node
WEBPC_JIT_STRESS=1 node --test tests/boot-node*.test.ts # every Node boot under JIT-stress (hours; not routine)
cargo test --release --test boot -- --ignored --nocapture      # Buildroot natively (also: kvm_unit_tests, ltp, distros [alpine])
images/build.sh [name...]      # guest images in rootless Podman -> target/images/<name>/ (--check <name>); images.md
node tools/corpus/run.ts [--oracle qemu|m4|both] [group...]    # regenerate golden corpus groups (QEMU / the M4 oracle VM)
scripts/tsan.sh                # ThreadSanitizer on the native parallel SMP runner (in ci.sh)
WEBPC_PARALLEL_RUNS=20 cargo test --release --test baremetal baremetal_parallel   # parallel SMP, repeated
(cd core/fuzz && cargo run --release --bin sweep [-- sys])      # decoder sweep vs Capstone (~3 min; sys: seconds)
(cd core && cargo fuzz run virtqueue)                           # libFuzzer on the virtio transport
node tests/virgl-fuzz.ts [seconds] [first seed]               # virgl's stream decoder fuzzed (docs/testing.md "virgl fuzzing")
tests/baremetal/build.sh && tests/baremetal/oracle.sh [--hvf]  # rebuild the bare-metal tests, run them on QEMU (TCG or hvf)
node tools/uefi-oracle.ts debian alpine alpine-grub          # unmodified images through our EDK2 (images/build.sh edk2) on QEMU
tests/usb/gadget.sh up|down|status [zero acm zero-a zero-b]   # the dummy_hcd gadgets (once: tests/usb/gadget.sh install)
tests/usb/oracle.sh [--trace] [--tests 1,2]                  # the linux-usb guest's testusb on QEMU's qemu-xhci + usb-host on Gadget Zero
node tools/osk-keymaps.ts      # regenerate web/app/keymaps.ts (the on-screen keyboard's layouts) from xkeyboard-config; needs xkbcomp, xkeyboard-config, xorgproto's keysymdef.h
node tests/usb/hid-record.ts   # re-record Chromium's parse of the uhid rig's devices (tests/usb/hid-fixtures/) when Chromium moves
node bench/usb/run.ts 5        # WebUSB's per-transfer cost and bulk throughput from a worker, against Gadget Zero (bench/usb/)
scripts/testfloat.sh           # FP core vs TestFloat 3e (in ci.sh)
tests/qcow2/make.sh            # regenerate the qcow2 fixtures with qemu-img
npm start                      # what a user runs: checks, npm ci, wasm core, the tailnet client, the UEFI firmware (images/build.sh edk2, Podman), the page's build, then serves it; the page waits for the user's disk (frontend.md)
npm run dist                   # the page built (Vite) as static files for any web server -> target/dist/ (no guest images; frontend.md "A static copy")
npm run serve                  # Vite's dev server with COOP/COEP and hot reloading on :8080 (PORT overrides); builds the tailnet client first if missing or stale (net/ts)
node tools/screens.ts --label <name>   # screenshots of every page state without a guest (toolbar menus, Machines page wide and 720 px, dialogs, wizard steps) -> bench/results/local/screens/<name>/; --compare <other> --label <name>: what differs (frontend.md "Screenshots")
net/tailscale/build.sh         # the Go Tailscale client, the hand-over test's fixture -> target/net/tailscale.wasm (tools/tailscale.ts does it when needed)
(cd ../webpc-net && go test -race ./...)    # the local network helper, its own repository (its CLAUDE.md); go run . --origin http://127.0.0.1:8080 beside npm run serve
WEBPC_NET_SRC=../webpc-net node --test tests/page-local.test.ts   # webpc's tests against that checkout instead of the commit tests/webpc-net.ts pins
net/ts/build.sh                # the Rust tailnet client (tailcat, and Tailscale: the page's default) -> target/net/ts.wasm (wasm32-wasip1; tailnet.md)
node bench/net/tailcat.ts <tc… address> 5   # it against a tailcat exit node on this machine: startup, RTT, echo throughput
node bench/net/clients.ts 5    # the Tailscale client in Chromium (the Podman tailnet): load, Running, RTT, throughput, the worker's memory and CPU
WEBPC_DISTROS=debian WEBPC_START_COLD=1 node --test tests/start.test.ts  # npm start on a fresh copy, building its own core
vk/build.sh [native]           # Venus's renderer -> target/vk/venus.wasm (vk/README.md), with its stamp venus.wasm.inputs
images/build.sh venus          # the same in Podman (what npm start runs when the stamp is stale), installed in target/vk/
npm run bench -- --page bench/interp/index.html [--only jit_mips]       # small guests, CoreMark
npm run bench -- --page bench/boot/index.html --only boot_alpine_jit    # boots, userspace, openssl, I/O
bench/interp/build-coremark.sh # CoreMark -> target/bench/
node bench/boot/profile.ts     # PC-sampling profile of a boot, symbolized
node bench/spike/memory/run-all.ts   # M0.5 memory suite
```

The full benchmark list is in [benchmarking.md](benchmarking.md); the on-demand guest images and disks (Arch, dEQP,
Vulkan) in [images.md](images.md).
