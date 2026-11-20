<!--
  The demo store's page (docs/frontend.md "The demo store"; docs/decisions.md "Demos"): full screen in the
  machine's place, as Home is; the toolbar's Home leads out to Home, its wordmark back to the machine. It reads the store the address names
  (web/app/demos-route.ts: ours, `?store=` another's, a single definition's URL a store of one) and shows it as Home
  shows its machines: the store's demos in a list on the left (DemoCard.svelte, a row each), the chosen one's pane on
  the right (DemoStart.svelte: `?id=`), so another demo is a click on its row. With no demo named, the store's first
  is shown (the address stays without an id); an id the store doesn't have says so in the pane's place. At 720 px
  and under (`NARROW`) it's one column: the list, then the chosen demo's pane alone with All demos back to the list.
  Another store's demos are shown only once the visitor accepts that they aren't ours: nothing past its JSON is
  fetched before. Our store's list ends with a row that is no demo, **Things to try** (DemoIdeas.svelte; the id
  `IDEAS` in the address, unless the store has a demo of that id).
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { MediaQuery } from 'svelte/reactivity';
  import Button from './ui/Button.svelte';
  import Callout from './ui/Callout.svelte';
  import ErrorWords from './ErrorWords.svelte';
  import Note from './ui/Note.svelte';
  import T from './T.svelte';
  import DemoCard from './DemoCard.svelte';
  import DemoIdeas from './DemoIdeas.svelte';
  import DemoStart from './DemoStart.svelte';
  import { errorView, type ErrorView } from './usb-problems.ts';
  import { fetchStore, findDemo, machinesOf, OUR_STORE, type DemoStore, type StoreDemo } from './demo-store.ts';
  import type { Store } from './store.ts';
  import { demos } from './areas/demos.svelte.ts';
  import { records } from './areas/records.svelte.ts';
  import { page } from './page.ts';
  import { leaveDemo } from './demo-leave.ts';
  import { t } from '../i18n.ts';

  type Props = { store: Store };
  let { store }: Props = $props();

  const route = $derived(demos.route);
  let shelf = $state.raw<DemoStore>();
  /** The store's read, while it runs; how it failed. Only the latest read's (an older one's answer is dropped). */
  let loading = $state(false);
  let error = $state.raw<ErrorView>();
  let reads = 0;
  /** Another store's demos accepted (its warning's Show their demos), for the store shown. */
  let accepted = $state(false);

  /** The store at `url` read (again: Try again). */
  function load(url: string) {
    const read = ++reads;
    [shelf, accepted, error, loading] = [undefined, false, undefined, true];
    fetchStore(url).then(
      (s) => {
        if (read !== reads) return;
        [shelf, loading] = [s, false];
      },
      (e: unknown) => {
        if (read !== reads) return;
        [error, loading] = [errorView(e), false];
      },
    );
  }
  /** The demo whose pane was left last: in one column, its row takes the focus back (All demos). */
  let left = $state<string>();
  $effect(() => {
    const id = route.id;
    return () => (left = id);
  });
  // The store the address names, read when it changes (the page's first, a `?store=` link opened in this tab); not when
  // only the demo chosen does (a primitive `$derived` changes only with its value).
  const storeUrl = $derived(demos.route.store);
  $effect(() => {
    const url = storeUrl;
    untrack(() => load(url));
  });

  /** One column (the list, or the chosen demo's pane with its way back) rather than the list beside the pane. */
  const narrow = new MediaQuery('max-width: 720px');
  /** The store's demos, once they may show (ours, or another's accepted). */
  const listed = $derived(shelf && (route.ours || accepted) ? shelf : undefined);
  /** The demo the address names, if the store has it. */
  const chosen = $derived(listed && route.id !== undefined ? findDemo(listed, route.id) : undefined);
  /** The id of the row that is no demo: what to try with a machine (our store's list only). */
  const IDEAS = 'things-to-try';
  const ideas = $derived(!!listed && route.ours && route.id === IDEAS && !chosen);
  /** The demo whose pane shows: the chosen one, or beside the list with none named, the store's first. */
  const open = $derived(chosen ?? (narrow.current || route.id !== undefined ? undefined : listed?.demos.at(0)));
  /** The list shows: always beside the pane, and in one column until a demo (or the ideas' row) is chosen. */
  const showList = $derived(!narrow.current || (!chosen && !ideas));
  /** A demo's mark on its card: the visitor has it, or an older version of it. */
  function markOf(d: StoreDemo) {
    const m = machinesOf(records.machines, d);
    return m.mine.length ? 'mine' : m.older.length ? 'older' : undefined;
  }
  const host = $derived(new URL(route.store).host);

  /** Demo `id` chosen from the list (the one shown already: nothing leaves). */
  const choose = (id: string) =>
    id === open?.def.demo.id ? page.chooseDemo(id) : void leaveDemo(() => page.chooseDemo(id));
</script>

