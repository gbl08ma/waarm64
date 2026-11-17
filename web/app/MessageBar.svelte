<!--
  The message bar (web/app/areas/message-bar.svelte.ts, written by web/app/run/messages.ts; docs/frontend.md "Dialogs and
  the message bar"): at the top, floating over the machine so its screen keeps its size. Over the Machines page it is
  not shown: that page's own error banner (MachinesPage.svelte, under its header) shows the message instead, so there is
  never both a floating banner and the page's banner at once. The banner floats again when the machines section closes.
-->
<script lang="ts">
  import Button from './ui/Button.svelte';
  import ErrorBanner from './ui/ErrorBanner.svelte';
  import { messageBar } from './areas/message-bar.svelte.ts';
  import { page } from './page.ts';
  import { t } from '../i18n.ts';
</script>

<!-- Its own wrapper, of no height: the bar floats over the machine (whose screen keeps its size), and the page in full
     screen hides it. -->
<div class="message" class:shown={!!messageBar.text}>
  <ErrorBanner
    id="message"
    role={messageBar.kind === 'info' ? 'status' : 'alert'}
    tone={messageBar.kind}
    floating
    countdown={messageBar.countdown}
    hidden={!messageBar.text}
    data-kind={messageBar.kind}
    data-snapshot={messageBar.snapshot || undefined}
    data-load={messageBar.load || undefined}
    bodyId="message-body"
    actionsId="message-actions"
    dismissId="message-close"
    dismissLabel={t('common:MessageBar.close')}
    ondismiss={() => page.dismiss()}
  >
    <pre id="message-text">{messageBar.text}</pre>
    {#if messageBar.details.length}<pre id="message-details">{messageBar.details.join('\n')}</pre>{/if}
    {#snippet actions()}
      {#each messageBar.actions as a (a)}<Button
          onclick={(e: MouseEvent & { currentTarget: HTMLButtonElement }) => a.run(e.currentTarget)}>{a.label}</Button
        >{/each}
    {/snippet}
  </ErrorBanner>
</div>

<style>
  pre {
    margin: 0;
    white-space: pre-wrap;
    font-family: var(--font-mono);
    font-size: var(--text-sm);
  }
  #message-text::first-line {
    font-weight: var(--weight-bold);
  }
  #message-details {
    opacity: 0.8;
  }
  .message {
    position: relative;
    z-index: 1;
    height: 0;
  }
  .message > :global(#message) {
    position: absolute;
    top: var(--space-4);
    left: 50%;
    transform: translateX(-50%);
    width: max-content;
    max-width: calc(100% - 2 * var(--space-5));
  }
  /* Full screen with the status bar (Preferences): the page, without its toolbar and message bar. */
  :global(body:fullscreen) .message {
    display: none;
  }
</style>
