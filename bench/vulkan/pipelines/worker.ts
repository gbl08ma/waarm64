// The worker of bench/vulkan/pipelines/page.ts: `n` render pipelines whose fragment shaders are unique to `seed` (a
// chain of `size` dependent operations, so the compiler has work), made one by one or all at once, then one submit
// drawing a triangle with each, timed until WebGPU says it is done.
const shader = (seed: number, i: number, size: number) => {
  const lines = [`var a = vec4<f32>(p.xy * ${(seed % 997) / 1000 + i}, ${i}.0, 1.0);`];
  for (let k = 0; k < size; k++) {
    const c = ((seed * 31 + i * 7 + k * 13) % 1000) / 1000;
    lines.push(k % 3 === 0 ? `a = sin(a * ${c.toFixed(3)} + a.yzwx);` : k % 3 === 1 ? `a = a * a.wxyz + vec4<f32>(${c.toFixed(3)});` : `if (a.x > ${c.toFixed(3)}) { a = a.zwxy; } else { a = fract(a); }`);
  }
  return `@vertex fn vs(@builtin(vertex_index) v: u32) -> @builtin(position) vec4<f32> {
  return vec4<f32>(f32(v & 1u), f32(v >> 1u), 0.0, 1.0);
}
@fragment fn fs(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
  ${lines.join('\n  ')}
  return a;
}`;
};

onmessage = async (e: MessageEvent<{ mode: 'sync' | 'async'; n: number; seed: number; size: number }>) => {
  const { mode, n, seed, size } = e.data;
  const adapter = (await navigator.gpu.requestAdapter())!;
  const device = await adapter.requestDevice();
  const target = device.createTexture({ size: [16, 16], format: 'rgba8unorm', usage: 16 /* RENDER_ATTACHMENT */ });
  const descs: GPURenderPipelineDescriptor[] = [];
  for (let i = 0; i < n; i++) {
    const module = device.createShaderModule({ code: shader(seed, i, size) });
    descs.push({ layout: 'auto', vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] }, primitive: { topology: 'triangle-list' } });
  }
  const t0 = performance.now();
  let pipelines: GPURenderPipeline[];
  if (mode === 'sync') pipelines = descs.map((d) => device.createRenderPipeline(d));
  else pipelines = await Promise.all(descs.map((d) => device.createRenderPipelineAsync(d)));
  const made = performance.now() - t0;
  const enc = device.createCommandEncoder();
  const pass = enc.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store' }] });
  for (const p of pipelines) {
    pass.setPipeline(p);
    pass.draw(3);
  }
  pass.end();
  device.queue.submit([enc.finish()]);
  await device.queue.onSubmittedWorkDone();
  const done = performance.now() - t0;
  device.destroy();
  postMessage({ mode, n, made: +made.toFixed(1), done: +done.toFixed(1), adapter: adapter.info.architecture || adapter.info.vendor });
};
