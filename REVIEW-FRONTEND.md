# Review: the page's code and its boundary with the machine worker (static, out of context)

2026-11-11, over origin/main `a3e9d6b5`. Area: `web/app/` (main.ts, App.svelte, `run/`, `areas/`, the snapshot and
restore paths, the Machines page's Snapshots tab) and the boundary with `web/app/worker.ts` / `web/app/protocol.ts`
(start message, configuration, snapshots, suspend, replies). Read against docs/frontend.md, docs/frontend-code.md and
docs/machines.md. Static only: no CI, no browser. Ranked by severity; each finding says the defect, what triggers it,
how sure I am, and a test that would confirm it.

## Findings

### 1. High: a kept snapshot's restore is planned while the machine still runs, so a disk can be "kept" after it moved on

`web/app/areas/snapshot-restore.ts:137` (`#restore`: `#plan` → `planRestore`) runs before the confirmation and before
`runner.stop()` (`:150`); `plan.commit` (`:154`) only carries out the decisions made then. `planRestore`
(`web/app/snapshots.ts:108-115`, and `:97` for a disk written in place) picks **keep** when the overlay's generation
on disk equals the pinned one. The device worker bumps the generation at the first write after a snapshot
(`web/overlay.ts` `epoch`). While the confirmation (and the "keep or replace" question) is open, and between the plan
and the stop, the guest keeps writing. Each write moves the generation past the pin, but the plan still says `keep`. The
worker skips a `keep` disk without checking again (`web/snapshot.ts:165`, `plan?.action === 'keep' ? { kind: 'skip' }`).
The result is RAM and device state from the snapshot over a disk that holds writes made after it, which corrupts the
guest's filesystem without any error.

- **Trigger:** a stored machine runs. Snapshot it (kept), then at once Restore that snapshot from the Snapshots tab or
  Load snapshot ›. At plan time no write has followed the snapshot, so the plan is "kept". Leave the confirmation open a
  few seconds; journald or anything else writes; confirm.
- **Confidence:** high, from the code. The page plans before it stops, the overlay bumps on the next write, and the
  worker trusts `keep`.
- **Test:** a `planRestore` unit test over the in-memory store: plan, then bump the overlay's meta generation, then
  `commit`. Today it returns `keep`. Or the same on Debian in `scripts/ci-machines.sh`: keep, restore with a write
  between plan and confirm, and fsck or a file written after the snapshot is still there. The fix is to plan, or
  re-check the pins, inside `exclusively` after `runner.stop()`, or to have the worker refuse a `keep` whose generation
  isn't the pin's.

### 2. Medium-high: the Snapshots tab judges other machines' snapshots by the address meant for the page's machine, so "Delete orphaned" can delete good snapshots

`web/app/run/size-actions.ts:131` (`shapeNow`) resolves any machine's shape with `resolveMachine(query(), r, …)` and
`refused: !!m.no3d` (`:141`). `Snapshots.svelte:47-48` calls it for whichever machine the Machines page shows. The
address's `?ncpus=`, `?ram=`, `?split=`, `?usb=`, `?mouse=`, `?touch=`, `?clipboard=`, `?clock=` and `?netconfig=`
belong to the machine the page opened. `switchMachine` drops exactly those before that other machine runs here
(`web/app/areas/disk-actions.ts:165`, `MACHINE_PARAMS`), so the shape shown for machine B is not the one B "would run
with on this page".

- **Trigger:** open `?m=A&ncpus=2` (or `&mouse=1`), open the Machines page and select machine B, which has kept
  snapshots taken at its own vCPU count. Every one shows as orphaned ("vCPUs differ"), Restore is disabled, and
  [Delete orphaned snapshots] offers to delete them all. The same happens for every 3D machine's snapshots after this
  page's GPU worker failed once (`no3d`).
- **Confidence:** high that the shape is computed this way. Medium on intent: the doc comment on `shapeNow` says "the
  address resolves them over its record", but `switchMachine` contradicts that for any machine but the page's.
- **Test:** a `wording`-free Node test of `shapeNow`'s rule (or a page test) with `?ncpus=` set and a second machine:
  its kept snapshot's hash should match.

### 3. Medium: a lost WebGL context, or an uncaught error in the machine worker, says "crashed" but leaves the run going

`web/app/run/worker-messages.ts:161` (`lost`) and `web/app/run/runner.ts:166`/`:210` (`worker.onerror`,
`gpu.onerror`) call `messages.setState('crashed', …)` and nothing else. `Runner.ended(r)` doesn't run and the workers
aren't stopped. `m.run` stays the run, the machine worker and its vCPU workers keep running the guest, the machine's Web
Lock stays held (another tab and the Machines page see it running), the memory signal's mark keeps being renewed by
`status`, and USB devices stay attached. `setState('crashed')` also goes through `STOPPED` and calls
`net.machineOff()`, so the guest, still running, loses its network.

- **Trigger:** a 3D machine whose GPU process resets (a driver reset, `WEBGL_lose_context` in a test). The page shows
  "crashed" with Restart, but the guest keeps running unseen and the lock stays held until a restart.
- **Confidence:** high on the code path. Whether a context loss always leaves the machine worker running is inferred:
  nothing on the page stops it.
- **Test:** a page test with `?gpu=virgl` that loses the context (the GPU worker posts `lost`), then checks
  `navigator.locks.query()` and that `status` messages stop. Today the lock stays and `status` keeps coming.

### 4. Medium: the memory checks run only at the page's first start, not when the Machines page opens another machine

`web/app/run/power-actions.ts` `boot` is the only caller of `signal.crashedBefore()` and `signal.fits()`.
`DiskActions.switchMachine` (`web/app/areas/disk-actions.ts:174`) and a disk file opened on a running page (through
`#machineForFile` → `switchMachine`) call `runner.start()` directly. docs/frontend.md "Errors" says a leftover mark
makes "the next start of that machine (state `idle`)" say so, and that below the memory estimate "the page doesn't
start the machine".

- **Trigger:** machine B's tab was killed out of memory (the `webpc.alive.<B>` mark is left over). In a tab showing
  machine A, open B from the Machines page: B starts at once with the size that killed it, and no warning or smaller
  choice is offered. Similarly, a machine whose RAM is over `navigator.deviceMemory` starts without "Start anyway".
- **Confidence:** high on the code. That this contradicts the doc is clear from its wording.
- **Test:** a page test that seeds an `alive` mark for machine B, opens A, switches to B, and expects state `idle` with
  the memory signal's actions.

### 5. Medium: a 3D "Copy screen" waits forever when the GPU worker doesn't answer

`web/app/areas/clipboard-actions.ts:122` asks `replies.grabs` with no timeout (the 2D path has 10 s, `:125`). The
answer comes through `gpu.onmessage = r.guard(…)` (`runner.ts:209`). If the run is replaced meanwhile (a restart, a
switch), or the GPU worker is busy for a long time or was terminated, the answer is dropped or never sent. The
`ClipboardItem` promise then never settles, `navigator.clipboard.write` hangs, `clipboard.failed` is never set (the
menu doesn't say it failed), and the waiting entry stays in `Replies.#waiting`.

- **Trigger:** Clipboard › Copy screen on a 3D machine, then Restart right after (or the WebGL context lost).
- **Confidence:** medium-high.
- **Test:** a Node test of `screenPng` with a fake GPU worker that never answers, which should settle (undefined) after
  a timeout.

### 6. Medium-low: a guest reboot that arrives while a save or switch is running leaves the machine at "rebooting"

`web/app/run/worker-messages.ts:77` runs `void x.d.later.restart()` on `rebooting`. `restart` goes through
`exclusively` (`web/app/run/power-actions.ts:32`), which returns without doing anything while `power.busy`. Nothing
retries, so the run loop has exited and the state stays `rebooting`.

- **Trigger:** the guest reboots (PSCI reset) while a snapshot is being written (`power.saving`), for example a guest
  that reboots right after the clock catch-up's Sleep key, or during a USB empty-ports wait before the save. The save
  then fails (`snapshots:worker.ended`), and the page sits at "Rebooting" until the user clicks Restart.
- **Confidence:** medium (a narrow window, but the drop is certain).
- **Test:** a unit test with `power.saving = true` that dispatches `state: rebooting`, then clears `saving`, and expects
  a restart.

### 7. Medium-low: a restore asked from the Snapshots tab during a save is confirmed and then silently dropped

`restoreKept` (`web/app/areas/snapshot-restore.ts:167`) doesn't check `pw.busy()` (`load` does, `:204`), and the
Snapshots tab's Restore button is disabled only by `!here` (`Snapshots.svelte:172`), not by `power.busy` (the toolbar's
menu is: `LoadSnapshotMenu.svelte:55`). While a save runs, the user goes through both questions, and then `exclusively`
(`:150`) returns at once: nothing is restored and nothing is said.

- **Confidence:** high.
- **Test:** a page test: start a large kept snapshot, click Restore on another one meanwhile, and expect the "wait"
  alert (as `load` gives) or a disabled button.

### 8. Low-medium: a notice wipes the stopped machine's error and its actions after 30 s

`Messages.notify` (`web/app/run/messages.ts:90-96`) replaces whatever the bar shows. When its 30 s timer fires it shows
the standing note, not what was there before. If the machine is `failed`/`crashed` (with its Retry, Show serial log,
Disks…, Allow access actions) and any notice comes (an `inBar` action's error via `providePage`, an
`unhandledrejection`, a folder or USB notice), the failure's explanation and its buttons are gone for good. The state
stays `failed`.

- **Trigger:** a machine fails with `disk-in-use`, then a network action in the toolbar fails. 30 s later the bar is
  empty.
- **Confidence:** high on behaviour. Severity is a judgement.
- **Test:** a unit test of `Messages`: setState('failed', e, [retry]), notify(x), advance the timer, and expect the
  failure's message and actions back.

### 9. Low-medium: "Start with N MiB of RAM" after a crash is overridden by the address

`MemorySignal.#use` (`web/app/run/memory-signal.ts:76-99`) writes the smaller RAM or JIT budget into the stored record,
then restarts. `restart` → `reloadStored` → `takeSize` resolves the address over the record
(`web/app/run/config.ts` `resolveSize`), so with `?ram=`/`?split=`/`?jitmb=` in the address the machine starts again
at the size that killed it. Also, `#use` clears the mark (`:76`) before it asks to orphan the snapshots. On Cancel,
`crashedBefore()` (`:89`) finds no mark and returns false. The bar keeps the old buttons, but the mark that would warn
the next start is gone.

- **Confidence:** high on the code. Opening a stored machine with `?ram=` is uncommon.
- **Test:** a unit test with a record, `?ram=4096`, and `#use({ramMiB: 1024})`, expecting the next config's RAM to be
  1024.

### 10. Low: closing the Machines page after the guest itself stopped doesn't reload the edited record

`web/app/areas/page-window.ts:162` reloads the stored machine only when `!machine.run`. After a guest power-off, crash or
suspend (worker `state` → `Runner.ended`), `m.run` stays the stopped run until the next `stop()`. Edits made on the
Machines page while it shows off (name, size, 3D) don't reach the toolbar or the Machine menu until Start.
`docs/frontend.md` and the comment ("while nothing runs") say they should.

- **Confidence:** high.
- **Test:** a page test: the guest powers off, rename it on the Machines page, close it, and expect the toolbar's name.

### 11. Low: the screen stops following density changes after the first one

`web/app/areas/screen-view.ts:69` registers one `matchMedia('(resolution: <dpr at load>dppx)')` listener and never makes
a new one. The query changes only when that one density is entered or left. After a move from 1× to 2×, a move from
2× to 1.5× (or between any two other densities) fires nothing, so the canvas isn't refitted or resized (the guest keeps
the old size) unless the box also resizes.

