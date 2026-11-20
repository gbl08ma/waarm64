<!--
  A pane of code (the introduction's deep dives): a title and a line under it, then the code in a sunk well, monospace,
  a row a line. A row may belong to a `group` (a number): the rows of the `active` group are lit, the first of them
  scrolled into the pane's view, and the pointer over a row or a click on it picks its group (`onpick`). Items that
  are folds (code-pane.ts) show their label as a button that unfolds their rows in place. The pane keeps a height and
  scrolls inside it, both ways; a narrow window scrolls the long lines, it doesn't wrap them (code is read by column).
-->
<script lang="ts">
  import { isFold, type CodeItem, type CodeRow } from './code-pane.ts';

  type Props = {
    title: string;
    sub?: string;
    items: CodeItem[];
    active?: number;
    onpick?: (group: number) => void;
    [attr: string]: unknown;
  };
  let { title, sub, items, active, onpick, ...rest }: Props = $props();

  /** The folds opened, by their place in `items`. A new list starts folded. */
  let open = $state<Record<number, boolean>>({});
  $effect(() => {
    void items;
    open = {};
  });

  let well = $state<HTMLElement>();
  /** The rows lit by one change of the active group; the topmost is brought into view once they're all known. */
  let lit: HTMLElement[] = [];
  function showFirst() {
    const first = lit.reduce<HTMLElement | undefined>((a, b) => (a && a.offsetTop <= b.offsetTop ? a : b), undefined);
    lit = [];
    if (!first || !well) return;
    const top = first.offsetTop - well.offsetTop;
    if (top < well.scrollTop || top > well.scrollTop + well.clientHeight - first.offsetHeight * 3)
      well.scrollTo({ top: Math.max(0, top - well.clientHeight / 3), behavior: 'smooth' });
  }
  /** A row that becomes lit asks for the well's view (the page itself doesn't scroll). */
  function reveal(row: HTMLElement, on: boolean) {
    const show = (now: boolean) => {
      if (!now) return;
      if (!lit.length) queueMicrotask(showFirst);
      lit.push(row);
    };
    show(on);
    return { update: show };
  }
</script>

{#snippet line(r: CodeRow)}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions (the pointer's shortcut: the stepper beside the panes picks an instruction from the keyboard) -->
  <div
    class={['row', { lit: r.group !== undefined && r.group === active, gap: r.gap, grouped: r.group !== undefined }]}
    use:reveal={r.group !== undefined && r.group === active}
    onpointerenter={() => r.group !== undefined && onpick?.(r.group)}
    onclick={() => r.group !== undefined && onpick?.(r.group)}
  >
    {#if r.gutter !== undefined}<span class="gutter">{r.gutter}</span>{/if}<span class="text">{r.text}</span>
  </div>
{/snippet}

<section class="pane" {...rest}>
  <header>
    <h4>{title}</h4>
    {#if sub}<span>{sub}</span>{/if}
  </header>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex (a region that scrolls takes the focus, so the keyboard can scroll it) -->
  <div class="well" bind:this={well} tabindex="0" role="group" aria-label={title}>
    {#each items as item, i (i)}
      {#if isFold(item)}
        <button
          class={['fold', { lit: item.group !== undefined && item.group === active }]}
          aria-expanded={!!open[i]}
          onclick={() => (open[i] = !open[i])}>{item.label}</button
        >
        {#if open[i]}
          {#each item.rows as r, j (j)}{@render line(r)}{/each}
        {/if}
      {:else}
        {@render line(item)}
      {/if}
    {/each}
  </div>
</section>

<style>
  .pane {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface-raised);
    box-shadow: var(--card-edge);
  }
  header {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-1) var(--space-4);
    padding: var(--space-3) var(--space-4);
    border-bottom: 1px solid var(--border);
    color: var(--text-dim);
    font-size: var(--text-xs);
  }
  h4 {
    margin: 0;
    color: var(--text);
    font-size: var(--text-sm);
    font-weight: var(--weight-bold);
    letter-spacing: var(--label-tracking);
    text-transform: uppercase;
  }
  .well {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: var(--space-3) 0;
    background: var(--well-bg);
    box-shadow: var(--well-edge);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    line-height: 1.55;
    outline: none;
  }
  .well:focus-visible {
    box-shadow: var(--shadow-focus);
  }
  .row {
    display: flex;
    gap: var(--space-4);
    width: max-content;
    min-width: 100%;
    padding: 0 var(--space-4);
    color: var(--text-dim);
    white-space: pre;
  }
  .grouped {
    color: var(--text);
    cursor: default;
  }
  .gap {
    margin-top: var(--space-4);
  }
  .gutter {
    color: var(--text-dim);
    opacity: 0.7;
    user-select: none;
  }
  /* The active instruction's lines: lit, a rail at their start. */
  .lit {
    background: var(--code-lit-bg);
    box-shadow: inset 3px 0 0 var(--accent);
    color: var(--code-lit-fg);
  }
  .lit .gutter {
    color: var(--accent);
    opacity: 1;
  }
  /* A fold's label: a line of the pane that isn't code, in the page's face. */
  .fold {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    width: 100%;
    padding: var(--space-1) var(--space-4);
    color: var(--text-dim);
    font-family: var(--font);
    font-size: var(--text-xs);
    text-align: left;
  }
  .fold::before {
    content: '';
    width: 12px;
    height: 12px;
    background: currentColor;
    mask: var(--chevron) center / 12px no-repeat;
    transform: rotate(-90deg);
    transition: transform var(--motion-fast) var(--ease);
  }
  .fold[aria-expanded='true']::before {
    transform: none;
  }
  .fold.lit {
    color: var(--accent);
  }
</style>
