// Clipboard sharing's host side (docs/plans/clipboard.md §4): the browser's clipboard and the guest's, over the agent's
// link (web/app/agent-link.ts, frames of web/agent-frame.ts):
// - **Guest to host** (§4.2): the guest's OFFER of text (inline, or requested in DATA frames as the page's MOREs allow)
//   is written with `writeText` while the document has focus; one with an image (§4.4) is written as one
//   `ClipboardItem` whose values are promises, the bytes requested from the guest at the write, the image converted to
//   PNG in a worker if it isn't one (`Host.toPng`), its text in the same item; one with HTML (`text/html`, plan §3.2)
//   the same way, its text and HTML (and image) in one item. Otherwise (or refused) it is kept as `pending`
//   (`pendingItem`), only the newest, and written on the next focus where the read permission shows the
//   host's clipboard unchanged since the page last knew it (`focused`), or on the next key or pointer down on the
//   screen (`activated`: the activation Firefox and Safari want). The host's newer copy wins: a focus read that finds
//   it changed drops it, and so does a paste chord (the host's copy goes to the guest instead).
// - **Sync on focus** (§4.1, way 1): while the browser's `clipboard-read` permission is `granted`, each focus of the
//   page reads the host's clipboard and offers it to the guest if it changed (where `clipboardchange` exists, only after
//   one); never while it is `prompt` (the reads that ask are the user's clicks: `askRead`, `send`, `typeIt`). Its text
//   is `readText`'s; `read()` is asked too after an empty `readText` or a `clipboardchange` (so an image on the
//   clipboard isn't re-encoded at every focus), for the types (§4.3), the image (a PNG offered with the text) and the
//   HTML (offered beside the text or the image, as Chromium sanitised it: §4.3; never alone, and not in the hashes).
// - **The paste chord** (§4.1, way 2): web/input.ts holds the key (`chord`) and lets the browser's `paste` event come;
//   its text and image (`pasted`) are offered to the guest unless the guest has them already, and the key goes on once
//   the agent says the guest's clipboard has them (ACK) or `ACK_WAIT` passed.
// - **Placeholders** (§4.3): an empty read is never offered and leaves the hashes alone; `read()`'s types tell a
//   hidden text (types say text, the text is empty: counted, and `EMPTY_RUN` in a row stop the focus reads for the
//   run, `stopped`) from no text (an image, nothing). Refusals are silent.
// - **Echo suppression** (§2, §4.4): a hash of the last content each way (text, image or both: `contentHash`), which
//   stands for "the guest's clipboard has it still": the same isn't offered back. The browser re-encodes an image it
//   writes, so after writing the guest's image the page reads the clipboard back once (with the permission and focus)
//   and that hash is the guest's. Each is forgotten when the clipboard moves on the other way (an offer to the guest
//   forgets the guest's, the guest's copy the page's), when the agent refuses an offer (even after `ACK_WAIT`), when
//   the port opens or closes, at the agent's HELLO and at its SESSION (the guest's clipboard changed hands: a session
//   child, or its compositor, came or went), which also end the transfers in progress.
// Sharing stops while paused (the toolbar's switch, §5: `pause`): nothing is read, offered, written or answered. The
// page holds at most one image from each side (§4.4): the newest it offered, and a guest's while it is written.

import { ACK, CHUNK, CREDIT, DATA_END, DATA_FAIL, decodeAck, decodeData, decodeMore, decodeOffer, decodeRequest, encodeData, encodeMore, encodeOffer, encodeRequest, FRAME, CAP, UNKNOWN, type Frame, type Hello } from '../agent-frame.ts';

