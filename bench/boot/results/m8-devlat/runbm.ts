// node bench/boot/results/m8-devlat/runbm.ts [jit]: devbench.bin (build: devbench.c's header) in Node, realtime, one virtio device; jit 1 the JIT, 4 the block interpreter only.
import { readFileSync } from 'node:fs';
import { runToPowerOff } from '../../../../web/test-guests.ts';
const WASM = readFileSync(new URL('../../../../target/wasm32-unknown-unknown/release/webpc_core.wasm', import.meta.url));
const jit = Number(process.argv[2] ?? 1) as 0 | 1;
const r = await runToPowerOff(WASM, { ncpus: 1, jit, parallel: process.env.PAR === '1', realtime: true, idleLimitMs: 20_000, ramSize: 64 << 20, kernel: readFileSync(new URL('devbench.bin', import.meta.url)), kernelOffset: 0, cmdline: '', devices: [{ type: 'rng' } as never] }, 1e12);
console.log(r.console);
process.exit(0);
