// Clipboard sharing's host side (docs/plans/clipboard.md §4): the browser's clipboard and the guest's, over the agent's
// link (web/app/agent-link.ts, frames of web/agent-frame.ts):
// - **Guest to host** (§4.2): the guest's OFFER (its text inline, or requested in DATA frames as the page's MOREs
//   allow) is written with `writeText` while the document has focus; otherwise (or refused) it is kept as `pending`,
//   only the newest, and written on the next focus where the read permission shows the host's clipboard unchanged
//   since the page last knew it (`focused`), or on the next key or pointer down on the screen (`activated`: the
//   activation Firefox and Safari want). The host's newer copy wins: a focus read that finds it changed drops it, and
//   so does a paste chord (the host's copy goes to the guest instead).
// - **Sync on focus** (§4.1, way 1): while the browser's `clipboard-read` permission is `granted`, each focus of the
//   page reads the host's clipboard and offers it to the guest if it changed (where `clipboardchange` exists, only after
//   one); never while it is `prompt` (the reads that ask are the user's clicks: `askRead`, `send`, `typeIt`).
// - **The paste chord** (§4.1, way 2): web/input.ts holds the key (`chord`) and lets the browser's `paste` event come;
//   its text (`pasted`) is offered to the guest unless the guest has it already, and the key goes on once the agent
//   says the guest's clipboard has it (ACK) or `ACK_WAIT` passed.
// - **Placeholders** (§4.3): an empty read is never offered and leaves the hashes alone; `read()`'s types tell a
//   hidden text (types say text, the text is empty: counted, and `EMPTY_RUN` in a row stop the focus reads for the
//   run, `stopped`) from no text (an image, nothing). Refusals are silent.
// - **Echo suppression** (§2): a hash of the last text each way; the same text isn't offered back.
// Sharing stops while paused (the toolbar's switch, §5: `pause`): nothing is read, offered, written or answered.

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
  pause(): void;
  resume(): void;
  /** TYPE: the text pasted on the guest's console (false: not sent). */
  type?(text: string): boolean;
  onFrame?: (f: Frame) => void;
  onOpen?: (open: boolean) => void;
};

/** How many focus reads in a row may come back empty while their types say there is text before they stop (§4.3). */
export const EMPTY_RUN = 3;

/** A clipboard item as `read()` gives it: its types (`getType` isn't needed to tell them apart). */
export type HostItem = { types: readonly string[] };

/**
 * What the clipboard needs of the browser: its clipboard (`readText` and `read` where it has them) and whether the
 * document has focus.
 */
export type Host = {
  clipboard: { writeText(text: string): Promise<void>; readText?(): Promise<string>; read?(): Promise<readonly HostItem[]> };
  hasFocus: () => boolean;
  /** The browser fires `clipboardchange` (the page then reads on it, not on every focus). */
  changeEvents?: boolean;
};

/**
 * Chromium's `clipboard-read` permission as the page knows it; `none` where the browser has no such permission (Firefox,
 * Safari: a read wants a click and shows their Paste button) or there is no clipboard (not a secure context).
 */
export type ReadPermission = 'granted' | 'prompt' | 'denied' | 'none';

/** What the toolbar's button shows (plan §5): sharing, paused for the run, or waiting for the guest's program (before its HELLO, or since its port closed). */
export type ShareState = 'sharing' | 'paused' | 'waiting';

/**
 * The read permission, followed: `onChange` with each state, the first at once (`none` if the browser can't say).
 * Resolves with the first.
 */
