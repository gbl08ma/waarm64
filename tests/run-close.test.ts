// A run's end (web/app/run/run.ts `Run.close`) in Node, with a stand-in machine worker: the saves still in progress
// when its workers end fail, so the page's save (`power.saving`) ends with them (docs/frontend.md "Snapshots").
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { msgOf } from '../web/msg.ts';
import { Run, type RunHolder, type SnapshotJob } from '../web/app/run/run.ts';
import type { FromWorker, ToWorker } from '../web/app/protocol.ts';

/** A machine worker that answers `stop` with `stopped` at once (a guest that powered off: nothing to wait for). */
class Stand extends EventTarget {
  terminated = false;
  posted: ToWorker[] = [];
  postMessage(m: ToWorker) {
    this.posted.push(m);
    if (m.type === 'stop')
      queueMicrotask(() =>
        this.dispatchEvent(new MessageEvent('message', { data: { type: 'stopped' } satisfies FromWorker })),
      );
  }
  terminate() {
    this.terminated = true;
  }
}

function runOf(worker: Stand) {
  const holder: RunHolder = { run: undefined };
  const ch = { serial: new MessageChannel(), display: new MessageChannel(), netLinks: [] };
  const r = new Run(holder, { worker: worker as unknown as Worker, input: {} as never, ch });
  holder.run = r;
  return { r, ports: () => (ch.serial.port1.close(), ch.display.port1.close()) };
}

test("a save still in progress when the run's workers end fails (the worker said stopped without its done)", async () => {
  const w = new Stand();
  const { r, ports } = runOf(w);
  const ended: unknown[] = [];
  const job: SnapshotJob = {
    progress: () => {},
    chunk: () => {},
    done: () => ended.push('done'),
    error: (e) => ended.push(e),
  };
  r.save({ type: 'snapshot', keep: 'x' } as never, job);
  await r.close();
  ports();
  assert.ok(w.terminated);
  assert.equal(ended.length, 1, 'the job ended');
  assert.equal(msgOf(ended[0])?.key, 'snapshots:run.stopped');
  assert.equal(r.job(1), undefined, 'and is dropped');
});

test("the machine worker's stop waits for a save in progress to end (web/app/worker-saving.ts `saveSettled`), bounded", async () => {
  const posted: FromWorker[] = [];
  (globalThis as { self?: unknown }).self ??= { postMessage: (m: FromWorker) => posted.push(m) };
  const { saveSnapshot } = await import('../web/app/worker-snapshot.ts');
  const { saveSettled } = await import('../web/app/worker-saving.ts');
  assert.equal(await Promise.race([saveSettled(5000).then(() => 'settled'), new Promise((r) => setTimeout(r, 200, 'waited'))]), 'settled', 'none in progress: at once');
  // A save whose codec never comes until let go: it is in progress (as a staged file's copy after the resume).
  let go!: (e: Error) => void;
  const codec = new Promise<never>((_, reject) => (go = reject));
  const save = saveSnapshot({ codec: () => codec } as never, 7, undefined, 'x');
  const settled = saveSettled(60_000).then(() => 'settled');
  assert.equal(await Promise.race([settled, new Promise((r) => setTimeout(r, 200, 'waited'))]), 'waited', 'it waits for the save');
  go(new Error('let go'));
  await save;
  assert.equal(await settled, 'settled', 'and ends with it');
  assert.ok(posted.some((m) => m.type === 'snapshot-error'));
  // Bounded: a save that never ends is waited for `ms` only.
  const stuck = saveSnapshot({ codec: () => new Promise(() => {}) } as never, 8, undefined, 'y');
  void stuck;
  const t0 = performance.now();
  await saveSettled(100);
  assert.ok(performance.now() - t0 < 2000);
});
