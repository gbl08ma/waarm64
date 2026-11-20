<!--
  A section of the introduction (web/app/IntroPage.svelte): its title, a paragraph that says what it's about, and its
  parts under them, in the page's column. `id` names its heading (the bar's links scroll to the section's element,
  which the page binds through `ref`). `ground`: `raised` sets it a step off the page's ground, a seam at its top.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  type Props = {
    id: string;
    title: string;
    lede?: Snippet;
    children: Snippet;
    ground?: 'page' | 'raised';
    ref?: HTMLElement;
  };
  let { id, title, lede, children, ground = 'page', ref = $bindable() }: Props = $props();
</script>

<section bind:this={ref} class={ground} aria-labelledby={id} data-section={id}>
  <div class="column">
    <h2 {id}>{title}</h2>
    {#if lede}<p class="lede">{@render lede()}</p>{/if}
    {@render children()}
  </div>
</section>

<style>
  section {
    padding: var(--space-8) var(--space-6);
    /* The bar stays over the page: a section scrolled to starts under it. */
    scroll-margin-top: var(--tool-h);
  }
  .raised {
    border-top: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
    background: var(--surface-raised);
    box-shadow: var(--card-edge);
  }
  .column {
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
    max-width: 1240px;
    margin: 0 auto;
  }
  h2 {
    margin: 0;
    font-size: var(--text-title);
    line-height: var(--line-height-tight);
  }
  .lede {
    margin: 0;
    max-width: 720px;
    color: var(--text-dim);
    font-size: var(--text-lg);
  }
  @media (max-width: 900px) {
    section {
      padding: var(--space-7) var(--space-5);
    }
  }
</style>
