// Fuzzing virgl's stream decoder (docs/testing.md "virgl fuzzing"): the traces guests sent (tests/virgl/*.vglt)
// replayed through the device into the renderer on the recording WebGL2 (tests/virgl-mock-gl.ts), with their
// SUBMIT_3D streams, data records (staging buffers: vertices, indices, video bitstreams) and 3D resource commands
// mutated. The guest controls every word of these, and WebGL validates only what the renderer hands it, so the
// renderer's own reading of them must hold. A case is a seed: the same seed is the same case.
//
// What counts as a defect (`Finding`):
//   escape  an exception out of the device or the renderer (the GPU worker's call loop would stop)
//   fault   an exception a command's decoding caught that isn't an `Error` thrown on purpose: a TypeError (a field
//           read from something missing), a RangeError (a view or an allocation the guest sized), ...
//   memory  a case whose resources keep more than `MEMORY_LIMIT` (a guest-sized copy)
//   slow    a case that took longer than `SLOW_MS` (a loop the guest sized)
// `tests/virgl.test.ts` runs a few hundred seeded cases; `node tests/virgl-fuzz.ts` runs for longer (below).
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { localHost } from '../web/virgl-host.ts';
import { VirglRenderer } from '../web/virgl-renderer.ts';
import { replay } from '../web/virgl-replay.ts';
import { TgsiError } from '../web/virgl-tgsi.ts';
import type { DecoderFactory } from '../web/virgl-video.ts';
import { encodeRecord, encodeTrace, readTrace, type TraceRecord } from '../web/virgl-trace.ts';
import { mockGl } from './virgl-mock-gl.ts';

const HDR = 24;
const CREATE_3D = 0x204, TRANSFER_TO_HOST_3D = 0x205, TRANSFER_FROM_HOST_3D = 0x206, SUBMIT_3D = 0x207;
export const MEMORY_LIMIT = 256 << 20, SLOW_MS = 2000;

/** The traces fuzzed: the GL ones and a video one a codec (AV1's with its coding tools). */
export const TRACES = [
  'glcomp-128x96.vglt', 'sway-640.vglt.gz', 'deqp-gles2-stencil-stride.vglt.gz', 'deqp-gles3-fragment-out-int.vglt.gz',
  'deqp-gles3-fragment-out-r11f.vglt.gz', 'video-vp9.vglt.gz', 'video-h264.vglt.gz', 'video-av1-tools.vglt.gz',
];

export type Finding = { kind: 'escape' | 'fault' | 'memory' | 'slow'; message: string; /** The first frame in web/. */ where: string };
export type Seed = { name: string; records: TraceRecord[]; /** Indices into `records` of the SUBMIT_3Ds. */ submits: number[] };

export function loadSeeds(names = TRACES): Seed[] {
  return names.map((name) => {
    const b = readFileSync(new URL(`virgl/${name}`, import.meta.url));
    const records = [...readTrace(new Uint8Array(name.endsWith('.gz') ? gunzipSync(b) : b))];
    const submits = records.flatMap((r, k) => (r.kind === 'command' && type(r.bytes) === SUBMIT_3D ? [k] : []));
    return { name, records, submits };
  });
}

const type = (c: Uint8Array) => new DataView(c.buffer, c.byteOffset, c.length).getUint32(0, true);

/** mulberry32, as tests/gpu.test.ts's. */
function prng(seed: number) {
  let s = seed | 0;
  const next = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
  const int = (n: number) => Math.floor(next() * n);
  return { next, int, pick: <T>(a: readonly T[]) => a[int(a.length)] };
}
type Rnd = ReturnType<typeof prng>;

const INTERESTING = [
  0, 1, 2, 3, 4, 7, 8, 15, 16, 31, 32, 63, 64, 255, 256, 0x7fff, 0x8000, 0xffff, 0x10000, 0x7fffffff, 0x80000000,
  0xfffffffe, 0xffffffff, 0x3f800000, 0xbf800000, 0x7f800000, 0xff800000, 0x7fc00000, 0x00000001, 0x4b800000,
];
const NUMBERS = ['0', '1', '7', '8', '31', '32', '255', '65535', '65536', '2147483647', '4294967295', '4294967296', '99999999999', '-1', '1e309', 'nan'];

/** A word: an interesting value, the word nudged, a bit flipped, or small. */
function word(r: Rnd, w: number) {
  switch (r.int(5)) {
    case 0: case 1: return r.pick(INTERESTING);
    case 2: return (w + r.int(9) - 4) >>> 0;
    case 3: return (w ^ (1 << r.int(32))) >>> 0;
    default: return r.int(r.pick([4, 64, 4096, 0x40000]));
  }
}

type Cmd = Uint32Array;

