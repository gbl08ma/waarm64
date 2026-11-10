<!--
  The Preferences' status bar (docs/frontend.md "The status bar"): a copy of the bar whose elements are chips, dragged
  to reorder them (or moved with Alt+←/→ when one has the focus) and dragged out or × to remove them; a chip chosen
  shows its settings under the bar (its look, a vCPU element's bars or numbers, a `one` element's device). Below, the
  palette: a click adds an element at the bar's end, a drag puts it where it's dropped. A mouse drags through HTML5
  drag and drop; a finger or a pen through pointer events, after a long press (a swipe still scrolls the page). The chips draw what the
  running machine shows, or a made-up machine's numbers (statusbar.ts `SAMPLE`) while none runs; one the running
  machine hasn't (a second disk) is dimmed. Kept in the settings at each change.
-->
<script lang="ts">
  import Icon from './Icon.svelte';
  import type { PageNetwork } from './net-live.ts';
  import { remember } from './settings.ts';
  import { liveNow } from './StatusBar.svelte';
  import StatusPiece from './StatusPiece.svelte';
  import {
    aboutOf, DEFAULT_ITEMS, deviceOf, firstIndex, groupName, hasLooks, iconOf, lookOf, nameOf, palette, render, SAMPLE, shows, type Item, type Look,
  } from './statusbar.ts';
  import { t } from '../i18n.ts';
  import { ui } from './ui.svelte.ts';

  let { net }: { net: PageNetwork } = $props();

  const items = $derived(ui.statusItems);
  let chosen = $state<number | undefined>(undefined);
  const groups = palette();
  /** The running machine's numbers, else the sample's. */
  const sample = $derived(!ui.status.metrics);
  const live = $derived.by(() => {
    const l = liveNow(net, Date.now());
    return sample ? { ...l, state: 'running' as const, stateText: t('statusbar:StatusEditor.sample.state'), disks: SAMPLE.disks, nets: SAMPLE.nets, gpu: SAMPLE.gpu } : l;
  });
  const metrics = $derived(ui.status.metrics ?? SAMPLE.metrics);

  function keep(next: Item[]) {
    ui.statusItems = next;
    remember({ statusBar: next });
  }
  const insert = (item: Item, at = items.length) => { keep([...items.slice(0, at), { ...item }, ...items.slice(at)]); chosen = at; };
  function removeAt(at: number) {
    keep(items.filter((_, k) => k !== at));
    chosen = undefined;
  }
  function move(from: number, to: number) {
    if (to < 0 || to > items.length || from === to || from + 1 === to) return;
    const next = [...items];
    const [it] = next.splice(from, 1);
    const at = to > from ? to - 1 : to;
    next.splice(at, 0, it);
    keep(next);
    chosen = at;
  }
  function change(at: number, patch: Partial<Item>) {
    keep(items.map((it, k) => {
      if (k !== at) return it;
      const next = { ...it, ...patch };
      if (patch.look === (KIND_LOOK(it))) delete next.look; // the kind's own look isn't kept
      if (patch.numbers === false) delete next.numbers;
      return next;
    }));
  }
  const KIND_LOOK = (it: Item) => lookOf({ kind: it.kind });

  // Drag and drop: a chip's index, or a palette item (as JSON), and where it would land (before chip `over`).
  type Drag = { from?: number; add?: Item };
  let drag: Drag | undefined;
  let over = $state<number | undefined>(undefined);
  function start(e: DragEvent, d: Drag) {
    if (touch) { e.preventDefault(); return; } // a long press's own drag (Chromium on a touchscreen): the pointer's
    drag = d;
    e.dataTransfer!.effectAllowed = 'move';
    e.dataTransfer!.setData('text/plain', d.add ? nameOf(d.add) : nameOf(items[d.from!]));
  }
  function overChip(e: DragEvent, at: number) {
    if (!drag) return;
    e.preventDefault();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    over = e.clientX > r.left + r.width / 2 ? at + 1 : at;
  }
  function overEnd(e: DragEvent) {
    if (!drag) return;
    e.preventDefault();
    if (e.target === e.currentTarget) over = items.length;
  }
  function drop(e: DragEvent) {
    e.preventDefault();
    const d = drag, to = over ?? items.length;
    end();
    if (d?.add) insert(d.add, to);
    else if (d?.from !== undefined) move(d.from, to);
  }
  /** A chip dropped on the palette goes away. */
  function dropOut(e: DragEvent) {
    e.preventDefault();
    const d = drag;
    end();
    if (d?.from !== undefined) removeAt(d.from);
  }
  function end() {
    drag = undefined;
    over = undefined;
  }
  // A finger's or a pen's drag (HTML5 drag and drop serves only the mouse): pressed and held still for `HOLD` ms, it
  // picks up the chip or palette item, then follows the pointer through hit tests until it's lifted. Moving first is
  // a scroll (the browser's: touch-action stays auto, and the drag's touchmoves are what's cancelled).
  const HOLD = 350, SLOP = 8;
  let touch: { id: number; x: number; y: number; d: Drag; timer?: ReturnType<typeof setTimeout>; active: boolean; out: boolean } | undefined;
  let lifted = $state<number | undefined>(undefined);
  let leaving = $state(false);
  let root: HTMLElement;
  let swallowClick = false;
  function press(e: PointerEvent, d: Drag) {
    if (e.pointerType === 'mouse' || !e.isPrimary || touch) return;
    touch = { id: e.pointerId, x: e.clientX, y: e.clientY, d, active: false, out: false };
    touch.timer = setTimeout(() => {
      if (!touch) return;
      touch.active = true;
      drag = touch.d;
      lifted = touch.d.from;
      navigator.vibrate?.(10);
    }, HOLD);
    addEventListener('pointermove', follow);
    addEventListener('pointerup', lift);
    addEventListener('pointercancel', cancel);
    addEventListener('touchmove', still, { passive: false });
    addEventListener('contextmenu', still);
  }
  /** Where the pointer is: before which chip (by the chips' boxes in its row, so the drop mark that shifts them
   *  doesn't change the answer), at the bar's end, or over the palette (out). */
  function aim(x: number, y: number) {
    const el = document.elementFromPoint(x, y);
    leaving = false;
    if (el && el.closest('.bar') && root.contains(el)) {
      const row = [...root.querySelectorAll<HTMLElement>('.bar .chip')].filter((c) => { const r = c.getBoundingClientRect(); return y >= r.top && y < r.bottom; });
      const next = row.find((c) => { const r = c.getBoundingClientRect(); return x < r.left + r.width / 2; });
      over = next ? Number(next.dataset.at) : row.length ? Number(row[row.length - 1].dataset.at) + 1 : items.length;
    } else {
      over = undefined;
      leaving = drag?.from !== undefined && !!el?.closest('.palette') && root.contains(el);
    }
  }
  function follow(e: PointerEvent) {
    if (!touch || e.pointerId !== touch.id) return;
    if (!touch.active) {
      if (Math.hypot(e.clientX - touch.x, e.clientY - touch.y) > SLOP) cancel(e);
      return;
    }
    aim(e.clientX, e.clientY);
  }
  function lift(e: PointerEvent) {
    if (!touch || e.pointerId !== touch.id) return;
    const held = touch;
    if (!held.active) { cancel(e); return; }
    aim(e.clientX, e.clientY);
    const to = over, out = leaving;
    cancel(e);
    swallowClick = true;
    setTimeout(() => (swallowClick = false), 0);
    if (held.d.add) { if (to !== undefined) insert(held.d.add, to); }
    else if (held.d.from !== undefined) {
      if (out) removeAt(held.d.from);
      else if (to !== undefined) move(held.d.from, to);
    }
  }
  function cancel(e: Event) {
    if (touch && e instanceof PointerEvent && e.pointerId !== touch.id) return;
    clearTimeout(touch?.timer);
    touch = undefined;
    lifted = undefined;
    leaving = false;
    end();
    removeEventListener('pointermove', follow);
    removeEventListener('pointerup', lift);
    removeEventListener('pointercancel', cancel);
    removeEventListener('touchmove', still);
    removeEventListener('contextmenu', still);
  }
  /** While a finger drags, the page doesn't scroll under it and the long press opens no menu. */
  function still(e: Event) { if (touch?.active || e.type === 'contextmenu' && touch) e.preventDefault(); }
  /** The click a lifted finger may end with isn't a choice or an add. */
  function guard(e: MouseEvent) { if (swallowClick) { e.stopPropagation(); e.preventDefault(); } }
  $effect(() => () => { if (touch) cancel(new Event('cancel')); });

  function key(e: KeyboardEvent, at: number) {
    if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      move(at, e.key === 'ArrowLeft' ? at - 1 : at + 2);
      queueMicrotask(() => (document.querySelector(`.status-edit [data-at="${chosen}"]`) as HTMLElement | null)?.focus());
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      removeAt(at);
    }
  }

  const sel = $derived(chosen !== undefined ? items[chosen] : undefined);
  const LOOK_WORDS: Record<Look, string> = { text: 'statusbar:StatusEditor.look.text', icon: 'statusbar:StatusEditor.look.icon', both: 'statusbar:StatusEditor.look.both' };
  const DEVICE_WORDS = { cpu: 'statusbar:StatusEditor.device.cpu', net: 'statusbar:StatusEditor.device.net', disk: 'statusbar:StatusEditor.device.disk' } as const;
  const INDEX_NOTE = { cpu: 'statusbar:StatusEditor.index.cpu', net: 'statusbar:StatusEditor.index.net', disk: 'statusbar:StatusEditor.index.disk' } as const;
