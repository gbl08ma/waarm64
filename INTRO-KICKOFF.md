# INTRO: an introduction that becomes the machine — kickoff

The user's brief (2026-11-20), in their words:

> Right now, new visitors to waarm64 are taken straight to the demo page. Without harming too much the new-user
> accessibility of those demos [...] create an introduction/presentation page, that can work as a section "within" the
> toolbar and statusbar as with the demo page, or even better yet, seamlessly transitions into the normal view with the
> machine, the status bar and the toolbar once the users launch one of the demos. [...] I'd definitely like to evoke a
> bit of a "wow" factor. I'd like that introduction to be explanatory of what the project is in a first moment,
> followed or accompanied by a "us vs prior art/competition" section (see docs/comparison.md for some ideas), with a
> (potentially optional) "how it works" moment, that could include some animated visualizations of how the JIT works,
> how our video decode and GLES acceleration works, etc. It'd be cool if, for interested users, it went to greater
> detail to also explain/visualize the inner workings of the interpreter and JIT compiler, what an interpreted block
> looks like vs a JIT-compiled block, visualizations of what the aarch64 code looks like compared to the wasm code we
> produce and the final e.g. x86 code that comes out of that in a hypothetical x86 host. Could also be cool to have
> similar deep dives for how we manage wasm memories (including the spillover/NUMA ones), the graphics stack
> (particularly the vulkan translation, which I think is the most complex), and other aspects you find similarly worth
> it. Ideally these visualizations should comply, or at least not conflict, with our design system (even if they may
> require expanding said design system); avoid "Claude tropes" both in terms of visuals and copy (see also
> docs/copy.md; naturally, the text in this intro would need to be slightly less formal, have a bit of a more direct
> voice, and likely mention particular distros and software unlike our normal guidelines recommend).

On the hero's machine:

> A tiny live machine, we need to make sure it doesn't depend on anything that would cause additional browser
> permission prompts or incompatibility with most browsers. I know Firefox is not a priority, but from my tests even
> moderately heavy guests work to a point, and I'd like the page to not fail spectacularly on the first visit from
> Firefox. [...] No snapshots (unlike our decision for the Alpine and other demos): buildroot boots fast enough, and
> that will likely mean a smaller download.

> Terminal plus a framebuffer toy. That terminal should cycle, using a script, between a few of these toy demos, before
> handing control over to an interactive shell the user can use. Bonus points if that script starts with visuals that
> don't immediately look like linux running, for a reveal of sorts. [...] No demo network or any other network
> connection; this demo machine should store nothing in the browser (other than cached downloaded files, like browsers
> normally do); it shouldn't even be a "machine" as far as the UI "machines" model is concerned (I don't want users
> going back to it outside of this intro flow). Regarding the budget: the 10 MB is to be counted on top of the 2.5 MiB
> of the page itself (for a total download of ~ 13 to 15 MiB), and it's a guideline, not a hard cap [...]; we should
> still try to make it as tiny as possible.

> Also: this intro should be accessible again via a button in the "About" section.

On the draft of this brief:

