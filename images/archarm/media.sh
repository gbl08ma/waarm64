#!/usr/bin/env bash
# The desktop guest's media (audio S3, docs/audio.md "Decisions"): made with ffmpeg in rootless Podman (Alpine's
# container, natively on arm64), WebM (VP8 or VP9 and Opus: Firefox decodes them itself, without the system's ffmpeg).
# On demand: images/archarm/desktop.sh calls it.
#   avsync.webm   the A/V sync clip: 640x360 at 30 frames a second, black, the first frame of every second white; a
#                 1 kHz beep of 40 ms at the start of every second (Opus, 48 kHz stereo); 60 s. On the page, the flash
#                 is timed on the screen and the beep on the sound's output (bench/audio/avsync.ts).
#   sintel.webm   a real video for the ear: the Sintel trailer (Blender Foundation, CC BY 3.0, from download.blender.org),
#                 854x480 VP9 and Opus; sintel-silent.webm, the same video without its sound (the decode's cost of sound).
#   avsync.html   a page that plays a clip (?v=<file>) to its end, full window on black, with sound (its profile allows it).
#   images/archarm/media.sh [outdir]   (default target/archarm/media)
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
OUT=$(realpath -m "${1:-$ROOT/target/archarm/media}")
CONTAINER=$(grep -E '^USERLAND_CONTAINER=' "$ROOT/images/build.sh" | cut -d= -f2 | cut -d' ' -f1)
SINTEL_URL=https://download.blender.org/durian/trailer/sintel_trailer-480p.mp4
SINTEL_SHA256=b670602fa00934ca27c4351bb0efe7ea7a07fae57284e44226025eeed7c51254
mkdir -p "$OUT"

if [ ! -f "$OUT/sintel_trailer-480p.mp4" ]; then
  curl -fL --retry 3 -o "$OUT/sintel_trailer-480p.mp4.part" "$SINTEL_URL"
  mv "$OUT/sintel_trailer-480p.mp4.part" "$OUT/sintel_trailer-480p.mp4"
fi
[ "$(sha256sum "$OUT/sintel_trailer-480p.mp4" | cut -d' ' -f1)" = "$SINTEL_SHA256" ] || { echo "sintel_trailer-480p.mp4: sha256 mismatch" >&2; exit 1; }

podman run --rm -v "$OUT:/out:Z" "$CONTAINER" sh -euc '
  apk add -q --no-cache ffmpeg
  cd /out
  ffmpeg -loglevel error -y \
    -f lavfi -i "color=c=black:s=640x360:r=30:d=60,drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable=lt(mod(n\,30)\,1)" \
    -f lavfi -i "aevalsrc=if(lt(mod(t\,1)\,0.04)\,0.5*sin(2*PI*1000*t)\,0):s=48000:d=60" \
    -ac 2 -c:v libvpx -b:v 400k -g 30 -deadline good -c:a libopus -b:a 96k avsync.webm
  [ -f sintel.webm ] || ffmpeg -loglevel error -y -i sintel_trailer-480p.mp4 -c:v libvpx-vp9 -crf 34 -b:v 0 -row-mt 1 -deadline good -cpu-used 4 -c:a libopus -b:a 128k sintel.webm
  [ -f sintel-silent.webm ] || ffmpeg -loglevel error -y -i sintel.webm -an -c:v copy sintel-silent.webm
  for f in avsync.webm sintel.webm sintel-silent.webm; do ffprobe -loglevel error -show_entries stream=codec_name,width,height,sample_rate,channels:format=duration -of compact "$f"; done'
cat > "$OUT/avsync.html" <<'EOF'
<!doctype html>
<meta charset="utf-8">
<title>webpc avsync</title>
<style>html, body { margin: 0; height: 100%; background: #000; overflow: hidden } video { width: 100%; height: 100%; object-fit: contain }</style>
<video id="v" autoplay playsinline></video>
<script>
// Plays ?v=<file> (beside this page) once, with sound; `dump` prints the playback's events on Firefox's stdout.
const v = document.getElementById('v');
const say = (m) => { try { dump(`AVSYNC ${m}\n`); } catch {} console.log(`AVSYNC ${m}`); };
v.src = new URLSearchParams(location.search).get('v') || 'avsync.webm';
for (const e of ['playing', 'waiting', 'stalled', 'ended', 'error']) v.addEventListener(e, () => say(`${e} t=${v.currentTime.toFixed(3)}`));
setInterval(() => { const q = v.getVideoPlaybackQuality(); say(`t=${v.currentTime.toFixed(3)} frames=${q.totalVideoFrames} dropped=${q.droppedVideoFrames}`); }, 1000);
</script>
EOF
ls -l "$OUT"
