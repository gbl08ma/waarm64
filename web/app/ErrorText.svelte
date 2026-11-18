<!--
  An error's words as the page shows them in a note or a box (usb-problems.ts `ErrorView`): its headline and its
  causes, a line each, a message's names and the page's elements drawn as T.svelte draws them, and a developer's text
  (an exception's own words: `'raw'`) as code. Its parent keeps the lines (`white-space: pre-line`, as `Note` does).
-->
<script lang="ts">
  import T from './T.svelte';
  import type { ErrorView } from './usb-problems.ts';

  type Props = { error: ErrorView };
  let { error }: Props = $props();
  /** A line break between lines (the parent keeps it: `pre-line`, `pre-wrap`). */
  const NL = '\n';
  const lines = $derived(
    error.said
      ? [error.said.headline, ...error.said.details].map((text, i) => ({ text, from: error.said?.from?.[i] }))
      : [{ text: error.text, from: undefined }],
  );
</script>

{#each lines as l, i (i)}{#if i}{NL}{/if}{#if l.from === 'raw'}<code>{l.text}</code>{:else if l.from}<T
      m={l.from}
    />{:else}{l.text}{/if}{/each}
