#!/bin/bash
# The desktop guest's second disk for desktop.ts (README.md "On the desktop guest"): Mozilla's own linux-aarch64
# Firefox (its symbols are on symbols.mozilla.org; the port's Firefox has none) with bench/gpu/firefox's autoconfig,
# desktop.html and photos.py's images from the photos in <src dir> -> target/imgpipe/disk.ext4; the symbols of
# libxul as `addr size name` lines -> target/imgpipe/libxul.funcs. Needs Python's Pillow (README.md).
#   bench/imgdecode/desktop-disk.sh <src dir>
set -euo pipefail
cd "$(dirname "$0")/../.."
VER=${FIREFOX_VERSION:-158.0.1}
W=target/imgpipe
SRC=${1:?usage: desktop-disk.sh <src dir of photos>}
mkdir -p "$W/dl"
T=$W/dl/firefox-$VER.tar.xz
[ -f "$T" ] || curl -sSfL -o "$T" "https://ftp.mozilla.org/pub/firefox/releases/$VER/linux-aarch64/en-US/firefox-$VER.tar.xz"
rm -rf "$W/tree" && mkdir -p "$W/tree"
tar -C "$W/tree" -xf "$T"
cp bench/gpu/firefox/autoconfig.js "$W/tree/firefox/defaults/pref/"
cat bench/gpu/firefox/webpc.cfg bench/imgdecode/profiler.cfg > "$W/tree/firefox/webpc.cfg"
cp bench/imgdecode/desktop.html bench/gpu/firefox/user.js "$W/tree/"
# Mozilla's build asks for its Terms of Use at the first start (the distribution's doesn't): skipped.
echo '{"policies": {"SkipTermsOfUse": true, "DisableTelemetry": true, "DontCheckDefaultBrowser": true, "OverrideFirstRunPage": ""}}' > "$W/tree/firefox/distribution/policies.json"
cat >> "$W/tree/user.js" <<'EOF'
user_pref("termsofuse.bypassNotification", true);
user_pref("browser.preonboarding.enabled", false);
user_pref("datareporting.policy.dataSubmissionPolicyBypassNotification", true);
EOF
python3 bench/imgdecode/photos.py "$SRC" "$W/tree/img"
# perf for the guest (desktop.ts PERF=1): the port's package and what it needs, installed there with pacman -U.
if [ ! -f "$W/pkg/.done" ]; then
  mkdir -p "$W/pkg"
  podman run --rm -v "$PWD/$W/pkg:/out:Z" localhost/arch-base sh -c 'pacman -Sy >/dev/null && pacman -Sw --noconfirm --cachedir /out perf >/dev/null'
  touch "$W/pkg/.done"
fi
mkdir -p "$W/tree/pkg" && cp "$W"/pkg/*.pkg.tar.zst "$W/tree/pkg/"
# The decoders' command-line tools for decoders.sh (target/imgpipe/pkg2: dwebp, djpeg, tjbench, avifdec), if fetched.
[ -d "$W/pkg2" ] && mkdir -p "$W/tree/pkg2" && cp "$W"/pkg2/*.pkg.tar.zst "$W/tree/pkg2/"
cp bench/imgdecode/decoders.sh "$W/tree/"
# Ad hoc static tools (target/imgpipe/bin: e.g. the clock_gettime microbenchmark), if any.
[ -d "$W/bin" ] && cp -r "$W/bin" "$W/tree/"
if [ ! -f "$W/libxul.funcs" ]; then
  # The breakpad debug id: the build id's first 16 bytes as a GUID (its first three fields byte-swapped), then 0.
  id=$(readelf -n "$W/tree/firefox/libxul.so" | awk '/Build ID/{print toupper($3)}')
  g=$(echo "$id" | sed -E 's/^(..)(..)(..)(..)(..)(..)(..)(..)(.{16}).*/\4\3\2\1\6\5\8\7\9/')0
  curl -sSfL "https://symbols.mozilla.org/libxul.so/$g/libxul.so.sym" | gzip -dcf | awk '
    $1=="FUNC"{m=($2=="m"); a=m?$3:$2; sz=m?$4:$3; $1=$2=$3=$4=""; if(m)$5=""; sub(/^ +/,""); print a, sz, substr($0,1,240)}
    $1=="PUBLIC"{m=($2=="m"); a=m?$3:$2; $1=$2=$3=""; if(m)$4=""; sub(/^ +/,""); print a, 0, substr($0,1,240)}' > "$W/libxul.funcs.part"
  mv "$W/libxul.funcs.part" "$W/libxul.funcs"
fi
mb=$(du -sm "$W/tree" | cut -f1)
rm -f "$W/disk.ext4"
truncate -s $((mb * 13 / 10 + 64))M "$W/disk.ext4"
mke2fs -q -t ext4 -L imgpipe -d "$W/tree" "$W/disk.ext4"
rm -rf "$W/tree"
ls -l "$W/disk.ext4"
