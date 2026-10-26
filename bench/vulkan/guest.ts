// VK0's arm 4 (bench/vulkan/REPORT.md): the scene in our machine's guest on the page, what the guest has today. `vk` on
// the guest's lavapipe (Vulkan now) and `gles`, the GLES port, on virgl (what Vulkan competes with), from
// images/vulkan/build.sh's guest (Arch with Mesa and lavapipe) and second disk (/vk0: the binaries, shaders and pack),
// as root on EGL's surfaceless platform (no compositor); `vk` on Venus (VK1's gate: a machine with Vulkan, the
// desktop guest, images/arch/desktop.sh, whose Mesa has Venus's driver). One JSON a setting: the guest's frame time and its CPU a frame
// (the process's, lavapipe's threads included), with the display's and the GPU worker's stats over the same span.
//   node bench/vulkan/guest.ts <lavapipe|virgl|venus|venus-nowatch> [image|-] [out dir]
// CHECK=1 first renders frame 300 at 1,000 fish and the toolkit's frame 100 in the guest and compares their 32x18
// thumbnails (dump.h) with the native frames (bench/results/local/vk0/lvp-1000.ppm, lvp-tk.ppm: vk on lavapipe).
// FISH, TOOLKIT, MSAA (lists), WARMUP, SAMPLES, FRAMES, NCPUS (default 4), RUN_S, GPU_KNOBS (more of `?gpu=` for Venus,
// comma-separated: e.g. `vkvendor=nvidia`), SIZE (the frame's, default 1920x1080: SwiftShader's
// software GPU draws a 1080p frame for ~60 ms, so its floor shows only smaller); the Mac's GPU through
// bench/gpu/sway-mac.sh (SCRIPT=../vulkan/guest.ts, which copies the second disk when VK0=1).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { openSession } from '../gpu/guest-session.ts';

const arm = process.argv[2];
if (!['lavapipe', 'virgl', 'venus', 'venus-nowatch'].includes(arm)) throw new Error('usage: node bench/vulkan/guest.ts <lavapipe|virgl|venus|venus-nowatch> [image] [out dir]');
// venus-nowatch: Venus without the window's write-watch at each submit (`?gpu=vulkan,nowatch`), its cost against venus.
const venus = arm.startsWith('venus');
const image = process.argv[3] && process.argv[3] !== '-' ? process.argv[3] : 'target/vulkan/guest.qcow2';
const out = process.argv[4] ?? new URL(`../results/local/vk0/guest-${arm}/`, import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const env = (k: string, d: string) => process.env[k] ?? d;
const list = (k: string, d: string) => env(k, d).split(/\s+/).filter(Boolean);
const slow = arm === 'lavapipe';
const WARMUP = Number(env('WARMUP', slow ? '2' : '30')), SAMPLES = Number(env('SAMPLES', slow ? '3' : '5')), FRAMES = Number(env('FRAMES', slow ? '3' : '30'));
const RUN_S = Number(env('RUN_S', '900'));
const ncpus = Number(env('NCPUS', '4'));
const [width, height] = env('SIZE', '1920x1080').split('x').map(Number);
const sizeArgs = width === 1920 && height === 1080 ? '' : ` --width ${width} --height ${height}`;

const knobs = venus && process.env.GPU_KNOBS ? `,${process.env.GPU_KNOBS}` : '';
const s = await openSession({ gpu: venus ? `virgl,vulkan${arm === 'venus-nowatch' ? ',nowatch' : ''}${knobs}` : 'virgl', image, out, disk2: '/target/vulkan/disk.ext4', ncpus, ramMiB: 4096 });
const { log, rootShell, run, display, vmStats, vmDelta } = s;
await rootShell();
const info = await run('uname -r; pacman -Q mesa vulkan-swrast vulkan-virtio 2>/dev/null | tr "\\n" " "; mkdir -p /mnt/vdb; mount -o ro /dev/vdb /mnt/vdb && ls /mnt/vdb/vk0 | tr "\\n" " "');
log('info', info);
const bin = arm === 'lavapipe'
  ? 'env VK_DRIVER_FILES=/usr/share/vulkan/icd.d/lvp_icd.json /mnt/vdb/vk0/vk --shaders /mnt/vdb/vk0/shaders'
  : venus ? '/mnt/vdb/vk0/vk --shaders /mnt/vdb/vk0/shaders' // the desktop guest's only ICD
  : 'env EGL_PLATFORM=surfaceless /mnt/vdb/vk0/gles --shaders /mnt/vdb/vk0/gles-shaders';
log('device', await run(`${bin.split(' --')[0]} --pack /mnt/vdb/vk0/aquarium.pack --shaders /mnt/vdb/vk0/${arm === 'virgl' ? 'gles-shaders' : 'shaders'} --fish 1 --warmup 1 --samples 1 --frames 1 2>&1 | head -1`, 300_000));

/** A PPM's block means, as dump.h computes them. */
function thumbOf(path: string, tw: number, th: number): Uint8Array {
  const d = readFileSync(path);
  let at = 0;
  const field = () => { while (/\s/.test(String.fromCharCode(d[at]))) at++; const s = at; while (!/\s/.test(String.fromCharCode(d[at]))) at++; return d.subarray(s, at).toString(); };
  field();
  const w = Number(field()), h = Number(field());
  field();
  at++;
  const px = d.subarray(at);
  const out = new Uint8Array(tw * th * 3);
  for (let by = 0; by < th; by++) {
    for (let bx = 0; bx < tw; bx++) {
      const x0 = Math.floor((bx * w) / tw), x1 = Math.floor(((bx + 1) * w) / tw), y0 = Math.floor((by * h) / th), y1 = Math.floor(((by + 1) * h) / th);
      const sum = [0, 0, 0];
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) for (let c = 0; c < 3; c++) sum[c] += px[(y * w + x) * 3 + c];
      const n = (x1 - x0) * (y1 - y0);
      for (let c = 0; c < 3; c++) out[(by * tw + bx) * 3 + c] = Math.floor(sum[c] / n);
    }
  }
  return out;
}

