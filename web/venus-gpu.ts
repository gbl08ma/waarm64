// The Vulkan driver's "hardware" (vk/driver/wg_gpu.h; vk/README.md "The driver"): the renderer module's `wg` imports,
// implemented on the GPU worker's WebGPU device. The driver names every object by an id it assigns, describes the
// rarely made ones as JSON (ids for the objects they refer to) and replays each submit's commands as calls with plain
// numbers into one command encoder. What it can't express as a WebGPU command — blits, resolves, image clears and
// clears of a pass's attachments — is drawn here (`meta`, `clearRects`). A submit completes once its work is done and
// the staging buffers of its readbacks are mapped: then `complete(serial)` calls back into the module, in submit order.
// Without a device (Node's tests) objects are only counted and every submit completes at once.

/** GPUBufferUsage's and GPUMapMode's values (the worker may lack the globals in Node). */
const COPY_SRC = 4, COPY_DST = 8, UNIFORM = 64, MAP_READ = 1, MAP_MODE_READ = 1;

export type VenusGpuStats = { submits: number; uploads: number; uploadBytes: number; readbacks: number; readbackBytes: number; pipelines: number; pipelineMs: number; bindGroups: number; errors: number; dirtyPages: number };

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type View = { view: GPUTextureView; format: GPUTextureFormat; samples: number; tex: GPUTexture };
type Obj = GPUBuffer | GPUTexture | View | GPUSampler | GPUBindGroupLayout | GPUPipelineLayout | GPURenderPipeline | GPUComputePipeline | GPUBindGroup | GPUShaderModule | GPUQuerySet;

/** The device's optional features the driver uses (vk/driver/wg_private.h `wg_feature`). */
export function gpuFeatures(device: GPUDevice | undefined) {
  if (!device) return 0;
  const f = device.features;
  return (f.has('texture-compression-bc') ? 1 : 0) | (f.has('texture-compression-etc2') ? 2 : 0) | (f.has('texture-compression-astc') ? 4 : 0) |
    (f.has('depth32float-stencil8') ? 8 : 0) | (f.has('float32-filterable') ? 16 : 0) | (f.has('depth-clip-control') ? 32 : 0) |
    (f.has('dual-source-blending') ? 64 : 0) | (f.has('clip-distances' as GPUFeatureName) ? 128 : 0) | (f.has('indirect-first-instance') ? 256 : 0) | (1 << 31);
}

/** The bytes of immediates a pipeline layout may declare on `device` (0 where the browser has none). */
export function maxImmediates(device: GPUDevice | undefined) {
  const has = typeof GPURenderPassEncoder !== 'undefined' && typeof (GPURenderPassEncoder.prototype as unknown as { setImmediates?: unknown }).setImmediates === 'function';
  return device && has ? Math.min(128, (device.limits as unknown as Record<string, number>).maxImmediateSize ?? 0) : 0;
}

/** The features and limits to ask an adapter's device for. */
export function deviceRequest(adapter: GPUAdapter): GPUDeviceDescriptor {
  const want = ['texture-compression-bc', 'texture-compression-etc2', 'texture-compression-astc', 'depth32float-stencil8', 'float32-filterable',
    'depth-clip-control', 'dual-source-blending', 'clip-distances', 'rg11b10ufloat-renderable', 'indirect-first-instance'] as GPUFeatureName[];
  const limits = adapter.limits as unknown as Record<string, number>;
  const requiredLimits: Record<string, number> = {};
  for (const k of ['maxBufferSize', 'maxStorageBufferBindingSize', 'maxBindGroups', 'maxColorAttachmentBytesPerSample', 'maxStorageBuffersPerShaderStage', 'maxSampledTexturesPerShaderStage', 'maxSamplersPerShaderStage', 'maxUniformBuffersPerShaderStage', 'maxStorageTexturesPerShaderStage', 'maxDynamicUniformBuffersPerPipelineLayout', 'maxDynamicStorageBuffersPerPipelineLayout', 'maxTextureDimension2D', 'maxTextureArrayLayers', 'maxImmediateSize', 'maxInterStageShaderVariables', 'maxVertexAttributes', 'maxComputeWorkgroupStorageSize', 'maxComputeInvocationsPerWorkgroup']) {
    if (typeof limits[k] === 'number') requiredLimits[k] = limits[k];
  }
  return { requiredFeatures: want.filter((f) => adapter.features.has(f)), requiredLimits };
}

