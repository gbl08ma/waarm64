// VK2 L4's candidates for sharing a WebGPU texture with WebGL2 (bench/vulkan/share.ts; vk/README.md "Presentation"),
// in a worker as the GPU worker has them: a WebGPU texture an "app" draws into each frame (a Venus WSI image), copied
// into a WebGL2 texture holding its bytes in memory order (the virgl renderer's B8G8R8A8: an RGBA8 texture whose R is
// B), which a "compositor" draw then samples onto the WebGL2 canvas. Per arm and round: N frames timed from the first
// to a readPixels after the last (ms a frame), and the refresh's own time on the thread. Arms:
//   canvas    a draw into a WebGPU canvas context's texture (bytes swizzled to memory order), texSubImage2D from the canvas
//   bitmap    the same draw, then the canvas's transferToImageBitmap, texSubImage2D from the bitmap
//   none      no refresh (the frame's other work, to subtract)
//   readback  copyTextureToBuffer, mapAsync awaited, texSubImage2D from the bytes (the CPU path)
// Each arm first checks its bytes: a pattern (with alpha 128 and 0 among it) read back from the WebGL2 texture.
export type ShareRequest = { width: number; height: number; frames: number; rounds: number; arms: string[]; /** The app's image: bgra8unorm (default) or rgba16float (vkcube's choice on Mesa's WSI). */ format?: 'bgra8unorm' | 'rgba16float' };
export type ShareResult = { adapter: string; gl: string; checks: Record<string, string>; rounds: Record<string, { msPerFrame: number; refreshMs: number }[]>; error?: string };

