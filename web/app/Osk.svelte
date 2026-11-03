<!--
  The on-screen keyboard (docs/frontend.md "The on-screen keyboard"): a US keyboard of 104 keys over the machine, or in
  a narrow window the compact one's pages chosen by tabs in its bar (web/app/osk.ts `PAGES`; the bar's button forces
  either), moved by its bar and resized by the grip in it (remembered; kept in the window). Each pointer on a key holds it until it lifts, so fingers chord as
  on a real keyboard (web/app/osk.ts `OskKeys`); the keys go to the guest through `send`. It never takes the focus: the
  screen keeps it.
-->
<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import Icon from './Icon.svelte';
  import { autoLayout, COMPACT_HEIGHT, COMPACT_WIDTH, fullKeys, HEIGHT, keymapOf, layoutOf, legends, OskKeys, pages, WIDTH, type Key, type Layout, type ModifierMode, type Mods } from './osk.ts';
  import { remember, settings } from './settings.ts';
  import { t } from '../i18n.ts';

  type Props = {
    /** Key `code` down or up, with the modifiers down on the keyboard (for a terminal's characters); `repeat`, a held key's. */
    send(code: string, down: boolean, mods: Mods, repeat?: boolean): void;
    /** The machine's keyboard layout (web/app/keyboard.ts), or none (US): the keys' legends, ISO's or JIS's extra keys. */
    keyLayout?: string;
    mode: ModifierMode;
    /** Bumped when the guest's keys were released elsewhere (a blur): what the keyboard holds is forgotten. */
    released: number;
    /** The last key typed on the physical keyboard (`n` bumped each time): it ends the latches as a key here does. */
    typed: { code: string; n: number };
    /** The guest's LEDs (bit 0 Num, 1 Caps, 2 Scroll Lock): lit on the lock keys. */
    leds: number;
    onclose(): void;
  };
  let { send, keyLayout, mode, released, typed, leds, onclose }: Props = $props();
  /** The lock keys' LEDs: their bits in `leds`. */
  const LED_BITS: Record<string, number> = { NumLock: 1, CapsLock: 2, ScrollLock: 4 };

  let tick = $state(0);
  const keys = new OskKeys((code, down, repeat) => send(code, down, keys.mods(), repeat));
  keys.onChange = () => { tick++; };
  $effect(() => { keys.mode = mode; });
  $effect(() => { if (released) untrack(() => keys.forget()); });
  $effect(() => { if (typed.n) { const code = typed.code; untrack(() => keys.typed(code)); } });

  /** The named keys' words (the others show their legends). */
  const NAMES: Record<string, string> = {
    Escape: 'osk:Osk.key.Escape', Tab: 'osk:Osk.key.Tab', CapsLock: 'osk:Osk.key.CapsLock', ShiftLeft: 'osk:Osk.key.Shift',
    ShiftRight: 'osk:Osk.key.Shift', ControlLeft: 'osk:Osk.key.Control', ControlRight: 'osk:Osk.key.Control',
    MetaLeft: 'osk:Osk.key.Meta', MetaRight: 'osk:Osk.key.Meta', AltLeft: 'osk:Osk.key.Alt', AltRight: 'osk:Osk.key.AltGr',
    ContextMenu: 'osk:Osk.key.ContextMenu', Backspace: 'osk:Osk.key.Backspace', Enter: 'osk:Osk.key.Enter',
    NumpadEnter: 'osk:Osk.key.Enter', PrintScreen: 'osk:Osk.key.PrintScreen', ScrollLock: 'osk:Osk.key.ScrollLock',
    Pause: 'osk:Osk.key.Pause', Insert: 'osk:Osk.key.Insert', Home: 'osk:Osk.key.Home', PageUp: 'osk:Osk.key.PageUp',
    Delete: 'osk:Osk.key.Delete', End: 'osk:Osk.key.End', PageDown: 'osk:Osk.key.PageDown', NumLock: 'osk:Osk.key.NumLock',
    ArrowUp: 'osk:Osk.key.ArrowUp', ArrowDown: 'osk:Osk.key.ArrowDown', ArrowLeft: 'osk:Osk.key.ArrowLeft', ArrowRight: 'osk:Osk.key.ArrowRight',
  };
  // The keys and their legends, as the machine's layout has them.
  const keymap = $derived(keymapOf(keyLayout));
  /** Key `k`'s words: a one-key-wide Backspace's short ones (JIS's), JIS's Hankaku/Zenkaku (Backquote without a character). */
  const nameOf = (k: Key) =>
    k.code === 'Backspace' && k.w < 1.5 ? t('osk:Osk.key.BackspaceShort')
    : k.code === 'Backquote' && !keymap.Backquote ? t('osk:Osk.key.HankakuZenkaku')
    : NAMES[k.code] ? t(NAMES[k.code]) : undefined;
  const label = (keys: Key[]) => keys.map((k) => ({ ...k, legend: legends(k.code, keymap), name: nameOf(k) }));
  const FULL = $derived(label(fullKeys(keymap)));
  const PAGES = $derived(pages(keymap));
  const PAGE_KEYS = $derived(Object.fromEntries(PAGES.map((p) => [p.id, label(p.keys)])));
  /** The compact layout's tabs: their words and tooltips. */
  const PAGE_WORDS: Record<string, [string, string]> = {
    main: ['osk:Osk.page.main', 'osk:Osk.pageTitle.main'], symbols: ['osk:Osk.page.symbols', 'osk:Osk.pageTitle.symbols'],
    fn: ['osk:Osk.page.fn', 'osk:Osk.pageTitle.fn'], keypad: ['osk:Osk.page.keypad', 'osk:Osk.pageTitle.keypad'],
  };

  // The layout: the one the window's width gets (osk.ts `autoLayout`), or the one the bar's button forced, kept until
  // the window's width crosses to where the automatic one is the same.
  const saved = settings().osk;
  let forced = $state<Layout | undefined>(saved?.layout);
  let winWidth = $state(innerWidth);
  const layout = $derived(layoutOf(winWidth, forced));
  let page = $state('main');
  const labels = $derived(layout === 'compact' ? PAGE_KEYS[page] : FULL);

  // Where it is and how wide (CSS pixels; a width per layout), kept in the window: its bar, its padding (no top one)
  // and its border.
  const PAD = 6, BORDER = 1;
  const DIMS = { full: { cols: WIDTH, rows: HEIGHT, bar: 22, min: 320 }, compact: { cols: COMPACT_WIDTH, rows: COMPACT_HEIGHT, bar: 28, min: 240 } };
  const dims = $derived(DIMS[layout]);
  const unitIn = (l: Layout, w: number) => (w - 2 * PAD - 2 * BORDER) / DIMS[l].cols;
  const heightIn = (l: Layout, w: number) => unitIn(l, w) * DIMS[l].rows + DIMS[l].bar + PAD + 2 * BORDER;
  const heightOf = (w: number) => heightIn(layout, w);
  /** The widest it can be: the window's width, and the width whose height is the window's. */
  const widest = () => Math.min(innerWidth, ((innerHeight - dims.bar - PAD - 2 * BORDER) / dims.rows) * dims.cols + 2 * PAD + 2 * BORDER);
  // Where it was left, or centered at the bottom.
  const w0 = { full: saved?.w ?? Math.min(960, innerWidth - 16), compact: saved?.wc ?? Math.min(480, innerWidth - 16) };
  let widths = $state(w0);
  const w = $derived(widths[layout]);
  const first = layoutOf(innerWidth, saved?.layout);
  let x = $state(saved?.x ?? (innerWidth - w0[first]) / 2);
  let y = $state(saved?.y ?? innerHeight - heightIn(first, w0[first]) - 40);
  const u = $derived(unitIn(layout, w));
  const px = (n: number) => `${n}px`;
  function clamp() {
    widths[layout] = Math.max(Math.min(dims.min, widest()), Math.min(widths[layout], widest()));
    x = Math.max(0, Math.min(x, innerWidth - widths[layout]));
    y = Math.max(0, Math.min(y, innerHeight - heightOf(widths[layout])));
  }
  const save = () => remember({ osk: { x: Math.round(x), y: Math.round(y), w: Math.round(widths.full), wc: Math.round(widths.compact), layout: forced } });
  // A layout shown anew is kept in the window too (the compact one is taller for its width).
  $effect(() => { void layout; untrack(clamp); });
  /** The bar's button: the other layout, forced while the window's width keeps the automatic one the same. */
  function switchLayout() {
    const next: Layout = layout === 'compact' ? 'full' : 'compact';
    forced = next === autoLayout(innerWidth) ? undefined : next;
    page = 'main';
    save();
  }
  let root: HTMLElement;
  onMount(() => {
    const fit = () => {
      winWidth = innerWidth;
      if (forced && forced === autoLayout(innerWidth)) { forced = undefined; save(); }
      clamp();
    };
    fit();
    // A press elsewhere (a click on the screen) while a finger holds a modifier uses it: Shift-click, not a tap.
    const elsewhere = (e: PointerEvent) => { if (!root.contains(e.target as Node)) keys.used(); };
    // A pointer lets its key go wherever it lifts: its key may be gone (another finger chose another page).
    const lift = (e: PointerEvent) => keys.release(e.pointerId);
    addEventListener('resize', fit);
    document.addEventListener('pointerdown', elsewhere, true);
    document.addEventListener('pointerup', lift, true);
    document.addEventListener('pointercancel', lift, true);
    return () => {
      removeEventListener('resize', fit);
      document.removeEventListener('pointerdown', elsewhere, true);
      document.removeEventListener('pointerup', lift, true);
      document.removeEventListener('pointercancel', lift, true);
      keys.releaseAll();
    };
  });

  // Moving (the bar) and resizing (the grip, by its left edge): a pointer's drag, kept when it ends.
  let drag: { id: number; kind: 'move' | 'size'; x0: number; y0: number; x: number; y: number; w: number } | undefined;
  function grab(kind: 'move' | 'size', e: PointerEvent) {
    if (e.button !== 0 || (e.target as Element).closest('button')) return;
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    drag = { id: e.pointerId, kind, x0: e.clientX, y0: e.clientY, x, y, w };
  }
  function dragMove(e: PointerEvent) {
    if (drag?.id !== e.pointerId) return;
    const [dx, dy] = [e.clientX - drag.x0, e.clientY - drag.y0];
    if (drag.kind === 'move') [x, y] = [drag.x + dx, drag.y + dy];
    else widths[layout] = drag.w + dx;
    clamp();
  }
  function dragEnd(e: PointerEvent) {
    if (drag?.id !== e.pointerId) return;
    drag = undefined;
    save();
  }

  // The keys: each pointer holds the key it went down on until it lifts (captured: sliding off doesn't let it go).
  function keyDown(e: PointerEvent) {
    const el = (e.target as Element).closest<HTMLElement>('[data-code]');
    e.preventDefault(); // no focus moved, no text selected, no mouse events after a touch
    if (!el || (e.pointerType === 'mouse' && e.button !== 0)) return;
    el.setPointerCapture(e.pointerId);
    keys.press(e.pointerId, el.dataset.code!);
  }
  /** Key `code`'s state as of redraw `_tick`. */
  const stateOf = (code: string, _tick: number) => keys.state(code);
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div id="osk" bind:this={root} data-layout={layout} style:left={px(x)} style:top={px(y)} style:width={px(w)} style:--u={px(u)}
  onmousedown={(e) => e.preventDefault()} oncontextmenu={(e) => e.preventDefault()}>
  <div class="bar" style:height={px(dims.bar)} onpointerdown={(e) => grab('move', e)} onpointermove={dragMove} onpointerup={dragEnd} onpointercancel={dragEnd}>
    <span class="title">{t('osk:Osk.title')}</span>
    {#if layout === 'compact'}
      <div class="tabs" role="tablist">
        {#each PAGES as p (p.id)}
          <button role="tab" data-page={p.id} aria-selected={page === p.id} title={t(PAGE_WORDS[p.id][1])} onclick={() => { page = p.id; }}>{t(PAGE_WORDS[p.id][0])}</button>
        {/each}
      </div>
    {/if}
    <button class="layout" aria-label={t(layout === 'compact' ? 'osk:Osk.toFull' : 'osk:Osk.toCompact')} title={t(layout === 'compact' ? 'osk:Osk.toFull' : 'osk:Osk.toCompact')} onclick={switchLayout}><Icon name={layout === 'compact' ? 'keyboard' : 'device-mobile'} size={14} /></button>
    <div class="grip" title={t('osk:Osk.resize')} onpointerdown={(e) => { e.stopPropagation(); grab('size', e); }} onpointermove={dragMove} onpointerup={dragEnd} onpointercancel={dragEnd}><Icon name="arrows-horizontal" size={14} /></div>
    <button class="close" aria-label={t('osk:Osk.close')} title={t('osk:Osk.close')} onclick={onclose}><Icon name="x" size={14} /></button>
  </div>
  <div class="keys" style:height={px(u * dims.rows)} onpointerdown={keyDown}>
    {#each labels as k (k.code)}
      <div class="key" data-code={k.code} data-state={stateOf(k.code, tick)} data-led={LED_BITS[k.code] ? (leds & LED_BITS[k.code] ? 'on' : 'off') : undefined} class:named={!!k.name}
        style:left={px(k.x * u)} style:top={px(k.y * u)} style:width={px(k.w * u)} style:height={px(k.h * u)}>
        {#if k.name}<span class="main">{k.name}</span>{:else if k.legend?.top}<span class="top">{k.legend.top}</span><span class="main">{k.legend.main}</span>{:else}<span class="main">{k.legend?.main}</span>{/if}{#if k.legend?.alt}<span class="alt">{k.legend.alt}</span>{/if}
      </div>
    {/each}
  </div>
</div>

<style>
  #osk { position: fixed; z-index: 1; box-sizing: border-box; padding: 0 6px 6px; background: color-mix(in srgb, var(--panel) 92%, transparent);
    border: 1px solid var(--line); border-radius: 8px; box-shadow: 0 6px 24px #0009; user-select: none; -webkit-user-select: none; touch-action: none; }
  /* The bar is a container: when it's too narrow for the title beside the compact layout's tabs, the title goes. */
  .bar { display: flex; align-items: center; gap: 2px; cursor: move; color: var(--dim); font-size: 12px; padding-left: 4px; container-type: inline-size; }
  .title { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  @container (max-width: 420px) { #osk[data-layout=compact] .title { display: none; } }
  @container (max-width: 160px) { .title { display: none; } }
  .tabs { display: flex; gap: 2px; height: 100%; padding: 2px 0; box-sizing: border-box; }
  .tabs button { min-width: 36px; padding: 0 8px; color: var(--dim); background: none; border: 1px solid transparent; border-radius: 4px; font: inherit; cursor: pointer; }
  .tabs button:hover { background: var(--hover); color: var(--text); }
  .tabs button[aria-selected=true] { color: var(--text); background: var(--bar); border-color: var(--line); }
  .layout { display: grid; place-items: center; width: 26px; height: 20px; margin-left: auto; padding: 0; color: var(--dim); background: none; border: 0; border-radius: 4px; cursor: pointer; }
  .layout:hover { background: var(--hover); color: var(--text); }
  .grip { display: grid; place-items: center; width: 28px; height: 20px; margin-right: 2px; border-radius: 4px; cursor: ew-resize; touch-action: none; }
  .grip:hover { background: var(--hover); color: var(--text); }
  .close { display: grid; place-items: center; width: 22px; height: 20px; padding: 0; color: var(--dim); background: none; border: 0; border-radius: 4px; cursor: pointer; }
  .close:hover { background: var(--hover); color: var(--text); }
  .keys { position: relative; }
  .key { position: absolute; box-sizing: border-box; margin: 0; border: 1px solid var(--line); border-radius: calc(var(--u) * 0.12);
    background: var(--bar); color: var(--text); display: flex; flex-direction: column; align-items: center; justify-content: center;
    line-height: 1.05; font-size: calc(var(--u) * 0.34); cursor: pointer; overflow: hidden; outline-offset: -1px;
    transform: scale(0.94); }
  .key.named { font-size: calc(var(--u) * 0.24); text-align: center; }
  #osk[data-layout=compact] .key.named { font-size: calc(var(--u) * 0.27); }
  .key .top { color: var(--dim); font-size: 0.85em; }
  /* The AltGr character, as a keyboard prints it: small, at the bottom right. */
  .key .alt { position: absolute; right: calc(var(--u) * 0.1); bottom: calc(var(--u) * 0.04); color: var(--accent); font-size: 0.7em; }
  /* A lock key's LED, as a keyboard's in its key: dim off, lit on. */
  .key[data-led]::after { content: ''; position: absolute; top: calc(var(--u) * 0.1); right: calc(var(--u) * 0.1); width: calc(var(--u) * 0.12);
    height: calc(var(--u) * 0.12); border-radius: 50%; background: var(--line); }
  .key[data-led=on]::after { background: var(--ok); box-shadow: 0 0 calc(var(--u) * 0.12) var(--ok); }
  .key[data-state=held] { background: var(--pressed); border-color: var(--accent); }
  .key[data-state=latched] { background: color-mix(in srgb, var(--accent) 35%, var(--bar)); border-color: var(--accent); }
</style>
