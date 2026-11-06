# Review: clipboard sharing (CLIP steps 1–3)

A static review of the last three commits (`ade4652b`, `e95b11ac`, `439222d4`): the agent (`agent/`), its unit and
delivery, the device, the link, the page's clipboard and the paste chord's hold. I ran no CI and booted no guest. The
findings are ranked with the most severe first. Each gives the place, the defect, what triggers it, and a test that
would confirm it (the test should fail first).

## Findings

### 1. The paste chord sends the held key without its modifiers (the guest gets a plain `v`)

`web/input.ts:189-214`. The hold is keyed by the held key's `code` only. While V is held (waiting for the browser's
`paste` and then the agent's ACK, up to `PASTE_WAIT` + `ACK_WAIT` = 600 ms), every other key event takes the normal
path at once. So Ctrl's key up reaches the guest **before** the held V's key down. `go()` then presses V down and up
with Ctrl already released, and the guest sees `v`, not Ctrl+V. Any other key typed during the hold is also delivered
ahead of the V (the keys arrive out of order).

- **Trigger:** any paste chord whose text differs from what the guest has (so the page waits for the ACK), when the
  user lets go of Ctrl before the ACK comes back. Playwright's `keyboard.press('Control+V')` does exactly this, and
  so do quick human chords (Ctrl is held for about 100–200 ms; the ACK makes a round trip through the worker, the
  device, the parent, the child and the compositor under the JIT).
- **Why the tests pass:** `tests/page-clipboard.test.ts` `pasteChord` then checks only the guest's clipboard
  (`wl-paste`). It never checks what the key did in the guest, so it can't catch this.
- **Confirming test:** in the sway test, focus a client that logs keys (`wev`, or `foot` running `cat -v`), then do
  `pasteChord` with new text. Assert that the client got Ctrl+V (or that the pasted text appeared in it), not a `v`.
  A cheaper version is a unit test of `attachInput` with a fake `hold` promise: down Ctrl, down V, up V, up Ctrl,
  resolve, then assert the order of the keyboard port's events (Ctrl's release must come after V's).
- **Fix direction:** while a key is held, queue every later key event behind it, or at least the releases of the
  modifiers that were down at the chord.

### 2. Echo suppression's hashes are never cleared by traffic the other way: wrong or lost clipboard contents

Both sides remember a hash of "the last thing it received", but neither clears it when the clipboard moves on in the
other direction.

- **The page,** `web/app/clipboard.ts:143-152` (`paste`). This sets `toGuest` but leaves `fromGuest` alone. Sequence:
  1. The guest copies X, so `fromGuest = h(X)`.
  2. The host copies Y and the user pastes it with the chord. Y is offered, so the guest now holds Y.
  3. The host copies X again and the user presses the chord. `h(X) === fromGuest`, so nothing is offered, and the
     guest pastes **Y**, which is the wrong content.
- **The agent,** `agent/src/session.rs:629-631` and `:931` set `last_host`, and nothing ever clears it.
  `clip::announce` (`agent/src/clip.rs:169-177`) checks it against every later guest selection. Sequence:
  1. The host gives A, so `last_host = h(A)`.
  2. The guest copies B, which is offered, and the host now has B.
  3. The guest copies A again (from its own document). `announce` returns `Nothing`, so the host keeps B and the
     guest's copy is lost.
