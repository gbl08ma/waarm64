// The agent's framing (docs/plans/clipboard.md §2): what the page and the guest's agent (waarm64-agent) say to each other
// over the agent's vsock connection (web/vsock-device.ts), as frames: a u32 length (little-endian, the bytes after it: the type
// and the payload), a u8 type, then the payload. This module cuts the byte stream into frames, both ways, and defines
// the payloads: the page's half of the format the agent's own code speaks (agent/src/frame.rs, its Rust twin, which
// pins the same bytes in its tests). HELLO, TYPE, PAUSE and RESUME (step 2); the clipboard's OFFER, REQUEST, DATA,
// ACK and MORE (step 3), the capability `CAP.TEXT`; SESSION and TYPED; `CAP.IMAGE` (step 5); TIME, `CAP.TIME` (the
// guest's clock); DISPLAY, `CAP.DISPLAY` (the guest's screen follows the page's size); RENEW and RENEWED, `CAP.RENEW`
// (a template's copy made the guest's own); LEASE and LEASED, `CAP.LEASE` (the leases renewed after a restore);
// DESKTOP, `CAP.DESKTOP` (the guest's graphical session up or down); TRIM and TRIMMED, `CAP.TRIM` (the guest's
// filesystems trimmed on the page's request); KEYMAP, `CAP.KEYMAP` (the machine's keyboard layout for the running session);
// COPY and COPIED, `CAP.COPY` (the text console's screen as text, for the host's clipboard); OS, `CAP.OS` (the guest's
// OS named, for the status bar); POWER and POWERED, `CAP.POWER` (the guest powers off or reboots itself).

/** The frame types (docs/plans/clipboard.md §2). */
export const FRAME = {
  /** Version and capabilities: each side's first frame. */
  HELLO: 1,
  /** A serial number and the MIME types a side has (its clipboard changed). */
  OFFER: 2,
  /** A serial number and a type: the bytes of an offer, please. */
  REQUEST: 3,
  /** A serial number, a type and bytes: an answer to a request, in frames of at most `MAX_PAYLOAD`. */
  DATA: 4,
  /** Text to paste on the guest's console. */
  TYPE: 5,
  /** The toolbar's switch: stop sharing until RESUME. */
  PAUSE: 6,
  RESUME: 7,
  /** A serial number and a status (`ACK`): what the agent did with the page's offer. */
  ACK: 8,
  /** A request id and a count: how many more DATA frames the requester takes (0 stops the answer). */
  MORE: 9,
  // 10 was SYNC (a stream begun afresh after a restore, over the virtio-console the agent had before vsock): unused.
  /**
   * The agent's: the guest's clipboard changed hands (a session child started or stopped, or its compositor came or
   * went). What the page knew of the guest's clipboard is gone, and so are the transfers of the one before.
   */
  SESSION: 11,
  /** The agent's: a u8 status (`TYPED`), what became of TYPE's text. */
  TYPED: 12,
  /** The page's: the host's wall clock (`encodeTime`), for the guest's (the agent sets it). */
  TIME: 13,
  /** The page's: the size of its screen (`encodeDisplay`), for the guest's session to take (the agent sets its outputs). */
  DISPLAY: 14,
  /** The page's: the guest was restored from a template (a snapshot flagged so): random bytes of the host's, to make its identity its own. */
  RENEW: 15,
  /** The agent's: what RENEW renewed and what failed (`decodeRenewed`, bits `RENEWED`). */
  RENEWED: 16,
  /** The page's: the machine was restored and its connections are up: the guest is to renew its leases. */
  LEASE: 17,
  /** The agent's: a u8 status (`LEASED`), what became of LEASE. */
  LEASED: 18,
  /** The agent's: a u8 state (`DESKTOP`), the graphical session on the guest's seat0 now. */
  DESKTOP: 19,
  /** The page's: the guest's filesystems are to tell their disks what they no longer use (a trim). */
  TRIM: 20,
  /** The agent's: a u8 status (`TRIMMED`), what became of TRIM. */
  TRIMMED: 21,
  /** The page's: the machine's keyboard layout (`encodeKeymap`), which the guest's running session is to have. */
  KEYMAP: 22,
  /** The page's: the foreground text console's screen, as text, please. */
  COPY: 23,
  /** The agent's: a u8 status (`COPIED`), then the screen's UTF-8 text (`decodeCopied`). */
  COPIED: 24,
  /** The agent's, after its HELLO to a page with `CAP.OS`: the guest's OS (`decodeOs`). */
  OS: 25,
  /** The page's: a u8 (`POWER`), the guest is to power off or reboot itself (a clean shutdown). */
  POWER: 26,
  /** The agent's: a u8 status (`POWERED`), whether the guest took POWER. */
  POWERED: 27,
} as const;

