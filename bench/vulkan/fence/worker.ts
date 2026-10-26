// VK3 L2 (bench/vulkan/fence.ts): in a dedicated worker, (1) what a turn of each way of yielding costs (a nested
// setTimeout(0), a MessageChannel message, scheduler.postTask, a setTimeout(0) set from a message's task) and (2) how
// long WebGPU takes to say a submit is done (onSubmittedWorkDone, a mapAsync), alone and with the worker doing
// something meanwhile (nothing but turns of a MessageChannel; empty submits; writeBuffer), and an error scope's round
// trip (the GPU process's IPC alone, no device tick).
// GPUBufferUsage and GPUMapMode by value (COPY_SRC 4, COPY_DST 8, MAP_READ 1; READ 1): the types know no globals here.
type Row = { median: number; p10: number; p90: number; iqr: number; n: number };
const stat = (v: number[]): Row => {
  const s = [...v].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { median: +q(0.5).toFixed(3), p10: +q(0.1).toFixed(3), p90: +q(0.9).toFixed(3), iqr: +(q(0.75) - q(0.25)).toFixed(3), n: s.length };
};
const channel = () => { const c = new MessageChannel(); return (f: () => void) => { c.port1.onmessage = f; c.port2.postMessage(0); }; };
const mc = channel();
const word = new Int32Array(new SharedArrayBuffer(4));
const hop = () => new Promise<void>((r) => mc(() => r()));

async function turns(n: number, kind: string): Promise<Row> {
  const times: number[] = [];
  await new Promise<void>((done) => {
    let last = performance.now(), i = 0;
    const post = (globalThis as unknown as { scheduler?: { postTask(f: () => void, o?: object): Promise<void> } }).scheduler;
    const next = () => {
      const now = performance.now();
      if (i++) times.push(now - last);
      last = now;
      if (i > n) return done();
      if (kind === 'setTimeout') setTimeout(next, 0);
      else if (kind === 'message') mc(next);
      else if (kind === 'postTask') void post!.postTask(next, { priority: 'user-blocking' });
      else if (kind === 'setTimeout-from-message') mc(() => setTimeout(next, 0));
      else if (kind === 'setTimeout1-from-message') mc(() => setTimeout(next, 1));
      else if (kind.startsWith('waitAsync-')) {
        // A wait on a word nobody notifies: it resolves at its timeout (ms, fractional).
        const r = (Atomics as unknown as { waitAsync(a: Int32Array, i: number, v: number, t: number): { async: boolean; value: Promise<string> | string } }).waitAsync(word, 0, 0, Number(kind.slice(10)));
        if (r.async) void (r.value as Promise<string>).then(next);
        else mc(next);
      }
    };
    next();
  });
  return stat(times);
}

async function gpu(n: number) {
  const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) return { skipped: 'no WebGPU adapter' };
  const d = await adapter.requestDevice();
  const src = d.createBuffer({ size: 256, usage: 4 | 8 });
  const dst = d.createBuffer({ size: 256, usage: 8 | 1 });
  const work = () => { const e = d.createCommandEncoder(); e.copyBufferToBuffer(src, 0, dst, 0, 256); d.queue.submit([e.finish()]); };
  // A background activity while a fence is awaited, stopped after.
  const busy = (what: string) => {
    let on = true;
    let last = 0;
    const loop = () => {
      if (!on) return;
      if (what === 'submit') d.queue.submit([]);
      else if (what === 'write') d.queue.writeBuffer(src, 0, new Uint32Array(1));
      else if (what === 'submit-0.25ms') { const t = performance.now(); if (t - last >= 0.25) { last = t; d.queue.submit([]); } }
      if (what === 'scope' || what === 'submit+scope') {
        if (what === 'submit+scope') d.queue.submit([]);
        d.pushErrorScope('validation');
        void d.popErrorScope().then(loop);
      } else if (what === 'submit-1ms-timer') { d.queue.submit([]); mc(() => setTimeout(loop, 1)); }
      else mc(loop);
    };
    if (what !== 'none') loop();
    return () => { on = false; };
  };
  const out: Record<string, Row> = {};
  const measure = async (name: string, f: () => Promise<unknown>, during = 'none') => {
    const v: number[] = [];
    for (let i = 0; i < n + 5; i++) {
      await hop();
      const stop = busy(during);
      const t0 = performance.now();
      await f();
      const dt = performance.now() - t0;
      stop();
      if (i >= 5) v.push(dt);
      // Idle a little between, as a frame's fences are apart.
      await new Promise((r) => setTimeout(r, 2));
    }
    out[name] = stat(v);
  };
  await measure('errorScope', async () => { d.pushErrorScope('validation'); await d.popErrorScope(); });
  await measure('emptySubmitDone', async () => { d.queue.submit([]); await d.queue.onSubmittedWorkDone(); });
  await measure('copyDone', async () => { work(); await d.queue.onSubmittedWorkDone(); });
  await measure('copyMap', async () => { work(); await dst.mapAsync(1); dst.unmap(); });
  await measure('copyDoneAndMap', async () => { work(); await Promise.all([d.queue.onSubmittedWorkDone(), dst.mapAsync(1)]); dst.unmap(); });
  await measure('copyDone+messages', async () => { work(); await d.queue.onSubmittedWorkDone(); }, 'loop');
  await measure('copyDone+emptySubmits', async () => { work(); await d.queue.onSubmittedWorkDone(); }, 'submit');
  await measure('copyDone+writeBuffer', async () => { work(); await d.queue.onSubmittedWorkDone(); }, 'write');
  for (const k of ['submit-0.25ms', 'submit-1ms-timer', 'scope', 'submit+scope']) await measure(`copyDone+${k}`, async () => { work(); await d.queue.onSubmittedWorkDone(); }, k);
  await measure('copyDoneAndMap+submit-1ms-timer', async () => { work(); await Promise.all([d.queue.onSubmittedWorkDone(), dst.mapAsync(1)]); dst.unmap(); }, 'submit-1ms-timer');
  d.destroy();
  return { adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device, description: adapter.info.description }, ...out };
}

self.onmessage = async (m: MessageEvent<{ n: number }>) => {
  const n = m.data.n;
  try {
    const timers: Record<string, Row> = {};
    for (const k of ['setTimeout', 'message', 'postTask', 'setTimeout-from-message', 'setTimeout1-from-message', 'waitAsync-0.25', 'waitAsync-0.5', 'waitAsync-1']) {
      if (k === 'postTask' && !('scheduler' in globalThis)) continue;
      timers[k] = await turns(n, k);
    }
    postMessage({ timers, gpu: await gpu(n) });
  } catch (err) {
    postMessage({ error: String(err) });
  }
};
