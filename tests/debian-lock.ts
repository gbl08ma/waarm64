// One Debian page boot at a time across test files (node --test runs files
// concurrently): tests/start.test.ts and tests/page-debian.test.ts each boot the
// page's Debian in realtime on 2–4 vCPU workers, and together, beside the rest of
// `npm test`, they loaded the host enough that realtime tests with 1 ms windows
// (the parallel bare-metal timer.bin) failed (M8 loop 6). A directory in the temp
// directory is the lock; its `pid` file lets a waiter take over from a dead holder.
// WAARM64_DEBIAN_SLOTS lets that many boots run at once (scripts/ci-debian.sh, scripts/ci-graphics.sh, scripts/ci-machines.sh and scripts/ci-net.sh, where nothing else
// runs beside them): a slot is a directory each, given to the waiters in the order of their `chain` hints, then first come.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LOCK = join(tmpdir(), 'waarm64-debian-page.lock');
const SLOTS = Math.max(1, Number(process.env.WAARM64_DEBIAN_SLOTS ?? 1));
/** WAARM64_DEBIAN_TIMES=1 prints each hold (where a suite's time goes); the start is the process's. */
const START = Date.now() - performance.now();

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** The waiters' queue: a file each, `<pid>-<n>`, holding `<chain> <since>` (below). */
const QUEUE = `${LOCK}.queue`;
let waits = 0;

/** The waiters as the queue holds them now, dead ones' files removed. */
function waiters() {
  const out: { name: string; chain: number; since: number }[] = [];
  let names: string[] = [];
  try { names = readdirSync(QUEUE); } catch { return out; }
  for (const name of names) {
    let text = '';
    try { text = readFileSync(join(QUEUE, name), 'utf8'); } catch { continue; } // removed meanwhile
    const pid = Number(name.split('-')[0]);
    if (!alive(pid)) { rmSync(join(QUEUE, name), { force: true }); continue; }
    const [chain, since] = text.split(' ').map(Number);
    if (Number.isFinite(chain) && Number.isFinite(since)) out.push({ name, chain, since });
  }
  return out;
}

/** What a wait for a slot is given: `chain` (below), and the longest wait, ms. */
export type DebianLockOptions = { chain?: number; ms?: number };

/**
 * Waits for a slot (at most `ms`), runs `f`, releases it. A test's own `timeout` counts the wait:
 * give it the wait and its run (25 min: with the snapshot tests the queue outlasted a 10 min one).
 *
 * A free slot goes to the waiter with the longest `chain` first, then the earliest: `chain` is a hint, the slot-seconds
 * the test's file still has from this test on when they run one after another (its own hold and its later tests'), so
 * a suite's longest file doesn't start last and become its tail (scripts/ci-machines.sh, 2026-11-18). Absent: 0.
 */
export async function withDebianLock<T>(f: () => Promise<T>, o: DebianLockOptions | number = {}): Promise<T> {
  const { chain = 0, ms = 15 * 60_000 } = typeof o === 'number' ? { ms: o } : o;
  const until = Date.now() + ms;
  const me = `${process.pid}-${waits++}`;
  mkdirSync(QUEUE, { recursive: true });
  writeFileSync(join(QUEUE, me), `${chain} ${Date.now()}`);
  let held = '';
  try {
    while (!held) {
      // The waiters ahead (a longer chain, or as long and earlier) take the free slots first.
      const queue = waiters();
      const mine = queue.find((w) => w.name === me) ?? { name: me, chain, since: 0 };
      const ahead = queue.filter((w) => w.name !== me && (w.chain > mine.chain || (w.chain === mine.chain && (w.since < mine.since || (w.since === mine.since && w.name < me))))).length;
      const pids: number[] = [];
      let free = 0;
      const open: string[] = [];
      for (let i = 0; i < SLOTS; i++) {
        const lock = i ? `${LOCK}.${i}` : LOCK;
        let pid = 0;
        try {
          pid = Number(readFileSync(join(lock, 'pid'), 'utf8'));
        } catch {
          if (!existsSync(lock)) { free++; open.push(lock); continue; }
          // being created or removed
        }
        if (pid && !alive(pid)) rmSync(lock, { recursive: true, force: true });
        pids.push(pid);
      }
      if (ahead < free) {
        for (const lock of open) {
          try {
            mkdirSync(lock);
            writeFileSync(join(lock, 'pid'), String(process.pid));
            held = lock;
            break;
          } catch { /* taken meanwhile */ }
        }
      }
      if (held) break;
      if (Date.now() > until) throw new Error(`waited ${ms / 1000} s for ${LOCK} (${SLOTS} slot${SLOTS > 1 ? 's' : ''}, held by pids ${pids}, ${ahead} waiting ahead)`);
      await new Promise((r) => setTimeout(r, 250));
    }
  } finally {
    rmSync(join(QUEUE, me), { force: true });
  }
  const t = Date.now();
  try {
    return await f();
  } finally {
    rmSync(held, { recursive: true, force: true });
    if (process.env.WAARM64_DEBIAN_TIMES) console.log(`# debian slot ${held.slice(LOCK.length) || '.0'}: held ${((Date.now() - t) / 1000).toFixed(0)} s, from +${((t - START) / 1000).toFixed(0)} s (pid ${process.pid}, at ${new Date(t).toISOString().slice(11, 19)})`);
  }
}
