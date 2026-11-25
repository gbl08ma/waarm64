// What tests/virgl-browser.test.ts runs in Chromium: the shader corpus compiled on WebGL2, traces replayed.
import { generate, parseTgsi, quirksOf, type ProgramKey } from '../../web/virgl-tgsi.ts';

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
import type { RendererSnapshot, ResourceDesc, SavedLevel } from '../../web/virgl-objects.ts';
import { FORMATS } from '../../web/virgl-formats.ts';
import { CallQueue, FenceGate, localHost, portHost, runCall, type HostCall } from '../../web/virgl-host.ts';
import { replay, replayAsync } from '../../web/virgl-replay.ts';
import { Gpu } from '../../web/gpu.ts';
import { ramLayout, type Ram } from '../../web/ram.ts';
import { canvasPresenter } from '../../web/gpu-present.ts';
import { Screen } from '../../web/virgl-screen.ts';
import { copyPicture, probeVideo, webCodecsDecoder, type DecodedPicture, type DecoderFactory, type PictureScratch, type PictureShape } from '../../web/virgl-video.ts';

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

/**
 * A video fixture (bench/video/fixture.ts) replayed through the device into a renderer decoding with WebCodecs, as
 * the GPU worker does (its CallQueue, timer and all): each picture's planes are read back as it's written and its
 * visible `w`×`h` hashed as I420 (SHA-256). With `orig` (an H.264 stream's first pictures, Annex B), also the
 * browser's own decode of it, hashed the same way: what the planes must hold where its decoder isn't FFmpeg's.
 * `fault` damages the chunk of one picture (its index in decode order) before the decoder gets it: `garble` overwrites
 * its bytes after the first 8 with a pattern, `truncate` keeps its first 8 bytes; `slowCopyMs` holds each frame's copy
 * (`VideoFrame.copyTo`) that long, so the decoder's error finds copies still out. With a fault, the queue's drain and
 * give-up (CallQueue.tick) come only after 10 and 20 s, and `timedOut` counts them: what frees the guest after a
 * fault must be the decoder's error, not a timer, however slow the host runs; `outputs` counts the frames the decoder
 * put out (what it still held when the error closed it is lost with it).
 */
export type ChunkFault = { picture: number; how: 'garble' | 'truncate'; slowCopyMs?: number };
export async function replayVideo64(trace: string, w: number, h: number, orig?: string, fault?: ChunkFault) {
  const gl = new OffscreenCanvas(16, 16).getContext('webgl2')!;
  const log: string[] = [];
  const { hardware } = await probeVideo();
  const shots: Promise<string>[] = [];
  const sampled: Promise<string>[] = [];
  let pictureTextures = 0;
  let r!: VirglRenderer;
  let q!: CallQueue<HostCall>;
  const timedOut = { drains: 0, giveUps: 0 };
  const outputs = { n: 0 };
  const t0 = performance.now();
  const timer = setInterval(() => q?.tick(), 20);
  const copyTo = VideoFrame.prototype.copyTo;
  if (fault?.slowCopyMs) {
    const ms = fault.slowCopyMs;
    VideoFrame.prototype.copyTo = async function (this: VideoFrame, ...a: Parameters<VideoFrame['copyTo']>) {
      const layout = await copyTo.apply(this, a);
      await new Promise((ok) => setTimeout(ok, ms));
      return layout;
    };
  }
  const settled = async () => { while (q.length || r.videoWaiting) await new Promise((ok) => setTimeout(ok, 5)); };
  try {
    await replayAsync(fromBase64(trace), (ram) => {
      r = new VirglRenderer(gl, { ram, log: (m) => log.push(m), video: { decoders: fault ? faulty(fault, outputs) : webCodecsDecoder, hardware } });
      // Each picture's planes, read back as it's written (the buffers are used again).
      const p = r as unknown as { writePicture(planes: number[], pic: DecodedPicture): void };
      const write = p.writePicture.bind(r);
      p.writePicture = (planes, pic) => {
        write(planes, pic);
        shots.push(sha256(i420(planes.map((id) => ({ bytes: r.readResource(id)!, width: r.resources.get(id)!.width })), w, h)));
        // And what a draw samples: a plane's picture texture where the picture is smaller than its plane.
        const res = planes.map((id) => r.resources.get(id)!);
        pictureTextures += res.filter((x) => x.picture).length;
        sampled.push(sha256(i420(res.map((x) => texels(gl, x.picture ?? x)), w, h)));
      };
      // `ctx` -1: the guest's read of a picture (below), which only waits.
      q = new CallQueue<HostCall>({ run: (c) => { if (c.t !== 'transfer' || c.ctx !== -1) runCall(c, r); }, pending: r.videoPending, nudge: () => r.videoNudge(), drain: () => { timedOut.drains++; r.videoDrain(); }, giveUp: () => { timedOut.giveUps++; r.videoGiveUp(); }, ...(fault ? { drainMs: 10_000, giveUpMs: 20_000 } : {}) });
      r.onVideoSettled = () => queueMicrotask(() => q.progress());
      return { call: (c) => q.push(c), fence: () => undefined };
    }, async () => { if (q.length) await settled(); });
    // The guest reads the pictures still out (a read of their planes waits for them): a decoder that holds pictures for
    // reordering is drained then (CallQueue.tick).
    for (const res of (r as unknown as { pendingPlanes(): number[] }).pendingPlanes()) {
      q.push({ t: 'transfer', ctx: -1, res, level: 0, box: { x: 0, y: 0, z: 0, w: 1, h: 1, d: 1 }, offset: 0, stride: 0, layerStride: 0, toHost: false });
    }
    await settled();
  } finally {
    clearInterval(timer);
    VideoFrame.prototype.copyTo = copyTo;
  }
  return { hashes: await Promise.all(shots), sampled: await Promise.all(sampled), pictureTextures, stats: { ...r.videoStats }, ahead: q.ahead, maxWaitMs: q.maxWaitMs, timedOut, outputs: outputs.n, hardware, log, ms: performance.now() - t0, orig: orig ? await decodeOrig(fromBase64(orig), w, h, hardware) : null };
}

/**
 * `copyPicture` on frames made here (I420 and NV12: no decoder in the dev VM's Chromium gives NV12), their visible
 * rectangle inside the coded size at an offset, an odd size and an even one, in each shape: none, the picture's own
 * size and a larger plane's, interleaved and planar. Each texel of each array against the frame's bytes, the picture's
 * last column and row where the array is larger. Returns the cases that differ, and how many ran.
 */
export async function copyPictures() {
  const wrong: string[] = [];
  let cases = 0;
  const scratch: PictureScratch = {};
  const CODED_W = 32, CODED_H = 24, CCW = CODED_W / 2, CCH = CODED_H / 2;
  // The frame's planes: every byte its plane's own (a wrong plane, row or column reads as another value).
  const Y = Uint8Array.from({ length: CODED_W * CODED_H }, (_, k) => (k * 7 + 3) & 0xff);
  const U = Uint8Array.from({ length: CCW * CCH }, (_, k) => (k * 5 + 101) & 0xff);
  const V = Uint8Array.from({ length: CCW * CCH }, (_, k) => (k * 11 + 53) & 0xff);
  for (const format of ['I420', 'NV12'] as const) {
    const data = new Uint8Array(CODED_W * CODED_H + 2 * CCW * CCH);
    data.set(Y);
    if (format === 'I420') { data.set(U, Y.length); data.set(V, Y.length + U.length); }
    else for (let k = 0; k < U.length; k++) { data[Y.length + 2 * k] = U[k]; data[Y.length + 2 * k + 1] = V[k]; }
    for (const rect of [{ x: 2, y: 4, width: 21, height: 13 }, { x: 0, y: 0, width: 28, height: 16 }]) {
      const cw = (rect.width + 1) >> 1, ch = (rect.height + 1) >> 1;
      const shapes: (PictureShape | undefined)[] = [undefined];
      for (const planar of [false, true]) shapes.push({ w: 0, h: 0, cw: 0, ch: 0, planar }, { w: 32, h: 16, cw: 16, ch: 8, planar }, { w: 22, h: 24, cw: 11, ch: 12, planar });
      for (const shape of shapes) {
        cases++;
        const name = `${format} ${rect.width}x${rect.height} into ${shape ? `${shape.w}x${shape.h} ${shape.planar ? 'planar' : 'interleaved'}` : 'no shape'}`;
        const f = new VideoFrame(data, { format, codedWidth: CODED_W, codedHeight: CODED_H, timestamp: 0, visibleRect: rect });
        let p: DecodedPicture;
        try { p = await copyPicture(f, shape, scratch); } catch (e) { wrong.push(`${name}: ${e}`); continue; } finally { f.close(); }
        const W = Math.max(rect.width, shape?.w ?? 0), H = Math.max(rect.height, shape?.h ?? 0), CW = Math.max(cw, shape?.cw ?? 0), CH = Math.max(ch, shape?.ch ?? 0);
        const said = [p.width, p.height, p.stride, p.rows, p.cstride, p.crows, !!p.planar, p.y.length, p.uv.length].join(' ');
        const want = [rect.width, rect.height, W, H, CW, CH, !!shape?.planar, W * H, 2 * CW * CH].join(' ');
        if (said !== want) { wrong.push(`${name}: sizes ${said}, not ${want}`); continue; }
        let bad = '';
        for (let r = 0; r < H && !bad; r++) for (let x = 0; x < W && !bad; x++) {
          const v = Y[(rect.y + Math.min(r, rect.height - 1)) * CODED_W + rect.x + Math.min(x, rect.width - 1)];
          if (p.y[r * W + x] !== v) bad = `luma at ${x},${r}: ${p.y[r * W + x]}, not ${v}`;
        }
        for (let r = 0; r < CH && !bad; r++) for (let x = 0; x < CW && !bad; x++) {
          const at = ((rect.y >> 1) + Math.min(r, ch - 1)) * CCW + (rect.x >> 1) + Math.min(x, cw - 1);
          const u = p.planar ? p.uv[r * CW + x] : p.uv[2 * (r * CW + x)], v = p.planar ? p.uv[CW * CH + r * CW + x] : p.uv[2 * (r * CW + x) + 1];
          if (u !== U[at] || v !== V[at]) bad = `chroma at ${x},${r}: ${u} ${v}, not ${U[at]} ${V[at]}`;
        }
        if (bad) wrong.push(`${name}: ${bad}`);
      }
    }
  }
  return { cases, wrong };
}

