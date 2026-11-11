<!--
  The toolbar (docs/frontend.md "The toolbar"): the running machine's quick actions. The Machines page holds the rest
  (settings, disks, overlays, snapshots). Icons with tooltips; the main gates (Machines, Start) also have their names.
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
  import { page, ui, type View } from './ui.svelte.ts';
  import { t } from '../i18n.ts';

  let { audio, net, folders }: { audio: PageAudio; net: PageNetwork; folders: PageFolders } = $props();

  const running = $derived(ui.state === 'running' || ui.state === 'booting');
  /** What Start says: start an idle machine, retry a failed one, else restart. */
  function startAsOf() {
    if (ui.state === 'off' || ui.state === 'idle' || ui.state === 'suspended') return 'start';
    return ui.state === 'failed' ? 'retry' : 'restart';
  }
  const startAs = $derived(startAsOf());
  const START = {
    start: { label: 'toolbar:Toolbar.start', title: 'toolbar:Toolbar.start.title' },
    retry: { label: 'toolbar:Toolbar.retry', title: 'toolbar:Toolbar.retry.title' },
    restart: { label: 'toolbar:Toolbar.restart', title: 'toolbar:Toolbar.restart.title' },
  } as const;
  const canSnapshot = $derived(running && !ui.busy);

  const VIEWS: { v: View; icon: 'device-desktop' | 'terminal-2' | 'layout-columns'; title: string }[] = [
    { v: 'screen', icon: 'device-desktop', title: t('toolbar:Toolbar.view.screen') },
    { v: 'terminal', icon: 'terminal-2', title: t('toolbar:Toolbar.view.terminal') },
    { v: 'both', icon: 'layout-columns', title: t('toolbar:Toolbar.view.both') },
  ];
</script>

<header class="toolbar">
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
  <span id="machine" title={ui.title}>{ui.title}</span>
  <span class="sep"></span>
  <Button
    variant="tool"
    labelled
    icon={startAs === 'restart' ? 'refresh' : 'player-play'}
    id="restart"
    hidden={ui.cantRun}
    disabled={ui.busy}
    title={t(START[startAs].title)}
    onclick={() => page.restart()}
  >
    {t(START[startAs].label)}
  </Button>
  <Button
    variant="tool"
    icon="player-stop"
    id="power-off"
    hidden={ui.cantRun || !running}
    disabled={ui.busy}
    aria-label={t('toolbar:Toolbar.powerOff')}
    title={t('toolbar:Toolbar.powerOff.title')}
    onclick={() => page.powerOffAsked()}
  />
  <Button
    variant="tool"
    icon="zzz"
    id="suspend"
    hidden={!ui.hasOverlay || ui.cantRun}
    disabled={!canSnapshot}
    aria-label={t('toolbar:Toolbar.suspend')}
    title={t('toolbar:Toolbar.suspend.title')}
    onclick={() => page.suspend()}
  />
  <span class="sep"></span>
  <Button
    variant="tool"
    labelled
    icon="history-toggle"
    id="save-snapshot"
    disabled={!canSnapshot}
    title={ui.current ? t('toolbar:Toolbar.snapshot.title') : t('toolbar:Toolbar.snapshot.title.file')}
    onclick={() => page.takeSnapshot()}
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
        aria-pressed={ui.view === v}
        aria-label={title}
        {title}
        onclick={() => page.setView(v)}
      />
    {/each}
  </span>
  {#if ui.hasGpu}<ScreenMenu />{/if}
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
  {#if ui.hasNetwork}<Network {net} />{/if}
  {#if usb.on}<UsbMenu />{/if}
  {#if folders.running}<FoldersMenu {folders} />{/if}
  {#if ui.clipboard.on && running}<ClipboardMenu />{/if}
  {#if !ui.current}<SizeMenu />{/if}
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
