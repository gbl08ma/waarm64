<!--
  One domain of a room connection, a card of its Domains pane (DomainsPane.svelte; docs/networking/names.md "What the
  user sees"): the whole domain (the name strong, the room's domain dim), its light and its state in words, its dates
  where the title has them (registered, the next renewal from, works until about), then where it points (the domain
  itself and each subdomain, each at a member's name in the room: this connection's, or one pasted), a subdomain added,
  where one points changed, Save (a new zone: web/names.ts `setZone`), and Let it go (a release, after asking). A domain
  let go, lost or lapsed shows its state and what that means, with nothing to edit. `here` (this connection's node key)
  and `domain` (the room's) are the names agent's `member`'s, so it works with the connection disconnected.
-->
<script lang="ts">
  import ErrorText from './ErrorText.svelte';
  import { untrack } from 'svelte';
  import Button from './ui/Button.svelte';
  import Card from './ui/Card.svelte';
  import Note from './ui/Note.svelte';
  import StatusDot from './ui/StatusDot.svelte';
  import T from './T.svelte';
  import { Actions } from './actions.svelte.ts';
  import { ask } from './ask.svelte.ts';
  import { msg, t, text } from '../i18n.ts';
  import type { NamesConn, TitleView } from '../names.ts';
  import type { ZonePoint } from '../names-store.ts';
  import { pageNames } from './areas/names.svelte.ts';
  import {
    endedWords,
    isLive,
    MAX_POINTS,
    targetName,
    titleDates,
    titleState,
    titleTone,
    zonePoints,
  } from './names-view.ts';

  type Props = { v: TitleView; conn: NamesConn; domain: string; here: string };
  let { v, conn, domain, here }: Props = $props();

  type Row = { label: string | null; target: string };
  const rowsOf = (points: ZonePoint[]): Row[] =>
    points.map((p) => ({ label: p.label, target: targetName(p.key, domain) }));
  // Its points as edited here: they follow the title's (a domain registered while the card shows, a save read back)
  // until edited, as a machine's or a connection's settings do.
  let rows = $state<Row[]>(untrack(() => rowsOf(v.points)));
  let base = untrack(() => rowsOf(v.points));
  const same = (a: Row[], b: Row[]) => JSON.stringify(a) === JSON.stringify(b);
  $effect(() => {
    const now = rowsOf(v.points);
    untrack(() => {
      if (same(rows, base)) rows = now;
      base = now;
    });
  });
  const live = $derived(isLive(v));
  const dates = $derived(live ? titleDates(v) : []);
  const ended = $derived(endedWords(v));
  const runner = new Actions();

  const save = () => runner.run('', () => pageNames.setZone(conn, v.name, zonePoints(rows)));
  async function letGo() {
    const sure = await ask.confirm(msg('network:DomainCard.release.confirm', { name: v.name }), {
      ok: t('network:DomainCard.release'),
      danger: true,
    });
    if (sure) await runner.run('', () => pageNames.release(conn, v.name));
  }
</script>

<Card class="domain" data-name={v.name} data-state={v.state}>
  <div class="what">
    <p class="head">
      <span class="light"><StatusDot tone={titleTone(v)} aria-hidden="true" /></span>
      <span class="full"><strong>{v.name}</strong><span class="suffix">.{domain}</span></span>
      <Note inline class="state" data-field="state">{text(titleState(v))}</Note>
    </p>
    {#if dates.length}
      <Note inline class="dates" data-field="dates"
        >{#each dates as d, k (d.key)}{#if k}<span class="sep" aria-hidden="true">·</span>{/if}<span
            data-date={d.key}
            title={d.title && text(d.title)}><T m={d.m} /></span
          >{/each}</Note
      >
    {/if}
    {#if ended}<Note size="md" data-field="ended"><T m={ended} /></Note>{/if}
  </div>
  {#if live}
    <div class="points">
      {#each rows as r, k (k)}
        <div class="row" data-point={r.label ?? ''}>
          {#if r.label === null}
            <span class="label">{v.name}</span>
          {:else}
            <input
              class="label"
              data-field="label"
              bind:value={r.label}
              aria-label={t('network:DomainCard.label')}
              autocomplete="off"
              spellcheck="false"
            />
          {/if}
          <input
            class="target"
            data-field="target"
            bind:value={r.target}
            aria-label={t('network:DomainCard.target')}
            autocomplete="off"
            spellcheck="false"
          />
          {#if r.label !== null}
            <Button
              variant="plain"
              icon="trash"
              data-action="remove-label"
              title={t('network:DomainCard.removeLabel')}
              aria-label={t('network:DomainCard.removeLabel')}
              onclick={() => (rows = rows.filter((_, i) => i !== k))}
            />
          {/if}
        </div>
      {/each}
      <Note><T k="network:DomainCard.note" params={{ name: v.name }} /></Note>
      <div class="actions">
        <Button
          data-action="add-label"
          disabled={rows.length >= MAX_POINTS}
          onclick={() => (rows = [...rows, { label: '', target: targetName(here, domain) }])}
        >
          {t('network:DomainCard.addLabel')}
        </Button>
        <Button
          data-action="point-here"
          onclick={() => (rows = rows.map((r) => ({ ...r, target: targetName(here, domain) })))}
        >
          {t('network:DomainCard.pointHere')}
        </Button>
        <Button variant="primary" data-action="save-zone" onclick={save}>{t('network:DomainCard.save')}</Button>
        <span class="gap"></span>
        <Button variant="danger" data-action="release" onclick={letGo}>{t('network:DomainCard.release')}</Button>
      </div>
      {#if runner.error}<Note tone="error"><ErrorText error={runner.error} /></Note>{/if}
    </div>
  {/if}
</Card>

<style>
  .what,
  .points {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .points {
    gap: var(--space-3);
    padding-top: var(--space-3);
  }
  /* The light, the whole domain and its state on one line where they fit. */
  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-1) var(--space-3);
    margin: 0;
  }
  .light {
    display: flex;
    align-self: center;
  }
  .full {
    overflow-wrap: anywhere;
  }
  .sep {
    padding-inline: var(--space-2);
  }
  .suffix {
    color: var(--text-dim);
  }
  .row {
    display: grid;
    grid-template-columns: minmax(80px, 140px) 1fr auto;
    gap: var(--space-3);
    align-items: center;
  }
  .label {
    overflow-wrap: anywhere;
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
  /* Let it go apart from the editing's buttons, at the row's end. */
  .gap {
    flex: 1;
  }
</style>
