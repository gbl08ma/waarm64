// The keys and the mouse the toolbar and the on-screen keyboard send (docs/frontend.md "Input", "The on-screen
// keyboard", "Mouse lock"; web/app/page.ts's `chord`, `holdKey`, `oskKey`, `showOsk`, `setMouseLock`).
import type { LockMode } from '../../input.ts';
import { eventOf, keymapOf, keyOf, type Mods } from '../osk.ts';
import type { Page } from '../page.ts';
import { remember } from '../settings.ts';
import type { PageMachine } from '../run/page-machine.svelte.ts';
import type { Runner } from '../run/runner.ts';
import { keys } from './keys.svelte.ts';
import { mouse } from './mouse.svelte.ts';
import { screen } from './screen.svelte.ts';
import type { ScreenView } from './screen-view.ts';
import type { SerialTerminal } from './serial-terminal.ts';

type KeysPage = Pick<Page, 'chord' | 'holdKey' | 'oskKey' | 'showOsk' | 'setMouseLock'>;

export class KeysActions {
  readonly #m: PageMachine;
  readonly #runner: Runner;
  readonly #screen: ScreenView;
  readonly #terminal: SerialTerminal;
  /** Hold Esc's key held now: its timer, and its release. */
  #holding: { timer: ReturnType<typeof setTimeout>; up: () => void } | undefined;

  constructor(d: { machine: PageMachine; runner: Runner; screen: ScreenView; terminal: SerialTerminal }) {
    [this.#m, this.#runner, this.#screen, this.#terminal] = [d.machine, d.runner, d.screen, d.terminal];
  }

  /** The screen takes the focus, and a sleeping guest wakes. */
  #toScreen() {
    this.#screen.canvas.focus();
    this.#runner.wake();
  }

  #hold(code: string, ms: number) {
    this.#toScreen();
    const r = this.#m.run;
    if (!r) return;
    const e = { key: keyOf(code, false), ctrlKey: false, altKey: false, metaKey: false };
    // A hold while one runs: the earlier ends now (one timer, one holder).
    if (this.#holding) {
      clearTimeout(this.#holding.timer);
      this.#holding.up();
    }
    r.input.key(code, true, e, 'hold');
    const up = () => {
      this.#holding = undefined;
      r.input.key(code, false, e, 'hold');
    };
    this.#holding = { timer: setTimeout(up, ms), up };
  }

  #oskKey(code: string, down: boolean, m: Mods, repeat: boolean) {
    const e = { ...eventOf(code, m, keymapOf(keys.layout)), repeat };
    // A key goes where it went down: the terminal (it has the focus: the terminal's view, or both views with the
    // terminal last clicked) or the screen's keys. The terminal types it as xterm.js does its own keys.
    if (this.#terminal.oskKey(code, down, e)) return;
    if (down) this.#runner.wake();
    this.#m.run?.input.key(code, down, e, 'osk');
  }

  page(): KeysPage {
    return {
      chord: (k) => {
        this.#toScreen();
        this.#m.run?.input.chord(...k);
      },
      holdKey: (code, ms) => this.#hold(code, ms),
      oskKey: (code, down, m, repeat = false) => this.#oskKey(code, down, m, repeat),
      showOsk: (on) => {
        keys.osk = on;
        // The view's input keeps (or takes) the focus: the terminal in its view, or in both views when it has it.
        if (on && !this.#terminal.focused())
          (screen.view === 'terminal' ? this.#terminal.term : this.#screen.canvas).focus();
      },
      setMouseLock: (on: boolean, mode: LockMode = mouse.mode) => {
        [mouse.lock, mouse.mode] = [on, mode];
        remember({ mouseLock: on, mouseLockMode: mode });
        this.#m.run?.input.mouseLock(on, mode);
        if (on) this.#screen.canvas.focus();
      },
    };
  }
}
