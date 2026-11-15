// The page's snapshot phases, as tools read them (`#message`'s `data-snapshot` and `data-load`: web/app/protocol.ts
// `SaveTimes`, `LoadPhases`; docs/frontend.md "Snapshots"): every phase there, a number of ms, and the parts within
// their whole. The page tests that save and load a snapshot check them on the way.
import assert from 'node:assert/strict';
import { availableParallelism } from 'node:os';
import type { LoadPhases, SaveTimes } from '../web/app/protocol.ts';

// Every key of each (the compiler holds them complete).
const SAVE: Record<keyof SaveTimes, true> = { state: true, blobs: true, ram: true, disk: true, scan: true, compress: true, crc: true, sink: true, pool: true, pause: true, close: true, poolWait: true, poolReady: true };
const LOAD: Record<keyof LoadPhases, true> = { check: true, checkRead: true, checkCrc: true, state: true, ram: true, apply: true, disk: true, read: true, crc: true, unpack: true, prepare: true, start: true, total: true };

/** Every key of `keys` in `phases` and no other, each a number of ms. */
function numbers(phases: unknown, keys: Record<string, true>, what: string) {
  assert.ok(phases && typeof phases === 'object', `${what}: no phases`);
  const p = phases as Record<string, unknown>;
  for (const k of Object.keys(keys)) assert.ok(typeof p[k] === 'number' && Number.isFinite(p[k]) && p[k] >= 0, `${what}: phase ${k} is ${String(p[k])}`);
  assert.deepEqual(Object.keys(p).sort(), Object.keys(keys).sort(), `${what}: the phases' names`);
  return p as Record<string, number>;
}
/** What a sum of phases may be over its whole, ms (each phase is timed on its own). */
const SLACK = 5;

/** A save's `data-snapshot` (parsed): its kind, and its phases within the pause. */
export function checkSave(info: { kind?: unknown; pausedMs?: unknown; phases?: unknown }, kind: 'file' | 'kept' | 'suspend') {
  assert.equal(info.kind, kind, 'the save says its kind');
  const p = numbers(info.phases, SAVE, `a ${kind} save`);
  const paused = info.pausedMs as number;
  assert.ok(p.pause + p.state + p.blobs + p.ram + p.disk <= paused + SLACK, `a ${kind} save's phases are within its pause (${paused} ms): ${JSON.stringify(p)}`);
  // RAM's scan, codec and CRC are the pool's workers' sums when it has one (CPU time: up to `pool` times RAM's wall).
  // The page's saves go through a pool where the host has a thread to spare (web/snapshot-pool.ts `poolSize`: the
  // headless browser's `hardwareConcurrency` is this host's).
  assert.ok(Number.isInteger(p.pool) && (p.pool > 0 || p.poolReady === 0), `a ${kind} save's pool: ${JSON.stringify(p)}`);
  if (availableParallelism() > 1) assert.ok(p.pool > 0, `a ${kind} save went through no pool: ${JSON.stringify(p)}`);
  assert.ok(p.scan + p.compress + p.crc + p.sink <= p.blobs + p.ram * Math.max(1, p.pool) + p.disk + SLACK, `a ${kind} save's frames' times are within its frames: ${JSON.stringify(p)}`);
  return p;
}

/** A start from a snapshot's `data-load` (its JSON): its phases within its total. */
export function checkLoad(json: string | undefined) {
  assert.ok(json, 'a start from a snapshot says its phases');
  const p = numbers(JSON.parse(json), LOAD, 'a load');
  assert.ok(p.prepare + p.check + p.state + p.ram + p.disk + p.start <= p.total + SLACK, `a load's phases are within its total: ${JSON.stringify(p)}`);
  assert.ok(p.checkRead + p.checkCrc <= p.check + SLACK && p.apply <= p.ram + SLACK, `a load's parts are within their phases: ${JSON.stringify(p)}`);
}
