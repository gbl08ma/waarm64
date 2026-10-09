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
import { localHost, type HostCall, type VirglHost } from '../web/virgl-host.ts';
import { VirglRenderer, toHalf } from '../web/virgl-renderer.ts';
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

test('virgl tgsi: integers keep their bits, the fragment coordinate follows the origin, an alpha test discards', () => {
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
  assert.match(p.fs, /u_fbh - gl_FragCoord.y - 0.5/);
  assert.match(p.fs, /if \(!\(col0.w < u_alpharef\)\) discard;/);
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
  const p = generate(vs, fs, { ...KEY, so: [{ reg: 0, start: 0, comps: 4 }, { reg: 1, start: 1, comps: 2 }, { reg: 1, start: 3, comps: 1 }], soSeparate: true });
  assert.deepEqual(p.tf, { varyings: ['tf_0', 'tf_1', 'tf_2'], separate: true });
  for (const l of ['out highp vec4 tf_0;', 'out highp vec2 tf_1;', 'out highp float tf_2;', 'tf_0 = gl_Position.xyzw;', 'tf_1 = o_1.yz;', 'tf_2 = o_1.w;']) assert.ok(p.vs.includes(l), l);
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

test('virgl device: a fenced command\'s reply waits for the host, and replies stay in order', async () => {
  const ram = new Uint8Array(1 << 20);
  const done: number[] = [];
  const ctx = { ram: () => ram, ramSize: ram.length, complete: (w0: number) => done.push(w0), config: () => new Uint8Array(16), changeConfig: () => {} };
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

test('virgl caps: from the browser\'s WebGL2, formats only where their extensions are; a restore checks them', () => {
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
