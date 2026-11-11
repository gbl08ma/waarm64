<!--
  A machine's snapshots on the Machines page (docs/machines.md §5): the ones kept in this browser, orphaned ones
  marked with what differs (their shape isn't the machine's now); restore (on this page's machine), rename, download,
  delete, delete all orphaned, make a machine like an orphaned one; a file restored at once or kept; one saved to a
  file. The restore itself is the page's (web/app/main.ts: it confirms the forks). Without `machine`, the page's
  transient machine: files only.
-->
<script lang="ts">
  import Icon from './Icon.svelte';
  import { ask } from './ask.svelte.ts';
  import type { Store, SnapshotRecord } from './store.ts';
  import type { MachineRecord, Shape } from './shape.ts';
  import { shapeDiff } from './shape.ts';
  import { snapshotPath } from './store.ts';
  import { t, text } from '../i18n.ts';
  import { importSnapshot, machineLike } from './snapshots.ts';
  import { opfsDir } from '../overlay.ts';
  import { page, ui } from './ui.svelte.ts';

  type Props = {
    store: Store;
    machine?: MachineRecord;
    running?: boolean;
    act(what: string, f: () => Promise<unknown>): Promise<void>;
  };
  let { store, machine, running = false, act }: Props = $props();

  let kept = $state<SnapshotRecord[]>([]);
  let now = $state<{ shape: Shape; hash: string } | undefined>();
  $effect(() => {
    void ui.records;
    const m = machine;
    if (!m) return;
    void (async () => {
      kept = (await store.snapshotsOf(m.id)).sort((a, b) => b.created - a.created);
      now = await page.shapeNow(m).catch(() => undefined);
    })();
  });
  const orphaned = (s: SnapshotRecord) => !!now && s.shapeHash !== now.hash;
  const why = (s: SnapshotRecord) =>
    now
      ? shapeDiff(s.shape, now.shape)
          .map((m) => text(m))
          .join('; ')
      : '';
  const inPlace = $derived(!!machine?.attachments.some((a) => a.inPlace && !a.readOnly));
  /** The machine runs on this page: snapshots restore onto it, and it can save one. */
  const here = $derived(machine ? machine.id === ui.current : true);
  const live = $derived(here && (machine ? running : ui.state === 'running' || ui.state === 'booting'));

  async function download(s: SnapshotRecord) {
    const parts = snapshotPath(s.machine, s.id).split('/');
    const name = parts.pop()!;
    const file = await (await (await opfsDir(parts.join('/'))).getFileHandle(name)).getFile();
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(file),
      download: `${s.name.replace(/[^\w.-]+/g, '-')}.webpcsnap`,
    });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
  }
  async function rename(s: SnapshotRecord) {
    const name = (
      await ask.prompt(t('snapshots:Snapshots.rename.prompt'), s.name, {
        title: t('snapshots:Snapshots.rename.title', { name: s.name }),
        ok: t('snapshots:Snapshots.rename.ok'),
      })
    )?.trim();
    if (name && name !== s.name)
      await act(t('snapshots:Snapshots.renaming'), () =>
        store.put('snapshots', { ...($state.snapshot(s) as SnapshotRecord), name }),
      );
  }
  async function remove(s: SnapshotRecord) {
    if (
      await ask.confirm(t('snapshots:Snapshots.delete.confirm', { name: s.name, size: s.bytes }), {
        ok: t('snapshots:Snapshots.delete.ok'),
        danger: true,
      })
    )
      await act(t('snapshots:Snapshots.deleting'), () => store.deleteSnapshot(s.id));
  }
  async function removeOrphaned() {
    const gone = kept.filter(orphaned);
    if (
      await ask.confirm(
        t('snapshots:Snapshots.deleteOrphaned.confirm', {
          count: gone.length,
          size: gone.reduce((n, s) => n + s.bytes, 0),
        }),
        { ok: t('snapshots:Snapshots.deleteOrphaned.ok'), danger: true },
      )
    ) {
      await act(t('snapshots:Snapshots.deleting'), async () => {
        for (const s of gone) await store.deleteSnapshot(s.id);
      });
    }
  }
  function like(s: SnapshotRecord) {
    void act(t('snapshots:Snapshots.making'), async () => {
      ui.machinesSelected = (await machineLike(store, s)).id;
      ui.machinesTab = 'settings';
    });
  }
  function restore(s: SnapshotRecord) {
    page.closeMachines();
    page.restoreKept(s.id);
  }
  let importInput = $state<HTMLInputElement>();
  const imported = () => {
    const f = importInput!.files?.[0];
    importInput!.value = '';
    if (f && machine) void act(t('snapshots:Snapshots.importing'), () => importSnapshot(store, machine.id, f));
  };
  const restoreFile = () => document.getElementById('load-snapshot-input')!.click();
  async function toFile() {
    const whole =
      inPlace &&
      (await ask.confirm(t('snapshots:Snapshots.toFile.ask'), {
        title: t('snapshots:Snapshots.toFile.ask.title'),
        ok: t('snapshots:Snapshots.toFile.ask.whole'),
        cancel: t('snapshots:Snapshots.toFile.ask.without'),
      }));
    page.saveSnapshotFile(whole);
  }