/** POWER's requests (agent/src/frame.rs `power`). */
export const POWER = { OFF: 0, REBOOT: 1 } as const;

/** POWERED's statuses (agent/src/power.rs `status`). */
export const POWERED = {
  /** The guest took it: its shutdown or reboot is under way (or waits on a delay inhibitor). */
  TAKEN: 0,
  /** The guest refused it (a block inhibitor, a shutdown already under way) or its tool failed. */
  REFUSED: 1,
  /** The guest has no tool for it (neither logind with busctl nor `shutdown`). */
  NO_TOOL: 2,
} as const;

/** The guest's OS as its os-release names it: the pretty name, ID and VERSION_ID. */
export type GuestOs = { name: string; id: string; version: string };

/** OS's payload: the pretty name, ID and VERSION_ID, each a u8 length and its UTF-8; undefined if short. */
export function decodeOs(p: Uint8Array): GuestOs | undefined {
  const f = fields(p);
  const [name, id, version] = [f.str(), f.str(), f.str()];
  return name === undefined || id === undefined || version === undefined ? undefined : { name, id, version };
}

/** DESKTOP's states (agent/src/frame.rs `desktop`). */
export const DESKTOP = {
  /** No graphical session: no compositor connected, no X server set up. */
  NONE: 0,
  /** A Wayland compositor's (the agent's session child connected to it). */
  WAYLAND: 1,
  /** An X server's, with no compositor (an X11 session). */
  X11: 2,
} as const;

/** LEASED's statuses (agent/src/lease.rs `status`). */
export const LEASED = {
  /** The guest's network manager was told to renew. */
  RENEWED: 0,
  /** None the agent knows runs, or its tool isn't there: the page flaps the link instead. */
  NO_CLIENT: 1,
  FAILED: 2,
} as const;

/** TRIMMED's statuses (agent/src/trim.rs `status`). */
export const TRIMMED = {
  /** At least one filesystem trimmed, none failed. */
  TRIMMED: 0,
  /** No filesystem takes a trim (none on a block device, or their disks don't discard). */
  NONE: 1,
  /** A filesystem's trim failed (others may have been trimmed). */
  FAILED: 2,
} as const;

/** COPIED's statuses (agent/src/screen.rs `status`). */
export const COPIED = {
  /** The screen's text follows. */
  OK: 0,
  /** The guest's foreground console shows graphics (a compositor runs on it): no text. */
  GRAPHICS: 1,
  /** The guest has no text console (a kernel without virtual terminals). */
  NO_CONSOLE: 2,
  FAILED: 3,
} as const;

/** COPIED's payload: a u8 status (`COPIED`), then the screen's UTF-8 text. */
export function decodeCopied(p: Uint8Array): { status: number; text: string } | undefined {
  return p.length < 1 ? undefined : { status: p[0], text: new TextDecoder().decode(p.subarray(1)) };
}

/** RENEWED's bits (agent/src/renew.rs `what`). */
export const RENEWED = { ENTROPY: 1, MACHINE_ID: 2, SEED: 4, SSH: 8 } as const;

/** RENEWED's payload: u8 renewed, u8 failed (`RENEWED`'s bits each). */
export function decodeRenewed(p: Uint8Array): { done: number; failed: number } | undefined {
  return p.length < 2 ? undefined : { done: p[0], failed: p[1] };
}

/** TYPED's statuses. */
export const TYPED = {
  /** All of it typed: the agent has nothing left to type. */
  DONE: 0,
  /** The guest's console shows graphics (a compositor runs on it), not text: none of it typed. */
  NOT_TEXT: 1,
  /** The console can't be opened or refused the bytes. */
  REFUSED: 2,
  /** The console's reader stopped taking bytes, or too much was queued: the rest dropped. */
  DROPPED: 3,
} as const;

/** The most bytes in a DATA frame. */
export const CHUNK = 65536;
/** The DATA frames an answer may send before the requester's first MORE: what a REQUEST grants. */
export const CREDIT = 4;
/** OFFER's flag: the rest of the payload is the first type's bytes, whole. */
export const OFFER_INLINE = 1 << 0;
/** DATA's flags: the answer's last frame; the answer failed. */
export const DATA_END = 1 << 0;
export const DATA_FAIL = 1 << 1;
/** A size an offer doesn't know. */
export const UNKNOWN = 0xffffffff;
/** ACK's statuses. */
export const ACK = {
  /** The guest's clipboard holds the offer. */
  HELD: 0,
  /** No session with a clipboard the agent can reach (none active, no display, no data-control). */
  NO_SESSION: 1,
  PAUSED: 2,
  /** Past the size cap. */
  TOO_LARGE: 3,
  /** No type the agent takes. */
  NO_TYPE: 4,
} as const;

