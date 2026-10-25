**Drafted 2026-10-25, at the user's request, by the session that finished VK0; the user approves the content.**
Covers **VK1** of the Vulkan plan ([docs/plans/graphics.md](docs/plans/graphics.md) §6), M8's graphics track. VK2 and
later get their own kickoffs.

Start **VK1: route (b)'s premise, then the device and a null Venus renderer.** VK0 found Vulkan translated onto WebGPU
worth building (bench/vulkan/REPORT.md: a whole frame at 1.0–1.8× native Vulkan on the M4, 1.9–3.6× on the user's
NVIDIA, 200–950× faster than the guest's lavapipe) and chose route (b), Mesa's runtime, `spirv_to_nir` and NIR under
virglrenderer's Venus decoder, built for wasm. VK1 first measures whether those pieces are small and fast enough in
wasm. Then it builds what the guest sees: the virtio-gpu features Venus needs, the host-visible window with its
write-watch, the Venus capset, and a renderer in the GPU worker that answers Venus and draws nothing. That is enough to
measure the one cost VK0 could only estimate: the guest's cost of encoding Venus, against virgl's.

Read docs/plans/graphics.md whole (§3 the shape, §4 the map, §6 VK1, §7 the risks) and bench/vulkan/REPORT.md ("The
answer", B, D, G, "The route", "The bar", "Not done in VK0"). Then docs/graphics.md ("Decisions", "The GPU worker",
"Measurements": G2's method for virgl's guest cost, "Findings", "Tools"), docs/devices.md "virtio-gpu" and the
virtio-mmio transport's SHM regions, docs/spill-memories.md (memories outside memory 0), docs/cpu.md and docs/jit.md on
the TLB, docs/abi.md, docs/testing.md, docs/benchmarking.md, `tools/venus-oracle/` and THIRD_PARTY.md. CLAUDE.md's
conventions and working rules apply. Work as in the other tracks: short loops, one commit and a short report each,
without check-ins, except as below.

## Decisions (binding)

- **Everything in plan §2 still binds:** Venus, translated onto WebGPU on the real GPU, no software rasterizer, virgl
  the GL path, the caps following the browser's adapter, realtime mode only, a C toolchain for wasm allowed (each
  library checked against THIRD_PARTY.md and given its row; other new dependencies: ask).
- **Vulkan is a per-machine choice, off by default.** A machine without it sees exactly today's device: no new
  features, capsets or memory, `tests/steps.txt` unmoved.
- **Step 1, route (b)'s premise, comes first and is measured on its own:** `spirv_to_nir` and the NIR passes the
  translator will need, built to wasm with the toolchain the session picks (Emscripten or clang with wasi-sdk,
  settled by measurement), run over VK0's 110 stages (`bench/vulkan/translate/programs.sh`'s dumps). Measure the
  compressed download size, the median and p90 ms a stage in Chromium on the Mac and in the dev VM, and how many stages
  reach NIR. **The bar:** within ~5 MiB compressed, fetched only by a machine with Vulkan on (the core is ~1.9 MB
  today), and within ~5 ms a stage at the median (naga took 1.1; Chromium's own part of a pipeline is ~9). It is a
  spike: nothing of it reaches the page in VK1.
- **The null renderer draws nothing and translates nothing** (that is VK2). It answers what Venus must have answered:
  setup's replies, fences, feedback slots, the ring. It may advertise whatever a gate program needs to take Vulkan
  (GTK4 wants YCbCr and dma-buf modifiers), since nothing is drawn. The set the device will really advertise is VK2's
  question.
- **Where VK1 runs:** the dev VM, and the Mac host for numbers on a real GPU, as in VK0. **Nothing is installed on the
  Mac:** it runs from `~/webpc-gpu-bench`, and its disk is nearly full, so keep that folder small. The x86_64 desktop
  is never touched by an agent. If a number from the user's NVIDIA desktop would settle something, extend
  `bench/vulkan/nvidia.sh` and say so. Don't wait for the user's run.
- **Check-ins:** none, except stop and report at once in two cases. First, if step 1 misses its bar: switching to
  route (a) is the user's call. Second, if VK1's gate shows Venus costing the guest clearly more than virgl for the
  same frames, which would put the bar of plan §1 out of reach.

## What VK1 builds

- **The device** (devices.md "virtio-gpu"): `CONTEXT_INIT`, `RESOURCE_BLOB`, `HOST_VISIBLE` (a shared-memory region
  on the virtio-mmio transport) and `RESOURCE_UUID`, the Venus capset, blob resources (guest and host memory), the
  commands Venus's kernel path uses, and snapshots of all of it (or refused cleanly while Vulkan is in use, said so,
  and noted in the backlog).