> Clarification on "no speed claims": leave space for those later. Probably just a hero number "Up to X.y% faster than
> [the next best solution, named]" type of thing would do; obviously we'd have to drop it if, and this would be really
> unexpected, any of the competition surpasses our speed. It's ok to add dependencies for animations if they'd make
> our life easier. I believe Svelte's transition/animation packages are already in place, we can bring them in if
> they're not, and we can also bring in any other popular dependency, as long as it doesn't weigh too much on the
> page's download. Yes, avoid porting existing demos so we don't have one more thing to attribute (and so our first
> visual isn't literally "stolen"). I think Firefox will be able to boot the hero demo, but maybe other browsers like
> Safari won't, and so we need that safety net of either a static image or a fallback design that avoids the demo. OK
> to not have the demo autoplay on browsers with reduced motion enabled. All other gaps you filled with defaults have
> my OK. OK to change the "demos" decision to open the intro, naturally. The intro should still finish in the store,
> and skipping or "fast-forwarding" through the intro should lead the user to the store, unless they already have
> machines. OK to build the guest image in the dev VM, I can hand over this branch to a Fable session in the dev VM
> once we get to that loop, so that the design work can continue there. [...] For now, focus on the loops you can
> build here, then create a handover for the dev VM.

## Decisions taken (the user's choices, 2026-11-20)

- **Shape:** the intro is a full-window page with only the wordmark and a way past it. **It finishes in the demo
  store**, and Skip leads there too, or Home for a visitor with machines; the toolbar and the status bar come in as it
  is left, and a demo's Start grows its picture into the machine view.
- **The hero:** a tiny Buildroot guest boots by itself in the hero's frame: a framebuffer and a serial terminal, one
  vCPU, no disk kept, no network, nothing stored, not a machine of the Machines model. A script in the guest cycles a
  few framebuffer toys (the first not looking like Linux, then the reveal), then hands over an interactive shell. A
  cold boot, no snapshot. About 10 MB on top of the page's 2.5 MiB, a guideline; as small as it can be made.
- **Browsers:** no permission prompt on the way to the hero, and no spectacular failure in Firefox on a first visit.
  Chromium stays the only supported browser (decisions.md).
- **The comparison:** unkernel, v86, WebVM and JSLinux named, features only, dated and sourced from
  docs/comparison.md, with a short "where they lead". No speed claims until §3's rows are measured, **but with a
  place kept for one**: a single figure, "up to X.y% faster than" the next best, named; dropped if a peer is faster.
- **How it works:** one scroll. Each subsystem (the CPU's tiers, memory, GLES through virgl, video decode, Vulkan
  through Venus) gets a short animated overview; a deep dive unfolds in place, its code and data loaded when opened.
  **Deep dives in the first version: the CPU (interpreter, block interpreter, JIT; AArch64 beside our wasm beside
  V8's x86-64 and arm64) and memory (wasm memories, the TLB's fast path, spill memories and NUMA).** Vulkan's and
  GLES/video's deep dives come later (the backlog).
- **Truth:** the visualizations replay real captures made by a build-time tool, committed as data. No drawn stand-ins
  for code we don't produce.
- **Returning visitors:** with stored machines, Home as today; without, the intro. The intro has its own address
  (`#intro`) and a button in About. The demo store keeps its address and its page.

## Defaults for what the brief leaves open (the user's OK, 2026-11-20, as amended above)

1. **Dependencies for animation are allowed** (Svelte's own transitions and motion; another popular one if it earns
   its weight in the page's download). So far none is needed: CSS, SVG, the Web Animations API and the View
   Transitions API (the change made immediately where a browser lacks it).
2. **The toys are ours** (small C programs written for this, MIT, drawn to the framebuffer: no ported demo-scene
   code). Three, chosen in loop 1 by how they look at the hero's size and what they cost in bytes.
3. **The hero's guest is served with the page** (same origin, cached by the browser as any asset; one file: a kernel
   with its initramfs inside). It pauses when scrolled out of view or the tab is hidden, and is thrown away when a demo
   starts or the intro is left.
4. **When the hero can't run** (no shared memory, a core that fails to start; Safari is the likely case): a design
   that does without it (the machine's plate, built in loop 0) or a still of it, and the rest of the page, which
   doesn't need the emulator. The demos' own checks say what a demo needs, as today.
5. **Reduced motion** (`prefers-reduced-motion`): no autoplay, the hero's guest included (it starts on a click); each
   visualization is a stepper the visitor drives; the transitions are cuts.
6. **Narrow windows** (720 px and under): one column; code panes side by side become tabs.
7. **The words** go in the catalog as a new namespace (`intro`), and docs/copy.md gets a section for this page's
   voice (more direct, distributions and software named). The user reviews the copy before it ships.
8. **Under automation** the intro doesn't open by itself, as the store doesn't today; its tests open it by address.
9. **Design system:** the visualizations' needs (a code pane, a stepper, a diagram's tones, motion durations and
   easings) become tokens and `ui/` components, documented in docs/frontend-code.md.

## What needs the user's OK along the way

- **decisions.md "Demos"** changes: a first visit opens the intro, not the store; the hero's guest is a demo without
  a snapshot and outside the store. Confirming this kickoff is that OK.
- **A new guest image** (`images/`, a trimmed kernel configuration and an initramfs): built in the dev VM (Podman);
  a cloud session can't build it. Its boot gets no entry in `tests/steps.txt` unless the user wants one.
- **The capture tool's use of V8's code printing** (`--print-wasm-code`): x86-64 captured on an x86_64 host, arm64 in
  the dev VM. If Node's build can't print it, the choice of another way (a d8 build is a dev-only tool) is the user's.
- Any host ABI change the hero's machine turns out to need (none expected: it's a transient machine the page already
  knows how to run).
- The copy, and the clip or stills used as the hero's fallback.

## Loops

0. **The shell and the route:** the intro's page state, `#intro`, the first-visit rule, the About button, the wordmark
   and the way past it; the launch transition from a placeholder frame into the machine view with a demo started.
   Tests at the page's layer.
1. **The tiny guest:** kernel configuration, initramfs, the toys and the script; its size measured against the
   budget, its click-free time to first pixels measured in Chromium (bench/demo), a check in headless Firefox that it
   runs or falls back.
2. **The hero:** the guest running in the frame outside the Machines model, pausing, teardown, the fallback, the demo
   picker beside it; the first screenful's words.
3. **What it is and the comparison:** the sections' words and the feature table from docs/comparison.md §2 and §4,
   re-checked against the peers' sources on the day.
4. **The capture tool and the design system's additions:** real blocks, their micro-ops, our wasm, V8's output;
   the code pane and the stepper.
5. **The overviews:** one animation per subsystem.
6. **The CPU deep dive.**
7. **The memory deep dive.**
8. **The end:** an out-of-context review, the docs (frontend.md, decisions.md, copy.md, comparison.md, images.md),
   the backlog's entries (the Vulkan and GLES/video deep dives, live panels fed by the running machine), the whole CI
   set, screenshots, PLAN.md's row.

## Validation

Each loop passes `scripts/ci-fast.sh`; before a push `scripts/ci.sh` and `scripts/ci-debian.sh` (the page), plus
`scripts/ci-machines.sh` when the first-visit rule or Home is touched. The hero's download and time to first pixels
are recorded in `bench/demo/REPORT.md` with their JSON. The intro's states join the screenshots tool.

## The end

A first visit to vm.tny.im's build shows the intro with the tiny guest running inside the budget; a demo started from
it becomes the machine view without a page change; the comparison and the two deep dives are in; the docs say how it
works; this file and the handover are deleted. Deploying is on the user's word.
