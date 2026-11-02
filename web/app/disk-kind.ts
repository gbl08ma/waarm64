// What a disk is (docs/machines.md §4.2), in words and as an icon: on a machine's Disks tab, the Disks pane and Add a disk… ›
// A disk already in this browser.
import { t } from '../i18n.ts';
import type { IconName } from './icons.ts';
import type { DiskKind } from './shape.ts';

/** Disk kind `kind`'s words and icon. */
export function diskKind(kind: DiskKind): { text: string; icon: IconName } {
  switch (kind) {
    case 'url': return { text: t('disks:disk-kind.url'), icon: 'world-www' };
    case 'file': return { text: t('disks:disk-kind.file'), icon: 'file' };
    case 'stored': return { text: t('disks:disk-kind.stored'), icon: 'database' };
    case 'blank': return { text: t('disks:disk-kind.blank'), icon: 'square-dashed' };
    case 'ramdisk': return { text: t('disks:disk-kind.ramdisk'), icon: 'bolt' };
  }
}
