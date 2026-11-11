// Clipboard sharing's guest-to-host way (docs/plans/clipboard.md §4.2, §4.4; web/app/clipboard.ts `ClipboardShare`):
// the guest's OFFER taken, its text written with `writeText` and an offer with an image or HTML as one `ClipboardItem`
// whose values are promises (the bytes requested from the guest at the write), or kept pending until the page may write.
import { decodeOffer, UNKNOWN } from '../agent-frame.ts';
import {
  contentHash,
  escapeHtml,
  HTML,
  IMAGE_CAP,
  imageHash,
  isImage,
  isText,
  PNG,
  pngOf,
  TEXT_CAP,
  textOf,
  type Host,
  type ReadPermission,
} from './clipboard-host.ts';
import type { Transfers } from './clipboard-transfer.ts';

/**
 * The guest's offer with an image or HTML, as the page writes it (one `ClipboardItem`): its serial, the image's type,
 * its text (inline, or to request), its HTML's type.
 */
export type GuestItem = { serial: number; image?: string; text?: { type: string; inline?: string }; html?: string };

/**
 * What the page knows of each side's clipboard (§2, §4.4): the hashes (`contentHash`) of the last content from the
 * guest and of the last offered to it, the host's clipboard as the page last knew it (read, pasted, or written by the
 * page; undefined: never), and the serial of the guest's newest offer.
 */
export type Known = { fromGuest?: string; toGuest?: string; hostHash?: string; guestSerial?: number };

/** What the guest's copies take of the sharing (`ClipboardShare`). */
export type Sharing = {
  host: Host;
  transfers: Transfers;
  known: Known;
  /** Sharing works now; images cross too; the browser's read permission. */
  active: () => boolean;
  images: () => boolean;
  permission: () => ReadPermission;
};

/** The guest's copies, written to the host's clipboard or kept pending. */
export class GuestCopy {
  /** The guest's newest text not written to the host's clipboard (the document had no focus, or the write was refused). */
  pending?: string;
  /** The guest's newest offer with an image or HTML not written (as `pending`; only one of the two is set, the newer). */
  pendingItem?: GuestItem;
  /** Called with each text from the guest written to the host's clipboard (the tests' hook). */
  onWritten?: (text: string) => void;
  /** Called with each image from the guest written to the host's clipboard, as the PNG written (the tests' hook). */
  onImage?: (png: Blob) => void;
  /** An image being written to the host's clipboard (and read back): focus reads wait for it. */
  writing = false;
  private s: Sharing;

  constructor(s: Sharing) {
    this.s = s;
  }

  /** The guest's newest copy waits to be written to the host's clipboard. */
  get hasPending() {
    return this.pending !== undefined || this.pendingItem !== undefined;
  }

  /** The guest's pending copy is dropped (the host's newer copy goes to the guest instead, or sharing paused). */
  drop() {
    this.pending = this.pendingItem = undefined;
  }

  /** Writes the guest's pending copy to the host's clipboard (kept pending if refused). */
  writePending() {
    if (this.pendingItem) {
      const g = this.pendingItem;
      this.pendingItem = undefined;
      return this.writeItem(g);
    }
    const text = this.pending;
    if (text === undefined) return;
    this.pending = undefined;
    this.write(text);
  }

  private write(text: string) {
    this.s.host.clipboard.writeText(text).then(
      () => {
        this.s.known.hostHash = contentHash(text);
        this.onWritten?.(text);
      },
      () => {
        // Refused (no focus, no activation): the newest stays pending, unless a newer came meanwhile.
        if (!this.hasPending && this.s.known.fromGuest === contentHash(text)) this.pending = text;
      },
    );
  }

