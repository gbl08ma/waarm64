# The demo store's page and the toolbar's ways back: handover for the merge

**Delete this file in the merge's commit, once the lanes below pass in the dev VM.** It isn't a track's: the DEMO track
is closed on `main`, and these are UI adjustments made after it (2026-11-20, a cloud session) on the branch
`claude/laughing-maxwell-jercdj`, which also carries the page's new look (four commits from before this work: e5a7fae,
6efeee2, 1b3ea01, 2a79e9a, whose own tier this session doesn't know). What exists is in docs/ already
([frontend.md](docs/frontend.md) "The demo store" and "The toolbar", [copy.md](docs/copy.md) "A first-time visitor's
screens", [frontend-code.md](docs/frontend-code.md) §2); this file is what the merge needs to know.

## The merge

`main` moved since the branch's base (eae82627): it closed the DEMO track (DEMO-KICKOFF.md, DEMO-HANDOVER.md and
docs/plans/first-demo.md deleted; this branch leaves those three as they were at the base, so their deletion merges
cleanly) and touched docs/machines.md, web/app/demo-store.ts and web/app/definitions.ts, which this branch's work is
near (docs/machines.md §6.2 has one word changed here). Commit messages on the branch say "DEMO:" for the first of
these changes: they were written before the user said the work isn't the track's.

## Lanes to run on the merge's result (the dev VM, one at a time)

| Lane | Why |
|---|---|
| `scripts/ci.sh` | before any merge; the branch adds a dependency (`@fontsource/barlow`), which the selector treats as "every heavy file" |
| `scripts/ci-debian.sh --platform` | the page and the catalog changed; the selector also names the agent's area |
| `scripts/ci-machines.sh` | Home and the demo store; `tests/page-demos-guest.test.ts` chooses a row and starts it (needs the demo templates linked in), which no cloud session can run |
| `scripts/ci-net.sh` | `page-network`, `page-room` and `page-connections` use the Back hook and `openHome` |
| `scripts/ci-usb.sh` | the USB menu's offer is a `ui/Callout` now |
| `scripts/ci-graphics.sh`, `scripts/ci-audio.sh` | optional and short: they drive the Machine and Sound menus, which the new look redrew |

Not needed: `ci-jit.sh`, `ci-fp.sh`, `ci-deqp.sh`, `ci-deqp-vk.sh` (no core, JIT, FP, 3D or Vulkan change).

## What changed, and what can break in the lanes the cloud couldn't run

- **The demo store's page** is a list beside the chosen demo's pane (one column at 720 px and under); its words were
  rewritten for a first-time visitor; with every browser check met one line says so; a click that would stop a running
  download asks first (`web/app/demo-leave.ts`); errors and warnings are `ui/Callout` boxes. Hooks: rows are
  `.cards [data-demo]` (a bare `[data-demo=…]` now also matches the pane, `article.start[data-demo]`).
- **No Back rows.** The toolbar's Home is a toggle and the wordmark (`Wordmark.svelte`, `#wordmark`) a button back to
  the machine. Two consequences for tests, both handled here but mostly run only in the dev VM:
  - `[data-action=back]` is the wordmark's while Home or the store shows. Unscoped uses stand; the scoped ones
    (`.machines [data-action=back]`, `modal(page).locator(…)`) were changed to the wordmark's or to `#machines-open`.
    A scoped use this session missed fails as "waiting for locator('.machines').locator('[data-action=back]')".
  - A click on `#machines-open` closes a Home that's already open (a reload at `#home` keeps it open). 28 test files
    now open Home with `openHome` (tests/page-home.ts). A test that fails with the machine's screen "intercepting
    pointer events" over Home's list is this.
- **The words:** toolbar:Toolbar.name is toolbar:Wordmark.name; machines:MachinesPage.back and DemosPage.back are
  gone; Home's busy words are at the end of its bottom bar (`StorageBar`'s `busy`).
- bench/snapz/probe.ts (the closed SNAPZ track's) is left as it is, the user's call: its "if Home shows, click Home"
  lines now close Home.

## What passed in the cloud session

`scripts/ci-fast.sh` over each change. At the head: the last commit that touches this file says. Known there: tests/page-open.test.ts's
"says so at once" failed once under the lane's load (8.0 s) and passes alone (4.4 s); `tools/screens.ts`'s
`machines-error` state isn't reached, with or without these changes (not a CI step).

## Open with the user

- The demos' own summaries (deploy/disks/demos.json, the store's data) and the `demo-store.*`/`template.*` errors'
  words weren't part of the copy review.
- The room's note says the machine's name is found in the toolbar's Network menu (the user's wording): not checked
  against a running demo here.