const WGSL = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  return vec4f(f32(i & 1u) * 4.0 - 1.0, f32(i >> 1u) * 4.0 - 1.0, 0.0, 1.0);
}
@fragment fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f {
  return textureLoad(src, vec2u(p.xy), 0).SWIZZLE;
}`;

self.onmessage = async (e: MessageEvent<ShareRequest>) => {
  const { width: w, height: h, frames, rounds, arms } = e.data;
  const float = e.data.format === 'rgba16float';
  const out: ShareResult = { adapter: '', gl: '', checks: {}, rounds: {} };
  const errorsSeen: string[] = [];
  try {
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) throw new Error('no WebGPU adapter');
    out.adapter = `${adapter.info.vendor} ${adapter.info.architecture} ${adapter.info.description}`.trim();
    const device = await adapter.requestDevice();
    const errors = errorsSeen;
    device.addEventListener('uncapturederror', (ev) => errors.push((ev as GPUUncapturedErrorEvent).error.message));
    device.lost.then((info) => errors.push(`device lost: ${info.reason} ${info.message}`));
    const glCanvas = new OffscreenCanvas(w, h);
    const gl = glCanvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, premultipliedAlpha: false })!;
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    out.gl = String(gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER));

    // The app's image (a Venus WSI image: bgra8unorm) and the compositor's texture of the same bytes.
    const src = device.createTexture({ size: [w, h], format: float ? 'rgba16float' : 'bgra8unorm', usage: 16 | 4 | 1 | 2 });
    const srcView = src.createView();
    const dst = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, dst);
    gl.texStorage2D(gl.TEXTURE_2D, 1, float ? gl.RGBA16F : gl.RGBA8, w, h);
    const type = float ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;
    const fbo = gl.createFramebuffer();

    // The swizzling draw, into a canvas context's texture.
    const module = device.createShaderModule({ code: WGSL.replace('SWIZZLE', float ? 'rgba' : 'bgra') });
    const pipeline = device.createRenderPipeline({ layout: 'auto', vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: 'fs', targets: [{ format: 'bgra8unorm' }] }, primitive: { topology: 'triangle-list' } });
    const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: srcView }] });
    const sc = new OffscreenCanvas(w, h);
    const ctx = sc.getContext('webgpu') as GPUCanvasContext;
    ctx.configure({ device, format: 'bgra8unorm', alphaMode: 'premultiplied', usage: 16 });
    const drawToCanvas = () => {
      const enc = device.createCommandEncoder();
      const pass = enc.beginRenderPass({ colorAttachments: [{ view: ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.draw(3);
      pass.end();
      device.queue.submit([enc.finish()]);
    };
    const bpp = float ? 8 : 4;
    const bpr = Math.ceil(w * bpp / 256) * 256;
    const staging = device.createBuffer({ size: bpr * h, usage: 1 | 8 });
    const unpack = (fn: () => void) => {
      gl.bindTexture(gl.TEXTURE_2D, dst);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      fn();
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.BROWSER_DEFAULT_WEBGL);
    };
    const refresh: Record<string, () => Promise<void> | void> = {
      none: () => {},
      canvas: () => { drawToCanvas(); unpack(() => gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, type, sc)); },
      bitmap: () => {
        drawToCanvas();
        const bmp = sc.transferToImageBitmap();
        unpack(() => gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, type, bmp));
        bmp.close();
      },
      readback: async () => {
        const enc = device.createCommandEncoder();
        enc.copyTextureToBuffer({ texture: src }, { buffer: staging, bytesPerRow: bpr }, [w, h]);
        device.queue.submit([enc.finish()]);
        await staging.mapAsync(1);
        const bytes = float ? new Uint16Array(staging.getMappedRange()) : new Uint8Array(staging.getMappedRange());
        gl.bindTexture(gl.TEXTURE_2D, dst);
        gl.pixelStorei(gl.UNPACK_ROW_LENGTH, bpr / bpp);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, type, bytes);
        gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
        staging.unmap();
      },
    };

    // The check: a pattern in memory order, read back from the WebGL2 texture.
    const pattern = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const k = (y * w + x) * 4;
      pattern.set([x & 255, y & 255, (x * 7 + y * 3) & 255, x % 3 === 0 ? 128 : x % 3 === 1 ? 255 : 0], k);
    }
    const check = async (arm: string) => {
      device.queue.writeTexture({ texture: src }, pattern, { bytesPerRow: w * 4 }, [w, h]);
      await refresh[arm]();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, dst, 0);
      const got = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, got);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      let bad = 0, first = '';
      for (let k = 0; k < got.length; k++) {
        if (got[k] !== pattern[k]) {
          // Alpha 0's colour may be lost (premultiplied: it should be 0); count only where alpha isn't 0.
          if (pattern[(k & ~3) + 3] === 0) continue;
          if (!bad) first = `pixel ${(k >> 2) % w},${Math.floor((k >> 2) / w)}: ${[...got.subarray(k & ~3, (k & ~3) + 4)]} for ${[...pattern.subarray(k & ~3, (k & ~3) + 4)]}`;
          bad++;
        }
      }
      const zeroAlpha = [...got.subarray(8, 12)];
      return bad ? `${bad} bytes differ (${first})` : `ok (alpha 0's pixel: ${zeroAlpha})`;
    };

    // The compositor's draw: the texture onto the canvas.
    const vs = gl.createShader(gl.VERTEX_SHADER)!, fs = gl.createShader(gl.FRAGMENT_SHADER)!;
    gl.shaderSource(vs, '#version 300 es\nvoid main() { gl_Position = vec4(float(gl_VertexID & 1) * 4.0 - 1.0, float(gl_VertexID >> 1) * 4.0 - 1.0, 0.0, 1.0); }');
    gl.shaderSource(fs, '#version 300 es\nprecision mediump float; uniform sampler2D t; out vec4 o; void main() { o = texelFetch(t, ivec2(gl_FragCoord.xy), 0).bgra; }');
    gl.compileShader(vs);
    gl.compileShader(fs);
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    const appFrame = (i: number) => {
      const enc = device.createCommandEncoder();
      enc.beginRenderPass({ colorAttachments: [{ view: srcView, loadOp: 'clear', storeOp: 'store', clearValue: [(i % 60) / 60, 0.5, 1 - (i % 60) / 60, 1] }] }).end();
      device.queue.submit([enc.finish()]);
    };
    const composite = () => {
      gl.useProgram(prog);
      gl.bindTexture(gl.TEXTURE_2D, dst);
      gl.viewport(0, 0, w, h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    const px = new Uint8Array(4);
    for (const arm of arms) {
      if (arm !== 'none' && !float) out.checks[arm] = await check(arm);
      out.rounds[arm] = [];
    }
    for (let r = 0; r < rounds; r++) {
      for (const arm of arms) {
        // A warm-up frame, then the timed ones.
        appFrame(0);
        await refresh[arm]();
        composite();
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        await device.queue.onSubmittedWorkDone();
        let refreshMs = 0;
        const t0 = performance.now();
        for (let i = 1; i <= frames; i++) {
          appFrame(i);
          const r0 = performance.now();
          await refresh[arm]();
          refreshMs += performance.now() - r0;
          composite();
        }
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        out.rounds[arm].push({ msPerFrame: (performance.now() - t0) / frames, refreshMs: refreshMs / frames });
      }
    }
    if (errors.length) out.error = `WebGPU: ${errors.slice(0, 3).join(' | ')}`;
  } catch (err) {
    out.error = String(err instanceof Error ? err.stack : err) + (errorsSeen.length ? ` (${errorsSeen.join(' | ')})` : '');
  }
  (self as unknown as Worker).postMessage(out);
};
