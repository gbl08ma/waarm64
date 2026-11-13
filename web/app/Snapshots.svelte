<!--
  A machine's snapshots on the Machines page (docs/machines.md §5): the ones kept in this browser, orphaned ones
  marked with what differs (their shape isn't the machine's now); restore (on this page's machine), rename, download,
  delete, delete all orphaned, make a machine like an orphaned one; a file restored at once or kept; one saved to a
  file. The restore itself is the page's (web/app/areas/snapshot-restore.ts: it confirms the forks). Without `machine`, the page's
  transient machine: files only.
-->
<script lang="ts">
  import type { Act } from './actions.svelte.ts';
  import Button from './ui/Button.svelte';
  import Card from './ui/Card.svelte';
  import CardList from './ui/CardList.svelte';
  import Icon from './ui/Icon.svelte';
  import Note from './ui/Note.svelte';
  import { ask } from './ask.svelte.ts';
  import type { Store, SnapshotRecord } from './store.ts';
  import type { MachineRecord, Shape } from './shape.ts';
  import { shapeDiff } from './shape-diff.ts';
  import { snapshotPath } from './store.ts';
  import { t, text } from '../i18n.ts';
  import { importSnapshot, machineLike } from './snapshots.ts';
  import { opfsDir } from '../overlay.ts';
  import { machinesNav } from './areas/machines-nav.svelte.ts';
  import { records } from './areas/records.svelte.ts';
  import { current } from './areas/current.svelte.ts';
  import { isLive, power } from './areas/power.svelte.ts';
  import { inBar, page } from './page.ts';
  import { openPicker } from './file-pickers.ts';

  type Props = {
    store: Store;
    machine?: MachineRecord;
    running?: boolean;
    act: Act;
  };
  let { store, machine, running = false, act }: Props = $props();

  const kept = $derived(
    machine ? records.snapshots.filter((s) => s.machine === machine.id).sort((a, b) => b.created - a.created) : [],
  );
  /** The machine's shape now (an orphaned snapshot's differs), read again with the records. */
  let now = $state<{ shape: Shape; hash: string } | undefined>();
  $effect(() => {
    const [m, disks] = [machine, records.disks];
    if (!m) return;
    let shown = true;
    void page
      .shapeNow(m, disks)
      .catch(() => undefined)
      .then((n) => {
        if (shown) now = n;
      });
    return () => {
      shown = false;
    };
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
  const here = $derived(machine ? machine.id === current.id : true);
  const live = $derived(here && (machine ? running : isLive(power.state)));

  async function download(s: SnapshotRecord) {
    const path = snapshotPath(s.machine, s.id);
    const slash = path.lastIndexOf('/');
    const file = await (await (await opfsDir(path.slice(0, slash))).getFileHandle(path.slice(slash + 1))).getFile();
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(file),
      download: `${s.name.replace(/[^\w.-]+/g, '-')}.waarm64snap`,
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
      await act(t('snapshots:Snapshots.renaming'), () => store.put('snapshots', { ...$state.snapshot(s), name }));
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
      machinesNav.choose((await machineLike(store, s)).id);
      machinesNav.tab = 'settings';
    });
  }
  function restore(s: SnapshotRecord) {
    page.closeMachines();
    inBar(() => page.restoreKept(s.id));
  }
  let importInput = $state<HTMLInputElement>();
  const imported = (e: Event & { currentTarget: HTMLInputElement }) => {
    const input = e.currentTarget;
    const f = input.files?.[0];
    input.value = '';
    if (f && machine) void act(t('snapshots:Snapshots.importing'), () => importSnapshot(store, machine.id, f));
  };
  const restoreFile = () => openPicker('snapshot');
  async function toFile() {
    const whole =
      inPlace &&
      (await ask.confirm(t('snapshots:Snapshots.toFile.ask'), {
        title: t('snapshots:Snapshots.toFile.ask.title'),
        ok: t('snapshots:Snapshots.toFile.ask.whole'),
        cancel: t('snapshots:Snapshots.toFile.ask.without'),
      }));
    inBar(() => page.saveSnapshotFile(whole));
  }
</script>

<div class="snapshots">
  {#if machine}
    {#if !kept.length}<Note>{t('snapshots:Snapshots.none')}</Note>{:else}
      <CardList>
        {#each kept as s (s.id)}
          <Card data-snapshot={s.id} class={orphaned(s) ? 'orphaned' : undefined}>
            <div class="named">
              <Icon name="history" size={18} />
              <div class="lines">
                <strong class={{ struck: orphaned(s) }}>{s.name}</strong>
                <Note inline class="meta"
                  >{t('snapshots:Snapshots.meta', { when: new Date(s.created), size: s.bytes })}</Note
                >
                {#if orphaned(s)}<Note inline tone="warn" class="orphan" title={why(s)}
                    >{t('snapshots:Snapshots.orphaned', { why: why(s) })}</Note
                  >{/if}
              </div>
            </div>
            {#snippet actions()}
              {#if orphaned(s)}
                <Button onclick={() => like(s)} title={t('snapshots:Snapshots.like.title')}
                  >{t('snapshots:Snapshots.like')}</Button
                >
              {:else}
                <Button
                  icon="history"
                  onclick={() => restore(s)}
                  disabled={!here || power.busy}
                  title={here ? t('snapshots:Snapshots.restore.title') : t('snapshots:Snapshots.restore.notHere')}
                  data-action="restore">{t('snapshots:Snapshots.restore')}</Button
                >
              {/if}
              <Button
                icon="pencil"
                onclick={() => rename(s)}
                aria-label={t('snapshots:Snapshots.rename')}
                title={t('snapshots:Snapshots.rename')}
              ></Button>
              <Button
                icon="download"
                onclick={() => download(s)}
                aria-label={t('snapshots:Snapshots.download')}
                title={t('snapshots:Snapshots.download.title')}
              ></Button>
              <Button
                icon="trash"
                onclick={() => remove(s)}
                aria-label={t('snapshots:Snapshots.delete')}
                title={t('snapshots:Snapshots.delete')}
              ></Button>
            {/snippet}
          </Card>
        {/each}
      </CardList>
    {/if}
  {/if}
  <div class="row">
    {#if machine && kept.some(orphaned)}<Button icon="trash" onclick={removeOrphaned} data-action="delete-orphaned"
        >{t('snapshots:Snapshots.deleteOrphaned')}</Button
      >{/if}
    {#if here}<Button icon="history" onclick={restoreFile} title={t('snapshots:Snapshots.restoreFile.title')}
        >{t('snapshots:Snapshots.restoreFile')}</Button
      >{/if}
    {#if machine}
      <Button icon="file-import" onclick={() => importInput?.click()} title={t('snapshots:Snapshots.import.title')}
        >{t('snapshots:Snapshots.import')}</Button
      >
      <input
        type="file"
        accept=".waarm64snap"
        hidden
        bind:this={importInput}
        onchange={imported}
        data-field="import-snapshot"
      />
    {/if}
    {#if live}<Button icon="file-export" onclick={toFile} title={t('snapshots:Snapshots.toFile.title')}
        >{t('snapshots:Snapshots.toFile')}</Button
      >{/if}
  </div>
</div>

<style>
  .snapshots {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }
  /* A row's icon beside its name and lines. */
  .named {
    display: flex;
    align-items: center;
    gap: var(--space-4);
  }
  .lines {
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .struck {
    text-decoration: line-through;
    opacity: 0.7;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
  }
</style>
