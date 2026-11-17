<!--
  Name this machine… (docs/plans/room-names.md "What the user sees"): one dialog from a room adapter's section of the
  Network menu. A field, checked as typed (free, taken until about a date, not a valid name, this connection's
  already, or nobody in the room can say: web/names.ts `check`, which asks the room's servers for the ids under the
  name's id's first byte, never the id); the two notices, always shown, no boxes; Register, which closes it (the
  adapter then shows the name as Preparing, Reserved, Active). **No key is shown or asked for**, and nothing is added
  to this path (the kickoff's decision 6). A connection whose key is ephemeral can't hold a name: it says so instead.
-->
<script lang="ts">
  import Button from './ui/Button.svelte';
  import Field from './ui/Field.svelte';
  import Modal from './ui/Modal.svelte';
  import Note from './ui/Note.svelte';
  import { t, text } from '../i18n.ts';
  import type { PageNetwork } from './net-live.ts';
  import { network } from './areas/network.ts';
  import { pageNames, type NamesOf } from './areas/names.svelte.ts';
  import { canRegister, checkWords, type CheckShown } from './names-view.ts';
  import { inBar } from './page.ts';

  type Props = { net: PageNetwork };
  let { net }: Props = $props();

  /** How long typing pauses before the name is checked. */
  const CHECK_AFTER_MS = 300;

  let dialog = $state<{ open: () => void; close: () => void }>();
  let field = $state<HTMLInputElement>();
  let index = $state<number>();
  let typed = $state('');
  let check = $state<CheckShown>({ state: 'empty' });
  /** The check under way: an answer to an older one is dropped. */
  let serial = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const ad = $derived(index === undefined ? undefined : net.views()[index]);
  const room = $derived(ad?.connection?.room);
  const key = $derived(ad?.view.room?.key);
  const conn = $derived<NamesOf | undefined>(
    room && { identityKey: room.identityKey, link: room.link, ephemeralKey: !!room.identity },
  );
  const name = $derived(typed.trim().toLowerCase());
  const said = $derived(checkWords(name, check));
  const tone = $derived(check.state === 'free' ? 'ok' : check.state === 'checking' ? 'dim' : 'warn');

  $effect(() =>
    network.naming.handle((i) => {
      [index, typed, check] = [i, '', { state: 'empty' }];
      dialog?.open();
      queueMicrotask(() => field?.focus());
    }),
  );

  function changed() {
    clearTimeout(timer);
    const n = name;
    const c = conn;
    const k = ++serial;
    if (!n || !c) {
      check = { state: 'empty' };
      return;
    }
    check = { state: 'checking' };
    timer = setTimeout(() => {
      pageNames.check(c, n).then(
        (r) => {
          if (k === serial) check = r;
        },
        () => {
          if (k === serial) check = { state: 'unknown' };
        },
      );
    }, CHECK_AFTER_MS);
  }

  function register(e: SubmitEvent) {
    e.preventDefault();
    const [c, n, k] = [conn, name, key];
    if (!c || !k || !canRegister(check)) return;
    dialog?.close();
    inBar(() => pageNames.register(c, n, k));
  }
</script>

<Modal
  id="net-name"
  bind:this={dialog}
  auto={false}
  title={t('network:NameDialog.title')}
  onsubmit={register}
  onclose={() => {
    clearTimeout(timer);
    serial++;
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
        oninput={changed}
        autocomplete="off"
        spellcheck="false"
        maxlength="32"
      />
    </Field>
    <Note size="md" {tone} id="net-name-check" data-check={check.state}>{said ? text(said) : ''}</Note>
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
