// While a stored machine runs on this page, its Web Lock is held (machines.ts `machineLock`): the Home page, in any
// tab, sees it running. It's taken before the machine's disks are opened, and only if it's free: false when another
// tab holds it (the machine runs there), said at once instead of after the overlay's wait (`OVERLAY_WAIT_MS`).
import { machineLock } from '../machines.ts';

export class MachineLock {
  #release: (() => void) | undefined;
  /** Settles once the lock this page last held is released (a restart's next take waits for it, or it'd find its own). */
  #released: Promise<unknown> = Promise.resolve();
  /** Settles once the lock the last `drop` let go of is released (never waits on a `hold` under way). */
  #letGo: Promise<unknown> = Promise.resolve();

  /** A `hold` under way (its answer): a second one meanwhile waits for it rather than find this page's own lock. */
  #taking: Promise<boolean> | undefined;

  /** Takes machine `id`'s lock (none: a transient machine, true at once); false when another tab holds it. */
  async hold(id: string | undefined): Promise<boolean> {
    if (id === undefined || this.#release) return true;
    if (this.#taking) {
      await this.#taking;
      return this.hold(id);
    }
    const taking = (this.#taking = this.#take(id));
    try {
      return await taking;
    } finally {
      if (this.#taking === taking) this.#taking = undefined;
    }
  }

  async #take(id: string) {
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

  /**
   * Settles once the lock this page last let go of is released (at once if none): a reading of the records that
   * asks whether a start owns the machine (web/app/snapshot-undo.ts) doesn't find this page's own last run's.
   */
  settled(): Promise<unknown> {
    return this.#letGo;
  }
  drop() {
    if (this.#release) {
      this.#release();
      this.#letGo = this.#released;
    }
    this.#release = undefined;
  }
}
