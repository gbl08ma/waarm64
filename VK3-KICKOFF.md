**Drafted 2026-10-26, at the user's request, by the session that supervised VK2's last loops and processed the user's
NVIDIA run; the user is to approve the content before VK3 starts.** Covers **VK3** of the Vulkan plan
([docs/plans/graphics.md](docs/plans/graphics.md) §6), M8's graphics track. Later phases get their own kickoffs.

Start **VK3: Venus right everywhere, then the emulated rows.** VK2 made Venus draw: the direct set translated onto
WebGPU, frames to the screen through virgl, mpv on Vulkan at its bar, 1,463 dEQP-VK cases in CI (bench/vulkan/REPORT.md
"VK2 L4"–"VK2 L7"). The user's NVIDIA run then found two things the M4 and SwiftShader didn't show
(REPORT.md "VK2: the NVIDIA run"): **what Venus presents is black there** (the user saw the screen go black for seconds
at a time), and **a frame waits ~4.5 ms on its fence**. The user's own desktop is NVIDIA, so VK3 starts there, then
takes VK2's loose ends and plan §4's emulated rows in its order.

## How VK3 runs: a supervisor and loops

This kickoff starts **a supervising session**, which doesn't do the loops' work itself. Like a tech lead, it:
- Starts each loop in **a fresh subagent** (the Agent tool, general-purpose, in the background). The brief is short
  and gives the loop's scope, the ground rules below, what to read (this file, `VK3-HANDOVER.md`, CLAUDE.md, the
  docs of the area) and what to report (≤ 15 lines: done or not, commits, CI results, key numbers, blockers). The
  handover and the repo are the subagent's only context, so the handover must be sufficient.
- Has each loop end the same way: one commit (or a few), rebased onto origin/main and pushed, with
  `VK3-HANDOVER.md`'s "State (<date>, after Ln)" section on top (newest first: what was done, numbers, what's
  left, findings worth not re-discovering) and the plan's bullet for that loop marked done.
