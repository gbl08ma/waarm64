// Arm 2 of VK0's scene (bench/vulkan/REPORT.md): the Aquarium written for WebGPU as a WebGPU author would write it, in
// a worker as the page's GPU worker would run it. The simulation and the draw order are the native arm's
// (target/vulkan/scene.wasm, built from the same C), so every arm draws the same frames; the WebGPU side is ours:
// bind groups made once (materials, the frame's, the objects' at dynamic offsets), the frame's data written with
// writeBuffer, one render pass a frame, two frames in flight. The fish's data reaches the draws one of three ways
// (FishMode, wgsl.ts); render bundles are question E's.
import { GPUBufferUsage, GPUMapMode, GPUShaderStage, GPUTextureUsage } from './flags.ts';
import { type FishMode, sceneWgsl } from './wgsl.ts';

export type Settings = {
  fish: number;
  toolkit: number;      // quads; 0 for the Aquarium
  width: number;
  height: number;
  msaa: 1 | 4;
  warmup: number;
  samples: number;
  frames: number;
  fishMode: FishMode;
  inFlight: number;
  gpuFrames: number;    // frames timed with timestamp queries after the samples (0: none)
};

export type Result = {
  frameMs: number[];    // wall time a frame, per sample
  jsMs: number[];       // the worker's time a frame (building, encoding, submitting; not waiting)
  gpuMs: number[];      // timestamp-query time of a frame's render pass, per frame timed
  drawsPerFrame: number;
  uploadBytesPerFrame: number;
  pipelineMs: number;
  adapter: Record<string, unknown>;
};

const OBJECT_STRIDE = 256;
const GLOBALS_SIZE = 288;  // sizeof(SimGlobals)
const TK_TEXTURES = 8, TK_TEXTURE_SIZE = 256;
const CMD = { PIPELINE: 0, MATERIAL: 1, DRAW_OBJECT: 2, DRAW_FISH: 3, DRAW_BUBBLES: 4, DRAW_RAY: 5, TK_DRAW: 16 };
const PIPE = { BUBBLE: 9, COUNT: 11 };

type Blend = 'none' | 'alpha' | 'add';
type PipeDesc = { vs: string; fs: string; fog: boolean; cull: boolean; depthWrite: boolean; blend: Blend; input: 'model' | 'none' | 'tk' };
const PIPES: PipeDesc[] = [
  { vs: 'vs_object', fs: 'fs_diffuse', fog: true, cull: true, depthWrite: true, blend: 'none', input: 'model' },
  { vs: 'vs_object', fs: 'fs_diffuse', fog: false, cull: true, depthWrite: true, blend: 'none', input: 'model' },
  { vs: 'vs_object', fs: 'fs_normalmap', fog: true, cull: true, depthWrite: true, blend: 'none', input: 'model' },
  { vs: 'vs_object', fs: 'fs_reflection', fog: true, cull: true, depthWrite: true, blend: 'none', input: 'model' },
  { vs: 'vs_fish', fs: 'fs_fishnormal', fog: true, cull: true, depthWrite: true, blend: 'alpha', input: 'model' },
  { vs: 'vs_fish', fs: 'fs_fishreflect', fog: true, cull: true, depthWrite: true, blend: 'alpha', input: 'model' },
  { vs: 'vs_seaweed', fs: 'fs_seaweed', fog: true, cull: true, depthWrite: true, blend: 'alpha', input: 'model' },
  { vs: 'vs_object', fs: 'fs_inner', fog: true, cull: true, depthWrite: true, blend: 'none', input: 'model' },
  { vs: 'vs_object', fs: 'fs_outer', fog: false, cull: true, depthWrite: true, blend: 'alpha', input: 'model' },
  { vs: 'vs_bubble', fs: 'fs_bubble', fog: false, cull: false, depthWrite: false, blend: 'add', input: 'none' },
  { vs: 'vs_ray', fs: 'fs_ray', fog: false, cull: false, depthWrite: false, blend: 'add', input: 'model' },
];
const TK_PIPES: PipeDesc[] = [
  { vs: 'vs_tk', fs: 'fs_tktexture', fog: false, cull: false, depthWrite: false, blend: 'alpha', input: 'tk' },
  { vs: 'vs_tk', fs: 'fs_tkcolor', fog: false, cull: false, depthWrite: false, blend: 'alpha', input: 'tk' },
  { vs: 'vs_tk', fs: 'fs_tkrounded', fog: false, cull: false, depthWrite: false, blend: 'alpha', input: 'tk' },
];

