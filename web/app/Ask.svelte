<!-- The page's questions (web/app/ask.svelte.ts): one modal dialog, the first queued question in it. -->
<script lang="ts">
  import { answer, asking } from './ask.svelte.ts';

  let dialog: HTMLDialogElement;
  let input = $state<HTMLInputElement>();
  let okButton = $state<HTMLButtonElement>();
  const q = $derived(asking.current);
  // A prompt's text, the component's own: the question goes away while the input still holds it.
  let text = $state('');
  $effect.pre(() => { text = asking.current?.value ?? ''; });

  $effect(() => {
    if (q && !dialog.open) dialog.showModal();
    else if (!q && dialog.open) dialog.close();
    if (q) queueMicrotask(() => (q.kind === 'prompt' ? input?.select() : okButton?.focus()));
  });
</script>

<dialog id="ask" bind:this={dialog} data-serial={asking.serial} data-kind={q?.kind} oncancel={(e) => { e.preventDefault(); answer(false); }} aria-labelledby="ask-title">
  {#if q}
    <form method="dialog" onsubmit={(e) => { e.preventDefault(); answer(true, text); }}>
      <h2 id="ask-title">{q.title}</h2>
      <p class="ask-text">{q.text}</p>
      {#if q.kind === 'prompt'}<input bind:this={input} bind:value={text} spellcheck="false" autocomplete="off">{/if}
      <div class="buttons">
        {#if q.kind !== 'alert'}<button type="button" data-answer="cancel" onclick={() => answer(false)}>{q.cancel}</button>{/if}
        <button type="submit" data-answer="ok" class="primary" class:danger={q.danger} bind:this={okButton}>{q.ok}</button>
      </div>
    </form>
  {/if}
</dialog>

<style>
  dialog { width: min(480px, calc(100vw - 32px)); padding: 0; color: var(--text); background: var(--panel); border: 1px solid var(--line); border-radius: 8px; box-shadow: 0 12px 40px #000a; }
  dialog::backdrop { background: #0008; }
  form { display: flex; flex-direction: column; gap: 12px; padding: 16px; }
  h2 { margin: 0; font-size: 15px; font-weight: 600; }
  .ask-text { margin: 0; white-space: pre-wrap; color: var(--text); }
  input { font: inherit; color: var(--text); background: var(--bg); border: 1px solid var(--line); border-radius: 4px; padding: 5px 8px; }
  .buttons { display: flex; justify-content: flex-end; gap: 8px; }
  button { font: inherit; color: var(--text); background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 5px 14px; cursor: pointer; }
  .primary { background: #24406b; border-color: #3b6db3; color: #fff; }
  .primary.danger { background: #5c1d22; border-color: #a33a40; }
</style>
