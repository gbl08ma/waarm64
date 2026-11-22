// A machine's workers started ahead of its `bootVm` (web/warm-workers.ts `warmWorkers`, `BootOptions.warm`; bench/boot/REPORT.md
// "SNAPZ loop 7"): what `take` hands out, a worker that failed to load replaced, the rest ended (by `end`, once the vCPU
// workers are started, when `bootVm` fails). The browser's workers are faked here (`Worker`, `WorkerGlobalScope`).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { bootVm } from '../web/vm.ts';
import { warmWorkers, type WarmWorkers } from '../web/warm-workers.ts';

class FakeWorker {
  static made: FakeWorker[] = [];
  terminated = false;
  onerror: ((e: { preventDefault(): void }) => void) | null = null;
  readonly url: URL;
  readonly options: WorkerOptions;
  constructor(url: URL, options: WorkerOptions) {
    this.url = url;
    this.options = options;
    FakeWorker.made.push(this);
  }
  terminate() {
    this.terminated = true;
  }
  get file() {
    return this.url.pathname.split('/').pop();
  }
}

/** `f` with the fake browser workers in place. */
function withFakeWorkers(f: () => void) {
  const g = globalThis as Record<string, unknown>;
  FakeWorker.made = [];
  g.Worker = FakeWorker;
  g.WorkerGlobalScope = class {};
  try {
    f();
  } finally {
    delete g.Worker;
    delete g.WorkerGlobalScope;
  }
}

test('warm workers: each kind made ahead, taken in turn, then made anew', () =>
  withFakeWorkers(() => {
    const warm = warmWorkers(3, true)!;
    assert.deepEqual(
      FakeWorker.made.map((w) => [w.file, w.options.type]),
      [['device-worker.ts', 'module'], ['vcpu-worker.ts', 'module'], ['vcpu-worker.ts', 'module'], ['vcpu-worker.ts', 'module'], ['jit-compile-worker.ts', 'module']],
    );
    const ahead = [...FakeWorker.made];
    assert.equal(warm.take('device'), ahead[0]);
    assert.deepEqual([warm.take('vcpu'), warm.take('vcpu'), warm.take('vcpu')], ahead.slice(1, 4));
    const more = warm.take('vcpu') as unknown as FakeWorker; // a snapshot's machine with more vCPUs than the page's
    assert.equal(more.file, 'vcpu-worker.ts');
    assert.ok(!ahead.includes(more));
    assert.equal(warm.take('compile'), ahead[4]);
    // Taken workers are the machine's: `end` leaves them, and their error handler is theirs to set.
    warm.end();
    assert.ok(FakeWorker.made.every((w) => !w.terminated));
    assert.ok(ahead.every((w) => w.onerror === null));
  }));

test("warm workers: `end` ends the ones not taken; one that failed to load is replaced", () =>
  withFakeWorkers(() => {
    const warm = warmWorkers(2, false)!;
    const [device, cpu0, cpu1] = FakeWorker.made;
    let prevented = 0;
    cpu0.onerror!({ preventDefault: () => prevented++ }); // its module didn't load: not the page's error
    assert.equal(prevented, 1);
    const taken = warm.take('vcpu') as unknown as FakeWorker;
    assert.ok(cpu0.terminated, 'the failed worker ended');
    assert.ok(taken !== cpu0 && taken.file === 'vcpu-worker.ts' && !taken.terminated, 'a new one made in its place');
    warm.end();
    assert.ok(device.terminated && cpu1.terminated, 'the ones not taken ended');
    assert.ok(!taken.terminated);
    assert.equal(FakeWorker.made.filter((x) => x.file === 'jit-compile-worker.ts').length, 0, 'no compile worker unless asked');
  }));

test('warm workers: none outside a browser worker', () => {
  assert.equal(warmWorkers(4, true), undefined); // Node: no Worker global
  withFakeWorkers(() => {
    delete (globalThis as Record<string, unknown>).WorkerGlobalScope; // a page's thread
    assert.equal(warmWorkers(4, true), undefined);
    assert.equal(FakeWorker.made.length, 0);
  });
});

/** A `WarmWorkers` that counts its `end`s (Node's vCPU workers are its own: nothing is taken). */
const counting = () => {
  const w = { ends: 0, takes: 0 };
  const warm: WarmWorkers = {
    take: () => {
      w.takes++;
      throw new Error('take in Node');
    },
    end: () => void w.ends++,
  };
  return { w, warm };
};

const wasm = readFileSync(new URL('../target/wasm32-unknown-unknown/release/waarm64_core.wasm', import.meta.url));

test('bootVm ends the warm workers once its vCPU workers are started', async () => {
  const { w, warm } = counting();
  const kernel = readFileSync(new URL('baremetal/smp.bin', import.meta.url));
  const vm = await bootVm(wasm, { ramSize: 16 << 20, kernel, kernelOffset: 0, cmdline: '', ncpus: 4, parallel: true, realtime: true, idleLimitMs: 30_000, jit: 1, warm });
  try {
    assert.equal(w.ends, 0, 'not before the vCPUs start');
    await vm.runAsync(1000); // the first run starts the vCPU workers
    assert.equal(w.ends, 1, 'ended once they started');
    assert.equal(w.takes, 0);
  } finally {
    await vm.close();
  }
});

test('bootVm ends the warm workers when it fails', async () => {
  const { w, warm } = counting();
  await assert.rejects(bootVm(wasm, { ramSize: 16 << 20, kernel: new Uint8Array(4), cmdline: '', spill: [1], warm }), RangeError);
  assert.equal(w.ends, 1);
});

test('a machine that is not parallel ends the warm workers at its boot', async () => {
  const { w, warm } = counting();
  const kernel = readFileSync(new URL('baremetal/smp.bin', import.meta.url));
  const vm = await bootVm(wasm, { ramSize: 16 << 20, kernel, kernelOffset: 0, cmdline: '', ncpus: 1, warm });
  assert.equal(w.ends, 1);
  await vm.close();
});
