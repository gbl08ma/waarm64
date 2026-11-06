// DOM input for virtio-input (docs/devices.md): the page owns the DOM events and
// sends them to the keyboard's and the tablet's ports as Linux input events
// ([type, code, value] arrays, one message per report); the device worker
// hands them to the guest.

const EV_SYN = 0;
const EV_KEY = 1;
const EV_REL = 2;
const EV_ABS = 3;

// KeyboardEvent.code → Linux keycodes (input-event-codes.h): a key's position on a PC keyboard, whatever its layout.
const ROW = (codes: string, first: number) => codes.split(' ').map((c, k) => [c, first + k] as const);
const KEYS = new Map<string, number>([
  // i18n-ignore-next: KeyboardEvent.code names
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
  // Keys a US keyboard lacks (ABNT2's and JIS's; the guest's layout gives them characters: web/app/keyboard.ts).
  ['IntlRo', 89], ['Convert', 92], ['KanaMode', 93], ['NonConvert', 94], ['Lang1', 122], ['Lang2', 123], ['IntlYen', 124],
  // Keys past a PC's 105 (the keyboard advertises every code to KEY_MICMUTE): the numpad's extras, F13 to F24, media keys.
  ['NumpadEqual', 117], ['NumpadComma', 121], ...ROW('F13 F14 F15 F16 F17 F18 F19 F20 F21 F22 F23 F24', 183),
  ['AudioVolumeMute', 113], ['AudioVolumeDown', 114], ['AudioVolumeUp', 115],
  ['MediaTrackNext', 163], ['MediaPlayPause', 164], ['MediaTrackPrevious', 165], ['MediaStop', 166],
  // The power keys (systemd-logind powers off, suspends on them); the page's clock catch-up presses Sleep.
  ['Power', 116], ['Sleep', 142], ['WakeUp', 143],
]);
// `PointerEvent.buttons`' bits: left, right, middle, back, forward → BTN_LEFT, BTN_RIGHT, BTN_MIDDLE, BTN_SIDE, BTN_EXTRA.
const BUTTON_BITS = [[1, 0x110], [2, 0x111], [4, 0x112], [8, 0x113], [16, 0x114]] as const;
const BTN_TOUCH = 0x14a;
const ABS_MT_SLOT = 0x2f, ABS_MT_POSITION_X = 0x35, ABS_MT_POSITION_Y = 0x36, ABS_MT_TRACKING_ID = 0x39;
/** The touchscreen's slots (web/devices.ts `TOUCH_SLOTS`). */
const TOUCH_SLOTS = 10;
/** A wheel's notch (REL_WHEEL 1) in CSS pixels: a mouse's notch comes as one event of at least this, a touchpad's motion as many small ones, summed. */
const NOTCH_PX = 50;

/** What `attachInput` returns. */
export type Input = {
  /** Releases what's held and removes the listeners. */
  detach(): void;
  /** Presses keys (`KeyboardEvent.code` names) in order and releases them in reverse: a chord the browser won't pass, e.g. `ControlLeft AltLeft Delete`. */
  chord(...codes: string[]): void;
  /**
   * Key `code` down or up, as a key event of the element's would (the on-screen keyboard's): to the keyboard, or before
   * the guest has a driver on it, to the built-in USB keyboard or the serial console (`event`: its `key` and modifiers).
   */
  key(code: string, down: boolean, event: KeyLike, from?: KeySource): void;
  /** Calls `f` whenever everything held is released (a blur, a hidden page, a detach, `release`). */
  onRelease(f: () => void): void;
  /** Calls `f` with each key the element's own key events let go (a key typed on the physical keyboard). */
  onTyped(f: (code: string) => void): void;
  /** Releases every key, button and touch held (the guest's keyboard driver came or went: the keys go elsewhere now). */
  release(): void;
  /**
   * The mouse lock: on, a click on the element takes the mouse (Pointer Lock); off, it is let go (as it is when the
   * mode changes: the next click takes it in the new one).
   */
  mouseLock(on: boolean, mode?: LockMode): void;
};

