# INTRO: handover

The introduction page (the brief: [INTRO-KICKOFF.md](INTRO-KICKOFF.md); what exists: docs/frontend.md "The
introduction"). Branch `claude/gallant-fermi-d53q4y`. Written 2026-11-20 at the end of a cloud session (x86_64, no
Podman), for a session in the dev VM.

## Where it stands

Built in the cloud session, in the order built:

| Loop | What | Tier it passed |
|---|---|---|
| 0 | The page's state and address (`#intro`, a first visit), its bar and Skip, the first screen with the machine's plate, the end that leads to the store, About's button; the `intro` and `launch` view transitions | fast lane (see "CI" below) |
| 3 | "What runs on it" (four readouts, six topics) and "Compared with the others" (the table, where they lead, sources; the place kept for one speed figure) | fast lane |
| 4 | `tools/intro-capture.ts` and the core's `capture` feature; `web/intro-captures/blocks.json` with five blocks and the **x86-64** host column; `ui/CodePane.svelte`, `ui/Stepper.svelte`, the motion and code tokens | fast lane |
| 5 | "How it works": five paths (the processor, memory, OpenGL, video, Vulkan) | fast lane |
| 6 | The processor's deep dive: the captured code in four panes | fast lane |
| 7 | Memory's deep dive: the RAM slider over `splitRam` | fast lane |

**CI:** `scripts/ci-fast.sh` passed on the branch's head as of commit `0554224` (2026-11-20, the cloud container:
the static checks, the core's crate, the smoke set and the areas' heavy files). The introduction's own tests are
`tests/intro-route.test.ts` and `tests/page-intro.test.ts`.

**Not built: loops 1 and 2 (the tiny guest and the live hero) and loop 8 (the end).** Nothing here has passed
`scripts/ci.sh` or a topic script: the cloud can't run the push tier as the dev VM does (docs/cloud.md: six of the
agent's tests fail as root and stop `scripts/ci.sh`; no Debian guest for `ci-debian.sh`). **Run the push tier in the dev
VM before anything else**: `scripts/ci.sh`, `scripts/ci-debian.sh`, `scripts/ci-machines.sh` (the first-visit rule and
Home's About changed), and `scripts/ci-jit.sh` (the core's JIT emitters gained `Code::note` calls: nothing in a normal
build, and the capture tool checks the modules are byte for byte the same, but the JIT's tiers are the rule).

## What the dev VM session does next

1. **The push tier**, above. Fix what it finds first.
2. **The arm64 host column.** At this branch's head: `scripts/build-wasm.sh`, then `node tools/intro-capture.ts` (no
   `--build-guest`: the committed `tools/intro-capture/guest.bin` is what both hosts capture). It adds `host.arm64` to
   `web/intro-captures/blocks.json` and keeps `x64`, provided the WebAssembly is the same (same core commit). The
   tool's clean-up of V8's arm64 text (stripping ` (addr 0x…)`) was written without an arm64 V8 to try it on: read a
   few lines of the result. The viewer then shows a chip per architecture by itself (`IntroTranslate.svelte`
   `arches`); consider choosing the visitor's own architecture first (`navigator.userAgentData`).
