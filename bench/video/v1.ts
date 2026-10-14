// The video track's V1 end check (docs/plans/video.md §5; dev-only, not in tests): the desktop guest
// (images/archarm/desktop.sh, with webpc-va) on the page, whose 3D machine decodes VA-API with WebCodecs. The guest's
// FFmpeg decodes each clip twice, in software and through VA-API with the pictures downloaded (`vaDeriveImage`: a read
// of the planes, which waits for the host's decode), and compares the frames' hashes (framemd5): equal where the
// host's decoder is exact (VP9 everywhere; H.264 on FFmpeg's or a hardware decoder, not the dev VM's OpenH264). Also
// the renderer's video totals (pictures decoded, dropped) and the longest a call waited for a picture.
//   node bench/video/v1.ts <image.qcow2> [outdir]      (default bench/results/local/video/v1/)
// FRAMES (default 120), CLIPS (default both trailers), HWDEC (default vaapi; FFmpeg's -hwaccel), VIRGL_GPU (the page's
// `?gpu=`, default virgl; e.g. virgl,swvideo).
import { mkdirSync, writeFileSync } from 'node:fs';
import { openSession } from '../gpu/guest-session.ts';

const image = process.argv[2];
if (!image) throw new Error('usage: node bench/video/v1.ts <image.qcow2> [outdir]');
const out = process.argv[3] ?? new URL('../results/local/video/v1/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const FRAMES = Number(process.env.FRAMES ?? 120);
const CLIPS = (process.env.CLIPS ?? 'sintel_trailer-480p.mp4,sintel.webm').split(',');

const s = await openSession({ gpu: process.env.VIRGL_GPU ?? 'virgl', image, out, disk2: '/target/video/media.ext4' });
const { page, log, rootShell, run } = s;
const results: Record<string, unknown> = { gl: s.gl, chromium: s.browser.version(), frames: FRAMES };
const save = () => writeFileSync(`${out}/results.json`, JSON.stringify(results, null, 1));
type Video = { frames: number; decoded: number; dropped: number; errors: number; ahead: number; maxWaitMs: number };
/** The renderer's video totals, and the longest wait for a picture in the seconds since the last call. */
const video = async () => {
  const r = await page.evaluate(() => ((window as unknown as { __renderStats?: { video?: Video }[] }).__renderStats ?? []).slice(-30).map((x) => x.video));
  const last = r.at(-1);
  return { frames: last?.frames ?? 0, decoded: last?.decoded ?? 0, dropped: last?.dropped ?? 0, errors: last?.errors ?? 0, ahead: last?.ahead ?? 0, maxWaitMs: Math.max(0, ...r.map((v) => v?.maxWaitMs ?? 0)) };
};

try {
  await rootShell();
  await run('mkdir -p /mnt/media && mount -o ro /dev/vdb /mnt/media; ls /mnt/media | tr "\\n" " "');
  results.info = await run('uname -r; pacman -Q mesa libva ffmpeg webpc-va | tr "\\n" " "; echo; grep -h LIBVA /etc/environment.d/*');
  log('info', results.info);
  results.vainfo = await run('vainfo --display drm --device /dev/dri/renderD128 2>&1 | grep -E "driver|VAProfile"', 120_000);
  log('vainfo\n' + results.vainfo);
  for (const clip of CLIPS) {
    const md5 = (hw: boolean) => `ffmpeg -hide_banner -loglevel error ${hw ? `-hwaccel ${process.env.HWDEC ?? 'vaapi'} -hwaccel_device /dev/dri/renderD128 ` : ''}-i /mnt/media/${clip} -frames:v ${FRAMES} -an -pix_fmt yuv420p -f framemd5 - 2>/tmp/err-${hw ? 'hw' : 'sw'}.txt | grep -v '^#' | awk -F, '{print $6}' > /tmp/${hw ? 'hw' : 'sw'}.md5`;
    await run(`cd /tmp; ${md5(false)}; wc -l < /tmp/sw.md5`, 300_000);
    const before = await video();
    const t0 = Date.now();
    const timing = await run(`cd /tmp; (TIMEFORMAT='time %R s user %U s sys %S s'; time ${md5(true)}) 2>&1 | tail -1`, 300_000);
    const ms = Date.now() - t0;
    await page.waitForTimeout(2500); // the next render-stats
    const after = await video();
    const cmp = await run(`echo frames $(wc -l < /tmp/hw.md5) of $(wc -l < /tmp/sw.md5), equal $(paste -d' ' /tmp/sw.md5 /tmp/hw.md5 | awk '$1==$2' | wc -l), first differing $(paste -d' ' /tmp/sw.md5 /tmp/hw.md5 | awk '$1!=$2{print NR; exit}'); head -c 300 /tmp/err-hw.txt`);
    const r = { compare: cmp, timing, ms, decoded: after.decoded - before.decoded, dropped: after.dropped - before.dropped, errors: after.errors - before.errors, ahead: after.ahead - before.ahead, maxWaitMs: after.maxWaitMs, warnings: [...s.warnings.entries()].slice(0, 10) };
    results[clip] = r;
    log(clip, r);
    save();
  }
} finally {
  save();
  await s.close?.();
}
process.exit(0);
