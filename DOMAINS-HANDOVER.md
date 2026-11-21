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

## Loop 2: a connection's Settings, the column's commands, the wizard's first choice, levels in history (2026-11-21, cloud session)

**What it did**
- **Settings** (`ConnectionSettings.svelte`, with `ConnectionTailcatSettings.svelte` and `ConnectionRoomSettings.svelte`
  for the two big kinds; the draft, its comparison and its checks DOM-free in **`web/app/connection-settings.ts`**,
  `tests/connection-settings.test.ts`). In a `Fields` grid: the name, then a tailnet's hostname (control server shown
  disabled), tailcat's exit switch and address, serve switch, relay and allow list, the helper's link (its install
  lines folded under it), the demo network's server, a room's two switches and, under Advanced, its key to copy and
  New name. `SaveRow` (now typed on a small `Draft` interface, so a MachineEdit and the Settings both fit; Revert got
  `data-action="revert"`). Save validates with the wizard's own messages (an error goes to the Home page's banner
  through the page's runner, `act`), then `page.netEdit` (which reconnects an adapter here that runs it, so the
  change is live: hence no "Changes apply the next time…" line) or `page.netRename` when only the name changed. Save
  builds from the record as it is at that moment, so New name then Save keeps the new key. The draft follows the record
  unless dirty, and is dropped on leaving the section (as a machine's).
- **The choice for the steps' edit branches: moved out.** The steps no longer know editing (`Flow` lost `editing`,
  `edited`, `edit`, `forget`; `EDIT_STEP`, `roomEdit`, `mode: 'edit'` gone). The Settings reuse the steps' catalog
  entries where the words are the same (allowed: the stem's own file still names them), and the edit-only entries
  moved: `NetTailnetStep.control.edit` → `network:ConnectionSettings.tailnet.control`, `NetLocalStep.local.link` →
  `ConnectionSettings.local.link`, `NetRoomStep.room.exportKey*` / `.newName*` → `ConnectionRoomSettings.key*` /
  `.newName*` (words unchanged). `NetTailcatStep.newAddress*`, `NetWizard.save`, `NetWizard.title.edit`,
  `ConnectionEditButton.*` and `ConnectionDetails.edit` are removed. New words of mine (not in the kickoff): the tailcat
  address field's label, `ConnectionTailcatSettings.address` "The tailcat server's address" (the step's label is a
  numbered step's "Paste the address it prints, below:").
- **The column's commands** (`ConnectionNav.svelte`, under a rule): New address (tailcat serving), Log out (a node kept,
  or a tailnet running here), Delete; the card's words, tooltips and conditions, keys moved to `machines:ConnectionNav.*`
  (`ConnectionsPane.connection.newAddress*`, `.logout*`, `logout.confirm/ok`, `busy.*`). Delete's words stay the
  card's (both use them). Cards keep the name, the line, Details and Delete; `ConnectionEditButton.svelte` is gone, and
  `ui/Choice.svelte` lost its `after` slot (its only user) and takes a `Msg` label (for "Edit <name>").
- **The wizard's first choice** (`NetChangeStep.svelte`): `Opened` has `attached` (the adapter's connection id) and
  `from`; AdapterCard passes `{ to: 'tab', machine }`, Network.svelte `{ to: 'screen' }`. `net-wizard.ts` has the way
  through as pure functions (`firstStep`, `stepBack`; `tests/net-wizard.test.ts`). Edit closes the wizard and calls
  `page.openConnection(id, 'settings', from)`. The local helper's pairing link still opens on its step.
