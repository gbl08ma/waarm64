// The video track's V1 end check (docs/plans/video.md §5; dev-only, not in tests): the desktop guest
// (images/arch/desktop.sh, with webpc-va) on the page, whose 3D machine decodes VA-API with WebCodecs. The guest's
// FFmpeg decodes each clip twice, in software and through VA-API with the pictures downloaded (`vaDeriveImage`: a read
// of the planes, which waits for the host's decode), and compares the frames' hashes (framemd5): equal where the
// host's decoder is exact (VP9 everywhere; H.264 on FFmpeg's or a hardware decoder, not the dev VM's OpenH264). Also
// the renderer's video totals (pictures decoded, dropped) and the longest a call waited for a picture.
//   node bench/video/v1.ts <image.qcow2> [outdir]      (default bench/results/local/video/v1/)
// FRAMES (default 120), CLIPS (default both trailers), HWDEC (default vaapi; FFmpeg's -hwaccel), VIRGL_GPU (the page's
// `?gpu=`, default virgl; e.g. virgl,swvideo). SHIM=1: the media disk's webpc_drv_video.so as the guest's VA driver. SNAPSHOT=1 then tries Save snapshot while FFmpeg decodes a clip through
// VA-API at its own pace (refused: its codec is 3D in use) and again once FFmpeg has exited (saved, the file dropped).
// CAPTURE=1 saves the session's virgl capture as <outdir>/capture.vglt (bench/video/pictures.ts makes the host's
// streams of it).
import { mkdirSync, writeFileSync } from 'node:fs';
import { encodeTrace } from '../../web/virgl-trace.ts';
import { openSession } from '../gpu/guest-session.ts';

const image = process.argv[2];
if (!image) throw new Error('usage: node bench/video/v1.ts <image.qcow2> [outdir]');
const out = process.argv[3] ?? new URL('../results/local/video/v1/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const FRAMES = Number(process.env.FRAMES ?? 120);
const CLIPS = (process.env.CLIPS ?? 'sintel_trailer-480p.mp4,sintel.webm').split(',');

const capture = !!process.env.CAPTURE;
const s = await openSession({ gpu: `${process.env.VIRGL_GPU ?? 'virgl'}${capture ? ',capture' : ''}`, image, out, disk2: '/target/video/media.ext4' });
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

/** Save snapshot on the page: the message it ends with, and the file's size if one was downloaded (then deleted). */
async function saveSnapshot() {
  const before = await page.evaluate(() => document.getElementById('message-text')?.textContent ?? '');
  const download = page.waitForEvent('download', { timeout: 600_000 }).catch(() => null);
  await page.locator('#save-snapshot').click();
  await page.waitForFunction((b) => { const t = document.getElementById('message-text')?.textContent ?? ''; return t !== b && /^Saved the snapshot|no file was saved/.test(t); }, before, { timeout: 600_000, polling: 250 });
  const message = await page.evaluate(() => (document.getElementById('message-text')?.textContent ?? ''));
  let bytes: number | undefined;
  if (message.startsWith('Saved')) {
    const d = await download;
    bytes = d ? (await import('node:fs')).statSync((await d.path())!).size : undefined;
    await d?.delete();
  }
  return { message, bytes };
}

async function snapshots() {
  const clip = CLIPS[0];
  await run(`(ffmpeg -nostdin -hide_banner -loglevel error -re -hwaccel vaapi -hwaccel_device /dev/dri/renderD128 -i /mnt/media/${clip} -t 20 -an -f null - > /tmp/snap-ff.txt 2>&1; echo ffmpeg-exit $? >> /tmp/snap-ff.txt) < /dev/null & true`);
  await page.waitForTimeout(5000);
  const during = { ...await saveSnapshot(), decoded: (await video()).decoded };
  log('snapshot while decoding', during);
  await run('while pgrep -x ffmpeg > /dev/null; do sleep 1; done; cat /tmp/snap-ff.txt', 120_000);
  const after = await saveSnapshot();
  log('snapshot after the player exited', after);
  return { during, after };
}

try {
  await rootShell();
  await run('mkdir -p /mnt/media && mount -o ro /dev/vdb /mnt/media; ls /mnt/media | tr "\\n" " "');
  // SHIM=1: the VA driver on the media disk (bench/video/media-disk.sh) instead of the image's webpc-va.
  if (process.env.SHIM === '1') await run('cp /mnt/media/webpc_drv_video.so /usr/lib/dri/');
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
    const cmp = await run(`echo frames $(wc -l < /tmp/hw.md5) of $(wc -l < /tmp/sw.md5), equal $(paste -d' ' /tmp/sw.md5 /tmp/hw.md5 | awk '$1==$2' | wc -l), first differing $(paste -d' ' /tmp/sw.md5 /tmp/hw.md5 | awk '$1!=$2{print NR; exit}'); paste -d' ' /tmp/sw.md5 /tmp/hw.md5 | awk '{printf ($1==$2) ? "=" : "x"}' | cut -c1-240; echo; head -c 300 /tmp/err-hw.txt`);
    const r = { compare: cmp, timing, ms, decoded: after.decoded - before.decoded, dropped: after.dropped - before.dropped, errors: after.errors - before.errors, ahead: after.ahead - before.ahead, maxWaitMs: after.maxWaitMs, warnings: [...s.warnings.entries()].slice(0, 10) };
    results[clip] = r;
    log(clip, r);
    save();
  }
  if (process.env.SNAPSHOT === '1') results.snapshot = await snapshots();
  // `?gpu=...,debug`: the renderer's video lines (codecs, buffers, decoders).
  if (s.debugLines.length) results.debug = s.debugLines.filter((l) => l.startsWith('video')).slice(0, 400);
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
process.exit(0);