/** WebCodecs' decoders with one chunk damaged (`ChunkFault`). */
function faulty(fault: ChunkFault, outputs: { n: number }): DecoderFactory {
  let n = 0;
  return (config, output, error, shape) => {
    // Each frame out of the decoder asks for its planes' shape once (webCodecsDecoder): counted there.
    const counted: typeof shape = (ts) => {
      const s = shape?.(ts);
      if (s) outputs.n++;
      return s;
    };
    const d = webCodecsDecoder(config, output, error, shape ? counted : shape);
    return {
      ...d,
      decode(data, key, timestamp) {
        if (n++ === fault.picture) {
          if (fault.how === 'truncate') data = data.slice(0, 8);
          else data = data.map((x, k) => (k < 8 ? x : (k * 37 + 11) & 0xff));
        }
        d.decode(data, key, timestamp);
      },
    };
  };
}

/** I420 of planes read back (NV12: R8 then RG8; or three R8), the top-left `w`×`h`. */
/** A texture's texels (R8 or RG8), read through a framebuffer of its own. */
function texels(gl: WebGL2RenderingContext, t: { tex?: WebGLTexture | null; width: number; height: number; fmt?: { bpp: number } }) {
  const fbo = gl.createFramebuffer(), bpp = t.fmt!.bpp;
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex!, 0);
  const rgba = new Uint8Array(t.width * t.height * 4);
  gl.readPixels(0, 0, t.width, t.height, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  const bytes = new Uint8Array(t.width * t.height * bpp);
  for (let k = 0; k < t.width * t.height; k++) for (let c = 0; c < bpp; c++) bytes[k * bpp + c] = rgba[k * 4 + c];
  return { bytes, width: t.width };
}

function i420(planes: { bytes: Uint8Array; width: number }[], w: number, h: number) {
  const cw = (w + 1) >> 1, ch = (h + 1) >> 1;
  const out = new Uint8Array(w * h + 2 * cw * ch);
  for (let y = 0; y < h; y++) out.set(planes[0].bytes.subarray(y * planes[0].width, y * planes[0].width + w), y * w);
  let at = w * h;
  if (planes.length === 2) {
    const uv = planes[1];
    for (const c of [0, 1]) for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) out[at++] = uv.bytes[2 * (y * uv.width + x) + c];
  } else {
    for (const p of planes.slice(1)) for (let y = 0; y < ch; y++) { out.set(p.bytes.subarray(y * p.width, y * p.width + cw), at); at += cw; }
  }
  return out;
}

async function sha256(b: Uint8Array<ArrayBuffer>) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** The browser's decode of an H.264 stream (a chunk a picture, as the device's decoder is configured), each frame hashed. */
async function decodeOrig(stream: Uint8Array, w: number, h: number, hardware: number[]) {
  const { splitAnnexB } = await import('../../web/video-h264.ts');
  const { PROFILE } = await import('../../web/virgl-video.ts');
  const pictures: Uint8Array[][] = [];
  for (const n of splitAnnexB(stream)) {
    const t = n[0] & 31;
    if ((t === 1 || t === 5) && n[1] & 0x80 && pictures.at(-1)?.some((m) => (m[0] & 31) === 1 || (m[0] & 31) === 5)) pictures.push([]);
    (pictures.at(-1) ?? pictures[pictures.push([]) - 1]).push(n);
  }
  const hashes: Promise<string>[] = [];
  const errors: string[] = [];
  const dec = new VideoDecoder({
    output: (f) => {
      const raw = new Uint8Array(f.allocationSize());
      hashes.push(f.copyTo(raw).then((layout) => {
        const nv12 = f.format === 'NV12';
        const planes = layout.map((l, k) => ({ bytes: raw.subarray(l.offset), width: l.stride / (nv12 && k === 1 ? 2 : 1) }));
        f.close();
        return sha256(i420(planes, w, h));
      }));
    },
    error: (e) => errors.push(String(e)),
  });
  dec.configure({ codec: 'avc1.64001E', optimizeForLatency: true, hardwareAcceleration: hardware.includes(PROFILE.AVC_HIGH) ? 'prefer-hardware' : 'prefer-software' });
  pictures.forEach((p, k) => {
    const data = new Uint8Array(p.reduce((n, x) => n + 4 + x.length, 0));
    let at = 0;
    for (const x of p) { data.set([0, 0, 0, 1], at); data.set(x, at + 4); at += 4 + x.length; }
    dec.decode(new EncodedVideoChunk({ type: p.some((x) => (x[0] & 31) === 5) ? 'key' : 'delta', timestamp: k, data }));
  });
  await dec.flush();
  dec.close();
  return { hashes: await Promise.all(hashes), errors };
}

/** Replays a trace on WebGL2 and reads back resource `read` (its RGBA as stored, rows top first; -1: the scanout's). */
export function replayTrace(trace: Uint8Array, read?: number) {
  const canvas = new OffscreenCanvas(16, 16);
  const gl = canvas.getContext('webgl2')!;
  const log: string[] = [];
  let r!: VirglRenderer;
  const t0 = performance.now();
  const res = replay(trace, (ram) => localHost((r = new VirglRenderer(gl, { ram, log: (m) => log.push(m), checkPrograms: true }))), { lastSubmit: true });
  gl.finish();
  const ms = performance.now() - t0;
  const scanout = res.gpu.state().scanout;
  if (read === -1) read = scanout?.id;
  const pixels = read ? r.readResource(read) : null;
  const fmt = read ? r.resources.get(read)?.format : undefined;
  return { stats: r.stats, log, ms, scanout, read, fmt, width: read ? r.resources.get(read)?.width : 0, height: read ? r.resources.get(read)?.height : 0, replies: [...new Set(res.replies)], pixels: pixels ? Array.from(pixels) : null, renderer: gl.getParameter(gl.RENDERER) as string, glError: gl.getError() };
}

/**
 * `replayTrace` with snapshots: after each submit numbered in `at`, the renderer's state is saved (`save`), carried
 * as a snapshot file carries it (JSON, its Uint8Arrays apart: web/snapshot.ts), and loaded into a fresh renderer on a
 * new WebGL2 context, which goes on with the trace. Each save is also saved again from the renderer it loaded into,
 * at once: the resources whose contents differ (what a load or a save loses) are listed.
 */
