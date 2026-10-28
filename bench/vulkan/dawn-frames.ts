// VK3 L7.1: Dawn's row's program (bench/vulkan/REPORT.md "VK3 L7.1"). WebGPU samples (bench/vulkan/dawn/samples.html:
// a triangle, MSAA, a textured cube with depth, a compute pass's storage texture, sample-rate shading through
// `sample_index`) drawn once each and read back, by Dawn.
//   node bench/vulkan/dawn-frames.ts ref [outdir]     the reference: the dev VM's Chromium, its Dawn on lavapipe through
//                                                      Venus's advertised set (run it under bench/vulkan/profiles/run.sh)
//   node bench/vulkan/dawn-frames.ts guest [image] [outdir]   the desktop guest's Chromium (images/arch/desktop.sh) on
//                                                      the page with Vulkan: its Dawn on Venus, the frames read back in
//                                                      the guest and shown on 2D canvases, grabbed from the page's screen
//   node bench/vulkan/dawn-frames.ts compare <ref.json> <guest.json>   each scene's bytes off by more than 24
// Each run writes <outdir>/frames.json: the adapter, the errors and each scene's RGBA bytes (256x256).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';

const root = new URL('../..', import.meta.url).pathname;
// PAGE=<file>: another page in place of the samples (VK3 L7.4: bench/vulkan/angle/es3.html, ANGLE's ES3 row).
const SAMPLES = readFileSync(process.env.PAGE ?? `${root}bench/vulkan/dawn/samples.html`, 'utf8');
const SCENES = ['triangle', 'msaa', 'cube', 'compute', 'samplerate'];
const S = 256;
type Frames = { adapter: string | null; errors: string[]; scenes: Record<string, number[]>; chromium?: string; presented?: number[] };

function compare(a: Frames, b: Frames) {
  const out: Record<string, unknown> = {};
  for (const name of SCENES) {
    const x = a.scenes[name], y = b.scenes[name];
    if (!x || !y || x.length !== y.length) { out[name] = 'missing'; continue; }
    let off24 = 0, max = 0, sum = 0;
    for (let i = 0; i < x.length; i++) {
      if ((i & 3) === 3) continue;
      const dd = Math.abs(x[i] - y[i]);
      sum += dd; max = Math.max(max, dd); if (dd > 24) off24++;
    }
    out[name] = { bytes: (x.length / 4) * 3, off24, share: +((off24 / ((x.length / 4) * 3)) * 100).toFixed(3), max, mean: +(sum / ((x.length / 4) * 3)).toFixed(3) };
  }
  return out;
}

