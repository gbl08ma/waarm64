# BETTERAGENT handover

The track's brief: BETTERAGENT-KICKOFF.md (the user's; approved and started 2026-11-13). State and next steps only.
Loops 1–5 done (jobs 1–4 and the mid-track review's fixes); the next loop is job 5.

## State

The agent's frames and capability bits now: DISPLAY 14 (bit 5), RENEW 15 / RENEWED 16 (bit 6), LEASE 17 / LEASED 18
(bit 7), DESKTOP 19 (bit 10); free from 20 and bit 11 (bit 3 reserved for text/html, 8 and 9 for session kinds). The
binary is 165,904 bytes (`images/build.sh agent`; its hash in images/SHA256SUMS moves with each agent change, in the same commit).

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
- **The mid-track review** (2026-11-13): five findings, fixed (each with its failing test first) or filed in the backlog.
- **Not run end to end** (backlog): a restore with a live connection (the network tests use `tests/browser/netguest.html`,
  no snapshots or agent); Xorg's modesetting on virtio-gpu; sshd on the Debian test image (it has none: the real
  ssh-keygen and sshd run in the native test); NetworkManager (a fake nmcli).

## Next

1. Job 5 (fstrim on demand), then 6, 7, 8 as the kickoff orders them; ask the user what a job does to the guest where
   the kickoff leaves it open (job 6: whether the layout's disk write stays).
2. The track's end: an out-of-context review over the whole track, `ci.sh`, `ci-debian.sh --platform`, `ci-machines.sh`,
   `ci-net.sh`, `ci-graphics.sh`; then PLAN.md's row, the kickoff and this handover deleted.

## Found (worth not re-discovering)

- **The page's linter caps a file at 300 lines** (eslint `max-lines`, in `ci.sh`'s lint); `runner.ts` sits at the limit,
  `worker.ts` and `net-live.ts` near it: put new logic in a module of its own. Format with the project's config
  (`npm run format`, or tools/lint/node_modules/.bin/prettier --config tools/lint/prettier.config.ts), never a bare
  `npx prettier` (it rewrote a whole file at another width).
- **A port handed to a device must be listed in web/devices.ts's transfer list** (the `specs.flatMap` near line 178),
  or every machine with that device fails to start with a DataCloneError.
- **The agent's sandbox** (`RestrictAddressFamilies=AF_UNIX AF_VSOCK`) breaks tools that use netlink: networkctl (even
  with an index) and if_nametoindex; D-Bus tools (busctl, nmcli) work. Check a guest tool from inside the unit on Debian,
  not only natively.
- **OpenSSH ≥ 9.8's listener loads host keys only at its start and SIGHUP**; `sshd -D` writes no pid file.
- **Xvfb can't grow its screen past its start size**: RandR tests run on Xorg's dummy driver (xf86-video-dummy and
  xrandr in the dev VM: docs/devenv.md).
- **Piped, swaymsg prints JSON** (`current_mode` there), not its human format.
- A quick look at the page's error: a Playwright script in `bench/results/local/` printing `#message`'s text (the
  tests' assertion only has the headline); delete it after (tsc checks that directory).
