# webpc graphics plan: Vulkan

**Status: VK0 to VK3 done (2026-10-25 to 10-29); VK4 started 2026-10-29 as tasks the user starts
([VK4-KICKOFF.md](../../VK4-KICKOFF.md)).** What exists, how it fits together, what it backs and what it found are
[docs/graphics.md](../graphics.md) "Vulkan through Venus" (the renderer's code: [vk/README.md](../../vk/README.md));
each phase's measurements are bench/vulkan/REPORT.md; its loose ends are in [backlog.md](../backlog.md) "Platform and
devices". This page is what binds the work ahead: **Vulkan for unmodified guests, through Mesa's Venus driver,
translated onto WebGPU on the host**, the bar it must meet, the decisions, and VK4.

Why: programs that need Vulkan and ignore our GLES (native Vulkan games, Vulkan-only tools and toolkits) run on the
guest's lavapipe otherwise, which is usable but slow, and every vCPU cycle it rasterizes with is one the program's own
logic doesn't get (llvmpipe: 323 ms a compositor frame on 1 vCPU, 71 ms on 4, ~12× native; graphics.md "Guests that
composite with llvmpipe").

## 1. The bar

**Offering Vulkan must make no program slower than it is today.** The guest picks its API from what the device
offers; we can't steer an unmodified guest per program (the guests aren't ours to configure). Today every program
that can use GL draws through virgl, because the device offers nothing else. Once a Vulkan device appears, some switch
on their own. Their defaults (VK0 A checked them on the guests' versions; VK3 L7.3 GTK 4.24's):

| Program | With a Vulkan device present |
|---|---|
| **GTK4** (4.16+, Wayland) | **Would switch**: Vulkan is GSK's default, but with Venus offering only the LINEAR modifier GTK 4.24 takes GL ("Not using Vulkan: no dmabuf support"); GSK on Vulkan, forced, misses GTK4's bar (VK4 T13) |
| **Chromium** | Compositing stays GL (ANGLE); Vulkan on Linux is opt-in. **Its WebGPU (Dawn) needs Vulkan**: new, not a switch |
| **Firefox** | WebRender is GL only. Its WebGPU (wgpu) would use Vulkan: new |
| **KWin, Qt Quick; Mutter; sway (wlroots)** | GL; Vulkan is opt-in (`QSG_RHI_BACKEND`, `WLR_RENDERER`) |
| **mpv / libplacebo** | Likely switches (Vulkan first) |
| **Native Vulkan games and tools** | Vulkan only: the reason for this plan (Proton's DXVK and VKD3D need what isn't offered yet: graphics.md "What maps, what's emulated, what isn't offered") |

So the programs that switch must be **at least as fast on our Vulkan as on virgl**, or Vulkan isn't offered. A
program that finds a feature it requires missing falls back to GL by itself, so what we advertise also chooses who
switches; that's a lever, but a fragile one to tune per program.

This bar is why a software Vulkan driver on the host (lavapipe or SwiftShader built for wasm, behind Venus) lost
(graphics.md "Not taken for Vulkan"): it would take the rasterizing off the guest's vCPUs, but GTK4 and the rest would move from a GPU to a CPU
rasterizer.

## 2. Decisions (the user, 2026-10-25, and the tracks' since)

- **Venus**, Mesa's upstream virtio-gpu Vulkan driver (in Debian's and Arch's Mesa: the virtio ICD GTK4 already
  probes): no guest patches. Its host side is ours, in the GPU worker beside the virgl renderer.
- **Translated onto WebGPU**, on the real GPU. No software rasterizer, in the guest or on the host.
- **virgl stays the GL path.** The device offers both capsets; VK0 checks that the guest's Mesa still picks virgl for
  GL and not Zink on Venus.
- **The caps follow the browser:** Vulkan only where `navigator.gpu` gives an adapter (macOS and Windows; on Linux
  since Chrome 144 on Intel Gen12+ and 147–148 on NVIDIA: the user's NVIDIA desktop has it with no flags; the dev VM's
  SwiftShader adapter for tests), and only what that
  adapter backs (its optional features: `clip-distances`, `dual-source-blending`, `shader-f16`, subgroups,
  `primitive-index`, the texture-format tiers). A snapshot restored where its caps can't be backed runs without
  Vulkan, as for 3D.
- **A per-machine choice, off by default,** until every program that switches meets the bar (§1); then on by default
  where WebGPU is.
- **A C toolchain for wasm is allowed** (clang with wasi-sdk is the one in use). Each library it brings in is still
  checked against THIRD_PARTY.json and gets its row.
- **Realtime mode only**, as for virgl; the vCPU never blocks on the GPU worker.
- **Correctness gate: dEQP-VK** (the same VK-GL-CTS build as the GLES gate, a guest workload), with pass lists in CI as
  `scripts/ci-deqp.sh` has for GLES. **The oracle:** virglrenderer's Venus renderer on lavapipe through vtest in the dev
  VM (Mesa's Venus driver can talk vtest natively, as virpipe does for virgl), so protocol captures and reference
  images come without QEMU (which can't run 3D there: graphics.md "Findings").
- **Route (b)** (VK0 D, built in VK1–VK3): vkr calling a Mesa Vulkan driver of ours whose hardware is WebGPU, the
  translator NIR → WGSL; **one renderer module on memory 1**, its own, the window after its arena (VK4 T19, the user's call 2026-10-29: it was memory 0's top, which cost the guest 511 MiB of fast RAM); **vkr on one thread**
  (graphics.md "The shape").
- **API 1.3 advertised** (the user, 2026-10-28), and **what the device advertises must work** (VK4): a feature or
  format that can't be backed is taken off the advertised set (guest-visible, pre-approved) rather than left failing.
- **Correct before fast, and never a black screen** (VK3): a presentation way that can fail on a platform is checked
  when the page starts using it, with a fallback to the readback way; a fix aimed at a platform the agents can't
  reach ships with a check of its own at run time and a safe fallback.
- **YCbCr conversions on by default** (the user, 2026-10-28; `?gpu=vkycbcr=off`): GTK 4.24 aborts on a device with
  the dma-buf extensions and no YCbCr. **Any change that offers GTK a modifier other than LINEAR must first show GTK4
  on Vulkan meeting its bar** (bench/vulkan/REPORT.md G), or GTK4 moves to the slower path.
- **Each emulated row's dEQP-VK groups join `tests/deqp/vk.txt` as its gate**; an adapter-only failure is filed, not
  taken off the list (the lists are shared by every adapter).

## 3. VK4: compliance and cost, as tasks

VK4's tasks, their order and what each counts as done are [VK4-KICKOFF.md](../../VK4-KICKOFF.md) (approved by the user,
2026-10-29): no supervisor or loops; the user starts each task in a session of its own. Ranked by what the guest's
programs meet, weighted by the consequence (a crash or a lost device, then dropped work, then wrong pixels, then
missing features; an advertised feature that doesn't work counts whatever its use), then performance on the long,
real workloads; T1, a census of dEQP-VK's whole list by cause, re-ranks the rest. Its end: dEQP-VK's pass list grown
and passing on SwiftShader, the M4 and NVIDIA, every advertised feature backed, and Vulkan **on by default** where
every switching program meets the bar (§1).