export function replaySaved64(trace: string, read: number, at: number[]) {
  const log: string[] = [];
  const saves: { bytes: number; resources: number; lost: string[]; differ: string[] }[] = [];
  let ram!: () => Ram;
  let r!: VirglRenderer;
  const fresh = () => new VirglRenderer(new OffscreenCanvas(16, 16).getContext('webgl2')!, { ram, log: (m) => log.push(m) });
  let submits = 0, errors = 0;
  const carry = (s: RendererSnapshot) => {
    const blobs: Uint8Array[] = [];
    const json = JSON.stringify(s, (_k, v: unknown) => (v instanceof Uint8Array ? { $blob: blobs.push(v.slice()) - 1 } : v));
    return JSON.parse(json, (_k, v: unknown) => (v && typeof v === 'object' && '$blob' in v ? blobs[(v as { $blob: number }).$blob] : v)) as RendererSnapshot;
  };
  const res = replay(fromBase64(trace), (ramOf) => {
    ram = ramOf;
    r = fresh();
    return {
      call(c) {
        runCall(c, r);
        if (c.t !== 'submit' || !at.includes(++submits)) return;
        const saved = r.save();
        errors += r.stats.errors;
        const next = fresh();
        next.load(carry(saved));
        const again = next.save();
        const differ: string[] = [];
        for (const [k, a] of saved.resources.entries()) {
          const b = again.resources[k];
          const same = a.levels.length === b?.levels.length && a.levels.every((l, j) => l.data.length === b.levels[j].data.length && l.data.every((x, i) => x === b.levels[j].data[i]));
          if (!same) differ.push(`${a.desc.id} (format ${a.desc.format}, target ${a.desc.target}, ${a.desc.width}x${a.desc.height}, samples ${a.desc.samples})`);
        }
        saves.push({ bytes: saved.resources.reduce((n, x) => n + x.levels.reduce((m, l) => m + l.data.length, 0), 0), resources: saved.resources.length, lost: saved.resources.filter((x) => x.lost).map((x) => `${x.desc.id}: ${x.lost}`), differ });
        (r.gl.getExtension('WEBGL_lose_context') as { loseContext(): void } | null)?.loseContext();
        r = next;
      },
      fence: () => undefined,
    };
  }, { lastSubmit: true });
  r.gl.finish();
  const scanout = res.gpu.state().scanout;
  if (read === -1) read = scanout?.id ?? 0;
  const pixels = read ? r.readResource(read) : null;
  return { errors: errors + r.stats.errors, log, saves, submits, glError: r.gl.getError(), width: read ? r.resources.get(read)?.width : 0, height: read ? r.resources.get(read)?.height : 0, pixels64: pixels ? toBase64(pixels) : null };
}

/**
 * Every format this WebGL2 has, as each kind of resource (2D with two levels, a cube, a 2D array, a 3D texture, and
 * 4 samples where it renders), given contents through a snapshot's load (`VirglRenderer.load`) and saved back: the
 * resources whose saved contents differ from what was loaded, and those whose contents are lost. The contents are
 * values each format holds exactly (depths on the format's grid, finite floats).
 */
export function snapshotFormats() {
  const gl = new OffscreenCanvas(16, 16).getContext('webgl2')!;
  const log: string[] = [];
  const r = new VirglRenderer(gl, { ram: () => [], log: (m) => log.push(m) });
  const has = (names?: string[]) => !names || names.some((n) => gl.getSupportedExtensions()!.includes(n));
  let seed = 1;
  const rand = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 8) & 0xff;
  const differ: string[] = [], lost: string[] = [];
  let checked = 0, id = 1;
  for (const f of FORMATS.values()) {
    if (!has(f.needs)) continue;
    const zs = f.kind === 'depth' || f.kind === 'depthstencil' || f.kind === 'stencil';
    const renders = !!f.write && has(f.renderNeeds);
    const kinds: [string, Partial<ResourceDesc>][] = [['2d', { target: 2, lastLevel: 1 }]];
    if (!zs && f.block === 1) kinds.push(['cube', { target: 4, arraySize: 6 }], ['array', { target: 7, arraySize: 3 }], ['3d', { target: 3, depth: 2 }]);
    if (zs) kinds.push(['array', { target: 7, arraySize: 2 }]);
    if (f.kind === 'stencil') kinds.splice(0, kinds.length, ['2d', { target: 2 }]);
    if ((renders || zs) && f.block === 1 && f.kind !== 'uint' && f.kind !== 'sint') kinds.push(['4 samples', { target: 2, samples: 4 }]);
    for (const [what, k] of kinds) {
      const desc: ResourceDesc = { id: id++, target: 2, format: f.id, bind: 0, width: 8, height: 8, depth: 1, arraySize: 1, lastLevel: 0, samples: 0, flags: 0, ...k };
      const levels: SavedLevel[] = [];
      for (let level = 0; level <= desc.lastLevel; level++) {
        const w = Math.max(1, desc.width >> level), h = Math.max(1, desc.height >> level), d = desc.target === 3 ? Math.max(1, desc.depth >> level) : desc.arraySize;
        const n = w * h * d;
        if (zs) {
          const hasD = f.kind !== 'stencil', hasS = f.kind !== 'depth';
          const data = new Uint8Array((hasD ? 4 * n : 0) + (hasS ? n : 0));
          const grid = f.id === 16 ? 65535 : f.id === 18 || f.id === 126 ? 0 : 16777215;
          if (hasD) new Float32Array(data.buffer, 0, n).forEach((_, i, a) => { a[i] = grid ? ((rand() << 8 | rand()) % (grid + 1)) / grid : rand() / 255; });
          if (hasS) for (let i = 0; i < n; i++) data[(hasD ? 4 * n : 0) + i] = rand();
          levels.push({ level, how: 'zs' as const, data });
          continue;
        }
        const bytes = Math.ceil(w / f.block) * Math.ceil(h / f.block) * d * f.bpp;
        const data = new Uint8Array(bytes).map(rand);
        if (f.kind === 'float') {
          // Finite values: a half's or a float's exponent kept below all ones (no NaN to canonicalize).
          const size = f.type === 0x140b ? 2 : 4;
          for (let i = size - 1; i < data.length; i += size) data[i] &= 0x3f;
          if (f.type === 0x8c3b || f.type === 0x8c3e) data.fill(0x10);
          // A multisampled 32-bit float is loaded by a draw and saved through a resolve, and D3D11 flushes 32-bit
          // denormals to zero in both (GLES allows it; its 16-bit ones it keeps): its floats are normal.
          if (f.float32 && what === '4 samples') for (let i = 3; i < data.length; i += 4) if (!(data[i] & 0x7f) && !(data[i - 1] & 0x80)) data[i - 1] |= 0x80;
        }
        if (f.kind === 'snorm') for (let i = 0; i < data.length; i++) if (data[i] === 0x80) data[i] = 0x81;
        levels.push({ level, how: 'bytes' as const, data });
      }
      const name = `${f.name} ${what}`;
      r.load({ version: 1, resources: [{ desc, backing: null, levels }], contexts: [] });
      const saved = r.save().resources[0];
      checked++;
      if (saved.lost) { lost.push(`${name}: ${saved.lost}`); continue; }
      // A unorm depth is compared on its grid: the float a GL samples may be an ulp off the one written.
      const grid = f.kind === 'depth' || f.kind === 'depthstencil' ? (f.id === 16 ? 65535 : f.id === 18 || f.id === 126 ? 0 : 16777215) : 0;
      if (grid) for (const l of [...levels, ...saved.levels]) {
        const n = l.data.length / (f.kind === 'depth' ? 4 : 5);
        new Float32Array(l.data.buffer, l.data.byteOffset, n).forEach((v, i, a) => { a[i] = Math.round(v * grid); });
      }
      const same = saved.levels.length === levels.length && saved.levels.every((l, j) => l.how === levels[j].how && l.data.length === levels[j].data.length && l.data.every((x, i) => x === levels[j].data[i]));
      if (!same) {
        const l = saved.levels.findIndex((l, j) => l.data.some((x, i) => x !== levels[j]?.data[i]));
        const i = l >= 0 ? saved.levels[l].data.findIndex((x, i) => x !== levels[l].data[i]) : -1;
        differ.push(`${name}: level ${l} byte ${i}: ${l >= 0 ? `${levels[l].data[i]} saved as ${saved.levels[l].data[i]}` : `${saved.levels.length} levels`}`);
      }
    }
  }
  return { checked, differ, lost, log: log.filter((m) => !m.startsWith('snapshot:')), glError: gl.getError() };
}

/**
 * A snapshot through the page's GPU worker (web/gpu-worker.ts) and its port (`portHost`), as a machine takes one: a
 * context with a sub-context's object, a texture and a buffer given bytes by transfers; saved (the contents cross
 * the port), loaded into a second GPU worker, and read back there. Returns what was read, and the saved shape.
 */