/**
 * How the locked mouse moves the guest (docs/frontend.md "Mouse lock"): `pointer`, the tablet by the host's pointer
 * motion (accelerated as the host's pointer is, in CSS pixels: the same speed as unlocked), a cursor kept in the
 * screen; `raw`, the relative mouse by the mouse's own counts (unadjusted where the platform has it; the guest
 * accelerates), unbounded by the screen, for games. `raw` on a machine without a mouse is `pointer`.
 */
export type LockMode = 'pointer' | 'raw';

/**
 * The pointing devices besides the tablet (docs/frontend.md "Mouse lock"): `mouse`, a relative mouse's port, which
 * takes the motion while the element holds the mouse in the `raw` mode; `touch`, a touchscreen's port, which takes the touches (without one a touch moves the tablet and
 * presses its left button). `locked` is told when the element takes the mouse or lets it go.
 */
export type Pointers = { mouse?: MessagePort; touch?: MessagePort; locked?: (on: boolean) => void };

const CSI: Record<string, string> = {
  ArrowUp: '\x1b[A', ArrowDown: '\x1b[B', ArrowRight: '\x1b[C', ArrowLeft: '\x1b[D', Home: '\x1b[H', End: '\x1b[F',
  PageUp: '\x1b[5~', PageDown: '\x1b[6~', Insert: '\x1b[2~', Delete: '\x1b[3~',
  F1: '\x1bOP', F2: '\x1bOQ', F3: '\x1bOR', F4: '\x1bOS', F5: '\x1b[15~', F6: '\x1b[17~', F7: '\x1b[18~', F8: '\x1b[19~', F9: '\x1b[20~', F10: '\x1b[21~', F11: '\x1b[23~', F12: '\x1b[24~',
};

/** What a key event says beside its code: its `key` (the character or the key's name) and the modifiers down with it. */
export type KeyLike = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'metaKey'> & { repeat?: boolean };

/** Who presses a key (web/input.ts `attachInput` keeps who holds each): the screen's key events, the on-screen keyboard, the Keys menu's combinations, Hold Esc. */
export type KeySource = 'screen' | 'osk' | 'menu' | 'hold';

/** A `KeyboardEvent.key` for code `code` on a US keyboard, as a terminal reads it (a letter or digit, else the code: `Escape`, `Tab`, `F4`). */
const keyName = (code: string, shift: boolean) => (/^Key[A-Z]$/.test(code) ? (shift ? code[3] : code[3].toLowerCase()) : /^Digit\d$/.test(code) ? code[5] : code);

/** Key `code`'s (a `KeyboardEvent.code` name) Linux keycode, if the guest's keyboard has it. */
export const codeOf = (code: string) => KEYS.get(code);

/** What a terminal sends for a key event (what EDK2's and GRUB's serial console read), or null for one that sends nothing (a modifier, an unknown key). */
export function terminalBytes(e: KeyLike): string | null {
  if (e.metaKey) return null;
  const special = CSI[e.key] ?? ({ Enter: '\r', Backspace: '\x7f', Tab: '\t', Escape: '\x1b' } as Record<string, string>)[e.key];
  if (special !== undefined) return e.altKey ? `\x1b${special}` : special;
  if (e.key.length !== 1) return null;
  let c = e.key;
  if (e.ctrlKey) {
    const k = c.toLowerCase().charCodeAt(0);
    if (k >= 97 && k <= 122) c = String.fromCharCode(k - 96);
    else if (c === '[') c = '\x1b';
    else if (c === ' ') c = '\0';
    else return null;
  }
  return e.altKey ? `\x1b${c}` : c;
}

/**
 * Forwards `el`'s keyboard events to `keyboard` and its pointer and wheel
 * events to `tablet` (0–32767 across the element's box as laid out, so CSS
 * scaling doesn't matter), or to `pointers`' devices. `el` needs a tabindex to
 * take the focus. Keys, buttons and touches held when `el` loses the focus, the
 * window loses it or the page is hidden are released then (their keyup goes
 * elsewhere: no stuck modifiers). A mouse's back and forward buttons are the
 * guest's over `el`: the browser doesn't navigate.
 *
 * `text`: what takes the keys while the guest has no driver on its keyboard (`live` false): `usb`, the built-in USB
 * keyboard (web/usb-keyboard.ts: every key, down and up, by `KeyboardEvent.code`; '' releases them all), when it says
 * it took the key; else `send`, the serial console, as a terminal sends them (`terminalBytes`).
 *
 * `hooks.hold`: asked at each key down on the element (not a repeat); a promise holds the key: no `preventDefault`, so
 * the browser's own action happens (a paste chord's `paste` event: web/app/clipboard.ts), and the key goes to the guest
 * when the promise settles, and the element's key events that came meanwhile after it, in order (the chord's
 * modifiers' releases among them; its own repeats dropped). A release (a blur) drops the held key and those.
 */
