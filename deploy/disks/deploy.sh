#!/bin/sh
# Deploys target/disks/ to vmdisks.tny.im (wrangler.jsonc beside this). Only when the user asks: it replaces the
# whole site, so target/disks/ must hold every image that should stay (wrangler uploads only pieces it hasn't seen).
# An image goes in with: node tools/chunk-image.ts <image> target/disks/<name> 2 --name "<what the page calls it>",
# then node tools/disk-trace.ts <run.json> target/disks/<name>/manifest.json target/disks/<name>/prefetch.json.
#   deploy/disks/deploy.sh   (with ~/.config/cloudflare/webpc.env sourced: docs/frontend.md "Deployed at vm.tny.im")
set -eu
cd "$(dirname "$0")"
D=../../target/disks
[ -d "$D" ] || { echo "no $D"; exit 1; }
cp _headers "$D/_headers"
n=$(find "$D" -type f | wc -l)
[ "$n" -le 20000 ] || { echo "$n files: a version holds 20,000 at most on the free plan"; exit 1; }
exec wrangler deploy --config wrangler.jsonc --message "${1:-disks}"
