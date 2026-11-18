<!--
  A disk's overlays (docs/machines.md §4): a dialog over the Home page, opened by Overlays… on a disk in the Disks pane or
  on a machine's Disks tab. Each overlay with what it holds of the size its guest sees, when it was made and the machines that write to it; Rename,
  Delete, Resize… (ResizeDisk.svelte, over this dialog), Merge into the disk (a stored or a blank disk: docs/machines.md
  §4.4) and Export. Export's steps
  (ExportSteps.svelte) take the dialog's place, the list the step before them (Back). Which overlay a machine uses is chosen on its Disks tab.
-->
<script lang="ts">
  import ErrorText from './ErrorText.svelte';
  import type { Act } from './actions.svelte.ts';
  import ExportSteps from './ExportSteps.svelte';
  import ResizeDisk from './ResizeDisk.svelte';
  import Button from './ui/Button.svelte';
  import Card from './ui/Card.svelte';
  import CardList from './ui/CardList.svelte';
  import Note from './ui/Note.svelte';
  import T from './T.svelte';
  import Modal from './ui/Modal.svelte';
  import type { Dialog } from './ui/dialog.ts';
  import { ask } from './ask.svelte.ts';
  import { msg, MsgError, t } from '../i18n.ts';
  import { Actions } from './actions.svelte.ts';
  import type { OverlayRecord, Store } from './store.ts';
  import type { DiskRecord, MachineRecord } from './shape.ts';
  import { bytesText } from './bytes.ts';
  import { deleteOverlay, renameOverlay } from './disks.ts';
  import { mergeEffect, mergeIntoDisk } from './merge.ts';
  import type { ExportMode, ExportStepsApi } from './export.ts';
  import { inBar, page } from './page.ts';

  type Props = {
    store: Store;
    disk: DiskRecord;
    /** Every overlay in this browser (the page's, reread after each change); the disk's are shown. */
    overlays: OverlayRecord[];
    machines: MachineRecord[];
    act: Act;
    offFirst: (m: MachineRecord) => Promise<boolean>;
    close: () => void;
  };
  let { store, disk, overlays, machines, act, offFirst, close }: Props = $props();

  let dialog: Dialog;
  /** The dialog's own runner: its errors show here (the page's bar is behind the dialog); the page's `act` says what runs. */
  const runner = new Actions();

  const mine = $derived(overlays.filter((o) => o.disk === disk.id).sort((a, b) => a.created - b.created));
  /** The machines whose attachment of this disk writes to overlay `id`. */
  const usersOf = (id: string) =>
    machines.filter((m) => m.attachments.some((a) => a.disk === disk.id && a.overlay === id)).map((m) => m.name);

  /** The overlay whose Resize dialog is open (over this one). */
  let resizing = $state<OverlayRecord>();

  /** The overlay being exported: Export's steps show instead of the list. */
  let exporting = $state<OverlayRecord>();
  let steps = $state<ExportStepsApi>();
  function startExport(o: OverlayRecord) {
    runner.clear();
    exporting = o;
  }
  function save(mode: ExportMode, compress: boolean) {
    const overlay = exporting?.id;
    exporting = undefined;
    inBar(() => page.saveDisk(mode, compress, { disk: $state.snapshot(disk), overlay }));
  }
  function goBack() {
    if (!steps?.back()) exporting = undefined;
  }

  /** Runs an action through the page's `act` (what runs, the reread), its error shown here. */
  const run = (what: string, f: () => Promise<unknown>) => act(what, () => runner.run(what, f));

  async function rename(o: OverlayRecord) {
    const name = await ask.prompt(t('disks:Overlays.rename.text'), o.name, {
      title: msg('disks:Overlays.rename.title', { name: o.name }),
      ok: t('disks:Overlays.rename.ok'),
    });
    if (name)
      await run(t('disks:Overlays.busy.rename'), () =>
        renameOverlay(store, o.id, name).catch((e: unknown) => {
          throw new MsgError('disks:Overlays.failed.rename', {}, { cause: e });
        }),
      );
  }
  async function remove(o: OverlayRecord) {
    if (
      !(await ask.confirm(msg('disks:Overlays.delete.confirm', { name: o.name, size: bytesText(o.bytes) }), {
        ok: t('disks:Overlays.delete.ok'),
        danger: true,
      }))
    )
      return;
    await run(t('disks:Overlays.busy.delete'), () =>
      deleteOverlay(store, o.id).catch((e: unknown) => {
        throw new MsgError('disks:Overlays.failed.delete', {}, { cause: e });
      }),
    );
  }
  async function merge(o: OverlayRecord) {
    const effect = await mergeEffect(store, o.id);
    if (!effect) return;
    const { how, others, size, snapshots } = effect;
    const deleted = others.length
      ? msg('disks:Overlays.merge.others', {
          list: others.map((x) => msg('disks:Overlays.merge.other', { name: x.name, size: bytesText(x.bytes) })),
        })
      : undefined;
    const orphaned = snapshots.length ? msg('disks:Overlays.merge.snapshots', { count: snapshots.length }) : undefined;
    const words = { overlay: o.name, disk: disk.name, others: deleted, snapshots: orphaned };
    const question =
      how === 'grow'
        ? msg('disks:Overlays.merge.confirm.grow', { overlay: o.name, disk: disk.name, size, snapshots: orphaned })
        : how === 'convert'
          ? msg('disks:Overlays.merge.confirm.blank', { ...words, size })
          : msg('disks:Overlays.merge.confirm', words);
    if (!(await ask.confirm(question, { ok: t('disks:Overlays.merge.ok'), danger: others.length > 0 }))) return;
    await run(t('disks:Overlays.busy.merge'), () =>
      mergeIntoDisk(store, o.id).catch((e: unknown) => {
        throw new MsgError('disks:Overlays.failed.merge', {}, { cause: e });
      }),
    );
  }
