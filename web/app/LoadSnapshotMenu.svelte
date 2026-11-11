<!--
  The toolbar's Load snapshot menu (docs/frontend.md "Snapshots"): the machine's latest kept snapshots (orphaned ones
  can't restore: shown, disabled), all of them (its Snapshots tab), or a file.
-->
<script lang="ts">
  import Button from './ui/Button.svelte';
  import Menu from './ui/Menu.svelte';
  import Note from './ui/Note.svelte';
  import { openPicker } from './file-pickers.ts';
  import { t } from '../i18n.ts';
  import type { SnapshotRecord, Store } from './store.ts';
  import { page, ui } from './ui.svelte.ts';

  type Props = { store: Store };
  let { store }: Props = $props();

  const LATEST = 5;
  let open = $state(false);
  let latest = $state<(SnapshotRecord & { orphaned: boolean })[]>([]);
  // Read from the store while it's open, again when the records change.
  $effect(() => {
    // eslint-disable-next-line @typescript-eslint/no-meaningless-void-operator -- a change counter's read (docs/frontend-code.md §3.1: to go)
    void ui.records;
    const id = ui.current;
    if (!open || !id) return;
    void (async () => {
      const m = await store.get('machines', id);
      const now = m ? await page.shapeNow(m).catch(() => undefined) : undefined;
      const kept = (await store.snapshotsOf(id)).sort((a, b) => b.created - a.created).slice(0, LATEST);
      latest = kept.map((s) => ({ ...s, orphaned: !!now && s.shapeHash !== now.hash }));
    })();
  });
  /** Closes the menu, then does `f`. */
  const then = (f: () => void) => () => {
    open = false;
    f();
  };
</script>

<Menu id="load-snapshot" icon="history" title={t('toolbar:LoadSnapshotMenu.load.title')} bind:open disabled={ui.busy}>
  {#if ui.current}
    {@const id = ui.current}
    <div class="heading">{t('toolbar:LoadSnapshotMenu.load.latest')}</div>
    {#each latest as s (s.id)}
      <Button
        variant="item"
        data-snapshot={s.id}
        disabled={s.orphaned}
        title={s.orphaned
          ? t('toolbar:LoadSnapshotMenu.load.orphaned.title')
          : t('toolbar:LoadSnapshotMenu.load.restore.title', { name: s.name })}
        onclick={then(() => page.restoreKept(s.id))}
      >
        <span>{s.name}</span><span class="dim">{new Date(s.created).toLocaleString()}</span>
      </Button>
    {:else}
      <div class="hint"><Note>{t('toolbar:LoadSnapshotMenu.load.none')}</Note></div>
    {/each}
    <hr />
    <Button variant="item" onclick={then(() => page.openMachines('snapshots', id))}>
      {t('toolbar:LoadSnapshotMenu.load.all')}
    </Button>
  {/if}
  <Button variant="item" onclick={then(() => openPicker('snapshot'))}>{t('toolbar:LoadSnapshotMenu.load.file')}</Button>
</Menu>

<style>
  .heading {
    padding: var(--space-3) var(--space-4) var(--space-1);
    color: var(--text-dim);
    font-size: var(--text-sm);
  }
  .dim {
    color: var(--text-dim);
    font-size: var(--text-sm);
  }
  .hint {
    max-width: 280px;
    padding: var(--space-2) var(--space-4);
  }
</style>
