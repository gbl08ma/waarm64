<!--
  One pane on the right of the Machines page (docs/frontend.md "The Machines page"): a machine, the browser's Disks,
  Shared folders and Connections, Preferences, About. The frame every pane shares, so they can't drift apart: the head
  (the title, its small line, the pane's buttons on the right), the tabs under it when it has some, and the body.
  The title sits at the same place whether or not the head has buttons (its line is a button's height), and the body
  starts at the same place under a head of one line. A pane's content keeps its own styles; the head's buttons and the
  tabs are styled here.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icon from './Icon.svelte';
  import type { IconName } from './icons.ts';

  type Tab<T extends string> = { id: T; icon: IconName; label: string };
  type Props = {
    /** What the pane shows (`data-selected`: a machine's id, `disks`, `about`…). */
    id: string;
    title: string;
    /** The small line beside the title. */
    meta?: string;
    /** Attributes of the small line (a test's `data-` hook). */
    metaAttrs?: Record<string, string>;
    /** The head's buttons, on the right. */
    actions?: Snippet;
    /** The tabs under the head, and the one chosen. */
    tabs?: Tab<string>[];
    tab?: string;
    ontab?: (id: string) => void;
    children: Snippet;
  };
  let { id, title, meta, metaAttrs, actions, tabs, tab, ontab, children }: Props = $props();
</script>

<section class="machine" data-selected={id}>
  <div class="head">
    <span class="title"
      ><h3>{title}</h3>
      {#if meta !== undefined}<span class="meta" {...metaAttrs}>{meta}</span>{/if}</span
    >
    {#if actions}{@render actions()}{/if}
  </div>
  {#if tabs}
    <div class="tabs" role="tablist">
      {#each tabs as x (x.id)}
        <button role="tab" aria-selected={x.id === tab} onclick={() => ontab?.(x.id)} data-tab={x.id}
          ><Icon name={x.icon} size={16} />{x.label}</button
        >
      {/each}
    </div>
  {/if}
  <div class="tab">{@render children()}</div>
</section>

<style>
  section {
    --row: 28px;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: auto;
  }
  /* Top-aligned: a title that wraps keeps its first line level with the buttons, and the title's padding centers that
     line in a button's height, so a head without buttons puts the title where one with them does. */
  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 6px 10px;
    padding: 12px 16px 8px;
  }
  /* The title takes the line's room, so a long small line wraps under it and the buttons stay beside it (they go
     under it only when the pane is too narrow for both). */
  .title {
    flex: 1 1 20em;
    min-width: 0;
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 2px 10px;
    padding-block: calc((var(--row) - 22px) / 2);
  }
  h3 {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    line-height: 22px;
  }
  .meta {
    color: var(--dim);
    font-size: 12px;
  }
  .head > :global(button) {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: var(--row);
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 3px 10px;
  }
  .tabs {
    flex: none;
    display: flex;
    gap: 2px;
    padding: 0 16px;
    box-shadow: inset 0 -1px var(--line);
    overflow-x: auto;
    scrollbar-width: none;
  }
  .tabs button {
    flex: none;
    white-space: nowrap;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 7px 14px;
    border-radius: 6px 6px 0 0;
    border: 1px solid transparent;
    border-bottom: 0;
    color: var(--dim);
  }
  .tabs button[aria-selected='true'] {
    color: var(--text);
    background: var(--bg);
    border-color: var(--line);
    border-bottom: 1px solid var(--bg);
  }
  .tab {
    padding: 16px;
  }
</style>