export class VenusGpu {
  readonly stats: VenusGpuStats = { submits: 0, uploads: 0, uploadBytes: 0, readbacks: 0, readbackBytes: 0, pipelines: 0, pipelineMs: 0, bindGroups: 0, errors: 0, dirtyPages: 0 };
  private readonly objs: (Obj | undefined)[] = [];
  private enc: GPUCommandEncoder | undefined;
  private pass: GPURenderPassEncoder | GPUComputePassEncoder | undefined;
  /** The current render pass's attachments (for clears inside it). */
  private passAtts: { colors: (GPUTextureFormat | null)[]; depth?: GPUTextureFormat; samples: number; width: number; height: number } | undefined;
  /** Buffers to destroy once the encoder is submitted, and the readbacks' staging buffers by slot. */
  private temps: GPUBuffer[] = [];
  private readonly slots = new Map<number, { buffer: GPUBuffer; size: number }>();
  private submitSlots: number[] = [];
  private nextSlot = 1;
  private chain: Promise<void> = Promise.resolve();
  private readonly metaPipelines = new Map<string, GPURenderPipeline>();
  private readonly views = new Map<string, GPUTextureView>();
  private readonly seen = new Set<string>();
  private readonly mem: () => ArrayBuffer;
  /** The submit (its count in `stats.submits`) that last wrote each texture, and those the open encoder writes. */
  private readonly written = new WeakMap<GPUTexture, number>();
  private touched = new Set<GPUTexture>();

  /**
   * `memory`: memory 0. `complete(serial)`: the module's export. `dirty()`: the window's written pages since the last
   * call (undefined: unknown, every page counts).
   */
  private readonly device: GPUDevice | undefined;
  private readonly complete: (serial: number) => void;
  private readonly dirty: () => number[] | undefined;

  constructor(device: GPUDevice | undefined, memory: WebAssembly.Memory, complete: (serial: number) => void, dirty: () => number[] | undefined) {
    [this.device, this.complete, this.dirty] = [device, complete, dirty];
    this.mem = () => memory.buffer as ArrayBuffer;
    device?.addEventListener('uncapturederror', (e) => this.warn(`WebGPU: ${(e as GPUUncapturedErrorEvent).error.message}`));
  }

  private warn(m: string) {
    this.stats.errors++;
    const key = m.slice(0, 200);
    if (this.seen.has(key) || this.seen.size > 200) return;
    this.seen.add(key);
    console.warn(`venus-gpu: ${m}`);
  }

  private text(ptr: number, len: number) {
    return new TextDecoder().decode(new Uint8Array(this.mem(), ptr >>> 0, len).slice());
  }

  private get<T extends Obj>(id: number) { return this.objs[id] as T; }

  /** A texture by its id, with the submit that last wrote it (0: none yet): web/venus-share.ts reads WSI images. */
  texture(id: number): { texture: GPUTexture; written: number } | undefined {
    const t = this.objs[id];
    return t instanceof GPUTexture ? { texture: t, written: this.written.get(t) ?? 0 } : undefined;
  }

  /** The module's `wg` imports. */
  imports(): Record<string, (...a: number[]) => number | void> {
    const d = this.device;
    const self = this;
    const rp = () => this.pass as GPURenderPassEncoder;
    const cp = () => this.pass as GPUComputePassEncoder;
    const buf = (id: number) => this.get<GPUBuffer>(id);
    const nothing = () => {};
    if (!d) {
      // No device: objects aren't made; a submit completes in a later task.
      const noop: Record<string, (...a: number[]) => number | void> = {};
      for (const n of IMPORTS) noop[n] = nothing;
      noop.gpu_readback = () => 0;
      noop.gpu_dirty = (ptr: number, max: number) => this.dirtyInto(ptr, max);
      noop.gpu_submit = (serial: number) => { this.stats.submits++; this.chain = this.chain.then(() => this.complete(serial)); };
      return noop;
    }
    // An exception out of an import would unwind the module's call midway (its state half updated: the renderer then
    // misbehaves for good); what WebGPU's API throws (an argument it rejects) is warned and the command dropped.
    const guarded: Record<string, (...a: number[]) => number | void> = {};
    for (const [name, f] of Object.entries(this.calls(d, self, rp, cp, buf))) {
      guarded[name] = (...a: number[]) => {
        try {
          return f(...a);
        } catch (e) {
          self.warn(`${name} threw: ${String(e).slice(0, 300)}`);
          return 0;
        }
      };
    }
    return guarded;
  }

