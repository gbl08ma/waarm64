// Clipboard sharing's host side (docs/plans/clipboard.md §4): the browser's clipboard and the guest's, over the agent's
// link (web/app/agent-link.ts, frames of web/agent-frame.ts). Step 3 has what the Wayland test needs:
// - **Guest to host** (§4.2): the guest's OFFER (its text inline, or requested in DATA frames as the page's MOREs
//   allow) is written with `writeText` while the document has focus; without focus it is kept as `pending` (step 4
//   writes it).
// - **The paste chord** (§4.1, way 2): web/input.ts holds the key (`chord`) and lets the browser's `paste` event come;
//   its text (`pasted`) is offered to the guest unless the guest has it already, and the key goes on once the agent
//   says the guest's clipboard has it (ACK) or `ACK_WAIT` passed.
// - **Echo suppression** (§2): a hash of the last text each way; the same text isn't offered back.
// Sharing stops while the link is paused (§3.2): nothing is offered, written or answered.
// Step 4 adds sync on focus, the permission's asking, the toolbar button and the placeholder rules.

import { ACK, CHUNK, CREDIT, DATA_END, DATA_FAIL, decodeAck, decodeData, decodeMore, decodeOffer, decodeRequest, encodeData, encodeMore, encodeOffer, encodeRequest, FRAME, CAP, UNKNOWN, type Frame, type Hello } from '../agent-frame.ts';

/** The type text crosses as. */
export const TEXT = 'text/plain;charset=utf-8';
/** The most text that crosses (plan §3.2), checked against an offer's size before any bytes do. */
export const TEXT_CAP = 16 << 20;
/** Text up to this size goes inline in its OFFER (plan §2). */
export const INLINE = 4096;
/** How long the paste chord's key waits for the agent's ACK (plan §4.1). */
export const ACK_WAIT = 300;
/** How long a held paste chord waits for the browser's `paste` event (a browser may not fire one). */
export const PASTE_WAIT = 300;

/** The link as the clipboard uses it (`AgentLink`). */
export type ClipLink = {
  open: boolean;
  paused: boolean;
  agent?: Hello;
  send(type: number, payload?: Uint8Array): boolean;
  onFrame?: (f: Frame) => void;
  onOpen?: (open: boolean) => void;
};

/** What the clipboard needs of the browser: its clipboard and whether the document has focus. */
export type Host = { clipboard: { writeText(text: string): Promise<void> }; hasFocus: () => boolean };

/** Whether a key event is a paste chord: Ctrl+V, Ctrl+Shift+V, Shift+Insert, Cmd+V (by the key, as the browser's shortcut is). */
export function isPasteChord(e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>): boolean {
  if (e.altKey) return false;
  if (e.key === 'v' || e.key === 'V') return e.ctrlKey !== e.metaKey;
  return e.code === 'Insert' && e.shiftKey && !e.ctrlKey && !e.metaKey;
}

