<!--
  The Machines modal (docs/plans/machines.md §7): the machines kept in this browser, one machine's settings, its
  disks (from any source; per writable disk its overlays: new, rename, switch, delete, export, merge into a stored
  disk), its snapshots, and the browser's storage. Logic is in web/app/machines.ts and disks.ts; this is the view.
  Every action that loses data asks first; edits that need the machine off say so (web/app/machines.ts `needsOff`).
-->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { Store, OverlayRecord } from './store.ts';
  import type { DiskRecord, MachineRecord, Shape } from './shape.ts';
  import { MAX_DISKS } from './shape.ts';
  import { askPersist, attach, bytesText, createDisk, createMachine, deleteMachine, duplicateMachine, editAttachment, isRunning, storageReport, updateMachine } from './machines.ts';
  import { createOverlay, deleteOverlay, diskRef, estimateStored, importStored, mergeCosts, mergeIntoDisk, renameOverlay, switchOverlay } from './disks.ts';
  import { checkUrl, URL_SLOW, type UrlCheck } from './urlcheck.ts';
  import { runExport, type ExportMode } from './export.ts';
  import Snapshots from './Snapshots.svelte';
  import { exportDefinition, importDefinition, parseDefinition } from './definitions.ts';

  type Props = {
    store: Store;
    /** The machine this page runs (or shows), if a stored one. */
    current?: string;
    /** Opens machine `id` on this page (it stops the one running, after asking). */
    open(id: string): void;
    /** Powers this page's machine off (resolves once it is off). */
    powerOff(): Promise<void>;
    close(): void;
    /** A machine's shape as it would run on this page, and its hash (its snapshots are checked against it). */
    shapeNow(m: MachineRecord): Promise<{ shape: Shape; hash: string }>;
    /** Restore kept snapshot `id`, apply a file, save a snapshot to a file: on this page's machine (web/app/main.ts). */
    restore(id: string): void;
    apply(file: File): void;
    saveToFile(whole: boolean): void;
  };
  let { store, current, open, powerOff, close, shapeNow, restore, apply, saveToFile }: Props = $props();

  let machines = $state<MachineRecord[]>([]);
  let disks = $state<Map<string, DiskRecord>>(new Map());
  let overlays = $state<OverlayRecord[]>([]);
  let running = $state<Set<string>>(new Set());
  let selected = $state<string | undefined>(current);
  let draft = $state<MachineRecord | undefined>();
  let error = $state('');
  let busy = $state('');
  let storage = $state<Awaited<ReturnType<typeof storageReport>> | undefined>();

  const CPU_CHOICES = [1, 2, 3, 4, 6, 8];
  const RAM_CHOICES = [512, 1024, 1536, 2048, 2560, 3072];

  async function reread() {
    machines = (await store.all('machines')).sort((a, b) => a.name.localeCompare(b.name));
    disks = new Map((await store.all('disks')).map((d) => [d.id, d]));
    overlays = await store.all('overlays');
    running = new Set((await Promise.all(machines.map(async (m) => ((await isRunning(m.id)) ? m.id : '')))).filter(Boolean));
    if (selected && !machines.some((m) => m.id === selected)) selected = undefined;
    const m = machines.find((x) => x.id === selected);
    draft = m ? structuredClone($state.snapshot(m)) as MachineRecord : undefined;
    storage = await storageReport(store).catch(() => undefined);
  }
  void reread();
  const unsubscribe = store.onChange(() => void reread());
  onDestroy(unsubscribe);

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

  const choose = (id: string) => { selected = id; void reread(); };
  /** A machine as a plain object (the modal's draft is reactive state, which IndexedDB can't clone). */
  const plain = (m: MachineRecord) => $state.snapshot(m) as MachineRecord;
  const isOn = (id: string) => running.has(id);
  const kindText: Record<string, string> = { url: 'URL', file: 'file', stored: 'stored in the browser', blank: 'blank', ramdisk: 'ramdisk' };

  async function offFirst(m: MachineRecord) {
    if (!isOn(m.id)) return true;
    if (m.id !== current) { error = 'It runs in another tab: power it off there first.'; return false; }
    if (!confirm(`Power ${m.name} off? Like pulling the plug: unsaved work in the guest is lost.`)) return false;
    await powerOff();
    await reread();
    return true;
  }

  async function saveSettings() {
    const m = draft!;
    await act('Saving', async () => {
      const was = machines.find((x) => x.id === m.id)!;
      if ((was.ramMiB !== m.ramMiB || was.ncpus !== m.ncpus || was.display !== m.display || was.network !== m.network) && !(await offFirst(was))) return;
      const orphaned = (await store.snapshotsOf(m.id)).length;
      if (orphaned && (was.ramMiB !== m.ramMiB || was.ncpus !== m.ncpus || was.display !== m.display || was.network !== m.network) && !confirm(`This change orphans its snapshots: they were taken of a machine with the old settings (they stay, marked, until deleted).`)) return;
      await updateMachine(store, $state.snapshot(m) as MachineRecord);
    });
  }

  // Adding a disk.
  let source = $state<'url' | 'file' | 'stored' | 'blank' | 'ramdisk'>('url');
  let url = $state('');
  let urlCheck = $state<UrlCheck | undefined>();
  let sizeMiB = $state(1024);
  let readOnly = $state(false);
  let picked = $state<{ file: File; handle?: FileSystemFileHandle } | undefined>();

  async function pick() {
    const picker = (window as unknown as { showOpenFilePicker?: () => Promise<FileSystemFileHandle[]> }).showOpenFilePicker;
    if (picker) {
      try {
        const [handle] = await picker.call(window);
        picked = { file: await handle.getFile(), handle };
      } catch (e) {
        if ((e as DOMException).name !== 'AbortError') error = String(e);
      }
    } else fileInput.click();
  }
  let fileInput: HTMLInputElement;
  const picked1 = () => { const f = fileInput.files?.[0]; if (f) picked = { file: f }; fileInput.value = ''; };

  /** A disk image's virtual size from its first bytes (a qcow2's header), else its length. */
  const virtualSize = (head: Uint8Array | undefined, bytes: number) => (head && head.length >= 32 && new DataView(head.buffer, head.byteOffset).getUint32(0) === 0x514649fb ? Number(new DataView(head.buffer, head.byteOffset).getBigUint64(24)) : bytes);

  async function addDisk() {
    const m = draft!;
    await act('Adding the disk', async () => {
      if (!(await offFirst(m))) return;
      let d: DiskRecord;
      if (source === 'url') {
        urlCheck = await checkUrl(url);
        if (!urlCheck.ok) throw new Error(`The URL can't be a disk:\n${urlCheck.problems.join('\n')}`);
        d = await createDisk(store, { kind: 'url', url, size: virtualSize(urlCheck.head, urlCheck.bytes!), bytes: urlCheck.bytes!, etag: urlCheck.etag, lastModified: urlCheck.lastModified });
      } else if (source === 'file' || source === 'stored') {
        if (!picked) throw new Error('Pick a file first.');
        if (source === 'file') {
          const head = new Uint8Array(await picked.file.slice(0, 32).arrayBuffer());
          d = await createDisk(store, { kind: 'file', file: picked.file, handle: picked.handle, size: virtualSize(head, picked.file.size) });
        } else {
          const e = await estimateStored(picked.file);
          const est = await navigator.storage.estimate();
          if (!confirm(`Store a copy of ${picked.file.name} in this browser? It takes about ${bytesText(e.estimate)} of the browser's storage (${bytesText((est.quota ?? 0) - (est.usage ?? 0))} free), which you can't easily see outside this page, and duplicates the file you have. It then needs no picking again, can take an overlay in place and be written in place.`)) return;
          await askPersist();
          d = await importStored(store, picked.file, (f) => { busy = `Storing ${picked!.file.name}: ${Math.floor(100 * f)}%`; });
        }
      } else {
        d = await createDisk(store, { kind: source, size: sizeMiB * 2 ** 20 });
      }
      await attach(store, plain(m), d, { readOnly: source === 'blank' || source === 'ramdisk' ? false : readOnly });
      picked = undefined;
      url = '';
      urlCheck = undefined;
    });
  }

  // Overlays.
  const overlaysOf = (disk: string) => overlays.filter((o) => o.disk === disk).sort((a, b) => a.created - b.created);
  async function newOverlay(m: MachineRecord, attachment: string, disk: DiskRecord) {
    const name = prompt('Name of the new, empty overlay (the disk as the image has it):', 'Fresh start');
    if (!name) return;
    await act('Making the overlay', async () => {
      if (!(await offFirst(m))) return;
      const o = await createOverlay(store, disk, name);
      await switchOverlay(store, plain(m), attachment, o.id);
    });
  }
  async function switchTo(m: MachineRecord, attachment: string, overlay: string) {
    await act('Switching', async () => {
      if (!(await offFirst(m))) return;
      await switchOverlay(store, plain(m), attachment, overlay);
    });
  }
  async function rename(o: OverlayRecord) {
    const name = prompt('New name:', o.name);
    if (name) await act('Renaming', () => renameOverlay(store, o.id, name));
  }
  async function remove(o: OverlayRecord) {
    if (!confirm(`Delete the overlay ${o.name}? What the machines wrote to the disk in it (${bytesText(o.bytes)}) is deleted for good.`)) return;
    await act('Deleting', () => deleteOverlay(store, o.id));
  }
  async function merge(o: OverlayRecord, disk: DiskRecord) {
    const others = await mergeCosts(store, o.id);
    const pinned = new Set([`disks/${disk.id}`, `overlays/${o.id}`, ...others.map((x) => `overlays/${x.id}`)]);
    const snaps = (await store.all('snapshots')).filter((s) => s.pins.some((p) => p.overlay && pinned.has(p.overlay)));
    if (!confirm(`Merge ${o.name} into ${disk.name}? Its changes become the disk's own.${others.length ? `\nThese overlays of the disk are deleted (they were made over its old bytes): ${others.map((x) => `${x.name} (${bytesText(x.bytes)})`).join(', ')}.` : ''}${snaps.length ? `\n${snaps.length} snapshot${snaps.length > 1 ? 's' : ''} pinning them can no longer restore onto the disk without their own copy of it.` : ''}`)) return;
    await act('Merging', () => mergeIntoDisk(store, o.id));
  }
  async function exportDisk(disk: DiskRecord, overlay: string | undefined, mode: ExportMode, compress: boolean) {
    await act('Saving the disk', async () => {
      const r = await runExport({ mode, compress, disk: await diskRef(disk, overlay), baseName: disk.name }, (phase, f) => { busy = `${phase} ${Math.floor(100 * f)}%`; });
      const stem = disk.name.replace(/\.(qcow2|img|raw|iso)$/i, '');
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(r.blob!), download: `${stem}${mode === 'changes' ? '-changes.qcow2' : mode === 'qcow2' ? '.qcow2' : '.img'}` });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
    });
  }
  let compress = $state(true);

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
      selected = r.machine.id;
      if (r.toPick.length) error = `${r.machine.name} is made. Its files are picked when it first starts: ${r.toPick.join(', ')}.`;
    });
  };