/** A stream's commands (each its header and payload); a stream that runs past its end is kept as one tail. */
function commands(words: Uint32Array): Cmd[] {
  const out: Cmd[] = [];
  for (let at = 0; at < words.length;) {
    const len = words[at] >>> 16;
    const end = Math.min(words.length, at + 1 + len);
    out.push(words.slice(at, end));
    at = end;
  }
  return out;
}

/** One mutation of a stream's commands, `dict` the commands of every seed (spliced in). */
function mutateStream(r: Rnd, cmds: Cmd[], dict: Cmd[]) {
  const k = r.int(cmds.length + 1);
  const c = cmds[k];
  const op = c ? r.int(10) : 7;
  switch (op) {
    case 0: case 1: case 2: { // a payload word
      if (c.length < 2) return;
      const at = 1 + r.int(c.length - 1);
      c[at] = word(r, c[at]);
      return;
    }
    case 3: { // the command or object type (the length kept)
      if (r.next() < 0.5) c[0] = (c[0] & ~0xff) | r.int(64);
      else c[0] = (c[0] & ~0xff00) | (r.int(16) << 8);
      return;
    }
    case 4: { // the length: payload cut or grown with junk, the header saying so (or not)
      const len = Math.max(0, c.length - 1 + r.int(9) - 6);
      const n = new Uint32Array(1 + len);
      n.set(c.subarray(0, Math.min(c.length, n.length)));
      for (let j = c.length; j < n.length; j++) n[j] = word(r, 0);
      n[0] = (n[0] & 0xffff) | ((r.next() < 0.9 ? len : word(r, len) & 0xffff) << 16);
      cmds[k] = n;
      return;
    }
    case 5: { // bytes of the payload (a shader's text, mostly)
      if (c.length < 2) return;
      const b = new Uint8Array(c.buffer, c.byteOffset + 4, (c.length - 1) * 4);
      textMutation(r, b);
      return;
    }
    case 6: cmds.splice(k, 1); return;
    case 7: { // another seed's command (an object type it never used, a draw where nothing is bound), maybe changed
      const d = r.pick(dict).slice();
      if (d.length > 1 && r.next() < 0.5) d[1 + r.int(d.length - 1)] = word(r, 0);
      cmds.splice(k, 0, d);
      return;
    }
    case 8: cmds.splice(k, 0, c.slice()); return;
    default: { // the handles: one of the small numbers the guest's objects have
      if (c.length < 2) return;
      c[1 + r.int(c.length - 1)] = r.int(r.pick([4, 32, 256]));
    }
  }
}

/** Bytes changed: a number in text replaced by another, a character, a byte or a run cut. */
function textMutation(r: Rnd, b: Uint8Array) {
  if (!b.length) return;
  const at = r.int(b.length);
  switch (r.int(4)) {
    case 0: { // a number (a register index, an immediate) made big, small or odd
      let s = at;
      while (s < b.length && !(b[s] >= 0x30 && b[s] <= 0x39)) s++;
      if (s === b.length) break;
      let e = s;
      while (e < b.length && b[e] >= 0x30 && b[e] <= 0x39) e++;
      const n = new TextEncoder().encode(r.pick(NUMBERS));
      // Written over what follows (the payload's length stays).
      b.set(n.subarray(0, b.length - s), s);
      if (n.length < e - s) b.fill(0x20, s + n.length, e);
      return;
    }
    case 1: b[at] = r.pick([0, 0x0a, 0x20, 0x2c, 0x2e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2d, 0x3a]); return;
    case 2: b[at] ^= 1 << r.int(8); return;
    default: b.fill(r.pick([0, 0x20]), at, Math.min(b.length, at + 1 + r.int(64)));
  }
}

function mutateSubmit(r: Rnd, cmd: Uint8Array, dict: Cmd[]): Uint8Array {
  const v = new DataView(cmd.buffer, cmd.byteOffset, cmd.length);
  const size = Math.min(v.getUint32(HDR, true), cmd.length - HDR - 8) & ~3;
  const cmds = commands(new Uint32Array(cmd.slice(HDR + 8, HDR + 8 + size).buffer));
  for (let n = 1 + r.int(4); n > 0; n--) mutateStream(r, cmds, dict);
  const words = cmds.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(HDR + 8 + 4 * words);
  out.set(cmd.subarray(0, HDR + 8));
  let at = HDR + 8;
  for (const c of cmds) {
    out.set(new Uint8Array(c.buffer, c.byteOffset, c.byteLength), at);
    at += c.byteLength;
  }
  new DataView(out.buffer).setUint32(HDR, 4 * words, true);
  return out;
}

