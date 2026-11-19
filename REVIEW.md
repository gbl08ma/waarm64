# Review: the demo code since review/demo-page-3 (`git diff cbe02be1..main`)

A static review (no tests, builds or guests run) of: the caps a snapshot carries (web/gpu.ts `capsRead`), the desktop
templates made before any GL client (bench/demo/make-template.ts `startOnResume`), the serial console's size (CONSOLE:
agent/src/tty.rs, frame.rs, main.rs, web/agent-frame.ts, web/app/agent-link.ts, agent-actions.ts,
serial-terminal.ts, App.svelte), their docs and tests. Ranked most severe first. "Confirmed": traced end to end in
the code; "plausible": the mechanism is in the code, but a step depends on guest or browser behavior not verified here.

## Findings

### 1. The terminal goes back to 80×25 when the agent's connection ends, but the guest keeps the fitted size (confirmed)

- **Where:** web/app/areas/agent-actions.ts:106-109 (`onClose` → `follow(undefined)`), web/app/areas/serial-terminal.ts:81-91
  (`follow(undefined)` resizes to 80×25 and tells no one); agent/src/tty.rs (nothing resets the size); docs/devices.md
  "The serial console's size" ("The connection's end (a restart, the agent stopped) … put the terminal back at 80×25 …:
  what it shows is always what the guest was told").
- **Defect:** at a connection's end the page shrinks its terminal to 80×25, but the guest is not told. The tty's
  `winsize` lives in the kernel's `tty_struct` for as long as anything holds the tty open: the getty/login shell (and
  the agent's own held fd, or a hung-up one after a vhangup) keep it, so the guest stays at the last CONSOLE's size
  (e.g. 170×55). The docs say the opposite.
- **Trigger:** any `opened(false)` while the guest runs: the agent stopped (`rc-service`/`systemctl stop`), crashed and not
  yet restarted, upgraded, or the page's reset of a broken stream (agent-link.ts:467-471). Also at a restore: the new run
  starts at 80×25 (`end()` → `follow(undefined)`), while the restored guest's tty is at the size the snapshotting page
  told, until the restored agent's HELLO; if the agent never says HELLO again, for good. The Alpine demo's template is
  made in the build's 1400-wide window, so every visitor's restore starts in this state.
- **Consequence:** a shell's line editing, `less`, `vi`, `top` draw for 170×55 on an 80×25 terminal: wrapped and
  overwritten lines, until the next HELLO (or forever, for an agent that stays down).
- **Related (confirmed, low):** at the next HELLO, `agentHello` (agent-link.ts:437) sends the previous connection's
  `cells` before `onHello`'s `follow(tell)` sends the current size. With the terminal hidden (view "screen"), `follow`
  then tells 80×25 (what `onClose` left), so the guest goes S → S → 80×25 and back to S only once the terminal is
  shown: two needless SIGWINCH redraws, and a guest console downsized while nothing on the page changed.
- **Fix direction:** keep the last told size (stay unfitted at it) when the connection ends, and go back to 80×25 at a
  guest reset or a new boot (what the firmware/GRUB need), not at the agent's connection end; at a restore, start at
  the size the snapshot's guest has (or keep the terminal unfitted at it until HELLO).
- **Test (failing first):** tests/page-alpine-agent.test.ts after `consoleFollows`: stop the agent's OpenRC service
  in the guest, wait for `#terminal[data-fit]` to go, then `stty size` vs `#terminal`'s `data-size`: they differ
  (guest 170×55, page 80×25). Or in tests/page-console.test.ts with the stub: after `openPort(page, false)`, assert that
  the last CONSOLE said equals the terminal's size (it is the fitted one, the terminal 80×25).

### 2. A guest reset keeps the restored caps and `off3d`; a snapshot after it carries `off3d` without caps (confirmed)

- **Where:** web/gpu.ts:987-1000 (`reset()`: `capsRead = false` "a guest that starts again reads them again", but
  `this.capsets` and `this.off3d` kept), web/gpu.ts:1024 (`save()` writes `off3d` whatever `capsRead` is), 1087
  (`restore()`: `this.off3d = t.off3d` unconditionally).
- **Defect:** after a restore where this browser can't back the saved caps, `capsets` is the saved (unbacked) blob and
  `off3d` is set. A guest reboot runs `reset()`, which only clears `capsRead`: the fresh guest reads the stale unbacked
  caps again and every CTX_CREATE is still refused (ERR_UNSPEC). Then a snapshot taken after the reboot and before any
  GET_CAPSET carries `off3d` but no `caps`, and restoring it in a browser that backs everything leaves 3D off (the
  restore sets `off3d` from the file), contradicting graphics.md "The caps": "a snapshot of a guest that never did
  carries none, and its restore gives the guest this browser's".
- **Trigger:** restore a 3D machine (e.g. a visitor's own snapshot of a started desktop demo, which has read the caps)
  in a lesser browser → reboot the guest → (optionally) snapshot → restore anywhere.
- **Consequence:** 3D stays off across reboots and across restores in capable browsers, with no way back but a new
  machine; the reset's comment suggests the opposite.
- **Fix direction:** in `reset()`, rebuild `capsets` from `o.caps` (and the Venus capset) and clear `off3d`; and/or only
  save `off3d` with the caps it came from.
- **Test (failing first):** tests/virgl.test.ts: `make(capsA)` with GET_CAPSET, save, restore in `make(capsB)` (off3d:
  CTX_CREATE refused), `b.g.reset()`, CTX_CREATE → expect 0x1100 (now ERR_UNSPEC); and `save()` after the reset →
  restore in `make(capsA)` → CTX_CREATE expected OK (now refused).

### 3. The fit measures `#terminal`'s border box: one row too many at some heights (plausible)

- **Where:** web/app/App.svelte:222-234 (the fit rules: `#terminal[data-fit]` keeps its 1px border, padding moved to
  `.xterm`), web/app/theme/base.css:6-10 (`box-sizing: border-box` on everything), @xterm/addon-fit
  `proposeDimensions` (uses `getComputedStyle(parent).height`).
- **Defect:** with `box-sizing: border-box`, `getComputedStyle(#terminal).height` is the border-box height, 2px more
  than the content box `.xterm` (height 100%) gets. The addon computes `floor((H − 16) / cellH)` rows where only
  `H − 2 − 16` is there; when `(H − 16) mod cellH < 2` it proposes one row that doesn't fit.
- **Trigger:** about 2 in every cellH (~17 at 14px) window heights.
- **Consequence:** the last row is clipped by up to 2px, `.xterm` overflows `#terminal`, and `#terminal-view`
  (`overflow: auto`) shows a scrollbar (which then narrows the box and changes the columns); the guest is told a row the
  user can't fully see.
- **Test (failing first):** tests/page-console.test.ts with the stub's CONSOLE agent: step the viewport's height 1px at a
  time over 20px; at each, assert `#terminal-view`'s `scrollHeight === clientHeight` and `.xterm-screen`'s bottom ≤
  `#terminal`'s inner bottom.
- **Fix direction:** drop the border in fit mode (or move it onto `.xterm`), or measure a border-free wrapper.

### 4. The Alpine re-login check likely passes without the agent's held fd (plausible)

- **Where:** tests/page-alpine-agent.test.ts:209-215 ("A login that ends and starts again (the getty's respawn) finds the
  size still set: the agent keeps the tty open"); agent/src/tty.rs `held`.
- **Defect:** under busybox init, init's fds 0-2 are `/dev/console`, which shares ttyAMA0's `tty_struct` when ttyAMA0 is
  the last `console=`; init keeps them open, so the struct and its `winsize` survive a logout regardless of the agent's
  fd. The test can't fail if `self.held = Some(fd)` is removed. Where the hold does matter (systemd guests: PID 1 doesn't
  keep the console open, and agetty does a vhangup), there is no re-login check (tests/page-agent.test.ts only follows
  resizes). tty.rs's unit test can't show it either (the pty master holds the pair).
- **Test:** plant the bug (drop `self.held = Some(fd)`) and run the Alpine case: expected to stay green. A real check
  goes in tests/page-agent.test.ts (Debian): `consoleFollows`, then log out on the serial console, log in again, and
  compare `stty size` with `data-size`.

### 5. `start-desktop.sh` waits forever if the template's first run ends before RENEW (plausible)

- **Where:** bench/demo/make-template.ts `startOnResume` (the loop on `/etc/machine-id` or `GO`), web/app/main.ts:189-192
  (`renew()` only when `restored(template)`).
- **Defect:** the script's only ways on are the machine id changing (RENEW, sent only at a template's first restore) or
  the build's `GO`. RENEW is owed per link (per run): a first run that ends before the agent's HELLO is handled (Stop
  or Suspend in the first seconds, the tab closed with a suspend) leaves a machine whose later starts restore its own
  snapshot with `template = false`: no RENEW, the id never changes. The same for the template's snapshot opened as a
  plain snapshot file.
- **Consequence:** the screen stays on "Starting the desktop..." for good, with no hint, and the loop forks `cat` and
  `sleep` five times a second under emulation.
- **Test:** tests/page-demos-guest.test.ts variant: Start the desktop demo, stop it before the agent's HELLO
  (`window.__agent` without `renewed`), Start again; the window never comes. Fix direction: an end to the wait (a
  timeout, or the agent's HELLO itself as the signal, e.g. a file the agent writes at any page's HELLO).

### 6. A Venus (or v1) GET_CAPSET makes the device save the VIRGL2 caps the guest never read (plausible, low)

- **Where:** web/gpu.ts:446-453: `capsRead = true` for any capset id; `save()` writes `this.caps` (VIRGL2).
- **Consequence:** a guest that only ran a Vulkan program (Venus capset read, its context gone by the snapshot) carries
  the VIRGL2 blob, and its restore in a browser with fewer virgl formats turns 3D off though the guest never saw them.
- **Test:** tests/virgl.test.ts: GET_CAPSET for `CAPSET_VENUS` only, save → `caps` expected absent.

### 7. Docs and comments that disagree with the code (confirmed, low)

- docs/devices.md "The serial console's size": "what it shows is always what the guest was told" (finding 1).
- web/gpu.ts:262-266 and docs/remote-disks.md "Building the demos" point at graphics.md "Snapshots with 3D in use" for
  the caps rule; that section says nothing of caps: the text is in "The caps" (the `capsBacked` bullet).
- tests/page-demos-guest.test.ts header: a desktop's Start shows "its screen like the template's thumbnail (… sway's 3D
  state loaded)" and "~1 min for the desktop"; the template now has no sway and no 3D state (`resume.webp` is tty1's
  "Starting the desktop..."), and the case waits up to 240 s for the window.

