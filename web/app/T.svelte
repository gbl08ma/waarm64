<!--
  A message whose words have markers (docs/i18n.md "Markers"): `<T k="ns:Source.name" params={…}>` with a snippet per
  marker, named as the marker and given the words it wraps: `{#snippet b(text)}<b>{text}</b>{/snippet}`. A message
  without markers needs none of this: `{t('ns:Source.name')}`.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { parts, t, type Params } from '../i18n.ts';

  let { k, params, ...markers }: { k: string; params?: Params; [marker: string]: Snippet<[string]> | Params | string | undefined } = $props();
  const pieces = $derived(parts(t(k, params)));
</script>

{#each pieces as p, i (i)}{#if p.tag && typeof markers[p.tag] === 'function'}{@render (markers[p.tag] as Snippet<[string]>)(p.text)}{:else}{p.text}{/if}{/each}
