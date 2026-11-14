# Review: the Machines screen's clean stops (BETTERAGENT loop 13, commit 3d42c9d1)

Static review of `web/app/run/clean-stop.ts`, `PowerActions.stopCleanly`/`powerOff({ cleanly })`, `ask.wait` and
`Ask.svelte`, and their callers (`disk-export.ts`, `disk-actions.ts` `switchMachine`, `size-actions.ts`
`saveSettings`, `MachinesPage.svelte` `offFirst`), read against `soft-power.ts`, `runner.ts`, `worker-messages.ts`,
`agent-link.ts` and `agent-shown.ts`. Finding 3 was confirmed with a throwaway Node test (real `SoftPower` +
`stopCleanly`, fake link). It was not committed.

Counts: 2 high, 3 medium, 3 low.

---

## 1. HIGH: Esc on the "Shutting down" dialog leaves no way to cut the power, and the page stays locked

- `web/app/ask.svelte.ts:66-96` (`wait`: Esc resolves `false`, so `skipped` never resolves), `web/app/Ask.svelte:25-28`
  (`oncancel` → `answer(false)`), `web/app/run/clean-stop.ts:40-48` (the wait has no end other than the guest going
  down or `skipped`), `web/app/run/power-actions.ts:40-48` (`exclusively` returns silently while `power.busy`).
- **What goes wrong:** Esc takes the wait dialog down, but `stopCleanly` keeps waiting inside `exclusively`, so
  `power.switching` stays true. Nothing can bring back "Power off now". The toolbar's Power off runs
  `powerOffAsked`. There `#soft.request('off')` returns false (`shown.soft` is still `'off'`), the user confirms
  "power off now", and `powerOff()` → `exclusively` returns at once without stopping anything and without saying
  so. The same happens to Restart, a disk reset, a restore, Open disk, an export and the settings (all go through
  `exclusively`, or bail on `busy()`).
