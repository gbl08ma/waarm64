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
// The guest-to-host way is web/app/clipboard-guest.ts's, the transfers and ACKs web/app/clipboard-transfer.ts's, the
// held paste chord web/app/clipboard-chord.ts's, the browser's side and the hashes web/app/clipboard-host.ts's.

import { ACK, CAP, encodeOffer, FRAME, type Frame, type Hello } from '../agent-frame.ts';
import {
  contentHash,
  HTML,
  IMAGE_CAP,
  isPasteChord,
  readClick,
  readHost,
  hashOf,
  imageHash,
  PNG,
  TEXT,
  TEXT_CAP,
  type Content,
  type Host,
  type ReadPermission,
} from './clipboard-host.ts';
import { HeldChord } from './clipboard-chord.ts';
import { GuestCopy, type Known } from './clipboard-guest.ts';
import { Acks, Transfers, type Offered } from './clipboard-transfer.ts';

/** Text up to this size goes inline in its OFFER (plan §2). */
export const INLINE = 4096;
/** How long the paste chord's key waits for the agent's ACK (plan §4.1). */
export const ACK_WAIT = 300;
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

/** What the toolbar's button shows (plan §5): sharing, paused for the run, or waiting for the guest's program (before its HELLO, or since its port closed). */
export type ShareState = 'sharing' | 'paused' | 'waiting';

/** The page's clipboard sharing for one machine's link. */
export class ClipboardShare {
  /** Called when what the toolbar shows changes: `state`, `permission`, `stopped`, `canType`. */
  onChange?: () => void;
  /** The browser's read permission (`setPermission`). */
  permission: ReadPermission = 'none';
  /** Focus reads stopped for the run: they came back empty `EMPTY_RUN` times in a row while their types said text (§4.3). */
  stopped = false;
  /** What became of the last Type the clipboard, as the agent said (TYPED's status); undefined: nothing said since. */
  typed?: number;
  private link: ClipLink;
  private host: Host;
  /** The page's requests for the guest's offer's bytes, and its answers to the agent's for its own. */
  private transfers: Transfers;
  // From a random start: a restored guest's agent may hold transfers of an earlier page's ids.
  private serial = crypto.getRandomValues(new Uint32Array(1))[0];
  /** What the page knows of each side's clipboard (the echo hashes). */
  private known: Known = {};
  /** The guest's copies, written to the host's clipboard or kept pending. */
  private guest: GuestCopy;
  /** Empty reads in a row whose types said text. */
  private empties = 0;
  /** A focus read in flight. */
  private reading = false;
  /** `clipboardchange` fired since the last read (true at first: the clipboard is unknown). */
  private changed = true;
  /** The page's offer whose ACK is awaited: its content's hash, and when the wait ends. */
  private offering?: { hash: string; done: Promise<void> };
  /** The page's offer to the guest, for the agent's requests. */
  private offered?: Offered;
  /** The page's offers' ACKs awaited (the newest only): each takes the status, or undefined (superseded). */
  private acks = new Acks();
  /** The held paste chord. */
  private chordHeld = new HeldChord();
  /**
   * Counts the page's offers as they begin (`paste`), before any wait: an offer that a newer one began during its waits
   * (an image's bytes, its hash) isn't sent, nor is a focus read's whose read a paste began during.
   */
  private began = 0;

