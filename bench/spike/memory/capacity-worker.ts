// Worker side of the capacity experiments: allocates memories in a dedicated
// worker (same renderer process) and runs wasm functions for the atomics tests.
import { mk, touch, type Desc } from './capacity-page.ts';

const held: WebAssembly.Memory[] = [];
const err = (e: unknown) => ({ name: (e as Error).name, message: (e as Error).message });

type Msg = { id: number; cmd: string; desc: Desc; k: number; touchBytes: number; mod: WebAssembly.Module; mems: WebAssembly.Memory[]; fn: string; args: unknown[] };

self.onmessage = (e: MessageEvent<Msg>) => {
  const m = e.data;
  const reply = (result: unknown) => self.postMessage({ id: m.id, result });
  switch (m.cmd) {
    case 'ping': return reply('pong');
    case 'allocMany': {
      for (let i = 0; i < m.k; i++) {
        try {
          const mem = mk(m.desc);
          if (m.touchBytes) touch(mem, 0, m.touchBytes);
          held.push(mem);
        } catch (x) { return reply({ allocated: i, error: err(x) }); }
      }
      return reply({ allocated: m.k });
    }
    case 'freeAll': { held.length = 0; (globalThis as unknown as { gc: () => void }).gc(); return reply(true); }
    case 'run': {
      const env = Object.fromEntries(m.mems.map((x, i) => [`m${i}`, x]));
      const ex = new WebAssembly.Instance(m.mod, { env }).exports as Record<string, (...a: unknown[]) => unknown>;
      return reply(ex[m.fn](...m.args));
    }
  }
};
