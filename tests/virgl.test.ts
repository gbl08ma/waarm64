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
import { CAPS_FIELDS, decodeCaps, virglCaps } from '../web/virgl.ts';
import { capsBacked, capsFromGl, withBits, withoutFormats } from '../web/virgl-caps.ts';
import { FORMATS } from '../web/virgl-formats.ts';
import { clock, FenceGate, fenceSettled, localHost, portHost, queryScheduler, SPIN_MS, type HostCall, type VirglHost } from '../web/virgl-host.ts';
import { VirglRenderer, readbackOf, toHalf, type RendererSnapshot } from '../web/virgl-renderer.ts';
import { replay } from '../web/virgl-replay.ts';
import { generate, parseTgsi, TgsiError, type ProgramKey } from '../web/virgl-tgsi.ts';
import { encodeRecord, encodeTrace, readTrace } from '../web/virgl-trace.ts';
import { ramLayout } from '../web/ram.ts';
import { msg, toWire, type WireError } from '../web/msg.ts';
import { dictionary, findingKey, loadSeeds, makeCase, runTrace } from './virgl-fuzz.ts';
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
  assert.match(generate(mv, parseTgsi('FRAG\nDCL OUT[0], COLOR\n  0: END'), KEY).vs, /uintBitsToFloat\(1u \^ u_zero\)/);
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

test('virgl tgsi: an integer immediate that isn\'t a normal float is no constant expression (dEQP-GLES2 argument_eval_order on Metal: -1 came back a canonical NaN)', () => {
  const fs = parseTgsi('FRAG\nDCL IN[0], GENERIC[0], PERSPECTIVE\nDCL OUT[0], COLOR\n  0: MOV OUT[0], IN[0]\n  1: END');
  const vs = parseTgsi('VERT\nDCL IN[0]\nDCL OUT[0], POSITION\nDCL OUT[1], GENERIC[0]\nIMM[0] UINT32 {4294967295, 1, 1065353216, 2139095040}\n  0: MOV OUT[0], IN[0]\n  1: MOV OUT[1], IMM[0]\n  2: END');
  const p = generate(vs, fs, { ...KEY, attribs: ['f'] });
  // -1 (a NaN's bits), 1 (a denormal's) and +inf go through the uniform; 1.0 stays a literal.
  assert.match(p.vs, /vec4\(uintBitsToFloat\(4294967295u \^ u_zero\), uintBitsToFloat\(1u \^ u_zero\), 1\.0, uintBitsToFloat\(2139095040u \^ u_zero\)\)/, p.vs);
  assert.match(p.vs, /^uniform uint u_zero;$/m);
  assert.doesNotMatch(p.fs, /u_zero/);
});

test('virgl tgsi: x != x is isnan(x), x == x its negation (dEQP-GLES3 common.isnan on Metal, whose fast math folds x != x)', () => {
  const fs = parseTgsi('FRAG\nDCL IN[0], GENERIC[0], PERSPECTIVE\nDCL OUT[0], COLOR\nDCL TEMP[0..1]\n  0: FSNE TEMP[0], IN[0], IN[0]\n  1: FSEQ TEMP[1], IN[0].xyzw, IN[0].xyzw\n  2: FSNE TEMP[0].y, IN[0].xxxx, IN[0].yyyy\n  3: OR OUT[0], TEMP[0], TEMP[1]\n  4: END');
  const vs = parseTgsi('VERT\nDCL IN[0]\nDCL OUT[0], POSITION\nDCL OUT[1], GENERIC[0]\n  0: MOV OUT[0], IN[0]\n  1: MOV OUT[1], IN[0]\n  2: END');
  const p = generate(vs, fs, { ...KEY, attribs: ['f'] });
  assert.match(p.fs, /uvec4\(-ivec4\(isnan\(v_GENERIC0\)\)\)/, p.fs);
  assert.match(p.fs, /not\(isnan\(v_GENERIC0\)\)/);
  assert.match(p.fs, /notEqual\(v_GENERIC0\.xxxx, v_GENERIC0\.yyyy\)/);
});

test('virgl tgsi: an invariant position stays invariant (dEQP-GLES2 shaders.invariance on Metal)', () => {
  const fs = parseTgsi('FRAG\nDCL OUT[0], COLOR\nIMM[0] FLT32 {1.0, 0.0, 0.0, 1.0}\n  0: MOV OUT[0], IMM[0]\n  1: END');
  // Declared, or (Mesa's way) the instructions that compute it marked precise; `_SAT` comes before `_PRECISE`.
  for (const [decl, op, invariant] of [['', 'MUL', false], [', INVARIANT', 'MUL', true], ['', 'MUL_PRECISE', true], ['', 'MUL_SAT_PRECISE', true]] as const) {
    const vs = parseTgsi(`VERT\nDCL IN[0]\nDCL OUT[0], POSITION${decl}\n  0: ${op} OUT[0], IN[0], IN[0]\n  1: END`);
    assert.equal(vs.instrs[0].op, 'MUL');
    assert.equal(vs.instrs[0].sat, op.includes('SAT'));
    const p = generate(vs, fs, { ...KEY, attribs: ['f'] });
    assert.equal(/^invariant gl_Position;$/m.test(p.vs), invariant, p.vs);
  }
});