</script>

<Modal
  id="overlays"
  bind:this={dialog}
  title={exporting ? (steps?.title() ?? '') : msg('disks:Overlays.title', { disk: disk.name })}
  onclose={close}
  data-disk={disk.id}
>
  {#if exporting}
    <ExportSteps bind:this={steps} name={exporting.name} changes={disk.kind !== 'blank'} {save}
      >{#snippet hint()}{t('disks:Overlays.exportHint')}{/snippet}</ExportSteps
    >
  {:else}
    <Note size="md"><T k="disks:Overlays.note" /></Note>
    <CardList empty={mine.length ? undefined : t('disks:Overlays.none')}>
      {#each mine as o (o.id)}
        {@const users = usersOf(o.id)}
        <!-- An overlay's line (size, date, machines) is long: it takes the row, its actions go under it. -->
        <Card data-overlay={o.id}>
          <strong>{o.name}</strong>
          <Note inline
            >{t(o.fork ? 'disks:Overlays.meta.forked' : 'disks:Overlays.meta', {
              held: bytesText(o.bytes),
              size: bytesText(Math.max(disk.size, o.size ?? 0)),
              when: new Date(o.created),
            })} · {#if users.length}<T k="disks:Overlays.usedBy" params={{ machines: users }} />{:else}{t(
                'disks:Overlays.usedByNone',
              )}{/if}</Note
          >
          <div class="actions">
            <Button
              icon="pencil"
              onclick={() => rename(o)}
              title={t('disks:Overlays.renameButton.title')}
              data-action="rename-overlay">{t('disks:Overlays.renameButton')}</Button
            >
            <Button
              icon="trash"
              onclick={() => remove(o)}
              title={t('disks:Overlays.deleteButton.title')}
              data-action="delete-overlay">{t('disks:Overlays.deleteButton')}</Button
            >
            <Button
              onclick={() => (resizing = o)}
              title={t('disks:Overlays.resizeButton.title')}
              data-action="resize-overlay">{t('disks:Overlays.resizeButton')}</Button
            >
            {#if disk.kind === 'stored' || disk.kind === 'blank'}<Button
                icon="git-merge"
                onclick={() => merge(o)}
                title={disk.kind === 'blank'
                  ? t('disks:Overlays.mergeButton.title.blank')
                  : t('disks:Overlays.mergeButton.title')}
                data-action="merge-overlay">{t('disks:Overlays.mergeButton')}</Button
              >{/if}
            <Button
              icon="download"
              onclick={() => startExport(o)}
              title={t('disks:Overlays.exportButton.title')}
              data-action="export">{t('disks:Overlays.exportButton')}</Button
            >
          </div>
        </Card>
      {/each}
    </CardList>
  {/if}
  {#if runner.error}<Note tone="error" size="md" class="error" role="alert"><ErrorText error={runner.error} /></Note
    >{/if}
  {#snippet back()}
    {#if exporting}<Button type="button" data-action="export-back" onclick={goBack}>{t('disks:Overlays.back')}</Button
      >{/if}
  {/snippet}
  {#snippet buttons()}<Button onclick={() => dialog.close()} data-action="close-overlays"
      >{t('disks:Overlays.close')}</Button
    >{/snippet}
</Modal>
{#if resizing}<ResizeDisk
    {store}
    target={{ overlay: resizing.id }}
    name={resizing.name}
    ramdisk={false}
    {act}
    {offFirst}
    close={() => (resizing = undefined)}
  />{/if}

<style>
  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-3);
    margin-top: var(--space-3);
  }
</style>
