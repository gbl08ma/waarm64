# Review: the demo store's page, templates, the demo image and its build (review/demo-page-2)

A static review of the code as of 466efe19. Findings ranked most severe first. Each has its place, the defect, a
concrete failure, a confidence and a suggested fix. No tests were added; none of these were run.

## 1. A demo's start keeps running after its interstitial is gone, then switches machines without asking; a second start can run beside it

`web/app/DemoStart.svelte:66-72` (`start`), with `web/app/areas/page-window.ts:212-216` (`openDemo`) and
`web/app/main.ts:271-274` (`switchTo: (id) => disks.switchMachine(id, true)`).

`start` asks `page.askSwitch()` once, before the download. It then awaits `machineFromDemo` (the template's download,
which can take minutes), and finally calls `page.openDemo(machine.id, view)`. That call closes the store's page, sets
the view and calls `switchMachine(id, asked = true)`, which stops whatever runs without a question. The runner is the
component's own (`new Actions()`), and nothing cancels the closure when DemoStart unmounts.

- The visitor starts the download, presses the page's Back (or "All demos"), and starts or keeps using another machine
  in the meantime. When the download ends, the page jumps to the demo: the store's page closes, the view changes, and
  the machine they are using is powered off. The earlier `askSwitch()` asked nothing when no machine was live at that
  time, so in that case nothing was ever asked.
- The visitor presses "All demos", then opens the same demo again. The new DemoStart has a fresh runner, so its Start
  button is enabled while the first download still runs. Two downloads run, two machines are made ("Alpine" and
  "Alpine (2)"), and whichever finishes last wins the switch. Two different demos started this way also race.

Confidence: high.

Fix: keep the start in a page-level state (`demos`), not in the component. While a start runs, disable Start on every
interstitial. Abort it (an `AbortSignal` through `fetchChunked`) when the store's page closes, or at least skip
`openDemo` when the page was closed or another machine was opened in the meantime. Ask `askSwitch` again just before
the switch.

## 2. "Open my machine" on a machine already running here goes to Home when the store was opened from Home

`web/app/DemoStart.svelte:77` calls `page.closeDemos()` when the visitor's machine runs on this page. Through
`demoActions`, `closeDemos: () => this.closeDemos()` uses `back = true`, and `page-window.ts:228` then opens Home when
`demos.from === 'home'`.

Failure: on Home, open Demos, choose the demo whose machine is running, and press the primary "Open my machine". The
Home page shows, not the machine.

Confidence: high.

Fix: give the page an action that closes the store's page to the machine (`closeDemos(false)` plus the focus), and use
it here.

## 3. The command-not-found hook runs the rest of the typed line twice

`images/alpine-demo/command-not-found.sh:41-54`.

After the install, the hook runs the whole history line again in `/bin/sh -c "$line"`. It checks only that the line's
first word is the missing command. The interactive shell that called the hook then carries on with the rest of the
same line.

Failure: typing `python3 gen.py > out; echo done >> log` (python3 not installed) runs `echo done >> log` twice: once in
the child shell, once in the prompt's shell. `htop; reboot` reboots from the child's copy of the line first. Any
`cmd && x`, `cmd; x` or `cmd || x` repeats the side effects of `x`.

