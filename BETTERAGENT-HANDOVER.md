# BETTERAGENT handover

The track's brief: BETTERAGENT-KICKOFF.md (the user's; approved and started 2026-11-13). State and next steps only.
Loops 1–10 done (jobs 1–7, the agent's gzip and its fw_cfg pieces, the mid-track review's fixes); the next loop is job 8.

## State

The agent's frames and capability bits now: DISPLAY 14 (bit 5), RENEW 15 / RENEWED 16 (bit 6), LEASE 17 / LEASED 18
(bit 7), DESKTOP 19 (bit 10), TRIM 20 / TRIMMED 21 (bit 11), KEYMAP 22 (bit 12), COPY 23 / COPIED 24 (bit 13); free from
25 and bit 14 (bit 3 reserved for text/html, 8 and 9 for session kinds). The binary is 179,672 bytes (`images/build.sh agent`; its hash in images/SHA256SUMS moves with each agent change, in the same commit).

- **Job 1, the screen's size:** the page sends the size it asks the guest's display for (DISPLAY, at each change and
  each agent HELLO). Wayland: `agent/src/outputs.rs` (wlr-output-management custom mode; sway, wlroots). X11 sessions:
  `agent/src/x11/randr.rs` (RandR by hand; never under a compositor: `session::x_jobs`). KDE on Wayland follows the
  display event by itself (the user's session). The root process keeps the page's HELLO and last DISPLAY for each new
  session child; the child's jobs (`session::Jobs`: clip, resize) are fixed at its start. devices.md "The screen's size".
- **Job 2, a template's identity:** a snapshot flagged `template: true` (`tools/snapshot-template.ts`; never set by the
  page) has the agent renew the kernel's entropy (and force the reseed), `/etc/machine-id`, systemd's random seed and
  the SSH host keys (ssh-keygen where it exists, then SIGHUP to sshd's listeners); not the hostname (the user's choice).
  devices.md "A template's identity".
- **Job 3, the network after a restore (loop 4):** after any restore the page waits for its network to settle with a
  card connected (`web/app/net-settled.ts`, fed by the page network's `onChange`), then asks the agent (LEASE:
  `agent/src/lease.rs`, busctl's RenewLink by ifindex for networkd, nmcli for NetworkManager), else flaps the connected
  cards (`Run.netLinks` → web/devices.ts `flap`, 7 s). The user's design. devices.md "The network after a restore".
- **Job 4, the desktop's state (loop 5; for the tests only, the user's decision):** the session child says DESKTOP
  (none, Wayland's once its compositor's globals are known, X11's once an X server took it); the root keeps it and says
  it to a page with `CAP.DESKTOP`, which every page says (so the child runs wherever seat0 has an active session). The
  page: `AgentLink.desktop`, `body[data-desktop]` (`tests/page-desktop.ts`), which the sway and X11 page tests wait on.
  Nothing the user sees changed. devices.md "The desktop's state".
- **Job 5, disk space handed back (loop 6):** the agent trims (`agent/src/trim.rs`: `sync`, then FITRIM itself on each
  `/dev/` filesystem of the mount table, no fstrim), then the page compacts the overlays in full (`Vm.compact` →
  `Devices.compact`; a change compacts only past half free). Asked from the Machines page's storage bar (Free unused
  disk space), at the storage-full notice, and before a disk's Export stops the machine (`web/app/areas/trim-actions.ts`).
  The user's choices (when, `fstrim -a`'s scope, the storage bar). devices.md "Disk space handed back".
- **Job 6, the keyboard layout in the running session (loop 7):** KEYMAP at each agent HELLO and when the setting is
  saved mid-run (`web/app/areas/keyboard-follow.ts`); the root applies only a layout the session hasn't (the boot's
  `/etc/environment`, then its last: `agent/src/keymap.rs`), the child through sway's IPC or `setxkbmap`, the root
  `loadkeys` (the unit got CAP_SYS_TTY_CONFIG). The boot's disk write stays. devices.md "The keyboard layout in the
  running session".
- **Job 7, copying from a text console (loop 8):** the clipboard menu's Copy the console's text (`#clipboard-console`,
  enabled with the agent's `CAP.COPY`, paused too) asks COPY; the root answers COPIED at once (`agent/src/screen.rs`:
  `/dev/tty0`'s KDGETMODE and TIOCGWINSZ, then `/dev/vcsu`, or `/dev/vcs` where the console isn't UTF-8); the page
  writes it as Copy the screen does (`areas/clipboard-actions.ts`). Read-only: nothing in the unit changed. The screen
  only, no scrollback. devices.md "A text console's text".