## Checked and found fine

- CONSOLE's wire format: `encodeConsole` and `decode_console` agree (u16 LE columns, rows; zero rejected, clamped at
  1000); frame 33 and cap bit 19 are pinned on both sides (frame.rs test, tests/agent.test.ts).
- AgentLink: `console()` keeps the size for the next HELLO and sends only to an agent with `CAP.CONSOLE`; `agent` is
  cleared at each `opened`, so nothing is sent between a connection's end and the next HELLO; the stub test covers HELLO,
  change, reconnection and an agent without the cap.
- serial-terminal.ts: the settle timer is cleared at each `follow`; a timer firing after a new link uses the current
  `tell`; `#refit` gives up on a hidden box (`display: none` gives NaN, filtered); `follow(undefined)` drops `data-fit`
  before the box goes back to its content size; no ResizeObserver feedback loop (fit mode's box doesn't depend on its
  content; Both fixes 80 columns). The run's end → `follow(undefined)` and `begin` → `end()` order is right.
- agent/src/tty.rs: `O_NOCTTY | O_NONBLOCK` (no controlling tty taken, no wait for carrier on the PL011); the new fd is
  opened before the old one is dropped, so the tty's count never reaches zero between; a hung-up held fd still keeps the
  `tty_struct` (its release goes through `tty_release`); a failed open keeps the previous fd; TIOCSWINSZ signals the
  foreground group only on a change, so the page's duplicate CONSOLEs (at HELLO and after the settle) cost nothing.
- gpu.ts `capsRead`: GET_CAPSET_INFO at the kernel's probe doesn't set it (the VIRGL2 blob's length is fixed:
  `withVideo` keeps it, so the probe's cached `max_size` holds in another browser); an error reply doesn't set it; a
  restore of an older snapshot (always with caps) counts as read; a restored machine carries the caps on.
- make-template.ts: the build's `GO` is touched after the snapshot's download, so it isn't in the template; the user's
  script quotes (`$HOME` inside the double-quoted `swaymsg exec` is expanded by the script's shell, the recipe validator
  forbids quotes and `$` in `run`); the waiting check's `pgrep -u <user>` doesn't match root's own command line.
- page-demos-guest's dmesg check: `clear` runs before the output, so `(^|\s)0\s*DMESG-END` matches only a count of 0 at
  the top row; 3D off would show as `0x1200` errors and no window. `capsno` reaches the device through the GPU worker's
  `ready` caps, so a template carrying the build's caps would fail it.
