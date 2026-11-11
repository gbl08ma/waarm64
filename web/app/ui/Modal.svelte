<!--
  A dialog over the page, opened when it mounts: its title, the caller's content, then a row of buttons (`buttons`, at
  the end; `back`, at the start: a wizard's Back). The shell, so the dialogs look alike: Add a disk…, Add a device…, a
  disk's Overlays, Attach to a machine, and the Network and Folder wizards (always mounted: `auto` off, opened with
  `open()`). The page's questions are Ask.svelte's. Its content is built of the primitives (Note, Field, Choice, Card,
  Button); the one rule it sets on it is layout: a column, its parts a step apart. Cards in it take the page's
  background (`--card-bg`), against the dialog's.
-->
<script lang="ts">
  import { onMount, type Snippet } from 'svelte';

  type Props = {
    /** The dialog's id; its title's is `<id>-title`. */
    id: string;
    title: string;
    onclose(): void;
    /** Makes the body a form (Enter submits). */
    onsubmit?: (e: SubmitEvent) => void;
    /** The body's id. */
    bodyId?: string;
    /** Opens the dialog when it mounts (default); off, `open()` does. */
    auto?: boolean;
    children: Snippet;
    buttons: Snippet;
    back?: Snippet;
    [attr: string]: unknown;
  };
  let { id, title, onclose, onsubmit, bodyId, auto = true, children, buttons, back, ...rest }: Props = $props();

  let dialog: HTMLDialogElement;
  onMount(() => {
    if (auto) dialog.showModal();
  });
  /** Opens the dialog, if it isn't. */
  export function open() {
    if (!dialog.open) dialog.showModal();
  }
  /** Closes the dialog (its `onclose` follows). */
  export function close() {
    dialog.close();
  }
</script>

{#snippet inner()}
  <h2 id={`${id}-title`}>{title}</h2>
  {@render children()}
  <div class="buttons">
    {#if back}<div class="back">{@render back()}</div>{/if}
    {@render buttons()}
  </div>
{/snippet}

<dialog {id} bind:this={dialog} {onclose} aria-labelledby={`${id}-title`} {...rest}>
  {#if onsubmit}<form class="body" id={bodyId} {onsubmit}>{@render inner()}</form>{:else}<div class="body" id={bodyId}>
      {@render inner()}
    </div>{/if}
</dialog>

<style>
  dialog {
    width: min(560px, calc(100vw - 32px));
    max-height: calc(100dvh - 32px);
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
  .body {
    --card-bg: var(--surface);
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
  .buttons {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    align-items: center;
    gap: var(--space-3);
  }
  .back {
    display: flex;
    gap: var(--space-3);
    margin-right: auto;
  }
</style>
