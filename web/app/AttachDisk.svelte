<!--
  Attach a disk to a machine (docs/machines.md §4): a dialog over the Disks pane of the Machines page, the other way round from
  Add a disk… › A disk already in this browser. The machines in this browser, each attaching the disk last, with its
  overlays; one that has it already, has as many disks as a machine can, or runs in another tab says so instead.
-->
<script lang="ts">
  import { onMount } from 'svelte';
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

  let dialog: HTMLDialogElement;
  let error = $state('');
  onMount(() => dialog.showModal());

  /** Why machine `m` can't take the disk now, or undefined if it can. */
  const why = (m: MachineRecord) =>
    m.attachments.some((a) => a.disk === disk.id) ? t('disks:AttachDisk.has')
    : m.attachments.length >= MAX_DISKS ? t('disks:AttachDisk.full', { max: MAX_DISKS })
    : running.has(m.id) && m.id !== ui.current ? t('disks:AttachDisk.otherTab')
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

<dialog id="attach-disk" bind:this={dialog} onclose={close} aria-labelledby="attach-disk-title" data-disk={disk.id}>
  <div class="body">
    <h2 id="attach-disk-title">{t('disks:AttachDisk.title', { disk: disk.name })}</h2>
    <p class="note">{t('disks:AttachDisk.note')}</p>
    <ul class="list">
      {#each machines as m (m.id)}
        {@const no = why(m)}
        <li data-machine={m.id}>
          <div class="what">
            <strong>{m.name}</strong>
            <span class="meta">{t('disks:AttachDisk.meta', { n: m.attachments.length, max: MAX_DISKS })}{#if running.has(m.id)}{' · '}{t('disks:AttachDisk.running')}{/if}</span>
            {#if no}<span class="meta why" data-why>{no}</span>{/if}
          </div>
          <button class="primary" disabled={!!no} onclick={() => attachTo(m)} data-action="attach-to">{t('disks:AttachDisk.attach')}</button>
        </li>
      {:else}
        <li class="none">{t('disks:AttachDisk.none')}</li>
      {/each}
    </ul>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <div class="buttons">
      <span class="grow"></span>
      <button onclick={() => dialog.close()}>{t('disks:AttachDisk.cancel')}</button>
    </div>
  </div>
</dialog>

<style>
  dialog { width: min(560px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); padding: 0; }
  .body { display: flex; flex-direction: column; gap: 12px; padding: 16px; }
  h2 { margin: 0; font-size: 16px; font-weight: 600; }
  .note { margin: 0; color: var(--dim); font-size: 13px; }
  .list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; max-height: 50vh; overflow: auto; }
  .list li { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); }
  .list li.none { color: var(--dim); }
  .what { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .meta { color: var(--dim); font-size: 12px; }
  .why { color: #ffb36b; }
  button { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line); border-radius: 6px; padding: 3px 10px; }
  .primary { background: #24406b; border-color: #3b6db3; color: #fff; }
  .primary:disabled { background: transparent; color: var(--dim); border-color: var(--line); }
  .error { color: #ff8f8f; white-space: pre-wrap; margin: 0; }
  .buttons { display: flex; gap: 8px; }
  .grow { flex: 1; }
</style>
