<!--
  The Network wizard's room step (NetWizard.svelte; docs/networking/rooms.md): join the global public room (its name
  given, the defaults), create a room (a name, private or public, its relays under Advanced: web/room.ts builds the
  link), or join one (a link, or a public room's name); a connection's Settings on the Home page change its switches
  (ConnectionRoomSettings.svelte). Direct connections and incoming ones are switches; a new room
  connection has a key of its own, another room connection's, or one pasted (copied from a connection, perhaps on
  another computer, or mined by net/ts/examples/room-key-mine.rs for an address).
-->
<script lang="ts">
  import Check from './ui/Check.svelte';
  import Disclosure from './ui/Disclosure.svelte';
  import Field from './ui/Field.svelte';
  import Note from './ui/Note.svelte';
  import Step from './ui/Step.svelte';
  import T from './T.svelte';
  import ValueField from './ui/ValueField.svelte';
  import { msg, t, type Msg } from '../i18n.ts';
  import { ROOM_STEPS, type Flow, type Step as StepName } from './net-wizard.ts';
  import type { PageNetwork } from './net-live.ts';
  import { tailcatBuilt } from './network.ts';
  import { GLOBAL_ROOM, parseRoomExport, parseRoomLink, privateRoomId, roomLink, type RoomLink } from '../room.ts';
  import { page } from './page.ts';

  type Props = { flow: Flow; net: PageNetwork; step: StepName };
  let { flow, net, step }: Props = $props();

  /** What the room's note on one's IP address links to: DERP, Nostr and STUN explained. */
  const DERP_DOC = 'https://tailscale.com/kb/1232/derp-servers';
  const NOSTR_DOC = 'https://github.com/nostr-protocol/nips/blob/master/01.md';
  const STUN_DOC = 'https://en.wikipedia.org/wiki/STUN';
  const DERPER = 'https://github.com/tailscale/tailscale/tree/main/cmd/derper';

  let name = $state('');
  let isPrivate = $state(true);
  let joinLink = $state('');
  let nostr = $state('');
  let derp = $state('');
  let incoming = $state(true);
  let relayOnly = $state(false);
  /** The Key list's choice: '' a new key, `PASTE` a pasted one (`pastedKey`), or another connection's id. */
  let keyOf = $state('');
  const PASTE = '#paste';
  let pastedKey = $state('');
  let advanced = $state(false);
  let nameInput = $state<HTMLInputElement>();
  let linkInput = $state<HTMLInputElement>();
  let directBox = $state<HTMLInputElement>();

  const conns = $derived(net.connections);
  /** The room connections whose key a new one may share: the stored ones (an ephemeral one's key is gone with its tab). */
  const keys = $derived(conns.filter((c) => c.kind === 'room' && !c.ephemeral));
  /** A choice of another connection's key (an <option> holds only text). */
  const sameKeyAs = (name: string) => t('network:NetRoomStep.room.key.of', { name });

  export function begin() {
    [name, isPrivate, joinLink, nostr, derp, keyOf, pastedKey, advanced] = ['', true, '', '', '', '', '', false];
    [incoming, relayOnly] = [true, false];
  }
  export function enter() {
    queueMicrotask(() => firstControl()?.focus());
  }
  /** What a step's focus starts on: the name, the link, or (the global room) the first switch. */
  function firstControl() {
    if (step === 'roomCreate') return nameInput;
    if (step === 'roomJoin') return linkInput;
    return directBox;
  }
  /** The relays as typed: one per line (or separated by spaces or commas). */
  const lines = (s: string) => s.split(/[\s,]+/).filter((x) => x);
  export async function save() {
    let link: { link: string; room?: RoomLink } | { error: Msg };
    if (step === 'roomGlobal') link = roomLink({ id: GLOBAL_ROOM, nostr: [], derp: [] });
    else if (step === 'roomCreate') {
      const n = name.trim();
      if (!n) return flow.fail(msg('network:NetRoomStep.room.noName'));
      link = roomLink({ id: isPrivate ? privateRoomId(n) : n, nostr: lines(nostr), derp: lines(derp) });
    } else link = parseRoomLink(joinLink);
    if ('error' in link) return flow.fail(link.error);
    const pasted = keyOf === PASTE ? parseRoomExport(pastedKey) : undefined;
    if (keyOf === PASTE && !pasted) return flow.fail(msg('network:NetRoomStep.room.key.bad'));
    if (!(await tailcatBuilt())) return flow.fail(msg('network:NetTailcatStep.tailcatNotBuilt'));
    const c = await page.netCreate({
      kind: 'room',
      ephemeral: !flow.keep,
      room: {
        link: link.link,
        incoming,
        relayOnly,
        ...keyChoice(pasted),
      },
    });
    await flow.made(c);
  }
  /** The key's choice: a pasted key, or a connection's whole export (the key and the names it carries); another
   * connection's key; or a new one. */
  function keyChoice(pasted: { key: string; names?: string } | undefined) {
    if (pasted) return pasted.names ? { key: pasted.key, names: pasted.names } : { key: pasted.key };
    return keyOf ? { keyOf } : {};
  }