</script>

<div class="snapshots">
  {#if machine}
    {#if !kept.length}<p class="note">{t('snapshots:Snapshots.none')}</p>{/if}
    <ul>
      {#each kept as s (s.id)}
        <li data-snapshot={s.id} class:orphaned={orphaned(s)}>
          <Icon name="history" size={18} />
          <div class="what">
            <strong>{s.name}</strong>
            <span class="meta">{t('snapshots:Snapshots.meta', { when: new Date(s.created), size: s.bytes })}</span>
            {#if orphaned(s)}<span class="orphan" title={why(s)}
                >{t('snapshots:Snapshots.orphaned', { why: why(s) })}</span
              >{/if}
          </div>
          {#if orphaned(s)}
            <button onclick={() => like(s)} title={t('snapshots:Snapshots.like.title')}
              >{t('snapshots:Snapshots.like')}</button
            >
          {:else}
            <button
              onclick={() => restore(s)}
              disabled={!here}
              title={here ? t('snapshots:Snapshots.restore.title') : t('snapshots:Snapshots.restore.notHere')}
              data-action="restore"><Icon name="history" size={16} />{t('snapshots:Snapshots.restore')}</button
            >
          {/if}
          <button
            class="icon"
            onclick={() => rename(s)}
            aria-label={t('snapshots:Snapshots.rename')}
            title={t('snapshots:Snapshots.rename')}><Icon name="pencil" size={16} /></button
          >
          <button
            class="icon"
            onclick={() => download(s)}
            aria-label={t('snapshots:Snapshots.download')}
            title={t('snapshots:Snapshots.download.title')}><Icon name="download" size={16} /></button
          >
          <button
            class="icon"
            onclick={() => remove(s)}
            aria-label={t('snapshots:Snapshots.delete')}
            title={t('snapshots:Snapshots.delete')}><Icon name="trash" size={16} /></button
          >
        </li>
      {/each}
    </ul>
  {/if}
  <div class="row">
    {#if machine && kept.some(orphaned)}<button onclick={removeOrphaned} data-action="delete-orphaned"
        ><Icon name="trash" size={16} />{t('snapshots:Snapshots.deleteOrphaned')}</button
      >{/if}
    {#if here}<button onclick={restoreFile} title={t('snapshots:Snapshots.restoreFile.title')}
        ><Icon name="history" size={16} />{t('snapshots:Snapshots.restoreFile')}</button
      >{/if}
    {#if machine}
      <button onclick={() => importInput?.click()} title={t('snapshots:Snapshots.import.title')}
        ><Icon name="file-import" size={16} />{t('snapshots:Snapshots.import')}</button
      >
      <input
        type="file"
        accept=".webpcsnap"
        hidden
        bind:this={importInput}
        onchange={imported}
        data-field="import-snapshot"
      />
    {/if}
    {#if live}<button onclick={toFile} title={t('snapshots:Snapshots.toFile.title')}
        ><Icon name="file-export" size={16} />{t('snapshots:Snapshots.toFile')}</button
      >{/if}
  </div>
</div>

<style>
  .snapshots ul {
    list-style: none;
    padding: 0;
    margin: 0 0 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .snapshots li {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    padding: 8px 12px;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--panel);
  }
  .what {
    flex: 1;
    min-width: 200px;
    display: flex;
    flex-direction: column;
  }
  .orphaned strong {
    text-decoration: line-through;
    opacity: 0.7;
  }
  .orphan {
    color: #ffb36b;
    font-size: 12px;
  }
  .meta,
  .note {
    color: var(--dim);
    font-size: 12px;
  }
  .note {
    margin: 0 0 8px;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 3px 10px;
  }
  button.icon {
    padding: 3px 5px;
  }
</style>
