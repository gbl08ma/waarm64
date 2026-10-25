**Drafted 2026-10-25 from the user's answers in a cloud session, which they asked for; the user approves the
content.** Covers **VK0** of the Vulkan plan ([docs/plans/graphics.md](docs/plans/graphics.md)), M8's graphics track.
VK1 and later get their own kickoffs.

Start **VK0**: measure whether Vulkan for our guests, through Mesa's Venus driver translated onto WebGPU, can be fast
enough to be worth building, before anything is built for the guest. Programs that need Vulkan run on the guest's
lavapipe today: usable, but slow, and every vCPU cycle it rasterizes with is taken from the program's own logic. The
first question is the magnitude of the slowdown for a whole, light, real scene: if Vulkan → our translation → WebGPU in
Chromium comes out tens of times slower than Vulkan natively on the same GPU, acceleration isn't viable and the effort
stops. Read docs/plans/graphics.md whole (§5 is VK0, §9 my answers), then docs/graphics.md ("Decisions", "The GPU
worker", "Measurements", "Findings", "Tools"), bench/gpu/REPORT.md (WebGPU in headless Chromium, on the dev VM and on
the Mac), docs/benchmarking.md and THIRD_PARTY.md. CLAUDE.md's conventions and working rules apply. Work as in the
other tracks: short loops, one commit and a short report each, without check-ins, except as below.

## Decisions (binding)

- **Venus translated onto WebGPU** on the real GPU; no software rasterizer in the guest or on the host; virgl stays
  the GL path; Vulkan a per-machine choice until every program that switches to it is no slower than on virgl
  (docs/plans/graphics.md §1, §2).
- **A C toolchain for wasm is allowed** (Emscripten or clang with wasi-sdk). Each library is still checked against
  THIRD_PARTY.md and gets its row. Other new dependencies: ask, as CLAUDE.md says.
- **Where VK0 runs:** the dev VM, and the **M4 Mac host** it runs on, which agents in the dev VM may use for WebGPU
  numbers and validation on its GPU. **Nothing is installed on the Mac itself**: everything runs from
  `~/webpc-gpu-bench` (as `bench/gpu/run-mac.sh` does), the Vulkan SDK's KosmicKrisp unpacked there for the native arm;
  if the native arm can't run from that folder, it is skipped on the Mac. The x86_64 desktop is never touched by an
  agent.
- **The stop line:** judged against today's paths. Continue if the translated scene (S's arm 3) is several times
  faster than the guest's lavapipe at the light settings (up to ~1,000 fish, the toolkit setting); the ratio to native
  is context, with a hard stop only past ~20× native.
- **Check-ins:** none, except stop and report at once if an arm crosses the stop line.

## The scene

The Vulkan counterpart of the WebGL Aquarium (plan §5 S): fish with per-fish data, plants, bubbles, an environment
map, the fish-count knob from 1 to 30,000, and a toolkit-shaped setting. **Use the Aquarium's textures and models if
their licence allows** (check it and add the row to THIRD_PARTY.md); failing that, design a scene of your own that is
representative. It doesn't have to look pretty: it is a technical benchmark. What matters is that it is written the
way Vulkan programs are, and that every arm draws the same thing.

## The NVIDIA desktop's script

I run it myself, by hand, on my desktop: x86_64, **CachyOS** (an Arch Linux flavor), an NVIDIA GPU with its own driver,
**LLVM (clang) already installed**, Chromium with WebGPU working without flags. The script:
- puts **everything it downloads or builds in one self-contained directory** I can delete afterwards (the Vulkan SDK
  for Linux, a portable Node if it needs one, a Chrome for Testing if it uses one, the scene's build, the results):
  no `sudo`, no packages installed, nothing written outside that directory except what I'm told to open;
- builds the scene with the installed clang against the SDK in that directory, and runs the native arm on the
  system's Vulkan driver;
- runs the Chromium arms (a headless Chrome for Testing in the directory if it gets the NVIDIA adapter; otherwise it
  serves the page and prints a URL for me to open in my own Chromium, where the page downloads its results);
- writes the JSON I send back, and prints what it did and how to remove it.
Prepare it during VK0 and don't wait for my results.

## Deliverable

`bench/vulkan/REPORT.md` with the JSON: S's ratios (the translated scene against native, against the guest's lavapipe
and against virgl's GLES port), A to G's answers, the route chosen (plan §3), the advertised set and its emulation
order, the render-pass rule, and whether the bar looks reachable for the programs that switch. Then the plan updated
from it (§4 to §7). I decide whether VK1 starts.
