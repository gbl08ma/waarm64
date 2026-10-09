// What tests/virgl-browser.test.ts runs in Chromium: the shader corpus compiled on WebGL2, traces replayed.
import { generate, parseTgsi, type ProgramKey } from '../../web/virgl-tgsi.ts';

/** Compiles every fragment shader of the corpus with the vertex shader before it; returns the failures. */
export function compileCorpus(corpus: string) {
  const gl = new OffscreenCanvas(16, 16).getContext('webgl2')!;
  const shaders = corpus.split(/^=== /m).filter(Boolean).map((b) => { const nl = b.indexOf('\n'); return { name: b.slice(0, nl), text: b.slice(nl + 1) }; });
  const key: ProgramKey = { attribs: [], samplers: { vs: [], fs: [] }, cbufs: [{ type: 'f', write: [0, 1, 2, 3] }] };
  let vs = shaders.find((s) => s.text.startsWith('VERT'))!;
  const failures: { name: string; error: string; source?: string }[] = [];
  let programs = 0;
  const t0 = performance.now();
  for (const s of shaders) {
    if (s.text.startsWith('VERT')) { vs = s; continue; }
    let p;
    try { p = generate(parseTgsi(vs.text), parseTgsi(s.text), key); } catch (e) { failures.push({ name: s.name, error: String(e) }); continue; }
    const compile = (type: number, src: string) => { const sh = gl.createShader(type)!; gl.shaderSource(sh, src); gl.compileShader(sh); return sh; };
    const v = compile(gl.VERTEX_SHADER, p.vs), f = compile(gl.FRAGMENT_SHADER, p.fs);
    const prog = gl.createProgram()!;
    gl.attachShader(prog, v); gl.attachShader(prog, f); gl.linkProgram(prog);
    programs++;
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const bad = !gl.getShaderParameter(v, gl.COMPILE_STATUS) ? ['vs', gl.getShaderInfoLog(v), p.vs] : !gl.getShaderParameter(f, gl.COMPILE_STATUS) ? ['fs', gl.getShaderInfoLog(f), p.fs] : ['link', gl.getProgramInfoLog(prog), p.vs + '\n----\n' + p.fs];
      failures.push({ name: `${vs.name} + ${s.name} (${bad[0]})`, error: String(bad[1]), source: String(bad[2]) });
    }
    gl.deleteProgram(prog); gl.deleteShader(v); gl.deleteShader(f);
  }
  return { programs, failures, ms: performance.now() - t0, renderer: gl.getParameter(gl.RENDERER) as string };
}

import { VirglRenderer } from '../../web/virgl-renderer.ts';
import { localHost } from '../../web/virgl-host.ts';
import { replay } from '../../web/virgl-replay.ts';

const fromBase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
function toBase64(b: Uint8Array) {
  let s = '';
  for (let k = 0; k < b.length; k += 8192) s += String.fromCharCode(...b.subarray(k, k + 8192));
  return btoa(s);
}

/** `replayTrace` across Playwright: the trace in and the pixels out as base64 (arrays of numbers are slow and big). */
export function replayTrace64(trace: string, read?: number) {
  const r = replayTrace(fromBase64(trace), read);
  return { ...r, pixels: undefined, pixels64: r.pixels ? toBase64(Uint8Array.from(r.pixels)) : null };
}

/** Replays a trace on WebGL2 and reads back resource `read` (its RGBA as stored, rows top first; -1: the scanout's). */
export function replayTrace(trace: Uint8Array, read?: number) {
  const canvas = new OffscreenCanvas(16, 16);
  const gl = canvas.getContext('webgl2')!;
  const log: string[] = [];
  let r!: VirglRenderer;
  const t0 = performance.now();
  const res = replay(trace, (ram) => localHost((r = new VirglRenderer(gl, { ram, log: (m) => log.push(m) }))), { lastSubmit: true });
  gl.finish();
  const ms = performance.now() - t0;
  const scanout = res.gpu.state().scanout;
  if (read === -1) read = scanout?.id;
  const pixels = read ? r.readResource(read) : null;
  const fmt = read ? r.resources.get(read)?.format : undefined;
  return { stats: r.stats, log, ms, scanout, read, fmt, width: read ? r.resources.get(read)?.width : 0, height: read ? r.resources.get(read)?.height : 0, replies: [...new Set(res.replies)], pixels: pixels ? Array.from(pixels) : null, renderer: gl.getParameter(gl.RENDERER) as string, glError: gl.getError() };
}
