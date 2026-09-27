# Third-party code and references

## Code in this repository derived from other projects

When porting or copying code, add a row here and keep the original
copyright/license header in the file.

| Our file(s) | Source project, file, commit | License |
|---|---|---|
| `core/src/a64/a64.inc` | dynarmic, `src/dynarmic/frontend/A64/decoder/a64.inc`, `a41c380246d3` (verbatim, header added). `core/build.rs` follows the match order of dynarmic's `a64.h` | 0BSD |

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
| [v86](https://github.com/copy/v86) | `5f9a90f2be01` | BSD-2-Clause | |
| [TinyEMU](https://bellard.org/tinyemu/) | 2019-12-21 tarball | MIT (per-file headers, `MIT-LICENSE.txt`) | `virtio.c`, `fs*.c` and `riscv_*` are MIT. `slirp/` has its own headers. `aes.c`, `sha256.c`, `fbuf.h`, `ps2.h` lack the MIT header, so check them individually |
| [dynarmic](https://github.com/lioncash/dynarmic) | `a41c380246d3` | 0BSD | Repository **archived** 2024-03. The former upstream (merryhime/dynarmic) is gone. Fine as a read-only reference |
| [crosvm](https://github.com/google/crosvm) | `501fcaaa701d` | BSD-3-Clause | |
| [Firecracker](https://github.com/firecracker-microvm/firecracker) | `8ff4940e6a72` | Apache-2.0 | Needs NOTICE/attribution if code is copied |
| [rust-vmm/vm-fdt](https://github.com/rust-vmm/vm-fdt) | crate 0.3.0 | Apache-2.0 OR BSD-3-Clause | |
| [rust-vmm/vm-virtio](https://github.com/rust-vmm/vm-virtio) (`virtio-queue`, `virtio-bindings`) | virtio-queue 0.18.0, virtio-bindings 0.2.7 | virtio-queue: **Apache-2.0 AND BSD-3-Clause**; virtio-bindings: BSD-3-Clause OR Apache-2.0 | Repository **archived** 2026-09-11. Crates are still published |
| [gem5](https://github.com/gem5/gem5) | `f5c5a6e390f5` | BSD-3-Clause | |
| [Berkeley SoftFloat 3e](https://github.com/ucb-bar/berkeley-softfloat-3) / [TestFloat 3e](https://github.com/ucb-bar/berkeley-testfloat-3) | `a0c6494cdc11` / `a9c849f1b0eb` | BSD-3-Clause (text in `COPYING.txt`) | |
| [Capstone](https://github.com/capstone-engine/capstone) | `9791930a895b` (`next`) | BSD-3-Clause (`LICENSES/`) | Some parts are LLVM-derived under their own license. We use it only as a tool |
| [Sail ARM model](https://github.com/rems-project/sail-arm) | `1bf2e5574ba9` | BSD-3-Clause-Clear (per model directory) | The Clear variant explicitly grants no patent rights |
| Arm A64 machine-readable spec (AARCHMRS JSON) | 2024-12 release | Arm publishes a "BSD license JSON" release, but its release notes defer to the Proprietary Notice inside the package | **Read the notice in the downloaded package before generating code from it.** Until then, dynarmic's 0BSD decoder table is the safe source |
| [Playwright](https://github.com/microsoft/playwright) | 1.63.0 | Apache-2.0 | |

**Copyleft or other: use as oracle, guest workload or behavioral reference only. Never copy code.**

| Project | Commit | License |
|---|---|---|
| [QEMU](https://gitlab.com/qemu-project/qemu) | `a97f90fcf802` | GPL-2.0 overall, per-file licenses (TCG mostly BSD/MIT) |
| [Unicorn](https://github.com/unicorn-engine/unicorn) | `7c5db94191de` | GPL-2.0 |
| [kvm-unit-tests](https://gitlab.com/kvm-unit-tests/kvm-unit-tests) | master, 2026-09-25 | GPL-2.0 (many files LGPL-2) |
| [LTP](https://github.com/linux-test-project/ltp) | `f5bf852334d5` | GPL-2.0 |
| [herdtools7](https://github.com/herd/herdtools7) | `ca7d66e90bf3` | CeCILL-B (`asllib/` is BSD-3-Clause, © Arm) |
| [risu](https://gitlab.com/pm215/risu) | `eed224965e7b` | EPL-1.0 |
| [Buildroot](https://gitlab.com/buildroot.org/buildroot) | master, 2026-09-25 | GPL-2.0-or-later |

Guest images we build and distribute (kernel, BusyBox, and so on) carry their own
licenses and obligations. Publish the Buildroot configs and point to the sources.
