// The simple-framebuffer on a canvas (docs/devices.md): the guest draws into its
// framebuffer in guest RAM (x8r8g8b8, packed rows); every animation frame
// copies it into an ImageData (opaque RGBA) and puts it on the canvas.
// ponytail: a full copy per frame, no dirty tracking; track dirty rows (or move to virtio-gpu) if it shows in a profile.

export type Framebuffer = { addr: number; width: number; height: number };

/** Draws `fb` (in `memory`) to `canvas` on each animation frame until `stop`; `draw` draws once now. */
export function showFramebuffer(canvas: HTMLCanvasElement, memory: WebAssembly.Memory, fb: Framebuffer) {
  [canvas.width, canvas.height] = [fb.width, fb.height];
  const ctx = canvas.getContext('2d')!;
  const img = new ImageData(fb.width, fb.height);
  const dst = new Uint32Array(img.data.buffer);
  const draw = () => {
    const src = new Uint32Array(memory.buffer, fb.addr, dst.length); // anew: the buffer changes when memory grows
    for (let k = 0; k < dst.length; k++) {
      const p = src[k]; // 0xXXRRGGBB → ImageData's bytes R, G, B, A (0xAABBGGRR little-endian)
      dst[k] = 0xff000000 | ((p & 0xff) << 16) | (p & 0xff00) | ((p >>> 16) & 0xff);
    }
    ctx.putImageData(img, 0, 0);
  };
  let id = requestAnimationFrame(function frame() {
    draw();
    id = requestAnimationFrame(frame);
  });
  return { draw, stop: () => cancelAnimationFrame(id) };
}
