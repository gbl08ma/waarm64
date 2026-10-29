// virtio-gpu backend, 2D only (docs/devices.md "virtio-gpu"), written from the virtio 1.2
// specification §5.7 and Linux's drivers/gpu/drm/virtio, with QEMU's hw/display/virtio-gpu.c as
// the behavioral oracle (its answers to the same commands, G1 loop 0) and crosvm's rutabaga_gfx as
// a reference for the command set (BSD-3). core/tests/common/gpu.rs is its native twin and must
// give the same answers and the same pixels.
//
// A host resource is RGBA bytes in JS memory (what a canvas takes: the swizzle from the guest's
// format is fused into TRANSFER_TO_HOST_2D's gather, bench/gpu/REPORT.md, G0); where the screen is
// WebGL2 (a 3D machine's, and a 2D machine's where the canvas gives WebGL2) it is the guest's bytes as
// they are (a plain copy, ~4 times faster), and the screen swizzles in its draw (web/virgl-screen.ts). The guest's
// backing pages are guest-physical addresses inside the command's payload, which the core's chain
// checks don't cover: every entry is checked to lie in RAM before it is kept, and a transfer
// reads only through those entries.
import { bytes, gather, locate, scatter, type Ctx, type Ram, type RamLayout, type Request, type Segment } from './devices.ts';
import { EDID_MAX, EDID_MIN, edid } from './edid.ts';
import { VirglStats, virglCaps, walk } from './virgl.ts';
import { BLOB_FLAG_USE_MAPPABLE, BLOB_MEM_HOST3D, CAPSET_VENUS, CONTEXT_INIT_CAPSET_ID_MASK, FLAG_INFO_RING_IDX, MAP_CACHE_CACHED, venusCapset } from './venus.ts';
import { FORMATS as VIRGL_FORMATS, boxBytes } from './virgl-formats.ts';
import { encodeRecord } from './virgl-trace.ts';
import type { VirglHost } from './virgl-host.ts';
import type { RendererSnapshot } from './virgl-renderer.ts';
import { capsBacked } from './virgl-caps.ts';


// Command and response types (virtio 1.2 §5.7.6).
const GET_DISPLAY_INFO = 0x100, RESOURCE_CREATE_2D = 0x101, RESOURCE_UNREF = 0x102, SET_SCANOUT = 0x103;
const RESOURCE_FLUSH = 0x104, TRANSFER_TO_HOST_2D = 0x105, RESOURCE_ATTACH_BACKING = 0x106;
const RESOURCE_DETACH_BACKING = 0x107, GET_CAPSET_INFO = 0x108, GET_CAPSET = 0x109, GET_EDID = 0x10a;
const RESOURCE_ASSIGN_UUID = 0x10b, RESOURCE_CREATE_BLOB = 0x10c, SET_SCANOUT_BLOB = 0x10d;
const RESOURCE_MAP_BLOB = 0x208, RESOURCE_UNMAP_BLOB = 0x209;
const CTX_CREATE = 0x200, CTX_DESTROY = 0x201, CTX_ATTACH_RESOURCE = 0x202, CTX_DETACH_RESOURCE = 0x203;
const RESOURCE_CREATE_3D = 0x204, TRANSFER_TO_HOST_3D = 0x205, TRANSFER_FROM_HOST_3D = 0x206, SUBMIT_3D = 0x207;
const UPDATE_CURSOR = 0x300, MOVE_CURSOR = 0x301;
const OK_NODATA = 0x1100, OK_DISPLAY_INFO = 0x1101, OK_CAPSET_INFO = 0x1102, OK_CAPSET = 0x1103, OK_EDID = 0x1104;
const OK_RESOURCE_UUID = 0x1105, OK_MAP_INFO = 0x1106;
const ERR_UNSPEC = 0x1200, ERR_OUT_OF_MEMORY = 0x1201, ERR_INVALID_SCANOUT_ID = 0x1202;
const ERR_INVALID_RESOURCE_ID = 0x1203, ERR_INVALID_CONTEXT_ID = 0x1204, ERR_INVALID_PARAMETER = 0x1205;
const FLAG_FENCE = 1;
const HDR = 24;
const EVENT_DISPLAY = 1;
/**
 * The capsets with `virgl` (VIRTIO_GPU_CAPSET_VIRGL, VIRGL2) from the VIRGL2 blob: id, max version, the blob (VIRGL is
 * its v1 part, max_version 1); with Venus also VIRTIO_GPU_CAPSET_VENUS (version 0), third (its index is what
 * GET_CAPSET_INFO takes).
 */
function capsets(caps: Uint8Array, venus?: Uint8Array) {
  const v1 = caps.slice(0, 77 * 4);
  new DataView(v1.buffer).setUint32(0, 1, true);
  const out: (readonly [number, number, Uint8Array])[] = [[1, 1, v1], [2, 2, caps]];
  if (venus) out.push([CAPSET_VENUS, 0, venus]);
  return out;
}
/** Contexts and 3D resources a guest may hold (a bound for a guest that leaks them: the null renderer keeps no host memory for most). */
const MAX_CONTEXTS = 1024;
const MAX_RESOURCES = 65536;
/** Blob resources' bytes a guest may hold at once (Venus's memory: the renderer keeps it). */
const MAX_BLOB_TOTAL = 4 * 2 ** 30;
/** PIPE_TEXTURE_2D: a 3D resource that can be shown on the scanout. */
const TARGET_2D = 2;

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
  /** RGBA, rows of `width` pixels; with `raw`, the guest's bytes in its format. */
  pixels: Uint8Array;
  /** Made with a host or `GpuHooks.raw`: `pixels` are copied as they are, for a screen that swizzles them in its draw. */
  raw?: boolean;
  /** The guest's pages, as segments of its RAM (memory, offset, length); null until attached. */
  backing: Segment[] | null;
  /** Shown on the scanout: its alpha is 255 (a canvas takes the pixels as they are). */
  opaque?: boolean;
  /** A transfer changed the pixels since the whole scanout was last given to the page: a flush has something to show. */
  changed?: boolean;
  /** A virgl resource (RESOURCE_CREATE_3D): gallium's target and bind flags. It has `pixels` only once it is shown (black: nothing renders). */
  three?: { target: number; bind: number; depth: number; arraySize: number; lastLevel: number; samples: number };
  /**
   * A blob resource (RESOURCE_CREATE_BLOB, Venus): host memory the renderer keeps, of `size` bytes, made in context `ctx`
   * for its object `blobId` (0: plain shared memory); `mapped` its offset in the host-visible window while mapped.
   */
  blob?: { ctx: number; mem: number; flags: number; blobId: bigint; size: number; mapped?: number };
};

