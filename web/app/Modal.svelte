<!--
  A dialog over the page, opened when it mounts: its title, the caller's content, then a row of buttons. The shell and the
  rules its content shares, so the dialogs look alike: Add a disk…, Add a device…, a disk's Overlays, Attach to a machine,
  and the Network and Folder wizards (always mounted: `auto` off, opened with `open()`). The page's questions are
  Ask.svelte's. Content classes: `note` (a dim paragraph), `error`, `choices` of `choice` buttons (a wizard's first step;
  `.choice` and `.net-choice` are index.html's), `rows` (a list of items, each `what` + buttons, `none` for the empty
  line), `meta` (an item's small line; `warn` for why it can't be chosen), `primary` (the main button), and labels over their fields; in `buttons`, a `grow`
  spacer.
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
    [attr: string]: unknown;
  };
  let { id, title, onclose, onsubmit, bodyId, auto = true, children, buttons, ...rest }: Props = $props();

  let dialog: HTMLDialogElement;
  onMount(() => { if (auto) dialog.showModal(); });
  /** Opens the dialog, if it isn't. */
  export function open() { if (!dialog.open) dialog.showModal(); }
  /** Closes the dialog (its `onclose` follows). */
  export function close() { dialog.close(); }
</script>

{#snippet inner()}
  <h2 id={`${id}-title`}>{title}</h2>
  {@render children()}
  <div class="buttons">{@render buttons()}</div>
{/snippet}

<dialog {id} bind:this={dialog} {onclose} aria-labelledby={`${id}-title`} {...rest}>
  {#if onsubmit}<form class="body" id={bodyId} {onsubmit}>{@render inner()}</form>{:else}<div class="body" id={bodyId}>{@render inner()}</div>{/if}
</dialog>

<style>
  dialog { width: min(560px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); padding: 0; }
  .body { display: flex; flex-direction: column; gap: 12px; padding: 16px; }
  h2 { margin: 0; font-size: 16px; font-weight: 600; }
  .body :global(.note) { margin: 0; color: var(--dim); font-size: 13px; white-space: pre-line; }
  .body :global(.note a) { color: var(--accent); }
  .body :global(label:not(.check)) { display: flex; flex-direction: column; gap: 4px; color: var(--dim); font-size: 12px; }
  .body :global(.error) { display: flex; flex-direction: column; gap: 6px; margin: 0; color: #ff8f8f; white-space: pre-wrap; }
  .body :global(.choices) { display: flex; flex-direction: column; gap: 8px; }
  .body :global(.choice b) { display: flex; align-items: center; gap: 8px; }
  .body :global(.rows) { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .body :global(.rows > li) { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); }
  .body :global(.rows > li.none) { color: var(--dim); }
  .body :global(.rows .what) { flex: 1; min-width: 200px; display: flex; flex-direction: column; }
  .body :global(.rows .meta) { color: var(--dim); font-size: 12px; }
  .body :global(.rows .warn) { color: #ffb36b; }
  .body :global(.rows button) { white-space: nowrap; display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line); border-radius: 6px; padding: 3px 10px; }
  .buttons { display: flex; align-items: center; gap: 8px; }
  .buttons :global(.grow) { flex: 1; }
  .buttons :global(button) { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line); border-radius: 6px; padding: 4px 12px; background: var(--bg); }
  .body :global(button.primary) { background: #24406b; border-color: #3b6db3; color: #fff; }
  .body :global(button.primary:disabled) { background: transparent; border-color: var(--line); color: var(--text); }
</style>
