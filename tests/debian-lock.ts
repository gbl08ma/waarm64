// One Debian page boot at a time across test files (node --test runs files
// concurrently): tests/start.test.ts and tests/page-debian.test.ts each boot the
// page's Debian in realtime on 2–4 vCPU workers, and together, beside the rest of
// `npm test`, they loaded the host enough that realtime tests with 1 ms windows
// (the parallel bare-metal timer.bin) failed (M8 loop 6). A directory in the temp
// directory is the lock; its `pid` file lets a waiter take over from a dead holder.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LOCK = join(tmpdir(), 'webpc-debian-page.lock');

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Waits for the lock (at most `ms`), runs `f`, releases it. */
export async function withDebianLock<T>(f: () => Promise<T>, ms = 15 * 60_000): Promise<T> {
  if (ms) return f(); // EXPERIMENT: no lock
  const until = Date.now() + ms;
  for (;;) {
    try {
      mkdirSync(LOCK);
      writeFileSync(join(LOCK, 'pid'), String(process.pid));
      break;
    } catch {
      let pid = 0;
      try {
        pid = Number(readFileSync(join(LOCK, 'pid'), 'utf8'));
      } catch { /* being created or removed */ }
      if (pid && !alive(pid)) rmSync(LOCK, { recursive: true, force: true });
      else if (Date.now() > until) throw new Error(`waited ${ms / 1000} s for ${LOCK} (held by pid ${pid})`);
      else await new Promise((r) => setTimeout(r, 500));
    }
  }
  try {
    return await f();
  } finally {
    rmSync(LOCK, { recursive: true, force: true });
  }
}
