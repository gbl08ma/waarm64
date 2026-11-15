<!--
  The on-screen keyboard (docs/frontend.md "The on-screen keyboard"): a PC keyboard of the machine's layout over the machine, or in
  a narrow window the compact one's pages chosen by tabs in its bar (web/app/osk.ts `PAGES`; the bar's button forces
  either), moved by its bar and resized by the grip in it (remembered; kept in the window). Each pointer on a key holds it until it lifts, so fingers chord as
  on a real keyboard (web/app/osk.ts `OskKeys`); the keys go to the guest through `send`. It never takes the focus: the
  screen keeps it.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import OskBar from './OskBar.svelte';
  import FloatingWindow from './ui/FloatingWindow.svelte';
  import type { Size } from './ui/floating-frame.svelte.ts';
  import { OskShape, PLACE, unitIn } from './osk-shape.svelte.ts';
  import { legends, OskKeys, type ModifierMode, type Mods } from './osk.ts';
  import { fullKeys, keymapOf, pages, type Key } from './osk-layout.ts';
  import { t } from '../i18n.ts';
  import { keys as pageKeys } from './areas/keys.svelte.ts';

  type Props = {
    /** Key `code` down or up, with the modifiers down on the keyboard (for a terminal's characters); `repeat`, a held key's. */
    send: (code: string, down: boolean, mods: Mods, repeat?: boolean) => void;
    /** The machine's keyboard layout (web/app/keyboard.ts), or none (US): the keys' legends, ISO's or JIS's extra keys. */
    keyLayout?: string;
    mode: ModifierMode;
    /** The guest's LEDs (bit 0 Num, 1 Caps, 2 Scroll Lock): lit on the lock keys. */
    leds: number;
    onclose: () => void;
  };
  let { send, keyLayout, mode, leds, onclose }: Props = $props();
  /** The lock keys' LEDs: their bits in `leds`. */
  const LED_BITS: Record<string, number> = { NumLock: 1, CapsLock: 2, ScrollLock: 4 };

  const keys = new OskKeys((code, down, repeat) => send(code, down, keys.mods(), repeat));
  $effect(() => {
    keys.mode = mode;
  });
  // The guest's keys released elsewhere (a blur): what the keyboard holds is forgotten. A key typed on the physical
  // keyboard ends the latches as a key here does.
  $effect(() => pageKeys.released.on(() => keys.forget()));
  $effect(() => pageKeys.typed.on((code) => keys.typed(code)));

  /** The named keys' words (the others show their legends). */
  const NAMES: Record<string, string> = {
    Escape: 'osk:Osk.key.Escape',
    Tab: 'osk:Osk.key.Tab',
    CapsLock: 'osk:Osk.key.CapsLock',
    ShiftLeft: 'osk:Osk.key.Shift',
    ShiftRight: 'osk:Osk.key.Shift',
    ControlLeft: 'osk:Osk.key.Control',
    ControlRight: 'osk:Osk.key.Control',
    MetaLeft: 'osk:Osk.key.Meta',
    MetaRight: 'osk:Osk.key.Meta',
    AltLeft: 'osk:Osk.key.Alt',
    AltRight: 'osk:Osk.key.AltGr',
    ContextMenu: 'osk:Osk.key.ContextMenu',
    Backspace: 'osk:Osk.key.Backspace',
    Enter: 'osk:Osk.key.Enter',
    NumpadEnter: 'osk:Osk.key.Enter',
    PrintScreen: 'osk:Osk.key.PrintScreen',
    ScrollLock: 'osk:Osk.key.ScrollLock',
    Pause: 'osk:Osk.key.Pause',
    Insert: 'osk:Osk.key.Insert',
    Home: 'osk:Osk.key.Home',
    PageUp: 'osk:Osk.key.PageUp',
    Delete: 'osk:Osk.key.Delete',
    End: 'osk:Osk.key.End',
    PageDown: 'osk:Osk.key.PageDown',
    NumLock: 'osk:Osk.key.NumLock',
    NonConvert: 'osk:Osk.key.NonConvert',
    Convert: 'osk:Osk.key.Convert',
    KanaMode: 'osk:Osk.key.KanaMode',
    ArrowUp: 'osk:Osk.key.ArrowUp',
    ArrowDown: 'osk:Osk.key.ArrowDown',
    ArrowLeft: 'osk:Osk.key.ArrowLeft',
    ArrowRight: 'osk:Osk.key.ArrowRight',
  };
  // The keys and their legends, as the machine's layout has them.
  const keymap = $derived(keymapOf(keyLayout));
  /** Key `k`'s words: a one-key-wide Backspace's short ones (JIS's), JIS's Hankaku/Zenkaku (Backquote without a character). */
  function nameOf(k: Key) {
    if (k.code === 'Backspace' && k.w < 1.5) return t('osk:Osk.key.BackspaceShort');
    if (k.code === 'Backquote' && !keymap.Backquote) return t('osk:Osk.key.HankakuZenkaku');
    const name = NAMES[k.code];
    return name ? t(name) : undefined;
  }
  const label = (list: Key[]) => list.map((k) => ({ ...k, legend: legends(k.code, keymap), name: nameOf(k) }));
  const FULL = $derived(label(fullKeys(keymap)));
  const PAGES = $derived(pages(keymap));
  const PAGE_KEYS = $derived(Object.fromEntries(PAGES.map((p) => [p.id, label(p.keys)])));

  const shape = new OskShape();
  const compact = $derived(shape.layout === 'compact');
  let page = $state('main');
  const labels = $derived(compact ? PAGE_KEYS[page] : FULL);
  const px = (n: number) => `${n}px`;
  function switchLayout() {
    shape.switchLayout();
    page = 'main';
  }
  /** A lock key's LED: lit or not (undefined: the key has none). */
  function ledOf(code: string) {
    const bit = LED_BITS[code];
    if (!bit) return undefined;
    return leds & bit ? 'on' : 'off';
  }

  let root = $state<HTMLElement>();
  onMount(() => {
    shape.fit();
    return () => keys.releaseAll();
  });
  /** A press elsewhere (a click on the screen) while a finger holds a modifier uses it: Shift-click, not a tap. */
  function elsewhere(e: PointerEvent) {
    if (!(e.target instanceof Node && root?.contains(e.target))) keys.used();
  }
  /** A pointer lets its key go wherever it lifts: its key may be gone (another finger chose another page). */
  const lift = (e: PointerEvent) => keys.release(e.pointerId);

  // The keys: each pointer holds the key it went down on until it lifts (captured: sliding off doesn't let it go).
  function keyDown(e: PointerEvent) {
    const el = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-code]') : null;
    e.preventDefault(); // no focus moved, no text selected, no mouse events after a touch
    const code = el?.dataset.code;
    if (!el || !code || (e.pointerType === 'mouse' && e.button !== 0)) return;
    el.setPointerCapture(e.pointerId);
    keys.press(e.pointerId, code);
  }
