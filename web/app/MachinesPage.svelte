<!--
  The Machines page (docs/machines.md §7): it takes the machine's place on the page (which runs on behind it).
  The machines kept in this browser (new, from a disk image, import a definition), and one machine: open it here,
  duplicate, export its definition, delete; its Settings, Disks and Snapshots as tabs. A transient machine (a test's
  `?machine=`) is listed as this page's, with its disk's and snapshots' actions. The browser's network connections
  (docs/network-adapters.md §3.1) under Connections, and the browser's storage at the bottom.
  Logic is in web/app/machines.ts, disks.ts and main.ts (`page`); every action that loses data asks first.
-->
<script lang="ts">
  import Disks from './Disks.svelte';
  import Icon from './Icon.svelte';
  import Menu from './Menu.svelte';
  import Check from './Check.svelte';
  import Snapshots from './Snapshots.svelte';
  import StatusEditor from './StatusEditor.svelte';
  import Usb from './Usb.svelte';
  import UsbProblems from './UsbProblems.svelte';
  import { ask } from './ask.svelte.ts';
  import { machineDir, type Store, type OverlayRecord } from './store.ts';
  import { suspended as suspendedCopy } from '../overlay.ts';
  import type { Connection } from './connections.ts';
  import Folders from './Folders.svelte';
  import FoldersPane from './FoldersPane.svelte';
  import type { PageFolders } from './folders-live.ts';
  import { DEFAULT_SHARES_PATH, sharesPathError } from './shares-mount.ts';
  import type { PageNetwork } from './net-live.ts';
  import { adaptersOf, MAX_ADAPTERS, type DiskRecord, type MachineRecord } from './shape.ts';
  import { clearCaches } from '../diskcache.ts';
  import { askPersist, bytesText, createMachine, deleteMachine, duplicateMachine, isRunning, storageReport, updateMachine, withAdapter, withoutAdapter } from './machines.ts';
  import { exportDefinition, importDefinition, parseDefinition } from './definitions.ts';
  import { leaveWarning, remember, settings } from './settings.ts';
  import { page, ui, type MachinesTab } from './ui.svelte.ts';
  import { errorView, type ErrorView } from './usb-ports.ts';
  import { browserLayout, FOLLOW_BROWSER, KEYBOARD_LAYOUTS } from './keyboard.ts';
  import { JIT_CHOICES, JIT_DEFAULT_MIB, MEMORY0_MIB, numaNote, RAM_CHOICES, ramSplitError, ramSplitMiB } from './machine.ts';

  let { store, net, folders }: { store: Store; net: PageNetwork; folders: PageFolders } = $props();

  let machines = $state<MachineRecord[]>([]);
  let disks = $state<Map<string, DiskRecord>>(new Map());
  let overlays = $state<OverlayRecord[]>([]);
  let running = $state<Set<string>>(new Set());
  /** The machines with a suspended copy (Start resumes them). */
  let suspended = $state<Set<string>>(new Set());
  let draft = $state<MachineRecord | undefined>();
  let error = $state('');
  /** A USB attach's problems, shown under `error` while it is theirs (`text`). */
  let usbError = $state<ErrorView>();
  let busy = $state('');
  let storage = $state<Awaited<ReturnType<typeof storageReport>> | undefined>();
  /** The page's own machine (transient) is chosen: `ui.machinesSelected` is `page`; the connections: `connections`. */
  const PAGE = 'page';
  const CONNECTIONS = 'connections';
  const FOLDERS = 'folders';
  /** The page's preferences (this browser's, for every machine). */
  const PREFERENCES = 'preferences';
  let warnOnLeave = $state(leaveWarning());
  let catchUpClock = $state(settings().clockSync !== false);

  const CPU_CHOICES = [1, 2, 3, 4, 6, 8];
  /** This browser offers WebGPU (a Vulkan machine's renderer draws on it; without it, Vulkan programs draw nothing). */
  const hasWebgpu = typeof navigator !== 'undefined' && 'gpu' in navigator;

  async function reread() {
    machines = (await store.all('machines')).sort((a, b) => a.name.localeCompare(b.name));
    disks = new Map((await store.all('disks')).map((d) => [d.id, d]));
    overlays = await store.all('overlays');
    running = new Set((await Promise.all(machines.map(async (m) => ((await isRunning(m.id)) ? m.id : '')))).filter(Boolean));
    suspended = new Set((await Promise.all(machines.map(async (m) => ((await suspendedCopy(machineDir(m.id)).catch(() => undefined)) ? m.id : '')))).filter(Boolean));
    if (ui.machinesSelected === undefined) ui.machinesSelected = ui.current ?? (ui.transient ? PAGE : undefined);
    if (ui.machinesSelected !== PAGE && ui.machinesSelected !== CONNECTIONS && ui.machinesSelected !== FOLDERS && ui.machinesSelected !== PREFERENCES && ui.machinesSelected && !machines.some((m) => m.id === ui.machinesSelected)) ui.machinesSelected = undefined;
    const m = machines.find((x) => x.id === ui.machinesSelected);
    // The draft follows the record, unless the user is editing its settings.
    if (!m || !draft || draft.id !== m.id || !dirty) draft = m ? structuredClone($state.snapshot(m)) as MachineRecord : undefined;
    storage = await storageReport(store).catch(() => undefined);
  }
  // Read now, again when a record changes (in any tab), and when the machine on this page starts or stops (its "running").
  $effect(() => store.onChange(() => void reread()));
  $effect(() => { void ui.state; void ui.records; void reread(); });

  /** Runs an action, showing what it's doing and any error; rereads after. */
  async function act(what: string, f: () => Promise<unknown>) {
    error = '';
    busy = what;
    try {
      await f();
    } catch (e) {
      usbError = errorView(e);
      error = usbError.text;
    } finally {
      busy = '';
      await reread();
    }
  }

  const choose = (id: string) => { ui.machinesSelected = id; dirty = false; void reread(); };
  const tab = (t: MachinesTab) => { ui.machinesTab = t; };
  /** A machine as a plain object (the draft is reactive state, which IndexedDB can't clone). */
  const plain = (m: MachineRecord) => $state.snapshot(m) as MachineRecord;
  const isOn = (id: string) => running.has(id);
  /** Running, suspended or off. */
  const stateText = (id: string) => (isOn(id) ? 'running' : suspended.has(id) ? 'suspended' : 'off');

  /** Powers machine `m` off, after asking, before an edit that needs it off; false if it can't be (or the user says no). */
  async function offFirst(m: MachineRecord) {
    if (!isOn(m.id)) return true;
    if (m.id !== ui.current) { error = 'It runs in another tab: power it off there first.'; return false; }
    if (!(await ask.confirm(`Power ${m.name} off? Like pulling the plug: unsaved work in the guest is lost.`, { ok: 'Power off', danger: true }))) return false;
    await page.powerOff();
    await reread();
    return true;
  }

  // Settings.
  let dirty = $state(false);
  const shapeChanged = (a: MachineRecord, b: MachineRecord) => a.ramMiB !== b.ramMiB || (a.ramSplit ?? []).join() !== (b.ramSplit ?? []).join() || a.ncpus !== b.ncpus || a.display !== b.display || !!a.vulkan !== !!b.vulkan || adaptersOf(a).map((x) => x.mac).join() !== adaptersOf(b).map((x) => x.mac).join() || !!a.usb !== !!b.usb || !!a.mouse !== !!b.mouse || !!a.touch !== !!b.touch || !!a.clock !== !!b.clock || !!a.shares !== !!b.shares;
  /** What takes a restart: the shape, and the JIT's budget (the guest doesn't see it: no snapshot is orphaned). */
  const restartChanged = (a: MachineRecord, b: MachineRecord) => shapeChanged(a, b) || (a.jitMiB ?? 0) !== (b.jitMiB ?? 0);
  async function saveSettings() {
    const m = plain(draft!);
    if (!m.jitMiB) delete m.jitMiB;
    if (!m.keyboard) delete m.keyboard;
    if (m.netConfig !== false) delete m.netConfig;
    if (!m.shares) delete m.shares;
    if (m.sharesMount !== false) delete m.sharesMount;
    if (!m.sharesPath) delete m.sharesPath;
    await act('Saving', async () => {
      if (m.sharesPath && sharesPathError(m.sharesPath)) throw new Error(sharesPathError(m.sharesPath));
      const was = machines.find((x) => x.id === m.id)!;
      if (shapeChanged(was, m) && (await store.snapshotsOf(m.id)).length && !(await ask.confirm('This change orphans its snapshots: they were taken of a machine with the old settings (they stay, marked, until deleted).', { ok: 'Save' }))) return;
      // The machine on this page, running: it restarts with them (the page asks).
      if (restartChanged(was, m) && m.id === ui.current && isOn(m.id)) return page.saveSettings(m);
      if (restartChanged(was, m) && isOn(m.id)) throw new Error('It runs in another tab: power it off there first.');
      await updateMachine(store, m);
    });
    dirty = false;
  }
  // The keyboard layout: "Match this browser" picks the one the browser reports (web/app/keyboard.ts), for the user to save.
  let keyboardNote = $state('');
  /** What this browser reports now, for the note of a machine that follows it. */
  let browserNow = $state<string | undefined>();
  browserLayout().then((l) => (browserNow = l?.label), () => {});
  async function matchKeyboard() {
    const l = await browserLayout();
    if (l) { draft!.keyboard = l.id; dirty = true; }
    keyboardNote = l ? `This browser's keyboard looks like ${l.label}: save to use it.` : "This browser doesn't say which layout its keyboard has (only Chromium-based browsers do), or it isn't one in the list: pick it yourself.";
  }
  // The RAM's split, set by hand (the advanced section; docs/spill-memories.md): memory 0, then the NUMA nodes past it, MiB.
  let splitProblem = $state('');
  let ram0Input = $state<HTMLInputElement>();
  let nodesInput = $state<HTMLInputElement>();
  function customSplit(on: boolean) {
    draft!.ramSplit = on ? ramSplitMiB(draft!.ramMiB, undefined, !!draft!.vulkan) : undefined;
    splitProblem = '';
    dirty = true;
  }
  /** Takes the two fields: a valid split sets the RAM to its sum, else says what's wrong (and Save waits). */
  function editSplit() {
    const split = [Number(ram0Input!.value), ...nodesInput!.value.split(',').map((x) => x.trim()).filter(Boolean).map(Number)];
    splitProblem = ramSplitError(split, !!draft!.vulkan) ?? '';
    if (!splitProblem) [draft!.ramSplit, draft!.ramMiB] = [split, split.reduce((a, b) => a + b, 0)];
    dirty = true;
  }
  const restartsToSave = $derived(!!draft && draft.id === ui.current && isOn(draft.id) && (() => { const was = machines.find((x) => x.id === draft!.id); return !!was && restartChanged(was, draft!); })());

  // Definitions in and out (§6): the machine's shape as a small file; disks that are files are picked again at its first start.
  async function exportDef(m: MachineRecord) {
    await act('Exporting', async () => {
      const def = await exportDefinition(store, m.id);
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([JSON.stringify(def, null, 2)], { type: 'application/json' })), download: `${m.name.replace(/[^\w.-]+/g, '-')}.webpc-machine.json` });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
    });
  }
  let defInput: HTMLInputElement;
  const importDef = () => {
    const f = defInput.files?.[0];
    defInput.value = '';
    if (f) void act('Importing', async () => {
      const r = await importDefinition(store, parseDefinition(await f.text()));
      ui.machinesSelected = r.machine.id;
      if (r.toPick.length) error = `${r.machine.name} is made. Its files are picked when it first starts: ${r.toPick.join(', ')}.`;
    });
  };
  async function remove(m: MachineRecord) {
    if (await ask.confirm(`Delete ${m.name}? Its snapshots and firmware settings are deleted; its disks and their overlays stay.`, { ok: 'Delete', danger: true })) await act('Deleting', () => deleteMachine(store, m.id));
  }

  // The network: each adapter's connection (the record's: attached while the machine runs too), and the browser's connections.
  const conns = $derived((void ui.net, net.connections));
  const live = $derived((void ui.net, net.views()));
  const kindText = (c: Connection) => `${c.kind === 'tailnet' ? `a tailnet (${new URL(c.tailnet!.controlURL).host})` : c.tailcat?.exit ? 'tailcat through a server' : 'tailcat, letting clients in'}${c.ephemeral ? ', ephemeral (not kept)' : ''}`;
  /** Who has connection `c` now: an adapter here, a machine in another tab, or no one. */
  const stateOf = (c: Connection) => (net.runs(c.id) >= 0 ? 'connected on this page' : net.held.has(c.id) ? 'in use in another tab' : 'not in use');
  const usedBy = (c: Connection) => [...machines.filter((m) => m.adapters?.some((a) => a.connection === c.id)).map((m) => m.name), ...(settings().transientNet === c.id && ui.transient ? [ui.transient.label] : [])];
  async function setAtStart(c: Connection, on: boolean) {
    await net.conns.put({ ...c, connectAtStart: on });
    await net.refresh();
  }
  async function logoutConnection(c: Connection) {
    if (!(await ask.confirm(`Log ${c.name} out? Its node is removed from the tailnet and its keys are forgotten here; connecting again logs in as a new node.`, { ok: 'Log out', danger: true }))) return;
    await act('Logging out', () => page.netLogout(net.runs(c.id)));
  }

  // The page's own disk (a transient machine): its export's options.
  let compress = $state(settings().compress ?? true);
  let pageExportOpen = $state(false);
  const savePage = (mode: 'changes' | 'qcow2' | 'raw') => { pageExportOpen = false; page.saveDisk(mode, mode !== 'raw' && compress); };