/** The largest payload: 64 KiB of data and room for a DATA frame's own fields. */
export const MAX_PAYLOAD = 65536 + 256;
/** The length field's size. */
const LEN = 4;

/** A frame: its type and payload. */
export type Frame = { type: number; payload: Uint8Array };

/**
 * The protocol's version, which HELLO says. A side speaks the lower of the two; a newer version only adds frame types,
 * capabilities and fields at a payload's end, which an older side ignores.
 */
export const VERSION = 1;

/** HELLO's capability bits: what a side can do. Bits a side doesn't know are ignored. */
export const CAP = {
  /** TYPE: text pasted on the guest's foreground text console (the agent), or a page that sends it. */
  TYPE: 1 << 0,
  /** The clipboard's text: OFFER, REQUEST, DATA, ACK, MORE. */
  TEXT: 1 << 1,
  /** Images in the clipboard's frames: `image/png` from the page, the guest programs' image types to it (plan §4.4). */
  IMAGE: 1 << 2,
  /** TIME: the guest's clock set from the host's (the agent), or a page that sends it. */
  TIME: 1 << 4,
  /** DISPLAY: the guest's session follows the page's screen size (the agent), or a page that sends it. */
  DISPLAY: 1 << 5,
  /** RENEW and RENEWED: a template's copy made the guest's own (the agent's; the page sends RENEW to an agent that says it). */
  RENEW: 1 << 6,
  /** LEASE and LEASED: the guest's leases renewed after a restore (the agent's). */
  LEASE: 1 << 7,
  /** DESKTOP: the guest's graphical session's state said (the agent), or a page that takes it. */
  DESKTOP: 1 << 10,
  /** TRIM and TRIMMED: the guest's filesystems trimmed on the page's request (the agent's). */
  TRIM: 1 << 11,
  /** KEYMAP: the running session's layout set (the agent), or a page that sends it. */
  KEYMAP: 1 << 12,
  /** COPY and COPIED: the text console's screen read for the host's clipboard (the agent's). */
  COPY: 1 << 13,
  /** OS: the guest's OS named (the agent), or a page that takes it. */
  OS: 1 << 14,
  /** POWER and POWERED: the guest powers off or reboots itself on the page's request (the agent's). */
  POWER: 1 << 15,
  // Reserved: 1 << 3 text/html, 1 << 8 a Wayland session, 1 << 9 an X11 session (agent/src/frame.rs has the same list).
} as const;

/** An OFFER: its serial, its types (and sizes, `UNKNOWN` where unknown), and the first type's bytes if inline. */
export type Offer = { serial: number; types: { type: string; size: number }[]; inline?: Uint8Array };

/**
 * OFFER's payload: u32 serial, u8 flags (`OFFER_INLINE`), u8 count, then for each type a u8 length, the type (ASCII)
 * and a u32 size; with `OFFER_INLINE`, the rest is the first type's bytes, whole.
 */
export function encodeOffer(o: Offer): Uint8Array {
  const names = o.types.map((t) => new TextEncoder().encode(t.type));
  const head = 6 + names.reduce((n, b) => n + 1 + b.length + 4, 0);
  const out = new Uint8Array(head + (o.inline?.length ?? 0));
  const v = new DataView(out.buffer);
  v.setUint32(0, o.serial >>> 0, true);
  out[4] = o.inline ? OFFER_INLINE : 0;
  out[5] = o.types.length;
  let at = 6;
  names.forEach((b, i) => {
    if (b.length > 255) throw new Error(`an agent offer's type of ${b.length} bytes`);
    out[at] = b.length;
    out.set(b, at + 1);
    v.setUint32(at + 1 + b.length, o.types[i].size >>> 0, true);
    at += 1 + b.length + 4;
  });
  if (o.inline) out.set(o.inline, at);
  return out;
}

/** An OFFER's fields; undefined if the payload is cut short. */
export function decodeOffer(p: Uint8Array): Offer | undefined {
  const r = fields(p);
  const serial = r.u32();
  const flags = r.u8();
  const n = r.u8();
  if (serial === undefined || flags === undefined || n === undefined) return undefined;
  const types: Offer['types'] = [];
  for (let i = 0; i < n; i++) {
    const type = r.str();
    const size = r.u32();
    if (type === undefined || size === undefined) return undefined;
    types.push({ type, size });
  }
  return { serial, types, ...(flags & OFFER_INLINE ? { inline: r.rest() } : {}) };
}

