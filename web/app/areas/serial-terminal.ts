// The serial terminal (docs/frontend.md "Views"): xterm.js on the PL011, the serial console's log a user can copy or
// save, and the boot card's line from it. The PL011 has no size negotiation: the guest assumes 80×24 unless told
// (`stty`); the firmware's console is 80×25 (images/build.sh edk2 offers no other mode), so the terminal has 25 rows.
// Once an agent that sets the serial console's size says HELLO (CONSOLE, docs/devices.md "The serial console's
// size"), the terminal fits its box instead (`follow`), and each size it takes is the guest's too.
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { t } from '../../i18n.ts';
import { terminalBytes, type KeyLike } from '../../input.ts';
import { bootCard } from './boot-card.svelte.ts';
import { keys } from './keys.svelte.ts';
import { screen } from './screen.svelte.ts';
import type { Action } from './message-bar.svelte.ts';

/** The size without an agent that sets the guest's: the firmware's console, and what a Linux guest assumes. */
const COLS = 80;
const ROWS = 25;
/** The least a fitted terminal takes, in a box too small for more. */
const MIN_COLS = 20;
const MIN_ROWS = 5;
/** A size is told once the box has kept it this long (a window dragged makes many). */
const SETTLE_MS = 150;

/** The log kept: past twice this, its older half goes (the terminal's scrollback is shorter). */
const LOG_MAX = 1 << 20;
// eslint-disable-next-line no-control-regex -- an escape sequence is what it takes out
const ESCAPES = /\x1b\[[0-9;?]*[A-Za-z]/g;

export class SerialTerminal {
  readonly term = new Terminal({
    cols: COLS,
    rows: ROWS,
    convertEol: false,
    scrollback: 5000,
    fontFamily: 'ui-monospace, "DejaVu Sans Mono", Menlo, monospace',
    fontSize: 14,
    theme: { background: '#0b0d10' },
  });
  /** The serial console's output, kept for the log. */
  log = '';
  /** The boot card's line so far. */
  #lastLine = '';
  /** xterm.js answers a query in the text (a cursor position request) while it parses it: the guest didn't ask. */
  #replaying = false;
  /** The on-screen keyboard's keys down into the terminal (their ups go there too). */
  readonly #oskKeys = new Set<string>();
  readonly #fit = new FitAddon();
  /** The terminal's box (`open`'s). */
  #el?: HTMLElement;
  /** Fitting its box: where each size goes (`follow`); none: the size last told, or 80×25. */
  #tell?: (cols: number, rows: number) => void;
  #settle?: ReturnType<typeof setTimeout>;
  /** The size last told this run (the guest's tty keeps it). */
  #said?: { cols: number; rows: number };

  /** Opens the terminal in `el`; what's typed in it goes to `send` (xterm.js sends what a terminal would: \r for Enter, escape sequences). */
  open(el: HTMLElement, send: (d: string) => void) {
    this.#el = el;
    this.term.loadAddon(this.#fit);
    this.term.open(el);
    // The fit at the next frame: a resize inside the observer's callback changes the layout it is observing (a
    // ResizeObserver loop, while Both's divider is dragged).
    let frame = 0;
    new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => this.#refit());
    }).observe(el);
    this.term.onResize(({ cols, rows }) => {
      el.dataset.size = `${cols}x${rows}`; // the tests' to read
      this.#told();
    });
    el.dataset.size = `${this.term.cols}x${this.term.rows}`;
    // A key typed on the physical keyboard into the terminal ends the on-screen keyboard's latches, as one into the screen does.
    this.term.textarea?.addEventListener('keyup', (e) => {
      keys.typed.emit(e.code);
    });
    this.term.onData((d) => {
      if (!this.#replaying) send(d);
    });
  }

  /**
   * The terminal fits its box while `tell` is given (an agent that sets the serial console's size said HELLO), each size
   * it takes told to it, the first at once. Without, it stops fitting and keeps the size last told: the guest's tty
   * keeps it past the agent's connection (a restart, the agent stopped), so the terminal still shows what the guest was
   * told; 80×25 until one was (`unfit`: a new run).
   */
  follow(tell: ((cols: number, rows: number) => void) | undefined) {
    this.#tell = tell;
    clearTimeout(this.#settle);
    if (this.#el) {
      if (tell) this.#el.dataset.fit = '';
      else delete this.#el.dataset.fit;
    }
    if (!tell) {
      const { cols, rows } = this.#said ?? { cols: COLS, rows: ROWS };
      if (this.term.cols !== cols || this.term.rows !== rows) this.term.resize(cols, rows);
      return;
    }
    this.#refit();
    this.#say(this.term.cols, this.term.rows);
  }

  /** The run's end: no guest has been told a size, so the terminal is 80×25 again (the firmware's, the boot's). */
  unfit() {
    this.#said = undefined;
    this.follow(undefined);
  }

  #say(cols: number, rows: number) {
    if (!this.#tell) return;
    this.#said = { cols, rows };
    this.#tell(cols, rows);
  }

  /**
   * The box's size in cells, taken while fitting (none while it isn't shown: its view hidden). Beside the screen (Both)
   * only its rows: its width is its content's there, so the screen's room stays what it was (and a fit of it would
   * shrink it with every fit); stacked under the screen, 80×25. Both ways once the user moved Both's divider: the
   * terminal's share is then the divider's, not its content's.
   */
  #refit() {
    if (!this.#tell) return;
    const d = this.#fit.proposeDimensions();
    if (!d || !Number.isFinite(d.cols) || !Number.isFinite(d.rows) || d.cols <= 0 || d.rows <= 0) return;
    const main = this.#el?.closest('main');
    const stacked = !!main && getComputedStyle(main).flexDirection === 'column';
    const both = screen.view === 'both' && screen.split[stacked ? 'stacked' : 'across'] === undefined;
    const cols = both ? COLS : Math.max(MIN_COLS, d.cols);
    const rows = both && stacked ? ROWS : Math.max(MIN_ROWS, d.rows);
    if (cols !== this.term.cols || rows !== this.term.rows) this.term.resize(cols, rows);
  }

  /** The terminal took a size while fitting: told once it settles. */
  #told() {
    if (!this.#tell) return;
    clearTimeout(this.#settle);
    this.#settle = setTimeout(() => this.#say(this.term.cols, this.term.rows), SETTLE_MS);
  }

  /** A new run: its log starts empty. */
  clear() {
    this.log = this.#lastLine = '';
  }

  /** The guest's output (`replay`: a restored machine's screen, written again). */
  write(data: string, replay = false) {
    if (replay) {
      this.#replaying = true;
      this.term.write(data, () => {
        this.#replaying = false;
      });
    } else this.term.write(data);
    this.#addLog(data);
  }

  #addLog(text: string) {
    this.log += text;
    if (this.log.length > 2 * LOG_MAX) this.log = this.log.slice(-LOG_MAX);
    if (!bootCard.shown) return;
    const lines = (this.#lastLine + text).split(/\r?\n/);
    this.#lastLine = lines.pop() ?? '';
    const shown = lines.reverse().find((l) => l.trim());
    if (shown !== undefined) bootCard.line = shown.replace(ESCAPES, '').trim();
  }

  /** The terminal has the focus (its view, or both views with it last clicked): the on-screen keyboard types into it. */
  focused() {
    return screen.view !== 'screen' && !!this.term.textarea && this.term.textarea === document.activeElement;
  }

  /** The on-screen keyboard's key, if it goes to the terminal (where it went down): typed as xterm.js does its own. */
  oskKey(code: string, down: boolean, e: KeyLike) {
    const here = down ? this.focused() : this.#oskKeys.has(code);
    if (!down) this.#oskKeys.delete(code);
    else if (here) this.#oskKeys.add(code);
    if (!here) return false;
    const bytes = down ? terminalBytes(e) : null;
    if (bytes !== null) this.term.input(bytes, true);
    return true;
  }

  /** The message bar's actions on the log: show it (`show` opens the terminal's view), copy it, save it as `machine`'s. */
  actions(show: () => void, machine: string): Record<'show' | 'copy' | 'save', Action> {
    return {
      show: {
        label: t('machine:serial-terminal.showLog'),
        run: () => {
          show();
          this.term.scrollToBottom();
        },
      },
      copy: {
        label: t('machine:serial-terminal.copyLog'),
        run: (b) =>
          void navigator.clipboard.writeText(this.log).then(
            () => {
              b.textContent = t('machine:serial-terminal.copyLog.copied');
            },
            () => {
              b.textContent = t('machine:serial-terminal.copyLog.failed');
            },
          ),
      },
      save: {
        label: t('machine:serial-terminal.saveLog'),
        run: () => {
          const a = Object.assign(document.createElement('a'), {
            href: URL.createObjectURL(new Blob([this.log], { type: 'text/plain' })),
            download: `waarm64-${machine}-serial-${new Date().toISOString().replace(/[:.]/g, '-')}.log`,
          });
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
        },
      },
    };
  }
}
