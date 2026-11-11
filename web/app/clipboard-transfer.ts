// Clipboard sharing's transfers (docs/plans/clipboard.md §2; web/app/clipboard.ts `ClipboardShare`): the page's
// requests for the bytes of the guest's offer (REQUEST, then DATA as the page's MOREs allow) and its answers to the
// agent's requests for the page's offer (DATA as the agent's MOREs allow); and the ACKs of its offers.
import {
  CHUNK,
  CREDIT,
  DATA_END,
  DATA_FAIL,
  decodeAck,
  decodeData,
  decodeMore,
  decodeRequest,
  encodeData,
  encodeMore,
  encodeRequest,
  FRAME,
} from '../agent-frame.ts';
import type { ClipLink } from './clipboard.ts';
import { HTML, isText, PNG } from './clipboard-host.ts';

/**
 * How long the page's request for the guest's bytes waits for each DATA before it stops (MORE 0): a guest program
 * that never serves its type (frozen, or an X11 owner that never answers) would otherwise hold the `ClipboardItem`
 * write waiting on it, and the focus syncs behind that write, for good. Long enough for a guest program to encode a
 * large image under the emulator.
 */
export const REQUEST_WAIT = 30_000;

/** The page's offer to the guest: its text's bytes, its PNG's and its HTML's, for the agent's requests. */
export type Offered = { serial: number; text?: Uint8Array; image?: Uint8Array; html?: Uint8Array };

/** A request of the page's: its chunks so far, and its end with them whole, or undefined (failed, stopped, past its cap). */
type Request = {
  chunks: Uint8Array[];
  len: number;
  cap: number;
  done: (bytes?: Uint8Array<ArrayBuffer>) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** The transfers of one machine's link; `active`, whether sharing works now (none are served while it doesn't). */
export class Transfers {
  /** `REQUEST_WAIT` (the tests' to shorten). */
  requestWait = REQUEST_WAIT;
  private link: ClipLink;
  private active: () => boolean;
  // From a random start: a restored guest's agent may hold transfers of an earlier page's ids.
  private id = crypto.getRandomValues(new Uint32Array(1))[0];
  /** The page's requests for the guest's offer's bytes. */
  private requests = new Map<number, Request>();
  /** The agent's requests for the page's offer's bytes. */
  private answers = new Map<number, { bytes: Uint8Array; at: number; credit: number; image: boolean }>();

  constructor(link: ClipLink, active: () => boolean) {
    this.link = link;
    this.active = active;
  }

  /**
   * Requests the bytes of the guest's offer `serial` as `type`, at most `cap` of them: they come whole, or undefined
   * (failed, stopped, past its cap, or no DATA for `requestWait`).
   */
  request(
    serial: number,
    type: string,
    cap: number,
  ): { id: number; bytes: Promise<Uint8Array<ArrayBuffer> | undefined> } {
    const id = (this.id = (this.id + 1) >>> 0);
    const bytes = new Promise<Uint8Array<ArrayBuffer> | undefined>((done) =>
      this.requests.set(id, { chunks: [], len: 0, cap, done, timer: this.waitFor(id) }),
    );
    this.link.send(FRAME.REQUEST, encodeRequest({ serial, id, type }));
    return { id, bytes };
  }

  /** Stops the page's request `id` (MORE 0), if it is still going. */
  stop(id: number) {
    if (!this.requests.has(id)) return;
    this.link.send(FRAME.MORE, encodeMore(id, 0));
    this.end(id);
  }

  /** Stops every request of the page's (the guest's newest offer wins). */
  stopAll() {
    for (const id of [...this.requests.keys()]) this.stop(id);
  }

  /** Every transfer ends: the requests with nothing, the answers dropped. */
  reset() {
    for (const r of this.requests.values()) {
      clearTimeout(r.timer);
      r.done(undefined);
    }
    this.requests.clear();
    this.answers.clear();
  }

  /** The answers with an older offer's image stop: the page holds one image of its own. */
  dropImages() {
    for (const [id, a] of this.answers) {
      if (!a.image) continue;
      this.answers.delete(id);
      this.link.send(FRAME.DATA, encodeData(id, DATA_FAIL));
    }
  }

  /** A DATA for one of the page's requests: its chunks so far, the next asked for, or its end. */
  data(payload: Uint8Array) {
    const d = decodeData(payload);
    const r = d && this.requests.get(d.id);
    if (!d || !r) return;
    if (d.flags & DATA_FAIL || !this.active()) return this.end(d.id);
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
    this.end(d.id, all);
  }

  /** The agent's REQUEST for the page's offer `offered` (none: no offer, or sharing doesn't work now). */
  serve(payload: Uint8Array, offered: Offered | undefined) {
    const r = decodeRequest(payload);
    if (!r) return;
    const o = this.active() && offered?.serial === r.serial ? offered : undefined;
    const bytes = bytesOf(o, r.type);
    if (!bytes) return void this.link.send(FRAME.DATA, encodeData(r.id, DATA_FAIL));
    this.answers.set(r.id, { bytes, at: 0, credit: CREDIT, image: r.type === PNG });
    this.answer(r.id);
  }

  /** The agent's MORE: credit for an answer, or its end (0). */
  more(payload: Uint8Array) {
    const m = decodeMore(payload);
    const a = m && this.answers.get(m.id);
    if (!m || !a) return;
    if (m.n === 0) return void this.answers.delete(m.id);
    a.credit += m.n;
    this.answer(m.id);
  }

  /** Sends what the agent's request `id` may take of the page's offer. */
  private answer(id: number) {
    const a = this.answers.get(id);
    if (!a) return;
    if (!this.active()) return void this.answers.delete(id);
    while (a.credit > 0) {
      const chunk = a.bytes.subarray(a.at, a.at + CHUNK);
      a.at += chunk.length;
      a.credit--;
      const end = a.at >= a.bytes.length;
      this.link.send(FRAME.DATA, encodeData(id, end ? DATA_END : 0, chunk));
      if (end) return void this.answers.delete(id);
    }
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
}

/** The bytes of the page's offer `o` as `type` (text, its PNG or its HTML), if it has them. */
function bytesOf(o: Offered | undefined, type: string) {
  if (isText(type)) return o?.text;
  if (type === PNG) return o?.image;
  if (type === HTML) return o?.html;
  return undefined;
}

/** The page's offers' ACKs awaited (the newest only): each takes the status, or undefined (superseded). */
export class Acks {
  private waits = new Map<number, (status?: number) => void>();

  /** The agent's ACK of offer `serial`: its status, or undefined after `ms`; `onStatus` takes it whenever it comes. */
  wait(serial: number, ms: number, onStatus: (status?: number) => void): Promise<number | undefined> {
    let resolve!: (s?: number) => void;
    const status = new Promise<number | undefined>((r) => (resolve = r));
    const timer = setTimeout(resolve, ms);
    this.waits.set(serial, (s) => {
      clearTimeout(timer);
      this.waits.delete(serial);
      onStatus(s);
      resolve(s);
    });
    return status;
  }

  /** A newer offer: the older ones' waits end with undefined. */
  supersede() {
    for (const a of [...this.waits.values()]) a(undefined);
  }

  /** The agent's ACK. */
  ack(payload: Uint8Array) {
    const a = decodeAck(payload);
    if (a) this.waits.get(a.serial)?.(a.status);
    if (a) this.waits.delete(a.serial);
  }

  /** Every wait ends with `status` (the agent's session ended). */
  reset(status: number) {
    for (const a of [...this.waits.values()]) a(status);
    this.waits.clear();
  }
}
