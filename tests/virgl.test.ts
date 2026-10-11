// The virgl renderer in Node (docs/testing.md "virgl"): the TGSI translator over the corpus (tests/virgl/tgsi-corpus.txt:
// the oracle's glmark2 shaders and the guests' own), the traces the device captured from guests (glcomp on
// alpine-virgl, sway on Arch: tests/virgl/*.vglt) replayed through the device into the renderer on a recording
// WebGL2, the device's fences, and the caps made from a browser's parameters. Pixels are
// tests/virgl-browser.test.ts's (Chromium's WebGL2).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { E } from '../web/gl-enums.ts';
import { Gpu, gpuBackend } from '../web/gpu.ts';
import { decodeCaps, virglCaps } from '../web/virgl.ts';
import { capsBacked, capsFromGl } from '../web/virgl-caps.ts';
import { FORMATS } from '../web/virgl-formats.ts';
import { FenceGate, localHost, type HostCall, type VirglHost } from '../web/virgl-host.ts';
import { VirglRenderer, readbackOf, toHalf } from '../web/virgl-renderer.ts';
import { replay } from '../web/virgl-replay.ts';
import { generate, parseTgsi, TgsiError, type ProgramKey } from '../web/virgl-tgsi.ts';
import { encodeRecord, encodeTrace, readTrace } from '../web/virgl-trace.ts';
import { mockGl } from './virgl-mock-gl.ts';

const fixture = (name: string) => {
  const b = readFileSync(new URL(`virgl/${name}`, import.meta.url));
  return new Uint8Array(name.endsWith('.gz') ? gunzipSync(b) : b);
};
const corpus = () => readFileSync(new URL('virgl/tgsi-corpus.txt', import.meta.url), 'utf8').split(/^=== /m).filter(Boolean).map((b) => {
  const nl = b.indexOf('\n');
  return { name: b.slice(0, nl), text: b.slice(nl + 1) };
});
const KEY: ProgramKey = { attribs: [], samplers: { vs: [], fs: [] }, cbufs: [{ type: 'f', write: [0, 1, 2, 3] }] };

