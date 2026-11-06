// The agent's framing (docs/plans/clipboard.md §2): what the page and the guest's agent (webpc-agent) say to each other
// over the agent's port (web/agent-device.ts), as frames: a u32 length (little-endian, the bytes after it: the type
// and the payload), a u8 type, then the payload. This module cuts the byte stream into frames, both ways, and defines
// the payloads: the page's half of the format the agent's own code speaks (agent/src/frame.rs, its Rust twin, which
// pins the same bytes in its tests). HELLO, TYPE, PAUSE and RESUME are defined (step 2); OFFER, REQUEST and DATA come
// with the clipboard itself (step 3), as a new capability.

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
  // Reserved for the next steps: 1 << 1 the clipboard's text (OFFER, REQUEST, DATA), 1 << 2 images, 1 << 3 text/html,
  // 1 << 8 a Wayland session, 1 << 9 an X11 session (agent/src/frame.rs has the same list).
} as const;

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
  if (payload.length > MAX_PAYLOAD) throw new Error(`an agent frame of ${payload.length} bytes (at most ${MAX_PAYLOAD})`);
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
 * the link does when the port closes (the agent starts its stream again when it opens it).
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
