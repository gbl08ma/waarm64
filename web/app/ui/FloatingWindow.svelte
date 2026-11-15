<!--
  A window floating over the page (a disk's surface, the on-screen keyboard): a title bar that moves it, with the title,
  the caller's controls (`head`) and Close; the caller's content under it (`children`, given the window's size, in a
  column that fills the window: a child that should fill the rest takes `flex: 1` in its own wrapper); a grip that
  resizes it. Kept in the browser's window (when that shrinks too), and its place and size remembered under `place` (a
  key of settings.ts `windows`), `size` the first time (where `at` says, else centred); never smaller than `min` unless
  the window is (floating-frame.svelte.ts).
  - Its size is free by default, the grip at the bottom right corner. With `aspect` (its height for a width) the height
    follows the width, and the grip is a ↔ in the bar, left of Close. `sizeKey` names the shape it has now: a window
    whose shape changes (the keyboard's layouts) keeps a size for each.
  - A click on it doesn't take the keyboard's focus from where it is (the machine's screen keeps it): only form
    controls in it (a select, a field) take it, as they must to be used; the rest is reached with Tab. A `tool` window
    (the keyboard) is a tool's: a slim bar (`barHeight` tall, the title small and dim), the window a little see-through
    and its content 8 px in (`TOOL_PAD`); nothing in it takes the focus, selects text or opens the context menu.
  - Narrower than `titleMin`, the bar leaves its title out (still the window's name) for the caller's controls; `ref`
    binds the window's element; `data-*` go on it.
-->
<script lang="ts">
  import { untrack, type Snippet } from 'svelte';
  import Button from './Button.svelte';
  import Icon from './Icon.svelte';
  import { FloatingFrame, type Point, type Size } from './floating-frame.svelte.ts';
  import { t } from '../../i18n.ts';

  type Props = {
    /** The window's id (a test's hook). */
    id?: string;
    /** The settings key its place is remembered under. */
    place: string;
    title: string;
    titleMin?: number;
    min?: Size;
    size?: Size;
    aspect?: (w: number) => number;
    sizeKey?: string;
    at?: (s: Size) => Point;
    tool?: boolean;
    barHeight?: number;
    head?: Snippet;
    children: Snippet<[Size]>;
    onclose: () => void;
    ref?: HTMLElement;
    [data: `data-${string}`]: string | undefined;
  };
  let {
    id,
    place,
    title,
    titleMin = 0,
    min = { w: 280, h: 160 },
    size = { w: 560, h: 400 },
    aspect,
    sizeKey,
    at,
    tool = false,
    barHeight,
    head,
    children,
    onclose,
    ref = $bindable(),
    ...data
  }: Props = $props();

  const titleId = $props.id();
  // The place is read once, when it opens (a new key is a new window); the shape as it changes.
  // svelte-ignore state_referenced_locally
  const frame = new FloatingFrame(place, () => ({ min, size, aspect, sizeKey, at }));
  const px = (n: number | undefined) => (n === undefined ? undefined : `${String(n)}px`);
  // Kept in the window when it opens and in each new shape (the keyboard's compact layout is taller for its width).
  $effect(() => {
    // eslint-disable-next-line @typescript-eslint/no-meaningless-void-operator -- read to track it (the effect's dependency)
    void frame.sizeKey;
    untrack(() => frame.clamp());
  });

  /** Form controls take the focus when clicked, as they must; nothing else in the window does (a tool's: nothing). */
  function keepFocus(e: MouseEvent) {
    if (tool || !(e.target instanceof Element && e.target.closest('input, select, textarea, [contenteditable]')))
      e.preventDefault();
  }
  const noMenu = (e: MouseEvent) => {
    if (tool) e.preventDefault();
  };
  const titleShown = $derived(frame.w > titleMin);
  const words = $derived(aspect ? t('common:FloatingWindow.resizeWidth') : t('common:FloatingWindow.resize'));
</script>

<svelte:window onresize={frame.fit} />

<div
  {id}
  {...data}
  bind:this={ref}
  class={['window', { tool }]}
  role="dialog"
  tabindex="-1"
  aria-labelledby={titleId}
  style:left={px(frame.x)}
  style:top={px(frame.y)}
  style:width={px(frame.w)}
  style:height={px(frame.h)}
  onmousedown={keepFocus}
  oncontextmenu={noMenu}
>
  <!-- Dragged with a pointer only. -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="bar"
    style:height={px(barHeight)}
    onpointerdown={(e) => frame.grab('move', e)}
    onpointermove={frame.move}
    onpointerup={frame.end}
    onpointercancel={frame.end}
  >
    <span class={['title', { hidden: !titleShown }]} id={titleId}>{title}</span>
    {#if head}<div class={['head', { fill: !titleShown }]}>{@render head()}</div>{/if}
    {#if aspect}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="grip sideways"
        title={words}
        onpointerdown={(e) => frame.grab('size', e)}
        onpointermove={frame.move}
        onpointerup={frame.end}
        onpointercancel={frame.end}
      >
        <Icon name="arrows-horizontal" size={14} />
      </div>
    {/if}
    <Button
      variant={tool ? 'inline' : 'plain'}
      icon="x"
      iconSize={tool ? 14 : 16}
      data-action="close"
      aria-label={t('common:FloatingWindow.close')}
      title={t('common:FloatingWindow.close')}
      onclick={onclose}
    />
  </div>
  <div class="body">{@render children({ w: frame.w, h: frame.h })}</div>
  {#if !aspect}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="grip corner"
      title={words}
      onpointerdown={(e) => frame.grab('size', e)}
      onpointermove={frame.move}
      onpointerup={frame.end}
      onpointercancel={frame.end}
    ></div>
  {/if}
</div>

<style>
  .window {
    position: fixed;
    z-index: 1;
    display: flex;
    flex-direction: column;
    background: var(--surface-raised);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-menu);
    overflow: hidden;
  }
  /* A tool's: see-through a little, its content 8 px in (TOOL_PAD) (no top padding: the bar), nothing selected or scrolled. */
  .window.tool {
    padding: 0 var(--space-3) var(--space-3);
    background: color-mix(in srgb, var(--surface-raised) 92%, transparent);
    overflow: visible;
    user-select: none;
    -webkit-user-select: none;
    touch-action: none;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex: none;
    padding: var(--space-1) var(--space-1) var(--space-1) var(--space-4);
    background: var(--surface-bar);
    box-shadow: var(--shadow-rule);
    cursor: move;
    user-select: none;
    -webkit-user-select: none;
    touch-action: none;
  }
  .tool .bar {
    gap: var(--space-1);
    padding: 0 0 0 var(--space-2);
    background: none;
    box-shadow: none;
    color: var(--text-dim);
    font-size: var(--text-sm);
  }
  .title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-size: var(--text-md);
    font-weight: var(--weight-bold);
  }
  .tool .title {
    font-size: inherit;
    font-weight: normal;
  }
  .title.hidden {
    display: none;
  }
  .head {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-width: 0;
    cursor: auto;
  }
  .tool .head {
    gap: var(--space-1);
    height: 100%;
  }
  .head.fill {
    flex: 1;
  }
  .body {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    flex: 1;
    min-height: 0;
    padding: var(--space-4);
  }
  .tool .body {
    padding: 0;
  }
  /* The bar's grip (a window whose height follows its width): a ↔ dragged sideways. */
  .grip.sideways {
    display: grid;
    place-items: center;
    flex: none;
    width: 28px;
    height: 20px;
    margin-right: var(--space-1);
    border-radius: var(--radius-sm);
    cursor: ew-resize;
    touch-action: none;
  }
  .grip.sideways:hover {
    background: var(--hover-bg);
    color: var(--text);
  }
  /* The corner's grip: three short diagonal strokes, as a desktop window's. */
  .grip.corner {
    position: absolute;
    right: 0;
    bottom: 0;
    width: 16px;
    height: 16px;
    cursor: nwse-resize;
    touch-action: none;
    background-image: linear-gradient(
      135deg,
      transparent 0 52%,
      var(--text-dim) 52% 58%,
      transparent 58% 68%,
      var(--text-dim) 68% 74%,
      transparent 74% 84%,
      var(--text-dim) 84% 90%,
      transparent 90%
    );
  }
</style>
