// What a virgl draw's GL state setting costs the browser, without the emulator (PERF loop 79; bench/gpu/REPORT.md):
// small textured quads drawn into a framebuffer of their own, each draw preceded by the calls web/virgl-renderer.ts
// makes before one (`draw`: the framebuffer's attachments and draw buffers, the program and its uniforms, the
// texture's unit, levels and sampler, the viewport, depth range, the capabilities, blend, masks, depth and stencil, all
// 16 vertex attributes), or only those of them that change the state (the vertex pointer, whose offset moves at every
// draw as in Mesa's upload buffer), or every call but one group's repeats, or the changes and one framebuffer call. Per draw: the time to issue the calls (JS:
// what the GPU worker's busy time sees) and to the GPU's end (a 1×1 readPixels after the draws). ZS=1 gives the target a
// depth-stencil texture (DEPTH24_STENCIL8, as the renderer makes a Z24S8 resource), which the framebuffer's calls attach
// after emptying the depth and stencil points (as the renderer did up to PERF loop 81), and two arms more: the changes
// and that texture detached and attached again (`zs churn`), or attached again alone (`zs again`). Prints JSON.
//   node bench/gpu/state-cost.ts [out.json]     (CHROMIUM=<binary>; DRAWS, ROUNDS, SIZE (the target's side, 512), ZS; on the Mac host through sway-mac.sh's copy)
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { chromiumEnv } from '../../tools/nosme.ts';