type Wasm = {
  memory: WebAssembly.Memory;
  vk0_head(): number;
  vk0_init(headSize: number, fish: number, toolkit: number, width: number, height: number): number;
  vk0_frame(): number;
  vk0_cmds(): number;
  vk0_objects(): number;
  vk0_object_count(): number;
  vk0_fish_records(stride: number): number;
  vk0_globals(): number;
  vk0_bubbles(): number;
  vk0_bubble_sets(): number;
  vk0_light_rays(): number;
  vk0_quads(): number;
  vk0_quad_count(): number;
  vk0_tk_texture(index: number): number;
  vk0_ray_vertices(): number;
  vk0_ray_indices(): number;
};

type PackTables = {
  textures: { name: string; width: number; height: number; layers: number; mips: number; offset: number; size: number }[];
  models: { scene: number; vertexCount: number; indexCount: number; diffuse: number; normalMap: number; reflectionMap: number; vertexOffset: number; indexOffset: number }[];
  tablesEnd: number;
};

function readPack(buf: ArrayBuffer): PackTables {
  const dv = new DataView(buf);
  const name = (at: number) => { let s = ''; for (let i = 0; i < 32 && dv.getUint8(at + i); i++) s += String.fromCharCode(dv.getUint8(at + i)); return s; };
  const [nTex, nScenes, nModels, nProps] = [8, 12, 16, 20].map((o) => dv.getUint32(o, true));
  let at = 32;
  const textures = [];
  for (let i = 0; i < nTex; i++, at += 64) {
    textures.push({ name: name(at), width: dv.getUint32(at + 32, true), height: dv.getUint32(at + 36, true), layers: dv.getUint32(at + 40, true),
      mips: dv.getUint32(at + 44, true), offset: Number(dv.getBigUint64(at + 48, true)), size: Number(dv.getBigUint64(at + 56, true)) });
  }
  at += nScenes * 48;
  const models = [];
  for (let i = 0; i < nModels; i++, at += 64) {
    models.push({ scene: dv.getUint32(at, true), vertexCount: dv.getUint32(at + 4, true), indexCount: dv.getUint32(at + 8, true),
      diffuse: dv.getUint32(at + 12, true), normalMap: dv.getUint32(at + 16, true), reflectionMap: dv.getUint32(at + 20, true),
      vertexOffset: Number(dv.getBigUint64(at + 24, true)), indexOffset: Number(dv.getBigUint64(at + 32, true)) });
  }
  at += nProps * 68;
  return { textures, models, tablesEnd: at };
}

const NONE = 0xffffffff;

/** The device, the pack's resources and the wasm module, made once; run() measures one setting. */
export class Aquarium {
  device!: GPUDevice;
  adapter!: GPUAdapter;
  wasm!: Wasm;
  pack!: PackTables;
  packBuf!: ArrayBuffer;
  textures: GPUTexture[] = [];
  repeat!: GPUSampler;
  clamp!: GPUSampler;
  vbuf!: GPUBuffer;
  ibuf!: GPUBuffer;
  firstIndex: number[] = [];
  baseVertex: number[] = [];
  layouts!: GPUBindGroupLayout[];
  fishLayout!: GPUBindGroupLayout;
  materials: GPUBindGroup[] = [];
  tkMaterials: GPUBindGroup[] = [];
  hasImmediates = false;
  timestamps = false;
  /** Called at the timed samples' start and end ("start", "end"): the runner reads the processes' CPU there. */
  onMark?: (mark: string) => void;

