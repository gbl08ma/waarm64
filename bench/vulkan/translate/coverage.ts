// Question D's coverage (bench/vulkan/REPORT.md): every SPIR-V module of a program (extracted from its GFXReconstruct
// capture with gfxrecon-extract) through naga alone and through arm 3's chain (shaders.ts: specialization frozen at
// the module's defaults, combined image-samplers split, bindings renumbered, then naga), with each failure's first
// line, counted by reason.
//   node bench/vulkan/translate/coverage.ts <name> <dir of .spv files> [out.json]
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renumberBindings } from './shaders.ts';

const [name, dir, outPath] = process.argv.slice(2);
if (!name || !dir) throw new Error('usage: coverage.ts <name> <spv dir> [out.json]');
const naga = join(process.env.HOME ?? '', '.cargo/bin/naga');
const tmp = mkdtempSync(join(tmpdir(), 'vk0-cov-'));
const reason = (s: string) => (s.split('\n').find((l) => l.trim() && !/^\[WARN|^(error|Could not|Error)\b:?\s*$/.test(l.trim())) ?? s).trim().replace(/%\d+/g, '%N').replace(/\[\d+\]/g, '[N]').slice(0, 140);
const rows: { file: string; bytes: number; direct: string; chain: string }[] = [];
try {
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.spv')).sort()) {
    const spv = join(dir, f);
    const d = spawnSync(naga, [spv, join(tmp, 'd.wgsl')], { encoding: 'utf8', timeout: 30_000 });
    const direct = d.status === 0 ? 'ok' : reason(d.stderr || d.stdout || `exit ${d.status}`);
    const opt = join(tmp, 'o.spv');
    const o = spawnSync('spirv-opt', ['--freeze-spec-const', '--fold-spec-const-op-composite', '--split-combined-image-sampler', spv, '-o', opt], { encoding: 'utf8', timeout: 30_000 });
    let chain: string;
    if (o.status !== 0) chain = `spirv-opt: ${reason(o.stderr)}`;
    else {
      writeFileSync(opt, renumberBindings(new Uint8Array(readFileSync(opt))));
      const n = spawnSync(naga, ['--keep-coordinate-space', opt, join(tmp, 'c.wgsl')], { encoding: 'utf8', timeout: 30_000 });
      chain = n.status === 0 ? 'ok' : reason(n.stderr || n.stdout || `exit ${n.status}`);
    }
    rows.push({ file: f, bytes: readFileSync(spv).length, direct, chain });
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
const count = (k: 'direct' | 'chain') => {
  const m = new Map<string, number>();
  for (const r of rows) m.set(r[k], (m.get(r[k]) ?? 0) + 1);
  return Object.fromEntries([...m].sort((a, b) => b[1] - a[1]));
};
const report = { program: name, modules: rows.length, direct: count('direct'), chain: count('chain'), rows };
if (outPath) writeFileSync(outPath, JSON.stringify(report, null, 1) + '\n');
console.log(`${name}: ${rows.length} modules; naga alone ${report.direct.ok ?? 0} ok, the chain ${report.chain.ok ?? 0} ok`);
for (const [k, v] of Object.entries(report.chain)) if (k !== 'ok') console.log(`  chain fails x${v}: ${k}`);
for (const [k, v] of Object.entries(report.direct)) if (k !== 'ok') console.log(`  alone fails x${v}: ${k}`);
