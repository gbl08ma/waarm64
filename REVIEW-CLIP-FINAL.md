# Clipboard sharing: final static review

Scope: everything `git diff 2f706ab2` changed for clipboard sharing. The agent (`agent/src/*`), its unit and its
delivery (`web/app/guest-agent.ts`, `guest-unit.ts`), its build (`images/build.sh agent`, `tools/dist.ts`), the device
and the page (`web/agent-device.ts`, `agent-frame.ts`, `app/agent-link.ts`, `app/clipboard.ts`, `app/png*.ts`, the chord
hold in `web/input.ts`, the menu, the machine switch, and the wiring in `main.ts`, `worker.ts`, `devices.ts`,
`gpu-present.ts`). The review was static, plus the agent's host tests (`cargo test`: 34 passed, with sway and Xvfb
present).

Findings are ranked most severe first.

---

## 1. X11: a conversion that is never answered stays forever and wedges the X clipboard (high)

**Where:** `agent/src/x11.rs:1041` (`owner_changed`), `:1092` (`owner_busy`), `:1099` (`start`). A `Conversion` is
removed in only three places: its SelectionNotify or GetProperty completing it, a pipe write failing (`abort`), or
the X connection ending.

**Defect:** nothing reaps a conversion whose answer never comes. Two cases trigger it:
- The owner receives our SelectionRequest and then exits or crashes without answering. The server answers for an
  owner only when there is none at ConvertSelection time.
- The owner drops our request. xclip 0.13 does this during an INCR to another requestor (the code's own comment says
  so). The agent serialises only its *own* conversions, so an INCR to a guest program can still be running when ours
  arrives.

Such a conversion stays `Conv::Asked`. An INCR whose owner dies mid-transfer stays `Waiting` the same way. Three
things follow:
- **For that owner:** `owner_busy(owner)` is true for good, so every later conversion from it (TARGETS, the probe, a
  REQUEST) waits in `queue` forever.
- **Slots leak:** `owner_changed` does not drop the dead owner's conversions, so each one holds one of the six
  `WEBPC_<k>` slots for good.
- **The wedge:** after six such leaks, `start()` finds no free slot. `convert()` still queues and returns true, so
  `owner_changed` never sends its empty `Ev::Selection` fallback. From then on every guest copy is silently ignored,
  and every page REQUEST fails, until the X server or the agent restarts.

The probe's and Xfer's read ends are dropped on the session side, but the X side notices only on a write, and an
`Asked` conversion never writes.

**Confirming test** (`x11_test.rs`, Xvfb):
1. Start a raw X client (a few requests over the socket, or a small helper) that takes CLIPBOARD and never answers
   SelectionRequest.
2. Let the agent's TARGETS conversion reach it, then kill the client.
3. Repeat six times.
4. Have `xclip -i` copy text and expect an OFFER: none comes.

A smaller variant: one silent owner that stays alive. After it, `xclip` copies, then the silent client takes
ownership again, and a REQUEST for its text never gets DATA.

**Fix direction (no timer needed):**
- At XFixes SelectionNotify, drop the conversions in `Asked`, `Waiting` or `Came` whose owner is no longer the owner:
  close their pipes and delete their properties.
- Or bound `Asked` by the next XFixes event for the same owner.

## 2. Page: a guest image or HTML whose bytes never come stops every focus sync (medium)

**Where:** `web/app/clipboard.ts:449` (`writeItem`), `:479` (`this.writing = true`), `:310` (`focused` returns while
`writing`), `:622` (`request`: no end but DATA, a newer OFFER, or `reset`).

**Defect:**
- `writeItem` hands Chromium a `ClipboardItem` whose promises wait on the page's REQUESTs, and sets `writing` until
  `write()` settles.
- If the guest never answers, `write()` never settles, so `writing` stays true. This happens when a Wayland source's
  program holds its pipe open without writing (a frozen app), or when the X conversion is wedged as in finding 1.
