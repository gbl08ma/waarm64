# INTRO: handover

The introduction page (the brief: [INTRO-KICKOFF.md](INTRO-KICKOFF.md); what exists: docs/frontend.md "The
introduction"). Built in a cloud session on branch `claude/gallant-fermi-d53q4y`, merged into `main` on 2026-11-20 by a
dev VM session that ran the push tier and added the arm64 captures. Loops 1 and 2 (the tiny guest, and the guest in the first screen) were
built in the dev VM the same day. What is left is loop 8, the end.

## Where it stands

| Loop | What | Tier it passed |
|---|---|---|
| 0 | The page's state and address (`#intro`, a first visit), its bar and Skip, the first screen with the machine's plate, the end that leads to the store, About's button; the `intro` and `launch` view transitions | push tier |
| 3 | "What runs on it" (four readouts, six topics) and "Compared with the others" (the table, where they lead, sources; the place kept for one speed figure) | push tier |
| 4 | `tools/intro-capture.ts` and the core's `capture` feature; `web/intro-captures/blocks.json` with five blocks; `ui/CodePane.svelte`, `ui/Stepper.svelte`, the motion and code tokens | push tier |
| 5 | "How it works": five paths (the processor, memory, OpenGL, video, Vulkan) | push tier |
| 6 | The processor's deep dive: the captured code in four panes | push tier |
| 7 | Memory's deep dive: the RAM slider over `splitRam` | push tier |
| 1 | The guest: `images/intro/` (its kernel fragment, `init`, `tour`, `cycle`, the toys `scope`, `ridges`, `life` over `screen.h`), `images/build.sh intro`; its runner `web/app/intro/guest.ts`, `guest-worker.ts`, `guest-protocol.ts`; `tests/intro-guest.test.ts`; the bench's target `waarm64-intro-guest` and `bench/demo/intro-firefox.ts`; numbers in bench/demo/REPORT.md "INTRO loop 1" | push tier (`scripts/ci.sh`, the dev VM, 2026-11-20) |
| 2 | The hero: `intro/IntroGuest.svelte` and `guest-run.svelte.ts` (the frame: screen, our line by the tour's marks, terminal, counters; paused out of view and in a hidden tab; a button under reduced motion and after a power-off; the plate where it can't run); the guest's file and `INTRO-LICENSES.txt` in `npm start` and `npm run dist` (which takes a current image only), About's group and `THIRD_PARTY.json`'s row; `tests/page-intro-guest.test.ts`; the bench's target `waarm64-intro`; numbers in REPORT.md "INTRO loop 2" | push tier: `scripts/ci-debian.sh` passed; `scripts/ci.sh` passed but for one assertion of `tests/page-intro-guest.test.ts` (Playwright listing a worker the page had ended), corrected in the test and passed 8 runs alone after (the dev VM, 2026-11-20) |
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

**The numbers** (bench/demo/REPORT.md "INTRO loop 1", "INTRO loop 2"): the guest is one file of 1.68 MB (gzip); a
first visit downloads ~4.4–4.7 MB in all (the page ~0.75, the guest 1.68, the core ~2). The first picture is on the
frame ~0.6 s after the navigation (0.93 s under the bench's harness), in Firefox too (the bare guest: 0.59 s); a shell
80 ms after a key. ~170 MiB of tab; a toy costs ~40% of a core while it draws, nothing while out of view.

**Not built: loop 8 (the end).**

## What the next session does

1. **Loop 8, the end**, as the kickoff says. Done of it (2026-11-20): the out-of-context review (branch
   `review/intro`, 14 findings: the visitor-facing ones and the weak tests fixed with their tests, the rest in
   docs/backlog.md "The introduction's out-of-context review"), the screenshots tool's states
   (`tools/screens-intro.ts`), the backlog's entries, the docs. The review's fixes passed `scripts/ci-debian.sh`, and `scripts/ci.sh` but for one clipboard page test that has
   nothing of the introduction and passed 3 runs of 3 alone (filed: backlog "Tests and tools"). **Left: the user's
   review of the copy** (below), then
   every tier on the commit that ends the track, PLAN.md's row set to done, this file and the kickoff deleted.

## Things the user decides or reviews

- **The copy.** All of it is the catalog's `intro` area (`web/messages/en/intro.json`, ~200 entries), written in the
  voice docs/copy.md "The introduction" sets out. The user reviews it before it ships; none of it has been reviewed.
- **The core's `capture` feature** was added without asking (a Cargo feature, off by default, no export or ABI
  change; frontend.md "The captures"). It is the only way found to say truthfully which WebAssembly lines a guest
  instruction became. If the user would rather not have it in the core, the fallback is a viewer without the
  per-instruction highlighting in the WebAssembly and host panes.
- **The speed figures** (`web/app/intro/speed.ts` `SPEED`): 1.9× as fast as unkernel (the next fastest) and 4.0× as
  fast as v86, at one Perl workload on the dev VM (bench/compare/REPORT.md, 2026-11-20; the user chose the peers, the
  kind of workload and both figures). Not measured on a Mac or x86-64, where V8 spares our code its bounds checks:
  REPORT.md's first "not measured". unkernel moves fast (its user space changed ISA the day before): measure again
  before a deploy.
- **The comparison's date** (`web/app/intro/compare.ts` `CHECKED`, 2026-11-20): unkernel was read again in full that
  day (aarch64 user space, Debian, up to 4 CPUs; its demo re-measured) and every project for sound, files and
  license; WebVM's, v86's and JSLinux's other rows are still 2026-11-18's. Check them before a deploy.
- **A still or clip** for the hero's fallback, if the plate alone isn't wanted.
- **The first screen's layout** (loop 2): the live frame takes the plate's place, and the plate shows only where the
  machine can't run (the two together were too tall for a first screen). Screenshots: `node
  bench/results/local/intro-shot.ts <dir>` (ad hoc, git-ignored) or the page itself on `npm start`.
- **The frame's words** (`intro:IntroGuest.*`, 12 entries: a line a mark, the buttons): unreviewed, like the rest.
- **Words added at the user's asking, 2026-11-20, unreviewed too:** the code viewer's notes
  (`intro:IntroTranslate.why.*`, 25: what each run of captured lines is for; what they claim of V8, the bounds checks
  by processor and the loop's check, is docs/v8.md's and the captures' own, held by `tests/intro-notes.test.ts`);
  the demo store's Things to try (`machines:DemoIdeas.*`, 20: the user's own trials, worded by us); the comparison's
  rows for sound and for files from the visitor's computer (docs/comparison.md has each cell's source, read that
  day), "Chromium-based first", JSLinux's license, ISO among the images.
- **Serving the guest's image from the page's own host** (the user asked about bundling, 2026-11-20): it is its own
  file (`assets/intro.img-<hash>.gz`), fetched by the guest's worker and never part of a script, as a disk image is.
  It could instead live on vmdisks.tny.im with the demos' disks (a `Cross-Origin-Resource-Policy` header there, a
  second deploy step); not done, and not asked for.
- **The guest's pictures and its tour** (loop 1): three toys in the page's orange on black (an X-Y oscilloscope, a
  flight over ridge lines, Life with fading cells) and the commands the tour types (`uname -srm`, `ls /toys`,
  `ridges &`, `life &`). Stills: run `node bench/demo/run.ts waarm64-intro-guest --runs 1` and open
  `bench/results/local/demo/waarm64-intro-guest-1.png`, or `bench/demo/intro.html` on `npm run serve`.
- **BusyBox is Alpine's static package**, not Buildroot's (the brief said "buildroot boots fast enough"): the same
  BusyBox, without a ten-minute toolchain build; a smaller one of our own configuration is REPORT.md's first
  "not tried".
- **Deploying**: only on the user's word.

## Notes for whoever continues

- **Changed outside the introduction at the user's asking** (2026-11-20, a5e85e2d and after): a load that opens the
  introduction, Home or the store leaves the machine opened last stopped (`power-actions.ts` `boot(elsewhere)`;
  frontend.md "What a load starts under it"); the demo's pane keeps its head to its content's width
  (`ui/Pane.svelte` `--pane-width`); the store's list ends with Things to try (`DemoIdeas.svelte`).

- **GPL sources: pinned links, no tarballs of ours** (the user, 2026-11-20): a GPL binary the page distributes needs
  links to exactly what it was built from, pinned by a commit or as durable an identifier as there is.
  `INTRO-LICENSES.txt` has kernel.org's tarball with its SHA-256 and Alpine's aports commits for `busybox-static` and
  `musl-dev`; `images/build.sh intro` checks the packages' recorded commits against `INTRO_BUSYBOX_COMMIT` and
  `INTRO_MUSL_COMMIT`, so a bumped package can't ship under the old links.

- **Not done in loop 2, for loop 8 or the backlog:** the `launch` transition doesn't name the frame (leaving for a
  demo crosses over as before); in a window under ~500 px the frame's terminal is cut at its right end (64 columns
  at 12 px); the first picture could come ~190 ms sooner with a preload (REPORT.md "INTRO loop 2"); a BusyBox of our
  own configuration would take ~0.3 MB off the guest (REPORT.md "INTRO loop 1").
- `tests/page-intro-guest.test.ts` counts a worker as alive only if it answers: Playwright's `page.workers()` keeps a
  terminated one about one run in five.
- Every page test that opens the introduction now boots the guest where the image is built (~0.5 s, 64 MiB).

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
