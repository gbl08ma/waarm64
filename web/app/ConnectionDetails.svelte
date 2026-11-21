<!--
  A connection's Details (docs/frontend.md "The Home page", "Network"): the pane of its page's Details section, on the
  Home page one level under Connections (ConnectionPage.svelte). First the machines it is attached to, each a link to
  that machine's Network tab, or that there are none, with where connections are attached; then what it gives out and
  what that lets in, by kind: the values the browser keeps for it always (a tailnet's hostname and control server, the
  local helper's install lines, the demo network's server, a room's link and who may connect), and, while it is
  connected on this page (`net.runs`), the adapter's live view (web/app/network-view.ts): the adapter's line, the guest's
  address, a tailcat address or key and the line that lets only this machine through a tailcat server, the demo
  network's page inside the guest, and a room's name, warnings and domains (ConnectionRoom.svelte). While it isn't, a
  line says why those are missing. Edit connection… opens the Network wizard on the connection.
-->
<script lang="ts">
  import Button from './ui/Button.svelte';
  import Note from './ui/Note.svelte';
  import Pane from './ui/Pane.svelte';
  import ValueField from './ui/ValueField.svelte';
  import ConnectionRoom from './ConnectionRoom.svelte';
  import NetLocalInstall from './NetLocalInstall.svelte';
  import T from './T.svelte';
  import { usersOf } from './connection-users.ts';
  import { t } from '../i18n.ts';
  import { SOURCE } from '../local-release.ts';
  import type { PageNetwork } from './net-live.ts';
  import type { MachineRecord } from './shape.ts';
  import { defaultsOf } from './network-view.ts';
  import { network } from './areas/network.ts';
  import { current } from './areas/current.svelte.ts';
  import { page } from './page.ts';

  type Props = { net: PageNetwork; machines: MachineRecord[]; id: string; takeFocus: () => boolean };
  let { net, machines, id, takeFocus }: Props = $props();

  const c = $derived(net.connections.find((x) => x.id === id));
  /** The adapter of this page's machine that has it connected, and its live view; none while it isn't. */
  const ad = $derived.by(() => {
    const at = net.runs(id);
    return at >= 0 ? net.views()[at] : undefined;
  });
  const v = $derived(ad?.view);
  const users = $derived(usersOf(id, machines, current.transient?.label));
  const allow = $derived(v?.tailcatKey ? `tailcat serve --allow=${v.tailcatKey} exit-node` : '');

  const adapterLine = $derived.by(() => {
    if (!ad) return '';
    const adapter = ad.index + 1;
    switch (defaultsOf(ad)) {
      case 'both':
        return t('network:NetAdapter.adapter.primary', { adapter });
      case 'v4':
        return t('network:NetAdapter.adapter.primary4', { adapter });
      case 'v6':
        return t('network:NetAdapter.adapter.primary6', { adapter });
      default:
        return t('network:NetAdapter.adapter', { adapter });
    }
  });
  /** A machine named in the line on the machines: its Network tab (the transient one has none). */
  const tabOf = (name: string) => users.find((u) => u.name === name)?.id;
</script>

{#snippet code(words: string)}<code>{words}</code>{/snippet}

{#if c}
  <Pane id="connection-details" title={t('machines:ConnectionNav.details')} {takeFocus}>
    {#snippet actions()}
      <Button id="net-details-edit" onclick={() => network.openWizard({ mode: 'edit', connection: c.id })}>
        {t('network:ConnectionDetails.edit')}
      </Button>
    {/snippet}
    <div id="net-details" class="details" data-kind={c.kind}>
      <div class="machines" data-connection-machines={users.length}>
        {#if users.length}
          <Note size="md" id="connection-details-machines">
            <T k="machines:ConnectionDetails.machines" params={{ machines: users.map((u) => u.name) }}>
              {#snippet name(words: string)}{@const to = tabOf(words)}{#if to}<Button
                    variant="link"
                    onclick={() => page.openMachines('network', to)}
                    data-machine-tab={to}>{words}</Button
                  >{:else}<strong>{words}</strong>{/if}{/snippet}
            </T>
          </Note>
        {:else}
          <Note size="md" id="connection-details-machines">{t('machines:ConnectionDetails.machines.none')}</Note>
        {/if}
        <Note size="md"><T k="machines:ConnectionDetails.machines.where" /></Note>
      </div>
      {#if ad}
        <Note size="md" id="net-details-adapter">{adapterLine}</Note>
      {:else if net.held.has(c.id)}
        <Note size="md" id="net-details-elsewhere">{t('machines:ConnectionDetails.otherTab')}</Note>
      {:else}
        <Note size="md" id="net-details-elsewhere">{t('machines:ConnectionDetails.notHere')}</Note>
      {/if}
      {#if v?.address}
        <ValueField
          id="net-details-address"
          copyId="net-details-address-copy"
          label={v.address.includes(':')
            ? t('network:ConnectionDetails.address.v6')
            : t('network:ConnectionDetails.address')}
          value={v.address}
          readonly
          copy
        />
      {/if}
      {#if c.kind === 'tailnet' && c.tailnet}
        <ValueField
          id="net-details-hostname"
          label={t('network:ConnectionDetails.tailnet.hostname')}
          value={c.tailnet.hostname}
          readonly
          copy
        />
        <ValueField
          id="net-details-control"
          label={t('network:ConnectionDetails.tailnet.control')}
          value={c.tailnet.controlURL}
          readonly
          copy
        />
        <Note size="md"><T k="network:ConnectionDetails.tailnet.note" /></Note>
      {:else if c.kind === 'tailcat' && v}
        {#if v.served}
          <ValueField
            id="net-details-served"
            copyId="net-details-served-copy"
            showId="net-details-served-show"
            label={t('network:NetAdapter.served')}
            value={v.served}
            readonly
            copy
            secret
          />
          <Note size="md" id="net-details-served-note">
            <T
              k="network:ConnectionDetails.served.note"
              params={{ ssh: 'tailcat ssh <address>', connect: 'tailcat <address> <port>' }}
              {code}
            />
          </Note>
        {/if}
        {#if v.tailcatKey}
          <ValueField
            id="net-details-key"
            copyId="net-details-key-copy"
            label={t('network:NetAdapter.key')}
            value={v.tailcatKey}
            readonly
            copy
            mono
          />
          <Note size="md">{t('network:ConnectionDetails.key.note')}</Note>
          <ValueField id="net-details-allow" copyId="net-details-allow-copy" value={allow} readonly copy mono />
          {#if c.ephemeral}<Note size="md">{t('network:ConnectionDetails.key.ephemeral')}</Note>{/if}
        {/if}
        {#if !v.served && !v.tailcatKey}<Note size="md">{t('network:ConnectionDetails.tailcat.offline')}</Note>{/if}
      {:else if c.kind === 'local'}
        <Note size="md">
          <T k="network:ConnectionDetails.local.note">
            {#snippet a(words: string)}<a href={SOURCE} target="_blank" rel="noopener">{words}</a>{/snippet}
          </T>
        </Note>
        <NetLocalInstall prefix="net-details-local" open={v?.phase !== 'connected'} />
        <Note size="md"><T k="network:ConnectionDetails.local.link" /></Note>
      {:else if c.kind === 'demo' && c.demo}
        <Note size="md">{t('network:ConnectionDetails.demo.note')}</Note>
        <ValueField
          id="net-details-demo-url"
          copyId="net-details-demo-url-copy"
          label={t('network:ConnectionDetails.demo.server')}
          value={c.demo.url}
          readonly
          copy
          mono
        />
        {#if v?.demo?.status}
          <ValueField
            id="net-details-demo-status"
            copyId="net-details-demo-status-copy"
            label={t('network:ConnectionDetails.demo.status')}
            value={`curl ${v.demo.status}`}
            readonly
            copy
            mono
          />
          <Note size="md">{t('network:ConnectionDetails.demo.status.note')}</Note>
        {/if}
      {:else if c.kind === 'room' && c.room}
        <ConnectionRoom room={c.room} {v} />
      {/if}
    </div>
  </Pane>
{/if}

<style>
  /* Its parts one under the other, as the dialog had them, in a column a form's width. */
  .details {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    max-width: 720px;
  }
  .machines {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
</style>