  private calls(d: GPUDevice, self: this, rp: () => GPURenderPassEncoder, cp: () => GPUComputePassEncoder, buf: (id: number) => GPUBuffer): Record<string, (...a: number[]) => number | void> {
    return {
      gpu_create(kind: number, id: number, ptr: number, len: number) { self.create(kind, id, parseJson(self.text(ptr, len))); },
      gpu_shader(id: number, ptr: number, len: number) {
        const code = self.text(ptr, len);
        const m = d.createShaderModule({ code });
        self.objs[id] = m;
        void m.getCompilationInfo().then((info) => {
          const errors = info.messages.filter((x) => x.type === 'error');
          if (errors.length) self.warn(`a shader didn't compile: ${errors.map((x) => `${x.lineNum}:${x.linePos} ${x.message}`).join('; ')}\n${code.split('\n').slice(0, 400).join('\n')}`);
        });
      },
      gpu_destroy(id: number) {
        const o = self.objs[id];
        if (o instanceof GPUBuffer || o instanceof GPUTexture || o instanceof GPUQuerySet) o.destroy();
        self.objs[id] = undefined;
      },
      gpu_write(id: number, offset: number, ptr: number, size: number) {
        if (!size) return;
        d.queue.writeBuffer(buf(id), offset, self.mem(), ptr >>> 0, size);
        self.stats.uploads++;
        self.stats.uploadBytes += size;
      },
      gpu_dirty: (ptr: number, max: number) => this.dirtyInto(ptr, max),
      gpu_encoder() { self.enc = d.createCommandEncoder(); },
      gpu_copy_bb(src: number, so: number, dst: number, dO: number, size: number) {
        if (size) self.enc!.copyBufferToBuffer(buf(src), so, buf(dst), dO, size);
      },
      gpu_copy_bt(b: number, offset: number, bpr: number, rows: number, tex: number, mip: number, x: number, y: number, z: number, w: number, h: number, depth: number, aspect: number) {
        self.touched.add(self.get<GPUTexture>(tex));
        if (aspect) return self.depthStencilCopy(true, b, offset, bpr, rows, tex, mip, x, y, z, w, h, depth, aspect);
        self.enc!.copyBufferToTexture(self.layout(b, offset, bpr, rows, h, depth), self.texCopy(tex, mip, x, y, z, aspect), { width: w, height: h, depthOrArrayLayers: depth });
      },
      gpu_copy_tb(b: number, offset: number, bpr: number, rows: number, tex: number, mip: number, x: number, y: number, z: number, w: number, h: number, depth: number, aspect: number) {
        if (aspect) return self.depthStencilCopy(false, b, offset, bpr, rows, tex, mip, x, y, z, w, h, depth, aspect);
        self.enc!.copyTextureToBuffer(self.texCopy(tex, mip, x, y, z, aspect), self.layout(b, offset, bpr, rows, h, depth), { width: w, height: h, depthOrArrayLayers: depth });
      },
      gpu_copy_tt(src: number, sm: number, sx: number, sy: number, sz: number, dst: number, dm: number, dx: number, dy: number, dz: number, w: number, h: number, depth: number, aspect: number) {
        self.enc!.copyTextureToTexture(self.texCopy(src, sm, sx, sy, sz, aspect), self.texCopy(dst, dm, dx, dy, dz, aspect), { width: w, height: h, depthOrArrayLayers: depth });
        self.touched.add(self.get<GPUTexture>(dst));
      },
      gpu_fill(b: number, offset: number, size: number, value: number) {
        if (!size) return;
        if (value === 0) return self.enc!.clearBuffer(buf(b), offset, size);
        const t = self.staging(size, (m) => new Uint32Array(m).fill(value >>> 0));
        self.enc!.copyBufferToBuffer(t, 0, buf(b), offset, size);
      },
      gpu_update(b: number, offset: number, ptr: number, size: number) {
        if (!size || !b) return;
        const padded = (size + 3) & ~3;
        const bytes = new Uint8Array(self.mem(), ptr >>> 0, size);
        const t = self.staging(padded, (m) => new Uint8Array(m).set(bytes));
        self.enc!.copyBufferToBuffer(t, 0, buf(b), offset, padded);
      },
      gpu_blit(ptr: number, len: number) { self.meta(parseJson(self.text(ptr, len))); },
      gpu_render_pass(ptr: number, len: number) {
        const j = parseJson(self.text(ptr, len));
        const colors: (GPUTextureFormat | null)[] = [];
        let samples = 1;
        const desc: GPURenderPassDescriptor = {
          colorAttachments: (j.colorAttachments as (Json | null)[]).map((a) => {
            if (!a) { colors.push(null); return null; }
            const v = self.get<View>(a.view);
            colors.push(v.format);
            samples = v.samples;
            self.touched.add(v.tex);
            if (a.resolveTarget) self.touched.add(self.get<View>(a.resolveTarget).tex);
            return { ...a, view: v.view, resolveTarget: a.resolveTarget ? self.get<View>(a.resolveTarget).view : undefined } as GPURenderPassColorAttachment;
          }),
        };
        let depth: GPUTextureFormat | undefined;
        if (j.depthStencilAttachment) {
          const v = self.get<View>(j.depthStencilAttachment.view);
          depth = v.format;
          samples = v.samples;
          desc.depthStencilAttachment = { ...j.depthStencilAttachment, view: v.view };
        }
        self.passAtts = { colors, depth, samples, width: j.width, height: j.height };
        self.pass = self.enc!.beginRenderPass(desc);
      },
      gpu_compute_pass() { self.pass = self.enc!.beginComputePass(); },
      gpu_pass_end() { self.pass?.end(); self.pass = undefined; self.passAtts = undefined; },
      gpu_set_pipeline(id: number) { (self.pass as GPURenderPassEncoder).setPipeline(self.get<GPURenderPipeline>(id)); },
      gpu_set_bind_group(index: number, id: number, ptr: number, n: number) {
        const offsets = n ? Array.from(new Uint32Array(self.mem(), ptr >>> 0, n)) : [];
        self.pass!.setBindGroup(index, self.get<GPUBindGroup>(id), offsets);
      },
      gpu_set_vertex_buffer(slot: number, b: number, offset: number, size: number) { rp().setVertexBuffer(slot, buf(b), offset, size); },
      gpu_set_index_buffer(b: number, wide: number, offset: number, size: number) { rp().setIndexBuffer(buf(b), wide ? 'uint32' : 'uint16', offset, size); },
      gpu_set_viewport(x: number, y: number, w: number, h: number, min: number, max: number) { rp().setViewport(x, y, w, h, min, max); },
      gpu_set_scissor(x: number, y: number, w: number, h: number) { rp().setScissorRect(x, y, w, h); },
      gpu_set_blend_constant(r: number, g: number, b: number, a: number) { rp().setBlendConstant([r, g, b, a]); },
      gpu_set_stencil_reference(ref: number) { rp().setStencilReference(ref); },
      gpu_set_immediates(offset: number, ptr: number, size: number) {
        (self.pass as unknown as { setImmediates(o: number, d: Uint8Array): void }).setImmediates(offset, new Uint8Array(self.mem(), ptr >>> 0, size).slice());
      },
      gpu_draw(n: number, inst: number, first: number, firstInst: number) { rp().draw(n, inst, first, firstInst); },
      gpu_draw_indexed(n: number, inst: number, first: number, base: number, firstInst: number) { rp().drawIndexed(n, inst, first, base, firstInst); },
      gpu_draw_indirect(b: number, offset: number, indexed: number) {
        if (indexed) rp().drawIndexedIndirect(buf(b), offset);
        else rp().drawIndirect(buf(b), offset);
      },
      gpu_dispatch(x: number, y: number, z: number) { cp().dispatchWorkgroups(x, y, z); },
      gpu_dispatch_indirect(b: number, offset: number) { cp().dispatchWorkgroupsIndirect(buf(b), offset); },
      gpu_clear_rects(ptr: number, len: number) { self.clearRects(parseJson(self.text(ptr, len))); },
      gpu_begin_occlusion(i: number) { rp().beginOcclusionQuery(i); },
      gpu_end_occlusion() { rp().endOcclusionQuery(); },
      gpu_resolve_queries(set: number, first: number, count: number, b: number, offset: number) {
        self.enc!.resolveQuerySet(self.get<GPUQuerySet>(set), first, count, buf(b), offset);
      },
      gpu_readback(b: number, offset: number, size: number) {
        const staging = d.createBuffer({ size, usage: MAP_READ | COPY_DST });
        self.enc!.copyBufferToBuffer(buf(b), offset, staging, 0, size);
        const slot = self.nextSlot++;
        self.slots.set(slot, { buffer: staging, size });
        self.submitSlots.push(slot);
        self.stats.readbacks++;
        self.stats.readbackBytes += size;
        return slot;
      },
      gpu_submit(serial: number) {
        if (self.pass) { self.pass.end(); self.pass = undefined; }
        d.queue.submit([self.enc!.finish()]);
        self.enc = undefined;
        self.stats.submits++;
        for (const t of self.touched) self.written.set(t, self.stats.submits);
        self.touched.clear();
        for (const t of self.temps) t.destroy();
        self.temps = [];
        const slots = self.submitSlots;
        self.submitSlots = [];
        const done = Promise.all([d.queue.onSubmittedWorkDone(), ...slots.map((s) => self.slots.get(s)!.buffer.mapAsync(MAP_MODE_READ))]);
        // In submit order: a later submit's work can't be done before an earlier one's, but its maps may resolve first.
        self.chain = self.chain.then(() => done).then(() => {
          self.complete(serial);
        }, (err) => {
          self.warn(`a submit's readbacks failed: ${err}`);
          self.complete(serial);
        }).finally(() => {
          for (const s of slots) { self.slots.get(s)!.buffer.destroy(); self.slots.delete(s); }
        });
      },
      gpu_readback_copy(slot: number, dst: number, size: number) {
        const s = self.slots.get(slot);
        if (!s) return;
        const n = Math.min(size, s.size) & ~3;
        new Uint8Array(self.mem(), dst >>> 0, n).set(new Uint8Array(s.buffer.getMappedRange(0, n)));
      },
    };
  }

