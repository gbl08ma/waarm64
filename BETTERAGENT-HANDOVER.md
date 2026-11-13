# BETTERAGENT handover

The track's brief: BETTERAGENT-KICKOFF.md (the user's; approved and started 2026-11-13). State and next steps only.

## State

- **Job 1, the screen's size, Wayland (loop 1, done):** DISPLAY (14) and `CAP.DISPLAY` (bit 5); the page sends the
  size it asks the guest's display for, at each change and each agent's HELLO; the root process keeps the page's HELLO
  and last DISPLAY and gives both to each new child first; the child's jobs (`session::Jobs`: clipboard, resize) are
  fixed at its start (other jobs: a fresh child). `agent/src/outputs.rs` speaks wlr-output-management v1 (custom mode
  of the page's size on every enabled head; a size asked once isn't asked again until the page's changes). No guest
  program is run. Binary 145,312 bytes (+12.6 KB). devices.md "The screen's size".
- **Job 1, X11 (loop 2, done):** `agent/src/x11/randr.rs`, RandR 1.2 on the child's X connection for X11 sessions
  (none under a compositor; Xwayland's outputs skipped); a mode of the size found or made, the screen grown first when
  the CRTC wouldn't fit. Tested natively on Xorg's dummy driver (Xvfb can't set modes), one planted bug caught.
  Binary 150,872 bytes. Xorg's modesetting on virtio-gpu unmeasured (backlog).
- **Job 2, a template's identity (loop 3, done):** RENEW (15) / RENEWED (16), `CAP.RENEW` (bit 6);
  `agent/src/renew.rs` (entropy + forced reseed, machine id, random seed, SSH host keys via ssh-keygen where it
  exists, in a helper polled by pidfd); the header flag `template` and `tools/snapshot-template.ts`; the unit's
  `ReadWritePaths`. Binary 158,064 bytes. devices.md "A template's identity".
- **The mid-track review (review/betteragent, 2026-11-13), five findings, all fixed or filed:** sshd's listeners
  SIGHUP'd after the keys are made (they load keys only then since OpenSSH 9.8); RandR's CRTC refused for a stale time
  tried again (3 times); no RandR on an X connection under a compositor (`x_jobs`: Xwayland's outputs take the
  compositor's names); RENEW owed until RENEWED (sent again after a reconnection); the mode made last deleted once
  left. Filed: a template saved or suspended before its renewal. Binary 160,744 bytes.
- Checks: `cargo test` in agent/ (headless sway, Xorg dummy, the root loop with a fake and the real ssh-keygen),
  `tests/agent.test.ts`, the Debian page tests `tests/page-clipboard.test.ts` and `tests/page-template.test.ts`
  (`scripts/ci-debian.sh --platform`).

## Next

1. **Job 3, decided by the user (2026-11-13): the agent first, the device's flap as the fallback.** After a restore,
   where the agent is up and networkd's `networkctl` (or NetworkManager's `nmcli`) exists, the agent renews the lease
   at once (no outage); otherwise (no agent, Alpine, direct boot) virtio-net's existing flap (`FLAP_MS`, 7 s: networkd
   ignores a carrier loss under 5 s when the lease's MTU isn't the link's original, NET-HANDOVER.md "Found") runs after
   the restore. **And the restore waits for our side's connections** (tailnets, rooms, the local helper) to be up
   before the guest is told to renew, unless the lease doesn't depend on them (check: does web/gateway.ts answer DHCP
   by itself before an adapter connects? Then only a later address change matters, which the gateway's `stale` flap
   already covers). The user's worry: a renewal before the connection is up gets no lease and the guest doesn't retry
   for long. Also refreshes networkd's DUID from a template's new machine id, if reconfigure re-reads it (check).
   Then jobs 4, 5 as the kickoff orders them.