- Also, `last_host` is set when any `In` transfer completes, including one for a host offer that a newer one already
  replaced (`:929-931`, which doesn't check `serial`).
- **Confirming tests:** for the page, a `ClipboardShare` unit test with a fake link:
  1. Receive an OFFER for "X" inline.
  2. Call `paste("Y")`, then ACK HELD.
  3. Call `paste("X")`.
  4. Assert that a second OFFER was sent.

  For the agent, run a `sway_test.rs` case with these steps:
  1. A page OFFER "A", then HELD.
  2. `wl-copy B`, then expect an OFFER of B.
  3. `wl-copy A`, then expect an OFFER of A. Today none comes.
- **Fix direction:** each side's "last received" hash means "the clipboard is still that". Clear it (or replace it)
  whenever that side sends or announces something else.

### 3. TYPE goes into a VT that a compositor owns, and the login shell runs it later

`agent/src/console.rs:273, 300-313`, called from `agent/src/main.rs:493-515`. TYPE always uses TIOCSTI on `/dev/tty0`,
the foreground VT. In the guests this track targets, the user logs in on tty1 and runs `sway` from the shell. The VT is
then in `KD_GRAPHICS`, but its line discipline still takes TIOCSTI input. Nobody reads it while sway runs; the shell is
waiting for its foreground job. Up to about 3.5 KiB is queued (the pacing waits a second at `HIGH` and then drops the
rest), with each newline turned into CR (Enter). **When sway exits, bash reads the queued lines and runs them as
commands.**

- **Trigger:** "Type the clipboard" (`AgentLink.type`) while the guest shows a graphical session. Nothing on either
  side checks for this: `AgentLink.type` checks only `paused` and `canType`, and `type_text` checks only UTF-8.
- **Confirming test:** in the Debian sway test, with sway started from the tty1 login shell:
  1. Call `__agent.type('touch /tmp/typed\n')`.
  2. Stop sway.
  3. Assert that `/tmp/typed` doesn't exist. Today it is created.
- **Fix direction:** the agent checks `KDGETMODE` on the foreground VT and refuses TYPE unless it is `KD_TEXT`. The
  refusal should say so (it needs a status frame, like ACK, so the page can tell the user).

### 4. A stale Wayland socket makes the session child wake five times a second, forever

`agent/src/session.rs:340-346` and `:478-480`. When a retry times out, `retries -= 1; connect()`. When the last retry
brings `retries` to 0, `connect()` is refused again, and because `retries == 0` it **re-arms `RETRIES`**. The 200 ms
poll timeout therefore never stops.

- **Trigger:** a socket file that refuses for good. The usual case is a compositor that crashed or was killed:
  libwayland unlinks the socket only in `wl_display_destroy`. The socket stays until a new compositor takes the same
  name, which may never happen if the user goes back to the console. This breaks the plan's "no timers, no periodic
  wakeups" (§3.3).
- **Confirming test:** in the sway test, `kill -9` sway and leave `wayland-1` in place. Over 20 s, assert that the
  child's `voluntary_ctxt_switches` (`/proc/<pid>/status`) doesn't move. Today it grows by about 100.
- **Fix direction:** arm the retries only when the socket set changed (an inotify event), not on each failed
  `connect`.

### 5. Stream resets never reach the session child: guest pastes hang, and stale transfers take a new page's credit

- **Where:** the parent reopens the port after `Stop::Broken` (`agent/src/main.rs:65-71`). The page also starts a new
  `ClipboardShare` (`web/app/main.ts:748`), whose `id` and `serial` start again at 1, for every start, including a
  snapshot restore. The child is told about neither: it keeps its `xfers` (`agent/src/session.rs:174-196`).
  - **An `Xfer::In`** (a guest program pasting the host's text) waits for DATA that the page will never send: the page
    cleared `answers` in `reset()`, or it is a new page. The guest program's pipe stays open with no end, so a
    synchronous reader like `wl-paste`, or an editor's paste, hangs until the user copies something else.
  - **An `Xfer::Out`** waits with credit 0 forever, which leaks its pipe. After a restore, the new page's request ids
    start at 1 again. `page_more` (`session.rs:838-851`) matches the **first** `Out` with that id, so a stale transfer
    from the snapshot's page takes the new request's MOREs. The page then gets that stale transfer's bytes as the
    answer to its new request: wrong content, or a hang for the real request.
- **Confirming tests:**
  - A `sway_test.rs` case:
    1. Start a paste of host text over 64 KiB (`wl-paste` as the reader).
    2. Drop the parent's stream the way a reopen does (close and recreate the parent socket's peer, or send a HELLO
       that should reset).
    3. Assert that `wl-paste` ends within a bound.
  - A page test: snapshot while a long guest-to-host transfer is in flight, restore, then copy in the guest. Assert
    that the host gets the new text.
- **Fix direction:** the page's HELLO, or the parent's reopen, should tell the child to fail or cancel every transfer
  (MORE 0, DATA FAIL, close the pipes).

### 6. The page's echo hash outlives the guest's clipboard (agent restart, VT switch, sway restart)

`web/app/clipboard.ts:146` and `:169-175`. `reset()` (port open or close) clears transfers, but not `toGuest` or
`fromGuest`. The page is also never told when the session child changes. The guest's copy of the host's text lives
only in the child's data source, so it disappears when:

- the child is stopped and restarted (`agent/src/main.rs:168-187`: a VT switch to another session and back);
- the agent restarts;
- sway restarts.

After any of these, `toGuest` still equals the host's text, so a paste chord with the same host clipboard offers
nothing, and the guest pastes nothing (or its own older copy).

- **Confirming test:** in the sway test:
  1. `pasteChord("A")`, then `guestHasText(A)`.
  2. Restart sway (or `systemctl restart webpc-agent`).
  3. `pasteChord("A")` again.
  4. Assert `guestHasText(A)`. Today the guest's clipboard is empty.
- **Fix direction:** clear both hashes in `reset()`. Have the agent tell the page when its session child (or that
  child's Wayland connection) changes, for example with a frame or an ACK-less status, so the page can clear them then
  too.

### 7. Snapshot restore: a paused agent stays paused, and the page's reader can start mid-frame with no way back

- **The pause** (`web/app/agent-link.ts:112-115`). At each opening the link sends PAUSE if it is paused, but never
  RESUME. The agent's `paused` lives in guest memory (`Agent.paused`, which lasts across openings), while the link is
  new for every start, with `paused = false`. A snapshot taken while paused, once restored, keeps an agent that
  answers `ACK PAUSED` and ignores the guest's selections. The page never sends the RESUME that would clear it.
  - **Test:** a unit test of `AgentLink`. Open a new link and assert that it sends PAUSE or RESUME, explicitly, after
    HELLO.
- **Mid-frame** (`web/agent-frame.ts:408-414`, `web/app/agent-link.ts:84-87`). The agent writes a frame with several
  `write`s: `flush` loops, a 64 KiB DATA frame doesn't fit one virtio_console write, and the frame is several TX
  buffers. A snapshot can fall between those writes. The new page's `FrameReader` then begins in the middle of a
  frame, and either:
  - it goes `broken`, which nothing acts on (the link stays dead until the agent happens to reopen its end, which it
    doesn't, since its own reader is fine); or
  - it reads a plausible length and silently swallows the frames after it, so even HELLO's answer may be lost and
    `active` stays false for the run.
  - **Test:** feed a new `AgentLink`, after `open`, the second half of a DATA frame and then a HELLO. Assert that the
    link gets the HELLO (today: `broken`, or the HELLO is swallowed).
  - **Fix direction:** on restore, have the device cycle the host's end (PORT_OPEN 0, then 1) and have the agent
    treat a reconnection of the host as a new stream. Or have the page, when its reader breaks, ask the agent to
    reopen.

### 8. The unit restarts forever, and each restart costs about 1.3 s of guest CPU (fw_cfg read)

`web/app/guest-agent.ts:67-72`. `Restart=on-failure` with `RestartSec=5s` never reaches systemd's default start limit
(5 starts in 10 s), because each start comes more than 5 s after the last. Any persistent failure becomes an endless
loop: `udevadm wait` timing out and `open` failing, or `read` returning 0 (`main.rs:380`). Each pass runs
`gzip -dc` over the fw_cfg file, about 1.3 s of byte-by-byte MMIO exits (plan §3.1), so roughly 20 % of a vCPU,
forever.

- **Confirming test:** boot with the setting on and a port name the agent doesn't open (or `systemctl mask` the port's
  udev rule). Over 60 s, assert that `systemctl show -p NRestarts webpc-agent` stays bounded and the guest's CPU stays
  idle.
- **Fix direction:** `StartLimitIntervalSec=` and `StartLimitBurst=` sized to the 5 s delay. Copy the binary in
  `ExecStartPre`, so a restart doesn't read fw_cfg again (the tmpfs lasts only while the unit runs, so this needs a
  directory that outlives a restart, or `RestartMode=direct`).

### 9. A late ACK is ignored, and the page goes on believing the guest holds the text

`web/app/clipboard.ts:153-166`. After `ACK_WAIT`, the waiter is removed and `toGuest` stays `h`. A refusal that comes
later (`NO_SESSION`, because the child hasn't finished its first round trip; `TOO_LARGE`; `NO_TYPE`) is dropped by the
`acks.get(...)` miss, so the same text is never offered again. A HELD that doesn't come at all (the source cancelled
before the sync's callback: `session.rs:1062-1066`) leaves the same state.

- **Test:** a `ClipboardShare` unit test with fake timers:
  1. Call `paste("A")`.
  2. Advance the timers 301 ms.
  3. Deliver ACK `NO_SESSION`.
  4. Call `paste("A")`.
  5. Assert a second OFFER.

### 10. The paste chord's hold costs 300 ms where the browser has no paste, and swallows a second press

`web/app/clipboard.ts:40-44` and `web/input.ts:190-196`.

- `isPasteChord` holds Ctrl+V on a Mac host and Meta+V on other hosts. Neither is a browser paste there, so no `paste`
  event comes, and the key waits the whole `PASTE_WAIT` every time. On a Mac, Ctrl+V is the guest's own paste key.
- A second V pressed while the first is held is `preventDefault`ed and dropped. Only one down and up pair goes out.
- **Test:** an `attachInput` unit test with `navigator.platform` set to `Mac`. Measure the delay from a Ctrl+V key
  down to the keyboard port's event (it should be immediate when no paste can come). Also check that two quick V
  presses give two downs.

### 11. The root process blocks inside TYPE

`agent/src/console.rs:318-333`. A TYPE frame is typed synchronously in the main loop, sleeping 1 ms at a time and
waiting up to 1 s for each stall, across all of a 64 KiB frame (and a page sends several). Meanwhile the parent
neither reads the port nor serves the child: clipboard transfers stall, and the child's queue can grow toward
`CHILD_STUCK`.

- **Test:** TYPE 256 KiB into `sleep 5` on the foreground VT, and meanwhile `wl-copy` in the session. Assert that the
  host gets the copy before the TYPE ends.

### 12. Session tracking misses events in two cases (overflow, and root's runtime directory)

- **Overflow,** `agent/src/main.rs:147-163`. `IN_Q_OVERFLOW` has no name and isn't `IGNORED`, so `changed` stays
  false and a session change is missed until something else wakes `track`. Treat an overflow as a change.
- **Root's session,** `agent/src/logind.rs:63-65`. "Ready" means the directory's owner is the session's uid. For uid 0
  that is also true of the bare mount point before `user-runtime-dir@0` mounts the tmpfs. A child started in that
  window watches the covered directory: the mount generates no inotify event on it, and `track` doesn't restart the
  child, because the key is the same. It never sees sway's socket.
  - **Test:** a unit test of `active()` against a directory that is root's but not a mount point, for uid 0.
  - **Fix direction:** compare `st_dev` with `/run/user`'s, which shows that it is a mount.

### 13. A killed child's transfers stay on the page

`web/app/clipboard.ts:78-80, 215-221`. When the parent stops a child (a VT switch, or `CHILD_STUCK`), the page's
`answers` entries for that child's requests never get MORE 0 or an end. They keep a reference to the offered bytes (up
to 16 MiB) until the port reopens, which is rare. `requests` for the dead child's offer waits until the next guest
OFFER. This follows from the page never hearing about a child change (finding 6).

### 14. The plan and the code disagree

- **Ports.** Plan §2 says port 0 is an unused console port and port 1 is `org.webpc.agent.0`. The device has one
  port, port 0, named `org.webpc.agent.0` (`web/agent-device.ts:17, 37-41`). docs/devices.md matches the code, so the
  plan is stale.
- **X11.** Plan §3.2's X11 route (`DISPLAY`, Xwayland's socket) can't work under the unit as written. `PrivateTmp=yes`
  hides `/tmp/.X11-unix`, and `PrivateNetwork=yes` hides the abstract `@/tmp/.X11-unix/X<n>` sockets, which are scoped
  to the network namespace (`web/app/guest-agent.ts:79-80`). The next step needs a different sandbox for that.