  private dirtyInto(ptr: number, max: number) {
    const pages = this.dirty();
    if (!pages) return -1;
    this.stats.dirtyPages += pages.length;
    if (pages.length > max) return -1;
    new Uint32Array(this.mem(), ptr >>> 0, pages.length).set(pages);
    return pages.length;
  }

  private layout(b: number, offset: number, bpr: number, rows: number, h: number, depth: number): GPUTexelCopyBufferInfo {
    // One row of blocks needs no row pitch (WebGPU's must be 256-aligned where given).
    const one = rows <= 1 && depth === 1 && bpr % 256 !== 0;
    return one ? { buffer: this.get<GPUBuffer>(b), offset } : { buffer: this.get<GPUBuffer>(b), offset, bytesPerRow: bpr, rowsPerImage: Math.max(rows, 1) };
  }

  /** A copy between a buffer and a depth or stencil aspect (aspect 1 or 2: the driver doesn't split their rows), which
   * WebGPU allows only of whole subresources, with rows 256 bytes apart, not of depth24plus's aspects at all, not into
   * depth32float's depth (nor of multisampled textures): rows realigned through a temporary buffer, and what WebGPU can't do
   * skipped with a warning (one bad copy would invalidate the submit's whole command buffer). */
  private depthStencilCopy(toTexture: boolean, b: number, offset: number, bpr: number, rows: number, tex: number, mip: number, x: number, y: number, z: number, w: number, h: number, depth: number, aspect: number) {
    const t = this.get<GPUTexture>(tex), f = t.format;
    const stencil = aspect === 2 || f === 'stencil8';
    const bytes = stencil ? 1 : f === 'depth16unorm' ? 2 : 4;
    const whole = x === 0 && y === 0 && w === Math.max(1, t.width >> mip) && h === Math.max(1, t.height >> mip);
    const allowed = (stencil && !f.startsWith('depth24plus')) || f === 'depth16unorm' || (!toTexture && f.startsWith('depth32float'));
    const row = w * bytes;
    const realign = bpr % 256 !== 0 && (rows > 1 || depth > 1);
    if (!whole || !allowed || t.sampleCount > 1 || (realign && (row % 4 || bpr % 4 || offset % 4))) {
      this.warn(`a ${stencil ? 'stencil' : 'depth'} copy WebGPU can't make (${toTexture ? 'into' : 'from'} ${f}, ${w}x${h} at ${x},${y} of mip ${mip}): skipped`);
      return;
    }
    const size = { width: w, height: h, depthOrArrayLayers: depth };
    if (!realign) {
      const layout = this.layout(b, offset, bpr, rows, h, depth);
      if (toTexture) this.enc!.copyBufferToTexture(layout, this.texCopy(tex, mip, x, y, z, aspect), size);
      else this.enc!.copyTextureToBuffer(this.texCopy(tex, mip, x, y, z, aspect), layout, size);
      return;
    }
    const pitch = Math.ceil(row / 256) * 256;
    const temp = this.device!.createBuffer({ size: pitch * h * depth, usage: COPY_SRC | COPY_DST });
    this.temps.push(temp);
    const src = this.get<GPUBuffer>(b), enc = this.enc!;
    const each = (fn: (from: number, to: number) => void) => {
      for (let d = 0; d < depth; d++) for (let r = 0; r < h; r++) fn(offset + (d * rows + r) * bpr, (d * h + r) * pitch);
    };
    const layout = { buffer: temp, offset: 0, bytesPerRow: pitch, rowsPerImage: h };
    if (toTexture) {
      each((from, to) => enc.copyBufferToBuffer(src, from, temp, to, row));
      enc.copyBufferToTexture(layout, this.texCopy(tex, mip, x, y, z, aspect), size);
    } else {
      enc.copyTextureToBuffer(this.texCopy(tex, mip, x, y, z, aspect), layout, size);
      each((to, from) => enc.copyBufferToBuffer(temp, from, src, to, row));
    }
  }
  private texCopy(tex: number, mip: number, x: number, y: number, z: number, aspect: number): GPUTexelCopyTextureInfo {
    return { texture: this.get<GPUTexture>(tex), mipLevel: mip, origin: { x, y, z }, aspect: aspect === 1 ? 'depth-only' : aspect === 2 ? 'stencil-only' : 'all' };
  }

