<!--
  The toolbar's clipboard menu (docs/plans/clipboard.md §5, docs/frontend.md "The toolbar"): shown while the running
  machine shares the clipboard. The button says the state (sharing: pressed; paused: crossed out; waiting for the
  guest's program) and carries a mark while the browser's read permission is missing or the focus reads stopped. The
  menu: the permission's item (Allow… while `prompt`, how to allow it while `denied`), the switch (paused for the run),
  Send the clipboard to the guest, Type the clipboard (and what became of it: the agent's TYPED), Copy the screen (a PNG
  of the display to the host's clipboard, with no agent: areas/clipboard-actions.ts `screenPng`). Logic is web/app/clipboard.ts's, through
  `page`.
-->
<script lang="ts">
  import Check from './ui/Check.svelte';
  import Menu from './ui/Menu.svelte';
  import Button from './ui/Button.svelte';
  import Note from './ui/Note.svelte';
  import StatusDot from './ui/StatusDot.svelte';
  import { t } from '../i18n.ts';
  import { TYPED } from '../agent-frame.ts';
  import { clipboard } from './areas/clipboard.svelte.ts';
  import { page } from './page.ts';

  let open = $state(false);
  const c = $derived(clipboard);
  /** The guest's own menus don't get the host's copy: no permission yet, or the focus reads stopped. */
  const marked = $derived(
    c.state === 'sharing' && (c.permission === 'prompt' || c.permission === 'denied' || c.stopped),
  );
  const title = $derived(
    c.state === 'paused'
      ? t('clipboard:ClipboardMenu.title.paused')
      : c.state === 'waiting'
        ? t('clipboard:ClipboardMenu.title.waiting')
        : marked
          ? t('clipboard:ClipboardMenu.title.limited')
          : t('clipboard:ClipboardMenu.title.sharing'),
  );
  const close = (f: () => unknown) => {
    open = false;
    void f();
  };
  /** Type's outcome comes later, in the agent's TYPED: the menu waits for it, open. */
  let awaitingTyped = $state(false);
  /**
   * An action that can fail (Send, Type, Copy the screen; `page` keeps its failure in `clipboard.failed`, not
   * thrown: no runner): the menu stays open while it runs and closes when it
   * succeeds; a failure keeps it open, so its note is seen where the click was.
   */
  const thenClose = async (f: () => Promise<void>, type = false) => {
    awaitingTyped = false;
    await f();
    if (clipboard.failed) return;
    if (type) awaitingTyped = true;
    else open = false;
  };
  $effect(() => {
    if (!open) awaitingTyped = false;
    else if (awaitingTyped && c.typed !== undefined) {
      awaitingTyped = false;
      if (c.typed === TYPED.DONE) open = false;
    }
  });
</script>

<Menu
  id="clipboard-menu"
  icon={c.state === 'paused' ? 'clipboard-off' : 'clipboard'}
  {title}
  bind:open
  panel
  on={c.state === 'sharing'}
  data-state={c.state}
  data-permission={c.permission}
  data-stopped={c.stopped || undefined}
>
  {#snippet badge()}{#if marked}<StatusDot tone="busy" aria-hidden="true" />{/if}{/snippet}
  {#if c.permission === 'prompt'}
    <Button
      id="clipboard-allow"
      title={t('clipboard:ClipboardMenu.allow.title')}
      onclick={() => close(() => page.clipboardAsk())}>{t('clipboard:ClipboardMenu.allow')}</Button
    >
  {:else if c.permission === 'denied'}
    <Note tone="warn" id="clipboard-denied">{t('clipboard:ClipboardMenu.denied')}</Note>
  {:else if c.permission === 'granted' && !c.stopped}
    <Note id="clipboard-granted">{t('clipboard:ClipboardMenu.granted')}</Note>
  {/if}
  {#if c.stopped}<Note tone="warn" id="clipboard-stopped">{t('clipboard:ClipboardMenu.stopped')}</Note>{/if}
  <Check
    id="clipboard-on"
    checked={c.state !== 'paused'}
    onchange={(on) => page.clipboardPause(!on)}
    title={t('clipboard:ClipboardMenu.share.title')}>{t('clipboard:ClipboardMenu.share')}</Check
  >
  {#if c.state === 'waiting'}<Note id="clipboard-waiting">
      {t('clipboard:ClipboardMenu.title.waiting')}
    </Note>{/if}
  <Button
    id="clipboard-send"
    disabled={c.state !== 'sharing'}
    title={t('clipboard:ClipboardMenu.send.title')}
    onclick={() => thenClose(() => page.clipboardSend())}>{t('clipboard:ClipboardMenu.send')}</Button
  >
  <Button
    id="clipboard-type"
    disabled={!c.canType}
    title={t('clipboard:ClipboardMenu.type.title')}
    onclick={() => thenClose(() => page.clipboardType(), true)}>{t('clipboard:ClipboardMenu.type')}</Button
  >
  <Button
    id="clipboard-screen"
    title={t('clipboard:ClipboardMenu.screen.title')}
    onclick={() => thenClose(() => page.clipboardScreen())}>{t('clipboard:ClipboardMenu.screen')}</Button
  >
  {#if c.failed === 'send'}<Note tone="warn" id="clipboard-failed">{t('clipboard:ClipboardMenu.failed.send')}</Note>
  {:else if c.failed === 'type'}<Note tone="warn" id="clipboard-failed">{t('clipboard:ClipboardMenu.failed')}</Note>
  {:else if c.failed === 'screen'}<Note tone="warn" id="clipboard-failed">
      {t('clipboard:ClipboardMenu.screen.failed')}
    </Note>{/if}
  {#if c.typed === TYPED.NOT_TEXT}<Note tone="warn" id="clipboard-not-text">
      {t('clipboard:ClipboardMenu.notText')}
    </Note>
  {:else if c.typed === TYPED.REFUSED || c.typed === TYPED.DROPPED}<Note tone="warn" id="clipboard-untyped">
      {t('clipboard:ClipboardMenu.untyped')}
    </Note>{/if}
</Menu>
