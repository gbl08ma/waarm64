<!--
  The Home page's left column in a connection's context (HomeColumn.svelte; docs/frontend.md "The Home page"), one
  level under Connections: Back to where the user came from (Connections, a machine's Network tab, or the machine's
  screen: web/app/home-route.ts `backOf`), the connection's name with its line (its kind, and who has it now), its
  sections (Details, Settings and a room's Domains: a section is chosen instantly, as the root's panes are), then the
  connection's commands.
-->
<script lang="ts">
  import Icon from './ui/Icon.svelte';
  import HomeBack from './HomeBack.svelte';
  import { kindText } from './connection-kind.ts';
  import type { IconName } from './icons.ts';
  import type { ConnectionSection, HomeContext } from './home-route.ts';
  import type { PageNetwork } from './net-live.ts';
  import { msg, t, type Msg } from '../i18n.ts';
  import { machinesNav } from './areas/machines-nav.svelte.ts';
  import { page } from './page.ts';

  type Props = { net: PageNetwork; ctx: HomeContext };
  let { net, ctx }: Props = $props();

  const c = $derived(net.connections.find((x) => x.id === ctx.id));

  /** Back's words, by where it leads. */
  const backWords = $derived.by((): Msg => {
    const b = machinesNav.back;
    if (b?.to === 'tab') return msg('machines:ConnectionNav.back.machine', { machine: b.name });
    if (b?.to === 'screen') return msg('machines:MachinesNav.back');
    return msg('machines:ConnectionNav.back.connections');
  });
  /** Who has the connection now: an adapter here, a machine in another tab, or no one (the card's words). */
  const stateWords = $derived.by(() => {
    if (net.runs(ctx.id) >= 0) return t('machines:ConnectionsPane.connection.here');
    if (net.held.has(ctx.id)) return t('machines:ConnectionsPane.connection.otherTab');
    return t('machines:ConnectionsPane.connection.unused');
  });

  type Section = { id: ConnectionSection; icon: IconName; label: string };
  const sections = $derived<Section[]>([
    { id: 'details', icon: 'info-circle', label: t('machines:ConnectionNav.details') },
    { id: 'settings', icon: 'settings', label: t('machines:ConnectionNav.settings') },
    ...(c?.kind === 'room'
      ? [{ id: 'domains' as const, icon: 'world-www' as const, label: t('machines:ConnectionNav.domains') }]
      : []),
  ]);
</script>

<HomeBack words={backWords} onclick={() => page.leaveContext()} data-action="back" data-back={machinesNav.back?.to} />
{#if c}
  <div class="named" data-context-connection={c.id}>
    <h3 class="name">{c.name}</h3>
    <span class="meta">{t('machines:ConnectionNav.line', { kind: kindText(c), state: stateWords })}</span>
  </div>
  <div class="entries">
    {#each sections as s (s.id)}
      <button
        class:chosen={ctx.section === s.id}
        aria-current={ctx.section === s.id ? 'page' : undefined}
        onclick={() => page.openConnection(ctx.id, s.id)}
        data-section={s.id}
      >
        <Icon name={s.icon} size={16} />{s.label}
      </button>
    {/each}
  </div>
  <!-- The connection's commands go here, under a rule (DOMAINS loop 2: New address, Log out, Delete; loop 4: a
       room's backup). -->
{/if}

<style>
  /* The connection's name and its line, in line with the entries' words. */
  .named {
    display: flex;
    flex-direction: column;
    padding: 0 var(--space-4);
  }
  h3 {
    margin: 0;
    font-size: var(--text-base);
    font-weight: var(--weight-bold);
    overflow-wrap: anywhere;
  }
  .meta {
    color: var(--text-dim);
    font-size: var(--text-sm);
  }
  .entries {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .entries button {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    width: 100%;
    padding: var(--space-2) var(--space-4);
    border-radius: var(--radius-sm);
    text-align: start;
  }
  .entries .chosen {
    background: var(--pressed-bg);
    box-shadow: var(--chosen-edge);
  }
</style>
