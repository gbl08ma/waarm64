// Arm 3 (bench/vulkan/REPORT.md): a throwaway prototype of VK0's mapping (docs/graphics.md "The shape"), translating a Vulkan
// program's command stream (convert.ts) to WebGPU at run time, in a worker, as our translator would: command buffers
// recorded and translated at submit; descriptor sets made bind groups when bound, cached by their content; dynamic
// offsets passed on; push constants as immediates where a pipeline's shaders read no more than the adapter's
// immediates (64 bytes), else written to a uniform ring bound at a dynamic offset (group 3); host-visible memory as a
// buffer per allocation, the guest's writes (the capture's fills) uploaded at submit with writeBuffer; barriers and
// layouts dropped. The shaders were translated ahead (shaders.ts: SPIR-V to WGSL), as a pipeline cache would hold them.
// The loop replays the captured frames over and over.
import { DESC, OP, opLength } from './stream.ts';
import { GPUBufferUsage, GPUMapMode, GPUTextureUsage } from '../webgpu/flags.ts';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** What shaders.ts says of a translated module: its WGSL, its resources by Vulkan (set, binding), whether it reads
 * push constants and how many bytes of them, and its specialization constants' override ids. */
export type ShaderMeta = {
  wgsl: string;
  wgslFlipped: string;  // y negated (naga's clip-space adjustment): for a positive-height Vulkan viewport
  entry: string;
  bindings: { set: number; binding: number; kind: 'uniform' | 'storage' | 'texture' | 'sampler'; dimension?: GPUTextureViewDimension; sampleType?: GPUTextureSampleType }[];
  pushBytes: number;
};

export type ReplayResult = { frameMs: number[]; jsMs: number[]; gpuMs: number[]; drawsPerFrame: number; uploadBytesPerFrame: number; pipelineMs: number;
  bindGroupsCreated: number; immediateDraws: number; ringDraws: number; adapter: Record<string, unknown> };

const FORMATS: Record<string, GPUTextureFormat> = {
  VK_FORMAT_R8G8B8A8_UNORM: 'rgba8unorm', VK_FORMAT_R8G8B8A8_SRGB: 'rgba8unorm-srgb', VK_FORMAT_B8G8R8A8_UNORM: 'bgra8unorm',
  VK_FORMAT_B8G8R8A8_SRGB: 'bgra8unorm-srgb', VK_FORMAT_D32_SFLOAT: 'depth32float', VK_FORMAT_D24_UNORM_S8_UINT: 'depth24plus-stencil8',
  VK_FORMAT_D16_UNORM: 'depth16unorm',
};
const VERTEX_FORMATS: Record<string, GPUVertexFormat> = {
  VK_FORMAT_R32_SFLOAT: 'float32', VK_FORMAT_R32G32_SFLOAT: 'float32x2', VK_FORMAT_R32G32B32_SFLOAT: 'float32x3',
  VK_FORMAT_R32G32B32A32_SFLOAT: 'float32x4', VK_FORMAT_R8G8B8A8_UNORM: 'unorm8x4', VK_FORMAT_R32_UINT: 'uint32',
};
const BLEND: Record<string, GPUBlendFactor> = {
  VK_BLEND_FACTOR_ZERO: 'zero', VK_BLEND_FACTOR_ONE: 'one', VK_BLEND_FACTOR_SRC_ALPHA: 'src-alpha',
  VK_BLEND_FACTOR_ONE_MINUS_SRC_ALPHA: 'one-minus-src-alpha', VK_BLEND_FACTOR_SRC_COLOR: 'src', VK_BLEND_FACTOR_ONE_MINUS_SRC_COLOR: 'one-minus-src',
  VK_BLEND_FACTOR_DST_ALPHA: 'dst-alpha', VK_BLEND_FACTOR_ONE_MINUS_DST_ALPHA: 'one-minus-dst-alpha', VK_BLEND_FACTOR_DST_COLOR: 'dst',
  VK_BLEND_FACTOR_ONE_MINUS_DST_COLOR: 'one-minus-dst',
};
const COMPARE: Record<string, GPUCompareFunction> = {
  VK_COMPARE_OP_NEVER: 'never', VK_COMPARE_OP_LESS: 'less', VK_COMPARE_OP_EQUAL: 'equal', VK_COMPARE_OP_LESS_OR_EQUAL: 'less-equal',
  VK_COMPARE_OP_GREATER: 'greater', VK_COMPARE_OP_NOT_EQUAL: 'not-equal', VK_COMPARE_OP_GREATER_OR_EQUAL: 'greater-equal', VK_COMPARE_OP_ALWAYS: 'always',
};
const TOPOLOGY: Record<string, GPUPrimitiveTopology> = {
  VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST: 'triangle-list', VK_PRIMITIVE_TOPOLOGY_TRIANGLE_STRIP: 'triangle-strip',
  VK_PRIMITIVE_TOPOLOGY_LINE_LIST: 'line-list', VK_PRIMITIVE_TOPOLOGY_POINT_LIST: 'point-list',
};
const ADDRESS: Record<string, GPUAddressMode> = { VK_SAMPLER_ADDRESS_MODE_REPEAT: 'repeat', VK_SAMPLER_ADDRESS_MODE_CLAMP_TO_EDGE: 'clamp-to-edge', VK_SAMPLER_ADDRESS_MODE_MIRRORED_REPEAT: 'mirror-repeat' };
const IMMEDIATES = 64;