const DRAWS = Number(process.env.DRAWS ?? 4000);
const ROUNDS = Number(process.env.ROUNDS ?? 7);
const SIZE = Number(process.env.SIZE ?? 512);
const ZS = process.env.ZS === '1';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', headless: true, env: chromiumEnv() });
const page = await browser.newPage();
const result = await page.evaluate(
  ({ DRAWS, ROUNDS, SIZE, ZS }) => {
    const gl = new OffscreenCanvas(64, 64).getContext('webgl2')!;
    const E = WebGL2RenderingContext;
    const d = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = String(gl.getParameter(d ? d.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
    const W = SIZE;
    const target = gl.createTexture();
    gl.bindTexture(E.TEXTURE_2D, target);
    gl.texStorage2D(E.TEXTURE_2D, 1, E.RGBA8, W, W);
    const src = gl.createTexture();
    gl.bindTexture(E.TEXTURE_2D, src);
    gl.texStorage2D(E.TEXTURE_2D, 1, E.RGBA8, 64, 64);
    gl.texSubImage2D(E.TEXTURE_2D, 0, 0, 0, 64, 64, E.RGBA, E.UNSIGNED_BYTE, new Uint8Array(64 * 64 * 4).fill(200));
    const sampler = gl.createSampler()!;
    gl.samplerParameteri(sampler, E.TEXTURE_MIN_FILTER, E.LINEAR);
    gl.samplerParameteri(sampler, E.TEXTURE_MAG_FILTER, E.LINEAR);
    const fbo = gl.createFramebuffer();
    let zs: WebGLTexture | null = null;
    if (ZS) {
      zs = gl.createTexture();
      gl.bindTexture(E.TEXTURE_2D, zs);
      gl.texStorage2D(E.TEXTURE_2D, 1, E.DEPTH24_STENCIL8, W, W);
    }
    const sh = (type: number, s: string) => {
      const o = gl.createShader(type)!;
      gl.shaderSource(o, s);
      gl.compileShader(o);
      if (!gl.getShaderParameter(o, E.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o) ?? '');
      return o;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(E.VERTEX_SHADER, `#version 300 es
in vec2 p; in vec2 t; out vec2 v; uniform float u_adjy; uniform vec2 u_adjz; uniform float u_psize;
uniform highp uvec4 vc0[4];
void main() { v = t; gl_Position = vec4(p.x + uintBitsToFloat(vc0[0].x), p.y * u_adjy, u_adjz.y, 1.0); gl_PointSize = u_psize; }`));
    gl.attachShader(prog, sh(E.FRAGMENT_SHADER, `#version 300 es
precision mediump float; in vec2 v; out vec4 o; uniform sampler2D s; uniform float u_fbh; uniform highp uvec4 fc0[2];
void main() { o = texture(s, v) * uintBitsToFloat(fc0[0].x) + vec4(u_fbh * 0.0); }`));
    gl.bindAttribLocation(prog, 0, 'p');
    gl.bindAttribLocation(prog, 1, 't');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, E.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? '');
    const loc = (n: string) => gl.getUniformLocation(prog, n);
    const [lvc, lfc, ladjy, ladjz, lpsize, lfbh, ls] = ['vc0', 'fc0', 'u_adjy', 'u_adjz', 'u_psize', 'u_fbh', 's'].map(loc);
    gl.useProgram(prog);
    gl.uniform1i(ls, 0);
    // A large vertex buffer the draws walk through, as Mesa's upload buffer: each draw's quad at its own offset.
    const quads = 4096;
    const verts = new Float32Array(quads * 16);
    for (let q = 0; q < quads; q++) {
      const x = ((q % 32) / 16) - 1,
        y = (Math.floor(q / 32) % 32) / 16 - 1,
        s = 1 / 16;
      verts.set([x, y, 0, 0, x + s, y, 1, 0, x, y + s, 0, 1, x + s, y + s, 1, 1], q * 16);
    }
    const vb = gl.createBuffer();
    gl.bindBuffer(E.ARRAY_BUFFER, vb);
    gl.bufferData(E.ARRAY_BUFFER, verts, E.STATIC_DRAW);
    const vao = gl.createVertexArray();
    const vc = new Uint32Array(16);
    vc[0] = new Uint32Array(new Float32Array([0]).buffer)[0];
    const fc = new Uint32Array(8);
    fc[0] = new Uint32Array(new Float32Array([1]).buffer)[0];
    const caps = [E.SCISSOR_TEST, E.CULL_FACE, E.POLYGON_OFFSET_FILL, E.RASTERIZER_DISCARD, E.DITHER, E.SAMPLE_ALPHA_TO_COVERAGE, E.SAMPLE_COVERAGE, E.DEPTH_TEST, E.STENCIL_TEST];
    // The groups of calls a draw makes, each either always ('all') or only where it changes the state.
    type Groups = { fb: boolean; prog: boolean; tex: boolean; raster: boolean; attribs: boolean; fbPart?: 'bind' | 'color' | 'nulls' | 'buffers' | 'zs churn' | 'zs again' };
    const once = { first: true };
    const draw = (q: number, all: Groups) => {
      const first = once.first;
      if (all.fbPart && !first) {
        if (all.fbPart === 'bind') gl.bindFramebuffer(E.DRAW_FRAMEBUFFER, fbo);
        if (all.fbPart === 'color') gl.framebufferTexture2D(E.DRAW_FRAMEBUFFER, E.COLOR_ATTACHMENT0, E.TEXTURE_2D, target, 0);
        if (all.fbPart === 'nulls')
          for (let k = 1; k < 8; k++) gl.framebufferRenderbuffer(E.DRAW_FRAMEBUFFER, E.COLOR_ATTACHMENT0 + k, E.RENDERBUFFER, null);
        if (all.fbPart === 'buffers') gl.drawBuffers([E.COLOR_ATTACHMENT0]);
        if (all.fbPart === 'zs churn') gl.framebufferRenderbuffer(E.DRAW_FRAMEBUFFER, E.DEPTH_STENCIL_ATTACHMENT, E.RENDERBUFFER, null);
        if (all.fbPart === 'zs churn' || all.fbPart === 'zs again')
          gl.framebufferTexture2D(E.DRAW_FRAMEBUFFER, E.DEPTH_STENCIL_ATTACHMENT, E.TEXTURE_2D, zs, 0);
      }
      if (all.fb || first) {
        gl.bindFramebuffer(E.DRAW_FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(E.DRAW_FRAMEBUFFER, E.COLOR_ATTACHMENT0, E.TEXTURE_2D, target, 0);
        for (let k = 1; k < 8; k++) gl.framebufferRenderbuffer(E.DRAW_FRAMEBUFFER, E.COLOR_ATTACHMENT0 + k, E.RENDERBUFFER, null);
        for (const p of [E.DEPTH_STENCIL_ATTACHMENT, E.DEPTH_ATTACHMENT, E.STENCIL_ATTACHMENT]) gl.framebufferRenderbuffer(E.DRAW_FRAMEBUFFER, p, E.RENDERBUFFER, null);
        if (zs) gl.framebufferTexture2D(E.DRAW_FRAMEBUFFER, E.DEPTH_STENCIL_ATTACHMENT, E.TEXTURE_2D, zs, 0);
        gl.drawBuffers([E.COLOR_ATTACHMENT0]);
      }
      if (all.prog || first) {
        gl.useProgram(prog);
        gl.uniform4uiv(lvc, vc, 0, 16);
        gl.uniform4uiv(lfc, fc, 0, 8);
        gl.uniform1f(ladjy, 1);
        gl.uniform2f(ladjz, 1, 0);
        gl.uniform1f(lfbh, W);
        gl.uniform1f(lpsize, 1);
      }
      if (all.tex || first) {
        gl.activeTexture(E.TEXTURE0);
        gl.bindTexture(E.TEXTURE_2D, src);
        gl.texParameteri(E.TEXTURE_2D, E.TEXTURE_BASE_LEVEL, 0);
        gl.texParameteri(E.TEXTURE_2D, E.TEXTURE_MAX_LEVEL, 0);
        gl.bindSampler(0, sampler);
      }
      if (all.raster || first) {
        gl.viewport(0, 0, W, W);
        gl.depthRange(0, 1);
        for (const c of caps) gl.disable(c);
        gl.frontFace(E.CCW);
        gl.enable(E.BLEND);
        gl.blendFuncSeparate(E.ONE, E.ONE_MINUS_SRC_ALPHA, E.ONE, E.ONE_MINUS_SRC_ALPHA);
        gl.blendEquationSeparate(E.FUNC_ADD, E.FUNC_ADD);
        gl.colorMask(true, true, true, true);
        gl.depthMask(false);
      }
      gl.bindVertexArray(vao);
      if (all.attribs || first) {
        for (let k = 2; k < 16; k++) gl.disableVertexAttribArray(k);
        for (const k of [0, 1]) {
          gl.enableVertexAttribArray(k);
          gl.bindBuffer(E.ARRAY_BUFFER, vb);
          gl.vertexAttribPointer(k, 2, E.FLOAT, false, 16, q * 64 + k * 8);
          gl.vertexAttribDivisor(k, 0);
        }
      } else {
        gl.bindBuffer(E.ARRAY_BUFFER, vb);
        for (const k of [0, 1]) gl.vertexAttribPointer(k, 2, E.FLOAT, false, 16, q * 64 + k * 8);
      }
      gl.drawArrays(E.TRIANGLE_STRIP, 0, 4);
      gl.bindVertexArray(null);
      once.first = false;
    };
    const px = new Uint8Array(4);
    const sync = () => {
      gl.bindFramebuffer(E.READ_FRAMEBUFFER, fbo);
      gl.readPixels(0, 0, 1, 1, E.RGBA, E.UNSIGNED_BYTE, px);
    };
    const T = true,
      F = false;
    const arms: Record<string, Groups> = {
      all: { fb: T, prog: T, tex: T, raster: T, attribs: T },
      changed: { fb: F, prog: F, tex: F, raster: F, attribs: F },
      'all but fb': { fb: F, prog: T, tex: T, raster: T, attribs: T },
      'all but attribs': { fb: T, prog: T, tex: T, raster: T, attribs: F },
      'all but raster': { fb: T, prog: T, tex: T, raster: F, attribs: T },
      'all but prog': { fb: T, prog: F, tex: T, raster: T, attribs: T },
      'all but tex': { fb: T, prog: T, tex: F, raster: T, attribs: T },
      'changed + attribs': { fb: F, prog: F, tex: F, raster: F, attribs: T },
      'changed + raster': { fb: F, prog: F, tex: F, raster: T, attribs: F },
      'changed + prog': { fb: F, prog: T, tex: F, raster: F, attribs: F },
      'changed + tex': { fb: F, prog: F, tex: T, raster: F, attribs: F },
      'changed + fb bind': { fb: F, prog: F, tex: F, raster: F, attribs: F, fbPart: 'bind' },
      'changed + fb color': { fb: F, prog: F, tex: F, raster: F, attribs: F, fbPart: 'color' },
      'changed + fb nulls': { fb: F, prog: F, tex: F, raster: F, attribs: F, fbPart: 'nulls' },
      'changed + drawBuffers': { fb: F, prog: F, tex: F, raster: F, attribs: F, fbPart: 'buffers' },
      ...(ZS
        ? {
            'changed + zs churn': { fb: F, prog: F, tex: F, raster: F, attribs: F, fbPart: 'zs churn' as const },
            'changed + zs again': { fb: F, prog: F, tex: F, raster: F, attribs: F, fbPart: 'zs again' as const },
          }
        : {}),
    };
    const res: Record<string, { jsUs: number[]; endUs: number[] }> = {};
    for (const n of Object.keys(arms)) res[n] = { jsUs: [], endUs: [] };
    // A warm-up of every arm, then rounds, each arm once a round in a rotating order.
    const names = Object.keys(arms);
    for (let r = -1; r < ROUNDS; r++) {
      for (let k = 0; k < names.length; k++) {
        const n = names[(k + Math.max(r, 0)) % names.length];
        once.first = true;
        sync();
        const t0 = performance.now();
        for (let i = 0; i < DRAWS; i++) draw(i % quads, arms[n]);
        const t1 = performance.now();
        sync();
        const t2 = performance.now();
        if (r >= 0) {
          res[n].jsUs.push(((t1 - t0) * 1000) / DRAWS);
          res[n].endUs.push(((t2 - t0) * 1000) / DRAWS);
        }
      }
    }
    const med = (a: number[]) => {
      const s = a.slice().sort((x, y) => x - y);
      return s[s.length >> 1];
    };
    return {
      renderer,
      draws: DRAWS,
      size: SIZE,
      zs: ZS,
      rounds: ROUNDS,
      arms: Object.fromEntries(Object.entries(res).map(([n, v]) => [n, { jsUs: +med(v.jsUs).toFixed(2), endUs: +med(v.endUs).toFixed(2), jsAll: v.jsUs.map((x) => +x.toFixed(2)), endAll: v.endUs.map((x) => +x.toFixed(2)) }])),
    };
  },
  { DRAWS, ROUNDS, SIZE, ZS },
);
const out = { chromium: browser.version(), ...result };
await browser.close();
const json = JSON.stringify(out, null, 1);
if (process.argv[2]) writeFileSync(process.argv[2], json + '\n');
console.log(json);
