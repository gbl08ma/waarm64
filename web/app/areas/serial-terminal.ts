// The serial terminal (docs/frontend.md "Views"): xterm.js on the PL011, the serial console's log a user can copy or
// save, and the boot card's line from it. The PL011 has no size negotiation: the guest assumes 80×24 unless told
// (`stty`); the firmware's console is 80×25 (images/build.sh edk2 offers no other mode), so the terminal has 25 rows.
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { t } from '../../i18n.ts';
import { terminalBytes, type KeyLike } from '../../input.ts';
import { bootCard } from './boot-card.svelte.ts';
import { keys } from './keys.svelte.ts';
import { screen } from './screen.svelte.ts';
import type { Action } from './message-bar.svelte.ts';

/** The log kept: past twice this, its older half goes (the terminal's scrollback is shorter). */
const LOG_MAX = 1 << 20;
// eslint-disable-next-line no-control-regex -- an escape sequence is what it takes out
const ESCAPES = /\x1b\[[0-9;?]*[A-Za-z]/g;

export class SerialTerminal {
  readonly term = new Terminal({
    cols: 80,
    rows: 25,
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

  /** Opens the terminal in `el`; what's typed in it goes to `send` (xterm.js sends what a terminal would: \r for Enter, escape sequences). */
  open(el: HTMLElement, send: (d: string) => void) {
    this.term.open(el);
    // A key typed on the physical keyboard into the terminal ends the on-screen keyboard's latches, as one into the screen does.
    this.term.textarea?.addEventListener('keyup', (e) => {
      keys.typed.emit(e.code);
    });
    this.term.onData((d) => {
      if (!this.#replaying) send(d);
    });
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
            download: `webpc-${machine}-serial-${new Date().toISOString().replace(/[:.]/g, '-')}.log`,
          });
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
        },
      },
    };
  }
}
