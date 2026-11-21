<!--
  The Home page's left column in a connection's context (HomeColumn.svelte; docs/frontend.md "The Home page"), one
  level under Connections: Back to where the user came from (Connections, a machine's Network tab, or the machine's
  screen: web/app/home-route.ts `backOf`), the connection's name with its line (its kind, and who has it now), its
  sections (Details, Settings and a room's Domains: a section is chosen instantly, as the root's panes are), then the
  connection's commands under a rule: a tailcat server's New address, Log out where a node is kept, Delete (each runs
  through the Home page's runner; Delete leaves the page for Connections once the connection is gone).
-->
<script lang="ts">
  import Icon from './ui/Icon.svelte';
  import HomeBack from './HomeBack.svelte';
  import { kindText } from './connection-kind.ts';
  import type { Connection } from './connections.ts';
  import type { Act } from './actions.svelte.ts';
  import { ask } from './ask.svelte.ts';
  import type { IconName } from './icons.ts';
  import type { ConnectionSection, HomeContext } from './home-route.ts';
  import type { PageNetwork } from './net-live.ts';
  import { msg, t, type Msg } from '../i18n.ts';
  import { machinesNav } from './areas/machines-nav.svelte.ts';
  import { page } from './page.ts';

  type Props = { net: PageNetwork; ctx: HomeContext; act: Act };
  let { net, ctx, act }: Props = $props();

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

  async function logout(conn: Connection) {
    const sure = await ask.confirm(msg('machines:ConnectionNav.logout.confirm', { name: conn.name }), {
      ok: t('machines:ConnectionNav.logout.ok'),
      danger: true,
    });
    if (sure) await act(t('machines:ConnectionNav.busy.loggingOut'), () => page.netLogoutConnection(conn));
  }
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
  <!-- The connection's commands (a room's Back up key and domains… joins them: DOMAINS loop 4). -->
  {@const conn = c}
  <div class="entries ruled">
    {#if conn.tailcat?.serve}
      <button
        onclick={() => act(t('machines:ConnectionNav.busy.forgettingAddress'), () => page.netNewAddress(conn))}
        data-action="new-address"
        title={t('machines:ConnectionNav.newAddress.title')}
      >
        <Icon name="refresh" size={16} />{t('machines:ConnectionNav.newAddress')}
      </button>
    {/if}
    {#if net.hasNode(conn) || (conn.tailnet && net.runs(conn.id) >= 0)}
      <button
        onclick={() => logout(conn)}
        data-action="logout-connection"
        title={t('machines:ConnectionNav.logout.title')}
      >
        <Icon name="plug" size={16} />{t('machines:ConnectionNav.logout')}
      </button>
    {/if}
    <button
      onclick={() => act(t('machines:MachinePane.busy.deleting'), () => page.netDelete(conn))}
      data-action="delete-connection"
      title={t('machines:ConnectionsPane.connection.delete.title')}
    >
      <Icon name="trash" size={16} />{t('machines:ConnectionsPane.connection.delete')}
    </button>
  </div>
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
  .ruled {
    padding-top: var(--space-3);
    border-top: 1px solid var(--border);
  }
  .entries .chosen {
    background: var(--pressed-bg);
    box-shadow: var(--chosen-edge);
  }
</style>
