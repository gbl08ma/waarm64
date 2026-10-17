<!--
  The Machines page (docs/plans/machines.md §7): it takes the machine's place on the page (which runs on behind it).
  The machines kept in this browser (new, from a disk image, import a definition), and one machine: open it here,
  duplicate, export its definition, delete; its Settings, Disks and Snapshots as tabs. A transient machine (a test's
  `?machine=`) is listed as this page's, with its disk's and snapshots' actions. The browser's storage at the bottom.
  Logic is in web/app/machines.ts, disks.ts and main.ts (`page`); every action that loses data asks first.
-->
<script lang="ts">
  import Disks from './Disks.svelte';
  import Icon from './Icon.svelte';
  import Menu from './Menu.svelte';
  import Snapshots from './Snapshots.svelte';
  import { ask } from './ask.svelte.ts';
  import type { Store, OverlayRecord } from './store.ts';
  import type { DiskRecord, MachineRecord } from './shape.ts';
  import { askPersist, bytesText, createMachine, deleteMachine, duplicateMachine, isRunning, storageReport, updateMachine } from './machines.ts';
  import { exportDefinition, importDefinition, parseDefinition } from './definitions.ts';
  import { remember, settings } from './settings.ts';
  import { page, ui, type MachinesTab } from './ui.svelte.ts';
  import { MAX_RAM_MIB, RAM_CHOICES } from './machine.ts';

  let { store }: { store: Store } = $props();

  let machines = $state<MachineRecord[]>([]);
  let disks = $state<Map<string, DiskRecord>>(new Map());
  let overlays = $state<OverlayRecord[]>([]);
  let running = $state<Set<string>>(new Set());
  let draft = $state<MachineRecord | undefined>();
  let error = $state('');
  let busy = $state('');
  let storage = $state<Awaited<ReturnType<typeof storageReport>> | undefined>();
  /** The page's own machine (transient) is chosen: `ui.machinesSelected` is `page`. */
  const PAGE = 'page';

  const CPU_CHOICES = [1, 2, 3, 4, 6, 8];

  async function reread() {
    machines = (await store.all('machines')).sort((a, b) => a.name.localeCompare(b.name));
    disks = new Map((await store.all('disks')).map((d) => [d.id, d]));
    overlays = await store.all('overlays');
    running = new Set((await Promise.all(machines.map(async (m) => ((await isRunning(m.id)) ? m.id : '')))).filter(Boolean));
    if (ui.machinesSelected === undefined) ui.machinesSelected = ui.current ?? (ui.transient ? PAGE : undefined);
    if (ui.machinesSelected !== PAGE && ui.machinesSelected && !machines.some((m) => m.id === ui.machinesSelected)) ui.machinesSelected = undefined;
    const m = machines.find((x) => x.id === ui.machinesSelected);
    // The draft follows the record, unless the user is editing its settings.
    if (!m || !draft || draft.id !== m.id || !dirty) draft = m ? structuredClone($state.snapshot(m)) as MachineRecord : undefined;
    storage = await storageReport(store).catch(() => undefined);
  }
  // Read now, again when a record changes (in any tab), and when the machine on this page starts or stops (its "running").
  $effect(() => store.onChange(() => void reread()));
  $effect(() => { void ui.state; void reread(); });

  /** Runs an action, showing what it's doing and any error; rereads after. */
  async function act(what: string, f: () => Promise<unknown>) {
    error = '';
    busy = what;
    try {
      await f();
    } catch (e) {
      error = String((e as Error).message ?? e);
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
  const shapeChanged = (a: MachineRecord, b: MachineRecord) => a.ramMiB !== b.ramMiB || a.ncpus !== b.ncpus || a.display !== b.display || a.network !== b.network;
  async function saveSettings() {
    const m = plain(draft!);
    await act('Saving', async () => {
      const was = machines.find((x) => x.id === m.id)!;
      if (shapeChanged(was, m) && (await store.snapshotsOf(m.id)).length && !(await ask.confirm('This change orphans its snapshots: they were taken of a machine with the old settings (they stay, marked, until deleted).', { ok: 'Save' }))) return;
      // The machine on this page, running: it restarts with them (the page asks).
      if (shapeChanged(was, m) && m.id === ui.current && isOn(m.id)) return page.saveSettings(m);
      if (shapeChanged(was, m) && isOn(m.id)) throw new Error('It runs in another tab: power it off there first.');
      await updateMachine(store, m);
    });
    dirty = false;
  }
  const restartsToSave = $derived(!!draft && draft.id === ui.current && isOn(draft.id) && (() => { const was = machines.find((x) => x.id === draft!.id); return !!was && shapeChanged(was, draft!); })());

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

  // The page's own disk (a transient machine): its export's options.
  let compress = $state(settings().compress ?? true);
  let pageExportOpen = $state(false);
  const savePage = (mode: 'changes' | 'qcow2' | 'raw') => { pageExportOpen = false; page.saveDisk(mode, mode !== 'raw' && compress); };
</script>

{#snippet saveRow()}
  <div class="row"><button class="primary" onclick={saveSettings} data-action="save" disabled={!dirty}>{restartsToSave ? 'Save and restart' : 'Save'}</button>
    {#if dirty}<button onclick={() => { dirty = false; void reread(); }}>Revert</button>{/if}</div>
{/snippet}

<div class="machines" data-busy={busy || undefined}>
  <div class="bar">
    <button class="tool labelled" onclick={() => page.closeMachines()} data-action="back" title="Back to the machine"><Icon name="arrow-left" /><span class="label">Back to the machine</span></button>
    <h2>Machines</h2>
    {#if busy}<span class="busy">{busy}…</span>{/if}
  </div>
  {#if error}<p class="error" role="alert">{error}<button class="dismiss" aria-label="Close" onclick={() => (error = '')}><Icon name="x" size={14} /></button></p>{/if}
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
              <span class="meta">{m.attachments.length} disk{m.attachments.length === 1 ? '' : 's'} · {isOn(m.id) ? 'running' : m.id === ui.current ? 'on this page' : 'off'}</span>
            </button>
          </li>
        {/each}
      </ul>
      <div class="new">
        <button onclick={() => act('Making a machine', async () => { choose((await createMachine(store)).id); })} data-action="new-machine"><Icon name="plus" size={16} />New machine</button>
        {#if ui.firmware}<button onclick={() => document.getElementById('open-disk-input')!.click()} title="A machine for a disk image on this computer (qcow2, raw or an ISO), started at once: the same as dropping the file on the page"><Icon name="file" size={16} />From a disk image…</button>{/if}
        <button onclick={() => defInput.click()} title="A machine definition (.webpc-machine.json): its settings and disks, without their contents"><Icon name="file-import" size={16} />Import a definition…</button>
        <input type="file" accept=".json,application/json" hidden bind:this={defInput} onchange={importDef} data-field="import-definition">
      </div>
    </nav>

    {#if ui.machinesSelected === PAGE && ui.transient}
      <section class="machine" data-selected={PAGE}>
        <div class="head"><h3>{ui.transient.label}</h3><span class="meta">This page's machine, from its address: its size is in the toolbar's Machine menu.</span></div>
        <div class="tabs" role="tablist">
          <button role="tab" aria-selected={ui.machinesTab !== 'snapshots'} onclick={() => tab('disks')} data-tab="disks"><Icon name="database" size={16} />Disks</button>
          <button role="tab" aria-selected={ui.machinesTab === 'snapshots'} onclick={() => tab('snapshots')} data-tab="snapshots"><Icon name="camera" size={16} />Snapshots</button>
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
                    <label class="check" title="Compressed clusters (deflate), as qemu-img convert -c writes them: the file is about half the size and takes longer to write"><input id="save-compress" type="checkbox" bind:checked={compress} onchange={() => remember({ compress })}> Compress the qcow2</label>
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
          <h3>{m.name}</h3>
          <span class="meta">{isOn(m.id) ? 'running' : 'off'}{m.id === ui.current ? ' · on this page' : ''}</span>
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
          <button role="tab" aria-selected={ui.machinesTab === 'snapshots'} onclick={() => tab('snapshots')} data-tab="snapshots"><Icon name="camera" size={16} />Snapshots</button>
        </div>
        <div class="tab">
          {#if ui.machinesTab === 'settings'}
            <div class="settings" oninput={() => (dirty = true)} onchange={() => (dirty = true)}>
              <label>Name <input bind:value={draft.name} data-field="name"></label>
              <label>vCPUs <select bind:value={draft.ncpus} data-field="ncpus">{#each CPU_CHOICES as n}<option value={n}>{n}</option>{/each}</select></label>
              <label>RAM <select bind:value={draft.ramMiB} data-field="ram">{#each [...new Set([...RAM_CHOICES, draft.ramMiB])].sort((a, b) => a - b) as n}<option value={n}>{n} MiB{n > MAX_RAM_MIB ? ' (past the heap reserve: slower on Linux arm64)' : ''}</option>{/each}</select></label>
              <label>Display <select bind:value={draft.display} data-field="display"><option value="3d">3D (WebGL2)</option><option value="2d">2D</option></select></label>
              {@render saveRow()}
              <p class="note">vCPUs, RAM, the display and the network adapters make the machine's shape: changing one orphans the snapshots taken before (they stay, marked, until deleted).</p>
            </div>
          {:else if ui.machinesTab === 'network'}
            <div class="network">
              <ul class="adapters">
                {#if draft.network}
                  <li data-adapter="0">
                    <Icon name="network" size={18} />
                    <div class="what"><strong>Network card</strong><span class="meta">virtio-net, eth0 in the guest: connected through the toolbar's Network menu (a tailnet, or tailcat) while the machine runs</span></div>
                    <button onclick={() => { draft!.network = false; dirty = true; }} title="Take the card out (the machine restarts without it)"><Icon name="trash" size={16} />Remove</button>
                  </li>
                {:else}
                  <li class="none">No network adapters: the machine is offline.</li>
                {/if}
              </ul>
              {#if !draft.network}<div class="row"><button onclick={() => { draft!.network = true; dirty = true; }} data-action="add-adapter"><Icon name="plus" size={16} />Add a network card</button></div>{/if}
              {@render saveRow()}
              <p class="note">One card for now. Adding or removing one changes the machine's shape: snapshots taken before are orphaned.</p>
            </div>
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
  .head .grow { flex: 1; }
  .head button, .row button, .settings button { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line); border-radius: 6px; padding: 3px 10px; }
  .tabs { display: flex; gap: 2px; padding: 0 16px; border-bottom: 1px solid var(--line); }
  .tabs button { display: inline-flex; align-items: center; gap: 6px; padding: 7px 14px; border-radius: 6px 6px 0 0; border: 1px solid transparent; border-bottom: 0; margin-bottom: -1px; color: var(--dim); }
  .tabs button[aria-selected=true] { color: var(--text); background: var(--bg); border-color: var(--line); border-bottom: 1px solid var(--bg); }
  .tab { padding: 16px; }
  .settings { display: grid; grid-template-columns: max-content minmax(0, 320px); gap: 10px 16px; align-items: center; }
  .settings label:not(.check) { display: contents; color: var(--dim); }
  .settings .row, .settings .note { grid-column: 1 / -1; }
  .check { display: flex; align-items: center; gap: 6px; }
  .row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .primary { background: #24406b; border-color: #3b6db3 !important; color: #fff; }
  .primary:disabled { background: transparent; color: var(--text); }
  .note, .hint { color: var(--dim); font-size: 12px; margin: 0; }
  .disk { display: flex; flex-direction: column; gap: 8px; }
  .network { display: flex; flex-direction: column; gap: 12px; max-width: 720px; }
  .adapters { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .adapters li { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); }
  .adapters li.none { color: var(--dim); }
  .adapters .what { flex: 1; display: flex; flex-direction: column; }
  .adapters button { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line); border-radius: 6px; padding: 3px 10px; }
  .storage { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; padding: 6px 16px; border-top: 1px solid var(--line); background: var(--panel); font-size: 12px; color: var(--dim); }
  .storage details ul { margin: 4px 0; }
  @media (max-width: 720px) { .panes { grid-template-columns: 1fr; } nav { border-right: 0; border-bottom: 1px solid var(--line); } }
</style>
