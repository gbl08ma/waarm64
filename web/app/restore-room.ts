// Whether a restore's replace keeps the overlays it replaces until the snapshot loaded (docs/machines.md §5.2, #156): only
// with the storage's room for the snapshot's blocks beside them, since a replace exists to need less than a fork.
import { storageNumbers } from '../overlay.ts';

/**
 * Whether the storage has room for what a restore's `steps` write (those that fill an overlay, `fork` or `fork-whole`:
 * their blocks, a tenth more and 64 MiB for the maps and the guest's first writes, as web/snapshot-stage.ts's `roomFor`
 * asks of a staging file) beside what is there. `room`: the free bytes (tests), else the browser's estimate; where the
 * browser says nothing, there is (a replace's refusal then loses nothing).
 */
export async function roomBeside(steps: { action: string; blocks: number }[], room?: number) {
  const free = room ?? (await storageNumbers().then((n) => n && n.quota - n.used));
  const bytes = steps.reduce((n, s) => n + (s.action === 'fork' || s.action === 'fork-whole' ? s.blocks * 4096 : 0), 0);
  return free === undefined || free >= bytes + Math.ceil(bytes / 10) + (64 << 20);
}
