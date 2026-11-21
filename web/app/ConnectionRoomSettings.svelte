<!--
  A room connection's part of its Settings (ConnectionSettings.svelte; docs/networking/rooms.md), in its Fields grid:
  its two switches (direct connections to the room's members, and members connecting to the guest), with the wizard's
  room step's words (NetRoomStep.svelte), and under Advanced its key to copy, its domains after it (the names agent's
  owners' secret and titles), and New name, which gives it a new key now (`page.netNewAddress`, after asking): an
  ephemeral connection has it at once, a stored one at its next start.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import Button from './ui/Button.svelte';
  import Check from './ui/Check.svelte';
  import Disclosure from './ui/Disclosure.svelte';
  import Note from './ui/Note.svelte';
  import T from './T.svelte';
  import ValueField from './ui/ValueField.svelte';
  import type { Act } from './actions.svelte.ts';
  import { t } from '../i18n.ts';
  import type { Connection } from './connections.ts';
  import type { SettingsDraft } from './connection-settings.ts';
  import type { PageNetwork } from './net-live.ts';
  import { page } from './page.ts';

  type Props = { net: PageNetwork; connection: Connection; act: Act; draft: SettingsDraft };
  let { net, connection, act, draft = $bindable() }: Props = $props();

  const DERP_DOC = 'https://tailscale.com/kb/1232/derp-servers';
  const NOSTR_DOC = 'https://github.com/nostr-protocol/nips/blob/master/01.md';
  const STUN_DOC = 'https://en.wikipedia.org/wiki/STUN';

  /** The connection's key and domains, to copy ('' before it's made), hidden until shown (or the clipboard refused it). */
  let exported = $state('');
  let keyShown = $state(false);
  let advanced = $state(false);
  /** It keeps a key of its own: New name can drop it. */
  let kept = $state(false);

  // Read once for the connection shown (not again at each read of the records: New name says what follows it).
  const id = $derived(connection.id);
  $effect(() => {
    // eslint-disable-next-line @typescript-eslint/no-meaningless-void-operator -- read to track it (the effect's dependency)
    void id;
    untrack(() => {
      void net.conns.exportKey(connection).then(
        (k) => ([kept, exported] = [!!k, k]),
        () => ([kept, exported] = [false, '']),
      );
    });
  });
  /** A new key, after asking: an ephemeral connection's is in its record now (to copy), a stored one's comes at its
   *  next start. */
  function newName() {
    return act(t('machines:ConnectionNav.busy.forgettingAddress'), async () => {
      const now = await page.netNewAddress(connection);
      if (now) [kept, exported] = [false, now.room?.identity ? await net.conns.exportKey(now) : ''];
    });
  }
</script>

{#snippet link(href: string, words: string)}<a {href} target="_blank" rel="noopener">{words}</a>{/snippet}
{#snippet derpLink(words: string)}{@render link(DERP_DOC, words)}{/snippet}
{#snippet nostrLink(words: string)}{@render link(NOSTR_DOC, words)}{/snippet}
{#snippet stunLink(words: string)}{@render link(STUN_DOC, words)}{/snippet}
{#snippet ipNote()}
  <span id="settings-room-ip">
    {#if draft.relayOnly}
      <T k="network:NetRoomStep.room.ip.relayed" derp={derpLink} nostr={nostrLink} />
    {:else}
      <T k="network:NetRoomStep.room.ip.direct" derp={derpLink} nostr={nostrLink} stun={stunLink} />
    {/if}
  </span>
{/snippet}

<Check
  id="settings-room-direct"
  checked={!draft.relayOnly}
  onchange={(on: boolean) => (draft.relayOnly = !on)}
  note={ipNote}
>
  {t('network:NetRoomStep.room.direct')}
</Check>
<Check
  id="settings-room-incoming"
  bind:checked={draft.incoming}
  note={draft.incoming ? t('network:NetRoomStep.room.incoming.note') : t('network:NetRoomStep.room.incoming.off')}
>
  {t('network:NetRoomStep.room.incoming')}
</Check>
<Disclosure id="settings-room-advanced" bind:open={advanced} summary={t('network:NetTailcatStep.advanced')}>
  <ValueField
    id="settings-room-key-value"
    copyId="settings-room-key-copy"
    showId="settings-room-key-show"
    label={t('network:ConnectionRoomSettings.key')}
    value={exported}
    bind:shown={keyShown}
    readonly
    copy
    secret
    mono
  />
  <Note size="md">
    {#if exported}<T k="network:ConnectionRoomSettings.key.note" />{:else}{t(
        'network:ConnectionRoomSettings.key.none',
      )}{/if}
  </Note>
  <div class="row">
    <Button type="button" id="settings-room-new-name" disabled={!kept} onclick={newName}>
      {t('network:ConnectionRoomSettings.newName')}
    </Button>
  </div>
  <Note size="md">{t('network:ConnectionRoomSettings.newName.note')}</Note>
</Disclosure>

<style>
  .row {
    display: flex;
    gap: var(--space-3);
  }
</style>
