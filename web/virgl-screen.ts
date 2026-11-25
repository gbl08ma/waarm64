// The screen of a 3D machine (docs/frontend.md "The screen"): the canvas's WebGL2 default framebuffer, showing the
// scanout; a 2D machine's too where the browser has WebGL2 on a GPU (web/gpu-present.ts, without a renderer: 2D
// scanouts only). A 2D scanout is the device's copy of the guest's resource, its bytes as they are (in shared memory
// on a 3D machine: the damaged rectangles are uploaded to a texture, drawn through the format's swizzle); a 3D
// scanout is the renderer's texture of the resource, drawn through its format's swizzle (B8G8R8X8, the usual one, is
// stored as its bytes are). The drawing buffer isn't preserved, so every present draws the whole scanout, with alpha
// ignored; rows go top first, as the guest's are.
import { E } from './gl-enums.ts';
import { SW_0, SW_1 } from './virgl-formats.ts';
import type { Rect, ScanoutOn, ScanoutShown } from './virgl-host.ts';
import type { VirglRenderer } from './virgl-renderer.ts';

const VS = `#version 300 es
uniform vec4 u_src;
out vec2 uv;
void main() {
  vec2 p = vec2(gl_VertexID & 1, gl_VertexID >> 1);
  uv = u_src.xy + vec2(p.x, 1.0 - p.y) * u_src.zw;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;
const FS = `#version 300 es
precision highp float;
uniform sampler2D s;
uniform ivec4 u_swz;
in vec2 uv;
out vec4 o;
float ch(vec4 t, int k) { return k == -1 ? 0.0 : k == -2 ? 1.0 : t[k]; }
void main() {
  vec4 t = texture(s, uv);
  o = vec4(ch(t, u_swz.x), ch(t, u_swz.y), ch(t, u_swz.z), 1.0);
}`;

/**
 * A/V sync's video end (`?avprobe`, bench/audio/avsync.ts): fed the screen's centre pixel at each draw, it calls
 * `flash` with the time (ms since the epoch) of each draw that turned it from dark to bright (a clip's white frame).
 */
export function flashProbe(flash: (t: number) => void) {
  let bright = false;
  return (r: number, g: number, b: number) => {
    const y = (r + g + b) / 3;
    if (!bright && y > 192) {
      bright = true;
      flash(performance.timeOrigin + performance.now());
    } else if (bright && y < 64) bright = false;
  };
}

/** The WebGL context's renderer and vendor (unmasked where the browser gives `WEBGL_debug_renderer_info`), read once. */
export function glInfo(gl: WebGL2RenderingContext) {
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = String(gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
  const vendor = String(gl.getParameter(dbg ? dbg.UNMASKED_VENDOR_WEBGL : gl.VENDOR));
  return { renderer, vendor, software: softwareRenderer(renderer) };
}

/** A WebGL renderer string that names a CPU rasterizer (SwiftShader, Mesa's llvmpipe or softpipe, Windows' WARP). */
export const softwareRenderer = (renderer: string) =>
  /SwiftShader|llvmpipe|softpipe|Basic Render Driver/i.test(renderer);

export class Screen {
  private gl: WebGL2RenderingContext;
  private r: VirglRenderer | undefined;
  private prog: WebGLProgram;
  private loc: { src: WebGLUniformLocation | null; swz: WebGLUniformLocation | null; s: WebGLUniformLocation | null };
  private tex2d: WebGLTexture;
  /**
   * The present's sampling: nearest, unmipped (a 3D scanout's texture keeps the filters and levels the guest's last
   * view of it left: its own sampler and level 0 here, or a mipmapped one could show another level, or none).
   */
  private sampler: WebGLSampler;
  private size2d = { width: 0, height: 0 };
  /** What it shows: a 2D resource's pixels or a 3D resource (null: nothing). */
  private src: ScanoutOn | null = null;
  /** Presents since the last read (`?displaystats`), and the time spent drawing them. */
  presents = 0;
  drawMs = 0;
  /** Presents since the screen was made (never reset: the GPU worker's `stats`). */
  presented = 0;
  /** Each present's time since the last read (epoch ms; `?displaystats`: bench/imgdecode/desktop.ts times rounds to the last one). */
  presentAt?: number[];
  /** Called after a present (a stats hook). */
  onPresent?: () => void;
  /** `?avprobe` (a `flashProbe`): fed the centre pixel after each present, read back (a stall: measurements only). */
  probe?: (r: number, g: number, b: number) => void;
  private px = new Uint8Array(4);

  constructor(gl: WebGL2RenderingContext, r?: VirglRenderer) {
    this.gl = gl;
    this.r = r;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    };
    this.prog = gl.createProgram()!;
    gl.attachShader(this.prog, sh(E.VERTEX_SHADER, VS));
    gl.attachShader(this.prog, sh(E.FRAGMENT_SHADER, FS));
    gl.linkProgram(this.prog);
    this.loc = {
      src: gl.getUniformLocation(this.prog, 'u_src'),
      swz: gl.getUniformLocation(this.prog, 'u_swz'),
      s: gl.getUniformLocation(this.prog, 's'),
    };
    this.tex2d = gl.createTexture()!;
    this.sampler = gl.createSampler()!;
    gl.samplerParameteri(this.sampler, E.TEXTURE_MIN_FILTER, E.NEAREST);
    gl.samplerParameteri(this.sampler, E.TEXTURE_MAG_FILTER, E.NEAREST);
    gl.samplerParameteri(this.sampler, E.TEXTURE_WRAP_S, E.CLAMP_TO_EDGE);
    gl.samplerParameteri(this.sampler, E.TEXTURE_WRAP_T, E.CLAMP_TO_EDGE);
  }

  scanout(c: ScanoutShown) {
    const { rect } = c;
    if (!rect.w || !rect.h || (!c.pixels && !c.res)) {
      this.src = null;
      this.clear();
      return;
    }
    this.set(c);
    if (c.pixels) this.upload({ x: 0, y: 0, w: rect.w, h: rect.h });
    this.present();
  }

  /** What the screen shows from now on, nothing uploaded or drawn (the 2D presenter's, which draws on its own frames: `upload`, `draw`). */
  set(c: ScanoutOn) {
    this.dirtyW = 0;
    this.src = c.pixels
      ? { pixels: c.pixels, swizzle: c.swizzle, width: c.width, height: c.height, rect: c.rect }
      : { res: c.res, width: c.width, height: c.height, rect: c.rect };
  }

  /**
   * The 2D scanout's damage not uploaded yet (scanout coordinates; `dirtyW` 0: none): the rectangles that come before
   * a draw, as one that holds them all (`draw` uploads it), so a frame's flushes make one upload as they make one draw.
   */
  private dirtyX = 0;
  private dirtyY = 0;
  private dirtyW = 0;
  private dirtyH = 0;

  damage(rect: Rect) {
    if (!this.src) return;
    if (this.src.pixels && rect.w > 0 && rect.h > 0) {
      const x1 = this.dirtyW ? Math.min(this.dirtyX, rect.x) : rect.x,
        y1 = this.dirtyW ? Math.min(this.dirtyY, rect.y) : rect.y;
      const x2 = this.dirtyW ? Math.max(this.dirtyX + this.dirtyW, rect.x + rect.w) : rect.x + rect.w,
        y2 = this.dirtyW ? Math.max(this.dirtyY + this.dirtyH, rect.y + rect.h) : rect.y + rect.h;
      this.dirtyX = x1;
      this.dirtyY = y1;
      this.dirtyW = x2 - x1;
      this.dirtyH = y2 - y1;
    }
    this.present();
  }

  clear() {
    const gl = this.gl;
    gl.bindFramebuffer(E.FRAMEBUFFER, null);
    gl.clearColor(0, 0, 0, 1);
    gl.disable(E.SCISSOR_TEST);
    gl.colorMask(true, true, true, true);
    gl.clear(E.COLOR_BUFFER_BIT);
  }

  /** Copies a rectangle of the 2D scanout (scanout coordinates) into the texture. */
  upload(r: Rect) {
    const gl = this.gl,
      s = this.src!;
    gl.activeTexture(E.TEXTURE0);
    gl.bindTexture(E.TEXTURE_2D, this.tex2d);
    gl.bindBuffer(E.PIXEL_UNPACK_BUFFER, null);
    if (this.size2d.width !== s.width || this.size2d.height !== s.height) {
      gl.texImage2D(E.TEXTURE_2D, 0, E.RGBA8, s.width, s.height, 0, E.RGBA, E.UNSIGNED_BYTE, null);
      gl.texParameteri(E.TEXTURE_2D, E.TEXTURE_MIN_FILTER, E.NEAREST);
      gl.texParameteri(E.TEXTURE_2D, E.TEXTURE_MAG_FILTER, E.NEAREST);
      this.size2d = { width: s.width, height: s.height };
      r = { x: 0, y: 0, w: s.rect.w, h: s.rect.h };
    }
    const x = s.rect.x + r.x,
      y = s.rect.y + r.y;
    gl.pixelStorei(E.UNPACK_ROW_LENGTH, s.width);
    gl.texSubImage2D(E.TEXTURE_2D, 0, x, y, r.w, r.h, E.RGBA, E.UNSIGNED_BYTE, s.pixels!, (y * s.width + x) * 4);
    gl.pixelStorei(E.UNPACK_ROW_LENGTH, 0);
  }

  private scheduled = false;
  private frames = true;
  private lastDraw = -Infinity;

  /**
   * Draws at the next animation frame: one frame however many calls a guest's flip took (a scanout change, its
   * damage). Each task that draws commits a frame of the canvas, and Chromium holds a worker's commits to the
   * display's rate: three commits a guest frame held the fences behind them and capped sway at ~40 frames a second.
   */
  present() {
    if (this.scheduled) return;
    this.scheduled = true;
    const frame = () => {
      this.scheduled = false;
      this.draw();
    };
    if (this.frames) {
      try {
        requestAnimationFrame(frame);
        return;
      } catch {
        this.frames = false;
      }
    }
    setTimeout(frame, Math.max(0, this.lastDraw + 1000 / 60 - performance.now()));
  }

  /** Draws the whole scanout on the canvas (sized to it). */
  draw() {
    const s = this.src;
    if (!s) return;
    const gl = this.gl;
    const t0 = performance.now();
    const canvas = gl.canvas as OffscreenCanvas;
    if (canvas.width !== s.rect.w || canvas.height !== s.rect.h) [canvas.width, canvas.height] = [s.rect.w, s.rect.h];
    let tex: WebGLTexture,
      swz = [0, 1, 2],
      tw = s.width,
      th = s.height;
    if (s.pixels) {
      if (this.dirtyW) {
        this.upload({ x: this.dirtyX, y: this.dirtyY, w: this.dirtyW, h: this.dirtyH });
        this.dirtyW = 0;
      }
      tex = this.tex2d;
      swz = s.swizzle ?? swz;
    } else {
      const src = this.r?.scanoutSource(s.res);
      if (!src) return this.clear();
      tex = src.tex;
      swz = src.fmt.sample.slice(0, 3);
      [tw, th] = [src.width, src.height];
    }
    gl.bindFramebuffer(E.FRAMEBUFFER, null);
    gl.viewport(0, 0, s.rect.w, s.rect.h);
    gl.useProgram(this.prog);
    gl.bindVertexArray(null);
    gl.activeTexture(E.TEXTURE0);
    gl.bindTexture(E.TEXTURE_2D, tex);
    // Level 0 (the renderer sets a view's levels at each draw that samples it); with an unmipped filter it alone counts.
    if (!s.pixels) gl.texParameteri(E.TEXTURE_2D, E.TEXTURE_BASE_LEVEL, 0);
    gl.bindSampler(0, this.sampler);
    gl.uniform1i(this.loc.s, 0);
    // The scanout's rectangle in texture coordinates, top row first.
    gl.uniform4f(this.loc.src, s.rect.x / tw, s.rect.y / th, s.rect.w / tw, s.rect.h / th);
    gl.uniform4iv(this.loc.swz, [...swz.map((q) => (q === SW_0 ? -1 : q === SW_1 ? -2 : q)), -2]);
    for (const cap of [E.BLEND, E.DEPTH_TEST, E.STENCIL_TEST, E.CULL_FACE, E.SCISSOR_TEST, E.RASTERIZER_DISCARD])
      gl.disable(cap);
    gl.colorMask(true, true, true, true);
    gl.drawArrays(E.TRIANGLE_STRIP, 0, 4);
    this.presents++;
    this.presented++;
    this.lastDraw = performance.now();
    this.presentAt?.push(performance.timeOrigin + this.lastDraw);
    this.drawMs += this.lastDraw - t0;
    if (this.probe) {
      gl.readPixels(s.rect.w >> 1, s.rect.h >> 1, 1, 1, E.RGBA, E.UNSIGNED_BYTE, this.px);
      this.probe(this.px[0], this.px[1], this.px[2]);
    }
    this.onPresent?.();
  }

  /** The screen drawn now and read back (bench hooks: `window.__waarm64Grab`): RGBA, top row first; 0×0 before a scanout. */
  grab(): { width: number; height: number; pixels: Uint8Array } {
    this.draw();
    const s = this.src,
      gl = this.gl;
    if (!s) return { width: 0, height: 0, pixels: new Uint8Array(0) };
    const { w, h } = s.rect,
      px = new Uint8Array(w * h * 4),
      out = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(E.FRAMEBUFFER, null);
    gl.readPixels(0, 0, w, h, E.RGBA, E.UNSIGNED_BYTE, px);
    for (let y = 0; y < h; y++) out.set(px.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    return { width: w, height: h, pixels: out };
  }
}