export function attachInput(el: HTMLElement, keyboard?: MessagePort, tablet?: MessagePort, text?: { live: () => boolean; send: (bytes: string) => void; usb?: (code: string, down: boolean) => boolean }, pointers: Pointers = {}, hooks: { hold?: (e: KeyboardEvent) => Promise<void> | undefined } = {}): Input {
  const keys = new Set<number>(); // held, as the guest sees it
  const on = <T extends EventTarget, E extends Event>(target: T, type: string, f: (e: E) => void) => {
    target.addEventListener(type, f as EventListener);
    return () => target.removeEventListener(type, f as EventListener);
  };
  const sendKey = (code: number, value: number) => {
    if (value === 0) keys.delete(code);
    else keys.add(code);
    keyboard?.postMessage([[EV_KEY, code, value], [EV_SYN, 0, 0]]);
  };
  /** Key `name` down or up to the guest, whoever holds it: whether it took it. */
  const deliver = (name: string, down: boolean, e: KeyLike): boolean => {
    // No guest driver for the keyboard yet (the firmware, GRUB, the initramfs have none): the keys go to the built-in USB
    // keyboard if the machine has one, else to the serial console as a terminal sends them.
    if (text && !text.live()) {
      if (text.usb?.(name, down)) return true;
      const bytes = terminalBytes(e);
      if (bytes === null) return false;
      if (down) text.send(bytes);
      return true;
    }
    const code = KEYS.get(name);
    if (!keyboard || code === undefined) return false;
    if (!down && !keys.has(code)) return true; // pressed elsewhere, or released already on a blur
    // The browser's repeats aren't the guest's: the keyboard has EV_REP, so the guest's kernel repeats a held key itself
    // (as QEMU's does; forwarded, a held key on a console repeated twice as fast).
    if (down && e.repeat && keys.has(code)) return true;
    sendKey(code, down ? 1 : 0);
    return true;
  };
  /**
   * Who holds each key down: the screen's own key events, the on-screen keyboard, the Keys menu, Hold Esc. A key goes
   * down with its first holder and up with its last: one letting go doesn't release it for another (a Shift latched on
   * the on-screen keyboard outlives the physical Shift's press).
   */
  const holders = new Map<string, Set<KeySource>>();
  /** Key `name` down or up from `from`: whether the guest took it (or it's held already). */
  const press = (name: string, down: boolean, e: KeyLike, from: KeySource): boolean => {
    const h = holders.get(name);
    if (down) {
      // The same holder's repeat goes on as before (the serial console types it; the keyboard drops it).
      if (h?.has(from)) return deliver(name, true, e);
      if (h) return h.add(from), true;
      holders.set(name, new Set([from]));
      return deliver(name, true, e);
    }
    if (h && !h.delete(from)) return true; // another holds it: still down
    if (h?.size) return true;
    holders.delete(name);
    return deliver(name, false, e);
  };
  const typed: ((code: string) => void)[] = [];
  /**
   * The key `hooks.hold` holds, and the key events that came after it, in order: they wait behind it (a chord's
   * modifiers' releases reach the guest after its key, a second press goes as a second press), but for its own
   * repeats, which go nowhere (the guest's kernel repeats a held key itself).
   */
  type Holding = { code: string; after: { e: KeyboardEvent; down: boolean }[] };
  let holding: Holding | undefined;
  const screenKey = (e: KeyboardEvent, down: boolean) => {
    const took = press(e.code, down, e, 'screen');
    if (!down) for (const f of typed) f(e.code);
    return took;
  };
  const key = (down: number) => (e: KeyboardEvent) => {
    if (holding) {
      if (!(down && e.repeat && e.code === holding.code)) holding.after.push({ e, down: !!down });
      // Its own action now would come before the held key's (a second press: no second paste event).
      e.preventDefault();
      return;
    }
    const wait = down && !e.repeat ? hooks.hold?.(e) : undefined;
    if (wait) {
      // No preventDefault: the browser's own action (its paste event) is what the holder waits for.
      const entry: Holding = { code: e.code, after: [] };
      holding = entry;
      const go = () => {
        if (holding !== entry) return; // released meanwhile (a blur): the keys never went down
        holding = undefined;
        screenKey(e, true);
        for (const a of entry.after) screenKey(a.e, a.down);
      };
      wait.then(go, go);
      return;
    }
    if (screenKey(e, !!down)) e.preventDefault();
  };
  const released: (() => void)[] = [];
  const at = (v: number, len: number) => Math.max(0, Math.min(32767, Math.round((v / len) * 32767)));
  /** Where the tablet is (0–32767): the pointer's last place, and while the mouse is locked in the `pointer` mode, the page's cursor. */
  const spot = { x: 16384, y: 16384 };
  const abs = (e: MouseEvent) => {
    const r = el.getBoundingClientRect();
    [spot.x, spot.y] = [at(e.clientX - r.left, r.width), at(e.clientY - r.top, r.height)];
    return [[EV_ABS, 0, spot.x], [EV_ABS, 1, spot.y]];
  };
  const { mouse, touch } = pointers;
  const locked = () => document.pointerLockElement === el;
  let lockOn = false;
  let lockMode: LockMode = 'pointer';
  /** The locked mouse is the relative mouse's. */
  const raw = () => locked() && lockMode === 'raw' && !!mouse;
  // The buttons as the guest sees them, and the port they were pressed on (the tablet, or the mouse while locked).
  const buttons = new Set<number>();
  let buttonsOn: MessagePort | undefined;
  /** Buttons held from before the lock (the click that took it): not the guest's until released. */
  let ignored = 0;
  /** What a pointer event moves: the tablet to the pointer; while locked, the tablet by the motion (`pointer`) or the mouse (`raw`). */
  const motion = (e: PointerEvent): { port?: MessagePort; events: number[][] } => {
    if (!locked()) return { port: tablet, events: abs(e) };
    if (raw()) return { port: mouse, events: [...(e.movementX ? [[EV_REL, 0, e.movementX]] : []), ...(e.movementY ? [[EV_REL, 1, e.movementY]] : [])] };
    const r = el.getBoundingClientRect();
    spot.x = Math.max(0, Math.min(32767, Math.round(spot.x + (e.movementX / r.width) * 32767)));
    spot.y = Math.max(0, Math.min(32767, Math.round(spot.y + (e.movementY / r.height) * 32767)));
    return { port: tablet, events: [[EV_ABS, 0, spot.x], [EV_ABS, 1, spot.y]] };
  };
  const releaseButtons = () => {
    if (buttons.size) buttonsOn?.postMessage([...[...buttons].map((b) => [EV_KEY, b, 0]), [EV_SYN, 0, 0]]);
    buttons.clear();
  };
  /** A mouse's (or a pen's) event: the motion and the buttons that changed, from `buttons` (a second button pressed while one is held comes as a move). */
  const pointer = (e: PointerEvent) => {
    const { port, events } = motion(e);
    if (!port) return;
    if (port !== buttonsOn) releaseButtons();
    buttonsOn = port;
    ignored &= e.buttons;
    for (const [bit, b] of BUTTON_BITS) {
      const down = (e.buttons & bit & ~ignored) !== 0;
      if (down === buttons.has(b)) continue;
      if (down) buttons.add(b);
      else buttons.delete(b);
      events.push([EV_KEY, b, down ? 1 : 0]);
    }
    if (events.length) port.postMessage([...events, [EV_SYN, 0, 0]]);
  };
  // The touchscreen: each finger a slot (by pointer id), the first one also the single-touch position and BTN_TOUCH.
  const fingers = new Map<number, number>();
  let tracking = 0;
  const finger = (e: PointerEvent, phase: 'down' | 'move' | 'up') => {
    const r = el.getBoundingClientRect();
    const [x, y] = [at(e.clientX - r.left, r.width), at(e.clientY - r.top, r.height)];
    let slot = fingers.get(e.pointerId);
    const ev: number[][] = [];
    if (phase === 'down') {
      if (slot !== undefined) return;
      slot = Array.from({ length: TOUCH_SLOTS }, (_, k) => k).find((k) => ![...fingers.values()].includes(k));
      if (slot === undefined) return; // more fingers than slots
      fingers.set(e.pointerId, slot);
      ev.push([EV_ABS, ABS_MT_SLOT, slot], [EV_ABS, ABS_MT_TRACKING_ID, tracking], [EV_ABS, ABS_MT_POSITION_X, x], [EV_ABS, ABS_MT_POSITION_Y, y]);
      tracking = (tracking + 1) & 0xffff;
      if (fingers.size === 1) ev.push([EV_KEY, BTN_TOUCH, 1]);
    } else if (slot === undefined) {
      return;
    } else if (phase === 'move') {
      ev.push([EV_ABS, ABS_MT_SLOT, slot], [EV_ABS, ABS_MT_POSITION_X, x], [EV_ABS, ABS_MT_POSITION_Y, y]);
    } else {
      fingers.delete(e.pointerId);
      ev.push([EV_ABS, ABS_MT_SLOT, slot], [EV_ABS, ABS_MT_TRACKING_ID, -1]);
      if (!fingers.size) ev.push([EV_KEY, BTN_TOUCH, 0]);
    }
    if (e.isPrimary && phase !== 'up') ev.push([EV_ABS, 0, x], [EV_ABS, 1, y]);
    touch!.postMessage([...ev, [EV_SYN, 0, 0]]);
  };
  const liftFingers = () => {
    if (!fingers.size) return;
    touch!.postMessage([...[...fingers.values()].flatMap((slot) => [[EV_ABS, ABS_MT_SLOT, slot], [EV_ABS, ABS_MT_TRACKING_ID, -1]]), [EV_KEY, BTN_TOUCH, 0], [EV_SYN, 0, 0]]);
    fingers.clear();
  };
  const touched = (e: PointerEvent) => !!touch && e.pointerType === 'touch';
  /**
   * Without a touchscreen, only a finger that lands on the element with no other finger on it is the tablet's (another
   * would move it there and lift its button): `tabletTouch`, its pointer, among `onEl`, the fingers on the element. The
   * page's other fingers don't count (one on the on-screen keyboard).
   */
  let tabletTouch: number | undefined;
  const onEl = new Set<number>();
  const stray = (e: PointerEvent, phase: 'down' | 'move' | 'up') => {
    if (touch || e.pointerType !== 'touch') return false;
    if (phase === 'down') {
      if (!onEl.size) tabletTouch = e.pointerId;
      onEl.add(e.pointerId);
    }
    const mine = e.pointerId === tabletTouch;
    if (phase === 'up') {
      onEl.delete(e.pointerId);
      if (mine) tabletTouch = undefined;
    }
    return !mine;
  };
  /** The wheel's motion not yet a notch (CSS pixels; reset when it turns). */
  let wheelPx = 0;
  const takeMouse = () => {
    // The pointer mode moves as the host's pointer does (the browser's motion is accelerated as it is).
    // A refusal (the browser's: too soon after Esc, no gesture) leaves the mouse the page's: the next click asks again.
    const ask = () => Promise.resolve(el.requestPointerLock()).catch(() => {});
    if (lockMode !== 'raw' || !mouse) return void ask();
    // Raw, unadjusted: the mouse's own counts, without the host's acceleration (the guest has its own); not every platform has it.
    const req = el.requestPointerLock as (o?: { unadjustedMovement?: boolean }) => Promise<void> | undefined;
    try {
      req.call(el, { unadjustedMovement: true })?.catch(ask);
    } catch {
      void ask();
    }
  };
  const releaseAll = () => {
    holding = undefined;
    holders.clear();
    tabletTouch = undefined;
    onEl.clear();
    text?.usb?.('', false);
    for (const code of [...keys].reverse()) sendKey(code, 0);
    releaseButtons();
    if (touch) liftFingers();
    for (const f of released) f();
  };
  // A mouse's back and forward buttons: the guest's, not the browser's history (Chromium navigates on an uncancelled mouseup).
  const sideButton = (e: MouseEvent) => {
    if (e.button === 3 || e.button === 4) e.preventDefault();
  };
  const off = [
    on(el, 'keydown', key(1)),
    on(el, 'keyup', key(0)),
    on(el, 'pointerdown', (e: PointerEvent) => {
      if (touched(e)) return finger(e, 'down');
      if (stray(e, 'down')) return;
      if (lockOn && !locked() && e.pointerType === 'mouse') {
        // The click that takes the mouse isn't the guest's.
        ignored = e.buttons;
        el.focus();
        takeMouse();
        return;
      }
      if (!locked()) el.setPointerCapture(e.pointerId); // a drag that leaves the screen still ends here (a locked pointer can't be captured)
      pointer(e);
    }),
    on(el, 'pointerup', (e: PointerEvent) => (touched(e) ? finger(e, 'up') : stray(e, 'up') || pointer(e))),
    // A cancelled pointer (the browser took a touch, a pen left) sends no up: what it held is released.
    on(el, 'pointercancel', (e: PointerEvent) => (touched(e) ? finger(e, 'up') : stray(e, 'up') || releaseButtons())),
    on(el, 'pointermove', (e: PointerEvent) => (touched(e) ? finger(e, 'move') : stray(e, 'move') || pointer(e))),
    on(el, 'mousedown', sideButton),
    on(el, 'mouseup', sideButton),
    on(el, 'auxclick', sideButton),
    on(el, 'wheel', (e: WheelEvent) => {
      const port = raw() ? mouse : tablet;
      if (!port || !e.deltaY) return;
      e.preventDefault();
      // Lines and pages (Firefox's deltaMode 1, 2) are a notch each; pixels add up to one (a notch per event at most).
      const px = e.deltaMode === 0 ? e.deltaY : Math.sign(e.deltaY) * NOTCH_PX;
      wheelPx = Math.sign(px) === Math.sign(wheelPx) ? wheelPx + px : px;
      if (Math.abs(wheelPx) < NOTCH_PX) return;
      port.postMessage([[EV_REL, 8, wheelPx < 0 ? 1 : -1], [EV_SYN, 0, 0]]);
      wheelPx = 0;
    }),
    on(el, 'contextmenu', (e: Event) => e.preventDefault()),
    on(el, 'blur', releaseAll),
    on(window, 'blur', releaseAll),
    on(document, 'visibilitychange', () => document.hidden && releaseAll()),
    // Taking the mouse or letting it go moves the buttons to the other device: what was held is released first.
    on(document, 'pointerlockchange', () => {
      releaseButtons();
      pointers.locked?.(locked());
    }),
  ];
  return {
    detach() {
      releaseAll();
      if (locked()) document.exitPointerLock();
      off.forEach((f) => f());
      pointers.locked?.(false); // its pointerlockchange comes after the listener is gone
    },
    mouseLock(on: boolean, mode = lockMode) {
      if (locked() && (!on || mode !== lockMode)) document.exitPointerLock();
      [lockOn, lockMode] = [on, mode];
    },
    key(code: string, down: boolean, event: KeyLike, from: KeySource = 'osk') {
      press(code, down, event, from);
    },
    onRelease(f: () => void) {
      released.push(f);
    },
    onTyped(f: (code: string) => void) {
      typed.push(f);
    },
    release: releaseAll,
    chord(...codes: string[]) {
      const has = (side: string) => codes.some((c) => c.startsWith(side));
      const e: KeyLike = { key: '', ctrlKey: has('Control'), altKey: has('Alt'), metaKey: has('Meta') };
      for (const c of codes) press(c, true, { ...e, key: keyName(c, has('Shift')) }, 'menu');
      for (const c of [...codes].reverse()) press(c, false, { ...e, key: keyName(c, has('Shift')) }, 'menu');
    },
  };
}
