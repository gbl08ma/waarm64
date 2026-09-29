# Third-party code and references

## Code in this repository derived from other projects

When porting or copying code, add a row here and keep the original
copyright/license header in the file.

| Our file(s) | Source project, file, commit | License |
|---|---|---|
| `core/src/a64/a64.inc` | dynarmic, `src/dynarmic/frontend/A64/decoder/a64.inc`, `a41c380246d3` (verbatim, header added). `core/build.rs` follows the match order of dynarmic's `a64.h` | 0BSD |
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

## Reference projects: verified licenses

Checked on 2026-09-25 against the upstream default branch at the commit listed.
Re-check at the commit you actually pin before copying anything.

**Permissive: code may be ported with attribution.**

| Project | Commit / version | License | Notes |
|---|---|---|---|
| [v86](https://github.com/copy/v86) | `5f9a90f2be01` | BSD-2-Clause | JIT architecture (wasmgen, block compilation and batching), 9p and its lazy HTTP filesystem, state save/restore, async HTTP disks; in-browser comparison target (i686) |
| [TinyEMU](https://bellard.org/tinyemu/) | 2019-12-21 tarball | MIT (per-file headers, `MIT-LICENSE.txt`) | `virtio.c`, `fs*.c` and `riscv_*` are MIT. `slirp/` has its own headers. `aes.c`, `sha256.c`, `fbuf.h`, `ps2.h` lack the MIT header, so check them individually. Compact virtio-mmio and virtio devices in C; JSLinux is an in-browser comparison target (riscv64) |
| [dynarmic](https://github.com/lioncash/dynarmic) | `a41c380246d3` | 0BSD | Repository **archived** 2024-03. The former upstream (merryhime/dynarmic) is gone. Fine as a read-only reference. The decoder's pattern table; IR design, A64 semantics, JIT techniques |
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
