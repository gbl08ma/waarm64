// G0 (docs/plans/graphics.md, M8-GRAPHICS-KICKOFF.md): the WebGPU environment and the ways to put a
// guest's frame on a canvas, measured in a worker (where the presentation will live).
//   webgpu_adapter        the adapter's info, features and limits (in the params; one sample of 1)
//   writebuffer           queue.writeBuffer from a SharedArrayBuffer view against a plain one (ms to return, ms to complete)
//   present_<path>        one frame onto an OffscreenCanvas, full frame and a ~10% damaged rectangle,
//                         at 1080p, 1440p and 4K, x8r8g8b8 guest pixels (BGRX in memory) as the source:
//     canvas2d            JS swizzle into an ImageData, putImageData of the rectangle
//     canvas2d_rgba       the same with the source already RGBA (the swizzle's cost excluded)
//     webgl2              texSubImage2D of the raw bytes, the swizzle in the fragment shader
//     webgpu              writeTexture into a bgra8unorm texture (no swizzle needed), a textured quad
// Samples are ms per frame; "return" is the time until the calls return, "done" until the work completed
// (WebGPU: onSubmittedWorkDone, WebGL: finish; canvas 2D: a 1-pixel getImageData).
// Run: node bench/run.ts --page bench/gpu/index.html --chromium-args='--enable-unsafe-webgpu --enable-features=Vulkan --use-angle=swiftshader --use-gl=angle'
import type { Options, Sample } from '../spike/benchmarks.ts';

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

export const suite = {
  webgpu_adapter: (_o: Options) => adapterInfo(),
  writebuffer: writeBuffer,
  present_canvas2d: (o: Options) => canvas2d(o, false),
  present_canvas2d_rgba: (o: Options) => canvas2d(o, true),
  present_webgl2: webgl2,
  present_webgpu: webgpu,
};

export async function runAll(o: Options): Promise<Sample[]> {
  const out: Sample[] = [];
  for (const [name, fn] of Object.entries(suite)) {
    o.log?.(name);
    try { out.push(...(await fn(o))); } catch (e) { out.push({ name, unit: 'ms', params: { error: String(e) }, samples: [0] }); }
  }
  return out;
}