if (process.env.CHECK) {
  const checks = [{ name: 'fish-1000', args: '--fish 1000', frame: 300, ref: 'lvp-1000.ppm' }, { name: 'toolkit-2000', args: '--toolkit 2000', frame: 100, ref: 'lvp-tk.ppm' }];
  for (const c of checks) {
    const lines = await s.runLines(`timeout ${RUN_S} ${bin} --pack /mnt/vdb/vk0/aquarium.pack ${c.args} --dump ${c.frame}:/tmp/check.ppm --thumb 32x18 2>/dev/null | grep "^thumb" | fold -w 200`, (RUN_S + 60) * 1000);
    const hex = lines.join('').replace(/^thumb 32 18 /, '').trim();
    const ref = new URL(`../results/local/vk0/${c.ref}`, import.meta.url).pathname;
    if (hex.length !== 32 * 18 * 6 || !existsSync(ref)) { log('check', c.name, 'no thumbnail or reference', hex.length); continue; }
    const got = Uint8Array.from(hex.match(/../g)!.map((x) => parseInt(x, 16)));
    const want = thumbOf(ref, 32, 18);
    let max = 0, sum = 0, over8 = 0;
    for (let i = 0; i < got.length; i++) { const d = Math.abs(got[i] - want[i]); max = Math.max(max, d); sum += d; if (d > 8) over8++; }
    const r = { name: c.name, frame: c.frame, maxDiff: max, meanDiff: sum / got.length, blocksOver8: over8 / 3 };
    writeFileSync(`${out}/check-${c.name}.json`, JSON.stringify(r) + '\n');
    log('check', JSON.stringify(r));
  }
}

const settings: { name: string; args: string; fish: number; toolkit: number; msaa: number }[] = [];
for (const msaa of list('MSAA', '1').map(Number)) {
  for (const n of list('FISH', '1 100 1000 10000').map(Number)) settings.push({ name: `fish-${n}-msaa${msaa}`, args: `--fish ${n} --msaa ${msaa}`, fish: n, toolkit: 0, msaa });
  for (const q of list('TOOLKIT', '2000 8000').map(Number)) settings.push({ name: `toolkit-${q}-msaa${msaa}`, args: `--toolkit ${q} --msaa ${msaa}`, fish: 0, toolkit: q, msaa });
}
for (const st of settings) {
  await display();
  const v0 = await vmStats();
  const t0 = performance.now();
  const line = await run(`timeout ${RUN_S} ${bin} --pack /mnt/vdb/vk0/aquarium.pack ${st.args}${sizeArgs} --warmup ${WARMUP} --samples ${SAMPLES} --frames ${FRAMES} --label ${arm} --json /tmp/${st.name}.json 2>&1 | tail -1`, (RUN_S + 60) * 1000);
  const seconds = (performance.now() - t0) / 1000;
  const v1 = await vmStats();
  const d = await display();
  const m = /: ([\d.]+) ms a frame \(IQR ([\d.]+)\), CPU ([\d.]+) ms/.exec(line);
  if (!m) { log(st.name, 'failed:', line); continue; }
  const result = {
    arm: `guest-${arm}`, knobs: knobs.slice(1) || undefined, info, gl: s.gl, browser: s.browser.version(), ncpus, scene: st.toolkit ? 'toolkit' : 'aquarium', fish: st.fish, quads: st.toolkit,
    width, height, msaa: st.msaa, warmup: WARMUP, samples: SAMPLES, frames: FRAMES,
    frameMs: { median: Number(m[1]), iqr: Number(m[2]) }, guestCpuMs: Number(m[3]), line, seconds,
    // The host's side over the whole run (warm-up included): the GPU worker's busy ms a second and the display's.
    renderer: d.renderer, display: { submits: d.submits, submitKB: d.submitKB, fences: d.fences }, vm: vmDelta(v0, v1),
  };
  writeFileSync(`${out}/${st.name}.json`, JSON.stringify(result, null, 1) + '\n');
  log(st.name, `${result.frameMs.median} ms a frame (IQR ${result.frameMs.iqr}), guest CPU ${result.guestCpuMs} ms;`,
    d.renderer ? `GPU worker busy ${d.renderer.busyMs.toFixed(0)} ms/s, ${d.renderer.glDraws.toFixed(0)} draws/s` : '');
  const v = d.renderer?.venus;
  if (v) log(st.name, `venus: ${v.submits.toFixed(0)} submits/s done in ${v.doneMs.toFixed(2)} ms (max ${v.doneMaxMs.toFixed(1)}), then ${v.orderMs.toFixed(2)} ms in order (by second: ${v.doneMsBySecond.join(" ")}); ${v.polls.toFixed(0)} polls/s ${v.gapMs.toFixed(2)} ms apart (max ${v.gapMaxMs.toFixed(1)}); ${v.nudges.toFixed(0)} nudges/s; ${v.fences.toFixed(0)} fences/s retired in ${v.fenceMs.toFixed(2)} ms`);
}
await s.close();
