// The page of bench/video/upload.ts: what a decoded picture costs between its arrays and its textures, where the
// picture is smaller than its planes (1080p in 1920×1088 planes), so it also goes into a texture of its own size for
// draws to sample (web/virgl-renderer.ts `writePicture`, `Res.picture`). The arms, NV12's R8 luma and RG8 chroma:
//   plane   the planes' uploads alone (the floor: what a picture of its planes' size costs)
//   twice   each plane uploaded, then its picture's rows uploaded again into the picture texture (the path until
//           2026-11-24, kept here as the reference arm)
//   copy    each plane uploaded, then the picture texture filled from it on the GPU (`copyTexSubImage2D`)
//   blit    the same through `blitFramebuffer`
// A picture ends with one texel read back from what a draw would sample, so its GPU work is in its time.
export const ARMS = ['plane', 'twice', 'copy', 'blit'] as const;
export type Arm = (typeof ARMS)[number];
export type Result = { renderer: string; plane: string; picture: string; equal: Record<Arm, boolean>; ms: Record<Arm, number[]>; callsMs: Record<Arm, number[]> };

export async function run(width: number, height: number, rounds: number, pictures: number): Promise<Result> {
  const W = (width + 15) & ~15, H = (height + 15) & ~15;
  const cw = (width + 1) >> 1, ch = (height + 1) >> 1, CW = W / 2, CH = H / 2;
  const gl = new OffscreenCanvas(16, 16).getContext('webgl2')!;
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = String(gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
  const tex = (internal: number, w: number, h: number) => {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, internal, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, 0);
    return t;
  };
  const fboOf = (t: WebGLTexture) => {
    const f = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    return f;
  };
  // A plane, its picture texture, and a framebuffer on each.
  const planes = [
    { fmt: gl.RED, bpp: 1, W, H, w: width, h: height, plane: tex(gl.R8, W, H), pic: tex(gl.R8, width, height) },
    { fmt: gl.RG, bpp: 2, W: CW, H: CH, w: cw, h: ch, plane: tex(gl.RG8, CW, CH), pic: tex(gl.RG8, cw, ch) },
  ].map((p) => ({ ...p, planeFbo: fboOf(p.plane), picFbo: fboOf(p.pic) }));
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
  // Six pictures' arrays (a decoder's: one array a picture, the luma then the chroma), used in turn.
  const at = W * H;
  const data = Array.from({ length: 6 }, (_, k) => {
    const d = new Uint8Array(at + 2 * CW * CH);
    for (let i = 0; i < d.length; i++) d[i] = (i * 31 + (i >> 9) * 7 + k * 53) & 0xff;
    return d;
  });
  const px = new Uint8Array(4);
  const put = (arm: Arm, d: Uint8Array) => {
    for (const [k, p] of planes.entries()) {
      const bytes = k ? d.subarray(at) : d.subarray(0, at);
      gl.bindTexture(gl.TEXTURE_2D, p.plane);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, p.W, p.H, p.fmt, gl.UNSIGNED_BYTE, bytes);
      if (arm === 'plane') continue;
      if (arm === 'twice') {
        gl.bindTexture(gl.TEXTURE_2D, p.pic);
        gl.pixelStorei(gl.UNPACK_ROW_LENGTH, p.W);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, p.w, p.h, p.fmt, gl.UNSIGNED_BYTE, bytes);
        gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
      } else if (arm === 'copy') {
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, p.planeFbo);
        gl.bindTexture(gl.TEXTURE_2D, p.pic);
        gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, p.w, p.h);
      } else {
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, p.planeFbo);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, p.picFbo);
        gl.blitFramebuffer(0, 0, p.w, p.h, 0, 0, p.w, p.h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      }
    }
  };
  /** One texel of what a draw would sample, read back: the picture's GPU work is done when it returns. */
  const sync = (arm: Arm) => {
    for (const p of planes) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, arm === 'plane' ? p.planeFbo : p.picFbo);
      gl.readPixels(p.w - 1, p.h - 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    }
  };
  /** Whether the textures a draw samples hold the picture's bytes. */
  const check = (arm: Arm, d: Uint8Array) => {
    for (const [k, p] of planes.entries()) {
      const w = arm === 'plane' ? p.W : p.w, h = arm === 'plane' ? p.H : p.h;
      const got = new Uint8Array(w * h * 4);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, arm === 'plane' ? p.planeFbo : p.picFbo);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, got);
      const src = k ? d.subarray(at) : d.subarray(0, at);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++)
          for (let c = 0; c < p.bpp; c++) if (got[(y * w + x) * 4 + c] !== src[(y * p.W + x) * p.bpp + c]) return false;
    }
    return true;
  };
  const rec = <T>(f: () => T) => Object.fromEntries(ARMS.map((a) => [a, f()])) as Record<Arm, T>;
  const equal = rec(() => true), ms = rec(() => [] as number[]), callsMs = rec(() => [] as number[]);
  for (const arm of ARMS)
    for (const d of data) {
      put(arm, d);
      equal[arm] &&= check(arm, d);
    }
  const round = (arm: Arm) => {
    let calls = 0;
    const t0 = performance.now();
    for (let k = 0; k < pictures; k++) {
      const t = performance.now();
      put(arm, data[k % data.length]);
      calls += performance.now() - t;
      sync(arm);
    }
    ms[arm].push((performance.now() - t0) / pictures);
    callsMs[arm].push(calls / pictures);
  };
  for (const arm of ARMS) round(arm);
  for (const arm of ARMS) ms[arm].length = callsMs[arm].length = 0; // a warm-up of each
  // The arms in turn, the order rotated each round.
  for (let r = 0; r < rounds; r++) {
    for (let k = 0; k < ARMS.length; k++) round(ARMS[(k + r) % ARMS.length]);
    await new Promise((ok) => setTimeout(ok, 0));
  }
  if (gl.getError()) throw new Error('GL error');
  return { renderer, plane: `${W}x${H}`, picture: `${width}x${height}`, equal, ms, callsMs };
}
