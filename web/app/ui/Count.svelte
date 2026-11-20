<!--
  How many of something a tab or a list's button leads to (a machine's disks, the browser's connections): the number
  in a small pill, a counter's window sunk into the panel, after the button's words. For the eye only: the button's
  accessible name says the count in words (`aria-label`: "Disks (3)").
-->
<script lang="ts">
  let { n }: { n: number } = $props();
</script>

<span class="count" aria-hidden="true">{n}</span>

<style>
  .count {
    flex: none;
    display: inline-grid;
    place-content: center;
    min-width: 18px;
    height: 18px;
    padding: 0 var(--space-2);
    border-radius: 999px;
    background: var(--count-bg, var(--well-bg));
    box-shadow: var(--well-edge);
    color: var(--text-dim);
    font-size: var(--text-xs);
    font-weight: var(--weight-bold);
    font-variant-numeric: tabular-nums;
    line-height: 1;
  }
</style>
