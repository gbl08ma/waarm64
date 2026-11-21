# DOMAINS — handover

The track's brief is [DOMAINS-KICKOFF.md](DOMAINS-KICKOFF.md). This file carries it from loop to loop.

## Loop 1: Home's levels, and a connection's Details (2026-11-21, cloud session)

**What it did**
- **Levels in Home.** `machinesNav` (web/app/areas/machines-nav.svelte.ts) has a context, `{ kind: 'connection', id,
  section, from }`, with `enter`/`leave`/`reset`, the `direction` the transitions read, `context` (derived: none once
  the connection is gone; Domains of a non-room is its Details), `back` (where Back leads now) and `level` (the key).
  The logic that can be pure is in **`web/app/home-route.ts`** (DOM-free, `tests/home-route.test.ts`): `homeRoute` /
  `homeHash` (the address), `shownContext` (the fallback), `backOf` (a tab whose machine is gone, or the screen with no
  machine loaded, leads to Connections). `From` is `{ to: 'connections' } | { to: 'tab'; machine } | { to: 'screen' }`.
- **The address**: `web/app/areas/home-levels.ts` (`HomeLevels`, made by `PageWindow` as `pageWindow.home`;
  `writeHome`) enters, leaves and writes `#home` / `#home/connections/<id>[/settings|/domains]`, always with
  `replaceState`, as Home always did (the browser's Back isn't wired into levels: see below). `#machines` still opens
  the root; a change of fragment to a Home address follows it (`hashChange`). `page.openConnection(id, section, from)`
  and `page.leaveContext()` are the page's calls. main.ts now awaits `net.refresh()` before the address opens Home, so
  a reload on a connection's address doesn't fall back for want of the list.
