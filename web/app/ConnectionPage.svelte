<!--
  A connection's page on the Home page (docs/frontend.md "The Home page"), one level under Connections: the pane of the
  section chosen in its column (ConnectionNav.svelte). Details (ConnectionDetails.svelte), Settings
  (ConnectionSettings.svelte) and a room's Domains (DomainsPane.svelte). The pane appearing after the level was
  entered takes the focus on its title.
-->
<script lang="ts">
  import ConnectionDetails from './ConnectionDetails.svelte';
  import ConnectionSettings from './ConnectionSettings.svelte';
  import DomainsPane from './DomainsPane.svelte';
  import type { Act } from './actions.svelte.ts';
  import type { HomeContext } from './home-route.ts';
  import type { PageNetwork } from './net-live.ts';
  import type { MachineRecord } from './shape.ts';
  import { machinesNav } from './areas/machines-nav.svelte.ts';

  type Props = { net: PageNetwork; machines: MachineRecord[]; ctx: HomeContext; act: Act };
  let { net, machines, ctx, act }: Props = $props();

  const takeFocus = () => machinesNav.takeFocus();
  const c = $derived(net.connections.find((x) => x.id === ctx.id));
</script>

{#if ctx.section === 'settings'}
  <ConnectionSettings {net} id={ctx.id} {act} {takeFocus} />
{:else if ctx.section === 'domains' && c?.room}
  <DomainsPane {net} id={c.id} name={c.name} room={c.room} {takeFocus} />
{:else}
  <ConnectionDetails {net} {machines} id={ctx.id} {takeFocus} />
{/if}
