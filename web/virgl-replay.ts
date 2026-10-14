// Replays a virgl trace (web/virgl-trace.ts) through the device (web/gpu.ts) into a host (a renderer): the
// renderer's tests (tests/virgl.test.ts against a recording WebGL2, tests/virgl-browser.test.ts on Chromium's) and
// tools. The guest's RAM is made up: every resource's backing gets a region of its own, laid out as the trace's
// ATTACH_BACKING says (its entries' lengths, one run), and the trace's data records are written there before the
// commands that read them.
import { Gpu } from './gpu.ts';
import { readTrace } from './virgl-trace.ts';
import type { VirglHost } from './virgl-host.ts';

const RAM_BASE = 0x4000_0000;
const ATTACH_BACKING = 0x106, SUBMIT_3D = 0x207, RESOURCE_FLUSH = 0x104;

export type ReplayResult = {
  gpu: Gpu;
  ram: Uint8Array;
  /** Each SUBMIT_3D's reply type (0x1100: OK). */
  replies: number[];
  flushes: number;
  notes: string[];
  /** Where each resource's backing is in `ram`. */
  regions: Map<number, { off: number; len: number }>;
};

/**
 * `until` stops the replay after a command (`lastSubmit`: after the trace's last SUBMIT_3D, before a client's exit
 * frees what it drew).
 */
export function replay(trace: Uint8Array, host: (ram: () => Uint8Array) => VirglHost | undefined, o: ReplayOptions = {}): ReplayResult {
  const steps = replaySteps(trace, host, o);
  for (let s = steps.next(); ; s = steps.next()) if (s.done) return s.value;
}

/**
 * `replay` for a host that runs calls later (the GPU worker's queue, web/virgl-host.ts `CallQueue`): before writing
 * a data record into a backing, `settle` waits until the calls before it have run (as the guest waits for a fence
 * before it writes a staging buffer again).
 */
export async function replayAsync(trace: Uint8Array, host: (ram: () => Uint8Array) => VirglHost | undefined, settle: () => Promise<void>, o: ReplayOptions = {}): Promise<ReplayResult> {
  const steps = replaySteps(trace, host, o);
  for (let s = steps.next(); ; s = steps.next()) {
    if (s.done) return s.value;
    await settle();
  }
}

type ReplayOptions = { width?: number; height?: number; caps?: Uint8Array; until?: (r: { submits: number; flushes: number }) => boolean; lastSubmit?: boolean };

/** The replay, pausing before each data record. */
function* replaySteps(trace: Uint8Array, host: (ram: () => Uint8Array) => VirglHost | undefined, o: ReplayOptions): Generator<void, ReplayResult> {
  // Pass 1: the RAM the backings need, and the submits.
  let size = 0, total = 0;
  for (const r of readTrace(trace)) {
    if (r.kind !== 'command') continue;
    const v = new DataView(r.bytes.buffer, r.bytes.byteOffset, r.bytes.length);
    if (v.getUint32(0, true) === SUBMIT_3D) total++;
    if (v.getUint32(0, true) !== ATTACH_BACKING) continue;
    const n = v.getUint32(28, true);
    for (let k = 0; k < n; k++) size += v.getUint32(32 + 16 * k + 8, true);
  }
  const ram = new Uint8Array(new SharedArrayBuffer(Math.max(4096, (size + 4095) & ~4095)));
  const gpu = new Gpu(() => ram, ram.length, { width: o.width ?? 1024, height: o.height ?? 768, virgl: true, caps: o.caps });
  gpu.host = host(() => ram);
  const regions = new Map<number, { off: number; len: number }>();
  const replies: number[] = [], notes: string[] = [];
  let next = 0, submits = 0, flushes = 0;
  for (const r of readTrace(trace)) {
    if (r.kind === 'note') { notes.push(r.text); continue; }
    if (r.kind === 'data') {
      yield;
      const g = regions.get(r.res);
      if (g && r.offset + r.bytes.length <= g.len) ram.set(r.bytes, g.off + r.offset);
      continue;
    }
    let cmd = r.bytes;
    const v = new DataView(cmd.buffer, cmd.byteOffset, cmd.length);
    const type = v.getUint32(0, true);
    if (type === ATTACH_BACKING) {
      // One entry, in the made-up RAM.
      const id = v.getUint32(24, true), n = v.getUint32(28, true);
      let len = 0;
      for (let k = 0; k < n; k++) len += v.getUint32(32 + 16 * k + 8, true);
      regions.set(id, { off: next, len });
      cmd = new Uint8Array(48);
      cmd.set(r.bytes.subarray(0, 24));
      const w = new DataView(cmd.buffer);
      w.setUint32(24, id, true);
      w.setUint32(28, 1, true);
      w.setBigUint64(32, BigInt(RAM_BASE + next), true);
      w.setUint32(40, len, true);
      next += len;
    }
    const reply = gpu.control(cmd, 4096);
    if (type === SUBMIT_3D) {
      replies.push(new DataView(reply.buffer, reply.byteOffset).getUint32(0, true));
      submits++;
    }
    if (type === RESOURCE_FLUSH) flushes++;
    if (o.until?.({ submits, flushes }) || (o.lastSubmit && submits === total)) break;
  }
  return { gpu, ram, replies, flushes, notes, regions };
}
