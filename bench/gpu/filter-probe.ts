// Which filter a browser's WebGL2 applies at a given level of detail (graphics.md §23: dEQP on the Mac's GPU), without
// the emulator: a 2×1 RGBA8 texture (texels 0 and 255, no mipmaps) sampled at u = 0.5, where NEAREST gives 255 and
// LINEAR 127 or 128, with the minifying and magnifying filters set apart (NEAREST/LINEAR and LINEAR/NEAREST), from a
// vertex shader (`texture`, implicit level 0; `textureLod`) and from a fragment shader at explicit levels around 0.
// GLES 3.0 §3.8.10: at λ ≤ c (c = 0 for these filters) the magnifying filter applies. Prints JSON.
//   node bench/gpu/filter-probe.ts [out.json]     (CHROMIUM=<binary>; on the Mac host through its copy, as sway-mac.sh)
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { chromiumEnv } from '../../tools/nosme.ts';

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', headless: true, env: chromiumEnv() });
const page = await browser.newPage();
const result = await page.evaluate(() => {
  const gl = new OffscreenCanvas(1, 1).getContext('webgl2')!;
  const d = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = String(gl.getParameter(d ? d.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 2, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255]));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, 0);
  const program = (vs: string, fs: string) => {
    const p = gl.createProgram()!;
    for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]] as const) {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, `#version 300 es\nprecision highp float;\nuniform highp sampler2D t;\nuniform float lod;\n${src}`);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? '');
      gl.attachShader(p, s);
    }
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? '');
    return p;
  };
  const point = 'gl_Position = vec4(0.0, 0.0, 0.0, 1.0); gl_PointSize = 1.0;';
  const shaders: Record<string, [string, string]> = {
    'vs texture': [`out vec4 c; void main() { c = texture(t, vec2(0.5)); ${point} }`, 'in vec4 c; out vec4 o; void main() { o = c; }'],
    'vs textureLod': [`out vec4 c; void main() { c = textureLod(t, vec2(0.5), lod); ${point} }`, 'in vec4 c; out vec4 o; void main() { o = c; }'],
    'fs textureLod': [`void main() { ${point} }`, 'out vec4 o; void main() { o = textureLod(t, vec2(0.5), lod); }'],
  };
  const fb = gl.createFramebuffer();
  const rb = gl.createRenderbuffer();
  gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
  gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, 1, 1);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, rb);
  gl.viewport(0, 0, 1, 1);
  const rows: { shader: string; min: string; mag: string; lod: number; value: number; filter: string; expected: string }[] = [];
  const px = new Uint8Array(4);
  for (const [name, [vs, fs]] of Object.entries(shaders)) {
    const p = program(vs, fs);
    gl.useProgram(p);
    for (const [min, mag] of [['NEAREST', 'LINEAR'], ['LINEAR', 'NEAREST']] as const) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl[min]);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl[mag]);
      for (const lod of name === 'vs texture' ? [0] : [-0.5, -0.01, 0, 0.004, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5]) {
        gl.uniform1f(gl.getUniformLocation(p, 'lod'), lod);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.POINTS, 0, 1);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        const filter = px[0] > 200 ? 'NEAREST' : px[0] > 100 ? 'LINEAR' : '?';
        rows.push({ shader: name, min, mag, lod, value: px[0], filter, expected: lod <= 0 ? mag : min });
      }
    }
  }
  return { renderer, rows, wrong: rows.filter((r) => r.filter !== r.expected).length };
});
result.rows.forEach((r) => console.log(`${r.shader.padEnd(13)} min ${r.min.padEnd(7)} mag ${r.mag.padEnd(7)} lod ${String(r.lod).padStart(5)}: ${r.value} (${r.filter}${r.filter === r.expected ? '' : `, GLES: ${r.expected}`})`));
console.log(result.renderer, '|', browser.version(), '|', result.wrong, 'wrong');
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify({ chromium: browser.version(), ...result }, null, 1) + '\n');
await browser.close();
