<!--
  The body of Disks on the Home page (docs/machines.md §4): every disk this browser keeps, attached or not, ramdisks
  included. Each with what it is, its overlays and the machines that have it; Overlays… (the disk's overlays, Overlays.svelte, when it has some),
  a "visualize" link on its line (its surface window, SurfaceWindow.svelte), Attach to a machine… (AttachDisk.svelte), Resize… on a stored disk or a ramdisk (ResizeDisk.svelte) and, when no machine has it, Delete with its overlays (`Store.deleteDisk`).
  A file disk whose file can't be read now, past a grant not given yet in this session (docs/machines.md §3.2), says why
  under its line, with Choose the file again… and, where the browser's grant may help, Allow….
-->
<script lang="ts">
  import type { Act } from './actions.svelte.ts';
  import AttachDisk from './AttachDisk.svelte';
  import DiskInfo from './DiskInfo.svelte';
  import Button from './ui/Button.svelte';
  import Card from './ui/Card.svelte';
  import CardList from './ui/CardList.svelte';
  import Overlays from './Overlays.svelte';
  import ResizeDisk from './ResizeDisk.svelte';
  import { ask } from './ask.svelte.ts';
  import Note from './ui/Note.svelte';
  import T from './T.svelte';
  import { msg, t, type Msg } from '../i18n.ts';
  import { allowHelps, type Unreachable } from './file-access.ts';
  import { page } from './page.ts';
  import type { OverlayRecord, Store } from './store.ts';
  import type { DiskRecord, MachineRecord } from './shape.ts';
  import { bytesText } from './bytes.ts';
  import { surfaceWindow } from './areas/surface.svelte.ts';

  type Props = {
    store: Store;
    machines: MachineRecord[];
    disks: Map<string, DiskRecord>;
    overlays: OverlayRecord[];
    running: Set<string>;
    act: Act;
    offFirst: (m: MachineRecord) => Promise<boolean>;
  };
  let { store, machines, disks, overlays, running, act, offFirst }: Props = $props();

  const all = $derived([...disks.values()].sort((a, b) => a.name.localeCompare(b.name)));
  const overlaysOf = (id: string) => overlays.filter((o) => o.disk === id);
  const usersOf = (id: string) => machines.filter((m) => m.attachments.some((a) => a.disk === id)).map((m) => m.name);

  /** The disk whose dialog is open: its overlays, the machines to attach it to, or its Resize. */
  let showing = $state<{ disk: string; what: 'overlays' | 'attach' | 'resize' } | undefined>();
  /** Disks that grow themselves (a URL's, a file's or a blank disk grows through its overlays). */
  const resizable = (d: DiskRecord) => d.kind === 'stored' || d.kind === 'ramdisk';
  const shown = $derived(showing ? disks.get(showing.disk) : undefined);

  /** The file disks whose files can't be read now, and why (read again as the records change, and after a click). */
  let unreachable = $state.raw<Map<string, { why: Unreachable; reason: Msg }>>(new Map());
  let checks = 0;
  async function check(list: DiskRecord[]) {
    const mine = ++checks;
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- filled here, then held raw
    const next = new Map<string, { why: Unreachable; reason: Msg }>();
    for (const d of list) {
      const r = await page.diskFile(d.id);
      if (r) next.set(d.id, r);
    }
    if (mine === checks) unreachable = next; // a later check's answer wins
  }
  const files = $derived(all.filter((d) => d.kind === 'file'));
  $effect(() => void check(files));
  /** Allow… or Choose the file again…, then the files checked again. */
  const fileAct = (what: string, f: () => Promise<void>) => act(what, f).then(() => check(files));

  /** Deletes a disk no machine has, with its overlays, after asking. */
  async function remove(d: DiskRecord) {
    const mine = overlaysOf(d.id);
    const bytes = mine.reduce((n, o) => n + o.bytes, 0);
    const what =
      d.kind === 'stored'
        ? d.bytes === undefined
          ? msg('disks:DisksPane.delete.stored', { size: bytesText(d.size) })
          : msg('disks:DisksPane.delete.storedHeld', { held: bytesText(d.bytes), size: bytesText(d.size) })
        : d.kind === 'file' || d.kind === 'url'
          ? msg('disks:DisksPane.delete.remote')
          : msg('disks:DisksPane.delete.disk');
    const remains =
      d.kind === 'file'
        ? msg('disks:DisksPane.delete.remains.file')
        : d.kind === 'url'
          ? msg('disks:DisksPane.delete.remains.url')
          : undefined;
    const question = bytes
      ? msg('disks:DisksPane.delete.confirmSized', {
          name: d.name,
          what,
          count: mine.length,
          size: bytesText(bytes),
          remains,
        })
      : msg('disks:DisksPane.delete.confirm', { name: d.name, what, count: mine.length, remains });
    if (
      !(await ask.confirm(question, {
        title: t('disks:DisksPane.delete.title'),
        ok: t('disks:DisksPane.delete.ok'),
        danger: true,
      }))
    )
      return;
    await act(t('disks:DisksPane.busy.deleting'), () => store.deleteDisk(d.id));
  }
</script>

<CardList empty={all.length ? undefined : t('disks:DisksPane.none')}>
  {#each all as d (d.id)}
    {@const mine = overlaysOf(d.id)}
    {@const users = usersOf(d.id)}
    {@const file = unreachable.get(d.id)}
    <Card data-disk={d.id} data-kind={d.kind}>
      <div class="info">
        <DiskInfo disk={d} overlays={mine} {users} onvisualize={() => surfaceWindow.show(d.id, undefined, 'disks')} />
      </div>
      {#if file}<Note inline tone="warn" data-field="disk-file-problem"><T m={file.reason} /></Note>{/if}
      {#snippet actions()}
        {#if file && d.handle && allowHelps(file.why)}<Button
            onclick={() => fileAct(t('disks:DisksPane.busy.allowing'), () => page.diskAllow(d))}
            data-action="allow-disk-file"
            title={t('disks:DisksPane.allowFile.title')}>{t('disks:DisksPane.allowFile')}</Button
          >{/if}
        {#if file}<Button
            onclick={() => fileAct(t('disks:DisksPane.busy.choosing'), () => page.diskRepick(d))}
            data-action="repick-disk-file"
            title={t('disks:DisksPane.repickFile.title')}>{t('disks:DisksPane.repickFile')}</Button
          >{/if}
        {#if mine.length}<Button
            onclick={() => (showing = { disk: d.id, what: 'overlays' })}
            data-action="disk-overlays"
            title={t('disks:DisksPane.overlaysButton.title')}>{t('disks:DisksPane.overlaysButton')}</Button
          >{/if}
        <Button
          onclick={() => (showing = { disk: d.id, what: 'attach' })}
          data-action="attach-disk"
          title={t('disks:DisksPane.attach.title')}>{t('disks:DisksPane.attach')}</Button
        >
        {#if resizable(d)}<Button
            onclick={() => (showing = { disk: d.id, what: 'resize' })}
            data-action="resize-disk"
            title={t('disks:DisksPane.resize.title')}>{t('disks:DisksPane.resize')}</Button
          >{/if}
        <Button
          icon="trash"
          onclick={() => remove(d)}
          disabled={users.length > 0}
          data-action="delete-disk"
          title={users.length
            ? t('disks:DisksPane.deleteAttached.title', { machines: users })
            : t('disks:DisksPane.deleteButton.title')}>{t('disks:DisksPane.deleteButton')}</Button
        >
      {/snippet}
    </Card>
  {/each}
</CardList>
{#if showing?.what === 'overlays' && shown}
  <Overlays {store} disk={shown} {overlays} {machines} {act} {offFirst} close={() => (showing = undefined)} />
{:else if showing?.what === 'attach' && shown}
  <AttachDisk {store} disk={shown} {machines} {running} {act} {offFirst} close={() => (showing = undefined)} />
{:else if showing?.what === 'resize' && shown}
  <ResizeDisk
    {store}
    target={{ disk: shown.id }}
    name={shown.name}
    ramdisk={shown.kind === 'ramdisk'}
    {act}
    {offFirst}
    close={() => (showing = undefined)}
  />
{/if}

<style>
  .info {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }
</style>
