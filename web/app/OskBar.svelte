<!--
  The on-screen keyboard's controls in its bar (Osk.svelte, in its window's title bar, `head`): the compact layout's
  pages as tabs, the button that switches layout. The window's frame has the title, the grip and Close.
-->
<script lang="ts">
  import Icon from './ui/Icon.svelte';
  import { t } from '../i18n.ts';

  type Props = {
    compact: boolean;
    /** The compact layout's pages (their ids), and the one shown. */
    pages: { id: string }[];
    page: string;
    onswitch: () => void;
  };
  let { compact, pages, page = $bindable(), onswitch }: Props = $props();

  /** The compact layout's tabs: their words and tooltips. */
  const PAGE_WORDS: Record<string, [string, string]> = {
    main: [t('osk:OskBar.page.main'), t('osk:OskBar.pageTitle.main')],
    symbols: [t('osk:OskBar.page.symbols'), t('osk:OskBar.pageTitle.symbols')],
    fn: [t('osk:OskBar.page.fn'), t('osk:OskBar.pageTitle.fn')],
    keypad: [t('osk:OskBar.page.keypad'), t('osk:OskBar.pageTitle.keypad')],
  };
  const switchWords = $derived(compact ? t('osk:OskBar.toFull') : t('osk:OskBar.toCompact'));
</script>

{#if compact}
  <div class="tabs" role="tablist">
    {#each pages as p (p.id)}
      <button
        role="tab"
        data-page={p.id}
        aria-selected={page === p.id}
        title={PAGE_WORDS[p.id][1]}
        onclick={() => (page = p.id)}
      >
        {PAGE_WORDS[p.id][0]}
      </button>
    {/each}
  </div>
{/if}
<button class="layout" aria-label={switchWords} title={switchWords} onclick={onswitch}>
  <Icon name={compact ? 'keyboard' : 'device-mobile'} size={14} />
</button>

<style>
  .tabs {
    display: flex;
    gap: var(--space-1);
    height: 100%;
    padding: var(--space-1) 0;
    box-sizing: border-box;
  }
  .tabs button {
    min-width: 36px;
    padding: 0 var(--space-3);
    color: var(--text-dim);
    background: none;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    font: inherit;
    cursor: pointer;
  }
  .tabs button:hover {
    background: var(--hover-bg);
    color: var(--text);
  }
  .tabs button[aria-selected='true'] {
    color: var(--text);
    background: var(--surface-bar);
    border-color: var(--border);
  }
  .layout {
    display: grid;
    place-items: center;
    width: 26px;
    height: 20px;
    margin-left: auto;
    padding: 0;
    color: var(--text-dim);
    background: none;
    border: 0;
    border-radius: var(--radius-sm);
    cursor: pointer;
  }
  .layout:hover {
    background: var(--hover-bg);
    color: var(--text);
  }
</style>
