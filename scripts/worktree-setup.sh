#!/usr/bin/env bash
# Makes a fresh worktree of this repository ready to run the page, its tests and the scripts/ci*.sh scripts, from the
# main checkout's untracked trees (docs/devenv.md "Worktrees"). Idempotent: what's already there is left alone.
#
#   scripts/worktree-setup.sh [worktree]    (default: the current directory's worktree)
#
# - node_modules copied (cp -a): Vite serves with fs.strict, which refuses a symlink out of the worktree (403s that
#   look like code bugs). tools/svelte-check/node_modules is a symlink (svelte-check isn't page code).
# - The guest images hard-linked (cp -al): target/images/* (but build/, the work trees) and target/deqp/*; an entry that
#   can't be linked is left out with a warning, not a failure. Their builders delete or rename before
#   writing (images/build.sh's `rm -rf "$dst"`, images/deqp/build.sh's `.new` + mv), so a rebuild in the worktree
#   never writes through a link into the main checkout's copy. Cargo's and Vite's outputs (the wasm core, venus.wasm,
#   ts.wasm) are not linked: a build there could rewrite a shared file in place, and a main checkout's output can be
#   stale for the branch. scripts/ci.sh builds them; scripts/build-wasm.sh (and vk/build.sh) before a page test alone.
# - package-lock.json's mtime set old, while it is the main checkout's (the one node_modules was installed from): git
#   resets it at checkout, and scripts/ci.sh runs `npm ci` when the lockfile is newer than node_modules. A branch whose
#   lockfile differs keeps its mtime, so CI installs the branch's packages.
# Run by the WorktreeCreate hook (scripts/worktree-hook.sh), or by hand; never by CI, so a worktree's own changes to
# node_modules or the lockfile are left alone.
set -euo pipefail

wt=$(git -C "${1:-.}" rev-parse --show-toplevel)
main=$(dirname "$(git -C "$wt" rev-parse --path-format=absolute --git-common-dir)")
if [ "$wt" = "$main" ]; then
  echo "worktree-setup: $wt is the main checkout" >&2
  exit 1
fi

if [ ! -d "$wt/node_modules" ] && [ -d "$main/node_modules" ]; then
  cp -a "$main/node_modules" "$wt/node_modules"
fi
if [ ! -e "$wt/tools/svelte-check/node_modules" ] && [ -d "$main/tools/svelte-check/node_modules" ]; then
  ln -s "$main/tools/svelte-check/node_modules" "$wt/tools/svelte-check/node_modules"
fi

for tree in images deqp; do
  [ -d "$main/target/$tree" ] || continue
  mkdir -p "$wt/target/$tree"
  for d in "$main/target/$tree"/*; do
    [ -e "$d" ] || continue
    n=$(basename "$d")
    # target/images/build holds images/build.sh's work trees (kernels, Buildroot, venus's Mesa and wasi-sdk), which
    # make writes in place (a link would carry a worktree's build into the main checkout's tree), partly owned by
    # Podman's subordinate uids (fs.protected_hardlinks refuses links to them). A worktree's image build starts its own.
    [ "$tree/$n" = images/build ] && continue
    [ -e "$wt/target/$tree/$n" ] && continue
    if ! cp -al "$d" "$wt/target/$tree/$n" 2>/dev/null; then
      rm -rf "$wt/target/$tree/$n"
      echo "worktree-setup: target/$tree/$n not linked (a file can't be hard-linked: another owner?); build it here if needed" >&2
    fi
  done
done

# Only while the worktree's lockfile is the one the copied node_modules came from: a branch that changes it keeps
# its mtime, so scripts/ci.sh runs `npm ci` for it.
if cmp -s "$wt/package-lock.json" "$main/package-lock.json"; then
  touch -d 2020-01-01 "$wt/package-lock.json"
fi
echo "worktree-setup: $wt ready (node_modules, target/images, target/deqp from $main)"
