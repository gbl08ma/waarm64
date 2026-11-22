// PERF loop 46's counts (bench/boot/REPORT.md "PERF loop 46"): with diag.patch's core, the modules of the code
// cache's epoch whose functions the block map no longer names (invalidated or superseded), sampled every 16 installs,
// at each flush and at each guest mark, as `D:` lines of the helper report.
//   CARGO_TARGET_DIR=target/mods scripts/build-wasm.sh   (with diag.patch applied)
//   node bench/boot/results/perf46/mods.ts [--json out.json] [boot user smp4 smp-user4]
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { boot } from '../../suite.ts';
import { compileCore } from '../../../../web/core.ts';
import { DISTROS } from '../../../../web/test-guests.ts';

const { values: a, positionals } = parseArgs({
  allowPositionals: true,
  options: { wasm: { type: 'string', default: 'target/mods/wasm32-unknown-unknown/release/waarm64_core.wasm' }, json: { type: 'string' } },
});
type D = Record<string, number>;
const root = new URL('../../../../', import.meta.url);
const IMAGES = new URL('target/images/', root);
const d = DISTROS.alpine;
const module = await compileCore(readFileSync(new URL(a.wasm!, root)));
const parse = (h: { op: string; calls: number }[]): D => Object.fromEntries(h.filter((x) => x.op.startsWith('D:')).map((x) => [x.op.slice(2), x.calls]));
const runs: { name: string; marks: { mark: string; d: D }[]; end: D; stats: unknown }[] = [];
for (const name of positionals.length ? positionals : ['boot', 'user', 'smp4', 'smp-user4']) {
  const user = name.includes('user');
  const ncpus = name.startsWith('smp') ? 4 : 1;
  const parallel = name.startsWith('smp');
  const disk = new URL(user ? 'alpine-user/rootfs-user.ext4' : d.disk, IMAGES).href;
  const img = { kernel: readFileSync(new URL(d.kernel, IMAGES)), initrd: readFileSync(new URL(d.initrd, IMAGES)), disk, cmdline: d.cmdline, ramSize: 1 << 30, test: !user, jit: 1 as const };
  const marks: { mark: string; d: D }[] = [];
  let vm!: Awaited<ReturnType<typeof import('../../../../web/vm.ts').bootVm>>;
  const r = await boot(module, img, (v) => { vm = v; }, { cmdline: parallel && user ? `${d.cmdline} waarm64.threads=${ncpus}` : d.cmdline, ncpus, parallel, realtime: parallel, onMark: (m) => marks.push({ mark: m, d: parse(vm.helperReport()) }) });
  const end = marks.at(-1)!.d;
  const s = r.stats.jit;
  runs.push({ name, marks, end, stats: { steps: r.stats.steps, modules: s.modules, blocks: s.blocks, bytes: s.bytes, invalidations: s.invalidations, flushes: s.flushes, tierUps: s.tierUps } });
  console.log(`== ${name}: ${(r.stats.steps / 1e6).toFixed(0)}M steps, modules ${s.modules}, blocks ${s.blocks}, ${(s.bytes / 2 ** 20).toFixed(1)} MiB, invalidations ${s.invalidations}, flushes ${s.flushes}, tier-ups ${s.tierUps}`);
  for (const k of ['max', 'last', 'flush']) {
    const g = (n: string) => end[`${k}:${n}`] ?? 0;
    const mb = (n: string) => (g(n) / 2 ** 20).toFixed(2);
    console.log(`  ${k.padEnd(5)} mods ${g('mods')} ${mb('bytes')} MiB, fns ${g('fns')} unnamed ${g('unnamed')}; all-unnamed mods ${g('fullMods')} ${mb('fullBytes')} MiB (freeable ${g('freeMods')} ${mb('freeBytes')} MiB, imported ${g('impMods')} ${mb('impBytes')} MiB); partly ${g('partMods')} ${mb('partBytes')} MiB, its dead share ${mb('partDeadBytes')} MiB (invalidated ${mb('partInvalBytes')}); tiered heads ${g('tiered')}`);
  }
  console.log(`  flushes sampled ${end['flushes']}`);
}
if (a.json) writeFileSync(a.json, JSON.stringify({ date: new Date().toISOString(), node: process.version, runs }, null, 1));
