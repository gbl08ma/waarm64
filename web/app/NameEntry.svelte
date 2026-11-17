<!--
  One registered name in a room adapter's details (NetDetails.svelte; docs/plans/room-names.md "What the user sees"):
  its state, where it points (the name itself and each label under it, each at a member's name in the room: this
  machine's, or one pasted), a label added, where one points changed, Save (a new zone: web/names.ts `setZone`), and
  Let it go (a release, after asking). A name let go, lost or lapsed shows its state alone.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import Button from './ui/Button.svelte';
  import Note from './ui/Note.svelte';
  import { Actions } from './actions.svelte.ts';
  import { ask } from './ask.svelte.ts';
  import { MsgError, t, text } from '../i18n.ts';
  import type { NamesConn, TitleView, ZonePoint } from '../names.ts';
  import { pageNames } from './areas/names.svelte.ts';
  import { parseTarget, targetName, titleState } from './names-view.ts';

  type Props = { v: TitleView; conn: NamesConn; domain: string; here: string };
  let { v, conn, domain, here }: Props = $props();

  type Row = { label: string | null; target: string };
  const rowsOf = (points: ZonePoint[]): Row[] =>
    points.map((p) => ({ label: p.label, target: targetName(p.key, domain) }));
  // Its points as they were when the details opened (a save reads the title again; these rows are what was saved).
  let rows = $state<Row[]>(untrack(() => rowsOf(v.points)));
  const live = $derived(
    v.state === 'preparing' || v.state === 'reserved' || v.state === 'active' || v.state === 'grace',
  );
  const runner = new Actions();
  const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

  function points(): ZonePoint[] {
    const out: ZonePoint[] = [];
    for (const r of rows) {
      const label = r.label === null ? null : r.label.trim().toLowerCase();
      if (label !== null && !LABEL.test(label)) throw new MsgError('network:NameEntry.badLabel', { label });
      const key = parseTarget(r.target);
      if (!key) throw new MsgError('network:NameEntry.badTarget', { target: r.target });
      out.push({ label, key });
    }
    return out;
  }
  const save = () => runner.run('', () => pageNames.setZone(conn, v.name, points()));
  async function letGo() {
    const sure = await ask.confirm(t('network:NameEntry.release.confirm', { name: v.name }), {
      ok: t('network:NameEntry.release'),
      danger: true,
    });
    if (sure) await runner.run('', () => pageNames.release(conn, v.name));
  }
</script>

<div class="entry" data-name={v.name} data-state={v.state}>
  <p class="head"><strong>{v.name}</strong> <Note inline>{text(titleState(v))}</Note></p>
  {#if live}
    {#each rows as r, k (k)}
      <div class="row" data-point={r.label ?? ''}>
        {#if r.label === null}
          <span class="label">{v.name}</span>
        {:else}
          <input
            class="label"
            data-field="label"
            bind:value={r.label}
            aria-label={t('network:NameEntry.label')}
            autocomplete="off"
            spellcheck="false"
          />
        {/if}
        <input
          class="target"
          data-field="target"
          bind:value={r.target}
          aria-label={t('network:NameEntry.target')}
          autocomplete="off"
          spellcheck="false"
        />
        {#if r.label !== null}
          <Button
            variant="plain"
            icon="trash"
            data-action="remove-label"
            title={t('network:NameEntry.removeLabel')}
            aria-label={t('network:NameEntry.removeLabel')}
            onclick={() => (rows = rows.filter((_, i) => i !== k))}
          />
        {/if}
      </div>
    {/each}
    <Note>{t('network:NameEntry.note', { name: v.name })}</Note>
    <div class="actions">
      <Button
        data-action="add-label"
        onclick={() => (rows = [...rows, { label: '', target: targetName(here, domain) }])}
      >
        {t('network:NameEntry.addLabel')}
      </Button>
      <Button
        data-action="point-here"
        onclick={() => (rows = rows.map((r) => ({ ...r, target: targetName(here, domain) })))}
      >
        {t('network:NameEntry.pointHere')}
      </Button>
      <Button variant="primary" data-action="save-zone" onclick={save}>{t('network:NameEntry.save')}</Button>
      <Button variant="danger" data-action="release" onclick={letGo}>{t('network:NameEntry.release')}</Button>
    </div>
    {#if runner.error}<Note tone="error">{runner.error.text}</Note>{/if}
  {/if}
</div>

<style>
  .entry {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding-top: var(--space-3);
    border-top: 1px solid var(--border);
  }
  .head {
    margin: 0;
  }
  .row {
    display: grid;
    grid-template-columns: minmax(80px, 140px) 1fr auto;
    gap: var(--space-3);
    align-items: center;
  }
  .target {
    min-width: 0;
    font-family: var(--font-mono);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
  }
</style>
