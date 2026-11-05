# Clipboard sharing (CLIP): handover

The track's brief is [docs/plans/clipboard.md](docs/plans/clipboard.md), with the user's choices of 2026-11-05 in its
§7 (no separate kickoff: the plan was written with the user and holds them). Its §6 lists the steps; each is a loop.

## Where it stands

**Step 1, the channel: done 2026-11-05** (a cloud session). A machine with clipboard sharing (`MachineRecord.clipboard`,
a transient one's `?clipboard=1`) has the agent's device: a virtio-console of its own with MULTIPORT and one port,
`org.webpc.agent.0` (`web/agent-device.ts`; docs/devices.md "agent"). The page's end is `web/app/agent-link.ts`
(`AgentLink`, `window.__agent` for the tests), the frames `web/agent-frame.ts`. The device is its own transport kind
(`agent`, after `9p` in the slots), so no other machine's shape or step counts moved. No UI: the Machines page's switch
and its words come with step 4, once the agent exists to make it mean something.

- Tests: `tests/agent.test.ts` (the device through hand-built queues, the frames, the link's window), the shape in
  `tests/store.test.ts`, and `tests/page-agent.test.ts` on Debian (`scripts/ci-debian.sh`): the port's name, the page
  hearing `cat` open and close it, frames echoed back unchanged.
- **Not run here:** the plan's Buildroot echo "in every runner" (Buildroot is built in Podman, which a cloud session
  can't); Debian's test covers the device against a real driver instead. If a Buildroot or native twin is wanted, it's
  for the dev VM.
- Frame types are numbered (`FRAME`), their payloads not yet defined: step 2 defines HELLO and TYPE with the agent.

## Next: step 2 (needs the dev VM)

The agent, console only: the Rust binary built in rootless Podman through `images/` (`images/build.sh agent`), delivered
over fw_cfg (`opt/webpc/agent`) by a credential unit (web/app/guest-unit.ts's pattern), HELLO, TYPE through TIOCSTI,
PAUSE. Measure the binary's size and the fw_cfg read time; check §3.3's idle targets. The page's credentials for it
are added only when the machine has `clipboard` (main.ts builds the start message: `agent` is set there).

## Notes

- Linux's virtio_console drops what arrives for a port nobody holds open, and the device does the same on its side;
  the page learns the agent is there from the port's `open`, and the link resets its reader and queue at each opening.
- Port 0 needn't be a console: Linux makes it one only on CONSOLE_PORT (checked in v6.12's driver), so the single port
  is id 0 and there are four queues. A second port (spice's, plan §3.4) would be id 1 at queues 4 and 5
  (`portQueues`), with `max_nr_ports` 2: a change of shape for machines that have the device.
