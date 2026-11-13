**Drafted at the user's ask (2026-11-13)** by the session that closed AGENT, for a track **BETTERAGENT**: more jobs
for the guest agent. Not approved yet: the user reads it, edits it if they want, and starts the track in a session of
its own. The list is the AGENT session's answer to "what other backlog items could be tackled with a more complex or
complete guest agent?", in its order (most visible to users first).

## Where things stand

The guest agent (AGENT, done 2026-11-13; PLAN.md §3) runs by default on every `firmware` machine whose guest has
systemd 256+, delivered over fw_cfg and SMBIOS credentials with nothing written to the disk, and talks to the page over
the machine's vsock (`AGENT_PORT` 8574, numbered connections; a restore resets the transport and the agent connects
again). It sets the guest's clock (TIME) and, where the machine shares it, the clipboard; its root process forks a
session child for the active session on seat0 (Wayland data-control or X11). Read first: docs/devices.md "vsock" and
"The guest's agent" (the frames, the unit and its sandbox), docs/clipboard.md, docs/frontend.md "The guest's clock",
docs/plans/agent.md (the plan these jobs come from), and CLAUDE.md.

New jobs fit as frames under a capability bit each (`CAP` in `web/agent-frame.ts` and `agent/src/frame.rs`; bit 3 is
reserved for text/html, 8 and 9 for session kinds), said in both HELLOs. A job that needs root runs in the root
process; one that needs the user's session runs in the session child, as the user (the child runs today only where the
clipboard is shared: a session job would need it started for its own sake too). The agent runs no guest program today
(it speaks Wayland and X itself); a job that runs one (`swaymsg`, `networkctl`, `fstrim`, `setxkbmap`, …) first checks
that it exists and offers its capability only then. Each job that changes the unit's
needs (capabilities, `RestrictAddressFamilies`, writable paths) changes `AGENT_SERVICE` in `web/app/guest-agent.ts` and
its test. Every one needs the user's OK on what it does to the guest (they are guest-visible), and is measured for the
agent's size and idle cost (0 ticks, 0 wakeups: docs/clipboard.md "What it costs").

## The jobs

1. **Live resize of the guest's screen** (docs/plans/agent.md "What an agent is for"; backlog "The plan's optional
   step 6"; docs/graphics.md "The console and the display size"). sway keeps its mode when the page's size changes,
   and Xorg sees the new mode but doesn't apply it. The page posts its size; the session child runs
   `swaymsg -- output <name> mode --custom WxH` (or speaks wlr-output-management, as `wlr-randr` does) and, under
   X11, `xrandr --auto` (or RandR's requests by hand, as x11.rs speaks X). The agent runs a guest tool only if it's
   there: it looks for `swaymsg` or `xrandr` (executable, on the session's `PATH`) before it offers the job, and a
   guest without it gets no resize and no error (the capability bit stays off, the page keeps today's behaviour).
   Speaking the protocol itself needs no tool at all, so prefer it where it's cheap. GNOME and KDE are expected to
   follow by themselves (unmeasured). Start: the measurements in plans/agent.md's table, `GpuOptions.resize` (the display
   event's test hook).

2. **Each visitor's copy of a preloaded snapshot** (backlog: the preloaded image and snapshot entry, "what must
   differ per visitor"). The page's HELLO after a restore carries fresh entropy and a "restored" flag; the agent
   reseeds the kernel's random generator (`RNDADDENTROPY` on `/dev/random` with the host's bytes), makes a new
   `/etc/machine-id`, SSH host keys and systemd's random seed, and sets the hostname. Needs the user's decisions on
   what is renewed, and on whether it runs for every restore or only for a snapshot marked as shared (a user's own
   snapshot keeps its identity). Writes to the guest's disk: a first for the agent (docs/plans/agent.md §"An agent of
   ours" rejected disk writes for delivery, not for this).

3. **The network across a snapshot** (backlog "The network across a snapshot"). A restored guest keeps its DHCP lease
   while the page may connect its card somewhere else. After a restore the agent runs `networkctl reconfigure` (or
   renews the lease; NetworkManager's equivalent), so the guest takes a lease for the network it's on now. Unlike the
   entry's "link down/up at restore", it needs no change to virtio-net. Needs the networking docs
   (docs/networking/adapters.md) and a check with tailnet and room connections.

4. **A "desktop is ready" signal** (backlog "The ready marker is a per-machine regexp": "Not built: a compositor's
   first cursor…"). The session child knows when a compositor or an X server is up (its SESSION today); a frame for
   it gives the page a state past `running` for guests that log in automatically or have no serial getty. Needs a
   decision on what the page does with it (the state line, the tests' waits).

5. **Disk space handed back on demand** (backlog "blk DISCARD/WRITE_ZEROES": "the user runs `fstrim`, or waits for
   `fstrim.timer`"). The page asks the agent to run `fstrim` before an export or a compaction, or when storage runs
   low, so freed blocks shrink the overlay without the user doing anything in the guest. Mind the entry's note: a trim
   of GBs holds the guest's I/O for seconds (the compaction is synchronous in the device worker).

6. **The keyboard layout in the running session** (backlog "Keyboard layouts' loose ends"; docs/frontend.md "The
   keyboard layout"). Today the layout is written to the guest's disk at boot, takes effect from the next boot and
   stays after the setting is turned off. The session child applies it at once (`swaymsg input * xkb_layout …`,
   `setxkbmap` or XKB requests under X11; `localectl` or `loadkeys` for the console from the root process), with no
   disk write. Decide whether the disk write stays (for the display manager's greeter, which the agent can't reach).

7. **Copying from a text console** (docs/clipboard.md "Not shared"; docs/plans/agent.md). Root reads `/dev/vcsN`
   (`/dev/vcsaN` for the cursor): a "Copy the console's text" item in the clipboard menu, the foreground VT's screen
   as text to the host's clipboard.

8. **Smaller jobs from docs/plans/agent.md** (no backlog entries): the guest's address and OS name in the status bar
   (`/etc/os-release`, the interfaces' addresses); a power-off and reboot that ask the guest first (logind's
   `PowerOff`/`Reboot`, so inhibitors are honoured; the power key already works through logind); mounting a shared
   folder when it's attached, not only at boot (docs/shares.md).

Beside any of them, the agent's own backlog entries: "Two compositors for one user" and "Restarts read the binary
again" (docs/backlog.md "Clipboard sharing").

**Reaching more guests** (backlog "The guest's clock after a restore": "Guests without the agent"): the tools disk of
docs/plans/agent.md (a read-only FAT disk with the binary, a systemd unit, an OpenRC script and an installer) would
bring the agent to guests without systemd 256 (Alpine with OpenRC). It matters most if jobs 2 and 3 are wanted beyond
systemd 256 guests. A job of its own, if the user wants it.

## How it runs

As AGENT did: loops without check-ins, one commit and a short report per loop, each job with its tests at the cheapest
layer (`agent/`'s `cargo test` and `serve_test.rs`, `tests/agent.test.ts`, the Debian page tests), a planted bug for
each new rule; docs (devices.md "The guest's agent", the job's own topic) and the backlog changed in the same commit;
an out-of-context review mid-track and at its end. CI: `scripts/ci.sh` always; `scripts/ci-debian.sh` (with
`--platform` for the session jobs and the track's end), `scripts/ci-machines.sh` where settings or snapshots move,
`scripts/ci-net.sh` for job 3.
