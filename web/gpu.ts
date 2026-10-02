// virtio-gpu backend, 2D only (docs/devices.md "virtio-gpu"), written from the virtio 1.2
// specification §5.7 and Linux's drivers/gpu/drm/virtio, with QEMU's hw/display/virtio-gpu.c as
// the behavioral oracle (its answers to the same commands, G1 loop 0) and crosvm's rutabaga_gfx as
// a reference for the command set (BSD-3). core/tests/common/gpu.rs is its native twin and must
// give the same answers and the same pixels.
//
// A host resource is RGBA bytes in JS memory (what a canvas takes: the swizzle from the guest's
// format is fused into TRANSFER_TO_HOST_2D's gather, docs/plans/graphics.md §10). The guest's
// backing pages are guest-physical addresses inside the command's payload, which the core's chain
// checks don't cover: every entry is checked to lie in RAM before it is kept, and a transfer
// reads only through those entries.
import { gather, scatter, type Ctx, type Request } from './devices.ts';
import { EDID_MAX, EDID_MIN, edid } from './edid.ts';

const RAM_BASE = 0x4000_0000;

// Command and response types (virtio 1.2 §5.7.6).
const GET_DISPLAY_INFO = 0x100, RESOURCE_CREATE_2D = 0x101, RESOURCE_UNREF = 0x102, SET_SCANOUT = 0x103;
const RESOURCE_FLUSH = 0x104, TRANSFER_TO_HOST_2D = 0x105, RESOURCE_ATTACH_BACKING = 0x106;
const RESOURCE_DETACH_BACKING = 0x107, GET_EDID = 0x10a;
const UPDATE_CURSOR = 0x300, MOVE_CURSOR = 0x301;
const OK_NODATA = 0x1100, OK_DISPLAY_INFO = 0x1101, OK_EDID = 0x1104;
const ERR_UNSPEC = 0x1200, ERR_OUT_OF_MEMORY = 0x1201, ERR_INVALID_SCANOUT_ID = 0x1202;
const ERR_INVALID_RESOURCE_ID = 0x1203, ERR_INVALID_PARAMETER = 0x1205;
const FLAG_FENCE = 1;
const HDR = 24;
const EVENT_DISPLAY = 1;

/** Largest resource (bytes of RGBA) and the total a guest may hold: a bigger request is ERR_OUT_OF_MEMORY. */
export const MAX_RESOURCE = 64 << 20;
export const MAX_TOTAL = 256 << 20;
/** Backing entries per resource (QEMU's limit): a 64 MiB resource in 4 KiB pages. */
const MAX_ENTRIES = 16384;
/** The cursor image: Linux's 64×64 B8G8R8A8. */
const CURSOR = 64;

// Formats (memory byte order, virtio 1.2 §5.7.6.8): the byte positions of R, G, B and A. An X format's
// unused byte is kept as alpha all the same: Linux creates every dumb buffer as B8G8R8X8, and a cursor
// that is an ARGB8888 framebuffer on one carries its alpha in that byte (QEMU copies the bytes raw, too).
// The screen ignores alpha (its hash forces it opaque, and the canvas has none).
const FORMATS = new Map<number, [number, number, number, number]>([
  [1, [2, 1, 0, 3]], // B8G8R8A8
  [2, [2, 1, 0, 3]], // B8G8R8X8
  [3, [1, 2, 3, 0]], // A8R8G8B8
  [4, [1, 2, 3, 0]], // X8R8G8B8
  [67, [0, 1, 2, 3]], // R8G8B8A8
  [68, [3, 2, 1, 0]], // X8B8G8R8
  [121, [3, 2, 1, 0]], // A8B8G8R8
  [134, [0, 1, 2, 3]], // R8G8B8X8
]);

export type Rect = { x: number; y: number; w: number; h: number };
type Resource = {
  id: number; format: number; width: number; height: number;
  /** RGBA, rows of `width` pixels. */
  pixels: Uint8Array;
  /** The guest's pages, as RAM offsets (`addr` − RAM_BASE) and lengths; null until attached. */
  backing: { off: number; len: number }[] | null;
  /** Shown on the scanout: its alpha is 255 (a canvas takes the pixels as they are). */
  opaque?: boolean;
};

