<!--
  The toolbar (docs/frontend.md "The toolbar"): the running machine's quick actions. The Machines page holds the rest
  (settings, disks, overlays, snapshots). Icons with tooltips; the main gates (Machines, Start) also have their names.
-->
<script lang="ts">
  import Icon from './Icon.svelte';
  import Menu from './Menu.svelte';
  import Check from './Check.svelte';
  import ClipboardMenu from './ClipboardMenu.svelte';
  import FoldersMenu from './FoldersMenu.svelte';
  import Network from './Network.svelte';
  import Sound from './Sound.svelte';
  import UsbMenu from './UsbMenu.svelte';
  import type { PageAudio } from '../audio.ts';
  import type { PageFolders } from './folders-live.ts';
  import type { PageNetwork } from './net-live.ts';
  import type { Store, SnapshotRecord } from './store.ts';
  import { remember, settings } from './settings.ts';
  import { page, ui, type View } from './ui.svelte.ts';
  import { numaNote } from './machine.ts';
  import { t, text } from '../i18n.ts';

  let { store, audio, net, folders }: { store: Store; audio: PageAudio; net: PageNetwork; folders: PageFolders } = $props();

  const running = $derived(ui.state === 'running' || ui.state === 'booting');
  const startAs = $derived(ui.state === 'off' || ui.state === 'idle' || ui.state === 'suspended' ? 'start' : ui.state === 'failed' ? 'retry' : 'restart');
  const START = {
    start: { label: 'toolbar:Toolbar.start', title: 'toolbar:Toolbar.start.title' },
    retry: { label: 'toolbar:Toolbar.retry', title: 'toolbar:Toolbar.retry.title' },
    restart: { label: 'toolbar:Toolbar.restart', title: 'toolbar:Toolbar.restart.title' },
  } as const;
  const canSnapshot = $derived(running && !ui.busy);

  // Load snapshot: the machine's latest kept snapshots (orphaned ones can't restore: shown, disabled), a file, or all of them.
  const LATEST = 5;
  let loadOpen = $state(false);
  let latest = $state<(SnapshotRecord & { orphaned: boolean })[]>([]);
  $effect(() => {
    void ui.records;
    const id = ui.current;
    if (!loadOpen || !id) return;
    void (async () => {
      const m = await store.get('machines', id);
      const now = m ? await page.shapeNow(m).catch(() => undefined) : undefined;
      const kept = (await store.snapshotsOf(id)).sort((a, b) => b.created - a.created).slice(0, LATEST);
      latest = kept.map((s) => ({ ...s, orphaned: !!now && s.shapeHash !== now.hash }));
    })();
  });
  const loadFile = () => { loadOpen = false; document.getElementById('load-snapshot-input')!.click(); };

  // The screen's size (virtio-gpu machines).
  let screenSize = $state([ 'fit', '1024x768', '1280x800', '1920x1080' ].includes(settings().screen ?? '') ? settings().screen! : 'fit');
  let hidpi = $state(settings().hidpi ?? false);

  let keysOpen = $state(false);
  const chord = (keys: string) => { keysOpen = false; page.chord(keys.split(' ')); };
  /** How long Hold Esc holds it (ms): past what a browser asks to leave its full screen (Chromium's keyboard lock, ~2 s). */
  const HOLD_ESC_MS = 3000;
  /** The combinations the Keys menu sends besides Ctrl+Alt+Del and Ctrl+Alt+F1–F12: those a browser or a desktop takes. */
  const COMBOS = [
    { keys: 'Escape', label: 'toolbar:Toolbar.keys.esc', title: 'toolbar:Toolbar.keys.esc.title' },
    { keys: 'ControlLeft KeyW', label: 'toolbar:Toolbar.keys.ctrlW', title: 'toolbar:Toolbar.keys.ctrlW.title' },
    { keys: 'ControlLeft KeyT', label: 'toolbar:Toolbar.keys.ctrlT', title: 'toolbar:Toolbar.keys.ctrlT.title' },
    { keys: 'ControlLeft KeyN', label: 'toolbar:Toolbar.keys.ctrlN', title: 'toolbar:Toolbar.keys.ctrlN.title' },
    { keys: 'ControlLeft KeyQ', label: 'toolbar:Toolbar.keys.ctrlQ', title: 'toolbar:Toolbar.keys.ctrlQ.title' },
    { keys: 'AltLeft F4', label: 'toolbar:Toolbar.keys.altF4', title: 'toolbar:Toolbar.keys.altF4.title' },
    { keys: 'AltLeft Tab', label: 'toolbar:Toolbar.keys.altTab', title: 'toolbar:Toolbar.keys.altTab.title' },
    { keys: 'MetaLeft', label: 'toolbar:Toolbar.keys.super', title: 'toolbar:Toolbar.keys.super.title' },
  ] as const;

  // A transient machine's size (a stored machine's is in its Settings, on the Machines page).
  let sizeOpen = $state(false);
  let ncpus = $state(ui.size.ncpus), ramMiB = $state(ui.size.ramMiB), gpu = $state(ui.size.gpu);
  // It shows what runs, except while it's open (a choice being made).
  $effect(() => { const [n, r, g] = [ui.size.ncpus, ui.size.ramMiB, ui.size.gpu]; if (!sizeOpen) [ncpus, ramMiB, gpu] = [n, r, g]; });
  /** The note for a size past memory 0 (its NUMA nodes); the running split (`?split=`) while the size is unchanged. */
  const numa = $derived(numaNote(Number(ramMiB), Number(ramMiB) === ui.size.ramMiB ? ui.size.split : undefined, ui.size.vulkan));
  const ramText = (n: number) => (n >= 1024 && n % 512 === 0 ? `${n / 1024} GiB` : `${n} MiB`); // i18n-ignore: a size and its unit

  const VIEWS: { v: View; icon: 'device-desktop' | 'terminal-2' | 'layout-columns'; title: string }[] = [
    { v: 'screen', icon: 'device-desktop', title: t('toolbar:Toolbar.view.screen') },
    { v: 'terminal', icon: 'terminal-2', title: t('toolbar:Toolbar.view.terminal') },
    { v: 'both', icon: 'layout-columns', title: t('toolbar:Toolbar.view.both') },
  ];