export async function workerSnapshot() {
  const start = async () => {
    const w = new Worker(new URL('../../web/gpu-worker.ts', import.meta.url), { type: 'module' });
    const canvas = new OffscreenCanvas(64, 64), ch = new MessageChannel();
    const ready = new Promise<{ type: string }>((resolve) => { w.onmessage = (e) => resolve(e.data); });
    w.postMessage({ type: 'init', canvas, port: ch.port1 }, [canvas, ch.port1]);
    const m = await ready;
    if (m.type !== 'ready') throw new Error(`the GPU worker: ${JSON.stringify(m)}`);
    const ram = new Uint8Array(new SharedArrayBuffer(4096));
    const host = portHost(ch.port2);
    host.call({ t: 'ram', ram: [{ buffer: ram.buffer, offset: 0, length: ram.length }] });
    return { w, host, ram };
  };
  const a = await start();
  const tex = { id: 5, target: 2, format: 67, bind: 0x8, width: 4, height: 4, depth: 1, arraySize: 1, lastLevel: 0, samples: 0, flags: 0 };
  const buf = { id: 6, target: 0, format: 64, bind: 0x10, width: 64, height: 1, depth: 1, arraySize: 1, lastLevel: 0, samples: 0, flags: 0 };
  for (let k = 0; k < 128; k++) a.ram[k] = (k * 37 + 11) & 0xff;
  a.host.call({ t: 'ctx', id: 1, create: true });
  for (const desc of [tex, buf]) {
    a.host.call({ t: 'res', desc });
    a.host.call({ t: 'ctxres', ctx: 1, res: desc.id, attach: true });
  }
  a.host.call({ t: 'backing', id: 5, backing: [{ off: 0, len: 64, mem: 0 }] });
  a.host.call({ t: 'backing', id: 6, backing: [{ off: 64, len: 64, mem: 0 }] });
  a.host.call({ t: 'transfer', ctx: 1, res: 5, level: 0, box: { x: 0, y: 0, z: 0, w: 4, h: 4, d: 1 }, offset: 0, stride: 16, layerStride: 0, toHost: true });
  a.host.call({ t: 'transfer', ctx: 1, res: 6, level: 0, box: { x: 0, y: 0, z: 0, w: 64, h: 1, d: 1 }, offset: 0, stride: 0, layerStride: 0, toHost: true });
  // A blend state (CREATE_OBJECT, handle 3) bound (BIND_OBJECT).
  a.host.call({ t: 'submit', ctx: 1, words: new Uint32Array([1 | 1 << 8 | 11 << 16, 3, 0, 0, 0x1f << 27, 0, 0, 0, 0, 0, 0, 0, 2 | 1 << 8 | 1 << 16, 3]) });
  const saved = await a.host.save!();
  if (!('state' in saved)) throw new Error(`refused: ${saved.refused}`);
  const s = saved.state;
  const shape = { resources: s.resources.map((r) => [r.desc.id, r.levels.map((l) => l.data.length), r.backing]), objects: s.contexts.map((c) => c.subs.map((x) => [x.objects.map((o) => o.kind), x.blend])) };
  a.w.terminate();
  const b = await start();
  b.host.call({ t: 'load', state: s });
  const read = [await b.host.read!(5), await b.host.read!(6)].map((x) => (x ? Array.from(x) : null));
  const again = await b.host.save!();
  b.w.terminate();
  return { read, want: [Array.from(a.ram.subarray(0, 64)), Array.from(a.ram.subarray(64, 128))], shape, again: 'state' in again ? again.state.contexts.length : again.refused };
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
  const r = new VirglRenderer(gl, { ram: () => [ram], log: (m) => log.push(m) });
  r.createContext(1);
  const buffer = (id: number, width: number, bind: number) => { r.createResource({ id, target: 0, format: 64, bind, width, height: 1, depth: 1, arraySize: 1, lastLevel: 0, samples: 0, flags: 0 }); r.attach(1, id); };
  buffer(1, 48 * 4, 0x10); // vertices: 12 vec4s
  buffer(2, 60 * 4, 0x800); // interleaved: 10 vertices of 6 floats
  buffer(3, 64, 0x800); buffer(4, 64, 0x800); // separate: 4 vec4s, 8 vec2s
  buffer(5, 64, 0x800); r.attachBacking(5, [{ off: 0, len: 64, mem: 0 }]); // the query's result
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

/**
 * Integers through the translator's registers on WebGL2: WebRender's unpacking of instance data (an integer attribute
 * masked with 255 and 1023, shifted right by 10, added) into a flat varying and an RGBA32UI color buffer. ANGLE's
 * D3D11 backend made 0 of every one when the registers were floats (its HLSL compiler folds a float made of an
 * integer whose exponent bits it knows are clear, a denormal, to 0). Returns the pixel.
 */
export function integerRegisters() {
  const gl = new OffscreenCanvas(1, 1).getContext('webgl2')!;
  const vs = parseTgsi(`VERT
DCL IN[0]
DCL IN[1]
DCL OUT[0], POSITION
DCL OUT[1], GENERIC[0]
DCL TEMP[0..1]
IMM[0] UINT32 {255, 1023, 10, 0}
  0: AND TEMP[0], IN[0], IMM[0].xyxy
  1: USHR TEMP[1], IN[0], IMM[0].zzzz
  2: MOV OUT[1], TEMP[0]
  3: UADD OUT[1].y, TEMP[0].yyyy, TEMP[1].xxxx
  4: MOV OUT[0], IN[1]
  5: END`);
  const fs = parseTgsi('FRAG\nDCL IN[0], GENERIC[0], CONSTANT\nDCL OUT[0], COLOR\nDCL TEMP[0]\n  0: MOV TEMP[0], IN[0]\n  1: MOV OUT[0], TEMP[0]\n  2: END');
  const p = generate(vs, fs, { attribs: ['i', 'f'], samplers: { vs: [], fs: [] }, cbufs: [{ type: 'u', write: [0, 1, 2, 3] }] });
  const compile = (type: number, src: string) => { const sh = gl.createShader(type)!; gl.shaderSource(sh, src); gl.compileShader(sh); return sh; };
  const prog = gl.createProgram()!;
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, p.vs)); gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, p.fs)); gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return { error: gl.getProgramInfoLog(prog), pixel: [] };
  gl.useProgram(prog);
  gl.uniform1f(gl.getUniformLocation(prog, 'u_adjy'), 1);
  gl.uniform2f(gl.getUniformLocation(prog, 'u_adjz'), 1, 0);
  const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex); gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32UI, 1, 1);
  const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.viewport(0, 0, 1, 1);
  const ints = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, ints);
  gl.bufferData(gl.ARRAY_BUFFER, new Uint32Array([0x12345, 0x2bb, 0xff09, 0xffffffff]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribIPointer(0, 4, gl.INT, 16, 0); gl.vertexAttribDivisor(0, 1);
  const pos = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, pos);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 0, 1, 3, -1, 0, 1, -1, 3, 0, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 16, 0);
  gl.drawArraysInstanced(gl.TRIANGLES, 0, 3, 1);
  const px = new Uint32Array(4); gl.readPixels(0, 0, 1, 1, gl.RGBA_INTEGER, gl.UNSIGNED_INT, px);
  return { error: gl.getError() || null, pixel: Array.from(px) };
}

/**
 * A vertex and fragment shader pair from TGSI drawn over a 1×1 RGBA32UI color buffer (so the pixel is the bits the
 * fragment shader wrote), attribute 0 the constant `a0`, attribute 1 the position. Returns the pixel.
 */
function drawBits(vsText: string, fsText: string, a0: number[]) {
  const gl = new OffscreenCanvas(1, 1).getContext('webgl2')!;
  const p = generate(parseTgsi(vsText), parseTgsi(fsText), { attribs: ['f', 'f'], samplers: { vs: [], fs: [] }, cbufs: [{ type: 'u', write: [0, 1, 2, 3] }] });
  const compile = (type: number, src: string) => { const sh = gl.createShader(type)!; gl.shaderSource(sh, src); gl.compileShader(sh); return sh; };
  const prog = gl.createProgram()!;
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, p.vs)); gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, p.fs)); gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return { error: gl.getProgramInfoLog(prog), pixel: [] };
  gl.useProgram(prog);
  gl.uniform1f(gl.getUniformLocation(prog, 'u_adjy'), 1);
  gl.uniform2f(gl.getUniformLocation(prog, 'u_adjz'), 1, 0);
  const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex); gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32UI, 1, 1);
  const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.viewport(0, 0, 1, 1);
  gl.vertexAttrib4f(0, a0[0], a0[1], a0[2], a0[3]);
  const pos = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, pos);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 0, 1, 3, -1, 0, 1, -1, 3, 0, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 16, 0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  const px = new Uint32Array(4); gl.readPixels(0, 0, 1, 1, gl.RGBA_INTEGER, gl.UNSIGNED_INT, px);
  return { error: gl.getError() || null, pixel: Array.from(px) };
}

