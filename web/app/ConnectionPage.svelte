<!--
  A connection's page on the Home page (docs/frontend.md "The Home page"), one level under Connections: the pane of the
  section chosen in its column (ConnectionNav.svelte). Details (ConnectionDetails.svelte); Settings and a room's Domains
  are their titles alone for now (DOMAINS loops 2 and 4 fill them). The pane appearing after the level was entered
  takes the focus on its title.
-->
<script lang="ts">
  import ConnectionDetails from './ConnectionDetails.svelte';
  import Pane from './ui/Pane.svelte';
  import { t } from '../i18n.ts';
  import type { HomeContext } from './home-route.ts';
  import type { PageNetwork } from './net-live.ts';
  import type { MachineRecord } from './shape.ts';
  import { machinesNav } from './areas/machines-nav.svelte.ts';

  type Props = { net: PageNetwork; machines: MachineRecord[]; ctx: HomeContext };
  let { net, machines, ctx }: Props = $props();

  const takeFocus = () => machinesNav.takeFocus();
</script>

{#if ctx.section === 'settings'}
  <Pane id="connection-settings" title={t('machines:ConnectionNav.settings')} {takeFocus}>
    <div></div>
  </Pane>
{:else if ctx.section === 'domains'}
  <Pane id="connection-domains" title={t('machines:ConnectionNav.domains')} {takeFocus}>
    <div></div>
  </Pane>
{:else}
  <ConnectionDetails {net} {machines} id={ctx.id} {takeFocus} />
{/if}
