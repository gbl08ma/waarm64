// Seeking with the host decoding the guest's video (docs/plans/video.md V3; dev-only, not in tests): the desktop guest
// (images/archarm/desktop.sh, with webpc-va) on the page, the clips on bench/video/media-disk.sh's disk.
//   1. The guest's FFmpeg jumps within one decoder: the concat demuxer's in and out points on the same file (each
//      segment starts at the key picture before its in point, so the decoder gets a new key picture where the guest's
//      stream jumps), the list looped once (the loop is a seek to its start, which flushes the decoder). Decoded in
//      software and through VA-API, the frames' hashes compared (framemd5): equal where the host's decoder is exact
//      (VP9 everywhere; H.264 on FFmpeg's or a hardware decoder, not the dev VM's OpenH264).
//   2. Firefox seeks a paused video (`currentTime`, then `seeked`), draws the picture it shows into a canvas and
//      compares it, as 16×9 blocks of mean luma, with FFmpeg's software frames from 0.1 s before the time to 0.1 s
//      after (PNGs made in the guest): the best match should be the frame that time falls in, and a picture left from
//      before the seek (the buffers' old planes) matches none.
//   3. Firefox seeks every 2.5 s while playing: the ms from setting `currentTime` to `seeked`, how far playback went
//      after each seek (it plays on), frames presented and dropped; the renderer's video totals (pictures given up,
//      drains, errors) over the phase.
//   node bench/video/seek.ts <image.qcow2> [outdir]      (default bench/results/local/video/seek/)
// CLIPS (default sintel_trailer-480p.mp4,sintel.webm), VIRGL_GPU (the page's `?gpu=`, default virgl), PHASES (default
// ffmpeg,paused,playing). CAPTURE=1 saves the session's virgl capture as <outdir>/capture.vglt (bench/video/pictures.ts
// makes the host's streams of it).
import { mkdirSync, writeFileSync } from 'node:fs';
import { encodeTrace } from '../../web/virgl-trace.ts';
import { openSession } from '../gpu/guest-session.ts';