/** What the null renderer counted (`state().virgl`): the 3D commands, the bytes each way, and each context's stream. */
export type VirglCounts = {
  commands: Record<string, number>;
  toHostBytes: number; fromHostBytes: number;
  stream: ReturnType<VirglStats['json']>;
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
   * Complete at most one RESOURCE_FLUSH per display frame (60 a second), as a display completes a flush at its
   * refresh: the first after an idle moment is answered at once (a key's glyph isn't delayed), one that
   * follows within the frame waits for the frame's end, and so does everything queued behind it (replies
   * stay in order). Why: Linux's driver waits for no reply on a primary plane
   * (no fence, and before 6.19 no vblank either), so a guest with damage to show commits as fast as it can
   * and only a full queue stops it. Answered at once, a scrolling console committed ~5,000 times a second,
   * and the guest spent its CPU on DRM's atomic path (docs/graphics.md "Console scrolling and the flush pacing"). The commands themselves are never
   * delayed: a transfer copies when it arrives. The page's machine sets it; the test guests don't.
   */
  paceFlushes?: boolean;
  /** Pixels per inch for the EDID's physical size (default 96). */
  dpi?: number;
  /**
   * 3D through virgl (VIRTIO_GPU_F_VIRGL and the VIRGL capsets: docs/devices.md "virgl"). The guest's contexts, 3D
   * resources and command streams are checked here and run by the renderer (`Gpu.host`: the page's GPU worker, or a
   * test's); without one, on a null renderer (counted, nothing drawn, fences at once). Off by default, so no guest's
   * bytes or step counts move.
   */
  virgl?: boolean;
  /** The VIRGL2 caps blob to advertise (the browser's, web/virgl-caps.ts); default `virglCaps(2)`, WebGL2's minimums. */
  caps?: Uint8Array;
  /**
   * Vulkan through Venus, with `virgl` (docs/devices.md "The host-visible window"; docs/graphics.md "Vulkan through Venus"): features
   * RESOURCE_UUID, RESOURCE_BLOB and CONTEXT_INIT, the VENUS capset, contexts made for it, blob resources mapped into
   * the host-visible window (`window` bytes: the machine's, `BootOptions.window`), their commands handed to the host.
   * Off by default, a per-machine choice: without it the device is what it was.
   */
  venus?: boolean;
  /** With `venus`: the window's written pages aren't taken at each submit (`?gpu=vulkan,nowatch`: the write-watch's cost, A/B). */
  noWatch?: boolean;
  /** The VENUS capset (the renderer's, `vkr_get_capset`); default web/venus.ts `venusCapset()`. */
  venusCaps?: Uint8Array;
  /** The host-visible window's bytes (with `venus`): where RESOURCE_MAP_BLOB may put a blob. */
  window?: number;
  /**
   * A test hook: after this many RESOURCE_FLUSHes the display changes to the size given (a
   * display event, as a page resize would raise), so the resize path is exact in deterministic runs.
   */
  resize?: { after: number; width: number; height: number };
  /** A test hook: hash the visible scanout at every RESOURCE_FLUSH (`state().trace`): the pictures the guest showed, not only the last. */
  trace?: boolean;
};

/**
 * Where the scanout's pixels are: a resource's RGBA (rows `width` pixels apart, alpha meaningless) and the scanout's
 * origin in it; with `swizzle` (`GpuHooks.raw`) the guest's bytes, R, G and B at those byte positions of a pixel.
 */
export type ScanoutSource = { pixels: Uint8Array; width: number; height: number; x: number; y: number; swizzle?: number[] };

