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

/**
 * Stream output on WebGL2, from a stream made here: a vertex shader whose position and a generic's .yz (doubled) are
 * captured, interleaved into one buffer or each into its own, or mixed (two outputs in one buffer with gaps, which
 * keep their bytes); draws appended, rebound, overflowing; the emitted primitives counted by a query. Nothing to draw on (no color buffer): only captures. Returns the buffers' floats.
 */
export function streamOut() {
  const gl = new OffscreenCanvas(16, 16).getContext('webgl2')!;
  const ram = new Uint8Array(4096);
  const log: string[] = [];
  const r = new VirglRenderer(gl, { ram: () => ram, log: (m) => log.push(m) });
  r.createContext(1);
  const buffer = (id: number, width: number, bind: number) => { r.createResource({ id, target: 0, format: 64, bind, width, height: 1, depth: 1, arraySize: 1, lastLevel: 0, samples: 0, flags: 0 }); r.attach(1, id); };
  buffer(1, 48 * 4, 0x10); // vertices: 12 vec4s
  buffer(2, 60 * 4, 0x800); // interleaved: 10 vertices of 6 floats
  buffer(3, 64, 0x800); buffer(4, 64, 0x800); // separate: 4 vec4s, 8 vec2s
  buffer(5, 64, 0x800); r.attachBacking(5, [{ off: 0, len: 64 }]); // the query's result
  buffer(6, 64, 0x800); buffer(7, 80, 0x800); // mixed: 4 vec4s; 4 vertices of 5 floats (gaps at 0 and 4)
  const words: number[] = [];
  const cmd = (c: number, obj: number, ...p: number[]) => words.push(c | obj << 8 | p.length << 16, ...p);
  const text = (s: string) => { const b = new TextEncoder().encode(s + '\0'); const w = new Uint32Array(Math.ceil(b.length / 4)); new Uint8Array(w.buffer).set(b); return [b.length, ...w]; };
  const f = (v: number) => new Uint32Array(new Float32Array([v]).buffer)[0];
  const VS = 'VERT\nDCL IN[0]\nDCL OUT[0], POSITION\nDCL OUT[1], GENERIC[0]\nIMM[0] FLT32 {2.0, 0.0, 0.0, 0.0}\n  0: MOV OUT[0], IN[0]\n  1: MUL OUT[1], IN[0], IMM[0].xxxx\n  2: END\n';
  const FS = 'FRAG\nDCL OUT[0], COLOR\nIMM[0] FLT32 {1.0, 0.0, 0.0, 1.0}\n  0: MOV OUT[0], IMM[0]\n  1: END\n';
  const so = (reg: number, start: number, comps: number, buf: number, off: number) => [reg | start << 8 | comps << 10 | buf << 13 | off << 16, 0];
  const shader = (h: number, type: number, src: string, nso = 0, extra: number[] = []) => { const [len, ...t] = text(src); cmd(1, 4, h, type, len, 0, nso, ...extra, ...t); };
  // Vertices 0..11: (4k+1, 4k+2, 4k+3, 4k+4).
  cmd(9, 0, 1, 0, 0, 0, 0, 0, 0, 0, 48 * 4, 1, 1, ...Array.from({ length: 48 }, (_, k) => f(k + 1)));
  shader(10, 0, VS, 2, [6, 0, 0, 0, ...so(0, 0, 4, 0, 0), ...so(1, 1, 2, 0, 4)]); // interleaved, stride 6
  shader(11, 0, VS, 2, [4, 2, 0, 0, ...so(0, 0, 4, 0, 0), ...so(1, 1, 2, 1, 0)]); // separate
  shader(13, 0, VS, 3, [4, 5, 0, 0, ...so(0, 0, 4, 0, 0), ...so(1, 1, 2, 1, 1), ...so(1, 3, 1, 1, 3)]); // mixed
  shader(12, 1, FS);
  cmd(1, 5, 20, 0, 0, 0, 31); // vertex elements: one R32G32B32A32_FLOAT from buffer 0
  cmd(2, 5, 20);
  cmd(1, 2, 21, 1 << 1, f(1), 0, 0, f(1), 0, 0, 0); // a rasterizer (not discarding: nothing to draw on does it)
  cmd(2, 2, 21);
  cmd(5, 0, 0, 0); // no color buffer, no depth
  cmd(6, 0, 16, 0, 1);
  cmd(31, 0, 12, 1);
  cmd(1, 10, 30, 2, 0, 60 * 4); cmd(1, 10, 35, 2, 0, 60 * 4); cmd(1, 10, 31, 3, 0, 64); cmd(1, 10, 32, 4, 0, 64); cmd(1, 10, 33, 6, 0, 64); cmd(1, 10, 34, 7, 0, 80);
  cmd(9, 0, 7, 0, 0, 0, 0, 0, 0, 0, 80, 1, 1, ...Array.from({ length: 20 }, () => f(-1))); // the gaps' bytes
  cmd(1, 9, 40, 6, 0, 5); // VIRGL_QUERY_PRIMITIVES_EMITTED (6: virgl's numbering), its result in resource 5
  const draw = (start: number, count: number, mode = 0) => cmd(8, 0, start, count, mode, 0, 1, 0, 0, 0, 0, 0, 0, 0);
  // Interleaved: 3 points, 2 more appended (the same target set again: a resume), then a triangle; then a new target
  // on the same buffer (as Mesa makes at a new Begin) starts over, and 12 points overflow it at 10.
  cmd(31, 0, 10, 0);
  cmd(19, 0, 40);
  cmd(25, 0, 0, 30); draw(0, 3);
  cmd(25, 0, 0, 30); draw(3, 2); draw(5, 3, 4); // the append mask Mesa sends: 0
  cmd(25, 0); draw(0, 2); // paused (no targets): generated, not emitted
  cmd(20, 0, 40);
  const first = () => Array.from(new Float32Array(r.readResource(2)!.slice().buffer));
  r.submit(1, new Uint32Array(words)); words.length = 0;
  const appended = first();
  const emitted = new DataView(ram.buffer).getUint32(8, true);
  cmd(25, 0, 0, 35); draw(0, 12);
  r.submit(1, new Uint32Array(words)); words.length = 0;
  const overflowed = first();
  // Separate: 2 points, position into buffer 3 and the generic's .yz into buffer 4.
  cmd(31, 0, 11, 0);
  cmd(25, 0, 0, 31, 32); draw(1, 2);
  // Mixed: 2 points, position into buffer 6, the generic's .yz and .w into buffer 7 at words 1 and 3 of 5.
  cmd(31, 0, 13, 0);
  cmd(25, 0, 0, 33, 34); draw(1, 2);
  r.submit(1, new Uint32Array(words));
  const floats = (id: number) => Array.from(new Float32Array(r.readResource(id)!.slice().buffer));
  return { appended, emitted, overflowed, separate: [floats(3), floats(4)], mixed: [floats(6), floats(7)], log, glError: gl.getError() };
}
