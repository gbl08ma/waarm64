# INTRO: handover

The introduction page (the brief: [INTRO-KICKOFF.md](INTRO-KICKOFF.md); what exists: docs/frontend.md "The
introduction"). Built in a cloud session on branch `claude/gallant-fermi-d53q4y`, merged into `main` on 2026-11-20 by a
dev VM session that ran the push tier and added the arm64 captures. The next session (Fable's) starts at loop 1, in the
dev VM.

## Where it stands

| Loop | What | Tier it passed |
|---|---|---|
| 0 | The page's state and address (`#intro`, a first visit), its bar and Skip, the first screen with the machine's plate, the end that leads to the store, About's button; the `intro` and `launch` view transitions | push tier |
| 3 | "What runs on it" (four readouts, six topics) and "Compared with the others" (the table, where they lead, sources; the place kept for one speed figure) | push tier |
| 4 | `tools/intro-capture.ts` and the core's `capture` feature; `web/intro-captures/blocks.json` with five blocks; `ui/CodePane.svelte`, `ui/Stepper.svelte`, the motion and code tokens | push tier |
| 5 | "How it works": five paths (the processor, memory, OpenGL, video, Vulkan) | push tier |
| 6 | The processor's deep dive: the captured code in four panes | push tier |
| 7 | Memory's deep dive: the RAM slider over `splitRam` | push tier |
| — | The captures' AArch64 host column (the dev VM: V8 14.6.202.34-node.28) beside x86-64's; the viewer shows the visitor's own architecture first (`IntroTranslate.svelte`, `local-release.ts` `thisTarget`) | push tier |

**CI** (the dev VM, 2026-11-20): `scripts/ci.sh` passed on 1791b60a (the arm64 captures and three flake fixes);
`scripts/ci-debian.sh`, `scripts/ci-graphics.sh`, `scripts/ci-machines.sh` and `scripts/ci-jit.sh` passed on
4b24f2d4 (the merge; what came after touches no area of theirs: the captures' data and the introduction's viewer,
three tests, one type). The flakes `scripts/ci.sh` hit on the way, each fixed with its cause shown: the "Both's
divider" test read a mid-drag width under load; `tests/audio-page.test.ts` hung for good after a failed check (an
open port), the 17-minute idle stall; the lint's types depended on file order (`web/snapshot.ts` before
`web/snapshot-file.ts` made the overlay's loop `any`).

The arm64 column: `wasm-tools` must be the same version on both hosts (the tool compares its text to keep the other
host's column), so the dev VM's is now 1.263.0, the cloud's. The arm64 text read clean: branches as offsets, no
` (addr 0x…)` left, calls to V8's stubs as `bl #-0x…`.

**Not built: loops 1 and 2 (the tiny guest and the live hero) and loop 8 (the end).**

## What the next session does

1. **Loop 1, the tiny guest** (the kickoff's "On the hero's machine" is the brief; the user's words there bind):
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
2. **Loop 2, the hero**: the guest running in the first screen's frame.
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
3. **Loop 8, the end**, as the kickoff says: an out-of-context review, the docs, the backlog's entries, every tier,
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
