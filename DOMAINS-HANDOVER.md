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

## Loop 3: a room connection's key, name and domains without connecting it (2026-11-21, cloud session)

**What it did**
- **The module's `member`** (tailnet.md "The module" got its line first; `net/ts/src/room/names/agent.rs` `call`,
  export `ts_names_member`): input `{ room, node }` (the room's ID, the node's private key in hex), output `{ key,
  name, domain, domains }`: the public key in hex (the `self` event's `key` without `nodekey:`, as the page's view
  holds it), `Room::name`, `Room::domain`, `Room::domains` (that one first). The public key comes from a new
  `room.rs` `node_public`, which `Client::build` now uses too (one derivation). Rust test
  `a_member_is_what_a_running_node_with_its_key_reports`: a label room (`gabriel-lan`), a private room's ID and a
  non-label ID, each pinned to a real `Client`'s `self` event for the same key; refusals for no key and a short one.
- **`NamesAgent.member(conn)`** (web/names.ts; `MemberConn` = `NamesConn & { identity? }`, `Member`): an ephemeral
  connection's own key (`conn.identity`), else `roomIdentity(identityKey)` (made in `waarm64-room` if never started).
  `AgentOptions.identity` overrides the key source (Node's tests: `memoryState().roomIdentity`). `NamesOp` gained
  `member`; names-ops.ts and names-worker.ts needed nothing else (generic `op`). Test in `tests/names-agent.test.ts`:
  the key made under the entry, the same again, equal to a running `TsClient`'s `self` (key, name; tag domain for the
  tests' non-label room; a label room's two domains), and an ephemeral key read from `identity` with nothing made.
- **`pageNames.member(conn)`** (areas/names.svelte.ts; `memberOf(room)` builds the argument from a `RoomConnection`):
  `$state.raw` map keyed by [ephemeral key, identityKey, room ID]; undefined until the agent answers, then reactive;
  `forgetMember(identityKey)` drops what was read under an entry (ConnectionRoomSettings' New name calls it).
  Reading it loads the names agent and its worker (a room connection's Details now does).
- **Details** (ConnectionRoom.svelte): the name in the room from `member`, connected or not, under a new label
  `network:ConnectionRoom.name` "This connection's name in the room" (the toolbar's menu keeps `NetAdapter.room.name`,
  whose note no longer mentions Details); `ConnectionRoom.offline` removed; `ConnectionRoom.note` says "this
  connection's name" (was "the machine's name"), the notes of both `.note`s follow. NameEntry rows show connected or
  not, `here`/`domain` from `member`.
- **NameDialog**: key and domain from `member` (still opened by `network.naming` with an adapter index: loop 4 changes
  that to a connection id).
- **Settings** (ConnectionRoomSettings.svelte): the key is read again whenever `member`'s key changes, so a stored
  connection's key shows once its page made it (`ConnectionRoomSettings.key.none` removed: it was false now). New name
  then: the record changes (ephemeral) or the entry is forgotten and `member` read again, which makes the new key at
  once; New name is enabled again once the new key shows (page-room.test.ts waited for it disabled: now it waits for
  the new key, then for the button enabled). New name reads the key again itself after forgetting `member`'s (a first
  version only cleared the field and left it empty for an ephemeral connection: page-room.test.ts caught it).
- **CI in this container** (from commit 6921f2b, beside this loop): the agent's six root-only tests skip in a cloud
  session, so `scripts/ci.sh` runs whole here; its JS step needs no running by hand any more.

**Where it differs from the brief, and why**
- The input field for the node's key is `node` (not `secret`, which the other operations use for the owners' secret).
- `member` makes a stored connection's key the first time its page (Details, Settings, the dialog) shows it, not at
  its first connect: the kickoff's "made there if the connection never started". adapters.md §2.1 says so.

**For loop 4**
- The pane reads `pageNames.member(memberOf(room))` for `{{member}}` (its `name`) and `{{domain}}` (`domain`), and
  passes `member.key` / `member.domain` to the cards as ConnectionRoom does now; ConnectionRoom's NameEntry loop and
  registry line then move to the pane. `network.naming` can take the connection id and NameDialog build `conn` and
  `member` from the stored connection (`net.connections`) rather than `net.views()[index]`.
- An ephemeral connection with its own key: NameDialog skips `member` (nothing to register).

## Loop 4: a room connection's Domains pane (2026-11-21, cloud session)