- **The column**: `HomeColumn.svelte` (the `nav`, keyed by level, grid-stacked `.level` blocks), `MachinesNav.svelte`
  (the root's entries; Back to the machine moved to the top, same condition and `data-action="back-to-machine"`),
  `ConnectionNav.svelte` (Back `data-action="back"` `data-back=<to>`, the name with "kind · state", sections
  `data-section=…`; the commands' place is a comment under them), `HomeBack.svelte` (the shared Back).
- **Transitions**: `web/app/home-level.ts`, one `level` transition for the column's blocks and the pane's slot
  (MachinesPage's `.slot` / `.level`): 150 ms `cubicOut`, 24 % of the block's width plus a fade; a plain fade under
  `prefers-reduced-motion`. The direction is read from `machinesNav.direction` when the transition starts (not a
  parameter: crossfade.ts's `derived_inert` finding). Sections within a level and the root's panes are instant (same
  key).
- **Esc** (MachinesPage `escape`): in a context, `page.leaveContext()`; at the root as before. Same guards (dialog,
  open `details`, a field being typed in), and in a context it doesn't need a machine on the page.
- **Focus**: entering, the pane's title takes the focus (`Pane`'s new `takeFocus` prop, `machinesNav.takeFocus()`; the
  `h3` has `tabindex="-1"`); leaving for Connections, the card's Details button (`machinesNav.takeReturn`).
- **Connections' cards** gain **Details** (`data-action="connection-details"`); Edit…, New address, Log out and Delete
  stay on the card for loop 2.
- **ConnectionDetails.svelte** (+ **ConnectionRoom.svelte**, a room's part, to stay under the size rule) from the
  dialog's body, in `ConnectionPage.svelte` (Settings and Domains: a Pane with its title only). Machines first
  (`connection-users.ts` `usersOf`, shared with the cards; each stored machine a link to its Network tab), then the
  stored values always and the live view while `net.runs(id) >= 0`; else `ConnectionDetails.notHere` / `.otherTab`.
  Ids kept: `#net-details` is now the pane's content wrapper (so `#net-details [data-name=…]` still works),
  `net-details-*` fields as before, new `#net-details-adapter`, `#net-details-elsewhere`,
  `#connection-details-machines`. Edit connection… stays (pane head, `#net-details-edit`) and the `NameEntry` cards and
  registry line show exactly as the dialog had them.
- **The toolbar**: Details… and the room's warning call `page.openConnection(id, 'details', { to: 'screen' })`.
  `NetDetails.svelte`, `network.details` and `network.openDetails` are gone. The pairing link's code moved out of
  page-window.ts into `areas/pairing.ts` (page-window.ts was at the 300-line lint limit).

**Where it differs from the kickoff, and why**
- **Keys renamed.** The kickoff says `NetDetails.*` stay "as they are", but `tools/i18n-check.ts` refuses a key whose
  stem names no file using it ("a key starts with the stem of the file that uses it"). They became
  `network:ConnectionDetails.*` and (a room's) `network:ConnectionRoom.*` (`NetDetails.room.note` →
  `ConnectionRoom.note`, etc.), words unchanged, notes updated; `NetDetails.close` removed. The new Details lines are in
  `machines:ConnectionDetails.*` as the kickoff says. Tests and docs follow.
- **The Domains section has no count yet** (needs the titles by connection: loop 4/5 with `member`).
- **No new entry point from a machine's Network tab** in this loop (the kickoff's ways in from there are loop 2's
  wizard choice and loop 5's link); `from: { to: 'tab' }` works and is tested through `page.openConnection`.
- A transient (page's own) machine named among a connection's machines is plain bold text, not a link (it has no
  Network tab). A link is found by the machine's name (T's `name` snippet gets the words): two machines with one name
  would both lead to the first.
- The pane title of Details is "Details" (no meta line).

**Tests**: `tests/home-route.test.ts` (unit: the address, the fallback, Back's target);
`tests/page-home-levels.test.ts` (Chromium, no guest: a reload on a connection's address, Back to Connections, the
sections, Esc with the focus back on the card, Back to the machine first at the root, the column's two blocks during a
move, the pane's title focused, a tailnet without Domains, the machine link to its Network tab, Back to `<machine>` and
to the screen, Home at its root after closing, an unknown id). `tests/page-room.test.ts` follows the new path (Details…
→ the page, Back to the machine) but needs the room rigs and a guest: not run here.

**For the next loops**
- Loop 2: the commands' place is the comment in `ConnectionNav.svelte` (under the sections; a `div` with a rule like
  MachinesNav's `.new.ruled`). Delete from the page: `shownContext` already falls back to Connections when the
  connection goes. The wizard's "edit" choice should call `page.openConnection(id, 'settings', from)` with `from` the
  wizard's opener (`{ to: 'tab', machine }` or `{ to: 'screen' }`). `ConnectionDetails.edit` (Edit connection…) and
  `ConnectionDetails.local.link`'s mention of it go then.
- Loop 4: `ConnectionPage.svelte`'s Domains placeholder is where `DomainsPane` goes; ConnectionRoom's `NameEntry` loop
  and registry line move there.
- The browser's Back/Forward don't move between levels (addresses are replaced, as Home's always were). If wanted,
  push in `HomeLevels` and follow `popstate` in `PageWindow.followAddress`.
- `ConnectionNav` reads `net.connections` for the name; a connection renamed elsewhere updates it live.
- Ad-hoc screenshot script: `bench/results/local/loop1-shots.ts` (git-ignored).

## Tiers passed

| Commit | Tier |
|---|---|
| DOMAINS loop 1 | T1 (`scripts/ci-fast.sh`: OK, 437 s, 166 files). T2 as far as a cloud session goes: `scripts/ci.sh`'s static checks, Rust tests, TestFloat and builds passed; its **agent** step failed with the six known root-container failures (docs/cloud.md: `x11::…display_socket_gets_the_cookie` and five `serve_test` cases), which stops the script, so its JS step was run by hand with ci.sh's settings (`WAARM64_DISTROS=` (no Alpine images), `WAARM64_LONG_TESTS=1`, `node --test 'tests/**/*.test.ts'`): 1461 passed, 0 failed, 618 skipped (images, rigs, topic-only). Not run: ci.sh's TSan and native guest-image steps (no images here). Of the topic scripts ci-fast names (ci-net, ci-debian, ci-graphics, ci-machines), only `tests/page-room.test.ts` was run (Debian via `images/build.sh debian`, `WAARM64_NET_TESTS=1 WAARM64_TAILCAT=1`): passed (256 s), Details… → the page and Back included. The four scripts whole are left for the dev VM. |
