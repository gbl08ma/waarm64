<!--
  The toolbar (docs/frontend.md "The toolbar"): the running machine's quick actions. The Home page holds the rest
  (settings, disks, overlays, snapshots). Icons with tooltips; the main gates (Home, Start) also have their names.
  Each network adapter has its own button where the toolbar keeps to one row with them; where they'd take it onto
  another, one button has them all (Network.svelte `split`).
-->
<script lang="ts">
  import Button from './ui/Button.svelte';
  import Wordmark from './Wordmark.svelte';
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
  import { leaveDemo } from './demo-leave.ts';
  import { clipboard } from './areas/clipboard.svelte.ts';
  import { current } from './areas/current.svelte.ts';
  import { records } from './areas/records.svelte.ts';
  import { isLive, power } from './areas/power.svelte.ts';
  import { screen } from './areas/screen.svelte.ts';
  import { inBar, page } from './page.ts';
  import type { View } from './areas/screen.svelte.ts';
  import { t } from '../i18n.ts';

  // The wordmark: the name's two halves told apart by weight (wa: WebAssembly, dim and lighter; arm64). A drawing of
  // the name, not words from the catalog (which names the heading: the copy editor's marks can't be cut in two).
  /** The Home button, a toggle: Home opened (from the store's page too), or closed, back to the machine. */
  const home = () => (machinesNav.open ? page.closeMachines() : void leaveDemo(() => page.openMachines()));

  let { audio, net, folders }: { audio: PageAudio; net: PageNetwork; folders: PageFolders } = $props();

  const running = $derived(isLive(power.state));
  /** What Start says: start an idle machine, resume a suspended one, retry a failed one, else restart. */
  function startAsOf() {
    if (power.state === 'suspended') return 'resume';
    if (power.state === 'off' || power.state === 'idle') return 'start';
    return power.state === 'failed' ? 'retry' : 'restart';
  }
  const startAs = $derived(startAsOf());
  const START = {
    start: { label: 'toolbar:Toolbar.start', title: 'toolbar:Toolbar.start.title' },
    resume: { label: 'toolbar:Toolbar.resume', title: 'toolbar:Toolbar.resume.title' },
    retry: { label: 'toolbar:Toolbar.retry', title: 'toolbar:Toolbar.retry.title' },
    restart: { label: 'toolbar:Toolbar.restart', title: 'toolbar:Toolbar.restart.title' },
  } as const;
  const canSnapshot = $derived(running && !power.busy);
  /** The machine writes a disk in place: a kept snapshot of it restores only until that disk is written again (said in Snapshot's tooltip). */
  const inPlace = $derived(
    !!records.machines.find((m) => m.id === current.id)?.attachments.some((a) => a.inPlace && !a.readOnly),
  );
  const snapshotTitle = $derived(
    !current.id
      ? t('toolbar:Toolbar.snapshot.title.file')
      : inPlace
        ? t('toolbar:Toolbar.snapshot.title.inPlace')
        : t('toolbar:Toolbar.snapshot.title'),
  );
  /** Power off's tooltip: a request to the guest where its agent takes one, at once while one is pending. */
  const offTitle = $derived(
    power.soft
      ? 'toolbar:Toolbar.powerOff.now.title'
      : power.canSoft
        ? 'toolbar:Toolbar.powerOff.soft.title'
        : 'toolbar:Toolbar.powerOff.title',
  );
  const startTitle = $derived(
    startAs === 'restart' && power.canSoft && !power.soft ? 'toolbar:Toolbar.restart.soft.title' : START[startAs].title,
  );

  /** Each network adapter has its own button (`fits`). */
  let split = $state(true);
  let bar = $state<HTMLElement>();
  /** The adapters' buttons' widths together, as last measured, and how many they were. */
  let measured = { width: 0, count: 0 };
  /**
   * The machine's adapters, as buttons beside the single one's or sections in its menu. None before its first start (no
   * adapter is known yet): no Network button then, like the other menus with nothing to show.
   */
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
  <Wordmark />
  <Button
    variant="tool"
    labelled
    icon="home"
    id="machines-open"
    aria-pressed={machinesNav.open}
    title={machinesNav.open ? t('toolbar:Toolbar.machines.back.title') : t('toolbar:Toolbar.machines.title')}
    onclick={home}
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
    title={t(startTitle)}
    onclick={() => inBar(() => page.restart())}
  >
    {t(START[startAs].label)}
  </Button>
  {#if power.soft && running}<span id="soft-power" role="status"
      >{t(power.soft === 'off' ? 'toolbar:Toolbar.soft.off' : 'toolbar:Toolbar.soft.reboot')}</span
    >{/if}
  <Button
    variant="tool"
    icon="player-stop"
    id="power-off"
    class={power.soft ? 'now' : undefined}
    hidden={power.cantRun || !running}
    disabled={power.busy}
    aria-label={t('toolbar:Toolbar.powerOff')}
    title={t(offTitle)}
    onclick={() => inBar(() => page.powerOffAsked())}
  />
  <Button
    variant="tool"
    icon="zzz"
    id="suspend"
    hidden={!current.canSuspend || power.cantRun}
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
    title={snapshotTitle}
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
  {#if adapters}<Network {net} {split} />{/if}
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
    background: var(--toolbar-bg);
    border-bottom: 1px solid var(--border);
    box-shadow: var(--toolbar-edge);
    font-size: var(--bar-text-base);
    user-select: none;
  }
  /* Full screen with the status bar (Preferences): the page without its toolbar. */
  :global(body:fullscreen) .toolbar {
    display: none;
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
    font-size: var(--bar-text-md);
    max-width: 28ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* A power-off or reboot asked of the guest, pending: said beside the stop button, which then cuts the power. */
  #soft-power {
    margin: 0 var(--space-2);
    color: var(--text-dim);
    font-size: var(--bar-text-sm);
  }
  /* The introduction has a bar of its own, which this one takes the place of when it's left (view-transition.ts). */
  :global(body[data-page='intro']) .toolbar {
    display: none;
  }
  :global(html[data-vt='intro']) .toolbar {
    view-transition-name: page-bar;
  }
  .toolbar :global(#power-off.now) {
    color: var(--danger-fg);
  }
  .views {
    display: inline-flex;
    gap: var(--space-1);
  }
</style>
