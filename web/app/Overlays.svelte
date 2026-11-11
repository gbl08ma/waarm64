<!--
  A disk's overlays (docs/machines.md §4): a dialog over the Machines page, opened by Overlays… on a disk in the Disks pane or
  on a machine's Disks tab. Each overlay with what it holds, when it was made and the machines that write to it; Rename,
  Delete, Merge into the disk (a stored disk) and Export. Which overlay a machine uses is chosen on its Disks tab.
-->
<script lang="ts">
  import type { Act } from './actions.svelte.ts';
  import ExportMenu from './ExportMenu.svelte';
  import Button from './ui/Button.svelte';
  import Card from './ui/Card.svelte';
  import CardList from './ui/CardList.svelte';
  import Note from './ui/Note.svelte';
  import Modal from './ui/Modal.svelte';
  import type { Dialog } from './ui/dialog.ts';
  import { ask } from './ask.svelte.ts';
  import { msg, MsgError, t } from '../i18n.ts';
  import { Actions } from './actions.svelte.ts';
  import type { OverlayRecord, Store } from './store.ts';
  import type { DiskRecord, MachineRecord } from './shape.ts';
  import { bytesText } from './bytes.ts';
  import { deleteOverlay, mergeCosts, mergeIntoDisk, renameOverlay } from './disks.ts';

  type Props = {
    store: Store;
    disk: DiskRecord;
    /** Every overlay in this browser (the page's, reread after each change); the disk's are shown. */
    overlays: OverlayRecord[];
    machines: MachineRecord[];
    act: Act;
    close: () => void;
  };
  let { store, disk, overlays, machines, act, close }: Props = $props();

  let dialog: Dialog;
  /** The dialog's own runner: its errors show here (the page's bar is behind the dialog); the page's `act` says what runs. */
  const runner = new Actions();

  const mine = $derived(overlays.filter((o) => o.disk === disk.id).sort((a, b) => a.created - b.created));
  /** The machines whose attachment of this disk writes to overlay `id`. */
  const usersOf = (id: string) =>
    machines.filter((m) => m.attachments.some((a) => a.disk === disk.id && a.overlay === id)).map((m) => m.name);

  /** Runs an action through the page's `act` (what runs, the reread), its error shown here. */
  const run = (what: string, f: () => Promise<unknown>) => act(what, () => runner.run(what, f));

  async function rename(o: OverlayRecord) {
    const name = await ask.prompt(t('disks:Overlays.rename.text'), o.name, {
      title: t('disks:Overlays.rename.title', { name: o.name }),
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
      !(await ask.confirm(t('disks:Overlays.delete.confirm', { name: o.name, size: bytesText(o.bytes) }), {
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
    const others = await mergeCosts(store, o.id);
    const pinned = new Set([`disks/${disk.id}`, `overlays/${o.id}`, ...others.map((x) => `overlays/${x.id}`)]);
    const snaps = (await store.all('snapshots')).filter((s) => s.pins.some((p) => p.overlay && pinned.has(p.overlay)));
    const deleted = others.length
      ? msg('disks:Overlays.merge.others', {
          list: others.map((x) => msg('disks:Overlays.merge.other', { name: x.name, size: bytesText(x.bytes) })),
        })
      : undefined;
    const orphaned = snaps.length ? msg('disks:Overlays.merge.snapshots', { count: snaps.length }) : undefined;
    if (
      !(await ask.confirm(
        t('disks:Overlays.merge.confirm', { overlay: o.name, disk: disk.name, others: deleted, snapshots: orphaned }),
        { ok: t('disks:Overlays.merge.ok'), danger: others.length > 0 },
      ))
    )
      return;
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
  title={t('disks:Overlays.title', { disk: disk.name })}
  onclose={close}
  data-disk={disk.id}
>
  <Note size="md">{t('disks:Overlays.note')}</Note>
  <CardList empty={mine.length ? undefined : t('disks:Overlays.none')}>
    {#each mine as o (o.id)}
      {@const users = usersOf(o.id)}
      <!-- An overlay's line (size, date, machines) is long: it takes the row, its actions go under it. -->
      <Card data-overlay={o.id}>
        <strong>{o.name}</strong>
        <Note inline
          >{o.fork
            ? t('disks:Overlays.meta.forked', { size: bytesText(o.bytes), when: new Date(o.created) })
            : t('disks:Overlays.meta', { size: bytesText(o.bytes), when: new Date(o.created) })} · {users.length
            ? t('disks:Overlays.usedBy', { machines: users })
            : t('disks:Overlays.usedByNone')}</Note
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
          {#if disk.kind === 'stored'}<Button
              icon="git-merge"
              onclick={() => merge(o)}
              title={t('disks:Overlays.mergeButton.title')}
              data-action="merge-overlay">{t('disks:Overlays.mergeButton')}</Button
            >{/if}
          <ExportMenu id={o.id} {disk} overlay={o.id} changes={disk.kind !== 'blank'} />
        </div>
      </Card>
    {/each}
  </CardList>
  {#if runner.error}<Note tone="error" size="md" class="error" role="alert">{runner.error.text}</Note>{/if}
  {#snippet buttons()}<Button onclick={() => dialog.close()} data-action="close-overlays"
      >{t('disks:Overlays.close')}</Button
    >{/snippet}
</Modal>

<style>
  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-3);
    margin-top: var(--space-3);
  }
</style>