/**
 * TGSI's SSG on WebGL2, in both stages: a vertex shader's sign of an attribute (-2.5, 0, 3, -0.5) into a flat varying,
 * the fragment shader's sign of that. ANGLE's D3D11 backend writes GLSL's sign() as HLSL's, which returns an int, and
 * floatBitsToUint of it took the int's bits. Returns the pixel (the result's bits).
 */
export function signs() {
  return drawBits(
    'VERT\nDCL IN[0]\nDCL IN[1]\nDCL OUT[0], POSITION\nDCL OUT[1], GENERIC[0]\nDCL TEMP[0]\n  0: SSG TEMP[0], IN[0]\n  1: MOV OUT[1], TEMP[0]\n  2: MOV OUT[0], IN[1]\n  3: END',
    'FRAG\nDCL IN[0], GENERIC[0], CONSTANT\nDCL OUT[0], COLOR\nDCL TEMP[0]\n  0: SSG TEMP[0], IN[0]\n  1: MOV OUT[0], TEMP[0]\n  2: END',
    [-2.5, 0, 3, -0.5],
  );
}

/**
 * Float constants copied into registers as bits, then added (dEQP-GLES2 shaders.random's scalar_conversion.74): the
 * lanes made of constants alone came out without them on ANGLE's D3D11 backend (4.0 + -3.5 + -0.5 gave -3.5), the
 * lanes mixed with an attribute right. Attribute 0 is (0.25, 0.625, 0, 0). Returns the pixel (the result's bits).
 */
export function constantRegisters() {
  return drawBits(
    `VERT
DCL IN[0]
DCL IN[1]
DCL OUT[0], POSITION
DCL OUT[1], GENERIC[0]
DCL TEMP[0..2]
IMM[0] UINT32 {3217031168, 1082130432, 1069547520, 1065353216}
IMM[1] FLT32 {5.0, -3.5, 6.0, 1.0}
IMM[2] UINT32 {3204448256, 3235905536, 0, 0}
  0: MOV TEMP[0].xyz, IMM[0]
  1: MOV TEMP[0].w, IN[0].xxxx
  2: ADD TEMP[1], TEMP[0], IMM[1]
  3: MOV TEMP[2].x, IN[0].yyyy
  4: MOV TEMP[2].yz, IMM[2].xxyx
  5: MOV TEMP[2].w, IMM[0].wwww
  6: ADD OUT[1], TEMP[1], TEMP[2]
  7: MOV OUT[0], IN[1]
  8: END`,
    'FRAG\nDCL IN[0], GENERIC[0], CONSTANT\nDCL OUT[0], COLOR\n  0: MOV OUT[0], IN[0]\n  1: END',
    [0.25, 0.625, 0, 0],
  );
}

/**
 * A vertex shader's shadow lookup at an explicit level (TGSI's TXL on a SHADOW2D view: dEQP-GLES3 texture_functions'
 * texturelod.sampler2dshadow_vertex) from a 4×4 DEPTH_COMPONENT16 texture of depth 0.75, the reference 0.5 under
 * LEQUAL (passes: 1) into a flat varying, generated with this browser's quirks (web/virgl-tgsi.ts `quirksOf`). On
 * ANGLE's D3D11 a `textureLod` there linked with an error in its log and the first draw lost the context. Returns the
 * pixel and whether the context was lost.
 */
export function vertexShadowLod() {
  const gl = new OffscreenCanvas(1, 1).getContext('webgl2')!;
  const vs = parseTgsi(`VERT
DCL IN[0]
DCL IN[1]
DCL OUT[0], POSITION
DCL OUT[1], GENERIC[0]
DCL SAMP[0]
DCL SVIEW[0], SHADOW2D, FLOAT
DCL TEMP[0]
  0: TXL TEMP[0], IN[0], SAMP[0], SHADOW2D
  1: MOV OUT[1], TEMP[0]
  2: MOV OUT[0], IN[1]
  3: END`);
  const fs = parseTgsi('FRAG\nDCL IN[0], GENERIC[0], CONSTANT\nDCL OUT[0], COLOR\n  0: MOV OUT[0], IN[0]\n  1: END');
  const p = generate(vs, fs, { attribs: ['f', 'f'], samplers: { vs: [{ type: 'f', swizzle: [0, 1, 2, 3], gl: '2D' }], fs: [] }, cbufs: [{ type: 'u', write: [0, 1, 2, 3] }] }, quirksOf(gl));
  const compile = (type: number, src: string) => { const sh = gl.createShader(type)!; gl.shaderSource(sh, src); gl.compileShader(sh); return sh; };
  const prog = gl.createProgram()!;
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, p.vs)); gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, p.fs)); gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return { error: gl.getProgramInfoLog(prog), pixel: [], lost: false };
  gl.useProgram(prog);
  gl.uniform1f(gl.getUniformLocation(prog, 'u_adjy'), 1);
  gl.uniform2f(gl.getUniformLocation(prog, 'u_adjz'), 1, 0);
  const depth = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, depth);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT16, 4, 4, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_SHORT, new Uint16Array(16).fill(0xc000));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
  gl.uniform1i(gl.getUniformLocation(prog, 'vs0'), 0);
  gl.activeTexture(gl.TEXTURE1);
  const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex); gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32UI, 1, 1);
  const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.viewport(0, 0, 1, 1);
  // (s, t, reference, lod)
  gl.vertexAttrib4f(0, 0.5, 0.5, 0.5, 0);
  const pos = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, pos);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 0, 1, 3, -1, 0, 1, -1, 3, 0, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 16, 0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  const px = new Uint32Array(4); gl.readPixels(0, 0, 1, 1, gl.RGBA_INTEGER, gl.UNSIGNED_INT, px);
  const error = gl.getError();
  return { error: error || null, pixel: Array.from(px), lost: gl.isContextLost() };
}

/**
 * A program ANGLE's D3D11 backend links though its HLSL compiler refused it (a derivative of a varying read as bits in
 * a loop: "error X3018: invalid subscript 'xy'" in the program's log, the link status true), linked by the renderer,
 * then drawn if it gave one. On D3D11 a draw with such a program can lose the context (the GPU process exits): the
 * renderer refuses it there. Returns whether it gave a program, its log lines and whether the context was lost.
 */
export function refusedProgram() {
  const gl = new OffscreenCanvas(1, 1).getContext('webgl2')!;
  const log: string[] = [];
  const r = new VirglRenderer(gl, { ram: () => [new Uint8Array(0)], log: (m) => log.push(m) });
  const vs = '#version 300 es\nlayout(location = 0) in vec4 a_0;\nlayout(location = 1) in vec4 a_1;\nout vec4 v_GENERIC0;\nvoid main() { v_GENERIC0 = a_1; gl_Position = a_0; }';
  const fs = `#version 300 es
precision highp float;
precision highp int;
uniform uvec4 fc0[4];
in vec4 v_GENERIC0;
layout(location = 0) out vec4 o0;
uvec4 t0 = uvec4(0u);
uvec4 t1 = uvec4(0u);
uvec4 t5 = uvec4(0u);
void main() {
  while (true) {
    if (ivec4(t0.xxxx).x >= ivec4(fc0[2].xxxx).x) break;
    t5.xy = uvec2((floatBitsToUint(dFdx(v_GENERIC0))).xy);
    t1.xy = uvec2((floatBitsToUint(uintBitsToFloat(t1.xyyy) + uintBitsToFloat(t5.xyyy))).xy);
    t0.x = t0.x + 1u;
  }
  o0 = uintBitsToFloat(t1);
}`;
  const d3d11 = !!quirksOf(gl).d3d11; // before any draw: a lost context answers nothing
  const prog = (r as unknown as { link(vs: string, fs: string): WebGLProgram | null }).link(vs, fs);
  if (prog) {
    gl.useProgram(prog);
    const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex); gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, 1, 1);
    const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.vertexAttrib4f(0, 0, 0, 0, 1); gl.vertexAttrib4f(1, 0.5, 0.5, 0.5, 1);
    gl.drawArrays(gl.POINTS, 0, 1);
    gl.getError();
  }
  return { linked: !!prog, d3d11, refused: log.filter((l) => l.includes("D3D's compiler refused it")).length, lost: gl.isContextLost() };
}