  /** A buffer of `size` bytes written by `fill` on the CPU, for a copy in the encoder (destroyed after its submit). */
  private staging(size: number, fill: (m: ArrayBuffer) => void) {
    const t = this.device!.createBuffer({ size, usage: COPY_SRC, mappedAtCreation: true });
    fill(t.getMappedRange());
    t.unmap();
    this.temps.push(t);
    return t;
  }

  private create(kind: number, id: number, j: Json) {
    const d = this.device!;
    const ids = (a: number[]) => a.map((i) => this.objs[i]);
    switch (kind) {
      case 0: this.objs[id] = d.createBuffer({ size: j.size, usage: j.usage }); return;
      case 1: this.objs[id] = d.createTexture(j as GPUTextureDescriptor); return;
      case 2: {
        const tex = this.get<GPUTexture>(j.texture);
        const { texture: _, ...desc } = j;
        this.objs[id] = { view: tex.createView(desc as GPUTextureViewDescriptor), format: j.format ?? tex.format, samples: tex.sampleCount, tex };
        return;
      }
      case 3: this.objs[id] = d.createSampler(j as GPUSamplerDescriptor); return;
      case 4: this.objs[id] = d.createBindGroupLayout(j as GPUBindGroupLayoutDescriptor); return;
      case 5: {
        const desc: Json = { bindGroupLayouts: ids(j.bindGroupLayouts) };
        if (j.immediateSize) desc.immediateSize = j.immediateSize;
        this.objs[id] = d.createPipelineLayout(desc as GPUPipelineLayoutDescriptor);
        return;
      }
      case 6: {
        const text = JSON.stringify(j);
        j.layout = this.objs[j.layout];
        j.vertex.module = this.objs[j.vertex.module];
        if (j.fragment) j.fragment.module = this.objs[j.fragment.module];
        const t0 = performance.now();
        d.pushErrorScope('validation');
        this.objs[id] = d.createRenderPipeline(j as GPURenderPipelineDescriptor);
        void d.popErrorScope().then((e) => { if (e) this.warn(`a render pipeline: ${e.message} (${text})`); });
        this.stats.pipelines++;
        this.stats.pipelineMs += performance.now() - t0;
        return;
      }
      case 7: {
        j.layout = this.objs[j.layout];
        j.compute.module = this.objs[j.compute.module];
        d.pushErrorScope('validation');
        this.objs[id] = d.createComputePipeline(j as GPUComputePipelineDescriptor);
        void d.popErrorScope().then((e) => { if (e) this.warn(`a compute pipeline: ${e.message}`); });
        this.stats.pipelines++;
        return;
      }
      case 8: {
        const entries = (j.entries as Json[]).map((e) => ({
          binding: e.binding,
          resource: e.buffer !== undefined ? { buffer: this.get<GPUBuffer>(e.buffer), offset: e.offset, size: e.size }
            : e.view !== undefined ? this.get<View>(e.view).view : this.get<GPUSampler>(e.sampler),
        }));
        d.pushErrorScope('validation');
        this.objs[id] = d.createBindGroup({ layout: this.get<GPUBindGroupLayout>(j.layout), entries });
        void d.popErrorScope().then((e) => { if (e) this.warn(`a bind group: ${e.message}`); });
        this.stats.bindGroups++;
        return;
      }
      case 9: this.objs[id] = d.createQuerySet({ type: j.type, count: j.count }); return;
    }
  }

