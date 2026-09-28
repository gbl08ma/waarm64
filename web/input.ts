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

/**
 * Forwards `el`'s keyboard events to `keyboard` and its pointer and wheel
 * events to `tablet` (0–32767 across the element). `el` needs a tabindex to
 * take the focus. Returns a function that detaches them.
 */
export function attachInput(el: HTMLElement, keyboard?: MessagePort, tablet?: MessagePort) {
  const on = <K extends keyof HTMLElementEventMap>(type: K, f: (e: HTMLElementEventMap[K]) => void) => {
    el.addEventListener(type, f);
    return () => el.removeEventListener(type, f);
  };
  const key = (down: number) => (e: KeyboardEvent) => {
    const code = KEYS.get(e.code);
    if (!keyboard || code === undefined) return;
    e.preventDefault();
    keyboard.postMessage([[EV_KEY, code, e.repeat ? 2 : down], [EV_SYN, 0, 0]]);
  };
  const abs = (e: MouseEvent) => {
    const r = el.getBoundingClientRect();
    const at = (v: number, len: number) => Math.max(0, Math.min(32767, Math.round((v / len) * 32767)));
    return [[EV_ABS, 0, at(e.clientX - r.left, r.width)], [EV_ABS, 1, at(e.clientY - r.top, r.height)]];
  };
  const button = (down: number) => (e: PointerEvent) => {
    if (!tablet || BUTTONS[e.button] === undefined) return;
    tablet.postMessage([...abs(e), [EV_KEY, BUTTONS[e.button], down], [EV_SYN, 0, 0]]);
  };
  const off = [
    on('keydown', key(1)),
    on('keyup', key(0)),
    on('pointerdown', button(1)),
    on('pointerup', button(0)),
    on('pointermove', (e) => tablet?.postMessage([...abs(e), [EV_SYN, 0, 0]])),
    on('wheel', (e) => {
      if (!tablet || !e.deltaY) return;
      e.preventDefault();
      tablet.postMessage([[EV_REL, 8, e.deltaY < 0 ? 1 : -1], [EV_SYN, 0, 0]]);
    }),
    on('contextmenu', (e) => e.preventDefault()),
  ];
  return () => off.forEach((f) => f());
}
