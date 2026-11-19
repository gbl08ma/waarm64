<!--
  The toolbar's clipboard menu (docs/plans/clipboard.md §5, docs/frontend.md "The toolbar"): shown while the running
  machine shares the clipboard. The button says the state with its light (`tone`, as the network's) and its tooltip,
  never pressed (it isn't a switch): green sharing, amber waiting for the guest's program or sharing with less (the
  browser's read permission missing, or the focus reads stopped), grey paused (the icon crossed out too; a demo's machine starts each run so, and says how to turn it on). The
  menu: the permission's item (Allow… while `prompt`, how to allow it while `denied`), the switch (paused for the run),
  Send the clipboard to the guest, Type the clipboard (and what became of it: the agent's TYPED), Copy the screen (a PNG
  of the display to the host's clipboard, with no agent: areas/clipboard-actions.ts `screenPng`), Copy the console's text (the
  agent's COPY: the text console's screen as text, paused too; a console that shows graphics says so). Logic is web/app/clipboard.ts's, through
  `page`.
-->
<script lang="ts">
  import Check from './ui/Check.svelte';
  import Menu from './ui/Menu.svelte';
  import Button from './ui/Button.svelte';
  import Note from './ui/Note.svelte';
  import StatusDot from './ui/StatusDot.svelte';
  import T from './T.svelte';
  import { t } from '../i18n.ts';
  import { TYPED } from '../agent-frame.ts';
  import { clipboard } from './areas/clipboard.svelte.ts';
  import type { ShareState } from './clipboard.ts';
  import { page } from './page.ts';

  let open = $state(false);
  const c = $derived(clipboard);
  /** The guest's own menus don't get the host's copy: no permission yet, or the focus reads stopped. */
  const marked = $derived(
    c.state === 'sharing' && (c.permission === 'prompt' || c.permission === 'denied' || c.stopped),
  );
  /** The button's light: each state's, and amber for sharing with less. */
  const TONES: Record<ShareState, 'ok' | 'busy' | 'off'> = { sharing: 'ok', waiting: 'busy', paused: 'off' };
  const tone = $derived(marked ? 'busy' : TONES[c.state]);
  const title = $derived(
    c.state === 'paused'
      ? c.startedPaused
        ? t('clipboard:ClipboardMenu.title.pausedDemo')
        : t('clipboard:ClipboardMenu.title.paused')
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
  data-state={c.state}
  data-permission={c.permission}
  data-stopped={c.stopped || undefined}
>
  {#snippet badge()}<StatusDot {tone} aria-hidden="true" data-tone={tone} />{/snippet}
  {#if c.permission === 'prompt' && !(c.state === 'paused' && c.startedPaused)}
    <!-- A demo's machine, started paused: its switch is the one click that asks (`clipboardPause`). -->
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
  {#if c.stopped}<Note tone="warn" id="clipboard-stopped"><T k="clipboard:ClipboardMenu.stopped" /></Note>{/if}
  <Check
    id="clipboard-on"
    checked={c.state !== 'paused'}
    onchange={(on) => page.clipboardPause(!on)}
    title={t('clipboard:ClipboardMenu.share.title')}>{t('clipboard:ClipboardMenu.share')}</Check
  >
  {#if c.state === 'paused' && c.startedPaused}<Note id="clipboard-paused-demo">
      {t('clipboard:ClipboardMenu.title.pausedDemo')}
    </Note>{/if}
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
  <Button
    id="clipboard-console"
    disabled={!c.canCopy}
    title={t('clipboard:ClipboardMenu.console.title')}
    onclick={() => thenClose(() => page.clipboardConsole())}>{t('clipboard:ClipboardMenu.console')}</Button
  >
  {#if c.failed === 'send'}<Note tone="warn" id="clipboard-failed">{t('clipboard:ClipboardMenu.failed.send')}</Note>
  {:else if c.failed === 'type'}<Note tone="warn" id="clipboard-failed">{t('clipboard:ClipboardMenu.failed')}</Note>
  {:else if c.failed === 'screen'}<Note tone="warn" id="clipboard-failed">
      {t('clipboard:ClipboardMenu.screen.failed')}
    </Note>
  {:else if c.failed === 'console'}<Note tone="warn" id="clipboard-failed">
      {t('clipboard:ClipboardMenu.console.failed')}
    </Note>
  {:else if c.failed === 'graphics'}<Note tone="warn" id="clipboard-graphics">
      <T k="clipboard:ClipboardMenu.console.graphics" />
    </Note>{/if}
  {#if c.typed === TYPED.NOT_TEXT}<Note tone="warn" id="clipboard-not-text">
      {t('clipboard:ClipboardMenu.notText')}
    </Note>
  {:else if c.typed === TYPED.REFUSED || c.typed === TYPED.DROPPED}<Note tone="warn" id="clipboard-untyped">
      {t('clipboard:ClipboardMenu.untyped')}
    </Note>{/if}
</Menu>
