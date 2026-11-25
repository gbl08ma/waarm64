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
  ...ROW(
    'Numpad7 Numpad8 Numpad9 NumpadSubtract Numpad4 Numpad5 Numpad6 NumpadAdd Numpad1 Numpad2 Numpad3 Numpad0 NumpadDecimal',
    71,
  ),
  ['IntlBackslash', 86],
  ['F11', 87],
  ['F12', 88],
  ['NumpadEnter', 96],
  ['ControlRight', 97],
  ['NumpadDivide', 98],
  ['PrintScreen', 99],
  ['AltRight', 100],
  ['Home', 102],
  ['ArrowUp', 103],
  ['PageUp', 104],
  ['ArrowLeft', 105],
  ['ArrowRight', 106],
  ['End', 107],
  ['ArrowDown', 108],
  ['PageDown', 109],
  ['Insert', 110],
  ['Delete', 111],
  ['Pause', 119],
  ['MetaLeft', 125],
  ['MetaRight', 126],
  ['ContextMenu', 127],
  // Keys a US keyboard lacks (ABNT2's and JIS's; the guest's layout gives them characters: web/app/keyboard.ts).
  ['IntlRo', 89],
  ['Convert', 92],
  ['KanaMode', 93],
  ['NonConvert', 94],
  ['Lang1', 122],
  ['Lang2', 123],
  ['IntlYen', 124],
  // Keys past a PC's 105 (the keyboard advertises every code to KEY_MICMUTE): the numpad's extras, F13 to F24, media keys.
  ['NumpadEqual', 117],
  ['NumpadComma', 121],
  ...ROW('F13 F14 F15 F16 F17 F18 F19 F20 F21 F22 F23 F24', 183),
  ['AudioVolumeMute', 113],
  ['AudioVolumeDown', 114],
  ['AudioVolumeUp', 115],
  ['MediaTrackNext', 163],
  ['MediaPlayPause', 164],
  ['MediaTrackPrevious', 165],
  ['MediaStop', 166],
  // The power keys (systemd-logind powers off, suspends on them); nothing of the page's presses them by itself.
  ['Power', 116],
  ['Sleep', 142],
  ['WakeUp', 143],
]);
// `PointerEvent.buttons`' bits: left, right, middle, back, forward → BTN_LEFT, BTN_RIGHT, BTN_MIDDLE, BTN_SIDE, BTN_EXTRA.
const BUTTON_BITS = [
  [1, 0x110],
  [2, 0x111],
  [4, 0x112],
  [8, 0x113],
  [16, 0x114],
] as const;
const BTN_TOUCH = 0x14a;
const ABS_MT_SLOT = 0x2f,
  ABS_MT_POSITION_X = 0x35,
  ABS_MT_POSITION_Y = 0x36,
  ABS_MT_TRACKING_ID = 0x39;
/** The touchscreen's slots (web/input-device.ts `TOUCH_SLOTS`). */
const TOUCH_SLOTS = 10;
/** A wheel's notch (REL_WHEEL 1, REL_WHEEL_HI_RES 120) in CSS pixels: a mouse's notch comes as one event of at least this, a touchpad's motion as many small ones, summed. */
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
   * Holds the guest's input (on) or lets it through again (off): while held, what's held is released and the element's
   * keys, pointer, wheel and touches go nowhere, so nothing arrives while the machine is paused for a save
   * (docs/frontend.md "Snapshots").
   */
  hold(on: boolean): void;
  /** Whether the input is held (`hold`). */
  held(): boolean;
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
/** A Linux input event as virtio-input's ports carry them: [type, code, value] (a frame is a list of them). */
export type EvdevEvent = readonly [type: number, code: number, value: number];
/** `attachInput`'s ends and hooks: virtio-input's ports (`keyboard`, `tablet`, the `Pointers`), `text`, `hold`. */
export type InputOptions = Pointers & {
  keyboard?: MessagePort;
  tablet?: MessagePort;
  text?: { live: () => boolean; send: (bytes: string) => void; usb?: (code: string, down: boolean) => boolean };
  hold?: (e: KeyboardEvent) => Promise<void> | undefined;
  /** The host is Windows (its AltGr comes as a left Ctrl and a right Alt: `altGrFilter`); the browser's own by default. */
  windows?: boolean;
};

