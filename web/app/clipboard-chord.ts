// Clipboard sharing's paste chord (docs/plans/clipboard.md §4.1, way 2; web/app/clipboard.ts `ClipboardShare.chord`):
// the key held until the browser's `paste` event came and its content was offered to the guest, or `PASTE_WAIT` passed.

/** How long a held paste chord waits for the browser's `paste` event (a browser may not fire one). */
export const PASTE_WAIT = 300;

/** The held paste chord: at most one, a newer one letting the older go. */
export class HeldChord {
  /** The held chord's wait for the browser's paste event. */
  private holding?: () => void;
  /** The offer of the paste event's content: the chord goes on once it settled. */
  private waiting: Promise<void> = Promise.resolve();

  /** Whether a paste chord waits for the browser's paste event. */
  get held() {
    return !!this.holding;
  }

  /** Holds a paste chord: the promise settles after the paste event's offer, or `PASTE_WAIT`. */
  hold(): Promise<void> {
    this.release();
    let release: () => void = () => undefined; // replaced by the promise's resolve at once
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

  /** The paste event came while a chord is held: `offer` offers its content, and the chord goes on after. */
  pasted(offer: () => Promise<void>) {
    const release = this.holding;
    if (!release) return;
    this.waiting = offer();
    release();
  }

  /** Lets the held chord go (sharing paused, a newer chord). */
  release() {
    this.holding?.();
  }
}
