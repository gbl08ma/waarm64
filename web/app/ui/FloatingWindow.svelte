<!--
  A window floating over the page (a disk's surface; later RAM's): a title bar that moves it, with the title, the
  caller's controls (`head`) and Close; the caller's content under it (`children`, in a column that fills the window:
  a child that should fill the rest takes `flex: 1` in its own wrapper); a grip at the bottom right corner that resizes
  it, width and height. Kept in the browser's window (when that shrinks too), and its place and size remembered under
  `place` (a key of settings.ts `windows`), `size` the first time; never smaller than `min` unless the window is.
  A click on it doesn't take the keyboard's focus from where it is (the machine's screen keeps it): only form controls
  in it (a select, a field) take it, as they must to be used; the rest is reached with Tab. The on-screen keyboard has
  its own frame (Osk.svelte: its sizes follow its layout).
-->
<script lang="ts">
  import { onMount, type Snippet } from 'svelte';
  import Button from './Button.svelte';
  import { FloatingFrame, type Size } from './floating-frame.svelte.ts';
  import { t } from '../../i18n.ts';

  type Props = {
    /** The window's id (a test's hook). */
    id?: string;
    /** The settings key its place is remembered under. */
    place: string;
    title: string;
    min?: Size;
    size?: Size;
    head?: Snippet;
    children: Snippet;
    onclose: () => void;
  };
  let {
    id,
    place,
    title,
    min = { w: 280, h: 160 },
    size = { w: 560, h: 400 },
    head,
    children,
    onclose,
  }: Props = $props();

  const titleId = $props.id();
  // The place is read once, when it opens (a new key is a new window).
  // svelte-ignore state_referenced_locally
  const frame = new FloatingFrame(place, min, size);
  const px = (n: number) => `${String(n)}px`;
  onMount(() => frame.clamp());

  /** Form controls take the focus when clicked, as they must; nothing else in the window does. */
  function keepFocus(e: MouseEvent) {
    if (!(e.target instanceof Element && e.target.closest('input, select, textarea, [contenteditable]')))
      e.preventDefault();
  }
</script>

<svelte:window onresize={frame.fit} />

<div
  {id}
  class="window"
  role="dialog"
  tabindex="-1"
  aria-labelledby={titleId}
  style:left={px(frame.x)}
  style:top={px(frame.y)}
  style:width={px(frame.w)}
  style:height={px(frame.h)}
  onmousedown={keepFocus}
>
  <!-- Dragged with a pointer only. -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="bar"
    onpointerdown={(e) => frame.grab('move', e)}
    onpointermove={frame.move}
    onpointerup={frame.end}
    onpointercancel={frame.end}
  >
    <span class="title" id={titleId}>{title}</span>
    {#if head}<div class="head">{@render head()}</div>{/if}
    <Button
      variant="plain"
      icon="x"
      iconSize={16}
      data-action="close"
      aria-label={t('common:FloatingWindow.close')}
      title={t('common:FloatingWindow.close')}
      onclick={onclose}
    />
  </div>
  <div class="body">{@render children()}</div>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="grip"
    title={t('common:FloatingWindow.resize')}
    onpointerdown={(e) => frame.grab('size', e)}
    onpointermove={frame.move}
    onpointerup={frame.end}
    onpointercancel={frame.end}
  ></div>
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
  .title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-size: var(--text-md);
    font-weight: var(--weight-bold);
  }
  .head {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-width: 0;
    cursor: auto;
  }
  .body {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    flex: 1;
    min-height: 0;
    padding: var(--space-4);
  }
  /* The corner's grip: three short diagonal strokes, as a desktop window's. */
  .grip {
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
