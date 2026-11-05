// The agent's framing (docs/plans/clipboard.md §2): what the page and the guest's agent (webpc-agent) say to each other
// over the agent's port (web/agent-device.ts), as frames: a u32 length (little-endian, the bytes after it: the type
// and the payload), a u8 type, then the payload. The types' payloads are defined with the parts that use them; this
// module only cuts the byte stream into frames, both ways, and is the page's half of the format the agent's own code
// (Rust) speaks.

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
