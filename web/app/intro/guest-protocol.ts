// The messages between the introduction and its guest's worker (intro/guest.ts, intro/guest-worker.ts).

/** The marks the guest's tour sends on its console (images/intro/tour): an OSC 777 `waarm64;<mark>`. */
export const MARKS = ['scope', 'reveal', 'ridges', 'life', 'shell'] as const;
export type Mark = (typeof MARKS)[number];
/** A mark as it is on the console. */
export const markText = (mark: Mark) => `\x1b]777;waarm64;${mark}\x07`;

export type GuestStart = {
  type: 'start';
  /** The frame's canvas, transferred: the worker draws the guest's framebuffer on it. */
  screen: OffscreenCanvas;
  /** What is typed: strings or bytes for the guest's serial port. */
  serial: MessagePort;
  /** The framebuffer's pixels, and the terminal's size for the guest's `stty`. */
  width: number;
  height: number;
  cols: number;
  rows: number;
};
export type ToGuest = GuestStart | { type: 'pause' } | { type: 'resume' } | { type: 'stop' };

/** What the guest has run so far, once a second: instructions retired, and the blocks of them the JIT compiled. */
export type GuestStats = { steps: number; blocks: number };

export type FromGuest =
  /** The serial port's output. */
  | { type: 'output'; text: string }
  /** The first frame with something on it is on the canvas. */
  | { type: 'screen' }
  | { type: 'stats'; stats: GuestStats }
  /** The guest powered itself off (`off`), or couldn't start or go on (`failed`; `detail` for the console, not for the page's words). */
  | { type: 'end'; state: 'off' | 'failed'; detail?: string }
  /** The answer to `stop`: everything the start took is freed. */
  | { type: 'stopped' };