- **The agent shipped as the build's zopfli gzip (loop 9, the user's ask):** `waarm64-agent.gz` (105,912 bytes,
  `images/build.sh agent`, in SHA256SUMS), handed to fw_cfg as it is; vite.config.ts `plainGzip` and .htaccess drop the
  `Content-Encoding` servers put on a `.gz`; an ELF that arrives decoded is gzipped by the page as before. Cloudflare's
  headers on it: check at the next deploy. Loop 10: in fw_cfg as pieces of 4 KiB (`agent.000`…, `agentFiles`): Linux's
  sysfs read of one file re-reads up to each page's offset (quadratic: 414 ms), the pieces take 74 ms.
- **The mid-track review** (2026-11-13): five findings, fixed (each with its failing test first) or filed in the backlog.
- **Not run end to end** (backlog): a restore with a live connection (the network tests use `tests/browser/netguest.html`,
  no snapshots or agent); Xorg's modesetting on virtio-gpu; sshd on the Debian test image (it has none: the real
  ssh-keygen and sshd run in the native test); NetworkManager (a fake nmcli); the trim before an Export and at the
  storage-full notice (`TrimActions` with fakes; Debian runs only the storage bar's); the layout's X11 and console
  paths (no setxkbmap or kbd in Debian's images); the console's text from a non-UTF-8 console (`/dev/vcs`).

## Next

1. Job 8 (the smaller jobs: the guest's address and OS name in the status bar, a power-off and reboot through logind,
   a shared folder mounted when attached); ask the user what each does to the guest where the kickoff leaves it open.
   Job 6's decision (the user, 2026-11-13): the layout's disk write at
   boot stays, by today's non-agent path, so it applies where the agent doesn't run (and to the greeter); the agent
   applies it in the running session on top: sway (its IPC), X11 (setxkbmap where installed), the consoles (loadkeys),
   only when the page's layout differs from what the session has (the boot's `/etc/environment`, then the agent's last).
   GNOME and KDE later, with a test image each (the user, 2026-11-13): no shared live D-Bus path (localed's is the
   system default, read-only on Debian 13; GNOME's is the user's dconf `org.gnome.desktop.input-sources`, KDE's
   `kxkbrc` and its reload signal, both kept in the user's settings).
2. The track's end: an out-of-context review over the whole track, `ci.sh`, `ci-debian.sh --platform`, `ci-machines.sh`,
   `ci-net.sh`, `ci-graphics.sh`; then PLAN.md's row, the kickoff and this handover deleted.

## Found (worth not re-discovering)

- **The page's linter caps a file at 300 lines** (eslint `max-lines`, in `ci.sh`'s lint) and a function's complexity at
  15; `main.ts` (299) and `runner.ts` sit at the limit, `worker.ts` and `net-live.ts` near it (worker.ts's `onmessage`
  sends its asks to `worker-profile.ts`'s `asked` from `default`): put new logic in a module of its own. A `.svelte.ts`
  module can't be imported by the Node tests (runes): keep testable logic in plain `.ts` and its `$state` elsewhere
  (`current.canTrim`). Format with the project's config
  (`npm run format`, or tools/lint/node_modules/.bin/prettier --config tools/lint/prettier.config.ts), never a bare
  `npx prettier` (it rewrote a whole file at another width).
- **A port handed to a device must be listed in web/devices.ts's transfer list** (the `specs.flatMap` near line 178),
  or every machine with that device fails to start with a DataCloneError.
- **The agent's sandbox** (`RestrictAddressFamilies=AF_UNIX AF_VSOCK`) breaks tools that use netlink: networkctl (even
  with an index) and if_nametoindex; D-Bus tools (busctl, nmcli) work. Check a guest tool from inside the unit on Debian,
  not only natively.
- **A forked helper closes what it inherited** (`rt::close_inherited`, `close_range`): else it holds the page's
  connection (and, in the tests, other tests' sockets) for as long as it runs; one flaked `ci.sh` that way.
- **OpenSSH ≥ 9.8's listener loads host keys only at its start and SIGHUP**; `sshd -D` writes no pid file.
- **Xvfb can't grow its screen past its start size**: RandR tests run on Xorg's dummy driver (xf86-video-dummy and
  xrandr in the dev VM: docs/devenv.md).
- **sway checks a layout as it takes it** (it compiles the keymap at each `input … xkb_*` command): a variant only
  one layout has (`neo` German's, `intl` US's) reads the layout back without a keyboard; with no layout set, any
  variant passes.
- **Piped, swaymsg prints JSON** (`current_mode` there), not its human format.
- A quick look at the page's error: a Playwright script in `bench/results/local/` printing `#message`'s text (the
  tests' assertion only has the headline); delete it after (tsc checks that directory).
