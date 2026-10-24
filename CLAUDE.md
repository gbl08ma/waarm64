# webpc

A whole-system AArch64 emulator for the browser. It JIT-compiles guest code to WebAssembly and
runs unmodified arm64 Linux. Chromium is the primary target.

## Where things are written down

- **`PLAN.md`**: the decisions that bind, the milestones (done, current, next) and the risks. When
  a decision changes, update PLAN.md (and the doc it affects) in the same change.
- **`docs/`** ([index](docs/README.md)): how things work now, by topic: architecture, cpu,
  platform, devices, abi, jit, v8, testing, benchmarking, images, backlog. Read the relevant page
  before changing an area; update it with the change. State what exists; keep history out unless
  it's a finding worth not re-discovering (then say what was tried and why it lost).
- `bench/*/REPORT.md`: dated measurement journals with committed JSON. Read `bench/spike/REPORT.md`
  and [docs/v8.md](docs/v8.md) before designing JIT, dispatch or TLB code.
- `THIRD_PARTY.md`: verified licenses of reference projects and the attribution of ported code.
- `M<n>-KICKOFF.md` and `M<n>-*-HANDOVER.md` in the repo root, **tracked** (so a fresh clone or a
  cloud session has them): the user's brief for the current milestone (or phase), and the notes
  that carry work from one session to the next. Only the current milestone's live there: commit a
  handover with the work it describes, and delete a superseded handover, and a finished
  milestone's kickoff, in the commit that supersedes it (git history keeps them). A kickoff's
  content is the user's: change it only with their OK.

## Status