</script>

<div class="status-edit" bind:this={root} onclickcapture={guard}>
  <div class="bar" role="list" aria-label={t('statusbar:StatusEditor.bar')} ondragover={overEnd} ondrop={drop} data-field="status-bar">
    {#each items as it, at (at)}
      {@const pieces = render(it, metrics, live)}
      {#if over === at}<span class="mark" aria-hidden="true"></span>{/if}
      <div role="listitem" class="chip" class:spacer={it.kind === 'spacer'} class:chosen={chosen === at} class:absent={!pieces.length} class:lifted={lifted === at} draggable="true"
        onpointerdown={(e) => press(e, { from: at })} ondragstart={(e) => start(e, { from: at })} ondragend={end} ondragover={(e) => overChip(e, at)} data-at={at} data-kind={it.kind}>
        <button class="pick" onclick={() => (chosen = chosen === at ? undefined : at)} onkeydown={(e) => key(e, at)} aria-pressed={chosen === at}
          title={pieces.length ? t('statusbar:StatusEditor.chip.title', { name: nameOf(it), about: aboutOf(it.kind) }) : t('statusbar:StatusEditor.chip.title.absent', { name: nameOf(it), about: aboutOf(it.kind) })}>
          {#if it.kind === 'spacer'}<span class="gap"><Icon name="arrows-horizontal" size={14} />{t('statusbar:StatusEditor.spacer')}</span>
          {:else if it.kind === 'divider'}<span class="line"></span>
          {:else if pieces.length}{#each pieces as p, k (k)}<StatusPiece item={it} {p} />{/each}
          {:else}<span>{nameOf(it)}</span>{/if}
        </button>
        <button class="x" onclick={() => removeAt(at)} title={t('statusbar:StatusEditor.remove.title')} aria-label={t('statusbar:StatusEditor.remove.label', { name: nameOf(it) })}><Icon name="x" size={12} /></button>
      </div>
    {/each}
    {#if over === items.length}<span class="mark" aria-hidden="true"></span>{/if}
    {#if !items.length}<span class="empty">{t('statusbar:StatusEditor.empty')}</span>{/if}
  </div>
  <div class="row">
    <span class="note">{sample ? t('statusbar:StatusEditor.sample') : t('statusbar:StatusEditor.running')} {shows(items) ? '' : t('statusbar:StatusEditor.nothing')}</span>
    <span class="grow"></span>
    <button onclick={() => { keep(DEFAULT_ITEMS.map((i) => ({ ...i }))); remember({ statusBar: undefined }); chosen = undefined; }} data-action="status-defaults"><Icon name="refresh" size={14} />{t('statusbar:StatusEditor.defaults')}</button>
  </div>

  {#if sel && chosen !== undefined}
    {@const at = chosen}
    {@const device = deviceOf(sel.kind)}
    <div class="options" data-field="status-options">
      <strong>{nameOf(sel)}</strong><span class="note">{aboutOf(sel.kind)}</span>
      {#if hasLooks(sel.kind) && iconOf(sel.kind)}
        <fieldset class="set">
          <legend class="sr">{t('statusbar:StatusEditor.look')}</legend>
          {#each ['text', 'icon', 'both'] as const as l (l)}
            <label><input type="radio" name="status-look" checked={lookOf(sel) === l} onchange={() => change(at, { look: l })}> {t(LOOK_WORDS[l])}</label>
          {/each}
        </fieldset>
      {/if}
      {#if device === 'cpu' && sel.scope === 'each'}
        <fieldset class="set">
          <legend class="sr">{t('statusbar:StatusEditor.cpus')}</legend>
          <label><input type="radio" name="status-bars" checked={!sel.numbers} onchange={() => change(at, { numbers: false })}> {t('statusbar:StatusEditor.cpus.bars')}</label>
          <label><input type="radio" name="status-bars" checked={!!sel.numbers} onchange={() => change(at, { numbers: true })}> {t('statusbar:StatusEditor.cpus.numbers')}</label>
        </fieldset>
      {/if}
      {#if device && sel.scope === 'one'}
        <fieldset class="set">
          <legend class="sr">{t(DEVICE_WORDS[device])}</legend>
          <label class="index">{t(DEVICE_WORDS[device])} <input type="number" min={firstIndex(device)} max="64" value={sel.index ?? firstIndex(device)}
          onchange={(e) => { const n = Math.round(Number(e.currentTarget.value)); if (Number.isFinite(n) && n >= firstIndex(device)) change(at, { index: n }); }} data-field="status-index"></label>
          <span class="note">{t(INDEX_NOTE[device])}</span>
        </fieldset>
      {/if}
      <span class="grow"></span>
      <button onclick={() => move(at, at - 1)} disabled={at === 0} title={t('statusbar:StatusEditor.left')}><Icon name="arrow-left" size={14} /></button>
      <button onclick={() => move(at, at + 2)} disabled={at === items.length - 1} title={t('statusbar:StatusEditor.right')}><Icon name="arrow-right" size={14} /></button>
      <button onclick={() => removeAt(at)}><Icon name="trash" size={14} />{t('statusbar:StatusEditor.remove')}</button>
    </div>
  {/if}

  <div class="palette" class:leaving role="group" aria-label={t('statusbar:StatusEditor.palette')} ondragover={(e) => { if (drag?.from !== undefined) e.preventDefault(); }} ondrop={dropOut}>
    {#each groups as g (g.group)}
      <span class="group">{groupName(g.group)}</span>
      <div class="chips">
        {#each g.items as it, k (k)}
          <button class="add" draggable="true" onpointerdown={(e) => press(e, { add: it })} ondragstart={(e) => start(e, { add: it })} ondragend={end} onclick={() => insert(it)} title={t('statusbar:StatusEditor.add.title', { about: aboutOf(it.kind) })} data-add={`${it.kind}${it.scope ? `:${it.scope}` : ''}`}>
            {#if iconOf(it.kind)}<Icon name={iconOf(it.kind)!} size={14} />{/if}{nameOf(it, true)}
          </button>
        {/each}
      </div>
    {/each}
  </div>
</div>

<style>
  .status-edit { display: flex; flex-direction: column; gap: 10px; }
  .bar { display: flex; flex-wrap: wrap; align-items: stretch; gap: 4px; padding: 6px; min-height: 40px; border: 1px solid var(--line); border-radius: 6px; background: var(--bar); color: var(--dim); font-size: 12px; font-variant-numeric: tabular-nums; }
  .chip { display: inline-flex; align-items: center; border: 1px solid var(--line); border-radius: 5px; background: var(--bg); cursor: grab; }
  .chip.spacer { flex: 1; justify-content: space-between; }
  .chip.spacer .pick { flex: 1; justify-content: center; }
  .chip.chosen { border-color: var(--accent); }
  .chip.absent { opacity: 0.5; border-style: dashed; }
  .chip.lifted { opacity: 0.5; border-color: var(--accent); }
  /* A finger's long press picks a chip up: no selection or callout under it. */
  .chip, .add { -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }
  .pick { display: inline-flex; align-items: center; gap: 8px; padding: 3px 4px 3px 8px; color: inherit; }
  .x { padding: 3px 5px; color: var(--dim); }
  .x:hover { color: var(--text); }
  .gap { display: inline-flex; align-items: center; gap: 4px; color: var(--dim); }
  .line { width: 1px; height: 14px; background: var(--line); }
  .mark { width: 2px; align-self: stretch; background: var(--accent); border-radius: 1px; }
  .empty { color: var(--dim); padding: 4px; }
  .row, .options { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .options { padding: 8px 10px; border: 1px solid var(--line); border-radius: 6px; }
  .options button, .row button, .add { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line); border-radius: 6px; padding: 3px 10px; }
  /* Each set of options apart from the next by a line (its legend is for screen readers). */
  .set { display: inline-flex; align-items: center; gap: 12px; margin: 0; padding: 0 0 0 16px; border: 0; border-left: 1px solid var(--line); }
  .set label, .index { display: inline-flex; align-items: center; gap: 4px; }
  .index input { width: 4em; }
  .grow { flex: 1; }
  .note { color: var(--dim); font-size: 12px; }
  .palette.leaving { outline: 2px dashed var(--accent); outline-offset: 4px; border-radius: 6px; }
  .palette { display: grid; grid-template-columns: max-content 1fr; gap: 8px 14px; align-items: baseline; }
  .group { color: var(--dim); font-size: 12px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .add { font-size: 12px; padding: 2px 8px; cursor: grab; }
</style>
