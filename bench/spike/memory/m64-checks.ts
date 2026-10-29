// T19: does V8 check a memory64 index once or at every access when the index is the same value?
//   node bench/spike/memory/m64-checks.ts   (spawns itself under --perf-prof --no-liftoff, prints the code)
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { I32, I64, ModuleBuilder, op } from '../wasm.ts';
import { parseJitdump } from './machine-code.ts';

/** k(p, n): n times, six loads at p+0..40 (memarg offsets, as the JIT's Vcpu fields) and a store at p+48. */
function build(m64: boolean) {
  const m = new ModuleBuilder();
  m.importMemory('env', 'm', { min: 16, max: m64 ? 262144 : 65536, shared: true, memory64: m64 });
  const P = 0, N = 1, I = 2, S = 3;
  const addr = m64 ? op.localGet(P) : [...op.localGet(P), ...op.i32WrapI64];
  const body: number[] = [];
  for (let k = 0; k < 6; k++) body.push(...op.localGet(S), ...addr, ...op.i64Load(k * 8), ...op.i64Add, ...op.localSet(S));
  body.push(...addr, ...op.localGet(S), ...op.i64Store(48));
  const f = m.func(m.type([I64, I32], [I64]), [I32, I64], [
    ...op.block(), ...op.loop(),
    ...op.localGet(I), ...op.localGet(N), ...op.i32GeU, ...op.brIf(1),
    ...body,
    ...op.localGet(I), ...op.i32Const(1), ...op.i32Add, ...op.localSet(I),
    ...op.br(0), ...op.end, ...op.end,
    ...op.localGet(S),
  ]);
  m.exportFunc('k', f);
  m.name(f, m64 ? 'cse_m64' : 'cse_m32');
  return m.bytes();
}

if (process.env.M64_CHILD) {
  for (const m64 of [false, true]) {
    const mem = new WebAssembly.Memory((m64 ? { initial: 16n, maximum: 262144n, shared: true, address: 'i64' } : { initial: 16, maximum: 65536, shared: true }) as WebAssembly.MemoryDescriptor);
    const k = new WebAssembly.Instance(new WebAssembly.Module(build(m64)), { env: { m: mem } }).exports.k as (p: bigint, n: number) => bigint;
    for (let i = 0; i < 200; i++) k(4096n, 10000);
  }
} else {
  const dir = mkdtempSync(join(os.tmpdir(), 'm64cse-'));
  spawnSync(process.execPath, ['--perf-prof', `--perf-prof-path=${dir}`, `--logfile=${dir}/v8.log`, '--no-liftoff', '--disable-warning=ExperimentalWarning', import.meta.filename], { env: { ...process.env, M64_CHILD: '1' }, stdio: 'inherit' });
  const codes = readdirSync(dir).filter((f) => f.startsWith('jit-')).flatMap((f) => parseJitdump(readFileSync(join(dir, f))));
  for (const c of codes.filter((c) => /cse_m(32|64)/.test(c.name))) {
    const bin = join(dir, 'code.bin');
    writeFileSync(bin, c.bytes);
    console.log(`## ${c.name}`);
    console.log(execFileSync('objdump', ['-D', '-b', 'binary', '-m', 'aarch64', bin]).toString().split('\n').filter((l) => /^\s+[0-9a-f]+:/.test(l)).map((l) => l.replace(/^\s+[0-9a-f]+:\t(?:[0-9a-f]{2} )+\s*\t?/, '  ')).join('\n'));
  }
}
