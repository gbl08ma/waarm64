// Per-stage timers for the disk I/O benchmark (bench/io, M8 track IOSPEED): a blk device spec with `stats` wraps
// its base reads, its overlay's OPFS files and its request handling, and reports counts, time and bytes per stage
// and a histogram of request sizes when the VM closes. Off otherwise: nothing here runs.
import type { SyncFile } from './overlay.ts';

type Stage = { n: number; ms: number; bytes: number };

export class IoStats {
  private stages = new Map<string, Stage>();
  /** Requests by kind and log2 of their size in bytes. */
  private sizes = new Map<string, Map<number, number>>();
  /** `poll` calls and the time inside them. */
  polls = 0;
  /** Every base read as [start ms on the epoch clock (`timeOrigin` + `now`), offset, length, ms]: what a remote disk's reads were, in order. */
  private trace: number[] = [];

  /** A base read (`fn` reads `len` bytes at `off`), timed as `base.read` and traced. */
  read<T>(off: number, len: number, fn: () => T): T {
    const t = performance.now();
    try {
      return fn();
    } finally {
      const ms = performance.now() - t;
      this.add('base.read', len, ms);
      this.trace.push(+(performance.timeOrigin + t).toFixed(1), off, len, +ms.toFixed(2));
    }
  }

  /** Runs `fn`, adding its time to stage `name` (`bytes`: what it moved). */
  time<T>(name: string, bytes: number, fn: () => T): T {
    const t = performance.now();
    try {
      return fn();
    } finally {
      this.add(name, bytes, performance.now() - t);
    }
  }

  add(name: string, bytes: number, ms: number) {
    const s = this.stages.get(name) ?? { n: 0, ms: 0, bytes: 0 };
    s.n++;
    s.ms += ms;
    s.bytes += bytes;
    this.stages.set(name, s);
  }

  size(kind: string, bytes: number) {
    const m = this.sizes.get(kind) ?? new Map<number, number>();
    const k = bytes > 0 ? Math.ceil(Math.log2(bytes)) : 0;
    m.set(k, (m.get(k) ?? 0) + 1);
    this.sizes.set(kind, m);
  }

  /** `read` for a read that doesn't block (`readAsync`): its time is until it resolves, overlapping others'. */
  async readAsync<T>(off: number, len: number, fn: () => Promise<T>): Promise<T> {
    const t = performance.now();
    try {
      return await fn();
    } finally {
      const ms = performance.now() - t;
      this.add('base.read', len, ms);
      this.trace.push(+(performance.timeOrigin + t).toFixed(1), off, len, +ms.toFixed(2));
    }
  }

  /** An OPFS file with its reads, writes and flushes timed as `<name>.read` etc. */
  file(name: string, f: SyncFile): SyncFile {
    return {
      read: (buf, o) => this.time(`${name}.read`, buf.length, () => f.read(buf, o)),
      write: (buf, o) => this.time(`${name}.write`, buf.length, () => f.write(buf, o)),
      getSize: () => f.getSize(),
      truncate: (n) => this.time(`${name}.truncate`, 0, () => f.truncate(n)),
      flush: () => this.time(`${name}.flush`, 0, () => f.flush()),
    };
  }

  json() {
    return {
      trace: this.trace,
      stages: Object.fromEntries([...this.stages].map(([k, s]) => [k, { n: s.n, ms: +s.ms.toFixed(2), bytes: s.bytes }])),
      sizes: Object.fromEntries([...this.sizes].map(([k, m]) => [k, Object.fromEntries([...m].sort((a, b) => a[0] - b[0]).map(([b, n]) => [`<=${2 ** b}`, n]))])),
    };
  }
}
