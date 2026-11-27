# ISSUES handover

## State (2026-11-27)

- **Loop 1 done** (c9df2738; push tier `scripts/ci.sh` passed): `tools/issue.ts` (REST through `gh api`), the
  `issues` skill, docs/issues.md, the set's lint in the static checks.
- **Loop 2 done**: the user approved the triage (https://claude.ai/artifact/6SebpDrcnWTn5fZHksxg8x), the label set
  (2986ec11, fast lane; the user synced it, GitHub's defaults deleted) and the bodies' light rework (What, Evidence,
  Where, Tried, Context; the backlog's text in a collapsed block; a dated effort estimate in the footer; track names
  kept as pointers to their reports).
- **Loop 3 done**: the 311 kept units are issues #4–#314, and 15 of them got a Related section. The data, in
  `bench/results/local/issues-triage/` (git-ignored): `map.json` (unit to issue number), `bodies.json`,
  `triage.json`, `units.json` (the split of docs/backlog.md at e04a6974, unchanged since), `assemble.py`,
  `migrate.ts`, the briefs.

- **Loop 4 done**: the references switched (docs, code comments, test lists, CLAUDE.md, PLAN.md, the other tracks'
  files, VK4's kickoff with the user's OK), the 19 doc units in their pages, docs/backlog.md deleted,
  `tools/backlog-refs.ts` in the static checks, #315 and #316 filed from the two `ponytail:` markers left without an
  issue. After the migration the user switched kinds to issue types and priorities to the Priority field (effd1e83).

## Next

The track's end: the out-of-context review of tools/issue.ts and tools/backlog-refs.ts, its findings fixed or filed,
then PLAN.md's row set to done and this file and the kickoff deleted.