</script>

<div class="machines" data-busy={busy || undefined}>
  <header>
    <h2>Machines</h2>
    <button class="close" onclick={close} aria-label="Close">×</button>
  </header>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if busy}<p class="busy">{busy}…</p>{/if}
  <div class="panes">
    <nav>
      <ul>
        {#each machines as m (m.id)}
          <li class:chosen={m.id === selected}>
            <button class="pick" onclick={() => choose(m.id)} data-machine={m.id}>
              <span class="name">{m.name}</span>
              <span class="meta">{m.attachments.length} disk{m.attachments.length === 1 ? '' : 's'} · {isOn(m.id) ? 'running' : m.id === current ? 'on this page' : 'off'}</span>
            </button>
          </li>
        {/each}
      </ul>
      <button onclick={() => act('Making a machine', async () => { selected = (await createMachine(store)).id; })} data-action="new-machine">New machine</button>
      <button onclick={() => defInput.click()} title="A machine definition (.webpc-machine.json): its settings and disks, without their contents">Import a definition…</button>
      <input type="file" accept=".json,application/json" hidden bind:this={defInput} onchange={importDef} data-field="import-definition">
    </nav>

    {#if draft}
      {@const m = draft}
      <section class="machine" data-selected={m.id}>
        <div class="row">
          <button onclick={() => open(m.id)} data-action="open" disabled={m.id === current}>{m.id === current ? 'On this page' : 'Open on this page'}</button>
          <button onclick={() => act('Copying', async () => { selected = (await duplicateMachine(store, m.id)).id; })}>Duplicate</button>
          <button onclick={() => exportDef(m)} title="The machine's settings and disks (which files, which URLs), without their contents, overlays or snapshots">Export the definition</button>
          <button onclick={() => { if (confirm(`Delete ${m.name}? Its snapshots and firmware settings are deleted; its disks and their overlays stay.`)) void act('Deleting', () => deleteMachine(store, m.id)); }}>Delete</button>
        </div>
        <fieldset>
          <legend>Settings</legend>
          <label>Name <input bind:value={draft.name} data-field="name"></label>
          <label>vCPUs <select bind:value={draft.ncpus} data-field="ncpus">{#each CPU_CHOICES as n}<option value={n}>{n}</option>{/each}</select></label>
          <label>RAM <select bind:value={draft.ramMiB} data-field="ram">{#each RAM_CHOICES as n}<option value={n}>{n} MiB</option>{/each}</select></label>
          <label>Display <select bind:value={draft.display} data-field="display"><option value="3d">3D (WebGL2)</option><option value="2d">2D</option></select></label>
          <label><input type="checkbox" bind:checked={draft.network}> Network card</label>
          <button onclick={saveSettings} data-action="save">Save</button>
        </fieldset>

        <fieldset>
          <legend>Disks ({m.attachments.length} of {MAX_DISKS})</legend>
          <ol class="disks">
            {#each m.attachments as a, i (a.id)}
              {@const d = disks.get(a.disk)}
              <li data-attachment={a.id}>
                <div class="row">
                  <strong>{d?.name ?? 'missing disk'}</strong>
                  <span class="meta">{d ? `${kindText[d.kind]}, ${bytesText(d.size)}` : ''} · vd{String.fromCharCode(97 + i)}</span>
                  <label><input type="checkbox" checked={a.readOnly} disabled={d?.kind === 'blank' || d?.kind === 'ramdisk'} onchange={(e) => act('Changing', async () => { if (await offFirst(m)) await editAttachment(store, plain(m), a.id, { readOnly: e.currentTarget.checked }); })}> read-only</label>
                  {#if d?.kind === 'stored' && !a.readOnly}
                    <label title="The guest's writes go into the stored disk itself: no overlay, no variants, and snapshots can't fork it."><input type="checkbox" checked={!!a.inPlace} onchange={(e) => act('Changing', async () => { if (await offFirst(m)) await editAttachment(store, plain(m), a.id, { inPlace: e.currentTarget.checked }); })}> write in place</label>
                  {/if}
                  <button onclick={() => act('Moving', () => editAttachment(store, plain(m), a.id, { move: -1 }))} disabled={i === 0} aria-label="Up">↑</button>
                  <button onclick={() => act('Moving', () => editAttachment(store, plain(m), a.id, { move: 1 }))} disabled={i === m.attachments.length - 1} aria-label="Down">↓</button>
                  <button onclick={() => act('Detaching', async () => { if (await offFirst(m)) await editAttachment(store, plain(m), a.id, { detach: true }); })}>Detach</button>
                </div>
                {#if d?.kind === 'url'}<p class="note">{URL_SLOW}</p>{/if}
                {#if d && !a.readOnly && d.kind !== 'ramdisk' && !a.inPlace}
                  <div class="overlays">
                    <label>Changes in
                      <select value={a.overlay ?? ''} onchange={(e) => switchTo(m, a.id, e.currentTarget.value)} data-field="overlay">
                        {#if !a.overlay}<option value="">(a new overlay, at the next start)</option>{/if}
                        {#each overlaysOf(d.id) as o (o.id)}<option value={o.id}>{o.name} ({bytesText(o.bytes)}{o.fork ? ', forked' : ''})</option>{/each}
                      </select>
                    </label>
                    <button onclick={() => newOverlay(m, a.id, d)}>New empty</button>
                    {#if a.overlay}
                      {@const o = overlays.find((x) => x.id === a.overlay)}
                      {#if o}
                        <button onclick={() => rename(o)}>Rename</button>
                        <button onclick={() => remove(o)}>Delete</button>
                        {#if d.kind === 'stored'}<button onclick={() => merge(o, d)}>Merge into the disk</button>{/if}
                        {#if d.kind !== 'blank'}<button onclick={() => exportDisk(d, o.id, 'changes', compress)}>Save changes</button>{/if}
                        <button onclick={() => exportDisk(d, o.id, 'qcow2', compress)}>Save whole disk (qcow2)</button>
                        <button onclick={() => exportDisk(d, o.id, 'raw', false)}>Save whole disk (raw)</button>
                      {/if}
                    {/if}
                  </div>
                {:else if d?.kind === 'stored'}
                  <div class="overlays">
                    <button onclick={() => exportDisk(d, undefined, 'qcow2', compress)}>Save the disk (qcow2)</button>
                    <button onclick={() => exportDisk(d, undefined, 'raw', false)}>Save the disk (raw)</button>
                  </div>
                {/if}
              </li>
            {/each}
          </ol>
          <label><input type="checkbox" bind:checked={compress}> Compress saved qcow2 files</label>
          {#if m.attachments.length < MAX_DISKS}
            <div class="add">
              <label>Add a disk
                <select bind:value={source} data-field="source">
                  <option value="url">from a URL</option>
                  <option value="file">a file on this computer</option>
                  <option value="stored">a file, stored in the browser</option>
                  <option value="blank">blank</option>
                  <option value="ramdisk">ramdisk (empty at every boot)</option>
                </select>
              </label>
              {#if source === 'url'}
                <input type="url" placeholder="https://…/disk.qcow2" bind:value={url} data-field="url">
                <button onclick={() => act('Checking', async () => { urlCheck = await checkUrl(url); })}>Check</button>
                {#if urlCheck}
                  {#if urlCheck.ok}<p class="ok">The server can serve it ({urlCheck.bytes ? bytesText(urlCheck.bytes) : 'size unknown'}). {URL_SLOW}</p>
                  {:else}<ul class="problems">{#each urlCheck.problems as p}<li>{p}</li>{/each}</ul>{/if}
                {/if}
              {:else if source === 'file' || source === 'stored'}
                <button onclick={pick}>Pick a file…</button> {picked?.file.name ?? ''}
                <input type="file" hidden bind:this={fileInput} onchange={picked1} data-field="file">
                {#if source === 'stored'}<p class="note">A copy goes into this browser's storage: it duplicates the file, in storage you can't easily see outside this page.</p>{/if}
              {:else}
                <label>Size <input type="number" min="1" bind:value={sizeMiB} data-field="size"> MiB</label>
                {#if source === 'ramdisk'}<p class="note">In this computer's memory, empty at every boot (the guest's reboot too); it takes memory as the guest fills it, and gives it back when the guest trims (fstrim).</p>{/if}
              {/if}
              {#if source !== 'blank' && source !== 'ramdisk'}<label><input type="checkbox" bind:checked={readOnly}> read-only</label>{/if}
              <button onclick={addDisk} data-action="add-disk">Add</button>
            </div>
          {/if}
        </fieldset>

        <Snapshots {store} machine={m} {disks} {overlays} {current} running={isOn(m.id)} {act} {shapeNow} {restore} {apply} {saveToFile} {choose} />
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
  .machines { display: flex; flex-direction: column; gap: 8px; color: #e6e6e6; font: 14px system-ui, sans-serif; max-height: 90vh; }
  header { display: flex; justify-content: space-between; align-items: center; }
  h2 { margin: 0; font-size: 18px; }
  .panes { display: grid; grid-template-columns: minmax(160px, 220px) 1fr; gap: 12px; overflow: auto; min-height: 0; }
  nav ul { list-style: none; margin: 0 0 8px; padding: 0; }
  nav li.chosen .pick { background: #2b3440; }
  .pick { display: flex; flex-direction: column; align-items: flex-start; width: 100%; text-align: left; }
  .meta { color: #9aa4ae; font-size: 12px; }
  fieldset { border: 1px solid #333a43; border-radius: 6px; margin: 0 0 10px; }
  .row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .disks { padding-left: 20px; }
  .disks li { margin-bottom: 8px; }
  .overlays, .add { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-top: 4px; }
  .note { color: #9aa4ae; font-size: 12px; margin: 2px 0; }
  .error { color: #ff8f8f; white-space: pre-wrap; }
  .ok { color: #8fd18f; }
  .problems { color: #ffb36b; }
  .storage { font-size: 12px; color: #9aa4ae; }
  @media (max-width: 640px) { .panes { grid-template-columns: 1fr; } }
</style>