  // What the driver can't say as WebGPU commands: drawn here.

  private viewOf(tex: number, mip: number, layer: number, format?: string) {
    const key = `${tex}:${mip}:${layer}:${format ?? ''}`;
    let v = this.views.get(key);
    const t = this.get<GPUTexture>(tex);
    if (!v || (v as unknown as { tex?: GPUTexture }).tex !== t) {
      // A 3D texture's slice is drawn into through its 3D view and the attachment's depthSlice (attachment()).
      v = t.dimension === '3d'
        ? t.createView({ dimension: '3d', baseMipLevel: mip, mipLevelCount: 1, ...(format ? { format: format as GPUTextureFormat } : {}) })
        : t.createView({ dimension: '2d', baseMipLevel: mip, mipLevelCount: 1, baseArrayLayer: layer, arrayLayerCount: 1, ...(format ? { format: format as GPUTextureFormat } : {}) });
      (v as unknown as { tex?: GPUTexture }).tex = t;
      if (this.views.size > 1024) this.views.clear();
      this.views.set(key, v);
    }
    return v;
  }

  /** A level and layer (a 3D texture's slice) as a colour attachment. */
  private attachment(tex: number, mip: number, layer: number) {
    const view = this.viewOf(tex, mip, this.get<GPUTexture>(tex).dimension === '3d' ? 0 : layer);
    return this.get<GPUTexture>(tex).dimension === '3d' ? { view, depthSlice: layer } : { view };
  }