</script>

<svelte:window onresize={shape.fit} />
<svelte:document onpointerdowncapture={elsewhere} onpointerupcapture={lift} onpointercancelcapture={lift} />

<FloatingWindow
  id="osk"
  place={PLACE}
  title={t('osk:Osk.title')}
  tool
  min={shape.min}
  size={shape.size}
  aspect={shape.height}
  sizeKey={shape.layout}
  at={shape.at}
  barHeight={shape.dims.bar}
  titleMin={shape.dims.titleMin}
  data-layout={shape.layout}
  bind:ref={root}
  {onclose}
>
  {#snippet head()}
    <OskBar {compact} pages={PAGES} bind:page onswitch={switchLayout} />
  {/snippet}
  {#snippet children({ w }: Size)}
    {@const u = unitIn(shape.layout, w)}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class={['keys', { compact }]} style:height={px(u * shape.dims.rows)} style:--u={px(u)} onpointerdown={keyDown}>
      {#each labels as k (k.code)}
        <div
          class="key"
          data-code={k.code}
          data-state={keys.state(k.code)}
          data-led={ledOf(k.code)}
          class:named={!!k.name}
          style:left={px(k.x * u)}
          style:top={px(k.y * u)}
          style:width={px(k.w * u)}
          style:height={px(k.h * u)}
        >
          {#if k.name}
            <span class="main">{k.name}</span>
          {:else if k.legend?.top}
            <span class="top">{k.legend.top}</span><span class="main">{k.legend.main}</span>
          {:else}
            <span class="main">{k.legend?.main}</span>
          {/if}
          {#if k.legend?.alt}<span class="alt">{k.legend.alt}</span>{/if}
        </div>
      {/each}
    </div>
  {/snippet}
</FloatingWindow>

<style>
  .keys {
    position: relative;
  }
  .key {
    position: absolute;
    box-sizing: border-box;
    margin: 0;
    border: 1px solid var(--border);
    border-radius: calc(var(--u) * 0.12);
    background: var(--surface-bar);
    color: var(--text);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    line-height: 1.05;
    font-size: calc(var(--u) * 0.34);
    cursor: pointer;
    overflow: hidden;
    outline-offset: -1px;
    transform: scale(0.94);
  }
  .key.named {
    font-size: calc(var(--u) * 0.24);
    text-align: center;
  }
  .keys.compact .key.named {
    font-size: calc(var(--u) * 0.27);
  }
  .key .top {
    color: var(--text-dim);
    font-size: calc(var(--u) * 0.29); /* 0.85 of a key's legend */
  }
  /* The AltGr character, as a keyboard prints it: small, at the bottom right. */
  .key .alt {
    position: absolute;
    right: calc(var(--u) * 0.1);
    bottom: calc(var(--u) * 0.04);
    color: var(--accent);
    font-size: calc(var(--u) * 0.24); /* 0.7 of a key's legend */
  }
  /* A lock key's LED, as a keyboard's in its key: dim off, lit on. */
  .key[data-led]::after {
    content: '';
    position: absolute;
    top: calc(var(--u) * 0.1);
    right: calc(var(--u) * 0.1);
    width: calc(var(--u) * 0.12);
    height: calc(var(--u) * 0.12);
    border-radius: 50%;
    background: var(--border);
  }
  .key[data-led='on']::after {
    background: var(--status-ok);
    box-shadow: 0 0 calc(var(--u) * 0.12) var(--status-ok);
  }
  .key[data-state='held'] {
    background: var(--pressed-bg);
    border-color: var(--accent);
  }
  .key[data-state='latched'] {
    background: color-mix(in srgb, var(--accent) 35%, var(--surface-bar));
    border-color: var(--accent);
  }
</style>