const RING = 4 << 20;  // the push-constant ring: 256 bytes a draw, 16,384 draws a frame

type SetState = { layout: number; resources: (number[] | undefined)[]; key: string; dirty: boolean };

export class Replay {
  device!: GPUDevice;
  adapter!: GPUAdapter;
  setup!: Json;
  stream!: Uint32Array;
  bytes!: Uint8Array;
  shaders = new Map<string, ShaderMeta>();  // by `${SPIR-V hash}:${id}=${value},...`: modules are specialized per pipeline
  memories = new Map<number, GPUBuffer>();
  mirrors = new Map<number, Uint8Array>();   // host-visible memory as the guest wrote it (for repacked image copies)
  textures = new Map<number, GPUTexture>();
  views = new Map<number, GPUTextureView>();
  samplers = new Map<number, GPUSampler>();
  setLayouts = new Map<number, { gpu: GPUBindGroupLayout; dynamic: number[]; textures: Set<number> }>();
  pipelineLayouts = new Map<number, { gpu: GPUPipelineLayout; ring: GPUPipelineLayout; sets: number[] }>();
  pipelines = new Map<string, { gpu: GPURenderPipeline; immediates: boolean; push: boolean; groups: number }>();
  sets = new Map<number, SetState>();
  bindGroups = new Map<string, GPUBindGroup>();
  emptyLayout!: GPUBindGroupLayout;
  emptyGroup!: GPUBindGroup;
  ringLayout!: GPUBindGroupLayout;
  ringBuf!: GPUBuffer;
  ringGroup!: GPUBindGroup;
  ringCpu = new Uint8Array(RING);
  hasImmediates = false;
  stats = { bindGroupsCreated: 0, immediateDraws: 0, ringDraws: 0, draws: 0, uploads: 0 };
  onMark?: (m: string) => void;
  log?: (m: string) => void;