  private meta(j: Json) {
    const enc = this.enc!;
    const tex = this.get<GPUTexture>(j.dst);
    this.touched.add(tex);
    const fmt = j.format as GPUTextureFormat;
    const depthy = /depth|stencil/.test(fmt);
    if (j.op === 'clear') {
      const view = this.viewOf(j.dst, j.dstMip, j.dstLayer);
      if (depthy) {
        const ds: GPURenderPassDepthStencilAttachment = { view };
        if (/depth/.test(fmt)) Object.assign(ds, j.depth !== undefined ? { depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: j.depth } : { depthLoadOp: 'load', depthStoreOp: 'store' });
        if (/stencil/.test(fmt)) Object.assign(ds, j.stencil !== undefined ? { stencilLoadOp: 'clear', stencilStoreOp: 'store', stencilClearValue: j.stencil } : { stencilLoadOp: 'load', stencilStoreOp: 'store' });
        enc.beginRenderPass({ colorAttachments: [], depthStencilAttachment: ds }).end();
      } else {
        enc.beginRenderPass({ colorAttachments: [{ ...this.attachment(j.dst, j.dstMip, j.dstLayer), loadOp: 'clear', storeOp: 'store', clearValue: j.color ?? [0, 0, 0, 0] }] }).end();
      }
      return;
    }
    if (j.op === 'resolve' && /int$/.test(fmt)) {
      this.warn(`a resolve of ${fmt}, which WebGPU can't resolve: skipped`);
      return;
    }
    if (j.op === 'resolve') {
      enc.beginRenderPass({ colorAttachments: [{ view: this.viewOf(j.src, j.srcMip, j.srcLayer), resolveTarget: this.viewOf(j.dst, j.dstMip, j.dstLayer), loadOp: 'load', storeOp: 'store' }] }).end();
      return;
    }
    // A blit: the source's region drawn into the destination's.
    const kind = sampleKind(fmt);
    const srcKind = sampleKind(j.srcFormat);
    const linear = j.filter === 'linear' && srcKind === 'f32' && !/32float/.test(j.srcFormat);
    const key = `blit:${fmt}:${srcKind}:${linear}`;
    let pipeline = this.metaPipelines.get(key);
    if (!pipeline) {
      const out = kind === 'f32' ? 'vec4<f32>' : kind === 'u32' ? 'vec4<u32>' : 'vec4<i32>';
      const tex = srcKind === 'f32' ? 'texture_2d<f32>' : srcKind === 'u32' ? 'texture_2d<u32>' : 'texture_2d<i32>';
      const read = linear ? 'textureSampleLevel(t, s, uv, 0.0)' : 'textureLoad(t, vec2<i32>(floor(uv * vec2<f32>(textureDimensions(t)))), 0)';
      const conv = kind === srcKind ? 'v' : kind === 'f32' ? 'vec4<f32>(v)' : `${out}(v)`;
      const code = `struct U { r: vec4<f32>, flip: vec4<f32> }
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var t: ${tex};
${linear ? '@group(0) @binding(2) var s: sampler;' : ''}
struct V { @builtin(position) p: vec4<f32>, @location(0) q: vec2<f32> }
@vertex fn vs(@builtin(vertex_index) i: u32) -> V {
  let q = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
  return V(vec4<f32>(q.x * 2.0 - 1.0, 1.0 - q.y * 2.0, 0.0, 1.0), q);
}
@fragment fn fs(v_in: V) -> @location(0) ${out} {
  let t01 = select(v_in.q, 1.0 - v_in.q, u.flip.xy > vec2<f32>(0.5));
  let uv = u.r.xy + t01 * u.r.zw;
  let v = ${read};
  return ${conv};
}`;
      const m = this.device!.createShaderModule({ code });
      pipeline = this.device!.createRenderPipeline({ layout: 'auto', vertex: { module: m, entryPoint: 'vs' }, fragment: { module: m, entryPoint: 'fs', targets: [{ format: fmt }] }, primitive: { topology: 'triangle-list' } });
      this.metaPipelines.set(key, pipeline);
    }
    const [sx0, sy0, sx1, sy1] = j.from as number[], [dx0, dy0, dx1, dy1] = j.to as number[];
    const [sw, sh] = j.srcSize as number[];
    if (dx0 === dx1 || dy0 === dy1) return;
    const u = this.staging(32, (m) => new Float32Array(m).set([sx0 / sw, sy0 / sh, (sx1 - sx0) / sw, (sy1 - sy0) / sh, dx0 > dx1 ? 1 : 0, dy0 > dy1 ? 1 : 0, 0, 0]));
    const uniform = this.device!.createBuffer({ size: 32, usage: UNIFORM | COPY_DST });
    enc.copyBufferToBuffer(u, 0, uniform, 0, 32);
    this.temps.push(uniform);
    const entries: GPUBindGroupEntry[] = [{ binding: 0, resource: { buffer: uniform } }, { binding: 1, resource: this.viewOf(j.src, j.srcMip, j.srcLayer) }];
    if (linear) entries.push({ binding: 2, resource: this.sampler() });
    const group = this.device!.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries });
    const pass = enc.beginRenderPass({ colorAttachments: [{ ...this.attachment(j.dst, j.dstMip, j.dstLayer), loadOp: 'load', storeOp: 'store' }] });
    const x = Math.min(dx0, dx1), y = Math.min(dy0, dy1);
    pass.setViewport(x, y, Math.abs(dx1 - dx0), Math.abs(dy1 - dy0), 0, 1);
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.draw(3);
    pass.end();
    void tex;
  }

  private linearSampler: GPUSampler | undefined;
  private sampler() {
    return (this.linearSampler ??= this.device!.createSampler({ magFilter: 'linear', minFilter: 'linear' }));
  }

  /** Rectangles of the current render pass's attachments cleared: a draw with the clear values (the pass's state is the driver's to set again). */
  private clearRects(j: Json) {
    const atts = this.passAtts;
    const pass = this.pass as GPURenderPassEncoder | undefined;
    if (!atts || !pass) return;
    const colors = new Map<number, number[]>((j.colors as number[][]).map((c) => [c[0], c.slice(1)]));
    const depth = j.depth as number | undefined, stencil = j.stencil as number | undefined;
    const key = `clear:${atts.colors.join(',')}:${atts.depth}:${atts.samples}:${[...colors.keys()].join(',')}:${depth !== undefined}:${stencil !== undefined}`;
    let pipeline = this.metaPipelines.get(key);
    if (!pipeline) {
      const outs = atts.colors.map((f, i) => f && colors.has(i) ? `@location(${i}) c${i}: vec4<${sampleKind(f)}>` : '').filter(Boolean);
      const sets = atts.colors.map((f, i) => f && colors.has(i) ? `o.c${i} = ${sampleKind(f) === 'f32' ? `bitcast<vec4<f32>>(u.c[${i}])` : sampleKind(f) === 'i32' ? `bitcast<vec4<i32>>(u.c[${i}])` : `u.c[${i}]`};` : '').filter(Boolean);
      const code = `struct U { c: array<vec4<u32>, 8>, d: vec4<f32> }
@group(0) @binding(0) var<uniform> u: U;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  let q = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4<f32>(q.x * 2.0 - 1.0, 1.0 - q.y * 2.0, u.d.x, 1.0);
}
${outs.length ? `struct O { ${outs.join(', ')} }
@fragment fn fs() -> O { var o: O; ${sets.join(' ')} return o; }` : '@fragment fn fs() {}'}`;
      const m = this.device!.createShaderModule({ code });
      const hasStencil = !!atts.depth && /stencil/.test(atts.depth), hasDepth = !!atts.depth && /depth/.test(atts.depth);
      const desc: GPURenderPipelineDescriptor = {
        layout: 'auto', vertex: { module: m, entryPoint: 'vs' }, primitive: { topology: 'triangle-list' },
        fragment: { module: m, entryPoint: 'fs', targets: atts.colors.map((f, i) => f ? { format: f, writeMask: colors.has(i) ? 0xf : 0 } : null) },
        multisample: { count: atts.samples },
      };
      if (atts.depth) {
        const face: GPUStencilFaceState = { compare: 'always', passOp: stencil !== undefined ? 'replace' : 'keep' };
        desc.depthStencil = { format: atts.depth, ...(hasDepth ? { depthWriteEnabled: depth !== undefined, depthCompare: 'always' as GPUCompareFunction } : {}),
          ...(hasStencil ? { stencilFront: face, stencilBack: face, stencilWriteMask: stencil !== undefined ? 0xff : 0 } : {}) };
      }
      pipeline = this.device!.createRenderPipeline(desc);
      this.metaPipelines.set(key, pipeline);
    }
    const data = new ArrayBuffer(144);
    const u32 = new Uint32Array(data), f32 = new Float32Array(data), i32 = new Int32Array(data);
    for (const [i, c] of colors) {
      const k = atts.colors[i] ? sampleKind(atts.colors[i]!) : 'f32';
      for (let n = 0; n < 4; n++) {
        if (k === 'f32') f32[i * 4 + n] = c[n];
        else if (k === 'i32') i32[i * 4 + n] = c[n];
        else u32[i * 4 + n] = c[n];
      }
    }
    f32[32] = depth ?? 0;
    const uniform = this.device!.createBuffer({ size: 144, usage: UNIFORM, mappedAtCreation: true });
    new Uint8Array(uniform.getMappedRange()).set(new Uint8Array(data));
    uniform.unmap();
    this.temps.push(uniform);
    const group = this.device!.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: uniform } }] });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.setViewport(0, 0, atts.width, atts.height, 0, 1);
    if (stencil !== undefined) pass.setStencilReference(stencil);
    for (const [x, y, w, h] of j.rects as number[][]) {
      const x0 = Math.max(0, Math.min(x, atts.width)), y0 = Math.max(0, Math.min(y, atts.height));
      const x1 = Math.max(x0, Math.min(x + w, atts.width)), y1 = Math.max(y0, Math.min(y + h, atts.height));
      if (x1 === x0 || y1 === y0) continue;
      pass.setScissorRect(x0, y0, x1 - x0, y1 - y0);
      pass.draw(3);
    }
  }
}