- The agent has no timeout either: `Xfer::Out` waits on the pipe for good.
- With `writing` stuck, every `focused()` returns early. The host's copies stop reaching the guest until the guest
  copies something new (`OFFER` stops the old requests) or SESSION, HELLO or the port resets.

**Condition:** a guest program copies an image or HTML, the page has focus, and the owner never serves the type.

**Confirming test** (`tests/clipboard.test.ts` style, fake link and host):
1. The fake agent OFFERs `image/png` of unknown size.
2. The test never answers the REQUEST; `host.clipboard.write` awaits the item's promises.
3. Call `focused()` with the permission granted, and assert `readText` was called. Today it isn't.

## 3. Typist: a long paste is typed with a hole, its memory grows with the whole paste, and DONE hides the drop (medium)

**Where:** `agent/src/console.rs:141` (`push`), `:206`–`:216` (`step`), `:220` (`end`).

**Defect:**
- **Holes:** the budget is `queue.len() - at`, the bytes not yet typed. Once a paste passes 1 MiB, a TYPE frame that
  doesn't fit is dropped (TYPED `DROPPED`). The next frames are taken again as soon as typing has freed 64 KiB. The
  console gets the text with a 64 KiB hole in the middle, and when the queue ends `step` sends TYPED `DONE`. The page
  keeps the last status (`ClipboardShare.typed`), so the menu shows no warning.
- **Memory:** the queue `Vec` is never compacted while busy: `at` advances, and the front is freed only at `end`. A
  sustained paste into a reader that keeps up grows the `Vec` to the whole paste plus its capacity doubling. "Type the
  clipboard" has no size cap on the page side (`typeIt`, `typePayloads`), so a paste of tens of MiB passes the unit's
  `MemoryMax=32M`. The kernel then OOM-kills the agent (`OOMScoreAdjust=500`) and takes the session child with it.

**Confirming tests:**
- `console.rs` unit, holes: a fake console that takes 4 KiB of unread input per step. Push 17 frames of 64 KiB and
  step until one frame's worth is typed. Push an 18th, run to the end, then assert that the typed bytes are a prefix
  of the input and that the last status isn't `DONE`.
- Memory: a fast fake reader, push frames continuously for 8 MiB, and assert `queue.capacity()` stays near `QUEUE`.

**Fix direction:**
- Once a paste has dropped, refuse its remaining frames until the queue ends, and keep `DROPPED` as the final status.
- Drain the typed prefix of `queue` (for example, when `at > QUEUE/2`).

## 4. HELLO leaves the session child holding an earlier page's offers (medium)

**Where:** `agent/src/session.rs:836` (`frame::HELLO => self.xfers.clear()`). Its effect reaches
`host_send` (`:988`) and `page_request` (`:1248`).

**Defect:** after a snapshot restore, or after the port is reopened following `Stop::Broken`, the new page has reset
everything (`clipboard.ts` `reset()`, with new random serials). The child keeps two things:
- **`host`**, a source for the earlier page's serial. A guest paste of anything not cached (an image, HTML, text over
  64 KiB, or text that never crossed whole) sends REQUEST(old serial). The new page answers
  `DATA_FAIL`, because `offered` is undefined. The guest's clipboard keeps advertising content that pastes as nothing,
  and it stays so until the host copies again. Without the read permission, no focus sync replaces it.
- **`guest`**, the guest's selection, already offered to the earlier page. It is never offered to the new one. A copy
  made in the guest before the snapshot can't reach the host after the restore until the guest copies again.

The plan (§2: "The page's HELLO reaches the session child too, whose transfers in flight end") covers transfers
only. That leaves this gap.

**Confirming test** (`sway_test.rs`):
1. Page OFFER of 100 KiB of text, lazy, then ACK `HELD`.
2. Page HELLO.
3. `wl-paste` in the guest: the agent sends REQUEST with the old serial.
4. A second case: `wl-copy` some text, then HELLO, and expect an OFFER of it. None comes.

