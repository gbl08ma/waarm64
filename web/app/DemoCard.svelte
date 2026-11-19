<!--
  A demo's card on the demo store's page (DemosPage.svelte; docs/frontend.md "The demo store"): a button, reached by
  the keyboard, with its thumbnail (decorative: the button's name is the demo's), name, summary and download size, and whether the
  visitor has it or an older version of it. Its words are the store's data, drawn as plain text, never as messages.
-->
<script lang="ts">
  import Note from './ui/Note.svelte';
  import type { StoreDemo } from './demo-store.ts';
  import { t } from '../i18n.ts';

  type Props = {
    demo: StoreDemo;
    /** The visitor has a machine from it (`mine`), or from a version it replaces (`older`). */
    mark?: 'mine' | 'older';
    onopen: () => void;
    /** Takes the focus (the card the visitor came back from: All demos). */
    focused?: boolean;
  };
  let { demo, mark, onopen, focused = false }: Props = $props();
  let button = $state<HTMLButtonElement>();
  $effect(() => {
    if (focused) button?.focus();
  });
  const d = $derived(demo.def.demo);
  const name = $derived(demo.def.machine.name);
  const MARKS = { mine: 'machines:DemoCard.mine', older: 'machines:DemoCard.older' } as const;
</script>

<button class="card" onclick={onopen} data-demo={d.id} bind:this={button}>
  {#if d.thumbnail}
    <img src={d.thumbnail} alt="" crossorigin="anonymous" loading="lazy" />
  {/if}
  <span class="name">{name}</span>
  <span class="summary">{d.summary}</span>
  <Note inline>{t('machines:DemoCard.download', { size: d.download })}</Note>
  {#if mark}<Note inline tone="ok" data-mark={mark}>{t(MARKS[mark])}</Note>{/if}
</button>

<style>
  .card {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-2);
    width: 100%;
    height: 100%;
    padding: var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface-raised);
    text-align: start;
  }
  .card:hover {
    background: var(--hover-bg);
  }
  .card:focus-visible {
    box-shadow: var(--shadow-focus);
    outline: none;
  }
  img {
    width: 100%;
    aspect-ratio: 16 / 10;
    object-fit: cover;
    border-radius: var(--radius);
    background: var(--screen-bg);
  }
  .name {
    font-size: var(--text-lg);
    font-weight: var(--weight-bold);
  }
  .summary {
    color: var(--text);
    white-space: pre-line;
  }
</style>