/** The type text crosses as. */
export const TEXT = 'text/plain;charset=utf-8';
/** The page's one image type, both ways (plan §4.4). */
export const PNG = 'image/png';
/** HTML, both ways beside the text (plan §3.2), within `TEXT_CAP`. */
export const HTML = 'text/html';
/** The most text that crosses (plan §3.2), checked against an offer's size before any bytes do. */
export const TEXT_CAP = 16 << 20;
/** The most image bytes that cross (plan §4.4), checked as `TEXT_CAP` is. */
export const IMAGE_CAP = 64 << 20;
/** Text up to this size goes inline in its OFFER (plan §2). */
export const INLINE = 4096;
/** How long the paste chord's key waits for the agent's ACK (plan §4.1). */
export const ACK_WAIT = 300;
/** How long a held paste chord waits for the browser's `paste` event (a browser may not fire one). */
export const PASTE_WAIT = 300;
/**
 * How long the page's request for the guest's bytes waits for each DATA before it stops (MORE 0): a guest program
 * that never serves its type (frozen, or an X11 owner that never answers) would otherwise hold the `ClipboardItem`
 * write waiting on it, and the focus syncs behind that write, for good. Long enough for a guest program to encode a
 * large image under the emulator.
 */
export const REQUEST_WAIT = 30_000;

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

/** A clipboard item as `read()` gives it: its types, and its data by type where the browser gives it. */
export type HostItem = { types: readonly string[]; getType?(type: string): Promise<Blob> };

/**
 * What the clipboard needs of the browser: its clipboard (`readText`, `read` and `write` where it has them) and
 * whether the document has focus.
 */
export type Host = {
  clipboard: {
    writeText(text: string): Promise<void>;
    readText?(): Promise<string>;
    read?(): Promise<readonly HostItem[]>;
    /** One `ClipboardItem` of these types, whose promises the browser awaits at the write (`write([new ClipboardItem(…)])`). */
    write?(item: Record<string, Promise<Blob>>): Promise<void>;
  };
  hasFocus: () => boolean;
  /** The browser fires `clipboardchange` (the page then reads on it, not on every focus). */
  changeEvents?: boolean;
  /** The browser runs on a Mac: its paste chord is Cmd+V (`isPasteChord`). */
  mac?: boolean;
  /** An image (a JPEG, a BMP, …) as a PNG, converted in a worker (web/app/png.ts `toPng`). */
  toPng?(image: Blob): Promise<Blob>;
};

/** What a side's clipboard holds as the page passes it: text, an image (a PNG), or both; HTML beside either. */
export type Content = { text?: string; image?: Blob; html?: string };

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

/**
 * Whether a key event is the browser's paste chord on this host (by the key, as the browser's shortcut is): Ctrl+V,
 * Ctrl+Shift+V and Shift+Insert; on a Mac (`mac`), Cmd+V and Cmd+Shift+V only (Ctrl+V is the guest's own key there,
 * and no paste event would come for it).
 */
export function isPasteChord(e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>, mac = false): boolean {
  if (e.altKey) return false;
  if (e.key === 'v' || e.key === 'V') return mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  return !mac && e.code === 'Insert' && e.shiftKey && !e.ctrlKey && !e.metaKey;
}