/** A REQUEST: the offer's serial, the requester's id (its answer's DATA and MORE carry it) and the type. */
export type Request = { serial: number; id: number; type: string };

/** REQUEST's payload: u32 serial, u32 id, u8 length, the type. */
export function encodeRequest(r: Request): Uint8Array {
  const t = new TextEncoder().encode(r.type);
  const out = new Uint8Array(9 + t.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, r.serial >>> 0, true);
  v.setUint32(4, r.id >>> 0, true);
  out[8] = t.length;
  out.set(t, 9);
  return out;
}

export function decodeRequest(p: Uint8Array): Request | undefined {
  const r = fields(p);
  const [serial, id, type] = [r.u32(), r.u32(), r.str()];
  return serial === undefined || id === undefined || type === undefined ? undefined : { serial, id, type };
}

/** DATA's payload: u32 id, u8 flags (`DATA_END`, `DATA_FAIL`), then at most `CHUNK` bytes. */
export function encodeData(id: number, flags: number, bytes: Uint8Array = new Uint8Array(0)): Uint8Array {
  const out = new Uint8Array(5 + bytes.length);
  new DataView(out.buffer).setUint32(0, id >>> 0, true);
  out[4] = flags;
  out.set(bytes, 5);
  return out;
}

export function decodeData(p: Uint8Array): { id: number; flags: number; bytes: Uint8Array } | undefined {
  if (p.length < 5) return undefined;
  return {
    id: new DataView(p.buffer, p.byteOffset, p.byteLength).getUint32(0, true),
    flags: p[4],
    bytes: p.subarray(5),
  };
}

/** ACK's payload: u32 serial (the page's offer), u8 status (`ACK`). */
export function decodeAck(p: Uint8Array): { serial: number; status: number } | undefined {
  if (p.length < 5) return undefined;
  return { serial: new DataView(p.buffer, p.byteOffset, p.byteLength).getUint32(0, true), status: p[4] };
}

export function encodeAck(serial: number, status: number): Uint8Array {
  const out = new Uint8Array(5);
  new DataView(out.buffer).setUint32(0, serial >>> 0, true);
  out[4] = status;
  return out;
}

/** MORE's payload: u32 id (the requester's), u32 count. */
export function encodeMore(id: number, n: number): Uint8Array {
  const out = new Uint8Array(8);
  const v = new DataView(out.buffer);
  v.setUint32(0, id >>> 0, true);
  v.setUint32(4, n >>> 0, true);
  return out;
}

export function decodeMore(p: Uint8Array): { id: number; n: number } | undefined {
  if (p.length < 8) return undefined;
  const v = new DataView(p.buffer, p.byteOffset, p.byteLength);
  return { id: v.getUint32(0, true), n: v.getUint32(4, true) };
}

/** A payload read field by field (little-endian); undefined past its end. */
function fields(p: Uint8Array) {
  const v = new DataView(p.buffer, p.byteOffset, p.byteLength);
  let at = 0;
  const has = (n: number) => at + n <= p.length;
  return {
    u8: () => (has(1) ? p[at++] : undefined),
    u32: () => (has(4) ? ((at += 4), v.getUint32(at - 4, true)) : undefined),
    str: () => {
      if (!has(1)) return undefined;
      const n = p[at];
      if (!has(1 + n)) return undefined;
      at += 1 + n;
      return new TextDecoder().decode(p.subarray(at - n, at));
    },
    rest: () => p.slice(at),
  };
}

/** A HELLO: the sender's version and capabilities. */
export type Hello = { version: number; caps: number };

/** HELLO's payload: u16 version, u32 capabilities (little-endian); later versions append fields. */
export function encodeHello(h: Hello): Uint8Array {
  const b = new Uint8Array(6);
  const v = new DataView(b.buffer);
  v.setUint16(0, h.version, true);
  v.setUint32(2, h.caps >>> 0, true);
  return b;
}

/** A HELLO's fields; undefined if the payload is too short to be one. */
export function decodeHello(p: Uint8Array): Hello | undefined {
  if (p.length < 6) return undefined;
  const v = new DataView(p.buffer, p.byteOffset, p.byteLength);
  return { version: v.getUint16(0, true), caps: v.getUint32(2, true) };
}