export type GpuOptions = {
  /** The display's size: what GET_DISPLAY_INFO and the EDID say (the page's, `resize` changes it). */
  width: number; height: number;
  /**
   * Keep fbcon's console whole under size changes (the EDID's fallback modes, the crop floor: devices.md
   * "Display size and events"). The page's machine sets it; the test guests leave it off so their bytes
   * (and step counts) stay what they were.
   */
  keepConsole?: boolean;
  /**
   * Note TRANSFER_TO_HOST_2D rectangles instead of copying them, and copy the union once when the page
   * draws (`ScanoutSource.sync`), at a state read, a snapshot or before the resource's backing changes.
   * A console scrolling sends thousands of full-screen transfers a second, of which the page draws ~60:
   * copying each saturated the device worker and the guest waited for every reply (graphics.md §13). The
   * copy happens later than the guest asked for, so a guest that rewrites its backing without transferring
   * can show newer pixels than it flushed (harmless). The page's machine sets it; the test guests stay eager.
   */
  lazyTransfer?: boolean;
  /**
   * Complete TRANSFER_TO_HOST_2D and RESOURCE_FLUSH at most once per display frame (16 ms), as a real
   * display completes a flush at its refresh. The first after an idle moment is answered at once (a key's
   * glyph isn't delayed); a burst is held to the frame boundary. Why: Linux's fbdev damage worker commits and
   * sleeps until the reply, so what arrives while it sleeps is one commit's worth. Answering at once made
   * a scrolling console commit 5,000 times a second (the guest spent its CPU on DRM's atomic path, `dmesg`
   * ran 3× slower than on a framebuffer: graphics.md §13).
   */
  paceReplies?: boolean;
  /** Pixels per inch for the EDID's physical size (default 96). */
  dpi?: number;
  /**
   * A test hook: after this many RESOURCE_FLUSHes the display changes to the size given (a
   * display event, as a page resize would raise), so the resize path is exact in deterministic runs.
   */
  resize?: { after: number; width: number; height: number };
  /** A test hook: hash the visible scanout at every RESOURCE_FLUSH (`state().trace`): the pictures the guest showed, not only the last. */
  trace?: boolean;
};

/** Where the scanout's pixels are: a resource's RGBA (rows `width` pixels apart, alpha meaningless) and the scanout's origin in it. */
export type ScanoutSource = { pixels: Uint8Array; width: number; height: number; x: number; y: number; /** Brings the pixels up to date (lazy transfers): call before reading them. */ sync?: () => void };

/** What the page draws from: the scanout and its damage, and the cursor. All optional (tests read the state). */
export type GpuHooks = {
  /** The scanout's size changed or it was set again (0×0 and no source: the scanout is off). */
  scanout?(width: number, height: number, source: ScanoutSource | null): void;
  /** A rectangle of the scanout (its own coordinates) has new pixels in the source. */
  damage?(rect: Rect): void;
  /** The cursor image (64×64 RGBA) or none, its hotspot, and where it is (guest pixels). */
  cursor?(image: Uint8Array | null, hotX: number, hotY: number, x: number, y: number): void;
};

/** What `Gpu.state()` says: the display, the resources without their pixels, and the hashes of what is visible. */
export type GpuState = ReturnType<Gpu['state']>;

const clampSize = (n: number) => Math.min(EDID_MAX, Math.max(1, Math.floor(n)));

