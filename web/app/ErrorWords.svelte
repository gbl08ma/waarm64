<!--
  An action's error as the page shows it (actions.svelte.ts, usb-problems.ts `errorView`): its words, a line each, and a
  USB attach's problems with their remedies folded (UsbProblems.svelte). A block: it goes in a bar or a box, not in a
  `Note` (a paragraph); where no problems can come, a `<Note tone="error">` of `error.text` says the same.
-->
<script lang="ts">
  import ErrorText from './ErrorText.svelte';
  import UsbProblems from './UsbProblems.svelte';
  import type { ErrorView } from './usb-problems.ts';

  type Props = { error: ErrorView };
  let { error }: Props = $props();
</script>

<div class="words"><ErrorText {error} /></div>
{#if error.words}<UsbProblems words={error.words} />{/if}

<style>
  .words {
    white-space: pre-line;
  }
</style>
