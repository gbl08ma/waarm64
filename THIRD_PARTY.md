# Third-party code and references

## Code in this repository derived from other projects

When porting or copying code, add a row here and keep the original
copyright/license header in the file.

| Our file(s) | Source project, file, commit | License |
|---|---|---|
| `core/src/a64/a64.inc` | dynarmic, `src/dynarmic/frontend/A64/decoder/a64.inc`, `a41c380246d3` (verbatim, header added). `core/build.rs` follows the match order of dynarmic's `a64.h` | 0BSD |
| `web/virgl.ts` (G2) | virglrenderer `c8e3fc3b`: the command and object names of `src/virgl_protocol.h` (`enum virgl_context_cmd`, `enum virgl_object_type`) and the field layout of `src/virgl_hw.h` (`struct virgl_caps_v1`/`_v2`) as tables; the caps' base values are virglrenderer's own output on a GLES 3.0 host (graphics.md §19) | MIT |
| `web/virgl-video.ts`, `web/video-h264.ts` (video, docs/plans/video.md) | Mesa 26.2.4 (MIT): the video commands' layouts (`src/virtio/virtio-gpu/virgl_protocol.h`), `struct virgl_video_caps` and the picture descs' field offsets (`virgl_video_hw.h`, measured with its compiler), `enum pipe_video_profile`'s values; nothing copied. The H.264 parameter sets are written from ITU-T H.264 §7.3.2 | MIT |
| `web/virgl-renderer.ts`, `web/virgl-tgsi.ts`, `web/virgl-formats.ts` (G3) | virglrenderer `c8e3fc3b`, rewritten in TypeScript for WebGL2 (no code copied verbatim): the command decoding and payload layouts of `src/vrend/vrend_decode.c` and `virgl_protocol.h`; the state model (contexts, sub-contexts owning the objects, resources attached to contexts, long shaders in pieces) and the GLES-host conventions of `vrend_renderer.c` (the front face inverted for guest resources, a negative viewport's y flip in the shader, BGRA stored as its bytes); the GLSL conventions of `vrend_shader.c` (registers as float vec4s holding bits, constants as `uvec4` bits, the fragment coordinate's origin flip); the GL formats and swizzles of `vrend_formats.c`'s GLES tables. The TGSI text grammar is Mesa's `tgsi_dump.c`/`tgsi_strings.c` as virglrenderer carries them | MIT |
| `net/tailscale/main_js.go` (N2) | the engine setup of Tailscale's `cmd/tsconnect/wasm/wasm_js.go` (v1.102.5), with our `Tun` device and JS API instead of the netstack-terminated sockets and ssh; header kept | BSD-3-Clause |
| `net/tailscale/overlay/controlhttp_client_js.go` (N2) | `tailscale.com/control/controlhttp/client_js.go` (v1.102.5), copied with one marked change (keep the control server's HTTPS port over WebSocket); `net/tailscale/build.sh` builds against a copy of the module with this file replaced | BSD-3-Clause |

## Techniques from papers and other projects (ideas, no code)

Reimplemented from the description, nothing copied; credited all the same.

| Where | Idea | Source |
|---|---|---|
| `core/src/crypto.rs` `Nested`, `core/src/jit/emit/crypto.rs` (M6.5) | AES SubBytes by "nested inversion" over the tower field GF(2⁴)[t]/(t² + t + ζ) with 16-entry lookups as vector permutes and an infinity flag; the formulas and field representation of section 3.3, implemented by us (tables generated at compile time) | Mike Hamburg, "Accelerating AES with Vector Permute Instructions", CHES 2009 (the paper; the technique behind OpenSSL's `vpaes`, whose code we didn't read) |
| `core/src/jit/emit/crypto.rs` `inv_mix_columns` (M6.5) | InvMixColumns as MixColumns after a multiply by 04 00 05 00 | Daemen and Rijmen, "The Design of Rijndael", 4.1.3 |
| `core/src/crypto.rs` `clmul32`/`clmul64` (M6.5) | Carry-less multiplication with integer multiplies of operands masked to every fourth bit ("multiply with holes"), so partial sums can't carry into the next bit of the same class; constant time without a carry-less multiply instruction | Thomas Pornin, BearSSL's `bmul` (`src/hash/ghash_ctmul.c`) and its "Constant-Time Mul" notes (bearssl.org), MIT |

## Runtime dependencies (npm)

| Package | Version | License | Use |
|---|---|---|---|
| @xterm/xterm | 6.0.0 | MIT | the page's serial terminal (`web/app/`); served from `node_modules` (only `lib/xterm.mjs` and `css/xterm.css`), not vendored |

## Go dependencies of the Tailscale backend (`net/tailscale`, N2)

Built to `target/net/tailscale.wasm` by `net/tailscale/build.sh`, loaded only when the user connects
to a tailnet. Modules linked into the wasm (`go list -deps`, checked 2026-09-29; `go.mod` pins the
versions), all permissive: `tailscale.com` v1.102.5 (BSD-3-Clause); `github.com/tailscale/wireguard-go`
(MIT); `gvisor.dev/gvisor` (Apache-2.0); `github.com/coder/websocket` (ISC);
`github.com/klauspost/compress` (BSD-3-Clause, Apache-2.0 and MIT parts); `github.com/gaissmai/bart`
(MIT); `github.com/golang/groupcache`, `github.com/google/btree`, `github.com/akutz/memconn`,
`go4.org/mem` (Apache-2.0); `go4.org/netipx`, `github.com/go-json-experiment/json`, `golang.org/x/{crypto,exp,net,sys,term,text,time}`
(BSD-3-Clause). Go's `wasm_exec.js` (BSD-3-Clause) is copied next to the module. Re-run the listing
when bumping the pin.

## Development dependencies (not distributed)

| Package | Version | License |
|---|---|---|
| playwright-core | 1.63.0 | Apache-2.0 |
| typescript | 7.0.2 | Apache-2.0 |
| @types/node | 26.6.2 | MIT |
| cargo-fuzz (installed tool) | 0.13.2 | MIT OR Apache-2.0 |
| libfuzzer-sys (`core/fuzz` only) | 0.4.13 | (MIT OR Apache-2.0) AND NCSA (bundled libFuzzer) |
| capstone / capstone-sys (`core/fuzz` only) | 0.14.0 / 0.18.0 | MIT; bundles Capstone 5.0 (BSD-3-Clause) |
| Berkeley SoftFloat 3e + TestFloat 3e (built under `target/testfloat` by `scripts/testfloat.sh`; `testfloat_gen` only) | `a0c6494cdc11` / `a9c849f1b0eb` | BSD-3-Clause |
| miniz_oxide (`core` dev-dependency: the native test runners' qcow2 reader, `core/tests/common/qcow2.rs`; default features off) | 0.9.1 | MIT OR Zlib OR Apache-2.0 |

## Benchmark workloads fetched at build time (not in the repository)

| Workload | Source, commit | License | How we use it |
|---|---|---|---|
| CoreMark | [eembc/coremark](https://github.com/eembc/coremark), `1f483d5b8316` | Apache-2.0, plus EEMBC's CoreMark Acceptable Use Agreement (the CoreMark trademark only for results of unmodified sources) | `bench/interp/build-coremark.sh` fetches it into `target/dl/coremark` and builds it unmodified with our own port layer (`bench/interp/coremark/core_portme.{c,h}`, MIT) into `target/bench/` (not committed, not distributed) |
| Mesa (G2's virgl guest) | [Mesa](https://mesa3d.org) 26.1.6 release tarball (`MESA_SHA256` in `images/build.sh`) | MIT | `images/build.sh alpine-virgl` builds it unmodified (llvmpipe and virgl) in Alpine's container into the benchmark image's `/opt/mesa` (`target/images`, not committed, not distributed) |

## Media in the repository (test fixtures)

| Our file(s) | Source | License | How we use it |
|---|---|---|---|
| `tests/virgl/video-h264.vglt.gz`, `video-vp9.vglt.gz`, `video-h264-orig.h264.gz`, `video.json` (video V1) | The Sintel trailer, © Blender Foundation (durian.blender.org), the 480p H.264 MP4 and a VP9 WebM made from it (`images/archarm/media.sh`) | CC BY 3.0 | The first 40 pictures of each, as the guest's FFmpeg sent them through VA-API (`bench/video/fixture.ts`), the original stream's first pictures and SHA-256 hashes of FFmpeg's decoded frames: the Chromium video tests' input and reference |

## Firmware we build and distribute (not in the repository)

| Binary | Source, commit | License | How we use it |
|---|---|---|---|
| `target/images/edk2/QEMU_EFI.fd`, and the UEFI Shell in `shell.img` (tests only) (`images/build.sh edk2`, M8 phase B) | [EDK2](https://github.com/tianocore/edk2) `edk2-stable202608`, `2970e5699ba6`, `ArmVirtPkg/ArmVirtQemuKernel.dsc` | BSD-2-Clause-Patent; linked in from its submodules: OpenSSL (Apache-2.0, in `Hash2DxeCrypto`) and libfdt (BSD-2-Clause, dual with GPL-2.0) | built with three small patches of ours (`images/edk2/*.patch`: the virtio-gpu as a console, the boot logo's progress bar, the GOP's flushes a frame at a time; they change EDK2's files, under its license) and run as the guest's UEFI firmware; served to users with `LICENSES.txt` (the three texts), as binary redistribution requires. No EDK2 code is copied into webpc's own code |

## Reference projects: verified licenses

Checked on 2026-09-25 against the upstream default branch at the commit listed.
Re-check at the commit you actually pin before copying anything.

**Permissive: code may be ported with attribution.**

| Project | Commit / version | License | Notes |
|---|---|---|---|
| [v86](https://github.com/copy/v86) | `5f9a90f2be01` | BSD-2-Clause | JIT architecture (wasmgen, block compilation and batching), 9p and its lazy HTTP filesystem, state save/restore, async HTTP disks; in-browser comparison target (i686) |
| [TinyEMU](https://bellard.org/tinyemu/) | 2019-12-21 tarball | MIT (per-file headers, `MIT-LICENSE.txt`) | `virtio.c`, `fs*.c` and `riscv_*` are MIT. `slirp/` has its own headers. `aes.c`, `sha256.c`, `fbuf.h`, `ps2.h` lack the MIT header, so check them individually. Compact virtio-mmio and virtio devices in C; JSLinux is an in-browser comparison target (riscv64) |
| [dynarmic](https://github.com/lioncash/dynarmic) | `a41c380246d3` | 0BSD | Repository **archived** 2024-03. The former upstream (merryhime/dynarmic) is gone. Fine as a read-only reference. The decoder's pattern table; IR design, A64 semantics, JIT techniques |
| [virglrenderer](https://gitlab.freedesktop.org/virgl/virglrenderer) | `c8e3fc3b` | MIT | The virgl protocol (`src/virgl_protocol.h`, `virgl_hw.h`), the host's command decoder (`src/vrend/vrend_decode.c`) and TGSI → GLSL translator (`vrend_shader.c`): G3's reference, porting allowed with attribution. A debug build with our capture patch (`tools/virgl-oracle/capture.patch`, a diff against `c8e3fc3b`, MIT like the file it patches) is the oracle (`tools/virgl-oracle/build.sh`, built into `target/`, not distributed) |
| [crosvm](https://github.com/google/crosvm) | `501fcaaa701d` | BSD-3-Clause | virtio devices (blk, net, gpu, input, snd), the `p9` crate, arm64 FDT, PSCI; `rutabaga_gfx` for graphics |
| [Firecracker](https://github.com/firecracker-microvm/firecracker) | `8ff4940e6a72` | Apache-2.0 | Needs NOTICE/attribution if code is copied. Minimal virtio-mmio model, arm64 FDT, direct kernel boot |
| [rust-vmm/vm-fdt](https://github.com/rust-vmm/vm-fdt) | crate 0.3.0 | Apache-2.0 OR BSD-3-Clause | Not used: `core/src/fdt.rs` is our own writer |
| [rust-vmm/vm-virtio](https://github.com/rust-vmm/vm-virtio) (`virtio-queue`, `virtio-bindings`) | virtio-queue 0.18.0, virtio-bindings 0.2.7 | virtio-queue: **Apache-2.0 AND BSD-3-Clause**; virtio-bindings: BSD-3-Clause OR Apache-2.0 | Repository **archived** 2026-09-11. Crates are still published. Not used: our own split queues (`core/src/virtio.rs`) |
| [gem5](https://github.com/gem5/gem5) | `f5c5a6e390f5` | BSD-3-Clause | GICv2/GICv3 and generic timer models (M7's per-CPU GIC) |
| [Berkeley SoftFloat 3e](https://github.com/ucb-bar/berkeley-softfloat-3) / [TestFloat 3e](https://github.com/ucb-bar/berkeley-testfloat-3) | `a0c6494cdc11` / `a9c849f1b0eb` | BSD-3-Clause (text in `COPYING.txt`) | TestFloat vectors (`scripts/testfloat.sh`); the FP core itself is ours |
| [Capstone](https://github.com/capstone-engine/capstone) | `9791930a895b` (`next`) | BSD-3-Clause (`LICENSES/`) | Some parts are LLVM-derived under their own license. We use it only as a tool: the decoder sweep, disassembly for debugging |
| [Sail ARM model](https://github.com/rems-project/sail-arm) | `1bf2e5574ba9` | BSD-3-Clause-Clear (per model directory) | The Clear variant explicitly grants no patent rights. Executable ISA model: the oracle for disputed corner cases |
| Arm A64 machine-readable spec (AARCHMRS JSON) | 2024-12 release | Arm publishes a "BSD license JSON" release, but its release notes defer to the Proprietary Notice inside the package | **Read the notice in the downloaded package before generating code from it.** Until then, dynarmic's 0BSD decoder table is the safe source |
| [Playwright](https://github.com/microsoft/playwright) | 1.63.0 | Apache-2.0 | |
| [Tailscale](https://github.com/tailscale/tailscale) | v1.102.5 | BSD-3-Clause | the client the networking backend is built from (above); its `tailscaled` image is the test peer |
| [headscale](https://github.com/juanfont/headscale) | v0.29.4 | BSD-3-Clause | the control server the networking tests run in rootless Podman (`tests/net/tailnet.sh`); never linked or distributed |

**Copyleft or other: use as oracle, guest workload or behavioral reference only. Never copy code.**

| Project | Commit | License | Use |
|---|---|---|---|
| [QEMU](https://gitlab.com/qemu-project/qemu) | `a97f90fcf802` | GPL-2.0 overall, per-file licenses (TCG mostly BSD/MIT) | `qemu-aarch64` and `qemu-system-aarch64 -M virt` as oracles and comparison; `hw/arm/virt.c` as the de facto platform reference |
| [Unicorn](https://github.com/unicorn-engine/unicorn) | `7c5db94191de` | GPL-2.0 | optional in-process fuzzing oracle (not used so far) |
| [kvm-unit-tests](https://gitlab.com/kvm-unit-tests/kvm-unit-tests) | master, 2026-09-25 | GPL-2.0 (many files LGPL-2) | guest-run system tests |
| [LTP](https://github.com/linux-test-project/ltp) | `f5bf852334d5` | GPL-2.0 | in-guest tests (with the kernel selftests) |
| [herdtools7](https://github.com/herd/herdtools7) | 7.58, `1ca343e16a20` | CeCILL-B (`asllib/` is BSD-3-Clause, © Arm) | built and run in the images container (`images/build.sh litmus`: `diyone7` makes the tests, `herd7` their allowed outcomes, `litmus7` the programs run in the guest and on the oracle VM); nothing copied (M7) |
| [risu](https://gitlab.com/pm215/risu) | `eed224965e7b` | EPL-1.0 | the methodology behind the golden corpus |
| [Buildroot](https://gitlab.com/buildroot.org/buildroot) | master, 2026-09-25 | GPL-2.0-or-later | building test and bench images |
| Linux kernel | — | GPL-2.0 | `booting.rst`, the DT bindings and the drivers as the spec our devices must satisfy |

Guest images we build and distribute (kernel, BusyBox, and so on) carry their own
licenses and obligations. Publish the Buildroot configs and point to the sources.
