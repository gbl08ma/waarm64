// The machine worker's side of the RAM map (docs/frontend.md "RAM's map"): a `ram-*` query from the page goes to a
// scanner worker (web/app/ram-scan-worker.ts) that this worker starts on the first one, hands the machine's RAM (its
// shared buffers: memory 0's RAM and the spill memories) and ends when no query has come for `IDLE_MS` (the window
// closed, the page hidden) or the machine is another. Nothing runs while no one asks: no worker, no pass.
import type { Vm } from '../vm.ts';
import type { RamPart } from '../ram-scan.ts';
import type { InspectAnswer, InspectQuery } from '../surface.ts';
import type { FromRamScan, ToRamScan } from './ram-scan-worker.ts';
import { endWithOwner } from '../worker-end.ts';

/** How long the scanner stays without a query (the page asks at least every few seconds while its window is open). */
const IDLE_MS = 20_000;

type Scanner = {
  vm: Vm;
  worker: Worker;
  asks: Map<number, (a: InspectAnswer) => void>;
  idle?: ReturnType<typeof setTimeout>;
};
let scanner: Scanner | undefined;
let lastId = 0;

/** The machine's RAM as the scanner reads it, where it lies (none when it isn't on shared buffers: nothing to share). */
export function ramParts(vm: Pick<Vm, 'memory' | 'ram' | 'layout' | 'spill'>): RamPart[] | undefined {
  const parts = vm.layout.map((l, k) => ({
    buffer: k === 0 ? vm.memory.buffer : vm.spill[k - 1].buffer,
    offset: k === 0 ? vm.ram : l.off,
    size: l.size,
    pa: l.pa,
  }));
  return parts.every((p) => p.buffer instanceof SharedArrayBuffer) ? parts : undefined;
}

function end(s: Scanner, ending = false) {
  clearTimeout(s.idle);
  endWithOwner(s.worker, ending);
  for (const reply of s.asks.values()) reply({ kind: 'none' });
  s.asks.clear();
  if (scanner === s) scanner = undefined;
}

function start(vm: Vm): Scanner | undefined {
  const parts = ramParts(vm);
  if (!parts) return undefined;
  const worker = new Worker(new URL('./ram-scan-worker.ts', import.meta.url), { type: 'module' });
  const s: Scanner = { vm, worker, asks: new Map() };
  worker.onmessage = (e: MessageEvent<FromRamScan>) => {
    const reply = s.asks.get(e.data.id);
    s.asks.delete(e.data.id);
    reply?.(e.data.answer);
  };
  worker.onerror = () => end(s);
  worker.postMessage({ type: 'parts', parts } satisfies ToRamScan);
  return s;
}

/** Answers a `ram-*` query about `vm`'s RAM through the scanner (started if it isn't). */
export function inspectRam(vm: Vm | undefined, query: InspectQuery): Promise<InspectAnswer> {
  if (scanner && scanner.vm !== vm) end(scanner);
  if (!vm) return Promise.resolve({ kind: 'none' });
  scanner ??= start(vm);
  const s = scanner;
  if (!s) return Promise.resolve({ kind: 'none' });
  clearTimeout(s.idle);
  s.idle = setTimeout(() => end(s), IDLE_MS);
  const id = ++lastId;
  return new Promise((resolve) => {
    s.asks.set(id, resolve);
    s.worker.postMessage({ type: 'ask', id, query } satisfies ToRamScan);
  });
}

/** Ends the scanner (the machine stops: this worker ends next, the scanner with it: web/worker-end.ts `endWithOwner`). */
export function stopRam() {
  if (scanner) end(scanner, true);
}
