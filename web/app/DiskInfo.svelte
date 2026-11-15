<!--
  A disk as the lists of disks show it (docs/machines.md §4): its kind's icon, its name, and a line with its kind, size (and what a stored disk holds of it),
  overlays (a ramdisk has none) and the machines it's attached to. In the Disks pane and Add a disk… › A disk already in
  this browser. One element: a row (the icon, then the name over its line) that takes the room its parent gives it.
-->
<script lang="ts">
  import Icon from './ui/Icon.svelte';
  import { t } from '../i18n.ts';
  import { bytesText } from './bytes.ts';
  import { diskKind } from './disk-kind.ts';
  import type { OverlayRecord } from './store.ts';
  import type { DiskRecord } from './shape.ts';

  /** `overlays`: the disk's; `users`: the names of the machines it's attached to. */
  let { disk, overlays, users }: { disk: DiskRecord; overlays: OverlayRecord[]; users: string[] } = $props();
  const kind = $derived(diskKind(disk.kind));
  const bytes = $derived(overlays.reduce((n, o) => n + o.bytes, 0));
  /** Its line: its kind and size, its overlays (a ramdisk has none), the machines that have it. */
  const line = $derived.by(() => {
    const parts = [
      disk.kind === 'stored' && disk.bytes !== undefined
        ? t('disks:DiskInfo.meta.held', { kind: kind.text, held: bytesText(disk.bytes), size: bytesText(disk.size) })
        : t('disks:DiskInfo.meta', { kind: kind.text, size: bytesText(disk.size) }),
    ];
    if (disk.kind !== 'ramdisk')
      parts.push(
        bytes
          ? t('disks:DiskInfo.overlaysSized', { count: overlays.length, size: bytesText(bytes) })
          : t('disks:DiskInfo.overlays', { count: overlays.length }),
      );
    parts.push(users.length ? t('disks:DiskInfo.on', { machines: users }) : t('disks:DiskInfo.onNone'));
    return parts.join(' · ');
  });
</script>

<div class="disk">
  <span class="kind" title={kind.text}><Icon name={kind.icon} size={18} /></span>
  <div class="what">
    <strong>{disk.name}</strong>
    <span class="meta">{line}</span>
  </div>
</div>

<style>
  .disk {
    flex: 1;
    min-width: 200px;
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }
  .kind {
    display: inline-flex;
    color: var(--text-dim);
  }
  .what {
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .meta {
    color: var(--text-dim);
    font-size: var(--text-sm);
  }
</style>