  async init(url: string, noImmediates = false) {
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) throw new Error('no WebGPU adapter');
    this.adapter = adapter;
    const limits = adapter.limits as unknown as Record<string, number>;
    const requiredLimits: Record<string, number> = {};
    if ('maxImmediateSize' in limits) requiredLimits.maxImmediateSize = Math.min(IMMEDIATES, limits.maxImmediateSize);
    this.device = await adapter.requestDevice({ requiredLimits, requiredFeatures: adapter.features.has('timestamp-query') ? ['timestamp-query'] : [] });
    this.device.addEventListener('uncapturederror', (e) => console.error('webgpu:', (e as GPUUncapturedErrorEvent).error.message));
    this.hasImmediates = !noImmediates && typeof (GPURenderPassEncoder.prototype as unknown as { setImmediates?: unknown }).setImmediates === 'function' &&
      (this.device.limits as unknown as Record<string, number>).maxImmediateSize >= 16;
    const [setup, stream, shaders] = await Promise.all([
      fetch(`${url}/setup.json`).then((r) => r.json()), fetch(`${url}/stream.bin`).then((r) => r.arrayBuffer()),
      fetch(`${url}/shaders.json`).then((r) => r.json()) as Promise<Record<string, ShaderMeta>>]);
    this.setup = setup;
    this.stream = new Uint32Array(stream);
    this.bytes = new Uint8Array(stream);
    for (const [key, m] of Object.entries(shaders)) this.shaders.set(key, m);
    this.log?.(`trace: ${this.stream.length} words, ${this.shaders.size} shader stages`);
    this.createObjects();
    this.log?.('objects made');
  }

  adapterInfo() {
    const i = this.adapter.info;
    return { vendor: i.vendor, architecture: i.architecture, description: i.description, immediates: this.hasImmediates };
  }

  createObjects() {
    const d = this.device, s = this.setup;
    // Memory: one GPUBuffer an allocation, for every use a buffer bound to it may have.
    for (const [id, m] of Object.entries(s.memories as Record<string, Json>)) {
      const bound = Object.values(s.buffers as Record<string, Json>).some((b) => b.memory === Number(id));
      if (!bound) continue;
      this.memories.set(Number(id), d.createBuffer({ size: (m.size + 3) & ~3, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC |
        GPUBufferUsage.VERTEX | GPUBufferUsage.INDEX | GPUBufferUsage.UNIFORM | GPUBufferUsage.STORAGE }));
      this.mirrors.set(Number(id), new Uint8Array(m.size));
    }
    for (const [id, im] of Object.entries(s.images as Record<string, Json>)) {
      const format = FORMATS[im.format];
      if (!format) throw new Error(`image format ${im.format}`);
      const attachment = (im.usage & 0x30) !== 0;  // colour or depth attachment
      const usage = (im.samples > 1 ? 0 : GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST) | (attachment ? GPUTextureUsage.RENDER_ATTACHMENT : 0) |
        ((im.usage & 1) ? GPUTextureUsage.COPY_SRC : 0);
      this.textures.set(Number(id), d.createTexture({ size: [im.width, im.height, im.layers], format, mipLevelCount: im.mips, sampleCount: im.samples, usage }));
    }
    for (const [id, v] of Object.entries(s.views as Record<string, Json>)) {
      const dimension: GPUTextureViewDimension = v.viewType === 'VK_IMAGE_VIEW_TYPE_CUBE' ? 'cube' : v.viewType === 'VK_IMAGE_VIEW_TYPE_2D_ARRAY' ? '2d-array' : '2d';
      this.views.set(Number(id), this.textures.get(v.image)!.createView({ dimension, baseMipLevel: v.baseMip, mipLevelCount: v.mips, baseArrayLayer: v.baseLayer, arrayLayerCount: v.layers }));
    }
    for (const [id, x] of Object.entries(s.samplers as Record<string, Json>)) {
      this.samplers.set(Number(id), d.createSampler({ magFilter: x.magFilter === 'VK_FILTER_LINEAR' ? 'linear' : 'nearest', minFilter: x.minFilter === 'VK_FILTER_LINEAR' ? 'linear' : 'nearest',
        mipmapFilter: x.mipmapMode === 'VK_SAMPLER_MIPMAP_MODE_LINEAR' ? 'linear' : 'nearest', addressModeU: ADDRESS[x.addressModeU], addressModeV: ADDRESS[x.addressModeV],
        addressModeW: ADDRESS[x.addressModeW], lodMinClamp: x.minLod, lodMaxClamp: Math.min(x.maxLod, 32) }));
    }
    // Bind group layouts: a Vulkan binding b is WGSL binding 2b (a combined image-sampler's texture; its sampler 2b+1).
    // A layout says nothing of a texture's dimension: the shaders that use the set say it.
    const texInfo = new Map<string, { dimension?: GPUTextureViewDimension; sampleType?: GPUTextureSampleType }>();
    for (const p of Object.values(s.pipelines as Record<string, Json>)) {
      const layout = s.pipelineLayouts[p.layout];
      for (const st of p.stages) {
        for (const b of this.shaders.get(this.stageKey(st))!.bindings) {
          if (b.kind === 'texture') texInfo.set(`${layout.setLayouts[b.set]}:${b.binding}`, { dimension: b.dimension, sampleType: b.sampleType });
        }
      }
    }
    for (const [id, bindings] of Object.entries(s.setLayouts as Record<string, Json[]>)) {
      const entries: GPUBindGroupLayoutEntry[] = [];
      const dynamic: number[] = [];
      const textures = new Set<number>();
      for (const b of bindings) {
        const visibility = ((b.stages & 1) ? 1 : 0) | ((b.stages & 0x10) ? 2 : 0) | ((b.stages & 0x20) ? 4 : 0);
        if (b.type === DESC.UNIFORM_BUFFER || b.type === DESC.UNIFORM_BUFFER_DYNAMIC) {
          entries.push({ binding: b.binding * 2, visibility, buffer: { type: 'uniform', hasDynamicOffset: b.type === DESC.UNIFORM_BUFFER_DYNAMIC } });
          if (b.type === DESC.UNIFORM_BUFFER_DYNAMIC) dynamic.push(b.binding);
        } else if (b.type === DESC.STORAGE_BUFFER || b.type === DESC.STORAGE_BUFFER_DYNAMIC) {
          entries.push({ binding: b.binding * 2, visibility, buffer: { type: 'read-only-storage', hasDynamicOffset: b.type === DESC.STORAGE_BUFFER_DYNAMIC } });
          if (b.type === DESC.STORAGE_BUFFER_DYNAMIC) dynamic.push(b.binding);
        } else if (b.type === DESC.COMBINED_IMAGE_SAMPLER) {
          // A texture no shader of the program reads has no dimension to give it: left out of the layout and the groups.
          const t = texInfo.get(`${id}:${b.binding}`);
          if (!t) continue;
          textures.add(b.binding);
          entries.push({ binding: b.binding * 2, visibility, texture: { viewDimension: t.dimension ?? '2d', sampleType: t.sampleType ?? 'float' } });
          entries.push({ binding: b.binding * 2 + 1, visibility, sampler: {} });
        } else throw new Error(`descriptor type ${b.type}`);
      }
      this.setLayouts.set(Number(id), { gpu: d.createBindGroupLayout({ entries }), dynamic: dynamic.sort((x, y) => x - y), textures });
    }
    this.emptyLayout = d.createBindGroupLayout({ entries: [] });
    this.emptyGroup = d.createBindGroup({ layout: this.emptyLayout, entries: [] });
    this.ringLayout = d.createBindGroupLayout({ entries: [{ binding: 0, visibility: 3, buffer: { type: 'uniform', hasDynamicOffset: true } }] });
    this.ringBuf = d.createBuffer({ size: RING, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.ringGroup = d.createBindGroup({ layout: this.ringLayout, entries: [{ binding: 0, resource: { buffer: this.ringBuf, size: 256 } }] });
    for (const [id, pl] of Object.entries(s.pipelineLayouts as Record<string, Json>)) {
      const groups = (pl.setLayouts as number[]).map((x) => this.setLayouts.get(x)!.gpu);
      const pushSize = (pl.push as Json[]).reduce((m, r) => Math.max(m, r.offset + r.size), 0);
      const gpu = d.createPipelineLayout({ bindGroupLayouts: groups, ...(this.hasImmediates && pushSize ? { immediateSize: Math.min(IMMEDIATES, pushSize) } : {}) } as GPUPipelineLayoutDescriptor);
      // The ring's layout: the push constants in a fourth group (at most three sets are used ahead of it).
      const padded = [...groups];
      while (padded.length < 3) padded.push(this.emptyLayout);
      const ring = d.createPipelineLayout({ bindGroupLayouts: [...padded, this.ringLayout] });
      this.pipelineLayouts.set(Number(id), { gpu, ring, sets: pl.setLayouts });
    }
  }

  stageKey(st: Json) {
    return `${this.setup.shaders[st.module].hash}:${(st.spec as { id: number; value: number }[]).map((x) => `${x.id}=${x.value}`).join(',')}`;
  }

  /** A pipeline's WebGPU form for the viewport's orientation (flip: a positive-height Vulkan viewport). */
  async pipeline(id: number, flip: boolean) {
    const key = `${id}:${flip}`;
    const have = this.pipelines.get(key);
    if (have) return have;
    const p = this.setup.pipelines[id], rp = this.setup.renderPasses[p.renderPass];
    const layout = this.pipelineLayouts.get(p.layout)!;
    const push = Math.max(...(p.stages as Json[]).map((st) => this.shaders.get(this.stageKey(st))!.pushBytes));
    const immediates = push > 0 && push <= IMMEDIATES && this.hasImmediates;
    const stage = (kind: string) => {
      const st = (p.stages as Json[]).find((x) => x.stage === kind)!;
      const meta = this.shaders.get(this.stageKey(st))!;
      let code = flip ? meta.wgslFlipped : meta.wgsl;
      // Push constants (naga writes them as immediates; older nagas as var<push_constant>): kept as immediates, or made
      // the ring's uniform (group 3).
      code = code.replace(/var<push_constant>/g, 'var<immediate>');
      if (!immediates) code = code.replace(/var<immediate>/g, '@group(3) @binding(0) var<uniform>');
      else if (!/requires[^;]*immediate_address_space/.test(code)) code = `requires immediate_address_space;\n${code}`;
      const module = this.device.createShaderModule({ code });
      return { module, entryPoint: meta.entry };
    };
    const vs = stage('VK_SHADER_STAGE_VERTEX_BIT'), fs = stage('VK_SHADER_STAGE_FRAGMENT_BIT');
    const buffers: GPUVertexBufferLayout[] = [];
    for (const b of p.vertexBindings as Json[]) {
      buffers[b.binding] = { arrayStride: b.stride, stepMode: b.instance ? 'instance' : 'vertex',
        attributes: (p.vertexAttributes as Json[]).filter((a) => a.binding === b.binding).map((a) => {
          const format = VERTEX_FORMATS[a.format];
          if (!format) throw new Error(`vertex format ${a.format}`);
          return { shaderLocation: a.location, offset: a.offset, format };
        }) };
    }
    const color = rp.color.map((i: number, k: number) => {
      const bl = p.blend[k];
      const blend = bl?.enable ? { color: { srcFactor: BLEND[bl.srcColor], dstFactor: BLEND[bl.dstColor], operation: 'add' as const },
        alpha: { srcFactor: BLEND[bl.srcAlpha], dstFactor: BLEND[bl.dstAlpha], operation: 'add' as const } } : undefined;
      return { format: FORMATS[rp.attachments[i].format], blend, writeMask: bl?.writeMask ?? 0xf };
    });
    const depth = rp.depth >= 0 ? { format: FORMATS[rp.attachments[rp.depth].format], depthWriteEnabled: p.depthWrite,
      depthCompare: p.depthTest ? COMPARE[p.depthCompare] : 'always' as GPUCompareFunction } : undefined;
    const cull = p.cullMode === 'VK_CULL_MODE_BACK_BIT' ? 'back' : p.cullMode === 'VK_CULL_MODE_FRONT_BIT' ? 'front' : 'none';
    const ccw = p.frontFace === 'VK_FRONT_FACE_COUNTER_CLOCKWISE';
    const gpu = await this.device.createRenderPipelineAsync({
      layout: immediates || push === 0 ? layout.gpu : layout.ring,
      vertex: { ...vs, buffers }, fragment: { ...fs, targets: color },
      primitive: { topology: TOPOLOGY[p.topology], cullMode: cull, frontFace: ccw !== flip ? 'ccw' : 'cw' },
      depthStencil: depth, multisample: { count: p.samples },
    });
    const r = { gpu, immediates, push: push > 0, groups: immediates || push === 0 ? layout.sets.length : 4 };
    this.pipelines.set(key, r);
    return r;
  }

  /** The bind group for a descriptor set's current content (made once per content: a set updated back to what it
   * held before finds its group again). */
  bindGroup(id: number): GPUBindGroup {
    const st = this.sets.get(id)!;
    if (st.dirty) {
      st.key = `${st.layout}|${st.resources.map((r) => r?.join(',') ?? '').join('|')}`;
      st.dirty = false;
    }
    let g = this.bindGroups.get(st.key);
    if (!g) {
      const entries: GPUBindGroupEntry[] = [];
      for (const b of this.setup.setLayouts[st.layout] as Json[]) {
        const r = st.resources[b.binding];
        if (!r) throw new Error(`set ${id} binding ${b.binding} never written`);
        if (b.type === DESC.COMBINED_IMAGE_SAMPLER) {
          if (!this.setLayouts.get(st.layout)!.textures.has(b.binding)) continue;
          entries.push({ binding: b.binding * 2, resource: this.views.get(r[1])! }, { binding: b.binding * 2 + 1, resource: this.samplers.get(r[0])! });
        } else {
          const buf = this.setup.buffers[r[0]];
          const size = r[2] === 0xffffffff ? buf.size - r[1] : r[2];
          entries.push({ binding: b.binding * 2, resource: { buffer: this.memories.get(buf.memory)!, offset: buf.offset + r[1], size } });
        }
      }
      g = this.device.createBindGroup({ layout: this.setLayouts.get(st.layout)!.gpu, entries });
      this.bindGroups.set(st.key, g);
      this.stats.bindGroupsCreated++;
    }
    return g;
  }

  /** Runs the stream's ops from `from` to `to` (setup, or a frame), translating command buffers at their submits. */
  async run(from: number, to: number) {
    const w = this.stream, d = this.device;
    const recorded = new Map<number, [number, number]>();
    let cbStart = 0;
    for (let i = from; i < to;) {
      const op = w[i], len = opLength(w, i);
      switch (op) {
        case OP.FILL: {
          const mem = w[i + 1], off = w[i + 2], n = w[i + 3];
          const data = this.bytes.subarray((i + 4) * 4, (i + 4) * 4 + n);
          const buf = this.memories.get(mem);
          if (buf) { d.queue.writeBuffer(buf, off, data, 0, (n + 3) & ~3); this.stats.uploads += n; }
          this.mirrors.get(mem)?.set(data, off);
          break;
        }
        case OP.UPDATE_DESC: {
          let j = i + 2;
          for (let k = 0; k < w[i + 1]; k++) {
            const set = w[j], binding = w[j + 1], t = w[j + 3], n = w[j + 4];
            let st = this.sets.get(set);
            if (!st) { st = { layout: this.setup.sets[set].layout, resources: [], key: '', dirty: true }; this.sets.set(set, st); }
            const image = t === DESC.COMBINED_IMAGE_SAMPLER || t === DESC.SAMPLED_IMAGE || t === DESC.SAMPLER;
            st.resources[binding] = image ? [w[j + 5], w[j + 6]] : [w[j + 5], w[j + 6], w[j + 7]];
            st.dirty = true;
            j += 5 + n * (image ? 2 : 3);
          }
          break;
        }
        case OP.BEGIN_CB: cbStart = i + len; break;
        case OP.END_CB: recorded.set(w[i + 1], [cbStart, i]); break;
        case OP.SUBMIT: {
          const enc = d.createCommandEncoder();
          for (let k = 0; k < w[i + 1]; k++) {
            const r = recorded.get(w[i + 2 + k]);
            if (r) await this.translate(enc, r[0], r[1]);
          }
          d.queue.submit([enc.finish()]);
          break;
        }
        default: break;  // recorded commands: translated at their submit
      }
      i += len;
    }
  }

  /** A command buffer's commands onto an encoder. */
  async translate(enc: GPUCommandEncoder, from: number, to: number) {
    const w = this.stream, f32 = new Float32Array(w.buffer);
    let pass: GPURenderPassEncoder | null = null;
    let flip = false, current: { gpu: GPURenderPipeline; immediates: boolean; push: boolean; groups: number } | null = null;
    let pipelineId = -1, pipelineLayout = -1;
    const push = new Uint8Array(128);
    let pushDirty = false, ringAt = 0;
    const bound: (GPUBindGroup | null)[] = [null, null, null, null];
    for (let i = from; i < to; i += opLength(w, i)) {
      switch (w[i]) {
        case OP.BEGIN_RP: {
          const rp = this.setup.renderPasses[w[i + 1]], fb = this.setup.framebuffers[w[i + 2]];
          const clear = (k: number) => i + 8 + k * 5;
          const view = (k: number) => this.views.get(fb.attachments[k])!;
          pass = enc.beginRenderPass({
            colorAttachments: rp.color.map((a: number, k: number) => ({
              view: view(a), resolveTarget: rp.resolve[k] !== undefined ? view(rp.resolve[k]) : undefined,
              clearValue: [f32[clear(a)], f32[clear(a) + 1], f32[clear(a) + 2], f32[clear(a) + 3]],
              loadOp: rp.attachments[a].load === 'VK_ATTACHMENT_LOAD_OP_LOAD' ? 'load' : 'clear',
              storeOp: rp.attachments[a].store === 'VK_ATTACHMENT_STORE_OP_STORE' ? 'store' : 'discard' })),
            depthStencilAttachment: rp.depth >= 0 ? { view: view(rp.depth), depthClearValue: f32[clear(rp.depth) + 4],
              depthLoadOp: rp.attachments[rp.depth].load === 'VK_ATTACHMENT_LOAD_OP_LOAD' ? 'load' : 'clear',
              depthStoreOp: rp.attachments[rp.depth].store === 'VK_ATTACHMENT_STORE_OP_STORE' ? 'store' : 'discard' } : undefined,
          });
          bound.fill(null);
          current = null;
          break;
        }
        case OP.END_RP: pass!.end(); pass = null; break;
        case OP.VIEWPORT: {
          const [x, y, vw, vh, mn, mx] = [f32[i + 1], f32[i + 2], f32[i + 3], f32[i + 4], f32[i + 5], f32[i + 6]];
          // A negative height is GL's convention, which is WebGPU's: the same viewport with its height made positive.
          flip = vh > 0;
          pass!.setViewport(x, vh < 0 ? y + vh : y, vw, Math.abs(vh), mn, mx);
          break;
        }
        case OP.SCISSOR: pass!.setScissorRect(w[i + 1], w[i + 2], w[i + 3], w[i + 4]); break;
        case OP.BIND_PIPELINE: {
          pipelineId = w[i + 1];
          const p = this.setup.pipelines[pipelineId];
          current = this.pipelines.get(`${pipelineId}:${flip}`) ?? await this.pipeline(pipelineId, flip);
          pass!.setPipeline(current.gpu);
          // Sets stay bound across pipelines, as in Vulkan with compatible layouts (WebGPU keeps them across setPipeline).
          pipelineLayout = p.layout;
          pushDirty = current.push;
          break;
        }
        case OP.BIND_SETS: {
          const first = w[i + 2], n = w[i + 3];
          let dyn = i + 5 + n;
          for (let k = 0; k < n; k++) {
            const set = w[i + 4 + k];
            const g = this.bindGroup(set);
            const nd = this.setLayouts.get(this.sets.get(set)!.layout)!.dynamic.length;
            const offsets = nd ? Array.from(w.subarray(dyn, dyn + nd)) : undefined;
            dyn += nd;
            if (offsets) pass!.setBindGroup(first + k, g, offsets);
            else if (bound[first + k] !== g) pass!.setBindGroup(first + k, g);
            bound[first + k] = g;
          }
          break;
        }
        case OP.PUSH: {
          const off = w[i + 3], n = w[i + 4];
          push.set(this.bytes.subarray((i + 5) * 4, (i + 5) * 4 + n), off);
          pushDirty = true;
          break;
        }
        case OP.BIND_VB: {
          for (let k = 0; k < w[i + 2]; k++) {
            const b = this.setup.buffers[w[i + 3 + 2 * k]];
            pass!.setVertexBuffer(w[i + 1] + k, this.memories.get(b.memory)!, b.offset + w[i + 4 + 2 * k]);
          }
          break;
        }
        case OP.BIND_IB: {
          const b = this.setup.buffers[w[i + 1]];
          pass!.setIndexBuffer(this.memories.get(b.memory)!, w[i + 3] === 32 ? 'uint32' : 'uint16', b.offset + w[i + 2]);
          break;
        }
        case OP.DRAW: case OP.DRAW_INDEXED: {
          const c = current!;
          // WebGPU wants every group of the layout bound, used or not.
          for (let g = 0; g < c.groups; g++) {
            if (g === 3 && !c.immediates && c.push) continue;
            if (!bound[g]) {
              const sets = this.setup.pipelineLayouts[pipelineLayout].setLayouts as number[];
              const nd = g < sets.length ? this.setLayouts.get(sets[g])!.dynamic.length : 0;
              pass!.setBindGroup(g, this.emptyGroupFor(pipelineLayout, g), nd ? new Array<number>(nd).fill(0) : undefined);
              bound[g] = this.emptyGroup;
            }
          }
          if (c.push && pushDirty) {
            if (c.immediates) {
              (pass as unknown as { setImmediates(o: number, d: Uint8Array, a: number, s: number): void }).setImmediates(0, push, 0, IMMEDIATES);
              this.stats.immediateDraws++;
            } else {
              if (ringAt + 256 > RING) throw new Error('push-constant ring full');
              this.ringCpu.set(push, ringAt);
              pass!.setBindGroup(3, this.ringGroup, [ringAt]);
              ringAt += 256;
              this.stats.ringDraws++;
            }
            pushDirty = false;
          }
          if (w[i] === OP.DRAW) pass!.draw(w[i + 1], w[i + 2], w[i + 3], w[i + 4]);
          else pass!.drawIndexed(w[i + 1], w[i + 2], w[i + 3], w[i + 4] | 0, w[i + 5]);
          this.stats.draws++;
          break;
        }
        case OP.COPY_BUFFER: {
          const src = this.setup.buffers[w[i + 1]], dst = this.setup.buffers[w[i + 2]];
          for (let k = 0; k < w[i + 3]; k++) {
            const r = i + 4 + 3 * k;
            enc.copyBufferToBuffer(this.memories.get(src.memory)!, src.offset + w[r], this.memories.get(dst.memory)!, dst.offset + w[r + 1], w[r + 2]);
          }
          break;
        }
        case OP.COPY_BUF_TO_IMG: {
          // WebGPU wants rows of a buffer-to-texture copy 256 bytes apart: the rows are repacked from the guest's
          // memory (the prototype writes them from its copy of host-visible memory: setup only).
          const src = this.setup.buffers[w[i + 1]], tex = this.textures.get(w[i + 2])!;
          const mirror = this.mirrors.get(src.memory)!;
          for (let k = 0; k < w[i + 3]; k++) {
            const r = i + 4 + 10 * k;
            const [bo, rowLen, , mip, layer, layers, x, y, width, height] = Array.from(w.subarray(r, r + 10));
            const rowBytes = (rowLen || width) * 4;
            this.device.queue.writeTexture({ texture: tex, mipLevel: mip, origin: [x, y, layer] }, mirror, { offset: src.offset + bo, bytesPerRow: rowBytes, rowsPerImage: height }, [width, height, layers]);
          }
          break;
        }
        default: break;
      }
    }
    if (ringAt) this.device.queue.writeBuffer(this.ringBuf, 0, this.ringCpu, 0, ringAt);
  }

  emptyGroups = new Map<string, GPUBindGroup>();
  /** A group for a set the program left unbound: empty resources of its layout's kinds would be needed for a real
   * layout; the prototype's programs leave only sets with no bindings unbound. */
  emptyGroupFor(pipelineLayout: number, g: number): GPUBindGroup {
    const sets = this.setup.pipelineLayouts[pipelineLayout].setLayouts as number[];
    if (g >= sets.length) return this.emptyGroup;
    const key = `${pipelineLayout}:${g}`;
    let grp = this.emptyGroups.get(key);
    if (!grp) {
      // A set the program never bound: any set of that layout the program wrote will do (the prototype's programs
      // bind every set their pipelines read).
      const st = [...this.sets.entries()].find(([, x]) => x.layout === sets[g]);
      if (!st) throw new Error(`group ${g} of layout ${pipelineLayout} unbound and no set of its layout written`);
      grp = this.bindGroup(st[0]);
      this.emptyGroups.set(key, grp);
    }
    return grp;
  }

  /** Setup, then the frames looped: warm-up, timed samples; or one frame read back (dump). */
  async replay(o: { warmup: number; samples: number; frames: number; inFlight: number; gpuFrames: number }, dump?: { frame: number; image: number }):
    Promise<ReplayResult & { pixels?: Uint8Array; width?: number; height?: number }> {
    const s = this.setup, d = this.device;
    const t0 = performance.now();
    await this.run(0, s.frameStart);
    await d.queue.onSubmittedWorkDone();
    this.log?.('setup run');
    // The frames' offsets: each from the word after the previous frame's submit.
    const starts: number[] = [];
    const w = this.stream;
    let at = s.frameStart;
    starts.push(at);
    for (let i = s.frameStart; i < w.length;) {
      const len = opLength(w, i);
      if (w[i] === OP.SUBMIT) starts.push(i + len);
      i += len;
    }
    const frames = starts.length - 1;
    // Compile every pipeline before timing (a pipeline cache's work): createShaderModule and createRenderPipelineAsync,
    // timed apart from the setup.
    const setupMs = performance.now() - t0;
    const t1 = performance.now();
    for (const id of Object.keys(s.pipelines)) await this.pipeline(Number(id), false);
    const pipelineMs = performance.now() - t1;
    this.log?.(`setup ${setupMs.toFixed(0)} ms, ${Object.keys(s.pipelines).length} pipelines ${pipelineMs.toFixed(0)} ms`);
    this.log?.(`pipelines made: ${frames} frames to replay`);
    const pending: Promise<void>[] = [];
    const settle = async (n: number) => { while (pending.length > n) await pending.shift(); };
    let k = 0;
    const one = async () => {
      const f = k++ % frames;
      await this.run(starts[f], starts[f + 1]);
      pending.push(d.queue.onSubmittedWorkDone());
    };
    if (dump) {
      while (k <= dump.frame) { await one(); await settle(o.inFlight - 1); }
      await settle(0);
      if (dump.image < 0) {
        // The first framebuffer's colour image (its resolve target if it has one).
        const fb = Object.values(s.framebuffers as Record<string, Json>)[0], rp = s.renderPasses[fb.renderPass];
        dump.image = s.views[fb.attachments[rp.resolve[0] ?? rp.color[0]]].image;
      }
      const im = s.images[dump.image];
      const rb = d.createBuffer({ size: im.width * im.height * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const enc = d.createCommandEncoder();
      enc.copyTextureToBuffer({ texture: this.textures.get(dump.image)! }, { buffer: rb, bytesPerRow: im.width * 4 }, [im.width, im.height]);
      d.queue.submit([enc.finish()]);
      await rb.mapAsync(GPUMapMode.READ);
      const pixels = new Uint8Array(rb.getMappedRange()).slice();
      return { ...this.result([], [], [], 1, pipelineMs), pixels, width: im.width, height: im.height };
    }
    for (let n = 0; n < o.warmup; n++) { await one(); await settle(o.inFlight - 1); }
    await settle(0);
    this.onMark?.('start');
    this.stats = { bindGroupsCreated: this.stats.bindGroupsCreated, immediateDraws: 0, ringDraws: 0, draws: 0, uploads: 0 };
    const created0 = this.stats.bindGroupsCreated;
    const frameMs: number[] = [], jsMs: number[] = [];
    for (let smp = 0; smp < o.samples; smp++) {
      let js = 0;
      const t = performance.now();
      for (let n = 0; n < o.frames; n++) {
        const a = performance.now();
        await one();
        js += performance.now() - a;
        await settle(o.inFlight - 1);
      }
      frameMs.push((performance.now() - t) / o.frames);
      jsMs.push(js / o.frames);
    }
    await settle(0);
    this.onMark?.('end');
    const r = this.result(frameMs, jsMs, [], o.samples * o.frames, pipelineMs);
    r.bindGroupsCreated = this.stats.bindGroupsCreated - created0;
    return r;
  }

  result(frameMs: number[], jsMs: number[], gpuMs: number[], measured: number, pipelineMs: number): ReplayResult {
    return { frameMs, jsMs, gpuMs, drawsPerFrame: this.stats.draws / Math.max(1, measured), uploadBytesPerFrame: this.stats.uploads / Math.max(1, measured),
      pipelineMs, bindGroupsCreated: this.stats.bindGroupsCreated, immediateDraws: this.stats.immediateDraws / Math.max(1, measured),
      ringDraws: this.stats.ringDraws / Math.max(1, measured), adapter: this.adapterInfo() };
  }
}
