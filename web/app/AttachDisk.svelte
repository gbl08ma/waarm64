<!--
  Attach a disk to a machine (docs/machines.md §4): a dialog over the Disks pane of the Home page, the other way round from
  Add a disk… › A disk already in this browser. The machines in this browser, each attaching the disk last, with its
  overlays; one that has it already, has as many disks as a machine can, or runs in another tab says so instead.
-->
<script lang="ts">
  import { Actions, type Act } from './actions.svelte.ts';
  import Button from './ui/Button.svelte';
  import Card from './ui/Card.svelte';
  import CardList from './ui/CardList.svelte';
  import Modal from './ui/Modal.svelte';
  import type { Dialog } from './ui/dialog.ts';
  import Note from './ui/Note.svelte';
  import { t } from '../i18n.ts';
  import type { Store } from './store.ts';
  import { MAX_DISKS, type DiskRecord, type MachineRecord } from './shape.ts';
  import { attach } from './machines.ts';
  import { current } from './areas/current.svelte.ts';

  type Props = {
    store: Store;
    disk: DiskRecord;
    machines: MachineRecord[];
    /** The machines that run, in this tab or another. */
    running: Set<string>;
    act: Act;
    offFirst: (m: MachineRecord) => Promise<boolean>;
    close: () => void;
  };
  let { store, disk, machines, running, act, offFirst, close }: Props = $props();

  let dialog: Dialog;
  /** The dialog's own runner: its errors show here (the page's bar is behind the dialog). */
  const runner = new Actions();

  /** Why machine `m` can't take the disk now, or undefined if it can. */
  const why = (m: MachineRecord) =>
    m.attachments.some((a) => a.disk === disk.id)
      ? t('disks:AttachDisk.has')
      : m.attachments.length >= MAX_DISKS
        ? t('disks:AttachDisk.full', { max: MAX_DISKS })
        : running.has(m.id) && m.id !== current.id
          ? t('disks:AttachDisk.otherTab')
          : undefined;

  /** A machine's line: its disks, and whether it runs. */
  function lineOf(m: MachineRecord) {
    const meta = t('disks:AttachDisk.meta', { n: m.attachments.length, max: MAX_DISKS });
    return running.has(m.id) ? `${meta} · ${t('disks:AttachDisk.running')}` : meta;
  }
  async function attachTo(m: MachineRecord) {
    const plain = $state.snapshot(m);
    let ok = false;
    await act(t('disks:AttachDisk.busy'), async () => {
      if (await offFirst(plain)) ok = await runner.run('', () => attach(store, plain, $state.snapshot(disk)));
    });
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- set by the callback `act` runs
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
  <Note size="md">{t('disks:AttachDisk.note')}</Note>
  <CardList empty={machines.length ? undefined : t('disks:AttachDisk.none')}>
    {#each machines as m (m.id)}
      {@const no = why(m)}
      <Card data-machine={m.id}>
        <strong>{m.name}</strong>
        <Note inline>{lineOf(m)}</Note>
        {#if no}<Note inline tone="warn" data-why>{no}</Note>{/if}
        {#snippet actions()}
          <Button variant="primary" disabled={!!no} onclick={() => attachTo(m)} data-action="attach-to"
            >{t('disks:AttachDisk.attach')}</Button
          >
        {/snippet}
      </Card>
    {/each}
  </CardList>
  {#if runner.error}<Note tone="error" class="error" role="alert">{runner.error.text}</Note>{/if}
  {#snippet buttons()}<Button onclick={() => dialog.close()}>{t('disks:AttachDisk.cancel')}</Button>{/snippet}
</Modal>
