// The browser's records as the page shows them (docs/machines.md): its machines, disks, overlays and snapshots, read
// from the store (web/app/store.ts) when it opens and again whenever they change: in another tab (the store says so)
// or in this one (whoever wrote calls `reread`: the store doesn't tell a tab of its own writes). The Machines page,
// its tabs and the toolbar's snapshot list read them here.
import type { DiskRecord, MachineRecord } from '../shape.ts';
import type { OverlayRecord, SnapshotRecord, Store } from '../store.ts';

class Records {
  /** By name. */
  machines = $state.raw<MachineRecord[]>([]);
  disks = $state.raw<Map<string, DiskRecord>>(new Map());
  overlays = $state.raw<OverlayRecord[]>([]);
  snapshots = $state.raw<SnapshotRecord[]>([]);
  #store: Store | undefined;
  /** The read that runs, and the one that follows it (the writes during a read are all covered by one more). */
  #reading: Promise<void> | undefined;
  #next: Promise<void> | undefined;

  /** Reads `store`'s records, and again whenever another tab changes them. */
  watch(store: Store) {
    this.#store = store;
    store.onChange(() => void this.reread());
    return this.reread();
  }

  /** Reads the records again (after this tab wrote them); resolves once a read that started after the call is done. */
  reread(): Promise<void> {
    if (!this.#reading) {
      this.#reading = this.#read()
        // The page goes on with the records it had: the next change reads them again.
        .catch((e: unknown) => console.warn('webpc: the records could not be read:', e))
        .finally(() => {
          this.#reading = undefined;
        });
      return this.#reading;
    }
    this.#next ??= this.#reading.then(() => {
      this.#next = undefined;
      return this.reread();
    });
    return this.#next;
  }

  async #read() {
    const store = this.#store;
    if (!store) return;
    const [machines, disks, overlays, snapshots] = await Promise.all([
      store.all('machines'),
      store.all('disks'),
      store.all('overlays'),
      store.all('snapshots'),
    ]);
    this.machines = machines.sort((a, b) => a.name.localeCompare(b.name));
    this.disks = new Map(disks.map((d) => [d.id, d]));
    this.overlays = overlays;
    this.snapshots = snapshots;
  }
}
export const records = new Records();
