// For tests/browser.test.ts: opens and closes an OPFS overlay (web/overlay.ts)
// when asked, as a machine's device worker does, and says when (ms since the
// epoch, comparable across workers).
import { openOverlay, type OverlayFiles } from '../../web/overlay.ts';

let files: OverlayFiles | undefined;
const now = () => performance.timeOrigin + performance.now();
self.onmessage = async (e: MessageEvent<{ type: 'open' | 'close'; name: string; waitMs?: number }>) => {
  const { type, name, waitMs } = e.data;
  try {
    if (type === 'open') {
      files = await openOverlay(name, `${location.origin}/disk.img`, 1 << 20, waitMs);
      self.postMessage({ type: 'opened', at: now() });
    } else {
      files?.close();
      self.postMessage({ type: 'closed', at: now() });
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err), at: now() });
  }
};
