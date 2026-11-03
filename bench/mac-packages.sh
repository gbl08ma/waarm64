# The page's packages on the Mac host, for the *-mac.sh scripts (sourced): the repository's lock installed there with
# `npm ci`, so the dev server's native parts (Vite's Rolldown and Lightning CSS) are the Mac's own, with vite.config.ts
# and the tools the server needs. Needs Node and npm there (Homebrew's).
#   mac_packages <host> <dest>
mac_packages() {
  ssh "$1" "mkdir -p $2/tools/svelte-check"
  rsync -a package.json package-lock.json vite.config.ts THIRD_PARTY.json "$1:$2/"
  rsync -a tools/serve.ts tools/stamp.ts tools/tailscale.ts tools/nosme.ts tools/third-party.ts "$1:$2/tools/"
  rsync -a tools/svelte-check/package.json "$1:$2/tools/svelte-check/"
  ssh "$1" "cd $2 && PATH=/opt/homebrew/bin:\$PATH npm ci --no-audit --no-fund --loglevel=error"
}