test('virgl tgsi: every corpus shader parses, and every fragment shader makes a program with a vertex shader', () => {
  const shaders = corpus();
  assert.ok(shaders.length >= 60, `${shaders.length} shaders`);
  let vs = shaders.find((s) => s.text.startsWith('VERT'))!;
  let programs = 0;
  for (const s of shaders) {
    const t = parseTgsi(s.text);
    assert.ok(t.instrs.length > 0, s.name);
    if (t.stage === 'VERT') { vs = s; continue; }
    const p = generate(parseTgsi(vs.text), t, KEY);
    assert.match(p.vs, /^#version 300 es/);
    assert.match(p.fs, /layout\(location = 0\) out vec4 o0;/, s.name);
    programs++;
  }
  assert.ok(programs >= 35);
});

test('virgl tgsi: registers, immediates, swizzles and writes', () => {
  const vs = parseTgsi(`VERT
DCL IN[0]
DCL OUT[0], POSITION
DCL OUT[1].xy, GENERIC[0]
DCL CONST[0..1]
DCL TEMP[0]
IMM[0] UINT32 {0, 1065353216, 3, 4294967295}
  0: MUL TEMP[0].xy, IN[0].xyyy, CONST[0].zwyy
  1: ADD OUT[0].xy, CONST[0].xyxx, TEMP[0].xyxx
  2: MOV OUT[0].zw, IMM[0].xxxy
  3: MOV OUT[1].xy, IN[0].xyxx
  4: END`);
  const fs = parseTgsi(`FRAG
DCL IN[0].xy, GENERIC[0], PERSPECTIVE
DCL OUT[0], COLOR
DCL SAMP[0]
DCL SVIEW[0], 2D, FLOAT
DCL TEMP[0..1]
IMM[0] UINT32 {1065353216, 3, 0, 0}
  0: TEX TEMP[0], IN[0].xyyy, SAMP[0], 2D
  1: USEQ TEMP[1].x, IMM[0].yyyy, IMM[0].yyyy
  2: UIF TEMP[1].xxxx
  3:   MOV OUT[0], TEMP[0]
  4: ELSE
  5:   MOV OUT[0], IMM[0].xxxx
  6: ENDIF
  7: END`);
  // A BGRX texture (stored as its bytes: B in .x) and a BGRX render target, its layout from the format table.
  const bgrx = FORMATS.get(2)!;
  assert.equal(bgrx.name, 'B8G8R8X8_UNORM');
  const key: ProgramKey = { attribs: ['f'], samplers: { vs: [], fs: [{ type: 'f', swizzle: [2, 1, 0, 5], gl: '2D' }] }, cbufs: [{ type: 'f', write: [...bgrx.write!] }] };
  const p = generate(vs, fs, key);
  assert.match(p.vs, /uniform uvec4 vc0\[2\];/);
  assert.match(p.vs, /gl_Position.zw = vec2\(\(vec4\(0.0, 0.0, 0.0, 1.0\)\).zw\);/, 'float immediates as literals');
  assert.match(p.vs, /smooth out vec4 v_GENERIC0;/);
  assert.match(p.vs, /gl_Position.y \*= u_adjy;/);
  assert.match(p.fs, /uniform highp sampler2D fs0;/);
  assert.match(p.fs, /vec4\(tx0.z, tx0.y, tx0.x, 1.0\)/, 'the sampler swizzle');
  assert.match(p.fs, /if \(uvec4\(3u, 3u, 3u, 3u\).x != 0u\) \{|if \(floatBitsToUint\(t1.xxxx\).x != 0u\) \{/);
  // The X byte gets the fragment's alpha (blending reads it: a constant 1 made translucent edges opaque).
  assert.match(p.fs, /o0 = vec4\(col0.z, col0.y, col0.x, col0.w\);/, 'the render target\'s stored order, alpha in the X byte');
  assert.deepEqual(p.attribs, [0]);
  assert.deepEqual(p.samplers.fs, [0]);
});

test('virgl tgsi: integers keep their bits (flat varyings as integers), the fragment coordinate stays upper-left (Mesa flips it), an alpha test discards', () => {
  const vs = parseTgsi('VERT\nDCL IN[0]\nDCL OUT[0], POSITION\n  0: MOV OUT[0], IN[0]\n  1: END');
  const fs = parseTgsi(`FRAG
PROPERTY FS_COORD_ORIGIN LOWER_LEFT
PROPERTY FS_COORD_PIXEL_CENTER INTEGER
DCL IN[0], POSITION, LINEAR
DCL OUT[0], COLOR
DCL TEMP[0]
IMM[0] UINT32 {3, 7, 0, 0}
  0: UADD TEMP[0].x, IMM[0].xxxx, IMM[0].yyyy
  1: U2F TEMP[0].y, TEMP[0].xxxx
  2: MOV OUT[0], IN[0]
  3: END`);
  const p = generate(vs, fs, { ...KEY, alphaFunc: 1 });
  assert.match(p.fs, /uintBitsToFloat\(uvec4\(3u, 3u, 3u, 3u\) \+ uvec4\(7u, 7u, 7u, 7u\)\)|uintBitsToFloat\(\(uvec4\(3u, 3u, 3u, 3u\) \+ uvec4\(7u, 7u, 7u, 7u\)\)/);
  assert.match(p.fs, /vec4\(floatBitsToUint\(t0.xxxx\)\)/);
  assert.match(p.fs, /vec4\(gl_FragCoord.x - 0.5, gl_FragCoord.y - 0.5,/);
  assert.match(p.fs, /if \(!\(col0.w < u_alpharef\)\) discard;/);
  // A flat varying carries integers between the stages (a float varying may flush or canonicalize their bits).
  const fv = generate(parseTgsi('VERT\nDCL IN[0]\nDCL OUT[0], POSITION\nDCL OUT[1], GENERIC[0]\n  0: MOV OUT[0], IN[0]\n  1: MOV OUT[1], IN[0]\n  2: END'),
    parseTgsi('FRAG\nDCL IN[0], GENERIC[0], CONSTANT\nDCL OUT[0], COLOR\n  0: MOV OUT[0], IN[0]\n  1: END'), { ...KEY, attribs: ['i'] });
  assert.ok(fv.vs.includes('flat out highp ivec4 vf_GENERIC0;') && fv.vs.includes('vf_GENERIC0 = floatBitsToInt(v_GENERIC0);'), fv.vs);
  assert.ok(fv.fs.includes('flat in highp ivec4 vf_GENERIC0;') && fv.fs.includes('v_GENERIC0 = intBitsToFloat(vf_GENERIC0);'), fv.fs);
  // Small integers as float immediates stay bits (a float literal would be a denormal, flushed on some GPUs).
  const mv = parseTgsi('VERT\nDCL OUT[0], POSITION\nDCL TEMP[0]\nIMM[0] UINT32 {1, 2, 0, 1065353216}\n  0: MOV TEMP[0], IMM[0]\n  1: MOV OUT[0], TEMP[0]\n  2: END');
  assert.match(generate(mv, parseTgsi('FRAG\nDCL OUT[0], COLOR\n  0: END'), KEY).vs, /uintBitsToFloat\(1u\)/);
});

test('virgl tgsi: a vertex shader that writes the point size declares it once (dEQP-GLES2 points)', () => {
  const vs = parseTgsi('VERT\nDCL IN[0]\nDCL OUT[0], POSITION\nDCL OUT[1], PSIZE\nIMM[0] FLT32 {4.0, 0.0, 0.0, 0.0}\n  0: MOV OUT[0], IN[0]\n  1: MOV OUT[1].x, IMM[0].xxxx\n  2: END');
  const fs = parseTgsi('FRAG\nDCL OUT[0], COLOR\nIMM[0] FLT32 {1.0, 0.0, 0.0, 1.0}\n  0: MOV OUT[0], IMM[0]\n  1: END');
  for (const points of [false, true]) {
    const p = generate(vs, fs, { ...KEY, attribs: ['f'], points });
    assert.equal(p.vs.match(/vec4 o_psize\b/g)?.length, 1, p.vs);
    if (points) assert.match(p.vs, /gl_PointSize = o_psize.x;/);
  }
});

test('virgl tgsi: a constant blend factor WebGL can\'t pair is applied in the shader; a target without alpha gets the source alpha; z flips for an inverted depth range (dEQP blend, depth_range)', () => {
  const vs = parseTgsi('VERT\nDCL IN[0]\nDCL OUT[0], POSITION\n  0: MOV OUT[0], IN[0]\n  1: END');
  const fs = parseTgsi('FRAG\nDCL OUT[0], COLOR\nIMM[0] FLT32 {1.0, 0.5, 0.25, 1.0}\n  0: MOV OUT[0], IMM[0]\n  1: END');
  const plain = generate(vs, fs, { ...KEY, attribs: ['f'] });
  assert.ok(!plain.fs.includes('u_blendc'));
  assert.ok(plain.vs.includes('gl_Position.z *= u_adjz;'));
  for (const [f, e] of [[7, 'u_blendc.rgb'], [0x17, '(1.0 - u_blendc.rgb)'], [8, 'vec3(u_blendc.a)'], [0x18, 'vec3(1.0 - u_blendc.a)']] as const) {
    const p = generate(vs, fs, { ...KEY, attribs: ['f'], blendSrc: f });
    assert.ok(p.fs.includes('uniform vec4 u_blendc;'), p.fs);
    assert.ok(p.fs.includes(`vec4(col0.rgb * ${e}, col0.a)`), p.fs);
  }
  // A target without alpha (RGB565, R8) still gets the fragment's alpha in the output's fourth component: blending reads it.
  for (const [write, out] of [[[0, 1, 2], 'o0 = vec4(col0.x, col0.y, col0.z, col0.w);'], [[0], 'o0 = vec4(col0.x, 0.0, 0.0, col0.w);']] as const) {
    const p = generate(vs, fs, { ...KEY, attribs: ['f'], cbufs: [{ type: 'f', write: [...write] }] });
    assert.ok(p.fs.includes(out), p.fs);
  }
});

test('virgl tgsi: texture sizes and gradients have the texture\'s dimensions (dEQP-GLES3 texturesize, texturegrad); a multisampled texture is fetched resolved', () => {
  const s = corpus().find((c) => c.name.startsWith('texture queries'))!;
  const vs = parseTgsi('VERT\nDCL IN[0]\nDCL OUT[0], POSITION\nDCL OUT[1], GENERIC[0]\n  0: MOV OUT[0], IN[0]\n  1: MOV OUT[1], IN[0]\n  2: END');
  const fs = generate(vs, parseTgsi(s.text), { ...KEY, attribs: ['f'] }).fs;
  assert.match(fs, /ivec4\(textureSize\(fs0, [^;]*\)\.xy, 0, 0\)/, 'a cube\'s size is 2D');
  assert.match(fs, /textureGrad\(fs1, v_GENERIC0\.xyz, v_GENERIC0\.xy, v_GENERIC0\.xy\)/, 'a 2D array\'s gradients are 2D');
  assert.match(fs, /textureGrad\(fs2, vec4\(v_GENERIC0\.xyz, v_GENERIC0\.w\), v_GENERIC0\.xy, v_GENERIC0\.xy\)/, 'and a shadow array\'s');
  assert.match(fs, /ivec4\(textureSize\(fs3, [^;]*\)\.xz, 0, 0\)/, 'a 1D array\'s layers come from the 2D array\'s third size');
  // A multisampled texture is sampled resolved: a 2D texture fetched at level 0, the sample index left out.
  const ms = generate(vs, parseTgsi('FRAG\nDCL OUT[0], COLOR\nDCL SAMP[0]\nDCL SVIEW[0], 2D_MSAA, FLOAT\nDCL TEMP[0]\nIMM[0] UINT32 {1, 2, 0, 3}\n  0: TXF TEMP[0], IMM[0], SAMP[0], 2D_MSAA\n  1: MOV OUT[0], TEMP[0]\n  2: END'), { ...KEY, attribs: ['f'] }).fs;
  assert.match(ms, /uniform highp sampler2D fs0;/);
  assert.match(ms, /texelFetch\(fs0, [^;]*\.xy, 0\)/, ms);
});

test('virgl tgsi: what WebGL2 can\'t do is refused, not miscompiled', () => {
  const vs = parseTgsi('VERT\nDCL OUT[0], POSITION\n  0: END');
  for (const body of ['DCL IMAGE[0], 2D, PIPE_FORMAT_R8G8B8A8_UNORM, WR\n  0: END', 'DCL TEMP[0]\n  0: IMUL_HI TEMP[0], TEMP[0], TEMP[0]\n  1: END', 'DCL SAMP[0]\nDCL TEMP[0]\n  0: TEX TEMP[0], TEMP[0], SAMP[0], CUBE_ARRAY\n  1: END']) {
    assert.throws(() => generate(vs, parseTgsi(`FRAG\nDCL OUT[0], COLOR\n${body}`), KEY), TgsiError, body);
  }
  assert.throws(() => parseTgsi('FRAG\n  0: FOO TEMP[0]%'), TgsiError);
});

test('virgl tgsi: stream output captures the components asked for, as the shader wrote them', () => {
  const vs = parseTgsi('VERT\nDCL IN[0]\nDCL OUT[0], POSITION\nDCL OUT[1], GENERIC[0]\n  0: MOV OUT[0], IN[0]\n  1: MOV OUT[1], IN[0]\n  2: END');
  const fs = parseTgsi('FRAG\nDCL OUT[0], COLOR\n  0: END');
  const p = generate(vs, fs, { ...KEY, so: [{ reg: 0, start: 0, comps: 4 }, { reg: 1, start: 1, comps: 2 }, { reg: 1, start: 3, comps: 1 }] });
  // Interleaved, as bits (the renderer scatters them to their targets).
  assert.deepEqual(p.tf, { varyings: ['tf_0', 'tf_1', 'tf_2'], separate: false });
  for (const l of ['flat out highp uvec4 tf_0;', 'flat out highp uvec2 tf_1;', 'flat out highp uint tf_2;', 'tf_0 = floatBitsToUint(gl_Position.xyzw);', 'tf_1 = floatBitsToUint(o_1.yz);', 'tf_2 = floatBitsToUint(o_1.w);']) assert.ok(p.vs.includes(l), l);
  assert.ok(p.vs.indexOf('tf_0 = gl_Position') < p.vs.indexOf('gl_Position.y *= u_adjy'), 'captured before the flip');
  assert.equal(generate(vs, fs, KEY).tf, undefined);
});

test('virgl trace: records round-trip', () => {
  const t = encodeTrace([encodeRecord({ kind: 'note', text: 'hi' }), encodeRecord({ kind: 'command', bytes: Uint8Array.of(1, 2, 3, 4, 5) }), encodeRecord({ kind: 'data', res: 7, offset: 9, bytes: Uint8Array.of(8, 9) })]);
  const r = [...readTrace(t)];
  assert.deepEqual(r.map((x) => x.kind), ['note', 'command', 'data']);
  assert.equal((r[0] as { text: string }).text, 'hi');
  assert.deepEqual([...(r[1] as { bytes: Uint8Array }).bytes], [1, 2, 3, 4, 5]);
  assert.deepEqual([(r[2] as { res: number }).res, (r[2] as { offset: number }).offset, ...(r[2] as { bytes: Uint8Array }).bytes], [7, 9, 8, 9]);
});

/** Replays a fixture on a recording WebGL2 and returns the renderer's numbers. */
function replayMock(name: string) {
  const gl = mockGl();
  let r!: VirglRenderer;
  const errors: string[] = [];
  const res = replay(fixture(name), (ram) => localHost((r = new VirglRenderer(gl, { ram, log: (m) => errors.push(m) }))));
  return { r, gl, res, errors };
}

/**
 * The draws where a texture bound for sampling is attached to the draw framebuffer (a feedback loop: WebGL refuses
 * the draw). The units counted are those bound since the program was (the renderer binds a draw's textures then).
 */
function feedbackLoops(log: [string, unknown[]][]) {
  const DRAW: number[] = [E.DRAW_FRAMEBUFFER, E.FRAMEBUFFER];
  const attached = new Map<unknown, Map<number, unknown>>();
  const units = new Map<number, Map<number, unknown>>();
  let unit: number = E.TEXTURE0, draw: unknown = null, draws = 0;
  const loops: string[] = [];
  const attach = (target: number, point: number, tex: unknown) => {
    const fb = DRAW.includes(target) ? draw : null;
    if (!fb) return;
    if (!attached.has(fb)) attached.set(fb, new Map());
    attached.get(fb)!.set(point, tex);
  };
  for (const [n, a] of log) {
    if (n === 'activeTexture') unit = a[0] as number;
    else if (n === 'useProgram') units.clear();
    else if (n === 'bindTexture') { if (!units.has(unit)) units.set(unit, new Map()); units.get(unit)!.set(a[0] as number, a[1]); }
    else if (n === 'bindFramebuffer' && DRAW.includes(a[0] as number)) draw = a[1];
    else if (n === 'framebufferTexture2D') attach(a[0] as number, a[1] as number, a[3]);
    else if (n === 'framebufferTextureLayer') attach(a[0] as number, a[1] as number, a[2]);
    else if (n === 'framebufferRenderbuffer') attach(a[0] as number, a[1] as number, null);
    else if (n.startsWith('draw') && n !== 'drawBuffers') {
      draws++;
      const at = [...(attached.get(draw)?.values() ?? [])].filter(Boolean);
      for (const [u, ts] of units) for (const t of ts.values()) if (t && at.includes(t)) loops.push(`draw ${draws} (${n}) samples unit ${u - E.TEXTURE0}'s texture, attached to its framebuffer`);
    }
  }
  return loops;
}

test('virgl renderer: no draw samples a texture attached to its framebuffer (dEQP-GLES3 fragment_out: a blit after three targets)', () => {
  for (const name of ['deqp-gles3-fragment-out-r11f.vglt.gz', 'glcomp-128x96.vglt', 'sway-640.vglt.gz', 'deqp-gles2-stencil-stride.vglt.gz']) {
    const gl = mockGl();
    gl.keepLog = true;
    const errors: string[] = [];
    replay(fixture(name), (ram) => localHost(new VirglRenderer(gl, { ram, log: (m) => errors.push(m) })));
    assert.deepEqual(errors, [], name);
    assert.deepEqual(feedbackLoops(gl.log).slice(0, 3), [], name);
  }
});

test('virgl renderer: an RG target first doesn\'t mask an RGBA target\'s B and A (dEQP-GLES3 fragment_out.random)', () => {
  // RG32I and RGBA32I targets, drawn at once (fragment_out.random.11, captured): WebGL2 has one color mask.
  const gl = mockGl();
  gl.keepLog = true;
  const errors: string[] = [];
  replay(fixture('deqp-gles3-fragment-out-int.vglt.gz'), (ram) => localHost(new VirglRenderer(gl, { ram, log: (m) => errors.push(m) })));
  assert.deepEqual(errors, []);
  let mask: unknown[] = [];
  const atDraws: unknown[][] = [];
  for (const [n, a] of gl.log) {
    if (n === 'colorMask') mask = a;
    if (n === 'drawElements') atDraws.push(mask);
  }
  assert.deepEqual(atDraws, [[true, true, true, true]]);
});

test('virgl renderer: glcomp\'s trace runs through the device: 18 draws, 6 read-backs, every submit OK', () => {
  const { r, res, errors } = replayMock('glcomp-128x96.vglt');
  assert.deepEqual(errors, []);
  assert.deepEqual(new Set(res.replies), new Set([0x1100]));
  assert.equal(r.stats.submits, 6);
  assert.equal(r.stats.draws, 18); // 6 frames of 3 quads
  assert.equal(r.stats.readbacks, 6); // glReadPixels after each
  assert.equal(r.stats.programs, 1);
  // glcomp exited and its context went; one stays, the initramfs's nlplug-findfs's (it opened the render node at boot).
  assert.equal(r.contextCount, 1);
});

test('virgl renderer: sway\'s trace (foot starting, a command typed) runs with no errors', () => {
  const { r, res, errors } = replayMock('sway-640.vglt.gz');
  assert.deepEqual(errors, []);
  assert.deepEqual(new Set(res.replies), new Set([0x1100]));
  assert.equal(r.stats.draws, 147);
  assert.ok(r.stats.programs >= 3);
  assert.ok(res.flushes > 100, `${res.flushes} flushes`);
});

test('virgl renderer: what WebGL refuses and GLES allows is worked around (dEQP-GLES2 stencil faces and strides)', () => {
  // dEQP-GLES2's stencil_ops.zero_invert_keep (front and back stencil masks differ) and vertex_arrays'
  // 3_float2_17_float2_32_float2_17 (floats 17 bytes apart), captured in the guest (bench/gpu/deqp-run.ts CAPTURE=).
  const gl = mockGl();
  gl.keepLog = true;
  const errors: string[] = [];
  const res = replay(fixture('deqp-gles2-stencil-stride.vglt.gz'), (ram) => localHost(new VirglRenderer(gl, { ram, log: (m) => errors.push(m) })));
  assert.deepEqual(errors, []);
  assert.deepEqual(new Set(res.replies), new Set([0x1100]));
  // WebGL's rules at every draw: the faces' stencil reference and masks agree; attributes aligned to their type, strides under 256.
  const face: Record<number, { ref: number; vmask: number; wmask: number }> = { [E.FRONT]: { ref: 0, vmask: -1, wmask: -1 }, [E.BACK]: { ref: 0, vmask: -1, wmask: -1 } };
  const set = (f: number, k: 'ref' | 'vmask' | 'wmask', v: number) => { for (const x of f === E.FRONT_AND_BACK ? [E.FRONT, E.BACK] : [f]) face[x][k] = v; };
  let draws = 0, split = 0;
  for (const [name, a] of gl.log) {
    const n = a as number[];
    if (name === 'stencilFuncSeparate') { set(n[0], 'ref', n[2]); set(n[0], 'vmask', n[3]); if (n[0] === E.FRONT_AND_BACK) split++; }
    if (name === 'stencilMaskSeparate') set(n[0], 'wmask', n[1]);
    if (name === 'vertexAttribPointer') {
      const size = n[2] === E.FLOAT ? 4 : n[2] === E.SHORT || n[2] === E.UNSIGNED_SHORT ? 2 : 1;
      assert.ok(n[4] % size === 0 && n[5] % size === 0 && n[4] < 256, `attribute ${n[0]}: stride ${n[4]}, offset ${n[5]}`);
    }
    if (name.startsWith('draw')) {
      draws++;
      assert.deepEqual(face[E.FRONT], face[E.BACK], `draw ${draws}`);
    }
  }
  assert.ok(split >= 2, `${split} stencil states set for both faces (a split draw)`);
});

test('virgl renderer: depth textures: Z24S8 goes up with depth in the high bits, and a copy reads its depth (dEQP-GLES3 shadow)', () => {
  const gl = mockGl();
  gl.keepLog = true;
  const errors: string[] = [];
  const r = new VirglRenderer(gl, { ram: () => new Uint8Array(0), log: (m) => errors.push(m) });
  r.createContext(1);
  for (const id of [1, 2]) {
    r.createResource({ id, target: 2, format: 19, bind: 8, width: 2, height: 1, depth: 1, arraySize: 1, lastLevel: 0, samples: 0, flags: 0 });
    r.attach(1, id);
  }
  const words: number[] = [];
  const cmd = (c: number, obj: number, ...p: number[]) => words.push(c | obj << 8 | p.length << 16, ...p);
  // Two texels of Z24_UNORM_S8_UINT: depth 0x123456 with stencil 0xab, depth 0xfedcba with stencil 0x01.
  cmd(9, 0, 1, 0, 0, 0, 0, 0, 0, 0, 2, 1, 1, 0xab123456, 0x01fedcba);
  cmd(17, 0, 2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 2, 1, 1); // RESOURCE_COPY_REGION 1 -> 2
  r.submit(1, new Uint32Array(words));
  assert.deepEqual(errors, []);
  const up = gl.log.find(([n]) => n === 'texSubImage2D')!;
  const view = (up[1] as unknown[]).find((a) => ArrayBuffer.isView(a)) as Uint8Array;
  assert.deepEqual([...new Uint32Array(view.buffer, view.byteOffset, 2)].map((w) => w.toString(16)), ['123456ab', 'fedcba01']);
  const at = gl.log.findIndex(([n, a]) => n === 'framebufferTexture2D' && (a as number[])[0] === E.READ_FRAMEBUFFER && (a as number[])[1] === E.DEPTH_STENCIL_ATTACHMENT);
  assert.ok(at >= 0, 'the copy reads the source at its depth-stencil attachment');
  assert.ok(gl.log.slice(at).some(([n, a]) => n === 'blitFramebuffer' && ((a as number[])[8] & E.DEPTH_BUFFER_BIT) !== 0), 'a depth blit');
});

test('virgl renderer: an upload to DEPTH32F_STENCIL8, which WebGL2 takes no data for, is drawn (dEQP-GLES3 depth32f_stencil8)', () => {
  const gl = mockGl();
  gl.keepLog = true;
  const errors: string[] = [];
  const r = new VirglRenderer(gl, { ram: () => new Uint8Array(0), log: (m) => errors.push(m) });
  r.createContext(1);
  r.createResource({ id: 1, target: 2, format: 126, bind: 8, width: 2, height: 1, depth: 1, arraySize: 1, lastLevel: 0, samples: 0, flags: 0 });
  r.attach(1, 1);
  // Two texels: depth 0.25 with stencil 0x81, depth 1.0 with stencil 0x02 (the depth's float, then the stencil's word).
  const f = (v: number) => new Uint32Array(new Float32Array([v]).buffer)[0];
  r.submit(1, new Uint32Array([9 | 15 << 16, 1, 0, 0, 0, 0, 0, 0, 0, 2, 1, 1, f(0.25), 0x81, f(1), 0x02]));
  assert.deepEqual(errors, []);
  assert.ok(!gl.log.some(([n, a]) => n.startsWith('texSubImage') && (a as unknown[]).includes(0x8dad /* FLOAT_32_UNSIGNED_INT_24_8_REV */)), 'no data WebGL refuses');
  const ups = gl.log.filter(([n]) => n === 'texImage2D').map(([, a]) => Array.from((a as unknown[])[8] as ArrayLike<number>));
  assert.deepEqual(ups, [[0.25, 1], [0x81, 0x02]]);
  assert.equal(gl.log.filter(([n]) => n === 'drawArrays').length, 9, 'the depth, then a pass a stencil bit');
  // The renderer's uploads assume rows packed at 1: the drawn upload leaves it so (one set at 4 skewed every later
  // upload of rows not a multiple of 4 bytes: r8, rg8, rgb565 in dEQP's texture.specification after a depth32f_stencil8).
  const aligns = gl.log.filter(([n, a]) => n === 'pixelStorei' && (a as number[])[0] === E.UNPACK_ALIGNMENT).map(([, a]) => (a as number[])[1]);
  assert.deepEqual(aligns.filter((v) => v !== 1), [], 'UNPACK_ALIGNMENT stays 1');
});

test('virgl renderer: integer formats blit through GL\'s blit, and RGB10_A2UI reads back packed (dEQP-GLES3 fbo.blit)', () => {
  const byName = (n: string) => [...FORMATS.values()].find((f) => f.name === n)!;
  // RGB10_A2UI: four integers read, packed again.
  const rb = readbackOf(byName('R10G10B10A2_UINT'), false)!;
  const src = new Uint8Array(new Uint32Array([1023, 512, 3, 2]).buffer), dst = new Uint8Array(4);
  rb.pack(src, dst, 1);
  assert.equal(new Uint32Array(dst.buffer)[0], (1023 | 512 << 10 | 3 << 20 | 2 << 30) >>> 0);
  // RGBA8I to RG8I: a framebuffer blit (an integer texture can't be sampled as a float one).
  const gl = mockGl();
  gl.keepLog = true;
  const errors: string[] = [];
  const r = new VirglRenderer(gl, { ram: () => new Uint8Array(0), log: (m) => errors.push(m) });
  r.createContext(1);
  const [a8, rg8] = [byName('R8G8B8A8_SINT'), byName('R8G8_SINT')];
  r.createResource({ id: 1, target: 2, format: a8.id, bind: 2, width: 4, height: 4, depth: 1, arraySize: 1, lastLevel: 0, samples: 0, flags: 0 });
  r.createResource({ id: 2, target: 2, format: rg8.id, bind: 2, width: 4, height: 4, depth: 1, arraySize: 1, lastLevel: 0, samples: 0, flags: 0 });
  r.attach(1, 1);
  r.attach(1, 2);
  // BLIT: mask (RGBA), scissor, dst (res, level, format, box), src (res, level, format, box).
  r.submit(1, new Uint32Array([16 | 21 << 16, 0xf, 0, 0, 2, 0, rg8.id, 0, 0, 0, 4, 4, 1, 1, 0, a8.id, 0, 0, 0, 4, 4, 1]));
  assert.deepEqual(errors, []);
  assert.ok(gl.log.some(([n]) => n === 'blitFramebuffer'), 'a framebuffer blit');
  assert.ok(!gl.log.some(([n]) => n === 'drawArrays'), 'no sampling draw');
});

test('virgl renderer: a transfer\'s stride 0 is its level\'s pitch, as vrend reads it (dEQP-GLES3 texsubimage)', () => {
  const gl = mockGl();
  gl.keepLog = true;
  const errors: string[] = [];
  const ram = new Uint8Array(64 * 32 * 4);
  const r = new VirglRenderer(gl, { ram: () => ram, log: (m) => errors.push(m) });
  r.createContext(1);
  r.createResource({ id: 1, target: 2, format: 2, bind: 8, width: 64, height: 32, depth: 1, arraySize: 1, lastLevel: 1, samples: 0, flags: 0 });
  r.attachBacking(1, [{ off: 0, len: ram.length }]);
  // An 8x4 box at (16, 8) of level 0, and of level 1 (32 wide), from the backing laid out as the whole level.
  assert.ok(r.transfer(1, 1, 0, { x: 16, y: 8, z: 0, w: 8, h: 4, d: 1 }, (8 * 64 + 16) * 4, 0, 0, true));
  assert.ok(r.transfer(1, 1, 1, { x: 4, y: 2, z: 0, w: 8, h: 4, d: 1 }, (2 * 32 + 4) * 4, 0, 0, true));
  assert.deepEqual(errors, []);
  const rows = gl.log.filter(([n, a]) => n === 'pixelStorei' && (a as number[])[0] === E.UNPACK_ROW_LENGTH && (a as number[])[1]).map(([, a]) => (a as number[])[1]);
  assert.deepEqual(rows, [64, 32]);
});

test('virgl renderer: indices start at the index buffer\'s offset, and the largest index restarts only with restart on (dEQP-GLES2 index arrays)', () => {
  const gl = mockGl();
  gl.keepLog = true;
  const errors: string[] = [];
  const r = new VirglRenderer(gl, { ram: () => new Uint8Array(0), log: (m) => errors.push(m) });
  r.createContext(1);
  const buffer = (id: number, width: number, bind: number) => { r.createResource({ id, target: 0, format: 64, bind, width, height: 1, depth: 1, arraySize: 1, lastLevel: 0, samples: 0, flags: 0 }); r.attach(1, id); };
  buffer(1, 256 * 16, 0x10);
  buffer(2, 16, 0x20);
  const words: number[] = [];
  const cmd = (c: number, obj: number, ...p: number[]) => words.push(c | obj << 8 | p.length << 16, ...p);
  const text = (src: string) => { const b = new TextEncoder().encode(src + '\0'); const w = new Uint32Array(Math.ceil(b.length / 4)); new Uint8Array(w.buffer).set(b); return [b.length, ...w]; };
  const shader = (h: number, type: number, src: string) => { const [len, ...t] = text(src); cmd(1, 4, h, type, len, 0, 0, ...t); };
  shader(10, 0, 'VERT\nDCL IN[0]\nDCL OUT[0], POSITION\n  0: MOV OUT[0], IN[0]\n  1: END\n');
  shader(11, 1, 'FRAG\nDCL OUT[0], COLOR\nIMM[0] FLT32 {1.0, 0.0, 0.0, 1.0}\n  0: MOV OUT[0], IMM[0]\n  1: END\n');
  cmd(31, 0, 10, 0); cmd(31, 0, 11, 1);
  cmd(1, 5, 20, 0, 0, 0, 31); cmd(2, 5, 20);
  cmd(1, 2, 21, 1 << 1, 0x3f800000, 0, 0, 0x3f800000, 0, 0, 0); cmd(2, 2, 21);
  r.createResource({ id: 3, target: 2, format: 2, bind: 2, width: 4, height: 4, depth: 1, arraySize: 1, lastLevel: 0, samples: 0, flags: 0 });
  r.attach(1, 3);
  cmd(1, 8, 22, 3, 2, 0, 0); // a surface on it
  cmd(5, 0, 1, 0, 22);
  cmd(6, 0, 16, 0, 1);
  // Bytes 8..11 of the index buffer are the draw's: 4, 5, 255, 6 (Mesa sends the start in the offset, and in start).
  cmd(9, 0, 2, 0, 0, 0, 0, 0, 0, 0, 16, 1, 1, 0x03020100, 0x09090909, 0x06ff0504, 0x07070707);
  cmd(11, 0, 2, 1, 8);
  const draw = (restart: number, index: number) => cmd(8, 0, 8, 4, 3, 1, 1, 0, 0, restart, index, 4, 255, 0);
  draw(0, 0); // GLES 2: 255 is a vertex
  draw(1, 255); // restart at 255: WebGL's own
  draw(1, 5); // restart at 5
  r.submit(1, new Uint32Array(words));
  assert.deepEqual(errors, []);
  // Each element buffer's data, and the one bound at each draw.
  const data = new Map<unknown, Uint8Array | Uint16Array>();
  let bound: unknown;
  const drawn: [number[], number, number][] = [];
  for (const [n, a] of gl.log) {
    if (n === 'bindBuffer' && a[0] === E.ELEMENT_ARRAY_BUFFER) bound = a[1];
    if (n === 'bufferData' && a[0] === E.ELEMENT_ARRAY_BUFFER) data.set(bound, a[1] as Uint8Array);
    if (n === 'drawElements') {
      const [, count, type, offset] = a as number[];
      const v = data.get(bound)!;
      drawn.push([[...v.subarray(offset / v.BYTES_PER_ELEMENT, offset / v.BYTES_PER_ELEMENT + count)], type, offset]);
    }
  }
  assert.deepEqual(drawn, [
    [[4, 5, 255, 6], E.UNSIGNED_SHORT, 0],
    [[4, 5, 255, 6], E.UNSIGNED_BYTE, 8],
    [[4, 0xffff, 255, 6], E.UNSIGNED_SHORT, 0],
  ]);
});

test('virgl renderer: a fence waits for the occlusion queries before it (dEQP-GLES3 occlusion_query: results after glFinish)', () => {
  const gl = mockGl();
  let available = false;
  (gl as unknown as { getQueryParameter: unknown }).getQueryParameter = (_q: unknown, p: number) => (p === E.QUERY_RESULT_AVAILABLE ? available : 1);
  const ram = new Uint8Array(64);
  const errors: string[] = [];
  const r = new VirglRenderer(gl, { ram: () => ram, log: (m) => errors.push(m) });
  r.createContext(1);
  r.createResource({ id: 5, target: 0, format: 64, bind: 0x800, width: 64, height: 1, depth: 1, arraySize: 1, lastLevel: 0, samples: 0, flags: 0 });
  r.attach(1, 5);
  r.attachBacking(5, [{ off: 0, len: 64 }]);
  const answered: string[] = [];
  const gate = new FenceGate<string>((f) => answered.push(f));
  gate.fence('before', r.queriesSettled());
  // An occlusion predicate (virgl's type 1), its state in resource 5: begun, ended.
  r.submit(1, new Uint32Array([1 | 9 << 8 | 4 << 16, 40, 1, 0, 5, 19 | 1 << 16, 40, 20 | 1 << 16, 40]));
  assert.deepEqual(errors, []);
  assert.equal(new DataView(ram.buffer).getUint32(0, true), 2, 'the guest is told to wait for the host');
  gate.fence('after', r.queriesSettled());
  gate.fence('later', r.queriesSettled());
  r.pollQueries();
  gate.release();
  assert.deepEqual(answered, ['before'], 'held while the result is pending');
  available = true;
  r.pollQueries();
  gate.release();
  assert.deepEqual(answered, ['before', 'after', 'later']);
  assert.equal(new DataView(ram.buffer).getUint32(0, true), 1, 'the result is written before the fence is answered');
});

test('virgl renderer: a query destroyed before its result holds no fence (dEQP-GLES3 hung at a context\'s end)', () => {
  const gl = mockGl();
  // A deleted query's result never becomes available.
  (gl as unknown as { getQueryParameter: unknown }).getQueryParameter = (_q: unknown, p: number) => (p === E.QUERY_RESULT_AVAILABLE ? false : null);
  const ram = new Uint8Array(64);
  const errors: string[] = [];
  const r = new VirglRenderer(gl, { ram: () => ram, log: (m) => errors.push(m) });
  r.createContext(1);
  r.createResource({ id: 5, target: 0, format: 64, bind: 0x800, width: 64, height: 1, depth: 1, arraySize: 1, lastLevel: 0, samples: 0, flags: 0 });
  r.attach(1, 5);
  r.attachBacking(5, [{ off: 0, len: 64 }]);
  const answered: string[] = [];
  const gate = new FenceGate<string>((f) => answered.push(f));
  // An occlusion predicate begun and ended, then destroyed (DESTROY_OBJECT) with its result pending.
  r.submit(1, new Uint32Array([1 | 9 << 8 | 4 << 16, 40, 1, 0, 5, 19 | 1 << 16, 40, 20 | 1 << 16, 40, 3 | 9 << 8 | 1 << 16, 40]));
  assert.deepEqual(errors, []);
  gate.fence('after', r.queriesSettled());
  r.pollQueries();
  gate.release();
  assert.deepEqual(answered, ['after']);
  assert.equal(r.pollQueries(), 0, 'nothing left to poll');
});

test('virgl renderer: a multisampled source is resolved before a conversion or a flip (dEQP-GLES3 fbo.invalidate unbind_blit_msaa)', () => {
  const gl = mockGl();
  gl.keepLog = true;
  const errors: string[] = [];
  const r = new VirglRenderer(gl, { ram: () => new Uint8Array(0), log: (m) => errors.push(m) });
  r.createContext(1);
  const byName = (n: string) => [...FORMATS.values()].find((f) => f.name === n)!.id;
  const tex = (id: number, format: string, samples: number, bind = 2) => { r.createResource({ id, target: 2, format: byName(format), bind, width: 8, height: 8, depth: 1, arraySize: 1, lastLevel: 0, samples, flags: 0 }); r.attach(1, id); };
  tex(1, 'R8G8B8A8_UNORM', 4); tex(2, 'B8G8R8A8_UNORM', 0); tex(3, 'Z24_UNORM_S8_UINT', 4, 1); tex(4, 'Z24_UNORM_S8_UINT', 0, 1); tex(5, 'R8G8B8A8_UNORM', 0);
  const blit = (mask: number, dst: number, df: string, src: number, sf: string, flip: boolean) =>
    new Uint32Array([16 | 21 << 16, mask, 0, 0, dst, 0, byName(df), 0, flip ? 8 : 0, 0, 8, flip ? -8 >>> 0 : 8, 1, src, 0, byName(sf), 0, 0, 0, 8, 8, 1]);
  const calls = (from: number) => gl.log.slice(from).filter(([n]) => n === 'blitFramebuffer' || n === 'drawArrays').map(([n, a]) => (n === 'drawArrays' ? 'draw' : `blit ${(a as number[])[8].toString(16)}`));
  // RGBA8 x4 onto BGRA: resolved (a blit), then converted (a draw); onto RGBA8 at the same rectangle, GL's resolve alone.
  let at = gl.log.length;
  r.submit(1, blit(0xf, 2, 'B8G8R8A8_UNORM', 1, 'R8G8B8A8_UNORM', false));
  assert.deepEqual(calls(at), ['blit 4000', 'draw']);
  at = gl.log.length;
  r.submit(1, blit(0xf, 5, 'R8G8B8A8_UNORM', 1, 'R8G8B8A8_UNORM', false));
  assert.deepEqual(calls(at), ['blit 4000']);
  // Depth and stencil onto a flipped rectangle: resolved, then blitted flipped.
  at = gl.log.length;
  r.submit(1, blit(0x30, 4, 'Z24_UNORM_S8_UINT', 3, 'Z24_UNORM_S8_UINT', true));
  assert.deepEqual(calls(at), ['blit 500', 'blit 500']);
  const flipped = gl.log.filter(([n]) => n === 'blitFramebuffer').at(-1)![1] as number[];
  assert.ok(flipped[5] > flipped[7], `the second blit is flipped: ${flipped.join(',')}`);
  assert.deepEqual(errors, []);
});

test('virgl renderer: the sample mask Mesa makes from glSampleCoverage maps back onto WebGL\'s coverage (dEQP-GLES3 multisample); a multisampled texture is sampled resolved', () => {
  const gl = mockGl();
  gl.keepLog = true;
  const errors: string[] = [];
  const r = new VirglRenderer(gl, { ram: () => new Uint8Array(0), log: (m) => errors.push(m) });
  r.createContext(1);
  r.createResource({ id: 1, target: 0, format: 64, bind: 0x10, width: 64, height: 1, depth: 1, arraySize: 1, lastLevel: 0, samples: 0, flags: 0 });
  r.createResource({ id: 3, target: 2, format: 67, bind: 2, width: 4, height: 4, depth: 1, arraySize: 1, lastLevel: 0, samples: 4, flags: 0 });
  r.attach(1, 1); r.attach(1, 3);
  const words: number[] = [];
  const cmd = (c: number, obj: number, ...p: number[]) => words.push(c | obj << 8 | p.length << 16, ...p);
  const text = (src: string) => { const b = new TextEncoder().encode(src + '\0'); const w = new Uint32Array(Math.ceil(b.length / 4)); new Uint8Array(w.buffer).set(b); return [b.length, ...w]; };
  const shader = (h: number, type: number, src: string) => { const [len, ...t] = text(src); cmd(1, 4, h, type, len, 0, 0, ...t); };
  shader(10, 0, 'VERT\nDCL IN[0]\nDCL OUT[0], POSITION\n  0: MOV OUT[0], IN[0]\n  1: END\n');
  shader(11, 1, 'FRAG\nDCL OUT[0], COLOR\nIMM[0] FLT32 {1.0, 0.0, 0.0, 1.0}\n  0: MOV OUT[0], IMM[0]\n  1: END\n');
  cmd(31, 0, 10, 0); cmd(31, 0, 11, 1);
  cmd(1, 5, 20, 0, 0, 0, 31); cmd(2, 5, 20);
  cmd(1, 2, 21, 1 << 1, 0x3f800000, 0, 0, 0x3f800000, 0, 0, 0); cmd(2, 2, 21);
  cmd(1, 8, 22, 3, 67, 0, 0);
  cmd(5, 0, 1, 0, 22);
  cmd(6, 0, 16, 0, 1);
  for (const m of [0xffffffff, 0b0011, ~0b0011 >>> 0, 0b0101]) { cmd(24, 0, m); cmd(8, 0, 0, 3, 4, 0, 1, 0, 0, 0, 0, 0, 2, 0); }
  r.submit(1, new Uint32Array(words));
  assert.deepEqual(errors, []);
  const seen: string[] = [];
  let state = '';
  for (const [n, a] of gl.log) {
    if (n === 'disable' && a[0] === E.SAMPLE_COVERAGE) state = 'off';
    if (n === 'sampleCoverage') state = `${a[0]} ${a[1]}`;
    if (n === 'drawArrays') seen.push(state);
  }
  assert.deepEqual(seen, ['off', '0.5 false', '0.5 true', '0.5 false']);
  // A multisampled texture sampled: resolved into a texture of its own before the draw, which samples that.
  r.createResource({ id: 4, target: 2, format: 67, bind: 8, width: 4, height: 4, depth: 1, arraySize: 1, lastLevel: 0, samples: 4, flags: 0 });
  r.attach(1, 4);
  words.length = 0;
  shader(12, 1, 'FRAG\nDCL OUT[0], COLOR\nDCL SAMP[0]\nDCL SVIEW[0], 2D_MSAA, FLOAT\nDCL TEMP[0]\nIMM[0] UINT32 {1, 2, 0, 3}\n  0: TXF TEMP[0], IMM[0], SAMP[0], 2D_MSAA\n  1: MOV OUT[0], TEMP[0]\n  2: END\n');
  cmd(31, 0, 12, 1);
  cmd(1, 6, 23, 4, 67, 0, 0, 0 | 1 << 3 | 2 << 6 | 3 << 9);
  cmd(10, 0, 1, 0, 23);
  const at = gl.log.length;
  cmd(8, 0, 0, 3, 4, 0, 1, 0, 0, 0, 0, 0, 2, 0);
  r.submit(1, new Uint32Array(words));
  assert.deepEqual(errors, []);
  const tail = gl.log.slice(at).map(([n]) => n);
  assert.ok(tail.indexOf('blitFramebuffer') >= 0 && tail.indexOf('blitFramebuffer') < tail.indexOf('drawArrays'), 'resolved before the draw');
  const made = gl.log.slice(at).find(([n]) => n === 'texStorage2D');
  assert.ok(made, 'a texture for the resolve');
});

test('virgl device: a fenced command\'s reply waits for the host, and replies stay in order', async () => {
  const ram = new Uint8Array(1 << 20);
  const done: number[] = [];
  const ctx = { ram: () => ram, ramSize: ram.length, complete: (w0: number) => done.push(w0), config: () => new Uint8Array(16), changeConfig: () => {}, untaken: () => 0 };
  let release!: () => void;
  const calls: HostCall[] = [];
  const host: VirglHost = { call: (c) => calls.push(c), fence: () => new Promise<void>((r) => { release = r; }) };
  const b = gpuBackend(ctx as never, { width: 640, height: 480, virgl: true });
  b.gpu.host = host;
  // A command in guest RAM at `at`: header (type, flags), then fields; the reply after it.
  const put = (at: number, type: number, flags: number, ctxId: number, fields: number[]) => {
    const v = new DataView(ram.buffer);
    v.setUint32(at, type, true);
    v.setUint32(at + 4, flags, true);
    v.setUint32(at + 16, ctxId, true);
    fields.forEach((f, k) => v.setUint32(at + 24 + 4 * k, f, true));
    return { queue: 0, w0: at, read: [{ off: at, len: 24 + 4 * fields.length }], write: [{ off: at + 2048, len: 64 }] };
  };
  assert.equal(b.request(put(0, 0x200, 0, 5, [0, 0])), 24); // CTX_CREATE: at once
  // SUBMIT_3D with a fence (one NOP), then GET_DISPLAY_INFO: both wait.
  assert.equal(b.request(put(4096, 0x207, 1, 5, [4, 0, 0])), undefined);
  assert.equal(b.request(put(8192, 0x100, 0, 0, [])), undefined);
  assert.deepEqual(done, []);
  assert.deepEqual(calls.map((c) => c.t), ['ctx', 'submit']);
  release();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(done, [4096, 8192]);
});

test('virgl caps: from the browser\'s WebGL2, formats only where their extensions are, multisampling where it is; a restore checks them', () => {
  const plain = decodeCaps(capsFromGl(mockGl({ extensions: [] })));
  const rich = decodeCaps(capsFromGl(mockGl({ extensions: ['EXT_texture_norm16', 'EXT_color_buffer_float', 'WEBGL_compressed_texture_s3tc', 'EXT_texture_filter_anisotropic'], params: { [0xd33]: 16384, [0x84ff]: 16 } })));
  const has = (c: Record<string, unknown>, mask: string, name: string) => (c[mask] as number[]).includes([...FORMATS.values()].find((f) => f.name === name)!.id);
  assert.equal(plain.max_texture_2d_size, 8192);
  assert.equal(rich.max_texture_2d_size, 16384);
  assert.equal(plain.max_anisotropy, 1);
  assert.equal(rich.max_anisotropy, 16);
  assert.ok(has(plain, 'sampler', 'B8G8R8X8_UNORM') && has(plain, 'render', 'B8G8R8X8_UNORM') && has(plain, 'scanout', 'B8G8R8X8_UNORM'));
  assert.ok(!has(plain, 'sampler', 'R16_UNORM') && has(rich, 'sampler', 'R16_UNORM'));
  assert.ok(!has(plain, 'sampler', 'DXT1_RGBA') && has(rich, 'sampler', 'DXT1_RGBA'));
  assert.ok(!has(plain, 'render', 'R32_FLOAT') && has(rich, 'render', 'R32_FLOAT'));
  assert.ok(!has(plain, 'render', 'DXT1_RGBA'));
  assert.equal(plain.max_uniform_blocks, 13);
  assert.equal((plain.max_const_buffer_size as number[])[0], (256 - 16) * 16);
  // GLES 3.0's floor (G2's caps) stays: the bits the guest's Mesa needs for GLES 3.0.
  assert.equal(plain.glsl_level, 130);
  assert.equal(plain.capability_bits, decodeCaps(virglCaps(2)).capability_bits);
  // Multisampled renderbuffers (GLES 3.0's 4 samples): Mesa makes them only with texture_multisample; depth too.
  assert.ok((plain.bset as number) & (1 << 14));
  assert.ok(!((decodeCaps(capsFromGl(mockGl({ params: { [E.MAX_SAMPLES]: 1 } }))).bset as number) & (1 << 14)));
  assert.ok(has(plain, 'supported_multisample_formats', 'R8G8B8A8_UNORM') && has(plain, 'supported_multisample_formats', 'Z24_UNORM_S8_UINT'));
  // A machine saved where s3tc was there doesn't restore its 3D where it isn't.
  assert.equal(capsBacked(capsFromGl(mockGl({ extensions: [] })), capsFromGl(mockGl({ extensions: ['WEBGL_compressed_texture_s3tc'] }))), null);
  assert.match(capsBacked(capsFromGl(mockGl({ extensions: ['WEBGL_compressed_texture_s3tc'] })), capsFromGl(mockGl({ extensions: [] })))!, /sampler lacks formats/);
  assert.match(capsBacked(capsFromGl(mockGl({ params: { [0xd33]: 16384 } })), capsFromGl(mockGl()))!, /max_texture_2d_size/);
});

test('virgl renderer: half floats round to nearest even', () => {
  assert.deepEqual([1, -2, 0.5, 65504, 1e-8, Infinity, 1 + 2 ** -11, 1 + 3 * 2 ** -11].map(toHalf), [0x3c00, 0xc000, 0x3800, 0x7bff, 0, 0x7c00, 0x3c00, 0x3c02]);
});

test('virgl snapshots: contexts that never submitted are saved and made again; caps this browser can\'t back turn 3D off', () => {
  const ram = new Uint8Array(1 << 16);
  const make = (caps?: Uint8Array) => {
    const calls: HostCall[] = [];
    const g = new Gpu(() => ram, ram.length, { width: 640, height: 480, virgl: true, caps });
    g.host = { call: (c) => calls.push(c), fence: () => undefined };
    return { g, calls };
  };
  const ctxCmd = (type: number, ctxId: number, ...fields: number[]) => {
    const b = new Uint8Array(24 + 4 * fields.length);
    const v = new DataView(b.buffer);
    v.setUint32(0, type, true);
    v.setUint32(16, ctxId, true);
    fields.forEach((f, k) => v.setUint32(24 + 4 * k, f, true));
    return b;
  };
  const type = (r: Uint8Array) => new DataView(r.buffer, r.byteOffset).getUint32(0, true);
  const capsA = capsFromGl(mockGl({ extensions: ['WEBGL_compressed_texture_s3tc'] })), capsB = capsFromGl(mockGl({ extensions: [] }));
  const a = make(capsA);
  assert.equal(type(a.g.control(ctxCmd(0x200, 7, 0, 0), 64)), 0x1100);
  // The console on the screen: a 2D resource on the scanout (RESOURCE_CREATE_2D, SET_SCANOUT).
  assert.equal(type(a.g.control(ctxCmd(0x101, 0, 1, 1, 64, 32), 64)), 0x1100);
  assert.equal(type(a.g.control(ctxCmd(0x103, 0, 0, 0, 64, 32, 0, 1), 64)), 0x1100);
  const saved = JSON.parse(JSON.stringify(a.g.save())) as { unsaveable?: string };
  assert.equal(saved.unsaveable, undefined, 'a context alone (a process that opened the render node) doesn\'t stop a snapshot');
  // Restored where the same caps are backed: the context is made again in the renderer.
  const b = make(capsA);
  b.g.restore(saved);
  assert.deepEqual(b.calls.filter((c) => c.t === 'ctx'), [{ t: 'ctx', id: 7, create: true }]);
  // The GPU worker draws the screen: it is told what the restored scanout shows.
  const shown = b.calls.filter((c) => c.t === 'scanout');
  assert.deepEqual(shown.map((c) => c.t === 'scanout' && [c.width, c.height, c.pixels?.length, c.rect.w]), [[64, 32, 64 * 32 * 4, 64]]);
  assert.equal(type(b.g.control(ctxCmd(0x200, 8, 0, 0), 64)), 0x1100);
  // Where s3tc is missing: the guest's caps stay the saved ones, and 3D is off.
  const c = make(capsB);
  c.g.restore(saved);
  assert.deepEqual([...c.g.caps], [...capsA]);
  assert.equal(c.calls.filter((x) => x.t === 'ctx').length, 0, 'no context is made');
  assert.equal(type(c.g.control(ctxCmd(0x200, 8, 0, 0), 64)), 0x1200);
  // A context that submitted has objects in the renderer: not saved, until it's gone.
  assert.equal(type(a.g.control(ctxCmd(0x207, 7, 4, 0, 0), 64)), 0x1100);
  assert.match((a.g.save() as { unsaveable?: string }).unsaveable ?? '', /3D/);
  a.g.control(ctxCmd(0x201, 7), 64);
  assert.equal((a.g.save() as { unsaveable?: string }).unsaveable, undefined);
});

test('virgl cursor: a 3D resource\'s image is read back from the renderer, in its format, and a later update wins', async () => {
  const ram = new Uint8Array(1 << 16);
  const g = new Gpu(() => ram, ram.length, { width: 640, height: 480, virgl: true });
  // The renderer holds B8G8R8A8 bytes: pixel k is (B, G, R, A) = (k, 1, 2, 200).
  const stored = new Uint8Array(64 * 64 * 4).map((_, i) => (i % 4 === 0 ? (i / 4) & 0xff : i % 4 === 3 ? 200 : i % 4));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const reads: number[] = [];
  g.host = { call: () => undefined, fence: () => undefined, read: async (res) => { reads.push(res); await gate; return stored.slice(); } };
  const shown: (Uint8Array | null)[] = [];
  g.hooks = { cursor: (image) => shown.push(image) };
  const cmd = (type: number, ...fields: number[]) => {
    const b = new Uint8Array(24 + 4 * Math.max(fields.length, 8));
    const v = new DataView(b.buffer);
    v.setUint32(0, type, true);
    fields.forEach((f, k) => v.setUint32(24 + 4 * k, f, true));
    return b;
  };
  // RESOURCE_CREATE_3D: id 5, a 2D texture, B8G8R8A8, render target and sampler, 64×64.
  assert.equal(new DataView(g.control(cmd(0x204, 5, 2, 1, 0xa, 64, 64, 1, 1, 0, 0, 0), 64).buffer).getUint32(0, true), 0x1100);
  // UPDATE_CURSOR: scanout 0 at (10, 20), resource 5, hotspot (3, 4).
  g.cursor(cmd(0x300, 0, 10, 20, 0, 5, 3, 4, 0));
  assert.deepEqual(reads, [5]);
  release();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(shown.length, 1);
  assert.deepEqual([...shown[0]!.subarray(0, 8)], [2, 1, 0, 200, 2, 1, 1, 200], 'RGBA from B8G8R8A8');
  // An update (here: hidden) that comes while a read is out wins over the read.
  g.cursor(cmd(0x300, 0, 10, 20, 0, 5, 3, 4, 0));
  g.cursor(cmd(0x300, 0, 10, 20, 0, 0, 0, 0, 0));
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(shown.slice(1), [null]);
});