M0–M7 are done (the summary table is in PLAN.md §3): the interpreter, the golden corpus, Linux
with virtio devices, Alpine and Debian, a JIT that boots Alpine in ~10 s in Chromium, the crypto
extensions, SMP on a GICv3 (deterministic round-robin for tests, a worker per vCPU for users).
**Current:** M8, a usable machine (PLAN.md §3). Phase A (the interactive machine: `npm start`, the
page in `web/app/`, [docs/frontend.md](docs/frontend.md); since 2026-10-17 it starts no disk image: the user opens one, and Debian is the tests' guest, `?machine=debian`, `images/build.sh debian`) and phase B (your own disk: unmodified
images through UEFI, disk in and out, changes back in; [docs/firmware.md](docs/firmware.md))
are done; of the C tracks, networking is done up to its loose ends ([docs/plans/networking.md](docs/plans/networking.md)); its Rust client is done (a light replacement for the Go one, how it works in [docs/tailnet.md](docs/tailnet.md): tailcat on the page, Debian through it, the VM as a tailcat server, the Network wizard; Tailscale's control session, the kept node shared with the Go client and the data plane; the page's Tailscale client; the Go one left the page, `net/tailscale` stays as a test fixture; loose ends in docs/backlog.md "Network"; **peer-to-peer rooms over WebRTC are proposed**, [docs/plans/networking-p2p.md](docs/plans/networking-p2p.md); **a local network helper is proposed** (a Go program of ours on the user's computer, over gvisor-tap-vsock, reached by a WebSocket on loopback; [docs/plans/networking-local.md](docs/plans/networking-local.md)); **several network adapters per machine, on connections kept by the browser, are done** ([docs/network-adapters.md](docs/network-adapters.md); loose ends in docs/backlog.md "Several adapters' loose ends")) and snapshots are done (save and load a machine as a file, Suspend: [docs/plans/snapshots.md](docs/plans/snapshots.md)), and graphics has its 2D display (virtio-gpu, G0 and G1; how it all works now in [docs/graphics.md](docs/graphics.md), the decisions and what's open in [docs/plans/graphics.md](docs/plans/graphics.md)); 3D comes through virgl onto WebGL2 (plans/graphics.md §1): G2 measured virgl's guest side, and G3 built the WebGL2 renderer, now the page's default where WebGL2 is; G4 (breadth and correctness: Firefox, GTK4, dEQP's whole GLES2/GLES3 lists passing) is done; of G5, snapshots while 3D is in use (Firefox, GTK4 and sway saved and loaded on the desktop guest) and dEQP on the Mac's GPU (four fixes; what still differs is Metal's) are done, the rest open items (docs/backlog.md: dEQP on more platforms, GtkGLArea's offload). **Video is done** ([docs/plans/video.md](docs/plans/video.md): VA-API over virgl decoded by WebCodecs; V0's gates passed, V1 decodes on the page; V2 measured Firefox on it (what it drops is the guest's CPU); V3 offers H.264 where the browser decodes it only in software too; Firefox's cost and pacing measured (the bursts: the guest's CPU, and the host's JIT installs stopping every vCPU, which the JIT's compile worker has since taken off the vCPUs); seeking, size changes, decoder errors and snapshots checked (video.md §9); AV1 decoded on the host (§10); HEVC dropped, §11). Audio is done ([docs/audio.md](docs/audio.md): virtio-snd played by an AudioWorklet, every page machine has a sound card; Debian and the desktop guest (`images/arch/desktop.sh`: Arch Linux from arch.bens.haus's aarch64 port, PipeWire, Firefox) play in sync and record through the page's microphone, opened when the guest records; snapshots while sound plays). **USB is done** ([docs/usb.md](docs/usb.md): an xHCI, WebUSB passthrough, WebHID as an emulated HID device, the page's USB tab, a built-in USB keyboard that gives the firmware real keys; checked on the user's devices; isochronous transfers left out; loose ends in docs/backlog.md "USB"). The page is deployed at `https://vm.tny.im` (`npm run dist`); **remote disks are done** ([docs/remote-disks.md](docs/remote-disks.md), bench/remote-disk/REPORT.md: a block cache kept in OPFS, a chunked format for any static host, parallel reads, a boot's reads fetched ahead; the desktop guest from a remote server to Firefox 196 → 65 s, a local file's time; loose ends in docs/backlog.md "Remote disks' loose ends"), and phase D started with **machines as the unit**, done ([docs/plans/machines.md](docs/plans/machines.md): built in a cloud session, L0–L5, §11; the dev VM's pass and the user's by hand; loose ends and its unmeasured numbers in docs/backlog.md "Machines as the unit"); **guest RAM past memory 0** is done ([docs/spill-memories.md](docs/spill-memories.md): spill memories the guest sees as CPU-less NUMA nodes, up to 16 GiB on the page; the guest keeps those pages cold until its active set outgrows memory 0; **the JIT's spill arm** (2026-10-24) reaches spill memory 1 inline, so node 1 runs at 1.0–1.6× node 0's time (2–17× before; nodes 2 and up still go through the helper; +15% JIT code on spill machines, none on others); `HEAP_FLOOR` stays 1 GiB (the heap reaches ~600 MiB)). The JIT's side track for a browser's code (no handover open): the code cache is 320 MiB since 2026-10-20, so
Firefox's page loads don't flush, and a machine sets its own (the JIT cache in its Settings, `?jitmb=`); the page keeps a
memory signal (docs/jit.md "The page's memory signal": what the tab costs by the emulator's accounting, and a tab
killed with its machine running is noted at the next start, which offers a smaller cache or less RAM); carrying the
hot set across a flush and an adaptive budget were tried and not kept (docs/jit.md). **The block interpreter's speed** is done (2026-10-22; judged by its own MIPS, so the compile threshold can rise
and less code reaches V8; docs/cpu.md "The block interpreter", bench/interp/REPORT.md "M8-INTERP loop 0" to "loop
13"): a call-free hot loop over 8-byte micro-ops with handlers for the common integer, load/store, exclusive, barrier
and plain system forms (the interpreter alone 249 → 467 MIPS on the user-mode guest, 122 → 210 on Alpine's boot; the
decoded blocks of Firefox's pages session 381 → 208 MB), the threshold's floor at 1000
and its maximum at 2000 under the cache's pressure; a browser's FP handlers and one decoded-block store for every
table measured and not kept; what x86_64's atomics cost and a per-block compile policy in docs/backlog.md
"Interpreter". **The JIT cache's lock, round two** is done (a miss no longer waits for it, and CTR_EL0 reports 2 KiB instruction
cache lines, so guests issue 2 ICs a page; docs/jit.md "Sharing", bench/boot/REPORT.md). **Self-hosted debug** is
done (2026-10-23; docs/cpu.md "Self-hosted debug": breakpoints, watchpoints and single step in a debug interpreter the
dispatcher picks for an armed EL, its test the same instructions as before; kvm-unit-tests' `debug-*` pass). Loose ends go in
[docs/backlog.md](docs/backlog.md), not in TODOs.

## Development environment

Development happens in the Lima VM **`dev`** on the M4 Mac mini (`macmini.lan`: 10 cores, 24 GiB,
macOS 26), not on the x86_64 desktop (which the user needs for other work).
- openSUSE Tumbleweed aarch64, Lima `vz`, 8 vCPUs, 14 GiB, 150 GiB disk, no host mounts, from
  `template:experimental/opensuse-tumbleweed` with Lima's containerd off. Home is
  `/home/gabriel.guest`; the repo is `~/Development/webpc` (remote `origin` on GitHub).
- From outside: `ssh macmini.lan /opt/homebrew/bin/limactl shell dev`. Inside, `macmini.lan`
  points at the Mac host (`~/.ssh/config`). The `oracle` VM (Debian 13, 4 vCPUs, 8 GiB) shares the
  Mac: `ssh macmini.lan /opt/homebrew/bin/limactl shell oracle <cmd>`.
- Packages from zypper: Node 26, Chromium 153 (`/usr/bin/chromium`), clang/lld/llvm, qemu (user,
  system, tools), podman (rootless), dtc, capstone, qemu-uefi-aarch64 (EDK2 for the UEFI oracle), mtools, dosfstools, dejavu-fonts (headless Chromium draws no page
  text without a font: screenshots of the page need it); Rust through rustup and `rust-toolchain.toml`.
  qemu-hw-display-virtio-gpu (QEMU's virtio-gpu device is a separate package) and edid-decode (graphics oracle);
  for the virgl oracle virglrenderer-test-server (`virgl_test_server`, vtest),
  Mesa-demo (`eglinfo`, `es2_info`) and Mesa-libGLESv2-devel, Mesa-libEGL-devel, Mesa-KHR-devel (glcomp builds natively); glmark2, xvfb-run (glmark2-es2 on virpipe under Xvfb), meson, ninja, libepoxy-devel, libdrm-devel, libgbm-devel (a debug virglrenderer for the oracle, docs/graphics.md "Tools"), sway and foot; dash (tests/keyboard.test.ts runs the keyboard script under it); qemu-ui-opengl is installed but QEMU's
  `virtio-gpu-gl` can't run (no DRM render node in the VM: docs/graphics.md "Findings").
  Add what's missing with `sudo zypper in`, and note it here.
- **USB rigs** (docs/testing.md "USB"): the VM runs `kernel-default` (7.2.9) with `kernel-default-devel`, so
  `tests/usb/gadget.sh install` can build `dummy_hcd` out of tree (openSUSE doesn't ship it; the source comes from
  kernel.org's stable tree for the running version) into `/lib/modules/<kver>/updates/`. Run it again after a
  kernel update. It also installs `/etc/udev/rules.d/70-webpc-usb.rules` (the 0525 gadgets' usbfs nodes, `/dev/uhid`,
  uhid's `hidraw` nodes and the ACM gadget's `/dev/ttyGS*` open to the user), `/etc/modprobe.d/50-webpc-usb.conf` (blocks `usbtest` and `cdc_acm`
  on the host, so the gadgets stay free) and Chromium's managed policy
  `/etc/chromium/policies/managed/webpc-usb.json` (WebUSB grants the 0525 gadgets, and WebHID every HID device, to
  `http://127.0.0.1:8190`–`8197`). `qemu-hw-usb-host` (QEMU's `usb-host`, for `tests/usb/oracle.sh`): installing
  it moved QEMU from 11.1.1 to 11.1.2 on 2026-10-18, while `qemu-linux-user` (the corpus oracle) and `qemu-img` stay at 11.1.1.
- **Go** (from zypper; `net/tailscale/go.mod` pins the toolchain) builds the Go Tailscale client, `net/tailscale/build.sh` (no longer the page's: a test fixture, tests/ts-tailnet.test.ts's hand-over), and the tailcat rig. The networking tests' headscale and peer run in rootless Podman: `tests/net/tailnet.sh up|down`. Never Docker in scripts or CI.
- Deploying the page and the disk images' host `vmdisks.tny.im` (`deploy/disks/`; only when the user asks; images never on R2: docs/remote-disks.md): wrangler in `~/.local/bin`, the Cloudflare token in
  `~/.config/cloudflare/webpc.env` (never print it); docs/frontend.md "Deployed at vm.tny.im".
- Dev-only tools (not repo dependencies, not in tests or CI): `perf` (with V8's `--perf-prof`;
  `perf_event_paranoid` is 2, so profile your own processes) and `wasm-tools` (`cargo +stable
  install --locked wasm-tools`, in `~/.cargo/bin`). Node's `--print-wasm-code` prints V8's machine
  code without either.
- Side checkouts: `../webpc-exp` and `../webpc-base` (detached worktrees for A/B experiments).
- Benchmark numbers from the x86_64 desktop (M0 to M5 step 7) aren't comparable with the VM's.

**Cloud sessions** (Claude Code on the web) are a secondary path: an Ubuntu x86_64 container without
Lima, Podman or the macOS oracles. `scripts/cloud-setup.sh` (a SessionStart hook in
`.claude/settings.json`, a no-op elsewhere) installs Node 26 and dtc 1.7.2, points `CHROMIUM` at
Playwright's Chromium and sets `NODE_USE_ENV_PROXY=1`. There `systemd-run` doesn't work (run under
`timeout` only), and guest images other than Debian can't be built. Details: [docs/cloud.md](docs/cloud.md).

## Commands

```sh
scripts/ci.sh                  # what every change runs (~6 min): fmt, clippy, cargo test, TestFloat, wasm build, tsc, svelte-check, Node + Chromium tests, image tests, the long multi-vCPU runs
scripts/ci-net.sh              # the network tests on Debian (~4 min): also when a change touches the network (docs/testing.md)
scripts/ci-debian.sh           # Debian on the page (~3.5 min): also for the page, firmware, devices, disks, snapshots, display, guest-visible changes, track ends (docs/testing.md)
scripts/ci-machines.sh         # machines as the unit on Debian (~3.5 min): also for stored machines, their disks (stored, blank, ramdisk, overlays), their snapshots, the Machines page, track ends
scripts/ci-audio.sh            # the realtime sound tests on the page (~1 min, alone): also when a change touches sound (docs/testing.md)
scripts/ci-deqp.sh             # dEQP's pass lists on the page (~6 min): also when a change touches 3D (renderer, translator, caps, GPU worker), graphics track ends; needs images/deqp/build.sh
scripts/ci-usb.sh              # USB through the dev VM's host rigs (dummy_hcd gadgets, uhid; alone): also when a change touches USB; "skipped: <why>" without the rigs (docs/testing.md "USB")
scripts/ci-fp.sh               # the FP suite in the guest (~3 min): TestFloat through every FP form under the JIT; also when a change touches floating point (the JIT's FP, the FP core); needs images/build.sh linux fptest
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
images/build.sh [name...]      # guest images in rootless Podman -> target/images/<name>/ (--check <name>); docs/images.md
node tools/corpus/run.ts [--oracle qemu|m4|both] [group...]    # regenerate golden corpus groups (QEMU / the M4 oracle VM)
scripts/tsan.sh                # ThreadSanitizer on the native parallel SMP runner (in ci.sh)
WEBPC_PARALLEL_RUNS=20 cargo test --release --test baremetal baremetal_parallel   # parallel SMP, repeated
(cd core/fuzz && cargo run --release --bin sweep [-- sys])      # decoder sweep vs Capstone (~3 min; sys: seconds)
(cd core && cargo fuzz run virtqueue)                           # libFuzzer on the virtio transport
tests/baremetal/build.sh && tests/baremetal/oracle.sh [--hvf]  # rebuild the bare-metal tests, run them on QEMU (TCG or hvf)
node tools/uefi-oracle.ts debian alpine alpine-grub          # unmodified images through our EDK2 (images/build.sh edk2) on QEMU
tests/usb/gadget.sh up|down|status [zero acm zero-a zero-b]   # the dummy_hcd gadgets (once: tests/usb/gadget.sh install)
tests/usb/oracle.sh [--trace] [--tests 1,2]                  # the linux-usb guest's testusb on QEMU's qemu-xhci + usb-host on Gadget Zero
node tests/usb/hid-record.ts   # re-record Chromium's parse of the uhid rig's devices (tests/usb/hid-fixtures/) when Chromium moves
node bench/usb/run.ts 5        # WebUSB's per-transfer cost and bulk throughput from a worker, against Gadget Zero (bench/usb/)
scripts/testfloat.sh           # FP core vs TestFloat 3e (in ci.sh)
tests/qcow2/make.sh            # regenerate the qcow2 fixtures with qemu-img
npm start                      # what a user runs: checks, npm ci, wasm core, the tailnet client, the UEFI firmware (images/build.sh edk2, Podman), the page's build, then serves it; the page waits for the user's disk (docs/frontend.md)
npm run dist                   # the page built (Vite) as static files for any web server -> target/dist/ (no guest images; docs/frontend.md "A static copy")
npm run serve                  # Vite's dev server with COOP/COEP and hot reloading on :8080 (PORT overrides); builds the tailnet client first if missing or stale (net/ts)
net/tailscale/build.sh         # the Go Tailscale client, the hand-over test's fixture -> target/net/tailscale.wasm (tools/tailscale.ts does it when needed)
net/ts/build.sh                # the Rust tailnet client (tailcat, and Tailscale: the page's default) -> target/net/ts.wasm (wasm32-wasip1; docs/tailnet.md)
node bench/net/tailcat.ts <tc… address> 5   # it against a tailcat exit node on this machine: startup, RTT, echo throughput
node bench/net/clients.ts 5    # the Tailscale client in Chromium (the Podman tailnet): load, Running, RTT, throughput, the worker's memory and CPU
WEBPC_DISTROS=debian WEBPC_START_COLD=1 node --test tests/start.test.ts  # npm start on a fresh copy, building its own core
npm run bench -- --page bench/interp/index.html [--only jit_mips]       # small guests, CoreMark
npm run bench -- --page bench/boot/index.html --only boot_alpine_jit    # boots, userspace, openssl, I/O
bench/interp/build-coremark.sh # CoreMark -> target/bench/
node bench/boot/profile.ts     # PC-sampling profile of a boot, symbolized
node bench/spike/memory/run-all.ts   # M0.5 memory suite
```

The full benchmark list is in [docs/benchmarking.md](docs/benchmarking.md). **`scripts/ci.sh` must
pass before any piece of work is considered done** (and `scripts/ci-debian.sh` when it touches the page, the firmware, the devices, disks, snapshots or
the display, for guest-visible changes and at the end of a milestone or a track; `scripts/ci-machines.sh` when it touches stored machines, their disks or snapshots, or the Machines page; `scripts/ci-net.sh`
when it touches the network; `scripts/ci-audio.sh` when it touches sound; `scripts/ci-deqp.sh` when it touches 3D; `scripts/ci-fp.sh` when it touches floating point; `scripts/ci-usb.sh` when it touches USB). **Exception:** a change that only edits docs (`.md` files or code comments)
needs no CI run.

## Conventions

**Rust (core)**
- The nightly is pinned in `rust-toolchain.toml` (wasm threads need `-Zbuild-std` and
  `-Zllvm-target-feature=+atomics`, see `.cargo/config.toml`). Bump it deliberately and re-run the
  benchmarks; the core stays built **without `simd128`** ([docs/backlog.md](docs/backlog.md)).
- The core also builds natively, so logic is unit-tested with `cargo test`. Keep wasm-only code
  behind `cfg(target_arch = "wasm32")`.
- SMP-ready: no mutable globals; all vCPU state behind a per-vCPU pointer; guest atomics use real
  atomics even single-core.
- Every `unsafe` block gets a `// SAFETY:` comment. Exports are `#[unsafe(no_mangle)] extern "C"`,
  and `ABI_VERSION` is bumped when they change ([docs/abi.md](docs/abi.md)).

**TypeScript (host, tools, tests)**
- No build step for Node: tools, tests and `bench/` run `.ts` directly. The page is built with **Vite**
  (`vite.config.ts`, Svelte's plugin; docs/frontend.md "The build"): the dev server (`tools/serve.ts`, the tests'
  and benchmarks') compiles per request, `npm run dist` and `npm start` bundle. Use **erasable syntax only** (no
  enums, namespaces or parameter properties; `tsconfig.json` enforces it). Import with `.ts` extensions, and npm
  packages as packages (no copied code or import maps). A worker is `new Worker(new URL('./x.ts',
  import.meta.url), { type: 'module' })` written out whole (Vite bundles only that form; options static).
- Stdlib and platform APIs first where they suit; past them, use a dependency. **Ask before adding one**: each is vetted
  (not too many, none redundant, none of known bad quality). Fewest dependencies isn't a goal in itself: an
  industry-standard set of dependencies and build steps beats a bespoke setup.
- Anything that runs in the browser must work with cross-origin isolation (COOP/COEP) on.

**Testing** ([docs/testing.md](docs/testing.md))
- New behavior comes with tests at the cheapest layer that catches it. Instruction semantics need
  golden-corpus coverage; JIT changes must pass the differential test, lockstep and the exact-step
  boots.
- Step counts live in `tests/steps.txt`; they move only with a guest-visible change, once, in its
  commit (and guest-visible changes need the user's OK).
- Plant a bug for every new JIT rule and check the tests fail; restore the source **and rebuild
  the wasm** afterwards.
- Oracles: `qemu-aarch64` in the dev VM; real hardware is the `oracle` VM. Don't depend on
  GitHub-hosted runners.

**Performance** ([docs/benchmarking.md](docs/benchmarking.md))
- Don't claim a speedup or regression without numbers from `bench/run.ts` in Chromium: medians and
  IQR (from the JSON), host and Chromium version; in one session's alternated A/B (≥3 rounds), a
  difference counts when the arms' rounds don't overlap and it's past ~1% (Buildroot's boot ~3%);
  across sessions the host moves runs by up to ~8% (docs/benchmarking.md "Rules").
- Commit the result JSON behind any written report; ad-hoc runs go to `bench/results/local/`.
- Compare A/B in one session, alternating; small guests at eight placements.
- Rank changes by the long, real workloads (Alpine, Alpine userspace); don't optimize for
  very short runs (the Buildroot boot is a check, not a target) or fit the design to CoreMark.
- Peer comparisons (QEMU, native) are rare, one-off tables; **qemu-wasm is dropped for good**.

**Guest images**: only in rootless Podman through `images/`; never cross toolchains or build
dependencies on the host; never Docker ([docs/images.md](docs/images.md)).

**Browsers**: Chromium only, headless through Playwright (`playwright-core`, temporary profile).
**Never touch Firefox outside the dev VM** (the user's daily browser is elsewhere); inside it, headless
Firefox through Playwright is fine for checks (docs/backlog.md "Firefox"), and its incompatibilities are never blockers. Never run `/usr/bin/chromium` directly except `--version` (it opens a window on
the user's desktop); for V8 flags use `node --v8-options`. A launcher whose Chromium decodes video passes
`env: chromiumEnv()` (`tools/nosme.ts`): the M4 under Lima has SME but no SVE, and Chromium's SME kernels fault
reading a decoded frame without the shim ([docs/testing.md](docs/testing.md), "Video over virgl").

**Licensing**: MIT. Check `THIRD_PARTY.md` before porting code; copy only from the permissive table,
keep headers, add an attribution row. GPL, EPL and CeCILL projects (QEMU, Unicorn, kvm-unit-tests,
LTP, risu, herdtools7) are oracles, guest workloads or behavioral references only: **never copy
their code.**

**Git**: push to `origin` (GitHub) so the user can pull. Don't add other remotes.

## Working rules (learned the hard way)

- **Bound every run.** Wrap ad-hoc experiments, guest runs and benchmarks in `timeout N`, know
  the expected duration first, and keep each command under the Bash tool's ~600 s cap (a command
  that overruns is backgrounded and can stall unseen: a hung benchmark once sat 17 minutes, an
  experiment 9). Bound every wait too; if a run's CPU or progress doesn't match its expected time,
  kill it and investigate.
- **Cap memory on heavy runs** (`npm test`, `scripts/ci.sh`, multi-machine experiments):
  `systemd-run --user --scope -q -p MemoryMax=10G -p MemorySwapMax=0 -- timeout N <cmd>`. A leak
  once grew a Node test process to 7 GB and the VM's OOM kill took the whole Claude session down
  (M8 loop 8); a capped scope dies alone. **Subagents cap every `node` and `cargo` run**, small
  ones too, with caps that sum under the VM's memory (a "pure TypeScript" unit test run uncapped
  with a planted bug reached 10 GB and killed the snapshots lane's first session), and tests
  never `assert.deepEqual` large buffers (a mismatch builds a diff of them): compare with
  `Buffer.compare` and fail with a short message.
- **Never `pkill -f`/`pgrep -f` a pattern that appears in your own command line**: it kills your
  shell (exit 144) or makes a wait loop wait forever. Find the PID and `kill <pid>`; wait on
  background jobs through their completion notification, not polling loops. Before a benchmark
  session, check `ps -eo pcpu,etime,args --sort=-pcpu | head` for leftover experiments.
- **Don't boot complex guests under the interpreter in Node or Chromium** (minutes each, nothing
  the native interpreter run doesn't test). Iterate on the Buildroot guest and Alpine under the
  JIT; Debian boots only through UEFI in Chromium (the page tests, ~1 min under the JIT), never natively, in Node or directly.
- Multi-hour JIT-stress runs aren't routine: short stress variants catch what they catch.
- **`scripts/ci.sh`, `scripts/ci-debian.sh`, `scripts/ci-machines.sh`, `scripts/ci-audio.sh`, `scripts/ci-deqp.sh`, `scripts/ci-fp.sh` and `scripts/ci-usb.sh` run alone, one at a time, in the background** (each is at or over the
  Bash tool's cap): start it, wait for its notification, and run no other Chromium, QEMU or benchmark work beside it (a contended run was cancelled by a
  timeout; a timing-sensitive unit test failed only under its load). `cargo fmt --all` first: it is CI's first step.
- `tsc` covers `bench/`, the git-ignored files under `bench/results/local/` too; `tests/browser.test.ts` pins the
  ABI number.
- Remove debug hooks that use `process` (e.g. module dumps in `web/vm.ts`) before any Chromium run.
- Temporary files go in the job's tmp directory; ad-hoc tools and results in
  `bench/results/local/`.
- Work through a milestone's loops without check-ins (one commit and a short report per loop);
  settle choices by measurement and ask only what can't be measured. The user is often watching:
  give short status lines during long runs.
