# Issues

The project's open work (bugs, CI flakes, missing features, performance opportunities, numbers never taken) lives in
GitHub issues on `gbl08ma/waarm64`, labeled so that a question across areas ("the high-priority items", "one flake",
"everything about p2p rooms") is a filter. `tools/issue.ts` is how agents and scripts read and write them; the project
skill `.claude/skills/issues/` says when and how.

## The tool

`node tools/issue.ts` (its header lists the commands): `file`, `edit`, `comment`, `close`, `reopen`, `show`, `list`,
`search`, `labels`. It speaks GitHub's REST API through `gh api`, never `gh issue` or `gh pr`: those use GraphQL, which
the cloud sessions' proxy refuses with a 403 (and GitHub Projects, GraphQL-only, is out of reach there, which is why
grouping is by labels). One path works in the dev VM, the cloud and CI. It waits out GitHub's secondary rate limit (a
minute, three times) and takes bodies from `--body-file` or stdin.

## Types and labels

An issue's kind is its **issue type** (GitHub's field, single-valued): exactly one of `Bug`, `Feature`, `Flake` (CI's
reliability, not the product), `Performance`, `Measurement` (a number never taken, or to take again), `Cleanup`. The
types are the account's, made in GitHub's settings by the user; `Task` exists by default and isn't used. `list --type`
and `search --type` filter by it.

The set is `.github/labels.json`: the issue types, the Priority field (its id and options), then the labels (each with a name, a group, a color and a
description; a sub-area names its parent). `node tools/issue.ts labels` lists it, `labels --lint` checks it (the static checks of `scripts/ci-fast.sh` and
`scripts/ci.sh`), `labels --diff` compares the repo with it (and reports a type the repo lacks).

- **Areas**, nested by a dash: `network`, `network-p2p`, `network-p2p-domains`. An issue takes every area it touches; a
  sub-area always comes with its parents (the tool adds them), and an issue about an area as a whole takes only the
  parent.
- **Modifiers**, any number: `upstream` (waits on another project, or is to be reported to one), `needs-human` (the
  user's hardware, a decision, or work only a person can do).

An issue's **priority** is the Priority field (single-select: `Urgent`, `High`, `Medium`, `Low`), set only by the user
or a triage session that weighs many issues together (`edit N --triage --priority High`, `none` clears it). An issue
without one is untriaged. GitHub's search filters on it only in advanced search (`field.priority:High`,
`no:field.priority`; `-has:field.priority` answers wrongly), so `list --priority` and `list --untriaged` go through it.
Reading the field's definition needs the `read:user` scope: `.github/labels.json` keeps its id instead.

The rest are labels. A label exists only if at least 3 issues take it; a sub-area below that folds into its parent. **Agents never create,
rename or delete labels, types, fields, milestones or projects**: a change to the set is a change to `.github/labels.json` with the
user's OK, and the user applies it with `node tools/issue.ts labels --sync --apply` (without `--apply` it prints the
plan).

## Where the backlog was

Until 2026-11-27 the open work was `docs/backlog.md`. Its 350 items were triaged and 311 filed as #4–#314; each
issue's footer names its line in the file as it last stood (commit `e04a6974`). `tools/backlog-refs.ts` (in the static
checks) fails on a file that still points at it. The dated journals (`bench/*/REPORT.md`, results) are left as they
were written.

## Commits

A commit names every issue it filed, changed, commented on or closed: `Refs #n` in its message, `Fixes #n` for one it
completes (GitHub closes it when the commit reaches main). A handover lists the issues its loop touched. Docs and code
link an issue by its full URL (`https://github.com/gbl08ma/waarm64/issues/n`), which works in a clone, on GitHub and in
a terminal alike.
