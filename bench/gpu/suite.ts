// G0 (docs/plans/graphics.md §10): the WebGPU environment and the ways to put a
// guest's frame on a canvas, measured in a worker (where the presentation will live).
//   webgpu_adapter        the adapter's info, features and limits (in the params; one sample of 1)
//   writebuffer           queue.writeBuffer from a SharedArrayBuffer view against a plain one (ms to return, ms to complete)
//   present_<path>        one frame onto an OffscreenCanvas, full frame and a ~10% damaged rectangle,
//                         at 1080p, 1440p and 4K, x8r8g8b8 guest pixels (BGRX in memory) as the source:
//     canvas2d            JS swizzle into an ImageData, putImageData of the rectangle
//     canvas2d_rgba       the same with the source already RGBA (the swizzle's cost excluded)
//     webgl2              texSubImage2D of the raw bytes, the swizzle in the fragment shader
//     webgpu              writeTexture into a bgra8unorm texture (no swizzle needed), a textured quad
//   flush_cost            the virtio-gpu backend itself (web/gpu.ts, web/gpu-present.ts): a transfer and a flush with its draw
// Samples are ms per frame; "return" is the time until the calls return, "done" until the work completed
// (WebGPU: onSubmittedWorkDone, WebGL: finish; canvas 2D: a 1-pixel getImageData).
// Run: node bench/run.ts --page bench/gpu/index.html --chromium-args='--enable-unsafe-webgpu --enable-features=Vulkan --use-angle=swiftshader --use-gl=angle'
import type { Options, Sample } from '../spike/benchmarks.ts';
import { Gpu } from '../../web/gpu.ts';
import { canvasPresenter } from '../../web/gpu-present.ts';

const SIZES: [string, number, number][] = [['1080p', 1920, 1080], ['1440p', 2560, 1440], ['4k', 3840, 2160]];
const now = () => performance.now();

type Rect = { x: number; y: number; w: number; h: number };
function rects(w: number, h: number): [string, Rect][] {
  const s = Math.sqrt(0.1); // ~10% of the area
  return [['full', { x: 0, y: 0, w, h }], ['damage10', { x: Math.round(w * 0.2), y: Math.round(h * 0.3), w: Math.round(w * s), h: Math.round(h * s) }]];
}

/** A frame like the guest's: x8r8g8b8 (B, G, R, X in memory) in shared memory. */
function frame(w: number, h: number): Uint8Array<SharedArrayBuffer> {
  const f = new Uint8Array(new SharedArrayBuffer(w * h * 4));
  for (let i = 0; i < f.length; i += 4) { f[i] = i >> 8; f[i + 1] = i >> 12; f[i + 2] = i >> 4; f[i + 3] = 0; }
  return f;
}

let shared: Promise<{ adapter: GPUAdapter; device: GPUDevice } | null> | undefined;
/** One adapter and device for the whole run (a new instance per suite was lost in the 4K runs). */
function gpuDevice() {
  return shared ??= (async () => {
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) return null;
    return { adapter, device: await adapter.requestDevice() };
  })();
}

function limits(l: object) {
  const out: Record<string, number> = {};
  for (const k in l) out[k] = (l as Record<string, number>)[k];
  return out;
}

async function adapterInfo(): Promise<Sample[]> {
  const g = await gpuDevice();
  const params: Record<string, unknown> = { gpu: 'gpu' in navigator, offscreenCanvas: typeof OffscreenCanvas !== 'undefined', crossOriginIsolated: self.crossOriginIsolated };
  if (g) {
    const i = g.adapter.info;
    params.info = { vendor: i.vendor, architecture: i.architecture, device: i.device, description: i.description, backend: (i as unknown as { backend?: string }).backend, type: (i as unknown as { type?: string }).type };
    params.features = [...g.adapter.features].sort();
    params.limits = limits(g.adapter.limits);
    params.deviceLimits = limits(g.device.limits);
  }
  const gl = new OffscreenCanvas(16, 16).getContext('webgl2');
  params.webgl2 = gl ? { renderer: gl.getParameter(gl.RENDERER), vendor: gl.getParameter(gl.VENDOR), version: gl.getParameter(gl.VERSION) } : null;
  return [{ name: 'webgpu_adapter', unit: 'n', params, samples: [1] }];
}

