<!--
  The toolbar's Network menus (docs/frontend.md "Network", docs/networking/adapters.md §3.3). Where the toolbar has room
  (`split`), each network adapter of the page's machine has its own button, its state's light and its number on it,
  and its menu holds that adapter alone; otherwise one button's menu has a section per adapter (NetAdapter.svelte).
  Each section shows the adapter's connection and what can be done with it; Change connection… opens the Network wizard
  (web/app/NetWizard.svelte), Details… the adapter's details (NetDetails.svelte). A menu opens by itself when its
  adapter needs the user (a login) and when the page asks (the wizard's end, a status click). Adapter 1's menu is
  `#network` (the single one's too); adapter n's is `#network-<n-1>`. `data-net-menu` marks them for the toolbar,
  which measures them.
-->
<script lang="ts">
  import Menu from './ui/Menu.svelte';
  import StatusDot from './ui/StatusDot.svelte';
  import NetAdapter from './NetAdapter.svelte';
  import { t } from '../i18n.ts';
  import type { PageNetwork } from './net-live.ts';
  import { phaseTone } from './network-view.ts';
  import { network } from './areas/network.ts';
  import { current } from './areas/current.svelte.ts';

  type Props = { net: PageNetwork; split: boolean };
  let { net, split }: Props = $props();

  const views = $derived(net.views());
  /** What the single button's light shows: the default gateway's state, else adapter 1's (none without an adapter). */
  const shown = $derived<(typeof views)[number] | undefined>(views.find((a) => a.primary) ?? views[0]);
  /** A button for each adapter. */
  const apart = $derived(split && views.length > 1);

  /** The adapter whose menu is open (any, for the single menu: it's open); none: closed. */
  let openAt = $state<number>();
  /** The menu's openings by the page: the adapters' sections start again (last time's errors gone). */
  let session = $state(0);
  let lastPhases: string[] = [];
  $effect(() => {
    const phases = views.map((a) => a.view.phase);
    const login = phases.findIndex((p, i) => p === 'login' && lastPhases[i] !== 'login');
    if (login >= 0) openAt = login; // the user has something to do
    lastPhases = phases;
  });
  $effect(() =>
    network.menu.handle((adapter) => {
      openAt = adapter ?? shown?.index ?? 0;
      session++;
    }),
  );

  /** One adapter's menu, open or closed (`bind:open`'s getter and setter). */
  const isOpen = (i: number) => openAt === i;
  function setOpen(i: number, on: boolean) {
    if (on) openAt = i;
    else if (openAt === i) openAt = undefined;
  }

  function wizard(i: number) {
    openAt = undefined;
    network.openWizard({ mode: 'attach', machine: current.id, adapter: i, here: views[i]?.on });
  }
  function details(i: number) {
    openAt = undefined;
    network.openDetails(i);
  }
  function naming(i: number) {
    openAt = undefined;
    network.openNaming(i);
  }
</script>

{#snippet section(a: (typeof views)[number])}
  <NetAdapter
    {a}
    heading={views.length > 1}
    onwizard={() => wizard(a.index)}
    ondetails={() => details(a.index)}
    onname={() => naming(a.index)}
  />
{/snippet}

{#if apart}
  {#each views as a (a.index)}
    <Menu
      id={a.index ? `network-${a.index}` : 'network'}
      icon="network"
      title={t('network:Network.title.adapter', { adapter: a.index + 1 })}
      bind:open={() => isOpen(a.index), (on: boolean) => setOpen(a.index, on)}
      panel
      wide
      data-phase={a.view.phase}
      data-net-menu={a.index}
    >
      {#snippet badge()}<StatusDot tone={phaseTone(a.view.phase)} aria-hidden="true" /><span
          class="digit"
          aria-hidden="true">{a.index + 1}</span
        >{/snippet}
      {#key session}{@render section(a)}{/key}
    </Menu>
  {/each}
{:else}
  <Menu
    id="network"
    icon="network"
    title={t('network:Network.title')}
    bind:open={() => openAt !== undefined, (on: boolean) => (openAt = on ? (shown?.index ?? 0) : undefined)}
    panel
    wide
    data-phase={shown?.view.phase ?? 'off'}
    data-net-menu="all"
  >
    {#snippet badge()}<StatusDot tone={phaseTone(shown?.view.phase)} aria-hidden="true" />{/snippet}
    {#key session}
      {#each views as a (a.index)}
        <div class="adapter">{@render section(a)}</div>
      {/each}
    {/key}
  </Menu>
{/if}

<style>
  /* A rule between adapters. */
  .adapter + .adapter {
    padding-top: var(--space-4);
    border-top: 1px solid var(--border);
  }
  /* The adapter's number on its button, after its light. */
  .digit {
    font-size: var(--text-xs);
    font-weight: var(--weight-bold);
    color: var(--text-dim);
  }
</style>
