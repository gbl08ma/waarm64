# Clipboard sharing (CLIP): handover

The track's brief is [docs/plans/clipboard.md](docs/plans/clipboard.md), with the user's choices of 2026-11-05 in its
§7 (no separate kickoff: the plan was written with the user and holds them). Its §6 lists the steps; each is a loop.

## Where it stands

**Steps 1–3 done** (2026-11-05, 2026-11-06): the channel (`web/agent-device.ts`, docs/devices.md "agent"), the agent
on the console (`agent/`, `images/build.sh agent`, `web/app/guest-agent.ts`), and **Wayland** (docs/devices.md "The
guest's agent"): the root process follows seat0's active session through logind's files and the mount table, forks a
session child that drops to the user and runs our hand-written data-control client (`agent/src/session.rs`,
`wire.rs`; ext, else wlr); OFFER/REQUEST/DATA/ACK/MORE in both `frame` modules (capability `TEXT`); the page's side
`web/app/clipboard.ts` (`ClipboardShare`, `window.__clipboard`): the guest's text written with `writeText` while
focused (else `pending`), the paste chord held by `web/input.ts` (`hooks.hold`) for the browser's paste event and the
agent's ACK. The test image `images/debian-sway/build.sh` (a tty autologin running headless sway) and
`tests/page-clipboard.test.ts` (`scripts/ci-debian.sh --platform`, ~2 min); natively `agent/src/sway_test.rs` against
the dev VM's sway 1.12 (ext data-control; wl-clipboard installed for it). No UI yet.

## Next: step 4 (the host's three ways and the toolbar)

Sync on focus with `clipboard-read` (and when it asks), the toolbar button and its states, the Machines page's switch,
the placeholder rules (§4.3), `pending` written on the next focus/key (§4.2; `ClipboardShare.pending` holds it now),
the measurements of §4.1 and §4.3 (Firefox in the dev VM, the Mac by the user). `ClipboardShare` is the module to
extend; `PAGE_CAPS` already says `TEXT`.

## Open questions and left for the user

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
