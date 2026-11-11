<!--
  The body of Disks on the Machines page (docs/machines.md §4): every disk this browser keeps, attached or not, ramdisks
  included. Each with what it is, its overlays and the machines that have it; Overlays… (the disk's overlays, Overlays.svelte, when it has some),
  Attach to a machine… (AttachDisk.svelte) and, when no machine has it, Delete with its overlays (`Store.deleteDisk`).
-->
<script lang="ts">
  import AttachDisk from './AttachDisk.svelte';
  import DiskInfo from './DiskInfo.svelte';
  import Icon from './Icon.svelte';
  import Overlays from './Overlays.svelte';
  import { ask } from './ask.svelte.ts';
  import { msg, t } from '../i18n.ts';
  import type { OverlayRecord, Store } from './store.ts';
  import type { DiskRecord, MachineRecord } from './shape.ts';
  import { bytesText } from './bytes.ts';

  type Props = {
    store: Store;
    machines: MachineRecord[];
    disks: Map<string, DiskRecord>;
    overlays: OverlayRecord[];
    running: Set<string>;
    act(what: string, f: () => Promise<unknown>): Promise<void>;
    offFirst(m: MachineRecord): Promise<boolean>;
  };
  let { store, machines, disks, overlays, running, act, offFirst }: Props = $props();

  const all = $derived([...disks.values()].sort((a, b) => a.name.localeCompare(b.name)));
  const overlaysOf = (id: string) => overlays.filter((o) => o.disk === id);
  const usersOf = (id: string) => machines.filter((m) => m.attachments.some((a) => a.disk === id)).map((m) => m.name);

  /** The disk whose dialog is open: its overlays, or the machines to attach it to. */
  let showing = $state<{ disk: string; what: 'overlays' | 'attach' } | undefined>();
  const shown = $derived(showing ? disks.get(showing.disk) : undefined);

  /** Deletes a disk no machine has, with its overlays, after asking. */
  async function remove(d: DiskRecord) {
    const mine = overlaysOf(d.id);
    const bytes = mine.reduce((n, o) => n + o.bytes, 0);
    const what =
      d.kind === 'stored'
        ? msg('disks:DisksPane.delete.stored', { size: bytesText(d.size) })
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
      ? t('disks:DisksPane.delete.confirmSized', {
          name: d.name,
          what,
          count: mine.length,
          size: bytesText(bytes),
          remains,
        })
      : t('disks:DisksPane.delete.confirm', { name: d.name, what, count: mine.length, remains });
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

<ul class="cards">
  {#each all as d (d.id)}
    {@const mine = overlaysOf(d.id)}
    {@const users = usersOf(d.id)}
    <li data-disk={d.id} data-kind={d.kind}>
      <DiskInfo disk={d} overlays={mine} {users} />
      {#if mine.length}<button
          onclick={() => (showing = { disk: d.id, what: 'overlays' })}
          data-action="disk-overlays"
          title={t('disks:DisksPane.overlaysButton.title')}>{t('disks:DisksPane.overlaysButton')}</button
        >{/if}
      <button
        onclick={() => (showing = { disk: d.id, what: 'attach' })}
        data-action="attach-disk"
        title={t('disks:DisksPane.attach.title')}>{t('disks:DisksPane.attach')}</button
      >
      <button
        onclick={() => remove(d)}
        disabled={users.length > 0}
        data-action="delete-disk"
        title={users.length
          ? t('disks:DisksPane.deleteAttached.title', { machines: users })
          : t('disks:DisksPane.deleteButton.title')}
        ><Icon name="trash" size={16} />{t('disks:DisksPane.deleteButton')}</button
      >
    </li>
  {:else}
    <li class="none">{t('disks:DisksPane.none')}</li>
  {/each}
</ul>
{#if showing?.what === 'overlays' && shown}
  <Overlays {store} disk={shown} {overlays} {machines} {act} close={() => (showing = undefined)} />
{:else if showing?.what === 'attach' && shown}
  <AttachDisk {store} disk={shown} {machines} {running} {act} {offFirst} close={() => (showing = undefined)} />
{/if}

<style>
  .cards {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .cards > li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--panel);
  }
  .cards > li.none {
    color: var(--dim);
  }
  button {
    white-space: nowrap;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 3px 10px;
  }
</style>
