<!--
  Attach a disk to a machine (docs/machines.md §4): a dialog over the Disks pane of the Machines page, the other way round from
  Add a disk… › A disk already in this browser. The machines in this browser, each attaching the disk last, with its
  overlays; one that has it already, has as many disks as a machine can, or runs in another tab says so instead.
-->
<script lang="ts">
  import Modal from './ui/Modal.svelte';
  import { errorText, t } from '../i18n.ts';
  import type { Store } from './store.ts';
  import { MAX_DISKS, type DiskRecord, type MachineRecord } from './shape.ts';
  import { attach } from './machines.ts';
  import { ui } from './ui.svelte.ts';

  type Props = {
    store: Store;
    disk: DiskRecord;
    machines: MachineRecord[];
    /** The machines that run, in this tab or another. */
    running: Set<string>;
    act(what: string, f: () => Promise<unknown>): Promise<void>;
    offFirst(m: MachineRecord): Promise<boolean>;
    close(): void;
  };
  let { store, disk, machines, running, act, offFirst, close }: Props = $props();

  let dialog: Modal;
  let error = $state('');

  /** Why machine `m` can't take the disk now, or undefined if it can. */
  const why = (m: MachineRecord) =>
    m.attachments.some((a) => a.disk === disk.id)
      ? t('disks:AttachDisk.has')
      : m.attachments.length >= MAX_DISKS
        ? t('disks:AttachDisk.full', { max: MAX_DISKS })
        : running.has(m.id) && m.id !== ui.current
          ? t('disks:AttachDisk.otherTab')
          : undefined;

  async function attachTo(m: MachineRecord) {
    error = '';
    const plain = $state.snapshot(m) as MachineRecord;
    let ok = false;
    await act(t('disks:AttachDisk.busy'), async () => {
      if (!(await offFirst(plain))) return;
      try {
        await attach(store, plain, $state.snapshot(disk) as DiskRecord);
        ok = true;
      } catch (e) {
        error = errorText(e);
      }
    });
    if (ok) dialog.close();
  }
</script>

<Modal
  id="attach-disk"
  bind:this={dialog}
  title={t('disks:AttachDisk.title', { disk: disk.name })}
  onclose={close}
  data-disk={disk.id}
>
  <p class="note">{t('disks:AttachDisk.note')}</p>
  <ul class="rows">
    {#each machines as m (m.id)}
      {@const no = why(m)}
      <li data-machine={m.id}>
        <div class="what">
          <strong>{m.name}</strong>
          <span class="meta"
            >{t('disks:AttachDisk.meta', { n: m.attachments.length, max: MAX_DISKS })}{#if running.has(m.id)}{' · '}{t(
                'disks:AttachDisk.running',
              )}{/if}</span
          >
          {#if no}<span class="meta warn" data-why>{no}</span>{/if}
        </div>
        <button class="primary" disabled={!!no} onclick={() => attachTo(m)} data-action="attach-to"
          >{t('disks:AttachDisk.attach')}</button
        >
      </li>
    {:else}
      <li class="none">{t('disks:AttachDisk.none')}</li>
    {/each}
  </ul>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#snippet buttons()}<span class="grow"></span><button onclick={() => dialog.close()}
      >{t('disks:AttachDisk.cancel')}</button
    >{/snippet}
</Modal>
