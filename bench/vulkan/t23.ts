// VK4 T23: what the emulated paths cost a program's frame (dev-only; bench/vulkan/REPORT.md "VK4 T23"). Godot's Global
// Illumination demo as it starts in SDFGI mode (bench/vulkan/godot-disk.sh's `gi-sdfgi`, `gi-sdfgi-ssil`: vsync off, a
// line a second of its frames and its own CPU and GPU ms) in the desktop guest on Venus, as bench/vulkan/godot.ts runs
// Godot; once it draws and has settled, arms alternated in the one run (`window.__webpcVkSkip`: the emulated work an
// arm leaves out, web/venus-host.ts `SKIPS`), each ARM_S seconds a round: Godot's frames a second, its CPU and GPU ms
// a frame, its process's CPU (the guest's), the GPU worker's busy ms a second and its Venus submits' parts (with
// `GPU_KNOBS=vkgputime` the GPU's own ms in their passes), and the emulated paths' counts a frame (the render stats'
// `venusEmul`). The page's screen is kept for each arm in the first round (what it leaves out is wrong pixels).
//   node bench/vulkan/t23.ts <desktop.qcow2> [outdir]
// PROJECTS ('gi-sdfgi gi-sdfgi-ssil'), ARMS ('none views words feedback meta all': `all` every path `SKIPS` has),
// ROUNDS (3), ARM_S (12), SETTLE_S (60, after the first frame), FIRST_S (420: the first frame's limit, the import's and
// pipelines' time), NCPUS (4), RAM_MIB (6144), SCREEN, GPU_KNOBS (more of `?gpu=`). On the Mac: bench/gpu/sway-mac.sh
// with SCRIPT=../vulkan/t23.ts; on the user's NVIDIA desktop: nvidia.sh's `t23` step.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { openSession } from '../gpu/guest-session.ts';
import { SKIPS } from '../../web/venus-host.ts';

