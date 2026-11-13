#!/usr/bin/env bash
# The realtime sound tests on the page (docs/testing.md, docs/audio.md "Tests"): run it, besides scripts/ci.sh, when
# a change touches sound: virtio-snd, the sound ring (web/snd.ts, web/audio-*.ts), the page's Sound menu or
# microphone, snapshots of a playing machine. They time the sound against the clock, so they run alone, not beside
# npm test's other files. ~1 min. Needs the snd guest (images/build.sh linux-snd) and the wasm core (scripts/ci.sh
# builds it).
set -euo pipefail
cd "$(dirname "$0")/.."
step() { printf '\n== %s (at %d s)\n' "$*" "$SECONDS"; }

images/build.sh --check linux-snd > /dev/null || { echo 'ci-audio: the snd guest is missing or stale (images/build.sh linux-snd)'; exit 1; }
export WAARM64_AUDIO_TESTS=1
step 'sound tests'
node --disable-warning=ExperimentalWarning --test tests/audio-browser.test.ts
printf '\nCI-AUDIO OK (%d s)\n' "$SECONDS"
