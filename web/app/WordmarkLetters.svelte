<!--
  The wordmark's letters (the look: docs/frontend-code.md §1 item 2): the name's two halves by weight, `wa` dim and
  medium, `arm64` in the weight and color around it. The toolbar's wordmark (Wordmark.svelte) and the introduction's bar
  draw it; whoever does says the name to a screen reader (`aria-label`).
-->
<script lang="ts">
  const WORDMARK = ['wa', 'arm64']; // i18n-ignore
</script>

<span>{WORDMARK[0]}</span>{WORDMARK[1]}

<style>
  span {
    font-weight: var(--weight-medium);
    color: var(--text-dim);
  }
</style>
