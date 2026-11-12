<!--
  The toolbar (docs/frontend.md "The toolbar"): the running machine's quick actions. The Machines page holds the rest
  (settings, disks, overlays, snapshots). Icons with tooltips; the main gates (Machines, Start) also have their names.
  Each network adapter has its own button where the toolbar keeps to one row with them; where they'd take it onto
  another, one button has them all (Network.svelte `split`).
-->
<script lang="ts">
  import Button from './ui/Button.svelte';
  import ClipboardMenu from './ClipboardMenu.svelte';
  import FoldersMenu from './FoldersMenu.svelte';
  import KeysMenu from './KeysMenu.svelte';
  import LoadSnapshotMenu from './LoadSnapshotMenu.svelte';
  import MouseMenu from './MouseMenu.svelte';
  import Network from './Network.svelte';
  import ScreenMenu from './ScreenMenu.svelte';
  import SizeMenu from './SizeMenu.svelte';
  import Sound from './Sound.svelte';
  import UsbMenu from './UsbMenu.svelte';
  import type { PageAudio } from '../audio.ts';
  import type { PageFolders } from './folders-live.ts';
  import type { PageNetwork } from './net-live.ts';
  import { usb } from './areas/usb.svelte.ts';
  import { machinesNav } from './areas/machines-nav.svelte.ts';
  import { clipboard } from './areas/clipboard.svelte.ts';
  import { current } from './areas/current.svelte.ts';
  import { isLive, power } from './areas/power.svelte.ts';
  import { screen } from './areas/screen.svelte.ts';
  import { inBar, page } from './page.ts';
  import type { View } from './areas/screen.svelte.ts';
  import { t } from '../i18n.ts';

  let { audio, net, folders }: { audio: PageAudio; net: PageNetwork; folders: PageFolders } = $props();

  const running = $derived(isLive(power.state));
  /** What Start says: start an idle machine, retry a failed one, else restart. */
  function startAsOf() {
    if (power.state === 'off' || power.state === 'idle' || power.state === 'suspended') return 'start';
    return power.state === 'failed' ? 'retry' : 'restart';
  }
  const startAs = $derived(startAsOf());
  const START = {
    start: { label: 'toolbar:Toolbar.start', title: 'toolbar:Toolbar.start.title' },
    retry: { label: 'toolbar:Toolbar.retry', title: 'toolbar:Toolbar.retry.title' },
    restart: { label: 'toolbar:Toolbar.restart', title: 'toolbar:Toolbar.restart.title' },
  } as const;
  const canSnapshot = $derived(running && !power.busy);

  /** Each network adapter has its own button (`fits`). */
  let split = $state(true);
  let bar = $state<HTMLElement>();
  /** The adapters' buttons' widths together, as last measured, and how many they were. */
  let measured = { width: 0, count: 0 };
  /** The adapters' buttons beside the single one's, in its place: none when there's one adapter. */
  const adapters = $derived(current.hasNetwork ? net.views().length : 0);

  /**
   * Whether the toolbar's contents, with a button for each adapter, fit on one row: its children's widths (their margins
   * too), their gaps and its padding against its own width. With the single button, the adapters' are as wide as last
   * measured (before that, the single one's and a digit each), so the answer is the same whichever is shown (no
   * flip-flop). Hidden children (no width) don't count. The children include the menus' `details` (`data-net-menu`,
   * Network.svelte), measured, not touched.
   */
  function fits(el: HTMLElement): boolean {
    const style = getComputedStyle(el);
    const gap = parseFloat(style.columnGap) || 0;
    let width = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    let items = 0;
    let single = 0;
    const apart = { width: 0, count: 0 };
    for (const child of el.children) {
      const w = child.getBoundingClientRect().width;
      if (!w) continue;
      const cs = getComputedStyle(child);
      width += w + parseFloat(cs.marginLeft) + parseFloat(cs.marginRight);
      items++;
      const menu = child instanceof HTMLElement ? child.dataset.netMenu : undefined;
      if (menu === 'all') single = w;
      else if (menu !== undefined) [apart.width, apart.count] = [apart.width + w, apart.count + 1];
    }
    if (apart.count) measured = apart;
    if (single && adapters > 1) {
      const all = measured.count === adapters ? measured.width : (single + parseFloat(style.fontSize)) * adapters;
      width += all - single + gap * (adapters - 1);
    }
    return width + gap * Math.max(0, items - 1) <= el.clientWidth + 0.5;
  }
  // Measured after a layout, outside the observer's callback (changing the toolbar from inside it would loop).
  $effect(() => {
    // Without adapters there's nothing to choose; a machine with more or fewer: measure again.
    if (!bar || !adapters) return;
    const el = bar;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => (split = fits(el)));
    };
    const sizes = new ResizeObserver(measure);
    const watch = () => {
      sizes.disconnect();
      sizes.observe(el);
      for (const child of el.children) sizes.observe(child);
    };
    const children = new MutationObserver(() => {
      watch();
      measure();
    });
    children.observe(el, { childList: true });
    watch();
    return () => {
      cancelAnimationFrame(frame);
      sizes.disconnect();
      children.disconnect();
    };
  });

  const VIEWS: { v: View; icon: 'device-desktop' | 'terminal-2' | 'layout-columns'; title: string }[] = [
    { v: 'screen', icon: 'device-desktop', title: t('toolbar:Toolbar.view.screen') },
    { v: 'terminal', icon: 'terminal-2', title: t('toolbar:Toolbar.view.terminal') },
    { v: 'both', icon: 'layout-columns', title: t('toolbar:Toolbar.view.both') },
  ];