const image = process.argv[2];
if (!image) throw new Error('usage: node bench/vulkan/t23.ts <desktop.qcow2> [outdir]');
const out = process.argv[3] ?? new URL('../results/local/t23/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const env = (k: string, d: string) => process.env[k] ?? d;
const PROJECTS = env('PROJECTS', 'gi-sdfgi gi-sdfgi-ssil').split(/\s+/).filter(Boolean);
const ARMS = env('ARMS', 'none views words feedback meta all').split(/\s+/).filter(Boolean);
const ROUNDS = Number(env('ROUNDS', '3')), ARM_S = Number(env('ARM_S', '12')), SETTLE_S = Number(env('SETTLE_S', '60')), FIRST_S = Number(env('FIRST_S', '420'));
// `all`: every skip (`rgb9e5` isn't one: it chooses how views are made, before Godot starts: GPU_KNOBS=vkskip=rgb9e5).
const skipsOf = (arm: string) => (arm === 'none' ? [] : arm === 'all' ? Object.keys(SKIPS).filter((k) => k !== 'rgb9e5') : arm.split('+'));
for (const a of ARMS) for (const k of skipsOf(a)) if (!(k in SKIPS)) throw new Error(`t23: arm ${a}: ${k} isn't one of ${Object.keys(SKIPS).join(', ')}`);

const s = await openSession({
  gpu: ['virgl,vulkan', process.env.GPU_KNOBS].filter(Boolean).join(','), screen: process.env.SCREEN || undefined, image, out,
  ncpus: Number(env('NCPUS', '4')), ramMiB: Number(env('RAM_MIB', '6144')), disk2: env('DISK2', '/target/godot/godot.ext4'),
});
const { page, log, rootShell, run, asUser } = s;
let current = 'boot';
page.on('console', (m) => appendFileSync(`${out}/console.txt`, `${current} ${m.type()} ${m.text().slice(0, 600)}\n`));
type Stats = Record<string, unknown> & { busyMs?: number; shareRefreshes?: number; venus?: Record<string, number>; venusEmul?: Record<string, number> };
const takeStats = async () => (await page.evaluate(() => ((window as unknown as { __renderStats?: unknown[] }).__renderStats ?? []).splice(0))) as Stats[];
const setSkip = (paths: string[]) => page.evaluate((p) => (window as unknown as { __webpcVkSkip(p: string[]): void }).__webpcVkSkip(p), paths);
const results: Record<string, unknown> = { chromium: s.browser.version(), gl: s.gl, gpuKnobs: process.env.GPU_KNOBS ?? '', arms: ARMS, rounds: ROUNDS, armS: ARM_S };
const save = () => writeFileSync(`${out}/results.json`, JSON.stringify({ ...results, warnings: Object.fromEntries(s.warnings) }, null, 1));

await rootShell();
await run('mkdir -p /mnt/godot && mount -o ro /dev/vdb /mnt/godot && rm -rf /home/arch/projects && cp -r /mnt/godot/projects /home/arch/ && chown -R arch: /home/arch/projects');
results.info = await run('uname -r; nproc; pacman -Q mesa vulkan-virtio sway 2>&1 | tr "\\n" " "');
results.sway = await s.startSway('gles2');
log('sway', results.sway);

const median = (v: number[]) => { const a = v.filter(Number.isFinite).sort((x, y) => x - y); return a.length ? (a.length % 2 ? a[a.length >> 1] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : NaN; };
const sum = (rows: Stats[], f: (r: Stats) => number | undefined) => rows.reduce((n, r) => n + (f(r) ?? 0), 0);

for (const project of PROJECTS) {
  current = project;
  const p = `/home/arch/projects/${project}`, glog = `/tmp/godot-${project}.log`;
  // Imported first, headless (the editor's import, in software): a run of an unimported project loads nothing.
  const t0 = performance.now();
  await run(asUser(`timeout 900 /mnt/godot/godot --headless --path ${p} --import > /tmp/import-${project}.log 2>&1; echo import exit $?`), 960_000);
  const importS = Math.round((performance.now() - t0) / 1000);
  log(project, 'imported in', importS, 's');
  await run('pkill -x godot; sleep 2; pkill -9 -x godot; true');
  // Started by sway from a script: sway's own parser splits a command at `;` (an `echo` after it was a sway command).
  await run(`printf '%s\\n' '#!/bin/sh' '/mnt/godot/godot --path ${p} --rendering-driver vulkan > ${glog} 2>&1' 'echo godot exit status $? >> ${glog}' > /tmp/run-${project}.sh && chmod 755 /tmp/run-${project}.sh`);
  await run(asUser(`swaymsg exec /tmp/run-${project}.sh`));
  const started = performance.now();
  let firstFrameS: number | undefined;
  while (firstFrameS === undefined && performance.now() - started < FIRST_S * 1000) {
    await page.waitForTimeout(1000);
    if ((await takeStats()).some((x) => (x.shareRefreshes ?? 0) > 0)) firstFrameS = Math.round((performance.now() - started) / 100) / 10;
  }
  log(project, 'first frame', firstFrameS ?? `none within ${FIRST_S} s`);
  const r: Record<string, unknown> = { importS, firstFrameS };
  results[project] = r;
  save();
  if (firstFrameS === undefined) continue;
  await page.waitForTimeout(SETTLE_S * 1000);
  const pid = (await run('pgrep -x godot | head -1')).trim();
  const cpuTicks = async () => Number((await run(`awk '{print $14 + $15}' /proc/${pid}/stat 2>/dev/null || echo NaN`)).trim());
  const lines = async () => Number((await run(`wc -l < ${glog}`)).trim());
  const rows: Record<string, unknown>[] = [];
  for (let round = 0; round < ROUNDS; round++) {
    for (const arm of ARMS) {
      await setSkip(skipsOf(arm));
      await page.waitForTimeout(2000);
      await takeStats();
      const [from, ticks0, at0] = [await lines(), await cpuTicks(), performance.now()];
      await page.waitForTimeout(ARM_S * 1000);
      const stats = await takeStats();
      const [ticks1, secs] = [await cpuTicks(), (performance.now() - at0) / 1000];
      const g = (await run(`tail -n +${from + 1} ${glog} | grep '^t23 ' | tail -n ${Math.max(1, ARM_S - 2)}`)).trim().split('\n').filter(Boolean)
        .map((l) => Object.fromEntries([...l.matchAll(/(\w+)=([\d.]+)/g)].map((m) => [m[1], Number(m[2])])));
      const frames = g.reduce((n, x) => n + (x.frames ?? 0), 0), gms = g.reduce((n, x) => n + (x.ms ?? 0), 0);
      const fps = gms ? (frames * 1000) / gms : 0;
      const v = (k: string) => sum(stats, (x) => x.venus?.[k]);
      const emul: Record<string, number> = {};
      for (const x of stats) for (const [k, n] of Object.entries(x.venusEmul ?? {})) emul[k] = (emul[k] ?? 0) + n;
      const perFrame = Object.fromEntries(Object.entries(emul).filter(([, n]) => n).map(([k, n]) => [k, +(n / Math.max(1, fps * stats.length)).toFixed(2)]));
      const row = {
        round, arm, fps: +fps.toFixed(1), godotCpuMs: +median(g.map((x) => x.cpu)).toFixed(2), godotGpuMs: +median(g.map((x) => x.gpu)).toFixed(2),
        // The guest's: Godot's process's CPU, % of one CPU (10 ms ticks).
        guestCpuPct: +(((ticks1 - ticks0) * 10) / (secs * 10)).toFixed(1),
        workerBusyMsPerS: +(sum(stats, (x) => x.busyMs) / Math.max(1, stats.length)).toFixed(1),
        // Frames that reached the page's screen (Vulkan's, copied into virgl: Godot's window is the only Vulkan one) a
        // second, and the seconds without one (a freeze: GD's leftovers on NVIDIA).
        screenFps: +(sum(stats, (x) => x.shareRefreshes) / Math.max(1, stats.length)).toFixed(1), frozenS: stats.filter((x) => !x.shareRefreshes).length,
        submitsPerS: +(v('submits') / Math.max(1, stats.length)).toFixed(1),
        doneMsPerSubmit: +(v('doneMs') / Math.max(1, v('done'))).toFixed(2), encodeMsPerSubmit: +(v('encodeMs') / Math.max(1, v('submits'))).toFixed(2),
        gpuMsPerSubmit: v('gpuTimed') ? +(v('gpuMs') / v('gpuTimed')).toFixed(2) : undefined,
        emulPerFrame: perFrame,
      };
      rows.push(row);
      log(project, `round ${round} ${arm}`, JSON.stringify(row));
      if (round === 0) await page.locator('#screen').screenshot({ path: `${out}/${project}-${arm}.png` }).catch((e) => log('screenshot', String(e).slice(0, 200)));
      r.rows = rows;
      save();
    }
  }
  await setSkip([]);
  // Each arm's medians over the rounds, and against `none` (the page as it is).
  const by = (arm: string, k: string) => median(rows.filter((x) => x.arm === arm).map((x) => x[k] as number));
  const keys = ['fps', 'screenFps', 'frozenS', 'godotCpuMs', 'godotGpuMs', 'guestCpuPct', 'workerBusyMsPerS', 'doneMsPerSubmit', 'encodeMsPerSubmit', 'gpuMsPerSubmit'];
  r.summary = Object.fromEntries(ARMS.map((a) => [a, Object.fromEntries(keys.map((k) => [k, by(a, k)]))]));
  r.log = (await run(`grep -v '^t23 ' ${glog} | grep -iE 'error|vulkan|device' | tail -20 | cut -c1-240`)).trim();
  console.table(r.summary);
  save();
  await run('pkill -x godot; sleep 2; pkill -9 -x godot; true');
}
save();
await s.close();