/** A 3D resource's description or a 3D transfer's box, offset, level and strides: one field. */
function mutateDevice(r: Rnd, cmd: Uint8Array): Uint8Array {
  const out = cmd.slice(), v = new DataView(out.buffer);
  const fields = type(cmd) === CREATE_3D ? 11 : 12;
  const at = HDR + 4 * r.int(fields);
  if (at + 4 <= out.length) v.setUint32(at, word(r, v.getUint32(at, true)), true);
  return out;
}

export type Case = { trace: Uint8Array; seed: Seed; mutations: number };

/**
 * The case for `seed`: a seed trace's prefix up to a few submits past a chosen one, with mutations in that window
 * (its submits' streams, the data records and resource commands among them).
 */
export function makeCase(seeds: Seed[], dict: Cmd[], seed: number): Case {
  const r = prng(seed);
  const s = r.pick(seeds);
  const first = s.submits.length ? r.int(s.submits.length) : 0;
  const lastSubmit = Math.min(s.submits.length - 1, first + r.int(4));
  const from = s.submits[first] ?? 0, to = s.submits[lastSubmit] ?? s.records.length - 1;
  // Where the window starts: back to the commands that made what its first submit uses, sometimes.
  const start = r.next() < 0.3 ? Math.max(0, from - r.int(200)) : from;
  const records: (TraceRecord | Uint8Array)[] = [];
  let mutations = 0;
  for (let k = 0; k <= to; k++) {
    const rec = s.records[k];
    if (k < start || rec.kind === 'note') { records.push(rec); continue; }
    if (rec.kind === 'data') {
      if (r.next() < 0.1) {
        const bytes = rec.bytes.slice();
        for (let n = 1 + r.int(8); n > 0; n--) textMutation(r, bytes);
        records.push({ ...rec, bytes });
        mutations++;
      } else records.push(rec);
      continue;
    }
    const t = type(rec.bytes);
    if (t === SUBMIT_3D && r.next() < 0.7) {
      records.push({ kind: 'command', bytes: mutateSubmit(r, rec.bytes, dict) });
      mutations++;
    } else if ((t === CREATE_3D || t === TRANSFER_TO_HOST_3D || t === TRANSFER_FROM_HOST_3D) && r.next() < 0.05) {
      records.push({ kind: 'command', bytes: mutateDevice(r, rec.bytes) });
      mutations++;
    } else records.push(rec);
  }
  return { trace: encodeTrace(records.map((x) => (x instanceof Uint8Array ? x : encodeRecord(x)))), seed: s, mutations };
}

