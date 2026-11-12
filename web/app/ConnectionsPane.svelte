<!--
  The Machines page's Connections (docs/networking/adapters.md §3.1): the browser's network connections, each with its
  kind, who has it now and the machines that use it; rename, edit (the Network wizard), a tailcat server's new address,
  log out, delete. Logic is web/app/net-live.ts's, through `page`.
-->
<script lang="ts">
  import Button from './ui/Button.svelte';
  import Card from './ui/Card.svelte';
  import CardList from './ui/CardList.svelte';
  import Icon from './ui/Icon.svelte';
  import NameInput from './ui/NameInput.svelte';
  import Note from './ui/Note.svelte';
  import Pane from './ui/Pane.svelte';
  import { CONNECTIONS } from './machines-panes.ts';
  import { kindText } from './connection-kind.ts';
  import type { Connection } from './connections.ts';
  import { ask } from './ask.svelte.ts';
  import type { Act } from './actions.svelte.ts';
  import { msg, t } from '../i18n.ts';
  import type { PageNetwork } from './net-live.ts';
  import { settings } from './settings.ts';
  import type { MachineRecord } from './shape.ts';
  import { network } from './areas/network.ts';
  import { current } from './areas/current.svelte.ts';
  import { page } from './page.ts';

  type Props = { net: PageNetwork; machines: MachineRecord[]; act: Act };
  let { net, machines, act }: Props = $props();

  const conns = $derived(net.connections);
  const EDIT_TITLES: Record<Connection['kind'], string> = {
    tailnet: t('machines:ConnectionsPane.connection.edit.tailnet'),
    local: t('machines:ConnectionsPane.connection.edit.local'),
    room: t('machines:ConnectionsPane.connection.edit.room'),
    tailcat: t('machines:ConnectionsPane.connection.edit.tailcat'),
  };

  /** Who has connection `c` now: an adapter here, a machine in another tab, or no one. */
  function stateOf(c: Connection) {
    if (net.runs(c.id) >= 0) return t('machines:ConnectionsPane.connection.here');
    if (net.held.has(c.id)) return t('machines:ConnectionsPane.connection.otherTab');
    return t('machines:ConnectionsPane.connection.unused');
  }
  /** The machines whose adapters use `c` (the page's transient machine too). */
  const usedBy = (c: Connection) => [
    ...machines.filter((m) => m.adapters?.some((a) => a.connection === c.id)).map((m) => m.name),
    ...(settings().transientNet === c.id && current.transient ? [current.transient.label] : []),
  ];
  function metaOf(c: Connection) {
    const users = usedBy(c);
    return t('machines:ConnectionsPane.connection.meta', {
      kind: kindText(c),
      state: stateOf(c),
      used: users.length
        ? msg('machines:ConnectionsPane.connection.usedBy', { machines: users })
        : msg('machines:ConnectionsPane.connection.usedByNone'),
    });
  }
  async function logout(c: Connection) {
    const sure = await ask.confirm(t('machines:ConnectionsPane.logout.confirm', { name: c.name }), {
      ok: t('machines:ConnectionsPane.logout.ok'),
      danger: true,
    });
    if (sure) await act(t('machines:ConnectionsPane.busy.loggingOut'), () => page.netLogoutConnection(c));
  }
</script>

<Pane
  id={CONNECTIONS}
  title={t('machines:ConnectionsPane.connections.heading')}
  meta={t('machines:ConnectionsPane.connections.meta')}
>
  {#snippet actions()}
    <Button icon="plus" onclick={() => network.openWizard({ mode: 'new' })} data-action="new-connection">
      {t('machines:ConnectionsPane.connections.new')}
    </Button>
  {/snippet}
  <CardList class="connections" empty={conns.length ? undefined : t('machines:ConnectionsPane.connections.none')}>
    {#each conns as c (c.id)}
      <Card data-connection={c.id}>
        <div class="named">
          <Icon name="network" size={18} />
          <div class="lines">
            <NameInput
              class="conn-name"
              value={c.name}
              aria-label={t('machines:ConnectionsPane.connection.name')}
              data-field="connection-name"
              onchange={(name: string) =>
                void act(t('machines:ConnectionsPane.busy.renaming'), () => page.netRename(c, name))}
            />
            <Note inline class="meta">{metaOf(c)}</Note>
          </div>
        </div>
        {#snippet actions()}
          <Button
            onclick={() => network.openWizard({ mode: 'edit', connection: c.id })}
            data-action="edit-connection"
            title={EDIT_TITLES[c.kind]}
          >
            {t('machines:ConnectionsPane.connection.edit')}
          </Button>
          {#if c.tailcat?.serve}
            <Button
              onclick={() => act(t('machines:ConnectionsPane.busy.forgettingAddress'), () => page.netNewAddress(c))}
              data-action="new-address"
              title={t('machines:ConnectionsPane.connection.newAddress.title')}
            >
              {t('machines:ConnectionsPane.connection.newAddress')}
            </Button>
          {/if}
          {#if net.hasNode(c) || (c.tailnet && net.runs(c.id) >= 0)}
            <Button
              onclick={() => logout(c)}
              data-action="logout-connection"
              title={t('machines:ConnectionsPane.connection.logout.title')}
            >
              {t('machines:ConnectionsPane.connection.logout')}
            </Button>
          {/if}
          <Button
            icon="trash"
            onclick={() => act(t('machines:MachinePane.busy.deleting'), () => page.netDelete(c))}
            data-action="delete-connection"
            title={t('machines:ConnectionsPane.connection.delete.title')}
          >
            {t('machines:ConnectionsPane.connection.delete')}
          </Button>
        {/snippet}
      </Card>
    {/each}
  </CardList>
</Pane>

<style>
  /* A row's icon beside its name and lines. */
  .named {
    display: flex;
    align-items: center;
    gap: var(--space-4);
  }
  .lines {
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
</style>
