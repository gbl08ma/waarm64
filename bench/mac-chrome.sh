# Chrome on the Mac host for the *-mac.sh scripts (sourced; docs/devenv.md "The Mac host"): the current Stable Chrome
# for Testing (Google's build of Chrome for automation; its last-known-good Stable), fetched into ~/waarm64-chrome/<version>/
# there when Stable moves, ~/waarm64-chrome/current pointing at it, the two newest kept. Offline, the one already there.
# Not Playwright's own download, which lags Stable and is an early build of its milestone (153.0.8010.12 had a WebGPU bug
# that 153's release didn't: indirect dispatches read clobbered immediates, GD G4).
#   mac_chrome <host>     then, in the command run there: export CHROMIUM="$MAC_CHROME" (expanded there)
MAC_CHROME='$HOME/waarm64-chrome/current/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
mac_chrome() {
  timeout 600 ssh "$1" 'bash -s' <<'EOF'
set -eu
d=$HOME/waarm64-chrome
mkdir -p "$d" && cd "$d"
v=$(curl -sSf --max-time 20 https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions.json |
  plutil -extract channels.Stable.version raw -o - - 2>/dev/null) || v=
if [ -z "$v" ]; then
  [ -e current ] || { echo "mac_chrome: no Chrome for Testing there, and its version can't be fetched" >&2; exit 1; }
  echo "mac_chrome: offline: keeping $(readlink current)" >&2
  exit 0
fi
if [ ! -d "$v" ]; then
  rm -rf "$v.part" && mkdir "$v.part"
  curl -sSfL --max-time 400 -o "$v.part/c.zip" "https://storage.googleapis.com/chrome-for-testing-public/$v/mac-arm64/chrome-mac-arm64.zip"
  (cd "$v.part" && unzip -q c.zip && rm c.zip)
  mv "$v.part" "$v"
fi
ln -sfn "$v" current
old=$(ls -d [0-9]*.[0-9]*.[0-9]*.[0-9]* 2>/dev/null | grep -v part | sort -t. -k1,1n -k2,2n -k3,3n -k4,4n || true)
n=$(printf '%s\n' "$old" | grep -c . || true)
[ "$n" -gt 2 ] && printf '%s\n' "$old" | head -n $((n - 2)) | while read -r o; do [ "$o" != "$v" ] && rm -rf "$o"; done
echo "mac_chrome: Chrome for Testing $v"
EOF
}