  async init(packUrl: string, wasmUrl: string) {
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) throw new Error('no WebGPU adapter');
    this.adapter = adapter;
    this.timestamps = adapter.features.has('timestamp-query');
    const requiredLimits: Record<string, number> = { maxStorageBuffersInVertexStage: 4 };
    if ('maxImmediateSize' in adapter.limits) requiredLimits.maxImmediateSize = Math.min(64, (adapter.limits as unknown as Record<string, number>).maxImmediateSize);
    const limitsKnown = adapter.limits as unknown as Record<string, number>;
    for (const k of Object.keys(requiredLimits)) if (!(k in limitsKnown)) delete requiredLimits[k];
    this.device = await adapter.requestDevice({ requiredFeatures: this.timestamps ? ['timestamp-query'] : [], requiredLimits });
    this.device.addEventListener('uncapturederror', (e) => console.error('webgpu:', (e as GPUUncapturedErrorEvent).error.message));
    this.hasImmediates = typeof (GPURenderPassEncoder.prototype as unknown as { setImmediates?: unknown }).setImmediates === 'function' &&
      (this.device.limits as unknown as Record<string, number>).maxImmediateSize >= 48;

    const [packBuf, wasmBuf] = await Promise.all([fetch(packUrl).then((r) => r.arrayBuffer()), fetch(wasmUrl).then((r) => r.arrayBuffer())]);
    this.packBuf = packBuf;
    this.pack = readPack(packBuf);
    const { instance } = await WebAssembly.instantiate(wasmBuf, {});
    this.wasm = instance.exports as unknown as Wasm;