<div class="demos" data-busy={loading ? t('machines:DemosPage.loading') : undefined}>
  {#if listed}
    <div class="panes">
      {#if showList}
        <nav aria-labelledby="demos-heading">
          <div class="intro">
            <h2 id="demos-heading">{t('machines:DemosPage.heading')}</h2>
            <Note size="md"><T k="machines:DemosPage.intro" /></Note>
            {#if !route.ours}
              <Note size="md" data-field="from"><T k="machines:DemosPage.from" params={{ host }} /></Note>
            {/if}
            {#if narrow.current && route.id !== undefined && !ideas}
              <Note tone="warn" size="md" data-field="unknown-id">
                {t('machines:DemosPage.unknown', { id: route.id })}
              </Note>
            {/if}
            {#if listed.skipped.length}
              <Note data-field="skipped">{t('machines:DemosPage.skipped', { count: listed.skipped.length })}</Note>
            {/if}
            {#if !listed.demos.length}<Note size="md">{t('machines:DemosPage.empty')}</Note>{/if}
          </div>
          {#if listed.demos.length}
            <ul class="cards">
              {#each listed.demos as d (d.def.demo.id)}
                <li>
                  <DemoCard
                    demo={d}
                    mark={markOf(d)}
                    chosen={d === open}
                    onopen={() => choose(d.def.demo.id)}
                    focused={narrow.current && route.id === undefined && left === d.def.demo.id}
                  />
                </li>
              {/each}
            </ul>
          {/if}
          {#if route.ours}
            <DemoIdeas row chosen={ideas} onopen={() => void leaveDemo(() => page.chooseDemo(IDEAS))} />
          {/if}
        </nav>
      {/if}
      {#if ideas}
        <DemoIdeas back={narrow.current} onback={() => page.chooseDemo()} />
      {:else if open}
        {#key open.def.demo.id}
          <DemoStart
            {store}
            demo={open}
            back={narrow.current}
            onback={() => leaveDemo(() => page.chooseDemo())}
            takesFocus={narrow.current}
          />
        {/key}
      {:else if !narrow.current}
        <section class="none" data-field="no-demo">
          {#if route.id !== undefined}
            <Note tone="warn" size="md" data-field="unknown-id">
              {t('machines:DemosPage.unknown', { id: route.id })}
            </Note>
          {/if}
          {#if listed.demos.length}<p>{t('machines:DemosPage.choose')}</p>{/if}
        </section>
      {/if}
    </div>
  {:else}
    <div class="body">
      <h2>{t('machines:DemosPage.heading')}</h2>
      {#if loading}<Note size="md" role="status">{t('machines:DemosPage.loading')}</Note>{/if}
      {#if error}
        <div class="box">
          <Callout role="alert" data-field="store-error">
            <ErrorWords {error} />
            {#snippet actions()}
              <Button onclick={() => load(route.store)} data-action="retry">{t('machines:DemosPage.retry')}</Button>
            {/snippet}
          </Callout>
        </div>
      {/if}
      {#if shelf}
        <div class="box">
          <Callout tone="warn" title={t('machines:DemosPage.notOurs.title')} data-field="not-ours">
            <Note size="md"><T k="machines:DemosPage.notOurs" params={{ host }} /></Note>
            {#if shelf.name}
              <Note size="md"><T k="machines:DemosPage.notOurs.name" params={{ name: shelf.name }} /></Note>
            {/if}
            {#snippet actions()}
              <Button variant="primary" onclick={() => (accepted = true)} data-action="accept-store">
                {t('machines:DemosPage.notOurs.show')}
              </Button>
              <Button onclick={() => page.openDemos({ store: OUR_STORE, ours: true })} data-action="our-store">
                {t('machines:DemosPage.notOurs.ours')}
              </Button>
            {/snippet}
          </Callout>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .demos {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--surface);
  }
  /* The list beside the chosen demo's pane, as Home's machines beside a machine's (MachinesPage.svelte). */
  .panes {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(280px, 360px) 1fr;
  }
  nav {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    min-height: 0;
    overflow: auto;
    padding: var(--space-4) var(--space-3);
    border-right: 1px solid var(--border);
    background: var(--surface-raised);
  }
  /* The heading and the lines under it, in line with the rows' words. */
  .intro {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: 0 var(--space-3) var(--space-2);
  }
  /* What shows before the list does (the store loading, its failure, another store's warning): one column. */
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
  .cards {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  /* No demo to show beside the list (the address's id isn't the store's): said where its pane would be. */
  .none {
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-3);
    padding: var(--space-5);
    color: var(--text-dim);
    text-align: center;
  }
  .none p {
    margin: 0;
  }
  /* A warning's or an error's box, a column's measure wide. */
  .box {
    width: 100%;
    max-width: 720px;
  }
  @media (max-width: 720px) {
    .panes {
      grid-template-columns: 1fr;
    }
    nav {
      border-right: 0;
    }
    .body {
      padding: var(--space-4);
    }
  }
</style>
