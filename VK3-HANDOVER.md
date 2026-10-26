# VK3 handover

The notes that carry VK3 ([VK3-KICKOFF.md](VK3-KICKOFF.md)) from one loop to the next. Newest state first. Each loop
adds a "State (<date>, after Ln)" section on top of the states, and marks its bullet in "The plan" done.

## What the next NVIDIA run must answer

Kept by the supervisor. Each loop that needs an NVIDIA number extends `bench/vulkan/nvidia.sh` (one command, one
results tarball) and adds its question here.

The command (on the dev VM: `git pull`, the images built, then `bench/vulkan/nvidia-bundle.sh` makes
`target/vk2-nvidia-bundle.tar`, ~3.4 GB, for the user to copy over; on the desktop, in a checkout at the same commit):

    bench/vulkan/nvidia.sh page <the bundle> ~/webpc-vk2

(the same directory as VK2's run reuses its Node and browsers; `VK2_STEPS="present"` runs only L1's step, ~10 min;
results: `~/webpc-vk2/vk3-nvidia-results.tar.gz`, `results/present/results.json` and its PNGs.)

- **L1, presentation** (`present` step, bench/vulkan/present.ts): (1) with NVIDIA reported as an unknown maker, are
  vkcube's window and mpv's picture right on the page (`auto`: `vkcube.ok`, `mpv.ok`, not `mpv.black`)? (2) Which way
  did the page's check settle on (`shareAfterMpv.way`/`state`; `dropped` and `why` if a GPU way copied wrong)? (3) Each
  forced way (`bitmap`, `canvas`, `readback`) right or not, and its check's `checksWrong` (a forced way is checked but
  kept): this says whether Chromium's GPU-to-GPU path (a Dawn-on-Vulkan shared image read by ANGLE on NVIDIA's GL) works
  there. (4) Any `venus-share: … isn't (or no longer) a Vulkan image's memory` warnings beyond a killed program's last
  images (a window still taking Mesa's prime blit). Also from the user: is the screen still going black for seconds?

## The plan (loops; the supervisor may reorder)

The kickoff's eight steps, one loop each unless a loop says otherwise:

- [x] L1 (done 2026-10-26): presentation on NVIDIA (why the bitmap way is black; a run-time check of the first copy and the readback
  fallback; nvidia.sh's presentation check).
- [ ] L2: the fence's round trip (instrumented on every host; the pollers' `setTimeout(0)` first; the bar: Venus at
  1 fish no slower than virgl on any host).
- [ ] L3: pipelines made asynchronously, WGSL cached by SPIR-V hash across runs.
- [ ] L4: libplacebo's advanced path (`float32-blendable`; the M4's green VA-API chroma; tier1's storage formats).
- [ ] L5: the translator's missing adapter features (`subgroups`, `shader-f16`, read-write storage with `tier2`).
- [ ] L6: the driver's gaps from dEQP-VK (per-face stencil, occlusion queries, texel buffers, depth/stencil copies,
  dEQP-VK on the Mac's GPU).
- [ ] L7: §4's emulated rows in order (Dawn's: indexed descriptor arrays, sample-rate shading; ANGLE's ES3: provoking
  vertex, >12 UBOs, transform feedback; vkd3d's draw parameters; GTK4's YCbCr with modifiers last). Likely several loops.
- [ ] L8: the track's end (REPORT.md's VK3 section, docs, plan §6/§7, the final NVIDIA run scripted).

## State (2026-10-26, after L1)

