<!--
  The Network wizard's room step (NetWizard.svelte; docs/tailnet.md "Rooms"): create a room (a name, private or
  public, its relays under Advanced: web/room.ts builds the link), join one (a link, or a public room's name), or edit
  one (its switches, a new name). Direct connections and incoming ones are switches; a new room connection has a key
  of its own or another room connection's.
-->
<script lang="ts">
  import Button from './ui/Button.svelte';
  import Check from './ui/Check.svelte';
  import Disclosure from './ui/Disclosure.svelte';
  import Field from './ui/Field.svelte';
  import Note from './ui/Note.svelte';
  import Step from './ui/Step.svelte';
  import T from './T.svelte';
  import { msg, t, type Msg } from '../i18n.ts';
  import { ROOM_STEPS, type Flow, type Step as StepName } from './net-wizard.ts';
  import type { PageNetwork } from './net-live.ts';
  import { tailcatBuilt } from './network.ts';
  import { hasRoomIdentity, parseRoomLink, privateRoomId, roomLink, type RoomLink } from '../room.ts';
  import { page, ui } from './ui.svelte.ts';

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
  let keyOf = $state('');
  let advanced = $state(false);
  /** The room connection being edited keeps its identity: New name can drop it. */
  let kept = $state(false);
  let nameInput = $state<HTMLInputElement>();
  let linkInput = $state<HTMLInputElement>();
  let directBox = $state<HTMLInputElement>();

  // eslint-disable-next-line @typescript-eslint/no-meaningless-void-operator -- a change counter's read (docs/frontend-code.md §3.1: to go)
  const conns = $derived((void ui.net, net.connections));
  /** The room connections whose key a new one may share: the stored ones (an ephemeral one's key is gone with its tab). */
  const keys = $derived(conns.filter((c) => c.kind === 'room' && !c.ephemeral));

  export function begin() {
    const r = flow.editing?.room;
    [name, isPrivate, joinLink, nostr, derp, keyOf, advanced] = ['', true, '', '', '', '', false];
    incoming = r?.incoming ?? true;
    relayOnly = r?.relayOnly ?? false;
  }
  export function enter() {
    const r = flow.editing?.room;
    if (step === 'roomEdit' && r?.identity) kept = true;
    else if (step === 'roomEdit' && r)
      void hasRoomIdentity(r.identityKey).then((k) => {
        kept = k;
      });
    queueMicrotask(() => firstControl()?.focus());
  }
  /** What a step's focus starts on: the name, the link, or (editing) the first switch. */
  function firstControl() {
    if (step === 'roomCreate') return nameInput;
    if (step === 'roomJoin') return linkInput;
    return directBox;
  }
  /** The relays as typed: one per line (or separated by spaces or commas). */
  const lines = (s: string) => s.split(/[\s,]+/).filter((x) => x);
  export async function save() {
    const editing = flow.editing;
    if (step === 'roomEdit' && editing?.room)
      return flow.edited({ ...editing, room: { ...editing.room, incoming, relayOnly } });
    let link: { link: string; room?: RoomLink } | { error: Msg };
    if (step === 'roomCreate') {
      const n = name.trim();
      if (!n) return flow.fail(msg('network:NetRoomStep.room.noName'));
      link = roomLink({ id: isPrivate ? privateRoomId(n) : n, nostr: lines(nostr), derp: lines(derp) });
    } else link = parseRoomLink(joinLink);
    if ('error' in link) return flow.fail(link.error);
    if (!(await tailcatBuilt())) return flow.fail(msg('network:NetTailcatStep.tailcatNotBuilt'));
    const c = await page.netCreate({
      kind: 'room',
      ephemeral: !flow.keep,
      room: { link: link.link, incoming, relayOnly, ...(keyOf ? { keyOf } : {}) },
    });
    await flow.made(c);
  }
  async function forget() {
    if (await flow.forget()) kept = false;
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
    <Field label={t('network:NetRoomStep.room.link')}>
      <input
        id="net-room-link"
        bind:this={linkInput}
        bind:value={joinLink}
        type="password"
        autocomplete="off"
        spellcheck="false"
      />
    </Field>
    <Note size="md">{t('network:NetRoomStep.room.link.note')}</Note>
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
    {#if step === 'roomEdit'}
      <div class="row">
        <Button type="button" id="net-room-new-name" disabled={!kept} onclick={forget}>
          {t('network:NetRoomStep.room.newName')}
        </Button>
      </div>
      <Note size="md">{t('network:NetRoomStep.room.newName.note')}</Note>
    {:else}
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
          {#each keys as k (k.id)}<option value={k.id}>{t('network:NetRoomStep.room.key.of', { name: k.name })}</option
            >{/each}
        </select>
      </Field>
      <Note size="md">{t('network:NetRoomStep.room.key.note')}</Note>
    {/if}
  </Disclosure>
</Step>

<style>
  .row {
    display: flex;
    gap: var(--space-3);
  }
</style>
