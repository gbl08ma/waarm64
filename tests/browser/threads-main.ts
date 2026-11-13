// tests/browser/threads.html's worker: runs tests/threads-run.ts with nested
// module workers (tests/threads-worker.ts) and posts the result.
import { threadsRun, type Spawn } from '../threads-run.ts';
import type { Result } from '../threads-worker.ts';

const spawn: Spawn = () => {
  const w = new Worker(new URL('../threads-worker.ts', import.meta.url), { type: 'module' });
  return {
    run: (job) => new Promise<Result>((resolve, reject) => {
      w.onmessage = (e: MessageEvent<Result & { error?: string }>) => (e.data.error ? reject(new Error(e.data.error)) : resolve(e.data));
      w.onerror = (e) => reject(new Error(e.message));
      w.postMessage(job);
    }),
    close: () => w.terminate(),
  };
};

try {
  const get = async (p: string) => new Uint8Array(await (await fetch(p)).arrayBuffer());
  const [wasm, guest] = await Promise.all([get('/target/wasm32-unknown-unknown/release/waarm64_core.wasm'), get('/bench/interp/guest.bin')]);
  self.postMessage(await threadsRun(wasm, guest, spawn));
} catch (e) {
  self.postMessage({ error: String((e as Error).stack ?? e) });
}