- **The host-visible window:** where it lives (its own memory, as the spill memories have, or memory 0's 4 GiB;
  settle it by what it costs the guest and the heap). Also **the write-watch:** the window's pages write-protected in
  the TLB, a page marked dirty on its first write after each submit, then protected again. It is a JIT rule like any
  other: the differential test, lockstep and the exact-step boots pass, and a bug is planted and caught. Machines
  without Vulkan pay nothing measurable (bench/run.ts, CLAUDE.md's rules).
- **The null Venus renderer in the GPU worker:** the ring polled with its poller kept awake across frames, the ring
  and the virtqueue serviced independently (they wait on each other: REPORT.md B), feedback slots copied back after
  each submit that carries one, the dirty pages read at each submit (their count kept as a statistic: VK2 uploads
  them). Also the behaviors beyond the spec that B found in `vkr`, answered as our driver chooses to.
- **The guests:** the Venus driver in Debian's and the desktop guest's images (through `images/`, in Podman), and a
  check that their Mesa keeps virgl for GL with both capsets (plan §2; REPORT.md A read it from the loader's source
  only).

## The gate

As G2 measured for virgl: **vkcube's, S's scene's (1 and 1,000 fish, the toolkit setting) and GTK4's frames cost the
guest no more CPU on Venus than on virgl,** on the Mac, 4 vCPUs. GTK4 is on the desktop guest: fishbowl and frames
against REPORT.md G's numbers (gtk4-demo 8 ms of CPU a frame in fishbowl, 2.3 in frames). Also: B's estimate of
Venus's encoding (≈280 guest instructions a command) confirmed or replaced by the measurement, and the write-watch's
cost a frame on the guest's side.

**Tests** at the cheapest layer that catches each thing: Rust unit tests for the device and the window, the JIT's
tests for the write-watch, and a guest test of vkcube on the null renderer reaching steady frames. The guest test
goes in the CI script that fits (`ci-debian.sh` for the device on the page) or a new one, and it skips cleanly
where there is no WebGPU adapter.

## THIRD_PARTY.md, brought up to date

VK0 used, built or learned from projects that THIRD_PARTY.md doesn't list yet. Early in VK1, as its own loop,
**audit every third-party project the Vulkan work chose to use or took ideas from,** check each licence against
the project's own files (not a summary), and give each its row in the right table: code derived, development
dependencies, benchmark workloads, techniques (ideas, no code), or reference projects. Keep it current with every
loop after that. Known gaps to start from (verify each, and look for others in `bench/vulkan/`, `tools/venus-oracle/`,
`tools/vulkan-tools/` and the REPORT):
- **Built or run by VK0:** naga (its CLI built to wasm in `bench/vulkan/translate/`), SPIRV-Tools (spirv-opt),
  SPIRV-Cross, GFXReconstruct, Khronos's Profiles layer (a patched build: `bench/vulkan/profiles/build-layer.sh`),
  virglrenderer's Venus renderer and our `capture.patch` to it, Mesa's Venus driver and lavapipe in the oracle.
- **The programs VK0 measured:** vkcube, vkmark, vkQuake with LibreQuake's data, gtk4-demo, mpv and libplacebo,
  vkd3d's demos, Chromium's ANGLE and Dawn, Firefox's wgpu.
- **Ideas the plan leans on:** Mesa's common Vulkan runtime and NIR, libpoly, KosmicKrisp (NIR → MSL, the model for
  NIR → WGSL), MoltenVK, `venus-protocol`, Tint.
- **What VK1 brings in:** the wasm toolchain, the parts of Mesa and virglrenderer built for wasm, and anything the
  guests' images add.

## Deliverable

- Step 1's numbers and verdict in bench/vulkan/REPORT.md (a VK1 section, with JSON).
- The device, the window, the write-watch and the null renderer, with docs that state how they work now:
  devices.md "virtio-gpu", graphics.md, and a page of its own if Vulkan's host side outgrows them.
- The gate's numbers (JSON committed).
- THIRD_PARTY.md current.
- Plan §6 and §7 revised from what VK1 learned, with loose ends in docs/backlog.md.
- `scripts/ci.sh`, and the CI scripts the change touches, passing.

Notes between sessions go in `M8-VK1-HANDOVER.md`. I decide whether VK2 starts.
