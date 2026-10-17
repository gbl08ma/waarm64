// One Debian page boot at a time across test files (node --test runs files
// concurrently): tests/start.test.ts and tests/page-debian.test.ts each boot the
// page's Debian in realtime on 2–4 vCPU workers, and together, beside the rest of
// `npm test`, they loaded the host enough that realtime tests with 1 ms windows
// (the parallel bare-metal timer.bin) failed (M8 loop 6). A directory in the temp
// directory is the lock; its `pid` file lets a waiter take over from a dead holder.
// WEBPC_DEBIAN_SLOTS lets that many boots run at once (scripts/ci-debian.sh and scripts/ci-machines.sh, where nothing else
// runs beside them): a slot is a directory each.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LOCK = join(tmpdir(), 'webpc-debian-page.lock');
const SLOTS = Math.max(1, Number(process.env.WEBPC_DEBIAN_SLOTS ?? 1));
/** WEBPC_DEBIAN_TIMES=1 prints each hold (where a suite's time goes); the start is the process's. */
const START = Date.now() - performance.now();

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Waits for the lock (at most `ms`), runs `f`, releases it. A test's own `timeout` counts the wait:
 * give it the wait and its run (25 min: with the snapshot tests the queue outlasted a 10 min one).
 */
export async function withDebianLock<T>(f: () => Promise<T>, ms = 15 * 60_000): Promise<T> {
  const until = Date.now() + ms;
  let held = '';
  while (!held) {
    const pids: number[] = [];
    for (let i = 0; i < SLOTS && !held; i++) {
      const lock = i ? `${LOCK}.${i}` : LOCK;
      try {
        mkdirSync(lock);
        writeFileSync(join(lock, 'pid'), String(process.pid));
        held = lock;
      } catch {
        let pid = 0;
        try {
          pid = Number(readFileSync(join(lock, 'pid'), 'utf8'));
        } catch { /* being created or removed */ }
        if (pid && !alive(pid)) rmSync(lock, { recursive: true, force: true });
        pids.push(pid);
      }
    }
    if (held) break;
    if (Date.now() > until) throw new Error(`waited ${ms / 1000} s for ${LOCK} (${SLOTS} slot${SLOTS > 1 ? 's' : ''}, held by pids ${pids})`);
    await new Promise((r) => setTimeout(r, 500));
  }
  const t = Date.now();
  try {
    return await f();
  } finally {
    rmSync(held, { recursive: true, force: true });
    if (process.env.WEBPC_DEBIAN_TIMES) console.log(`# debian slot ${held.slice(LOCK.length) || '.0'}: held ${((Date.now() - t) / 1000).toFixed(0)} s, from +${((t - START) / 1000).toFixed(0)} s (pid ${process.pid})`);
  }
}
