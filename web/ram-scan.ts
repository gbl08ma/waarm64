// The guest's RAM as the RAM map sees it (docs/frontend.md "RAM's map"): which 4 KiB pages hold anything but zeros and
// which changed since the last look, counted per cell of a grid (web/surface.ts `Surface`) and one 4 MiB range page by
// page. Nothing is added to the vCPUs' path: a pass reads guest RAM where it lies (memory 0's RAM and the spill
// memories, shared buffers) from a worker of its own (web/app/ram-scan-worker.ts), keeping a fingerprint per page to
// tell a change at the next pass. No DOM: the worker and Node's tests import it.
//
// A pass reads every byte of every page with data (the fingerprint), and a zero page whole (to know it is one): its
// cost is the RAM's size over the memory's bandwidth (~0.35 s a GiB of data, ~0.1 s a GiB never written: untouched
// memory reads the host's zero page and isn't committed by it), so the map asks seldom enough that passes take a small
// share of the time (web/app/ram-source.ts `ramDelay`).
import { cellBytesFor, cellCount, RANGE, UNIT, type RamPlace, type RangeDetail, type Surface } from './surface.ts';

/** A piece of guest RAM: `size` bytes at `offset` in `buffer` (shared: the machine's memories), at guest PA `pa`. */
export type RamPart = { buffer: ArrayBufferLike; offset: number; size: number; pa: number };

/**
 * A page's state after a pass: it holds data; it holds other data than at the pass before (written from zeros too); it
 * held data then and is zero now.
 */
export const PAGE_DATA = 1;
export const PAGE_CHANGED = 2;
export const PAGE_GONE = 4;

/**
 * Per 4 KiB page of a RAM range (`RangeDetail.blocks` of a `ram-range` answer): zero, data, data changed since the
 * last look, zero now but data at the last look, past the end of RAM.
 */
export const RAM_PAGE = { zero: 0, data: 1, changed: 2, gone: 3, past: 4 } as const;

const WORDS = UNIT / 4;

/**
 * A page's fingerprint (never 0) from its words at `b`: four lanes of sums and sums of sums, so a change of any word
 * (or two words swapping) changes it but for a 2^-32 chance. Reads every word: the pass's cost is the reads.
 */
function fingerprint(w: Int32Array, b: number) {
  let a0 = 0;
  let a1 = 0;
  let a2 = 0;
  let a3 = 0;
  let c0 = 0;
  let c1 = 0;
  let c2 = 0;
  let c3 = 0;
  for (let i = b, e = b + WORDS; i < e; i += 4) {
    a0 = (a0 + w[i]) | 0;
    a1 = (a1 + w[i + 1]) | 0;
    a2 = (a2 + w[i + 2]) | 0;
    a3 = (a3 + w[i + 3]) | 0;
    c0 = (c0 + a0) | 0;
    c1 = (c1 + a1) | 0;
    c2 = (c2 + a2) | 0;
    c3 = (c3 + a3) | 0;
  }
  let h = Math.imul(a0 ^ ((c0 << 7) | (c0 >>> 25)), 0x9e3779b1);
  h = Math.imul(h ^ a1 ^ ((c1 << 13) | (c1 >>> 19)), 0x85ebca6b);
  h = Math.imul(h ^ a2 ^ ((c2 << 17) | (c2 >>> 15)), 0xc2b2ae35);
  h = Math.imul(h ^ a3 ^ ((c3 << 23) | (c3 >>> 9)), 0x27d4eb2f);
  return h | 1;
}

/** Whether the page at word `b` is all zeros (read 8 words at a time; a page with data is left at its first). */
function zeroPage(w: Int32Array, b: number) {
  for (let i = b, e = b + WORDS; i < e; i += 8)
    if (w[i] | w[i + 1] | w[i + 2] | w[i + 3] | w[i + 4] | w[i + 5] | w[i + 6] | w[i + 7]) return false;
  return true;
}

/** Guest RAM's pages, looked at pass by pass: their state at the last pass, and their fingerprints for the next. */
export class RamScan {
  /** Bytes of RAM (every part's, one after another: the map's offsets) and pages. */
  readonly size: number;
  readonly pages: number;
  /** Passes made (the first can't tell a change). */
  passes = 0;
  readonly #parts: { w: Int32Array; first: number; pages: number; pa: number }[];
  readonly #sig: Int32Array;
  readonly #state: Uint8Array;