- **Confidence:** high (the standard `matchMedia` density pattern needs re-arming).
- **Test:** not cheap in headless Chromium. A small change that re-arms the query in its handler.

### 12. Low: a start can be posted to a run that was already stopped

`Runner.#begin` (`web/app/run/runner.ts:228-237`) checks `r.live()` after the folders, then awaits `resolveKeyboard`
(`:234`) and posts `start` without checking again. A `stop()` in that gap (Power off or Restart at that moment) posts
`stop` and then the page posts `start` to the same worker. The worker answers `stopped` and starts booting until it is
terminated, opening the overlay's handles meanwhile. The next run then waits on them (`OVERLAY_WAIT_MS`). A throw from
`folders.begin` or `resolveKeyboard` is also not caught there. It escapes as an `unhandledrejection` notice and leaves
the state at `loading` with the machine's lock held until a restart.

- **Confidence:** medium (narrow window). The missing catch is certain.
- **Test:** a unit test of `#begin` with a `resolveKeyboard` that resolves after `stop()`, expecting no `start` posted.

### 13. Low: the docs contradict the code

- docs/frontend.md "The worker protocol" (`:517`): "the page then terminates the worker (after 3 s without an answer)".
  `Runner.stop` waits `CLOSE_MS + 1500` = 4 s (`runner.ts:306`, `devices.ts` `CLOSE_MS = 2500`), as its own comment
  says.
