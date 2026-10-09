#!/usr/bin/env bash
# Real pages for bench/gpu/firefox-load.ts (the G4 kickoff's decision 1: the user found Firefox slow on real sites,
# scrolling and loading): a few sites saved with what they load (wget --page-requisites, links made local), each with
# bench/gpu/firefox/{bench,page}.js injected (`FFBENCH load <ms>` at its load event, then the frames a second), in an
# ext4 the page serves as its second disk (`?disk2=`; the guest mounts /dev/vdb on /mnt/ffpages). Local only: the
# pages are other people's, never committed. Pages that depend on scripts from the network show what loaded.
#   bench/gpu/firefox-pages.sh   -> target/ffpages/pages.ext4
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
W=$ROOT/target/ffpages
UA="Mozilla/5.0 (X11; Linux aarch64; rv:157.0) Gecko/20100101 Firefox/157.0"
mkdir -p "$W/site"
cd "$W/site"
# name url saved-file
PAGES="wiki https://en.wikipedia.org/wiki/Linux en.wikipedia.org/wiki/Linux.html
mdn https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_grid_layout developer.mozilla.org/en-US/docs/Web/CSS/CSS_grid_layout.html
github https://github.com/torvalds/linux github.com/torvalds/linux.html
bbc https://www.bbc.com/news www.bbc.com/news.html
hn https://news.ycombinator.com/ news.ycombinator.com/index.html"
echo "$PAGES" | while read -r name url file; do
  # wget exits non-zero when any requisite fails (and has crashed converting Wikipedia's links): what it saved is used.
  [ -f "$file" ] || timeout 300 wget -q -U "$UA" -e robots=off -p -k -H -E --timeout=20 --tries=2 "$url" || true
  [ -f "$file" ] || { echo "$name: nothing saved" >&2; exit 1; }
done
cp "$ROOT/bench/gpu/firefox/bench.js" "$ROOT/bench/gpu/firefox/page.js" .
rm -rf "$W/tree"; mkdir -p "$W/tree"
cp -r . "$W/tree/site"
echo "$PAGES" | while read -r name url file; do
  # The scripts first in <head>; the page's own Content-Security-Policy meta tag (if any) dropped.
  sed -i -e '0,/<head[^>]*>/s##&<script src="file:///mnt/ffpages/site/bench.js"></script><script src="file:///mnt/ffpages/site/page.js"></script>#' \
    -e 's#<meta[^>]*http-equiv="Content-Security-Policy"[^>]*>##I' "$W/tree/site/$file"
  echo "$name site/$file" >> "$W/tree/pages.txt"
done
mb=$(du -sm "$W/tree" | cut -f1)
rm -f "$W/pages.ext4"
truncate -s $((mb * 13 / 10 + 32))M "$W/pages.ext4"
mke2fs -q -t ext4 -L ffpages -d "$W/tree" "$W/pages.ext4"
rm -rf "$W/tree"
ls -l "$W/pages.ext4"
