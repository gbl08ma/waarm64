// Images to PNG off the page's thread (docs/plans/clipboard.md §4.4; web/app/png.ts starts it): an image the guest copied
// in another type (a JPEG, a BMP, …), decoded by `createImageBitmap` and drawn on an `OffscreenCanvas`, or a screen's
// RGBA pixels put on one; then `convertToBlob` as PNG, the one image type the host's clipboard takes from the page.

/** To the worker: an image to convert, or RGBA pixels (top row first) to encode. */
export type ToPng = { image: Blob } | { width: number; height: number; pixels: Uint8Array<ArrayBuffer> };
/** From the worker: the PNG, or why there is none. */
export type FromPng = { png: Blob } | { error: string };

async function convert(m: ToPng): Promise<Blob> {
  let canvas: OffscreenCanvas;
  if ('image' in m) {
    // As the image's pixels are: no colour space conversion, alpha as it is.
    const bitmap = await createImageBitmap(m.image, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
    bitmap.close();
  } else {
    canvas = new OffscreenCanvas(m.width, m.height);
    canvas
      .getContext('2d')!
      .putImageData(
        new ImageData(
          new Uint8ClampedArray(m.pixels.buffer, m.pixels.byteOffset, m.width * m.height * 4),
          m.width,
          m.height,
        ),
        0,
        0,
      );
  }
  return canvas.convertToBlob({ type: 'image/png' });
}

self.onmessage = (e: MessageEvent<ToPng>) => {
  convert(e.data).then(
    (png) => self.postMessage({ png } satisfies FromPng),
    (err) => self.postMessage({ error: String(err) } satisfies FromPng),
  );
};
