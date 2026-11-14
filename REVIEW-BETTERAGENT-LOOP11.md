# Review: the guest's OS and its clean power-off (BETTERAGENT loop 11, commit d370c708)

Out-of-context static review of `d370c708`. The agent's side (`agent/src/frame.rs`, `os.rs`, `power.rs`, `main.rs`),
the page's side (`web/agent-frame.ts`, `web/app/agent-link.ts`, `web/app/run/soft-power.ts`,
`web/app/run/power-actions.ts`, `web/app/areas/agent-*.ts`, `Toolbar.svelte`, the status bar) and the tests. The frame
numbers, CAP bits, POWER values, POWERED statuses and OS's layout (u8 length + UTF-8, three times) are the same on
both sides. I found no protocol mismatch.

Findings 1 and 2 were confirmed with a scratch `node --test` file that drove `AgentLink` and `SoftPower` through a
faked device port, like `tests/agent-power.test.ts` does. The file isn't committed. Everything else is from reading
the code.

Severity: **Medium** = wrong state the user acts on, or a shutdown the page told the user didn't happen; **Low** =
narrow window or cosmetic-with-consequence; **Info** = suspicion or out of the stated scope.

---

## 1. Medium: any end of the agent's connection is taken as "the guest took it", and the sign never clears

`web/app/run/soft-power.ts:40` (`r === 'gone'` returns true), `web/app/agent-link.ts:329` (every waiter is resolved
`'gone'` on any open/close), `web/app/areas/agent-shown.ts:11-13` (only `canPower(false)` clears `soft`).

**What goes wrong.** `request()` treats `'gone'` like `TAKEN`. It returns true, so no fallback runs, and it leaves
`power.soft` set. `AgentLink.opened` resolves `'gone'` whenever the connection closes *or a new one opens*. Nothing
after that clears the sign until the run ends:
- a later HELLO from the same agent calls `canPower(true)`, which doesn't touch `soft`;
- a POWERED that comes on the new connection has no waiter and is dropped. The agent keeps `powered` on `Agent`, not
  on the session (`agent/src/main.rs:734`), so it does send it on the next connection.

From then on the toolbar says "Shutting down…" or "Restarting…" for the rest of the run, the status bar's state says
the same, and the stop button is red. The next click on Power off or Restart skips the guest and goes straight to the
hard question, worded as "the guest is on its way" (`power-actions.restart.now` / `powerOff.now`). The user is led
into a power cut on a guest that isn't shutting down.

**Scenario.** The connection can end for reasons other than a shutdown:
- The agent is OOM-killed. Its unit makes it the guest's first victim (`OOMScoreAdjust=500`, `MemoryMax=32M`), and
  `Restart=on-failure` brings it back 5 s later.
- The agent fails a write or poll and reconnects (`Stop::Failed`).
- The page's reader goes out of step and resets the stream (`agent-link.ts` `resetting`).
- The guest driver resets the virtio device (`vsock-device.ts` `reset()` → `dropAgent`).

If this happens between the click and POWERED, with logind refusing (a block inhibitor) or busctl still running, the
refusal arrives on the new connection and is ignored. My scratch test showed that after `'gone'` and a fresh HELLO
with `CAP.POWER`, `shown.soft` stays `'off'` and the next `request('off')` returns false, which means the hard path.

A snapshot restore is *not* a trigger: it starts a new run (`snapshot-restore.ts` → `runner.stop`/`start`), and
`AgentActions.end` clears the sign.

**Fix direction.** A new HELLO after `'gone'` shows the guest isn't shutting down, because a shutting-down guest's agent
is stopped and doesn't connect again. On the next HELLO, clear `soft` (or re-ask). Better still, let a POWERED that
arrives on the next connection settle the pending request.

**Confidence:** high on the mechanism (confirmed). The trigger needs a connection drop inside the request's window
(normally under a second; up to 15 s), so it is uncommon.

## 2. Medium: a timed-out request isn't withdrawn, so its late answer can settle a later request of the other kind

`web/app/run/soft-power.ts:38-46`, `web/app/agent-link.ts:359` (any POWERED settles every POWERED waiter),
`agent/src/main.rs:843` (`POWER if powering.is_none()`: a POWER while one runs falls to `_ => {}` at :910, so it is
dropped with no answer).

**What goes wrong.** After `SOFT_WAIT_MS` with no answer, the page clears the sign and shows the ordinary hard
question. The agent's busctl or shutdown child keeps running, and nothing cancels it. Two things follow:

1. The user answers Cancel ("don't cut the power") and believes nothing will happen. When busctl finishes, the guest
   powers off or reboots anyway. The page told the user it didn't take the request, and they declined the
   alternative.
2. If the user then clicks the other button (Restart after Power off, or the reverse), the agent drops the new POWER
   because the first is still running. The first request's POWERED then resolves the *new* waiter: frames carry
   neither a request id nor the kind. The page shows "Restarting…" while the guest powers off, and the run ends `off`
   instead of rebooting. My scratch test reproduced the link half: request A (off) times out, request B (reboot) is
   sent, and A's `TAKEN` answers B.

**Scenario.** The busctl call has to take more than 15 s. Some ways that happens:
- The agent runs at `Nice=10`, and so does busctl, which inherits it. A guest whose vCPUs are saturated by nice-0 work
  under the JIT starves both.
- dbus or logind is slow or restarting, for example during a package upgrade. sd-bus's default method timeout, 25 s,
  is longer than the page's 15 s.

**Fix direction.** Echo the request kind (or a serial) in POWERED and ignore answers that don't match. Answer a second
POWER while one runs explicitly (for example with a "busy" status) rather than staying silent. Either kill the child
on the page's timeout, or say in the hard question that the guest may still act on the earlier request.