/** What the page draws from: the scanout and its damage, and the cursor. All optional (tests read the state). */
export type GpuHooks = {
  /** The page swizzles in its draw: resources keep the guest's bytes (read once, when a resource is made). */
  raw?: boolean;
  /** The scanout's size changed or it was set again (0×0 and no source: the scanout is off). */
  scanout?(width: number, height: number, source: ScanoutSource | null): void;
  /** RESOURCE_FLUSH: a rectangle of the scanout (its own coordinates) is to be shown as the source has it now. */
  damage?(rect: Rect): void;
  /** The cursor image (64×64 RGBA) or none, its hotspot, and where it is (guest pixels). */
  cursor?(image: Uint8Array | null, hotX: number, hotY: number, x: number, y: number): void;
  /** A virtio reset: no cursor was ever set (a pointer over the firmware's screens is the host's own), unlike `cursor(null)`, which the guest asked for. */
  cursorReset?(): void;
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

/** Time the device worker spent in the backend since the last read (`?displaystats`, bench/gpu): requests, and the transfers inside them; the control commands by type (hex). */
/** `events` (bench/imgdecode/desktop.ts, `?displaystats` only): [epoch ms, what] pairs, flat: a control command's
 * arrival (its type), a held reply's release (0x10000 + its type), a key injected into virtio-input (1). */
export const busy = { events: undefined as number[] | undefined, request: 0, transfer: 0, requests: 0, transfers: 0, pixels: 0, flushes: 0, submits: 0, submitBytes: 0, commands: {} as Record<string, number>, fences: 0, fenceMs: 0, fenceMaxMs: 0, heldMs: 0, behindMs: 0, fullMs: 0, heldMax: 0 };

export class Gpu {
  readonly resources = new Map<number, Resource>();
  private total = 0;
  private scanout: { id: number; rect: Rect } | null = null;
  private cursorImage: Uint8Array | null = null;
  /** UPDATE_CURSORs so far: a 3D cursor's read-back is shown only if no update came after it. */
  private cursorSerial = 0;
  private cursorState = { hotX: 0, hotY: 0, x: 0, y: 0 };
  private flushes = 0;
  private trace: string[] = [];
  /** The size the display reports: the page's (`wanted`), but not below `floor`. */
  private width: number;
  private height: number;
  private wanted: { width: number; height: number };
  /**
   * The size of a resource the guest shows cropped (a rectangle smaller than the resource, from the
   * origin): fbcon keeps its buffer and crops the console when the mode shrinks (docs/graphics.md "The console and the display size"),
   * so the display never reports less than this. Zero until a guest does it; a compositor that
   * allocates a resource per mode never trips it, so desktops follow shrinks.
   */
  private floor = { width: 0, height: 0 };
  /** The floor raised the display event and the guest hasn't cleared an event since (`eventsCleared`). */
  private bounce = false;
  /** The size of the resource last on the scanout (kept while the scanout is off): a mode the guest's buffer holds, for the EDID. */
  private shown = { width: 0, height: 0 };
  /** virgl's contexts (`virgl`): id → the resources attached. */
  private contexts = new Map<number, Set<number>>();
  /** Contexts that have submitted work: they have objects in the renderer (a context alone is only an id). */
  private used = new Set<number>();
  /** Contexts made for the VENUS capset (`venus`): their submits are the renderer's protocol, not virgl's. */
  private venusContexts = new Set<number>();
  /** Blob resources' bytes, against a bound (the renderer keeps them). */
  private blobBytes = 0;
  /** Why 3D is off on this machine (a snapshot restored where the browser can't back the caps its guest was given). */
  private off3d: string | undefined;
  private virgl: VirglCounts = { commands: {}, toHostBytes: 0, fromHostBytes: 0, stream: new VirglStats().json() };
  private stream = new VirglStats();
  /** Called with every SUBMIT_3D's command words (bench/results/local captures). */
  onSubmit?: (ctx: number, words: Uint32Array) => void;
  /** Called with a trace's records (web/virgl-trace.ts) as the guest's 3D commands arrive: the renderer's fixtures. */
  onCapture?: (record: Uint8Array) => void;
  /**
   * Where the 3D work runs, and on a 3D machine the screen too (web/virgl-host.ts). With a host, 2D resources keep
   * their pixels in shared memory (the host's screen reads them in place) and every scanout goes to it.
   */
  host?: VirglHost;
  /** A fenced command's wait for the host (taken by the backend, which holds the reply until it resolves). */
  private wait: Promise<void> | undefined;
  private capsets: ReturnType<typeof capsets>;
  private ram: () => Ram;
  private layout: RamLayout;
  private o: GpuOptions;
  hooks: GpuHooks = {};
  /** Raises the display event (set by the backend): the config changed. */
  raise: (() => void) | undefined;

  constructor(ram: () => Ram, layout: RamLayout, o: GpuOptions) {
    [this.ram, this.layout, this.o] = [ram, layout, o];
    this.wanted = { width: clampSize(o.width), height: clampSize(o.height) };
    [this.width, this.height] = [this.wanted.width, this.wanted.height];
    this.capsets = capsets(o.caps ?? virglCaps(2), o.venus ? o.venusCaps ?? venusCapset() : undefined);
  }

  /** The wait a fenced command left for the host, if any: its reply waits for it. */
  takeWait() {
    const w = this.wait;
    this.wait = undefined;
    return w;
  }

  /** New resources keep the guest's bytes: their screen swizzles them (a host's, or the page's: `GpuHooks.raw`). */
  private get raw() { return !!this.host || !!this.hooks.raw; }

  /** The caps blob the guest is given (VIRGL2). */
  get caps() { return this.capsets[1][2]; }

  /** A control command (the whole readable payload) → the response to write (empty: none fits). */
  control(cmd: Uint8Array, room: number): Uint8Array {
    if (cmd.length < HDR) return this.reply(ERR_UNSPEC, cmd, room);
    const v = new DataView(cmd.buffer, cmd.byteOffset, cmd.length);
    const type = v.getUint32(0, true);
    const k = type.toString(16);
    busy.commands[k] = (busy.commands[k] ?? 0) + 1;
    if (this.onCapture && this.o.virgl) this.capture(type, cmd, v);
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
        this.resources.set(id, { id, format, width, height, pixels: this.pixels(bytes), backing: null, raw: this.raw });
        return this.reply(OK_NODATA, cmd, room);
      }
      case RESOURCE_UNREF: {
        if (!need(HDR + 8)) return this.reply(ERR_UNSPEC, cmd, room);
        const res = this.resources.get(u32(0));
        if (!res) return this.reply(ERR_INVALID_RESOURCE_ID, cmd, room);
        this.resources.delete(res.id);
        this.total -= res.pixels.length;
        for (const set of this.contexts.values()) set.delete(res.id);
        if (this.scanout?.id === res.id) this.setScanout(null);
        if (res.three) this.host?.call({ t: 'unref', id: res.id });
        if (res.blob) {
          this.blobBytes -= res.blob.size;
          this.host?.call({ t: 'blob-unref', res: res.id });
          this.hold();
        }
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
        if (res.three && !res.pixels.length && !this.host) {
          // A virgl resource shown on the null renderer: black pixels for the page.
          const bytes = res.width * res.height * 4;
          if (res.three.target !== TARGET_2D || bytes > MAX_RESOURCE || this.total + bytes > MAX_TOTAL) return this.reply(ERR_INVALID_PARAMETER, cmd, room);
          this.total += bytes;
          res.pixels = new Uint8Array(bytes);
        }
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
        if (res.three || !this.inside(r, res)) return this.reply(ERR_INVALID_PARAMETER, cmd, room);
        const t0 = performance.now();
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
        for (let k = 0; k < n; k++) {
          const at = HDR + 8 + 16 * k;
          const seg = locate(this.layout, v.getBigUint64(at, true), BigInt(v.getUint32(at + 8, true)));
          if (!seg) return this.reply(ERR_INVALID_PARAMETER, cmd, room);
          backing.push(seg);
        }
        res.backing = backing;
        if (res.three) this.host?.call({ t: 'backing', id, backing });
        return this.reply(OK_NODATA, cmd, room);
      }
      case RESOURCE_DETACH_BACKING: {
        if (!need(HDR + 8)) return this.reply(ERR_UNSPEC, cmd, room);
        const res = this.resources.get(u32(0));
        if (!res) return this.reply(ERR_INVALID_RESOURCE_ID, cmd, room);
        res.backing = null;
        if (res.three) this.host?.call({ t: 'backing', id: res.id, backing: null });
        return this.reply(OK_NODATA, cmd, room);
      }
      default:
        return this.o.virgl ? this.control3d(type, cmd, v, room) : this.reply(ERR_UNSPEC, cmd, room);
    }
  }

  /** The virgl commands (`virgl`), on the null renderer: checked as virglrenderer checks them, counted, never drawn. */
  private control3d(type: number, cmd: Uint8Array, v: DataView, room: number): Uint8Array {
    const need = (n: number) => cmd.length >= n;
    const u32 = (at: number) => v.getUint32(HDR + at, true);
    const ctxId = v.getUint32(16, true);
    const count = (name: string) => { this.virgl.commands[name] = (this.virgl.commands[name] ?? 0) + 1; };
    switch (type) {
      case GET_CAPSET_INFO: {
        count('GET_CAPSET_INFO');
        if (!need(HDR + 4)) return this.reply(ERR_UNSPEC, cmd, room);
        const c = this.capsets[u32(0)];
        const r = new Uint8Array(HDR + 16);
        const w = new DataView(r.buffer);
        if (c) [c[0], c[1], c[2].length].forEach((x, k) => w.setUint32(HDR + 4 * k, x, true));
        return this.reply(c ? OK_CAPSET_INFO : ERR_INVALID_PARAMETER, cmd, room, c ? r : undefined);
      }
      case GET_CAPSET: {
        count('GET_CAPSET');
        if (!need(HDR + 8)) return this.reply(ERR_UNSPEC, cmd, room);
        const c = this.capsets.find(([id]) => id === u32(0));
        if (!c || u32(4) > c[1]) return this.reply(ERR_INVALID_PARAMETER, cmd, room);
        const r = new Uint8Array(HDR + c[2].length);
        r.set(c[2], HDR);
        return this.reply(OK_CAPSET, cmd, room, r);
      }
      case CTX_CREATE: {
        count('CTX_CREATE');
        if (ctxId === 0 || this.contexts.has(ctxId) || this.contexts.size >= MAX_CONTEXTS) return this.reply(ERR_INVALID_CONTEXT_ID, cmd, room);
        if (this.off3d) return this.reply(ERR_UNSPEC, cmd, room);
        // CONTEXT_INIT (with `venus`): the capset the context speaks in `context_init`'s low byte; 0 is virgl's.
        const capset = this.o.venus && need(HDR + 8) ? u32(4) & CONTEXT_INIT_CAPSET_ID_MASK : 0;
        if (capset !== 0 && capset !== 1 && capset !== 2 && capset !== CAPSET_VENUS) return this.reply(ERR_INVALID_PARAMETER, cmd, room);
        this.contexts.set(ctxId, new Set());
        if (capset === CAPSET_VENUS) {
          this.venusContexts.add(ctxId);
          const nlen = Math.min(u32(0), 64, Math.max(0, cmd.length - HDR - 8));
          this.host?.call({ t: 'vctx', id: ctxId, create: true, name: new TextDecoder().decode(cmd.subarray(HDR + 8, HDR + 8 + nlen)) });
        } else this.host?.call({ t: 'ctx', id: ctxId, create: true });
        return this.reply(OK_NODATA, cmd, room);
      }
      case CTX_DESTROY: {
        count('CTX_DESTROY');
        if (!this.contexts.delete(ctxId)) return this.reply(ERR_INVALID_CONTEXT_ID, cmd, room);
        this.used.delete(ctxId);
        if (this.venusContexts.delete(ctxId)) {
          this.host?.call({ t: 'vctx', id: ctxId, create: false });
          this.hold();
        } else this.host?.call({ t: 'ctx', id: ctxId, create: false });
        return this.reply(OK_NODATA, cmd, room);
      }
      case CTX_ATTACH_RESOURCE: case CTX_DETACH_RESOURCE: {
        count(type === CTX_ATTACH_RESOURCE ? 'CTX_ATTACH_RESOURCE' : 'CTX_DETACH_RESOURCE');
        if (!need(HDR + 4)) return this.reply(ERR_UNSPEC, cmd, room);
        const set = this.contexts.get(ctxId);
        if (!set) return this.reply(ERR_INVALID_CONTEXT_ID, cmd, room);
        if (!this.resources.has(u32(0))) return this.reply(ERR_INVALID_RESOURCE_ID, cmd, room);
        if (type === CTX_ATTACH_RESOURCE) set.add(u32(0));
        else set.delete(u32(0));
        const res = this.resources.get(u32(0))!;
        // A virgl resource attached to a Venus context: the guest imports it into Vulkan as a dma-buf (a VA-API
        // surface's plane: web/venus-import.ts), as many bytes as its pages (the guest's dma-buf), or its texels at 4 a texel.
        if (res.three && this.venusContexts.has(ctxId)) {
          const t = res.three, pages = (res.backing ?? []).reduce((n, s) => n + s.len, 0);
          const size = Math.ceil(Math.max(pages, res.width * res.height * t.depth * t.arraySize * 4, 4096) / 4096) * 4096;
          this.host?.call({ t: 'blob-ctx', ctx: ctxId, res: u32(0), attach: type === CTX_ATTACH_RESOURCE, size });
        } else if (res.three) this.host?.call({ t: 'ctxres', ctx: ctxId, res: u32(0), attach: type === CTX_ATTACH_RESOURCE });
        else if (res.blob && this.venusContexts.has(ctxId)) this.host?.call({ t: 'blob-ctx', ctx: ctxId, res: u32(0), attach: type === CTX_ATTACH_RESOURCE });
        return this.reply(OK_NODATA, cmd, room);
      }
      case RESOURCE_CREATE_BLOB: {
        count('RESOURCE_CREATE_BLOB');
        if (!this.o.venus) return this.reply(ERR_UNSPEC, cmd, room);
        if (!need(HDR + 32)) return this.reply(ERR_UNSPEC, cmd, room);
        const [id, mem, flags, entries] = [u32(0), u32(4), u32(8), u32(12)];
        const blobId = v.getBigUint64(HDR + 16, true), size = Number(v.getBigUint64(HDR + 24, true));
        if (id === 0 || this.resources.has(id) || this.resources.size >= MAX_RESOURCES) return this.reply(ERR_INVALID_RESOURCE_ID, cmd, room);
        // Host memory of a Venus context only (Venus's shared memory and its objects' memory): guest-backed blobs
        // (BLOB_MEM_GUEST, HOST3D_GUEST) aren't offered (the capset says no guest VRAM).
        if (!this.venusContexts.has(ctxId)) return this.reply(ERR_INVALID_CONTEXT_ID, cmd, room);
        if (mem !== BLOB_MEM_HOST3D || entries !== 0 || size === 0 || size % 4096 || flags & ~7) return this.reply(ERR_INVALID_PARAMETER, cmd, room);
        if (this.blobBytes + size > MAX_BLOB_TOTAL) return this.reply(ERR_OUT_OF_MEMORY, cmd, room);
        this.blobBytes += size;
        this.resources.set(id, { id, format: 0, width: 0, height: 0, pixels: new Uint8Array(0), backing: null, blob: { ctx: ctxId, mem, flags, blobId, size } });
        this.host?.call({ t: 'blob', ctx: ctxId, res: id, mem, flags, blobId, size });
        this.hold();
        return this.reply(OK_NODATA, cmd, room);
      }
      case RESOURCE_MAP_BLOB: {
        count('RESOURCE_MAP_BLOB');
        if (!need(HDR + 16)) return this.reply(ERR_UNSPEC, cmd, room);
        const res = this.resources.get(u32(0));
        const offset = Number(v.getBigUint64(HDR + 8, true));
        if (!res?.blob) return this.reply(ERR_INVALID_RESOURCE_ID, cmd, room);
        const b = res.blob;
        if (!(b.flags & BLOB_FLAG_USE_MAPPABLE) || b.mapped !== undefined) return this.reply(ERR_INVALID_PARAMETER, cmd, room);
        // In the window, page-aligned, and over no other mapping (Linux's allocator picks the offset).
        if (offset % 4096 || offset + b.size > (this.o.window ?? 0)) return this.reply(ERR_INVALID_PARAMETER, cmd, room);
        for (const r of this.resources.values()) {
          const m = r.blob?.mapped;
          if (m !== undefined && offset < m + r.blob!.size && m < offset + b.size) return this.reply(ERR_INVALID_PARAMETER, cmd, room);
        }
        b.mapped = offset;
        this.host?.call({ t: 'blob-map', res: res.id, offset });
        this.hold();
        const r = new Uint8Array(HDR + 8);
        new DataView(r.buffer).setUint32(HDR, MAP_CACHE_CACHED, true);
        return this.reply(OK_MAP_INFO, cmd, room, r);
      }
      case RESOURCE_UNMAP_BLOB: {
        count('RESOURCE_UNMAP_BLOB');
        if (!need(HDR + 8)) return this.reply(ERR_UNSPEC, cmd, room);
        const res = this.resources.get(u32(0));
        if (!res?.blob) return this.reply(ERR_INVALID_RESOURCE_ID, cmd, room);
        if (res.blob.mapped === undefined) return this.reply(ERR_INVALID_PARAMETER, cmd, room);
        res.blob.mapped = undefined;
        this.host?.call({ t: 'blob-unmap', res: res.id });
        this.hold();
        return this.reply(OK_NODATA, cmd, room);
      }
      case RESOURCE_ASSIGN_UUID: {
        count('RESOURCE_ASSIGN_UUID');
        if (!this.o.venus) return this.reply(ERR_UNSPEC, cmd, room);
        if (!need(HDR + 8)) return this.reply(ERR_UNSPEC, cmd, room);
        if (!this.resources.has(u32(0))) return this.reply(ERR_INVALID_RESOURCE_ID, cmd, room);
        // A stable UUID a resource is known by across devices: its id, in a version 4 shape.
        const r = new Uint8Array(HDR + 16);
        const w = new DataView(r.buffer);
        w.setUint32(HDR, 0x77656270, false); // "webp"
        w.setUint32(HDR + 4, 0x4000, false);
        w.setUint32(HDR + 8, 0x80000000, false);
        w.setUint32(HDR + 12, u32(0), false);
        return this.reply(OK_RESOURCE_UUID, cmd, room, r);
      }
      case SET_SCANOUT_BLOB: {
        count('SET_SCANOUT_BLOB');
        return this.reply(ERR_UNSPEC, cmd, room);
      }
      case RESOURCE_CREATE_3D: {
        count('RESOURCE_CREATE_3D');
        if (!need(HDR + 44)) return this.reply(ERR_UNSPEC, cmd, room);
        const [id, target, format, bind, width, height, depth, arraySize, lastLevel, samples] = [0, 4, 8, 12, 16, 20, 24, 28, 32, 36].map(u32);
        if (id === 0 || this.resources.has(id) || this.resources.size >= MAX_RESOURCES) return this.reply(ERR_INVALID_RESOURCE_ID, cmd, room);
        if (target > 8 || width === 0 || height === 0 || depth === 0 || arraySize === 0) return this.reply(ERR_INVALID_PARAMETER, cmd, room);
        this.resources.set(id, { id, format, width, height, pixels: new Uint8Array(0), backing: null, three: { target, bind, depth, arraySize, lastLevel, samples } });
        this.host?.call({ t: 'res', desc: { id, target, format, bind, width, height, depth, arraySize, lastLevel, samples, flags: u32(40) } });
        this.fenced(cmd);
        return this.reply(OK_NODATA, cmd, room);
      }
      case TRANSFER_TO_HOST_3D: case TRANSFER_FROM_HOST_3D: {
        const to = type === TRANSFER_TO_HOST_3D;
        count(to ? 'TRANSFER_TO_HOST_3D' : 'TRANSFER_FROM_HOST_3D');
        if (!need(HDR + 48)) return this.reply(ERR_UNSPEC, cmd, room);
        const [w, h, d] = [u32(12), u32(16), u32(20)];
        const res = this.resources.get(u32(32));
        if (!res?.three) return this.reply(ERR_INVALID_RESOURCE_ID, cmd, room);
        if (!res.backing) return this.reply(ERR_UNSPEC, cmd, room);
        // The bytes the transfer covers: a buffer's box is in bytes; a texture's rows are `stride` apart.
        const [stride, layerStride] = [u32(40), u32(44)];
        const bytes = res.three.target === 0 ? w : d > 1 ? layerStride * d : stride * h;
        if (to) this.virgl.toHostBytes += bytes;
        else this.virgl.fromHostBytes += bytes;
        this.host?.call({ t: 'transfer', ctx: ctxId, res: res.id, level: u32(36), box: { x: u32(0), y: u32(4), z: u32(8), w, h, d }, offset: Number(v.getBigUint64(HDR + 24, true)), stride, layerStride, toHost: to });
        this.fenced(cmd);
        return this.reply(OK_NODATA, cmd, room);
      }
      case SUBMIT_3D: {
        count('SUBMIT_3D');
        if (!need(HDR + 8)) return this.reply(ERR_UNSPEC, cmd, room);
        if (!this.contexts.has(ctxId)) return this.reply(ERR_INVALID_CONTEXT_ID, cmd, room);
        const size = u32(0);
        if (size % 4 || cmd.length < HDR + 8 + size) return this.reply(ERR_INVALID_PARAMETER, cmd, room);
        if (this.venusContexts.has(ctxId)) {
          // Venus's commands (the renderer decodes them): handed on as they are.
          busy.submits++;
          busy.submitBytes += size;
          this.used.add(ctxId);
          const flags = v.getUint32(4, true);
          const fence = flags & FLAG_FENCE ? { flags: flags & (FLAG_FENCE | FLAG_INFO_RING_IDX), ring: flags & FLAG_INFO_RING_IDX ? v.getUint8(20) : 0, id: v.getBigUint64(8, true) } : undefined;
          this.host?.call({ t: 'vsubmit', ctx: ctxId, bytes: cmd.slice(HDR + 8, HDR + 8 + size), ...(fence ? { fence } : {}) });
          this.fenced(cmd);
          return this.reply(OK_NODATA, cmd, room);
        }
        const words = new Uint32Array(cmd.buffer.slice(cmd.byteOffset + HDR + 8, cmd.byteOffset + HDR + 8 + size));
        const ok = this.stream.count(words) >= 0;
        busy.submits++;
        busy.submitBytes += size;
        this.onSubmit?.(ctxId, words);
        this.used.add(ctxId);
        if (ok && this.host) {
          this.host.call({ t: 'submit', ctx: ctxId, words });
          this.fenced(cmd);
        }
        return this.reply(ok ? OK_NODATA : ERR_INVALID_PARAMETER, cmd, room);
      }
      default:
        return this.reply(ERR_UNSPEC, cmd, room);
    }
  }

  /**
   * `onCapture`: the command if it concerns 3D (and the scanout, which may show a 3D resource), after the guest
   * memory it will read: the staging bytes a SUBMIT_3D's uploads copy (COPY_TRANSFER3D to the host), the region a
   * TRANSFER_TO_HOST_3D copies.
   */
  private capture(type: number, cmd: Uint8Array, v: DataView) {
    const u32 = (at: number) => (cmd.length >= HDR + at + 4 ? v.getUint32(HDR + at, true) : 0);
    const three = (id: number) => this.resources.get(id)?.three !== undefined;
    const data = (id: number, offset: number, len: number) => {
      const res = this.resources.get(id);
      if (!res?.backing || len <= 0) return;
      const total = res.backing.reduce((n, b) => n + b.len, 0);
      len = Math.min(len, total - offset);
      if (len <= 0) return;
      const bytes = new Uint8Array(len);
      readBacking(this.ram(), res.backing, offset, bytes);
      this.onCapture!(encodeRecord({ kind: 'data', res: id, offset, bytes }));
    };
    if (type === SUBMIT_3D && cmd.length >= HDR + 8) {
      const size = u32(0);
      if (size % 4 === 0 && cmd.length >= HDR + 8 + size) {
        const words = new Uint32Array(cmd.buffer.slice(cmd.byteOffset + HDR + 8, cmd.byteOffset + HDR + 8 + size));
        walk(words, (c, _obj, at, len) => {
          // TRANSFER3D (43) and COPY_TRANSFER3D (45): dst, level, usage, stride, layer stride, box (x y z w h d), then
          // TRANSFER3D's offset in the resource's own backing and direction (1: to the host), or COPY_TRANSFER3D's
          // source (a staging buffer), offset in it and flags (2: a read-back).
          // DECODE_BITSTREAM (59): codec, target, the picture's parameters and its data (staging buffers), the
          // data's length (docs/plans/video.md).
          if (c === 59 && len >= 5) {
            data(words[at + 2], 0, 0x7fffffff);
            data(words[at + 3], 0, words[at + 4]);
            return;
          }
          const copy = c === 45 && len === 14 && !(words[at + 13] & 2);
          if (!copy && !(c === 43 && len >= 13 && words[at + 12] === 1)) return;
          const dst = this.resources.get(words[at]);
          if (!dst?.three) return;
          const [w, h, d] = [words[at + 8], words[at + 9], words[at + 10]];
          const n = dst.three.target === 0 ? w : boxBytes(VIRGL_FORMATS.get(dst.format), w, h, d, words[at + 3], words[at + 4]);
          if (copy) data(words[at + 11], words[at + 12], n);
          else data(dst.id, words[at + 11], n);
        });
      }
    } else if (type === TRANSFER_TO_HOST_3D && cmd.length >= HDR + 48) {
      const res = this.resources.get(u32(32));
      if (res?.three) {
        const [w, h, d] = [u32(12), u32(16), u32(20)];
        data(res.id, Number(v.getBigUint64(HDR + 24, true)), res.three.target === 0 ? w : boxBytes(VIRGL_FORMATS.get(res.format), w, h, d, u32(40), u32(44)));
      }
    }
    const wanted = (type >= CTX_CREATE && type <= SUBMIT_3D) || type === SET_SCANOUT || type === GET_CAPSET
      || ((type === RESOURCE_ATTACH_BACKING || type === RESOURCE_DETACH_BACKING || type === RESOURCE_UNREF || type === RESOURCE_FLUSH) && three(u32(type === RESOURCE_FLUSH ? 16 : 0)));
    if (wanted) this.onCapture!(encodeRecord({ kind: 'command', bytes: cmd.slice() }));
  }

  /** A command with a fence waits for the host to have run everything before its reply goes. */
  private fenced(cmd: Uint8Array) {
    if (this.host && new DataView(cmd.buffer, cmd.byteOffset, 8).getUint32(4, true) & FLAG_FENCE) this.wait = this.host.fence();
  }

  /** The reply waits for the host whatever the command's flags: a blob's map must be in the window before the guest reads it. */
  private hold() {
    if (this.host) this.wait = this.host.fence();
  }

  /** A 2D resource's pixels: in shared memory when a host's screen shows them. */
  private pixels(bytes: number) {
    return this.host ? new Uint8Array(new SharedArrayBuffer(bytes)) : new Uint8Array(bytes);
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
      const serial = ++this.cursorSerial;
      [c.hotX, c.hotY] = [u32(20), u32(24)];
      if (id === 0) this.cursorImage = null;
      else {
        const res = this.resources.get(id);
        if (!res || res.width !== CURSOR || res.height !== CURSOR) return; // the guest's mistake: the cursor stays as it was
        if (res.three) return this.readCursor(res, serial);
        this.cursorImage = res.raw ? rgba(res, 0, CURSOR * CURSOR) : res.pixels.slice();
      }
    }
    this.hooks.cursor?.(this.cursorImage, c.hotX, c.hotY, c.x, c.y);
  }

  /**
   * A 3D cursor (a compositor on virgl draws its cursor with GL, and Linux transfers only dumb buffers): its pixels
   * are the renderer's, read back as QEMU does (`virgl_renderer_get_cursor_data`), after the guest's commands
   * before it, and shown unless another update came meanwhile.
   */
  private readCursor(res: Resource, serial: number) {
    const order = FORMATS.get(res.format);
    if (!order || !this.host?.read || this.off3d) return;
    void this.host.read(res.id).then((bytes) => {
      if (serial !== this.cursorSerial || !bytes || bytes.length < CURSOR * CURSOR * 4) return;
      const img = new Uint8Array(CURSOR * CURSOR * 4);
      for (let p = 0; p < img.length; p += 4) for (let k = 0; k < 4; k++) img[p + k] = bytes[p + order[k]];
      this.cursorImage = img;
      const c = this.cursorState;
      this.hooks.cursor?.(img, c.hotX, c.hotY, c.x, c.y);
    });
  }

  /** The page's size changed: the next GET_DISPLAY_INFO and EDID say so, and the guest gets a display event. */
  setSize(width: number, height: number) {
    this.wanted = { width: clampSize(width), height: clampSize(height) };
    this.report();
    this.raise?.();
  }

  /**
   * The modes after the preferred one: the size of the resource the guest last showed (a console's buffer)
   * and the floor. fbcon refuses a mode wider or taller than its buffer (DRM's `VIRTUAL_X`/`VIRTUAL_Y`)
   * and with no other mode in the list it blanks the screen: a window grown past the buffer would
   * kill the console. With these the guest falls back to a size its buffer holds. (The size the display
   * started with is not it: a machine restored from a snapshot starts at the new page's size, and its console
   * was born in another.)
   */
  private fallbackModes() {
    const modes: { width: number; height: number }[] = [];
    for (const m of [this.shown, this.floor]) {
      if (m.width < EDID_MIN.width || m.height < EDID_MIN.height) continue;
      if ((m.width === this.width && m.height === this.height) || modes.some((x) => x.width === m.width && x.height === m.height)) continue;
      modes.push(m);
    }
    return modes;
  }

  /**
   * The guest cleared the display event (the backend calls this). It clears the bit after it has handled
   * the event, and the floor's event comes while it is still handling the shrink that caused it, so that
   * clear takes the new event with it (the console stayed cropped, seen in CI): raise it once more.
   */
  eventsCleared() {
    if (!this.bounce) return;
    this.bounce = false;
    this.raise?.();
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
    this.hostScanout();
    if (s && res) {
      this.shown = { width: res.width, height: res.height };
      this.draw(res, s.rect);
      res.changed = false;
      if (this.o.keepConsole && s.rect.x === 0 && s.rect.y === 0 && (s.rect.w < res.width || s.rect.h < res.height)) {
        // The console is cropped: ask for its whole buffer again.
        this.floor = { width: Math.max(this.floor.width, res.width), height: Math.max(this.floor.height, res.height) };
        if (this.report()) {
          this.bounce = true;
          this.raise?.();
        }
      }
    }
  }

  /** Tells the host (a 3D machine's GPU worker, which draws the screen) what the scanout shows. */
  private hostScanout() {
    if (!this.host) return;
    const s = this.scanout;
    const res = s && this.resources.get(s.id);
    if (!s || !res) this.host.call({ t: 'scanout', width: 0, height: 0, rect: { x: 0, y: 0, w: 0, h: 0 } });
    else if (res.three) this.host.call({ t: 'scanout', res: res.id, width: res.width, height: res.height, rect: { ...s.rect } });
    else this.host.call({ t: 'scanout', pixels: res.pixels, swizzle: res.raw ? FORMATS.get(res.format)!.slice(0, 3) : undefined, width: res.width, height: res.height, rect: { ...s.rect } });
  }

  /** Copies the part of `r` that is on the scanout to the page. */
  private draw(res: Resource, r: Rect) {
    const s = this.scanout;
    if (!s || s.id !== res.id) return;
    const x0 = Math.max(r.x, s.rect.x), y0 = Math.max(r.y, s.rect.y);
    const x1 = Math.min(r.x + r.w, s.rect.x + s.rect.w), y1 = Math.min(r.y + r.h, s.rect.y + s.rect.h);
    if (x1 <= x0 || y1 <= y0) return;
    const rect = { x: x0 - s.rect.x, y: y0 - s.rect.y, w: x1 - x0, h: y1 - y0 };
    this.hooks.damage?.(rect);
    this.host?.call({ t: 'damage', rect });
  }

  /** Tells the hooks the scanout as it is now. */
  private announce() {
    const s = this.scanout;
    const res = s && this.resources.get(s.id);
    this.hooks.scanout?.(s ? s.rect.w : 0, s ? s.rect.h : 0, s && res ? { pixels: res.pixels, width: res.width, height: res.height, x: s.rect.x, y: s.rect.y, swizzle: res.raw ? FORMATS.get(res.format)!.slice(0, 3) : undefined } : null);
  }

  private flush(res: Resource, r: Rect) {
    busy.flushes++;
    // A page flip is transfer, SET_SCANOUT, flush: the scanout change has drawn it all, and the flush would draw it again.
    // A 3D resource changes on the host: every flush shows it.
    if (res.changed || (res.three && this.host)) this.draw(res, r);
    if (this.o.trace) this.trace.push(this.screenHash() ?? '');
    const t = this.o.resize;
    if (t && ++this.flushes === t.after) this.setSize(t.width, t.height);
  }

  /** Whether the rows of `r` from `offset` lie inside the backing. */
  private fits(res: Resource, r: Rect, offset: number) {
    const last = offset + res.width * 4 * (r.h - 1) + r.w * 4;
    return Number.isSafeInteger(last) && last <= res.backing!.reduce((n, b) => n + b.len, 0);
  }

  /** TRANSFER_TO_HOST_2D: the rectangle's rows from the backing (the first at `offset`, rows `width`×4 bytes apart) into the host pixels. False if the backing is too short. */
  private transfer(res: Resource, r: Rect, offset: number) {
    if (r.w === 0 || r.h === 0) return true;
    res.changed = true;
    const stride = res.width * 4;
    const rowLen = r.w * 4;
    const backing = res.backing!;
    if (!this.fits(res, r, offset)) return false;
    const [ri, gi, bi, ai] = FORMATS.get(res.format)!;
    const ram = this.ram();
    if (res.raw) {
      // For the host's screen: the bytes as they are, a backing page's run at a time.
      const px = res.pixels;
      let seg = 0, segStart = 0;
      for (let y = 0; y < r.h; y++) {
        let at = offset + stride * y;
        let d = ((r.y + y) * res.width + r.x) * 4;
        for (let left = rowLen; left > 0;) {
          while (at >= segStart + backing[seg].len) segStart += backing[seg++].len;
          const b = backing[seg];
          const s0 = at - segStart;
          const n = Math.min(left, b.len - s0);
          px.set(bytes(ram, b).subarray(s0, s0 + n), d);
          d += n;
          left -= n;
          at += n;
        }
      }
      return true;
    }
    // The usual case, words: B8G8R8x or R8G8B8x, pages 4-byte aligned (Linux's are): 32-bit loads and stores
    // with the channels swapped in registers, ~4 times the bytewise loop (a console scrolling at full screen
    // sends hundreds of these a second, and the guest waits for each).
    const swap = res.format === 1 || res.format === 2;
    if ((swap || res.format === 67 || res.format === 134) && ram.every((m) => m.byteOffset % 4 === 0) && offset % 4 === 0 && backing.every((b) => b.off % 4 === 0 && b.len % 4 === 0)) {
      const srcs = ram.map((m) => new Uint32Array(m.buffer, m.byteOffset, m.length >>> 2));
      const dst = new Uint32Array(res.pixels.buffer, res.pixels.byteOffset, res.pixels.length >>> 2);
      const opaque = res.opaque ? 0xff000000 : 0;
      const words = r.w;
      let seg = 0, segStart = 0; // the backing page holding the byte at `at`, and where it starts: rows only move forward
      for (let y = 0; y < r.h; y++) {
        let at = offset + stride * y;
        while (at >= segStart + backing[seg].len) segStart += backing[seg++].len;
        let d = (r.y + y) * res.width + r.x;
        for (let left = words; left > 0;) {
          const b = backing[seg];
          const src = srcs[b.mem];
          const s0 = (b.off + (at - segStart)) >>> 2;
          const n = Math.min(left, (b.len - (at - segStart)) >>> 2);
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
        // A fence on a ring (FLAG_INFO_RING_IDX, Venus's timelines) answers with its ring.
        const flags = c.getUint32(4, true) & (FLAG_FENCE | FLAG_INFO_RING_IDX);
        v.setUint32(4, flags, true);
        v.setBigUint64(8, c.getBigUint64(8, true), true);
        if (flags & FLAG_INFO_RING_IDX) v.setUint8(20, c.getUint8(20));
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
    const res = this.resources.get(s.id)!;
    const words = new Uint32Array(res.pixels.buffer, res.pixels.byteOffset, res.pixels.length / 4);
    const rows = [];
    for (let y = 0; y < s.rect.h; y++) {
      const at = (s.rect.y + y) * res.width + s.rect.x;
      rows.push(res.raw ? new Uint32Array(rgba(res, at, s.rect.w).buffer) : words.subarray(at, at + s.rect.w));
    }
    return hashRgba(rows, true);
  }

  /** What a test or a snapshot reads: the state without the pixels (they come back from the backing), and the hashes of what is visible. */
  state() {
    const s = this.scanout;
    const screen = this.screenHash();
    const c = this.cursorImage;
    return {
      width: this.width, height: this.height, flushes: this.flushes,
      resources: [...this.resources.values()].map((r) => ({ id: r.id, format: r.format, width: r.width, height: r.height, backing: r.backing?.map((b) => (b.mem ? [b.off, b.len, b.mem] : [b.off, b.len])) ?? null })),
      scanout: s ? { id: s.id, ...s.rect } : null,
      screen,
      trace: this.trace,
      cursor: c ? { ...this.cursorState, hash: hashRgba([new Uint32Array(c.buffer, c.byteOffset, c.length / 4)], false) } : null,
      ...(this.o.virgl ? { virgl: { ...this.virgl, contexts: this.contexts.size, stream: this.stream.json() } } : {}),
    };
  }

  /** A virtio reset: the guest's resources, scanout and cursor are gone. */
  reset() {
    this.shown = { width: 0, height: 0 };
    this.resources.clear();
    this.contexts.clear();
    this.used.clear();
    this.venusContexts.clear();
    this.blobBytes = 0;
    this.host?.call({ t: 'reset' });
    this.total = 0;
    this.cursorImage = null;
    this.cursorSerial++; // a 3D cursor still being read back is dropped
    this.cursorState = { hotX: 0, hotY: 0, x: 0, y: 0 };
    this.setScanout(null);
    if (this.hooks.cursorReset) this.hooks.cursorReset();
    else this.hooks.cursor?.(null, 0, 0, 0, 0);
  }

  /**
   * A snapshot's state: `state` plus the cursor's image, JSON but for the 3D contents (Uint8Arrays: web/snapshot.ts
   * writes them as frames of their own). Host pixels come back from the backing at `restore`. With 3D in use, the
   * renderer's state comes from the host (`VirglRenderer.save`: objects as data, contents read back; docs/graphics.md
   * "Snapshots with 3D in use"), with the 3D resources and the contexts' attachments here; the caps the guest was given are kept, for a
   * restore to check. `unsaveable` where the host refuses (a video decoding) or can't save; the snapshot refuses it
   * (web/vm.ts), and a test's state read takes the rest all the same.
   */
  async save() {
    const inUse = this.used.size > 0 || [...this.resources.values()].some((r) => r.three);
    let renderer: RendererSnapshot | undefined, unsaveable: string | undefined;
    if (this.venusContexts.size > 0) unsaveable = "the machine is using Vulkan (Venus), whose state can't be saved yet";
    else if (inUse && this.host && !this.off3d) {
      const got = this.host.save ? await this.host.save() : { refused: 'the machine is using 3D (virgl), and this renderer can\'t be saved' };
      if ('refused' in got) unsaveable = got.refused;
      else renderer = got.state;
    }
    const three = this.o.virgl ? {
      contexts: [...this.contexts.keys()], caps: toBase64(this.caps), ...(this.off3d ? { off3d: this.off3d } : {}),
      attached: [...this.contexts].map(([id, set]) => [id, [...set]]), used: [...this.used],
      three: [...this.resources.values()].filter((r) => r.three).map((r) => [r.id, r.three]),
      ...(renderer ? { renderer } : {}),
    } : {};
    return { ...this.state(), cursorImage: this.cursorImage ? toBase64(this.cursorImage) : null, shown: this.shown, ...three, ...(unsaveable ? { unsaveable } : {}) };
  }

  /** `save`'s state back: the tables, then every resource with a backing read again from the (restored) RAM, and the scanout drawn. */
  restore(state: unknown) {
    const t = state as Awaited<ReturnType<Gpu['save']>> & { contexts?: number[]; caps?: string; off3d?: string; attached?: [number, number[]][]; used?: number[]; three?: [number, NonNullable<Resource['three']>][]; renderer?: RendererSnapshot };
    if (!Array.isArray(t?.resources) || !(t.width > 0) || !(t.height > 0)) throw new Error('the snapshot has no state for the display device');
    this.resources.clear();
    this.total = 0;
    this.scanout = null;
    [this.width, this.height, this.flushes] = [t.width, t.height, t.flushes];
    this.wanted = { width: t.width, height: t.height };
    this.floor = { width: 0, height: 0 };
    this.bounce = false;
    this.trace = t.trace ?? [];
    const three = new Map(t.three ?? []);
    for (const r of t.resources) {
      const backing = r.backing?.map(([off, len, mem = 0]) => ({ off, len, mem })) ?? null;
      const t3 = three.get(r.id);
      if (t3) {
        // A virgl resource: its contents are the renderer's (`renderer` below).
        this.resources.set(r.id, { id: r.id, format: r.format, width: r.width, height: r.height, pixels: new Uint8Array(0), backing, three: t3 });
        continue;
      }
      const res: Resource = { id: r.id, format: r.format, width: r.width, height: r.height, pixels: this.pixels(r.width * r.height * 4), backing, raw: this.raw };
      this.total += res.pixels.length;
      this.resources.set(res.id, res);
      if (res.backing) this.transfer(res, { x: 0, y: 0, w: res.width, h: res.height }, 0);
    }
    this.scanout = t.scanout ? { id: t.scanout.id, rect: { x: t.scanout.x, y: t.scanout.y, w: t.scanout.w, h: t.scanout.h } } : null;
    this.cursorImage = t.cursorImage ? Uint8Array.from(atob(t.cursorImage), (c) => c.charCodeAt(0)) : null;
    this.cursorSerial++;
    this.cursorState = t.cursor ? { hotX: t.cursor.hotX, hotY: t.cursor.hotY, x: t.cursor.x, y: t.cursor.y } : { hotX: 0, hotY: 0, x: 0, y: 0 };
    // 3D: the guest keeps the caps it read at boot. The device gives them again, and if this browser can't back them,
    // 3D is off (a context can't be made; the guest's GL falls back or fails) rather than the machine refused.
    this.contexts.clear();
    this.used.clear();
    this.off3d = t.off3d;
    if (this.o.virgl && t.caps) {
      const saved = Uint8Array.from(atob(t.caps), (c) => c.charCodeAt(0));
      const now = this.caps;
      if (saved.length !== now.length || saved.some((x, k) => x !== now[k])) {
        const why = capsBacked(saved, now);
        this.capsets = capsets(saved);
        if (why) this.off3d ??= `this browser can't back the 3D the machine was started with (${why})`;
      }
    }
    if (this.off3d) console.warn(`virtio-gpu: 3D is off: ${this.off3d}`);
    const attached = new Map(t.attached ?? []);
    for (const id of t.contexts ?? []) this.contexts.set(id, new Set(attached.get(id) ?? []));
    for (const id of t.used ?? []) this.used.add(id);
    if (t.renderer && this.host && !this.off3d) this.host.call({ t: 'load', state: t.renderer });
    else {
      if (t.renderer) console.warn(`virtio-gpu: the machine's 3D state isn't restored (${this.off3d ?? 'no renderer'}): its GL programs will fail`);
      if (!this.off3d) for (const id of t.contexts ?? []) this.host?.call({ t: 'ctx', id, create: true });
    }
    const s = this.scanout;
    const sr = s && this.resources.get(s.id);
    if (sr?.three && !this.host) sr.pixels = new Uint8Array(sr.width * sr.height * 4); // the null renderer's black
    if (s) makeOpaque(this.resources.get(s.id)!);
    const shown = s && this.resources.get(s.id);
    this.shown = shown ? { width: shown.width, height: shown.height } : t.shown?.width > 0 && t.shown.height > 0 ? { width: t.shown.width, height: t.shown.height } : { width: 0, height: 0 };
    if (this.o.keepConsole && s && shown && s.rect.x === 0 && s.rect.y === 0 && (s.rect.w < shown.width || s.rect.h < shown.height)) this.floor = { width: shown.width, height: shown.height };
    this.announce();
    this.hostScanout();
    if (s) this.draw(this.resources.get(s.id)!, s.rect);
    this.hooks.cursor?.(this.cursorImage, this.cursorState.hotX, this.cursorState.hotY, this.cursorState.x, this.cursorState.y);
  }
}

/** A resource that is on the scanout loses its alpha (an X format's unused byte, `FORMATS`): from now on transfers write 255 too. A raw one keeps its bytes (its screen ignores alpha). */
function makeOpaque(res: Resource) {
  if (res.opaque || res.raw) return;
  res.opaque = true;
  for (let k = 3; k < res.pixels.length; k += 4) res.pixels[k] = 255;
}

/** `n` pixels of a raw resource from pixel `at`, as RGBA. */
function rgba(res: Resource, at: number, n: number) {
  const [ri, gi, bi, ai] = FORMATS.get(res.format)!;
  const px = res.pixels, out = new Uint8Array(n * 4);
  for (let k = 0, s = at * 4; k < out.length; k += 4, s += 4) [out[k], out[k + 1], out[k + 2], out[k + 3]] = [px[s + ri], px[s + gi], px[s + bi], px[s + ai]];
  return out;
}

/** Reads `out.length` bytes at `offset` of the concatenated backing pages. */
function readBacking(ram: Ram, backing: Segment[], offset: number, out: Uint8Array) {
  let skip = offset, k = 0;
  for (const b of backing) {
    if (skip >= b.len) {
      skip -= b.len;
      continue;
    }
    const n = Math.min(b.len - skip, out.length - k);
    out.set(bytes(ram, b).subarray(skip, skip + n), k);
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
  const gpu = new Gpu(() => ctx.ram(), ctx.layout, o);
  gpu.hooks = hooks;
  gpu.raise = () => ctx.changeConfig((c) => {
    const v = new DataView(c.buffer, c.byteOffset, 16);
    v.setUint32(0, v.getUint32(0, true) | EVENT_DISPLAY, true);
  });
  // Replies not sent yet, in order: a fenced command's waits for the host (`ready` once it has run), and with
  // `paceFlushes` a flush that follows the last within a frame waits for the frame's end, with all behind it.
  type Held = { w0: number; len: number; flush: boolean; ready: boolean; behind: boolean; at: number; type: number };
  let held: Held[] = [];
  // The stats' queue occupancy (`?displaystats`): the most replies held at once, and the time QUEUE_FULL of them were
  // (the page's queue size: the guest's ring had no free entry, so its next command waited).
  const QUEUE_FULL = 16;
  let fullSince = -1;
  const occupancy = () => {
    busy.heldMax = Math.max(busy.heldMax, held.length);
    const now = performance.now();
    if (held.length >= QUEUE_FULL && fullSince < 0) fullSince = now;
    else if (held.length < QUEUE_FULL && fullSince >= 0) { busy.fullMs += now - fullSince; fullSince = -1; }
  };
  let lastFlush = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const FRAME_MS = 1000 / 60;
  const pump = (fromTimer = false) => {
    while (held.length) {
      const h = held[0];
      if (!h.ready) return;
      if (h.flush && o.paceFlushes) {
        const now = performance.now();
        if (!fromTimer && now - lastFlush < FRAME_MS) {
          timer ??= setTimeout(() => { timer = undefined; pump(true); }, Math.max(0, lastFlush + FRAME_MS - now));
          return;
        }
        // A frame's end is a frame after the last, not when the timer got to run (timers are late: the rate would sag below 60).
        lastFlush = fromTimer && now - lastFlush < 2 * FRAME_MS ? lastFlush + FRAME_MS : now;
        fromTimer = false;
      }
      held.shift();
      busy.heldMs += performance.now() - h.at;
      if (h.behind) busy.behindMs += performance.now() - h.at;
      occupancy();
      busy.events?.push(performance.timeOrigin + performance.now(), 0x10000 + h.type);
      ctx.complete(h.w0, h.len);
    }
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
      const type = cmd.length >= 4 ? new DataView(cmd.buffer, cmd.byteOffset, 4).getUint32(0, true) : 0;
      busy.events?.push(performance.timeOrigin + t0, type);
      const reply = gpu.control(cmd, room);
      scatter(ram, r.write, reply);
      busy.request += performance.now() - t0;
      busy.requests++;
      const wait = gpu.takeWait();
      const flush = !!o.paceFlushes && type === RESOURCE_FLUSH;
      const now = performance.now();
      if (held.length || wait || (flush && now - lastFlush < FRAME_MS)) {
        // `behind`: neither fenced nor a paced flush, held only for the replies before it.
        const h: Held = { w0: r.w0, len: reply.length, flush, ready: !wait, behind: !wait && !flush, at: now, type };
        held.push(h);
        occupancy();
        if (wait) {
          busy.fences++;
          void wait.then(() => {
            const dt = performance.now() - now;
            busy.fenceMs += dt;
            busy.fenceMaxMs = Math.max(busy.fenceMaxMs, dt);
            h.ready = true;
            pump();
          });
        }
        else pump();
        return undefined;
      }
      if (flush) lastFlush = now;
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
        if (clear & EVENT_DISPLAY) gpu.eventsCleared();
      }
    },
    reset: () => {
      clearTimeout(timer);
      timer = undefined;
      held = [];
      fullSince = -1;
      gpu.reset();
    },
    save: () => gpu.save(),
    restore: (state: unknown) => gpu.restore(state),
  };
}