    const d = this.device;
    // Textures, every level and layer.
    for (const t of this.pack.textures) {
      const tex = d.createTexture({ size: [t.width, t.height, t.layers], format: 'rgba8unorm', mipLevelCount: t.mips,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      let o = t.offset;
      for (let l = 0; l < t.mips; l++) {
        const w = Math.max(1, t.width >> l), h = Math.max(1, t.height >> l);
        d.queue.writeTexture({ texture: tex, mipLevel: l }, new Uint8Array(packBuf, o, w * h * 4 * t.layers), { bytesPerRow: w * 4, rowsPerImage: h }, [w, h, t.layers]);
        o += w * h * 4 * t.layers;
      }
      this.textures.push(tex);
    }
    const sampler = (mode: GPUAddressMode) => d.createSampler({ addressModeU: mode, addressModeV: mode, addressModeW: mode,
      magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' });
    this.repeat = sampler('repeat');
    this.clamp = sampler('clamp-to-edge');

    // Geometry: every model, then the light ray's plane.
    const mem = () => this.wasm.memory.buffer;
    const rayV = new Uint8Array(mem(), this.wasm.vk0_ray_vertices(), 4 * 56).slice();
    const rayI = new Uint8Array(mem(), this.wasm.vk0_ray_indices(), 12).slice();
    const parts = this.pack.models.map((m) => ({ v: new Uint8Array(packBuf, m.vertexOffset, m.vertexCount * 56), i: new Uint8Array(packBuf, m.indexOffset, m.indexCount * 2), nv: m.vertexCount }));
    parts.push({ v: rayV, i: rayI, nv: 4 });
    const vbytes = parts.reduce((s, p) => s + p.v.length, 0);
    const ibytes = parts.reduce((s, p) => s + ((p.i.length + 3) & ~3), 0);
    const vdata = new Uint8Array(vbytes), idata = new Uint8Array(ibytes);
    let vo = 0, io = 0;
    for (const p of parts) {
      vdata.set(p.v, vo); idata.set(p.i, io);
      this.baseVertex.push(vo / 56); this.firstIndex.push(io / 2);
      vo += p.v.length; io += (p.i.length + 3) & ~3;
    }
    this.vbuf = d.createBuffer({ size: vbytes, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.ibuf = d.createBuffer({ size: ibytes, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    d.queue.writeBuffer(this.vbuf, 0, vdata);
    d.queue.writeBuffer(this.ibuf, 0, idata);

    // Bind group layouts.
    const VS = GPUShaderStage.VERTEX, FS = GPUShaderStage.FRAGMENT;
    this.layouts = [
      d.createBindGroupLayout({ entries: [
        { binding: 0, visibility: VS | FS, buffer: { type: 'uniform' } },
        { binding: 1, visibility: FS, texture: { viewDimension: 'cube' } },
        { binding: 2, visibility: FS, sampler: {} },
      ] }),
      d.createBindGroupLayout({ entries: [0, 1, 2].map((b) => ({ binding: b, visibility: FS, texture: {} } as GPUBindGroupLayoutEntry)).concat([{ binding: 3, visibility: FS, sampler: {} }]) }),
      d.createBindGroupLayout({ entries: [
        { binding: 0, visibility: VS | FS, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 144 } },
        { binding: 1, visibility: VS, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: VS, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: VS, buffer: { type: 'read-only-storage' } },
        { binding: 4, visibility: VS | FS, buffer: { type: 'read-only-storage' } },
      ] }),
    ];
    this.fishLayout = d.createBindGroupLayout({ entries: [{ binding: 0, visibility: VS, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 48 } }] });

    // Materials: a model's three textures (a missing normal or reflection map is its diffuse), the bubbles', the
    // rays'; the toolkit's eight textures.
    const view = (i: number) => this.textures[i].createView();
    const index = (name: string) => this.pack.textures.findIndex((t) => t.name === name);
    const material = (t: number[], s: GPUSampler) => d.createBindGroup({ layout: this.layouts[1], entries: [
      ...t.map((x, b) => ({ binding: b, resource: view(x) })), { binding: 3, resource: s }] });
    for (const m of this.pack.models) {
      this.materials.push(material([m.diffuse, m.normalMap !== NONE ? m.normalMap : m.diffuse, m.reflectionMap !== NONE ? m.reflectionMap : m.diffuse], this.repeat));
    }
    this.materials.push(material([index('bubble'), index('bubble'), index('bubble')], this.clamp));
    this.materials.push(material([index('lightray'), index('lightray'), index('lightray')], this.clamp));
    for (let i = 0; i < TK_TEXTURES; i++) {
      const tex = d.createTexture({ size: [TK_TEXTURE_SIZE, TK_TEXTURE_SIZE], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      d.queue.writeTexture({ texture: tex }, new Uint8Array(mem(), this.wasm.vk0_tk_texture(i), TK_TEXTURE_SIZE * TK_TEXTURE_SIZE * 4), { bytesPerRow: TK_TEXTURE_SIZE * 4 }, [TK_TEXTURE_SIZE, TK_TEXTURE_SIZE]);
      const v = tex.createView();
      this.tkMaterials.push(d.createBindGroup({ layout: this.layouts[1], entries: [0, 1, 2].map((b) => ({ binding: b, resource: v } as GPUBindGroupEntry)).concat([{ binding: 3, resource: this.clamp }]) }));
    }
    this.skyboxView = this.textures[index('skybox')].createView({ dimension: 'cube' });
    await d.queue.onSubmittedWorkDone();
  }

  skyboxView!: GPUTextureView;

  adapterInfo(): Record<string, unknown> {
    const i = this.adapter.info;
    return { vendor: i.vendor, architecture: i.architecture, device: i.device, description: i.description,
      features: [...this.adapter.features].sort(), immediates: this.hasImmediates, timestamps: this.timestamps };
  }

  /** Runs one setting: the samples, then (gpuFrames) frames timed on the GPU; or, with dump, frames 0..dump and its pixels. */
  async run(s: Settings, dump?: number): Promise<Result & { pixels?: Uint8Array }> {
    const d = this.device, w = this.wasm;
    const toolkit = s.toolkit > 0;
    // The module parses the pack's tables (its draw order needs them): copy them in, then start the setting.
    new Uint8Array(w.memory.buffer, w.vk0_head(), this.pack.tablesEnd).set(new Uint8Array(this.packBuf, 0, this.pack.tablesEnd));
    if (w.vk0_init(this.pack.tablesEnd, toolkit ? 0 : s.fish, s.toolkit, s.width, s.height) !== 0) throw new Error('vk0_init failed');
    if (s.fishMode === 'immediates' && !this.hasImmediates) throw new Error('no immediates in this browser');

    // Render targets.
    const color = d.createTexture({ size: [s.width, s.height], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    const colorMs = s.msaa === 4 ? d.createTexture({ size: [s.width, s.height], format: 'rgba8unorm', sampleCount: 4, usage: GPUTextureUsage.RENDER_ATTACHMENT }) : null;
    const depth = d.createTexture({ size: [s.width, s.height], format: 'depth32float', sampleCount: s.msaa, usage: GPUTextureUsage.RENDER_ATTACHMENT });
    const colorView = color.createView(), colorMsView = colorMs?.createView(), depthView = depth.createView();

    // Pipelines.
    const t0 = performance.now();
    const module = d.createShaderModule({ code: sceneWgsl(s.fishMode) });
    const bgls = [...this.layouts];
    if (s.fishMode === 'dynamic') bgls.push(this.fishLayout);
    const layout = d.createPipelineLayout({ bindGroupLayouts: bgls, ...(s.fishMode === 'immediates' ? { immediateSize: 48 } : {}) } as GPUPipelineLayoutDescriptor);
    const blend = (b: Blend): GPUBlendState | undefined => b === 'none' ? undefined : {
      color: { srcFactor: 'src-alpha', dstFactor: b === 'add' ? 'one' : 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'src-alpha', dstFactor: b === 'add' ? 'one' : 'one-minus-src-alpha', operation: 'add' } };
    const modelInput: GPUVertexBufferLayout[] = [{ arrayStride: 56, attributes: [
      { shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' },
      { shaderLocation: 2, offset: 24, format: 'float32x2' }, { shaderLocation: 3, offset: 32, format: 'float32x3' },
      { shaderLocation: 4, offset: 44, format: 'float32x3' }] }];
    const tkInput: GPUVertexBufferLayout[] = [{ arrayStride: 48, stepMode: 'instance', attributes: [
      { shaderLocation: 0, offset: 0, format: 'float32x4' }, { shaderLocation: 1, offset: 16, format: 'float32x4' },
      { shaderLocation: 2, offset: 32, format: 'float32x4' }] }];
    const descs = toolkit ? TK_PIPES : PIPES;
    const pipes = await Promise.all(descs.map((p) => d.createRenderPipelineAsync({
      layout,
      vertex: { module, entryPoint: p.vs, buffers: p.input === 'model' ? modelInput : p.input === 'tk' ? tkInput : [] },
      fragment: { module, entryPoint: p.fs, constants: p.fs.startsWith('fs_') && !toolkit && p.fs !== 'fs_outer' && p.vs !== 'vs_bubble' && p.vs !== 'vs_ray' ? { FOG: p.fog ? 1 : 0 } : {},
        targets: [{ format: 'rgba8unorm', blend: blend(p.blend) }] },
      primitive: { topology: p.input === 'model' ? 'triangle-list' : 'triangle-strip', cullMode: p.cull ? 'back' : 'none', frontFace: 'ccw' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: p.depthWrite, depthCompare: toolkit ? 'always' : 'less' },
      multisample: { count: s.msaa },
    })));
    const pipelineMs = performance.now() - t0;

    // Per-frame buffers (one set: writeBuffer orders the writes after the previous frame's submit, so frames in flight
    // see their own data).
    const nObjects = w.vk0_object_count();
    const fishStride = s.fishMode === 'dynamic' ? 256 : 48;
    const globals = d.createBuffer({ size: GLOBALS_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const objects = d.createBuffer({ size: Math.max(1, nObjects) * OBJECT_STRIDE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const fishBuf = d.createBuffer({ size: Math.max(1, s.fish) * fishStride, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const bubbles = d.createBuffer({ size: 100 * 64, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const bubbleSets = d.createBuffer({ size: 10 * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const rays = d.createBuffer({ size: 5 * 80, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const quads = toolkit ? d.createBuffer({ size: w.vk0_quad_count() * 48, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST }) : null;
    d.queue.writeBuffer(bubbles, 0, new Uint8Array(w.memory.buffer, w.vk0_bubbles(), 100 * 64));
    const frameGroup = d.createBindGroup({ layout: this.layouts[0], entries: [
      { binding: 0, resource: { buffer: globals } }, { binding: 1, resource: this.skyboxView }, { binding: 2, resource: this.clamp }] });
    const objectGroup = d.createBindGroup({ layout: this.layouts[2], entries: [
      { binding: 0, resource: { buffer: objects, size: 144 } }, { binding: 1, resource: { buffer: fishBuf } },
      { binding: 2, resource: { buffer: bubbles } }, { binding: 3, resource: { buffer: bubbleSets } }, { binding: 4, resource: { buffer: rays } }] });
    const fishGroup = s.fishMode === 'dynamic' ? d.createBindGroup({ layout: this.fishLayout, entries: [{ binding: 0, resource: { buffer: fishBuf, size: 48 } }] }) : null;

    const models = this.pack.models;
    const rayModel = models.length;
    let draws = 0, uploads = 0;
    const frame = () => {
      const n = w.vk0_frame();
      const mem = w.memory.buffer;
      d.queue.writeBuffer(globals, 0, new Uint8Array(mem, w.vk0_globals(), GLOBALS_SIZE));
      uploads += GLOBALS_SIZE;
      if (toolkit) {
        const bytes = w.vk0_quad_count() * 48;
        d.queue.writeBuffer(quads!, 0, new Uint8Array(mem, w.vk0_quads(), bytes));
        uploads += bytes;
      } else {
        const src = new Uint8Array(mem, w.vk0_objects(), nObjects * 144);
        const obj = new Uint8Array(nObjects * OBJECT_STRIDE);
        for (let i = 0; i < nObjects; i++) obj.set(src.subarray(i * 144, i * 144 + 144), i * OBJECT_STRIDE);
        d.queue.writeBuffer(objects, 0, obj);
        if (s.fish > 0) {
          const recs = w.vk0_fish_records(fishStride);
          d.queue.writeBuffer(fishBuf, 0, new Uint8Array(mem, recs, s.fish * fishStride));
          uploads += s.fish * fishStride;
        }
        d.queue.writeBuffer(bubbleSets, 0, new Uint8Array(mem, w.vk0_bubble_sets(), 160));
        d.queue.writeBuffer(rays, 0, new Uint8Array(mem, w.vk0_light_rays(), 400));
        uploads += nObjects * OBJECT_STRIDE + 560;
      }
      const cmds = new Uint32Array(mem, w.vk0_cmds(), n * 4);
      const fishRecs = s.fishMode === 'immediates' ? new Uint8Array(mem, w.vk0_fish_records(48), s.fish * 48) : null;
      const enc = d.createCommandEncoder();
      const pass = enc.beginRenderPass({
        colorAttachments: [{ view: colorMsView ?? colorView, resolveTarget: colorMsView ? colorView : undefined,
          clearValue: toolkit ? [0.96, 0.96, 0.96, 1] : [0, 0.8, 1, 1], loadOp: 'clear', storeOp: colorMsView ? 'discard' : 'store' }],
        depthStencilAttachment: { view: depthView, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' },
        ...(timing ? { timestampWrites: { querySet: timing.set, beginningOfPassWriteIndex: timing.slot * 2, endOfPassWriteIndex: timing.slot * 2 + 1 } } : {}),
      });
      // WebGPU wants every group of the layout bound before a draw, used or not (Vulkan doesn't).
      pass.setBindGroup(0, frameGroup);
      pass.setBindGroup(1, toolkit ? this.tkMaterials[0] : this.materials[0]);
      pass.setBindGroup(2, objectGroup, [0]);
      if (fishGroup) pass.setBindGroup(3, fishGroup, [0]);
      if (toolkit) pass.setVertexBuffer(0, quads!);
      else {
        pass.setVertexBuffer(0, this.vbuf);
        pass.setIndexBuffer(this.ibuf, 'uint16');
      }
      const passI = pass as unknown as { setImmediates(offset: number, data: ArrayBufferView, dataOffset?: number, size?: number): void };
      for (let i = 0; i < n * 4; i += 4) {
        const op = cmds[i], a = cmds[i + 1], b = cmds[i + 2];
        switch (op) {
          case CMD.PIPELINE: pass.setPipeline(pipes[a]); break;
          case CMD.MATERIAL: pass.setBindGroup(1, toolkit ? this.tkMaterials[a] : this.materials[a]); break;
          case CMD.DRAW_OBJECT:
            pass.setBindGroup(2, objectGroup, [b * OBJECT_STRIDE]);
            pass.drawIndexed(models[a].indexCount, 1, this.firstIndex[a], this.baseVertex[a], 0);
            draws++;
            break;
          case CMD.DRAW_FISH:
            if (s.fishMode === 'storage') pass.drawIndexed(models[a].indexCount, 1, this.firstIndex[a], this.baseVertex[a], b);
            else {
              if (s.fishMode === 'dynamic') pass.setBindGroup(3, fishGroup!, [b * 256]);
              else passI.setImmediates(0, fishRecs!, b * 48, 48);
              pass.drawIndexed(models[a].indexCount, 1, this.firstIndex[a], this.baseVertex[a], 0);
            }
            draws++;
            break;
          case CMD.DRAW_BUBBLES: pass.draw(4, 100, 0, a * 100); draws++; break;
          case CMD.DRAW_RAY: pass.drawIndexed(6, 1, this.firstIndex[rayModel], this.baseVertex[rayModel], a); draws++; break;
          case CMD.TK_DRAW: pass.draw(4, b, 0, a); draws++; break;
        }
      }
      pass.end();
      if (timing) {
        enc.resolveQuerySet(timing.set, timing.slot * 2, 2, timing.resolve, timing.slot * 256);
      }
      d.queue.submit([enc.finish()]);
    };
    let timing: { set: GPUQuerySet; resolve: GPUBuffer; slot: number } | null = null;

    const pending: Promise<void>[] = [];
    const settle = async (max: number) => { while (pending.length > max) await pending.shift(); };
    const frameMs: number[] = [], jsMs: number[] = [], gpuMs: number[] = [];
    if (dump !== undefined) {
      for (let f = 0; f <= dump; f++) { frame(); pending.push(d.queue.onSubmittedWorkDone()); await settle(s.inFlight - 1); }
      await settle(0);
      const rb = d.createBuffer({ size: s.width * s.height * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const enc = d.createCommandEncoder();
      enc.copyTextureToBuffer({ texture: color }, { buffer: rb, bytesPerRow: s.width * 4 }, [s.width, s.height]);
      d.queue.submit([enc.finish()]);
      await rb.mapAsync(GPUMapMode.READ);
      const pixels = new Uint8Array(rb.getMappedRange()).slice();
      rb.destroy();
      return { frameMs, jsMs, gpuMs, drawsPerFrame: draws / (dump + 1), uploadBytesPerFrame: uploads / (dump + 1), pipelineMs, adapter: this.adapterInfo(), pixels };
    }
    for (let f = 0; f < s.warmup; f++) { frame(); pending.push(d.queue.onSubmittedWorkDone()); await settle(s.inFlight - 1); }
    await settle(0);
    this.onMark?.('start');
    draws = 0; uploads = 0;
    for (let k = 0; k < s.samples; k++) {
      let js = 0;
      const t = performance.now();
      for (let f = 0; f < s.frames; f++) {
        const a = performance.now();
        frame();
        pending.push(d.queue.onSubmittedWorkDone());
        js += performance.now() - a;
        await settle(s.inFlight - 1);
      }
      frameMs.push((performance.now() - t) / s.frames);
      jsMs.push(js / s.frames);
    }
    await settle(0);
    this.onMark?.('end');
    const measured = s.samples * s.frames;
    const drawsPerFrame = draws / measured, uploadBytesPerFrame = uploads / measured;
    if (s.gpuFrames > 0 && this.timestamps) {
      const set = d.createQuerySet({ type: 'timestamp', count: 2 * s.inFlight });
      const resolve = d.createBuffer({ size: 256 * s.inFlight, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
      const read = d.createBuffer({ size: 256 * s.inFlight, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      for (let f = 0; f < s.gpuFrames; f++) {
        timing = { set, resolve, slot: 0 };
        frame();
        const enc = d.createCommandEncoder();
        enc.copyBufferToBuffer(resolve, 0, read, 0, 16);
        d.queue.submit([enc.finish()]);
        await read.mapAsync(GPUMapMode.READ, 0, 16);
        const ts = new BigUint64Array(read.getMappedRange(0, 16));
        gpuMs.push(Number(ts[1] - ts[0]) / 1e6);
        read.unmap();
      }
      timing = null;
      set.destroy(); resolve.destroy(); read.destroy();
    }
    for (const b of [globals, objects, fishBuf, bubbles, bubbleSets, rays, quads]) b?.destroy();
    color.destroy(); colorMs?.destroy(); depth.destroy();
    return { frameMs, jsMs, gpuMs, drawsPerFrame, uploadBytesPerFrame, pipelineMs, adapter: this.adapterInfo() };
  }
}
