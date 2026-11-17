<!--
  A network adapter's details (docs/frontend.md "Network"): a dialog opened from its section of a toolbar Network menu
  (Details…, web/app/areas/network.ts `openDetails`), with what the menu leaves out to stay short. Its connection's
  settings and the values it gives out (the guest's address, a tailcat address or key, a room's name and link), each
  to copy, with what they let in and how to use them: tailcat's commands, the line that lets only this machine through
  a tailcat server, the local helper's install lines; why a room's members go through the relay, when a direct path was
  wanted (the menu's warning opens it), and what may fix it. Edit connection… opens the Network wizard on the connection.
  It follows the adapter live (`net.views()`); always mounted, as the wizard is.
-->
<script lang="ts">
  import Button from './ui/Button.svelte';
  import Modal from './ui/Modal.svelte';
  import Note from './ui/Note.svelte';
  import ValueField from './ui/ValueField.svelte';
  import NetLocalInstall from './NetLocalInstall.svelte';
  import NameEntry from './NameEntry.svelte';
  import { pageNames } from './areas/names.svelte.ts';
  import { namesLine } from './names-view.ts';
  import T from './T.svelte';
  import { t, text } from '../i18n.ts';
  import { SOURCE } from '../local-release.ts';
  import type { PageNetwork } from './net-live.ts';
  import { network } from './areas/network.ts';
  import { defaultsOf } from './network-view.ts';

  type Props = { net: PageNetwork };
  let { net }: Props = $props();

  /** The dialog (Modal.svelte's exports). */
  let dialog = $state<{ open: () => void; close: () => void }>();
  /** The adapter shown; none while closed. */
  let index = $state<number>();
  const ad = $derived(index === undefined ? undefined : net.views()[index]);
  const c = $derived(ad?.connection);
  const v = $derived(ad?.view);
  /** The connection can be edited (the browser has it). */
  const editable = $derived(!!c && net.connections.some((x) => x.id === c.id));
  const roomNames = $derived(c?.room ? pageNames.of({ identityKey: c.room.identityKey, link: c.room.link }) : []);
  /** The room's domain (`<tag>.p2p.internal`): a member's name is its key's label under it. */
  const domain = $derived(v?.room?.name.split('.').slice(1).join('.') ?? '');
  const allow = $derived(v?.tailcatKey ? `tailcat serve --allow=${v.tailcatKey} exit-node` : '');

  $effect(() =>
    network.details.handle((i) => {
      index = i;
      dialog?.open();
    }),
  );

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
  function edit() {
    const id = c?.id;
    dialog?.close();
    if (id) network.openWizard({ mode: 'edit', connection: id });
  }
</script>

{#snippet code(words: string)}<code>{words}</code>{/snippet}

<Modal
  id="net-details"
  bind:this={dialog}
  auto={false}
  title={c?.name ?? adapterLine}
  onclose={() => (index = undefined)}
  data-kind={c?.kind}
>
  {#if ad && c && v}
    <Note size="md">{adapterLine}</Note>
    {#if v.address}
      <ValueField
        id="net-details-address"
        copyId="net-details-address-copy"
        label={v.address.includes(':') ? t('network:NetDetails.address.v6') : t('network:NetDetails.address')}
        value={v.address}
        readonly
        copy
      />
    {/if}
    {#if c.kind === 'tailnet' && c.tailnet}
      <ValueField
        id="net-details-hostname"
        label={t('network:NetDetails.tailnet.hostname')}
        value={c.tailnet.hostname}
        readonly
        copy
      />
      <ValueField
        id="net-details-control"
        label={t('network:NetDetails.tailnet.control')}
        value={c.tailnet.controlURL}
        readonly
        copy
      />
      <Note size="md">{t('network:NetDetails.tailnet.note')}</Note>
    {:else if c.kind === 'tailcat'}
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
            k="network:NetDetails.served.note"
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
        <Note size="md">{t('network:NetDetails.key.note')}</Note>
        <ValueField id="net-details-allow" copyId="net-details-allow-copy" value={allow} readonly copy mono />
        {#if c.ephemeral}<Note size="md">{t('network:NetDetails.key.ephemeral')}</Note>{/if}
      {/if}
      {#if !v.served && !v.tailcatKey}<Note size="md">{t('network:NetDetails.tailcat.offline')}</Note>{/if}
    {:else if c.kind === 'local'}
      <Note size="md">
        <T k="network:NetDetails.local.note">
          {#snippet a(words: string)}<a href={SOURCE} target="_blank" rel="noopener">{words}</a>{/snippet}
        </T>
      </Note>
      <NetLocalInstall prefix="net-details-local" open={v.phase !== 'connected'} />
      <Note size="md">{t('network:NetDetails.local.link')}</Note>
    {:else if c.kind === 'room' && c.room}
      {#if v.room}
        <ValueField
          id="net-details-room-name"
          copyId="net-details-room-name-copy"
          label={t('network:NetAdapter.room.name')}
          value={v.room.name}
          readonly
          copy
        />
      {/if}
      <ValueField
        id="net-details-room-link"
        copyId="net-details-room-link-copy"
        showId="net-details-room-link-show"
        label={t('network:NetAdapter.room.link')}
        value={c.room.link}
        readonly
        copy
        secret
      />
      <Note size="md" id="net-details-room-note">
        {c.room.incoming ? t('network:NetDetails.room.note') : t('network:NetDetails.room.note.off')}
      </Note>
      {#if !v.room}<Note size="md">{t('network:NetDetails.room.offline')}</Note>{/if}
      {#if v.room?.blocked}
        <Note size="md" tone="warn" id="net-details-room-blocked">
          <T
            k="network:NetDetails.room.directBlocked"
            params={{ flag: '#webrtc-ip-handling-policy', page: 'chrome://flags' }}
            {code}
          />
        </Note>
      {/if}
      {#if v.room?.peersBlocked}
        <Note size="md" tone="warn" id="net-details-room-peers-blocked">
          <T
            k="network:NetDetails.room.peersBlocked"
            params={{ count: v.room.peersBlocked, flag: '#webrtc-ip-handling-policy' }}
            {code}
          />
        </Note>
      {/if}
      {#if v.room?.failed}
        <Note size="md" tone="warn" id="net-details-room-failed"
          >{t('network:NetDetails.room.directFailed', { count: v.room.failed })}</Note
        >
      {/if}
      {#if v.room?.names}<Note size="md" id="net-details-names-line">{text(namesLine(v.room.names))}</Note>{/if}
      {#if v.room?.key && domain}
        {#each roomNames as n (n.name)}
          <NameEntry v={n} conn={{ identityKey: c.room.identityKey, link: c.room.link }} {domain} here={v.room.key} />
        {/each}
      {/if}
    {/if}
  {/if}
  {#snippet buttons()}
    {#if editable}
      <Button type="button" id="net-details-edit" onclick={edit}>{t('network:NetDetails.edit')}</Button>
    {/if}
    <Button type="button" variant="primary" id="net-details-close" onclick={() => dialog?.close()}>
      {t('network:NetDetails.close')}
    </Button>
  {/snippet}
</Modal>