- **`splice`.** Plan §3.3's "`splice` where both ends allow it" isn't used. This is harmless, but the plan reads as
  built.

## Checked and found fine

- **Wayland's wire format** (`wire.rs`):
  - headers and sizes, string padding and NUL checks, splitting on a bad size;
  - descriptors sent with or before their message's bytes, with the more-than-28 split;
  - `CMSG_CLOEXEC`; the receive buffer, sized for libwayland's 28 descriptors;
  - every opcode of `wl_display`, `wl_registry`, `wl_callback`, the ext and zwlr managers, the device, the source and
    the offer, against the XML.
- **Data-control's semantics:**
  - our own selection's echo is dropped;
  - `cancelled` comes before the new `selection` (wlroots destroys the old source first);
  - `set_selection(null)` on pause;
  - a destroyed source is kept until `delete_id`, so a late `send`'s descriptor is closed;
  - primary-selection offers are destroyed;
  - zwlr bound at v1 sends none.
- **Probe:** the write end is closed after `sendmsg`, so EOF reaches the probe; the read is bounded at 4 KiB + 1.
- **Privilege drop:**
  - `setgroups([])`, then `setresgid`, then `setresuid`, in that order, in a single-threaded child;
  - `PR_SET_PDEATHSIG` set after the uid change (which clears it), with the `getppid` race check;
  - the parent's descriptors closed in the child: the port, the other end of the socketpair, inotify, mountinfo;
  - capabilities cleared by the uid change (no keep-caps);
  - the child becomes non-dumpable through the credential change, so the user can't ptrace it or read the parent's
    leftover heap through `/proc/<pid>/mem`;
  - SIGPIPE is ignored (Rust's runtime), so a reader that closes early gives EPIPE and MORE 0.
- **The parent and child loops:**
  - everything between them is nonblocking, and `CHILD_STUCK` bounds the child's queue;
  - stopping a child is close, then SIGKILL (the unit keeps `CAP_KILL`), then a reap;
  - `/proc/self/mountinfo` POLLPRI is one-shot per change, so there is no busy loop;
  - the serial and id bases per child generation (`<< 24`).
- **The virtio-console multiport handshake** (DEVICE_READY, PORT_ADD, PORT_READY, PORT_NAME, PORT_OPEN):
  - queue numbering for `max_nr_ports` 1;
  - pending bytes dropped while the guest has the port closed;
  - `reset` and `save`/`restore` of pending bytes and control messages;
  - `MAX_PENDING` can't be reached under the link's `WINDOW`.
- **Frame codecs:** Rust and TypeScript agree (HELLO, OFFER, REQUEST, DATA, ACK, MORE), and both readers reject zero
  or oversized lengths. `typePayloads` doesn't cut inside a UTF-8 character or a CRLF, and `for_tty` carries a CR
  across frames.
- **Credit flow** both ways: `CREDIT` 4, then one MORE per frame written whole; MORE 0 on a newer offer and on the cap.
- **Host build:** `images/build.sh agent`'s fallback marker is removed by a Podman rebuild (`rm -rf "$dst"`), the
  inputs key includes the builder, and `npm run dist` refuses the host build.
