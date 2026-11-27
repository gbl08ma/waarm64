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

## Next

Loop 4:
1. Move the 19 doc units into the pages their notes name. Their verdicts and notes are in `triage.json`
   (`verdict: "doc"`).
2. Switch the references to `docs/backlog.md` to issue URLs, using `map.json` to go from a backlog entry to its
   issue. That covers about 25 docs, the 3 `ponytail:` markers, CLAUDE.md, docs/testing.md, docs/README.md, PLAN.md's
   header and rows, and the open kickoffs and handovers. A reference to a stale, done or merged unit points to the
   doc or to the issue it was merged into.
3. Add a check (static checks) that fails on a remaining `backlog.md` reference.
4. Delete docs/backlog.md, and update the memories that name it (backlog-hygiene).
