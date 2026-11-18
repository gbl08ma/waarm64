<!--
  The message bar's words (web/app/areas/message-bar.svelte.ts), in the floating bar (MessageBar.svelte) and the Home
  page's (MachinesPage.svelte): the headline, and the details under it, a line each. In the page's font: a line that is
  a developer's text (an exception's own words, from the browser or the core: `from`'s `'raw'`) is code, and a
  message's names and the page's elements are drawn as T.svelte draws them. A headline that isn't a sentence (an
  error's: "Couldn't start…") is bold, as far as its first line; one that is (a notice) is plain words.
-->
<script lang="ts">
  import T from './T.svelte';
  import { messageBar } from './areas/message-bar.svelte.ts';
  import type { Msg } from '../i18n.ts';

  const from = $derived(messageBar.from);
  /** A line break between lines (the parent keeps it: `pre-line`, `pre-wrap`). */
  const NL = '\n';
  /** The headline's first line and the rest (after its line break, if any). */
  const head = $derived.by(() => {
    const at = messageBar.text.indexOf('\n');
    return at < 0
      ? { first: messageBar.text, rest: '' }
      : { first: messageBar.text.slice(0, at), rest: messageBar.text.slice(at) };
  });
  const bold = $derived(!/[.?!:]\s*$/.test(head.first));
</script>

{#snippet line(words: string, f: Msg | 'raw' | undefined)}{#if f && f !== 'raw'}<T m={f} />{:else}{words}{/if}{/snippet}

<p id="message-text" class={{ raw: from[0] === 'raw' }}>
  {#if head.rest && from[0] === undefined}<span class={{ bold }}>{head.first}</span>{head.rest}{:else}<span
      class={{ bold }}>{@render line(messageBar.text, from[0])}</span
    >{/if}
</p>
{#if messageBar.details.length}<p id="message-details">
    {#each messageBar.details as d, i (i)}{#if i}{NL}{/if}<span class={{ raw: from[i + 1] === 'raw' }}
        >{@render line(d, from[i + 1])}</span
      >{/each}
  </p>{/if}

<style>
  p {
    margin: 0;
    white-space: pre-wrap;
    font-size: var(--text-md);
  }
  .bold {
    font-weight: var(--weight-bold);
  }
  #message-details {
    opacity: 0.85;
  }
  /* A developer's words, as they came: code. */
  .raw {
    font-family: var(--font-mono);
    font-size: var(--text-sm);
  }
</style>
