// GTK4 applications on the page (G4's loop 5, the kickoff's decision 2; dev-only, not in tests): the desktop guest
// (`target/arch/desktop.qcow2`, images/arch/desktop.sh: GTK 4.24 and gtk4-demo) as bench/gpu/firefox-load.ts runs it: sway on GLES,
// then gtk4-demo's demos one at a time (`--run=<name>`) with GSK's renderer picked by GSK_RENDERER (`gl`, GSK's GL
// renderer, by default; `cairo` its software one). Each demo is left WARM_S seconds, then measured for PHASE_S (the
// compositor's frames a second, every thread's CPU, the renderer's stats; bench/gpu/guest-session.ts `load`), its
// screen shot as <out>/<demo>-<renderer>.png, and what it wrote to stderr kept (GSK_DEBUG=renderer says which
// renderer GTK took). The benchmark demos (fishbowl, frames, iconscroll, themes) draw as fast as they can and show
// their own frame rate on the screen.
//   node bench/gpu/gtk4-load.ts <virgl|2d> <image.qcow2> [outdir]
// DEMOS (default fishbowl,frames,iconscroll,themes,gears,shadertoy,image_scaling,listview_clocks,mask,path_fill),
// RENDERERS (default gl; `default` sets none, GTK's own choice; listed again, alternated rounds), WARM_S (15), PHASE_S (10); GTK_ENV adds environment (`WAYLAND_DEBUG=1`: a demo that dies
// gets its last Wayland messages and sway's log in the results); PROFILE=1 samples the guest's PCs over each phase.
import { mkdirSync, writeFileSync } from 'node:fs';
import { openSession } from './guest-session.ts';

const mode = process.argv[2] ?? 'virgl';
const image = process.argv[3];
if (!image) throw new Error('usage: node bench/gpu/gtk4-load.ts <virgl|2d> <image.qcow2> [outdir]');
const out = process.argv[4] ?? new URL(`../results/local/gtk4-load/${mode}/`, import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const PHASE_S = Number(process.env.PHASE_S ?? 10);
const WARM_S = Number(process.env.WARM_S ?? 15);
const DEMOS = (process.env.DEMOS ?? 'fishbowl,frames,iconscroll,themes,gears,shadertoy,image_scaling,listview_clocks,mask,path_fill').split(',');
const RENDERERS = (process.env.RENDERERS ?? 'gl').split(',');
const s = await openSession({ gpu: mode === 'virgl' ? process.env.VIRGL_GPU ?? 'virgl' : '2d', image, out, screen: process.env.SCREEN });
const { page, log, rootShell, load, run, runLines, asUser } = s;
const results: Record<string, unknown> = { mode, gl: s.gl, chromium: s.browser.version(), warmS: WARM_S, phaseS: PHASE_S };
const save = () => {
  writeFileSync(`${out}/results.json`, JSON.stringify({ ...results, warnings: Object.fromEntries(s.warnings) }, null, 1));
  if (s.debugLines.length) writeFileSync(`${out}/virgl-debug.txt`, s.debugLines.join('\n') + '\n');
};

await rootShell();
results.info = await run('uname -r; pacman -Q gtk4 gtk4-demos sway mesa 2>&1 | tr "\\n" " "');
log('info', results.info);
results.sway = await s.startSway('gles2');
log('sway', results.sway);

const kill = () => run('pkill -x gtk4-demo; for i in $(seq 30); do pgrep -x gtk4-demo >/dev/null || break; sleep 1; done; pkill -9 -x gtk4-demo; true', 60_000);
// A renderer listed again (`gl,vulkan,gl,vulkan`: alternated rounds) gets its round in its tag from the second on.
const rounds = new Map<string, number>();
for (const renderer of RENDERERS) {
  const round = (rounds.get(renderer) ?? 0) + 1;
  rounds.set(renderer, round);
  for (const demo of DEMOS) {
    const tag = `${demo}-${renderer}${round > 1 ? `-${round}` : ''}`;
    await kill();
    // Started by sway (the user's session), its stderr kept.
    // `default`: no GSK_RENDERER, GTK's own choice (Vulkan first on Wayland where the device qualifies: VK3 L7.3).
    await run(asUser(`swaymsg exec '${process.env.GTK_ENV ?? ''} ${renderer === 'default' ? '' : `GSK_RENDERER=${renderer}`} GSK_DEBUG=renderer gtk4-demo --run=${demo} > /tmp/gtk-${tag}.log 2>&1'`));
    await page.waitForTimeout(WARM_S * 1000);
    const alive = (await run('pgrep -x gtk4-demo | wc -l')).trim() !== '0';
    const r = await load(tag, PHASE_S, process.env.PROFILE ? s.sampler : undefined);
    // PROFILE=1: where the guest's time goes over the phase (the kernel's functions; guest-session.ts `symbolize`).
    const profile = process.env.PROFILE ? await s.symbolize(60) : undefined;
    // Which renderer GTK took, and why not Vulkan (GSK_DEBUG=renderer).
    const took = await runLines(`grep -E "Using renderer|Not using" /tmp/gtk-${tag}.log | sort | uniq -c | head -6`);
    const stderr = await runLines(`grep -v -E "session bus|Vulkan|vkEnumerate|highlight|^\\[" /tmp/gtk-${tag}.log | sort | uniq -c | sort -rn | head -12`);
    // A demo that died: its last Wayland requests (GTK_ENV=WAYLAND_DEBUG=1) and sway's log.
    const died = alive ? {} : { last: await runLines(`grep -E "^\\[" /tmp/gtk-${tag}.log | tail -12 | cut -c1-300`), sway: await runLines('tail -8 /tmp/sway.log | cut -c1-300') };
    results[tag] = { alive, flushes: r.display.flushes, ...r, took, stderr, ...died, ...(profile ? { profile } : {}) };
    log(tag, alive ? 'running' : 'EXITED', 'frames/s', r.display.flushes.toFixed(1), 'renderer', JSON.stringify(r.display.renderer ?? {}), took.join(' | '), stderr.join(' | '));
    save();
  }
}
await kill();
save();
log('done', JSON.stringify(Object.fromEntries(s.warnings)));
await s.close();
