// V8's TurboFan code for a dumped set of JIT modules (bench/jit/dump-modules.ts), on arm64 (this Node) and x64 (Node's
// x64 build under qemu-user: tools/x64node.ts), summed per function (docs/benchmarking.md "The JIT's machine code, x64
// and arm64"): instructions, machine-code bytes, stack slots, and instructions with a frame-relative memory operand
// (spills and fills, plus V8's own frame set-up and tear-down, the same for every function: compare arms, not
// absolute numbers). Each set compiles in a child Node with every function eager in TurboFan, one thread:
//   node bench/jit/codestats.ts <dir> [<dir>...] [--arch arm64,x64] [--json out.json]
// With two or more sets, each after the first is compared with it (per function means, and the change).
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';

const { values: a, positionals } = parseArgs({
  allowPositionals: true,
  options: { arch: { type: 'string', default: 'arm64,x64' }, json: { type: 'string' } },
});

// The child: compiles every module eagerly, so V8 prints each function's code once (`--print-wasm-code`). Plain
// JavaScript through `-e`: a .ts file would be stripped by Node's own wasm module, whose code V8 would print too.
const CHILD = `const fs = require('node:fs'); const dir = process.argv[1];
const files = fs.readdirSync(dir).filter((f) => /^m\\d+\\.wasm$/.test(f)).sort();
for (const f of files) new WebAssembly.Module(fs.readFileSync(dir + '/' + f));
console.error('compiled ' + files.length + ' modules');`;

type Stats = { functions: number; insns: number; bytes: number; slots: number; frame: number };
const V8 = ['--no-liftoff', '--no-wasm-lazy-compilation', '--single-threaded', '--print-wasm-code'];
const X64 = new URL('../../target/x64node/', import.meta.url).pathname;
// A frame-relative memory operand: x64 [rbp-…], [rsp+…], [rsp]; arm64 [fp, #-…], [sp, #…], [sp].
const FRAME = /\[rbp-|\[rsp\+|\[rsp\]|\[fp, #-|\[sp, #|\[sp\]/;

function command(arch: string): [string, string[]] {
  if (arch === process.arch) return [process.execPath, [...V8, '-e', CHILD]];
  if (arch !== 'x64') throw new Error(`--arch ${arch}: arm64 or x64`);
  const node = `${X64}node-${process.version}-linux-x64/bin/node`;
  if (!existsSync(node)) throw new Error(`${node}: missing (node tools/x64node.ts)`);
  return ['qemu-x86_64', ['-L', `${X64}sysroot`, node, ...V8, '-e', CHILD]];
}

async function stats(arch: string, dir: string): Promise<Stats> {
  const [cmd, args] = command(arch);
  const p = spawn(cmd, [...args, dir], { stdio: ['ignore', 'pipe', 'inherit'] });
  const s: Stats = { functions: 0, insns: 0, bytes: 0, slots: 0, frame: 0 };
  let turbofan = false;
  for await (const l of createInterface({ input: p.stdout! })) {
    if (l.startsWith('compiler: ')) turbofan = l === 'compiler: TurboFan';
    if (!turbofan) continue;
    if (l.startsWith('0x')) {
      s.insns++;
      if (FRAME.test(l)) s.frame++;
    } else if (l.startsWith('Instructions (size = ')) {
      s.functions++;
      s.bytes += Number(l.match(/size = (\d+)/)![1]);
    } else if (l.startsWith('Safepoints (stack slots = ')) {
      s.slots += Number(l.match(/stack slots = (\d+)/)![1]);
    }
  }
  const code = await new Promise<number | null>((ok) => p.on('close', ok));
  if (code !== 0) throw new Error(`${arch} ${dir}: exit ${code}`);
  return s;
}

const KEYS = ['insns', 'bytes', 'slots', 'frame'] as const;
const NAMES = { insns: 'instructions', bytes: 'code bytes', slots: 'stack slots', frame: 'frame memory operands' };
const results: Record<string, Record<string, Stats>> = {};
for (const arch of a.arch!.split(',')) {
  results[arch] = {};
  for (const dir of positionals) {
    const t0 = performance.now();
    const s = await stats(arch, dir);
    results[arch][dir] = s;
    console.log(`${arch} ${dir}: ${s.functions} functions, ${KEYS.map((k) => `${NAMES[k]} ${s[k]}`).join(', ')} (${((performance.now() - t0) / 1000).toFixed(0)} s)`);
  }
  const [base, ...rest] = positionals.map((d) => results[arch][d]);
  for (const [i, s] of rest.entries()) {
    const per = (x: Stats, k: (typeof KEYS)[number]) => x[k] / x.functions;
    console.log(`${arch} ${positionals[i + 1]} vs ${positionals[0]}, per function: ${KEYS.map((k) => `${NAMES[k]} ${per(base, k).toFixed(1)} -> ${per(s, k).toFixed(1)} (${((100 * per(s, k)) / per(base, k) - 100).toFixed(1)}%)`).join(', ')}`);
  }
}
if (a.json) writeFileSync(a.json, JSON.stringify({ date: new Date().toISOString(), node: process.version, v8: process.versions.v8, flags: V8, sets: positionals, results }, null, 1));