/** TIME's payload: u64 nanoseconds since the Unix epoch (`ms`, the host's wall clock, `Date.now()`'s scale). */
export function encodeTime(ms: number): Uint8Array {
  const b = new Uint8Array(8);
  // Whole milliseconds and the rest apart: their product as a double would lose the nanoseconds.
  const whole = Math.floor(Math.max(0, ms));
  const ns = BigInt(whole) * 1_000_000n + BigInt(Math.round((Math.max(0, ms) - whole) * 1e6));
  new DataView(b.buffer).setBigUint64(0, ns, true);
  return b;
}

/** DISPLAY's payload: u32 width, u32 height (the guest's pixels, as the display's size says them). */
/** KEYMAP's payload (agent/src/keymap.rs `Keymap`): XKB's layout, model and variant, the console's keymap, each a u8 length and its bytes. */
export function encodeKeymap(k: { layout: string; model?: string; variant?: string; vc: string }): Uint8Array {
  const parts = [k.layout, k.model ?? 'pc105', k.variant ?? '', k.vc].map((s) => new TextEncoder().encode(s));
  const out = new Uint8Array(parts.reduce((n, p) => n + 1 + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out[at] = p.length;
    out.set(p, at + 1);
    at += 1 + p.length;
  }
  return out;
}

export function encodeDisplay(width: number, height: number): Uint8Array {
  const b = new Uint8Array(8);
  const v = new DataView(b.buffer);
  v.setUint32(0, width >>> 0, true);
  v.setUint32(4, height >>> 0, true);
  return b;
}

/** The most text in one TYPE frame, in UTF-8 bytes. */
export const TYPE_CHUNK = 65536;

/**
 * TYPE's payloads for `text`: its UTF-8, in frames of at most `max` bytes cut between characters (never inside one,
 * nor between a CR and its LF), so that each is UTF-8 on its own and the agent's line ends come out the same.
 */
export function typePayloads(text: string, max = TYPE_CHUNK): Uint8Array[] {
  if (max < 4) throw new RangeError(`TYPE frames of ${max} bytes (a character takes up to 4)`);
  const all = new TextEncoder().encode(text);
  const out: Uint8Array[] = [];
  let at = 0;
  while (at < all.length) {
    let end = Math.min(all.length, at + max);
    if (end < all.length) {
      while (end > at && (all[end] & 0xc0) === 0x80) end--; // a continuation byte: back to its character's start
      if (end > at + 1 && all[end - 1] === 0x0d && all[end] === 0x0a) end--;
    }
    out.push(all.subarray(at, end));
    at = end;
  }
  return out;
}

/** The bytes of a frame. Throws past `MAX_PAYLOAD` (a sender's bug: data goes in frames of 64 KiB). */
export function encodeFrame(type: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  if (payload.length > MAX_PAYLOAD)
    throw new Error(`an agent frame of ${payload.length} bytes (at most ${MAX_PAYLOAD})`);
  if (!Number.isInteger(type) || type < 0 || type > 255) throw new Error(`an agent frame of type ${type}`);
  const out = new Uint8Array(LEN + 1 + payload.length);
  new DataView(out.buffer).setUint32(0, 1 + payload.length, true);
  out[LEN] = type;
  out.set(payload, LEN + 1);
  return out;
}

/**
 * Cuts a byte stream into frames, whatever pieces it arrives in. A length that can't be a frame's (zero, or past
 * `MAX_PAYLOAD`) means the stream is out of step: the reader is `broken` and drops everything until `reset`, which
 * the link does with each new connection (it resets one out of step: the agent connects again).
 */
export class FrameReader {
  private buf = new Uint8Array(0);
  broken = false;

  /** The frames `bytes` completes. */
  push(bytes: Uint8Array): Frame[] {
    if (this.broken) return [];
    const all = this.buf.length ? concat(this.buf, bytes) : bytes;
    const out: Frame[] = [];
    let at = 0;
    while (all.length - at >= LEN) {
      const len = new DataView(all.buffer, all.byteOffset + at, LEN).getUint32(0, true);
      if (len < 1 || len > MAX_PAYLOAD + 1) {
        this.broken = true;
        this.buf = new Uint8Array(0);
        return out;
      }
      if (all.length - at < LEN + len) break;
      out.push({ type: all[at + LEN], payload: all.slice(at + LEN + 1, at + LEN + len) });
      at += LEN + len;
    }
    this.buf = all.slice(at);
    return out;
  }

  /** Bytes of a frame not yet complete. */
  get pending() {
    return this.buf.length;
  }

  reset() {
    this.buf = new Uint8Array(0);
    this.broken = false;
  }
}

function concat(a: Uint8Array, b: Uint8Array) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
