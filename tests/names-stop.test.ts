// The names agent's start and stop (web/names.ts `NamesAgent`): a pass still running when the agent stops arms no
// timer; a pass that fails tries again later; the worker backend refuses what waits when it closes or its worker fails.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryNamesStore } from '../web/names-store.ts';
import { NamesAgent, workerBackend } from '../web/names.ts';
import type { NamesBackend } from '../web/names-ops.ts';

const idle: NamesBackend = {
  op: () => Promise.reject(new Error('unused')),
  publish: () => Promise.reject(new Error('unused')),
  ids: () => Promise.reject(new Error('unused')),
  close() {},
};
const settle = () => new Promise((r) => setTimeout(r, 10));

test('a pass that ends after stop arms no timer', async () => {
  const store = memoryNamesStore();
  let release = () => {};
  const held = new Promise<void>((r) => (release = r));
  const titles = store.titles.bind(store);
  store.titles = async (k?: string) => {
    await held;
    return titles(k);
  };
  const agent = new NamesAgent({ store, backend: idle, log: () => {} });
  void agent.start();
  await settle();
  agent.stop();
  release();
  await settle();
  assert.equal(Reflect.get(agent, 'timer'), undefined);
});

test("a pass whose store fails is tried again (the timer is armed), not dropped", async () => {
  const store = memoryNamesStore();
  store.titles = () => Promise.reject(new Error('transient'));
  const logs: string[] = [];
  const agent = new NamesAgent({ store, backend: idle, log: (s) => logs.push(s) });
  await agent.start();
  await settle();
  assert.notEqual(Reflect.get(agent, 'timer'), undefined);
  agent.stop();
  assert.ok(logs.some((l) => l.includes('transient')));
});

test("the worker backend refuses what waits when it's closed or its worker fails", async () => {
  class FakeWorker {
    static last?: FakeWorker;
    onmessage: unknown = null;
    onerror: ((e: { message: string }) => void) | null = null;
    onmessageerror: unknown = null;
    constructor() {
      FakeWorker.last = this;
    }
    postMessage() {}
    terminate() {}
  }
  const g = globalThis as Record<string, unknown>;
  const real = g.Worker;
  g.Worker = FakeWorker;
  try {
    const a = workerBackend('x.wasm');
    const asked = a.op('key', {});
    FakeWorker.last!.onerror!({ message: 'trap' });
    await assert.rejects(asked);
    const b = workerBackend('x.wasm');
    const asked2 = b.ids('link', 0);
    b.close();
    await assert.rejects(asked2);
    await assert.rejects(b.op('key', {}));
  } finally {
    g.Worker = real;
  }
});