- **Scenario:** the Machines page's Save and restart on a Debian guest with the agent. The dialog shows and the user
  presses Esc (the usual way to dismiss a dialog). The guest's shutdown then hangs (a systemd stop job waiting 90 s or
  forever), or never starts (see finding 4: the agent's connection dropped for another reason). The page now refuses
  every power action until the guest powers off on its own. If it never does, only a reload of the tab gets out.
- **Note:** the docstring says Esc "only takes the dialog down (the wait goes on without it)", so this is by design.
  The defect is the dead end the design leaves. Either Esc should do nothing on a `wait`, or the toolbar's Power off
  should reach the pending wait's `skipped`.
- **Confidence:** high (followed through the code; not run).

## 2. HIGH: `offFirst` reports "off" when the stop didn't run, and the Machines page edits a running machine

- `web/app/MachinesPage.svelte:108-126` (`await page.powerOff(); … return true`), `web/app/main.ts:273`,
  `web/app/run/power-actions.ts:125-130` + `40-41`.
- **What goes wrong:** `powerOff()` is `exclusively(...)`, which returns `undefined` without stopping when
  `power.busy` is set. `offFirst` doesn't look at the result and returns `true`. Its callers then apply the edit to a
  machine that is still running: `Disks.svelte:51/62/74/98` (attachment flags, detach), `AddDisk.svelte:122` and
  `AttachDisk.svelte:55`. `records.reread()` still lists it as running, since its lock is held.
- **Scenario:** after finding 1's Esc, a clean stop is still waiting with `power.switching` true and no modal on the
  page. The user goes to the machine's Disks tab and detaches or adds a disk. The question "power it off first?" is
  asked and answered OK. Nothing stops, and the attachment is written into the record of the running machine. The
  same path is reachable without this commit while a snapshot is being written (`power.saving`), so the bug is older.
  This commit makes the busy window long (a guest's whole shutdown) and lets the user leave the modal.
- **Confidence:** high for the code path. The harm depends on what each edit does to a record whose disks are open
  (suspected bad: a detach or a new overlay under a live run).

## 3. MEDIUM: a toolbar Power off or Restart already pending turns the clean stop into an immediate hard cut

- `web/app/run/clean-stop.ts:39` with `web/app/run/soft-power.ts:273` (`if (this.#shown.soft || …) return false`).
- **What goes wrong:** `SoftPower.request` treats "a request already pending" as "the hard one is the caller's".
  `stopCleanly` reads that `false` as refused. It closes the dialog it just opened and calls `runner.stop()`. No
  question is asked, and the guest may be in the middle of the shutdown the user asked for.
- **Scenario:** the user clicks the toolbar's Power off (the guest is asked, `power.soft = 'off'`, and the sign
  shows). Within the next seconds they open the Machines screen and start an edit that needs the machine off, or Save
  and restart, or an export. The question uses the `.soft` wording ("you will be able to power it off forcibly, if
  needed"). After OK the dialog flashes and the power is cut mid-shutdown. With a toolbar Restart pending
  (`'reboot'`), the same thing happens. The window lasts from the request until the agent's connection drops: up to
  `SOFT_WAIT_MS` (15 s) while POWERED is awaited, longer with a delay inhibitor.
- **Confirmed:** a throwaway test (real `SoftPower` with a fake link whose `power()` never answers, then
  `stopCleanly`) gives `'hard'` with log `['dialog', 'closed', 'cut']`.
- **Fix direction:** when a soft request is already pending (`power.soft === 'off'`), wait for it as if taken, rather
  than cutting.

## 4. MEDIUM: an agent connection that ends (or comes back) for any reason other than the shutdown makes the wait endless

- `web/app/run/soft-power.ts:282-284` (`'gone'`, or a link changed, both count as taken), `web/app/run/clean-stop.ts:40-48`.
- **What goes wrong:** `request` returns `true` when the connection ends before POWERED, on the theory that the
  shutdown stopped the agent. If the agent restarts instead (a crash, its service restarted, a vsock reset), the
  guest never shuts down. The agent's next HELLO even clears `power.soft`, `SoftPower`'s own sign that "the guest
  isn't shutting down" (`soft-power.ts:276-278`). But `stopCleanly` doesn't watch for that and has no deadline, so the
  dialog waits until the user clicks Power off now (a hard cut). Combined with finding 1 (Esc), the page is stuck for
  good.
- **Scenario:** the agent's service restarts at the moment the POWER frame is in flight (for example during a
  package upgrade that restarts it). The connection ends, then a new HELLO arrives, and the dialog stays.
- **Confidence:** medium. The code path is clear; how often the agent restarts at that moment is unknown.

## 5. MEDIUM (design, documented): refused or unanswered means a hard cut with no question, unlike the toolbar

- `web/app/run/clean-stop.ts:39-51`. The behaviour is documented in docs/devices.md ("refused or unanswered, the hard
  stop follows at once").
- **What goes wrong:** the guest's refusal comes from logind honouring a block inhibitor, which a package manager or
  an unsaved-work app holds on purpose. The toolbar's Power off then asks before the hard power-off. These stops cut
  the power with no further question. The earlier question only promised that the user *will be able* to power it off
  forcibly, which reads as the user's choice. The message bar's "refused" note (`soft-power.ts:286`) is overwritten
  at once by the change's own `setState` (an export's `'off'`/saving, the settings' restart).
- **Scenario:** the user exports a disk while `apt upgrade` runs in the guest under an inhibitor. The guest refuses,
  and the page cuts the power in the middle of the upgrade, then exports the half-upgraded disk.
- **Confidence:** high that it happens. Whether it is a defect is the user's call; it is flagged because it
  contradicts the question's wording and the toolbar's rule.

## 6. LOW: the page tests' question answerer clicks "Power off now" on every wait

- `tests/page-ask.ts:6` and `:25`: `answerAsks` clicks `[data-answer=ok]` on every open `#ask`, and its
  `Question['kind']` doesn't include `'wait'`.
- **What goes wrong:** any Chromium test that goes through an export, a settings Save, a switch or the Machines
  page's Power off with an agent connected gets its wait dialog skipped at once, which is a hard cut. So no page test
  runs the clean path (the guest's own power-off ending the dialog, disks landed by the guest), and such tests
  keep passing on what is really a hard stop. `tests/clean-stop.test.ts` covers only the pure function with fakes.
  These go untested: `PowerActions.stopCleanly`'s wiring (`up()`, the pending-request case of finding 3), `ask.wait`'s
  `close()` while queued and while current, Esc on a wait, and the `serial`/queue invariants.
- **Confidence:** high.

## 7. LOW (suspicion): the wait dialog puts focus on its destructive button

- `web/app/Ask.svelte:16` focuses `okButton` for every non-prompt kind, `'wait'` included, and that button is
  "Power off now" (danger).
- **What goes wrong:** the wait appears within milliseconds of the confirm that came before it (a microtask-paced
  `exclusively` → `stopCleanly`) for the settings, the switch and the Machines page's Power off. A user who answered
  the confirm with Enter and holds it (key repeat), or presses Enter again, triggers a hard cut through the newly
  focused button.
- **Confidence:** low. It depends on how Chromium activates a focused submit button on a repeated keydown; not tried.

## 8. LOW: the dialog's wait can start behind another question and stay invisible

- `web/app/ask.svelte.ts:23-29`, `web/app/run/clean-stop.ts:35`.
- **What goes wrong:** if a question is already open, for example a `void ask.alert(...)` fired just before (the
  export's `#runsElsewhere` or `busy()`'s alert), the wait is queued behind it. The guest is asked to shut down while
  no Power off now button is visible. `close()` removes it from the queue correctly, so no invariant breaks; the
  user only can't skip until the other question is answered.
- **Confidence:** medium that it can be queued; low impact.

---

Checked and found sound:
- `close()` while the wait is current: it answers and advances (`serial` bumps). While queued: it is spliced out and
  resolved. After an answer: the second resolve is a no-op.
- Power off now before or after the guest's answer: the pending `link.power` settles `'gone'` through
  `runner.stop()` → `agent.end()` → `link.close()`, and `power.soft` is cleared by `canPower(false)`.
- The guest powering off on its own during the wait: `up()` turns false on `'off'`. The worker posts `'off'` only
  after `shutdown()` has landed the disks, and the later `runner.stop()` on that run gets `'stopped'` from the
  memoized `closed`.
- A crash during the wait: `runner.crash` → `stop()` clears `machine.run`, so `up()` is false.
