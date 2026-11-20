<!--
  A figure on the introduction, as a panel's readout shows one: the number in a sunk window, what it counts under it,
  and a sentence that says what stands behind it.
-->
<script lang="ts">
  type Props = { figure: string; counts: string; words: string };
  let { figure, counts, words }: Props = $props();
</script>

<div class="readout">
  <div class="window"><span class="figure">{figure}</span></div>
  <div class="counts">{counts}</div>
  <p>{words}</p>
</div>

<style>
  .readout {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    min-width: 0;
  }
  /* The readout's window: a well, its digits lit. */
  .window {
    display: flex;
    align-items: baseline;
    padding: var(--space-4) var(--space-5);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--well-bg);
    box-shadow: var(--well-edge);
  }
  .figure {
    color: var(--accent);
    font-family: var(--font-mono);
    font-size: var(--text-display);
    font-variant-numeric: tabular-nums;
    line-height: var(--line-height-tight);
    text-shadow: var(--lit-text);
    white-space: nowrap;
  }
  .counts {
    font-size: var(--text-lg);
    font-weight: var(--weight-bold);
  }
  p {
    margin: 0;
    color: var(--text-dim);
  }
</style>