**Fix direction:** at HELLO, drop `host` (clearing the selection if it is ours, as PAUSE does) and re-offer the current
`guest` selection under a new serial.

## 5. X11: a TARGETS list longer than 64 atoms discards the whole selection (low–medium)

**Where:** `agent/src/x11.rs:1166`–`:1172` (`got_property`'s cap for `Sink::Targets`, `4 * MAX_TYPES` = 256 bytes),
then `finish` (`:1227`).

**Defect:**
- A TARGETS reply past the cap sets `Done` *without* appending the value, so `finish` turns an empty `buf` into
  `Ev::Selection { types: [] }`.
- The selection is then ignored entirely: no text, no image, and nothing logged.
- It should truncate to the first 64 atoms, as Wayland's `MAX_TYPES` does.
- Owners with many targets exist: GTK's image targets list every gdk-pixbuf writer with its aliases, and office
  suites list many formats.

**Confirming test** (`x11_test.rs`): an owner whose TARGETS lists 70 atoms with `UTF8_STRING` among the first ten.
Expect an OFFER: none comes. (`xclip -t` can't do it; use a raw client, or call `X::got_property` directly with a
70-atom reply.)

## 6. X11: the display's socket isn't checked before the user's cookie goes to it (low; security)

**Where:** `agent/src/x11.rs:659`–`:668` (`X::connect`), `:425` (`displays`), `agent/src/session.rs:654`–`:679`
(`x_try`, which sends `x11::cookie(...)`).

**Defect:**
- `/tmp/.X11-unix` is world-writable (sticky). When the session user's processes name a display (`DISPLAY=:1` in an
  environment, or a server's argument) whose server isn't up yet, any other local uid can bind `X1` first.
- The child, running as the session user, connects and sends the user's `MIT-MAGIC-COOKIE-1` from `.Xauthority` in the
  setup. From then on it hands that peer the host's clipboard, and pastes whatever the peer serves.
- Real servers' sockets are owned by root (Xorg) or by the user (Xwayland, Xvfb).

**Confirming test:** a unit test that binds `X<n>` in a temporary directory, `chown`s it to another uid (or checks a
mocked `stat`), and asserts that `x_try` doesn't connect.

**Fix direction:** `statat` the socket and require `st_uid` to be 0 or the user's.

## 7. X11 serve: a failed host transfer is answered as an empty or partial success (low)

**Where:** `agent/src/x11.rs:1448`–`:1451` (`Serving::Collect if s.eof`); INCR ends at `:1459`–`:1464`.

**Defect:**
- The session closes a serve's pipe without bytes when the host fails or refuses the paste (`host_send`'s early
  return, the page's `DATA_FAIL`, a cap). Its EOF is taken as the end of the data.
- The requestor's property gets an empty value of the type, and a SelectionNotify *with* the property. A failure under
  INCR likewise ends with an empty chunk.
- Guest programs paste an empty string, or a truncated one, as a success. ICCCM's refusal (property None) was
  available while collecting.
- Wayland can't tell either case apart; X can.

**Confirming test** (`x11_test.rs`):
1. Page OFFER of text, lazy, unknown to the cache.
2. Run `xclip -o -sel clip`.
3. Answer the REQUEST with `DATA_FAIL`.
4. Assert that xclip fails ("target … not available"). Today it prints nothing and succeeds.

## 8. X11 serve: two INCR serves to one requestor window turn off each other's PropertyNotify (low)

**Where:** `agent/src/x11.rs:1463` (`select_property_changes(requestor, false)` when one serve ends) and `:1411`.

**Defect:**
- The event mask is per window. A requestor that runs two INCR transfers on one window (two properties: a MULTIPLE-like
  pattern, or two pastes in quick succession) loses PropertyNotify for the second when the first ends.
- The second serve then waits in `Serving::Waiting` until `MAX_SERVES` evicts it, and the requestor hangs until its own
  timeout.

**Confirming test:**
1. A raw requestor converts CLIPBOARD to `UTF8_STRING` into properties A and B on one window, with a 1 MiB host text.
2. Delete A's chunks to the end.
3. Then delete B's INCR property and expect B's first chunk: none comes.

**Fix direction:** turn the mask off only when no other serve has that requestor.

## 9. Blocking `connect()` in the session child (low)

**Where:** `agent/src/session.rs:581`–`:589` (Wayland) and `agent/src/x11.rs:662`–`:668` (X11). The sockets are made
blocking and set nonblocking only after `connect`.

**Defect:**
- A Unix stream `connect` blocks while the listener's backlog is full.
- A compositor or X server that is stopped (SIGSTOP, a debugger) or wedged, with its backlog full, therefore blocks the
  child's one thread for good. The parent's frames, PAUSE and the other display all stop with it.
- The parent then stops the child at `CHILD_STUCK`, and a new child for the same session blocks the same way.

**Confirming test:** a listener with `listen(fd, 0)` that never accepts, its backlog filled by another connect, as
`wayland-1` in the test runtime directory. Assert the child still answers a page REQUEST with `DATA_FAIL`.

**Fix direction:** `SOCK_NONBLOCK` at `socket_with`, treating `EINPROGRESS` or `EAGAIN` as refused or retried.

## 10. TYPE pacing can't see a canonical-mode line (low)

**Where:** `agent/src/console.rs:78`–`:82` (`unread` is `FIONREAD`) and `:190`.

**Defect:**
- In `ICANON` mode, `TIOCINQ` counts only completed lines (`inq_canon`). For a reader in canonical mode (a login
  prompt, `cat`, `read`), a pasted line longer than what N_TTY buffers shows `unread` = 0.
- The Typist keeps typing, and n_tty drops the overflow silently.
- `TYPED DONE` is reported, so the menu says nothing.

**Confirming test:** in the guest, run `cat > /tmp/x` on a VT, type a single 6 KiB line through TYPE, then compare
`wc -c /tmp/x` with the input; the status is `DONE`. Natively, the same check runs with a pty in canonical mode
standing in for `Vt`.

**Fix direction:** in canonical mode, also count the bytes typed since the last line end against the 4 KiB.

## 11. Page: concurrent `paste()` calls can land out of order (low)

**Where:** `web/app/clipboard.ts:549`–`:569`. The serial and `offered` are assigned only after
`await image.arrayBuffer()` and `await imageHash`.

**Defect:**
- A focus sync that found an image is still hashing it when a paste chord's text-only `paste()` starts. The chord's
  `paste()` runs to its offer first.
- The sync's offer then follows with a newer serial, so the guest's clipboard ends with the older read. The ACK the
  chord waited for is also superseded.
- Usually both reads are the same clipboard, so the effect shows only when they differ (a change in between).

**Confirming test** (fake host): `host.clipboard.read` resolves with an image whose `arrayBuffer` resolves late. Call
`focused()`, then `pasted('new text')`, resolve the image, and assert the last OFFER is `new text`'s.

---

## Checked and found fine

- **Framing:**
  - The Rust and TS twins agree on lengths, `MAX_PAYLOAD`, `encode_with` bounds, the offer, request, data, ack and more
    layouts, and the HELLO nonce and SYNC.
  - The page reader keeps a partial marker across pushes.
  - Request ids and serials live in separate namespaces per direction (DATA from the page is always an answer to the
    agent's REQUEST, and the reverse), so they can't collide.
- **virtio-console multiport:**
  - The queue numbering (port 0: 0/1, control: 2/3, port 1: 4/5) and the config layout (`max_nr_ports` at offset 4)
    are right.
  - So are the DEVICE_READY → PORT_ADD, PORT_READY → PORT_NAME + PORT_OPEN order and the guest's PORT_OPEN handling.
  - Pending is cleared on close. Save and restore of the ports' state and the control queue work, with buffers
    reposted by the core, and the page's whole-frame posts keep the restored stream consistent with the agent's reader.
  - `WINDOW` (256 KiB) stays below `MAX_PENDING` (1 MiB), even with a restored backlog.
- **Root process:**
  - Single-threaded, so `fork` is safe.
  - The child closes the port, inotify, mountinfo and console fds, and runs setgroups, setresgid, setresuid in that
    order. It sets PDEATHSIG after the id change and checks the parent is still alive.
  - The uid change clears capabilities and makes the child non-dumpable. Only clipboard frames are forwarded from the
    child, through a bounded reader. `CHILD_STUCK` covers a stopped child.
  - Stop and gone both reap. The generation-based id bases work, and SESSION is sent after the old child's frames.
- **logind:** IN_MOVED_TO/IN_DELETE match logind's rename-into-place. The CLASS and STATE filters, `valid_id`, the
  mountinfo POLLPRI (re-armed by `poll` itself), the `ready()` owner and device rule, and the watches re-added on
  IN_IGNORED are all right.
- **Wayland:**
  - The header, string and padding format is right, and fds go with or before their message (the `MAX_FDS` split).
  - New ids are strictly sequential and never reused, as libwayland-server's `wl_map_reserve_new` requires.
  - The opcodes of ext and zwlr data-control match their XML. `finished` destroys the device, server-side offers are
    destroyed without `delete_id`, and `DeadSource` takes a late `send`'s fd.
  - Primary-selection offers are destroyed. The selection for our own source is dropped (wlroots sends `cancelled`
    before the new selection).
  - The retry arming gives up on a dead socket (and the test shows no wakeups).
- **X11:**
  - The request encodings (CreateWindow InputOnly, ChangeProperty, GetProperty with delete, ConvertSelection,
    SendEvent length 11, the XFixes QueryVersion and SelectSelectionInput) are right.
  - So are the XFixes event offsets (owner at 8, selection at 12, selection time at 20, subtypes 1 and 2 meaning no
    owner) and the reply matching by sequence number with wrap.
  - INCR both ways follows ICCCM (PropertyChange selected before SelectionNotify, deletes delete the last chunk, an
    empty value ends it), and `threshold` stays under the maximum request.
  - Sequence and SelectionClear ordering against XFixes is right, and so is the `Held` check.
- **Session child:** credit and MORE flow control both ways, the caps counted as bytes cross, the 64 KiB text cache
  keyed by serial, and the echo hash cleared on emptying, an image, or a newer offer. PAUSE clears our selection and
  ends transfers (DATA FAIL, MORE 0). No busy-poll paths were found: every polled fd is consumed or drops its interest.
- **Unit:**
  - The capability set is enough (TIOCSTI under CAP_SYS_ADMIN; `/dev/tty0`, the port and fw_cfg's `raw` are root-owned,
    so no DAC override is needed). The `TemporaryFileSystem` mount is `exec`.
  - Connecting to a socket through the read-only bind of `/tmp/.X11-unix` works: the read-only-mount write check
    doesn't apply to sockets.
  - `RestrictAddressFamilies=AF_UNIX` with `PrivateNetwork` is fine for path sockets. `Restart=on-failure` and the start
    limit are reachable as documented.
- **Page:**
  - The chord hold releases its queued keys in order and drops them at a blur (`releaseAll` releases the modifiers
    held). `ACK_WAIT` and `PASTE_WAIT` are bounded.
  - Pending is kept only for the newest offer. The shape, slots and restore plan include `agent`. The `display` port's
    PNG handler is either the framebuffer's or virtio-gpu's, never both.
- **Build:** the toolchain pin is checked against `AGENT_TOOLCHAIN`. The `--inputs` key includes podman versus host,
  `rm -rf` of the output clears a stale `HOST-BUILD`, `dist` refuses a host build, and Vite keeps the extensionless
  asset name.