- **Done: NVIDIA's black found and fixed without the desktop** (REPORT.md "VK3 L1", JSON in
  `bench/vulkan/results/vk3/l1/`). The bitmap way was never the cause: VK2's run shows `shareRefreshes` 0 during mpv on
  Vulkan (24/s on the M4), so nothing was ever copied. The device reported the adapter's maker as its vendor (VK2 L7),
  0x10de on NVIDIA, and Venus's guest driver in Mesa 26 (`vn_wsi_init`) then sends Mesa's WSI down the prime blit: each
  frame copied into an exported linear buffer, a blob with no texture to share. Reproduced on SwiftShader with
  `?gpu=vkvendor=nvidia` on the desktop guest (mpv's page mean 0 against the guest's 55.8; the user's was 0.4); fixed
  by reporting NVIDIA as an unknown maker (web/venus-gpu.ts `VENDORS`; after: right, mean difference 3).
- **The run-time check** (web/venus-share.ts, vk/README.md "Presentation"): three ways now (bitmap, canvas,
  readback); a GPU way's first copies are held while 8 rows are read back from WebGPU and compared with the virgl
  texture (`readExternalRows`); dark frames decide nothing, 3 right frames settle it, a wrong one drops it for the next
  and that frame gets the next way's copy before the submit runs. Forcible: `?gpu=vkbitmap|vkcanvas|vkreadback`
  (checked, never dropped); tests break a way with `vkbreak=<way>`; `vkvendor=<maker>` spoofs the maker. State in the
  render stats (`share`) and on the console. **The page now picks:** bitmap on the M4 (checked right in 3 frames; all
  four arms right in situ; with the bitmap way broken it fell to canvas, checked right), readback on SwiftShader (by
  the renderer's name, as before: a WebGPU canvas there loses the GPU channel).
- **Tests:** tests/venus-share.test.ts (the bytes every way, the fallback with both GPU ways broken incl. on
  SwiftShader, the verdicts in Node; passes on the Mac too, run by hand), tests/page-venus.test.ts (its presentation
  runs with `vkbreak=bitmap,vkbreak=canvas` and asserts the fallback to readback), tests/venus-renderer.test.ts (never
  0x10de). Planted: the check never wrong, the check not holding the submit, NVIDIA's ID back: each caught.
- **nvidia.sh**: a `present` step first (bench/vulkan/present.ts: per way a session, vkcube and mpv in the desktop
  guest, the page's screen against the guest's frames), the tarball now `vk3-nvidia-results.tar.gz`; ran end to end on
  the dev VM (SwiftShader, `VK0_ANY_ARCH=1 VK0_NODE=system VK0_ADAPTER_MATCH=swiftshader VK2_STEPS=present`, the
  bundle rebuilt from this checkout). bench/gpu/sway-mac.sh passes `WAYS` (`SCRIPT=../vulkan/present.ts`).
- **Also fixed:** the readback way leaked: a buffer made and destroyed a frame grew Chromium's GPU process by ~one
  buffer a frame on SwiftShader (vkcube's 1276×670 rgba16float: 1.7 → 3.3 GB in 4 s, OOM); each resource keeps its
  buffer now (steady ~300 MB). Playwright screenshots of the page hang while SwiftShader's GPU process is busy:
  `window.__webpcGrab()` (bench hooks) reads the screen canvas as drawn, in the GPU worker.
- **Left:** the user's run (above) confirms. A WSI that exports buffers (prime blit) still isn't shared (backlog "A WSI
  image exported as a buffer isn't shared"; only a warning). If the next run shows the bitmap way wrong on NVIDIA,
  the check already falls back; the forced arms tell which of the hypotheses (REPORT.md "VK3 L1": a failed swap-buffer
  export gives a transparent image silently; GL/Vulkan memory and semaphore interop) holds.
- **CI at the commit:** ci.sh OK (504 s), ci-debian.sh OK (422 s; page-venus with the GPU ways broken: vkcube right
  through the fallback), ci-deqp-vk.sh OK (252 s). tests/venus-share.test.ts also passes on the Mac (by hand).
- **Worth not re-discovering:** the guest's Mesa reads the device's vendor ID (Venus's WSI: 0x10de means NVIDIA's
  driver underneath); check a vendor-dependent change on the desktop guest (Mesa 26), not Debian's 25. The serial
  `run()` joins a command's output lines: print one line. ffmpeg's `cropdetect` skips 2 frames by default (`skip=0` for
  a PNG). mpv on Venus draws unscaled (its scaler disabled with the FBO formats held back) while its own `screenshot
  window` is scaled: compare cropped pictures. The page-level `present.ts` on SwiftShader takes ~3 min a way.

## State (2026-10-26, before L1)

VK2 ended at cd03da82/465132b6: Venus draws through WebGPU, frames reach virgl's screen by bitmap (L4), mpv on Vulkan
meets its timing bar, 1,463 dEQP-VK cases in CI. The user's NVIDIA run (bench/vulkan/REPORT.md "VK2: the NVIDIA run")
found Venus's presented frames black there (offscreen frames right) and a ~4.5 ms fence floor a frame (the M4's ~0.9).

## Things worth not re-discovering

VK2's list still holds: `git show cd03da82:VK2-HANDOVER.md`, its "Things worth not re-discovering" and each state's
findings. Add VK3's here.

- (L1) Guest-visible identity matters: Venus's guest driver keys its WSI path on the device's vendor ID (0x10de →
  prime blit, frames into buffers that aren't shared). Read a NVIDIA run's render stats first: `shareRefreshes` 0 meant
  nothing was copied, before any theory about the copy.
- (L1) On SwiftShader a WebGPU buffer made and destroyed a frame isn't freed while the queue stays busy (Chromium's GPU
  process grew ~400 MB/s): keep staging buffers. Page screenshots can hang there: use `window.__webpcGrab()`.