- **ConnectionDetails**: Edit connection… gone; `ConnectionDetails.local.link` now says "paste it in <ui>Settings</ui>".
  Notes that said "while editing it" (the pasted key's note, `network-actions.newName.confirm`) point at the Settings.
  The doc examples of `<ui>Edit connection…</ui>` (copy.md, i18n.md, frontend-code.md) were changed to live elements.
- **Levels in the browser's history** (the user's addition to this loop): `HomeLevels.openConnection` pushes an entry
  going down a level (`history.state.home = { from, pushed: true }`, `home-route.ts` `homeState` reads it back,
  unit-tested); a section, and Home opened or closed, replace (writeHome keeps the entry's state). `popstate` →
  `PageWindow.followAddress` → `HomeLevels.follow`: a connection's address enters it from the entry's `from` (else
  Connections); any other leaves the level for where its Back leads (a hashless address closes Home). The column's
  Back and Esc on a pushed entry call `history.back()`; on a level the address opened (load, pasted address,
  `hashchange`: `open` replaces with a null state) they replace as before. `open` ignores an address Home is already at
  (the `hashchange` that follows a `popstate`). Found on the way: a `From` taken from component state is a Svelte proxy
  that `pushState` can't clone; it's copied plainly first.
- **Behaviour to know**: entering a connection's page sets Home's chosen pane to Connections (loop 1), so after
  visiting one from the toolbar, Home reopens on Connections rather than the machine
  (`tests/page-connections.test.ts` clicks the machine first now).

**Tests**: unit `tests/connection-settings.test.ts`, `tests/net-wizard.test.ts`, `homeState` in
`tests/home-route.test.ts`. `tests/page-home-levels.test.ts` (Chromium, no guest) gained three tests: browser
Back/Forward from Connections, a machine's tab and the screen, the column's Back after a push leaving no entry, a
section not adding one, a reload falling back to Connections; Settings (values, Revert, a refusal in the banner, Save,
a rename alone, the draft dropped on leaving, a room's switches saved, its key absent before a first start, the
column's commands, Delete leaving for Connections, the card's buttons); the wizard's first choice from the tab (both
branches, Back to the choice, Edit → Settings, Back to the tab) and from the screen (through `network.openWizard`
with the toolbar's arguments: the toolbar's menu needs a running machine), and an adapter without a connection
opening on the pick step. `tests/page-connections.test.ts` (needs `target/net/ts.wasm`: built here with
`net/ts/build.sh`) has the toolbar's Change connection… → the choice → Edit → Settings → Save → Back to the screen, and
Details… → Details. `tests/page-network.test.ts` (tailcat's New address from the column) and `tests/page-room.test.ts`
(the room's key, Copy, New name, then a switch and Save keeping the new key; the names' export from the Settings) were
rewritten for the page. `tools/screens.ts` shoots `connection-settings-<kind>` and `net-wizard-change` in place of
`net-wizard-edit-<kind>`.

**For the next loops**
- Loop 4: the backup command goes in ConnectionNav's commands block (above New address or after; the comment marks the
  place). `ConnectionRoomSettings` keeps the wizard's key field under Advanced as the kickoff says.
- The browser's Back across Home's open/close is unchanged (Home itself replaces), so from the screen: screen →
  (push) a connection's page → Back closes Home; from Home's root: Back from the level returns to the root.

## Tiers passed

| Commit | Tier |
|---|---|
| DOMAINS loop 1 | T1 (`scripts/ci-fast.sh`: OK, 437 s, 166 files). T2 as far as a cloud session goes: `scripts/ci.sh`'s static checks, Rust tests, TestFloat and builds passed; its **agent** step failed with the six known root-container failures (docs/cloud.md: `x11::…display_socket_gets_the_cookie` and five `serve_test` cases), which stops the script, so its JS step was run by hand with ci.sh's settings (`WAARM64_DISTROS=` (no Alpine images), `WAARM64_LONG_TESTS=1`, `node --test 'tests/**/*.test.ts'`): 1461 passed, 0 failed, 618 skipped (images, rigs, topic-only). Not run: ci.sh's TSan and native guest-image steps (no images here). Of the topic scripts ci-fast names (ci-net, ci-debian, ci-graphics, ci-machines), only `tests/page-room.test.ts` was run (Debian via `images/build.sh debian`, `WAARM64_NET_TESTS=1 WAARM64_TAILCAT=1`): passed (256 s), Details… → the page and Back included. The four scripts whole are left for the dev VM. |
| DOMAINS loop 2 | T1 (`scripts/ci-fast.sh`: OK, 362 s, 169 files). T2 as far as a cloud session goes: `scripts/ci.sh`'s static checks, clippy, Rust tests, TestFloat and builds passed; its agent step failed with the same six known root-container failures and stopped the script, so its JS step was run by hand as loop 1 did (`WAARM64_DISTROS=`, `WAARM64_LONG_TESTS=1`, `node --test 'tests/**/*.test.ts'`): 1482 passed, 0 failed, 607 skipped. `target/net/ts.wasm` was missing in this container and was built (`net/ts/build.sh`), so `tests/page-connections.test.ts` ran (passed). With `WAARM64_DISTROS=debian WAARM64_NET_TESTS=1 WAARM64_TAILCAT=1`: `tests/page-room.test.ts` passed (125 s) and `tests/page-network.test.ts` passed (171 s, the tailcat rig's served machine and New address from the column included). Not run: ci.sh's TSan and native guest-image steps, and the topic scripts ci-fast names (ci-net, ci-debian, ci-graphics, ci-machines) whole: left for the dev VM. |