</script>

<header class="toolbar">
  <h1>{t('toolbar:Toolbar.name')}</h1>
  <button id="machines-open" class="tool labelled" aria-pressed={ui.machinesOpen} title={t('toolbar:Toolbar.machines.title')} onclick={() => page.openMachines()}>
    <Icon name="server-2" /><span class="label">{t('toolbar:Toolbar.machines')}</span>
  </button>
  <span id="machine" title={ui.title}>{ui.title}</span>
  <span class="sep"></span>
  <button id="restart" class="tool labelled" hidden={ui.cantRun} disabled={ui.busy} title={t(START[startAs].title)} onclick={() => page.restart()}>
    <Icon name={startAs === 'restart' ? 'refresh' : 'player-play'} /><span class="label">{t(START[startAs].label)}</span>
  </button>
  <button id="power-off" class="tool" hidden={ui.cantRun || !running} disabled={ui.busy} aria-label={t('toolbar:Toolbar.powerOff')} title={t('toolbar:Toolbar.powerOff.title')} onclick={() => page.powerOffAsked()}>
    <Icon name="player-stop" />
  </button>
  <button id="suspend" class="tool" hidden={!ui.hasOverlay || ui.cantRun} disabled={!canSnapshot} aria-label={t('toolbar:Toolbar.suspend')} title={t('toolbar:Toolbar.suspend.title')} onclick={() => page.suspend()}>
    <Icon name="zzz" />
  </button>
  <span class="sep"></span>
  <button id="save-snapshot" class="tool labelled" disabled={!canSnapshot} title={ui.current ? t('toolbar:Toolbar.snapshot.title') : t('toolbar:Toolbar.snapshot.title.file')} onclick={() => page.takeSnapshot()}>
    <Icon name="history-toggle" /><span class="label">{t('toolbar:Toolbar.snapshot')}</span>
  </button>
  <Menu id="load-snapshot" icon="history" title={t('toolbar:Toolbar.load.title')} bind:open={loadOpen} disabled={ui.busy}>
    {#if ui.current}
      <div class="label">{t('toolbar:Toolbar.load.latest')}</div>
      {#each latest as s (s.id)}
        <button data-snapshot={s.id} disabled={s.orphaned} title={s.orphaned ? t('toolbar:Toolbar.load.orphaned.title') : t('toolbar:Toolbar.load.restore.title', { name: s.name })} onclick={() => { loadOpen = false; page.restoreKept(s.id); }}>
          <span>{s.name}</span><span class="dim">{new Date(s.created).toLocaleString()}</span>
        </button>
      {:else}
        <p class="hint">{t('toolbar:Toolbar.load.none')}</p>
      {/each}
      <hr>
      <button onclick={() => { loadOpen = false; page.openMachines('snapshots', ui.current); }}>{t('toolbar:Toolbar.load.all')}</button>
    {/if}
    <button onclick={loadFile}>{t('toolbar:Toolbar.load.file')}</button>
  </Menu>
  <span class="sep"></span>
  <span class="views" role="group" aria-label={t('toolbar:Toolbar.views')}>
    {#each VIEWS as { v, icon, title } (v)}
      <button class="tool" data-view-button={v} aria-pressed={ui.view === v} aria-label={title} {title} onclick={() => page.setView(v)}><Icon name={icon} /></button>
    {/each}
  </span>
  {#if ui.hasGpu}
    <Menu id="screen-menu" icon="aspect-ratio" title={t('toolbar:Toolbar.screen.title')} panel>
      <label>{t('toolbar:Toolbar.screen.size')}<select id="screen-size" bind:value={screenSize} onchange={() => { remember({ screen: screenSize }); page.screenSize(); }}>
        <option value="fit">{t('toolbar:Toolbar.screen.fit')}</option><option value="1024x768">1024×768</option><option value="1280x800">1280×800</option><option value="1920x1080">1920×1080</option>
      </select></label>
      <Check id="screen-hidpi" bind:checked={hidpi} onchange={() => { remember({ hidpi }); page.screenSize(); }} title={t('toolbar:Toolbar.screen.hidpi.title')}>{t('toolbar:Toolbar.screen.hidpi')}</Check>
      <p class="hint">{t('toolbar:Toolbar.screen.hint')}</p>
    </Menu>
  {/if}
  <Menu id="keys" icon="keyboard" title={t('toolbar:Toolbar.keys.title')} bind:open={keysOpen}>
    <button id="osk-toggle" aria-pressed={ui.osk} title={t('toolbar:Toolbar.keys.osk.title')} onclick={() => { keysOpen = false; page.showOsk(!ui.osk); }}>{ui.osk ? t('toolbar:Toolbar.keys.osk.hide') : t('toolbar:Toolbar.keys.osk')}</button>
    <hr>
    <div class="combos">
      {#each COMBOS as c (c.keys)}
        <button data-chord={c.keys} title={t(c.title)} onclick={() => chord(c.keys)}>{t(c.label)}</button>
      {/each}
      <button id="hold-esc" title={t('toolbar:Toolbar.keys.holdEsc.title')} onclick={() => { keysOpen = false; page.holdKey('Escape', HOLD_ESC_MS); }}>{t('toolbar:Toolbar.keys.holdEsc')}</button>
    </div>
    <button data-chord="ControlLeft AltLeft Delete" onclick={() => chord('ControlLeft AltLeft Delete')}>{t('toolbar:Toolbar.keys.ctrlAltDel')}</button>
    <div class="label">{t('toolbar:Toolbar.keys.ctrlAlt')}</div>
    <div class="fkeys" id="fkeys">
      {#each Array.from({ length: 12 }, (_, k) => k + 1) as k (k)}
        <button data-chord={`ControlLeft AltLeft F${k}`} title={t('toolbar:Toolbar.keys.fkey.title', { n: k })} aria-label={t('toolbar:Toolbar.keys.fkey.title', { n: k })} onclick={() => chord(`ControlLeft AltLeft F${k}`)}>{t('toolbar:Toolbar.keys.fkey', { n: k })}</button>
      {/each}
    </div>
  </Menu>
  <Menu id="mouse-lock" icon="mouse" title={ui.mouseLocked ? t('toolbar:Toolbar.mouse.title.locked') : ui.mouseLock ? t('toolbar:Toolbar.mouse.title.on') : t('toolbar:Toolbar.mouse.title')} data-on={ui.mouseLock || undefined} panel>
    <Check id="mouse-lock-on" checked={ui.mouseLock} onchange={(on) => page.setMouseLock(on)} title={t('toolbar:Toolbar.mouse.lock.title')}>{t('toolbar:Toolbar.mouse.lock')}</Check>
    <label class="row" title={t('toolbar:Toolbar.mouse.pointer.title')}><input type="radio" name="mouse-lock-mode" value="pointer" data-mode="pointer" checked={ui.mouseLockMode === 'pointer'} onchange={() => page.setMouseLock(ui.mouseLock, 'pointer')}> {t('toolbar:Toolbar.mouse.pointer')}</label>
    <label class="row" title={ui.hasMouse ? t('toolbar:Toolbar.mouse.raw.title') : t('toolbar:Toolbar.mouse.raw.title.noMouse')}><input type="radio" name="mouse-lock-mode" value="raw" data-mode="raw" checked={ui.mouseLockMode === 'raw'} disabled={!ui.hasMouse} onchange={() => page.setMouseLock(ui.mouseLock, 'raw')}> {t('toolbar:Toolbar.mouse.raw')}</label>
    <p class="hint">{ui.hasMouse ? t('toolbar:Toolbar.mouse.hint') : t('toolbar:Toolbar.mouse.hint.noMouse')}</p>
  </Menu>
  <button id="fullscreen" class="tool" aria-label={t('toolbar:Toolbar.fullscreen')} title={t('toolbar:Toolbar.fullscreen.title')} onclick={() => page.fullscreen()}><Icon name="maximize" /></button>
  <span class="sep"></span>
  <Sound {audio} />
  {#if ui.hasNetwork}<Network {net} />{/if}
  {#if ui.usb.on}<UsbMenu />{/if}
  {#if ui.folders.on}<FoldersMenu {folders} />{/if}
  {#if ui.clipboard.on && running}<ClipboardMenu />{/if}
  {#if !ui.current}
    <Menu id="machine-menu" icon="cpu" title={t('toolbar:Toolbar.size.title')} bind:open={sizeOpen} panel>
      <label>{t('toolbar:Toolbar.size.cpus')}<select id="machine-cpus" bind:value={ncpus}>{#each ui.size.cpuChoices as n (n)}<option value={n}>{t('toolbar:Toolbar.size.cpu', { count: n })}</option>{/each}</select></label>
      <label>{t('toolbar:Toolbar.size.ram')}<select id="machine-ram" bind:value={ramMiB}>{#each ui.size.ramChoices as n (n)}<option value={n}>{ramText(n)}</option>{/each}</select></label>
      {#if numa}<p class="hint warn" id="machine-numa">{text(numa)}</p>{/if}
      {#if ui.hasGpu}
        <label id="machine-gpu-label" title={t('toolbar:Toolbar.size.gpu.title')}>{t('toolbar:Toolbar.size.gpu')}<select id="machine-gpu" bind:value={gpu} disabled={!!ui.size.gpuLock} title={ui.size.gpuLock}><option value="3d">{t('toolbar:Toolbar.size.gpu.3d')}</option><option value="2d">{t('toolbar:Toolbar.size.gpu.2d')}</option></select></label>
      {/if}
      <button id="machine-apply" onclick={() => { sizeOpen = false; page.applySize(Number(ncpus), Number(ramMiB), gpu); }}>{t('toolbar:Toolbar.size.apply')}</button>
      <p class="hint">{t('toolbar:Toolbar.size.hint')}</p>
    </Menu>
  {/if}
</header>