/** Every command of every seed's streams (what a mutation splices in). */
export function dictionary(seeds: Seed[]): Cmd[] {
  const seen = new Set<string>(), out: Cmd[] = [];
  for (const s of seeds) {
    for (const k of s.submits) {
      const c = (s.records[k] as { bytes: Uint8Array }).bytes;
      const size = new DataView(c.buffer, c.byteOffset).getUint32(HDR, true);
      for (const cmd of commands(new Uint32Array(c.slice(HDR + 8, HDR + 8 + size).buffer))) {
        // One of each command and object type at each length (sway's thousands of draws are a few kinds).
        const key = `${cmd[0]}:${cmd.length > 64 ? 'long' : cmd.slice(1, 3).join()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(cmd);
      }
    }
  }
  return out;
}

/** Where in web/ an exception came from: its first frame there. */
function where(e: unknown) {
  const m = e instanceof Error ? e.stack?.match(/web\/[\w./-]+:\d+/) : null;
  return m ? m[0] : '?';
}

/** An exception thrown on purpose: a plain `Error` (the decoders' "bad X"), the TGSI parser's. */
const deliberate = (e: unknown) => e instanceof TgsiError || (e instanceof Error && e.constructor === Error);

/** Decoders that take every chunk and give no picture: the guest's bitstreams are parsed (web/video-h264.ts, -av1.ts), and
 * without decoders they aren't. */
const nullDecoder: DecoderFactory = () => ({ decode() {}, flush: () => Promise.resolve(), close() {} });

/** Runs a trace (a case's, or a reproducer's) and returns its defects. */
export function runTrace(trace: Uint8Array): { findings: Finding[]; errors: number; ms: number } {
  const findings: Finding[] = [];
  let r: VirglRenderer | undefined;
  const t0 = performance.now();
  try {
    replay(trace, (ram) => {
      r = new VirglRenderer(mockGl(), { ram, log: () => {}, video: { decoders: nullDecoder, hardware: [] } });
      r.onCaught = (e) => {
        if (!deliberate(e)) findings.push({ kind: 'fault', message: `${e instanceof Error ? e.name : typeof e}: ${e instanceof Error ? e.message : String(e)}`, where: where(e) });
      };
      return localHost(r);
    });
  } catch (e) {
    findings.push({ kind: 'escape', message: `${e instanceof Error ? e.name : typeof e}: ${e instanceof Error ? e.message : String(e)}`, where: where(e) });
  }
  const ms = performance.now() - t0;
  // What the renderer keeps of the guest's sizes: buffers' copies, kept texels and blocks. (Array buffers alive after a
  // collection, `process.memoryUsage()`'s, flagged cases that didn't repeat alone: V8 frees them on a thread of its own.)
  let kept = 0;
  for (const x of r?.resources.values() ?? []) {
    kept += x.shadow?.length ?? 0;
    for (const m of [x.texels, x.blocks]) for (const b of m?.values() ?? []) kept += b.length;
  }
  if (kept > MEMORY_LIMIT) findings.push({ kind: 'memory', message: `resources keep ${(kept / 2 ** 20).toFixed(0)} MiB`, where: '?' });
  if (ms > SLOW_MS) findings.push({ kind: 'slow', message: `${ms.toFixed(0)} ms`, where: '?' });
  return { findings, errors: r?.stats.errors ?? 0, ms };
}

/** A finding's class: its kind, where, and its message without numbers. */
export const findingKey = (f: Finding) => `${f.kind} ${f.where} ${f.message.replace(/\d+/g, '#').slice(0, 100)}`;

// `node tests/virgl-fuzz.ts [seconds] [first seed]`: cases from the seed on, in a child process the parent watches (a
// case that hangs is killed after `HANG_MS` and reported); each new class of finding is printed with its seed and its
// trace written to bench/results/local/virgl-fuzz/<seed>.vglt. `node tests/virgl-fuzz.ts --run <file|seed>` runs one
// case and prints what it found (to debug a reproducer).
const HANG_MS = 10_000;
if (import.meta.main) {
  const { fork } = await import('node:child_process');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  if (process.argv[2] === '--child') {
    const seeds = loadSeeds(), dict = dictionary(seeds);
    for (let seed = Number(process.argv[3]); ; seed++) {
      const c = makeCase(seeds, dict, seed);
      process.send!({ seed });
      const out = runTrace(c.trace);
      if (out.findings.length) process.send!({ seed, findings: out.findings });
    }
  } else if (process.argv[2] === '--run') {
    const arg = process.argv[3];
    const trace = /^\d+$/.test(arg) ? makeCase(loadSeeds(), dictionary(loadSeeds()), Number(arg)).trace : new Uint8Array(readFileSync(arg));
    const out = runTrace(trace);
    console.log(`${out.ms.toFixed(0)} ms, ${out.errors} renderer errors`);
    for (const f of out.findings) console.log(findingKey(f), '|', f.message);
  } else {
    const seconds = Number(process.argv[2] ?? 60), from = Number(process.argv[3] ?? 1);
    const dir = new URL('../bench/results/local/virgl-fuzz/', import.meta.url);
    mkdirSync(dir, { recursive: true });
    const seeds = loadSeeds(), dict = dictionary(seeds);
    const classes = new Map<string, number>();
    const end = Date.now() + seconds * 1000;
    let cases = 0, next = from;
    const report = (seed: number, fs: Finding[]) => {
      for (const f of fs) {
        const key = findingKey(f);
        classes.set(key, (classes.get(key) ?? 0) + 1);
        if (classes.get(key) !== 1) continue;
        console.log(`seed ${seed}: ${key}\n  ${f.message}`);
        writeFileSync(new URL(`${seed}.vglt`, dir), makeCase(seeds, dict, seed).trace);
      }
    };
    while (Date.now() < end) {
      const child = fork(new URL(import.meta.url), ['--child', String(next)]);
      let current = next, last = Date.now(), died = false;
      child.on('message', (m: { seed: number; findings?: Finding[] }) => {
        if (m.findings) return report(m.seed, m.findings);
        current = m.seed;
        cases++;
        last = Date.now();
      });
      child.on('exit', (code, signal) => {
        if (!child.killed) report(current, [{ kind: 'escape', message: `the child died (${code ?? signal})`, where: '?' }]);
        died = true;
      });
      // Until the time is up, the child dies, or a case hangs (then the next child starts past it).
      while (Date.now() < end && !died && Date.now() - last < HANG_MS) await new Promise((ok) => setTimeout(ok, 200));
      if (!died && Date.now() - last >= HANG_MS) report(current, [{ kind: 'slow', message: `hung (killed after ${HANG_MS / 1000} s)`, where: '?' }]);
      child.kill('SIGKILL');
      next = current + 1;
    }
    console.log(`${cases} cases (seeds ${from}..${next - 1}), ${classes.size} classes of finding`);
    for (const [k, n] of [...classes].sort((a, b) => b[1] - a[1])) console.log(`${String(n).padStart(6)}  ${k}`);
  }
}
