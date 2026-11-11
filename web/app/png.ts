// PNGs for the host's clipboard (docs/plans/clipboard.md §4.4), made in a worker of their own (web/app/png-worker.ts):
// the guest's image in another type converted (`toPng`), and the screen's pixels encoded (`rgbaPng`: "Copy the
// screen" on a 3D machine, whose GPU worker reads them back). A worker for each, ended once it answered: they are
// rare, and a big image's decoding then holds no memory after it.
import type { FromPng, ToPng } from './png-worker.ts';

function inWorker(m: ToPng, transfer: Transferable[] = []): Promise<Blob> {
  const worker = new Worker(new URL('./png-worker.ts', import.meta.url), { type: 'module' });
  return new Promise<Blob>((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<FromPng>) =>
      'png' in e.data ? resolve(e.data.png) : reject(new DOMException(e.data.error, 'DataError'));
    worker.onerror = (e) => reject(new DOMException(e.message || 'the PNG worker failed', 'DataError'));
    worker.postMessage(m, transfer);
  }).finally(() => worker.terminate());
}

/** An image the browser decodes (JPEG, BMP, WebP, GIF, …) as a PNG of the same pixels. */
export const toPng = (image: Blob) => inWorker({ image });

/** RGBA pixels, top row first, as a PNG (the pixels are handed to the worker). */
export const rgbaPng = (width: number, height: number, pixels: Uint8Array<ArrayBuffer>) =>
  inWorker({ width, height, pixels }, [pixels.buffer]);
