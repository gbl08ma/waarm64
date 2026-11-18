<!-- The page's questions (web/app/ask.svelte.ts): one modal dialog, the first queued question in it. -->
<script lang="ts">
  import Button from './ui/Button.svelte';
  import T from './T.svelte';
  import { answer, asking } from './ask.svelte.ts';

  let dialog: HTMLDialogElement;
  let input = $state<HTMLInputElement>();
  let okButton = $state<HTMLButtonElement>();
  const q = $derived(asking.current);
  // A prompt's text, the component's own: the question goes away while the input still holds it.
  let text = $derived(asking.current?.value ?? '');

  $effect(() => {
    if (q && !dialog.open) dialog.showModal();
    else if (!q && dialog.open) dialog.close();
    // A wait's one button cuts the power: not focused (an Enter meant for the question before mustn't press it).
    if (q && q.kind !== 'wait') queueMicrotask(() => (q.kind === 'prompt' ? input?.select() : okButton?.focus()));
  });
</script>

<dialog
  id="ask"
  bind:this={dialog}
  data-serial={asking.serial}
  data-kind={q?.kind}
  oncancel={(e) => {
    e.preventDefault();
    // A wait has no Cancel: its button, or its end, is the way out (taken down, it would leave no way to cut it short).
    if (q?.kind !== 'wait') answer(false);
  }}
  aria-labelledby="ask-title"
>
  {#if q}
    <form
      method="dialog"
      onsubmit={(e) => {
        e.preventDefault();
        answer(true, text);
      }}
    >
      <h2 id="ask-title">{#if typeof q.title === 'string'}{q.title}{:else}<T m={q.title} />{/if}</h2>
      <p class="ask-text">{#if typeof q.text === 'string'}{q.text}{:else}<T m={q.text} />{/if}</p>
      {#if q.kind === 'prompt'}<input bind:this={input} bind:value={text} spellcheck="false" autocomplete="off" />{/if}
      <div class="buttons">
        {#if q.kind !== 'alert' && q.kind !== 'wait'}<Button
            type="button"
            data-answer="cancel"
            onclick={() => answer(false)}>{q.cancel}</Button
          >{/if}
        <Button type="submit" data-answer="ok" variant={q.danger ? 'danger' : 'primary'} bind:ref={okButton}
          >{q.ok}</Button
        >
      </div>
    </form>
  {/if}
</dialog>

<style>
  /* The shell is Modal's (web/app/ui/Modal.svelte); a question has its own: it's always mounted, and opens and closes
     with the queue. */
  dialog {
    width: min(480px, calc(100vw - 32px));
    padding: 0;
    color: var(--text);
    background: var(--surface-raised);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-dialog);
  }
  dialog::backdrop {
    background: var(--backdrop);
  }
  form {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    padding: var(--space-5);
  }
  h2 {
    margin: 0;
    font-size: var(--text-lg);
    font-weight: var(--weight-bold);
  }
  .ask-text {
    margin: 0;
    white-space: pre-wrap;
  }
  .buttons {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-3);
  }
</style>
