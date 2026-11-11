<!--
  The toolbar's clipboard menu (docs/plans/clipboard.md §5, docs/frontend.md "The toolbar"): shown while the running
  machine shares the clipboard. The button says the state (sharing: pressed; paused: crossed out; waiting for the
  guest's program) and carries a mark while the browser's read permission is missing or the focus reads stopped. The
  menu: the permission's item (Allow… while `prompt`, how to allow it while `denied`), the switch (paused for the run),
  Send the clipboard to the guest, Type the clipboard (and what became of it: the agent's TYPED), Copy the screen (a PNG
  of the display to the host's clipboard, with no agent: main.ts `screenPng`). Logic is web/app/clipboard.ts's, through
  `page`.
-->
<script lang="ts">
  import Check from './Check.svelte';
  import Menu from './Menu.svelte';
  import { t } from '../i18n.ts';
  import { TYPED } from '../agent-frame.ts';
  import { page, ui } from './ui.svelte.ts';

  let open = $state(false);
  const c = $derived(ui.clipboard);
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
   * An action that can fail (Send, Type, Copy the screen): the menu stays open while it runs and closes when it
   * succeeds; a failure keeps it open, so its note is seen where the click was.
   */
  const act = async (f: () => Promise<void>, type = false) => {
    awaitingTyped = false;
    await f();
    if (ui.clipboard.failed) return;
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
  data-on={c.state === 'sharing' || undefined}
  data-state={c.state}
  data-permission={c.permission}
  data-stopped={c.stopped || undefined}
>
  {#snippet badge()}{#if marked}<span class="dot" aria-hidden="true"></span>{/if}{/snippet}
  {#if c.permission === 'prompt'}
    <button
      id="clipboard-allow"
      title={t('clipboard:ClipboardMenu.allow.title')}
      onclick={() => close(() => page.clipboardAsk())}>{t('clipboard:ClipboardMenu.allow')}</button
    >
  {:else if c.permission === 'denied'}
    <p class="hint warn" id="clipboard-denied">{t('clipboard:ClipboardMenu.denied')}</p>
  {:else if c.permission === 'granted' && !c.stopped}
    <p class="hint" id="clipboard-granted">{t('clipboard:ClipboardMenu.granted')}</p>
  {/if}
  {#if c.stopped}<p class="hint warn" id="clipboard-stopped">{t('clipboard:ClipboardMenu.stopped')}</p>{/if}
  <Check
    id="clipboard-on"
    checked={c.state !== 'paused'}
    onchange={(on) => page.clipboardPause(!on)}
    title={t('clipboard:ClipboardMenu.share.title')}>{t('clipboard:ClipboardMenu.share')}</Check
  >
  {#if c.state === 'waiting'}<p class="hint" id="clipboard-waiting">
      {t('clipboard:ClipboardMenu.title.waiting')}
    </p>{/if}
  <button
    id="clipboard-send"
    disabled={c.state !== 'sharing'}
    title={t('clipboard:ClipboardMenu.send.title')}
    onclick={() => act(() => page.clipboardSend())}>{t('clipboard:ClipboardMenu.send')}</button
  >
  <button
    id="clipboard-type"
    disabled={!c.canType}
    title={t('clipboard:ClipboardMenu.type.title')}
    onclick={() => act(() => page.clipboardType(), true)}>{t('clipboard:ClipboardMenu.type')}</button
  >
  <button
    id="clipboard-screen"
    title={t('clipboard:ClipboardMenu.screen.title')}
    onclick={() => act(() => page.clipboardScreen())}>{t('clipboard:ClipboardMenu.screen')}</button
  >
  {#if c.failed === 'send'}<p class="hint warn" id="clipboard-failed">{t('clipboard:ClipboardMenu.failed.send')}</p>
  {:else if c.failed === 'type'}<p class="hint warn" id="clipboard-failed">{t('clipboard:ClipboardMenu.failed')}</p>
  {:else if c.failed === 'screen'}<p class="hint warn" id="clipboard-failed">
      {t('clipboard:ClipboardMenu.screen.failed')}
    </p>{/if}
  {#if c.typed === TYPED.NOT_TEXT}<p class="hint warn" id="clipboard-not-text">
      {t('clipboard:ClipboardMenu.notText')}
    </p>
  {:else if c.typed === TYPED.REFUSED || c.typed === TYPED.DROPPED}<p class="hint warn" id="clipboard-untyped">
      {t('clipboard:ClipboardMenu.untyped')}
    </p>{/if}
</Menu>

<style>
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--busy);
  }
</style>