export async function watchReadPermission(permissions: Pick<Permissions, 'query'> | undefined, hasClipboard: boolean, onChange: (s: ReadPermission) => void): Promise<ReadPermission> {
  let status: PermissionStatus | undefined;
  try {
    // Firefox and Safari throw: `clipboard-read` isn't a permission name there.
    status = hasClipboard ? await permissions?.query({ name: 'clipboard-read' as PermissionName }) : undefined;
  } catch {
    status = undefined;
  }
  const state = (): ReadPermission => (status ? status.state : 'none');
  status?.addEventListener('change', () => onChange(state()));
  onChange(state());
  return state();
}

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
  /** Called when what the toolbar shows changes: `state`, `permission`, `stopped`, `canType`. */
  onChange?: () => void;
  /** The browser's read permission (`setPermission`). */
  permission: ReadPermission = 'none';
  /** Focus reads stopped for the run: they came back empty `EMPTY_RUN` times in a row while their types said text (§4.3). */
  stopped = false;
  private link: ClipLink;
  private host: Host;
  private serial = 0;
  private id = 0;
  /** The hashes of the last text from the guest, and of the last offered to it. */
  private fromGuest?: number;
  private toGuest?: number;
  /** The hash of the host's clipboard as the page last knew it (read, pasted, or written by the page); undefined: never. */
  private hostHash?: number;
  /** Empty reads in a row whose types said text. */
  private empties = 0;
  /** A focus read in flight. */
  private reading = false;
  /** `clipboardchange` fired since the last read (true at first: the clipboard is unknown). */
  private changed = true;
  /** The page's offer whose ACK is awaited: its text's hash, and when the wait ends. */
  private offering?: { hash: number; done: Promise<void> };
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
      this.onChange?.();
    };
  }

  /** Sharing works now: the agent is there and said it shares text, and the toolbar's switch isn't off. */
  get active() {
    return this.link.open && !this.link.paused && !!this.link.agent && (this.link.agent.caps & CAP.TEXT) !== 0;
  }

  /** What the toolbar's button shows. */
  get state(): ShareState {
    return this.link.paused ? 'paused' : this.link.open && this.link.agent ? 'sharing' : 'waiting';
  }

  /** The agent pastes on the console (TYPE) and sharing isn't paused: "Type the clipboard". */
  get canType() {
    return !this.link.paused && this.link.open && !!this.link.agent && (this.link.agent.caps & CAP.TYPE) !== 0;
  }

  /** The browser's read permission changed: becoming `granted` (the user allowed it just now) syncs at once. */
  setPermission(p: ReadPermission) {
    if (p === this.permission) return;
    this.permission = p;
    this.onChange?.();
    if (p === 'granted') void this.focused();
  }

  /** The toolbar's switch (plan §5), for the run: everything stops at once, both ways, and the agent hears PAUSE. */
  pause() {
    this.link.pause();
    this.pending = undefined;
    this.holding?.();
    // The agent drops the host's text from the guest's clipboard: what either side had is no longer known.
    this.fromGuest = this.toGuest = undefined;
    this.reset();
    this.onChange?.();
  }

  /** Sharing again: nothing is sent on its own (the next copy or paste is). */
  resume() {
    this.link.resume();
    this.onChange?.();
  }

  /**
   * The page has focus (`focus`, or `visibilitychange` to visible): with the read permission, the host's clipboard is
   * read, and offered to the guest if it changed since the page last knew it; if it didn't, the guest's pending text is
   * written. Where `clipboardchange` exists, the read waits for one. Without the permission, nothing.
   */
  async focused(): Promise<void> {
    if (!this.active || this.permission !== 'granted' || this.stopped || this.reading || !this.host.hasFocus()) return;
    if (this.host.changeEvents && !this.changed) {
      if (this.pending !== undefined) this.writePending();
      return;
    }
    this.reading = true;
    try {
      this.changed = false;
      const text = await this.readHost();
      if (text === undefined || !this.active) return;
      const h = textHash(text);
      if (h !== this.hostHash) {
        // The host's own copy, newer than the guest's pending one.
        this.pending = undefined;
        void this.paste(text);
      } else if (this.pending !== undefined) {
        this.writePending();
      }
    } finally {
      this.reading = false;
    }
  }

  /** `clipboardchange`: the host's clipboard changed; read now if the page has focus. */
  clipboardChanged() {
    this.changed = true;
    void this.focused();
  }

  /**
   * A key or pointer down on the screen (activation, which Firefox and Safari want for a write): the guest's pending
   * text is written. A paste chord instead drops it: the host's copy goes to the guest, the newer.
   */
  activated(pasteChord: boolean) {
    if (!this.active || this.pending === undefined) return;
    if (pasteChord) this.pending = undefined;
    else this.writePending();
  }

  /**
   * "Send the clipboard to the guest" (the toolbar's menu, from its click: the activation and the prompt a read may
   * want): the host's text offered even if the guest seems to have it. False if there was none to send.
   */
  async send(): Promise<boolean> {
    const text = await this.readClick();
    if (!text || !this.active) return false;
    void this.paste(text, true);
    return true;
  }

  /** "Type the clipboard": the host's text pasted on the guest's console (TYPE). False if there was none, or no agent that types. */
  async typeIt(): Promise<boolean> {
    const text = await this.readClick();
    return !!text && this.canType && this.link.type?.(text) === true;
  }

  /** The host's text from a click's read; undefined if the browser gave none (refused, nothing, a dismissed Paste button). */
  private async readClick(): Promise<string | undefined> {
    try {
      return (await this.host.clipboard.readText?.()) || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * The host's text for a focus read: undefined if there's nothing to sync (refused, empty, no text). An empty
   * `readText` asks `read()` for the types: text among them is a hidden read (§4.3), counted.
   */
  private async readHost(): Promise<string | undefined> {
    try {
      const text = await this.host.clipboard.readText?.();
      if (text) {
        this.empties = 0;
        return text;
      }
      const items = await this.host.clipboard.read?.().catch(() => undefined);
      // Text among the types, yet none read: hidden. No types, or others (an image): nothing to sync, a run broken.
      if (!items?.some((i) => i.types.some(isText))) this.empties = 0;
      else if (++this.empties >= EMPTY_RUN) {
        this.stopped = true;
        this.onChange?.();
      }
    } catch {
      // A refusal (NotAllowedError, DataError) is never an error mid-work.
    }
    return undefined;
  }

  /** Writes the guest's pending text to the host's clipboard (kept pending if refused). */
  private writePending() {
    const text = this.pending!;
    this.pending = undefined;
    this.write(text);
  }

  private write(text: string) {
    this.host.clipboard.writeText(text).then(() => {
      this.hostHash = textHash(text);
      this.onWritten?.(text);
    }, () => {
      // Refused (no focus, no activation): the newest stays pending, unless a newer came meanwhile.
      if (this.pending === undefined && this.fromGuest === textHash(text)) this.pending = text;
    });
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
   * Offers the host's `text` to the guest unless it has it already (the last text either way; `force`: offered anyway)
   * or it is empty; resolves once the agent's ACK came, or `ACK_WAIT` passed (or at once: nothing offered).
   */
  async paste(text: string, force = false): Promise<void> {
    if (!this.active || text === '') return;
    const h = textHash(text);
    this.hostHash = h;
    // Offered already: a paste chord waits for that offer's ACK still (a sync's, a moment before the chord).
    if (!force && h === this.toGuest && this.offering?.hash === h) return this.offering.done;
    if (!force && (h === this.fromGuest || h === this.toGuest)) return;
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
    const done = status.then(() => {});
    this.offering = { hash: h, done };
    this.link.send(FRAME.OFFER, encodeOffer({ serial, types: [{ type: TEXT, size: bytes.length }], inline: bytes.length <= INLINE ? bytes : undefined }));
    const s = await status;
    if (this.offering?.done === done) this.offering = undefined;
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
      case FRAME.HELLO:
        // The agent is there: the toolbar says so, and the host's clipboard goes to the guest if the page may read it.
        this.onChange?.();
        void this.focused();
        return;
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

  /** The guest's text: to the host's clipboard while the document has focus, else kept for later (the newest only). */
  private received(text: string) {
    if (text === '') return;
    this.fromGuest = textHash(text);
    this.toGuest = undefined;
    this.pending = text;
    if (this.host.hasFocus()) this.writePending();
  }
}
