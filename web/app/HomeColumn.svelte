<!--
  The Home page's left column (MachinesPage.svelte; docs/frontend.md "The Home page"), a `nav` named after the page: one
  level at a time, the root's entries (MachinesNav.svelte) or a context's (a connection's: ConnectionNav.svelte),
  keyed by the level. A move between levels shows: the outgoing entries and the incoming ones overlap in one grid cell
  as they slide (web/app/home-level.ts), the column's width fixed by the page's grid.
-->
<script lang="ts">
  import ConnectionNav from './ConnectionNav.svelte';
  import MachinesNav from './MachinesNav.svelte';
  import { level } from './home-level.ts';
  import type { Actions } from './actions.svelte.ts';
  import type { Msg } from '../i18n.ts';
  import type { PageNetwork } from './net-live.ts';
  import type { MachineRecord } from './shape.ts';
  import type { Store } from './store.ts';
  import { machinesNav } from './areas/machines-nav.svelte.ts';

  type Props = {
    store: Store;
    net: PageNetwork;
    machines: MachineRecord[];
    counts: { disks: number; folders: number; connections: number };
    stateOf: (id: string) => Msg;
    actions: Actions;
    onchoose: (id: string) => void;
  };
  let { store, net, machines, counts, stateOf, actions, onchoose }: Props = $props();
</script>

<nav aria-labelledby="home-heading">
  {#key machinesNav.level}
    <div class="level" in:level out:level data-level={machinesNav.level}>
      {#if machinesNav.context}
        <ConnectionNav {net} ctx={machinesNav.context} />
      {:else}
        <MachinesNav {store} {machines} {counts} {stateOf} {actions} {onchoose} />
      {/if}
    </div>
  {/key}
</nav>

<style>
  /* The levels stack in one cell: during a move, the one leaving and the one coming in overlap. */
  nav {
    display: grid;
    grid-template: minmax(0, 1fr) / minmax(0, 1fr);
    min-height: 0;
    overflow: hidden;
    border-right: 1px solid var(--border);
    background: var(--surface-raised);
  }
  .level {
    grid-area: 1 / 1;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    min-height: 0;
    overflow: auto;
    padding: var(--space-3);
  }
  @media (max-width: 720px) {
    nav {
      border-right: 0;
      border-bottom: 1px solid var(--border);
    }
  }
</style>
