# BETTERAGENT handover

The track's brief: BETTERAGENT-KICKOFF.md (the user's; approved and started 2026-11-13). State and next steps only.

## State

- **Job 1, the screen's size, Wayland (loop 1, done):** DISPLAY (14) and `CAP.DISPLAY` (bit 5); the page sends the
  size it asks the guest's display for, at each change and each agent's HELLO; the root process keeps the page's HELLO
  and last DISPLAY and gives both to each new child first; the child's jobs (`session::Jobs`: clipboard, resize) are
  fixed at its start (other jobs: a fresh child). `agent/src/outputs.rs` speaks wlr-output-management v1 (custom mode
  of the page's size on every enabled head; a size asked once isn't asked again until the page's changes). No guest
  program is run. Binary 145,312 bytes (+12.6 KB). devices.md "The screen's size".
- Checks: `cargo test` in agent/ (the headless-sway test, the root-loop test, two planted bugs caught),
  `tests/agent.test.ts`; the Debian page test's resize section (`tests/page-clipboard.test.ts`, in
  `scripts/ci-debian.sh --platform`).

## Next

1. **Job 1, X11** (backlog "The screen's size under X11"): RandR by hand in `x11.rs`'s style, only where the session
   has no Wayland compositor (Xwayland's outputs skipped); the child connects to X for the size alone when the
   clipboard isn't shared. Test: Xvfb's RandR, if it lets a mode be set (else byte-level tests and the Debian image's
   Xvfb session; Xorg isn't on the test image).
2. Then the kickoff's order: job 2 needs the user's decisions (what is renewed; every restore or only a shared
   snapshot) — ask before starting it; jobs 3 onwards as written.
- Mid-track out-of-context review after ~3 loops.
