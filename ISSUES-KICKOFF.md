# ISSUES: the backlog becomes GitHub issues

Confirmed by the user on 2026-11-27.

## Goal

`docs/backlog.md` (2,292 lines, 224 top-level items) becomes issues on `gbl08ma/waarm64`. Humans and agents can then
ask questions that cut across areas, such as "the high-priority items", "one CI flake" or "everything about the
network", and get the answer from a filter instead of by reading the file. When the track ends, `docs/backlog.md` is gone.

## Decisions taken

- **Issues are as public as the file**: being able to subscribe to them is fine.
- **Grouping uses labels, not GitHub Projects.** Projects v2 is GraphQL-only. Cloud sessions' proxy rejects GraphQL
  with a 403, and the dev VM's token lacks the `project` scope. Labels, milestones, search and sub-issues are all
  available over REST.
- **All access goes through REST** (`gh api repos/gbl08ma/waarm64/...`), locally too. `gh issue …` is GraphQL and
  gets a 403 in cloud sessions, so one code path works everywhere.
- **Agents never create, rename or delete labels**, and never create milestones or projects: those need the user's
  OK. The label set lives in the repo (`.github/labels.json`). The user approves changes to it, and a sync script
  that only the user runs applies them.
- **Agents filing an issue don't set its priority.** An issue without a `priority:*` label is untriaged. Priority is
  set by the user or by a triage session that looks at many issues together.
- **Commits name the issues they touch**, whether created, changed, commented on or closed: `Refs #n` / `Fixes #n` in
  the message. The handover lists them too.

## Label set (the triage proposes it; the user approves it)

Three groups of labels. Each group has its own color in `.github/labels.json`:

- **Areas**, which may be nested: `network`, `network-p2p`, `network-p2p-domains`, `network-tailnet`, `jit`, `page`, ….
  An issue takes every area it touches. A sub-area label always comes with its parent's label (`network-p2p` with
  `network`), and the tool adds the parent if it is missing. An issue that affects an area as a whole takes only the
  parent. Example: p2p configuration on the page is `network`, `network-p2p`, `page`.
- **Kind**: exactly one of `bug`, `flake` (CI reliability only), `feature`, `perf`, `measure` (a number never taken),
  `cleanup`.
- **Modifiers**: as many as apply, for example `upstream` (waits on, or is to be reported to, another project such as
  Chromium or the kernel) and `needs-human` (needs the user's hardware, a decision, or other work only a person can do). Example: a JIT speedup waiting on a
  Chromium bug is `jit`, `perf`, `upstream`.
- **Priority**: `priority:high`, `priority:medium`, `priority:low`. Only the user or a triage session sets one; an
  issue without one is untriaged.

**Threshold**: a label exists only if at least 3 of the issues kept after triage would take it (merged and closed
items don't count). A sub-area below the threshold folds into its parent's label. GitHub's default labels
(`bug`, `enhancement`, `good first issue`, …) are deleted; the user confirmed this. `bug` is recreated in the set. Vulkan's [A]/[B]/[C] grades map onto labels only if the triage
finds they pass the threshold outside Vulkan as well.

## Loops

1. **Tooling.** `tools/issue.ts`, a Node script over `gh api`, with the commands `file`, `edit`, `comment`, `close`,
   `list` (filtering by label) and `search`. It refuses labels missing from `.github/labels.json`, takes the body from
   a file or stdin, throttles itself under GitHub's secondary rate limits, and prints `#n` plus the URL. It also gets a
   project skill (`.claude/skills/issues/`) saying when and how to file, the body's shape (what, evidence linked
   to a REPORT.md section at a commit, where in the code) and the commit rule. It is tested against a fake `gh`, and
   nothing touches the real repo in tests.
2. **Triage (no GitHub writes).** Every backlog item gets one verdict: keep, close as stale (measurements nobody
   needs any more, flakes not seen since a date), merge with another item, or move to a doc (findings that are not
   tasks). Each kept item also gets its kind, area and a proposed priority. The output is a review table for the
   user (an artifact) plus the final `.github/labels.json`. **The user approves the table and the labels.**
3. **Migration.** The user syncs the labels, then the approved items are filed in one throttled run. The run
   records a mapping from each backlog title to its issue number (kept under `bench/results/local/` and not
   committed), so the run can resume without duplicates.
4. **References.** About 25 docs that cite `backlog.md "…"`, the 3 `ponytail:` code markers, CLAUDE.md, docs/testing.md,
   docs/README.md, tracks' docs, and the open kickoffs and handovers (with their owners' OK for kickoff text) are
   switched to full issue URLs. A check in `tools/` (static-check lane) fails on any remaining `backlog.md` reference.
   `docs/backlog.md` is deleted in this loop.

## Needs the user's OK

The label set (with its counts), the triage table (closures above all), syncing labels, and the migration run itself (it writes about
200 objects to GitHub).

## Validation

Tests for `tools/issue.ts`. A dry run of the migration that prints what it would file. After the run, compare the
issue count and labels with the approved table. The reference check finds nothing. Only docs and tools change, so the
fast lane is enough (no guest-visible change).

## The end

The backlog is issues, every doc links to them, the skill and tool are documented in docs/ (a page on issues, linked
from docs/README.md), PLAN.md's row is set to done, and this kickoff is deleted.
