// Overlay files in memory (web/overlay.ts `memFile`) that log each operation, for tests of what a bulk write leaves
// durable: what a file had written after its last flush is what a power loss may lose.
import { memFile } from '../web/overlay.ts';

/** Files like `memFile`'s that log each operation: what was written after a file's last flush is what a power loss may lose. */
export function loggedFiles() {
  const ops: { file: string; op: 'write' | 'truncate' | 'flush' }[] = [];
  const logged = (file: string) => {
    const f = memFile();
    return Object.assign(f, {
      write: ((w) => (buf: Uint8Array, o: { at: number }) => { ops.push({ file, op: 'write' }); return w(buf, o); })(f.write),
      truncate: ((t) => (size: number) => { ops.push({ file, op: 'truncate' }); t(size); })(f.truncate),
      flush: () => { ops.push({ file, op: 'flush' }); },
    });
  };
  /** The file's changes since its last flush (none: all of it durable). */
  const unflushed = (file: string) => {
    const last = ops.findLastIndex((o) => o.file === file && o.op === 'flush');
    return ops.slice(last + 1).filter((o) => o.file === file).length;
  };
  return { ops, data: logged('data'), map: logged('map'), meta: logged('meta'), unflushed, flushes: (file: string) => ops.filter((o) => o.file === file && o.op === 'flush').length };
}
