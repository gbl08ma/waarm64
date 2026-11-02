<!--
  The Machines page (docs/machines.md §7): it takes the machine's place on the page (which runs on behind it).
  The machines kept in this browser (new, from a disk image, import a definition), and one machine: open it here,
  duplicate, export its definition, delete; its Settings, Disks and Snapshots as tabs. A transient machine (a test's
  `?machine=`) is listed as this page's, with its disk's and snapshots' actions. The browser's disks (DisksPane.svelte)
  under Disks, its network connections (docs/network-adapters.md §3.1) under Connections, and the browser's storage at
  the bottom.
  Logic is in web/app/machines.ts, disks.ts and main.ts (`page`); every action that loses data asks first.
-->
<script lang="ts">
  import Disks from './Disks.svelte';
  import DisksPane from './DisksPane.svelte';
  import Icon from './Icon.svelte';
  import MoveButtons from './MoveButtons.svelte';
  import Menu from './Menu.svelte';
  import Check from './Check.svelte';
  import Snapshots from './Snapshots.svelte';
  import StatusEditor from './StatusEditor.svelte';
  import Usb from './Usb.svelte';
  import UsbProblems from './UsbProblems.svelte';
  import { ask } from './ask.svelte.ts';
  import T from './T.svelte';
  import { msg, said, t, text, MsgError, type Msg } from '../i18n.ts';
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
  import { askPersist, createMachine, deleteMachine, duplicateMachine, isRunning, movedAdapter, storageReport, updateMachine, withAdapter, withoutAdapter } from './machines.ts';
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
  /** The browser's disks (DisksPane.svelte). */
  const DISKS = 'disks';
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
    if (ui.machinesSelected !== PAGE && ui.machinesSelected !== CONNECTIONS && ui.machinesSelected !== FOLDERS && ui.machinesSelected !== DISKS && ui.machinesSelected !== PREFERENCES && ui.machinesSelected && !machines.some((m) => m.id === ui.machinesSelected)) ui.machinesSelected = undefined;
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
  const stateText = (id: string) => (isOn(id) ? msg('machines:MachinesPage.state.running') : suspended.has(id) ? msg('machines:MachinesPage.state.suspended') : msg('machines:MachinesPage.state.off'));

  /** Powers machine `m` off, after asking, before an edit that needs it off; false if it can't be (or the user says no). */
  async function offFirst(m: MachineRecord) {
    if (!isOn(m.id)) return true;
    if (m.id !== ui.current) { error = t('machines:MachinesPage.otherTab'); return false; }
    if (!(await ask.confirm(t('machines:MachinesPage.powerOff.confirm', { name: m.name }), { ok: t('machines:MachinesPage.powerOff.ok'), danger: true }))) return false;
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
    const pathError = m.sharesPath ? sharesPathError(m.sharesPath) : undefined;
    if (pathError) { error = said(pathError).headline; return; }
    await act(t('machines:MachinesPage.busy.saving'), async () => {
      const was = machines.find((x) => x.id === m.id)!;
      if (shapeChanged(was, m) && (await store.snapshotsOf(m.id)).length && !(await ask.confirm(t('machines:MachinesPage.orphans.confirm'), { ok: t('machines:MachinesPage.save') }))) return;
      // The machine on this page, running: it restarts with them (the page asks).
      if (restartChanged(was, m) && m.id === ui.current && isOn(m.id)) return page.saveSettings(m);
      if (restartChanged(was, m) && isOn(m.id)) throw new MsgError('machines:MachinesPage.otherTab');
      await updateMachine(store, m);
      if (m.id === ui.current) await page.netFollow();
    });
    dirty = false;
  }
  // The keyboard layout: "Match this browser" picks the one the browser reports (web/app/keyboard.ts), for the user to save.
  let keyboardNote = $state<Msg | undefined>();
  /** What this browser reports now, for the note of a machine that follows it. */
  let browserNow = $state<Msg | undefined>();
  browserLayout().then((l) => (browserNow = l?.label), () => {});
  async function matchKeyboard() {
    const l = await browserLayout();
    if (l) { draft!.keyboard = l.id; dirty = true; }
    keyboardNote = l ? msg('machines:MachinesPage.keyboard.matched', { layout: l.label }) : msg('machines:MachinesPage.keyboard.unknown');
  }
  // The RAM's split, set by hand (the advanced section; docs/spill-memories.md): memory 0, then the NUMA nodes past it, MiB.
  let splitProblem = $state<Msg | undefined>();
  let ram0Input = $state<HTMLInputElement>();
  let nodesInput = $state<HTMLInputElement>();
  function customSplit(on: boolean) {
    draft!.ramSplit = on ? ramSplitMiB(draft!.ramMiB, undefined, !!draft!.vulkan) : undefined;
    splitProblem = undefined;
    dirty = true;
  }
  /** Takes the two fields: a valid split sets the RAM to its sum, else says what's wrong (and Save waits). */
  function editSplit() {
    const split = [Number(ram0Input!.value), ...nodesInput!.value.split(',').map((x) => x.trim()).filter(Boolean).map(Number)];
    splitProblem = ramSplitError(split, !!draft!.vulkan);
    if (!splitProblem) [draft!.ramSplit, draft!.ramMiB] = [split, split.reduce((a, b) => a + b, 0)];
    dirty = true;
  }
  const restartsToSave = $derived(!!draft && draft.id === ui.current && isOn(draft.id) && (() => { const was = machines.find((x) => x.id === draft!.id); return !!was && restartChanged(was, draft!); })());

  // Definitions in and out (§6): the machine's shape as a small file; disks that are files are picked again at its first start.
  async function exportDef(m: MachineRecord) {
    await act(t('machines:MachinesPage.busy.exporting'), async () => {
      const def = await exportDefinition(store, m.id);
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([JSON.stringify(def, null, 2)], { type: 'application/json' })), download: `${m.name.replace(/[^\w.-]+/g, '-')}.webpc-machine.json` }); // i18n-ignore: a file name
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
    });
  }
  let defInput: HTMLInputElement;
  const importDef = () => {
    const f = defInput.files?.[0];
    defInput.value = '';
    if (f) void act(t('machines:MachinesPage.busy.importing'), async () => {
      const r = await importDefinition(store, parseDefinition(await f.text()));
      ui.machinesSelected = r.machine.id;
      if (r.toPick.length) error = t('machines:MachinesPage.imported.toPick', { name: r.machine.name, files: r.toPick });
    });
  };
  async function remove(m: MachineRecord) {
    if (await ask.confirm(t('machines:MachinesPage.delete.confirm', { name: m.name }), { ok: t('machines:MachinesPage.delete.ok'), danger: true })) await act(t('machines:MachinesPage.busy.deleting'), () => deleteMachine(store, m.id));
  }

  const MOVE_ADAPTER = t('machines:MachinesPage.adapter.move');
  // The network: each adapter's connection (the record's: attached while the machine runs too), and the browser's connections.
  const conns = $derived((void ui.net, net.connections));
  const live = $derived((void ui.net, net.views()));
  const kindText = (c: Connection): Msg => {
    const kind = c.kind === 'tailnet' ? msg('machines:MachinesPage.connection.tailnet', { host: new URL(c.tailnet!.controlURL).host }) : c.kind === 'local' ? msg('machines:MachinesPage.connection.local') : c.tailcat?.exit ? msg('machines:MachinesPage.connection.tailcatExit') : msg('machines:MachinesPage.connection.tailcatServe');
    return c.ephemeral ? msg('machines:MachinesPage.connection.ephemeral', { kind }) : kind;
  };
  /** Who has connection `c` now: an adapter here, a machine in another tab, or no one. */
  const stateOf = (c: Connection) => (net.runs(c.id) >= 0 ? t('machines:MachinesPage.connection.here') : net.held.has(c.id) ? t('machines:MachinesPage.connection.otherTab') : t('machines:MachinesPage.connection.unused'));
  const usedBy = (c: Connection) => [...machines.filter((m) => m.adapters?.some((a) => a.connection === c.id)).map((m) => m.name), ...(settings().transientNet === c.id && ui.transient ? [ui.transient.label] : [])];
  async function setAtStart(c: Connection, on: boolean) {
    await net.conns.put({ ...c, connectAtStart: on });
    await net.refresh();
  }
  async function logoutConnection(c: Connection) {
    if (!(await ask.confirm(t('machines:MachinesPage.logout.confirm', { name: c.name }), { ok: t('machines:MachinesPage.logout.ok'), danger: true }))) return;
    await act(t('machines:MachinesPage.busy.loggingOut'), () => page.netLogoutConnection(c));
  }

  // The page's own disk (a transient machine): its export's options.
  let compress = $state(settings().compress ?? true);
  let pageExportOpen = $state(false);
  const savePage = (mode: 'changes' | 'qcow2' | 'raw') => { pageExportOpen = false; page.saveDisk(mode, mode !== 'raw' && compress); };
