---
name: issues
description: How to find, file, update and close the project's GitHub issues (its backlog) with tools/issue.ts. Use before filing a loose end, a flake or a follow-up, before picking up backlog work, and when a commit completes or touches an issue.
---

# The project's issues

The backlog is GitHub issues, read and written only with `node tools/issue.ts` (REST through `gh api`; `gh issue` is
GraphQL and fails in cloud sessions). The rules: docs/issues.md.

## Finding

- `node tools/issue.ts list --label network-p2p` (several labels: all must match), `--type Flake`, `--priority High,Urgent`, `--untriaged`, `--state all`, `--json`.
- `node tools/issue.ts search "words"` before filing, to find a duplicate; `--state all` to see closed ones too (what was
  tried and why it was closed is often there).
- `node tools/issue.ts show N --comments` for one in full. `labels` lists the types, the priorities and the labels.

## Filing

1. Search first; if one exists, `comment` on it (new evidence) or `edit` it, rather than filing another.
2. Write the body to a file in the scratchpad: **what** is wrong or missing, the **evidence** (a test's output, a
   REPORT.md section, numbers with their host and Chromium version), **where** in the code, and what was already
   tried. State what exists; no session narrative.
3. `node tools/issue.ts file --title "…" --type <Bug|Feature|Flake|Performance|Measurement|Cleanup> --label
   <areas…>[,upstream|needs-human] --body-file <file>`. Exactly one type; every area it touches (a sub-area's parent
   is added for you). **Never a priority** (`--priority` needs `--triage`): the user or a triage session sets it.
4. Put `Refs #n` in the commit message of the work that found it, and the issue in the handover.

A label or type that doesn't exist is refused: use the closest existing one and say in the body what's missing; never
create labels or types (`labels --sync --apply` is the user's). Filing is routine and needs no confirmation; deleting issues, or closing
many at once outside an agreed triage, does.

## Working on one and closing it

- `edit N --add-label … --remove-label …`, `--type`, `--title`, `--body-file` (the body states the current state; progress goes
  in comments: `comment N --body-file …`).
- The commit that completes it says `Fixes #n` (GitHub closes it on main). Closing without a commit:
  `close N --reason not_planned|duplicate|completed --comment-file <why>`; the why names the commit, the measurement
  or the duplicate.
