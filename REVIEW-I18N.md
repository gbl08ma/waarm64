# Review: the page's words in the catalog (i18n)

Static review of `848e558~1..c78e874` (the I18N track's commits on `claude/exciting-thompson-8wbawb`): `web/msg.ts`,
`web/i18n.ts`, `web/messages/en/*.json`, `tools/i18n-check.ts`, the worker → page error protocol (`web/app/protocol.ts`,
`web/app/worker.ts`, `web/app/main.ts`, `web/vm.ts`, `web/device-worker.ts`) and the components and libraries that
moved. Nothing was run but `git` and `node tools/i18n-check.ts` (it passes). Line numbers are at `c78e874`.

Checked and found sound (no finding): i18next's interpolation of the renderer's parameters (a `Date` with its own
`toString`, the `Items` list, nested `Msg`s, `undefined` → `''`, no reserved option names among the `{{params}}`,
`skipOnVariables` keeps a value's `$t(`/`{{` inert); every plural has `_one` and `_other`; no `{{x, bytes}}` is given a
pre-formatted string; `toWire`/`fromWire` keep `problem`, `name` and causes; the overlay's `overlay-in-use` /
`overlay-mismatch` and `NoModificationAllowedError` reach `explain` across the device worker; `UsbHeldError` replaces
the old `message === 'held'` test everywhere it was used; the status bar's groups and kinds were renamed to codes but
nothing persisted holds them; no worker imports `web/i18n.ts`.

## 1. HIGH: a `MsgError` without a `problem` that stops a machine shows its key and a stack, not its words

`web/app/worker.ts:372-381` (`explain`). Only a `MsgError` that also has a `problem` (`failure()`) or is a
`SnapshotError` keeps its message. Any other `MsgError` falls to the `emulator` branch, which replaces it with
`new Error(stack)` (keeping only `e.cause`). A `MsgError`'s `message` is `devText` (its key and parameters), so its stack
starts `MsgError: <key> {…}`. The user reads:

```
The emulator stopped with an error
MsgError: disks:qcow2.zstd
    at fromWire (…/web/msg.ts…)
```

Before the change the same failure said the words (`The emulator stopped with an error:` + `Error: <the reason in
English>` + stack).

Failure scenarios (each reaches `explain` through `start()` → `bootVm` → the device worker → `fromWire`, or directly in
the machine worker):
- **Open disk… with a qcow2 the reader refuses**: zstd-compressed (`compression_type=zstd`, common now), encrypted,
  external data file, extended L2, qcow2 v1, unknown incompatible features (`web/qcow2.ts:71-84`, thrown by `openDisk`
  in `web/devices.ts:836` in the device worker at boot). Only a backing file is caught before boot (`changesHeader` in
  `main.ts`). The same holds for a `?disk=` URL or an attached "a file on this computer" disk.
- **Restoring a snapshot while the browser's storage is full**: `web/snapshot.ts:244`, `:248`, `:260`
  (`snapshots:snapshot.storageFull`, `.whole`) run in `restore` inside `bootVm` → no `problem`, and not a
  `SnapshotError` → key shown. (`restoring` is true here, so the user also loses the "its disk may hold part of the
  snapshot's changes … Reset disk" guidance that `snapshots:worker.notRestored` gives.)
- **A chunked image whose manifest is refused** (`web/chunked.ts:42-44`, via `chunkedHead` in `web/vm.ts:827`).

Suggested fix: in `explain`, when `msgOf(e)` is set, keep `e` itself as the cause
(`new MsgError('machine:worker.emulator', {}, { cause: e })`, or give such errors a problem of their own, e.g. a
`disk` problem with Retry/Disks…), and put the stack in the details only for errors without a message. Better still,
give `qcow2`'s and the restore's refusals `problem`s so they get actions. Confirming test: a Node test of `explain`
(or a page test with a zstd qcow2) asserting that `describe(error)` contains the catalog's words and no `MsgError:`.

## 2. MEDIUM: a failed network connection no longer says why in the status bar or on the Machines page

`web/app/network.ts:136-140`: `viewOf` used to give `text: "Couldn't connect: <first line of the error>"`; now `text`
is only `Couldn't connect` and the reason moved to a new `details` field. Only `web/app/Network.svelte:79` renders
`details`. The other places that show `view.text` lost the reason:
- the status bar's `link` element tooltip (`web/app/statusbar.ts:304`, `{{name}}: {{text}}` via
  `web/app/StatusBar.svelte`'s `text`): "Adapter 1: home tailnet: Couldn't connect" instead of "… Couldn't connect: the
  control server refused the node: …";
- the Machines page's adapter line (`web/app/MachinesPage.svelte:447`, `said(here.view.text).headline`).

Scenario: a tailnet whose control server refuses the node: the status bar shows "failed" and its tooltip no longer says
what failed. Fix: pass `details` along (`AdapterView` → `Live.nets[].text`, the Machines page line), or keep the first
detail in a short form for one-line places (`t('…couldntConnect.why', { why: d.headline })`).

## 3. MEDIUM-LOW: errors with causes run together where the page shows them in plain paragraphs

`errorText(e)` (headline, then each cause on its own line) replaced `String(e.message)` in places whose CSS doesn't
keep line breaks, so the headline and its cause are joined by a bare space, without the old ": ":
- `web/app/FoldersMenu.svelte:28,58` (`#folders-error`, `.net-note`: no `white-space: pre-wrap`);
- `web/app/FolderWizard.svelte:64,116` (`#folder-error`);
- `web/app/folders-live.ts:168` stores `errorText(e)` as a folder's `failed` reason, shown inline by
  `web/app/FoldersMenu.svelte:36` (`folders:FoldersMenu.state.failed`) as one sentence;
- `web/app/net-live.ts:40,408`: an adapter's note (`noteText` → `errorText`) shown in `web/app/Network.svelte:106`
  (`<p class="net-note">`).

Scenario: connecting an adapter fails with a `MsgError` that has a cause (e.g. `network:local-net.closed` with the
helper's reason): the note reads "The helper closed the connection the token is stale" as one run-on line. Fix: render
`describe(e)` as headline + `<br>`-separated details (as `Network.svelte:98` and `NetWizard.svelte:260` already do), or
add `white-space: pre-line` to `.net-note`/`#folders-error`/`#folder-error`; for the inline `failed` reason use
`describe(e).headline` (plus details in a title).

## 4. LOW: device-worker errors lose their class and stack on the way to the page

`web/vm.ts:1684` now rejects with `fromWire(e.data.error)` instead of `new Error('device worker: ' + String(err))`.
`fromWire` builds a fresh `Error(w.text)` and sets `name` afterwards; V8 has already captured the stack as
`Error: <text>` at `fromWire`. In the `emulator` branch the details are that stack: an unexpected `TypeError` in the
device worker now shows as `Error: x is not a function` with frames from `fromWire`/the message handler, without the
original class or any hint that the device worker threw it (the old text had both "device worker:" and `TypeError`).
Fix: carry `stack` in `WireError` (`toWire`: `stack: e.stack`) and use it in `explain`'s details; or build the
`Error` with the name in its message when it isn't `Error`.

## 5. LOW: `web/devices.ts:853` still matches an error's words

`full = … || /storage is full/.test(String(e.message))`. The only thrower of "the browser's storage is full" was
`web/overlay.ts:485`, now `new MsgError('disks:overlay.storageFull')`, whose `message` is the key, so the test can never
match (and it is the kind of logic docs/i18n.md says must check a code). Today it is dead rather than wrong (the disk
write path signals a full storage by a short write or `QuotaExceededError`), but a future thrower would silently stop
being counted as "full". Fix: test `msgOf(e)?.key === 'disks:overlay.storageFull'` (or a `problem: 'storage-full'`
field), or drop the regex.

## 6. LOW: markers are parsed after interpolation, so a parameter containing `<word>` can be taken for a marker

`web/i18n.ts:61-75` (`parts`) and `plain` run on the interpolated text. A parameter value with `<x>` / `</x>` is read
as a marker. It works today only by accident: `Network.svelte:96` and `NetWizard.svelte:243` pass
`'tailcat ssh <address>'` inside a `<code>` marker, where nested openers are skipped. A user-controlled value that isn't
inside a marker (or contains a closing tag) is cut: `folders:FoldersMenu.where` interpolates the user's mount path
inside `<path>…</path>`, and `sharesPathError` doesn't forbid `<`/`>`, so a mount point like `/mnt/a</path>b` renders
wrongly. `network:local-net.notLink` has a literal `<port>/<token>` in its words, harmless only because it is rendered
with `text()`, not `<T>`. Fix: split the message's words at markers before interpolating (interpolate each piece), or
escape `<` in parameter values and unescape after `parts`.

## 7. LOW: holes in `tools/i18n-check.ts`

- **Parameters through a map or a non-literal object aren't checked**: `t(SCOPED.each[d.device], { name })`,
  `t(key, { name: v.name })` with `PHASE_WORD`, `t(STATE_WORDS[s])`, `msg(CLASSES[c])` (the key literal isn't the call's
  first argument), and `t('statusbar:statusbar.net.traffic', total ? {…} : {…})` (a conditional, `obj.type !==
  'ObjectExpression'` returns at line 176), and every `words` object in `main.ts` (`snapshots:main.saved`,
  `machine:main.memory`). All checked by hand and correct today. Fix: for a key literal that sits in an object/array
  literal (a map), check every call that indexes that map; for a conditional, check both branches.
- **The audio worklet isn't followed**: `web/audio.ts:23` imports it as `'./audio-worklet.ts?worker&url'`, which
  `checkWorkers` neither treats as an entry nor resolves (the query suffix), though docs/i18n.md says worklets are
  checked. Fix: strip `?…` and treat `?worker`/`?worker&url` imports as entries.
- **`sentence()` (line 98) skips any string with `;`, `=`, `<`, `>`, `{`, `}`**, and lowercase sentences are never
  flagged outside copy properties. Many of this page's sentences use semicolons ("…; the guest…"), so a new one slips
  through. Fix: drop `;` from the exclusion (keep code-like tests: `=>`, `${`, `{`), and flag lowercase multi-word
  strings passed to `notify`/`setState`/`ask.*`/`fail`.
- **A mistyped namespace is invisible**: `KEY_RE` keys are only recognized when `catalogs[ns]` exists
  (lines 169, 196), so `'snapshot:main.busy'` is neither "no such message" nor "words outside the catalog" (lowercase),
  and i18next would show `snapshot:main.busy`. Fix: report any `^[a-z][a-z0-9-]*:[A-Za-z0-9-]+\.` literal whose
  namespace isn't a catalog (with an `i18n-ignore` escape for URLs/ids).
- **Nothing catches code that shows a `MsgError`'s `.message`/`.stack`** (the root of finding 1; also
  `web/device-worker.ts:46` posts `String(err.message)` for a disk read's error). A check that flags `.message`/`.stack`
  of an error flowing into words (or a runtime guard in `describe`/`errorText` that never prints `devText`) would catch
  it. At minimum, a unit test of `explain` with a `MsgError`.

## 8. LOW: guest-visible changes and words in the guest's unit files

- `web/app/keyboard.ts:100`: the keyboard unit's script now names the layout by id in its comment (was the label). It
  is guest-visible (the SMBIOS credential's bytes change); CLAUDE.md asks for the user's OK on guest-visible changes. The
  handover notes it; make sure it was OK'd and that no pinned step count/hash covers it.
- `web/app/guest-words.ts` → `web/app/shares-mount.ts:50`, `web/app/keyboard.ts:128`, `web/app/guest-net.ts:35`: the
  units' `Description=` now comes from the catalog and is written raw into a systemd unit. A translation with a newline
  (or a leading `[`) would corrupt the unit. Fix: reject or replace control characters in `guestWords()` and note it in
  the entries' notes.

## Notes (not defects)

- `machine:worker.panic`, `snapshots:worker.notRestored`/`notLoaded` and `disks:main.reset.failed`/`changes.failed`
  put the remedy line in the headline and the cause under it, so the user reads the advice before the reason
  ("The guest's kernel panicked / The serial log shows… / Kernel panic - not syncing: …"). Within the brief's allowed
  split, but the order reads oddly; a third part (headline, cause, then advice) would keep the old order.
- Several messages are still assembled from fragments (`disks:Disks.merge.confirm` with `{{others}}{{snapshots}}`
  whose sub-messages begin with `\n`, `usb:main.empty.list`, `machine:main.progress`), against docs/i18n.md's "Words
  are whole sentences". Fine in English; a translator can't reorder them.
