<!--
  A room connection's part of its Details (ConnectionDetails.svelte; docs/networking/rooms.md): its name in the room,
  connected or not (the names agent's `member`, from its key and the room's ID), the room's link and who may connect (kept with the connection, so always), why
  members go through the relay where a direct path was wanted (the toolbar's warning leads here) and what may fix it,
  the registry's line, and its domains (NameEntry.svelte, as the details dialog had them: DOMAINS loops 4 and 5 move
  them to the connection's Domains section).
-->
<script lang="ts">
  import Note from './ui/Note.svelte';
  import ValueField from './ui/ValueField.svelte';
  import NameEntry from './NameEntry.svelte';
  import T from './T.svelte';
  import { memberOf, pageNames } from './areas/names.svelte.ts';
  import { namesLine } from './names-view.ts';
  import { t, text } from '../i18n.ts';
  import type { RoomConnection } from './connections.ts';
  import type { NetworkView } from './network-view.ts';

  type Props = { room: RoomConnection; v: NetworkView | undefined };
  let { room, v }: Props = $props();

  const conn = $derived({ identityKey: room.identityKey, link: room.link });
  const roomNames = $derived(pageNames.of(conn));
  /** The connection as its room sees it, connected or not: its key, its name, the room's domain (web/names.ts
   * `Member`): a member's name is its key's label under the domain. */
  const member = $derived(pageNames.member(memberOf(room)));
</script>

{#snippet code(words: string)}<code>{words}</code>{/snippet}

{#if member}
  <ValueField
    id="net-details-room-name"
    copyId="net-details-room-name-copy"
    label={t('network:ConnectionRoom.name')}
    value={member.name}
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
{#if member}
  {#each roomNames as n (n.name)}
    <NameEntry v={n} {conn} domain={member.domain} here={member.key} />
  {/each}
{/if}
