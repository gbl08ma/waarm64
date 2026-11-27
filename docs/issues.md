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

## Labels

The set is `.github/labels.json`: each label has a name, a group, a color and a description; a sub-area names its
parent. `node tools/issue.ts labels` lists it, `labels --lint` checks it (the static checks of `scripts/ci-fast.sh` and
`scripts/ci.sh`), `labels --diff` compares the repo with it.

- **Areas**, nested by a dash: `network`, `network-p2p`, `network-p2p-domains`. An issue takes every area it touches; a
  sub-area always comes with its parents (the tool adds them), and an issue about an area as a whole takes only the
  parent.
- **Kind**: exactly one of `bug`, `flake` (CI's reliability, not the product), `feature`, `perf`, `measure` (a number
  never taken), `cleanup`.
- **Modifiers**, any number: `upstream` (waits on another project, or is to be reported to one), `needs-human` (the
  user's hardware, a decision, or work only a person can do).
- **Priority**: `priority:high`, `priority:medium`, `priority:low`, set only by the user or a triage session that weighs
  many issues together (`--triage`). An issue with no priority is untriaged: `list --untriaged`.

A label exists only if at least 3 issues take it; a sub-area below that folds into its parent. **Agents never create,
rename or delete labels, milestones or projects**: a change to the set is a change to `.github/labels.json` with the
user's OK, and the user applies it with `node tools/issue.ts labels --sync --apply` (without `--apply` it prints the
plan).

## Commits

A commit names every issue it filed, changed, commented on or closed: `Refs #n` in its message, `Fixes #n` for one it
completes (GitHub closes it when the commit reaches main). A handover lists the issues its loop touched. Docs and code
link an issue by its full URL (`https://github.com/gbl08ma/waarm64/issues/n`), which works in a clone, on GitHub and in
a terminal alike.