/** A word-wise hash of RGBA bytes (alpha forced opaque for the screen), two 32-bit lanes: what tests compare. */
export function hashRgba(words: Uint32Array[], opaque: boolean) {
  let a = 0x811c9dc5, b = 0x9e3779b9;
  for (const row of words) {
    for (let k = 0; k < row.length; k++) {
      const w = opaque ? (row[k] | 0xff000000) >>> 0 : row[k];
      a = Math.imul(a ^ w, 0x01000193);
      b = Math.imul((b ^ w) << 13 | (b ^ w) >>> 19, 0x9e3779b1);
    }
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

/** Time the device worker spent in the backend since the last read (`?displaystats`, bench/gpu): requests, and the transfers inside them. */
export const busy = { request: 0, transfer: 0, requests: 0, transfers: 0, pixels: 0 };

export class Gpu {
  readonly resources = new Map<number, Resource>();
  private total = 0;
  private scanout: { id: number; rect: Rect } | null = null;
  private cursorImage: Uint8Array | null = null;
  private cursorState = { hotX: 0, hotY: 0, x: 0, y: 0 };
  private flushes = 0;
  private trace: string[] = [];
  /** The size the display reports: the page's (`wanted`), but not below `floor`. */
  private width: number;
  private height: number;
  private wanted: { width: number; height: number };
  /**
   * The size of a resource the guest shows cropped (a rectangle smaller than the resource, from the
   * origin): fbcon keeps its buffer and crops the console when the mode shrinks (graphics.md §9),
   * so the display never reports less than this. Zero until a guest does it; a compositor that
   * allocates a resource per mode never trips it, so desktops follow shrinks.
   */
  /** Lazy transfers: the rectangle (a union) of each resource not yet copied from its backing. */
  private pending = new Map<number, Rect>();
  private floor = { width: 0, height: 0 };
  private ram: () => Uint8Array;
  private ramSize: number;
  private o: GpuOptions;
  hooks: GpuHooks = {};
  /** Raises the display event (set by the backend): the config changed. */
  raise: (() => void) | undefined;

  constructor(ram: () => Uint8Array, ramSize: number, o: GpuOptions) {
    [this.ram, this.ramSize, this.o] = [ram, ramSize, o];
    this.wanted = { width: clampSize(o.width), height: clampSize(o.height) };
    [this.width, this.height] = [this.wanted.width, this.wanted.height];
  }

  /** A control command (the whole readable payload) → the response to write (empty: none fits). */
  control(cmd: Uint8Array, room: number): Uint8Array {
    if (cmd.length < HDR) return this.reply(ERR_UNSPEC, cmd, room);
    const v = new DataView(cmd.buffer, cmd.byteOffset, cmd.length);
    const type = v.getUint32(0, true);
    const need = (n: number) => cmd.length >= n;
    const u32 = (at: number) => v.getUint32(HDR + at, true);
    const rect = (at: number): Rect => ({ x: u32(at), y: u32(at + 4), w: u32(at + 8), h: u32(at + 12) });
    switch (type) {
      case GET_DISPLAY_INFO: {
        const r = new Uint8Array(HDR + 16 * 24);
        const w = new DataView(r.buffer);
        w.setUint32(HDR + 8, this.width, true);
        w.setUint32(HDR + 12, this.height, true);
        w.setUint32(HDR + 16, 1, true); // enabled
        return this.reply(OK_DISPLAY_INFO, cmd, room, r);
      }
      case GET_EDID: {
        if (!need(HDR + 8)) return this.reply(ERR_UNSPEC, cmd, room);
        if (u32(0) !== 0) return this.reply(ERR_INVALID_PARAMETER, cmd, room);
        const r = new Uint8Array(HDR + 8 + 1024);
        const e = edid(Math.max(this.width, EDID_MIN.width), Math.max(this.height, EDID_MIN.height), { dpi: this.o.dpi, extra: this.o.keepConsole ? this.fallbackModes() : [] });
        new DataView(r.buffer).setUint32(HDR, e.length, true);
        r.set(e, HDR + 8);
        return this.reply(OK_EDID, cmd, room, r);
      }
      case RESOURCE_CREATE_2D: {
        if (!need(HDR + 16)) return this.reply(ERR_UNSPEC, cmd, room);
        const [id, format, width, height] = [u32(0), u32(4), u32(8), u32(12)];
        if (id === 0) return this.reply(ERR_INVALID_RESOURCE_ID, cmd, room);
        if (this.resources.has(id)) return this.reply(ERR_INVALID_RESOURCE_ID, cmd, room);
        if (!FORMATS.has(format) || width === 0 || height === 0) return this.reply(ERR_INVALID_PARAMETER, cmd, room);
        const bytes = width * height * 4; // exact in a double up to 2^53: 2^32 × 2^32 × 4 is not, but is refused all the same
        if (bytes > MAX_RESOURCE || this.total + bytes > MAX_TOTAL) return this.reply(ERR_OUT_OF_MEMORY, cmd, room);
        this.total += bytes;
        this.resources.set(id, { id, format, width, height, pixels: new Uint8Array(bytes), backing: null });
        return this.reply(OK_NODATA, cmd, room);
      }
      case RESOURCE_UNREF: {
        if (!need(HDR + 8)) return this.reply(ERR_UNSPEC, cmd, room);
        const res = this.resources.get(u32(0));
        if (!res) return this.reply(ERR_INVALID_RESOURCE_ID, cmd, room);
        this.resources.delete(res.id);
        this.pending.delete(res.id);
        this.total -= res.pixels.length;
        if (this.scanout?.id === res.id) this.setScanout(null);
        return this.reply(OK_NODATA, cmd, room);
      }
      case SET_SCANOUT: {
        if (!need(HDR + 24)) return this.reply(ERR_UNSPEC, cmd, room);
        const [r, scanoutId, id] = [rect(0), u32(16), u32(20)];
        if (scanoutId !== 0) return this.reply(ERR_INVALID_SCANOUT_ID, cmd, room);
        if (id === 0 || r.w === 0 || r.h === 0) {
          this.setScanout(null);
          return this.reply(OK_NODATA, cmd, room);
        }
        const res = this.resources.get(id);
        if (!res) return this.reply(ERR_INVALID_RESOURCE_ID, cmd, room);
        if (!this.inside(r, res)) return this.reply(ERR_INVALID_PARAMETER, cmd, room);
        makeOpaque(res);
        this.setScanout({ id, rect: r });
        return this.reply(OK_NODATA, cmd, room);
      }
      case RESOURCE_FLUSH: {
        if (!need(HDR + 24)) return this.reply(ERR_UNSPEC, cmd, room);
        const [r, id] = [rect(0), u32(16)];
        const res = this.resources.get(id);
        if (!res) return this.reply(ERR_INVALID_RESOURCE_ID, cmd, room);
        if (!this.inside(r, res)) return this.reply(ERR_INVALID_PARAMETER, cmd, room);
        this.flush(res, r);
        return this.reply(OK_NODATA, cmd, room);
      }
      case TRANSFER_TO_HOST_2D: {
        if (!need(HDR + 32)) return this.reply(ERR_UNSPEC, cmd, room);
        const [r, offset, id] = [rect(0), Number(v.getBigUint64(HDR + 16, true)), u32(24)];
        const res = this.resources.get(id);
        if (!res) return this.reply(ERR_INVALID_RESOURCE_ID, cmd, room);
        if (!res.backing) return this.reply(ERR_UNSPEC, cmd, room);
        if (!this.inside(r, res)) return this.reply(ERR_INVALID_PARAMETER, cmd, room);
        const t0 = performance.now();
        // The usual rectangle (the driver's offset is its own corner's): noted, copied when drawn.
        if (this.o.lazyTransfer && offset === r.y * res.width * 4 + r.x * 4 && this.fits(res, r, offset)) {
          const p = this.pending.get(id);
          if (!p) this.pending.set(id, { ...r });
          else {
            const [x0, y0] = [Math.min(p.x, r.x), Math.min(p.y, r.y)];
            [p.w, p.h] = [Math.max(p.x + p.w, r.x + r.w) - x0, Math.max(p.y + p.h, r.y + r.h) - y0];
            [p.x, p.y] = [x0, y0];
          }
          this.draw(res, r);
          busy.transfers++;
          busy.pixels += r.w * r.h;
          return this.reply(OK_NODATA, cmd, room);
        }
        this.materialize(res);
        const ok = this.transfer(res, r, offset);
        busy.transfer += performance.now() - t0;
        busy.transfers++;
        busy.pixels += r.w * r.h;
        return this.reply(ok ? OK_NODATA : ERR_INVALID_PARAMETER, cmd, room);
      }
      case RESOURCE_ATTACH_BACKING: {
        if (!need(HDR + 8)) return this.reply(ERR_UNSPEC, cmd, room);
        const [id, n] = [u32(0), u32(4)];
        const res = this.resources.get(id);
        if (!res) return this.reply(ERR_INVALID_RESOURCE_ID, cmd, room);
        if (res.backing) return this.reply(ERR_UNSPEC, cmd, room);
        if (n === 0 || n > MAX_ENTRIES || cmd.length < HDR + 8 + 16 * n) return this.reply(ERR_INVALID_PARAMETER, cmd, room);
        const backing = [];
        const end = BigInt(RAM_BASE) + BigInt(this.ramSize);
        for (let k = 0; k < n; k++) {
          const at = HDR + 8 + 16 * k;
          const addr = v.getBigUint64(at, true);
          const len = BigInt(v.getUint32(at + 8, true));
          if (addr < BigInt(RAM_BASE) || addr > end || len > end - addr) return this.reply(ERR_INVALID_PARAMETER, cmd, room);
          backing.push({ off: Number(addr) - RAM_BASE, len: Number(len) });
        }
        res.backing = backing;
        return this.reply(OK_NODATA, cmd, room);
      }
      case RESOURCE_DETACH_BACKING: {
        if (!need(HDR + 8)) return this.reply(ERR_UNSPEC, cmd, room);
        const res = this.resources.get(u32(0));
        if (!res) return this.reply(ERR_INVALID_RESOURCE_ID, cmd, room);
        this.materialize(res);
        res.backing = null;
        return this.reply(OK_NODATA, cmd, room);
      }
      default:
        return this.reply(ERR_UNSPEC, cmd, room);
    }
  }

  /** A cursor command (UPDATE_CURSOR, MOVE_CURSOR): no response. */
  cursor(cmd: Uint8Array) {
    if (cmd.length < HDR + 32) return;
    const v = new DataView(cmd.buffer, cmd.byteOffset, cmd.length);
    const type = v.getUint32(0, true);
    if (type !== UPDATE_CURSOR && type !== MOVE_CURSOR) return;
    const u32 = (at: number) => v.getUint32(HDR + at, true);
    if (u32(0) !== 0) return; // scanout
    const c = this.cursorState;
    [c.x, c.y] = [u32(4), u32(8)];
    if (type === UPDATE_CURSOR) {
      const id = u32(16);
      [c.hotX, c.hotY] = [u32(20), u32(24)];
      if (id === 0) this.cursorImage = null;
      else {
        const res = this.resources.get(id);
        if (!res || res.width !== CURSOR || res.height !== CURSOR) return; // the guest's mistake: the cursor stays as it was
        this.materialize(res);
        this.cursorImage = res.pixels.slice();
      }
    }
    this.hooks.cursor?.(this.cursorImage, c.hotX, c.hotY, c.x, c.y);
  }

  /** The page's size changed: the next GET_DISPLAY_INFO and EDID say so, and the guest gets a display event. */
  setSize(width: number, height: number) {
    this.wanted = { width: clampSize(width), height: clampSize(height) };
    this.report();
    this.raise?.();
  }

  /**
   * The modes after the preferred one: the size the console was born at and, if different, its buffer's
   * (the floor). fbcon refuses a mode wider or taller than its buffer (DRM's `VIRTUAL_X`/`VIRTUAL_Y`)
   * and with no other mode in the list it blanks the screen: a window grown past the buffer would
   * kill the console. With these the guest falls back to a size its buffer holds.
   */
  private fallbackModes() {
    const modes: { width: number; height: number }[] = [];
    for (const m of [{ width: clampSize(this.o.width), height: clampSize(this.o.height) }, this.floor]) {
      if (m.width < EDID_MIN.width || m.height < EDID_MIN.height) continue;
      if ((m.width === this.width && m.height === this.height) || modes.some((x) => x.width === m.width && x.height === m.height)) continue;
      modes.push(m);
    }
    return modes;
  }

  /**
   * The guest takes a display event's bit with `events_clear` after it handles it, and our event comes
   * while it is still handling the shrink that caused it: that clear can take the new event with it
   * (a lost bounce: the console stayed cropped, seen in CI). Raise again a few times while the crop lasts.
   */
  private reraise(id: number, left: number) {
    if (left <= 0) return;
    setTimeout(() => {
      const s = this.scanout;
      const res = s && this.resources.get(s.id);
      if (!s || !res || s.id !== id || (s.rect.w >= res.width && s.rect.h >= res.height)) return;
      this.raise?.();
      this.reraise(id, left - 1);
    }, 200);
  }

  /** Copies what lazy transfers noted (one resource's, or all). */
  private materialize(res?: Resource) {
    if (!this.pending.size) return;
    for (const [id, r] of [...this.pending]) {
      const t = this.resources.get(id);
      if (!t || (res && t !== res)) continue;
      this.pending.delete(id);
      if (t.backing) this.transfer(t, r, r.y * t.width * 4 + r.x * 4, true);
    }
  }

  /** The reported size from the wanted one and the floor; true if it changed. */
  private report() {
    const [w, h] = [Math.max(this.wanted.width, this.floor.width), Math.max(this.wanted.height, this.floor.height)];
    const changed = w !== this.width || h !== this.height;
    [this.width, this.height] = [w, h];
    return changed;
  }

  get size() {
    return { width: this.width, height: this.height };
  }

  private inside(r: Rect, res: Resource) {
    return r.x <= res.width && r.y <= res.height && r.w <= res.width - r.x && r.h <= res.height - r.y;
  }

  private setScanout(s: { id: number; rect: Rect } | null) {
    this.scanout = s;
    this.announce();
    const res = s && this.resources.get(s.id);
    if (s && res) {
      this.draw(res, s.rect);
      if (this.o.keepConsole && s.rect.x === 0 && s.rect.y === 0 && (s.rect.w < res.width || s.rect.h < res.height)) {
        // The console is cropped: ask for its whole buffer again.
        this.floor = { width: Math.max(this.floor.width, res.width), height: Math.max(this.floor.height, res.height) };
        if (this.report()) {
          this.raise?.();
          this.reraise(res.id, 5);
        }
      }
    }
  }

  /** Copies the part of `r` that is on the scanout to the page. */
  private draw(res: Resource, r: Rect) {
    const s = this.scanout;
    if (!s || s.id !== res.id) return;
    const x0 = Math.max(r.x, s.rect.x), y0 = Math.max(r.y, s.rect.y);
    const x1 = Math.min(r.x + r.w, s.rect.x + s.rect.w), y1 = Math.min(r.y + r.h, s.rect.y + s.rect.h);
    if (x1 <= x0 || y1 <= y0) return;
    this.hooks.damage?.({ x: x0 - s.rect.x, y: y0 - s.rect.y, w: x1 - x0, h: y1 - y0 });
  }

  /** Tells the hooks the scanout as it is now. */
  private announce() {
    const s = this.scanout;
    const res = s && this.resources.get(s.id);
    this.hooks.scanout?.(s ? s.rect.w : 0, s ? s.rect.h : 0, s && res ? { pixels: res.pixels, width: res.width, height: res.height, x: s.rect.x, y: s.rect.y, sync: () => this.materialize(res) } : null);
  }

  private flush(res: Resource, r: Rect) {
    this.draw(res, r);
    if (this.o.trace) this.trace.push(this.screenHash() ?? '');
    const t = this.o.resize;
    if (t && ++this.flushes === t.after) this.setSize(t.width, t.height);
  }

  /** TRANSFER_TO_HOST_2D: the rectangle's rows from the backing (the first at `offset`, rows `width`×4 bytes apart) into the host pixels. False if the backing is too short. */
  /** Whether the rows of `r` from `offset` lie inside the backing. */
  private fits(res: Resource, r: Rect, offset: number) {
    const last = offset + res.width * 4 * (r.h - 1) + r.w * 4;
    return Number.isSafeInteger(last) && last <= res.backing!.reduce((n, b) => n + b.len, 0);
  }

  private transfer(res: Resource, r: Rect, offset: number, quiet = false) {
    if (r.w === 0 || r.h === 0) return true;
    const stride = res.width * 4;
    const rowLen = r.w * 4;
    const backing = res.backing!;
    if (!this.fits(res, r, offset)) return false;
    const [ri, gi, bi, ai] = FORMATS.get(res.format)!;
    const ram = this.ram();
    // The usual case, words: B8G8R8x or R8G8B8x, pages 4-byte aligned (Linux's are): 32-bit loads and stores
    // with the channels swapped in registers, ~4 times the bytewise loop (a console scrolling at full screen
    // sends hundreds of these a second, and the guest waits for each).
    const swap = res.format === 1 || res.format === 2;
    if ((swap || res.format === 67 || res.format === 134) && ram.byteOffset % 4 === 0 && offset % 4 === 0 && backing.every((b) => b.off % 4 === 0 && b.len % 4 === 0)) {
      const src = new Uint32Array(ram.buffer, ram.byteOffset, ram.length >> 2);
      const dst = new Uint32Array(res.pixels.buffer, res.pixels.byteOffset, res.pixels.length >> 2);
      const opaque = res.opaque ? 0xff000000 : 0;
      const words = r.w;
      let seg = 0, segStart = 0; // the backing page holding the byte at `at`, and where it starts: rows only move forward
      for (let y = 0; y < r.h; y++) {
        let at = offset + stride * y;
        while (at >= segStart + backing[seg].len) segStart += backing[seg++].len;
        let d = (r.y + y) * res.width + r.x;
        for (let left = words; left > 0;) {
          const b = backing[seg];
          const s0 = (b.off + (at - segStart)) >> 2;
          const n = Math.min(left, (b.len - (at - segStart)) >> 2);
          if (swap) for (let k = 0; k < n; k++) {
            const v = src[s0 + k];
            dst[d + k] = (v & 0xff00ff00 | v >>> 16 & 0xff | (v & 0xff) << 16 | opaque) >>> 0;
          } else for (let k = 0; k < n; k++) dst[d + k] = (src[s0 + k] | opaque) >>> 0;
          d += n;
          left -= n;
          at += n * 4;
          if (left > 0) while (at >= segStart + backing[seg].len) segStart += backing[seg++].len;
        }
      }
      if (!quiet) this.draw(res, r);
      return true;
    }
    const row = new Uint8Array(rowLen);
    for (let y = 0; y < r.h; y++) {
      readBacking(ram, backing, offset + stride * y, row);
      let d = ((r.y + y) * res.width + r.x) * 4;
      const px = res.pixels;
      for (let k = 0; k < rowLen; k += 4, d += 4) {
        px[d] = row[k + ri];
        px[d + 1] = row[k + gi];
        px[d + 2] = row[k + bi];
        px[d + 3] = res.opaque ? 255 : row[k + ai];
      }
    }
    if (!quiet) this.draw(res, r);
    return true;
  }

  private reply(type: number, cmd: Uint8Array, room: number, body?: Uint8Array): Uint8Array {
    const r = body ?? new Uint8Array(HDR);
    if (r.length > room) return new Uint8Array(0);
    const v = new DataView(r.buffer, r.byteOffset, r.length);
    v.setUint32(0, type, true);
    if (cmd.length >= HDR) {
      const c = new DataView(cmd.buffer, cmd.byteOffset, cmd.length);
      if (c.getUint32(4, true) & FLAG_FENCE) {
        v.setUint32(4, FLAG_FENCE, true);
        v.setBigUint64(8, c.getBigUint64(8, true), true);
      }
      v.setUint32(16, c.getUint32(16, true), true); // ctx_id
    }
    return r;
  }

  /** Display events: bit 0 of events_read. */
  static readonly EVENT_DISPLAY = EVENT_DISPLAY;

  /** The hash of the visible scanout (alpha forced opaque), if there is one. */
  private screenHash() {
    const s = this.scanout;
    if (!s) return null;
    this.materialize();
    const res = this.resources.get(s.id)!;
    const words = new Uint32Array(res.pixels.buffer, res.pixels.byteOffset, res.pixels.length / 4);
    const rows = [];
    for (let y = 0; y < s.rect.h; y++) rows.push(words.subarray((s.rect.y + y) * res.width + s.rect.x, (s.rect.y + y) * res.width + s.rect.x + s.rect.w));
    return hashRgba(rows, true);
  }

  /** What a test or a snapshot reads: the state without the pixels (they come back from the backing), and the hashes of what is visible. */
  state() {
    const s = this.scanout;
    const screen = this.screenHash();
    const c = this.cursorImage;
    return {
      width: this.width, height: this.height, flushes: this.flushes,
      resources: [...this.resources.values()].map((r) => ({ id: r.id, format: r.format, width: r.width, height: r.height, backing: r.backing?.map((b) => [b.off, b.len]) ?? null })),
      scanout: s ? { id: s.id, ...s.rect } : null,
      screen,
      trace: this.trace,
      cursor: c ? { ...this.cursorState, hash: hashRgba([new Uint32Array(c.buffer, c.byteOffset, c.length / 4)], false) } : null,
    };
  }

  /** A virtio reset: the guest's resources, scanout and cursor are gone. */
  reset() {
    this.pending.clear();
    this.resources.clear();
    this.total = 0;
    this.cursorImage = null;
    this.cursorState = { hotX: 0, hotY: 0, x: 0, y: 0 };
    this.setScanout(null);
    this.hooks.cursor?.(null, 0, 0, 0, 0);
  }

  /** A snapshot's state, JSON: `state` plus the cursor's image. Host pixels come back from the backing at `restore`. */
  save() {
    return { ...this.state(), cursorImage: this.cursorImage ? toBase64(this.cursorImage) : null };
  }

  /** `save`'s state back: the tables, then every resource with a backing read again from the (restored) RAM, and the scanout drawn. */
  restore(state: unknown) {
    const t = state as ReturnType<Gpu['save']>;
    if (!Array.isArray(t?.resources) || !(t.width > 0) || !(t.height > 0)) throw new Error('the snapshot has no state for the display device');
    this.pending.clear();
    this.resources.clear();
    this.total = 0;
    this.scanout = null;
    [this.width, this.height, this.flushes] = [t.width, t.height, t.flushes];
    this.wanted = { width: t.width, height: t.height };
    this.floor = { width: 0, height: 0 };
    this.trace = t.trace ?? [];
    for (const r of t.resources) {
      const res: Resource = { id: r.id, format: r.format, width: r.width, height: r.height, pixels: new Uint8Array(r.width * r.height * 4), backing: r.backing?.map(([off, len]) => ({ off, len })) ?? null };
      this.total += res.pixels.length;
      this.resources.set(res.id, res);
      if (res.backing) this.transfer(res, { x: 0, y: 0, w: res.width, h: res.height }, 0);
    }
    this.scanout = t.scanout ? { id: t.scanout.id, rect: { x: t.scanout.x, y: t.scanout.y, w: t.scanout.w, h: t.scanout.h } } : null;
    this.cursorImage = t.cursorImage ? Uint8Array.from(atob(t.cursorImage), (c) => c.charCodeAt(0)) : null;
    this.cursorState = t.cursor ? { hotX: t.cursor.hotX, hotY: t.cursor.hotY, x: t.cursor.x, y: t.cursor.y } : { hotX: 0, hotY: 0, x: 0, y: 0 };
    const s = this.scanout;
    if (s) makeOpaque(this.resources.get(s.id)!);
    const shown = s && this.resources.get(s.id);
    if (this.o.keepConsole && s && shown && s.rect.x === 0 && s.rect.y === 0 && (s.rect.w < shown.width || s.rect.h < shown.height)) this.floor = { width: shown.width, height: shown.height };
    this.announce();
    if (s) this.draw(this.resources.get(s.id)!, s.rect);
    this.hooks.cursor?.(this.cursorImage, this.cursorState.hotX, this.cursorState.hotY, this.cursorState.x, this.cursorState.y);
  }
}

/** A resource that is on the scanout loses its alpha (an X format's unused byte, `FORMATS`): from now on transfers write 255 too. */
function makeOpaque(res: Resource) {
  if (res.opaque) return;
  res.opaque = true;
  for (let k = 3; k < res.pixels.length; k += 4) res.pixels[k] = 255;
}

/** Reads `out.length` bytes at `offset` of the concatenated backing pages. */
function readBacking(ram: Uint8Array, backing: { off: number; len: number }[], offset: number, out: Uint8Array) {
  let skip = offset, k = 0;
  for (const b of backing) {
    if (skip >= b.len) {
      skip -= b.len;
      continue;
    }
    const n = Math.min(b.len - skip, out.length - k);
    out.set(ram.subarray(b.off + skip, b.off + skip + n), k);
    k += n;
    skip = 0;
    if (k === out.length) return;
  }
}

function toBase64(b: Uint8Array) {
  let s = '';
  for (let k = 0; k < b.length; k += 8192) s += String.fromCharCode(...b.subarray(k, k + 8192));
  return btoa(s);
}

/** The virtio-gpu backend (queue 0: controlq, 1: cursorq) around a `Gpu`. */
export function gpuBackend(ctx: Ctx, o: GpuOptions, hooks: GpuHooks = {}) {
  const gpu = new Gpu(() => ctx.ram(), ctx.ramSize, o);
  gpu.hooks = hooks;
  gpu.raise = () => ctx.changeConfig((c) => {
    const v = new DataView(c.buffer, c.byteOffset, 16);
    v.setUint32(0, v.getUint32(0, true) | EVENT_DISPLAY, true);
  });
  // Replies held to the frame boundary (`paceReplies`), in order.
  let held: { w0: number; len: number }[] = [];
  let lastBatch = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const FRAME_MS = 16;
  const release = () => {
    timer = undefined;
    lastBatch = performance.now();
    const batch = held;
    held = [];
    for (const h of batch) ctx.complete(h.w0, h.len);
  };
  return {
    gpu,
    request(r: Request) {
      const ram = ctx.ram();
      const len = r.read.reduce((n, s) => n + s.len, 0);
      const cmd = gather(ram, r.read, len);
      if (r.queue === 1) {
        gpu.cursor(cmd);
        return 0;
      }
      const room = r.write.reduce((n, s) => n + s.len, 0);
      const t0 = performance.now();
      const reply = gpu.control(cmd, room);
      scatter(ram, r.write, reply);
      busy.request += performance.now() - t0;
      busy.requests++;
      if (o.paceReplies && cmd.length >= 4) {
        const type = new DataView(cmd.buffer, cmd.byteOffset, Math.min(cmd.length, 4)).getUint32(0, true);
        const now = performance.now();
        const display = type === TRANSFER_TO_HOST_2D || type === RESOURCE_FLUSH;
        if (held.length || (display && now - lastBatch < FRAME_MS)) {
          held.push({ w0: r.w0, len: reply.length });
          timer ??= setTimeout(release, Math.max(0, lastBatch + FRAME_MS - now));
          return undefined;
        }
        if (display) lastBatch = now;
      }
      return reply.length;
    },
    // events_clear: write-one-to-clear of events_read; the guest's write is taken and zeroed.
    config() {
      const c = ctx.config();
      const v = new DataView(c.buffer, c.byteOffset, 16);
      const clear = v.getUint32(4, true);
      if (clear) {
        v.setUint32(0, v.getUint32(0, true) & ~clear, true);
        v.setUint32(4, 0, true);
      }
    },
    reset: () => {
      clearTimeout(timer);
      timer = undefined;
      held = [];
      gpu.reset();
    },
    save: () => gpu.save(),
    restore: (state: unknown) => gpu.restore(state),
  };
}