</script>

{#snippet link(href: string, words: string)}<a {href} target="_blank" rel="noopener">{words}</a>{/snippet}
{#snippet derpLink(words: string)}{@render link(DERP_DOC, words)}{/snippet}
{#snippet nostrLink(words: string)}{@render link(NOSTR_DOC, words)}{/snippet}
{#snippet stunLink(words: string)}{@render link(STUN_DOC, words)}{/snippet}
{#snippet ipNote()}
  <span id="net-room-ip">
    {#if relayOnly}
      <T k="network:NetRoomStep.room.ip.relayed" derp={derpLink} nostr={nostrLink} />
    {:else}
      <T k="network:NetRoomStep.room.ip.direct" derp={derpLink} nostr={nostrLink} stun={stunLink} />
    {/if}
  </span>
{/snippet}

<Step id="net-step-room" active={ROOM_STEPS.has(step)}>
  {#if step === 'roomCreate'}
    <Field label={t('network:NetRoomStep.room.name')}>
      <input id="net-room-id" bind:this={nameInput} bind:value={name} autocomplete="off" spellcheck="false" />
    </Field>
    <Check
      id="net-room-private"
      bind:checked={isPrivate}
      note={isPrivate ? t('network:NetRoomStep.room.private.note') : t('network:NetRoomStep.room.public.note')}
    >
      {t('network:NetRoomStep.room.private')}
    </Check>
  {:else if step === 'roomJoin'}
    <ValueField
      id="net-room-link"
      showId="net-room-link-show"
      label={t('network:NetRoomStep.room.link')}
      bind:ref={linkInput}
      bind:value={joinLink}
      secret
    />
    <Note size="md">{t('network:NetRoomStep.room.link.note')}</Note>
  {:else if step === 'roomGlobal'}
    <Note size="md" id="net-room-global-note">{t('network:NetRoomStep.room.global.note')}</Note>
  {/if}
  <Check
    id="net-room-direct"
    bind:ref={directBox}
    checked={!relayOnly}
    onchange={(on: boolean) => (relayOnly = !on)}
    note={ipNote}
  >
    {t('network:NetRoomStep.room.direct')}
  </Check>
  <Disclosure id="net-room-advanced" bind:open={advanced} summary={t('network:NetTailcatStep.advanced')}>
    <Check
      id="net-room-incoming"
      bind:checked={incoming}
      note={incoming ? t('network:NetRoomStep.room.incoming.note') : t('network:NetRoomStep.room.incoming.off')}
    >
      {t('network:NetRoomStep.room.incoming')}
    </Check>
    {#if step === 'roomCreate'}
      <Field label={t('network:NetRoomStep.room.nostr')}>
        <textarea
          id="net-room-nostr"
          bind:value={nostr}
          rows="2"
          placeholder={t('network:NetRoomStep.room.nostr.placeholder')}
          autocomplete="off"
          spellcheck="false"></textarea>
      </Field>
      <Note size="md">{t('network:NetRoomStep.room.nostr.note')}</Note>
      <Field label={t('network:NetRoomStep.room.derp')}>
        <textarea
          id="net-room-derp"
          bind:value={derp}
          rows="2"
          placeholder={t('network:NetRoomStep.room.derp.placeholder')}
          autocomplete="off"
          spellcheck="false"></textarea>
      </Field>
      <Note size="md">
        <T k="network:NetRoomStep.room.derp.note">
          {#snippet a(words: string)}<a href={DERPER} target="_blank" rel="noopener">{words}</a>{/snippet}
        </T>
      </Note>
    {/if}
    <Field label={t('network:NetRoomStep.room.key')}>
      <select id="net-room-key" bind:value={keyOf}>
        <option value="">{t('network:NetRoomStep.room.key.new')}</option>
        <option value={PASTE}>{t('network:NetRoomStep.room.key.paste')}</option>
        {#each keys as k (k.id)}<option value={k.id}>{sameKeyAs(k.name)}</option>{/each}
      </select>
    </Field>
    {#if keyOf === PASTE}
      <ValueField
        id="net-room-key-paste"
        showId="net-room-key-paste-show"
        label={t('network:NetRoomStep.room.key.pasted')}
        bind:value={pastedKey}
        secret
        mono
      />
    {/if}
    <Note size="md">
      {#if keyOf === PASTE}<T k="network:NetRoomStep.room.key.paste.note" />{:else}{t(
          'network:NetRoomStep.room.key.note',
        )}{/if}
    </Note>
  </Disclosure>
</Step>