  constructor(link: ClipLink, host: Host) {
    [this.link, this.host] = [link, host];
    this.transfers = new Transfers(link, () => this.active);
    this.guest = new GuestCopy({
      host,
      transfers: this.transfers,
      known: this.known,
      active: () => this.active,
      images: () => this.images,
      permission: () => this.permission,
    });
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

  /** The guest's newest text not written to the host's clipboard (the document had no focus, or the write was refused). */
  get pending() {
    return this.guest.pending;
  }
  /** The guest's newest offer with an image or HTML not written (as `pending`; only one of the two is set, the newer). */
  get pendingItem() {
    return this.guest.pendingItem;
  }
  /** Called with each text from the guest written to the host's clipboard (the tests' hook). */
  set onWritten(f: ((text: string) => void) | undefined) {
    this.guest.onWritten = f;
  }
  get onWritten() {
    return this.guest.onWritten;
  }
  /** Called with each image from the guest written to the host's clipboard, as the PNG written (the tests' hook). */
  set onImage(f: ((png: Blob) => void) | undefined) {
    this.guest.onImage = f;
  }
  get onImage() {
    return this.guest.onImage;
  }

  /** `REQUEST_WAIT` (the tests' to shorten). */
  get requestWait() {
    return this.transfers.requestWait;
  }
  set requestWait(ms: number) {
    this.transfers.requestWait = ms;
  }

  /** Sharing works now: the agent is there and said it shares text, and the toolbar's switch isn't off. */
  get active() {
    return this.link.open && !this.link.paused && !!this.link.agent && (this.link.agent.caps & CAP.TEXT) !== 0;
  }

  /** Images cross too: the agent said it shares them, and the browser writes a `ClipboardItem`. */
  get images() {
    return this.active && ((this.link.agent?.caps ?? 0) & CAP.IMAGE) !== 0 && !!this.host.clipboard.write;
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
    return this.guest.hasPending;
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
    this.guest.drop();
    this.chordHeld.release();
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
    if (
      !this.active ||
      this.permission !== 'granted' ||
      this.stopped ||
      this.reading ||
      this.guest.writing ||
      !this.host.hasFocus()
    )
      return;
    if (this.host.changeEvents && !this.changed) {
      if (this.hasPending) this.guest.writePending();
      return;
    }
    this.reading = true;
    try {
      this.changed = false;
      const began = this.began;
      const got = await this.readHost();
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `active` can change across the await
      if (got === undefined || !this.active) return;
      const h = await hashOf(got);
      // A paste chord's offer began meanwhile: the host's clipboard as it read is the newer.
      if (this.began !== began) return;
      if (h === this.known.hostHash && this.hasPending) {
        this.guest.writePending();
      } else {
        // The host's own copy, newer than the guest's pending one; or unchanged, offered if the guest hasn't it (a
        // new session, a restarted agent: the echo hashes were forgotten).
        this.guest.drop();
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
    if (pasteChord) this.guest.drop();
    else this.guest.writePending();
  }

  /**
   * "Send the clipboard to the guest" (the toolbar's menu, from its click: the activation and the prompt a read may
   * want): the host's text and image offered even if the guest seems to have them. False if there was none to send.
   */
  async send(): Promise<boolean> {
    const got = await readClick(this.host, this.images);
    if (!got || !this.active) return false;
    void this.paste(got, true);
    return true;
  }

  /** "Type the clipboard": the host's text pasted on the guest's console (TYPE). False if there was none, or no agent that types. */
  async typeIt(): Promise<boolean> {
    this.typed = undefined;
    this.onChange?.();
    const text = (await readClick(this.host, false))?.text;
    return !!text && this.canType && this.link.type?.(text) === true;
  }

  /** The host's clipboard for a focus read (`readHost`), its hidden reads counted: `EMPTY_RUN` in a row stop them. */
  private async readHost(): Promise<Content | undefined> {
    const r = await readHost(this.host, this.images);
    if (!r) return undefined;
    if (!r.hidden) this.empties = 0;
    else if (++this.empties >= EMPTY_RUN) {
      this.stopped = true;
      this.onChange?.();
    }
    return r.got;
  }

  /**
   * A key down on the screen: a paste chord while sharing is active is held (web/input.ts sends it once the returned
   * promise settles: after the browser's `paste` event and the agent's ACK, or `PASTE_WAIT`); anything else, undefined.
   */
  chord(
    e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>,
  ): Promise<void> | undefined {
    if (!this.active || !isPasteChord(e, this.host.mac)) return undefined;
    return this.chordHeld.hold();
  }

  /** Whether a paste chord waits for the browser's paste event. */
  get held() {
    return this.chordHeld.held;
  }

  /** The browser's `paste` event's text, image (a `File` of its items) and HTML, while a paste chord is held: offered, and the chord let go after. */
  pasted(text: string, image?: Blob, html?: string) {
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty HTML is none
    this.chordHeld.pasted(() => this.paste({ text, image, html: html || undefined }));
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
    const c = this.crossing(typeof content === 'string' ? { text: content } : content);
    if (!this.active || !c) return;
    let png: Uint8Array<ArrayBuffer> | undefined;
    let h = contentHash(c.text);
    if (c.image) {
      png = new Uint8Array(await c.image.arrayBuffer());
      h = contentHash(c.text, await imageHash(png));
      // A newer offer began while this one read its image: that one goes, not this older one after it.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `active` can change across the awaits
      if (!this.active || this.began !== began) return;
    }
    this.known.hostHash = h;
    // Offered already: a paste chord waits for that offer's ACK still (a sync's, a moment before the chord).
    if (!force && h === this.known.toGuest && this.offering?.hash === h) return this.offering.done;
    if (!force && (h === this.known.fromGuest || h === this.known.toGuest)) return;
    return this.offer(h, { text: c.bytes, image: png, html: c.html });
  }

  /**
   * Content as it crosses: its text's bytes within `TEXT_CAP`, its image within `IMAGE_CAP` to an agent that takes
   * images, its HTML's bytes within `TEXT_CAP`; none when neither text nor image goes.
   */
  private crossing(c: Content) {
    const image = c.image && c.image.size <= IMAGE_CAP && this.images ? c.image : undefined;
    const bytes = capped(c.text);
    const text = bytes && c.text;
    if (!text && !image) return undefined;
    return { text, bytes, image, html: capped(c.html) };
  }

  /** Offers content of hash `h` to the guest; resolves once the agent's ACK came, or `ACK_WAIT` passed. */
  private async offer(h: string, parts: Omit<Offered, 'serial'>) {
    const serial = (this.serial = (this.serial + 1) >>> 0);
    // Requests for an older offer's text carry on (a guest program is reading it): their answers hold their own
    // bytes. An older image's stop: the page holds one image of its own.
    if (parts.image) this.transfers.dropImages();
    this.offered = { serial, ...parts };
    // The guest's clipboard is to hold this one: the guest's last copy is no longer what it has.
    this.known.toGuest = h;
    this.known.fromGuest = undefined;
    this.acks.supersede();
    // The key waits `ACK_WAIT` at most; the ACK is taken whenever it comes (until a newer offer, or a reset).
    const status = this.acks.wait(serial, ACK_WAIT, (s) => {
      // The guest didn't take it: the next paste offers it again.
      if (s !== undefined && s !== ACK.HELD && this.known.toGuest === h) this.known.toGuest = undefined;
    });
    const done = status.then(() => undefined);
    this.offering = { hash: h, done };
    const { text, image, html } = parts;
    const types = [
      ...(text ? [{ type: TEXT, size: text.length }] : []),
      ...(image ? [{ type: PNG, size: image.length }] : []),
      ...(html ? [{ type: HTML, size: html.length }] : []),
    ];
    this.link.send(
      FRAME.OFFER,
      encodeOffer({ serial, types, inline: text && text.length <= INLINE ? text : undefined }),
    );
    await status;
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- a newer offer or a reset can change it across the await
    if (this.offering?.done === done) this.offering = undefined;
  }

  /**
   * The transfers end and what the page knew of the guest's clipboard is forgotten (the echo hashes; the host's
   * clipboard is read again at the next sync): the port opened or closed, the agent said HELLO or SESSION, the pause.
   */
  private reset() {
    this.offered = undefined;
    this.transfers.reset();
    this.acks.reset(ACK.NO_SESSION);
    this.offering = undefined;
    this.known.fromGuest = this.known.toGuest = undefined;
    // The guest's image or HTML offer was its clipboard's then (its bytes are no longer to be had).
    this.guest.pendingItem = this.known.guestSerial = undefined;
    this.changed = true;
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
      case FRAME.OFFER:
        return this.guest.offer(f.payload);
      case FRAME.DATA:
        return this.transfers.data(f.payload);
      case FRAME.REQUEST:
        return this.transfers.serve(f.payload, this.offered);
      case FRAME.MORE:
        return this.transfers.more(f.payload);
      case FRAME.ACK:
        return this.acks.ack(f.payload);
    }
  }
}

/** A text's bytes within `TEXT_CAP`; none for no text, or past it. */
function capped(s: string | undefined) {
  const bytes = s ? new TextEncoder().encode(s) : undefined;
  return bytes && bytes.length <= TEXT_CAP ? bytes : undefined;
}