3. **Loop 1, the tiny guest** (the kickoff's "On the hero's machine" is the brief; the user's words there bind):
   - A new image in `images/` (Podman): a trimmed kernel (start from `images/linux.fragment`'s `allnoconfig` base and
     cut: one vCPU is enough, PL011, a simple framebuffer or virtio-gpu 2D, no network, no block device, no modules)
     with its initramfs inside, one file, served with the page. Budget: ~10 MB on top of the page's ~2.5 MiB, a
     guideline; as small as it can be made (try `Image.gz` against an xz initramfs inside an uncompressed Image the
     host's brotli compresses; measure what goes over the wire, not the file).
   - The toys: three small C programs of our own drawing to the framebuffer (no ported demo code: nothing to
     attribute, and the first picture mustn't be someone else's). The script in the guest shows the first before
     anything looks like Linux (quiet boot, no console on the framebuffer), cycles them, then hands over an
     interactive shell on the serial terminal.
   - Cold boot, no snapshot, no network, nothing stored, **not a machine of the Machines model** (no record, never on
     Home, not reachable outside the introduction).
   - Measure: bytes on the wire and time to first pixels and to the shell, in Chromium (`bench/demo/`), recorded in
     `bench/demo/REPORT.md` with JSON. Check headless Firefox in the dev VM: it runs, or the page falls back.
4. **Loop 2, the hero**: the guest running in the first screen's frame.
   - Where: `web/app/intro/IntroHero.svelte`. Today the plate (`IntroPlate.svelte`) sits where the frame goes. The
     plate **is the fallback design** for a browser that can't run the guest (the user: "either a static image or a
     fallback design that avoids the demo"; Safari is the likely case): keep it, shown when the guest can't start, and
     probably under or beside the frame when it can.
   - How it runs is the open design question: the page has one machine (`run/page-machine.svelte.ts`) with its areas,
     toolbar and status bar. The hero's guest must not be that machine (it stores nothing and must not appear as the
     page's machine, nor stop a stored machine running under the introduction when it's opened from About). A second,
     small runner (its own worker, its own canvas and xterm.js terminal inside the hero) is the likely shape; look at
     what `tests/demo-fixture.ts` and the bench pages use to run a machine without the page.
   - It pauses when scrolled out of view or the tab is hidden (`intro/autoplay.svelte.ts` has the observer), and is
     torn down when a demo starts or the introduction is left (host-code.md: teardown frees what start took).
   - `prefers-reduced-motion`: it doesn't start by itself; a click starts it (the user's OK).
   - No permission prompt on the way (no clipboard, no storage, no audio until a gesture).
   - Idea from the cloud session, not built: under the frame, readouts fed by the running guest (instructions run,
     blocks compiled to WebAssembly, MIPS), using `IntroReadout.svelte`: real numbers moving on a first visit.
   - The `launch` transition names the demo's picture in the store's pane and the machine's place. With a live frame in
     the hero, consider naming the frame too, so leaving the introduction for a demo's pane carries it across (today
     the introduction's bar becomes the toolbar and the rest crosses over).
5. **Loop 8, the end**, as the kickoff says: an out-of-context review, the docs, the backlog's entries, every tier,
   the screenshots tool (`tools/screens.ts`: the introduction's states aren't in it yet), PLAN.md's row, this file and
   the kickoff deleted.

## Things the user decides or reviews

- **The copy.** All of it is the catalog's `intro` area (`web/messages/en/intro.json`, ~200 entries), written in the
  voice docs/copy.md "The introduction" sets out. The user reviews it before it ships; none of it has been reviewed.
- **The core's `capture` feature** was added without asking (a Cargo feature, off by default, no export or ABI
  change; frontend.md "The captures"). It is the only way found to say truthfully which WebAssembly lines a guest
  instruction became. If the user would rather not have it in the core, the fallback is a viewer without the
  per-instruction highlighting in the WebAssembly and host panes.
- **The speed figure**: `web/app/intro/speed.ts` `SPEED_LEAD` is undefined. Filling it needs docs/comparison.md §3's
  rows measured (a benchmarking loop of its own).
- **The comparison's date** (`web/app/intro/compare.ts` `CHECKED`, 2026-11-18, comparison.md's own): the cloud
  session didn't read the peers' sites again. Check them before a deploy and move the date.
- **A still or clip** for the hero's fallback, if the plate alone isn't wanted.
- **Deploying**: only on the user's word.

## Notes for whoever continues

- The introduction never opens by itself under automation; tests use `?firstvisit=1` or `#intro`
  (`tests/page-intro.test.ts`).
- `App.svelte` is at its 300-line limit (the lint's `max-lines`): the `launch` transition's name for `main` is in
  `theme/base.css` for that reason.
- A `view-transition-name` is applied only under `html[data-vt]`, while a transition runs: named all the time, the
  toolbar would be a stacking context and its menus would open under the screen.
- The catalog's check reads keys from the file that renders them: tables of literal keys in the component
  (`IntroCompare.svelte`, `IntroHow.svelte`), never keys built from a template string, and a key starts with its
  file's stem.
- A message that is one common word ("Vulkan", "Disk images") collides with the check's rule that tests and docs take
  the page's words from the catalog: such titles here are worded to be the introduction's own ("Vulkan on WebGPU").
- Recapturing (`node tools/intro-capture.ts`) changes line counts; the words never state them (the stepper counts
  live). Read `IntroTranslate`'s five "what to look for" paragraphs against a new capture all the same: they describe
  what the WebAssembly does (one TLB probe for a group, the compare without flags, `f64.add` and its checks).
- Found while reading for the copy, not fixed (docs only; filed in docs/backlog.md "Documentation"): docs/jit.md
  gives the TLB entry mask as `0x7ff80` where the emitted code masks with `0x1fff80` (16,384 entries); docs/architecture.md
  still says memory 0 holds "≤ ~3.5 GiB" of RAM (it's 3 GiB less 1 MiB); docs/testing.md's dEQP-VK counts don't match
  `tests/deqp/vk.txt`.
- Left for the backlog (kickoff): deep dives for Vulkan and for OpenGL and video; panels fed by the running machine.
