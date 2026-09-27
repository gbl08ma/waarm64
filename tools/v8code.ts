// V8's machine code for JIT functions (M6 loop 0): runs a benchmark guest under
// the JIT in a child Node with --print-wasm-code and prints the code V8 made of
// the functions whose name matches (JIT functions are named after their guest
// PC: `<va>_pa<pa>`; core functions by their Rust symbol).
//
//   node tools/v8code.ts [--guest int|fp|coremark|el1|el1-mmu] [--steps N]
//     [--match REGEX] [--tier liftoff|turbofan] [--list] [--v8 '<more V8 flags>']
//
// --list prints one line per matching function (tier, code size); without it,
// the full disassembly of each match's last compile (per tier). Examples:
//   node tools/v8code.ts --list                       # every JIT function
//   node tools/v8code.ts --match '^0x10330_' --tier turbofan
//   node tools/v8code.ts --match 'add_exact' --guest fp --v8 --no-liftoff
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const { values: a } = parseArgs({
  options: {
    guest: { type: 'string', default: 'int' },
    steps: { type: 'string', default: '100000000' },
    match: { type: 'string', default: '^0x[0-9a-f]+_pa' },
    tier: { type: 'string' },
    list: { type: 'boolean', default: false },
    v8: { type: 'string', default: '' },
    child: { type: 'boolean', default: false },
  },
});

if (a.child) {
  // Runs the guest; V8 prints the code on stdout as it compiles.
  const suite = await import('../bench/interp/suite.ts');
  const n = Number(a.steps);
  const g = await (a.guest === 'int' ? suite.setup('guest.bin', suite.JIT_DEFAULT)
    : a.guest === 'fp' ? suite.setup('guest-fp.bin', suite.JIT_DEFAULT)
    : a.guest === 'coremark' ? suite.setup('../../target/bench/coremark.bin', suite.JIT_DEFAULT)
    : a.guest === 'el1' || a.guest === 'el1-mmu' ? suite.setupVm(a.guest === 'el1-mmu', 1)
    : Promise.reject(new Error(`unknown --guest ${a.guest}`)));
  // In chunks, so the dispatcher re-enters blocks and V8 tiers them up.
  for (let done = 0; done < n; ) done += g.run(Math.min(10_000_000, n - done));
  process.exit(0);
}

const self = fileURLToPath(import.meta.url);
const flags = ['--disable-warning=ExperimentalWarning', '--print-wasm-code', ...a.v8.split(' ').filter(Boolean)];
const r = spawnSync(process.execPath, [...flags, self, '--child', '--guest', a.guest!, '--steps', a.steps!], {
  maxBuffer: 1 << 30,
  encoding: 'utf8',
});
if (r.status !== 0) throw new Error(`child failed (${r.status}): ${r.stderr.slice(-2000)}`);

type Fn = { name: string; tier: string; size: number; text: string };
const re = new RegExp(a.match!);
const last = new Map<string, Fn>(); // name + tier -> its last compile
for (const rec of r.stdout.split('--- WebAssembly code ---').slice(1)) {
  const text = rec.split('--- End code ---')[0];
  const name = /^name: (.*)$/m.exec(text)?.[1] ?? '?';
  const tier = /^compiler: (.*)$/m.exec(text)?.[1] ?? '?';
  const size = Number(/^Instructions \(size = (\d+)/m.exec(text)?.[1] ?? 0);
  if (!re.test(name) || (a.tier && tier.toLowerCase() !== a.tier.toLowerCase())) continue;
  last.set(`${name} ${tier}`, { name, tier, size, text });
}
for (const f of last.values()) {
  if (a.list) console.log(`${f.name.padEnd(40)} ${f.tier.padEnd(9)} ${f.size} bytes`);
  else console.log(`${f.text.trim()}\n`);
}
if (last.size === 0) console.error(`no function matches /${a.match}/`);