/** Whether the browser runs on a Mac (its paste chord is Cmd+V): its client hints' platform, else `navigator.platform`. */
export function onMac(nav: { platform?: string; userAgentData?: { platform?: string } } | undefined): boolean {
  return /mac/i.test(nav?.userAgentData?.platform || nav?.platform || '');
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

/** An image's bytes, hashed (SHA-256, its first 96 bits in hex): what the page remembers of an image. */
export async function imageHash(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...d.subarray(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** What the page remembers of a clipboard's content: its text's hash and its image's (`imageHash`), either absent. */
export function contentHash(text?: string, image?: string): string {
  return `${text ? textHash(text) : ''}/${image ?? ''}`;
}

const isText = (t: string) => t === TEXT || t === 'text/plain';
const isImage = (t: string) => /^image\/./i.test(t);

/** The PNG of `read()`'s items, if one has it (and the browser gives its data). */
async function pngOf(items: readonly HostItem[] | undefined): Promise<Blob | undefined> {
  const item = items?.find((i) => i.types.includes(PNG) && i.getType);
  return item?.getType!(PNG).catch(() => undefined);
}

/** Text as HTML that shows it. */
const escapeHtml = (s: string) => s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));

/** The text of `read()`'s items as `type` (`text/plain`, `text/html`), if one has it. */
async function textOf(items: readonly HostItem[] | undefined, type = 'text/plain'): Promise<string | undefined> {
  const item = items?.find((i) => i.types.includes(type) && i.getType);
  return (await item?.getType!(type).then((b) => b.text(), () => undefined)) || undefined;
}

/**
 * The guest's offer with an image or HTML, as the page writes it (one `ClipboardItem`): its serial, the image's type,
 * its text (inline, or to request), its HTML's type.
 */
type GuestItem = { serial: number; image?: string; text?: { type: string; inline?: string }; html?: string };

/** The page's clipboard sharing for one machine's link. */
export class ClipboardShare {
  /** The guest's newest text not written to the host's clipboard (the document had no focus, or the write was refused). */
  pending?: string;
  /** The guest's newest offer with an image or HTML not written (as `pending`; only one of the two is set, the newer). */
  pendingItem?: GuestItem;
  /** Called with each text from the guest written to the host's clipboard (the tests' hook). */
  onWritten?: (text: string) => void;
  /** Called with each image from the guest written to the host's clipboard, as the PNG written (the tests' hook). */
  onImage?: (png: Blob) => void;
  /** Called when what the toolbar shows changes: `state`, `permission`, `stopped`, `canType`. */
  onChange?: () => void;
  /** The browser's read permission (`setPermission`). */
  permission: ReadPermission = 'none';
  /** Focus reads stopped for the run: they came back empty `EMPTY_RUN` times in a row while their types said text (§4.3). */
  stopped = false;
  /** What became of the last Type the clipboard, as the agent said (TYPED's status); undefined: nothing said since. */
  typed?: number;
  /** `REQUEST_WAIT` (the tests' to shorten). */
  requestWait = REQUEST_WAIT;
  private link: ClipLink;
  private host: Host;
  // From a random start: a restored guest's agent may hold transfers of an earlier page's ids.
  private serial = crypto.getRandomValues(new Uint32Array(1))[0];
  private id = crypto.getRandomValues(new Uint32Array(1))[0];
  /** The hashes (`contentHash`) of the last content from the guest, and of the last offered to it. */
  private fromGuest?: string;
  private toGuest?: string;
  /** The hash of the host's clipboard as the page last knew it (read, pasted, or written by the page); undefined: never. */
  private hostHash?: string;
  /** The serial of the guest's newest offer. */
  private guestSerial?: number;
  /** Empty reads in a row whose types said text. */
  private empties = 0;
  /** A focus read in flight. */
  private reading = false;
  /** An image being written to the host's clipboard (and read back): focus reads wait for it. */
  private writing = false;
  /** `clipboardchange` fired since the last read (true at first: the clipboard is unknown). */
  private changed = true;
  /** The page's offer whose ACK is awaited: its content's hash, and when the wait ends. */
  private offering?: { hash: string; done: Promise<void> };
  /** The page's offer to the guest: its text's bytes, its PNG's and its HTML's, for the agent's requests. */
  private offered?: { serial: number; text?: Uint8Array; image?: Uint8Array; html?: Uint8Array };
  /** The page's requests for the guest's offer's bytes: each ends with them whole, or undefined (failed, stopped, past its cap). */
  private requests = new Map<number, { chunks: Uint8Array[]; len: number; cap: number; done: (bytes?: Uint8Array<ArrayBuffer>) => void; timer: ReturnType<typeof setTimeout> }>();
  /** The agent's requests for the page's offer's bytes. */
  private answers = new Map<number, { bytes: Uint8Array; at: number; credit: number; image: boolean }>();
  /** The page's offers' ACKs awaited (the newest only): each takes the status, or undefined (superseded). */
  private acks = new Map<number, (status?: number) => void>();
  /** The held paste chord's wait for the browser's paste event. */
  private holding?: () => void;
  /**
   * Counts the page's offers as they begin (`paste`), before any wait: an offer that a newer one began during its waits
   * (an image's bytes, its hash) isn't sent, nor is a focus read's whose read a paste began during.
   */
  private began = 0;

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

  /** Images cross too: the agent said it shares them, and the browser writes a `ClipboardItem`. */
  get images() {
    return this.active && (this.link.agent!.caps & CAP.IMAGE) !== 0 && !!this.host.clipboard.write;
  }

  /** What the toolbar's button shows. */
  get state(): ShareState {
    return this.link.paused ? 'paused' : this.link.open && this.link.agent ? 'sharing' : 'waiting';
  }

  /** The agent pastes on the console (TYPE) and sharing isn't paused: "Type the clipboard". */
  get canType() {
    return !this.link.paused && this.link.open && !!this.link.agent && (this.link.agent.caps & CAP.TYPE) !== 0;
  }

  /** The guest's newest copy waits to be written to the host's clipboard. */
  get hasPending() {
    return this.pending !== undefined || this.pendingItem !== undefined;
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
    this.pending = this.pendingItem = undefined;
    this.holding?.();
    // The agent drops the host's text from the guest's clipboard: what either side had is no longer known (`reset`).
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
   * read, and offered to the guest if it changed since the page last knew it; if it didn't, the guest's pending copy is
   * written. Where `clipboardchange` exists, the read waits for one. Without the permission, nothing.
   */
  async focused(): Promise<void> {
    if (!this.active || this.permission !== 'granted' || this.stopped || this.reading || this.writing || !this.host.hasFocus()) return;
    if (this.host.changeEvents && !this.changed) {
      if (this.hasPending) this.writePending();
      return;
    }
    this.reading = true;
    try {
      this.changed = false;
      const began = this.began;
      const got = await this.readHost();
      if (got === undefined || !this.active) return;
      const h = await this.hashOf(got);
      // A paste chord's offer began meanwhile: the host's clipboard as it read is the newer.
      if (this.began !== began) return;
      if (h === this.hostHash && this.hasPending) {
        this.writePending();
      } else {
        // The host's own copy, newer than the guest's pending one; or unchanged, offered if the guest hasn't it (a
        // new session, a restarted agent: the echo hashes were forgotten).
        this.pending = this.pendingItem = undefined;
        void this.paste(got);
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
   * copy is written. A paste chord instead drops it: the host's copy goes to the guest, the newer.
   */
  activated(pasteChord: boolean) {
    if (!this.active || !this.hasPending) return;
    if (pasteChord) this.pending = this.pendingItem = undefined;
    else this.writePending();
  }

  /**
   * "Send the clipboard to the guest" (the toolbar's menu, from its click: the activation and the prompt a read may
   * want): the host's text and image offered even if the guest seems to have them. False if there was none to send.
   */
  async send(): Promise<boolean> {
    const got = await this.readClick(true);
    if (!got || !this.active) return false;
    void this.paste(got, true);
    return true;
  }

  /** "Type the clipboard": the host's text pasted on the guest's console (TYPE). False if there was none, or no agent that types. */
  async typeIt(): Promise<boolean> {
    this.typed = undefined;
    this.onChange?.();
    const text = (await this.readClick(false))?.text;
    return !!text && this.canType && this.link.type?.(text) === true;
  }

  /**
   * The host's clipboard from a click's read; undefined if the browser gave nothing (refused, nothing, a dismissed
   * Paste button). With `image`, `read()` first, for the PNG and the text; else (or with neither) `readText`.
   */
  private async readClick(image: boolean): Promise<Content | undefined> {
    try {
      if (image && this.images && this.host.clipboard.read) {
        const items = await this.host.clipboard.read();
        const [text, png, html] = [await textOf(items), await pngOf(items), await textOf(items, HTML)];
        if (text || png) return { text, image: png, html };
      }
      const text = await this.host.clipboard.readText?.();
      return text ? { text } : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * The host's clipboard for a focus read: undefined if there's nothing to sync (refused, empty, no text or image). An
   * empty `readText` asks `read()` for the types: text among them is a hidden read (§4.3), counted. After a
   * `clipboardchange` (the only reads there are where it fires), `read()` is asked anyway, for an image.
   */
  private async readHost(): Promise<Content | undefined> {
    try {
      const text = await this.host.clipboard.readText?.();
      const items = !text || this.host.changeEvents ? await this.host.clipboard.read?.().catch(() => undefined) : undefined;
      const png = this.images ? await pngOf(items) : undefined;
      const image = png && png.size <= IMAGE_CAP ? png : undefined;
      const html = await textOf(items, HTML);
      if (text) {
        this.empties = 0;
        return { text, image, html };
      }
      // Text among the types, yet none read: hidden. No types, or others (an image): nothing to sync, a run broken.
      if (!items?.some((i) => i.types.some(isText))) this.empties = 0;
      else if (++this.empties >= EMPTY_RUN) {
        this.stopped = true;
        this.onChange?.();
      }
      if (image) return { image, html };
    } catch {
      // A refusal (NotAllowedError, DataError) is never an error mid-work.
    }
    return undefined;
  }

  /** The hash of content the host's clipboard has (its image's bytes read for it). */
  private async hashOf(c: Content): Promise<string> {
    return contentHash(c.text, c.image && (await imageHash(new Uint8Array(await c.image.arrayBuffer()))));
  }

  /** Writes the guest's pending copy to the host's clipboard (kept pending if refused). */
  private writePending() {
    if (this.pendingItem) {
      const g = this.pendingItem;
      this.pendingItem = undefined;
      return this.writeItem(g);
    }
    const text = this.pending!;
    this.pending = undefined;
    this.write(text);
  }

  private write(text: string) {
    this.host.clipboard.writeText(text).then(() => {
      this.hostHash = contentHash(text);
      this.onWritten?.(text);
    }, () => {
      // Refused (no focus, no activation): the newest stays pending, unless a newer came meanwhile.
      if (!this.hasPending && this.fromGuest === contentHash(text)) this.pending = text;
    });
  }

  /**
   * Writes the guest's offer with an image or HTML: one `ClipboardItem`, its PNG (converted if the guest's type isn't
   * PNG), its text and its HTML as promises the browser awaits, their bytes requested from the guest now. Then, with an
   * image, the permission and focus, the clipboard read back once: the browser re-encodes what it writes, so that hash
   * is the guest's (§4.4); without one, the text's is. A refusal keeps it pending if it is still the newest.
   */
  private writeItem(g: GuestItem) {
    const write = this.host.clipboard.write;
    if (!write) return;
    const ids: number[] = [];
    let failed = false;
    const fetch = (type: string, cap: number) => {
      const r = this.request(g.serial, type, cap);
      ids.push(r.id);
      return r.bytes.then((b) => {
        if (!b) {
          failed = true;
          throw new DOMException(`no ${type} from the guest`, 'DataError');
        }
        return b;
      });
    };
    const image = g.image && fetch(g.image, IMAGE_CAP).then((bytes) => {
      const b = new Blob([bytes], { type: g.image!.toLowerCase() });
      if (b.type === PNG) return b;
      if (!this.host.toPng) throw new DOMException(`no conversion of ${b.type}`, 'DataError');
      return this.host.toPng(b);
    });
    const text = g.text && (g.text.inline !== undefined ? Promise.resolve(g.text.inline) : fetch(g.text.type, TEXT_CAP).then((b) => new TextDecoder().decode(b)));
    const item: Record<string, Promise<Blob>> = {};
    if (image) item[PNG] = image;
    if (text) item['text/plain'] = text.then((s) => new Blob([s], { type: 'text/plain' }));
    // HTML that doesn't come (the guest's program refused it) is the text's, escaped: the rest is written all the same.
    if (g.html) item[HTML] = fetch(g.html, TEXT_CAP).then((b) => new Blob([b], { type: HTML }), async () => new Blob([escapeHtml((await text?.catch(() => '')) ?? '')], { type: HTML }));
    // A refused write leaves its promises to fail on their own (their requests stopped): not an error of the page's.
    for (const p of Object.values(item)) p.catch(() => {});
    this.writing = true;
    write(item).then(async () => {
      const [png, s] = [await image, await text];
      if (!png) {
        // Text and HTML: the text stands for it (the hashes leave HTML out).
        if (this.guestSerial === g.serial) this.hostHash = this.fromGuest = contentHash(s);
        if (s) this.onWritten?.(s);
        return;
      }
      this.hostHash = this.fromGuest = undefined;
      if (this.permission === 'granted' && this.host.hasFocus() && this.host.clipboard.read) {
        const items = await this.host.clipboard.read().catch(() => undefined);
        const back = await pngOf(items);
        if (back && this.guestSerial === g.serial) {
          this.hostHash = this.fromGuest = contentHash(s ? await textOf(items) : undefined, await imageHash(new Uint8Array(await back.arrayBuffer())));
        }
      }
      this.onImage?.(png);
    }, () => {
      for (const id of ids) this.stop(id);
      // Refused (no focus, no activation): the newest stays pending, unless a newer came meanwhile or the guest no
      // longer has it (a request failed).
      if (!failed && !this.hasPending && this.guestSerial === g.serial && this.active) this.pendingItem = g;
    }).finally(() => {
      this.writing = false;
    });
  }

  /**
   * A key down on the screen: a paste chord while sharing is active is held (web/input.ts sends it once the returned
   * promise settles: after the browser's `paste` event and the agent's ACK, or `PASTE_WAIT`); anything else, undefined.
   */
  chord(e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>): Promise<void> | undefined {
    if (!this.active || !isPasteChord(e, this.host.mac)) return undefined;
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

  /** The browser's `paste` event's text, image (a `File` of its items) and HTML, while a paste chord is held: offered, and the chord let go after. */
  pasted(text: string, image?: Blob, html?: string) {
    const release = this.holding;
    if (!release) return;
    this.waiting = this.paste({ text, image, html: html || undefined });
    release();
  }

  /**
   * Offers the host's content (text, or text and an image) to the guest unless it has it already (the last content
   * either way; `force`: offered anyway) or it is empty; resolves once the agent's ACK came, or `ACK_WAIT` passed (or
   * at once: nothing offered). An image goes only to an agent that takes images, at most `IMAGE_CAP`; text past
   * `TEXT_CAP` doesn't go, nor HTML past it. HTML goes only beside the text or the image, and isn't in the hash (the
   * same text with other HTML is the same content).
   */
  async paste(content: string | Content, force = false): Promise<void> {
    const began = ++this.began;
    const c = typeof content === 'string' ? { text: content } : content;
    const image = c.image && c.image.size <= IMAGE_CAP && this.images ? c.image : undefined;
    let bytes = c.text ? new TextEncoder().encode(c.text) : undefined;
    if (bytes && bytes.length > TEXT_CAP) bytes = undefined;
    const text = bytes && c.text;
    if (!this.active || (!text && !image)) return;
    let html = c.html ? new TextEncoder().encode(c.html) : undefined;
    if (html && html.length > TEXT_CAP) html = undefined;
    let png: Uint8Array<ArrayBuffer> | undefined;
    let h = contentHash(text);
    if (image) {
      png = new Uint8Array(await image.arrayBuffer());
      h = contentHash(text, await imageHash(png));
      // A newer offer began while this one read its image: that one goes, not this older one after it.
      if (!this.active || this.began !== began) return;
    }
    this.hostHash = h;
    // Offered already: a paste chord waits for that offer's ACK still (a sync's, a moment before the chord).
    if (!force && h === this.toGuest && this.offering?.hash === h) return this.offering.done;
    if (!force && (h === this.fromGuest || h === this.toGuest)) return;
    const serial = this.serial = (this.serial + 1) >>> 0;
    // Requests for an older offer's text carry on (a guest program is reading it): their answers hold their own
    // bytes. An older image's stop: the page holds one image of its own.
    if (png) {
      for (const [id, a] of this.answers) {
        if (!a.image) continue;
        this.answers.delete(id);
        this.link.send(FRAME.DATA, encodeData(id, DATA_FAIL));
      }
    }
    this.offered = { serial, text: bytes, image: png, html };
    // The guest's clipboard is to hold this one: the guest's last copy is no longer what it has.
    this.toGuest = h;
    this.fromGuest = undefined;
    for (const a of [...this.acks.values()]) a(undefined);
    let resolve!: (s?: number) => void;
    const status = new Promise<number | undefined>((r) => (resolve = r));
    // The key waits `ACK_WAIT` at most; the ACK is taken whenever it comes (until a newer offer, or a reset).
    const timer = setTimeout(resolve, ACK_WAIT);
    this.acks.set(serial, (s) => {
      clearTimeout(timer);
      this.acks.delete(serial);
      // The guest didn't take it: the next paste offers it again.
      if (s !== undefined && s !== ACK.HELD && this.toGuest === h) this.toGuest = undefined;
      resolve(s);
    });
    const done = status.then(() => {});
    this.offering = { hash: h, done };
    const types = [...(bytes ? [{ type: TEXT, size: bytes.length }] : []), ...(png ? [{ type: PNG, size: png.length }] : []), ...(html ? [{ type: HTML, size: html.length }] : [])];
    this.link.send(FRAME.OFFER, encodeOffer({ serial, types, inline: bytes && bytes.length <= INLINE ? bytes : undefined }));
    await status;
    if (this.offering?.done === done) this.offering = undefined;
  }

  /**
   * The transfers end and what the page knew of the guest's clipboard is forgotten (the echo hashes; the host's
   * clipboard is read again at the next sync): the port opened or closed, the agent said HELLO or SESSION, the pause.
   */
  private reset() {
    this.offered = undefined;
    for (const r of this.requests.values()) {
      clearTimeout(r.timer);
      r.done(undefined);
    }
    this.requests.clear();
    this.answers.clear();
    for (const a of [...this.acks.values()]) a(ACK.NO_SESSION);
    this.acks.clear();
    this.offering = undefined;
    this.fromGuest = this.toGuest = undefined;
    // The guest's image or HTML offer was its clipboard's then (its bytes are no longer to be had).
    this.pendingItem = this.guestSerial = undefined;
    this.changed = true;
  }

  /**
   * Requests the bytes of the guest's offer `serial` as `type`, at most `cap` of them: they come whole, or undefined
   * (failed, stopped, past its cap, or no DATA for `requestWait`).
   */
  private request(serial: number, type: string, cap: number): { id: number; bytes: Promise<Uint8Array<ArrayBuffer> | undefined> } {
    const id = this.id = (this.id + 1) >>> 0;
    const bytes = new Promise<Uint8Array<ArrayBuffer> | undefined>((done) => this.requests.set(id, { chunks: [], len: 0, cap, done, timer: this.waitFor(id) }));
    this.link.send(FRAME.REQUEST, encodeRequest({ serial, id, type }));
    return { id, bytes };
  }

  /** Request `id`'s wait for its next DATA. */
  private waitFor(id: number) {
    return setTimeout(() => this.stop(id), this.requestWait);
  }

  /** Request `id` ends: with its bytes, or undefined. */
  private end(id: number, bytes?: Uint8Array<ArrayBuffer>) {
    const r = this.requests.get(id);
    if (!r) return;
    clearTimeout(r.timer);
    this.requests.delete(id);
    r.done(bytes);
  }

  /** Stops the page's request `id` (MORE 0), if it is still going. */
  private stop(id: number) {
    if (!this.requests.has(id)) return;
    this.link.send(FRAME.MORE, encodeMore(id, 0));
    this.end(id);
  }

  private frame(f: Frame) {
    switch (f.type) {
      case FRAME.TYPED:
        // The console took a paste whole, or refused it (graphics on it: a compositor's) or dropped the rest.
        if (f.payload.length >= 1) {
          this.typed = f.payload[0];
          this.onChange?.();
        }
        return;
      case FRAME.HELLO:
      case FRAME.SESSION:
        // The agent is there (its stream begun afresh), or the guest's clipboard changed hands: what the page knew of
        // it is gone. The toolbar says so, and the host's clipboard goes to the guest if the page may read it.
        this.reset();
        this.onChange?.();
        void this.focused();
        return;
      case FRAME.OFFER: {
        const o = decodeOffer(f.payload);
        if (!o || !this.active) return;
        const fits = (x: { size: number }, cap: number) => x.size === UNKNOWN || x.size <= cap;
        const t = o.types.find((x) => isText(x.type) && fits(x, TEXT_CAP));
        const img = this.images ? o.types.find((x) => isImage(x.type) && fits(x, IMAGE_CAP)) : undefined;
        // HTML needs a `ClipboardItem` write; without one, the text alone.
        const html = this.host.clipboard.write ? o.types.find((x) => x.type.toLowerCase() === HTML && fits(x, TEXT_CAP)) : undefined;
        if (!t && !img && !html) return;
        // The newest offer wins: requests for older ones stop.
        for (const id of [...this.requests.keys()]) this.stop(id);
        this.guestSerial = o.serial;
        const inline = o.inline && o.types[0] === t ? new TextDecoder().decode(o.inline) : undefined;
        if (img || html) {
          // The guest's clipboard moved on; what the host will have of it is known once it is written (and read back).
          this.fromGuest = this.toGuest = undefined;
          this.pending = undefined;
          this.pendingItem = { serial: o.serial, image: img?.type, text: t && { type: t.type, inline }, html: html?.type };
          if (this.host.hasFocus()) this.writePending();
          return;
        }
        if (inline !== undefined) return this.received(inline);
        const r = this.request(o.serial, t!.type, TEXT_CAP);
        void r.bytes.then((b) => b && this.received(new TextDecoder().decode(b)));
        return;
      }
      case FRAME.DATA: {
        const d = decodeData(f.payload);
        const r = d && this.requests.get(d.id);
        if (!d || !r) return;
        if (d.flags & DATA_FAIL || !this.active) return this.end(d.id);
        r.len += d.bytes.length;
        if (r.len > r.cap) return this.stop(d.id);
        r.chunks.push(d.bytes);
        if (!(d.flags & DATA_END)) {
          clearTimeout(r.timer);
          r.timer = this.waitFor(d.id);
          return void this.link.send(FRAME.MORE, encodeMore(d.id, 1));
        }
        const all = new Uint8Array(r.len);
        let at = 0;
        for (const c of r.chunks) {
          all.set(c, at);
          at += c.length;
        }
        return this.end(d.id, all);
      }
      case FRAME.REQUEST: {
        const r = decodeRequest(f.payload);
        if (!r) return;
        const o = this.active && this.offered?.serial === r.serial ? this.offered : undefined;
        const bytes = isText(r.type) ? o?.text : r.type === PNG ? o?.image : r.type === HTML ? o?.html : undefined;
        if (!bytes) return void this.link.send(FRAME.DATA, encodeData(r.id, DATA_FAIL));
        this.answers.set(r.id, { bytes, at: 0, credit: CREDIT, image: r.type === PNG });
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
    this.fromGuest = contentHash(text);
    this.toGuest = undefined;
    this.pending = text;
    this.pendingItem = undefined;
    if (this.host.hasFocus()) this.writePending();
  }
}
