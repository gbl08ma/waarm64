// VK1's gate, its programs under sway (bench/vulkan/REPORT.md "VK1: the gate"): the desktop guest (images/arch/desktop.sh,
// with Venus's driver) on a machine with Vulkan (`?gpu=virgl,vulkan`), sway on GLES (virgl), then each program of
// APPS alone, started by sway, left WARM_S seconds and measured for PHASE_S (bench/gpu/guest-session.ts `load`): the
// guest's CPU by process and thread, the compositor's frames a second, the renderer's stats. A program's CPU a frame
// is its process's ms a second over the frames sway showed a second (a single window at the display's rate).
//   node bench/vulkan/apps-load.ts <image.qcow2> [outdir]
// APPS: `tag=command` a line (default vkcube on Venus, es2gears on virgl); WARM_S (15), PHASE_S (10), NCPUS (4),
// RAM_MIB (4096), STDERR_LINES (5: what each program printed last), PRE (root commands first, a line each), PROFILE=1 (the guest's PCs sampled over each phase);
// bench/gpu/sway-mac.sh runs it on the Mac (SCRIPT=../vulkan/apps-load.ts, mode `-`).
import { mkdirSync, writeFileSync } from 'node:fs';
import { openSession } from '../gpu/guest-session.ts';

const image = process.argv[2];
if (!image) throw new Error('usage: node bench/vulkan/apps-load.ts <image.qcow2> [outdir]');
const out = process.argv[3] ?? new URL('../results/local/vk1/apps-load/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const PHASE_S = Number(process.env.PHASE_S ?? 10), WARM_S = Number(process.env.WARM_S ?? 15);
const APPS = (process.env.APPS ?? 'vkcube-venus=vkcube --wsi wayland\nes2gears-virgl=es2gears_wayland').split('\n').filter(Boolean)
  .map((l) => { const i = l.indexOf('='); return { tag: l.slice(0, i), cmd: l.slice(i + 1) }; });
const s = await openSession({ gpu: 'virgl,vulkan', image, out, ncpus: Number(process.env.NCPUS ?? 4), ramMiB: Number(process.env.RAM_MIB ?? 4096) });
const { page, log, rootShell, load, run, runLines, asUser } = s;
const results: Record<string, unknown> = { gl: s.gl, chromium: s.browser.version(), warmS: WARM_S, phaseS: PHASE_S };
const save = () => writeFileSync(`${out}/results.json`, JSON.stringify({ ...results, warnings: Object.fromEntries(s.warnings) }, null, 1));

await rootShell();
results.info = await run('uname -r; nproc; pacman -Q mesa vulkan-virtio vulkan-tools sway gtk4 2>&1 | tr "\\n" " "');
log('info', results.info);
results.sway = await s.startSway('gles2');
log('sway', results.sway);
results.vulkan = await run(asUser('vulkaninfo --summary 2>&1 | grep -E "deviceName|apiVersion|driverName" | head -4'));
log('vulkan', results.vulkan);

// PRE: root commands run first, one a line (e.g. a script for an app to run).
for (const cmd of (process.env.PRE ?? '').split('\n').filter(Boolean)) log('pre', await run(cmd, 120_000));

for (const app of APPS) {
  const exe = app.cmd.split(' ').find((w) => !w.includes('='))!;
  const kill = () => run(`pkill -x ${exe}; for i in $(seq 20); do pgrep -x ${exe} >/dev/null || break; sleep 0.5; done; pkill -9 -x ${exe}; true`, 60_000);
  await kill();
  await run(asUser(`swaymsg exec '${app.cmd} > /tmp/app-${app.tag}.log 2>&1'`));
  await page.waitForTimeout(WARM_S * 1000);
  const alive = (await run(`pgrep -x ${exe} | wc -l`)).trim() !== '0';
  const r = await load(app.tag, PHASE_S, process.env.PROFILE ? s.sampler : undefined);
  // PROFILE=1: where the guest's time goes over the phase (guest-session.ts `symbolize`).
  const profile = process.env.PROFILE ? await s.symbolize(40) : undefined;
  const proc = r.processes.find((p) => p.process === exe.slice(0, 15)) as Record<string, number> | undefined;
  const frames = r.display.flushes;
  const busy = r.cpus.find((c) => c.cpu === 'cpu')?.busy;
  const perFrame = proc && frames ? proc.cpu / frames : undefined;
  const stderr = await runLines(`tail -${process.env.STDERR_LINES ?? 5} /tmp/app-${app.tag}.log | cut -c1-200`);
  results[app.tag] = { cmd: app.cmd, alive, framesPerS: frames, processMsPerS: proc?.cpu, cpuMsPerFrame: perFrame, guestBusyPct: busy, stderr, ...r, ...(profile ? { profile } : {}) };
  log(app.tag, alive ? 'running' : 'EXITED', `frames/s ${frames.toFixed(1)}, ${exe} ${proc?.cpu ?? '?'} ms/s, ${perFrame?.toFixed(2) ?? '?'} ms a frame, guest ${busy}% busy`, stderr.join(' | '));
  save();
  await kill();
}
save();
await s.close();
