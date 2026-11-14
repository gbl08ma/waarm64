# Review: the page's side of the guest agent (BETTERAGENT, `d054e59b~1..b6a29139`)

An out-of-context static review of the changes outside `agent/`: `web/agent-frame.ts`, `web/app/agent-link.ts`, the
areas (`agent-actions`, `lease-actions`, `trim-actions`, `keyboard-follow`, `clipboard-actions`), `web/app/guest-agent.ts`,
`web/app/net-settled.ts`, the compaction path (`web/devices.ts`, `web/vm.ts`, `web/device-worker.ts`,
`web/app/worker-profile.ts`), the wiring in `web/app/main.ts` and `web/app/run/*`, the menus, `vite.config.ts` and the
tests. Two findings were confirmed with a throwaway Node test (`node --test`, not committed); the rest are static.

Scope note: `web/app/run/soft-power.ts` doesn't exist at HEAD and `web/app/run/power-actions.ts` is unchanged in the
range (the handover only records the soft power-off/reboot decision), so there was nothing to review there.

No high-severity finding: nothing found that powers the machine off unasked, loses data, or breaks the frame format.

## Medium

### M1. `AgentLink.close()` leaves its waiters pending. A trim that outlives its run is then joined by the next run's
**Where:** `web/app/agent-link.ts:253` (`close`), `:219-230` (`ask`), `:165-178` (`hello`);
`web/app/areas/trim-actions.ts:88` (`#running`), `:92-97`.

