<!--
  waarm64's logo, drawn large (About.svelte): the page's icon (index.html: a lit w on a key of the panel, steam over
  it), the same shapes with the panel's tokens for its colors. `size` in px.
-->
<script lang="ts">
  let { size = 200, label }: { size?: number; label: string } = $props();
</script>

<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width={size} height={size} role="img" aria-label={label}>
  <rect class="key" width="16" height="16" rx="2" />
  <path class="w" shape-rendering="crispEdges" d="M3 7h2v5h2V7h2v5h2V7h2v7H3z" />
  <path class="steam" d="M6 5.6C7.6 4 4.4 2.5 6 .9M10 5.6C8.4 4 11.6 2.5 10 .9" />
</svg>

<style>
  svg {
    display: block;
    flex: none;
  }
  .key {
    fill: var(--surface-bar);
  }
  .w {
    fill: var(--accent);
  }
  .steam {
    fill: none;
    stroke: var(--text-dim);
    stroke-width: 1.1;
    stroke-linecap: round;
  }
</style>
