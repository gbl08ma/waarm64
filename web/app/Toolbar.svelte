<!--
  The toolbar (docs/frontend.md "The toolbar"): the running machine's quick actions. The Machines page holds the rest
  (settings, disks, overlays, snapshots). Icons with tooltips; the main gates (Machines, Start) also have their names.
-->
<script lang="ts">
  import Icon from './Icon.svelte';
  import Menu from './Menu.svelte';
  import Network from './Network.svelte';
  import Sound from './Sound.svelte';
  import UsbMenu from './UsbMenu.svelte';
  import type { PageAudio } from '../audio.ts';
  import type { PageNetwork } from './net-live.ts';
  import type { Store, SnapshotRecord } from './store.ts';
  import { remember, settings } from './settings.ts';
  import { page, ui, type View } from './ui.svelte.ts';

  let { store, audio, net }: { store: Store; audio: PageAudio; net: PageNetwork } = $props();

  const running = $derived(ui.state === 'running' || ui.state === 'booting');
  const startLabel = $derived(ui.state === 'off' || ui.state === 'idle' || ui.state === 'suspended' ? 'Start' : ui.state === 'failed' ? 'Retry' : 'Restart');
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

  // A transient machine's size (a stored machine's is in its Settings, on the Machines page).
  let sizeOpen = $state(false);
  let ncpus = $state(ui.size.ncpus), ramMiB = $state(ui.size.ramMiB), gpu = $state(ui.size.gpu);
  // It shows what runs, except while it's open (a choice being made).
  $effect(() => { const [n, r, g] = [ui.size.ncpus, ui.size.ramMiB, ui.size.gpu]; if (!sizeOpen) [ncpus, ramMiB, gpu] = [n, r, g]; });
  const ramText = (n: number) => (n >= 1024 && n % 512 === 0 ? `${n / 1024} GiB` : `${n} MiB`);

  const VIEWS: { v: View; icon: 'device-desktop' | 'terminal-2' | 'layout-columns'; title: string }[] = [
    { v: 'screen', icon: 'device-desktop', title: 'Screen' },
    { v: 'terminal', icon: 'terminal-2', title: 'Serial terminal' },
    { v: 'both', icon: 'layout-columns', title: 'Both' },
  ];
</script>