test('virgl tgsi: a constant blend factor WebGL can\'t pair is applied in the shader; a target without alpha gets the source alpha; z flips for an inverted depth range (dEQP blend, depth_range)', () => {
  const vs = parseTgsi('VERT\nDCL IN[0]\nDCL OUT[0], POSITION\n  0: MOV OUT[0], IN[0]\n  1: END');
  const fs = parseTgsi('FRAG\nDCL OUT[0], COLOR\nIMM[0] FLT32 {1.0, 0.5, 0.25, 1.0}\n  0: MOV OUT[0], IMM[0]\n  1: END');
  const plain = generate(vs, fs, { ...KEY, attribs: ['f'] });
  assert.ok(!plain.fs.includes('u_blendc'));
  assert.ok(plain.vs.includes('gl_Position.z = gl_Position.z * u_adjz.x + gl_Position.w * u_adjz.y;'));
  for (const [f, e] of [[7, 'u_blendc.rgb'], [0x17, '(1.0 - u_blendc.rgb)'], [8, 'vec3(u_blendc.a)'], [0x18, 'vec3(1.0 - u_blendc.a)']] as const) {
    const p = generate(vs, fs, { ...KEY, attribs: ['f'], cbufs: [{ type: 'f', write: [0, 1, 2, 3], blendSrc: f }] });
    assert.ok(p.fs.includes('uniform vec4 u_blendc;'), p.fs);
    assert.ok(p.fs.includes(`vec4(col0.rgb * ${e}, col0.a)`), p.fs);
  }
  // Per buffer (independent blending): only the buffer whose blend pairs them.
  const fs2 = parseTgsi('FRAG\nDCL OUT[0], COLOR\nDCL OUT[1], COLOR[1]\nIMM[0] FLT32 {1.0, 0.5, 0.25, 1.0}\n  0: MOV OUT[0], IMM[0]\n  1: MOV OUT[1], IMM[0]\n  2: END');
  const two = generate(vs, fs2, { ...KEY, attribs: ['f'], cbufs: [{ type: 'f', write: [0, 1, 2, 3] }, { type: 'f', write: [0, 1, 2, 3], blendSrc: 7 }] });
  assert.ok(two.fs.includes('o0 = vec4(col0.x, col0.y, col0.z, col0.w);') && two.fs.includes('vec4(col1.rgb * u_blendc.rgb, col1.a)') && !two.fs.includes('col0.rgb *'), two.fs);
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
  const r = new VirglRenderer(gl, { ram: () => [new Uint8Array(0)], log: (m) => errors.push(m) });
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
  const r = new VirglRenderer(gl, { ram: () => [new Uint8Array(0)], log: (m) => errors.push(m) });
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
  const r = new VirglRenderer(gl, { ram: () => [new Uint8Array(0)], log: (m) => errors.push(m) });
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
  const r = new VirglRenderer(gl, { ram: () => [ram], log: (m) => errors.push(m) });
  r.createContext(1);
  r.createResource({ id: 1, target: 2, format: 2, bind: 8, width: 64, height: 32, depth: 1, arraySize: 1, lastLevel: 1, samples: 0, flags: 0 });
  r.attachBacking(1, [{ off: 0, len: ram.length, mem: 0 }]);
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
  const r = new VirglRenderer(gl, { ram: () => [new Uint8Array(0)], log: (m) => errors.push(m) });
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

test('virgl renderer: a shader with stream outputs draws through one program, captured or not (dEQP-GLES3 transform_feedback lines on Metal)', () => {
  const gl = mockGl();
  gl.keepLog = true;
  const errors: string[] = [];
  const r = new VirglRenderer(gl, { ram: () => [new Uint8Array(0)], log: (m) => errors.push(m) });
  r.createContext(1);
  const buffer = (id: number, width: number, bind: number) => { r.createResource({ id, target: 0, format: 64, bind, width, height: 1, depth: 1, arraySize: 1, lastLevel: 0, samples: 0, flags: 0 }); r.attach(1, id); };
  buffer(1, 256, 0x10); // vertices
  buffer(2, 256, 0x800); // the capture's target
  const words: number[] = [];
  const cmd = (c: number, obj: number, ...p: number[]) => words.push(c | obj << 8 | p.length << 16, ...p);
  const text = (src: string) => { const b = new TextEncoder().encode(src + '\0'); const w = new Uint32Array(Math.ceil(b.length / 4)); new Uint8Array(w.buffer).set(b); return [b.length, ...w]; };
  // The vertex shader captures OUT[1] (4 components) into buffer 0, stride 4 words.
  const [vlen, ...vt] = text('VERT\nDCL IN[0]\nDCL OUT[0], POSITION\nDCL OUT[1], GENERIC[0]\n  0: MOV OUT[0], IN[0]\n  1: MOV OUT[1], IN[0]\n  2: END\n');
  cmd(1, 4, 10, 0, vlen, 0, 1, 4, 0, 0, 0, 1 | 4 << 10, 0, ...vt);
  const [flen, ...ft] = text('FRAG\nDCL IN[0], GENERIC[0], PERSPECTIVE\nDCL OUT[0], COLOR\n  0: MOV OUT[0], IN[0]\n  1: END\n');
  cmd(1, 4, 11, 1, flen, 0, 0, ...ft);
  cmd(31, 0, 10, 0); cmd(31, 0, 11, 1);
  cmd(1, 5, 20, 0, 0, 0, 31); cmd(2, 5, 20);
  cmd(1, 2, 21, 1 << 1, 0x3f800000, 0, 0, 0x3f800000, 0, 0, 0); cmd(2, 2, 21);
  r.createResource({ id: 3, target: 2, format: 2, bind: 2, width: 4, height: 4, depth: 1, arraySize: 1, lastLevel: 0, samples: 0, flags: 0 });
  r.attach(1, 3);
  cmd(1, 8, 22, 3, 2, 0, 0);
  cmd(5, 0, 1, 0, 22);
  cmd(6, 0, 16, 0, 1);
  cmd(1, 10, 30, 2, 0, 256); // a stream output target on buffer 2
  const draw = () => cmd(8, 0, 0, 2, 1, 0, 1, 0, 0, 0, 0, 0, 1, 0); // a line
  draw(); // not captured
  cmd(25, 0, 0, 30); draw(); // captured
  cmd(25, 0, 0); draw(); // not captured again
  r.submit(1, new Uint32Array(words));
  assert.deepEqual(errors, []);
  const programs = gl.log.filter(([n]) => n === 'useProgram').map(([, a]) => a[0]);
  assert.equal(gl.log.filter(([n]) => n === 'drawArrays').length, 3);
  assert.equal(new Set(programs).size, 1, 'one program, transform feedback on or off');
  assert.equal(gl.log.filter(([n]) => n === 'beginTransformFeedback').length, 1);
  assert.deepEqual(gl.log.filter(([n]) => n === 'transformFeedbackVaryings').map(([, a]) => a[1]), [['tf_0']]);
});

/** Commands setting up a draw (a red triangle into resource 3, 4×4, vertices in resource 1), and the draw itself. */
function drawable(r: VirglRenderer, ctx = 1) {
  r.createResource({ id: 1, target: 0, format: 64, bind: 0x10, width: 64, height: 1, depth: 1, arraySize: 1, lastLevel: 0, samples: 0, flags: 0 });
  r.createResource({ id: 3, target: 2, format: 67, bind: 2, width: 4, height: 4, depth: 1, arraySize: 1, lastLevel: 0, samples: 0, flags: 0 });
  r.attach(ctx, 1); r.attach(ctx, 3);
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
  return { setup: words, draw: [8 | 12 << 16, 0, 3, 4, 0, 1, 0, 0, 0, 0, 0, 2, 0] };
}

test('virgl renderer: independent blending and clip control through the browser\'s extensions, the first buffer\'s state for all without them (dEQP-GLES3 draw_buffers_indexed, dEQP-GLES2 clip_control)', () => {
  const f = (x: number) => new Uint32Array(new Float32Array([x]).buffer)[0];
  const run = (extensions?: string[]) => {
    const gl = mockGl(extensions ? { extensions } : {});
    gl.keepLog = true;
    const errors: string[] = [];
    const r = new VirglRenderer(gl, { ram: () => [new Uint8Array(0)], log: (m) => errors.push(m) });
    r.createContext(1);
    const d = drawable(r);
    r.createResource({ id: 4, target: 2, format: 67, bind: 2, width: 4, height: 4, depth: 1, arraySize: 1, lastLevel: 0, samples: 0, flags: 0 });
    r.attach(1, 4);
    const words: number[] = [];
    const cmd = (c: number, obj: number, ...p: number[]) => words.push(c | obj << 8 | p.length << 16, ...p);
    const text = (src: string) => { const b = new TextEncoder().encode(src + '\0'); const w = new Uint32Array(Math.ceil(b.length / 4)); new Uint8Array(w.buffer).set(b); return [b.length, ...w]; };
    const [len, ...t] = text('FRAG\nDCL OUT[0], COLOR\nDCL OUT[1], COLOR[1]\nIMM[0] FLT32 {1.0, 0.0, 0.0, 0.5}\n  0: MOV OUT[0], IMM[0]\n  1: MOV OUT[1], IMM[0]\n  2: END\n');
    cmd(1, 4, 12, 1, len, 0, 0, ...t); cmd(31, 0, 12, 1);
    cmd(1, 8, 23, 4, 67, 0, 0);
    cmd(5, 0, 2, 0, 22, 23);
    // Independent: buffer 0 blends SRC_ALPHA, ONE_MINUS_SRC_ALPHA (all of RGBA written); buffer 1 constant color with
    // one minus constant alpha (which WebGL can't pair: folded into the shader), only R written.
    const rt = (on: number, src: number, dst: number, mask: number) => on | src << 4 | dst << 9 | 1 << 17 | 0x11 << 22 | mask << 27;
    cmd(1, 1, 30, 1, 0, rt(1, 0x3, 0x13, 0xf), rt(1, 0x7, 0x18, 0x1), 0, 0, 0, 0, 0, 0); cmd(2, 1, 30);
    // A rasterizer with clip_halfz (bit 2), and a depth range inverted: z 0.75 at clip z 0, 0.25 at clip z 1.
    cmd(1, 2, 24, 1 << 1 | 1 << 2, f(1), 0, 0, f(1), 0, 0, 0); cmd(2, 2, 24);
    cmd(4, 0, 0, f(2), f(2), f(-0.5), f(2), f(2), f(0.75));
    r.submit(1, new Uint32Array([...d.setup, ...words, ...d.draw]));
    assert.deepEqual(errors, []);
    const at = gl.log.findIndex(([n]) => n === 'drawArrays');
    assert.ok(at >= 0, 'drawn');
    const before = gl.log.slice(0, at);
    const calls = (n: string) => before.filter(([m]) => m === n).map(([, a]) => a);
    const fs = calls('shaderSource').map((a) => String(a[1])).find((x) => x.includes('out vec4 o1'))!;
    return { calls, fs };
  };
  const ext = run(['OES_draw_buffers_indexed', 'EXT_clip_control']);
  assert.deepEqual(ext.calls('enableiOES'), [[E.BLEND, 0], [E.BLEND, 1]]);
  assert.deepEqual(ext.calls('blendFuncSeparateiOES'), [[0, E.SRC_ALPHA, E.ONE_MINUS_SRC_ALPHA, E.ONE, E.ZERO], [1, E.ONE, E.ONE_MINUS_CONSTANT_ALPHA, E.ONE, E.ZERO]]);
  assert.ok(ext.fs.includes('vec4(col1.rgb * u_blendc.rgb, col1.a)') && !ext.fs.includes('col0.rgb *'), ext.fs);
  assert.deepEqual(ext.calls('colorMaskiOES'), [[0, true, true, true, true], [1, true, false, false, false]]);
  assert.deepEqual(ext.calls('clipControlEXT'), [[E.LOWER_LEFT_EXT, E.ZERO_TO_ONE_EXT]]);
  // 0 to 1 turned round by z' = w - z, into the range the right way round.
  assert.deepEqual(ext.calls('uniform2f').map((a) => a.slice(1)), [[-1, 1]]);
  assert.deepEqual(ext.calls('depthRange'), [[0.25, 0.75]]);
  // Without: the first buffer's blend and mask for all, -1 to 1 (the caps then offer neither).
  const plain = run();
  assert.deepEqual(plain.calls('enableiOES'), []);
  assert.deepEqual(plain.calls('blendFuncSeparate'), [[E.SRC_ALPHA, E.ONE_MINUS_SRC_ALPHA, E.ONE, E.ZERO]]);
  assert.deepEqual(plain.calls('colorMask').at(-1), [true, true, true, true]);
  assert.ok(!plain.fs.includes('u_blendc'), plain.fs);
  assert.deepEqual(plain.calls('clipControlEXT'), []);
  assert.deepEqual(plain.calls('uniform2f').map((a) => a.slice(1)), [[-1, 0]]);
});

test('virgl renderer: the blend color\'s alpha is the guest\'s on a target that stores no alpha (dEQP-GLES3 draw_buffers_indexed.random, RGB565 first)', () => {
  const f = (x: number) => new Uint32Array(new Float32Array([x]).buffer)[0];
  const gl = mockGl();
  gl.keepLog = true;
  const errors: string[] = [];
  const r = new VirglRenderer(gl, { ram: () => [new Uint8Array(0)], log: (m) => errors.push(m) });
  r.createContext(1);
  const d = drawable(r);
  r.createResource({ id: 4, target: 2, format: 7, bind: 2, width: 4, height: 4, depth: 1, arraySize: 1, lastLevel: 0, samples: 0, flags: 0 });
  r.attach(1, 4);
  const words: number[] = [];
  const cmd = (c: number, obj: number, ...p: number[]) => words.push(c | obj << 8 | p.length << 16, ...p);
  cmd(1, 8, 23, 4, 7, 0, 0);
  cmd(5, 0, 1, 0, 23);
  // ONE_MINUS_DST_ALPHA, ONE_MINUS_CONSTANT_ALPHA on B5G6R5, the blend color (0.1, 0.2, 0.3, 0.25).
  cmd(1, 1, 30, 0, 0, 1 | 0x14 << 4 | 0x18 << 9 | 1 << 17 | 0x11 << 22 | 0xf << 27, 0, 0, 0, 0, 0, 0, 0); cmd(2, 1, 30);
  cmd(14, 0, f(0.1), f(0.2), f(0.3), f(0.25));
  r.submit(1, new Uint32Array([...d.setup, ...words, ...d.draw]));
  assert.deepEqual(errors, []);
  const bc = gl.log.filter(([n]) => n === 'blendColor').at(-1)![1] as number[];
  assert.deepEqual(bc.map((x) => Math.round(x * 100) / 100), [0.1, 0.2, 0.3, 0.25]);
});

test('virgl renderer: a fence waits for the occlusion queries before it (dEQP-GLES3 occlusion_query: results after glFinish)', () => {
  const gl = mockGl();
  let available = false;
  (gl as unknown as { getQueryParameter: unknown }).getQueryParameter = (_q: unknown, p: number) => (p === E.QUERY_RESULT_AVAILABLE ? available : 1);
  const ram = new Uint8Array(64);
  const errors: string[] = [];
  const r = new VirglRenderer(gl, { ram: () => [ram], log: (m) => errors.push(m) });
  r.createContext(1);
  r.createResource({ id: 5, target: 0, format: 64, bind: 0x800, width: 64, height: 1, depth: 1, arraySize: 1, lastLevel: 0, samples: 0, flags: 0 });
  r.attach(1, 5);
  r.attachBacking(5, [{ off: 0, len: 64, mem: 0 }]);
  const answered: string[] = [];
  const gate = new FenceGate<string>((f) => answered.push(f));
  gate.fence('before', r.queriesSettled());
  // An occlusion predicate (virgl's type 1), its state in resource 5: begun, a draw, ended.
  const d = drawable(r);
  r.submit(1, new Uint32Array([...d.setup, 1 | 9 << 8 | 4 << 16, 40, 1, 0, 5, 19 | 1 << 16, 40, ...d.draw, 20 | 1 << 16, 40]));
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

// PERF loop 16: pending queries are looked at every task for SPIN_MS since the pending set last changed, then every 4 ms.
// The scheduler's clock is the test's (each look 0.1 ms on), and its 4 ms timers are counted: what the poll decides,
// whatever the host's load.
const spinLooks = async (looks: number, changes: (look: number) => number) => {
  const real = globalThis.setTimeout;
  let timers = 0, look = 0, now = 0, done!: () => void;
  const finished = new Promise<void>((ok) => { done = ok; });
  globalThis.setTimeout = ((f: () => void, ms?: number) => (ms === 4 && timers++, real(f, ms))) as typeof setTimeout;
  try {
    const s = queryScheduler('spin', () => {
      now += 0.1;
      if (++look < looks) s.next(1, changes(look));
      else { s.idle(); done(); }
    }, undefined, () => now);
    s.next(1, changes(0));
    await finished;
  } finally {
    globalThis.setTimeout = real;
  }
  return timers;
};

test('queries: the poll spins at every task for SPIN_MS after a change, then waits 4 ms a look', async () => {
  // One pending, unchanged: SPIN_MS / 0.1 looks at every task, then the rest by the timer.
  const timers = await spinLooks(30, () => 1);
  assert.ok(timers >= 9 && timers <= 11, `the looks after SPIN_MS by the 4 ms timer (${timers} of 30)`);
});

// PERF loop 20: a client that keeps one query in flight (one ended as the last settles) keeps the count at 1 while the
// set turns over; the poll follows the set (`changes`), so it keeps spinning.
test('queries: the poll keeps spinning while the pending set turns over at a steady count', async () => {
  // Every 10 looks (1 ms, under SPIN_MS) query N settles and N+1 is pending in its place.
  const timers = await spinLooks(100, (look) => Math.floor(look / 10));
  assert.equal(timers, 0, 'no look by the 4 ms timer');
});

// VK4 R1: a submit held for a signal the guest sends later (a CPU vkSignalSemaphore) holds its ring's fences only.
test('fences: a held fence of one lane holds its lane, not the others or the unnamed one', () => {
  const answered: string[] = [];
  const gate = new FenceGate<string>((f) => answered.push(f));
  let a = false, b = false;
  gate.fence('held', () => a, '3:1');
  gate.fence('virgl', () => true);
  gate.fence('other ring', () => true, '3:2');
  gate.fence('other context', () => b, '4:1');
  gate.fence('behind it', () => true, '3:1');
  assert.deepEqual(answered, ['virgl', 'other ring']);
  gate.fence('virgl later', () => true);
  assert.deepEqual(answered, ['virgl', 'other ring', 'virgl later']);
  assert.equal(gate.waiting, 3);
  b = true;
  gate.release();
  assert.deepEqual(answered.slice(3), ['other context'], 'each lane on its own');
  assert.equal(gate.oldest, undefined, 'the oldest held of the unnamed lane: the others wait for what the guest does');
  a = true;
  gate.release();
  assert.deepEqual(answered.slice(4), ['held', 'behind it'], 'in order in a lane');
});

test('fences: a fence in the unnamed lane still waits for those before it there', () => {
  const answered: string[] = [];
  const gate = new FenceGate<string>((f) => answered.push(f));
  let ready = false;
  gate.fence('first', () => ready);
  gate.fence('second', () => true);
  gate.fence('lane', () => true, '1:1');
  assert.deepEqual(answered, ['lane']);
  assert.equal(gate.oldest, 'first');
  ready = true;
  gate.release();
  assert.deepEqual(answered, ['lane', 'first', 'second']);
});

test('fences: what a fence waits for follows its scope', () => {
  const asked: unknown[] = [];
  let queries = false, backlog = false, retired = new Set<bigint>();
  const venus = { retired(ctx: number, ring: number, id: bigint) { asked.push([ctx, ring, id]); return retired.has(id); } };
  const host = { queries: () => () => queries, backlog: () => backlog, venus: () => venus as typeof venus | undefined };
  const virgl = fenceSettled(undefined, host);
  assert.equal(virgl(), false, 'virgl\'s waits for its queries');
  queries = true;
  assert.equal(virgl(), true, 'and for nothing of Venus\'s');
  assert.deepEqual(asked, []);
  backlog = true;
  assert.equal(virgl(), false, 'but the calls waiting for the renderer are before it');
  const ring = fenceSettled({ ctx: 3, ring: 1, id: 5n, ringed: true }, host);
  retired = new Set([5n]);
  assert.equal(ring(), false, 'its submit hasn\'t run');
  backlog = false;
  queries = false;
  assert.equal(ring(), true, 'a ring\'s fence waits for no queries');
  assert.deepEqual(asked, [[3, 1, 5n]]);
  host.venus = () => undefined;
  assert.equal(fenceSettled({ ctx: 3, ring: 1, id: 6n, ringed: true }, host)(), true, 'no renderer, nothing to wait for');
});

// dEQP's timeline_semaphore.device_host: a fence checked late, behind another of its ring, once took in the fences sent
// after it, and one of those waited for what the guest does after this one: every case hung.
test('fences: a fence held behind another of its ring doesn\'t wait for those after it', () => {
  const answered: string[] = [];
  const gate = new FenceGate<string>((f) => answered.push(f));
  const pending = new Set([1n, 2n, 3n]);
  const venus = { retired: (_c: number, _r: number, id: bigint) => !pending.has(id) };
  const host = { queries: () => () => true, backlog: () => false, venus: () => venus };
  const fence = (id: bigint) => gate.fence(`f${id}`, fenceSettled({ ctx: 3, ring: 1, id, ringed: true }, host), '3:1');
  fence(1n);
  fence(2n);
  fence(3n); // held for the guest's signal, which follows f2's answer
  pending.delete(1n);
  gate.release();
  pending.delete(2n);
  gate.release();
  assert.deepEqual(answered, ['f1', 'f2']);
});

test('portHost: fences answered out of order end only themselves', async () => {
  const ch = new MessageChannel();
  const host = portHost(ch.port1);
  const sent: { id: number; scope?: unknown }[] = [];
  ch.port2.onmessage = (e) => { sent.push(e.data); };
  const done: string[] = [];
  const until = async (ok: () => boolean) => { for (let k = 0; k < 500 && !ok(); k++) await new Promise((r) => setTimeout(r, 2)); };
  const ring = host.fence({ ctx: 3, ring: 1, id: 1n, ringed: true })!.then(() => done.push('ring'));
  const virgl = host.fence()!.then(() => done.push('virgl'));
  try {
    await until(() => sent.length === 2);
    assert.deepEqual(sent.map((s) => s.scope), [{ ctx: 3, ring: 1, id: 1n, ringed: true }, undefined]);
    ch.port2.postMessage({ t: 'fenced', id: sent[1].id, at: clock() });
    await virgl;
    assert.deepEqual(done, ['virgl'], 'the ring\'s stays');
    ch.port2.postMessage({ t: 'fenced', id: sent[0].id, at: clock() });
    await ring;
    assert.deepEqual(done, ['virgl', 'ring']);
  } finally {
    // Its watch on unanswered fences ends once they're answered.
    for (const m of sent) ch.port2.postMessage({ t: 'fenced', id: m.id, at: clock() });
    await until(() => done.length === 2);
    await new Promise((r) => setTimeout(r, 1100));
    ch.port1.close();
    ch.port2.close();
  }
});

test('virgl renderer: a query destroyed before its result holds no fence (dEQP-GLES3 hung at a context\'s end)', () => {
  const gl = mockGl();
  // A deleted query's result never becomes available.
  (gl as unknown as { getQueryParameter: unknown }).getQueryParameter = (_q: unknown, p: number) => (p === E.QUERY_RESULT_AVAILABLE ? false : null);
  const ram = new Uint8Array(64);
  const errors: string[] = [];
  const r = new VirglRenderer(gl, { ram: () => [ram], log: (m) => errors.push(m) });
  r.createContext(1);
  r.createResource({ id: 5, target: 0, format: 64, bind: 0x800, width: 64, height: 1, depth: 1, arraySize: 1, lastLevel: 0, samples: 0, flags: 0 });
  r.attach(1, 5);
  r.attachBacking(5, [{ off: 0, len: 64, mem: 0 }]);
  const answered: string[] = [];
  const gate = new FenceGate<string>((f) => answered.push(f));
  // An occlusion predicate begun, a draw, ended, then destroyed (DESTROY_OBJECT) with its result pending.
  const d = drawable(r);
  r.submit(1, new Uint32Array([...d.setup, 1 | 9 << 8 | 4 << 16, 40, 1, 0, 5, 19 | 1 << 16, 40, ...d.draw, 20 | 1 << 16, 40]));
  assert.equal(r.pollQueries(), 1, 'pending');
  r.submit(1, new Uint32Array([3 | 9 << 8 | 1 << 16, 40]));
  assert.deepEqual(errors, []);
  gate.fence('after', r.queriesSettled());
  r.pollQueries();
  gate.release();
  assert.deepEqual(answered, ['after']);
  assert.equal(r.pollQueries(), 0, 'nothing left to poll');
});

test('virgl renderer: an occlusion query without a draw has its result at once; one WebGL never answers counts as samples passed', () => {
  const gl = mockGl();
  // A query WebGL refused, or a lost context's: its result never comes (null).
  (gl as unknown as { getQueryParameter: unknown }).getQueryParameter = () => null;
  const ram = new Uint8Array(64);
  const errors: string[] = [];
  const r = new VirglRenderer(gl, { ram: () => [ram], log: (m) => errors.push(m) });
  r.createContext(1);
  r.createResource({ id: 5, target: 0, format: 64, bind: 0x800, width: 64, height: 1, depth: 1, arraySize: 1, lastLevel: 0, samples: 0, flags: 0 });
  r.attach(1, 5);
  r.attachBacking(5, [{ off: 0, len: 64, mem: 0 }]);
  const d = drawable(r);
  const dv = new DataView(ram.buffer);
  // Begun and ended with no draw: done, nothing passed.
  r.submit(1, new Uint32Array([...d.setup, 1 | 9 << 8 | 4 << 16, 40, 1, 0, 5, 19 | 1 << 16, 40, 20 | 1 << 16, 40]));
  assert.deepEqual([dv.getUint32(0, true), Number(dv.getBigUint64(8, true))], [1, 0]);
  assert.equal(r.pollQueries(), 0);
  // With a draw: pending, then settled as passed when WebGL says it never will.
  const answered: string[] = [];
  const gate = new FenceGate<string>((f) => answered.push(f));
  r.submit(1, new Uint32Array([19 | 1 << 16, 40, ...d.draw, 20 | 1 << 16, 40]));
  assert.equal(dv.getUint32(0, true), 2);
  gate.fence('after', r.queriesSettled());
  assert.equal(r.pollQueries(), 0);
  gate.release();
  assert.deepEqual(answered, ['after']);
  assert.deepEqual([dv.getUint32(0, true), Number(dv.getBigUint64(8, true))], [1, 1]);
  assert.deepEqual(errors, ['an occlusion query has no result (taken as samples passed)']);
});

test('virgl renderer: occlusion queries count their own sub-context\'s draws: WebGL\'s one query paused when another draws, or a blit', () => {
  const gl = mockGl();
  gl.keepLog = true;
  // No result comes until the end (then: samples passed).
  let available = false;
  (gl as unknown as { getQueryParameter: unknown }).getQueryParameter = (_q: unknown, p: number) => (p === E.QUERY_RESULT_AVAILABLE ? available : 1);
  const errors: string[] = [];
  const r = new VirglRenderer(gl, { ram: () => [new Uint8Array(0)], log: (m) => errors.push(m) });
  r.createContext(1);
  r.createContext(2);
  r.createResource({ id: 5, target: 0, format: 64, bind: 0x800, width: 64, height: 1, depth: 1, arraySize: 1, lastLevel: 0, samples: 0, flags: 0 });
  r.attach(1, 5); r.attach(2, 5);
  const d = drawable(r);
  r.attach(2, 1); r.attach(2, 3);
  const q = (h: number, offset: number) => [1 | 9 << 8 | 4 << 16, h, 1, offset, 5];
  const ops = (from: number) => gl.log.slice(from).filter(([n]) => n === 'beginQuery' || n === 'endQuery' || n === 'drawArrays' || n === 'blitFramebuffer').map(([n]) => n);
  r.submit(1, new Uint32Array(d.setup));
  r.submit(2, new Uint32Array(d.setup));
  // Context 1 begins and draws twice (one span); context 2 draws (context 1's span ended at its submit's end), begins
  // its own, draws; context 1 draws again (a new span) and ends.
  let at = gl.log.length;
  r.submit(1, new Uint32Array([...q(40, 0), 19 | 1 << 16, 40, ...d.draw, ...d.draw]));
  assert.equal(ops(at).at(-1), 'endQuery', 'paused when the submit ends: the screen draws on the same context');
  r.submit(2, new Uint32Array([...d.draw, ...q(41, 16), 19 | 1 << 16, 41, ...d.draw]));
  r.submit(1, new Uint32Array([...d.draw, 20 | 1 << 16, 40]));
  assert.deepEqual(ops(at), ['beginQuery', 'drawArrays', 'drawArrays', 'endQuery', 'drawArrays', 'beginQuery', 'drawArrays', 'endQuery', 'beginQuery', 'drawArrays', 'endQuery']);
  // Sub-contexts: 1 begins and draws in sub-context 1, then sub-context 0 draws (paused there) and 1 draws again.
  at = gl.log.length;
  r.submit(1, new Uint32Array([29 | 1 << 16, 1, 28 | 1 << 16, 1, ...d.setup, ...q(42, 32), 19 | 1 << 16, 42, ...d.draw, 28 | 1 << 16, 0, ...d.draw, 28 | 1 << 16, 1, ...d.draw, 20 | 1 << 16, 42]));
  assert.deepEqual(ops(at), ['beginQuery', 'drawArrays', 'endQuery', 'drawArrays', 'beginQuery', 'drawArrays', 'endQuery']);
  // A blit while a query is active counts nothing: paused before it, a new span at the next draw.
  r.createResource({ id: 4, target: 2, format: 67, bind: 2, width: 4, height: 4, depth: 1, arraySize: 1, lastLevel: 0, samples: 0, flags: 0 });
  r.attach(1, 4);
  at = gl.log.length;
  r.submit(1, new Uint32Array([19 | 1 << 16, 42, ...d.draw, 16 | 21 << 16, 0xf, 0, 0, 3, 0, 67, 0, 0, 0, 4, 4, 1, 4, 0, 67, 0, 0, 0, 4, 4, 1, ...d.draw, 20 | 1 << 16, 42]));
  assert.deepEqual(ops(at), ['beginQuery', 'drawArrays', 'endQuery', 'blitFramebuffer', 'beginQuery', 'drawArrays', 'endQuery']);
  // A query left active while another context draws: once a span has passed, no more spans (they'd pile up).
  available = true;
  r.pollQueries();
  at = gl.log.length;
  r.submit(1, new Uint32Array([19 | 1 << 16, 42, ...d.draw]));
  r.submit(2, new Uint32Array(d.draw));
  r.submit(1, new Uint32Array(d.draw));
  r.submit(2, new Uint32Array(d.draw));
  r.submit(1, new Uint32Array([...d.draw, 20 | 1 << 16, 42]));
  assert.deepEqual(ops(at), ['beginQuery', 'drawArrays', 'endQuery', 'drawArrays', 'drawArrays', 'drawArrays', 'drawArrays']);
  assert.equal(r.pollQueries(), 0, 'done when it ended: a span passed');
  assert.deepEqual(errors, []);
});

test('virgl renderer: a shader object destroyed deletes the programs made with it (the cache grew for good over a desktop session)', () => {
  const gl = mockGl();
  gl.keepLog = true;
  const errors: string[] = [];
  const r = new VirglRenderer(gl, { ram: () => [new Uint8Array(0)], log: (m) => errors.push(m) });
  r.createContext(1);
  const d = drawable(r);
  const count = (n: string) => gl.log.filter(([m]) => m === n).length;
  r.submit(1, new Uint32Array([...d.setup, ...d.draw]));
  assert.equal(count('linkProgram'), 1);
  // The fragment shader's object destroyed (DESTROY_OBJECT, shader 11), made again from the same text and drawn.
  r.submit(1, new Uint32Array([3 | 4 << 8 | 1 << 16, 11]));
  assert.equal(count('deleteProgram'), 1, 'its program deleted');
  r.submit(1, new Uint32Array([...d.setup, ...d.draw]));
  assert.equal(count('linkProgram'), 2, 'linked again for the new object');
  // The context destroyed: both shaders go, and the program with them.
  r.destroyContext(1);
  assert.equal(count('deleteProgram'), 2);
  assert.deepEqual(errors, []);
});

test('virgl renderer: a sampler with no view samples nothing: another context\'s texture and sampler unbound from its unit', () => {
  const gl = mockGl();
  gl.keepLog = true;
  const errors: string[] = [];
  const r = new VirglRenderer(gl, { ram: () => [new Uint8Array(0)], log: (m) => errors.push(m) });
  r.createContext(1);
  const d = drawable(r);
  const text = (src: string) => { const b = new TextEncoder().encode(src + '\0'); const w = new Uint32Array(Math.ceil(b.length / 4)); new Uint8Array(w.buffer).set(b); return [b.length, ...w]; };
  const [len, ...t] = text('FRAG\nDCL OUT[0], COLOR\nDCL SAMP[0]\nDCL SVIEW[0], CUBE, FLOAT\nIMM[0] FLT32 {0.5, 0.5, 0.5, 0.0}\n  0: TEX OUT[0], IMM[0], SAMP[0], CUBE\n  1: END\n');
  const at = gl.log.length;
  r.submit(1, new Uint32Array([...d.setup, 1 | 4 << 8 | (5 + t.length) << 16, 12, 1, len, 0, 0, ...t, 31 | 2 << 16, 12, 1, ...d.draw]));
  assert.deepEqual(errors, []);
  const calls = gl.log.slice(at).map(([n, a]) => `${n} ${(a as unknown[]).map((x) => (x === null ? 'null' : typeof x === 'number' ? x : 'obj')).join(' ')}`);
  assert.ok(calls.includes(`bindTexture ${E.TEXTURE_CUBE_MAP} null`), 'no cube map left on the unit');
  assert.ok(calls.some((c) => /^bindSampler \d+ null$/.test(c)), 'no sampler left on the unit');
});

test('virgl renderer: a multisampled source is resolved before a conversion or a flip (dEQP-GLES3 fbo.invalidate unbind_blit_msaa)', () => {
  const gl = mockGl();
  gl.keepLog = true;
  const errors: string[] = [];
  const r = new VirglRenderer(gl, { ram: () => [new Uint8Array(0)], log: (m) => errors.push(m) });
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
  const r = new VirglRenderer(gl, { ram: () => [new Uint8Array(0)], log: (m) => errors.push(m) });
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
  const ctx = { ram: () => [ram], layout: ramLayout(ram.length), complete: (w0: number) => done.push(w0), config: () => new Uint8Array(16), changeConfig: () => {}, untaken: () => 0, features: () => 0n };
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
    return { queue: 0, w0: at, read: [{ off: at, len: 24 + 4 * fields.length, mem: 0 }], write: [{ off: at + 2048, len: 64, mem: 0 }] };
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
  // Independent blending and clip control where the browser has their extensions.
  const ext = decodeCaps(capsFromGl(mockGl({ extensions: ['OES_draw_buffers_indexed', 'EXT_clip_control'] })));
  assert.equal((ext.bset as number) & 3, 3);
  assert.equal((plain.bset as number) & 3, 0);
  assert.ok((ext.capability_bits as number) & (1 << 27) && !((plain.capability_bits as number) & (1 << 27)));
  assert.match(capsBacked(capsFromGl(mockGl({ extensions: ['OES_draw_buffers_indexed'] })), capsFromGl(mockGl({ extensions: [] })))!, /bset lacks 3/);
  assert.match(capsBacked(capsFromGl(mockGl({ extensions: ['EXT_clip_control'] })), capsFromGl(mockGl({ extensions: [] })))!, /capability_bits lacks 8000000/);
  // A machine saved where s3tc was there doesn't restore its 3D where it isn't.
  assert.equal(capsBacked(capsFromGl(mockGl({ extensions: [] })), capsFromGl(mockGl({ extensions: ['WEBGL_compressed_texture_s3tc'] }))), null);
  assert.match(capsBacked(capsFromGl(mockGl({ extensions: ['WEBGL_compressed_texture_s3tc'] })), capsFromGl(mockGl({ extensions: [] })))!, /sampler lacks formats/);
  assert.match(capsBacked(capsFromGl(mockGl({ params: { [0xd33]: 16384 } })), capsFromGl(mockGl()))!, /max_texture_2d_size/);
});

test('virgl renderer: half floats round to nearest even', () => {
  assert.deepEqual([1, -2, 0.5, 65504, 1e-8, Infinity, 1 + 2 ** -11, 1 + 3 * 2 ** -11].map(toHalf), [0x3c00, 0xc000, 0x3800, 0x7bff, 0, 0x7c00, 0x3c00, 0x3c02]);
});

test('virgl caps: `?gpu=capsno=` takes formats out of every mask and leaves the rest of the caps as they were', () => {
  const caps = capsFromGl(mockGl({ extensions: [] }));
  const { caps: cut, unknown } = withoutFormats(caps, ['Z24_UNORM_S8_UINT', 'X8B8G8R8_UNORM', 'NOT_A_FORMAT']);
  assert.deepEqual(unknown, ['NOT_A_FORMAT']);
  const id = (name: string) => [...FORMATS.values()].find((f) => f.name === name)!.id;
  const a = decodeCaps(caps), b = decodeCaps(cut);
  for (const mask of ['sampler', 'render', 'depthstencil', 'supported_multisample_formats', 'scanout', 'supported_readback_formats']) {
    const want = (a[mask] as number[]).filter((f) => f !== id('Z24_UNORM_S8_UINT') && f !== id('X8B8G8R8_UNORM'));
    assert.deepEqual(b[mask], want, mask);
  }
  assert.ok((a.depthstencil as number[]).includes(id('Z24_UNORM_S8_UINT')), 'it was there');
  // Everything else byte for byte.
  const masks = new Set<number>();
  for (const [, at, n, kind] of CAPS_FIELDS) if (kind === 'm') for (let k = at * 4; k < (at + n) * 4; k++) masks.add(k);
  for (let k = 0; k < caps.length; k++) if (!masks.has(k)) assert.equal(cut[k], caps[k], `byte ${k}`);
  assert.equal(withoutFormats(caps, []).caps, caps);
});

test('virgl caps: `?gpu=capsyes=` sets the bits named, in their words, and nothing else', () => {
  const caps = capsFromGl(mockGl({ extensions: [] }));
  const { caps: set, unknown } = withBits(caps, ['COPY_IMAGE', 'INDIRECT_INPUT_ADDR', 'V2_BLEND_EQUATION', 'NOT_A_BIT']);
  assert.deepEqual(unknown, ['NOT_A_BIT']);
  const a = decodeCaps(caps), b = decodeCaps(set);
  assert.equal(b.capability_bits, ((a.capability_bits as number) | (1 << 3) | (1 << 25)) >>> 0);
  assert.equal(b.capability_bits_v2, ((a.capability_bits_v2 as number) | 1) >>> 0);
  assert.ok(!((a.capability_bits as number) & (1 << 3)), 'not offered before');
  let differ = 0;
  for (let k = 0; k < caps.length; k++) if (caps[k] !== set[k]) differ++;
  assert.ok(differ <= 3, `${differ} bytes changed`);
  assert.equal(withBits(caps, []).caps, caps);
});

test('virgl snapshots: contexts that never submitted are made again; one in use loads the renderer\'s state; caps this browser can\'t back turn 3D off', async () => {
  const ram = new Uint8Array(1 << 16);
  const make = (caps?: Uint8Array) => {
    const calls: HostCall[] = [];
    const g = new Gpu(() => [ram], ramLayout(ram.length), { width: 640, height: 480, virgl: true, caps });
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
  // The guest's Mesa reads the caps first (GET_CAPSET, VIRGL2 at version 2): a snapshot from here on carries them.
  assert.equal(type(a.g.control(ctxCmd(0x109, 0, 2, 2), 64 + capsA.length)), 0x1103);
  assert.equal(type(a.g.control(ctxCmd(0x200, 7, 0, 0), 64)), 0x1100);
  // The console on the screen: a 2D resource on the scanout (RESOURCE_CREATE_2D, SET_SCANOUT).
  assert.equal(type(a.g.control(ctxCmd(0x101, 0, 1, 1, 64, 32), 64)), 0x1100);
  assert.equal(type(a.g.control(ctxCmd(0x103, 0, 0, 0, 64, 32, 0, 1), 64)), 0x1100);
  const saved = JSON.parse(JSON.stringify(await a.g.save())) as { unsaveable?: string };
  assert.equal(saved.unsaveable, undefined, 'a context alone (a process that opened the render node) doesn\'t stop a snapshot');
  assert.equal(await a.g.refusal(), undefined, 'nor its check before a snapshot');
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
  // A context that submitted has objects in the renderer: saved from the host's state, or refused by a host that can't.
  assert.equal(type(a.g.control(ctxCmd(0x207, 7, 4, 0, 0), 64)), 0x1100);
  assert.equal((await a.g.save() as { unsaveable?: WireError }).unsaveable?.msg?.key, 'display:gpu.unsaveable.virgl');
  assert.equal((await a.g.refusal())?.msg?.key, 'display:gpu.unsaveable.virgl');
  const state: RendererSnapshot = { version: 1, resources: [], contexts: [{ id: 7, sub: 0, attached: [], subs: [] }] };
  a.g.host = { call: () => undefined, fence: () => undefined, save: async () => ({ state }) };
  const inUse = await a.g.save() as unknown as { unsaveable?: WireError; renderer?: RendererSnapshot; used: number[] };
  assert.deepEqual([inUse.unsaveable, inUse.renderer, inUse.used], [undefined, state, [7]]);
  const d = make(capsA);
  d.g.restore(inUse);
  assert.deepEqual(d.calls.filter((x) => x.t === 'ctx' || x.t === 'load'), [{ t: 'load', state }], 'the renderer makes the contexts');
  const video = toWire(msg('display:virgl-renderer.unsaveable.video'));
  a.g.host = { call: () => undefined, fence: () => undefined, save: async () => ({ refused: video }), refusal: async () => video };
  assert.deepEqual((await a.g.save() as { unsaveable?: WireError }).unsaveable, video);
  assert.deepEqual(await a.g.refusal(), video, 'the host\'s refusal, asked before a snapshot');
  a.g.control(ctxCmd(0x201, 7), 64);
  assert.equal((await a.g.save() as { unsaveable?: WireError }).unsaveable, undefined);
  assert.equal(await a.g.refusal(), undefined);
});

test("virgl snapshots: a guest that never read the caps saves none, and is given this browser's at the restore (a demo's template made before any GL client)", async () => {
  const ram = new Uint8Array(1 << 16);
  const capsA = capsFromGl(mockGl({ extensions: ['WEBGL_compressed_texture_s3tc'] })), capsB = capsFromGl(mockGl({ extensions: [] }));
  const make = (caps: Uint8Array) => {
    const calls: HostCall[] = [];
    const g = new Gpu(() => [ram], ramLayout(ram.length), { width: 640, height: 480, virgl: true, caps });
    g.host = { call: (c) => calls.push(c), fence: () => undefined };
    return { g, calls };
  };
  const cmd = (type: number, ...fields: number[]) => {
    const b = new Uint8Array(24 + 4 * fields.length);
    const v = new DataView(b.buffer);
    v.setUint32(0, type, true);
    fields.forEach((f, k) => v.setUint32(24 + 4 * k, f, true));
    return b;
  };
  const type = (r: Uint8Array) => new DataView(r.buffer, r.byteOffset).getUint32(0, true);
  // The kernel asks the capsets' sizes at its probe (GET_CAPSET_INFO), not their data.
  const a = make(capsA);
  assert.equal(type(a.g.control(cmd(0x108, 1), 64)), 0x1102);
  // A context the kernel makes when a process opens the DRM device (Arch's boot): no caps read for it.
  const early = cmd(0x200, 0, 0);
  new DataView(early.buffer).setUint32(16, 1, true);
  assert.equal(type(a.g.control(early, 64)), 0x1100);
  const saved = JSON.parse(JSON.stringify(await a.g.save())) as { caps?: string };
  assert.equal(saved.caps, undefined, 'no caps saved: the guest has none');
  // Restored where they differ: the guest reads this browser's, and 3D is on.
  const b = make(capsB);
  b.g.restore(saved);
  assert.deepEqual([...b.g.caps], [...capsB], "this browser's caps");
  assert.equal(type(b.g.control(cmd(0x200), 64)), 0x1204, 'context 0 is no context (the command\'s own check)');
  const ctx = cmd(0x200, 0, 0);
  new DataView(ctx.buffer).setUint32(16, 9, true);
  assert.equal(type(b.g.control(ctx, 64)), 0x1100, 'a context is made: 3D on');
  // Once read (GET_CAPSET), they are the guest's: saved, and checked at the next restore.
  assert.equal(type(b.g.control(cmd(0x109, 2, 2), 64 + capsB.length)), 0x1103);
  const read = JSON.parse(JSON.stringify(await b.g.save())) as { caps?: string };
  assert.ok(read.caps, 'saved once read');
  const c = make(capsA);
  c.g.restore(read);
  assert.deepEqual([...c.g.caps], [...capsB], 'the guest keeps the caps it read');
  // And a snapshot of that restored machine still carries them, read or not since.
  assert.ok((JSON.parse(JSON.stringify(await c.g.save())) as { caps?: string }).caps, 'carried on');
});

test("virgl snapshots: a guest's reset after a restore where 3D was off gives it this browser's caps and 3D again; only the virgl capsets count as read", async () => {
  const ram = new Uint8Array(1 << 16);
  const capsA = capsFromGl(mockGl({ extensions: ['WEBGL_compressed_texture_s3tc'] })), capsB = capsFromGl(mockGl({ extensions: [] }));
  const make = (caps: Uint8Array, venus = false) => {
    const g = new Gpu(() => [ram], ramLayout(ram.length), { width: 640, height: 480, virgl: true, caps, venus });
    g.host = { call: () => undefined, fence: () => undefined };
    return g;
  };
  const cmd = (type: number, ...fields: number[]) => {
    const b = new Uint8Array(24 + 4 * fields.length);
    const v = new DataView(b.buffer);
    v.setUint32(0, type, true);
    fields.forEach((f, k) => v.setUint32(24 + 4 * k, f, true));
    return b;
  };
  const ctx = (id: number) => {
    const c = cmd(0x200, 0, 0);
    new DataView(c.buffer).setUint32(16, id, true);
    return c;
  };
  const type = (r: Uint8Array) => new DataView(r.buffer, r.byteOffset).getUint32(0, true);
  const snap = async (g: Gpu) => JSON.parse(JSON.stringify(await g.save())) as { caps?: string; off3d?: string };
  // The guest read capsA; restored where only capsB is backed: 3D off.
  const a = make(capsA);
  assert.equal(type(a.control(cmd(0x109, 2, 2), 64 + capsA.length)), 0x1103);
  const b = make(capsB);
  b.restore(await snap(a));
  assert.equal(type(b.control(ctx(3), 64)), 0x1200, '3D off after the restore');
  // The guest reboots (a virtio reset): a fresh guest reads this browser's caps, and 3D is on again.
  b.reset();
  assert.deepEqual([...b.caps], [...capsB], "this browser's caps after the reset");
  assert.equal(type(b.control(ctx(3), 64)), 0x1100, '3D on after the reset');
  // A snapshot after the reset, before any read, carries neither caps nor off3d: 3D on where it's restored.
  const b2 = make(capsB);
  b2.restore(await snap(a));
  b2.reset();
  const after = await snap(b2);
  assert.equal(after.caps, undefined, 'no caps saved');
  assert.equal(after.off3d, undefined, 'no off3d saved');
  const c = make(capsA);
  c.restore(after);
  assert.equal(type(c.control(ctx(4), 64)), 0x1100, '3D on in the next browser');
  // Reading only the Venus capset (id 4) isn't reading the virgl caps: none saved.
  const v = make(capsA, true);
  assert.equal(type(v.control(cmd(0x109, 4, 0), 64 + 4096)), 0x1103, 'the Venus capset read');
  assert.equal((await snap(v)).caps, undefined, 'no virgl caps saved for a Venus read');
});

test('virgl cursor: a 3D resource\'s image is read back from the renderer, in its format, and a later update wins', async () => {
  const ram = new Uint8Array(1 << 16);
  const g = new Gpu(() => [ram], ramLayout(ram.length), { width: 640, height: 480, virgl: true });
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

// What fuzzing the stream found (tests/virgl-fuzz.ts, docs/testing.md "virgl fuzzing"): each defect at its command.
test('virgl renderer: guest-sized slots, layers, indices, boxes and buffers are bounded (found by fuzzing)', () => {
  const gl = mockGl();
  gl.keepLog = true;
  const errors: string[] = [], faults: unknown[] = [];
  const r = new VirglRenderer(gl, { ram: () => [new Uint8Array(0)], log: (m) => errors.push(m) });
  r.onCaught = (e) => { if (!(e instanceof Error && e.constructor === Error)) faults.push(e); };
  r.createContext(1);
  const d = drawable(r);
  r.submit(1, new Uint32Array(d.setup));
  assert.deepEqual(errors, []);
  const run = (...words: number[]) => { errors.length = 0; r.submit(1, new Uint32Array(words)); return errors.join('\n'); };
  // A start slot of 2^31 (a draw walked every slot below it: a hang).
  assert.match(run(10 | 3 << 16, 1, 0x7fffffff, 0), /bad SET_SAMPLER_VIEWS/);
  assert.match(run(18 | 3 << 16, 1, 0x7fffffff, 0), /bad BIND_SAMPLER_STATES/);
  // A blit of 2^32 - 1 layers into a 2D texture (as many blits: a hang) is its one layer.
  r.createResource({ id: 4, target: 2, format: 67, bind: 2, width: 4, height: 4, depth: 1, arraySize: 1, lastLevel: 0, samples: 0, flags: 0 });
  r.attach(1, 4);
  gl.log.length = 0;
  run(16 | 21 << 16, 0xf, 0, 0, 4, 0, 67, 0, 0, 0, 4, 4, 0xffffffff, 3, 0, 67, 0, 0, 0, 4, 4, 1);
  assert.equal(gl.log.filter(([n]) => n === 'blitFramebuffer').length, 1);
  // Indices misaligned or past the index buffer (a view of an odd length threw; a count sized the CPU's rebasing).
  r.createResource({ id: 2, target: 0, format: 64, bind: 0x20, width: 16, height: 1, depth: 1, arraySize: 1, lastLevel: 0, samples: 0, flags: 0 });
  r.attach(1, 2);
  const indexed = (count: number) => [8 | 12 << 16, 0, count, 4, 1, 0, 0, 0, 0, 0, 0, 2, 0];
  assert.match(run(11 | 3 << 16, 2, 2, 1, ...indexed(3)), /past index buffer/);
  assert.match(run(11 | 3 << 16, 2, 2, 0, ...indexed(0x7fffffff)), /past index buffer/);
  assert.match(run(11 | 3 << 16, 2, 3, 0, ...indexed(3)), /past index buffer/);
  assert.doesNotMatch(run(11 | 3 << 16, 2, 2, 0, ...indexed(8)), /past index buffer/);
  // An upload whose box isn't in the texture (it sized the CPU's repacking) or has fewer bytes than the box.
  assert.match(run(9 | 15 << 16, 3, 0, 0, 3, 0, 0, 0, 0, 0x7fffffff, 1, 1, 0, 0, 0, 0), /isn't in level 0/);
  assert.match(run(9 | 15 << 16, 3, 0, 0, 0, 0, 0, 0, 0, 4, 4, 1, 0, 0, 0, 0), /16 bytes for the box/);
  // A 2 GiB buffer (its CPU copy was as big) and a texture past WebGL's limits make nothing on the host.
  r.createResource({ id: 5, target: 0, format: 64, bind: 0x10, width: 0x80000000, height: 1, depth: 1, arraySize: 1, lastLevel: 0, samples: 0, flags: 0 });
  r.createResource({ id: 6, target: 2, format: 67, bind: 2, width: 1 << 20, height: 4, depth: 1, arraySize: 1, lastLevel: 0, samples: 0, flags: 0 });
  assert.equal(r.resources.get(5)?.shadow, undefined);
  assert.equal(r.resources.get(6)?.tex, undefined);
  assert.deepEqual(faults, []);
  // A TGSI swizzle that isn't one, and an instruction missing an operand: the shader's errors, not TypeErrors.
  assert.throws(() => parseTgsi('FRAG\nDCL IN[0]\nDCL OUT[0], COLOR\n  0: MOV OUT[0], IN[0].q\n  1: END'), TgsiError);
  const vs = parseTgsi('VERT\nDCL IN[0]\nDCL OUT[0], POSITION\n  0: MOV OUT[0], IN[0]\n  1: END');
  assert.throws(() => generate(vs, parseTgsi('FRAG\nDCL IN[0], GENERIC[0], PERSPECTIVE\nDCL OUT[0], COLOR\n  0: ADD OUT[0], IN[0]\n  1: END'), KEY), TgsiError);
});

test('virgl renderer: fuzzed streams through the device find no defects (tests/virgl-fuzz.ts, 300 cases)', () => {
  const seeds = loadSeeds(), dict = dictionary(seeds);
  const found: string[] = [];
  for (let seed = 1; seed <= 300; seed++) for (const f of runTrace(makeCase(seeds, dict, seed).trace).findings) found.push(`seed ${seed}: ${findingKey(f)}`);
  assert.deepEqual(found, []);
});
