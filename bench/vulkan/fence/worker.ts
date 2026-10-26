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

// VK3 L2b: submits shaped like VK0's scene's in Venus's worker (bench/vulkan/REPORT.md "VK3 L2b"): a render pass at
// 1080p, MSAA 1, colour and depth cleared, `DRAWS` draws through a uniform group with dynamic offsets, the frame's
// writeBuffers (the sizes Venus's stats show a scene frame carries on the M4: ~3 writes, ~66 KB: `WRITES`), optionally a readback mapped, a staging
// buffer made and destroyed a submit (as gpu_readback), empty submits every 1 ms meanwhile (the pump's nudges), the
// page's WebGL drawing meanwhile (the GPU process's GL work), and two frames queued (as the scene's FRAMES_IN_FLIGHT).
// Each part timed in the worker: encoding (encoder to finish), queue.submit's call, and its done; with timestamp-query,
// the pass's GPU ms (Chromium quantizes it to 100 µs without --enable-webgpu-developer-features, which fence.ts passes).
const DRAWS = 120, WRITES = [49152, 16384, 512], W = 1920, H = 1080;
const webgl = (on: boolean) => new Promise<void>((r) => { const c = new MessageChannel(); c.port1.onmessage = () => r(); postMessage({ webgl: on }, [c.port2]); });

