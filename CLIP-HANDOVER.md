# Clipboard sharing (CLIP): handover

The track's brief is [docs/plans/clipboard.md](docs/plans/clipboard.md), with the user's choices of 2026-11-05 in its
§7 (no separate kickoff: the plan was written with the user and holds them). Its §6 lists the steps; each is a loop.

## Where it stands

**Step 1, the channel: done 2026-11-05.** A machine with clipboard sharing (`MachineRecord.clipboard`, a transient one's
`?clipboard=1`) has the agent's device, a virtio-console of its own with one port, `org.webpc.agent.0`
(`web/agent-device.ts`; docs/devices.md "agent"). No UI yet: the Machines page's switch comes with step 4.

**Step 2, the agent on the console: done 2026-11-06.** `agent/` (Rust, `rustix` only, its own stable toolchain),
`images/build.sh agent` (Podman; the host's cargo with a `HOST-BUILD` marker without it, which `npm run dist`
refuses), delivered gzipped as fw_cfg's `opt/webpc/agent` with `webpc-agent.service` (`web/app/guest-agent.ts`);
HELLO both ways, TYPE through TIOCSTI, PAUSE/RESUME (docs/devices.md "The guest's agent"). The page's end speaks them
(`AgentLink.type`, `pause`, `resume`, `agent`); the tests drive it through `window.__agent`. Measured on Debian:
plan §3.1 and §3.3.

## Next: step 3 (Wayland)

Our data-control client in a session child, logind tracking, the test image's headless sway and wl-clipboard (plan
§6). The unit already keeps `CAP_SETUID`/`CAP_SETGID` for the child; X11 (step 5) will need `/tmp/.X11-unix`, which
the unit's `PrivateTmp=yes` hides: revisit then.

## Open questions and left for the user

- **Arch's kernel and `qemu_fw_cfg`** (plan §3.1): unchecked here (no desktop image on this VM). By hand on the Arch
  desktop: `ls /sys/firmware/qemu_fw_cfg/by_name/opt/webpc/` with clipboard sharing on, and `systemctl status
  webpc-agent`; also whether its /run is `noexec` (the unit doesn't care: its own tmpfs).
- **The binary's size**: 333 KiB, ~320 KiB of it `std` (an empty `fn main` is 319 KiB on this toolchain). The plan's
  ~200 KiB needs `#![no_std]` on `rustix`'s runtime (plan §3.3's "next step"); it would also cut the boot's fw_cfg
  read (§3.1). Not done: a rewrite of the startup, the allocator and the logging for one cost paid once a boot.
- **The x86_64 fallback** (`rust-lld` cross-linking the musl target) is unproven until a cloud session runs
  `scripts/cloud-setup.sh`; the same commands build on the dev VM (aarch64).

## Notes

- Linux's virtio_console drops what arrives for a port nobody holds open, and the device does the same on its side;
  the page learns the agent is there from the port's `open`, and the link resets its reader and queue at each opening.
- Port 0 needn't be a console: Linux makes it one only on CONSOLE_PORT, so the single port is id 0 and there are four
  queues. A second port (spice's, plan §3.4) would be id 1 at queues 4 and 5 (`portQueues`), with `max_nr_ports` 2: a
  change of shape for machines that have the device.
- Debian 13 mounts /run `noexec`: the unit runs the agent from a `TemporaryFileSystem=` of its own, so the serial
  shell sees `/run/webpc` empty (`/proc/<pid>/exe` reaches the binary).
