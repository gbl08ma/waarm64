#!/usr/bin/env bash
# Claude Code's WorktreeCreate and WorktreeRemove hooks (.claude/settings.json; docs/devenv.md "Worktrees").
#
#   scripts/worktree-hook.sh create    stdin: {"name": ...}; prints the new worktree's path last on stdout
#   scripts/worktree-hook.sh remove    stdin: {"worktree_path": ...}
#
# A WorktreeCreate hook replaces Claude Code's own `git worktree add`, so `create` does what it does (the worktree at
# .claude/worktrees/<name>, on a new branch worktree-<name>, from origin's default branch: `worktree.baseRef` "fresh")
# and then scripts/worktree-setup.sh, so the worktree runs the page and CI from its first command. `remove` removes
# the worktree (the user chose to, or it was a clean exit) and keeps its branch, as Claude Code's own removal does.
# Everything but the path goes to stderr.
set -euo pipefail

field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s)[process.argv[1]];if(typeof v!=="string"||!v)process.exit(1);process.stdout.write(v)})' "$1"; }

main=$(dirname "$(git -C "${CLAUDE_PROJECT_DIR:-.}" rev-parse --path-format=absolute --git-common-dir)")
case "${1:-}" in
create)
  name=$(field name)
  [[ $name =~ ^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$ && $name != *..* ]] || { echo "worktree-hook: bad name: $name" >&2; exit 1; }
  path=$main/.claude/worktrees/$name
  if [ ! -d "$path" ]; then
    timeout 60 git -C "$main" fetch -q origin >&2 || echo "worktree-hook: fetch failed; from the last fetched origin" >&2
    base=$(git -C "$main" symbolic-ref -q --short refs/remotes/origin/HEAD || echo origin/main)
    git -C "$main" worktree add -q -b "worktree-$name" "$path" "$base" >&2
  fi
  "$(dirname "${BASH_SOURCE[0]}")/worktree-setup.sh" "$path" >&2
  echo "$path"
  ;;
remove)
  path=$(field worktree_path)
  case "$path" in
  "$main"/.claude/worktrees/?*) ;;
  *) echo "worktree-hook: not one of this repository's worktrees: $path" >&2; exit 1 ;;
  esac
  [ -d "$path" ] || exit 0
  git -C "$main" worktree remove --force "$path" >&2
  ;;
*)
  echo "usage: $0 create|remove (JSON on stdin)" >&2
  exit 2
  ;;
esac