async function writeBuffer(o: Options): Promise<Sample[]> {
  const g = await gpuDevice();
  if (!g) return [];
  const out: Sample[] = [];
  const n = o.quick ? 5 : 20;
  for (const [label, w, h] of SIZES) {
    const bytes = w * h * 4;
    const buf = g.device.createBuffer({ size: bytes, usage: 0x08 /* COPY_DST */ });
    for (const src of ['sab', 'plain'] as const) {
      const data = src === 'sab' ? frame(w, h) : new Uint8Array(bytes);
      const ret: number[] = [], done: number[] = [];
      let error: string | undefined;
      for (let i = -3; i < n; i++) {
        const t = now();
        try { g.device.queue.writeBuffer(buf, 0, data); } catch (e) { error = String(e); break; }
        const r = now() - t;
        await g.device.queue.onSubmittedWorkDone();
        if (i >= 0) { ret.push(r); done.push(now() - t); }
      }
      if (error) { out.push({ name: 'writebuffer', unit: 'ms', params: { size: label, src, error }, samples: [0] }); continue; }
      out.push({ name: 'writebuffer', unit: 'ms', params: { size: label, src, bytes, phase: 'return' }, samples: ret });
      out.push({ name: 'writebuffer', unit: 'ms', params: { size: label, src, bytes, phase: 'done' }, samples: done });
    }
    buf.destroy();
  }
  return out;
}

function swizzle(src: Uint32Array, dst: Uint32Array, w: number, r: Rect) {
  for (let y = 0; y < r.h; y++) {
    let s = (r.y + y) * w + r.x, d = y * r.w;
    for (let x = 0; x < r.w; x++, s++, d++) { const v = src[s]; dst[d] = 0xff000000 | ((v & 0xff) << 16) | (v & 0xff00) | ((v >> 16) & 0xff); }
  }
}

async function measure(n: number, one: () => Promise<[number, number]>): Promise<[number[], number[]]> {
  const ret: number[] = [], done: number[] = [];
  for (let i = -3; i < n; i++) { const [a, b] = await one(); if (i >= 0) { ret.push(a); done.push(b); } }
  return [ret, done];
}

function push(out: Sample[], path: string, size: string, damage: string, r: Rect, [ret, done]: [number[], number[]]) {
  const params = { size, damage, rect: `${r.w}x${r.h}` };
  out.push({ name: `present_${path}`, unit: 'ms', params: { ...params, phase: 'return' }, samples: ret });
  out.push({ name: `present_${path}`, unit: 'ms', params: { ...params, phase: 'done' }, samples: done });
}

async function canvas2d(o: Options, rgbaReady: boolean): Promise<Sample[]> {
  const out: Sample[] = [];
  for (const [label, w, h] of SIZES) {
    const f = frame(w, h);
    const src = new Uint32Array(f.buffer);
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d')!;
    for (const [dname, r] of rects(w, h)) {
      const img = new ImageData(r.w, r.h);
      const dst = new Uint32Array(img.data.buffer);
      const res = await measure(o.quick ? 5 : 20, async () => {
        const t = now();
        if (!rgbaReady) swizzle(src, dst, w, r);
        ctx.putImageData(img, r.x, r.y);
        const a = now() - t;
        ctx.getImageData(0, 0, 1, 1); // forces the pending drawing to complete (the canvas has no other completion to wait for)
        return [a, now() - t];
      });
      push(out, rgbaReady ? 'canvas2d_rgba' : 'canvas2d', label, dname, r, res);
    }
  }
  return out;
}

const VS = `#version 300 es
in vec2 p; out vec2 uv; void main() { uv = p * .5 + .5; uv.y = 1. - uv.y; gl_Position = vec4(p, 0, 1); }`;
const FS = `#version 300 es
precision mediump float; uniform sampler2D t; in vec2 uv; out vec4 c; void main() { c = vec4(texture(t, uv).bgr, 1.); }`;

async function webgl2(o: Options): Promise<Sample[]> {
  const out: Sample[] = [];
  for (const [label, w, h] of SIZES) {
    const f = frame(w, h);
    const canvas = new OffscreenCanvas(w, h);
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false });
    if (!gl) return [{ name: 'present_webgl2', unit: 'ms', params: { error: 'no webgl2' }, samples: [0] }];
    const prog = gl.createProgram()!;
    for (const [type, src] of [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, FS]] as const) {
      const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s); gl.attachShader(prog, s);
    }
    gl.linkProgram(prog); gl.useProgram(prog);
    const vb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, w);
    for (const [dname, r] of rects(w, h)) {
      let shared = true;
      const upload = () => {
        gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, r.x); gl.pixelStorei(gl.UNPACK_SKIP_ROWS, r.y);
        try { gl.texSubImage2D(gl.TEXTURE_2D, 0, r.x, r.y, r.w, r.h, gl.RGBA, gl.UNSIGNED_BYTE, f); } catch { shared = false; }
        if (!shared) gl.texSubImage2D(gl.TEXTURE_2D, 0, r.x, r.y, r.w, r.h, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(f)); // a plain copy: the cost of not accepting shared views
      };
      const res = await measure(o.quick ? 5 : 20, async () => {
        const t = now();
        upload();
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        const a = now() - t;
        gl.finish();
        return [a, now() - t];
      });
      push(out, 'webgl2', label, dname, r, res);
      out[out.length - 1].params!.sharedView = shared;
      out[out.length - 2].params!.sharedView = shared;
    }
  }
  return out;
}