<header class="toolbar">
  <h1>webpc</h1>
  <button id="machines-open" class="tool labelled" aria-pressed={ui.machinesOpen} title="The machines kept in this browser: their settings, disks, overlays and snapshots" onclick={() => page.openMachines()}>
    <Icon name="server-2" /><span class="label">Machines</span>
  </button>
  <span id="machine" title={ui.title}>{ui.title}</span>
  <span class="sep"></span>
  <button id="restart" class="tool labelled" hidden={ui.cantRun} disabled={ui.busy} title={startLabel === 'Restart' ? 'Restart the machine (like pulling the plug)' : `${startLabel} the machine`} onclick={() => page.restart()}>
    <Icon name={startLabel === 'Restart' ? 'refresh' : 'player-play'} /><span class="label">{startLabel}</span>
  </button>
  <button id="power-off" class="tool" hidden={ui.cantRun || !running} disabled={ui.busy} aria-label="Power off" title="Power off: stop the machine at once, like pulling the plug (shut the guest down first for a clean stop)" onclick={() => page.powerOffAsked()}>
    <Icon name="player-stop" />
  </button>
  <button id="suspend" class="tool" hidden={!ui.hasOverlay || ui.cantRun} disabled={!canSnapshot} aria-label="Suspend" title="Suspend: stop the machine and keep its memory in this browser; the next start, or opening this page again, resumes it where it was" onclick={() => page.suspend()}>
    <Icon name="zzz" />
  </button>
  <span class="sep"></span>
  <button id="save-snapshot" class="tool labelled" disabled={!canSnapshot} title={ui.current ? 'Take a snapshot: the running machine as it is, kept with it in this browser (it pauses for a moment, then runs on)' : 'Take a snapshot: the running machine as it is, to a file (it pauses for a moment, then runs on)'} onclick={() => page.takeSnapshot()}>
    <Icon name="camera" /><span class="label">Snapshot</span>
  </button>
  <Menu id="load-snapshot" icon="history" title="Load a snapshot: the machine as it was when it was taken" bind:open={loadOpen} disabled={ui.busy}>
    {#if ui.current}
      <div class="label">Latest snapshots</div>
      {#each latest as s (s.id)}
        <button data-snapshot={s.id} disabled={s.orphaned} title={s.orphaned ? "Taken of this machine with other settings or disks: it can't be restored onto it" : `Restore ${s.name}`} onclick={() => { loadOpen = false; page.restoreKept(s.id); }}>
          <span>{s.name}</span><span class="dim">{new Date(s.created).toLocaleString()}</span>
        </button>
      {:else}
        <p class="hint">None kept yet: Snapshot keeps one.</p>
      {/each}
      <hr>
      <button onclick={() => { loadOpen = false; page.openMachines('snapshots', ui.current); }}>All snapshots…</button>
    {/if}
    <button onclick={loadFile}>From a file…</button>
  </Menu>
  <span class="sep"></span>
  <span class="views" role="group" aria-label="View">
    {#each VIEWS as { v, icon, title } (v)}
      <button class="tool" data-view-button={v} aria-pressed={ui.view === v} aria-label={title} {title} onclick={() => page.setView(v)}><Icon name={icon} /></button>
    {/each}
  </span>
  {#if ui.hasGpu}
    <Menu id="screen-menu" icon="aspect-ratio" title="The size of the machine's screen" panel>
      <label>Size<select id="screen-size" bind:value={screenSize} onchange={() => { remember({ screen: screenSize }); page.screenSize(); }}>
        <option value="fit">Fit the window</option><option value="1024x768">1024×768</option><option value="1280x800">1280×800</option><option value="1920x1080">1920×1080</option>
      </select></label>
      <label class="row" title="The guest draws in device pixels instead of CSS pixels: sharper on a HiDPI screen, with smaller text unless the desktop scales (its EDID carries the screen's physical size)"><input id="screen-hidpi" type="checkbox" bind:checked={hidpi} onchange={() => { remember({ hidpi }); page.screenSize(); }}> HiDPI</label>
      <p class="hint">A text console (fbcon) keeps the size it started with: a new size takes effect at the next boot (Restart), and the console is centred until then. A desktop takes it when it starts; whether it follows a change is up to its compositor (sway doesn't).</p>
    </Menu>
  {/if}
  <Menu id="keys" icon="keyboard" title="Key combinations the browser keeps for itself, sent to the screen's keyboard" bind:open={keysOpen}>
    <button data-chord="ControlLeft AltLeft Delete" onclick={() => chord('ControlLeft AltLeft Delete')}>Ctrl+Alt+Del</button>
    <div class="label">Ctrl+Alt+</div>
    <div class="fkeys" id="fkeys">
      {#each Array.from({ length: 12 }, (_, k) => k + 1) as k (k)}
        <button data-chord={`ControlLeft AltLeft F${k}`} title={`Ctrl+Alt+F${k}`} aria-label={`Ctrl+Alt+F${k}`} onclick={() => chord(`ControlLeft AltLeft F${k}`)}>F{k}</button>
      {/each}
    </div>
  </Menu>
  <button id="fullscreen" class="tool" aria-label="Full screen" title="Full screen: browser shortcuts (Ctrl+W, Ctrl+T) and Esc go to the machine; hold Esc to leave" onclick={() => page.fullscreen()}><Icon name="maximize" /></button>
  <span class="sep"></span>
  <Sound {audio} />
  {#if ui.hasNetwork}<Network {net} />{/if}
  {#if ui.usb.on}<UsbMenu />{/if}
  {#if !ui.current}
    <Menu id="machine-menu" icon="cpu" title="The number of vCPUs, the size of the RAM and the graphics: applied by a restart" bind:open={sizeOpen} panel>
      <label>Processors<select id="machine-cpus" bind:value={ncpus}>{#each ui.size.cpuChoices as n (n)}<option value={n}>{n} vCPU{n > 1 ? 's' : ''}</option>{/each}</select></label>
      <label>Memory<select id="machine-ram" bind:value={ramMiB}>{#each ui.size.ramChoices as n (n)}<option value={n}>{ramText(n)}</option>{/each}</select></label>
      {#if ui.hasGpu}
        <label id="machine-gpu-label" title="3D gives the guest OpenGL ES through the browser's WebGL2 (virgl); 2D is a plain framebuffer">Graphics<select id="machine-gpu" bind:value={gpu} disabled={!!ui.size.gpuLock} title={ui.size.gpuLock}><option value="3d">3D (WebGL2)</option><option value="2d">2D</option></select></label>
      {/if}
      <button id="machine-apply" onclick={() => { sizeOpen = false; page.applySize(Number(ncpus), Number(ramMiB), gpu); }}>Apply and restart</button>
      <p class="hint">Kept in this browser. A suspended machine resumes with the size it had; Boot instead starts it from its disk with this one.</p>
    </Menu>
  {/if}
</header>