/**
 * A derivative in a loop whose count is a constant buffer's (dEQP-GLES3 derivate's uniform_loop cases): ANGLE's D3D11
 * backend writes such a derivative as a scalar 0, and a swizzle of it failed in its HLSL ("error X3018: invalid
 * subscript" in the program's log, the status true; at a draw that compiles it again, a lost context). Drawn into an
 * RGBA32F pixel with the count 0 (cbuf 0 unset). Returns the program's D3D errors, the pixel and the GL error.
 */
export function loopDerivative() {
  const gl = new OffscreenCanvas(1, 1).getContext('webgl2')!;
  gl.getExtension('EXT_color_buffer_float');
  const vs = parseTgsi('VERT\nDCL IN[0]\nDCL IN[1]\nDCL OUT[0], POSITION\nDCL OUT[1], GENERIC[0]\n  0: MOV OUT[1], IN[0]\n  1: MOV OUT[0], IN[1]\n  2: END');
  const fs = parseTgsi(`FRAG
DCL IN[0], GENERIC[0], PERSPECTIVE
DCL OUT[0], COLOR
DCL CONST[0][0]
DCL TEMP[0..2]
IMM[0] UINT32 {0, 1, 0, 0}
  0: MOV TEMP[0].x, IMM[0].xxxx
  1: MOV TEMP[1], IMM[0].xxxx
  2: BGNLOOP
  3:   ISGE TEMP[2].x, TEMP[0].xxxx, CONST[0][0].xxxx
  4:   UIF TEMP[2].xxxx
  5:     BRK
  6:   ENDIF
  7:   DDX TEMP[2].xy, IN[0]
  8:   ADD TEMP[1].xy, TEMP[1].xyyy, TEMP[2].xyyy
  9:   UADD TEMP[0].x, TEMP[0].xxxx, IMM[0].yyyy
 10: ENDLOOP
 11: MOV OUT[0], TEMP[1]
 12: END`);
  const p = generate(vs, fs, { attribs: ['f', 'f'], samplers: { vs: [], fs: [] }, cbufs: [{ type: 'f', write: [0, 1, 2, 3] }] });
  const compile = (type: number, src: string) => { const sh = gl.createShader(type)!; gl.shaderSource(sh, src); gl.compileShader(sh); return sh; };
  const prog = gl.createProgram()!;
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, p.vs)); gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, p.fs)); gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return { d3dErrors: [gl.getProgramInfoLog(prog)], pixel: [], error: null };
  const d3dErrors = (gl.getProgramInfoLog(prog) ?? '').match(/error X\d+[^\n]*/g) ?? [];
  if (d3dErrors.length) return { d3dErrors, pixel: [], error: null }; // a draw could lose the context
  gl.useProgram(prog);
  gl.uniform1f(gl.getUniformLocation(prog, 'u_adjy'), 1);
  gl.uniform2f(gl.getUniformLocation(prog, 'u_adjz'), 1, 0);
  const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex); gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, 1, 1);
  const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.viewport(0, 0, 1, 1);
  gl.vertexAttrib4f(0, 0.25, 0.5, 0, 1);
  const pos = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, pos);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 0, 1, 3, -1, 0, 1, -1, 3, 0, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 16, 0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  const px = new Float32Array(4); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, px);
  return { d3dErrors, pixel: Array.from(px), error: gl.getError() || null };
}

/**
 * An implicit-LOD lookup (TGSI's TEX) in a fragment shader's loop, as a blur's: a 64×64 texture of 7 levels, level L
 * filled with red 30·L, sampled over a 16×16 target at uv = the position's (λ = 2: red 60). The loop runs three
 * times, skips the first with CONT and adds half of each lookup. ANGLE's D3D11 backend samples level 0 in a loop with a
 * `break` or `continue` (and makes its derivatives 0): red 0. Generated with this browser's quirks. Returns the
 * centre pixel's red, the program's D3D errors and whether the context was lost.
 */
export function loopTexture() {
  const gl = new OffscreenCanvas(16, 16).getContext('webgl2')!;
  const vs = parseTgsi('VERT\nDCL IN[0]\nDCL OUT[0], POSITION\nDCL OUT[1], GENERIC[0]\nIMM[0] FLT32 {0.5, 0.0, 0.0, 0.0}\n  0: MAD OUT[1], IN[0], IMM[0].xxxx, IMM[0].xxxx\n  1: MOV OUT[0], IN[0]\n  2: END');
  const fs = parseTgsi(`FRAG
DCL IN[0], GENERIC[0], PERSPECTIVE
DCL OUT[0], COLOR
DCL SAMP[0]
DCL SVIEW[0], 2D, FLOAT
DCL TEMP[0..2]
IMM[0] UINT32 {0, 1, 3, 0}
IMM[1] FLT32 {0.5, 0.0, 0.0, 0.0}
  0: MOV TEMP[0].x, IMM[0].xxxx
  1: MOV TEMP[1], IMM[1].yyyy
  2: BGNLOOP
  3:   ISGE TEMP[2].x, TEMP[0].xxxx, IMM[0].zzzz
  4:   UIF TEMP[2].xxxx
  5:     BRK
  6:   ENDIF
  7:   UADD TEMP[0].x, TEMP[0].xxxx, IMM[0].yyyy
  8:   USEQ TEMP[2].x, TEMP[0].xxxx, IMM[0].yyyy
  9:   UIF TEMP[2].xxxx
 10:     CONT
 11:   ENDIF
 12:   TEX TEMP[2], IN[0], SAMP[0], 2D
 13:   MAD TEMP[1], TEMP[2], IMM[1].xxxx, TEMP[1]
 14: ENDLOOP
 15: MOV OUT[0], TEMP[1]
 16: END`);
  const p = generate(vs, fs, { attribs: ['f'], samplers: { vs: [], fs: [{ type: 'f', swizzle: [0, 1, 2, 3], gl: '2D' }] }, cbufs: [{ type: 'f', write: [0, 1, 2, 3] }] }, quirksOf(gl));
  const compile = (type: number, src: string) => { const sh = gl.createShader(type)!; gl.shaderSource(sh, src); gl.compileShader(sh); return sh; };
  const prog = gl.createProgram()!;
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, p.vs)); gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, p.fs)); gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return { d3dErrors: [gl.getProgramInfoLog(prog)], red: -1, lost: false };
  const d3dErrors = (gl.getProgramInfoLog(prog) ?? '').match(/error X\d+[^\n]*/g) ?? [];
  if (d3dErrors.length) return { d3dErrors, red: -1, lost: false }; // a draw could lose the context
  gl.useProgram(prog);
  gl.uniform1f(gl.getUniformLocation(prog, 'u_adjy'), 1);
  gl.uniform2f(gl.getUniformLocation(prog, 'u_adjz'), 1, 0);
  gl.uniform1i(gl.getUniformLocation(prog, 'fs0'), 0);
  const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex); gl.texStorage2D(gl.TEXTURE_2D, 7, gl.RGBA8, 64, 64);
  for (let l = 0; l < 7; l++) {
    const s = 64 >> l;
    const b = new Uint8Array(s * s * 4);
    for (let k = 0; k < s * s; k++) b.set([30 * l, 0, 0, 255], k * 4);
    gl.texSubImage2D(gl.TEXTURE_2D, l, 0, 0, s, s, gl.RGBA, gl.UNSIGNED_BYTE, b);
  }
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.activeTexture(gl.TEXTURE1);
  const target = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, target); gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, 16, 16);
  const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
  gl.viewport(0, 0, 16, 16);
  const pos = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, pos);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 0, 1, 3, -1, 0, 1, -1, 3, 0, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 16, 0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  const px = new Uint8Array(4); gl.readPixels(8, 8, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  gl.getError();
  return { d3dErrors, red: px[0], lost: gl.isContextLost() };
}

/**
 * A 3D machine's 2D scanout on the screen: the device (web/gpu.ts) with a host whose screen draws on WebGL2, a 4×4
 * resource of `format` filled with the guest's bytes `px`, transferred and shown. Returns the screen's centre pixel.
 */
