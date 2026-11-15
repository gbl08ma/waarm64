// A surface window's asks (web/app/SurfaceWindow.svelte, docs/frontend.md "A disk's surface"): the map at the room the
// grid has, from the source the view's choice makes (web/app/surface-source.ts). Live, it asks every 500 ms while the
// document is visible, stretched so that making the answers (their `cost`) stays under 2% of the time; not live, once,
// and again on Refresh or when the records change. A new source (the machine started or stopped, another overlay)
// drops what the old one had in flight.
import type { Msg } from '../msg.ts';
import type { InspectAnswer, RangeDetail, Surface } from '../surface.ts';
import { pollDelay, type SurfaceSource } from './surface-source.ts';

/** After a switch from live to the files, how long an answer that the files are in use is taken for the machine's own close. */
const SETTLE_MS = 6_000;
const RETRY_MS = 1_000;

export class SurfacePoll {
  /** The last surface, and why there is none (the source's words) when there's none. */
  surface = $state.raw<Surface>();
  why = $state.raw<Msg>();
  /** The source follows the running guest. */
  live = $state(false);
  /** An ask runs (the first, or a Refresh). */
  asking = $state(false);
  /** Answers taken (tests). */
  answers = 0;
  #source: SurfaceSource | undefined;
  #key = '';
  #gen = 0;
  #cells = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #switched = 0;
  #closed = false;

  constructor() {
    document.addEventListener('visibilitychange', this.#visible);
  }

  /** The source for choice `key` (made by `make` when the key is new: the old one is closed, its asks dropped). */
  use(key: string, make: () => SurfaceSource) {
    if (key === this.#key || this.#closed) return;
    const was = this.#source?.live ?? false;
    this.#source?.close();
    this.#key = key;
    this.#source = make();
    this.live = this.#source.live;
    if (was && !this.live) this.#switched = performance.now();
    this.#gen++;
    void this.#ask();
  }
  /** The grid has room for `cells` cells. */
  room(cells: number) {
    if (cells === this.#cells) return;
    this.#cells = cells;
    void this.#ask();
  }
  /** Asks again now (Refresh, the records changed). */
  refresh() {
    void this.#ask();
  }
  /** A range's detail from the source, with its content check if asked. */
  async range(range: number, content: boolean): Promise<RangeDetail | Msg | undefined> {
    const s = this.#source;
    if (!s) return undefined;
    const a = await s.range(range, content);
    if (s !== this.#source) return undefined;
    return a.kind === 'disk-range' ? a.detail : a.kind === 'none' ? a.why : undefined;
  }
  close() {
    this.#closed = true;
    clearTimeout(this.#timer);
    this.#source?.close();
    this.#source = undefined;
    document.removeEventListener('visibilitychange', this.#visible);
  }

  #visible = () => {
    if (this.live && document.visibilityState === 'visible') void this.#ask();
  };

  /** Whether ask `gen`'s answer is stale: a newer ask, or another source, took its place, or the window closed. */
  #stale(gen: number) {
    return gen !== this.#gen || this.#closed;
  }

  async #ask() {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    const s = this.#source;
    if (!s || this.#closed || this.#cells <= 0) return;
    const gen = ++this.#gen;
    if (!this.surface) this.asking = true;
    const a = await s.surface(this.#cells).catch((): InspectAnswer => ({ kind: 'none' }));
    if (this.#stale(gen)) return;
    this.asking = false;
    this.answers++;
    const next = this.#take(s, a);
    if (next !== undefined && (!s.live || document.visibilityState === 'visible'))
      this.#timer = setTimeout(() => void this.#ask(), next);
  }

  /** Takes answer `a` of source `s`; returns when to ask again (none: not until asked). */
  #take(s: SurfaceSource, a: InspectAnswer): number | undefined {
    if (a.kind === 'disk-surface') {
      this.surface = a.surface;
      this.why = undefined;
      return s.live ? pollDelay(a.surface.cost) : undefined;
    }
    if (a.kind !== 'none') return undefined;
    if (s.live) {
      // Live without an answer: the machine is starting (no devices yet) or busy, and is asked again; the last picture
      // stays meanwhile.
      if (!this.surface) this.why = a.why;
      return pollDelay();
    }
    this.surface = undefined;
    this.why = a.why;
    // The machine on this page has just stopped: its device worker may hold the files a moment longer.
    const settling = performance.now() - this.#switched < SETTLE_MS;
    return a.why?.key === 'disks:surface-job.inUse' && settling ? RETRY_MS : undefined;
  }
}
