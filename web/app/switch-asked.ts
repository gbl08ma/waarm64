// A machine's disk switched to another of its overlays (the Disks tab's list, docs/machines.md §4.5, §5.1): one its
// guest sees at another size than now (one of them was resized) changes the machine's shape, so the switch asks first,
// naming the kept snapshots it orphans (`sizeOrphans`). Same size: no question.
import { t } from '../i18n.ts';
import { ask } from './ask.svelte.ts';
import { sizeSeen } from './disk-size.ts';
import { sizeOrphans } from './resize.ts';
import type { MachineRecord } from './shape.ts';
import type { Store } from './store.ts';

/** Whether machine `m`'s attachment `attachment` may switch to overlay `overlay` (asked when it orphans snapshots). */
export async function switchAsked(store: Store, m: MachineRecord, attachment: string, overlay: string) {
  const orphans = await sizeOrphans(store, m.id, attachment, { overlay });
  const a = m.attachments.find((x) => x.id === attachment);
  const d = a && (await store.get('disks', a.disk));
  if (!orphans.length || !a || !d) return true;
  const o = await store.get('overlays', overlay);
  const now = sizeSeen(d, a, a.overlay ? await store.get('overlays', a.overlay) : undefined);
  const words = {
    name: o?.name ?? '',
    size: sizeSeen(d, { ...a, overlay }, o),
    now,
    count: orphans.length,
    list: orphans.map((x) => t('disks:ResizeDisk.snapshot', { name: x.name, machine: m.name })),
  };
  return ask.confirm(t('disks:switch-asked.orphans', words), {
    title: t('disks:switch-asked.title'),
    ok: t('disks:switch-asked.ok'),
    danger: true,
  });
}