**Defect:** a run's end (`AgentActions.end` → `link.close()`) only closes the port. `opened(false)` never runs, so the
`waiting` entries (LEASE, TRIM, COPY) and any `hello()` waiter don't settle until their own timers fire (60 s, 120 s,
10 s, 20 s). Their timers keep running after the run and keep the dead link alive. On its own that is a leak, but
`TrimActions.#running` is shared by every run (it isn't cleared in `end()`), so a later run's trim joins the dead one:
- the new run's **storage-full trim** (`full`) gets the dead trim's `undefined`, so the new guest isn't trimmed for that
  notice;
- a **disk export** (`beforeExport`) shows "trimming" for up to the rest of the dead trim's 120 s, gets nothing, and
  then stops the machine without having trimmed it, which defeats the point of `beforeExport`;
- if the dead trim had already passed `link.trim` when the run ended, its `#compact` call goes to `machine.run`, which by
  then is the new run's worker (line 97).

**Trigger:** click Free unused disk space on a large disk. While the guest's FITRIM runs, restart the machine or
restore a snapshot. Within two minutes, export the disk or hit a storage-full notice.

**Confirmed:** an `AgentLink` with an agent that says `CAP.TRIM`; `trim(1500)`, then `close()`. The promise settled
only when its timer fired (after 1505 ms).

**Fix direction:** have `close()` settle `waiting` and the `hello()` waiters (as `opened(false)` does), and clear
`#running` in `TrimActions.end()`, or key `#running` to the link.
**Test:** the one above (close, then expect it to settle at once). Add a `TrimActions` case: end the run mid-trim,
`follow` a new link, call `beforeExport`, and expect a TRIM on the new link.
**Confidence:** high for the mechanism; medium that users will hit it (it needs a restart during a running trim).

### M2. LEASE renews every card, including those the page found not connected; the fallback flaps only the connected ones
**Where:** `web/app/areas/lease-actions.ts:45-53`, `web/app/net-settled.ts:45-48`; on the agent's side
`agent/src/lease.rs:81` (`commands`: every card in `/sys/class/net` with a device).

**Defect:** the page waits for its network to settle because the gateway NAKs a renewal while its connection has no
lease (`web/gateway.ts` `dhcp`: a REQUEST with no `lease` gets NAK, and a DISCOVER gets no offer), and a NAKed client
backs off. `whenConnected` returns *which* adapters are connected, but LEASE has no payload. The agent renews **all**
cards, including adapters that are still `connecting` after the 30 s grace, or `login`, or `error`. Those cards get the
NAK the wait was meant to avoid: they drop their address and go into DISCOVER backoff before their connection comes up.
The flap fallback (line 53) touches only the `connected` list, so the two paths disagree. A related case: the grace timer
(`net-settled.ts:45`) resolves `connected()` as it stands when the timer fires. If the one connected adapter dropped
back to `connecting` in the meantime, that list is `[]`, and LEASE still goes out and renews every card with nothing
connected.

**Trigger:** a stored machine with two adapters, the second on a tailnet that needs a login (or that takes over 30 s).
Restore a snapshot. Adapter 0 connects and the grace ends. The guest's second card is told to renew, is NAKed and backs
off.
**Confidence:** high that every card is renewed (lease.rs iterates `cards()`); medium on the user-visible impact, which
needs a multi-adapter machine. A fix: LEASE carries the cards (indices or MACs) to renew, and a `[]` from the grace means
"don't".

## Low

### L1. A `hello()` waiter that removes itself mid-iteration makes the next `onHello` listener miss the HELLO
**Where:** `web/app/agent-link.ts:322` (`for (const f of this.onHello) f(h)`), `:170-174` (`done` splices `onHello`).

**Defect:** `hello()`'s listener splices itself out of `onHello` while `received` is iterating that array, so the
listener after it is skipped for that HELLO. Today it is latent: the only transient listener is `LeaseActions`', pushed
after the run's persistent ones (`up`, clock, keymap, `canTrim`), so it is last. Any second concurrent `hello()`, or a
listener added after a pending one, silently misses a HELLO. The skipped one could be `up`, `canTrim` or KEYMAP if the
order ever changes.

**Confirmed:** two `hello(1000)` before the HELLO: the first got it, and the second resolved `undefined` after its timeout.
**Fix:** iterate a copy (`[...this.onHello]`). **Confidence:** high (latent).

### L2. Answers are matched by frame type only: a late COPIED, TRIMMED or LEASED answers the next ask
**Where:** `web/app/agent-link.ts:325`.

A COPY that timed out (10 s, a slow or busy guest) leaves the agent's answer in flight. The user clicks Copy the
console's text again, and the *earlier* COPIED resolves the new ask, so stale screen text goes onto the host's clipboard.
The same goes for a TRIM that timed out at 120 s while the agent's trim still runs. The next trim's ask is answered as
soon as the earlier job ends, and the compaction runs on that answer. The page also compacts after an early answer even
when the agent folded the new TRIM into a job it had already started, which `agent/src/main.rs:777` does by design. That
case is harmless.
**Fix:** a request id in COPY/TRIM (and in the answers), or drop answers for which no request is outstanding.
**Confidence:** high on the mechanism; low impact.

### L3. The forced compaction blocks the whole device worker, not only the disk's I/O
**Where:** `web/devices.ts:1017-1023`, `web/overlay.ts:183-205`.

`compact(true)` moves every block above every free slot in one synchronous loop. Each move is a 4 KiB read, a 4 KiB
write and a 4-byte map write, each its own `SyncFile` call. It runs on the device worker, which also serves the net,
console and input devices. After a trim that frees GiBs of a large overlay, that is hundreds of thousands of moves with
every device in that worker stalled: network frames and other disks too. docs/devices.md says only "the disk's I/O
waits". It is only measured at 47 MiB (`tests/page-agent.test.ts`). The page's `COMPACT_WAIT_MS` (120 s) gives up on the
answer but doesn't stop the work. Also, `while (running.size) await …` never ends under I/O that never pauses. It is
bounded on the page's side, but the compaction then runs at some arbitrary later moment.
**Suggest:** measure a GiB-scale case. If it is long, compact in slices that yield between them, with the disk's
requests held.
**Confidence:** a suspicion on the size of the effect; the mechanism is certain.

### L4. `canTrim` stays true after the agent's connection ends
**Where:** `web/app/areas/trim-actions.ts:73-84`.

`canTrim` is set at each HELLO and cleared only at the run's end. While the guest reboots, shuts down, or its agent is
stopped, the storage bar still shows Free unused disk space. A click says "no answer". `full()` and `beforeExport()` also
go through `trim()`, and they do no harm. Clear it in an `onOpen(false)` hook. **Confidence:** high, cosmetic.

### L5. Export waits up to ~6 minutes for the trim and compactions, with no way to skip them
**Where:** `web/app/areas/disk-export.ts:178-181`, `trim-actions.ts:94-97`.

`beforeExport` runs under `pw.exclusively` after the user confirmed the stop: a measuring compaction, the trim (up to
`TRIM_WAIT_MS` 120 s) and the compaction (up to `COMPACT_WAIT_MS` 120 s). On a slow guest, the export the user asked for
waits minutes with only "trimming" shown. M1 makes it worse.
**Suggest:** a shorter bound before an export, or a way to skip the trim. **Confidence:** high on the bound; whether it
matters is a product call.

### L6. Tests that don't cover what they claim
- `tests/trim.test.ts` ("a compaction asked for … gives back what a change's doesn't") calls `vm.compact()` in `atEnd`,
  after the guest's `poweroff -f`. No request is in flight, so the `running` wait in `blk`'s `compact`
  (`web/devices.ts:1005-1020`) isn't tested at all: nothing compacts while the guest does I/O. A planted bug that
  drops the `while (running.size)` line would pass every test. Suggest a Node test on `blk` with a request held open
  (a base read that waits on a promise) and `compact()` called meanwhile: the compaction must wait, and the read must
  return the right bytes.
- `tests/agent.test.ts` "a restore's leases … a run that ends first does neither" ends the run only *before*
  `whenConnected` resolves. Ending the run while the code waits on `hello` or `lease`, the paths with the `gone()` checks
  at lines 49 and 51, isn't tested.
- `tests/agent.test.ts` trim test: no case where the run ends while a trim is pending (M1).
- `tests/page-template.test.ts:24` skips on the ELF `waarm64-agent`, but the page fetches `waarm64-agent.gz`. A tree
  with only the ELF fails at `agentUp` (120 s) instead of skipping. Minor, since `images/build.sh agent` makes both.

## Notes (not defects, or outside the range)

- After a restore, a crashed agent stays gone for the run. `worker-start.ts:40` doesn't fetch the binary for a snapshot,
  so `Restart=on-failure` reruns the script, which finds no `agent.000` and exits 0 with "this kernel has no
  qemu_fw_cfg?". That message is wrong in this case. The same holds after a guest-initiated reboot inside a restored run.
  This predates the range (`910d81d2`); with LEASE, TRIM and KEYMAP depending on the agent, it matters more.
- The `encodeKeymap` lengths aren't capped at 255 (`web/agent-frame.ts`). Every `KEYBOARD_LAYOUTS` name is short and
  matches the agent's `plain` set, so this is only a guard for the future.

## Checked and found fine

- **Frame format:** type numbers, CAP bits, and the DESKTOP, LEASED, TRIMMED, COPIED and RENEWED values match
  `agent/src/frame.rs`, `lease.rs`, `trim.rs`, `screen.rs` and `renew.rs`. HELLO, TIME (u64 ns, split ms/ns), DISPLAY,
  KEYMAP (u8-length strings, layout/model/variant/vc) and COPIED (status then UTF-8, at most 64 KiB, so under
  `MAX_PAYLOAD`) match the agent's decoders and encoders. The `backlog` estimate of 13 bytes for a deferred TIME is right.
- **Connection handling:** connection numbering (`conn`) drops stale `taken`, `data` and `reset`. `opened` clears the
  queue, inflight, reader, waiters, `renewSent` and the desktop state. RENEW is owed across connections until RENEWED.
  DISPLAY's size is kept and resent at each HELLO.
- **Ordering:** `agent.begin` runs before the worker exists, so the worker's `restored` always finds the run's link.
  Restores go through `await runner.stop()`, then `start`, so `LeaseActions.end` precedes the next `restored`, and the
  `gone()` checks cover the awaits.
- **The flap port:** `channels` → `startMessage` transfer → `worker-devices` → `net`'s `link.onmessage`. It flaps only
  under a driver, one at a time, and the port closes with the backend. The flap index matches `views()`'s order
  (`ports` maps `adapters` in order).
- **Compaction's wait:** `running` is filled by the outermost `request` wrapper (it wraps the `concurrent` one). The
  delete callbacks run before `allSettled`'s, and the continuation and `compact()` run in one microtask chain, so no
  request starts between the wait's end and the moves. `measure` doesn't wait.
- **`asTemplate`:** the snapshot stream has no absolute offsets, so rewriting the header (its length and CRC) keeps the
  file valid.
- **The script and unit:** `agentScript` has no interpolated user data (`AGENT_FILE` is a constant; the glob is
  unquoted on purpose and sorted). `guestUnit` puts the description on one line. The unit's sandbox lets through what
  the agent's children need: `busctl` (D-Bus over `AF_UNIX`), `nmcli`, `loadkeys` (CAP_SYS_TTY_CONFIG), `ssh-keygen`
  (into the `ReadWritePaths`), FITRIM through read-only binds (CAP_SYS_ADMIN, superblock not read-only), and `connect()`
  to sockets on read-only mounts (`/run/user`, the bound `/tmp/.X11-unix`). Nothing over-grants beyond what the doc
  lists.
- **`plainGzip`:** it only touches `.gz` URLs. Nothing else the dev server serves as `.gz` relied on transparent
  decoding; the virgl fixtures are read from disk.
- **`keyboardFollow`:** it runs after `netFollow`, which rereads the record, so `resolve()` sees the new setting.
