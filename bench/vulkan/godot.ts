// Godot 4 on Venus (dev-only): the desktop guest (images/arch/desktop.sh) on a machine with Vulkan
// (`?gpu=virgl,vulkan`), sway on GLES (virgl), Godot's arm64 build and its test projects from a second disk
// (target/godot/godot.ext4: /godot and /projects/<name>/, made by bench/vulkan/godot-disk.sh), each RUN started by sway,
// the page's screen kept every SHOT_S seconds for RUN_S, then Godot's log and the page's console kept beside them.
//   node bench/vulkan/godot.ts <image.qcow2> [outdir]
// RUNS: `tag=<godot args>` a line (default: the Forward+ project's scene; `tag:<s>=…` runs that one <s> seconds instead
// of RUN_S); `{p}` is the projects' copy in the guest's
// home (~/projects, writable: the editor imports into a project). RUN_S (90), SHOT_S (15), NCPUS (4), RAM_MIB (6144),
// SCREEN (e.g. 1280x720), GPU_KNOBS (more of `?gpu=`), GODOT_ENV (more of Godot's environment, e.g. `VN_DEBUG=…`),
// STORE_DUMP (the shader store kept at the end: bench/vulkan/store-dump.ts).
// Each run's results: its first frame, when its start ended by the renderer's account (`lastHeldS`: the last second a
// submit waited for its pipelines) and its pipeline totals (VK4 T49: two runs of one RUNS line in a session are the
// editor's cold and warm start).
// bench/gpu/sway-mac.sh runs it on the Mac (SCRIPT=../vulkan/godot.ts, mode `-`; it copies the disk when it exists).
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { openSession } from '../gpu/guest-session.ts';
import { dumpStore } from './store-dump.ts';