- The same section lists `snapshot {id, handle?}` and `suspend {id}`. The messages also carry `keep`, `whole` and `sleep`
  (`web/app/worker.ts:72-75`, `snapshot-actions.ts`), and `snapshot-done` carries `pins`, `stateMs`, `blobBytes` and
  `slept`, which a kept snapshot's record depends on.

## Checked and found fine

- `Run.guard` and the per-save job ids: an old run's worker, GPU and display messages are dropped, and save answers
  find their job by id. Every path in `saveSnapshot`/`suspend` in the worker ends in `snapshot-done`/`suspend-done` or
  `snapshot-error`, so `power.saving` is cleared.
- `MachineLock`: a restart's take waits for the previous release, and a take that lands after its run was replaced
  drops itself.
- `start-message.ts`: every port in `MachinePorts` is in the transfer list, and the optional channels follow the
  config's devices. The worker's `layout` uses the same `slots` inputs as `planRestore` and `shapeOf`.
- `config.ts` precedence (address › record › settings › defaults) matches docs/frontend.md "Query parameters" for size,
  devices and 3D. `asRun` carries what the run resolved into `about`, and a kept snapshot uses the run's `about`, not
  the record now.
- `PageAudio.attach` closes the previous run's port, `UsbPorts`/`net.ports` re-adopt by id, and the GPU-failure
  fallback (`#gpu` `failed`) terminates both workers before it starts again in 2D.
- `ask.svelte.ts` queues questions (no lost resolver). `Modal`/`Ask` use `showModal` with `aria-labelledby`.
- `planRestore.commit` failing part-way leaves only in-memory record changes, and the Retry reloads the record.