Confidence: high (from ash's semantics; not run).

Fix: run the line again only when it is the command alone (no `;`, `&`, `|`, `&&`, `||`, redirections or newlines
after the first word). Otherwise say "installed: run it again".

## 4. An untrusted store's template snapshot is downloaded whole into memory with no bound

`web/chunked.ts:181-205` (`fetchChunked`), as called from `web/app/template.ts:84-103` (`fetchSnapshot`).

`checkManifest` bounds neither `size` nor the number of hashes, and allows a hash to repeat. `fetchChunked` keeps every
piece as a `Uint8Array` until the end. The storage check in `demo-check.ts` uses the card's claimed `demo.download`,
not the manifest's `size`.

Failure: a `?store=` store (once its warning is accepted) names a snapshot manifest whose 10,000 hashes are all one
hosted 1 MiB piece. The page fetches 10 GB into RAM and the tab crashes. The checks said the download was small, since
`download` is free text from the store.

Confidence: medium-high.

Fix: refuse a snapshot manifest whose `size` is past the card's `download`, or past a cap (a few hundred MiB). Stream
the pieces into OPFS rather than holding them in memory.

## 5. Another store's demo can turn on clipboard sharing and the demo network together

`web/app/definition-check.ts:85-102` (`MACHINE_CHECKS` accepts `clipboard: true`) and
`web/app/template.ts:51-55` (`marked` keeps it). With the definition's `network` on, `demo.network: "demo"` attaches
the demo connection.

Failure: a visitor who has granted `clipboard-read` to the origin for their own machines opens a `?store=` demo and
accepts the store's warning. On focus, the guest's agent is given the host clipboard
(`clipboard-guest.ts:159`). With the server's slow lane on (hosts off the allowlist reached slowly), the guest can send
it out. The "not ours" warning doesn't mention what the definition turns on.

Confidence: medium (it needs the permission granted and the slow lane on).

Fix: for a store that isn't ours, drop `clipboard` (and `shares`, `usb`) from the definition on import, or list them
in the warning and ask.

## 6. Leaving or reloading the tab during a demo's import leaves a half-made machine's records

`web/app/definitions.ts:304-329` (`importDefinition`), from `machineFromTemplate`.

The URL disk records and grown overlays are stored before `importSnapshot` writes the template (tens of MB) to OPFS,
and the machine's record is stored last. The tidy-up runs only on a thrown error. The store's sweep removes files
without records, but not disk records without a machine.

Failure: closing the tab while "Keeping…" runs leaves a stray demo disk record in the Disks list, with no machine
using it.

Confidence: low-medium (the window is short; whether a free URL disk record shows depends on the Disks list).

Fix: make the disk records inside the same `writing` section as the machine, or have the sweep drop disks that no
machine attaches and that this import marked.

## 7. A stale store load's error shows over the store now shown

`web/app/DemosPage.svelte:37-44`.

`load` guards only the success (`if (demos.route.store === url) shelf = s`). One `Actions` runner is shared by every
load: `run` clears `error` at its start, and a failure sets it whenever it comes.

Failure: open `?store=A` (slow, then unreachable), then press "Our store". Ours loads and shows its cards. A's failure
then arrives and shows "couldn't read the store" with Try again (which reloads ours). `busy` also clears when the first
load ends, while the second still runs.

Confidence: high.

Fix: give each load a generation number, and drop the error and `busy` of a load that is no longer current.

## 8. Browser Back and the address's fragment aren't followed

`web/app/areas/page-window.ts:76-79, 185-191, 219-223`.

The store's page writes every state with `replaceState`, so the browser's Back (and Android's back gesture) on a
demo's interstitial leaves the site rather than returning to the cards. When a pushed `#demos…` entry is left by Back
(an in-page link), `hashChange` sees no route and doesn't close the store's page, so the page and its address disagree.

Confidence: high for the behavior; whether it is wanted is the design's call.

Fix: `pushState` when choosing a demo, a `popstate` handler that re-reads `demosRoute(location)`, and close the store's
page when the fragment leaves `#demos`.

## 9. Opening a demo saves its view as the visitor's preferred view

`web/app/areas/page-window.ts:214` calls `this.setView(…)` with `save` at its default `true`, so `remember({ view })`
runs.

Failure: a visitor who keeps "both" opens a serial demo. Every machine they open afterwards starts in the terminal
view.

Confidence: high.

Fix: `this.setView(view === 'serial' ? 'terminal' : 'screen', false)`.

## 10. The restored card's held flap expires while the lease wait has no bound

`web/devices.ts:604-606` (`HOLD_MS` = 120 s from the restore) against `web/app/net-settled.ts:39-63`.

`when` stays pending while no adapter connects; only the time after the first connection is bounded. The hold's bound
assumes the 110 s worst case starts at the restore.

Failure: the demo server answers 4009 or 4008 (full or crowded, `CROWDED_MS` backoffs) or is unreachable for over
2 min after a restore. The hold ends and the owed flap fires. When the connection finally comes, the LEASE runs
without the hold's protection. Any later switch flaps at once, which is the race the hold was added against.

Confidence: low-medium (how often it matters depends on the server).

Fix: start the hold's timer when `whenConnected` resolves (re-arm through the link's `settled` protocol), or keep the
hold until the page says it settled, with `end()` releasing it.

## 11. Templates under New machine get the recipe's fixed MAC

`deploy/disks/demos.json` (the recipe's `macs`), carried through `templateDefinition`
(`web/app/template.ts:134-137`) and `machineFrom` (`definitions.ts:273`).

A demo needs a fixed MAC (it is in the template's shape). A template makes a cold-booted machine of the user's own,
which doesn't, yet it keeps that MAC.

Failure: two machines made from the template, put on one network (a tailnet or a local helper LAN), share
52:54:00:bf:f6:6b and break each other's networking.

Confidence: medium.

Fix: drop `macs` in `templateDefinition`, which gives a fresh MAC as New machine's empty machine does.

## 12. The demos' build trusts `build` paths, and `make-template.ts` deletes the directory recursively

`tools/demo-site.ts:146-160` (`readSource` checks `build` only for being a string), `tools/build-demos.ts:150-160`, and
`bench/demo/make-template.ts:66` (`rmSync(dir, { recursive: true, force: true })` with
`dir = join(site, name) = resolve(ROOT, build)`).

Failure: a typo such as `"build": "target"` or `"."` in deploy/disks/demos.json deletes target/ (every built image) or
the checkout. `prunePieces(dirname(dir))` then walks the parent.

Confidence: high (that it's possible); impact low (trusted input).

Fix: require `build` to resolve under the repository's `target/` (or `--out`) and to end in a directory of its own
(not `pieces`, not the root). Also refuse `--name` values with `/` or `..` in make-template.ts.

## 13. A demo's snapshot errors that aren't words

`web/app/template.ts:86` and `web/app/template.ts:94-102`.

- `JSON.parse` of a manifest that isn't JSON throws a bare `SyntaxError`. A manifest that is JSON `null` throws a
  `TypeError` at `raw.id`. The visitor reads the engine's text, not a `MsgError`.
- `fetchChunked` throws plain `Error`s for a piece of the wrong hash or size, and for an HTTP error on a piece. All of
  them are said as `template.cutOff` ("the connection was lost partway"), which is wrong for a 404 or a hash mismatch.
  The other workers also keep fetching after the first failure.

Confidence: high.

Fix: say a malformed manifest as `chunked.malformed`. Throw `MsgError`s from `fetchChunked` (gone, refused, cut off),
and abort the siblings on the first failure.

## 14. A far reconnect time from the demo server reconnects at once, in a loop

`web/demo-net.ts:458-462` (`until`) with `browserEnv().setTimeout`.

A `reconnect_after` or `resets` more than about 24.8 days away (for example a long maintenance notice) overflows
`setTimeout`'s 32-bit delay, which then fires immediately. The client reconnects, is closed with the same code, and
repeats without a pause.

Confidence: medium (it needs the server to send such a time).

Fix: clamp the wait to, say, one day, and wait again on wake.

## 15. Accessibility on the store's page

- `DemosPage.svelte:104` and `DemoStart.svelte:89`: choosing a card removes the focused button, and focus falls to
  `<body>`, except when "Open my machine" takes it. "All demos" does the same in reverse. Move the focus to the
  interstitial's heading, or to the chosen card on the way back.
- `DemoCard.svelte:28-33`: the thumbnail's alt text repeats the name inside the button, so the button's accessible name
  says the demo's name twice before its summary. Use `alt=""`; the image is decorative there.
- `DemoStart.svelte:178`: the `<progress>` has no accessible name. Add `aria-label` or `aria-labelledby` to the busy
  text.

Confidence: high; impact low.

## Looked at and found sound

- Store and definition text is rendered as plain text throughout (no `{@html}`; i18next `escapeValue: false` into
  Svelte text nodes). `T` renders params as text.
- `?store=` other than http(s) falls back to our store.
- The deflate frames are bounded before inflating: `frameHead` refuses `storedLen > rawLen > MAX_RAW` and codec 3 in a
  file below version 3. `inflate_raw` refuses output past `rawLen` (no wrapping buffer, `Done` only). The pool
  worker's bounds hold.
- `applyPlan` writes only under ids, hashes and thumb names it checked.
- `namedPieces` stays within `pieces/` after `join` normalizes the path.