const CSI: Record<string, string> = {
  ArrowUp: '\x1b[A',
  ArrowDown: '\x1b[B',
  ArrowRight: '\x1b[C',
  ArrowLeft: '\x1b[D',
  Home: '\x1b[H',
  End: '\x1b[F',
  PageUp: '\x1b[5~',
  PageDown: '\x1b[6~',
  Insert: '\x1b[2~',
  Delete: '\x1b[3~',
  F1: '\x1bOP',
  F2: '\x1bOQ',
  F3: '\x1bOR',
  F4: '\x1bOS',
  F5: '\x1b[15~',
  F6: '\x1b[17~',
  F7: '\x1b[18~',
  F8: '\x1b[19~',
  F9: '\x1b[20~',
  F10: '\x1b[21~',
  F11: '\x1b[23~',
  F12: '\x1b[24~',
};

/** What a key event says beside its code: its `key` (the character or the key's name) and the modifiers down with it. */
export type KeyLike = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'metaKey'> & { repeat?: boolean };

/** Who presses a key (web/input.ts `attachInput` keeps who holds each): the screen's key events, the on-screen keyboard, the Keys menu's combinations, Hold Esc. */
export type KeySource = 'screen' | 'osk' | 'menu' | 'hold';

/** A `KeyboardEvent.key` for code `code` on a US keyboard, as a terminal reads it (a letter or digit, else the code: `Escape`, `Tab`, `F4`). */
const keyName = (code: string, shift: boolean) =>
  /^Key[A-Z]$/.test(code) ? (shift ? code[3] : code[3].toLowerCase()) : /^Digit\d$/.test(code) ? code[5] : code;

/** Key `code`'s (a `KeyboardEvent.code` name) Linux keycode, if the guest's keyboard has it. */
export const codeOf = (code: string) => KEYS.get(code);

