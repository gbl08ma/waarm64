// What a restore of a stored machine that hasn't loaded yet did to its attachments (docs/machines.md §5.2 "A restore's
// records"): the steps its record's `restoring` holds (web/app/shape.ts `MachineRecord`), which the undo reads.
import type { MachineRecord } from './shape.ts';

/**
 * What a restore that hasn't loaded did to attachment `attachment` (`MachineRecord.restoring`): `fork`, a new overlay
 * `overlay` made and attached (undone: deleted, the attachment back on `before`); `reuse`, an earlier fork `overlay`
 * attached again (undone: the attachment back on `before`, the fork kept); `into`, its attached overlay `overlay`
 * written into (a replace, or a template's fresh overlay), found at `generation` at the commit (undone: left as it is
 * where the fill never moved it on, else read as empty). `fork` on an `into`: the fresh overlay becomes the snapshot's
 * fork, named after it, once the snapshot loaded.
 */
export type RestoreStep =
  | {
      attachment: string;
      how: 'fork' | 'reuse';
      overlay: string;
      /** What the attachment had before the restore: its overlay, or the disk written in place. */
      before: { overlay?: string; inPlace?: true };
    }
  | {
      attachment: string;
      how: 'into';
      overlay: string;
      generation: number;
      fork?: { snapshot: string; name: string };
    };

/** Whether machine `m`'s restore that hasn't loaded (`restoring`) writes or attaches overlay `id`, or would go back onto it. */
export const restoreNames = (m: MachineRecord, id: string) =>
  !!m.restoring?.some((s) => s.overlay === id || (s.how !== 'into' && s.before.overlay === id));
