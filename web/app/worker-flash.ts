// The firmware's variable store (its boot entries and settings), kept beside the disk's overlay by the machine worker
// (web/app/worker.ts): saved when the machine's bank changed, as last saved or loaded otherwise.
import { saveFlash } from '../overlay.ts';
import type { Vm } from '../vm.ts';

/** The variable store as last saved (or loaded). */
let saved: Uint8Array | undefined;
let saving: Promise<void> = Promise.resolve();
const same = (a: Uint8Array, b?: Uint8Array) => !!b && a.length === b.length && a.every((x, i) => x === b[i]);

/** The variable store a start loaded (none: the firmware's own); returned. */
export function flashLoaded(flash: Uint8Array | undefined) {
  saved = flash;
  return flash;
}

/** Saves `v`'s flash bank into OPFS directory `at` if it changed since the last save (a save in flight finishes first). */
export function keepFlash(v: Vm, at: string | undefined) {
  const flash = v.flash();
  if (!flash || !at || same(flash, saved)) return saving;
  saved = flash;
  return (saving = saving
    .then(() => saveFlash(at, flash))
    .catch(() => {
      saved = undefined;
    })); // retried at the next change or tick
}
