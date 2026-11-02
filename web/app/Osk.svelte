<!--
  The on-screen keyboard (docs/frontend.md "The on-screen keyboard"): a US keyboard of 104 keys over the machine, moved
  by its bar and resized by its corner (remembered). Each pointer on a key holds it until it lifts, so fingers chord as
  on a real keyboard (web/app/osk.ts `OskKeys`); the keys go to the guest through `send`. It never takes the focus: the
  screen keeps it.
-->
<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import Icon from './Icon.svelte';
  import { HEIGHT, KEYS, legends, OskKeys, WIDTH, type ModifierMode, type Mods } from './osk.ts';
  import { remember, settings } from './settings.ts';
  import { t } from '../i18n.ts';

  type Props = {
    /** Key `code` down or up, with the modifiers down on the keyboard (for a terminal's characters). */
    send(code: string, down: boolean, mods: Mods): void;
    mode: ModifierMode;
    /** Bumped when the guest's keys were released elsewhere (a blur): what the keyboard holds is forgotten. */
    released: number;
    onclose(): void;
  };
  let { send, mode, released, onclose }: Props = $props();

  let tick = $state(0);
  const keys = new OskKeys((code, down) => send(code, down, keys.mods()));
  keys.onChange = () => { tick++; };
  $effect(() => { keys.mode = mode; });
  $effect(() => { if (released) untrack(() => keys.forget()); });

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
  const LABELS = KEYS.map((k) => ({ ...k, legend: legends(k.code), name: NAMES[k.code] ? t(NAMES[k.code]) : undefined }));

  // Where it is and how wide (CSS pixels), kept in the viewport.
  const BAR = 22, PAD = 6, MIN = 360;
  const heightOf = (w: number) => ((w - 2 * PAD) / WIDTH) * HEIGHT + 2 * PAD + BAR;
  // Where it was left, or centered at the bottom.
  const saved = settings().osk;
  const w0 = saved?.w ?? Math.min(960, innerWidth - 16);
  let w = $state(w0);
  let x = $state(saved?.x ?? (innerWidth - w0) / 2);
  let y = $state(saved?.y ?? innerHeight - heightOf(w0) - 40);
  const u = $derived((w - 2 * PAD) / WIDTH);
  const px = (n: number) => `${n}px`;
  function clamp() {
    w = Math.max(MIN, Math.min(w, innerWidth));
    x = Math.max(0, Math.min(x, innerWidth - w));
    y = Math.max(0, Math.min(y, innerHeight - heightOf(w)));
  }
  onMount(() => {
    clamp();
    const fit = () => clamp();
    addEventListener('resize', fit);
    return () => { removeEventListener('resize', fit); keys.releaseAll(); };
  });

  // Moving (the bar) and resizing (the corner): a pointer's drag, kept when it ends.
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
    else w = drag.w + dx;
    clamp();
  }
  function dragEnd(e: PointerEvent) {
    if (drag?.id !== e.pointerId) return;
    drag = undefined;
    remember({ osk: { x: Math.round(x), y: Math.round(y), w: Math.round(w) } });
  }

  // The keys: each pointer holds the key it went down on until it lifts (captured: sliding off doesn't let it go).
  function keyDown(e: PointerEvent) {
    const el = (e.target as Element).closest<HTMLElement>('[data-code]');
    e.preventDefault(); // no focus moved, no text selected, no mouse events after a touch
    if (!el || (e.pointerType === 'mouse' && e.button !== 0)) return;
    el.setPointerCapture(e.pointerId);
    keys.press(e.pointerId, el.dataset.code!);
  }
  const keyUp = (e: PointerEvent) => keys.release(e.pointerId);
  /** Key `code`'s state as of redraw `_tick`. */
  const stateOf = (code: string, _tick: number) => keys.state(code);
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div id="osk" style:left={px(x)} style:top={px(y)} style:width={px(w)} style:--u={px(u)}
  onmousedown={(e) => e.preventDefault()} oncontextmenu={(e) => e.preventDefault()}>
  <div class="bar" onpointerdown={(e) => grab('move', e)} onpointermove={dragMove} onpointerup={dragEnd} onpointercancel={dragEnd}>
    <span>{t('osk:Osk.title')}</span>
    <button class="close" aria-label={t('osk:Osk.close')} title={t('osk:Osk.close')} onclick={onclose}><Icon name="x" size={14} /></button>
  </div>
  <div class="keys" style:height={px(u * HEIGHT)} onpointerdown={keyDown} onpointerup={keyUp} onpointercancel={keyUp}>
    {#each LABELS as k (k.code)}
      <div class="key" data-code={k.code} data-state={stateOf(k.code, tick)} class:named={!!k.name}
        style:left={px(k.x * u)} style:top={px(k.y * u)} style:width={px(k.w * u)} style:height={px(k.h * u)}>
        {#if k.name}<span class="main">{k.name}</span>{:else if k.legend?.top}<span class="top">{k.legend.top}</span><span class="main">{k.legend.main}</span>{:else}<span class="main">{k.legend?.main}</span>{/if}
      </div>
    {/each}
  </div>
  <div class="corner" title={t('osk:Osk.resize')} onpointerdown={(e) => grab('size', e)} onpointermove={dragMove} onpointerup={dragEnd} onpointercancel={dragEnd}></div>
</div>

<style>
  #osk { position: fixed; z-index: 20; box-sizing: border-box; padding: 0 6px 6px; background: color-mix(in srgb, var(--panel) 92%, transparent);
    border: 1px solid var(--line); border-radius: 8px; box-shadow: 0 6px 24px #0009; user-select: none; -webkit-user-select: none; touch-action: none; }
  .bar { display: flex; align-items: center; height: 22px; cursor: move; color: var(--dim); font-size: 12px; padding-left: 4px; }
  .bar span { flex: 1; }
  .close { display: grid; place-items: center; width: 22px; height: 20px; padding: 0; color: var(--dim); background: none; border: 0; border-radius: 4px; cursor: pointer; }
  .close:hover { background: var(--hover); color: var(--text); }
  .keys { position: relative; }
  .key { position: absolute; box-sizing: border-box; margin: 0; border: 1px solid var(--line); border-radius: calc(var(--u) * 0.12);
    background: var(--bar); color: var(--text); display: flex; flex-direction: column; align-items: center; justify-content: center;
    line-height: 1.05; font-size: calc(var(--u) * 0.34); cursor: pointer; overflow: hidden; outline-offset: -1px;
    transform: scale(0.94); }
  .key.named { font-size: calc(var(--u) * 0.24); text-align: center; }
  .key .top { color: var(--dim); font-size: 0.85em; }
  .key[data-state=held] { background: var(--pressed); border-color: var(--accent); }
  .key[data-state=latched] { background: color-mix(in srgb, var(--accent) 35%, var(--bar)); border-color: var(--accent); }
  .corner { position: absolute; right: 0; bottom: 0; width: 16px; height: 16px; cursor: nwse-resize; touch-action: none;
    background: linear-gradient(135deg, transparent 55%, var(--dim) 55% 62%, transparent 62% 72%, var(--dim) 72% 79%, transparent 79%); }
</style>
