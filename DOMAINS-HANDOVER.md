# DOMAINS: what is left for the dev VM

The DOMAINS track is **done** (2026-11-21; PLAN.md's row, docs/frontend.md "The Home page", docs/networking/names.md
"What the user sees", docs/backlog.md "A connection's page and its Domains pane"). **Don't reopen it.** This file holds
only the test runs its cloud session couldn't make. **Delete it once they are done** (and the backlog's item "Its
topic scripts have not run" with it).

## What ran, where

The track was built in a Claude Code cloud session (docs/cloud.md). On its final code (`e109c8e5`, branch
`claude/admiring-allen-h6luhy`):

- `scripts/ci.sh` passed whole: 1498 passed, 0 failed, 607 skipped. The skipped ones need guest images the cloud
  can't build, and its image and TSan steps were skipped for the same reason.
- `tests/page-room.test.ts` and `tests/page-network.test.ts` passed on Debian.
- `scripts/ci-net.sh`, `scripts/ci-debian.sh` and `scripts/ci-machines.sh` refused to start: the alpine-uefi,
  linux-snd and alpine-demo images are missing there.

## To run in the dev VM

On the branch's tip, one at a time (each takes the CI lock), under the memory cap CLAUDE.md gives:

```sh
systemd-run --user --scope -q -p MemoryMax=11G -p MemorySwapMax=0 -- scripts/ci.sh
systemd-run --user --scope -q -p MemoryMax=11G -p MemorySwapMax=0 -- scripts/ci-net.sh
systemd-run --user --scope -q -p MemoryMax=11G -p MemorySwapMax=0 -- scripts/ci-debian.sh
systemd-run --user --scope -q -p MemoryMax=11G -p MemorySwapMax=0 -- scripts/ci-machines.sh
```

- `scripts/ci.sh`: the 607 tests and the image and TSan steps skipped in the cloud; and the agent's six tests that
  are skipped as root in a cloud session (`agent/src/main.rs` `skipped_in_cloud`), which run only as a user.
- `scripts/ci-net.sh`: the track added the network module's `member` operation and changed how the page reaches names.
- `scripts/ci-debian.sh`: the track changed the Home page, the toolbar's Network menu and the Network wizard.
- `scripts/ci-machines.sh`: Home's levels sit in the Machines page.

The track touched neither the display nor 3D, so `scripts/ci-graphics.sh` was left out; the rule for a track's end
(the whole set) would include it and the other topic scripts.

## If one fails

Fix it as a change of its own, with its test, on the branch (or after it merges): a failure here is a defect to fix,
not a reason to reopen the track. A loose end that isn't fixed goes in docs/backlog.md's DOMAINS entry.
