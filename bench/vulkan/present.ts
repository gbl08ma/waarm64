// VK3 L1: what Venus presents on the page's screen, against the guest's own frames (bench/vulkan/REPORT.md "VK3 L1";
// web/venus-share.ts). The desktop guest (images/arch/desktop.sh) on a machine with Vulkan, sway on GLES (virgl), the
// media disk (bench/video/media-disk.sh) as its second disk; one session a way of WAYS (`auto`: the page's choice and
// its run-time check; `bitmap`, `canvas`, `readback`: that way forced, `?gpu=vk<way>`), each:
//   vkcube   in sway's window (Vulkan's WSI image shared into virgl): the page's screen (as it draws it) against what
//            vkcube draws, its clear colour (0.2: grey 51) over most of the window and its cube's colours;
//   mpv      Sintel's trailer paused at 20 s fullscreen on Vulkan (gpu-next): mpv's own screenshot of its window (what
//            its VO drew, read back through Venus inside the guest) against the page's screen, each picture's box
//            (black borders cropped: mpv's own screenshot is scaled, its VO on Venus draws the frame unscaled) brought
//            to 64×36 (the channels' mean difference; the page's screen black is the failure looked for).
// Records the way the page took and where its check stands (web/gpu-worker.ts render stats `share`), and its warnings.
//   node bench/vulkan/present.ts [image] [outdir]   (default target/arch/desktop.qcow2; bench/gpu/sway-mac.sh runs it
//   with SCRIPT=../vulkan/present.ts, mode `-`)
// WAYS (default "auto bitmap canvas readback"; a GPU way where the page renders in software is skipped: a WebGPU canvas
// there loses the page's GPU channel), GPU_KNOBS (more of `?gpu=`, comma-separated, e.g. `vkvendor=nvidia`,
// `vkbreak=bitmap`), SCREEN (default 1280x720), SHIM=1 (the media disk's VA driver: mpv decodes with VA-API).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { openSession } from '../gpu/guest-session.ts';