export async function screen2d(format: number, px: number[]) {
  const gl = new OffscreenCanvas(4, 4).getContext('webgl2')!;
  const ram = new Uint8Array(4096);
  for (let k = 0; k < 64; k += 4) ram.set(px, k);
  const r = new VirglRenderer(gl, { ram: () => [ram] });
  const screen = new Screen(gl, r);
  const seen = new Promise<number[]>((ok) => (screen.probe = (...rgb) => ok(rgb)));
  const gpu = new Gpu(() => [ram], ramLayout(ram.length), { width: 4, height: 4 });
  gpu.host = localHost(r, screen);
  const cmd = (type: number, ...fields: (number | bigint)[]) => {
    const b = new Uint8Array(24 + fields.reduce<number>((n, f) => n + (typeof f === 'bigint' ? 8 : 4), 0));
    const v = new DataView(b.buffer);
    v.setUint32(0, type, true);
    let at = 24;
    for (const f of fields) { if (typeof f === 'bigint') { v.setBigUint64(at, f, true); at += 8; } else { v.setUint32(at, f, true); at += 4; } }
    return gpu.control(b, 64);
  };
  cmd(0x101, 1, format, 4, 4); // RESOURCE_CREATE_2D
  cmd(0x106, 1, 1, 0x4000_0000n, 64, 0); // RESOURCE_ATTACH_BACKING: one entry
  cmd(0x105, 0, 0, 4, 4, 0n, 1, 0); // TRANSFER_TO_HOST_2D
  cmd(0x103, 0, 0, 4, 4, 0, 1); // SET_SCANOUT
  return seen;
}

/**
 * A 2D machine's screen (web/gpu-present.ts) on a 4×4 OffscreenCanvas: WebGL2 (even SwiftShader, which `auto` would
 * leave to a 2D context), or the canvas 2D one with `canvas2d`.
 * A resource of `format` filled with the guest's bytes `px`, transferred, shown and flushed; returns whether the
 * device kept the guest's bytes, the screen's centre pixel, and with `lose` the centre pixel again after the
 * context was lost and restored, with nothing flushed since (the restore's own draw).
 */
export async function presenter2d(format: number, px: number[], canvas2d: boolean, lose: boolean) {
  const canvas = new OffscreenCanvas(4, 4);
  const hooks = canvasPresenter(canvas, undefined, false, false, canvas2d ? 'canvas2d' : 'webgl2');
  const ram = new Uint8Array(4096);
  for (let k = 0; k < 64; k += 4) ram.set(px, k);
  const gpu = new Gpu(() => [ram], ramLayout(ram.length), { width: 4, height: 4 });
  gpu.hooks = hooks;
  const cmd = (type: number, ...fields: (number | bigint)[]) => {
    const b = new Uint8Array(24 + fields.reduce<number>((n, f) => n + (typeof f === 'bigint' ? 8 : 4), 0));
    const v = new DataView(b.buffer);
    v.setUint32(0, type, true);
    let at = 24;
    for (const f of fields) { if (typeof f === 'bigint') { v.setBigUint64(at, f, true); at += 8; } else { v.setUint32(at, f, true); at += 4; } }
    return gpu.control(b, 64);
  };
  const gl = canvas2d ? null : canvas.getContext('webgl2');
  const centre = () => {
    const p = new Uint8Array(4);
    if (gl) gl.readPixels(2, 2, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, p);
    else p.set((canvas.getContext('2d') as OffscreenCanvasRenderingContext2D).getImageData(2, 2, 1, 1).data);
    return Array.from(p.subarray(0, 3));
  };
  cmd(0x101, 1, format, 4, 4); // RESOURCE_CREATE_2D
  cmd(0x106, 1, 1, 0x4000_0000n, 64, 0); // RESOURCE_ATTACH_BACKING: one entry
  cmd(0x105, 0, 0, 4, 4, 0n, 1, 0); // TRANSFER_TO_HOST_2D
  cmd(0x103, 0, 0, 4, 4, 0, 1); // SET_SCANOUT
  cmd(0x104, 0, 0, 4, 4, 1, 0); // RESOURCE_FLUSH: drawn at once (no draw a frame before it)
  const raw = !!hooks.raw && gpu.resources.get(1)!.pixels.every((b, k) => b === ram[k]);
  const first = centre();
  if (!lose || !gl) return { raw, first };
  const ext = gl.getExtension('WEBGL_lose_context')!;
  const event = (name: string) => new Promise((ok) => canvas.addEventListener(name, ok, { once: true }));
  const gone = event('webglcontextlost');
  ext.loseContext();
  await gone;
  await new Promise((ok) => setTimeout(ok, 0)); // out of the event's dispatch: restoring inside it isn't allowed yet
  const back = event('webglcontextrestored');
  ext.restoreContext();
  await back;
  // The presenter's draw is on the next animation frame, asked for before this one's: read in the same frame.
  const restored = await new Promise<number[]>((ok) => requestAnimationFrame(() => ok(centre())));
  return { raw, first, restored };
}

/**
 * Occlusion queries of two contexts, and of two sub-contexts of one, open at once on the one WebGL2 context: what
 * their results say and whether a fence after them is answered (`FenceGate`). Each query's state (struct
 * virgl_host_query_state: state, size, result) is read from the guest's memory, and again after a transfer from the host.
 */
export async function overlappingQueries() {
  const gl = new OffscreenCanvas(16, 16).getContext('webgl2')!;
  const ram = new Uint8Array(4096);
  const log: string[] = [];
  const r = new VirglRenderer(gl, { ram: () => [ram], log: (m) => log.push(m) });
  const f = (v: number) => new Uint32Array(new Float32Array([v]).buffer)[0];
  const text = (s: string) => { const b = new TextEncoder().encode(s + '\0'); const w = new Uint32Array(Math.ceil(b.length / 4)); new Uint8Array(w.buffer).set(b); return [b.length, ...w]; };
  const VS = 'VERT\nDCL IN[0]\nDCL OUT[0], POSITION\n  0: MOV OUT[0], IN[0]\n  1: END\n';
  const FS = 'FRAG\nDCL OUT[0], COLOR\nIMM[0] FLT32 {1.0, 0.0, 0.0, 1.0}\n  0: MOV OUT[0], IMM[0]\n  1: END\n';
  // Resources: 5 the queries' states (in the guest's memory), then per context a vertex buffer and a 16×16 target.
  const res = (ctx: number, d: Partial<ResourceDesc> & { id: number }) => { r.createResource({ target: 0, format: 64, bind: 0x10, width: 16, height: 1, depth: 1, arraySize: 1, lastLevel: 0, samples: 0, flags: 0, ...d }); r.attach(ctx, d.id); };
  const contexts = [1, 2];
  for (const c of contexts) r.createContext(c);
  res(1, { id: 5, bind: 0x800, width: 256 });
  r.attach(2, 5);
  r.attachBacking(5, [{ off: 0, len: 256, mem: 0 }]);
  // The state of a context's current sub-context: a triangle over the whole target, or one off it (no samples).
  const setup = (cmd: (c: number, obj: number, ...p: number[]) => void, vb: number, rt: number) => {
    cmd(9, 0, vb, 0, 0, 0, 0, 0, 0, 0, 96, 1, 1, ...[-1, -1, 0, 1, 3, -1, 0, 1, -1, 3, 0, 1, 5, 5, 0, 1, 6, 5, 0, 1, 5, 6, 0, 1].map(f));
    const [vl, ...vt] = text(VS), [fl, ...ft] = text(FS);
    cmd(1, 4, 10, 0, vl, 0, 0, ...vt); cmd(1, 4, 11, 1, fl, 0, 0, ...ft);
    cmd(31, 0, 10, 0); cmd(31, 0, 11, 1);
    cmd(1, 5, 20, 0, 0, 0, 31); cmd(2, 5, 20); // one R32G32B32A32_FLOAT
    cmd(1, 2, 21, 1 << 1, f(1), 0, 0, f(1), 0, 0, 0); cmd(2, 2, 21);
    cmd(1, 8, 22, rt, 1, 0, 0); cmd(5, 0, 1, 0, 22);
    cmd(4, 0, 0, f(8), f(8), f(1), f(8), f(8), f(0));
    cmd(6, 0, 16, 0, vb);
  };
  const stream = () => {
    const words: number[] = [];
    const cmd = (c: number, obj: number, ...p: number[]) => words.push(c | obj << 8 | p.length << 16, ...p);
    return { words, cmd, draw: (start: number) => cmd(8, 0, start, 3, 4, 0, 1, 0, 0, 0, 0, 0, 0, 0) };
  };
  for (const c of contexts) {
    res(c, { id: 10 * c, width: 96 });
    res(c, { id: 10 * c + 1, target: 2, format: 1, bind: 2, height: 16 });
  }
  // Each context's sub-context 0 set up; context 1's sub-context 1 too, drawing into context 1's target.
  for (const c of contexts) {
    const s = stream();
    setup(s.cmd, 10 * c, 10 * c + 1);
    if (c === 1) { s.cmd(29, 0, 1); s.cmd(28, 0, 1); setup(s.cmd, 10, 11); s.cmd(28, 0, 0); }
    r.submit(c, new Uint32Array(s.words));
  }
  const PREDICATE = 1;
  const query = (s: ReturnType<typeof stream>, h: number, offset: number) => s.cmd(1, 9, h, PREDICATE, offset, 5);
  // Two contexts: 1 begins (drawing nothing in it), 2 begins, draws and ends, 1 ends in a later submit.
  let s = stream(); query(s, 40, 0); s.cmd(19, 0, 40); r.submit(1, new Uint32Array(s.words));
  s = stream(); query(s, 41, 16); s.cmd(19, 0, 41); s.draw(0); s.cmd(20, 0, 41); r.submit(2, new Uint32Array(s.words));
  s = stream(); s.draw(3); s.cmd(20, 0, 40); r.submit(1, new Uint32Array(s.words));
  // Two sub-contexts of context 1 in one submit: 0 begins, 1 begins, draws and ends, 0 draws off the target and ends.
  s = stream(); query(s, 42, 32); s.cmd(19, 0, 42);
  s.cmd(28, 0, 1); query(s, 43, 48); s.cmd(19, 0, 43); s.draw(0); s.cmd(20, 0, 43);
  s.cmd(28, 0, 0); s.draw(3); s.cmd(20, 0, 42); r.submit(1, new Uint32Array(s.words));
  const answered: string[] = [];
  const gate = new FenceGate<string>((x) => answered.push(x));
  gate.fence('after', r.queriesSettled());
  // Results come after the task that ended the queries: polled for up to a second, as the GPU worker does.
  for (let k = 0; k < 100 && !answered.length; k++) {
    await new Promise((ok) => setTimeout(ok, 10));
    r.pollQueries();
    gate.release();
  }
  const dv = new DataView(ram.buffer);
  const state = (o: number) => ({ state: dv.getUint32(o, true), result: Number(dv.getBigUint64(o + 8, true)) });
  const states = { contexts: [state(0), state(16)], subs: [state(32), state(48)] };
  // The states again after a transfer of the buffer from the host (Mesa's `get_query_result` reads them that way when
  // a wait found them not DONE: the transfer must bring the states, not overwrite them).
  r.transfer(1, 5, 0, { x: 0, y: 0, z: 0, w: 64, h: 1, d: 1 }, 0, 0, 0, false);
  return { answered, ...states, readBack: [state(0), state(16), state(32), state(48)], log, glError: gl.getError() };
}

