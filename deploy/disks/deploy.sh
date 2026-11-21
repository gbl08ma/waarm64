#!/bin/sh
# Deploys target/disks/ to disks.waarm64.com (wrangler.jsonc beside this). Only when the user asks: it replaces the
# whole site, so target/disks/ must hold every image that should stay (wrangler uploads only pieces it hasn't seen).
# The demos and the store go in with node tools/publish-demos.ts --apply (deploy/disks/demos.json; it checks the budget and
# says what a deploy would drop); another image with: node tools/chunk-image.ts <image> target/disks/<name> 2 --name
# "<what the page calls it>" --pieces target/disks/pieces, then node tools/disk-trace.ts <run.json> target/disks/<name>/manifest.json
# target/disks/<name>/prefetch.json. The publisher's ledger (.publish.json) isn't deployed (.assetsignore).
#   deploy/disks/deploy.sh   (with ~/.config/cloudflare/waarm64.env sourced: docs/frontend.md "Deployed at waarm64.com")
set -eu
cd "$(dirname "$0")"
D=../../target/disks
[ -d "$D" ] || { echo "no $D"; exit 1; }
cp _headers "$D/_headers"
n=$(find "$D" -type f ! -name .publish.json ! -name .assetsignore | wc -l)
[ "$n" -le 20000 ] || { echo "$n files: a version holds 20,000 at most on the free plan"; exit 1; }
exec wrangler deploy --config wrangler.jsonc --message "${1:-disks}"
