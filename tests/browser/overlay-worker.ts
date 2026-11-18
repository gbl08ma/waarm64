// For tests/browser.test.ts, tests/page-disks.test.ts and tests/page-unrestorable.test.ts: opens and closes an OPFS
// overlay (web/overlay.ts), sets its generation, or writes a stored disk in place and keeps it open (`inPlace`), when
// asked, as a machine's device worker does, and says when (ms since the epoch, comparable across workers).
import { openOverlay, overlay, readMeta, writeMeta, type OverlayFiles } from '../../web/overlay.ts';
import { openStoredForWriting, zeroDisk } from '../../web/stored.ts';

let files: OverlayFiles | undefined;
const now = () => performance.timeOrigin + performance.now();
type Ask = { type: 'open' | 'close' | 'meta' | 'inPlace'; name: string; waitMs?: number; generation?: number; identity?: string; size?: number };
self.onmessage = async (e: MessageEvent<Ask>) => {
  const { type, name, waitMs } = e.data;
  try {
    if (type === 'inPlace') {
      // Stored disk `name` opened for writing and a block written, held open as a running machine holds it.
      files = await openStoredForWriting(name, e.data.identity!, e.data.size!);
      const d = overlay(zeroDisk(e.data.size!), files.data, files.map, files.meta);
      if (!(await d.write(0, new Uint8Array(4096).fill(1)))) throw new Error('the write failed');
      d.flush();
      self.postMessage({ type: 'written', generation: d.generation(), at: now() });
    } else if (type === 'meta') {
      // Sets the generation of overlay (or stored disk) `name`, as machines that wrote it would have left it.
      const f = await openOverlay(name, undefined);
      writeMeta(f.meta, { ...readMeta(f.meta), generation: e.data.generation! });
      f.close();
      self.postMessage({ type: 'meta', at: now() });
    } else if (type === 'open') {
      files = await openOverlay(name, JSON.stringify({ path: '/disk.img', size: 1 << 20 }), waitMs);
      self.postMessage({ type: 'opened', at: now() });
    } else {
      files?.close();
      self.postMessage({ type: 'closed', at: now() });
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err), at: now() });
  }
};
