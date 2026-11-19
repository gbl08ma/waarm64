<!--
  Both's divider (docs/frontend.md "Views"): between the screen and the serial terminal, dragged or moved with the
  arrow keys, it sets the terminal's share of the room (`screen.split`), beside the screen or, in a narrow window,
  under it. Until it is moved the layout is the default one (the terminal's own width); a double click goes back to
  it. Only the user moves it: an agent's HELLO refits the terminal inside its share. Remembered per browser.
-->
<script lang="ts">
  import { remember } from './settings.ts';
  import { screen, SPLIT_MAX, SPLIT_MIN } from './areas/screen.svelte.ts';
  import { t } from '../i18n.ts';

  type Props = { main: HTMLElement | undefined };
  let { main }: Props = $props();

  /** The window's narrow layout (App.svelte's media query): the terminal under the screen. */
  const NARROW = '(max-width: 1100px)';
  let stacked = $state(matchMedia(NARROW).matches);
  $effect(() => {
    const q = matchMedia(NARROW);
    const changed = () => (stacked = q.matches);
    q.addEventListener('change', changed);
    return () => q.removeEventListener('change', changed);
  });
  const key = $derived(stacked ? 'stacked' : 'across');
  const share = $derived(screen.split[key]);
  /** A keypress's step. */
  const STEP = 0.02;

  let el = $state<HTMLElement>();
  let dragging = false;

  /** The room the two views share, along the divider's axis, without the divider: CSS pixels. */
  function room() {
    if (!main || !el) return undefined;
    const r = main.getBoundingClientRect(),
      s = getComputedStyle(main),
      d = el.getBoundingClientRect();
    return stacked
      ? {
          from: r.top + parseFloat(s.paddingTop),
          size: r.height - parseFloat(s.paddingTop) - parseFloat(s.paddingBottom) - d.height,
        }
      : {
          from: r.left + parseFloat(s.paddingLeft),
          size: r.width - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight) - d.width,
        };
  }
  /** The terminal's share now, measured (the default layout's, before the divider was moved). */
  function measured() {
    const r = room(),
      term = el?.nextElementSibling?.getBoundingClientRect(); // the terminal's view, after the divider
    if (!r || !term || r.size <= 0) return 0.5;
    return (stacked ? term.height : term.width) / r.size;
  }
  function set(v: number | undefined, save: boolean) {
    screen.split = {
      ...screen.split,
      [key]: v === undefined ? undefined : Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, v)),
    };
    if (save) remember({ split: { ...screen.split } });
  }

  function down(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    el?.setPointerCapture(e.pointerId);
    el?.focus();
    dragging = true;
  }
  function move(e: PointerEvent) {
    const r = dragging && room();
    if (!r || r.size <= 0 || !el) return;
    const d = el.getBoundingClientRect();
    // The terminal is after the divider: its share is what lies past the pointer (the divider's middle there).
    const at = (stacked ? e.clientY - d.height / 2 : e.clientX - d.width / 2) - r.from;
    set(1 - at / r.size, false);
  }
  function up(e: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    el?.releasePointerCapture(e.pointerId);
    set(screen.split[key], true);
  }
  function keydown(e: KeyboardEvent) {
    const grow = stacked ? 'ArrowUp' : 'ArrowLeft',
      shrink = stacked ? 'ArrowDown' : 'ArrowRight';
    if (e.key !== grow && e.key !== shrink) return;
    e.preventDefault();
    set((share ?? measured()) + (e.key === grow ? STEP : -STEP), true);
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions (a focusable separator is ARIA's splitter, a widget) -->
<div
  id="view-divider"
  bind:this={el}
  role="separator"
  tabindex="0"
  aria-orientation={stacked ? 'horizontal' : 'vertical'}
  aria-label={t('common:ViewDivider.label')}
  aria-valuemin={Math.round(SPLIT_MIN * 100)}
  aria-valuemax={Math.round(SPLIT_MAX * 100)}
  aria-valuenow={share === undefined ? undefined : Math.round(share * 100)}
  title={t('common:ViewDivider.title')}
  data-moved={share === undefined ? undefined : ''}
  class:stacked
  onpointerdown={down}
  onpointermove={move}
  onpointerup={up}
  onpointercancel={up}
  onkeydown={keydown}
  ondblclick={() => set(undefined, true)}
></div>

<style>
  #view-divider {
    flex: 0 0 var(--space-4);
    align-self: stretch;
    position: relative;
    cursor: col-resize;
    touch-action: none;
    outline: none;
  }
  #view-divider.stacked {
    cursor: row-resize;
  }
  /* The line: thin, in the middle of the gap it takes; clearer under the pointer, while dragged or focused. */
  #view-divider::before {
    content: '';
    position: absolute;
    inset: 0 calc(50% - 1px);
    border-radius: 1px;
    background: var(--border);
  }
  #view-divider.stacked::before {
    inset: calc(50% - 1px) 0;
  }
  #view-divider:hover::before,
  #view-divider:focus-visible::before,
  #view-divider:active::before {
    background: var(--accent);
  }
</style>
