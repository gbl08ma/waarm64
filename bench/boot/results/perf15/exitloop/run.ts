// PERF loop 15: exitloop.bin in parallel SMP (realtime, JIT) in Node: ns per always-exiting `mrs cntfrq_el0`,
// fast-completed `isb`, `wfe` yield, empty iteration.   node run.ts [ncpus] [wasm]
import { readFileSync } from 'node:fs';
import { runToPowerOff } from '../../../../../web/test-guests.ts';
const ncpus = Number(process.argv[2] ?? 2);
const wasm = readFileSync(process.argv[3] ?? new URL('../../../../../target/wasm32-unknown-unknown/release/webpc_core.wasm', import.meta.url));
const kernel = readFileSync(new URL(process.env.BIN ?? 'exitloop.bin', import.meta.url));
const r = await runToPowerOff(wasm, { ramSize: 16 << 20, kernel, kernelOffset: 0, cmdline: '', ncpus, parallel: true, realtime: true, idleLimitMs: 30_000, jit: 1, rng: false }, 1e12, undefined, undefined, 120_000);
console.log(r.console.trim());
console.log(JSON.stringify({ kind: r.kind, steps: r.steps, ms: Math.round(r.ms), par: r.stats?.par, jit: r.stats?.jit }));
