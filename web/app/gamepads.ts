// The host's game pads as the Gamepad API gives them (docs/usb.md "The game pad"), for the game pad of ours
// (web/usb-gamepad.ts): the pads the page can list, their names, and the feed that polls the attached ones and sends
// each change of their state to the device worker (`usb-pad`), and the guest's rumble played on the host's pad
// (`vibrationActuator`). The Gamepad API is the Window's only, so the page reads
// the pads and the device worker never sees a `Gamepad`. Chromium lists a pad only once one of its buttons has been
// pressed while the page was visible, and it gives the page no state while the page is hidden: the feed sends the pad
// at rest then, so nothing stays held in the guest.
import type { PadState } from '../usb-gamepad.ts';

/** What the feed reads of a `Gamepad`. */
export type PadLike = {
  index: number; id: string; connected: boolean; buttons: readonly { pressed: boolean; value: number }[]; axes: readonly number[];
  vibrationActuator?: Rumbler | null;
};
/** What the feed uses of a `GamepadHapticActuator`. */
type Rumbler = {
  playEffect(type: 'dual-rumble', params: { startDelay?: number; duration?: number; strongMagnitude?: number; weakMagnitude?: number }): Promise<unknown>;
  reset(): Promise<unknown>;
};

/** A pad at rest. */
export const REST: PadState = { pressed: 0, values: [], axes: [] };

/** A pad's state as the device takes it: the first 32 buttons' bits and values, the first four axes. */
export function padState(g: PadLike): PadState {
  let pressed = 0;
  const values: number[] = [];
  g.buttons.slice(0, 32).forEach((b, i) => {
    if (b.pressed) pressed |= 1 << i;
    values.push(b.value);
  });
  return { pressed: pressed >>> 0, values, axes: g.axes.slice(0, 4) };
}

/**
 * A pad's name from its `id`. Chromium's ends with what it read of the device in parentheses (on Linux
 * "Microsoft X-Box 360 pad (STANDARD GAMEPAD Vendor: 045e Product: 028e)", on Windows "Xbox 360 Controller (XInput
 * STANDARD GAMEPAD)"); the name is what comes before.
 */
export function padName(id: string): string {
  return id.replace(/\s*\([^()]*\)\s*$/, '').trim() || id.trim();
}

/** The pads the page sees now (none without the Gamepad API). */
export function listPads(read = readPads): { index: number; name: string }[] {
  return read().flatMap((g) => (g?.connected ? [{ index: g.index, name: padName(g.id) }] : []));
}

/** `navigator.getGamepads()`, or nothing where there is no Gamepad API (Node, a page without it). */
export function readPads(): readonly (PadLike | null)[] {
  try {
    return (globalThis.navigator as Navigator | undefined)?.getGamepads?.() ?? [];
  } catch {
    return []; // a permissions policy that disallows the gamepad feature throws
  }
}

const same = (a: PadState, b: PadState) =>
  a.pressed === b.pressed && a.values.length === b.values.length && a.axes.length === b.axes.length && a.values.every((v, i) => v === b.values[i]) && a.axes.every((v, i) => v === b.axes[i]);

/** How often the attached pads are read: the device's endpoint interval (4 ms) would be the pad's own; 8 ms is ~120 Hz. */
export const POLL_MS = 8;
/**
 * A rumble's effect length: the guest's motors run until it changes them, a `dual-rumble` effect for at most 5 s
 * (Chromium's limit), so a rumble that goes on is played again every `RUMBLE_AGAIN_MS`, before the last one ends.
 */
export const RUMBLE_MS = 5000;
export const RUMBLE_AGAIN_MS = 4000;

/**
 * Polls the attached pads (`set`: connector → pad index) while there are any, and sends each one's state when it
 * changed, and at rest while the page is hidden or the pad is gone.
 */
export class PadFeed {
  private pads = new Map<number, number>();
  private last = new Map<number, PadState>();
  private timer: ReturnType<typeof setInterval> | undefined;
  /** The rumbles going on, by connector: the host's pad, and the timer that plays it again. */
  private rumbles = new Map<number, { index: number; timer: ReturnType<typeof setTimeout> }>();
  private readonly send: (connector: number, pad: PadState) => void;
  private readonly read: () => readonly (PadLike | null)[];
  private readonly hidden: () => boolean;
  private readonly again: number;

  /** `again`: how often a rumble that goes on is played again (`RUMBLE_AGAIN_MS`; shorter in tests). */
  constructor(send: (connector: number, pad: PadState) => void, o: { read?: () => readonly (PadLike | null)[]; hidden?: () => boolean; again?: number } = {}) {
    this.send = send;
    this.again = o.again ?? RUMBLE_AGAIN_MS;
    this.read = o.read ?? readPads;
    this.hidden = o.hidden ?? (() => globalThis.document?.visibilityState === 'hidden');
  }

  /** The pads attached now, by connector. */
  set(pads: Map<number, number>) {
    this.pads = new Map(pads);
    for (const c of this.last.keys()) if (!this.pads.has(c)) this.last.delete(c);
    for (const c of this.rumbles.keys()) if (!this.pads.has(c)) this.rumble(c, 0, 0);
    if (this.pads.size && !this.timer) this.timer = setInterval(() => this.tick(), POLL_MS);
    else if (!this.pads.size && this.timer) { clearInterval(this.timer); this.timer = undefined; }
    if (this.pads.size) this.tick();
  }

  /** Reads the pads once and sends what changed. */
  tick() {
    const all = this.hidden() ? [] : this.read();
    for (const [connector, index] of this.pads) {
      const g = all[index];
      const s = g?.connected && g.index === index ? padState(g) : REST;
      const was = this.last.get(connector);
      if (was && same(was, s)) continue;
      this.last.set(connector, s);
      this.send(connector, s);
    }
  }

  /** The guest's rumble on `connector`'s game pad (each motor 0–1), played on the host's pad until it changes. */
  rumble(connector: number, strong: number, weak: number) {
    const was = this.rumbles.get(connector);
    if (was) clearTimeout(was.timer);
    this.rumbles.delete(connector);
    const actuator = (index: number) => {
      const g = this.hidden() ? undefined : this.read()[index];
      return g?.connected && g.index === index ? g.vibrationActuator ?? undefined : undefined;
    };
    if (!(strong > 0 || weak > 0)) {
      if (was) actuator(was.index)?.reset().catch(() => {});
      return;
    }
    const index = this.pads.get(connector);
    if (index === undefined) return;
    const play = () => {
      actuator(index)?.playEffect('dual-rumble', { startDelay: 0, duration: RUMBLE_MS, strongMagnitude: Math.min(1, strong), weakMagnitude: Math.min(1, weak) }).catch(() => {});
      this.rumbles.set(connector, { index, timer: setTimeout(play, this.again) });
    };
    play();
  }

  stop() {
    this.set(new Map());
  }
}
