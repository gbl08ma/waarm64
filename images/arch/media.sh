#!/usr/bin/env bash
# The desktop guest's media (audio S3, docs/audio.md "Decisions"): made with ffmpeg in rootless Podman (Alpine's
# container, natively on arm64), WebM (VP8 or VP9 and Opus: Firefox decodes them itself, without the system's ffmpeg).
# On demand: images/arch/desktop.sh calls it.
#   avsync.webm   the A/V sync clip: 640x360 at 30 frames a second, black, the first frame of every second white; a
#                 1 kHz beep of 40 ms at the start of every second (Opus, 48 kHz stereo); 60 s. On the page, the flash
#                 is timed on the screen and the beep on the sound's output (bench/audio/avsync.ts).
#   sintel.webm   a real video for the ear: the Sintel trailer (Blender Foundation, CC BY 3.0, from download.blender.org),
#                 854x480 VP9 and Opus; sintel-silent.webm, the same video without its sound (the decode's cost of sound).
#   avsync-vp9.webm, avsync.mp4   the sync clip again as VP9 (with Opus) and as H.264 High with B-pictures and AAC.
#   res-vp9.webm, res-h264.ts   a stream whose size changes (the video track, docs/graphics.md "Video's findings"): the trailer from
#                 20 s to 32 s in three 4 s segments, 854x480, 640x360 and 1280x720, each from a key picture, joined
#                 without re-encoding (one track); VP9 in WebM (Firefox plays it), H.264 High with B-pictures in MPEG-TS.
#   sintel-av1.webm, sintel-aom.webm, sintel-grain.webm   AV1 (the video track's V3): the trailer in SVT-AV1 with
#                 Opus; its first 10 s in libaom (all eight references, hidden frames shown later); 10 s of SVT-AV1 with
#                 film grain; sintel-tools.webm, 3 s of libaom with more of AV1's tools on (segmentation, 2x2 tiles,
#                 128x128 superblocks, quantizer matrices, global motion, delta q and lf, film grain).
#   avsync.html   a page that plays a clip (?v=<file>) to its end, full window on black, with sound (its profile allows it).
#   images/arch/media.sh [outdir]   (default target/arch/media)
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
OUT=$(realpath -m "${1:-$ROOT/target/arch/media}")
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
  # The same in the codecs the host decodes for the guest (VA-API over virgl, docs/graphics.md "Video"): VP9, and H.264 High
  # with B-pictures (x264 defaults) and AAC.
  [ -f avsync-vp9.webm ] || ffmpeg -loglevel error -y -i avsync.webm -c:v libvpx-vp9 -b:v 400k -g 30 -deadline good -cpu-used 4 -c:a copy avsync-vp9.webm
  [ -f avsync.mp4 ] || ffmpeg -loglevel error -y -i avsync.webm -c:v libx264 -profile:v high -pix_fmt yuv420p -g 30 -crf 23 -c:a aac -b:a 128k -movflags +faststart avsync.mp4
  [ -f sintel.webm ] || ffmpeg -loglevel error -y -i sintel_trailer-480p.mp4 -c:v libvpx-vp9 -crf 34 -b:v 0 -row-mt 1 -deadline good -cpu-used 4 -c:a libopus -b:a 128k sintel.webm
  [ -f sintel-silent.webm ] || ffmpeg -loglevel error -y -i sintel.webm -an -c:v copy sintel-silent.webm
  if [ ! -f res-vp9.webm ] || [ ! -f res-h264.ts ]; then
    k=0
    for seg in 20:854:480 24:640:360 28:1280:720; do
      IFS=: read -r at w h <<EOS
$seg
EOS
      ffmpeg -loglevel error -y -ss "$at" -t 4 -i sintel_trailer-480p.mp4 -an -vf "scale=$w:$h" -c:v libvpx-vp9 -crf 34 -b:v 0 -row-mt 1 -deadline good -cpu-used 4 /tmp/res$k.webm
      ffmpeg -loglevel error -y -ss "$at" -t 4 -i sintel_trailer-480p.mp4 -an -vf "scale=$w:$h" -c:v libx264 -profile:v high -pix_fmt yuv420p -crf 23 -f mpegts /tmp/res$k.ts
      echo "file /tmp/res$k.webm" >> /tmp/res.txt
      echo "file /tmp/res$k.ts" >> /tmp/res-ts.txt
      k=$((k + 1))
    done
    ffmpeg -loglevel error -y -f concat -safe 0 -i /tmp/res.txt -c copy res-vp9.webm
    ffmpeg -loglevel error -y -f concat -safe 0 -i /tmp/res-ts.txt -c copy -f mpegts res-h264.ts
  fi
  [ -f sintel-av1.webm ] || ffmpeg -loglevel error -y -i sintel_trailer-480p.mp4 -c:v libsvtav1 -preset 8 -crf 40 -c:a libopus -b:a 128k sintel-av1.webm
  [ -f sintel-aom.webm ] || ffmpeg -loglevel error -y -t 10 -i sintel_trailer-480p.mp4 -an -c:v libaom-av1 -cpu-used 6 -row-mt 1 -crf 40 -b:v 0 sintel-aom.webm
  [ -f sintel-tools.webm ] || ffmpeg -loglevel error -y -ss 30 -t 3 -i sintel_trailer-480p.mp4 -an -c:v libaom-av1 -cpu-used 4 -row-mt 1 -crf 40 -b:v 0 -aq-mode 1 -tiles 2x2 -aom-params "sb-size=128:enable-qm=1:enable-global-motion=1:deltaq-mode=1:delta-lf-mode=1:denoise-noise-level=10" sintel-tools.webm
  [ -f sintel-grain.webm ] || ffmpeg -loglevel error -y -ss 20 -t 10 -i sintel_trailer-480p.mp4 -an -c:v libsvtav1 -preset 8 -crf 40 -svtav1-params film-grain=8 sintel-grain.webm
  for f in avsync.webm avsync-vp9.webm avsync.mp4 sintel.webm sintel-silent.webm res-vp9.webm res-h264.ts sintel-av1.webm sintel-aom.webm sintel-grain.webm sintel-tools.webm; do ffprobe -loglevel error -show_entries stream=codec_name,width,height,sample_rate,channels:format=duration -of compact "$f"; done'
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