</script>

{#snippet usbSwitch()}
  {#if draft}
    <Check bind:checked={draft.usb} field="usb" title={t('machines:MachinesPage.usb.title')}>{t('machines:MachinesPage.usb')}</Check>
    {#if !!draft.usb !== !!machines.find((x) => x.id === draft?.id)?.usb}<p class="note warn" data-usb-orphans>{draft.usb ? t('machines:MachinesPage.usb.orphans.on') : t('machines:MachinesPage.usb.orphans.off')}</p>{/if}
  {/if}
{/snippet}

{#snippet vulkanSwitch()}
  {#if draft && draft.display === '3d'}
    <Check bind:checked={draft.vulkan} field="vulkan" title={t('machines:MachinesPage.vulkan.title')}>{t('machines:MachinesPage.vulkan')}</Check>
    {#if !!draft.vulkan !== !!machines.find((x) => x.id === draft?.id)?.vulkan}<p class="note warn" data-vulkan-orphans>{!draft.vulkan ? t('machines:MachinesPage.vulkan.orphans.off') : hasWebgpu ? t('machines:MachinesPage.vulkan.orphans.on') : t('machines:MachinesPage.vulkan.orphans.onNoWebgpu')}</p>{/if}
  {/if}
{/snippet}

{#snippet pointerSwitches()}
  {#if draft}
    {@const rec = machines.find((x) => x.id === draft?.id)}
    <Check bind:checked={draft.mouse} field="mouse" title={t('machines:MachinesPage.mouse.title')}>{t('machines:MachinesPage.mouse')}</Check>
    <Check bind:checked={draft.touch} field="touch" title={t('machines:MachinesPage.touch.title')}>{t('machines:MachinesPage.touch')}</Check>
    <Check bind:checked={draft.clock} field="clock" title={t('machines:MachinesPage.clock.title')}>{t('machines:MachinesPage.clock')}</Check>
    {#if !!draft.mouse !== !!rec?.mouse || !!draft.touch !== !!rec?.touch || !!draft.clock !== !!rec?.clock}<p class="note warn" data-pointer-orphans>{t('machines:MachinesPage.pointers.orphans')}</p>{/if}
  {/if}
{/snippet}

{#snippet saveRow()}
  <div class="row"><button class="primary" onclick={saveSettings} data-action="save" disabled={!dirty || !!splitProblem}>{restartsToSave ? t('machines:MachinesPage.saveRestart') : t('machines:MachinesPage.save')}</button>
    {#if dirty}<button onclick={() => { dirty = false; void reread(); }}>{t('machines:MachinesPage.revert')}</button>{/if}</div>
{/snippet}

<div class="machines" data-busy={busy || undefined}>
  <div class="bar">
    <button class="tool labelled" onclick={() => page.closeMachines()} data-action="back" title={t('machines:MachinesPage.back')}><Icon name="arrow-left" /><span class="label">{t('machines:MachinesPage.back')}</span></button>
    <h2>{t('machines:MachinesPage.heading')}</h2>
    {#if busy}<span class="busy">{t('machines:MachinesPage.busy', { what: busy })}</span>{/if}
  </div>
  {#if error}<div class="error" role="alert"><div class="text">{error}{#if usbError?.words && usbError.text === error}<UsbProblems words={usbError.words} />{/if}</div><button class="dismiss" aria-label={t('machines:MachinesPage.dismiss')} onclick={() => (error = '')}><Icon name="x" size={14} /></button></div>{/if}
  <div class="panes">
    <nav>
      <ul>
        {#if ui.transient}
          <li class:chosen={ui.machinesSelected === PAGE}>
            <button class="pick" onclick={() => choose(PAGE)} data-machine={PAGE}>
              <span class="name">{ui.transient.label}</span>
              <span class="meta">{t('machines:MachinesPage.list.transient')}</span>
            </button>
          </li>
        {/if}
        {#each machines as m (m.id)}
          <li class:chosen={m.id === ui.machinesSelected}>
            <button class="pick" onclick={() => choose(m.id)} data-machine={m.id}>
              <span class="name">{m.name}</span>
              <span class="meta">{t('machines:MachinesPage.list.meta', { count: m.attachments.length, state: isOn(m.id) || suspended.has(m.id) || m.id !== ui.current ? stateText(m.id) : msg('machines:MachinesPage.state.here') })}</span>
            </button>
          </li>
        {/each}
      </ul>
      <div class="new">
        <button onclick={() => act(t('machines:MachinesPage.busy.making'), async () => { choose((await createMachine(store)).id); })} data-action="new-machine"><Icon name="plus" size={16} />{t('machines:MachinesPage.newMachine')}</button>
        {#if ui.firmware}<button onclick={() => page.openDisk()} title={t('machines:MachinesPage.fromImage.title')}><Icon name="file" size={16} />{t('machines:MachinesPage.fromImage')}</button>{/if}
        <button onclick={() => defInput.click()} title={t('machines:MachinesPage.importDefinition.title')}><Icon name="file-import" size={16} />{t('machines:MachinesPage.importDefinition')}</button>
        <input type="file" accept=".json,application/json" hidden bind:this={defInput} onchange={importDef} data-field="import-definition">
      </div>
      <div class="new">
        <button class:chosen={ui.machinesSelected === DISKS} onclick={() => choose(DISKS)} data-machine={DISKS} title={t('machines:MachinesPage.disks.title')}><Icon name="database" size={16} />{t('machines:MachinesPage.disks', { n: disks.size })}</button>
        <button class:chosen={ui.machinesSelected === FOLDERS} onclick={() => choose(FOLDERS)} data-machine={FOLDERS} title={t('machines:MachinesPage.folders.title')}><Icon name="folder" size={16} />{t('machines:MachinesPage.folders', { n: (void ui.folders.tick, folders.folders.length) })}</button>
        <button class:chosen={ui.machinesSelected === CONNECTIONS} onclick={() => choose(CONNECTIONS)} data-machine={CONNECTIONS} title={t('machines:MachinesPage.connections.title')}><Icon name="network" size={16} />{t('machines:MachinesPage.connections', { n: conns.length })}</button>
        <button class:chosen={ui.machinesSelected === PREFERENCES} onclick={() => choose(PREFERENCES)} data-machine={PREFERENCES} title={t('machines:MachinesPage.preferences.title')}><Icon name="adjustments-horizontal" size={16} />{t('machines:MachinesPage.preferences')}</button>
      </div>
    </nav>

    {#if ui.machinesSelected === PREFERENCES}
      <section class="machine" data-selected={PREFERENCES}>
        <div class="head">
          <span class="title"><h3>{t('machines:MachinesPage.preferences')}</h3>
          <span class="meta">{t('machines:MachinesPage.preferences.meta')}</span></span>
        </div>
        <div class="tab settings">
          <Check bind:checked={warnOnLeave} onchange={() => remember({ leaveWarning: warnOnLeave })} field="leave-warning"
            note={t('machines:MachinesPage.leaveWarning.note')}>{t('machines:MachinesPage.leaveWarning')}</Check>
          <Check bind:checked={catchUpClock} onchange={() => remember({ clockSync: catchUpClock })} field="clock-sync"
            note={t('machines:MachinesPage.clockSync.note')}>{t('machines:MachinesPage.clockSync')}</Check>
          <Check checked={ui.oskModifiers === 'toggle'} onchange={(on) => { ui.oskModifiers = on ? 'toggle' : 'next'; remember({ oskModifiers: ui.oskModifiers }); }} field="osk-toggle"
            note={t('machines:MachinesPage.oskToggle.note')}>{t('machines:MachinesPage.oskToggle')}</Check>
        </div>
        <div class="tab">
          <h4>{t('machines:MachinesPage.statusBar')}</h4>
          <StatusEditor {net} />
          <div class="settings status-fullscreen">
            <Check bind:checked={ui.statusFullscreen} onchange={() => remember({ statusFullscreen: ui.statusFullscreen })} field="status-fullscreen"
              note={t('machines:MachinesPage.statusFullscreen.note')}>{t('machines:MachinesPage.statusFullscreen')}</Check>
          </div>
        </div>
      </section>
    {:else if ui.machinesSelected === DISKS}
      <section class="machine" data-selected={DISKS}>
        <div class="head">
          <span class="title"><h3>{t('machines:MachinesPage.disks.heading')}</h3>
          <span class="meta">{t('machines:MachinesPage.disks.meta')}</span></span>
        </div>
        <div class="tab"><DisksPane {store} {machines} {disks} {overlays} {running} {act} {offFirst} /></div>
      </section>
    {:else if ui.machinesSelected === FOLDERS}
      <section class="machine" data-selected={FOLDERS}>
        <div class="head">
          <span class="title"><h3>{t('machines:MachinesPage.folders.heading')}</h3>
          <span class="meta">{t('machines:MachinesPage.folders.meta')}</span></span>
          <span class="grow"></span>
          <button onclick={() => page.folderWizard(undefined, [])} data-action="new-folder"><Icon name="plus" size={16} />{t('machines:MachinesPage.folders.new')}</button>
        </div>
        <div class="tab"><FoldersPane {folders} {store} {act} /></div>
      </section>
    {:else if ui.machinesSelected === CONNECTIONS}
      <section class="machine" data-selected={CONNECTIONS}>
        <div class="head">
          <span class="title"><h3>{t('machines:MachinesPage.connections.heading')}</h3>
          <span class="meta">{t('machines:MachinesPage.connections.meta')}</span></span>
          <span class="grow"></span>
          <button onclick={() => page.netWizard({ mode: 'new' })} data-action="new-connection"><Icon name="plus" size={16} />{t('machines:MachinesPage.connections.new')}</button>
        </div>
        <div class="tab">
          <ul class="adapters connections">
            {#each conns as c (c.id)}
              <li data-connection={c.id}>
                <Icon name="network" size={18} />
                <div class="what">
                  <input class="conn-name" value={c.name} aria-label={t('machines:MachinesPage.connection.name')} data-field="connection-name" onchange={(e) => { const name = e.currentTarget.value; void act(t('machines:MachinesPage.busy.renaming'), () => page.netRename(c, name)); }}>
                  <span class="meta">{t('machines:MachinesPage.connection.meta', { kind: kindText(c), state: stateOf(c), used: usedBy(c).length ? msg('machines:MachinesPage.connection.usedBy', { machines: usedBy(c) }) : msg('machines:MachinesPage.connection.usedByNone') })}</span>
                </div>
                <button onclick={() => page.netWizard({ mode: 'edit', connection: c.id })} data-action="edit-connection" title={c.kind === 'tailnet' ? t('machines:MachinesPage.connection.edit.tailnet') : c.kind === 'local' ? t('machines:MachinesPage.connection.edit.local') : t('machines:MachinesPage.connection.edit.tailcat')}>{t('machines:MachinesPage.connection.edit')}</button>
                {#if c.tailcat?.serve}<button onclick={() => act(t('machines:MachinesPage.busy.forgettingAddress'), () => page.netNewAddress(c))} data-action="new-address" title={t('machines:MachinesPage.connection.newAddress.title')}>{t('machines:MachinesPage.connection.newAddress')}</button>{/if}
                {#if net.hasNode(c) || (c.tailnet && net.runs(c.id) >= 0)}<button onclick={() => logoutConnection(c)} data-action="logout-connection" title={t('machines:MachinesPage.connection.logout.title')}>{t('machines:MachinesPage.connection.logout')}</button>{/if}
                <button onclick={() => act(t('machines:MachinesPage.busy.deleting'), () => page.netDelete(c))} data-action="delete-connection" title={t('machines:MachinesPage.connection.delete.title')}><Icon name="trash" size={16} />{t('machines:MachinesPage.connection.delete')}</button>
              </li>
            {:else}
              <li class="none">{t('machines:MachinesPage.connections.none')}</li>
            {/each}
          </ul>
        </div>
      </section>
    {:else if ui.machinesSelected === PAGE && ui.transient}
      <section class="machine" data-selected={PAGE}>
        <div class="head"><span class="title"><h3>{ui.transient.label}</h3><span class="meta">{t('machines:MachinesPage.transient.meta')}</span></span></div>
        <div class="tabs" role="tablist">
          <button role="tab" aria-selected={ui.machinesTab !== 'snapshots'} onclick={() => tab('disks')} data-tab="disks"><Icon name="database" size={16} />{t('machines:MachinesPage.tab.disks')}</button>
          <button role="tab" aria-selected={ui.machinesTab === 'snapshots'} onclick={() => tab('snapshots')} data-tab="snapshots"><Icon name="history" size={16} />{t('machines:MachinesPage.tab.snapshots')}</button>
        </div>
        {#if ui.machinesTab !== 'snapshots'}
          <div class="tab">
            <div class="disk" data-attachment={PAGE}>
              <div class="row"><Icon name="database" size={18} /><strong>{ui.transient.disk}</strong>
                {#if ui.hasOverlay}<span class="meta">{t('machines:MachinesPage.transient.overlay')}</span>{/if}</div>
              {#if ui.hasOverlay}
                <div class="row actions">
                  <Menu id="save" icon="download" title={t('machines:MachinesPage.export.title')} label={t('machines:MachinesPage.export')} bind:open={pageExportOpen} align="left">
                    <button data-save="changes" title={t('machines:MachinesPage.export.changes.title')} onclick={() => savePage('changes')}>{t('machines:MachinesPage.export.changes')}</button>
                    <button data-save="qcow2" title={t('machines:MachinesPage.export.qcow2.title')} onclick={() => savePage('qcow2')}>{t('machines:MachinesPage.export.qcow2')}</button>
                    <button data-save="raw" title={t('machines:MachinesPage.export.raw.title')} onclick={() => savePage('raw')}>{t('machines:MachinesPage.export.raw')}</button>
                    <Check id="save-compress" bind:checked={compress} onchange={() => remember({ compress })} title={t('machines:MachinesPage.export.compress.title')}>{t('machines:MachinesPage.export.compress')}</Check>
                    <p class="hint"><T k="machines:MachinesPage.export.hint">{#snippet code(words: string)}<code>{words}</code>{/snippet}</T></p>
                  </Menu>
                  <button onclick={() => document.getElementById('load-changes-input')!.click()} title={t('machines:MachinesPage.importChanges.title')}><Icon name="upload" size={16} />{t('machines:MachinesPage.importChanges')}</button>
                  <button id="reset-disk" disabled={ui.busy} onclick={() => page.resetDisk()} title={t('machines:MachinesPage.resetDisk.title')}><Icon name="trash" size={16} />{t('machines:MachinesPage.resetDisk')}</button>
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
          <span class="meta" data-machine-state>{m.id === ui.current ? t('machines:MachinesPage.head.stateHere', { state: stateText(m.id) }) : text(stateText(m.id))}</span></span>
          <span class="grow"></span>
          {#if m.id !== ui.current}
            <button onclick={() => page.openMachine(m.id)} data-action="open"><Icon name="player-play" size={16} />{t('machines:MachinesPage.open')}</button>
          {:else if ui.state === 'running' || ui.state === 'booting' || ui.state === 'loading'}
            <button data-action="open" disabled title={t('machines:MachinesPage.runningHere.title')}>{t('machines:MachinesPage.runningHere')}</button>
          {:else}
            <button class="primary" onclick={() => { page.closeMachines(); page.restart(); }} data-action="start" title={t('machines:MachinesPage.start.title')}><Icon name="player-play" size={16} />{t('machines:MachinesPage.start')}</button>
          {/if}
          <button onclick={() => act(t('machines:MachinesPage.busy.copying'), async () => { choose((await duplicateMachine(store, m.id)).id); })} title={t('machines:MachinesPage.duplicate.title')}><Icon name="copy" size={16} />{t('machines:MachinesPage.duplicate')}</button>
          <button onclick={() => exportDef(m)} title={t('machines:MachinesPage.exportDefinition.title')}><Icon name="file-export" size={16} />{t('machines:MachinesPage.exportDefinition')}</button>
          <button onclick={() => remove(m)} title={t('machines:MachinesPage.machine.delete.title')}><Icon name="trash" size={16} />{t('machines:MachinesPage.machine.delete')}</button>
        </div>
        <div class="tabs" role="tablist">
          <button role="tab" aria-selected={ui.machinesTab === 'settings'} onclick={() => tab('settings')} data-tab="settings"><Icon name="settings" size={16} />{t('machines:MachinesPage.tab.settings')}</button>
          <button role="tab" aria-selected={ui.machinesTab === 'disks'} onclick={() => tab('disks')} data-tab="disks"><Icon name="database" size={16} />{t('machines:MachinesPage.tab.disksCount', { n: m.attachments.length })}</button>
          <button role="tab" aria-selected={ui.machinesTab === 'network'} onclick={() => tab('network')} data-tab="network"><Icon name="network" size={16} />{t('machines:MachinesPage.tab.network')}</button>
          <button role="tab" aria-selected={ui.machinesTab === 'usb'} onclick={() => tab('usb')} data-tab="usb"><Icon name="usb" size={16} />{m.usbDevices?.length ? t('machines:MachinesPage.tab.usbCount', { n: m.usbDevices.length }) : t('machines:MachinesPage.tab.usb')}</button>
          <button role="tab" aria-selected={ui.machinesTab === 'folders'} onclick={() => tab('folders')} data-tab="folders"><Icon name="folder" size={16} />{m.folders?.length ? t('machines:MachinesPage.tab.foldersCount', { n: m.folders.length }) : t('machines:MachinesPage.tab.folders')}</button>
          <button role="tab" aria-selected={ui.machinesTab === 'snapshots'} onclick={() => tab('snapshots')} data-tab="snapshots"><Icon name="history" size={16} />{t('machines:MachinesPage.tab.snapshots')}</button>
        </div>
        <div class="tab">
          {#if ui.machinesTab === 'settings'}
            <div class="settings" oninput={() => (dirty = true)} onchange={() => (dirty = true)}>
              <label>{t('machines:MachinesPage.name')} <input bind:value={draft.name} data-field="name"></label>
              <label>{t('machines:MachinesPage.ncpus')} <select bind:value={draft.ncpus} data-field="ncpus">{#each CPU_CHOICES as n}<option value={n}>{n}</option>{/each}</select></label>
              <label>{t('machines:MachinesPage.ram')} <select bind:value={draft.ramMiB} data-field="ram" disabled={!!draft.ramSplit} title={draft.ramSplit ? t('machines:MachinesPage.ram.title') : ''}>{#each [...new Set([...RAM_CHOICES, draft.ramMiB])].sort((a, b) => a - b) as n}<option value={n}>{t('machines:MachinesPage.mib', { n })}</option>{/each}</select></label>
              {#if numaNote(draft.ramMiB, draft.ramSplit, !!draft.vulkan)}<p class="note warn" data-numa>{text(numaNote(draft.ramMiB, draft.ramSplit, !!draft.vulkan)!)}</p>{/if}
              <details class="advanced" data-ram-split open={!!draft.ramSplit}>
                <summary>{t('machines:MachinesPage.split')}</summary>
                <Check checked={!!draft.ramSplit} onchange={customSplit} field="custom-split">{t('machines:MachinesPage.split.custom')}</Check>
                {#if draft.ramSplit}
                  <div class="split">
                    <label>{t('machines:MachinesPage.split.memory0')} <input bind:this={ram0Input} type="number" min="64" step="1" value={draft.ramSplit[0]} onchange={editSplit} data-field="ram0"></label>
                    <label>{t('machines:MachinesPage.split.nodes')} <input bind:this={nodesInput} value={draft.ramSplit.slice(1).join(', ')} placeholder={t('machines:MachinesPage.split.nodes.placeholder')} onchange={editSplit} data-field="ram-nodes"></label>
                  </div>
                  {#if splitProblem}<p class="note warn" data-split-problem>{text(splitProblem)}</p>{/if}
                {/if}
                <p class="note">{t('machines:MachinesPage.split.note', { max: MEMORY0_MIB })}</p>
              </details>
              <label>{t('machines:MachinesPage.jit')} <select bind:value={draft.jitMiB} data-field="jit" title={t('machines:MachinesPage.jit.title')}>{#each [undefined, ...new Set([...JIT_CHOICES, ...(draft.jitMiB ? [draft.jitMiB] : [])])].sort((a, b) => (a ?? 0) - (b ?? 0)) as n}<option value={n}>{n ? t('machines:MachinesPage.mib', { n }) : t('machines:MachinesPage.jit.default', { n: JIT_DEFAULT_MIB })}</option>{/each}</select></label>
              <label>{t('machines:MachinesPage.display')} <select bind:value={draft.display} data-field="display"><option value="3d">{t('machines:MachinesPage.display.3d')}</option><option value="2d">{t('machines:MachinesPage.display.2d')}</option></select></label>
              {@render vulkanSwitch()}
              <label>{t('machines:MachinesPage.keyboard')} <select bind:value={draft.keyboard} onchange={() => (keyboardNote = undefined)} data-field="keyboard" title={t('machines:MachinesPage.keyboard.title')}>{#each [undefined, FOLLOW_BROWSER, ...KEYBOARD_LAYOUTS.map((l) => l.id)] as id}<option value={id}>{id === FOLLOW_BROWSER ? t('machines:MachinesPage.keyboard.follow') : id ? text(KEYBOARD_LAYOUTS.find((l) => l.id === id)!.label) : t('machines:MachinesPage.keyboard.none')}</option>{/each}</select></label>
              <button class="beside" onclick={matchKeyboard} data-action="match-keyboard" title={t('machines:MachinesPage.keyboard.match.title')}><Icon name="keyboard" size={16} />{t('machines:MachinesPage.keyboard.match')}</button>
              {#if keyboardNote}<p class="note" data-keyboard-match>{text(keyboardNote)}</p>{/if}
              {#if draft.keyboard === FOLLOW_BROWSER}<p class="note" data-keyboard-note>{browserNow ? t('machines:MachinesPage.keyboard.followNote.now', { layout: browserNow }) : t('machines:MachinesPage.keyboard.followNote')}</p>{:else if draft.keyboard}<p class="note" data-keyboard-note>{t('machines:MachinesPage.keyboard.setNote')}</p>{/if}
              {@render usbSwitch()}
              {@render pointerSwitches()}
              {@render saveRow()}
              <p class="note">{t('machines:MachinesPage.shape.note')}</p>
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
                    <div class="what"><strong>{t('machines:MachinesPage.adapter', { n: i + 1 })}</strong><span class="meta">{t('machines:MachinesPage.adapter.mac', { mac: a.mac })}</span>
                      <span class="meta" data-connection-name>{c ? t('machines:MachinesPage.adapter.connection', { name: c.name, kind: kindText(c) }) : t('machines:MachinesPage.adapter.noConnection')}{#if here?.active}{' · '}{said(here.view.text).headline}{#each here.view.details ?? [] as d, k (k)}{' · '}{d}{/each}{/if}{#if here?.primary}{' · '}{t('machines:MachinesPage.adapter.primary')}{/if}</span>
                      {#if here?.note}<span class="meta warn">{said(here.note).headline}</span>{/if}</div>
                    {#if at >= 0}
                      {#if c}<Check compact checked={c.connectAtStart} onchange={(on) => void act(t('machines:MachinesPage.busy.saving'), () => setAtStart(c, on))} field="connect-at-start" title={t('machines:MachinesPage.adapter.atStart.title')}>{t('machines:MachinesPage.adapter.atStart')}</Check>{/if}
                      <button onclick={() => page.netWizard({ mode: 'attach', machine: m.id, adapter: at, here: !!here?.on })} data-action="attach-connection" title={t('machines:MachinesPage.adapter.attach.title')}>{c ? t('machines:MachinesPage.adapter.change') : t('machines:MachinesPage.adapter.attach')}</button>
                      {#if c}<button onclick={() => act(t('machines:MachinesPage.busy.detaching'), () => page.netDetach(m.id, at))} data-action="detach-connection" title={t('machines:MachinesPage.adapter.detach.title')}>{t('machines:MachinesPage.adapter.detach')}</button>{/if}
                      {#if here && c && (here.on || here.active)}
                        {#if here.active}<button onclick={() => act(t('machines:MachinesPage.busy.disconnecting'), () => page.netDisconnect(at))} data-action="disconnect">{t('machines:MachinesPage.adapter.disconnect')}</button>
                        {:else}<button onclick={() => act(t('machines:MachinesPage.busy.connecting'), () => page.netConnect(at))} data-action="connect">{t('machines:MachinesPage.adapter.connect')}</button>{/if}
                      {/if}
                    {:else}<span class="meta">{t('machines:MachinesPage.adapter.saveFirst')}</span>{/if}
                    <MoveButtons index={i} count={adaptersOf(draft).length} onmove={(by) => { draft = movedAdapter(draft!, a.id, by); dirty = true; }} upTitle={MOVE_ADAPTER} downTitle={MOVE_ADAPTER} action="adapter" />
                    <button onclick={() => { draft = withoutAdapter(draft!, a.id); dirty = true; }} title={t('machines:MachinesPage.adapter.remove.title')} data-action="remove-adapter"><Icon name="trash" size={16} />{t('machines:MachinesPage.adapter.remove')}</button>
                  </li>
                {:else}
                  <li class="none">{t('machines:MachinesPage.adapters.none')}</li>
                {/each}
              </ul>
              {#if adaptersOf(draft).length < MAX_ADAPTERS}<div class="row"><button onclick={() => { draft = withAdapter(draft!); dirty = true; }} data-action="add-adapter"><Icon name="plus" size={16} />{t('machines:MachinesPage.adapters.add')}</button></div>{/if}
              <p class="note">{t('machines:MachinesPage.adapters.note', { max: MAX_ADAPTERS })}</p>
              <Check checked={draft.netConfig !== false} onchange={(on) => { draft!.netConfig = on ? undefined : false; dirty = true; }} field="net-config" title={t('machines:MachinesPage.netConfig.title')}>
                {t('machines:MachinesPage.netConfig')}
                {#snippet note()}<span data-net-config-note>{draft?.netConfig !== false ? t('machines:MachinesPage.netConfig.on') : t('machines:MachinesPage.netConfig.off')}</span>{/snippet}
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
              <Check bind:checked={draft.shares} field="shares" title={t('machines:MachinesPage.shares.title')}>{t('machines:MachinesPage.shares')}</Check>
              {#if !!draft.shares !== !!rec.shares}<p class="note warn" data-shares-orphans>{draft.shares ? t('machines:MachinesPage.shares.orphans.on') : t('machines:MachinesPage.shares.orphans.off')}</p>{/if}
              {#if draft.shares}
                <Check checked={draft.sharesMount !== false} onchange={(on) => { draft!.sharesMount = on ? undefined : false; dirty = true; }} field="shares-mount" title={t('machines:MachinesPage.sharesMount.title')}>{t('machines:MachinesPage.sharesMount')}</Check>
                {#if draft.sharesMount !== false}
                  <label>{t('machines:MachinesPage.sharesPath')} <input value={draft.sharesPath ?? DEFAULT_SHARES_PATH} oninput={(e) => { const v = e.currentTarget.value; draft!.sharesPath = v === DEFAULT_SHARES_PATH ? undefined : v; }} data-field="shares-path" spellcheck="false"></label>
                  {#if pathError}<p class="note warn" data-shares-path-error>{said(pathError).headline}</p>{/if}
                  <p class="note" data-shares-path-note>{m.id === ui.current && ui.state === 'running' ? t('machines:MachinesPage.sharesPath.noteRunning') : t('machines:MachinesPage.sharesPath.note')}</p>
                {/if}
              {/if}
              {#if dirty}{@render saveRow()}{/if}
            </div>
            <Folders {folders} machine={rec} {act} />
          {:else if ui.machinesTab === 'disks'}
            <Disks {store} machine={m} {machines} {disks} {overlays} running={isOn(m.id)} {act} {offFirst} />
          {:else}
            <Snapshots {store} machine={m} running={isOn(m.id)} {act} />
          {/if}
        </div>
      </section>
    {:else}
      <section class="machine empty"><p>{t('machines:MachinesPage.empty')}</p></section>
    {/if}
  </div>

  {#if storage}
    <footer class="storage">
      <span>{storage.persisted ? t('machines:MachinesPage.storage.persisted', { used: storage.usage, quota: storage.quota }) : t('machines:MachinesPage.storage', { used: storage.usage, quota: storage.quota })}</span>
      {#if !storage.persisted}<button onclick={() => act(t('machines:MachinesPage.busy.asking'), askPersist)}>{t('machines:MachinesPage.storage.persist')}</button>{/if}
      {#if storage.remote > 0}<button data-action="clear-remote-cache" title={t('machines:MachinesPage.storage.clear.title')} onclick={() => act(t('machines:MachinesPage.busy.clearing'), clearCaches)}>{t('machines:MachinesPage.storage.clear', { size: storage.remote })}</button>{/if}
      <details><summary>{t('machines:MachinesPage.storage.items')}</summary><ul>{#each storage.items.filter((x) => x.bytes > 0) as it}<li>{t('machines:MachinesPage.storage.item', { what: it.what, size: it.bytes })}</li>{/each}</ul></details>
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
