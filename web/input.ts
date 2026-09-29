// DOM input for virtio-input (docs/devices.md): the page owns the DOM events and
// sends them to the keyboard's and the tablet's ports as Linux input events
// ([type, code, value] arrays, one message per report); the device worker
// hands them to the guest.

const EV_SYN = 0;
const EV_KEY = 1;
const EV_REL = 2;
const EV_ABS = 3;

// KeyboardEvent.code → Linux keycodes (input-event-codes.h), a US-layout PC keyboard.
const ROW = (codes: string, first: number) => codes.split(' ').map((c, k) => [c, first + k] as const);
const KEYS = new Map<string, number>([
  ...ROW('Escape Digit1 Digit2 Digit3 Digit4 Digit5 Digit6 Digit7 Digit8 Digit9 Digit0 Minus Equal Backspace Tab', 1),
  ...ROW('KeyQ KeyW KeyE KeyR KeyT KeyY KeyU KeyI KeyO KeyP BracketLeft BracketRight Enter ControlLeft', 16),
  ...ROW('KeyA KeyS KeyD KeyF KeyG KeyH KeyJ KeyK KeyL Semicolon Quote Backquote ShiftLeft Backslash', 30),
  ...ROW('KeyZ KeyX KeyC KeyV KeyB KeyN KeyM Comma Period Slash ShiftRight NumpadMultiply AltLeft Space CapsLock', 44),
  ...ROW('F1 F2 F3 F4 F5 F6 F7 F8 F9 F10 NumLock ScrollLock', 59),
  ...ROW('Numpad7 Numpad8 Numpad9 NumpadSubtract Numpad4 Numpad5 Numpad6 NumpadAdd Numpad1 Numpad2 Numpad3 Numpad0 NumpadDecimal', 71),
  ['IntlBackslash', 86], ['F11', 87], ['F12', 88], ['NumpadEnter', 96], ['ControlRight', 97], ['NumpadDivide', 98],
  ['PrintScreen', 99], ['AltRight', 100], ['Home', 102], ['ArrowUp', 103], ['PageUp', 104], ['ArrowLeft', 105],
  ['ArrowRight', 106], ['End', 107], ['ArrowDown', 108], ['PageDown', 109], ['Insert', 110], ['Delete', 111],
  ['Pause', 119], ['MetaLeft', 125], ['MetaRight', 126], ['ContextMenu', 127],
]);
const BUTTONS = [0x110, 0x112, 0x111]; // DOM buttons 0, 1, 2: BTN_LEFT, BTN_MIDDLE, BTN_RIGHT

/** What `attachInput` returns. */
export type Input = {
  /** Releases what's held and removes the listeners. */
  detach(): void;
  /** Presses keys (`KeyboardEvent.code` names) in order and releases them in reverse: a chord the browser won't pass, e.g. `ControlLeft AltLeft Delete`. */
  chord(...codes: string[]): void;
};

/**
 * Forwards `el`'s keyboard events to `keyboard` and its pointer and wheel
 * events to `tablet` (0–32767 across the element's box as laid out, so CSS
 * scaling doesn't matter). `el` needs a tabindex to take the focus. Keys and
 * buttons held when `el` loses the focus, the window loses it or the page is
 * hidden are released then (their keyup goes elsewhere: no stuck modifiers).
 */
export function attachInput(el: HTMLElement, keyboard?: MessagePort, tablet?: MessagePort): Input {
  const keys = new Set<number>(); // held, as the guest sees it
  const buttons = new Set<number>();
  const on = <T extends EventTarget, E extends Event>(target: T, type: string, f: (e: E) => void) => {
    target.addEventListener(type, f as EventListener);
    return () => target.removeEventListener(type, f as EventListener);
  };
  const sendKey = (code: number, value: number) => {
    if (value === 0) keys.delete(code);
    else keys.add(code);
    keyboard?.postMessage([[EV_KEY, code, value], [EV_SYN, 0, 0]]);
  };
  const key = (down: number) => (e: KeyboardEvent) => {
    const code = KEYS.get(e.code);
    if (!keyboard || code === undefined) return;
    e.preventDefault();
    if (!down && !keys.has(code)) return; // pressed elsewhere, or released already on a blur
    sendKey(code, e.repeat && keys.has(code) ? 2 : down);
  };
  const abs = (e: MouseEvent) => {
    const r = el.getBoundingClientRect();
    const at = (v: number, len: number) => Math.max(0, Math.min(32767, Math.round((v / len) * 32767)));
    return [[EV_ABS, 0, at(e.clientX - r.left, r.width)], [EV_ABS, 1, at(e.clientY - r.top, r.height)]];
  };
  const button = (down: number) => (e: PointerEvent) => {
    const b = BUTTONS[e.button];
    if (!tablet || b === undefined) return;
    if (!down && !buttons.has(b)) return;
    if (down) buttons.add(b);
    else buttons.delete(b);
    tablet.postMessage([...abs(e), [EV_KEY, b, down], [EV_SYN, 0, 0]]);
  };
  const releaseAll = () => {
    for (const code of [...keys].reverse()) sendKey(code, 0);
    if (buttons.size) tablet?.postMessage([...[...buttons].map((b) => [EV_KEY, b, 0]), [EV_SYN, 0, 0]]);
    buttons.clear();
  };
  const off = [
    on(el, 'keydown', key(1)),
    on(el, 'keyup', key(0)),
    on(el, 'pointerdown', (e: PointerEvent) => {
      el.setPointerCapture(e.pointerId); // a drag that leaves the screen still ends here
      button(1)(e);
    }),
    on(el, 'pointerup', button(0)),
    on(el, 'pointermove', (e: PointerEvent) => tablet?.postMessage([...abs(e), [EV_SYN, 0, 0]])),
    on(el, 'wheel', (e: WheelEvent) => {
      if (!tablet || !e.deltaY) return;
      e.preventDefault();
      tablet.postMessage([[EV_REL, 8, e.deltaY < 0 ? 1 : -1], [EV_SYN, 0, 0]]);
    }),
    on(el, 'contextmenu', (e: Event) => e.preventDefault()),
    on(el, 'blur', releaseAll),
    on(window, 'blur', releaseAll),
    on(document, 'visibilitychange', () => document.hidden && releaseAll()),
  ];
  return {
    detach() {
      releaseAll();
      off.forEach((f) => f());
    },
    chord(...codes: string[]) {
      const cs = codes.map((c) => {
        const k = KEYS.get(c);
        if (k === undefined) throw new Error(`no key ${c}`);
        return k;
      });
      for (const k of cs) sendKey(k, 1);
      for (const k of cs.reverse()) sendKey(k, 0);
    },
  };
}