async function shapes(n: number) {
  const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) return { skipped: 'no WebGPU adapter' };
  const timed = adapter.features.has('timestamp-query');
  const d = await adapter.requestDevice({ requiredFeatures: timed ? ['timestamp-query'] : [] });
  const color = d.createTexture({ size: [W, H], format: 'rgba8unorm', usage: 16 | 1 | 4 }); // RENDER_ATTACHMENT, COPY_SRC, TEXTURE_BINDING
  const depth = d.createTexture({ size: [W, H], format: 'depth24plus-stencil8', usage: 16 });
  const module = d.createShaderModule({ code: `
    struct U { m: vec4f, c: vec4f }
    @group(0) @binding(0) var<uniform> u: U;
    @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
      let p = array(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
      return vec4f(p[i % 3] * u.m.xy + u.m.zw, 0.5, 1);
    }
    @fragment fn fs() -> @location(0) vec4f { return u.c; }` });
  const layout = d.createBindGroupLayout({ entries: [{ binding: 0, visibility: 1 | 2, buffer: { type: 'uniform', hasDynamicOffset: true } }] });
  const pipeline = d.createRenderPipeline({ layout: d.createPipelineLayout({ bindGroupLayouts: [layout] }), vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
    depthStencil: { format: 'depth24plus-stencil8', depthWriteEnabled: true, depthCompare: 'less-equal' } });
  // The first draw covers the frame (the scene's background), the others are small.
  const u = new Float32Array(DRAWS * 64);
  for (let i = 0; i < DRAWS; i++) u.set(i ? [0.05, 0.05, (i % 12) / 6 - 1, Math.floor(i / 12) / 5 - 1, i / DRAWS, 0.5, 0.2, 1] : [1, 1, 0, 0, 0, 0.8, 1, 1], i * 64);
  const ubuf = d.createBuffer({ size: u.byteLength, usage: 64 | 8 }); // UNIFORM, COPY_DST
  d.queue.writeBuffer(ubuf, 0, u);
  const group = d.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: ubuf, size: 32 } }] });
  const sinks = WRITES.map((size) => d.createBuffer({ size, usage: 64 | 8 }));
  const bytes = WRITES.map((size) => new Uint8Array(size).fill(1));
  const src = d.createBuffer({ size: 256, usage: 4 | 8 });
  const staging = d.createBuffer({ size: 256, usage: 8 | 1 });
  const qs = timed ? d.createQuerySet({ type: 'timestamp', count: 2 }) : undefined;
  const resolved = timed ? d.createBuffer({ size: 16, usage: 0x200 | 4 }) : undefined;
  const times = timed ? [0, 1, 2].map(() => d.createBuffer({ size: 16, usage: 8 | 1 })) : [];
  let timeSlot = 0;
  type Opts = { writes?: boolean; smallWrites?: boolean; map?: boolean; newStaging?: boolean };
  // One frame: its writes, its pass, its submit; resolves with each part's ms once done (and the pass's GPU ms).
  const frame = (o: Opts) => {
    const t0 = performance.now();
    if (o.writes) WRITES.forEach((_, i) => d.queue.writeBuffer(sinks[i], 0, bytes[i]));
    if (o.smallWrites) WRITES.forEach((_, i) => d.queue.writeBuffer(sinks[i], 0, bytes[i], 0, 512));
    const e = d.createCommandEncoder();
    const p = e.beginRenderPass({
      colorAttachments: [{ view: color.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0.8, 1, 1] }],
      depthStencilAttachment: { view: depth.createView(), depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 1, stencilLoadOp: 'clear', stencilStoreOp: 'store' },
      ...(qs ? { timestampWrites: { querySet: qs, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } } : {}),
    });
    p.setPipeline(pipeline);
    for (let i = 0; i < DRAWS; i++) { p.setBindGroup(0, group, [i * 256]); p.draw(3); }
    p.end();
    const tb = times[timeSlot++ % times.length];
    if (qs) { e.resolveQuerySet(qs, 0, 2, resolved!, 0); e.copyBufferToBuffer(resolved!, 0, tb, 0, 16); }
    let fresh: GPUBuffer | undefined;
    if (o.map) e.copyBufferToBuffer(src, 0, staging, 0, 256);
    if (o.newStaging) { fresh = d.createBuffer({ size: 256, usage: 8 | 1 }); e.copyBufferToBuffer(src, 0, fresh, 0, 256); }
    const cb = e.finish();
    const t1 = performance.now();
    d.queue.submit([cb]);
    const t2 = performance.now();
    const waits: Promise<unknown>[] = [d.queue.onSubmittedWorkDone()];
    if (o.map) waits.push(staging.mapAsync(1));
    if (fresh) waits.push(fresh.mapAsync(1));
    return Promise.all(waits).then(async () => {
      const t3 = performance.now();
      if (o.map) staging.unmap();
      fresh?.destroy();
      let gpu: number | undefined;
      if (tb) {
        await tb.mapAsync(1);
        const t = new BigUint64Array(tb.getMappedRange().slice(0));
        tb.unmap();
        gpu = t[1] > t[0] ? Number(t[1] - t[0]) / 1e6 : undefined;
      }
      return { encode: t1 - t0, submit: t2 - t1, done: t3 - t2, gpu };
    });
  };
  // Empty submits every 1 ms while a frame is awaited (the pump's nudges), each timer set from a message's task.
  const nudger = () => {
    let on = true;
    const loop = () => { if (!on) return; d.queue.submit([]); mc(() => setTimeout(loop, 1)); };
    loop();
    return () => { on = false; };
  };
  const out: Record<string, Record<string, Row> & { frameMs?: Row }> = {};
  const summarize = (rs: { encode: number; submit: number; done: number; gpu?: number }[]) => {
    const g = rs.map((r) => r.gpu).filter((x): x is number => x !== undefined);
    return { encodeMs: stat(rs.map((r) => r.encode)), submitMs: stat(rs.map((r) => r.submit)), doneMs: stat(rs.map((r) => r.done)), ...(g.length ? { gpuMs: stat(g) } : {}) };
  };
  // One frame at a time, 2 ms idle between (as fence.ts's other rows).
  const alone = async (name: string, o: Opts, nudge = false) => {
    const rs = [];
    for (let i = 0; i < n + 5; i++) {
      await hop();
      const stop = nudge ? nudger() : undefined;
      const r = await frame(o);
      stop?.();
      if (i >= 5) rs.push(r);
      await new Promise((r) => setTimeout(r, 2));
    }
    out[name] = summarize(rs);
  };
  // Two frames queued, as the scene runs: frame k waits for frame k-2's done, then goes; the frame's period too.
  const queued = async (name: string, o: Opts, nudge = false) => {
    const rs: { encode: number; submit: number; done: number; gpu?: number }[] = [], periods: number[] = [];
    const inFlight: Promise<unknown>[] = [];
    const stop = nudge ? nudger() : undefined;
    let last = performance.now();
    for (let i = 0; i < 4 * n + 20; i++) {
      if (inFlight.length >= 2) await inFlight.shift();
      const now = performance.now();
      if (i >= 20) periods.push(now - last);
      last = now;
      inFlight.push(frame(o).then((r) => { if (i >= 20) rs.push(r); }));
    }
    await Promise.all(inFlight);
    stop?.();
    out[name] = { ...summarize(rs), frameMs: stat(periods) };
  };
  const scene: Opts = { writes: true };
  await alone('pass', {});
  await alone('pass+writes', scene);
  await alone('pass+small writes', { smallWrites: true });
  await alone('pass+writes+map', { writes: true, map: true });
  await alone('pass+writes+newStaging', { writes: true, newStaging: true });
  await alone('pass+writes, nudged', scene, true);
  await queued('two queued', scene);
  await queued('two queued, nudged', scene, true);
  await webgl(true);
  await alone('pass+writes, WebGL drawing', scene);
  await queued('two queued, nudged, WebGL drawing', scene, true);
  await webgl(false);
  // The GPU kept busy between: a frame's pass GPU ms back to back (clocks up) against alone (idle between).
  await queued('back to back', scene, true);
  d.destroy();
  return { timestamps: timed, draws: DRAWS, writes: WRITES, size: [W, H], ...out };
}

self.onmessage = async (m: MessageEvent<{ n: number }>) => {
  const n = m.data.n;
  try {
    const timers: Record<string, Row> = {};
    for (const k of ['setTimeout', 'message', 'postTask', 'setTimeout-from-message', 'setTimeout1-from-message', 'waitAsync-0.25', 'waitAsync-0.5', 'waitAsync-1']) {
      if (k === 'postTask' && !('scheduler' in globalThis)) continue;
      timers[k] = await turns(n, k);
    }
    const g = await gpu(n);
    postMessage({ timers, gpu: g, shapes: await shapes(n) });
  } catch (err) {
    postMessage({ error: String(err) });
  }
};
