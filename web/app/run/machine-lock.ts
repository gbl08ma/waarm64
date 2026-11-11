// While a stored machine runs on this page, its Web Lock is held (machines.ts `machineLock`): the Machines page, in any
// tab, sees it running. It's taken before the machine's disks are opened, and only if it's free: false when another
// tab holds it (the machine runs there), said at once instead of after the overlay's wait (`OVERLAY_WAIT_MS`).
import { machineLock } from '../machines.ts';

export class MachineLock {
  #release: (() => void) | undefined;
  /** Settles once the lock this page last held is released (a restart's next take waits for it, or it'd find its own). */
  #released: Promise<unknown> = Promise.resolve();

  /** Takes machine `id`'s lock (none: a transient machine, true at once); false when another tab holds it. */
  async hold(id: string | undefined) {
    if (id === undefined || this.#release) return true;
    await this.#released;
    return new Promise<boolean>((answer) => {
      this.#released = navigator.locks
        .request(machineLock(id), { ifAvailable: true }, (lock) => {
          if (!lock) {
            answer(false);
            return;
          }
          answer(true);
          return new Promise<void>((resolve) => {
            this.#release = resolve;
          });
        })
        .catch(() => answer(false));
    });
  }

  drop() {
    this.#release?.();
    this.#release = undefined;
  }
}