const args = process.argv.slice(2);
const out = args.at(-1) ?? new URL('../results/local/vk3/present/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const image = (args.length > 1 ? args[0] : process.env.IMAGE) ?? new URL('../../target/arch/desktop.qcow2', import.meta.url).pathname;
const WAYS = (process.env.WAYS ?? 'auto bitmap canvas readback').split(/\s+/).filter(Boolean);
const KNOBS = process.env.GPU_KNOBS ? `,${process.env.GPU_KNOBS}` : '';
const SCREEN = process.env.SCREEN || '1280x720';
const MPV = `--vo=gpu-next --gpu-api=vulkan ${process.env.SHIM ? '--hwdec=vaapi' : '--hwdec=no'}`;
// The guest's and the page's pictures are compared at this size (fullscreen both: the same picture, scaled).
const W = 64, H = 36;
const results: Record<string, unknown> = { ways: WAYS, knobs: KNOBS.slice(1), screen: SCREEN, mpv: MPV };
const save = () => writeFileSync(`${out}/results.json`, JSON.stringify(results, null, 1));

type Shot = { w: number; h: number; grey: number; colours: number; mean: number; box: string; small: number[] };
/**
 * The page's screen as it draws it (`window.__webpcGrab`, web/app/main.ts: a Playwright screenshot waits for a
 * compositor frame, which SwiftShader's busy GPU process may not give for minutes), written to `file` as a PNG: the
 * share of vkcube's clear grey, the colours (6 bits a channel), the mean, and the picture's box (what is brighter than
 * 24) at W×H (RGB).
 */
async function grabScreen(page: import('playwright-core').Page, file: string): Promise<Shot> {
  const r = await page.evaluate(async ([w, h]) => {
    const g = await (window as unknown as { __webpcGrab: () => Promise<{ width: number; height: number; pixels: Uint8Array }> }).__webpcGrab();
    if (!g.width) throw new Error('the screen has no scanout');
    const d = g.pixels;
    let grey = 0, sum = 0;
    const colours = new Set<number>();
    for (let i = 0; i < d.length; i += 4) {
      if (Math.abs(d[i] - 51) <= 3 && Math.abs(d[i + 1] - 51) <= 3 && Math.abs(d[i + 2] - 51) <= 3) grey++;
      colours.add((d[i] >> 2) << 12 | (d[i + 1] >> 2) << 6 | d[i + 2] >> 2);
      sum += d[i] + d[i + 1] + d[i + 2];
    }
    const full = new OffscreenCanvas(g.width, g.height), fx = full.getContext('2d')!;
    const img = new ImageData(g.width, g.height);
    img.data.set(d);
    for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
    fx.putImageData(img, 0, 0);
    const s = new OffscreenCanvas(w, h), sx = s.getContext('2d')!;
    sx.imageSmoothingQuality = 'high';
    // The picture's box: rows and columns with a pixel brighter than 24 (mpv's letterbox and its unscaled frame cropped).
    let x0 = g.width, y0 = g.height, x1 = -1, y1 = -1;
    for (let y = 0; y < g.height; y++) for (let x = 0; x < g.width; x++) {
      const i = (y * g.width + x) * 4;
      if (Math.max(d[i], d[i + 1], d[i + 2]) > 24) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    }
    if (x1 >= 0) sx.drawImage(full, x0, y0, x1 - x0 + 1, y1 - y0 + 1, 0, 0, w, h);
    const sd = sx.getImageData(0, 0, w, h).data, small: number[] = [];
    for (let i = 0; i < sd.length; i += 4) small.push(sd[i], sd[i + 1], sd[i + 2]);
    const png = new Uint8Array(await (await full.convertToBlob({ type: 'image/png' })).arrayBuffer());
    let bin = '';
    for (let i = 0; i < png.length; i += 0x8000) bin += String.fromCharCode(...png.subarray(i, i + 0x8000));
    const n = d.length / 4;
    return { w: g.width, h: g.height, grey: +(grey / n).toFixed(3), colours: colours.size, mean: +(sum / n / 3).toFixed(1), box: x1 >= 0 ? `${x1 - x0 + 1}x${y1 - y0 + 1}+${x0}+${y0}` : 'none', small, png: btoa(bin) };
  }, [W, H] as const);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, Buffer.from(r.png, 'base64'));
  const { png: _, ...shot } = r;
  return shot;
}

