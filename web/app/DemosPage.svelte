<!--
  The demo store's page (docs/frontend.md "The demo store"; DEMO-KICKOFF.md decisions 15, 16): full screen in the
  machine's place, as Home is, with Back to where the visitor came from. It reads the store the address names
  (web/app/demos-route.ts: ours, `?store=` another's, a single definition's URL a store of one) and shows its cards
  (DemoCard.svelte), or the chosen demo's interstitial (DemoStart.svelte: `?id=`). Another store's demos are shown only
  once the visitor accepts that they aren't ours: nothing past its JSON is fetched before. An id the store doesn't
  have opens the cards and says so.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import Button from './ui/Button.svelte';
  import ErrorWords from './ErrorWords.svelte';
  import Note from './ui/Note.svelte';
  import T from './T.svelte';
  import DemoCard from './DemoCard.svelte';
  import DemoStart from './DemoStart.svelte';
  import { Actions } from './actions.svelte.ts';
  import { fetchStore, findDemo, machinesOf, OUR_STORE, type DemoStore, type StoreDemo } from './demo-store.ts';
  import type { Store } from './store.ts';
  import { demos } from './areas/demos.svelte.ts';
  import { records } from './areas/records.svelte.ts';
  import { page } from './page.ts';
  import { t } from '../i18n.ts';

  type Props = { store: Store };
  let { store }: Props = $props();

  const route = $derived(demos.route);
  const runner = new Actions();
  let shelf = $state.raw<DemoStore>();
  /** Another store's demos accepted (its warning's Show their demos), for the store shown. */
  let accepted = $state(false);

  /** The store at `url` read (again: Try again). */
  function load(url: string) {
    shelf = undefined;
    accepted = false;
    void runner.run(t('machines:DemosPage.loading'), async () => {
      const s = await fetchStore(url);
      if (demos.route.store === url) shelf = s;
    });
  }
  // The store the address names, read when it changes (the page's first, a `?store=` link opened in this tab); not when
  // only the demo chosen does (a primitive `$derived` changes only with its value).
  const storeUrl = $derived(demos.route.store);
  $effect(() => {
    const url = storeUrl;
    untrack(() => load(url));
  });

  const shown = $derived(!!shelf && (route.ours || accepted));
  const chosen = $derived(shelf && route.id !== undefined ? findDemo(shelf, route.id) : undefined);
  /** A demo's mark on its card: the visitor has it, or an older version of it. */
  function markOf(d: StoreDemo) {
    const m = machinesOf(records.machines, d);
    return m.mine.length ? 'mine' : m.older.length ? 'older' : undefined;
  }
  const host = $derived(new URL(route.store).host);
</script>

<div class="demos" data-busy={runner.busy}>
  <div class="bar">
    <Button
      variant="tool"
      labelled
      icon="arrow-left"
      onclick={() => page.closeDemos()}
      data-action="back"
      title={t('machines:DemosPage.back')}
    >
      {t('machines:DemosPage.back')}
    </Button>
  </div>
  <div class="body">
    <h2>{t('machines:DemosPage.heading')}</h2>
    {#if runner.busy}<Note size="md" role="status">{runner.busy}</Note>{/if}
    {#if runner.error}
      <div class="error" role="alert" data-field="store-error"><ErrorWords error={runner.error} /></div>
      <Button onclick={() => load(route.store)} data-action="retry">{t('machines:DemosPage.retry')}</Button>
    {/if}
    {#if shelf && !shown}
      <section class="warning" data-field="not-ours">
        <h3>{t('machines:DemosPage.notOurs.title')}</h3>
        <Note size="md"><T k="machines:DemosPage.notOurs" params={{ host }} /></Note>
        {#if shelf.name}<Note size="md"><T k="machines:DemosPage.notOurs.name" params={{ name: shelf.name }} /></Note
          >{/if}
        <div class="actions">
          <Button variant="primary" onclick={() => (accepted = true)} data-action="accept-store">
            {t('machines:DemosPage.notOurs.show')}
          </Button>
          <Button onclick={() => page.openDemos({ store: OUR_STORE, ours: true })} data-action="our-store">
            {t('machines:DemosPage.notOurs.ours')}
          </Button>
        </div>
      </section>
    {:else if shelf && chosen}
      {#key chosen.def.demo.id}<DemoStart {store} demo={chosen} />{/key}
    {:else if shelf}
      <Note size="md">{t('machines:DemosPage.intro')}</Note>
      {#if !route.ours}<Note size="md" data-field="from"><T k="machines:DemosPage.from" params={{ host }} /></Note>{/if}
      {#if route.id !== undefined}
        <Note tone="warn" size="md" data-field="unknown-id">{t('machines:DemosPage.unknown', { id: route.id })}</Note>
      {/if}
      {#if shelf.skipped.length}
        <Note data-field="skipped">{t('machines:DemosPage.skipped', { count: shelf.skipped.length })}</Note>
      {/if}
      {#if shelf.demos.length}
        <ul class="cards">
          {#each shelf.demos as d (d.def.demo.id)}
            <li><DemoCard demo={d} mark={markOf(d)} onopen={() => page.chooseDemo(d.def.demo.id)} /></li>
          {/each}
        </ul>
      {:else}
        <Note size="md">{t('machines:DemosPage.empty')}</Note>
      {/if}
    {/if}
  </div>
</div>

<style>
  .demos {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--surface);
  }
  .bar {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    padding: var(--space-2) var(--space-4);
    border-bottom: 1px solid var(--border);
    background: var(--surface-raised);
  }
  .body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-4);
    padding: var(--space-5) var(--space-6);
  }
  h2 {
    margin: 0;
    font-size: var(--text-lg);
  }
  h3 {
    margin: 0;
    font-size: var(--text-base);
  }
  .cards {
    list-style: none;
    margin: 0;
    padding: 0;
    width: 100%;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: var(--space-4);
  }
  .warning {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    max-width: 720px;
    padding: var(--space-4);
    border: 1px solid var(--warn-border);
    border-radius: var(--radius);
    background: var(--warn-bg);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
  }
  .error {
    max-width: 720px;
    padding: var(--space-3) var(--space-4);
    border: 1px solid var(--error-border);
    border-radius: var(--radius);
    background: var(--error-bg);
    color: var(--error-bar-fg);
  }
  @media (max-width: 720px) {
    .body {
      padding: var(--space-4);
    }
  }
</style>
