// BlockGridDemo.svelte's made-up surface: a disk four fifths of the grid, held in patches of every step, a stretch not
// examined; an overlay on it with changed and zeroed stretches, and past the disk's end (an overlay larger than it).
import { CORE, FLASH, RIM } from '../../web/app/ui/block-grid.ts';

/** What the test reads back: the grid's reports. */
export type GridHooks = {
  rooms: number[];
  hovers: (number | undefined)[];
  picks: number[];
  /** The made-up looks shown now. */
  rim: Uint8Array;
  core: Uint8Array;
  mark: number;
  /** Sends a flash array: these cells read, these written. */
  flash: (read: number[], write: number[]) => void;
};
declare global {
  interface Window { __grid: GridHooks }
}

/** A number in [0, 1) from `i` (a fixed hash: the same picture every time). */
const hash = (i: number) => (Math.imul(i ^ 0x9e3779b9, 0x85ebca6b) >>> 0) / 2 ** 32;

/** The looks of `n` cells: the disk's end after `mark`. */
export function fakeSurface(n: number) {
  const rim = new Uint8Array(n);
  const core = new Uint8Array(n);
  const mark = Math.max(0, Math.floor(n * 0.8) - 1);
  const at = (f: number) => Math.floor(n * f);
  for (let i = 0; i < n; i++) {
    const patch = hash(Math.floor(i / 23));
    if (i > mark) rim[i] = RIM.absent;
    else if (i < at(0.06)) rim[i] = RIM.step(4);
    else if (i >= at(0.46) && i < at(0.52)) rim[i] = RIM.opaque;
    else if (patch < 0.3) rim[i] = RIM.empty;
    else rim[i] = RIM.step(1 + Math.floor(hash(i) * 4 * patch));
    if (i >= at(0.1) && i < at(0.24)) core[i] = hash(i + 7) < 0.8 ? CORE.step(1 + Math.floor(hash(i * 3) * 4)) : CORE.none;
    else if (i >= at(0.3) && i < at(0.34)) core[i] = CORE.hollow;
    else if (i >= at(0.62) && i < at(0.64)) core[i] = CORE.step(4);
    else if (i >= at(0.84) && i < at(0.9)) core[i] = CORE.step(2);
  }
  return { rim, core, mark };
}

/** A flash array of `n` cells: `read` read, `write` written. */
export function flashOf(n: number, read: number[], write: number[]) {
  const f = new Uint8Array(n);
  for (const i of read) if (i < n) f[i] |= FLASH.read;
  for (const i of write) if (i < n) f[i] |= FLASH.write;
  return f;
}