const mode = process.argv[2];
if (mode === 'compare') {
  const a = JSON.parse(readFileSync(process.argv[3], 'utf8')) as Frames, b = JSON.parse(readFileSync(process.argv[4], 'utf8')) as Frames;
  console.log(JSON.stringify({ ref: a.adapter, guest: b.adapter, scenes: compare(a, b) }, null, 1));
} else if (mode === 'ref') {
  const out = process.argv[3] ?? `${root}bench/results/local/dawn/ref`;
  mkdirSync(out, { recursive: true });
  const server = createServer((_q, r) => { r.setHeader('content-type', 'text/html'); r.end(SAMPLES); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', env: process.env as Record<string, string>,
    args: (process.env.CHROMIUM_ARGS ?? '--enable-unsafe-webgpu --enable-features=Vulkan --use-vulkan=native --disable-gpu-sandbox').split(' ').filter(Boolean) });
  try {
    const page = await browser.newPage({ viewport: { width: 1376, height: 762 } });
    page.on('console', (m) => console.log(m.text()));
    await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/#nocanvas`);
    await page.waitForFunction(() => (window as unknown as { __dawn?: { done?: boolean } }).__dawn?.done, null, { timeout: 120_000 });
    const r = await page.evaluate(() => (window as unknown as { __dawn: Frames }).__dawn);
    await page.screenshot({ path: `${out}/screen.png` });
    writeFileSync(`${out}/frames.json`, JSON.stringify({ ...r, chromium: browser.version() }));
    console.log(JSON.stringify({ adapter: r.adapter, errors: r.errors, scenes: Object.keys(r.scenes) }));
  } finally {
    await browser.close();
    server.close();
  }
} else if (mode === 'guest') {
  const image = process.argv[3] && process.argv[3] !== '-' ? process.argv[3] : `${root}target/arch/desktop.qcow2`;
  const out = process.argv[4] ?? `${root}bench/results/local/dawn/guest`;
  mkdirSync(out, { recursive: true });
  const { openSession, GUEST_USER } = await import('../gpu/guest-session.ts');
  const HOME = `/home/${GUEST_USER}`;
  const s = await openSession({ gpu: `virgl,vulkan${process.env.GPU_KNOBS ? `,${process.env.GPU_KNOBS}` : ''}`, image, out, ncpus: 4, ramMiB: 4096 });
  const results: Record<string, unknown> = { chromium: s.browser.version(), gl: s.gl };
  // ARMS: the guest Chromium's flags, `|`-separated, one run each (the first whose Dawn draws is the result).
  const arms = (process.env.ARMS ?? '--enable-unsafe-webgpu --enable-features=Vulkan|--enable-unsafe-webgpu').split('|');
  try {
    await s.rootShell();
    await s.pasteSerial(`cat > ${HOME}/dawn.html <<'EOF_DAWN'\n${SAMPLES}\nEOF_DAWN`);
    results.info = (await s.run(`chown ${GUEST_USER}: ${HOME}/dawn.html; wc -c < ${HOME}/dawn.html; pacman -Q chromium mesa vulkan-virtio xorg-xwayland 2>&1 | tr "\\n" " "`)).trim();
    s.log('info', results.info);
    results.sway = await s.startSway('gles2');
    results.vulkan = (await s.run(s.asUser(`vulkaninfo 2>/dev/null | grep -E 'deviceName|sampleRateShading|shader(Uniform|Storage)(Buffer|Image)ArrayDynamicIndexing' | sort -u | tr -s ' \\t' ' ' | tr '\\n' ';'`))).trim();
    s.log('vulkan', results.vulkan);
    const runs: Record<string, unknown>[] = [];
    for (const [k, flags] of arms.entries()) {
      const dir = `/tmp/cr${k}`;
      // CR_ENV: the environment of every arm's Chromium (e.g. VK_LOADER_DEBUG=warn).
      await s.run(s.asUser(`swaymsg exec '${process.env.CR_ENV ? `env ${process.env.CR_ENV} ` : ''}chromium --no-first-run --password-store=basic --user-data-dir=${dir} --kiosk --enable-logging=stderr ${flags} file://${HOME}/dawn.html > /tmp/chromium${k}.log 2>&1' >/dev/null`));
      let lines = '';
      for (let t = 0; t < 90; t++) {
        await s.page.waitForTimeout(2000);
        lines = await s.run(`grep -o '"dawn: [^"]*"' /tmp/chromium${k}.log | tr '\\n' ' '`);
        if (/dawn: (done|no adapter|failed)/.test(lines)) break;
      }
      await s.page.waitForTimeout(3000);
      const run: Record<string, unknown> = { flags, log: lines.trim() };
      run.gpuLog = (await s.run(`grep -v CONSOLE /tmp/chromium${k}.log | grep -v -i -E 'dbus|mailbox' | sed 's/^\\[[0-9:/.]*//' | cut -c1-200 | sort | uniq -c | sort -rn | head -30`)).trim();
      // LOGBEFORE=<pattern>: the log's 40 lines up to the first that matches it too, in order (what came before a crash).
      if (process.env.LOGBEFORE) run.logBefore = (await s.run(`grep -v -E 'CONSOLE|mailbox' /tmp/chromium${k}.log | grep -m1 -B40 -E '${process.env.LOGBEFORE}' | sed 's/^\\[[0-9:/.]*//' | cut -c1-200`)).trim();
      // The screen as the page draws it: each scene's 2D canvas (the readback in the guest), and the WebGPU canvas.
      const g = await s.page.evaluate(async () => {
        const x = await (window as unknown as { __webpcGrab: () => Promise<{ width: number; height: number; pixels: Uint8Array }> }).__webpcGrab();
        return { width: x.width, height: x.height, pixels: Array.from(x.pixels) };
      });
      const crop = (x0: number, y0: number) => {
        const px: number[] = [];
        for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) { const o = ((y0 + y) * g.width + x0 + x) * 4; px.push(g.pixels[o], g.pixels[o + 1], g.pixels[o + 2], 255); }
        return px;
      };
      const frames: Frames = { adapter: (/dawn: adapter ([^|"]*)/.exec(lines)?.[1] ?? null), errors: [...lines.matchAll(/dawn: (error|[a-z]+ threw|failed) ([^"]*)/g)].map((m) => m[0]), scenes: {} };
      if (g.width >= 8 + 264 * SCENES.length) SCENES.forEach((name, i) => { if (new RegExp(`dawn: ${name} [0-9a-f]+`).test(lines)) frames.scenes[name] = crop(8 + 264 * i, 8); });
      if (g.width) frames.presented = crop(8, 272);
      run.screen = { width: g.width, height: g.height };
      run.adapter = frames.adapter;
      writeFileSync(`${out}/frames${k}.json`, JSON.stringify(frames));
      await s.page.locator('#screen').screenshot({ path: `${out}/screen${k}.png` });
      s.log('arm', JSON.stringify(run).slice(0, 1500));
      runs.push(run);
      await s.run(`pkill -x chromium; sleep 3; true`);
    }
    results.runs = runs;
  } finally {
    writeFileSync(`${out}/results.json`, JSON.stringify({ ...results, warnings: Object.fromEntries(s.warnings) }, null, 1));
    await s.close();
  }
} else {
  throw new Error('usage: node bench/vulkan/dawn-frames.ts <ref|guest|compare> ...');
}
