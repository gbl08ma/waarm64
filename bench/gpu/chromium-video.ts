// A video in the guest's Chromium (dev-only, not in tests): the desktop image, sway on 3D, Chromium in kiosk mode on a
// page that plays a clip from the media disk (bench/video/media-disk.sh, /dev/vdb) decoded on the host through
// waarm64-va. Each second the page logs the video frames it presented (requestVideoFrameCallback), its own animation
// frames and getVideoPlaybackQuality's totals to Chromium's stderr; the host records the page's display and video
// stats over the same phases.
//   node bench/gpu/chromium-video.ts <image.qcow2> [outdir]
// VIDEO the clip on the media disk (sintel_trailer-480p.mp4), VIRGL_GPU the page's `?gpu=` (virgl), CR_FLAGS more
// flags for the guest's Chromium, WARM_S (15), PHASES (3) of PHASE_S (10). CAPTURE=1 saves the session's virgl
// capture as <outdir>/capture.vglt (bench/video/pictures.ts makes the host's streams of it; keep the run short).
import { mkdirSync, writeFileSync } from 'node:fs';
import { encodeTrace } from '../../web/virgl-trace.ts';
import { GUEST_USER, openSession } from './guest-session.ts';

const HOME = `/home/${GUEST_USER}`;
const image = process.argv[2];
if (!image) throw new Error('usage: node bench/gpu/chromium-video.ts <image.qcow2> [outdir]');
const capture = !!process.env.CAPTURE;
const gpu = `${process.env.VIRGL_GPU ?? 'virgl'}${capture ? ',capture' : ''}`;
const video = process.env.VIDEO ?? 'sintel_trailer-480p.mp4';
const out = process.argv[3] ?? new URL(`../results/local/chromium-video/${gpu.replace(/,/g, '-')}-${video}/`, import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const WARM_S = Number(process.env.WARM_S ?? 15), PHASES = Number(process.env.PHASES ?? 3), PHASE_S = Number(process.env.PHASE_S ?? 10);

const PAGE = `<!doctype html><html><head><style>
body { margin: 0; background: #202020; overflow: hidden; }
video { position: absolute; left: 100px; top: 100px; width: 854px; }
</style></head><body>
<video id="v" src="file:///mnt/${video}" autoplay muted loop></video>
<script>
const v = document.getElementById('v');
let vf = 0, raf = 0, t0 = performance.now();
const onVf = () => { vf++; v.requestVideoFrameCallback(onVf); };
v.requestVideoFrameCallback(onVf);
const tick = () => { raf++; requestAnimationFrame(tick); };
requestAnimationFrame(tick);
setInterval(() => {
  const q = v.getVideoPlaybackQuality();
  console.log('VSTAT ' + JSON.stringify({ t: Math.round(performance.now() - t0), vf, raf, total: q.totalVideoFrames, dropped: q.droppedVideoFrames, ct: +v.currentTime.toFixed(2) }));
  vf = 0; raf = 0;
}, 1000);
</script></body></html>
`;

const s = await openSession({ gpu, image, out, query: process.env.QUERY, disk2: '/target/video/media.ext4' });
const { log, pasteSerial, rootShell, run } = s;
const results: Record<string, unknown> = { gpu, video, chromium: s.browser.version(), gl: s.gl, flags: process.env.CR_FLAGS ?? '' };
await rootShell();
await run('mount -o ro /dev/vdb /mnt; ls /mnt | head -3');
await pasteSerial(`cat > ${HOME}/video.html <<'EOF'\n${PAGE}EOF`);
results.info = await run(`chown ${GUEST_USER}: ${HOME}/video.html; uname -r; pacman -Q chromium mesa sway waarm64-va 2>&1 | tr "\\n" " "`);
log('info', results.info);
results.sway = await s.startSway('gles2');
log('sway', results.sway);
await run(s.asUser(`swaymsg exec 'chromium --no-first-run --password-store=basic --user-data-dir=/tmp/crvideo --autoplay-policy=no-user-gesture-required --enable-logging=stderr --kiosk ${process.env.CR_FLAGS ?? ''} file://${HOME}/video.html > /tmp/chromium.log 2>&1' >/dev/null`));
const t0 = Date.now();
for (;;) {
  await s.page.waitForTimeout(3000);
  if (Number(await run('grep -c VSTAT /tmp/chromium.log')) > 2) break;
  if (Date.now() - t0 > 300_000) throw new Error('the page never logged');
}
results.startS = (Date.now() - t0) / 1000;
log('playing', results.startS, 's');
await s.page.waitForTimeout(WARM_S * 1000);
await s.display();
const phases = [];
for (let p = 0; p < PHASES; p++) {
  await run(': > /tmp/vstat.mark; grep -c VSTAT /tmp/chromium.log > /tmp/vstat.n');
  await s.page.waitForTimeout(PHASE_S * 1000);
  const d = await s.display();
  const lines = await s.runLines('tail -n +$(( $(cat /tmp/vstat.n) + 1 )) /tmp/chromium.log | grep -o "VSTAT {[^}]*}" | cut -c7-');
  const vs = lines.map((l) => { try { return JSON.parse(l) as { vf: number; raf: number; total: number; dropped: number; ct: number }; } catch { return undefined; } }).filter((x) => !!x);
  const ph = { pageVideoFps: vs.map((x) => x.vf), pageRafFps: vs.map((x) => x.raf), dropped: vs.length ? vs.at(-1)!.dropped - vs[0].dropped : 0, ct: vs.map((x) => x.ct), presents: d.renderer?.presents, video: d.renderer?.video, fences: d.fences, submits: d.submits };
  log(`phase ${p}`, JSON.stringify(ph));
  phases.push(ph);
}
results.phases = phases;
await s.page.screenshot({ path: `${out}/screen.png` });
if (capture) {
  // The records concatenated, as base64 (a page hands strings back quickly, arrays of numbers slowly).
  const b64 = await s.page.evaluate(() => {
    let t = '';
    for (const r of (window as unknown as { __virglCapture?: Uint8Array[] }).__virglCapture ?? []) for (let k = 0; k < r.length; k += 8192) t += String.fromCharCode(...r.subarray(k, k + 8192));
    return btoa(t);
  });
  writeFileSync(`${out}/capture.vglt`, encodeTrace([new Uint8Array(Buffer.from(b64, 'base64'))]));
}
results.log = await s.runLines('grep -v VSTAT /tmp/chromium.log | grep -i -E "vaapi|error|fail" | sort | uniq -c | sort -rn | head -15');
if (s.debugLines.length) writeFileSync(`${out}/debug.txt`, s.debugLines.join('\n'));
writeFileSync(`${out}/results.json`, JSON.stringify({ ...results, warnings: Object.fromEntries(s.warnings), debug: s.debugLines.slice(-400) }, null, 1));
log('warnings', JSON.stringify(Object.fromEntries(s.warnings)));
await s.close();
