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

## Next: step 5 (images, then X11)

Plan §4.4 and §6 step 5: `image/png` both ways (the page's conversion to PNG in a worker, the read-back for echoes),
a screenshot each way in the Wayland test; "copy the screen" joins there (the screen's canvas is a worker's: it needs
a read-back, plan §4.4); then X11 (Xwayland, Xorg, INCR), then `text/html`. When images land, the setting's note
says "text or an image" again (`machines:MachinesPage.clipboard.note`).

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
- **The binary's size**: 403,000 bytes now (333 KiB at step 2): `#![no_std]` on rustix's runtime is still the lever
  (plan §3.3), not done.
- **Not done from §3.3:** `splice` between the port and the pipes (the child reads and writes in 64 KiB chunks; the
  port's bytes cross the parent anyway); cancelling a page→guest answer that the guest's reader dropped is a MORE 0 the
  page honours, but the agent can't cancel what the page already sent (at most the credit, 4 chunks).
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
  user's it must reach by `stat` or as the child. X11 (step 5) needs `/tmp/.X11-unix`, which `PrivateTmp=yes` hides.
- Planted bugs (all caught): the agent's echo rule, the DATA credit, its own selection offered back, PAUSE leaving the
  host's text, the cache, the host's hash, a greeter's session taken, strings without their NUL (cargo test); the page's
  echo rule, its MOREs, its credit, Cmd+V (tests/agent.test.ts); a held key's preventDefault (the page test). The page test also found the
  first build's stop of a child hanging the agent (SIGKILL refused without CAP_KILL, the socket closed only after the
  wait): the stop closes the socket first now (the child ends by itself), so CAP_KILL is a backup for a stuck child.