</script>

{#snippet usbSwitch()}
  {#if draft}
    <Check bind:checked={draft.usb} field="usb" title="An xHCI with four connectors (USB 2 and USB 3 each) for the machine's USB devices: the guest sees it, so turning it on or off changes the machine's shape">USB controller</Check>
    {#if !!draft.usb !== !!machines.find((x) => x.id === draft?.id)?.usb}<p class="note warn" data-usb-orphans>Turning the USB controller {draft.usb ? 'on' : 'off'} changes the machine's shape: the snapshots taken before are orphaned (they stay, marked, until deleted), as a RAM change does.</p>{/if}
  {/if}
{/snippet}

{#snippet vulkanSwitch()}
  {#if draft && draft.display === '3d'}
    <Check bind:checked={draft.vulkan} field="vulkan" title="Vulkan through Venus beside 3D: the guest's Vulkan programs draw on this browser's WebGPU (what the guest is offered follows its GPU). Experimental: snapshots can't be taken while a program uses it. The guest sees it, so turning it on or off changes the machine's shape">Vulkan (WebGPU, experimental)</Check>
    {#if !!draft.vulkan !== !!machines.find((x) => x.id === draft?.id)?.vulkan}<p class="note warn" data-vulkan-orphans>Turning Vulkan {draft.vulkan ? 'on' : 'off'} changes the machine's shape: the snapshots taken before are orphaned (they stay, marked, until deleted), as a RAM change does.{draft.vulkan && !hasWebgpu ? ' This browser has no WebGPU: its Vulkan programs would draw nothing here.' : ''}</p>{/if}
  {/if}
{/snippet}

{#snippet pointerSwitches()}
  {#if draft}
    {@const rec = machines.find((x) => x.id === draft?.id)}
    <Check bind:checked={draft.mouse} field="mouse" title="A relative mouse (virtio-input) for the mouse lock's Raw mode: while the screen holds the mouse its motion goes to the guest unbounded by the screen (games), at the guest's own mouse speed. Without it the lock has the Pointer mode only. The guest sees it, so turning it on or off changes the machine's shape">Mouse (the mouse lock's Raw mode)</Check>
    <Check bind:checked={draft.touch} field="touch" title="A touchscreen (virtio-input, multitouch): the page's touches go to the guest as touches. Without it a touch moves the pointer and clicks. The guest sees it, so turning it on or off changes the machine's shape">Touchscreen</Check>
    <Check bind:checked={draft.clock} field="clock" title="A clock device (virtio-rtc) that reads the browser's clock: a guest with a driver for it (Linux 6.16 and later) gets a PTP clock that chrony can follow (refclock PHC), so its time stays the browser's across snapshots and the host's sleep, and a read-only RTC. The guest sees it, so turning it on or off changes the machine's shape">Clock device (the browser's time)</Check>
    {#if !!draft.mouse !== !!rec?.mouse || !!draft.touch !== !!rec?.touch || !!draft.clock !== !!rec?.clock}<p class="note warn" data-pointer-orphans>Adding or removing the mouse, the touchscreen or the clock device changes the machine's shape: the snapshots taken before are orphaned (they stay, marked, until deleted), as a RAM change does.</p>{/if}
  {/if}
{/snippet}

{#snippet saveRow()}
  <div class="row"><button class="primary" onclick={saveSettings} data-action="save" disabled={!dirty || !!splitProblem}>{restartsToSave ? 'Save and restart' : 'Save'}</button>
    {#if dirty}<button onclick={() => { dirty = false; void reread(); }}>Revert</button>{/if}</div>
{/snippet}

<div class="machines" data-busy={busy || undefined}>
  <div class="bar">
    <button class="tool labelled" onclick={() => page.closeMachines()} data-action="back" title="Back to the machine"><Icon name="arrow-left" /><span class="label">Back to the machine</span></button>
    <h2>Machines</h2>
    {#if busy}<span class="busy">{busy}…</span>{/if}
  </div>
  {#if error}<div class="error" role="alert"><div class="text">{error}{#if usbError?.words && usbError.text === error}<UsbProblems words={usbError.words} />{/if}</div><button class="dismiss" aria-label="Close" onclick={() => (error = '')}><Icon name="x" size={14} /></button></div>{/if}
  <div class="panes">
    <nav>
      <ul>
        {#if ui.transient}
          <li class:chosen={ui.machinesSelected === PAGE}>
            <button class="pick" onclick={() => choose(PAGE)} data-machine={PAGE}>
              <span class="name">{ui.transient.label}</span>
              <span class="meta">this page's machine (from its address, not kept)</span>
            </button>
          </li>
        {/if}
        {#each machines as m (m.id)}
          <li class:chosen={m.id === ui.machinesSelected}>
            <button class="pick" onclick={() => choose(m.id)} data-machine={m.id}>
              <span class="name">{m.name}</span>
              <span class="meta">{m.attachments.length} disk{m.attachments.length === 1 ? '' : 's'} · {isOn(m.id) || suspended.has(m.id) || m.id !== ui.current ? stateText(m.id) : 'on this page'}</span>
            </button>
          </li>
        {/each}
      </ul>
      <div class="new">
        <button onclick={() => act('Making a machine', async () => { choose((await createMachine(store)).id); })} data-action="new-machine"><Icon name="plus" size={16} />New machine</button>
        {#if ui.firmware}<button onclick={() => page.openDisk()} title="A machine for a disk image on this computer (qcow2, raw or an ISO), started at once: the same as dropping the file on the page"><Icon name="file" size={16} />From a disk image…</button>{/if}
        <button onclick={() => defInput.click()} title="A machine definition (.webpc-machine.json): its settings and disks, without their contents"><Icon name="file-import" size={16} />Import a definition…</button>
        <input type="file" accept=".json,application/json" hidden bind:this={defInput} onchange={importDef} data-field="import-definition">
      </div>
      <div class="new">
        <button class:chosen={ui.machinesSelected === FOLDERS} onclick={() => choose(FOLDERS)} data-machine={FOLDERS} title="The shared folders this browser keeps, for any machine"><Icon name="folder" size={16} />Shared folders ({(void ui.folders.tick, folders.folders.length)})</button>
        <button class:chosen={ui.machinesSelected === CONNECTIONS} onclick={() => choose(CONNECTIONS)} data-machine={CONNECTIONS} title="The network connections this browser keeps (tailnets, tailcat), for any machine's adapters"><Icon name="network" size={16} />Connections ({conns.length})</button>
        <button class:chosen={ui.machinesSelected === PREFERENCES} onclick={() => choose(PREFERENCES)} data-machine={PREFERENCES} title="How the page behaves in this browser, for every machine"><Icon name="adjustments-horizontal" size={16} />Preferences</button>
      </div>
    </nav>

    {#if ui.machinesSelected === PREFERENCES}
      <section class="machine" data-selected={PREFERENCES}>
        <div class="head">
          <span class="title"><h3>Preferences</h3>
          <span class="meta">Kept by this browser, for every machine.</span></span>
        </div>
        <div class="tab settings">
          <Check bind:checked={warnOnLeave} onchange={() => remember({ leaveWarning: warnOnLeave })} field="leave-warning"
            note="Leaving the page (closing the tab, reloading it, going elsewhere) stops its machine like pulling the plug: unsaved work in the guest is lost. With this on, the browser asks first, in its own words. Suspend keeps a machine to come back to.">Ask before leaving the page while a machine runs</Check>
          <Check bind:checked={catchUpClock} onchange={() => remember({ clockSync: catchUpClock })} field="clock-sync"
            note="Snapshot and Suspend first press the guest's sleep key, so the guest suspends itself (as a laptop does when its lid closes) and is woken once the file is written; loading the file wakes it the same way, so its clock catches up with the time the file sat. A guest that doesn't sleep on the key (no systemd-logind) is saved as it is, after waiting up to 10 s. Off, a snapshot is a pause the guest can hardly tell, and its clock lags until something sets it.">Suspend the guest before taking a snapshot</Check>
        </div>
        <div class="tab">
          <h4>Status bar</h4>
          <StatusEditor {net} />
          <div class="settings status-fullscreen">
            <Check bind:checked={ui.statusFullscreen} onchange={() => remember({ statusFullscreen: ui.statusFullscreen })} field="status-fullscreen"
              note="Off, full screen is the machine alone, edge to edge; on, the bar comes along (its Keyboard element says there whether the browser's shortcuts reach the machine).">Show the status bar in full screen</Check>
          </div>
        </div>
      </section>
    {:else if ui.machinesSelected === FOLDERS}
      <section class="machine" data-selected={FOLDERS}>
        <div class="head">
          <span class="title"><h3>Shared folders</h3>
          <span class="meta">Kept by this browser for any machine; one that writes a folder has it alone.</span></span>
          <span class="grow"></span>
          <button onclick={() => page.folderWizard(undefined, [])} data-action="new-folder"><Icon name="plus" size={16} />New folder…</button>
        </div>
        <div class="tab"><FoldersPane {folders} {store} {act} /></div>
      </section>
    {:else if ui.machinesSelected === CONNECTIONS}
      <section class="machine" data-selected={CONNECTIONS}>
        <div class="head">
          <span class="title"><h3>Connections</h3>
          <span class="meta">Kept by this browser for any machine's adapters; one running machine has a connection at a time.</span></span>
          <span class="grow"></span>
          <button onclick={() => page.netWizard({ mode: 'new' })} data-action="new-connection"><Icon name="plus" size={16} />New connection…</button>
        </div>
        <div class="tab">
          <ul class="adapters connections">
            {#each conns as c (c.id)}
              <li data-connection={c.id}>
                <Icon name="network" size={18} />
                <div class="what">
                  <input class="conn-name" value={c.name} aria-label="Name" data-field="connection-name" onchange={(e) => { const name = e.currentTarget.value; void act('Renaming', () => page.netRename(c, name)); }}>
                  <span class="meta">{kindText(c)} · {stateOf(c)} · {usedBy(c).length ? `attached to ${usedBy(c).join(', ')}` : 'attached to no machine'}</span>
                </div>
                <button onclick={() => page.netWizard({ mode: 'edit', connection: c.id })} data-action="edit-connection" title={c.kind === 'tailnet' ? 'Its hostname (another control server is another connection)' : 'Its server and relay'}>Edit…</button>
                {#if c.tailcat?.serve}<button onclick={() => act('Forgetting the address', () => page.netNewAddress(c))} data-action="new-address" title="Forget the connection's tailcat address: whoever has it can't come in any more">New address</button>{/if}
                {#if c.kind === 'tailnet' && net.runs(c.id) >= 0}<button onclick={() => logoutConnection(c)} data-action="logout-connection" title="Remove the node from the tailnet and forget its keys">Log out</button>{/if}
                <button onclick={() => act('Deleting', () => page.netDelete(c))} data-action="delete-connection" title="Delete the connection and what this browser keeps of it (its machines lose it)"><Icon name="trash" size={16} />Delete</button>
              </li>
            {:else}
              <li class="none">No connections yet: make one here, or from a machine's adapter (its Network tab, or the toolbar's Network menu).</li>
            {/each}
          </ul>
        </div>
      </section>
    {:else if ui.machinesSelected === PAGE && ui.transient}
      <section class="machine" data-selected={PAGE}>
        <div class="head"><span class="title"><h3>{ui.transient.label}</h3><span class="meta">This page's machine, from its address: its size is in the toolbar's Machine menu.</span></span></div>
        <div class="tabs" role="tablist">
          <button role="tab" aria-selected={ui.machinesTab !== 'snapshots'} onclick={() => tab('disks')} data-tab="disks"><Icon name="database" size={16} />Disks</button>
          <button role="tab" aria-selected={ui.machinesTab === 'snapshots'} onclick={() => tab('snapshots')} data-tab="snapshots"><Icon name="history" size={16} />Snapshots</button>
        </div>
        {#if ui.machinesTab !== 'snapshots'}
          <div class="tab">
            <div class="disk" data-attachment={PAGE}>
              <div class="row"><Icon name="database" size={18} /><strong>{ui.transient.disk}</strong>
                {#if ui.hasOverlay}<span class="meta">its changes are kept in this browser</span>{/if}</div>
              {#if ui.hasOverlay}
                <div class="row actions">
                  <Menu id="save" icon="download" title="Save the disk to a file: the machine stops while it's written" label="Export" bind:open={pageExportOpen} align="left">
                    <button data-save="changes" title="A small qcow2 holding what the machine wrote, with the image it booted as its backing file (kept beside it)" onclick={() => savePage('changes')}>Changes only (qcow2)</button>
                    <button data-save="qcow2" title="The whole disk as a qcow2 (empty space left out)" onclick={() => savePage('qcow2')}>Whole disk (qcow2)</button>
                    <button data-save="raw" title="The whole disk as a raw image" onclick={() => savePage('raw')}>Whole disk (raw)</button>
                    <Check id="save-compress" bind:checked={compress} onchange={() => remember({ compress })} title="Compressed clusters (deflate), as qemu-img convert -c writes them: the file is about half the size and takes longer to write">Compress the qcow2</Check>
                    <p class="hint">The machine stops while the file is written, as if its plug were pulled: shut it down first (<code>poweroff</code>) for a clean disk.</p>
                  </Menu>
                  <button onclick={() => document.getElementById('load-changes-input')!.click()} title="Put the changes of a saved changes file onto this disk (the disk it was made over must be this one)"><Icon name="upload" size={16} />Import changes…</button>
                  <button id="reset-disk" disabled={ui.busy} onclick={() => page.resetDisk()} title="Delete what the machine wrote to its disk and boot from the image again"><Icon name="trash" size={16} />Reset disk…</button>
                </div>
              {/if}
            </div>
          </div>
        {:else}
          <div class="tab"><Snapshots {store} {act} /></div>
        {/if}
      </section>
    {:else if draft}
      {@const m = draft}
      <section class="machine" data-selected={m.id}>
        <div class="head">
          <span class="title"><h3>{m.name}</h3>
          <span class="meta" data-machine-state>{stateText(m.id)}{m.id === ui.current ? ' · on this page' : ''}</span></span>
          <span class="grow"></span>
          {#if m.id !== ui.current}
            <button onclick={() => page.openMachine(m.id)} data-action="open"><Icon name="player-play" size={16} />Open on this page</button>
          {:else if ui.state === 'running' || ui.state === 'booting' || ui.state === 'loading'}
            <button data-action="open" disabled title="It runs on this page: its changes take effect at its next start">Running on this page</button>
          {:else}
            <button class="primary" onclick={() => { page.closeMachines(); page.restart(); }} data-action="start" title="Start it on this page, as it is now (its settings and disks)"><Icon name="player-play" size={16} />Start</button>
          {/if}
          <button onclick={() => act('Copying', async () => { choose((await duplicateMachine(store, m.id)).id); })} title="A new machine with these settings and disks (each with a new empty overlay)"><Icon name="copy" size={16} />Duplicate</button>
          <button onclick={() => exportDef(m)} title="The machine's settings and disks (which files, which URLs), without their contents, overlays or snapshots"><Icon name="file-export" size={16} />Export the definition</button>
          <button onclick={() => remove(m)} title="Delete the machine (its disks and their overlays stay)"><Icon name="trash" size={16} />Delete</button>
        </div>
        <div class="tabs" role="tablist">
          <button role="tab" aria-selected={ui.machinesTab === 'settings'} onclick={() => tab('settings')} data-tab="settings"><Icon name="settings" size={16} />Settings</button>
          <button role="tab" aria-selected={ui.machinesTab === 'disks'} onclick={() => tab('disks')} data-tab="disks"><Icon name="database" size={16} />Disks ({m.attachments.length})</button>
          <button role="tab" aria-selected={ui.machinesTab === 'network'} onclick={() => tab('network')} data-tab="network"><Icon name="network" size={16} />Network</button>
          <button role="tab" aria-selected={ui.machinesTab === 'usb'} onclick={() => tab('usb')} data-tab="usb"><Icon name="usb" size={16} />USB{m.usbDevices?.length ? ` (${m.usbDevices.length})` : ''}</button>
          <button role="tab" aria-selected={ui.machinesTab === 'folders'} onclick={() => tab('folders')} data-tab="folders"><Icon name="folder" size={16} />Shared folders{m.folders?.length ? ` (${m.folders.length})` : ''}</button>
          <button role="tab" aria-selected={ui.machinesTab === 'snapshots'} onclick={() => tab('snapshots')} data-tab="snapshots"><Icon name="history" size={16} />Snapshots</button>
        </div>
        <div class="tab">
          {#if ui.machinesTab === 'settings'}
            <div class="settings" oninput={() => (dirty = true)} onchange={() => (dirty = true)}>
              <label>Name <input bind:value={draft.name} data-field="name"></label>
              <label>vCPUs <select bind:value={draft.ncpus} data-field="ncpus">{#each CPU_CHOICES as n}<option value={n}>{n}</option>{/each}</select></label>
              <label>RAM <select bind:value={draft.ramMiB} data-field="ram" disabled={!!draft.ramSplit} title={draft.ramSplit ? 'The sum of the split below' : ''}>{#each [...new Set([...RAM_CHOICES, draft.ramMiB])].sort((a, b) => a - b) as n}<option value={n}>{n} MiB</option>{/each}</select></label>
              {#if numaNote(draft.ramMiB, draft.ramSplit, !!draft.vulkan)}<p class="note warn" data-numa>{numaNote(draft.ramMiB, draft.ramSplit, !!draft.vulkan)}</p>{/if}
              <details class="advanced" data-ram-split open={!!draft.ramSplit}>
                <summary>Memory split (advanced)</summary>
                <Check checked={!!draft.ramSplit} onchange={customSplit} field="custom-split">Set the split myself</Check>
                {#if draft.ramSplit}
                  <div class="split">
                    <label>Memory 0, MiB <input bind:this={ram0Input} type="number" min="64" step="1" value={draft.ramSplit[0]} onchange={editSplit} data-field="ram0"></label>
                    <label>NUMA nodes past it, MiB each <input bind:this={nodesInput} value={draft.ramSplit.slice(1).join(', ')} placeholder="none" onchange={editSplit} data-field="ram-nodes"></label>
                  </div>
                  {#if splitProblem}<p class="note warn" data-split-problem>{splitProblem}</p>{/if}
                {/if}
                <p class="note">Memory 0 is the fast memory, beside the emulator, up to {MEMORY0_MIB} MiB. Each NUMA node (up to 4096 MiB, at most 8) is a memory of its own, slower to reach. The guest's processors are all on memory 0's node, so Linux fills it first.</p>
              </details>
              <label>JIT cache <select bind:value={draft.jitMiB} data-field="jit" title="The most compiled guest code the emulator keeps before it starts over. The browser spends several times this on it: a smaller cache saves memory, a larger one keeps a big guest's code (a web browser's) compiled">{#each [undefined, ...new Set([...JIT_CHOICES, ...(draft.jitMiB ? [draft.jitMiB] : [])])].sort((a, b) => (a ?? 0) - (b ?? 0)) as n}<option value={n}>{n ? `${n} MiB` : `Default (${JIT_DEFAULT_MIB} MiB)`}</option>{/each}</select></label>
              <label>Display <select bind:value={draft.display} data-field="display"><option value="3d">3D (WebGL2)</option><option value="2d">2D</option></select></label>
              {@render vulkanSwitch()}
              <label>Keyboard layout <select bind:value={draft.keyboard} onchange={() => (keyboardNote = '')} data-field="keyboard" title="The layout of your keyboard, for the page to set in the guest">{#each [undefined, FOLLOW_BROWSER, ...KEYBOARD_LAYOUTS.map((l) => l.id)] as id}<option value={id}>{id === FOLLOW_BROWSER ? "This browser's, at every boot" : id ? KEYBOARD_LAYOUTS.find((l) => l.id === id)!.label : "Don't set it (the guest's own)"}</option>{/each}</select></label>
              <button class="beside" onclick={matchKeyboard} data-action="match-keyboard" title="The layout this browser reports for your keyboard"><Icon name="keyboard" size={16} />Match this browser</button>
              {#if keyboardNote}<p class="note" data-keyboard-match>{keyboardNote}</p>{/if}
              {#if draft.keyboard === FOLLOW_BROWSER}<p class="note" data-keyboard-note>At every boot the page changes the guest's own keyboard settings to the layout this browser reports{browserNow ? ` (now ${browserNow})` : ''} (console, X11 and Wayland, on a guest with systemd 256 or newer). Where the browser doesn't say (only Chromium-based browsers do), the guest keeps its last layout; so does "Don't set it".</p>{:else if draft.keyboard}<p class="note" data-keyboard-note>The next time the machine boots, the page changes the guest's own keyboard settings to this layout (console, X11 and Wayland, on a guest with systemd 256 or newer), and again at every boot while it is set. "Don't set it" leaves the last layout set.</p>{/if}
              {@render usbSwitch()}
              {@render pointerSwitches()}
              {@render saveRow()}
              <p class="note">vCPUs, RAM, the display and Vulkan, the network adapters, the USB controller, the mouse, the touchscreen, the clock device and shared folders make the machine's shape: changing one orphans the snapshots taken before (they stay, marked, until deleted). The JIT cache doesn't: the guest doesn't see it.</p>
            </div>
          {:else if ui.machinesTab === 'network'}
            <div class="network">
              <ul class="adapters">
                {#each adaptersOf(draft) as a, i (a.id)}
                  {@const rec = machines.find((x) => x.id === m.id)}
                  {@const at = rec ? adaptersOf(rec).findIndex((x) => x.id === a.id) : -1}
                  {@const c = at >= 0 ? conns.find((x) => x.id === adaptersOf(rec!)[at].connection) : undefined}
                  {@const here = m.id === ui.current && at >= 0 ? live[at] : undefined}
                  <li data-adapter={i}>
                    <Icon name="network" size={18} />
                    <div class="what"><strong>Adapter {i + 1}</strong><span class="meta">virtio-net, MAC {a.mac}</span>
                      <span class="meta" data-connection-name>{c ? `${c.name}: ${kindText(c)}` : 'No connection: the cable is out'}{here?.active ? ` · ${here.view.text}` : ''}{here?.primary ? ' · the default way out' : ''}</span>
                      {#if here?.note}<span class="meta warn">{here.note}</span>{/if}</div>
                    {#if at >= 0}
                      {#if c}<Check compact checked={c.connectAtStart} onchange={(on) => void act('Saving', () => setAtStart(c, on))} field="connect-at-start" title="Connect it when the machine starts (Disconnect turns it off)">Connect at start</Check>{/if}
                      <button onclick={() => page.netWizard({ mode: 'attach', machine: m.id, adapter: at, here: m.id === ui.current })} data-action="attach-connection" title="A connection of this browser's, or a new one">{c ? 'Change connection…' : 'Attach…'}</button>
                      {#if c}<button onclick={() => act('Detaching', () => page.netDetach(m.id, at))} data-action="detach-connection" title="Take the connection off the adapter (its client stops)">Detach</button>{/if}
                      {#if here && c}
                        {#if here.active}<button onclick={() => act('Disconnecting', () => page.netDisconnect(at))} data-action="disconnect">Disconnect</button>
                        {:else}<button onclick={() => act('Connecting', () => page.netConnect(at))} data-action="connect">Connect</button>{/if}
                      {/if}
                    {:else}<span class="meta">Save to attach a connection</span>{/if}
                    <button onclick={() => { draft = withoutAdapter(draft!, a.id); dirty = true; }} title="Take the adapter out (the machine restarts without it)" data-action="remove-adapter"><Icon name="trash" size={16} />Remove</button>
                  </li>
                {:else}
                  <li class="none">No network adapters: the machine is offline.</li>
                {/each}
              </ul>
              {#if adaptersOf(draft).length < MAX_ADAPTERS}<div class="row"><button onclick={() => { draft = withAdapter(draft!); dirty = true; }} data-action="add-adapter"><Icon name="plus" size={16} />Add a network adapter</button></div>{/if}
              <p class="note">Up to {MAX_ADAPTERS}, each with its own MAC (eth0, eth1… in the guest, in this order). Adding or removing one changes the machine's shape: snapshots taken before are orphaned. A connection is attached, changed or detached while the machine runs, as a cable is; the guest's default route goes through the first adapter that reaches the internet.</p>
              <Check checked={draft.netConfig !== false} onchange={(on) => { draft!.netConfig = on ? undefined : false; dirty = true; }} field="net-config" title="At every boot the page has the guest's systemd-networkd take what each connection's lease says">
                Take the connection's settings in the guest
                {#snippet note()}<span data-net-config-note>{#if draft?.netConfig !== false}At every boot the page has the guest's systemd-networkd take each connection's MTU (a tailnet's is 1280: at the adapter's 1500, large packets can be lost) and search domain (MagicDNS's), and use DHCP on adapters nothing else sets up, on a guest with systemd 256 or newer. Nothing is written to the guest's disk: it lasts until the guest shuts down. NetworkManager takes them by itself.{:else}The page leaves the guest's network settings alone: the guest takes the MTU and search domain only if it is set up to. The next boot has none of the page's settings.{/if}</span>{/snippet}
              </Check>
              {@render saveRow()}
            </div>
          {:else if ui.machinesTab === 'usb'}
            <div class="settings usb-switch" oninput={() => (dirty = true)} onchange={() => (dirty = true)}>
              {@render usbSwitch()}
              {#if dirty}{@render saveRow()}{/if}
            </div>
            <Usb machine={machines.find((x) => x.id === m.id) ?? m} running={isOn(m.id)} {act} />
          {:else if ui.machinesTab === 'folders'}
            {@const rec = machines.find((x) => x.id === m.id) ?? m}
            {@const pathError = sharesPathError(draft.sharesPath ?? DEFAULT_SHARES_PATH)}
            <div class="settings folders-switch" oninput={() => (dirty = true)} onchange={() => (dirty = true)}>
              <Check bind:checked={draft.shares} field="shares" title="One virtio-9p device through which the guest reaches this machine's folders: the guest sees it, so turning it on or off changes the machine's shape">Shared folders</Check>
              {#if !!draft.shares !== !!rec.shares}<p class="note warn" data-shares-orphans>Turning shared folders {draft.shares ? 'on' : 'off'} changes the machine's shape: the snapshots taken before are orphaned (they stay, marked, until deleted), as a RAM change does.</p>{/if}
              {#if draft.shares}
                <Check checked={draft.sharesMount !== false} onchange={(on) => { draft!.sharesMount = on ? undefined : false; dirty = true; }} field="shares-mount" title="At every boot the page has the guest's systemd mount the device, at the first access">Mount shared folders in the guest</Check>
                {#if draft.sharesMount !== false}
                  <label>Mount point <input value={draft.sharesPath ?? DEFAULT_SHARES_PATH} oninput={(e) => { const v = e.currentTarget.value; draft!.sharesPath = v === DEFAULT_SHARES_PATH ? undefined : v; }} data-field="shares-path" spellcheck="false"></label>
                  {#if pathError}<p class="note warn" data-shares-path-error>{pathError}</p>{/if}
                  <p class="note" data-shares-path-note>Mounting over a directory that has files hides them.{m.id === ui.current && ui.state === 'running' ? ' A new mount point takes effect at the next start.' : ''} On a guest with systemd 256 or newer; nothing is written to its disk.</p>
                {/if}
              {/if}
              {#if dirty}{@render saveRow()}{/if}
            </div>
            <Folders {folders} machine={rec} {act} />
          {:else if ui.machinesTab === 'disks'}
            <Disks {store} machine={m} {disks} {overlays} running={isOn(m.id)} {act} {offFirst} />
          {:else}
            <Snapshots {store} machine={m} running={isOn(m.id)} {act} />
          {/if}
        </div>
      </section>
    {:else}
      <section class="machine empty"><p>Choose a machine, or make a new one.</p></section>
    {/if}
  </div>

  {#if storage}
    <footer class="storage">
      <span>The browser's storage: {bytesText(storage.usage)} used of {bytesText(storage.quota)}{storage.persisted ? ', kept under pressure' : ''}.</span>
      {#if !storage.persisted}<button onclick={() => act('Asking', askPersist)}>Keep it under pressure</button>{/if}
      {#if storage.remote > 0}<button data-action="clear-remote-cache" title="Remote disks read again from the network (a running machine too, from now on). Kept a week after their last use at most; the browser may also take them back when space runs short" onclick={() => act('Clearing', clearCaches)}>Clear remote disks' blocks ({bytesText(storage.remote)})</button>{/if}
      <details><summary>What takes it</summary><ul>{#each storage.items.filter((x) => x.bytes > 0) as it}<li>{it.what}: {bytesText(it.bytes)}</li>{/each}</ul></details>
    </footer>
  {/if}
</div>

<style>
  .machines { flex: 1; min-height: 0; display: flex; flex-direction: column; background: var(--bg); }
  .bar { display: flex; align-items: center; gap: 12px; padding: 6px 12px; border-bottom: 1px solid var(--line); background: var(--panel); }
  h2 { margin: 0; font-size: 15px; font-weight: 600; }
  h3 { margin: 0; font-size: 16px; font-weight: 600; }
  .busy { color: var(--busy); font-size: 13px; }
  .error { display: flex; align-items: flex-start; gap: 8px; margin: 0; padding: 8px 12px; color: #ffb4b6; background: #2a1215; border-bottom: 1px solid #5c1d22; white-space: pre-wrap; }
  .error .text { display: flex; flex-direction: column; gap: 6px; }
  .error .dismiss { margin-left: auto; padding: 2px; color: inherit; }
  .panes { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(200px, 260px) 1fr; }
  nav { display: flex; flex-direction: column; gap: 8px; min-height: 0; overflow: auto; padding: 8px; border-right: 1px solid var(--line); background: var(--panel); }
  nav ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  nav li.chosen .pick { background: var(--pressed); }
  .pick { display: flex; flex-direction: column; align-items: flex-start; width: 100%; padding: 6px 10px; border-radius: 4px; text-align: left; }
  .name { font-weight: 600; }
  .meta { color: var(--dim); font-size: 12px; }
  .new { display: flex; flex-direction: column; gap: 4px; padding-top: 8px; border-top: 1px solid var(--line); }
  .new button { display: flex; align-items: center; gap: 8px; text-align: left; border-radius: 4px; padding: 5px 10px; }
  section.machine { min-width: 0; min-height: 0; display: flex; flex-direction: column; overflow: auto; }
  section.empty { align-items: center; justify-content: center; color: var(--dim); }
  .head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; padding: 12px 16px 8px; }
  .head .title { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 10px; }
  .head .grow { flex: 1; }
  .head button, .row button, .settings button { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line); border-radius: 6px; padding: 3px 10px; }
  .tabs { flex: none; display: flex; gap: 2px; padding: 0 16px; box-shadow: inset 0 -1px var(--line); overflow-x: auto; scrollbar-width: none; }
  .tabs button { flex: none; white-space: nowrap; display: inline-flex; align-items: center; gap: 6px; padding: 7px 14px; border-radius: 6px 6px 0 0; border: 1px solid transparent; border-bottom: 0; color: var(--dim); }
  .tabs button[aria-selected=true] { color: var(--text); background: var(--bg); border-color: var(--line); border-bottom: 1px solid var(--bg); }
  .tab { padding: 16px; }
  .settings { display: grid; grid-template-columns: max-content minmax(0, 320px) 1fr; gap: 10px 16px; align-items: center; }
  /* A full-row note's text would widen the labels' max-content column and squeeze the controls to nothing: it takes the row's width instead. */
  .settings > .note, .settings > .advanced { contain: inline-size; }
  .settings > label { grid-column: 1 / 3; display: grid; grid-template-columns: subgrid; align-items: center; color: var(--dim); }
  .settings .row, .settings .note, .settings > :global(.check), .settings > :global(.check-field) { grid-column: 1 / -1; }
  .status-fullscreen { margin-top: 20px; }
  .row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .primary { background: #24406b; border-color: #3b6db3 !important; color: #fff; }
  .primary:disabled { background: transparent; color: var(--text); }
  .note, .hint { color: var(--dim); font-size: 12px; margin: 0; }
  .note.warn { color: #ffb36b; }
  .settings .warn { grid-column: 1 / -1; }
  .settings > .beside { justify-self: start; }
  .advanced { grid-column: 1 / -1; display: flex; flex-direction: column; gap: 8px; }
  .advanced summary { color: var(--dim); cursor: pointer; }
  .advanced .split { display: grid; grid-template-columns: max-content minmax(0, 200px); gap: 8px 16px; align-items: center; }
  .advanced .split label { display: contents; color: var(--dim); }
  .usb-switch, .folders-switch { margin-bottom: 12px; }
  .disk { display: flex; flex-direction: column; gap: 8px; }
  .network { display: flex; flex-direction: column; gap: 12px; }
  .adapters { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .adapters li { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); }
  .adapters li.none { color: var(--dim); }
  .adapters .what { flex: 1; min-width: 200px; display: flex; flex-direction: column; }
  .adapters .warn { color: #ffb36b; }
  .conn-name { font: inherit; font-weight: 600; color: var(--text); background: transparent; border: 1px solid transparent; border-radius: 4px; padding: 1px 4px; margin-left: -5px; }
  .conn-name:hover, .conn-name:focus { border-color: var(--line); }
  .new .chosen { background: var(--pressed); }
  .adapters button { white-space: nowrap; display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line); border-radius: 6px; padding: 3px 10px; }
  .storage { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; padding: 6px 16px; border-top: 1px solid var(--line); background: var(--panel); font-size: 12px; color: var(--dim); }
  .storage details ul { margin: 4px 0; }
  @media (max-width: 720px) { .panes { grid-template-columns: 1fr; } nav { border-right: 0; border-bottom: 1px solid var(--line); } }
</style>
