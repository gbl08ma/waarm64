<!--
  A room connection's part of its Settings (ConnectionSettings.svelte; docs/networking/rooms.md), in its Fields grid:
  its two switches (direct connections to the room's members, and members connecting to the guest), with the wizard's
  room step's words (NetRoomStep.svelte), and under Advanced its key to copy, its domains after it (the names agent's
  owners' secret and titles), and New name, which gives it a new key now (`page.netNewAddress`, after asking). A stored
  connection's key is made under its entry when its page first shows it (the names agent's `member`, which Details' name
  in the room reads too: `pageNames.member`), so the field has it whether or not the connection ever connected.
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
  import { memberOf, pageNames } from './areas/names.svelte.ts';

  type Props = { net: PageNetwork; connection: Connection; act: Act; draft: SettingsDraft };
  let { net, connection, act, draft = $bindable() }: Props = $props();

  const DERP_DOC = 'https://tailscale.com/kb/1232/derp-servers';
  const NOSTR_DOC = 'https://github.com/nostr-protocol/nips/blob/master/01.md';
  const STUN_DOC = 'https://en.wikipedia.org/wiki/STUN';

  /** The connection's key and domains, to copy ('' until read), hidden until shown (or the clipboard refused it). */
  let exported = $state('');
  let keyShown = $state(false);
  let advanced = $state(false);
  /** It keeps a key of its own: New name can drop it. */
  let kept = $state(false);

  // Read for the connection shown and its key (made by `member` the first time: not again at each read of the records).
  const id = $derived(connection.id);
  const member = $derived(connection.room ? pageNames.member(memberOf(connection.room)) : undefined);
  const key = $derived(member?.key);
  /** Reads overtaken by a later one are dropped. */
  let reads = 0;
  $effect(() => {
    // eslint-disable-next-line @typescript-eslint/no-meaningless-void-operator -- read to track them (the effect's dependencies)
    void [id, key];
    untrack(() => {
      const n = ++reads;
      void net.conns.exportKey(connection).then(
        (k) => n === reads && ([kept, exported] = [!!k, k]),
        () => n === reads && ([kept, exported] = [false, '']),
      );
    });
  });
  /** A new key, after asking: an ephemeral connection's is in its record now, a stored one's is made under its entry
   *  again (`member`, read again), each then shown to copy. */
  function newName() {
    return act(t('machines:ConnectionNav.busy.forgettingAddress'), async () => {
      const before = connection.room?.identityKey;
      const now = await page.netNewAddress(connection);
      if (!now) return;
      if (before) pageNames.forgetMember(before);
      // Read now (an ephemeral one's new key is in the record; a stored one's entry is gone until `member` makes it).
      const n = ++reads;
      const k = await net.conns.exportKey(now);
      if (n === reads) [kept, exported] = [!!k, k];
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
  {#if exported}<Note size="md"><T k="network:ConnectionRoomSettings.key.note" /></Note>{/if}
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