/** The driver's JSON, whose numbers are C's %g: NaN and infinities come as `nan` and `inf` (a clear value may be
 * either), which JSON lacks and WebGPU's colours don't take. */
function parseJson(text: string): Json {
  if (!/nan|inf/i.test(text)) return JSON.parse(text);
  // WebGPU's colours are finite doubles: NaN as 0, infinities as f32's largest.
  return JSON.parse(text.replace(/-?\bnan\b/gi, '0').replace(/(-?)\binf\b/gi, '$13.4028234663852886e38'));
}

/** A texture format's WGSL sample type. */
function sampleKind(f: string): 'f32' | 'u32' | 'i32' {
  return /uint$/.test(f) ? 'u32' : /sint$/.test(f) ? 'i32' : 'f32';
}

/** Every import, for the deviceless stubs. */
const IMPORTS = ['gpu_create', 'gpu_shader', 'gpu_destroy', 'gpu_write', 'gpu_dirty', 'gpu_encoder', 'gpu_copy_bb', 'gpu_copy_bt', 'gpu_copy_tb', 'gpu_copy_tt', 'gpu_fill',
  'gpu_update', 'gpu_blit', 'gpu_render_pass', 'gpu_compute_pass', 'gpu_pass_end', 'gpu_set_pipeline', 'gpu_set_bind_group', 'gpu_set_vertex_buffer',
  'gpu_set_index_buffer', 'gpu_set_viewport', 'gpu_set_scissor', 'gpu_set_blend_constant', 'gpu_set_stencil_reference', 'gpu_set_immediates', 'gpu_draw',
  'gpu_draw_indexed', 'gpu_draw_indirect', 'gpu_dispatch', 'gpu_dispatch_indirect', 'gpu_clear_rects', 'gpu_begin_occlusion', 'gpu_end_occlusion',
  'gpu_resolve_queries', 'gpu_readback', 'gpu_submit', 'gpu_readback_copy'];
