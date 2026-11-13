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
- Checks: `cargo test` in agent/ (headless sway, Xorg dummy, the root loop with a fake and the real ssh-keygen),
  `tests/agent.test.ts`, the Debian page tests `tests/page-clipboard.test.ts` and `tests/page-template.test.ts`
  (`scripts/ci-debian.sh --platform`).

## Next

1. **The mid-track out-of-context review now** (after loop 3): the agent's DISPLAY path (outputs.rs, x11/randr.rs, the
   root's jobs) and RENEW (renew.rs, the link, `asTemplate`).
2. Then job 3 (the network across a snapshot; also refreshes networkd's DUID from the new machine id), 4, 5 as the
   kickoff orders them.
