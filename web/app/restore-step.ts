// What a restore of a stored machine that hasn't loaded yet did to its attachments (docs/machines.md §5.2 "A restore's
// records"): the steps its record's `restoring` holds (web/app/shape.ts `MachineRecord`), which the undo reads.
import type { MachineRecord } from './shape.ts';

/**
 * What a restore that hasn't loaded did to attachment `attachment` (`MachineRecord.restoring`): `fork`, a new overlay
 * `overlay` made and attached (undone: the attachment back on `before`, and the fork deleted unless another machine has
 * it chosen or something but the fill wrote it); `reuse`, an earlier fork `overlay`
 * attached again (undone: the attachment back on `before`, the fork kept); `into`, its attached overlay `overlay`
 * written into (a replace, or a template's fresh overlay), found at `generation` at the commit (undone: left as it is
 * where its meta doesn't carry the restore's fill token, else read as empty). `fork` on an `into`: the fresh overlay
 * becomes the snapshot's fork, named after it, once the snapshot loaded. `token`: the restore's fill token (the
 * commit's, one per restore), which the worker's fill writes into the meta of each overlay it writes and any later
 * opening's first change clears: the proof an undo needs before it empties or deletes an overlay (docs/machines.md §5.2
 * "Other machines"). A step without one (written before tokens) never empties or deletes anything.
 */
export type RestoreStep =
  | {
      attachment: string;
      how: 'fork' | 'reuse';
      overlay: string;
      /** What the attachment had before the restore: its overlay, or the disk written in place. */
      before: { overlay?: string; inPlace?: true };
      token?: string;
    }
  | {
      attachment: string;
      how: 'into';
      overlay: string;
      generation: number;
      fork?: { snapshot: string; name: string };
      token?: string;
    };

/** Whether machine `m`'s restore that hasn't loaded (`restoring`) writes or attaches overlay `id`, or would go back onto it. */
export const restoreNames = (m: MachineRecord, id: string) =>
  !!m.restoring?.some((s) => s.overlay === id || (s.how !== 'into' && s.before.overlay === id));

/**
 * Whether a machine of `all` other than `own` has overlay `id` chosen, or a restore of its that hasn't loaded names it
 * (`restoreNames`): an overlay a restore of `own` doesn't write into, and its undo doesn't delete (docs/machines.md §5.2
 * "Other machines").
 */
export const othersHave = (all: MachineRecord[], own: string, id: string) =>
  all.some((x) => x.id !== own && (x.attachments.some((a) => a.overlay === id) || restoreNames(x, id)));
