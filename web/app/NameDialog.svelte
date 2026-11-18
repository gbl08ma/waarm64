<!--
  Register a domain… (docs/networking/names.md "What the user sees", where it is a name): one dialog from a room
  adapter's section of the Network menu, for the adapter's connection (which holds the domain by its key, wherever
  the connection is attached). A field, with the whole domain under it (`<name>.<room name or tag>.p2p.internal`), checked as typed by this page alone (not a valid name, this connection's already: no server
  asked); Register asks the room's servers (one first byte of the name's id a press, the user's decision 2026-11-17:
  web/names-view.ts `NameForm`, web/names.ts `check`): free, it registers and closes (the adapter then shows the name
  as Preparing, Reserved, Active); taken, it stays open and says until about when; nobody in the room can say, it says
  so and Register pressed again registers. The two notices, always shown, no boxes. **No key is shown or asked for**,
  and nothing is added to the path where the name is free (the kickoff's decision 6). A connection whose key is
  ephemeral can't hold a name: it says so instead.
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
  import { pageNames, type NamesOf } from './areas/names.svelte.ts';
  import { canRegister, checkWords, NameForm, type CheckShown } from './names-view.ts';
  import { inBar } from './page.ts';

  type Props = { net: PageNetwork };
  let { net }: Props = $props();

  let dialog = $state<{ open: () => void; close: () => void }>();
  let field = $state<HTMLInputElement>();
  let index = $state<number>();
  let typed = $state('');
  let check = $state<CheckShown>({ state: 'empty' });

  const ad = $derived(index === undefined ? undefined : net.views()[index]);
  const room = $derived(ad?.connection?.room);
  const key = $derived(ad?.view.room?.key);
  const conn = $derived<NamesOf | undefined>(
    room && { identityKey: room.identityKey, link: room.link, ephemeralKey: !!room.identity },
  );
  /** The room's domain the module named the member under (`<room name>.p2p.internal`, or `<tag>.p2p.internal`: net/ts room.rs
   * `Room::domain`): a domain registered here is `<name>.<domain>` (and under the tag's as well). */
  const domain = $derived(ad?.view.room?.name.split('.').slice(1).join('.') ?? '');
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
    network.naming.handle((i) => {
      [index, typed] = [i, ''];
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
    index = undefined;
  }}
>
  {#if conn?.ephemeralKey}
    <Note size="md" id="net-name-ephemeral">{t('network:NameDialog.ephemeral')}</Note>
  {:else}
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
    {#if !conn?.ephemeralKey}
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