**What it did**
- **`DomainsPane.svelte`** (the Domains section of `ConnectionPage.svelte`): `Pane` with the title, the meta line
  (`network:DomainsPane.meta`: the connection's name, the room's `roomName(roomOf(link))`, `member.domain`) and
  Register a domain… (`data-action=register-domain`); with no domains `DomainsIntro.svelte` (the first explainer:
  headings as `h4`, `ui/Steps` for the three steps, a `ul` for "Before you register") and a second Register a domain…
  (`register-domain-intro`); with some, the upkeep line (`#domains-upkeep`, `data-warn`), a `CardList` of
  `DomainCard`s and `DomainsHow.svelte` (`ui/Disclosure` `#domains-how`, collapsed); the registry line
  (`#domains-names-line`) while connected here. An ephemeral connection with its own key: `#domains-ephemeral`
  (`DomainsPane.ephemeral`, moved from `NameDialog.ephemeral`) and nothing else. Wrapper `#domains`.
- **`DomainCard.svelte`** (from `NameEntry.svelte`, gone; keys `NameEntry.*` → `DomainCard.*`, the note's new words): a
  `ui/Card`, the light (`StatusDot`, which gained a `warn` tone and the token `--status-warn`), the whole domain
  (`.full`: name strong, `.<domain>` dim), the state (`titleState`, kept), the dates (`[data-date=claimed|renew|until]`,
  the renewal's tooltip), the ended sentence (`[data-field=ended]`), the editor as NameEntry had it (Let it go at the
  row's end). The rows now follow the title's points until edited (a domain registered while its card shows came up
  with no rows otherwise).
- **`names-view.ts`**: `isLive`, `titleTone`, `needsAttention`, `upkeepLine`, `titleDates`, `endedWords`, and loop 5's
  `domainsLink` (written here with its words: same file).
- **NameDialog** opens with a connection id (`network.naming: Command<[string]>`); it finds the stored connection in
  `net.connections`. Its ephemeral branch is gone (the pane never opens it there). The toolbar's NetNames button
  (still there until loop 5) passes the adapter's connection id.
- **ConnectionRoom** lost the domain rows (Details keeps the registry line).
- **The backup**: `ConnectionNav`'s Back up key and domains… (`data-action=backup-connection`, icon `file-export`: no
  key icon in the set) mounts **`ConnectionBackup.svelte`** (`#connection-backup`, `#connection-backup-value` secret
  mono, `-copy`, `-show`, `-close`; `#connection-backup-intro[data-domains]`). It reads `member` first (so a stored
  connection's key exists), then `net.conns.exportKey`; "with domains" is the export having a dot.
- **The column's count**: Domains has a `Count` of live domains and `aria-label` `machines:ConnectionNav.domains.named`,
  only when there are some (as MachinesNav's panes).
- **A fix in the agent's view** (web/names.ts `view`): a claim let go before it was public stayed **Reserved** (the
  release makes no entry then; `t.released` was ignored on that path). Now `released`. Test first, failing without it:
  `tests/names-agent.test.ts` "Let it go before the claim is public". **For the review:** what such a title does once
  its claim is anchored later (the agent may publish the claim with no release after it) was not looked into.

**Where it differs from the kickoff, and why**
- The keys follow the stem rule: the explainers are `DomainsIntro.*` / `DomainsHow.*`, the card's computed words
  `names-view.date.*`, `names-view.ended.*`, `names-view.upkeep*`, `names-view.link.*`; Register a domain… is
  `DomainsPane.register` (also the link's words); the title reuses `machines:ConnectionNav.domains`.
- The link's count counts lost domains as well as live ones ("1 domain registered, 1 needs attention" for a lost one:
  the pane still shows it); the column's count is live ones only.
- The upkeep line has no line when no live domain has a date yet (only Preparing/Reserved ones: no `keptUntil`).
- A Reserved domain shows no dates (the agent gives none before the claim is public).
- Words unchanged except where the kickoff's "Changed" says; `<em>` for the steps' and states' lead words.

**Tests**: `tests/names-page.test.ts` (unit: tones, dates, ended words, the upkeep line, the link; `wording:` cases);
**`tests/page-domains.test.ts`** (Chromium, the names agent on `ts-test.wasm`, pretend calendars, relays refused, no
machine): the first explainer with the member's name, register through the dialog (nobody can say → second press),
the card Reserved, the column's count, a subdomain saved then Point all, the second explainer collapsed, the backup
(with domains; an ephemeral connection's without), Let it go; the states' lights, ended words and the upkeep line from
titles set in the area; an ephemeral connection's pane. Heavy in the `rooms` area. `tests/page-home-levels.test.ts`
(the commands now include the backup) and `tests/page-room.test.ts` (the label through the pane; B's ephemeral
connection through its Domains) adjusted.
Screenshots: `bench/results/local/loop4-shots.ts` (git-ignored). In its backup shot the injected titles aren't stored,
so it says "no domains yet": staged, not a defect.

## Tiers passed

| Commit | Tier |
|---|---|
| DOMAINS loop 1 | T1 (`scripts/ci-fast.sh`: OK, 437 s, 166 files). T2 as far as a cloud session goes: `scripts/ci.sh`'s static checks, Rust tests, TestFloat and builds passed; its **agent** step failed with the six known root-container failures (docs/cloud.md: `x11::…display_socket_gets_the_cookie` and five `serve_test` cases), which stops the script, so its JS step was run by hand with ci.sh's settings (`WAARM64_DISTROS=` (no Alpine images), `WAARM64_LONG_TESTS=1`, `node --test 'tests/**/*.test.ts'`): 1461 passed, 0 failed, 618 skipped (images, rigs, topic-only). Not run: ci.sh's TSan and native guest-image steps (no images here). Of the topic scripts ci-fast names (ci-net, ci-debian, ci-graphics, ci-machines), only `tests/page-room.test.ts` was run (Debian via `images/build.sh debian`, `WAARM64_NET_TESTS=1 WAARM64_TAILCAT=1`): passed (256 s), Details… → the page and Back included. The four scripts whole are left for the dev VM. |
| DOMAINS loop 2 | T1 (`scripts/ci-fast.sh`: OK, 362 s, 169 files). T2 as far as a cloud session goes: `scripts/ci.sh`'s static checks, clippy, Rust tests, TestFloat and builds passed; its agent step failed with the same six known root-container failures and stopped the script, so its JS step was run by hand as loop 1 did (`WAARM64_DISTROS=`, `WAARM64_LONG_TESTS=1`, `node --test 'tests/**/*.test.ts'`): 1482 passed, 0 failed, 607 skipped. `target/net/ts.wasm` was missing in this container and was built (`net/ts/build.sh`), so `tests/page-connections.test.ts` ran (passed). With `WAARM64_DISTROS=debian WAARM64_NET_TESTS=1 WAARM64_TAILCAT=1`: `tests/page-room.test.ts` passed (125 s) and `tests/page-network.test.ts` passed (171 s, the tailcat rig's served machine and New address from the column included). Not run: ci.sh's TSan and native guest-image steps, and the topic scripts ci-fast names (ci-net, ci-debian, ci-graphics, ci-machines) whole: left for the dev VM. |
| DOMAINS loop 3 | T1 (`scripts/ci-fast.sh`: OK, 346 s, 165 files). T2 as far as a cloud session goes: `scripts/ci.sh` **whole** (with 6921f2b's skips): CI OK (901 s): static checks, clippy, Rust tests, the agent's tests (the six root-only ones skipped), TestFloat, builds, JS 2090 tests: 1483 passed, 0 failed, 607 skipped; its native guest-image and TSan steps said SKIPPED (no images here). The network's Rust tests: 287 passed (`member`'s among them). With `WAARM64_DISTROS=debian WAARM64_NET_TESTS=1 WAARM64_TAILCAT=1`: `tests/names-page.test.ts` passed; `tests/page-room.test.ts` failed once (New name left the key field empty: fixed in ConnectionRoomSettings), then passed (135 s); `tests/page-home-levels.test.ts` passed again after the fix. Those last three runs and the quick static checks (eslint, prettier, svelte-check, `cargo fmt --check`) are all that ran after the fix: the user, in a hurry, asked for targeted checks only, so the broad CI on the final tree (ci.sh, ci-fast.sh and the topic scripts: ci-net, ci-machines, ci-debian) is left for the track's end, run by the supervisor. |
| DOMAINS loop 4 | Targeted only (the user's instruction): tsc, svelte-check, eslint/prettier/stylelint on the touched files, `tools/i18n-check.ts`, `tools/ci-select.ts --check`; `tests/names-page.test.ts`, `tests/names-agent.test.ts`, `tests/page-domains.test.ts`, `tests/page-home-levels.test.ts` passed. `tests/page-room.test.ts` not run in this loop (run after loop 5). Not run: ci-fast, ci.sh, the topic scripts. |