  constructor(parts: RamPart[]) {
    let first = 0;
    this.#parts = parts.map((p) => {
      if (p.offset % 4 || p.size % UNIT) throw new Error(`RAM part at ${String(p.offset)} isn't whole pages`);
      const pages = p.size / UNIT;
      const part = { w: new Int32Array(p.buffer, p.offset, p.size / 4), first, pages, pa: p.pa };
      first += pages;
      return part;
    });
    this.pages = first;
    this.size = first * UNIT;
    this.#sig = new Int32Array(first);
    this.#state = new Uint8Array(first);
  }

  /** Where RAM's parts are in the guest's physical address space: map offset `off` → `pa`, `size` bytes. */
  get layout(): RamPlace[] {
    return this.#parts.map((p) => ({ off: p.first * UNIT, pa: p.pa, size: p.pages * UNIT }));
  }

  /** Looks at every page once (a fingerprint for those with data); the ms it took. */
  pass(): number {
    const t = performance.now();
    const [sig, state] = [this.#sig, this.#state];
    const compare = this.passes > 0;
    for (const { w, first, pages } of this.#parts) {
      for (let p = 0; p < pages; p++) {
        const g = first + p;
        const b = p * WORDS;
        const s = zeroPage(w, b) ? 0 : fingerprint(w, b);
        const was = sig[g];
        sig[g] = s;
        if (s === 0) state[g] = compare && was !== 0 ? PAGE_GONE : 0;
        else state[g] = PAGE_DATA | (compare && was !== s ? PAGE_CHANGED : 0);
      }
    }
    this.passes++;
    return performance.now() - t;
  }

  /**
   * The last pass as a surface of at most `cells` cells: the `ram` layer's `held` its pages with data; from the second
   * pass on, a `changed` layer: `held` its pages with other data than at the pass before (written from zeros too),
   * `zero` those that held data then and are zero now (freed memory the guest gave back: docs/devices.md "balloon").
   */
  surface(cells: number): Surface {
    const cellBytes = cellBytesFor(this.size, cells);
    const n = cellCount(this.size, cellBytes);
    const per = cellBytes / UNIT;
    const data = new Uint32Array(n);
    const changed = new Uint32Array(n);
    const gone = new Uint32Array(n);
    const state = this.#state;
    for (let g = 0; g < this.pages; g++) {
      const s = state[g];
      if (!s) continue;
      const c = Math.floor(g / per);
      if (s & PAGE_DATA) data[c]++;
      if (s & PAGE_CHANGED) changed[c]++;
      if (s & PAGE_GONE) gone[c]++;
    }
    const layers = [{ id: 'ram', size: this.size, known: 'counted' as const, held: data, zero: new Uint32Array(n) }];
    if (this.passes > 1) layers.push({ id: 'changed', size: this.size, known: 'counted', held: changed, zero: gone });
    return { size: this.size, cellBytes, unitBytes: UNIT, layers };
  }

  /** Range `r` (4 MiB of the map's offsets) at the last pass, page by page (`RAM_PAGE`); undefined past RAM's end. */
  range(r: number): RangeDetail | undefined {
    if (!Number.isInteger(r) || r < 0 || r * RANGE >= this.size) return undefined;
    const per = RANGE / UNIT;
    const blocks = new Uint8Array(per);
    for (let i = 0; i < per; i++) {
      const g = r * per + i;
      if (g >= this.pages) blocks[i] = RAM_PAGE.past;
      else {
        const s = this.#state[g];
        blocks[i] =
          s & PAGE_CHANGED
            ? RAM_PAGE.changed
            : s & PAGE_DATA
              ? RAM_PAGE.data
              : s & PAGE_GONE
                ? RAM_PAGE.gone
                : RAM_PAGE.zero;
      }
    }
    return { range: r, blocks, runs: {} };
  }
}

/** The guest PA of map offset `off` in RAM laid out as `layout` (`RamScan.layout`); the last byte's part past the end. */
export function paOf(layout: RamPlace[], off: number) {
  for (const l of layout) if (off >= l.off && off < l.off + l.size) return l.pa + (off - l.off);
  const last = layout.at(-1);
  return last ? last.pa + (off - last.off) : off;
}
