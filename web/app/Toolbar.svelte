<!--
  The toolbar (docs/frontend.md "The toolbar"): the running machine's quick actions. The Machines page holds the rest
  (settings, disks, overlays, snapshots). Icons with tooltips; the main gates (Machines, Start) also have their names.
-->
<script lang="ts">
  import Button from './ui/Button.svelte';
  import Field from './ui/Field.svelte';
  import Note from './ui/Note.svelte';
  import Radio from './ui/Radio.svelte';
  import Menu from './ui/Menu.svelte';
  import Check from './ui/Check.svelte';
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

  let { store, audio, net, folders }: { store: Store; audio: PageAudio; net: PageNetwork; folders: PageFolders } =
    $props();

  const running = $derived(ui.state === 'running' || ui.state === 'booting');
  const startAs = $derived(
    ui.state === 'off' || ui.state === 'idle' || ui.state === 'suspended'
      ? 'start'
      : ui.state === 'failed'
        ? 'retry'
        : 'restart',
  );
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
  const loadFile = () => {
    loadOpen = false;
    document.getElementById('load-snapshot-input')!.click();
  };

  // The screen's size (virtio-gpu machines).
  let screenSize = $state(
    ['fit', '1024x768', '1280x800', '1920x1080'].includes(settings().screen ?? '') ? settings().screen! : 'fit',
  );
  let hidpi = $state(settings().hidpi ?? false);

  let keysOpen = $state(false);
  const chord = (keys: string) => {
    keysOpen = false;
    page.chord(keys.split(' '));
  };
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
  let ncpus = $state(ui.size.ncpus),
    ramMiB = $state(ui.size.ramMiB),
    gpu = $state(ui.size.gpu);
  // It shows what runs, except while it's open (a choice being made).
  $effect(() => {
    const [n, r, g] = [ui.size.ncpus, ui.size.ramMiB, ui.size.gpu];
    if (!sizeOpen) [ncpus, ramMiB, gpu] = [n, r, g];
  });
  /** The note for a size past memory 0 (its NUMA nodes); the running split (`?split=`) while the size is unchanged. */
  const numa = $derived(
    numaNote(Number(ramMiB), Number(ramMiB) === ui.size.ramMiB ? ui.size.split : undefined, ui.size.vulkan),
  );
  const ramText = (n: number) => (n >= 1024 && n % 512 === 0 ? `${n / 1024} GiB` : `${n} MiB`); // i18n-ignore: a size and its unit

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
    aria-pressed={ui.machinesOpen}
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
  <Menu
    id="load-snapshot"
    icon="history"
    title={t('toolbar:Toolbar.load.title')}
    bind:open={loadOpen}
    disabled={ui.busy}
  >
    {#if ui.current}
      <div class="heading">{t('toolbar:Toolbar.load.latest')}</div>
      {#each latest as s (s.id)}
        <Button
          variant="item"
          data-snapshot={s.id}
          disabled={s.orphaned}
          title={s.orphaned
            ? t('toolbar:Toolbar.load.orphaned.title')
            : t('toolbar:Toolbar.load.restore.title', { name: s.name })}
          onclick={() => {
            loadOpen = false;
            page.restoreKept(s.id);
          }}
        >
          <span>{s.name}</span><span class="dim">{new Date(s.created).toLocaleString()}</span>
        </Button>
      {:else}
        <div class="hint"><Note>{t('toolbar:Toolbar.load.none')}</Note></div>
      {/each}
      <hr />
      <Button
        variant="item"
        onclick={() => {
          loadOpen = false;
          page.openMachines('snapshots', ui.current);
        }}>{t('toolbar:Toolbar.load.all')}</Button
      >
    {/if}
    <Button variant="item" onclick={loadFile}>{t('toolbar:Toolbar.load.file')}</Button>
  </Menu>
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
  {#if ui.hasGpu}
    <Menu id="screen-menu" icon="aspect-ratio" title={t('toolbar:Toolbar.screen.title')} panel>
      <Field label={t('toolbar:Toolbar.screen.size')}
        ><select
          id="screen-size"
          bind:value={screenSize}
          onchange={() => {
            remember({ screen: screenSize });
            page.screenSize();
          }}
        >
          <option value="fit">{t('toolbar:Toolbar.screen.fit')}</option><option value="1024x768">1024×768</option
          ><option value="1280x800">1280×800</option><option value="1920x1080">1920×1080</option>
        </select></Field
      >
      <Check
        id="screen-hidpi"
        bind:checked={hidpi}
        onchange={() => {
          remember({ hidpi });
          page.screenSize();
        }}
        title={t('toolbar:Toolbar.screen.hidpi.title')}>{t('toolbar:Toolbar.screen.hidpi')}</Check
      >
      <Note>{t('toolbar:Toolbar.screen.hint')}</Note>
    </Menu>
  {/if}
  <Menu id="keys" icon="keyboard" title={t('toolbar:Toolbar.keys.title')} bind:open={keysOpen}>
    <Button
      variant="item"
      id="osk-toggle"
      aria-pressed={ui.osk}
      title={t('toolbar:Toolbar.keys.osk.title')}
      onclick={() => {
        keysOpen = false;
        page.showOsk(!ui.osk);
      }}>{ui.osk ? t('toolbar:Toolbar.keys.osk.hide') : t('toolbar:Toolbar.keys.osk')}</Button
    >
    <hr />
    <div class="combos">
      {#each COMBOS as c (c.keys)}
        <Button variant="item" align="center" data-chord={c.keys} title={t(c.title)} onclick={() => chord(c.keys)}
          >{t(c.label)}</Button
        >
      {/each}
      <Button
        variant="item"
        align="center"
        id="hold-esc"
        title={t('toolbar:Toolbar.keys.holdEsc.title')}
        onclick={() => {
          keysOpen = false;
          page.holdKey('Escape', HOLD_ESC_MS);
        }}>{t('toolbar:Toolbar.keys.holdEsc')}</Button
      >
    </div>
    <Button variant="item" data-chord="ControlLeft AltLeft Delete" onclick={() => chord('ControlLeft AltLeft Delete')}
      >{t('toolbar:Toolbar.keys.ctrlAltDel')}</Button
    >
    <div class="heading">{t('toolbar:Toolbar.keys.ctrlAlt')}</div>
    <div class="fkeys" id="fkeys">
      {#each Array.from({ length: 12 }, (_, k) => k + 1) as k (k)}
        <Button
          variant="item"
          align="center"
          data-chord={`ControlLeft AltLeft F${k}`}
          title={t('toolbar:Toolbar.keys.fkey.title', { n: k })}
          aria-label={t('toolbar:Toolbar.keys.fkey.title', { n: k })}
          onclick={() => chord(`ControlLeft AltLeft F${k}`)}>{t('toolbar:Toolbar.keys.fkey', { n: k })}</Button
        >
      {/each}
    </div>
  </Menu>
  <Menu
    id="mouse-lock"
    icon="mouse"
    title={ui.mouseLocked
      ? t('toolbar:Toolbar.mouse.title.locked')
      : ui.mouseLock
        ? t('toolbar:Toolbar.mouse.title.on')
        : t('toolbar:Toolbar.mouse.title')}
    on={ui.mouseLock}
    panel
  >
    <Check
      id="mouse-lock-on"
      checked={ui.mouseLock}
      onchange={(on) => page.setMouseLock(on)}
      title={t('toolbar:Toolbar.mouse.lock.title')}>{t('toolbar:Toolbar.mouse.lock')}</Check
    >
    <Radio
      name="mouse-lock-mode"
      value="pointer"
      data-mode="pointer"
      title={t('toolbar:Toolbar.mouse.pointer.title')}
      checked={ui.mouseLockMode === 'pointer'}
      onchange={() => page.setMouseLock(ui.mouseLock, 'pointer')}>{t('toolbar:Toolbar.mouse.pointer')}</Radio
    >
    <Radio
      name="mouse-lock-mode"
      value="raw"
      data-mode="raw"
      title={ui.hasMouse ? t('toolbar:Toolbar.mouse.raw.title') : t('toolbar:Toolbar.mouse.raw.title.noMouse')}
      checked={ui.mouseLockMode === 'raw'}
      disabled={!ui.hasMouse}
      onchange={() => page.setMouseLock(ui.mouseLock, 'raw')}>{t('toolbar:Toolbar.mouse.raw')}</Radio
    >
    <Note>{ui.hasMouse ? t('toolbar:Toolbar.mouse.hint') : t('toolbar:Toolbar.mouse.hint.noMouse')}</Note>
  </Menu>
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
  {#if ui.usb.on}<UsbMenu />{/if}
  {#if ui.folders.on}<FoldersMenu {folders} />{/if}
  {#if ui.clipboard.on && running}<ClipboardMenu />{/if}
  {#if !ui.current}
    <Menu id="machine-menu" icon="cpu" title={t('toolbar:Toolbar.size.title')} bind:open={sizeOpen} panel>
      <Field label={t('toolbar:Toolbar.size.cpus')}
        ><select id="machine-cpus" bind:value={ncpus}
          >{#each ui.size.cpuChoices as n (n)}<option value={n}>{t('toolbar:Toolbar.size.cpu', { count: n })}</option
            >{/each}</select
        ></Field
      >
      <Field label={t('toolbar:Toolbar.size.ram')}
        ><select id="machine-ram" bind:value={ramMiB}
          >{#each ui.size.ramChoices as n (n)}<option value={n}>{ramText(n)}</option>{/each}</select
        ></Field
      >
      {#if numa}<Note tone="warn" id="machine-numa">{text(numa)}</Note>{/if}
      {#if ui.hasGpu}
        <Field id="machine-gpu-label" title={t('toolbar:Toolbar.size.gpu.title')} label={t('toolbar:Toolbar.size.gpu')}
          ><select id="machine-gpu" bind:value={gpu} disabled={!!ui.size.gpuLock} title={ui.size.gpuLock}
            ><option value="3d">{t('toolbar:Toolbar.size.gpu.3d')}</option><option value="2d"
              >{t('toolbar:Toolbar.size.gpu.2d')}</option
            ></select
          ></Field
        >
      {/if}
      <Button
        id="machine-apply"
        onclick={() => {
          sizeOpen = false;
          page.applySize(Number(ncpus), Number(ramMiB), gpu);
        }}>{t('toolbar:Toolbar.size.apply')}</Button
      >
      <Note>{t('toolbar:Toolbar.size.hint')}</Note>
    </Menu>
  {/if}
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
  /* In the menus: a group's heading, a snapshot's date, a hint in a list, the keys' grids. */
  .heading {
    padding: var(--space-3) var(--space-4) var(--space-1);
    color: var(--text-dim);
    font-size: var(--text-sm);
  }
  .dim {
    color: var(--text-dim);
    font-size: var(--text-sm);
  }
  .hint {
    max-width: 280px;
    padding: var(--space-2) var(--space-4);
  }
  .combos {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
  }
  .fkeys {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
  }
</style>
