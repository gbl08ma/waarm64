<!--
  A connection's page on the Home page (docs/frontend.md "The Home page"), one level under Connections: the pane of the
  section chosen in its column (ConnectionNav.svelte). Details (ConnectionDetails.svelte), Settings
  (ConnectionSettings.svelte); a room's Domains is its title alone for now (DOMAINS loop 4 fills it). The pane appearing after the level was entered
  takes the focus on its title.
-->
<script lang="ts">
  import ConnectionDetails from './ConnectionDetails.svelte';
  import ConnectionSettings from './ConnectionSettings.svelte';
  import Pane from './ui/Pane.svelte';
  import type { Act } from './actions.svelte.ts';
  import { t } from '../i18n.ts';
  import type { HomeContext } from './home-route.ts';
  import type { PageNetwork } from './net-live.ts';
  import type { MachineRecord } from './shape.ts';
  import { machinesNav } from './areas/machines-nav.svelte.ts';

  type Props = { net: PageNetwork; machines: MachineRecord[]; ctx: HomeContext; act: Act };
  let { net, machines, ctx, act }: Props = $props();

  const takeFocus = () => machinesNav.takeFocus();
</script>

{#if ctx.section === 'settings'}
  <ConnectionSettings {net} id={ctx.id} {act} {takeFocus} />
{:else if ctx.section === 'domains'}
  <Pane id="connection-domains" title={t('machines:ConnectionNav.domains')} {takeFocus}>
    <div></div>
  </Pane>
{:else}
  <ConnectionDetails {net} {machines} id={ctx.id} {takeFocus} />
{/if}