- **Reviews each loop before starting the next**: reads the report and the handover's new section, checks the numbers
  against the bar and plan §7's risks, looks at evidence itself where a claim matters (a screenshot, a JSON), fixes
  the handover if it is thin, and reorders or reshapes the next loops when a finding calls for it (and writes that
  in the handover's plan). It keeps the big picture: whether the track still makes sense.
- Waits on the subagent's completion notification. It doesn't poll, and doesn't touch the files a running loop is
  changing.
- Writes the user a short status line after each loop (the user may be away: the report is for when they're back).

**Ground rules for every loop** (each brief repeats them):
- Work only in `~/Development/webpc`. **No git worktrees and no side checkouts**: cross-worktree access and symlinks
  across them raise permission prompts that never time out and have blocked agents overnight. Build an A/B
  baseline in this checkout, one arm at a time.
- The dev VM and the Mac host (the `oracle` VM, `bench/gpu/sway-mac.sh`) are free for oracles, tests and benchmarks.
  Run Mac benchmarks while the VM is idle, since they share the M4. The x86_64 NVIDIA desktop is never touched by an
  agent.
- CLAUDE.md's working rules bind: `timeout` on every run, memory caps on `node` and `cargo`, no `pkill -f` on a
  pattern in one's own command line, CI scripts alone and in the background, one at a time. Never deploy.
- Guest-visible changes are pre-approved for correctness and performance (steps.txt moves once, in its commit).

**The user's NVIDIA runs are batched.** Agents can't reach the desktop, and a fix for it can't be confirmed without
the user. So:
- Every loop that needs an NVIDIA number extends `bench/vulkan/nvidia.sh`, keeping it one command with one results
  tarball.
- A fix aimed at NVIDIA ships with **a check of its own at run time** and a safe fallback. It must never leave the
  user's screen black on a guess.
- The supervisor keeps a list in the handover of what the next NVIDIA run must answer, and gives the user the
  command when they're back.
- The results come back as `vk*-nvidia-results.tar.gz` in the repo's root. They're processed into REPORT.md and
  `bench/vulkan/results/`, then the tarball is deleted.

**When to pause** (the supervisor, not the loop, decides):
- A loop finds a reason the plan didn't price that would reopen the route or the bar: WebGPU's per-call cost,
  pipeline stalls, or uploads well past REPORT.md's C to F.
- A choice needs the user's judgement and can't be settled by measurement.
- An NVIDIA-only fix can't be made safe without the user's run.

Then commit what works, write it in the handover and stop VK3's loops. The supervisor may then work on other ready
work the user named, and reports when the user is back.

## Read first

docs/plans/graphics.md whole (§2 the decisions, §4 the map and its order, §6 VK3, §7 the risks); bench/vulkan/REPORT.md
"The NVIDIA desktop", "VK2 L4"–"VK2 L7" and "VK2: the NVIDIA run"; vk/README.md; docs/devices.md "Venus"; docs/graphics.md;
docs/backlog.md's Vulkan entries ("Venus's frames are black on the user's NVIDIA desktop", "… wait ~4.5 ms on their
fence", "Presentation's gaps", "Imports' gaps", "The Vulkan driver's gaps"); docs/testing.md "dEQP". VK2's handover
(`git show cd03da82:VK2-HANDOVER.md`) has its loops' findings worth not re-discovering: read its "Things worth not
re-discovering" and each state's.

## Decisions (binding)

- Everything in plan §2 and VK2's choices still bind. Vulkan is a per-machine setting, off by default. The renderer
  is one wasm module on memory 0 in its arena, and vkr runs on one thread. The translator is route (b)'s (NIR → WGSL).
  The caps follow the adapter.
- **Correct before fast, and never a black screen**: a presentation way that can fail on a platform is checked when
  the page starts using it, and the page falls back to the readback way.
- §4's emulated rows go in §4's order, each with its dEQP-VK groups added to `tests/deqp/vk.txt` as its gate and the
  render-pass rule applied. GTK4's row (YCbCr, modifiers) goes last of the rows VK3 takes, and only once GTK4's
  black frames are understood.

## The plan (loops; the supervisor may reorder by what each loop finds)

1. **Presentation on NVIDIA.** Find why the bitmap way gives black on Linux with Dawn on Vulkan and ANGLE on GL:
   - Read Chromium's paths for `transferToImageBitmap` from a WebGPU canvas into WebGL. Try the other ways L4 measured:
     `texSubImage2D` straight from the canvas, and readback.
   - Make the page check a first copy (a one-off readback of a few pixels against the WebGPU texture) and fall back
     on mismatch.
   - Extend nvidia.sh with a presentation check: vkcube and mpv on the desktop guest, the page's screenshots compared
     with the frames inside the guest, for each way.
2. **The fence's round trip.** Instrument submit → `onSubmittedWorkDone` → the guest's fence on every host. Shorten
   what can be shortened: fences with nothing to read back, Dawn's device ticks, the copy's place in the frame.
   Measure on the M4 and SwiftShader, and add the breakdown to nvidia.sh. The bar: Venus's frame at 1 fish no slower
   than virgl's on any host.
3. **Pipelines made asynchronously, and cached across runs** (plan §7: Metal's ~80 ms first compile): the ring stalls
   while one is made, and WGSL is kept by SPIR-V hash in the browser's storage.
4. **libplacebo's advanced path:** the M4's green VA-API chroma with `float32-blendable`. Then that format and tier1's
   storage formats can come back, and mpv gets its scalers.
5. **The translator's missing adapter features:** `subgroups`, `shader-f16`, read-write storage with `tier2`.
6. **The driver's gaps from dEQP-VK:**
   - per-face stencil, occlusion queries
   - texel buffers, the depth and stencil copies WebGPU refuses: vkQuake's 1.67% difference has both as leads
   - dEQP-VK on the Mac's GPU (sway-mac.sh passing `vk` through)
7. **§4's emulated rows in order:**
   - Dynamically indexed descriptor arrays and sample-rate shading, for Dawn in the guest's Chromium (its WebGPU
     samples are the program).
   - The provoking vertex, more than 12 uniform buffers and transform feedback, for ANGLE's ES3.
   - Draw parameters, for vkd3d.
   - Then YCbCr with modifiers for GTK4, which must meet its bar (REPORT.md G) or stay on GL.
8. **The track's end:**
   - REPORT.md's VK3 section and the docs.
   - Plan §6/§7 revised from what VK3 learned.
   - The final NVIDIA run scripted, with the user's run outstanding as in VK2.

## The gate

- **On the user's NVIDIA desktop**, by their run:
  - vkcube and mpv on Vulkan are visible and right on the page's screen (screenshots against the guest's frames).
  - mpv meets its bar (no drops, the guest no busier than 19–27%).
  - VK0's scene costs no more a frame than on virgl at every size.
- **On SwiftShader and the M4:** the same, and the programs' replays stay within their tolerances.
- **For each emulated row taken:** its dEQP-VK groups are in the pass list, and the program it brings runs right
  (frames against lavapipe, as VK2's replays).
- **Pipelines:** a program's second run on a machine pays no compile it paid on its first.

## Deliverable

- REPORT.md's VK3 section with committed JSON: the NVIDIA numbers, the fence's breakdown, pipelines cold and warm,
  each row's cost.
- The docs (vk/README.md, devices.md "Venus", graphics.md, backlog), plan §6 and §7, and THIRD_PARTY.md current.
- `scripts/ci.sh` and the CI scripts the changes touch passing. That includes `ci-deqp-vk.sh` with the grown list,
  and `ci-debian.sh` and `ci-machines.sh` at the track's end.

Notes between loops go in `VK3-HANDOVER.md`. I decide whether VK4 starts.
