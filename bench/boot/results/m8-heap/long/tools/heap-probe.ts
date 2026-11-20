// Ad hoc: the heap after N `b .+4` blocks (old or new core). Args: blocks, heap reserve MiB.
import { readFileSync } from 'node:fs';
import type { Vm } from '../../../../../../web/vm.ts';
import { runToPowerOff } from '../../../../../../web/test-guests.ts';
const WASM = readFileSync(process.env.WEBPC_WASM ?? new URL('../../../../../../target/wasm32-unknown-unknown/release/webpc_core.wasm', import.meta.url));
const MiB = 1 << 20;
const n = Number(process.argv[2]);
const w = new Uint32Array(n + 3);
w.fill(0x1400_0001, 0, n);
w.set([0xd280_0100, 0xf2b0_8000, 0xd400_0002], n);
let vm: Vm | undefined;
const t = performance.now();
const r = await runToPowerOff(WASM, { ramSize: 64 * MiB, kernel: new Uint8Array(w.buffer), cmdline: '', jit: 1, heapReserve: Number(process.argv[3] ?? 1024) * MiB }, 1e9, (v) => (vm = v));
const u = vm!.hostUse();
const j = r.stats.jit;
console.log(JSON.stringify({ n, ms: Math.round(performance.now() - t), kind: r.kind, steps: r.steps, live: u.heapLive / MiB, peak: u.heapPeak / MiB, keys: u.jitKeys, keyMiB: u.jitKeyBytes / MiB, prunes: j.prunes, decoded: j.decoded, decClears: j.decClears, decMiB: j.decBytes / MiB, flushes: j.flushes, rescues: j.rescues }));
