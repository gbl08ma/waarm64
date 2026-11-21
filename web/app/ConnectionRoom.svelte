<!--
  A room connection's part of its Details (ConnectionDetails.svelte; docs/networking/rooms.md): its name in the room
  while it is connected on this page, the room's link and who may connect (kept with the connection, so always), why
  members go through the relay where a direct path was wanted (the toolbar's warning leads here) and what may fix it,
  the registry's line, and its domains (NameEntry.svelte, as the details dialog had them: DOMAINS loops 4 and 5 move
  them to the connection's Domains section).
-->
<script lang="ts">
  import Note from './ui/Note.svelte';
  import ValueField from './ui/ValueField.svelte';
  import NameEntry from './NameEntry.svelte';
  import T from './T.svelte';
  import { pageNames } from './areas/names.svelte.ts';
  import { namesLine } from './names-view.ts';
  import { t, text } from '../i18n.ts';
  import type { RoomConnection } from './connections.ts';
  import type { NetworkView } from './network-view.ts';

  type Props = { room: RoomConnection; v: NetworkView | undefined };
  let { room, v }: Props = $props();

  const conn = $derived({ identityKey: room.identityKey, link: room.link });
  const roomNames = $derived(pageNames.of(conn));
  /** The room's domain the module named the member under (`<room name>.p2p.internal`, or `<tag>.p2p.internal`: net/ts
   * room.rs `Room::domain`): a member's name is its key's label under it. */
  const domain = $derived(v?.room?.name.split('.').slice(1).join('.') ?? '');
</script>

{#snippet code(words: string)}<code>{words}</code>{/snippet}

{#if v?.room}
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
  value={room.link}
  readonly
  copy
  secret
/>
<Note size="md" id="net-details-room-note">
  {room.incoming ? t('network:ConnectionRoom.note') : t('network:ConnectionRoom.note.off')}
</Note>
{#if !v?.room}<Note size="md">{t('network:ConnectionRoom.offline')}</Note>{/if}
{#if v?.room?.blocked}
  <Note size="md" tone="warn" id="net-details-room-blocked">
    <T
      k="network:ConnectionRoom.directBlocked"
      params={{ flag: '#webrtc-ip-handling-policy', page: 'chrome://flags' }}
      {code}
    />
  </Note>
{/if}
{#if v?.room?.peersBlocked}
  <Note size="md" tone="warn" id="net-details-room-peers-blocked">
    <T
      k="network:ConnectionRoom.peersBlocked"
      params={{ count: v.room.peersBlocked, flag: '#webrtc-ip-handling-policy' }}
      {code}
    />
  </Note>
{/if}
{#if v?.room?.failed}
  <Note size="md" tone="warn" id="net-details-room-failed"
    >{t('network:ConnectionRoom.directFailed', { count: v.room.failed })}</Note
  >
{/if}
{#if v?.room?.names}<Note size="md" id="net-details-names-line">{text(namesLine(v.room.names))}</Note>{/if}
{#if v?.room?.key && domain}
  {#each roomNames as n (n.name)}
    <NameEntry v={n} {conn} {domain} here={v.room.key} />
  {/each}
{/if}
