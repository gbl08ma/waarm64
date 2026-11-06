# Clipboard sharing (CLIP): handover

The track's brief is [docs/plans/clipboard.md](docs/plans/clipboard.md), with the user's choices of 2026-11-05 in its
§7 (no separate kickoff: the plan was written with the user and holds them). Its §6 lists the steps; each is a loop.

## Where it stands

**Steps 1–4 done** (2026-11-05, 2026-11-06): the channel (`web/agent-device.ts`, docs/devices.md "agent"), the agent
on the console (`agent/`, `images/build.sh agent`, `web/app/guest-agent.ts`), **Wayland** (docs/devices.md "The
guest's agent": logind tracking, a session child with a hand-written data-control client, text both ways, the paste
chord), and **the host's side** (step 4; docs/frontend.md "The toolbar", Clipboard; plan §4.1–§4.3, §5):
`web/app/clipboard.ts`'s `ClipboardShare` syncs with Chromium's `clipboard-read` (on focus, on `clipboardchange`, at
HELLO, when it becomes granted), keeps the guest's newest copy pending under §4.2's rules, applies §4.3's placeholder
rules, pauses for the run; `web/app/ClipboardMenu.svelte` is the toolbar's button and menu; the Machines page's
**Share the clipboard with the guest** switch (`MachineRecord.clipboard`) asks for the permission when ticked; the
link says PAUSE or RESUME at every opening (a restored agent isn't left paused). Tests: `tests/agent.test.ts`
(Node), `tests/page-clipboard-ui.test.ts` (Chromium on Buildroot, the shell playing the agent; in `npm test`),
`tests/page-clipboard.test.ts` and `tests/page-agent.test.ts` (Debian). Measured in headless Chromium 155 and
Firefox 157 (plan §4.1).

**The out-of-context review of steps 1–3** (`review/clip`, `REVIEW-CLIP.md` there): **all fixed**, none to the
backlog. The page's (1, 2's page half, 5's page half, 6, 7, 9, 10, 13) brought SYNC and SESSION; the agent's: 2 (the
host's hash forgotten once the guest's clipboard holds anything else, and not set by a superseded offer's transfer),
3 (TYPE only while the foreground VT is `KD_TEXT`; the new TYPED frame says what became of a paste, the clipboard
menu says why it wasn't typed), 4 (a refusing socket's retries armed only when a socket comes), 5 (the page's HELLO
reaches the child, whose transfers end), 8 (the unit's start limit, 5 in 10 min), 11 (TYPE queued and typed in bursts
between the loop's work: `console::Typist`), 12 (an inotify overflow is a change; root's runtime directory counts as
mounted on another device than `/run/user`), 14 (the plan's ports, X11 under the sandbox, `splice`, the two bounded
wakeups). The root loop has native tests now (`agent/src/serve_test.rs`: a socketpair for the port). Not done for 8:
keeping the binary across restarts (each still reads fw_cfg: bounded by the limit).

**Step 5's images done** (2026-11-06; plan §4.4 "Built", devices.md "The guest's agent", frontend.md "The toolbar"):
`CAP.IMAGE` both sides; the agent offers a guest program's image (PNG first, else a type the page converts) after its
text, streamed on request, never kept; takes the page's `image/png` within the 64 MiB cap (ACK `TOO_LARGE` past it);
the page writes the guest's image as one `ClipboardItem` of promises (converted to PNG in `web/app/png-worker.ts`),
reads it back once for the echo hash, offers the host's PNG from sync, Send and the paste chord's `File`; **Copy the
screen** in the menu (3D: the GPU worker's `grab`; 2D: the display port's `png`). The sway image has `grim` now
(rebuilt). Tests: `agent/src/sway_test.rs` (images both ways, the cap), `tests/agent.test.ts` (four image cases),
`tests/page-clipboard-ui.test.ts` (Copy the screen on Buildroot's framebuffer, the PNG worker on a BMP, a JPEG, RGBA),
`tests/page-clipboard.test.ts` (grim's PNG and a JPEG to the host, Copy the screen and a 1.5 MB PNG to the guest and
back, the cap). Measured: a 1.58 MB PNG from the host to wl-paste in 1.9–2.0 s (~0.8 MB/s, the channel's rate under
the credit); planted bugs: docs/testing.md's step-5 row.

**Step 5's X11 and `text/html` done** (2026-11-06; plan §3.2 "Built (step 5)", devices.md "The guest's agent" X11,
frontend.md "The toolbar"): `agent/src/x11.rs`, a hand-written X11 client the session child uses where Wayland has no
data-control (no compositor, or one without either manager): the display from the session file's `DISPLAY=` or the
user's processes, the cookie from `-auth`/`XAUTHORITY`/`~/.Xauthority`, XFixes on CLIPBOARD, conversions and our
source as pipes (so the rest of session.rs is shared), INCR both ways, a window per conversion (xclip's INCR is per
requestor window). The unit binds `/tmp/.X11-unix` into its private /tmp read-only. HTML both ways on Wayland and X11
(the page: `text/html` beside the text or image, one `ClipboardItem`, not in the hashes). The setting's note has the
X11 sentence. The test image (images/debian-sway) gained xvfb, xauth, xclip and an X login behind `/tmp/x11`. Tests:
`agent/src/x11_test.rs` (Xvfb + xclip natively), the wire format's unit tests in x11.rs, `sway_test.rs` (HTML),
`tests/agent.test.ts` (HTML), `tests/page-clipboard-x11.test.ts` (Debian, `ci-debian.sh --platform`), which found
that Debian's xclip 0.13 drops requests during an INCR (conversions now wait while the owner is busy). Measured: idle
with X 0 ticks/0 switches, VmRSS 604/704 KiB; `systemd-analyze security` 3.8 (was 3.7). Binary 445,128 bytes (+37
KiB for X11 and HTML). Planted bugs: docs/testing.md's X11 row.

**The final out-of-context review** (`review/clip-final`, `REVIEW-CLIP-FINAL.md` there; 2026-11-06): **all eleven
fixed**, none to the backlog (docs/testing.md's "final review" row has the tests and planted bugs): 1 X11 conversions
whose owner doesn't answer end after 10 s (`OWNER_WAIT`; a late answer told by its target); 2 the page's requests
stop after 30 s without DATA (`REQUEST_WAIT`), so a guest image never served no longer holds the focus syncs;
3 an empty TYPE ends a paste: a dropped frame drops the rest of its paste (a prefix, `DROPPED` at the end), and the
typed bytes leave the queue; 4 the page's HELLO drops the host's offer unless cached text, and offers the guest's
selection again; 5 TARGETS keeps the known atoms however long the list; 6 the X socket must be root's or the user's;
7 a failed host transfer is refused to an X requestor (under INCR it still ends with what came); 8 the requestor's
PropertyNotify stays on while another INCR to it goes on; 9 nonblocking connects; 10 canonical readers' lines count
in TYPE's pacing; 11 an older offer isn't sent after a newer one began. The agent's rustix gained `termios` (the
pre-approved dependency's feature, for `tcgetattr`).

## Next: the track's end

Every step and both reviews are done. The track's end (plan §6 "When it ends"): `docs/clipboard.md` from the plan and
devices.md, PLAN.md §3's row, this handover deleted. Plan §6 step 6 stays optional (spice-vdagent's port, GNOME
through the portal, agent jobs: each needs the user's OK). The checks by hand below stay the user's.

## Open questions and left for the user

- **The Mac, by hand (plan §4.3; not automatable).** On `macmini.lan`, the user's Chrome (macOS 15.4 or later), with
  a stored machine that has **Share the clipboard with the guest** on (the desktop guest, or Debian with sway):
  1. Start it; in the toolbar's clipboard menu click **Allow seeing the clipboard…** and allow it in Chrome's prompt.
     The menu should then say the web app may see the clipboard, and the button lose its mark.
  2. In the page's console (DevTools undocked, so the page itself takes the focus back), log what a focus read gets:
     `addEventListener('focus', async () => console.log(await navigator.clipboard.readText().catch((e) => e.name), (await navigator.clipboard.read().catch(() => [])).map((i) => i.types)))`.
     Copy text in TextEdit, click back into the page's screen. Does macOS show its "Paste from Other Apps" alert
     (Privacy & Security)? What did the log get: the text, `""` with `text/plain` among the types, or an error? Did
     the guest's clipboard get the text (paste it in the guest from its own menu)?
  3. Repeat 2 four times: if the reads come back empty while the types say text, the menu shows the note that the
     focus reads stopped (after 3 in a row; `__clipboard.stopped` in the console) and the button has its mark;
     Ctrl+V on the screen still pastes.
  4. Copy text in the guest (foot, Firefox): it should be on the Mac's clipboard (Cmd+V in TextEdit), also after
     copying it while Chrome is in the background and coming back (the pending text, written on the focus).
  5. With a password manager's copy (concealed type): what does the guest get? (plan §4.3 "Concealed content").
  Write the answers into plan §4.3 (dated) and adjust `EMPTY_RUN` or the rules if they differ.

- **On the Arch desktop, by hand** (plan §6 step 3): foot and Firefox in the guest and the host, both ways; also the
  step-2 checks there (`qemu_fw_cfg` from Arch's kernel, `systemctl status webpc-agent`). Arch's sway has the ext
  protocol, which only the native test has exercised.
- **Images not measured outside headless Chromium:** Firefox's and Safari's image writes (activation, the promise
  form), the Mac's pasteboard with images, and the Arch desktop (Firefox's and foot's image copies, GIMP) are by hand.
  Copy the screen is tested on Buildroot's framebuffer and on the page test's default display (3D where WebGL2 is,
  `WEBPC_PAGE_QUERY=gpu=2d` for virtio-gpu 2D's scanout path): which one ci-debian ran wasn't checked.
- **The binary's size**: 445,128 bytes now (333 KiB at step 2, 403,000 at step 3, 407,200 with images): `#![no_std]` on rustix's runtime is still the lever
  (plan §3.3), not done.
- **Not done from §3.3:** `splice` between the port and the pipes (the child reads and writes in 64 KiB chunks; the
  port's bytes cross the parent anyway); cancelling a page→guest answer that the guest's reader dropped is a MORE 0 the
  page honours, but the agent can't cancel what the page already sent (at most the credit, 4 chunks).
- **A paste cut by the page's HELLO** (a restore mid-paste) ends the guest program's pipe: it gets what had crossed,
  truncated, with no way to say "failed" through a pipe.
- **TYPE under a headless compositor** (the Debian sway test's: no DRM, so tty1 stays `KD_TEXT`) is typed into tty1's
  input like any typeahead; only a compositor on the VT (graphics mode) is refused.
- **X11 not measured outside Xvfb:** a display manager's session (`TYPE=x11`, its cookie written late: the 25
  retries cover 5 s), Xorg through startx, and Xwayland under a compositor without data-control are by hand (natively,
  a fake compositor without data-control gives way to Xvfb). PRIMARY isn't shared. `STRING` goes out as UTF-8.
- **Two compositors for one user** (two VTs with sway each): the child takes the first `wayland-<n>` that accepts; which
  socket belongs to the active session isn't known without reading the session's processes' environment.
- **sway restarts at boot, seen twice:** in two runs the first sway of the boot ended within seconds and getty logged
  the user in again (the agent followed, once its stop no longer hung). Not seen since the image's profile logs how sway
  ends (`/tmp/sway.log`, `== sway ended: N`): if it comes back, that line says why.

## Notes

- Linux's virtio_console drops what arrives for a port nobody holds open, and the device does the same on its side;
  the page learns the agent is there from the port's `open`, and the link resets its reader and queue at each opening.
- Port 0 needn't be a console: Linux makes it one only on CONSOLE_PORT, so the single port is id 0 and there are four
  queues. A second port (spice's, plan §3.4) would be id 1 at queues 4 and 5 (`portQueues`), with `max_nr_ports` 2.
- Debian 13 mounts /run `noexec`: the unit runs the agent from a `TemporaryFileSystem=` of its own.
- The serial tests' `run(cmd)` takes `<<N:…>>` in the terminal for the output: a command with `>>` in it matches its
  own echo while it is typed (page-agent's slow reader did, and its long paste raced the reader's start: the first line
  lost, deterministically with step 3's agent). Keep `>>` out of such commands (`tee -a`).
- The unit's root has only `CAP_SYS_ADMIN CAP_SETUID CAP_SETGID CAP_KILL`: no DAC override, so whatever it reads of a
  user's it must reach by `stat` or as the child. X11 reaches `/tmp/.X11-unix` through `BindReadOnlyPaths=`.
- Planted bugs (all caught): the agent's echo rule, the DATA credit, its own selection offered back, PAUSE leaving the
  host's text, the cache, the host's hash, a greeter's session taken, strings without their NUL (cargo test); the page's
  echo rule, its MOREs, its credit, Cmd+V (tests/agent.test.ts); a held key's preventDefault (the page test); the
  review's loop: the host's hash on a superseded transfer, a lazy offer keeping the old hash, the child ignoring HELLO
  (the paste hangs) or keeping its Out transfers, TYPE without the mode check, the page ignoring TYPED. The page test also found the
  first build's stop of a child hanging the agent (SIGKILL refused without CAP_KILL, the socket closed only after the
  wait): the stop closes the socket first now (the child ends by itself), so CAP_KILL is a backup for a stuck child.
