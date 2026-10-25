// The S tables of bench/vulkan/REPORT.md from the committed JSON: each arm's median frame time per setting, and arm 3
// against native, against the guest's lavapipe and against virgl.
//   node bench/vulkan/summary.ts [results dir]     (default bench/vulkan/results)
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const R = process.argv[2] ?? fileURLToPath(new URL('./results', import.meta.url));
type Row = Record<string, number | undefined>;

/** Median frame ms by setting name from a directory of one-JSON-a-setting results. */
function dir(path: string, key: (j: Record<string, any>, file: string) => string | null): Row { // eslint-disable-line @typescript-eslint/no-explicit-any
  const out: Row = {};
  if (!existsSync(path)) return out;
  for (const f of readdirSync(path).filter((x) => x.endsWith('.json'))) {
    const j = JSON.parse(readFileSync(join(path, f), 'utf8'));
    const k = key(j, f);
    if (k) out[k] = j.frameMs?.median;
  }
  return out;
}
const setting = (j: Record<string, any>) => (j.scene === 'toolkit' ? `toolkit-${j.quads}` : `fish-${j.fish}`) + `-msaa${j.msaa}`; // eslint-disable-line @typescript-eslint/no-explicit-any
const native = (p: string) => dir(join(R, p), (j) => setting(j));
const webgpu = (p: string, mode: string) => dir(join(R, p), (j) => (j.scene === 'toolkit' || j.fishMode === mode ? setting(j) : null));
const arm3 = dir(join(R, 'loop3/mac-arm3'), (j) => { const m = /(fish|toolkit)(\d+)-trace/.exec(j.trace); return m ? `${m[1]}-${m[2]}-msaa1` : null; });
const guest = (...ps: string[]) => Object.assign({}, ...ps.map((p) => dir(join(R, p), (j) => setting(j))));

const arms: [string, Row][] = [
  ['native MoltenVK', native('loop3/mac-mvk')],
  ['native KosmicKrisp', native('loop1/mac-kosmickrisp')],
  ['WebGPU (storage)', { ...webgpu('loop3/mac-wgpu', 'storage'), ...webgpu('loop3/mac-wgpu-msaa', 'storage') }],
  ['WebGPU (dynamic)', { ...webgpu('loop3/mac-wgpu-modes', 'dynamic'), ...webgpu('loop3/mac-wgpu-msaa', 'dynamic') }],
  ['WebGPU (immediates)', { ...webgpu('loop3/mac-wgpu-modes', 'immediates'), ...webgpu('loop3/mac-wgpu-msaa', 'immediates') }],
  ['translated (arm 3)', arm3],
  ['guest virgl (GLES)', guest('loop3/vk0-guest-virgl', 'loop3/vk0-guest-virgl-ms', 'loop3/vk0-guest-virgl-30k')],
  ['guest lavapipe', guest('loop3/vk0-guest-lvp')],
  ['lavapipe, dev VM natively', native('loop1/vm-lavapipe')],
];
const settings = ['fish-1', 'fish-100', 'fish-1000', 'fish-10000', 'fish-30000', 'toolkit-2000', 'toolkit-8000'];
const fmt = (x?: number) => (x === undefined ? '' : x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2));
for (const msaa of [1, 4]) {
  console.log(`\nms a frame, 1080p, MSAA ${msaa}\n`);
  console.log(`| | ${settings.join(' | ')} |\n|---|${settings.map(() => '---').join('|')}|`);
  for (const [name, row] of arms) {
    if (!settings.some((s) => row[`${s}-msaa${msaa}`] !== undefined)) continue;
    console.log(`| ${name} | ${settings.map((s) => fmt(row[`${s}-msaa${msaa}`])).join(' | ')} |`);
  }
}
const ratio = (a?: number, b?: number) => (a === undefined || b === undefined ? '' : `${(a / b).toFixed(a / b >= 10 ? 0 : 2)}x`);
console.log('\nArm 3 against the others, MSAA 1 (above 1: arm 3 is slower; below 1: faster)\n');
console.log(`| arm 3 / | ${settings.join(' | ')} |\n|---|${settings.map(() => '---').join('|')}|`);
for (const [name, row] of arms.filter(([n]) => n !== 'translated (arm 3)')) {
  console.log(`| ${name} | ${settings.map((s) => ratio(arm3[`${s}-msaa1`], row[`${s}-msaa1`])).join(' | ')} |`);
}
console.log('\nToday\'s paths against arm 3, MSAA 1 (how many times faster arm 3 is)\n');
for (const [name, row] of arms.filter(([n]) => n.startsWith('guest'))) {
  console.log(`| ${name} | ${settings.map((s) => ratio(row[`${s}-msaa1`], arm3[`${s}-msaa1`])).join(' | ')} |`);
}