</script>

<header class="toolbar" bind:this={bar}>
  <h1>{t('toolbar:Toolbar.name')}</h1>
  <Button
    variant="tool"
    labelled
    icon="server-2"
    id="machines-open"
    aria-pressed={machinesNav.open}
    title={t('toolbar:Toolbar.machines.title')}
    onclick={() => page.openMachines()}
  >
    {t('toolbar:Toolbar.machines')}
  </Button>
  <span id="machine" title={current.title}>{current.title}</span>
  <span class="sep"></span>
  <Button
    variant="tool"
    labelled
    icon={startAs === 'restart' ? 'refresh' : 'player-play'}
    id="restart"
    hidden={power.cantRun}
    disabled={power.busy}
    title={t(START[startAs].title)}
    onclick={() => inBar(() => page.restart())}
  >
    {t(START[startAs].label)}
  </Button>
  <Button
    variant="tool"
    icon="player-stop"
    id="power-off"
    hidden={power.cantRun || !running}
    disabled={power.busy}
    aria-label={t('toolbar:Toolbar.powerOff')}
    title={t('toolbar:Toolbar.powerOff.title')}
    onclick={() => inBar(() => page.powerOffAsked())}
  />
  <Button
    variant="tool"
    icon="zzz"
    id="suspend"
    hidden={!current.hasOverlay || power.cantRun}
    disabled={!canSnapshot}
    aria-label={t('toolbar:Toolbar.suspend')}
    title={t('toolbar:Toolbar.suspend.title')}
    onclick={() => inBar(() => page.suspend())}
  />
  <span class="sep"></span>
  <Button
    variant="tool"
    labelled
    icon="history-toggle"
    id="save-snapshot"
    disabled={!canSnapshot}
    title={current.id ? t('toolbar:Toolbar.snapshot.title') : t('toolbar:Toolbar.snapshot.title.file')}
    onclick={() => inBar(() => page.takeSnapshot())}
  >
    {t('toolbar:Toolbar.snapshot')}
  </Button>
  <LoadSnapshotMenu />
  <span class="sep"></span>
  <span class="views" role="group" aria-label={t('toolbar:Toolbar.views')}>
    {#each VIEWS as { v, icon, title } (v)}
      <Button
        variant="tool"
        {icon}
        data-view-button={v}
        aria-pressed={screen.view === v}
        aria-label={title}
        {title}
        onclick={() => page.setView(v)}
      />
    {/each}
  </span>
  {#if current.hasGpu}<ScreenMenu />{/if}
  <KeysMenu />
  <MouseMenu />
  <Button
    variant="tool"
    icon="maximize"
    id="fullscreen"
    aria-label={t('toolbar:Toolbar.fullscreen')}
    title={t('toolbar:Toolbar.fullscreen.title')}
    onclick={() => page.fullscreen()}
  />
  <span class="sep"></span>
  <Sound {audio} />
  {#if current.hasNetwork}<Network {net} {split} />{/if}
  {#if usb.on}<UsbMenu />{/if}
  {#if folders.running}<FoldersMenu {folders} />{/if}
  {#if clipboard.on && running}<ClipboardMenu />{/if}
  {#if !current.id}<SizeMenu />{/if}
</header>

<style>
  /* The toolbar: tool buttons (an icon, words on the main ones) in groups. */
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-1);
    padding: var(--space-2) var(--space-3);
    background: var(--surface-bar);
    border-bottom: 1px solid var(--border);
    user-select: none;
  }
  /* Full screen with the status bar (Preferences): the page without its toolbar. */
  :global(body:fullscreen) .toolbar {
    display: none;
  }
  h1 {
    margin: 0 var(--space-3) 0 var(--space-2);
    font-size: var(--text-base);
    font-weight: var(--weight-bold);
    color: var(--text-dim);
    letter-spacing: 0.02em;
  }
  .sep {
    width: 1px;
    height: 22px;
    margin: 0 var(--space-3);
    background: var(--border);
  }
  #machine {
    margin: 0 var(--space-3);
    font-weight: var(--weight-bold);
    font-size: var(--text-md);
    max-width: 28ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .views {
    display: inline-flex;
    gap: var(--space-1);
  }
</style>