const WGSL = `
@group(0) @binding(0) var t: texture_2d<f32>;
@group(0) @binding(1) var s: sampler;
struct V { @builtin(position) p: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> V {
  var q = array(vec2f(-1, -1), vec2f(1, -1), vec2f(-1, 1), vec2f(1, 1));
  var o: V; o.p = vec4f(q[i], 0, 1); o.uv = vec2f(q[i].x * .5 + .5, .5 - q[i].y * .5); return o;
}
@fragment fn fs(v: V) -> @location(0) vec4f { return vec4f(textureSample(t, s, v.uv).rgb, 1); }`;

async function webgpu(o: Options): Promise<Sample[]> {
  const g = await gpuDevice();
  if (!g) return [{ name: 'present_webgpu', unit: 'ms', params: { error: 'no adapter' }, samples: [0] }];
  const { device } = g;
  const out: Sample[] = [];
  const format = navigator.gpu.getPreferredCanvasFormat();
  const module = device.createShaderModule({ code: WGSL });
  const pipeline = device.createRenderPipeline({ layout: 'auto', vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: 'fs', targets: [{ format }] }, primitive: { topology: 'triangle-strip' } });
  const sampler = device.createSampler();
  for (const [label, w, h] of SIZES) {
    const f = frame(w, h);
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('webgpu') as unknown as GPUCanvasContext;
    ctx.configure({ device, format, alphaMode: 'opaque' });
    const tex = device.createTexture({ size: [w, h], format: 'bgra8unorm', usage: 0x04 | 0x02 /* TEXTURE_BINDING | COPY_DST */ });
    const bind = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: tex.createView() }, { binding: 1, resource: sampler }] });
    for (const [dname, r] of rects(w, h)) {
      const res = await measure(o.quick ? 5 : 20, async () => {
        const t = now();
        device.queue.writeTexture({ texture: tex, origin: [r.x, r.y] }, f, { offset: (r.y * w + r.x) * 4, bytesPerRow: w * 4 }, [r.w, r.h]);
        const enc = device.createCommandEncoder();
        const pass = enc.beginRenderPass({ colorAttachments: [{ view: ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store' }] });
        pass.setPipeline(pipeline); pass.setBindGroup(0, bind); pass.draw(4); pass.end();
        device.queue.submit([enc.finish()]);
        const a = now() - t;
        await device.queue.onSubmittedWorkDone();
        return [a, now() - t];
      });
      push(out, 'webgpu', label, dname, r, res);
    }
    tex.destroy();
  }
  return out;
}

/**
 * The device's own cost of a frame (G1's exit numbers): the real backend (web/gpu.ts) over a guest resource whose
 * backing is 64 KiB chunks of shared memory, drawn by the page's presenter (web/gpu-present.ts) on an OffscreenCanvas.
 * `transfer` is TRANSFER_TO_HOST_2D (the gather and swizzle into the host's RGBA), `flush` is RESOURCE_FLUSH with its
 * draw (putImageData of the rectangle) until the call returns, `done` until the canvas has it: the canvas 2D screen
 * (`?gpu=canvas2d`, or no WebGL2). `transfer_raw`, `flush_webgl2` and `done_webgl2` are the same on a WebGL2 screen (a
 * 2D machine's where the canvas gives WebGL2, and a 3D machine's transfer): the bytes copied as they are, the
 * rectangle uploaded to a texture and the scanout drawn through the format's swizzle.
 */
async function flushCost(o: Options): Promise<Sample[]> {
  const out: Sample[] = [];
  const RAM_BASE = 0x4000_0000, CHUNK = 65536;
  const cmd = (type: number, ...fields: (number | bigint)[]) => {
    const b = new Uint8Array(24 + fields.reduce<number>((n, f) => n + (typeof f === 'bigint' ? 8 : 4), 0));
    const v = new DataView(b.buffer);
    v.setUint32(0, type, true);
    let at = 24;
    for (const f of fields) { if (typeof f === 'bigint') { v.setBigUint64(at, f, true); at += 8; } else { v.setUint32(at, f, true); at += 4; } }
    return b;
  };
  for (const [label, w, h] of SIZES) {
    const ram = frame(w, h);
    const canvas = new OffscreenCanvas(w, h);
    const gpu = new Gpu(() => ram, ram.length, { width: w, height: h });
    gpu.hooks = canvasPresenter(canvas, undefined, false, false, 'canvas2d');
    const glCanvas = new OffscreenCanvas(w, h);
    const hosted = new Gpu(() => ram, ram.length, { width: w, height: h });
    hosted.hooks = canvasPresenter(glCanvas, undefined, false, false, 'webgl2');
    if (!hosted.hooks.raw) throw new Error('flush_cost: no WebGL2 on an OffscreenCanvas here');
    const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
    const gl = glCanvas.getContext('webgl2')!;
    const px = new Uint8Array(4);
    const chunks = Math.ceil(ram.length / CHUNK);
    const attach = new Uint8Array(32 + 16 * chunks);
    attach.set(cmd(0x106, 1, chunks));
    for (let k = 0; k < chunks; k++) {
      new DataView(attach.buffer).setBigUint64(32 + 16 * k, BigInt(RAM_BASE + k * CHUNK), true);
      new DataView(attach.buffer).setUint32(32 + 16 * k + 8, Math.min(CHUNK, ram.length - k * CHUNK), true);
    }
    for (const g of [gpu, hosted]) {
      g.control(cmd(0x101, 1, 2, w, h), 64); // RESOURCE_CREATE_2D, B8G8R8X8
      g.control(attach, 64);
      g.control(cmd(0x103, 0, 0, w, h, 0, 1), 64); // SET_SCANOUT
      for (let i = 0; i < 30; i++) g.control(cmd(0x105, 0, 0, w, h, 0n, 1, 0), 64); // the gather's loop optimized before anything is timed
    }
    for (const [dname, r] of rects(w, h)) {
      const transfer: number[] = [], raw: number[] = [], flush: number[] = [], done: number[] = [], flushGl: number[] = [], doneGl: number[] = [];
      const n = o.quick ? 5 : 20;
      // Transfers back to back (a busy guest's), then flushes a frame apart (the presenter draws at once then).
      for (let i = -3; i < n; i++) {
        ram[(r.y * w + r.x) * 4] ^= 0xff;
        const t0 = now();
        gpu.control(cmd(0x105, r.x, r.y, r.w, r.h, BigInt((r.y * w + r.x) * 4), 1, 0), 64);
        if (i >= 0) transfer.push(now() - t0);
        const t1 = now();
        hosted.control(cmd(0x105, r.x, r.y, r.w, r.h, BigInt((r.y * w + r.x) * 4), 1, 0), 64);
        if (i >= 0) raw.push(now() - t1);
      }
      for (let i = -3; i < n; i++) {
        await new Promise((ok) => setTimeout(ok, 20));
        gpu.control(cmd(0x105, r.x, r.y, 1, 1, BigInt((r.y * w + r.x) * 4), 1, 0), 64); // something to show
        const t1 = now();
        gpu.control(cmd(0x104, r.x, r.y, r.w, r.h, 1, 0), 64);
        const t2 = now();
        ctx.getImageData(0, 0, 1, 1);
        if (i >= 0) { flush.push(t2 - t1); done.push(now() - t1); }
        hosted.control(cmd(0x105, r.x, r.y, 1, 1, BigInt((r.y * w + r.x) * 4), 1, 0), 64);
        await new Promise((ok) => setTimeout(ok, 20));
        const t3 = now();
        hosted.control(cmd(0x104, r.x, r.y, r.w, r.h, 1, 0), 64);
        const t4 = now();
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        if (i >= 0) { flushGl.push(t4 - t3); doneGl.push(now() - t3); }
      }
      const params = { size: label, damage: dname, rect: `${r.w}x${r.h}` };
      out.push({ name: 'flush_cost', unit: 'ms', params: { ...params, phase: 'transfer' }, samples: transfer });
      out.push({ name: 'flush_cost', unit: 'ms', params: { ...params, phase: 'transfer_raw' }, samples: raw });
      out.push({ name: 'flush_cost', unit: 'ms', params: { ...params, phase: 'flush' }, samples: flush });
      out.push({ name: 'flush_cost', unit: 'ms', params: { ...params, phase: 'done' }, samples: done });
      out.push({ name: 'flush_cost', unit: 'ms', params: { ...params, phase: 'flush_webgl2' }, samples: flushGl });
      out.push({ name: 'flush_cost', unit: 'ms', params: { ...params, phase: 'done_webgl2' }, samples: doneGl });
    }
  }
  return out;
}

export const suite = {
  webgpu_adapter: (_o: Options) => adapterInfo(),
  writebuffer: writeBuffer,
  present_canvas2d: (o: Options) => canvas2d(o, false),
  present_canvas2d_rgba: (o: Options) => canvas2d(o, true),
  present_webgl2: webgl2,
  present_webgpu: webgpu,
  flush_cost: flushCost,
};

export async function runAll(o: Options): Promise<Sample[]> {
  const out: Sample[] = [];
  for (const [name, fn] of Object.entries(suite)) {
    o.log?.(name);
    try { out.push(...(await fn(o))); } catch (e) { out.push({ name, unit: 'ms', params: { error: String(e) }, samples: [0] }); }
  }
  return out;
}
