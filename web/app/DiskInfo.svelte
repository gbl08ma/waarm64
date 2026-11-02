<!--
  A disk as the lists of disks show it (docs/machines.md §4): its kind's icon, its name, and a line with its kind, size,
  overlays (a ramdisk has none) and the machines it's attached to. In the Disks pane and Add a disk… › A disk already in
  this browser.
-->
<script lang="ts">
  import Icon from './Icon.svelte';
  import { t } from '../i18n.ts';
  import { bytesText } from './bytes.ts';
  import { diskKind } from './disk-kind.ts';
  import type { OverlayRecord } from './store.ts';
  import type { DiskRecord } from './shape.ts';

  /** `overlays`: the disk's; `users`: the names of the machines it's attached to. */
  let { disk, overlays, users }: { disk: DiskRecord; overlays: OverlayRecord[]; users: string[] } = $props();
  const kind = $derived(diskKind(disk.kind));
  const bytes = $derived(overlays.reduce((n, o) => n + o.bytes, 0));
</script>

<span class="kind" title={kind.text}><Icon name={kind.icon} size={18} /></span>
<div class="what">
  <strong>{disk.name}</strong>
  <span class="meta">{t('disks:DiskInfo.meta', { kind: kind.text, size: bytesText(disk.size) })}{#if disk.kind !== 'ramdisk'}{' · '}{bytes ? t('disks:DiskInfo.overlaysSized', { count: overlays.length, size: bytesText(bytes) }) : t('disks:DiskInfo.overlays', { count: overlays.length })}{/if}{' · '}{users.length ? t('disks:DiskInfo.on', { machines: users }) : t('disks:DiskInfo.onNone')}</span>
</div>

<style>
  .kind { display: inline-flex; color: var(--dim); }
  .what { flex: 1; min-width: 200px; display: flex; flex-direction: column; }
  .meta { color: var(--dim); font-size: 12px; }
</style>