**Confidence:** high on the logic (confirmed at the link level); low to moderate on how often the trigger happens.

## 3. Low: the hard question outlives the run it was asked for

`web/app/run/power-actions.ts:103-118` and `:131-145`. `isLive(power.state)` is checked before `ask.confirm`, never
after. Nothing checks that the run is still the same one.

**What goes wrong.** Say a soft reboot is pending and the user clicks Restart again: they get "Restart now?". Before
they answer, the guest's own reboot completes (PSCI reset → `rebooted` → a new run that boots). Their OK then hard-restarts
the *new* run in the middle of its boot. The same happens with Power off: a second click during a pending soft
reboot, then OK, cuts the power of the freshly booting run.

A related case: after a soft power-off completes (`off`), the stale "Restart now?" dialog's OK *starts* the machine.
That is arguably what Restart means, but nobody asked for it after the stop.

**Scenario.** Click Restart, click Restart again within the ~2 s the guest needs to reach its reset, and answer the
dialog after that.

**Confidence:** high on the code path. The effect is mild: a power cut of a booting guest.

## 4. Low: the toolbar's tooltip promises a soft request while the agent is disconnected

`web/app/areas/agent-shown.ts:11-13`, `Toolbar.svelte` `offTitle`/`startTitle`. `power.canSoft` is set at each HELLO
and cleared only when the run ends. It isn't cleared when the connection closes, whereas `link.canPower` becomes false
at once (`agent` is reset in `opened`).

**Scenario.** While the agent restarts (5 s `RestartSec`), or while it reconnects after a drop, Power off's tooltip
says it will ask the guest. The click actually goes to the hard question, and nothing says why. This is not a power cut:
it still asks first. But the user may expect a clean shutdown and confirm a hard one. Clear `canSoft` on `onOpen(false)`.

**Confidence:** high.

## 5. Low: a timeout, "no tool" or a failed send is dropped without a word

`web/app/run/soft-power.ts:43-46`. Only `REFUSED` notifies. A timeout (`undefined`), `NO_TOOL`, or `ask()` returning
`undefined` because `send` failed (the link closed between `canPower` and `send`) all fall through to the ordinary
hard question with its ordinary wording. Nothing says the guest was asked and didn't answer.

**Scenario.** A guest without busctl or shutdown, or one that is slow to answer. The user sees "Shutting down…" for
15 s, then the plain question, as if the soft path didn't exist. This matches "a request the page drops silently" in
the brief. It is a design choice in the docs ("today's hard power-off"), but the user can't tell a refusal from a
timeout from no tool.

**Confidence:** high (by reading).

## 6. Low (suspicion): os-release is read unbounded and blocking in the agent's event loop

`agent/src/os.rs:95` → `rt::read_file`. `rt.rs:117` reads until EOF with no limit. The read happens synchronously in
`Session::frame` at each HELLO.

**What goes wrong.** If `/etc/os-release` (or what it links to) is a FIFO, the root agent's whole loop blocks forever:
no clipboard, no clock, no POWER. If it is a link to a device such as `/dev/zero`, the buffer grows until
`MemoryMax=32M` kills the agent. The unit restarts it, and each HELLO repeats the kill until the start limit (5 in 10
minutes) stops it.

Separately, a file that isn't valid UTF-8 (one Latin-1 byte) fails `read_text` with ILSEQ. The agent then silently
reads `/usr/lib/os-release`, which may be a different or stale file, instead of decoding the bad byte lossily.

**Scenario.** It needs root in the guest to misconfigure the file, so this is not an exploit. It is a robustness gap
in the parsing of guest-controlled files: cap the read (for example at 64 KiB) and open with `O_NONBLOCK` or check
`S_ISREG`.

**Confidence:** high on the mechanism, low on real-world impact.

## 7. Info: the fallbacks outside systemd ≥ 246

`agent/src/power.rs:46-75`.
- `PowerOffWithFlags` and `RebootWithFlags` exist only in systemd 246 and later. On an older logind, busctl fails, the
  agent reports `REFUSED` ("an inhibitor?"), and it never tries `shutdown`. The user is told the guest refused when it
  merely lacks the method.
- On a non-systemd `shutdown`, `shutdown now` without `-h`/`-P` means single-user mode on sysvinit: the request is
  `TAKEN`, but the guest never powers off and the sign stays for the run. `openrc-shutdown` rejects it outright.

`docs/devices.md` scopes the agent to systemd 256+ guests, so this is out of scope today. I list it because the
fallback's command line is wrong for every init except systemd's. `shutdown -P now` / `-h now` would be safer.

**Confidence:** medium (from the tools' documented behaviour; not run).

## 8. Info: what the tests don't cover

- `tests/agent-power.test.ts`'s soft-power case asserts that `'gone'` means taken and that the sign stays (`assert.equal(shown.soft, 'reboot')`).
  It doesn't reconnect afterwards, so finding 1 passes unnoticed.
- No test sends a POWER while one runs, so the documented "a second while one runs is answered by its POWERED" is
  untested on the agent (`serve_test.rs` sends one at a time). No test checks that a late answer settles the wrong
  request (finding 2).
- `serve_test.rs` `powers_off_or_reboots_as_asked_and_says_if_taken` checks the busctl argv only for `RebootWithFlags`.
  `PowerOffWithFlags` is checked only in `power.rs`'s unit test, not end to end.
- `tests/page-power.test.ts` never covers a timeout or a reconnect. It does check, correctly, that a refusal leads to
  the hard question, and that the clean restart and power-off ask nothing: answering "cancel" to every question means
  a hard path couldn't make it pass.
