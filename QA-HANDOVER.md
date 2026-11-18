# QA handover

Supervisor + parallel lanes (Claude Code worktree agents, branches merged into main by the supervisor; lanes run
targeted tests only, the supervisor runs the scripts/ci*.sh set after each wave).

## Lanes
Wave 1 (parallel):
- **idle**: CPU in a tab whose machine is suspended or powered off; memory not released after power-off.
- **storage**: merging an overlay into a browser-internal disk (blank disk, blank overlay: the resize case);
  snapshots that can never be restored (written-in-place disk changed, and any other permanent cause) shown as
  orphaned, and a warning when taking a snapshot of a machine where that can happen.
- **netfolders**: an Edit button on each connection card in Change connection…'s chooser (opens that connection's
  editor in place of the chooser); the shared folders popup's manual mount command moved to a details/help screen.
- **home**: the Machines page/button renamed Home; "Machines" as the sidebar's heading, a proper empty state; the
  banner's enter/leave transitions (floating: flies in from above over the toolbar, 250 ms).
Wave 2 (after wave 1 merges; touches the whole catalog):
- **refs**: human-given names styled in running text (catalog-wide markup), UI elements referenced in messages (icons
  before them, a subtle style for a button's words), monospace in banners only where it belongs.
Then: out-of-context review of the whole change, fix loops, the full CI set.

## State
- Wave 1 (idle, storage, netfolders, home) merged into main locally, 1b9c4906; ci.sh running on it, then ci-debian
  --platform, ci-machines, ci-audio, ci-net, ci-graphics. Push after green. Lane screenshots: bench/results/local/qa/.
- Wave 2 (refs) running from d9189c7a (branch qa-refs).
- To check in review: the storage lane's snapshot warning is the Snapshot button's tooltip plus the notice after a
  kept snapshot; a crashed (kernel panic) machine keeps running on purpose (idle lane); tools/screens.ts crashes in
  its seed (size-actions.ts:119 `shapeNow`), pre-existing, maybe fixed by refs.
