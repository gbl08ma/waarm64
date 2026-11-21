<!--
  Register a domain… (docs/networking/names.md "What the user sees", where it is a name): one dialog from a room
  connection's Domains pane (DomainsPane.svelte), for that connection (which holds the domain by its key, wherever the
  connection is attached, connected or not). A field, with the whole domain under it (`<name>.<room name or
  tag>.p2p.internal`), checked as typed by this page alone (not a valid name, this connection's already: no server
  asked); Register asks the room's servers (one first byte of the name's id a press, the user's decision 2026-11-17:
  web/names-view.ts `NameForm`, web/names.ts `check`): free, it registers and closes (the pane then shows the domain as
  Preparing, Reserved, Active); taken, it stays open and says until about when; nobody in the room can say, it says
  so and Register pressed again registers. The two notices, always shown, no boxes. **No key is shown or asked for**.
  The pane doesn't open it for an ephemeral connection with a key of its own (it can't hold a domain: the pane says so).
  The key a domain points at and the room's domain come from the names agent (`pageNames.member`: the connection's
  stored key and the room's ID), so nothing in it waits for the connection to be connected.
-->
<script lang="ts">
  import Button from './ui/Button.svelte';
  import Field from './ui/Field.svelte';
  import Modal from './ui/Modal.svelte';
  import Note from './ui/Note.svelte';
  import T from './T.svelte';
  import { t } from '../i18n.ts';
  import type { PageNetwork } from './net-live.ts';
  import { network } from './areas/network.ts';
  import { memberOf, pageNames, type NamesOf } from './areas/names.svelte.ts';
  import { canRegister, checkWords, NameForm, type CheckShown } from './names-view.ts';
  import { inBar } from './page.ts';

  type Props = { net: PageNetwork };
  let { net }: Props = $props();

  let dialog = $state<{ open: () => void; close: () => void }>();
  let field = $state<HTMLInputElement>();
  /** The room connection it registers for (its id). */
  let id = $state<string>();
  let typed = $state('');
  let check = $state<CheckShown>({ state: 'empty' });

  const room = $derived(id === undefined ? undefined : net.connections.find((c) => c.id === id)?.room);
  const conn = $derived<NamesOf | undefined>(
    room && { identityKey: room.identityKey, link: room.link, ephemeralKey: !!room.identity },
  );
  /** The connection as its room sees it (web/names.ts `Member`): the key a domain registered here points at, and the
   * room's domain (`<room name>.p2p.internal`, or `<tag>.p2p.internal`: net/ts room.rs `Room::domain`), under which a
   * domain registered here is `<name>.<domain>` (and under the tag's as well). */
  const member = $derived(room && !room.identity ? pageNames.member(memberOf(room)) : undefined);
  const key = $derived(member?.key);
  const domain = $derived(member?.domain ?? '');
  const name = $derived(typed.trim().toLowerCase());
  const said = $derived(checkWords(name, check));
  const tone = $derived(check.state === 'checking' ? 'dim' : 'warn');
  const form = new NameForm(
    {
      here: (n) => (conn ? pageNames.checkHere(conn, n) : Promise.resolve({ state: 'invalid' })),
      servers: (n) => (conn ? pageNames.check(conn, n) : Promise.resolve({ state: 'invalid' })),
      register: (n) => {
        const [c, k] = [conn, key];
        if (!c || !k) return;
        dialog?.close();
        inBar(() => pageNames.register(c, n, k));
      },
    },
    (c) => (check = c),
  );

  $effect(() =>
    network.naming.handle((c) => {
      [id, typed] = [c, ''];
      form.typed('');
      dialog?.open();
      queueMicrotask(() => field?.focus());
    }),
  );

  function register(e: SubmitEvent) {
    e.preventDefault();
    if (key && canRegister(check)) void form.press();
  }
</script>

<Modal
  id="net-name"
  bind:this={dialog}
  auto={false}
  title={t('network:NameDialog.title')}
  onsubmit={register}
  onclose={() => {
    form.close();
    id = undefined;
  }}
>
  {#if conn && !conn.ephemeralKey}
    <Field label={t('network:NameDialog.name')}>
      <input
        id="net-name-input"
        bind:this={field}
        bind:value={typed}
        oninput={() => form.typed(name)}
        autocomplete="off"
        spellcheck="false"
        maxlength="32"
      />
    </Field>
    {#if domain}
      <Note size="md" tone="dim" id="net-name-full">
        {#if name}<T k="network:NameDialog.full" params={{ full: `${name}.${domain}`, name }} />{:else}{t(
            'network:NameDialog.suffix',
            { domain },
          )}{/if}
      </Note>
    {/if}
    <Note size="md" {tone} id="net-name-check" data-check={check.state}
      >{#if said}<T m={said} />{/if}</Note
    >
    <div class="notices" data-notices>
      <Note size="md" id="net-name-notice-find">{t('network:NameDialog.notice.find')}</Note>
      <Note size="md" id="net-name-notice-visit">{t('network:NameDialog.notice.visit')}</Note>
    </div>
  {/if}
  {#snippet buttons()}
    <Button type="button" id="net-name-cancel" onclick={() => dialog?.close()}>{t('network:NameDialog.cancel')}</Button>
    {#if conn && !conn.ephemeralKey}
      <Button type="submit" variant="primary" id="net-name-register" disabled={!key || !canRegister(check)}>
        {t('network:NameDialog.register')}
      </Button>
    {/if}
  {/snippet}
</Modal>

<style>
  .notices {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
</style>