const image = process.argv[2];
if (!image) throw new Error('usage: node bench/video/seek.ts <image.qcow2> [outdir]');
const out = process.argv[3] ?? new URL('../results/local/video/seek/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const CLIPS = (process.env.CLIPS ?? 'sintel_trailer-480p.mp4,sintel.webm').split(',');
const PHASES = (process.env.PHASES ?? 'ffmpeg,paused,playing').split(',');
/** The times for a clip: concat segments [in, out] (s; forwards, back, forwards), paused seeks (forwards and back, one
 * repeated, the start and near the end), seeks while playing (2.5 s apart). The 12 s clips whose size changes
 * (`res-*`: 854x480, then 640x360 from 4 s, 1280x720 from 8 s) seek across the changes. */
const times = (clip: string) => clip.startsWith('res-')
  ? { segments: [[5, 6], [1, 2], [9, 10]], paused: [5.3, 1.2, 9.7, 2.1, 5.3, 0.5, 11.1], playing: [6, 1, 9, 3, 7, 0.5] }
  : { segments: [[30, 31.5], [8, 9.5], [44, 45]], paused: [30.3, 5.2, 44.7, 12.1, 30.3, 0.5, 50.1], playing: [20, 8, 35, 3, 47, 15, 26, 40, 10, 30] };

const capture = !!process.env.CAPTURE;
const s = await openSession({ gpu: `${process.env.VIRGL_GPU ?? 'virgl'}${capture ? ',capture' : ''}`, image, out, disk2: '/target/video/media.ext4' });
const { page, log, pasteSerial, rootShell, run, runLines } = s;
/** Every renderer line (`?gpu=...,debug`'s trace and its warnings) in order, into <out>/virgl.txt. */
const virgl: string[] = [];
page.on('console', (m) => { if (m.text().startsWith('virgl')) virgl.push(`${(performance.now() / 1000).toFixed(2)} ${m.text().slice(0, 300)}`); });
const results: Record<string, unknown> = { gl: s.gl, chromium: s.browser.version(), gpu: process.env.VIRGL_GPU ?? 'virgl' };
const save = () => {
  writeFileSync(`${out}/results.json`, JSON.stringify({ ...results, slow: s.slow }, null, 1));
  writeFileSync(`${out}/virgl.txt`, virgl.join('\n'));
};
type Video = { frames: number; decoded: number; dropped: number; errors: number; latencyMs: number; latencyMaxMs: number; ahead: number; maxWaitMs: number };
/** The renderer's video totals now, and the longest END_FRAME-to-written and wait for a picture since the last call. */
const video = async () => {
  await page.waitForTimeout(2500); // the next render-stats
  const r = await page.evaluate(() => ((window as unknown as { __renderStats?: { video?: Video }[] }).__renderStats ?? []).splice(0).map((x) => x.video));
  const v = r.at(-1);
  return { frames: v?.frames ?? 0, decoded: v?.decoded ?? 0, dropped: v?.dropped ?? 0, errors: v?.errors ?? 0, latencyMs: v?.latencyMs ?? 0, latencyMaxMs: Math.max(0, ...r.map((x) => x?.latencyMaxMs ?? 0)), maxWaitMs: Math.max(0, ...r.map((x) => x?.maxWaitMs ?? 0)) };
};
/** Over a phase: pictures, the mean and longest ms from END_FRAME to written, the longest a call waited for one. */
const delta = (a: Awaited<ReturnType<typeof video>>, b: typeof a) => ({ frames: b.frames - a.frames, decoded: b.decoded - a.decoded, dropped: b.dropped - a.dropped, errors: b.errors - a.errors,
  latencyMs: +((b.latencyMs - a.latencyMs) / Math.max(1, b.decoded - a.decoded)).toFixed(1), latencyMaxMs: +b.latencyMaxMs.toFixed(1), maxWaitMs: +b.maxWaitMs.toFixed(1) });

// The page Firefox runs (paste-safe: no tabs, no `$` the shell's heredoc would expand).
const SEEK_HTML = String.raw`<!doctype html>
<meta charset="utf-8">
<title>webpc seek</title>
<style>html, body { margin: 0; height: 100%; background: #000; overflow: hidden } video { width: 100%; height: 100%; object-fit: contain }</style>
<video id="v" muted playsinline></video>
<script src="seekref.js"></script>
<script>
// ?<paused|playing>@<file> (no & or comma: sway's exec runs it through sh -c and splits at commas)
const [mode, file] = decodeURIComponent(location.search.slice(1)).split('@');
const v = document.getElementById('v');
const say = (m) => { try { dump('SEEK ' + m + '\n'); } catch {} };
const W = 16, H = 9;
/** 16x9 blocks of mean luma (BT.601 weights on the RGB drawn). */
function blocks(src, w, h) {
  const c = new OffscreenCanvas(w, h), g = c.getContext('2d');
  g.drawImage(src, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data, sum = new Float64Array(W * H), n = new Float64Array(W * H);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const k = 4 * (y * w + x), b = Math.floor(y * H / h) * W + Math.floor(x * W / w);
    sum[b] += 0.299 * d[k] + 0.587 * d[k + 1] + 0.114 * d[k + 2]; n[b]++;
  }
  return Array.from(sum, (s, b) => s / n[b]);
}
const diff = (a, b) => a.reduce((t, x, k) => t + Math.abs(x - b[k]), 0) / a.length;
const img = (src) => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error(src)); i.src = src; });
const event = (name) => new Promise((ok) => v.addEventListener(name, ok, { once: true }));
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
async function seek(t) {
  const t0 = performance.now(), done = event('seeked');
  v.currentTime = t;
  await done;
  return performance.now() - t0;
}
async function paused(times) {
  for (const t of times) {
    const ms = await seek(t);
    await sleep(500);
    const shown = blocks(v, v.videoWidth, v.videoHeight);
    const refs = [];
    for (const [pts, file] of (REFS[String(t)] || [])) refs.push({ pts, diff: +diff(shown, blocks(await img(file), v.videoWidth, v.videoHeight)).toFixed(2) });
    refs.sort((a, b) => a.diff - b.diff);
    say('paused ' + JSON.stringify({ t, ms: +ms.toFixed(0), currentTime: v.currentTime, best: refs[0], next: refs[1], refs: refs.length }));
  }
}
async function playing(times) {
  await v.play();
  await sleep(2500);
  for (const t of times) {
    const q0 = v.getVideoPlaybackQuality();
    const ms = await seek(t);
    await sleep(2500);
    const q1 = v.getVideoPlaybackQuality();
    say('playing ' + JSON.stringify({ t, ms: +ms.toFixed(0), after: +(v.currentTime - t).toFixed(2), paused: v.paused, frames: q1.totalVideoFrames - q0.totalVideoFrames, dropped: q1.droppedVideoFrames - q0.droppedVideoFrames }));
  }
  v.pause();
}
v.addEventListener('error', () => say('error ' + (v.error && v.error.message)));
v.src = file;
event('loadeddata').then(async () => {
  say('loaded ' + v.videoWidth + 'x' + v.videoHeight + ' ' + v.duration);
  try {
    if (mode === 'paused') await paused(PAUSED_T);
    else await playing(PLAYING_T);
  } catch (e) { say('error ' + e); }
  say('done');
});
</script>`;

try {
  await rootShell();
  await run('mkdir -p /mnt/media && mount -o ro /dev/vdb /mnt/media; ls /mnt/media | tr "\\n" " "');
  for (const clip of CLIPS) {
    const keys = await run(`ffprobe -v error -select_streams v -show_entries packet=pts_time,flags -of csv=p=0 /mnt/media/${clip} | awk -F, '$2 ~ /K/ {printf "%.2f ", $1}' | cut -c1-600`, 120_000);
    log(clip, 'key pictures at', keys);
    (results[clip] ??= {} as Record<string, unknown>) && Object.assign(results[clip] as object, { keys });
  }

  if (PHASES.includes('ffmpeg')) {
    for (const clip of CLIPS) {
      await pasteSerial(`cat > /tmp/seek.txt <<'EOF'\nffconcat version 1.0\n${times(clip).segments.map(([a, b]) => `file /mnt/media/${clip}\ninpoint ${a}\noutpoint ${b}`).join('\n')}\nEOF`);
      const md5 = (hw: boolean) => `ffmpeg -nostdin -hide_banner -loglevel error ${hw ? '-hwaccel vaapi -hwaccel_device /dev/dri/renderD128 ' : ''}-stream_loop 1 -f concat -safe 0 -i /tmp/seek.txt -an -pix_fmt yuv420p -f framemd5 - 2>/tmp/err-${hw ? 'hw' : 'sw'}.txt | grep -v '^#' | awk -F, '{print $6}' > /tmp/${hw ? 'hw' : 'sw'}.md5`;
      await run(`cd /tmp; ${md5(false)}; wc -l < /tmp/sw.md5`, 300_000);
      const v0 = await video();
      const timing = await run(`cd /tmp; (TIMEFORMAT='time %R s user %U s sys %S s'; time ${md5(true)}) 2>&1 | tail -1`, 300_000);
      const v1 = await video();
      const compare = await run(`echo frames $(wc -l < /tmp/hw.md5) of $(wc -l < /tmp/sw.md5), equal $(paste -d' ' /tmp/sw.md5 /tmp/hw.md5 | awk '$1==$2' | wc -l), differing $(paste -d' ' /tmp/sw.md5 /tmp/hw.md5 | awk '$1!=$2{printf "%d ", NR}' | cut -c1-200); head -c 300 /tmp/err-hw.txt`);
      const r = { compare, timing, video: delta(v0, v1), warnings: [...s.warnings.entries()].slice(0, 10) };
      Object.assign(results[clip] as object, { ffmpeg: r });
      log(clip, 'ffmpeg', r);
      save();
    }
  }

  if (PHASES.includes('paused') || PHASES.includes('playing')) {
    // FFmpeg's software frames around each paused seek (PNGs, named in order; their times from showinfo) and the list
    // the page reads (seekref.js: REFS[t] = [[pts, file], ...]), per clip.
    await pasteSerial(`cat > /home/alarm/seek.html <<'EOF'\n${SEEK_HTML}\nEOF`);
    await pasteSerial(String.raw`mkdir -p /home/alarm/ffseek; cat > /home/alarm/ffseek/user.js <<'EOF'
user_pref("browser.dom.window.dump.enabled", true);
user_pref("media.autoplay.default", 0);
user_pref("media.autoplay.blocking_policy", 0);
user_pref("security.fileuri.strict_origin_policy", false);
user_pref("browser.aboutwelcome.enabled", false);
user_pref("browser.startup.homepage_override.mstone", "ignore");
user_pref("datareporting.policy.dataSubmissionPolicyBypassNotification", true);
user_pref("browser.shell.checkDefaultBrowser", false);
EOF
cat > /root/ff.sh <<'EOF'
ffkill() { pkill -x firefox; for i in $(seq 60); do pgrep -x firefox >/dev/null || return 0; sleep 1; done; pkill -9 -x firefox; sleep 2; }
ffrun() { rm -f /tmp/ff-$2.log; su alarm -c "swaymsg -s $(ls /run/user/1000/sway-ipc.*.sock) exec 'firefox --profile /home/alarm/ffseek --kiosk $1 > /tmp/ff-$2.log 2>&1'" >/dev/null; }
ffwait() { for i in $(seq 360); do grep -q -E "SEEK (done|error)" /tmp/ff-$1.log 2>/dev/null && { echo finished; return; }; sleep 0.5; done; echo timeout; grep -a -v -E "Tranche|Feedback|format 0x" /tmp/ff-$1.log | tail -5 | cut -c1-200; }
EOF
chown -R alarm:alarm /home/alarm/ffseek /home/alarm/seek.html`);
    results.sway = await s.startSway('gles2');
    log('sway', results.sway);
    for (const clip of CLIPS) {
      const refs: string[] = [];
      const { paused: PAUSED, playing: PLAYING } = times(clip);
      for (const t of PAUSED) {
        const dir = `/home/alarm/ref/${clip}/${t}`;
        await run(`rm -rf ${dir}; mkdir -p ${dir}; ffmpeg -nostdin -v info -copyts -ss ${Math.max(0, t - 1)} -t 1.3 -i /mnt/media/${clip} -an -vf "select='between(t,${t - 0.1},${t + 0.1})',showinfo" -fps_mode passthrough ${dir}/%02d.png 2>&1 | grep -o 'pts_time:[0-9.]*' | cut -d: -f2 > ${dir}/pts; wc -l < ${dir}/pts`, 120_000);
        refs.push(`REFS["${t}"] = [${(await run(`awk '{printf "[%s, \\"file://${dir}/%02d.png\\"], ", $1, NR}' ${dir}/pts`)).trim()}];`);
      }
      const tag = clip.replace(/\W/g, '-');
      await pasteSerial(`cat > /home/alarm/seekref.js <<'EOF'\nconst REFS = {};\n${refs.join('\n')}\nconst PAUSED_T = ${JSON.stringify(PAUSED)}, PLAYING_T = ${JSON.stringify(PLAYING)};\nEOF\nchown -R alarm:alarm /home/alarm/seekref.js /home/alarm/ref`);
      for (const mode of ['paused', 'playing'].filter((m) => PHASES.includes(m))) {
        await run('. /root/ff.sh; ffkill', 120_000);
        const v0 = await video();
        await run(`. /root/ff.sh; ffrun "file:///home/alarm/seek.html?${mode}@/mnt/media/${clip}" ${tag}-${mode}`);
        const finished = await run(`. /root/ff.sh; ffwait ${tag}-${mode}`, 240_000);
        const v1 = await video();
        const lines = (await runLines(`grep -a "^SEEK" /tmp/ff-${tag}-${mode}.log`)).map((l) => l.replace(/^SEEK /, ''));
        const seeks = lines.filter((l) => l.startsWith(`${mode} `)).map((l) => JSON.parse(l.slice(mode.length + 1)));
        const r = { finished, lines: lines.filter((l) => !l.startsWith(`${mode} `)), seeks, video: delta(v0, v1), warnings: [...s.warnings.entries()].slice(0, 10) };
        Object.assign(results[clip] as object, { [mode]: r });
        log(clip, mode, JSON.stringify(r, null, 1));
        await page.locator('#screen').screenshot({ path: `${out}/${tag}-${mode}.png` });
        save();
      }
    }
    await run('. /root/ff.sh; ffkill', 120_000);
  }
  if (capture) {
    // The records concatenated, as base64 (a page hands strings back quickly, arrays of numbers slowly).
    const b64 = await page.evaluate(() => {
      let t = '';
      for (const r of (window as unknown as { __virglCapture?: Uint8Array[] }).__virglCapture ?? []) for (let k = 0; k < r.length; k += 8192) t += String.fromCharCode(...r.subarray(k, k + 8192));
      return btoa(t);
    });
    writeFileSync(`${out}/capture.vglt`, encodeTrace([new Uint8Array(Buffer.from(b64, 'base64'))]));
  }
} finally {
  save();
  await s.close?.();
}
log('done', out);
process.exit(0);
