// PERF loop 21's MMIO read micro-benchmark (bench/boot/REPORT.md): node run.ts <bin...> for mmio.c's builds
// (-DADDR=<register's PA, or RAM's 0x40000000> -DN=<iterations of 8 reads>, start.S and link.ld as tests/baremetal/build.sh's);
// env NCPUS (1), PAR (1: parallel SMP, realtime), JIT (1), RUNS (5), WASM, FW (the firmware configuration), OUT (JSON).
import { readFileSync, writeFileSync } from 'node:fs';
import { runToPowerOff } from '../../../../web/vm.ts';
const WASM = readFileSync(process.env.WASM ?? new URL('../../../../target/wasm32-unknown-unknown/release/waarm64_core.wasm', import.meta.url));
const mod = await WebAssembly.compile(WASM);
const base = { ncpus: Number(process.env.NCPUS ?? 1), jit: Number(process.env.JIT ?? 1) as 0 | 1 | 2 | 3, parallel: process.env.PAR !== '0', realtime: true, idleLimitMs: 20_000 };
const out: Record<string, number[]> = {};
for (let i = 0; i < Number(process.env.RUNS ?? 5); i++) {
  for (const bin of process.argv.slice(2)) {
    const r = await runToPowerOff(mod, { ...base, ramSize: 16 << 20, kernel: readFileSync(bin), kernelOffset: 0, cmdline: '', firmware: process.env.FW ? {} : undefined }, 1e12);
    const name = bin.split('/').pop()!;
    (out[name] ??= []).push(r.ms);
    if (!/exit 0/.test(r.console)) console.log(name, 'console:', r.console.slice(-200), 'x1', r.x[1]);
  }
}
const med = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];
if (process.env.OUT) writeFileSync(process.env.OUT, JSON.stringify({ wasm: process.env.WASM, node: process.version, runs: out }, null, 1));
for (const [k, v] of Object.entries(out)) console.log(k, 'median ms', med(v).toFixed(1), 'runs', v.map((x) => x.toFixed(0)).join(' '));
process.exit(0);
