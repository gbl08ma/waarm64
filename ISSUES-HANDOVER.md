# ISSUES handover

## State (2026-11-27)

- **Loop 1 done** (c9df2738; push tier `scripts/ci.sh` passed): `tools/issue.ts` (REST through `gh api`), the
  `issues` skill, docs/issues.md, `.github/labels.json` with the kinds, modifiers and priorities (no areas yet), the
  set's lint in the static checks.
- **Loop 2: the triage is done and awaits the user's review.** 350 units (an entry's sub-items count separately):
  311 keep, 19 doc, 9 stale, 8 merge, 3 done. The review page is https://claude.ai/artifact/6SebpDrcnWTn5fZHksxg8x.
  The data is in `bench/results/local/issues-triage/` (git-ignored): `units.json` (the split of docs/backlog.md at
  e04a6974), `triage.json` (the verdicts), `labels.json` (area counts), `triage-brief.md` (the agents' brief).
- The proposals waiting on the user: the areas with their counts (tailcat folds into `network-tailnet`, demo into
  `network`); no effort label; non-keep units not filed; issues filed without a priority; bundled units filed as
  one issue each.

## Next

1. Once the user approves: add the areas (with parents) to `.github/labels.json`. The user runs
   `node tools/issue.ts labels --sync --apply`; it also deletes GitHub's default labels, as the user confirmed.
2. Loop 3: a migration script over `fileIssue`. Body: the unit's backlog text, its parent entry's intro for
   sub-items, the merged units appended, and relative doc links made absolute (`blob/main/...`). Throttle at about 1
   s per create. Keep a uid-to-number map in `bench/results/local/issues-triage/` so a rerun resumes. Dry run first.
3. Loop 4: move the doc units into their pages, switch the references (25 docs, 3 `ponytail:` markers, CLAUDE.md,
   docs/testing.md, PLAN.md's header, the open kickoffs and handovers), add the check for stale `backlog.md`
   references, and delete docs/backlog.md.
