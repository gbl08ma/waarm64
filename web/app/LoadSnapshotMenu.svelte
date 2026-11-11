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
  import { records } from './areas/records.svelte.ts';
  import { current } from './areas/current.svelte.ts';
  import { power } from './areas/power.svelte.ts';
  import { page } from './page.ts';

  const LATEST = 5;
  let open = $state(false);
  /** The page's machine's shape now: a snapshot of another can't restore. */
  let now = $state<{ hash: string }>();
  const machine = $derived(records.machines.find((m) => m.id === current.id));
  // Read while the menu is open, again when the records change.
  $effect(() => {
    const [m, disks] = [machine, records.disks];
    if (!open || !m) return;
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
  const latest = $derived(
    records.snapshots
      .filter((s) => s.machine === current.id)
      .sort((a, b) => b.created - a.created)
      .slice(0, LATEST)
      .map((s) => ({ ...s, orphaned: !!now && s.shapeHash !== now.hash })),
  );
  /** Closes the menu, then does `f`. */
  const then = (f: () => void) => () => {
    open = false;
    f();
  };
</script>

<Menu
  id="load-snapshot"
  icon="history"
  title={t('toolbar:LoadSnapshotMenu.load.title')}
  bind:open
  disabled={power.busy}
>
  {#if current.id}
    {@const id = current.id}
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
