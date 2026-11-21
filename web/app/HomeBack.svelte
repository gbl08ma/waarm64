<!--
  The Home page's Back (docs/frontend.md "The Home page"): the first entry of its left column at every level, ruled off
  from the entries under it. At the root it leads to the machine (MachinesNav.svelte, while one is on the page); in a
  context, to where the user came from (ConnectionNav.svelte). Esc does the same (MachinesPage.svelte).
-->
<script lang="ts">
  import Icon from './ui/Icon.svelte';
  import T from './T.svelte';
  import type { Msg } from '../i18n.ts';

  type Props = { words: Msg; onclick: () => void; [attr: `data-${string}`]: string | undefined };
  let { words, onclick, ...rest }: Props = $props();
</script>

<div class="back">
  <button {onclick} {...rest}><Icon name="arrow-left" size={16} /><span><T m={words} /></span></button>
</div>

<style>
  .back {
    padding-bottom: var(--space-3);
    border-bottom: 1px solid var(--border);
  }
  button {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    width: 100%;
    padding: var(--space-2) var(--space-4);
    border-radius: var(--radius-sm);
    text-align: start;
  }
</style>
