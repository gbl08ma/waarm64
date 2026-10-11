// The screen of a 3D machine (docs/frontend.md "The screen"): the canvas's WebGL2 default framebuffer, showing the
// scanout. A 2D scanout is the device's RGBA copy of the guest's resource (in shared memory: the damaged rectangles
// are uploaded to a texture); a 3D scanout is the renderer's texture of the resource, drawn through its format's
// swizzle (B8G8R8X8, the usual one, is stored as its bytes are). The drawing buffer isn't preserved, so every present
// draws the whole scanout, with alpha ignored; rows go top first, as the guest's are.
import { E } from './gl-enums.ts';
import { SW_0, SW_1 } from './virgl-formats.ts';
import type { HostCall, Rect } from './virgl-host.ts';
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

export class Screen {
  private gl: WebGL2RenderingContext;
  private r: VirglRenderer;
  private prog: WebGLProgram;
  private loc: { src: WebGLUniformLocation | null; swz: WebGLUniformLocation | null; s: WebGLUniformLocation | null };
  private tex2d: WebGLTexture;
  private size2d = { width: 0, height: 0 };
  private src: { pixels?: Uint8Array; res?: number; width: number; height: number; rect: Rect } | null = null;
  /** Presents since the last read (`?displaystats`), and the time spent drawing them. */
  presents = 0;
  drawMs = 0;
  /** Called after a present (a stats hook). */
  onPresent?: () => void;
  /** `?avprobe` (a `flashProbe`): fed the centre pixel after each present, read back (a stall: measurements only). */
  probe?: (r: number, g: number, b: number) => void;
  private px = new Uint8Array(4);

  constructor(gl: WebGL2RenderingContext, r: VirglRenderer) {
    this.gl = gl;
    this.r = r;
    const sh = (type: number, src: string) => { const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s); return s; };
    this.prog = gl.createProgram()!;
    gl.attachShader(this.prog, sh(E.VERTEX_SHADER, VS));
    gl.attachShader(this.prog, sh(E.FRAGMENT_SHADER, FS));
    gl.linkProgram(this.prog);
    this.loc = { src: gl.getUniformLocation(this.prog, 'u_src'), swz: gl.getUniformLocation(this.prog, 'u_swz'), s: gl.getUniformLocation(this.prog, 's') };
    this.tex2d = gl.createTexture()!;
  }

  scanout(c: Omit<Extract<HostCall, { t: 'scanout' }>, 't'>) {
    const { rect } = c;
    if (!rect.w || !rect.h || (!c.pixels && !c.res)) {
      this.src = null;
      this.clear();
      return;
    }
    this.src = { pixels: c.pixels, res: c.res, width: c.width, height: c.height, rect };
    if (c.pixels) this.upload({ x: 0, y: 0, w: rect.w, h: rect.h });
    this.present();
  }

  damage(rect: Rect) {
    if (!this.src) return;
    if (this.src.pixels) this.upload(rect);
    this.present();
  }

  private clear() {
    const gl = this.gl;
    gl.bindFramebuffer(E.FRAMEBUFFER, null);
    gl.clearColor(0, 0, 0, 1);
    gl.disable(E.SCISSOR_TEST);
    gl.colorMask(true, true, true, true);
    gl.clear(E.COLOR_BUFFER_BIT);
  }

  /** Copies a rectangle of the 2D scanout (scanout coordinates) into the texture. */
  private upload(r: Rect) {
    const gl = this.gl, s = this.src!;
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
    const x = s.rect.x + r.x, y = s.rect.y + r.y;
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
    const frame = () => { this.scheduled = false; this.draw(); };
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
  private draw() {
    const s = this.src;
    if (!s) return;
    const gl = this.gl;
    const t0 = performance.now();
    const canvas = gl.canvas as OffscreenCanvas;
    if (canvas.width !== s.rect.w || canvas.height !== s.rect.h) [canvas.width, canvas.height] = [s.rect.w, s.rect.h];
    let tex: WebGLTexture, swz = [0, 1, 2], tw = s.width, th = s.height;
    if (s.pixels) tex = this.tex2d;
    else {
      const src = this.r.scanoutSource(s.res!);
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
    gl.bindSampler(0, null);
    gl.uniform1i(this.loc.s, 0);
    // The scanout's rectangle in texture coordinates, top row first.
    gl.uniform4f(this.loc.src, s.rect.x / tw, s.rect.y / th, s.rect.w / tw, s.rect.h / th);
    gl.uniform4iv(this.loc.swz, [...swz.map((q) => (q === SW_0 ? -1 : q === SW_1 ? -2 : q)), -2]);
    for (const cap of [E.BLEND, E.DEPTH_TEST, E.STENCIL_TEST, E.CULL_FACE, E.SCISSOR_TEST, E.RASTERIZER_DISCARD]) gl.disable(cap);
    gl.colorMask(true, true, true, true);
    gl.drawArrays(E.TRIANGLE_STRIP, 0, 4);
    this.presents++;
    this.lastDraw = performance.now();
    this.drawMs += this.lastDraw - t0;
    if (this.probe) {
      gl.readPixels(s.rect.w >> 1, s.rect.h >> 1, 1, 1, E.RGBA, E.UNSIGNED_BYTE, this.px);
      this.probe(this.px[0], this.px[1], this.px[2]);
    }
    this.onPresent?.();
  }
}
