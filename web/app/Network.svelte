<!--
  The toolbar's Network menu (docs/frontend.md "Network", docs/network-adapters.md §3.3): a section per network
  adapter of the page's machine (NetAdapter.svelte; one adapter: no heading), each showing its connection and what can
  be done with it; Change connection… opens the Network wizard (web/app/NetWizard.svelte). The menu opens by itself
  when an adapter needs the user (a login) and when the page asks (the wizard's end, a status click).
-->
<script lang="ts">
  import Menu from './ui/Menu.svelte';
  import StatusDot from './ui/StatusDot.svelte';
  import NetAdapter from './NetAdapter.svelte';
  import { t } from '../i18n.ts';
  import type { PageNetwork } from './net-live.ts';
  import { phaseTone } from './network.ts';
  import { network } from './areas/network.ts';
  import { current } from './areas/current.svelte.ts';

  type Props = { net: PageNetwork };
  let { net }: Props = $props();

  const views = $derived(net.views());
  /** What the toolbar's dot shows: the default way out's state, else adapter 1's (none without an adapter). */
  const shown = $derived<(typeof views)[number] | undefined>(views.find((a) => a.primary) ?? views[0]);

  let open = $state(false);
  /** The menu's openings by the page: the adapters' sections start again (last time's errors gone). */
  let session = $state(0);
  let lastPhases: string[] = [];
  $effect(() => {
    const phases = views.map((a) => a.view.phase);
    if (phases.some((p, i) => p === 'login' && lastPhases[i] !== 'login')) open = true; // the user has something to do
    lastPhases = phases;
  });
  $effect(() =>
    network.menu.handle(() => {
      open = true;
      session++;
    }),
  );

  function wizard(i: number) {
    open = false;
    network.openWizard({ mode: 'attach', machine: current.id, adapter: i, here: views[i]?.on });
  }
</script>

<Menu
  id="network"
  icon="network"
  title={t('network:Network.title')}
  bind:open
  panel
  wide
  data-phase={shown?.view.phase ?? 'off'}
>
  {#snippet badge()}<StatusDot tone={phaseTone(shown?.view.phase)} aria-hidden="true" />{/snippet}
  {#key session}
    {#each views as a (a.index)}
      <div class="adapter">
        <NetAdapter {a} heading={views.length > 1} onwizard={() => wizard(a.index)} />
      </div>
    {/each}
  {/key}
</Menu>

<style>
  /* A rule between adapters. */
  .adapter + .adapter {
    padding-top: var(--space-4);
    border-top: 1px solid var(--border);
  }
</style>