/**
 * Draws that sample what they draw into (WebGL refuses them as feedback loops; the renderer samples copies): a 2D
 * texture's level 0 drawn while sampled through a red↔blue swizzle (the texels as they were: red becomes blue), and
 * an array's layer 0 drawn while its layer 1 is sampled. Returns each target's centre texel after the draw.
 */
export function feedbackDraws() {
  const gl = new OffscreenCanvas(16, 16).getContext('webgl2')!;
  const log: string[] = [];
  const r = new VirglRenderer(gl, { ram: () => [new Uint8Array(0)], log: (m) => log.push(m) });
  r.createContext(1);
  const f = (v: number) => new Uint32Array(new Float32Array([v]).buffer)[0];
  const text = (src: string) => { const b = new TextEncoder().encode(src + '\0'); const w = new Uint32Array(Math.ceil(b.length / 4)); new Uint8Array(w.buffer).set(b); return [b.length, ...w]; };
  const res = (d: Partial<ResourceDesc> & { id: number }) => { r.createResource({ target: 2, format: 67, bind: 0xa, width: 4, height: 4, depth: 1, arraySize: 1, lastLevel: 0, samples: 0, flags: 0, ...d }); r.attach(1, d.id); };
  res({ id: 1, target: 0, format: 64, bind: 0x10, width: 48, height: 1 });
  res({ id: 2, lastLevel: 1 }); // 2D, two levels
  res({ id: 3, target: 7, arraySize: 2 }); // an array of two layers
  const words: number[] = [];
  const cmd = (c: number, obj: number, ...p: number[]) => words.push(c | obj << 8 | p.length << 16, ...p);
  const shader = (h: number, type: number, src: string) => { const [len, ...t] = text(src); cmd(1, 4, h, type, len, 0, 0, ...t); };
  cmd(9, 0, 1, 0, 0, 0, 0, 0, 0, 0, 48, 1, 1, ...[-1, -1, 0, 1, 3, -1, 0, 1, -1, 3, 0, 1].map(f));
  shader(10, 0, 'VERT\nDCL IN[0]\nDCL OUT[0], POSITION\n  0: MOV OUT[0], IN[0]\n  1: END\n');
  shader(11, 1, 'FRAG\nDCL OUT[0], COLOR\nDCL SAMP[0]\nDCL SVIEW[0], 2D, FLOAT\nIMM[0] FLT32 {0.5, 0.5, 0.0, 0.0}\n  0: TEX OUT[0], IMM[0], SAMP[0], 2D\n  1: END\n');
  shader(12, 1, 'FRAG\nDCL OUT[0], COLOR\nDCL SAMP[0]\nDCL SVIEW[0], 2D_ARRAY, FLOAT\nIMM[0] FLT32 {0.5, 0.5, 1.0, 0.0}\n  0: TEX OUT[0], IMM[0], SAMP[0], 2D_ARRAY\n  1: END\n');
  cmd(31, 0, 10, 0);
  cmd(1, 5, 20, 0, 0, 0, 31); cmd(2, 5, 20);
  cmd(1, 2, 21, 1 << 1, f(1), 0, 0, f(1), 0, 0, 0); cmd(2, 2, 21);
  cmd(6, 0, 16, 0, 1);
  cmd(4, 0, 0, f(2), f(2), f(1), f(2), f(2), f(0));
  cmd(1, 7, 30, 0, f(0), f(0), f(1000), 0, 0, 0, 0); cmd(18, 0, 1, 0, 30); // nearest, mipmapped (nearest)
  const clear = (surface: number, rgba: number[]) => { cmd(5, 0, 1, 0, surface); cmd(7, 0, 4, ...rgba.map(f), 0, 0, 0); };
  const BGRA = 2 | 1 << 3 | 0 << 6 | 3 << 9, RGBA = 0 | 1 << 3 | 2 << 6 | 3 << 9;
  // The 2D texture: level 0 red, level 1 green; drawn into level 0, sampling levels 0–1 (level 0 at this LOD) as BGRA.
  cmd(1, 8, 40, 2, 67, 0, 0); cmd(1, 8, 41, 2, 67, 1, 0);
  clear(40, [1, 0, 0, 1]); clear(41, [0, 1, 0, 1]);
  cmd(1, 6, 42, 2, 67 | 2 << 24, 0, 0 | 1 << 8, BGRA); cmd(10, 0, 1, 0, 42);
  cmd(31, 0, 11, 1); cmd(5, 0, 1, 0, 40);
  cmd(8, 0, 0, 3, 4, 0, 1, 0, 0, 0, 0, 0, 2, 0);
  // The array: layer 0 red, layer 1 green; drawn into layer 0, sampling layer 1.
  cmd(1, 8, 50, 3, 67, 0, 0); cmd(1, 8, 51, 3, 67, 0, 1 | 1 << 16);
  clear(50, [1, 0, 0, 1]); clear(51, [0, 1, 0, 1]);
  cmd(1, 6, 52, 3, 67 | 7 << 24, 0 | 1 << 16, 0, RGBA); cmd(10, 0, 1, 0, 52);
  cmd(31, 0, 12, 1); cmd(5, 0, 1, 0, 50);
  cmd(8, 0, 0, 3, 4, 0, 1, 0, 0, 0, 0, 0, 2, 0);
  r.submit(1, new Uint32Array(words));
  const glError = gl.getError();
  // Each target's centre texel (level 1 is 2×2), read from its texture.
  const tex = (id: number) => (r as unknown as { resources: Map<number, { tex: WebGLTexture }> }).resources.get(id)!.tex;
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fbo);
  const texel = (attach: () => void, at = 2) => { attach(); const px = new Uint8Array(4); gl.readPixels(at, at, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); return [...px]; };
  return {
    level0: texel(() => gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex(2), 0)),
    level1: texel(() => gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex(2), 1), 1),
    layer0: texel(() => gl.framebufferTextureLayer(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, tex(3), 0, 0)),
    layer1: texel(() => gl.framebufferTextureLayer(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, tex(3), 0, 1)),
    copies: r.stats.feedbackCopies, glError, log,
  };
}