/** What a terminal sends for a key event (what EDK2's and GRUB's serial console read), or null for one that sends nothing (a modifier, an unknown key). */
export function terminalBytes(e: KeyLike): string | null {
  if (e.metaKey) return null;
  const special =
    CSI[e.key] ?? ({ Enter: '\r', Backspace: '\x7f', Tab: '\t', Escape: '\x1b' } as Record<string, string>)[e.key];
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

/** An element's place and size on the page (CSS pixels), as `getBoundingClientRect` gives it. */
type Box = Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>;

/**
 * `el`'s box as the pointer reads it: read once (a layout read, forced if anything dirtied the layout), then kept until
 * something can have moved or resized it: a resize of the element or of an ancestor (they position it), a scroll
 * anywhere (captured), the window's resize, fullscreen, or `stale` (`attachInput` calls it at each pointerenter and
 * pointerdown, for what nothing observes: a transform). `detach` lets go of the observer and the listeners.
 */
export function boxCache(el: HTMLElement) {
  let box: Box | undefined;
  const stale = () => {
    box = undefined;
  };
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(stale) : undefined;
  if (ro) for (let e: HTMLElement | null = el; e; e = e.parentElement) ro.observe(e);
  const capture = { capture: true, passive: true };
  window.addEventListener('resize', stale);
  window.addEventListener('scroll', stale, capture);
  document.addEventListener('fullscreenchange', stale);
  return {
    get: (): Box => (box ??= el.getBoundingClientRect()),
    stale,
    detach() {
      ro?.disconnect();
      window.removeEventListener('resize', stale);
      window.removeEventListener('scroll', stale, capture);
      document.removeEventListener('fullscreenchange', stale);
      box = undefined;
    },
  };
}

/** `v` of `len` (a CSS length across the element) as the tablet's 0–32767. */
const at = (v: number, len: number) => Math.max(0, Math.min(32767, Math.round((v / len) * 32767)));

/** Whether the browser runs on Windows: its client hints' platform, else `navigator.platform`. */
export function onWindows(nav: { platform?: string; userAgentData?: { platform?: string } } | undefined): boolean {
  return /^win/i.test(nav?.userAgentData?.platform ?? nav?.platform ?? '');
}

/** How far apart (ms) Windows' AltGr may put its left Ctrl and its right Alt (Chrome 158 on Windows 10: 0.2 ms). */
export const ALTGR_MS = 50;

/**
 * Windows' AltGr as the guest's: Windows sends AltGr as a left Ctrl and a right Alt, both down with one message time
 * (and both up, and both repeating; Chrome clears ctrlKey on the character itself), so the guest saw Ctrl+AltGr, which the third level doesn't take (AltGr+2 typed
 * no "@" on a Portuguese layout). The Ctrl comes first and says nothing of it (`Control`, AltGraph's state off), so a
 * left Ctrl's press waits up to `ALTGR_MS` for the next key event: a right Alt's press within that whose key is
 * `AltGraph` is AltGr, and the Ctrl goes nowhere, nor its repeats and release; anything else, or the wait's end, lets it
 * go on first. `next` takes the events that go on; `reset` (a release) drops a waiting Ctrl.
 */
export function altGrFilter(
  next: (e: KeyboardEvent, down: number) => void,
  timer: { set: (f: () => void, ms: number) => unknown; clear: (t: unknown) => void } = {
    set: (f, ms) => setTimeout(f, ms),
    clear: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  },
) {
  let waiting: { e: KeyboardEvent; t: unknown } | undefined;
  let fake = false;
  const flush = () => {
    const w = waiting;
    waiting = undefined;
    if (w) next(w.e, 1);
  };
  return {
    key: (down: number) => (e: KeyboardEvent) => {
      if (waiting) {
        const w = waiting;
        timer.clear(w.t);
        // AltGr's right Alt says so (`AltGraph`; a layout without AltGr gets no Ctrl from Windows, and its right Alt is `Alt`).
        if (
          down &&
          e.code === 'AltRight' &&
          e.key === 'AltGraph' &&
          Math.abs(e.timeStamp - w.e.timeStamp) <= ALTGR_MS
        ) {
          waiting = undefined;
          fake = true;
        } else flush();
      }
      if (e.code === 'ControlLeft') {
        if (fake) {
          if (!down) fake = false;
          e.preventDefault();
          return;
        }
        if (down && !e.repeat) {
          e.preventDefault();
          waiting = { e, t: timer.set(flush, ALTGR_MS) };
          return;
        }
      }
      next(e, down);
    },
    reset() {
      if (waiting) timer.clear(waiting.t);
      waiting = undefined;
      fake = false;
    },
  };
}

/**
 * The keys (`attachInput`'s `keyboard` and `text`, `hold`): who holds each, what the guest has down, and the key
 * `hold` holds with the key events that came after it. `key(down)` is the element's listener.
 */
function keyMachine(o: Pick<InputOptions, 'keyboard' | 'text'>, hooks: { hold: InputOptions['hold'] }) {
  const { keyboard, text } = o;
  const keys = new Set<number>(); // held, as the guest sees it
  const sendKey = (code: number, value: number) => {
    if (value === 0) keys.delete(code);
    else keys.add(code);
    keyboard?.postMessage([
      [EV_KEY, code, value],
      [EV_SYN, 0, 0],
    ] satisfies EvdevEvent[]);
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
      if (h) return (h.add(from), true);
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
  return {
    key,
    press,
    typed,
    /** Whether any key is held (by a holder, by the guest, or by `hooks.hold`). */
    held: () => !!holding || holders.size > 0 || keys.size > 0,
    /** Drops the held key and lets go of every key the guest has down. */
    release() {
      holding = undefined;
      holders.clear();
      text?.usb?.('', false);
      for (const code of [...keys].reverse()) sendKey(code, 0);
    },
  };
}

/**
 * The pointer (`attachInput`'s `tablet`, and the `Pointers`' `mouse` and `locked`) and the mouse lock: the tablet to
 * the pointer, or while the element holds the mouse, the tablet by the motion (`pointer`) or the mouse (`raw`); the
 * buttons as the guest sees them, on the port they were pressed on.
 */
function pointerMachine(el: HTMLElement, box: () => Box, tablet: MessagePort | undefined, pointers: Pointers) {
  /** Where the tablet is (0–32767): the pointer's last place, and while the mouse is locked in the `pointer` mode, the page's cursor. */
  const spot = { x: 16384, y: 16384 };
  const abs = (e: MouseEvent): EvdevEvent[] => {
    const r = box();
    spot.x = at(e.clientX - r.left, r.width);
    spot.y = at(e.clientY - r.top, r.height);
    return [
      [EV_ABS, 0, spot.x],
      [EV_ABS, 1, spot.y],
    ];
  };
  const { mouse } = pointers;
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
  const motion = (e: PointerEvent): { port?: MessagePort; events: EvdevEvent[] } => {
    if (!locked()) return { port: tablet, events: abs(e) };
    if (raw()) {
      const events: EvdevEvent[] = [];
      if (e.movementX) events.push([EV_REL, 0, e.movementX]);
      if (e.movementY) events.push([EV_REL, 1, e.movementY]);
      return { port: mouse, events };
    }
    const r = box();
    spot.x = Math.max(0, Math.min(32767, Math.round(spot.x + (e.movementX / r.width) * 32767)));
    spot.y = Math.max(0, Math.min(32767, Math.round(spot.y + (e.movementY / r.height) * 32767)));
    return {
      port: tablet,
      events: [
        [EV_ABS, 0, spot.x],
        [EV_ABS, 1, spot.y],
      ],
    };
  };
  const releaseButtons = () => {
    if (buttons.size)
      buttonsOn?.postMessage([
        ...[...buttons].map((b): EvdevEvent => [EV_KEY, b, 0]),
        [EV_SYN, 0, 0],
      ] satisfies EvdevEvent[]);
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
    if (!events.length) return;
    events.push([EV_SYN, 0, 0]);
    port.postMessage(events);
  };
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
  return {
    locked,
    raw,
    pointer,
    /** Whether a button is down, as the guest sees it. */
    held: () => buttons.size > 0,
    releaseButtons,
    /** A mouse's (or a pen's) pointerdown: the click that takes the mouse, or the guest's. */
    down(e: PointerEvent) {
      if (lockOn && !locked() && e.pointerType === 'mouse') {
        // The click that takes the mouse isn't the guest's.
        ignored = e.buttons;
        el.focus();
        takeMouse();
        return;
      }
      if (!locked()) el.setPointerCapture(e.pointerId); // a drag that leaves the screen still ends here (a locked pointer can't be captured)
      pointer(e);
    },
    mouseLock: (on: boolean, mode = lockMode) => {
      if (locked() && (!on || mode !== lockMode)) document.exitPointerLock();
      [lockOn, lockMode] = [on, mode];
    },
  };
}

/**
 * The touches (the `Pointers`' `touch`): with a touchscreen, each finger a slot (by pointer id); the oldest finger
 * down is also the single-touch position (as Linux's pointer emulation, input_mt_report_pointer_emulation, picks it),
 * and BTN_TOUCH is from the first down to the last up. Without one, the fingers that aren't the tablet's (`stray`).
 */
function touchMachine(box: () => Box, touch: MessagePort | undefined) {
  /** The fingers down, oldest first (a Map keeps its insertion order): their slots and last positions. */
  const fingers = new Map<number, { slot: number; x: number; y: number }>();
  let tracking = 0;
  const finger = (e: PointerEvent, phase: 'down' | 'move' | 'up') => {
    const r = box();
    const x = at(e.clientX - r.left, r.width);
    const y = at(e.clientY - r.top, r.height);
    const lead = fingers.keys().next().value;
    let f = fingers.get(e.pointerId);
    const ev: EvdevEvent[] = [];
    if (phase === 'down') {
      if (f) return;
      const used = new Set([...fingers.values()].map((g) => g.slot));
      const slot = Array.from({ length: TOUCH_SLOTS }, (_, k) => k).find((k) => !used.has(k));
      if (slot === undefined) return; // more fingers than slots
      fingers.set(e.pointerId, (f = { slot, x, y }));
      ev.push(
        [EV_ABS, ABS_MT_SLOT, slot],
        [EV_ABS, ABS_MT_TRACKING_ID, tracking],
        [EV_ABS, ABS_MT_POSITION_X, x],
        [EV_ABS, ABS_MT_POSITION_Y, y],
      );
      tracking = (tracking + 1) & 0xffff;
      if (fingers.size === 1) ev.push([EV_KEY, BTN_TOUCH, 1]);
    } else if (!f) {
      return;
    } else if (phase === 'move') {
      [f.x, f.y] = [x, y];
      ev.push([EV_ABS, ABS_MT_SLOT, f.slot], [EV_ABS, ABS_MT_POSITION_X, x], [EV_ABS, ABS_MT_POSITION_Y, y]);
    } else {
      fingers.delete(e.pointerId);
      ev.push([EV_ABS, ABS_MT_SLOT, f.slot], [EV_ABS, ABS_MT_TRACKING_ID, -1]);
      if (!fingers.size) ev.push([EV_KEY, BTN_TOUCH, 0]);
    }
    // The single-touch position: the oldest finger's, when it moved or when it lifted and the next oldest took over.
    const now = fingers.keys().next().value;
    const p = now === undefined ? undefined : fingers.get(now);
    if (p && (now !== lead || now === e.pointerId)) ev.push([EV_ABS, 0, p.x], [EV_ABS, 1, p.y]);
    ev.push([EV_SYN, 0, 0]);
    touch!.postMessage(ev);
  };
  const liftFingers = () => {
    if (!fingers.size) return;
    touch!.postMessage([
      ...[...fingers.values()].flatMap(({ slot }): EvdevEvent[] => [
        [EV_ABS, ABS_MT_SLOT, slot],
        [EV_ABS, ABS_MT_TRACKING_ID, -1],
      ]),
      [EV_KEY, BTN_TOUCH, 0],
      [EV_SYN, 0, 0],
    ] satisfies EvdevEvent[]);
    fingers.clear();
  };
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
  return {
    finger,
    stray,
    /** The touchscreen's (`finger` takes it). */
    touched: (e: PointerEvent) => !!touch && e.pointerType === 'touch',
    /** Whether a finger is down (the touchscreen's, or one on the element without one). */
    held: () => fingers.size > 0 || onEl.size > 0,
    /** Forgets the fingers on the element, and lifts the touchscreen's. */
    release() {
      tabletTouch = undefined;
      onEl.clear();
      if (touch) liftFingers();
    },
  };
}

/**
 * The wheel: vertical, REL_WHEEL and REL_WHEEL_HI_RES, up positive (deltaY's opposite); horizontal, REL_HWHEEL and
 * REL_HWHEEL_HI_RES, right positive. `turn` gives a wheel event's events (none: no notch's worth yet).
 */
function wheelMachine() {
  /** Each wheel's motion (vertical, horizontal) since it last turned: high-resolution units (120 a notch) not yet sent, and sent but not yet a notch. */
  const wheels = [
    { rest: 0, units: 0 },
    { rest: 0, units: 0 },
  ];
  return {
    turn(e: WheelEvent): EvdevEvent[] {
      const ev: EvdevEvent[] = [];
      for (const [k, delta, dir, notch, hiRes] of [
        [0, e.deltaY, -1, 8, 11],
        [1, e.deltaX, 1, 6, 12],
      ] as const) {
        if (!delta) continue;
        const w = wheels[k];
        // Lines and pages (Firefox's deltaMode 1, 2) are a notch each; pixels count at 120 units a notch, a notch per event at most.
        // (`rest` counts units × NOTCH_PX, so whole pixels add up exactly.)
        const scaled =
          dir *
          (e.deltaMode === 0 ? Math.max(-NOTCH_PX, Math.min(NOTCH_PX, delta)) : Math.sign(delta) * NOTCH_PX) *
          120;
        if (Math.sign(scaled) !== Math.sign(w.rest + w.units || scaled)) [w.rest, w.units] = [0, 0]; // turning back starts over
        w.rest += scaled;
        const hi = Math.trunc(w.rest / NOTCH_PX);
        if (!hi) continue;
        w.rest -= hi * NOTCH_PX;
        w.units += hi;
        ev.push([EV_REL, hiRes, hi]);
        // The plain wheel's notch when the high-resolution motion makes one (Linux's rule for devices with both).
        if (Math.abs(w.units) >= 120) {
          ev.push([EV_REL, notch, Math.sign(w.units)]);
          w.units -= Math.sign(w.units) * 120;
        }
      }
      return ev;
    },
  };
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
 * `hold`: asked at each key down on the element (not a repeat); a promise holds the key: no `preventDefault`, so
 * the browser's own action happens (a paste chord's `paste` event: web/app/clipboard.ts), and the key goes to the guest
 * when the promise settles, and the element's key events that came meanwhile after it, in order (the chord's
 * modifiers' releases among them; its own repeats dropped). A release (a blur) drops the held key and those.
 */
export function attachInput(el: HTMLElement, o: InputOptions = {}): Input {
  const { tablet } = o;
  const pointers: Pointers = { mouse: o.mouse, touch: o.touch, locked: o.locked };
  const hooks = { hold: o.hold };
  const on = <T extends EventTarget, E extends Event>(target: T, type: string, f: (e: E) => void) => {
    target.addEventListener(type, f as EventListener);
    return () => target.removeEventListener(type, f as EventListener);
  };
  const keys = keyMachine(o, hooks);
  const altGr =
    (o.windows ?? onWindows(globalThis.navigator)) ? altGrFilter((e, down) => keys.key(down)(e)) : undefined;
  const box = boxCache(el);
  const ptr = pointerMachine(el, box.get, tablet, pointers);
  const touches = touchMachine(box.get, pointers.touch);
  const wheel = wheelMachine();
  const { mouse } = pointers;
  const released: (() => void)[] = [];
  let held = false;
  /** A listener that does nothing while the input is held (a key's browser action prevented). */
  const unlessHeld =
    <E extends Event>(f: (e: E) => unknown) =>
    (e: E) => {
      if (!held) return void f(e);
      if (e.type.startsWith('key')) e.preventDefault();
    };
  const releaseAll = () => {
    altGr?.reset();
    keys.release();
    ptr.releaseButtons();
    touches.release();
    for (const f of released) f();
  };
  /**
   * The focus lost or the page hidden: what's held is released, once (the element's blur and the window's come one after
   * the other for one focus loss).
   */
  const lost = () => {
    if (keys.held() || ptr.held() || touches.held()) releaseAll();
  };
  // A mouse's back and forward buttons: the guest's, not the browser's history (Chromium navigates on an uncancelled mouseup).
  const sideButton = (e: MouseEvent) => {
    if (e.button === 3 || e.button === 4) e.preventDefault();
  };
  const { finger, stray, touched } = touches;
  const { pointer } = ptr;
  const off = [
    // The box read again at a pointer's arrival and press (before the press's own listener reads it).
    on(el, 'pointerenter', box.stale),
    on(el, 'pointerdown', box.stale),
    on(el, 'keydown', unlessHeld(altGr ? altGr.key(1) : keys.key(1))),
    on(el, 'keyup', unlessHeld(altGr ? altGr.key(0) : keys.key(0))),
    on(
      el,
      'pointerdown',
      unlessHeld((e: PointerEvent) => {
        if (touched(e)) return finger(e, 'down');
        if (stray(e, 'down')) return;
        ptr.down(e);
      }),
    ),
    on(
      el,
      'pointerup',
      unlessHeld((e: PointerEvent) => (touched(e) ? finger(e, 'up') : stray(e, 'up') || pointer(e))),
    ),
    // A cancelled pointer (the browser took a touch, a pen left) sends no up: what it held is released.
    on(el, 'pointercancel', (e: PointerEvent) =>
      touched(e) ? finger(e, 'up') : stray(e, 'up') || ptr.releaseButtons(),
    ),
    on(
      el,
      'pointermove',
      unlessHeld((e: PointerEvent) => (touched(e) ? finger(e, 'move') : stray(e, 'move') || pointer(e))),
    ),
    on(el, 'mousedown', sideButton),
    on(el, 'mouseup', sideButton),
    on(el, 'auxclick', sideButton),
    on(el, 'wheel', (e: WheelEvent) => {
      if (held) return e.preventDefault();
      const port = ptr.raw() ? mouse : tablet;
      if (!port || (!e.deltaY && !e.deltaX)) return;
      e.preventDefault();
      const ev = wheel.turn(e);
      if (!ev.length) return;
      ev.push([EV_SYN, 0, 0]);
      port.postMessage(ev);
    }),
    on(el, 'contextmenu', (e: Event) => e.preventDefault()),
    on(el, 'blur', lost),
    on(window, 'blur', lost),
    on(document, 'visibilitychange', () => document.hidden && lost()),
    // Taking the mouse or letting it go moves the buttons to the other device: what was held is released first.
    on(document, 'pointerlockchange', () => {
      ptr.releaseButtons();
      pointers.locked?.(ptr.locked());
    }),
  ];
  return {
    detach() {
      releaseAll();
      if (ptr.locked()) document.exitPointerLock();
      off.forEach((f) => f());
      box.detach();
      pointers.locked?.(false); // its pointerlockchange comes after the listener is gone
    },
    mouseLock: ptr.mouseLock,
    key(code: string, down: boolean, event: KeyLike, from: KeySource = 'osk') {
      if (!held || !down) keys.press(code, down, event, from);
    },
    onRelease(f: () => void) {
      released.push(f);
    },
    onTyped(f: (code: string) => void) {
      keys.typed.push(f);
    },
    release: releaseAll,
    hold(on: boolean) {
      if (on && !held) releaseAll();
      held = on;
    },
    held: () => held,
    chord(...codes: string[]) {
      const has = (side: string) => codes.some((c) => c.startsWith(side));
      const e: KeyLike = { key: '', ctrlKey: has('Control'), altKey: has('Alt'), metaKey: has('Meta') };
      for (const c of codes) keys.press(c, true, { ...e, key: keyName(c, has('Shift')) }, 'menu');
      for (const c of [...codes].reverse()) keys.press(c, false, { ...e, key: keyName(c, has('Shift')) }, 'menu');
    },
  };
}
