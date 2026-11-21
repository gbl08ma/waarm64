<!--
  One pane on the right of the Home page (docs/frontend.md "The Home page"): a machine, the browser's Disks,
  Shared folders and Connections, Preferences, About; and the chosen demo's on the demo store's page (DemoStart.svelte).
  The frame every pane shares, so they can't drift apart: the head
  (the title, its small line, the pane's buttons on the right), the tabs under it when it has some, and the body.
  The title sits at the same place whether or not the head has buttons (its line is a button's height), and the body
  starts at the same place under a head of one line. A pane's content keeps its own styles; the head's buttons and the
  tabs are styled here.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import Count from './Count.svelte';
  import Icon from './Icon.svelte';
  import T from '../T.svelte';
  import type { IconName } from '../icons.ts';
  import { isMsg, type Msg } from '../../msg.ts';

  /** A tab: its words, and how many it holds when it counts them (`count` in a pill, `name` the tab's name with the
   *  count in words). */
  type Tab<K extends string> = { id: K; icon: IconName; label: string; count?: number; name?: string };
  type Props = {
    /** What the pane shows (`data-selected`: a machine's id, `disks`, `about`…). */
    id: string;
    title: string;
    /** The small line beside the title (a message is drawn with its markers: T.svelte). */
    meta?: string | Msg;
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
      {#if isMsg(meta)}<span class="meta" {...metaAttrs}><T m={meta} /></span>{:else if meta !== undefined}<span
          class="meta"
          {...metaAttrs}>{meta}</span
        >{/if}</span
    >
    {#if actions}{@render actions()}{/if}
  </div>
  {#if tabs}
    <div class="tabs" role="tablist">
      {#each tabs as x (x.id)}
        <button
          role="tab"
          aria-selected={x.id === tab}
          aria-label={x.name}
          onclick={() => ontab?.(x.id)}
          data-tab={x.id}
          ><Icon name={x.icon} size={16} />{x.label}{#if x.count !== undefined}<Count n={x.count} />{/if}</button
        >
      {/each}
    </div>
  {/if}
  <div class="tab">{@render children()}</div>
</section>

<style>
  section {
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
    gap: var(--space-3) var(--space-4);
    padding: var(--space-4) var(--space-5) var(--space-3);
    /* A pane whose content keeps a column's width (`--pane-width`: the demo's) keeps its head to it too, so the head's
       buttons end where the content does and not at the window's far edge. */
    box-sizing: border-box;
    width: 100%;
    max-width: calc(var(--pane-width, 100%) + 2 * var(--space-5));
  }
  /* The title takes the line's room, so a long small line wraps under it and the buttons stay beside it (they go
     under it only when the pane is too narrow for both). */
  .title {
    flex: 1 1 20em;
    min-width: 0;
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-1) var(--space-4);
    padding-block: calc((var(--control-h) - 22px) / 2);
  }
  h3 {
    margin: 0;
    font-size: var(--text-lg);
    font-weight: var(--weight-bold);
    line-height: 22px;
  }
  /* Its line is shorter than the title's, so a head with a small line is as tall as one without (About's has none). */
  .meta {
    color: var(--text-dim);
    font-size: var(--text-sm);
    line-height: 18px;
  }
  .tabs {
    flex: none;
    display: flex;
    gap: var(--space-1);
    padding: 0 var(--space-5);
    box-shadow: var(--shadow-rule);
    overflow-x: auto;
    scrollbar-width: none;
  }
  .tabs button {
    flex: none;
    white-space: nowrap;
    display: inline-flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-5);
    border-radius: var(--radius) var(--radius) 0 0;
    border: 1px solid transparent;
    border-bottom: 0;
    color: var(--text-dim);
  }
  .tabs button[aria-selected='true'] {
    color: var(--text);
    background: var(--surface);
    border-color: var(--border);
    border-bottom: 1px solid var(--surface);
  }
  .tab {
    padding: var(--space-5);
  }
</style>
