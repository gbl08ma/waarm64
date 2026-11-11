<!--
  The on-screen keyboard's bar (Osk.svelte): its title, the compact layout's pages as tabs, the button that switches
  layout, the grip that resizes it, Close. Dragged, it moves the keyboard (osk-frame.svelte.ts).
-->
<script lang="ts">
  import Icon from './ui/Icon.svelte';
  import { t } from '../i18n.ts';
  import type { OskFrame } from './osk-frame.svelte.ts';

  type Props = {
    frame: OskFrame;
    /** The compact layout's pages (their ids), and the one shown. */
    pages: { id: string }[];
    page: string;
    onswitch: () => void;
    onclose: () => void;
  };
  let { frame, pages, page = $bindable(), onswitch, onclose }: Props = $props();

  /** The compact layout's tabs: their words and tooltips. */
  const PAGE_WORDS: Record<string, [string, string]> = {
    main: [t('osk:OskBar.page.main'), t('osk:OskBar.pageTitle.main')],
    symbols: [t('osk:OskBar.page.symbols'), t('osk:OskBar.pageTitle.symbols')],
    fn: [t('osk:OskBar.page.fn'), t('osk:OskBar.pageTitle.fn')],
    keypad: [t('osk:OskBar.page.keypad'), t('osk:OskBar.pageTitle.keypad')],
  };
  const px = (n: number) => `${n}px`;
  const compact = $derived(frame.layout === 'compact');
  const switchWords = $derived(compact ? t('osk:OskBar.toFull') : t('osk:OskBar.toCompact'));
</script>

<!-- Dragged with a pointer only: the keyboard never takes the focus (Osk.svelte). -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class={['bar', { compact }]}
  style:height={px(frame.dims.bar)}
  onpointerdown={(e) => frame.grab('move', e)}
  onpointermove={frame.move}
  onpointerup={frame.end}
  onpointercancel={frame.end}
>
  <span class="title">{t('osk:OskBar.title')}</span>
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
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="grip"
    title={t('osk:OskBar.resize')}
    onpointerdown={(e) => {
      e.stopPropagation();
      frame.grab('size', e);
    }}
    onpointermove={frame.move}
    onpointerup={frame.end}
    onpointercancel={frame.end}
  >
    <Icon name="arrows-horizontal" size={14} />
  </div>
  <button class="close" aria-label={t('osk:OskBar.close')} title={t('osk:OskBar.close')} onclick={onclose}>
    <Icon name="x" size={14} />
  </button>
</div>

<style>
  /* The bar is a container: when it's too narrow for the title beside the compact layout's tabs, the title goes. */
  .bar {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    cursor: move;
    color: var(--text-dim);
    font-size: var(--text-sm);
    padding-left: var(--space-2);
    container-type: inline-size;
  }
  .title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  @container (max-width: 420px) {
    .compact .title {
      display: none;
    }
  }
  @container (max-width: 160px) {
    .title {
      display: none;
    }
  }
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
  .grip {
    display: grid;
    place-items: center;
    width: 28px;
    height: 20px;
    margin-right: var(--space-1);
    border-radius: var(--radius-sm);
    cursor: ew-resize;
    touch-action: none;
  }
  .grip:hover {
    background: var(--hover-bg);
    color: var(--text);
  }
  .close {
    display: grid;
    place-items: center;
    width: 22px;
    height: 20px;
    padding: 0;
    color: var(--text-dim);
    background: none;
    border: 0;
    border-radius: var(--radius-sm);
    cursor: pointer;
  }
  .close:hover {
    background: var(--hover-bg);
    color: var(--text);
  }
</style>
