// For tests/browser.test.ts and tests/page-disks.test.ts: opens and closes an OPFS overlay (web/overlay.ts), or sets its generation,
// when asked, as a machine's device worker does, and says when (ms since the
// epoch, comparable across workers).
import { openOverlay, readMeta, writeMeta, type OverlayFiles } from '../../web/overlay.ts';

let files: OverlayFiles | undefined;
const now = () => performance.timeOrigin + performance.now();
self.onmessage = async (e: MessageEvent<{ type: 'open' | 'close' | 'meta'; name: string; waitMs?: number; generation?: number }>) => {
  const { type, name, waitMs } = e.data;
  try {
    if (type === 'meta') {
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
