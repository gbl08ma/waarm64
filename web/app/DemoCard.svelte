<!--
  A demo's row in the demo store's list (DemosPage.svelte; docs/frontend.md "The demo store"): a button, reached by
  the keyboard, with its thumbnail (decorative: the button's name is the demo's), name, summary (its first lines beside
  the chosen demo's pane, which has it whole) and download size, and whether the visitor has it or an older version of
  it. The chosen one (`chosen`: its pane shows) is sunk with the lit rail, as Home's chosen machine. Its words are the
  store's data, drawn as plain text, never as messages.
-->
<script lang="ts">
  import Note from './ui/Note.svelte';
  import type { StoreDemo } from './demo-store.ts';
  import { t } from '../i18n.ts';

  type Props = {
    demo: StoreDemo;
    /** The visitor has a machine from it (`mine`), or from a version it replaces (`older`). */
    mark?: 'mine' | 'older';
    /** Its pane shows beside the list. */
    chosen?: boolean;
    onopen: () => void;
    /** Takes the focus (the row the visitor came back to: All demos). */
    focused?: boolean;
  };
  let { demo, mark, chosen = false, onopen, focused = false }: Props = $props();
  let button = $state<HTMLButtonElement>();
  $effect(() => {
    if (focused) button?.focus();
  });
  const d = $derived(demo.def.demo);
  const name = $derived(demo.def.machine.name);
  const MARKS = { mine: 'machines:DemoCard.mine', older: 'machines:DemoCard.older' } as const;
</script>

<button class="card" class:chosen onclick={onopen} data-demo={d.id} aria-current={chosen} bind:this={button}>
  {#if d.thumbnail}
    <img src={d.thumbnail} alt="" crossorigin="anonymous" loading="lazy" />
  {/if}
  <span class="words">
    <span class="name">{name}</span>
    <span class="summary">{d.summary}</span>
    <Note inline>{t('machines:DemoCard.download', { size: d.download })}</Note>
    {#if mark}<Note inline tone="ok" data-mark={mark}>{t(MARKS[mark])}</Note>{/if}
  </span>
</button>

<style>
  .card {
    display: flex;
    align-items: flex-start;
    gap: var(--space-4);
    width: 100%;
    padding: var(--space-3);
    border-radius: var(--radius-sm);
    text-align: start;
  }
  .card:hover {
    background: var(--hover-bg);
  }
  .card.chosen {
    background: var(--pressed-bg);
    box-shadow: var(--chosen-edge);
  }
  .card:focus-visible {
    box-shadow: var(--shadow-focus);
    outline: none;
  }
  img {
    flex: none;
    width: 96px;
    aspect-ratio: 16 / 10;
    object-fit: cover;
    border-radius: var(--radius-sm);
    background: var(--screen-bg);
    box-shadow: var(--shadow-frame);
  }
  .words {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .name {
    font-weight: var(--weight-bold);
  }
  /* Its first lines: the pane beside the list has the whole of it. */
  .summary {
    display: -webkit-box;
    overflow: hidden;
    color: var(--text-dim);
    font-size: var(--text-md);
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
  }
  /* One column: the list is all there is of a demo until it's chosen, so its summary is whole. */
  @media (max-width: 720px) {
    .summary {
      display: block;
    }
  }
</style>