const image = process.argv[2];
if (!image) throw new Error('usage: node bench/vulkan/godot.ts <image.qcow2> [outdir]');
const out = process.argv[3] ?? new URL('../results/local/godot/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const RUN_S = Number(process.env.RUN_S ?? 90), SHOT_S = Number(process.env.SHOT_S ?? 15);
const RUNS = (process.env.RUNS ?? 'forward=--path {p}/forward --rendering-driver vulkan').split('\n').filter(Boolean)
  .map((l) => { const i = l.indexOf('='), [tag, secs] = l.slice(0, i).split(':'); return { tag, runS: Number(secs || RUN_S), args: l.slice(i + 1) }; });
const s = await openSession({
  gpu: ['virgl,vulkan', process.env.GPU_KNOBS].filter(Boolean).join(','), screen: process.env.SCREEN || undefined, image, out,
  ncpus: Number(process.env.NCPUS ?? 4), ramMiB: Number(process.env.RAM_MIB ?? 6144), disk2: process.env.DISK2 ?? '/target/godot/godot.ext4',
});
const { page, log, rootShell, run, runLines, asUser } = s;
// Every console line (the driver's `wg:` ones too, which the session's warnings leave out), with the run it fell in.
let current = 'boot';
page.on('console', (m) => appendFileSync(`${out}/console.txt`, `${current} ${m.type()} ${m.text().slice(0, 600)}\n`));
const results: Record<string, unknown> = { gl: s.gl, chromium: s.browser.version(), runS: RUN_S };
const save = () => writeFileSync(`${out}/results.json`, JSON.stringify({ ...results, warnings: Object.fromEntries(s.warnings) }, null, 1));

await rootShell();
await run('mkdir -p /mnt/godot && mount -o ro /dev/vdb /mnt/godot && rm -rf /home/arch/projects && cp -r /mnt/godot/projects /home/arch/ && chown -R arch: /home/arch/projects');
results.info = await run('uname -r; nproc; pacman -Q mesa vulkan-virtio sway 2>&1 | tr "\\n" " "');
log('info', results.info);
results.sway = await s.startSway('gles2');
log('sway', results.sway);
results.vulkan = await run(asUser(`vulkaninfo --summary 2>&1 | grep -E 'deviceName|apiVersion|driverName' | head -4`));
log('vulkan', results.vulkan);

for (const r of RUNS) {
  current = r.tag;
  const args = r.args.replaceAll('{p}', '/home/arch/projects');
  await run('pkill -x godot; sleep 2; pkill -9 -x godot; true');
  // Started by sway from a script: sway's own parser splits a command at `;` (an `echo` after it was a sway command).
  await run(`printf '%s\\n' '#!/bin/sh' 'env ${process.env.GODOT_ENV ?? ''} /mnt/godot/godot --verbose ${args} > /tmp/godot-${r.tag}.log 2>&1' 'echo godot exit status $? >> /tmp/godot-${r.tag}.log' > /tmp/run-${r.tag}.sh && chmod 755 /tmp/run-${r.tag}.sh`);
  await run(asUser(`swaymsg exec /tmp/run-${r.tag}.sh`));
  const t0 = performance.now();
  const shots: string[] = [];
  // The renderer's stats (web/gpu-worker.ts: a record a second), polled each second for the run's time, each stamped
  // with the seconds since the start (`t`) and kept raw; the shots every SHOT_S seconds between them. The first frame
  // (GD G7: the editor's start, cold and warm): the first second in which a Vulkan frame reached virgl (`shareRefreshes`:
  // Godot's window is the only Vulkan one). The start's end (VK4 T49): the last second in which a submit held for its
  // pipelines went (`venusPipelines.deferredMs` grew: a draw waited for a compile), and the last a pipeline was made.
  type Rec = { t: number; shareRefreshes?: number; venusPipelines?: Record<string, number> };
  let firstFrameS: number | undefined, lastHeldS: number | undefined, lastPipelineS: number | undefined, base: Record<string, number> | undefined, last: Record<string, number> | undefined;
  let nextShot = SHOT_S, alive = true;
  while (alive && performance.now() - t0 < r.runS * 1000) {
    await page.waitForTimeout(Math.max(0, Math.min(1000, t0 + nextShot * 1000 - performance.now())));
    const t = Math.round((performance.now() - t0) / 100) / 10;
    const stats = (await page.evaluate(() => ((window as unknown as { __renderStats?: unknown[] }).__renderStats ?? []).splice(0)) as Omit<Rec, 't'>[]).map((x) => ({ t, ...x }));
    if (stats.length) appendFileSync(`${out}/render-${r.tag}.jsonl`, stats.map((x) => JSON.stringify(x)).join('\n') + '\n');
    for (const x of stats) {
      if (firstFrameS === undefined && (x.shareRefreshes ?? 0) > 0) firstFrameS = t;
      const p = x.venusPipelines;
      if (!p) continue;
      base ??= p;
      if (last && p.deferredMs > last.deferredMs) lastHeldS = t;
      if (last && p.pipelines > last.pipelines) lastPipelineS = t;
      last = p;
    }
    if (performance.now() - t0 < nextShot * 1000) continue;
    const name = `${r.tag}-${String(nextShot).padStart(3, '0')}s`;
    await page.locator('#screen').screenshot({ path: `${out}/${name}.png` }).catch((e) => log('screenshot', String(e).slice(0, 200)));
    alive = (await run('pgrep -x godot | wc -l')).trim() !== '0';
    const cpu = (await run('ps -o pcpu=,etime= -C godot | head -1')).trim();
    shots.push(`${name} ${alive ? 'alive' : 'EXITED'} ${cpu}`);
    log(r.tag, `${nextShot} s`, alive ? 'alive' : 'EXITED', cpu);
    nextShot += SHOT_S;
  }
  // The run's pipeline totals (`venusPipelines` counts since Vulkan started: the run's are the difference).
  const pipelines = base && last ? Object.fromEntries(Object.keys(last).map((k) => [k, Math.round((last![k] - (base![k] ?? 0)) * 10) / 10])) : undefined;
  log(r.tag, 'first frame', firstFrameS === undefined ? `not within ${r.runS} s` : `${firstFrameS} s`, 'last held', lastHeldS, 'last pipeline', lastPipelineS, JSON.stringify(pipelines));
  // What each of Godot's threads waits on: its state, wait channel and kernel stack.
  const threads = await runLines(`(for t in /proc/$(pgrep -x godot | head -1)/task/*; do echo "T $(cat $t/comm) $(awk '{print $3}' $t/stat) $(cat $t/wchan)"; sed 's/^/  /' $t/stack | head -8; done 2>/dev/null)`, 60_000);
  writeFileSync(`${out}/threads-${r.tag}.txt`, threads.join('\n') + '\n');
  // The kernel's last words (an OOM kill, a GPU fault) and the guest's memory.
  writeFileSync(`${out}/dmesg-${r.tag}.txt`, (await runLines(`(journalctl -b --no-pager -n 60 -o short-monotonic 2>&1 | cut -c1-220; coredumpctl --no-pager list 2>&1 | tail -5; coredumpctl --no-pager info 2>&1 | grep -E 'Signal|#[0-9]+ ' | head -40 | cut -c1-200; free -m)`, 90_000)).join('\n') + '\n');
  const godotLog = await runLines(`grep -v -E '^(ALSA|XInput)' /tmp/godot-${r.tag}.log | tail -${process.env.LOG_LINES ?? 120} | cut -c1-300`, 60_000);
  writeFileSync(`${out}/godot-${r.tag}.log`, godotLog.join('\n') + '\n');
  // Which display server Godot took (X11 through Xwayland where DISPLAY is set and Xwayland installed, else Wayland:
  // under X11 Mesa's WSI copies each frame into a buffer, the prime blit, GD G7) and its first lines about Vulkan.
  const display = (await run(`grep -m4 -iE 'display (driver|server)|x11|wayland' /tmp/godot-${r.tag}.log | cut -c1-160`)).trim();
  results[r.tag] = { args, firstFrameS, lastHeldS, lastPipelineS, pipelines, shots, display, errors: godotLog.filter((l) => /ERROR|error|WARNING|Vulkan|Device/.test(l)).slice(-30) };
  save();
}
save();
// STORE_DUMP: the shader store as the runs left it (bench/vulkan/store-dump.ts).
if (process.env.STORE_DUMP) log('store', await dumpStore(page, `${out}/shader-store.json`), 'entries');
await s.close();