/** A 53-bit hash of a string (cyrb53): what the page remembers of the last text each way. */
export function textHash(s: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

const isText = (t: string) => t === TEXT || t === 'text/plain';

/** The page's clipboard sharing for one machine's link. */
export class ClipboardShare {
  /** The guest's newest text not written to the host's clipboard (the document had no focus, or the write was refused). */
  pending?: string;
  /** Called with each text from the guest written to the host's clipboard (the tests' hook). */
  onWritten?: (text: string) => void;
  private link: ClipLink;
  private host: Host;
  private serial = 0;
  private id = 0;
  /** The hashes of the last text from the guest, and of the last offered to it. */
  private fromGuest?: number;
  private toGuest?: number;
  /** The page's offer to the guest: its bytes, for the agent's requests. */
  private offered?: { serial: number; bytes: Uint8Array };
  /** The page's requests for the guest's offer's bytes. */
  private requests = new Map<number, { chunks: Uint8Array[]; len: number }>();
  /** The agent's requests for the page's offer's bytes. */
  private answers = new Map<number, { bytes: Uint8Array; at: number; credit: number }>();
  private acks = new Map<number, (status: number) => void>();
  /** The held paste chord's wait for the browser's paste event. */
  private holding?: () => void;

  constructor(link: ClipLink, host: Host) {
    [this.link, this.host] = [link, host];
    const onFrame = link.onFrame;
    link.onFrame = (f) => {
      onFrame?.(f);
      this.frame(f);
    };
    const onOpen = link.onOpen;
    link.onOpen = (open) => {
      onOpen?.(open);
      this.reset();
    };
  }

  /** Sharing works now: the agent is there and said it shares text, and the toolbar's switch isn't off. */
  get active() {
    return this.link.open && !this.link.paused && !!this.link.agent && (this.link.agent.caps & CAP.TEXT) !== 0;
  }

  /**
   * A key down on the screen: a paste chord while sharing is active is held (web/input.ts sends it once the returned
   * promise settles: after the browser's `paste` event and the agent's ACK, or `PASTE_WAIT`); anything else, undefined.
   */
  chord(e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>): Promise<void> | undefined {
    if (!this.active || !isPasteChord(e)) return undefined;
    this.holding?.();
    let release = () => {};
    const event = new Promise<void>((resolve) => (release = resolve));
    const done = () => {
      clearTimeout(timer);
      if (this.holding === done) this.holding = undefined;
      release();
    };
    const timer = setTimeout(done, PASTE_WAIT);
    this.holding = done;
    // `waiting` is read once the event came (or didn't): `pasted` sets it first.
    return event.then(() => this.waiting);
  }

  /** Whether a paste chord waits for the browser's paste event. */
  get held() {
    return !!this.holding;
  }

  private waiting: Promise<void> = Promise.resolve();

  /** The browser's `paste` event's text, while a paste chord is held: offered, and the chord let go after. */
  pasted(text: string) {
    const release = this.holding;
    if (!release) return;
    this.waiting = this.paste(text);
    release();
  }

  /**
   * Offers `text` to the guest unless it has it already (the last text either way) or it is empty; resolves with the
   * agent's ACK status, or undefined (nothing offered, or no ACK within `ACK_WAIT`).
   */
  async paste(text: string): Promise<void> {
    if (!this.active || text === '') return;
    const h = textHash(text);
    if (h === this.fromGuest || h === this.toGuest) return;
    const bytes = new TextEncoder().encode(text);
    if (bytes.length > TEXT_CAP) return;
    const serial = this.serial = (this.serial + 1) >>> 0;
    // Requests for an older offer carry on (a guest program is reading it): their answers hold their own bytes.
    this.offered = { serial, bytes };
    this.toGuest = h;
    const status = new Promise<number | undefined>((resolve) => {
      const timer = setTimeout(() => {
        this.acks.delete(serial);
        resolve(undefined);
      }, ACK_WAIT);
      this.acks.set(serial, (s) => {
        clearTimeout(timer);
        resolve(s);
      });
    });
    this.link.send(FRAME.OFFER, encodeOffer({ serial, types: [{ type: TEXT, size: bytes.length }], inline: bytes.length <= INLINE ? bytes : undefined }));
    const s = await status;
    // The guest didn't take it: the next paste offers it again.
    if (s !== undefined && s !== ACK.HELD && this.toGuest === h) this.toGuest = undefined;
  }

  private reset() {
    this.offered = undefined;
    this.requests.clear();
    this.answers.clear();
    for (const a of this.acks.values()) a(ACK.NO_SESSION);
    this.acks.clear();
  }

  private frame(f: Frame) {
    switch (f.type) {
      case FRAME.OFFER: {
        const o = decodeOffer(f.payload);
        if (!o || !this.active) return;
        const t = o.types.find((x) => isText(x.type));
        if (!t || (t.size !== UNKNOWN && t.size > TEXT_CAP)) return;
        // The newest offer wins: requests for older ones stop.
        for (const id of this.requests.keys()) this.link.send(FRAME.MORE, encodeMore(id, 0));
        this.requests.clear();
        if (o.inline && o.types[0] === t) return this.received(new TextDecoder().decode(o.inline));
        const id = this.id = (this.id + 1) >>> 0;
        this.requests.set(id, { chunks: [], len: 0 });
        this.link.send(FRAME.REQUEST, encodeRequest({ serial: o.serial, id, type: t.type }));
        return;
      }
      case FRAME.DATA: {
        const d = decodeData(f.payload);
        const r = d && this.requests.get(d.id);
        if (!d || !r) return;
        if (d.flags & DATA_FAIL || !this.active) return void this.requests.delete(d.id);
        r.len += d.bytes.length;
        if (r.len > TEXT_CAP) {
          this.requests.delete(d.id);
          this.link.send(FRAME.MORE, encodeMore(d.id, 0));
          return;
        }
        r.chunks.push(d.bytes);
        if (!(d.flags & DATA_END)) return void this.link.send(FRAME.MORE, encodeMore(d.id, 1));
        this.requests.delete(d.id);
        const all = new Uint8Array(r.len);
        let at = 0;
        for (const c of r.chunks) {
          all.set(c, at);
          at += c.length;
        }
        return this.received(new TextDecoder().decode(all));
      }
      case FRAME.REQUEST: {
        const r = decodeRequest(f.payload);
        if (!r) return;
        if (!this.active || this.offered?.serial !== r.serial || !isText(r.type)) return void this.link.send(FRAME.DATA, encodeData(r.id, DATA_FAIL));
        this.answers.set(r.id, { bytes: this.offered.bytes, at: 0, credit: CREDIT });
        return this.answer(r.id);
      }
      case FRAME.MORE: {
        const m = decodeMore(f.payload);
        const a = m && this.answers.get(m.id);
        if (!m || !a) return;
        if (m.n === 0) return void this.answers.delete(m.id);
        a.credit += m.n;
        return this.answer(m.id);
      }
      case FRAME.ACK: {
        const a = decodeAck(f.payload);
        if (a) this.acks.get(a.serial)?.(a.status);
        if (a) this.acks.delete(a.serial);
        return;
      }
    }
  }

  /** Sends what the agent's request `id` may take of the page's offer. */
  private answer(id: number) {
    const a = this.answers.get(id);
    if (!a) return;
    if (!this.active) return void this.answers.delete(id);
    while (a.credit > 0) {
      const chunk = a.bytes.subarray(a.at, a.at + CHUNK);
      a.at += chunk.length;
      a.credit--;
      const end = a.at >= a.bytes.length;
      this.link.send(FRAME.DATA, encodeData(id, end ? DATA_END : 0, chunk));
      if (end) return void this.answers.delete(id);
    }
  }

  /** The guest's text: to the host's clipboard while the document has focus, else kept for later. */
  private received(text: string) {
    if (text === '') return;
    this.fromGuest = textHash(text);
    this.toGuest = undefined;
    if (!this.host.hasFocus()) {
      this.pending = text;
      return;
    }
    this.pending = undefined;
    this.host.clipboard.writeText(text).then(() => this.onWritten?.(text), () => { this.pending = text; });
  }
}
