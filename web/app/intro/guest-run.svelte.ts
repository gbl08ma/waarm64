// The introduction's guest as the first screen shows it (IntroGuest.svelte): its state, the tour's mark it is at, its
// counters, and the terminal its serial port is on. One run at a time; a run's canvas is its own (intro/guest.ts).
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { MARKS, type GuestStats, type Mark } from './guest-protocol.ts';
import { canRunGuest, startGuest, type Guest } from './guest.ts';

/** The guest's framebuffer and its terminal: the frame is drawn for these. */
export const SCREEN = { width: 512, height: 320 } as const;
export const TERMINAL = { cols: 64, rows: 8 } as const;

/** A token's value, for xterm.js, which takes colors as strings. */
const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export class GuestRun {
  /**
   * `unable`: this browser can't run it, or it failed (the plate shows instead). `waiting`: not started (the visitor
   * asked for less motion: a click starts it). `starting`: fetched and booting, nothing drawn yet. `running`. `off`:
   * the guest powered itself off.
   */
  state = $state<'unable' | 'waiting' | 'starting' | 'running' | 'off'>(canRunGuest() ? 'waiting' : 'unable');
  /** The tour's last mark (none before the first picture's). */
  mark = $state<Mark>();
  stats = $state<GuestStats>();
  /** Counts the runs: the frame's canvas is made anew for each (a canvas is handed to a worker once). */
  run = $state(0);
  #guest?: Guest;
  #term?: Terminal;
  #paused = false;

  /** Starts a run on `canvas` with its terminal in `box`. */
  start(canvas: HTMLCanvasElement, box: HTMLElement) {
    if (this.state === 'unable' || this.#guest) return;
    this.state = 'starting';
    this.mark = this.stats = undefined;
    const term = (this.#term = new Terminal({
      ...TERMINAL,
      scrollback: 500,
      fontFamily: 'ui-monospace, "DejaVu Sans Mono", Menlo, monospace',
      fontSize: 12,
      theme: { background: token('--well-bg'), foreground: token('--text'), cursor: token('--accent') },
    }));
    term.open(box);
    // The tour's marks (images/intro/tour): an OSC 777 `waarm64;<mark>`, in the order of the text around them.
    term.parser.registerOscHandler(777, (data) => {
      const mark = MARKS.find((m) => data === `waarm64;${m}`);
      if (mark) this.mark = mark;
      return true;
    });
    const guest = (this.#guest = startGuest({
      canvas,
      ...SCREEN,
      ...TERMINAL,
      onOutput: (text) => term.write(text),
      onScreen: () => {
        if (this.#guest === guest) this.state = 'running';
      },
      onStats: (stats) => (this.stats = stats),
      onEnd: (state, detail) => {
        if (this.#guest !== guest) return;
        if (state === 'failed') console.warn("The introduction's machine didn't run:", detail);
        void this.stop(state === 'off' ? 'off' : 'unable');
      },
    }));
    term.onData((d) => guest.send(d));
    if (this.#paused) guest.pause();
  }

  /** Pauses the run while nobody can see it (scrolled away, a hidden tab), and lets it go on. */
  pause(paused: boolean) {
    if (paused === this.#paused) return;
    this.#paused = paused;
    if (paused) this.#guest?.pause();
    else this.#guest?.resume();
  }

  /** Ends the run and frees what it took (`then`: what the frame shows after). */
  async stop(then: 'waiting' | 'off' | 'unable' = 'waiting') {
    // The worker first: whatever the page's own cleanup does, the machine ends.
    const stopped = this.#guest?.stop();
    this.#guest = undefined;
    this.#term?.dispose();
    this.#term = undefined;
    if (this.state !== 'unable') this.state = then;
    this.run++;
    await stopped;
  }
}