for (const way of WAYS) {
  const r: Record<string, unknown> = {};
  results[way] = r;
  const s = await openSession({ gpu: `virgl,vulkan${way === 'auto' ? '' : `,vk${way}`}${KNOBS}`, image, out: `${out}/${way}`, ncpus: 4, ramMiB: 4096, disk2: '/target/video/media.ext4', screen: SCREEN });
  const { page, run, asUser } = s;
  /** The page's share state now (the last render stats' `share`). */
  const share = () => page.evaluate(() => ((window as unknown as { __renderStats?: { share?: unknown }[] }).__renderStats ?? []).at(-1)?.share ?? null);
  try {
    r.gl = s.gl;
    r.chromium = s.browser.version();
    if (way !== 'auto' && way !== 'readback' && /SwiftShader|llvmpipe/i.test(s.gl) && !KNOBS.includes('vkbreak')) {
      r.skipped = 'the page renders in software: a WebGPU canvas would lose its GPU channel';
      s.log(way, r.skipped);
      continue;
    }
    await s.rootShell();
    await run('mkdir -p /mnt/media && mount -o ro /dev/vdb /mnt/media');
    if (process.env.SHIM) await run('cp /mnt/media/webpc_drv_video.so /usr/lib/dri/');
    r.info = await run('pacman -Q mesa vulkan-virtio mpv libplacebo vulkan-tools sway | tr "\\n" " "');
    r.sway = await s.startSway('gles2');
    s.log(way, 'sway', r.sway);

    // vkcube: left 10 s (sway's window opened, frames coming), then the page's screen.
    await run(asUser('(vkcube --wsi wayland > /tmp/vkcube.log 2>&1 &)'));
    s.log(way, 'vkcube started');
    await page.waitForTimeout(10_000);
    const c = await grabScreen(page, `${out}/${way}/vkcube.png`);
    r.vkcube = { grey: c.grey, colours: c.colours, mean: c.mean, size: `${c.w}x${c.h}`, ok: c.grey >= 0.3 && c.colours >= 50, log: (await run('head -c 300 /tmp/vkcube.log')).trim() };
    r.shareAfterVkcube = await share();
    s.log(way, 'vkcube', JSON.stringify(r.vkcube), JSON.stringify(r.shareAfterVkcube));
    await run('pkill -9 -x vkcube; sleep 1');

    // mpv: its own screenshot of the paused frame 10 s after the start (the seek done, the frame shown), then the page's.
    await s.pasteSerial(`cat > /home/arch/shot.lua <<'EOF'
mp.add_timeout(10, function() mp.commandv("screenshot-to-file", "/tmp/mpv.png", "window") end)
EOF
chmod 644 /home/arch/shot.lua; rm -f /tmp/mpv.png`);
    await run(asUser(`(timeout -k 5 120 mpv --start=20 --pause --fs --osc=no --osd-level=0 --ao=null --script=/home/arch/shot.lua ${MPV} /mnt/media/sintel_trailer-480p.mp4 > /tmp/mpv.log 2>&1 &)`));
    let shot = false;
    for (let i = 0; i < 40 && !shot; i++) {
      await page.waitForTimeout(2000);
      shot = (await run('[ -s /tmp/mpv.png ] && echo yes || echo no')).includes('yes');
    }
    await page.waitForTimeout(2000);
    const p = await grabScreen(page, `${out}/${way}/mpv.png`);
    r.shareAfterMpv = await share();
    if (shot) {
      // The same box in mpv's own picture (ffmpeg's cropdetect at the same threshold), at W×H.
      const crop = (await run('echo "$(ffmpeg -loglevel info -i /tmp/mpv.png -vf cropdetect=limit=24:round=1:reset=0:skip=0 -f null - 2>&1 | grep -o "crop=[0-9:]*" | tail -1) $(ffprobe -v error -show_entries stream=width,height -of csv=p=0 /tmp/mpv.png)"')).trim().split(/\s+/);
      const hex = (await s.runLines(`ffmpeg -loglevel error -i /tmp/mpv.png -vf ${crop[0]?.startsWith('crop=') ? `${crop[0]},` : ''}scale=${W}:${H}:flags=area -f rawvideo -pix_fmt rgb24 - | od -An -v -tx1 -w48 | tr -d ' '`, 120_000)).join('');
      const g = Buffer.from(hex, 'hex');
      let diff = 0, gmean = 0;
      for (let i = 0; i < g.length; i++) { diff += Math.abs(g[i] - (p.small[i] ?? 0)); gmean += g[i]; }
      const meanDiff = +(diff / g.length).toFixed(1);
      gmean = +(gmean / g.length).toFixed(1);
      // Right: close to mpv's own picture (scaling and sway's output differ by a few levels); black: the page's screen dark where mpv's isn't.
      r.mpv = { guest: crop.join(' '), page: `${p.w}x${p.h} ${p.box}`, guestMean: gmean, pageMean: p.mean, meanDiff, bytes: g.length, ok: g.length === W * H * 3 && gmean > 10 && meanDiff < 16, black: p.mean < 5 && gmean > 10 };
    } else r.mpv = { error: `mpv took no screenshot: ${(await run('tail -c 400 /tmp/mpv.log')).trim()}`, pageMean: p.mean };
    r.mpvLog = (await run('grep -E "Using hardware|VO:|Failed|rror" /tmp/mpv.log | head -5 | cut -c1-200')).trim();
    s.log(way, 'mpv', JSON.stringify(r.mpv), JSON.stringify(r.shareAfterMpv));
    await run('pkill -9 -x mpv; true');
  } catch (err) {
    r.error = String(err);
    s.log(way, 'failed', String(err));
  } finally {
    r.warnings = Object.fromEntries(s.warnings);
    save();
    await s.close();
  }
}
save();