  /**
   * Writes the guest's offer with an image or HTML: one `ClipboardItem`, its PNG (converted if the guest's type isn't
   * PNG), its text and its HTML as promises the browser awaits, their bytes requested from the guest now. Then, with an
   * image, the permission and focus, the clipboard read back once: the browser re-encodes what it writes, so that hash
   * is the guest's (§4.4); without one, the text's is. A refusal keeps it pending if it is still the newest.
   */
  private writeItem(g: GuestItem) {
    const write = this.s.host.clipboard.write;
    if (!write) return;
    const ids: number[] = [];
    let failed = false;
    const fetch = (type: string, cap: number) => {
      const r = this.s.transfers.request(g.serial, type, cap);
      ids.push(r.id);
      return r.bytes.then((b) => {
        if (!b) {
          failed = true;
          throw new DOMException(`no ${type} from the guest`, 'DataError');
        }
        return b;
      });
    };
    const imageType = g.image;
    const image =
      imageType &&
      fetch(imageType, IMAGE_CAP).then((bytes) => {
        const b = new Blob([bytes], { type: imageType.toLowerCase() });
        if (b.type === PNG) return b;
        if (!this.s.host.toPng) throw new DOMException(`no conversion of ${b.type}`, 'DataError');
        return this.s.host.toPng(b);
      });
    const text =
      g.text &&
      (g.text.inline !== undefined
        ? Promise.resolve(g.text.inline)
        : fetch(g.text.type, TEXT_CAP).then((b) => new TextDecoder().decode(b)));
    const item: Record<string, Promise<Blob>> = {};
    if (image) item[PNG] = image;
    if (text) item['text/plain'] = text.then((s) => new Blob([s], { type: 'text/plain' }));
    // HTML that doesn't come (the guest's program refused it) is the text's, escaped: the rest is written all the same.
    if (g.html)
      item[HTML] = fetch(g.html, TEXT_CAP).then(
        (b) => new Blob([b], { type: HTML }),
        async () => new Blob([escapeHtml((await text?.catch(() => '')) ?? '')], { type: HTML }),
      );
    // A refused write leaves its promises to fail on their own (their requests stopped): not an error of the page's.
    for (const p of Object.values(item)) p.catch(() => undefined);
    this.writing = true;
    write(item)
      .then(
        async () => {
          const [png, s] = [await image, await text];
          if (!png) {
            // Text and HTML: the text stands for it (the hashes leave HTML out).
            if (this.s.known.guestSerial === g.serial) this.s.known.hostHash = this.s.known.fromGuest = contentHash(s);
            if (s) this.onWritten?.(s);
            return;
          }
          this.s.known.hostHash = this.s.known.fromGuest = undefined;
          if (this.s.permission() === 'granted' && this.s.host.hasFocus() && this.s.host.clipboard.read) {
            const items = await this.s.host.clipboard.read().catch(() => undefined);
            const back = await pngOf(items);
            if (back && this.s.known.guestSerial === g.serial) {
              this.s.known.hostHash = this.s.known.fromGuest = contentHash(
                s ? await textOf(items) : undefined,
                await imageHash(new Uint8Array(await back.arrayBuffer())),
              );
            }
          }
          this.onImage?.(png);
        },
        () => {
          for (const id of ids) this.s.transfers.stop(id);
          // Refused (no focus, no activation): the newest stays pending, unless a newer came meanwhile or the guest no
          // longer has it (a request failed).
          if (!failed && !this.hasPending && this.s.known.guestSerial === g.serial && this.s.active())
            this.pendingItem = g;
        },
      )
      .finally(() => {
        this.writing = false;
      });
  }

  /** The types of the guest's offer the page takes: its text, its image (to a page that writes images), its HTML. */
  private takes(types: { type: string; size: number }[]) {
    const fits = (x: { size: number }, cap: number) => x.size === UNKNOWN || x.size <= cap;
    const text = types.find((x) => isText(x.type) && fits(x, TEXT_CAP));
    const image = this.s.images() ? types.find((x) => isImage(x.type) && fits(x, IMAGE_CAP)) : undefined;
    // HTML needs a `ClipboardItem` write; without one, the text alone.
    const html = this.s.host.clipboard.write
      ? types.find((x) => x.type.toLowerCase() === HTML && fits(x, TEXT_CAP))
      : undefined;
    return { text, image, html };
  }

  /** The guest's OFFER: its text received (inline, or requested), or its offer with an image or HTML written. */
  offer(payload: Uint8Array) {
    const o = decodeOffer(payload);
    if (!o || !this.s.active()) return;
    const { text: t, image: img, html } = this.takes(o.types);
    if (!t && !img && !html) return;
    // The newest offer wins: requests for older ones stop.
    this.s.transfers.stopAll();
    this.s.known.guestSerial = o.serial;
    const inline = o.inline && o.types[0] === t ? new TextDecoder().decode(o.inline) : undefined;
    if (img || html)
      return this.item({ serial: o.serial, image: img?.type, text: t && { type: t.type, inline }, html: html?.type });
    if (inline !== undefined) return this.received(inline);
    if (!t) return; // an image or HTML went above
    const r = this.s.transfers.request(o.serial, t.type, TEXT_CAP);
    void r.bytes.then((b) => b && this.received(new TextDecoder().decode(b)));
  }

  /** The guest's offer with an image or HTML: written now while the document has focus, else kept for later. */
  private item(g: GuestItem) {
    // The guest's clipboard moved on; what the host will have of it is known once it is written (and read back).
    this.s.known.fromGuest = this.s.known.toGuest = undefined;
    this.pending = undefined;
    this.pendingItem = g;
    if (this.s.host.hasFocus()) this.writePending();
  }

  /** The guest's text: to the host's clipboard while the document has focus, else kept for later (the newest only). */
  received(text: string) {
    if (text === '') return;
    this.s.known.fromGuest = contentHash(text);
    this.s.known.toGuest = undefined;
    this.pending = text;
    this.pendingItem = undefined;
    if (this.s.host.hasFocus()) this.writePending();
  }
}
