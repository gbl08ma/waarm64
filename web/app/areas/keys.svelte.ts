// The keyboard as the page shows it (docs/frontend.md "Input", "The on-screen keyboard"): the on-screen keyboard and
// its modifiers' setting, the guest's layout and LEDs, where keys go; and what happened to the keys that the on-screen
// keyboard follows (`onReleased`, `onTyped`). web/app/main.ts writes it from the machine's input.
import type { ModifierMode } from '../osk.ts';
import { settings } from '../settings.ts';

type Listener<A extends unknown[]> = (...args: A) => void;
/** Listeners to an event: `on` adds one and returns its removal (an `$effect`'s cleanup). */
class Event<A extends unknown[] = []> {
  readonly #listeners = new Set<Listener<A>>();
  on(f: Listener<A>) {
    this.#listeners.add(f);
    return () => {
      this.#listeners.delete(f);
    };
  }
  emit(...args: A) {
    for (const f of this.#listeners) f(...args);
  }
}

class Keys {
  /** The on-screen keyboard is shown. */
  osk = $state(false);
  /** How its tapped modifiers are let go (Preferences; remembered): after the next key, by default. */
  oskModifiers = $state<ModifierMode>(settings().oskModifiers ?? 'next');
  /**
   * The keyboard layout the running machine gives its guest (a `KEYBOARD_LAYOUTS` id, web/app/keyboard.ts), or none
   * (the guest's own, taken as US): the on-screen keyboard's legends and the characters it types into the serial console.
   */
  layout = $state<string>();
  /** The guest has a driver on its virtio keyboard (else the screen's keys go to the built-in USB one or the serial console). */
  live = $state(false);
  /** The LEDs the guest set (bit 0 Num, 1 Caps, 2 Scroll Lock) on the virtio keyboard and on the built-in USB one. */
  ledBits = $state({ virtio: 0, usb: 0 });
  /** The LEDs of the keyboard the guest reads now: the virtio one once its driver is up, else the built-in USB one. */
  readonly leds = $derived(this.live ? this.ledBits.virtio : this.ledBits.usb);
  /** Full screen with the keyboard lock held: the browser's shortcuts reach the machine. */
  locked = $state(false);
  /** The screen or the terminal has the focus, in a focused window (the screen's "Click to type" hint is off). */
  focused = $state(false);
  /** The guest's keys were released by the page (a blur): the on-screen keyboard forgets what it holds. */
  readonly released = new Event();
  /** A key was typed on the physical keyboard (into the screen or the terminal): it ends the on-screen keyboard's latches. */
  readonly typed = new Event<[code: string]>();
}
export const keys = new Keys();
