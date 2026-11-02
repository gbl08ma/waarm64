<!--
  A machine's disks on the Machines page (docs/machines.md §4): in slot order, read-only or not, a ramdisk as swap, moved, detached;
  per writable disk its overlays (switch, new empty, rename, delete, merge into a stored disk), export (the changes or
  the whole disk) and import (a changes file becomes a new overlay). Add a disk… opens the wizard (AddDisk.svelte).
-->
<script lang="ts">
  import Check from './Check.svelte';
  import AddDisk from './AddDisk.svelte';
  import Icon from './Icon.svelte';
  import MoveButtons from './MoveButtons.svelte';
  import Menu from './Menu.svelte';
  import { ask } from './ask.svelte.ts';
  import type { Store, OverlayRecord } from './store.ts';
  import type { DiskRecord, MachineRecord } from './shape.ts';
  import { MAX_DISKS } from './shape.ts';
  import { bytesText, editAttachment } from './machines.ts';
  import { createOverlay, deleteOverlay, mergeCosts, mergeIntoDisk, renameOverlay, switchOverlay } from './disks.ts';
  import { URL_SLOW } from './urlcheck.ts';
  import type { ExportMode } from './export.ts';
  import { remember, settings } from './settings.ts';
  import { page } from './ui.svelte.ts';
  import type { IconName } from './icons.ts';

  type Props = {
    store: Store;
    machine: MachineRecord;
    disks: Map<string, DiskRecord>;
    overlays: OverlayRecord[];
    running: boolean;
    act(what: string, f: () => Promise<unknown>): Promise<void>;
    offFirst(m: MachineRecord): Promise<boolean>;
  };
  let { store, machine, disks, overlays, act, offFirst }: Props = $props();

  const plain = (m: MachineRecord) => $state.snapshot(m) as MachineRecord;
  const KIND: Record<string, { text: string; icon: IconName }> = {
    url: { text: 'from a URL', icon: 'world-www' },
    file: { text: 'a file on this computer', icon: 'file' },
    stored: { text: 'stored in the browser', icon: 'database' },
    blank: { text: 'blank', icon: 'square-dashed' },
    ramdisk: { text: 'ramdisk', icon: 'bolt' },
  };

  const SWAP_TITLE = "The guest's swap, turned on at every boot with nothing to do inside: the page formats the ramdisk as swap and tells systemd (254+: Debian 13, Arch; not Debian 12). It takes memory as the guest swaps and gives it back as the guest frees it.";
  const overlaysOf = (disk: string) => overlays.filter((o) => o.disk === disk).sort((a, b) => a.created - b.created);
  async function newOverlay(attachment: string, disk: DiskRecord) {
    const name = await ask.prompt('Name of the new, empty overlay (the disk as the image has it):', 'Fresh start', { title: 'New empty overlay', ok: 'Make it' });
    if (!name) return;
    await act('Making the overlay', async () => {
      if (!(await offFirst(machine))) return;
      const o = await createOverlay(store, disk, name);
      await switchOverlay(store, plain(machine), attachment, o.id);
    });
  }
  async function switchTo(attachment: string, overlay: string) {
    await act('Switching', async () => {
      if (!(await offFirst(machine))) return;
      await switchOverlay(store, plain(machine), attachment, overlay);
    });
  }
  async function rename(o: OverlayRecord) {
    const name = await ask.prompt('New name:', o.name, { title: `Rename ${o.name}`, ok: 'Rename' });
    if (name) await act('Renaming', () => renameOverlay(store, o.id, name));
  }
  async function remove(o: OverlayRecord) {
    if (!(await ask.confirm(`Delete the overlay ${o.name}? What the machines wrote to the disk in it (${bytesText(o.bytes)}) is deleted for good.`, { ok: 'Delete', danger: true }))) return;
    await act('Deleting', () => deleteOverlay(store, o.id));
  }
  async function merge(o: OverlayRecord, disk: DiskRecord) {
    const others = await mergeCosts(store, o.id);
    const pinned = new Set([`disks/${disk.id}`, `overlays/${o.id}`, ...others.map((x) => `overlays/${x.id}`)]);
    const snaps = (await store.all('snapshots')).filter((s) => s.pins.some((p) => p.overlay && pinned.has(p.overlay)));
    if (!(await ask.confirm(`Merge ${o.name} into ${disk.name}? Its changes become the disk's own.${others.length ? `\nThese overlays of the disk are deleted (they were made over its old bytes): ${others.map((x) => `${x.name} (${bytesText(x.bytes)})`).join(', ')}.` : ''}${snaps.length ? `\n${snaps.length} snapshot${snaps.length > 1 ? 's' : ''} pinning them can no longer restore onto the disk without their own copy of it.` : ''}`, { ok: 'Merge', danger: others.length > 0 }))) return;
    await act('Merging', () => mergeIntoDisk(store, o.id));
  }
  /**
   * An attachment's read-only, in-place or swap box. Its value is taken from the event at once: Svelte's delegated events lose
   * `currentTarget` once dispatched, so read after an await (the power-off question) it was null and nothing was saved.
   */
  function setFlag(id: string, flag: { readOnly?: boolean; inPlace?: boolean; swap?: boolean }) {
    void act('Changing', async () => { if (await offFirst(machine)) await editAttachment(store, plain(machine), id, flag); });
  }
  async function detach(id: string, d: DiskRecord | undefined) {
    const mine = d ? overlaysOf(d.id) : [];
    const bytes = mine.reduce((n, o) => n + o.bytes, 0);
    const kept = d?.kind === 'ramdisk' ? 'The ramdisk stays in this browser (empty).' : `The disk stays in this browser${mine.length ? ` with its ${mine.length} overlay${mine.length === 1 ? '' : 's'} (${bytesText(bytes)})` : ''}, taking its space there.`;
    if (!(await ask.confirm(`Detach ${d?.name ?? 'the disk'} from ${machine.name}? ${kept} Add a disk… › A disk already in this browser attaches it again (here or to another machine), and deletes it when no machine has it.`, { title: 'Detach a disk', ok: 'Detach' }))) return;
    await act('Detaching', async () => { if (await offFirst(machine)) await editAttachment(store, plain(machine), id, { detach: true }); });
  }

  // Export and import.
  let compress = $state(settings().compress ?? true);
  let exportOpen = $state<Record<string, boolean>>({});
  function save(id: string, disk: DiskRecord, overlay: string | undefined, mode: ExportMode) {
    exportOpen[id] = false;
    page.saveDisk(mode, mode !== 'raw' && compress, { disk: $state.snapshot(disk) as DiskRecord, overlay });
  }
  let importInputs = $state<Record<string, HTMLInputElement>>({});
  const imported = (attachment: string) => (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    const f = input.files?.[0];
    input.value = '';
    if (f) page.importChanges(f, { machine: plain(machine), attachment });
  };

  let adding = $state(false);
</script>

{#snippet exportMenu(id: string, disk: DiskRecord, overlay: string | undefined, changes: boolean)}
  <Menu id={`export-${id}`} icon="download" title="Save the disk to a file: the changes over the image, or the whole disk" label="Export" bind:open={() => exportOpen[id] ?? false, (v) => (exportOpen[id] = v)} align="left">
    {#if changes}<button data-save="changes" title="A small qcow2 holding what the machine wrote, with the image as its backing file (keep it beside it)" onclick={() => save(id, disk, overlay, 'changes')}>Changes only (qcow2)</button>{/if}
    <button data-save="qcow2" title="The whole disk as a qcow2 (empty space left out)" onclick={() => save(id, disk, overlay, 'qcow2')}>Whole disk (qcow2)</button>
    <button data-save="raw" title="The whole disk as a raw image" onclick={() => save(id, disk, overlay, 'raw')}>Whole disk (raw)</button>
    <Check bind:checked={compress} onchange={() => remember({ compress })} title="Compressed clusters (deflate), as qemu-img convert -c writes them: the file is about half the size and takes longer to write">Compress the qcow2</Check>
    <p class="hint">A machine running from the disk stops while the file is written, and starts again after.</p>
  </Menu>
{/snippet}

<ol class="disks">
  {#each machine.attachments as a, i (a.id)}
    {@const d = disks.get(a.disk)}
    <li data-attachment={a.id}>
      <div class="row">
        <span class="kind" title={d ? KIND[d.kind].text : ''}><Icon name={d ? KIND[d.kind].icon : 'x'} size={18} /></span>
        <strong>{d?.name ?? 'missing disk'}</strong>
        <span class="meta">{d ? `${KIND[d.kind].text}, ${bytesText(d.size)}` : ''} · vd{String.fromCharCode(97 + i)}</span>
        <span class="grow"></span>
        <Check compact checked={a.readOnly} disabled={d?.kind === 'blank' || d?.kind === 'ramdisk'} onchange={(on) => setFlag(a.id, { readOnly: on })}>read-only</Check>
        {#if d?.kind === 'ramdisk'}
          <Check compact checked={!!a.swap} onchange={(on) => setFlag(a.id, { swap: on })} title={SWAP_TITLE}>swap</Check>
        {/if}
        {#if d?.kind === 'stored' && !a.readOnly}
          <Check compact checked={!!a.inPlace} onchange={(on) => setFlag(a.id, { inPlace: on })} title="The guest's writes go into the stored disk itself: no overlay, no variants, and snapshots can't fork it.">write in place</Check>
        {/if}
        <MoveButtons index={i} count={machine.attachments.length} onmove={(by) => act('Moving', () => editAttachment(store, plain(machine), a.id, { move: by }))} upTitle="Move up (an earlier slot)" downTitle="Move down (a later slot)" />
        <button onclick={() => detach(a.id, d)} title="Take the disk off this machine (it stays in this browser)">Detach</button>
      </div>
      {#if d?.kind === 'url'}<p class="note">{URL_SLOW}</p>{/if}
      {#if d && !a.readOnly && d.kind !== 'ramdisk' && !a.inPlace}
        <div class="overlays">
          <label>Changes in
            <select value={a.overlay ?? ''} onchange={(e) => switchTo(a.id, e.currentTarget.value)} data-field="overlay">
              {#if !a.overlay}<option value="">(a new overlay, at the next start)</option>{/if}
              {#each overlaysOf(d.id) as o (o.id)}<option value={o.id}>{o.name} ({bytesText(o.bytes)}{o.fork ? ', forked' : ''})</option>{/each}
            </select>
          </label>
          <button onclick={() => newOverlay(a.id, d)} title="A new, empty overlay: the disk as the image has it (the one it has now is kept)"><Icon name="plus" size={16} />New empty</button>
          {#if a.overlay}
            {@const o = overlays.find((x) => x.id === a.overlay)}
            {#if o}
              <button onclick={() => rename(o)} title="Rename this overlay"><Icon name="pencil" size={16} />Rename</button>
              <button onclick={() => remove(o)} title="Delete this overlay: what was written in it is lost"><Icon name="trash" size={16} />Delete</button>
              {#if d.kind === 'stored'}<button onclick={() => merge(o, d)} title="Write this overlay's changes into the stored disk itself"><Icon name="git-merge" size={16} />Merge into the disk</button>{/if}
              {@render exportMenu(a.id, d, o.id, d.kind !== 'blank')}
            {/if}
          {/if}
          {#if d.kind !== 'blank'}
            <button onclick={() => importInputs[a.id]?.click()} title="A changes file (Export › Changes only) of this disk becomes a new overlay, which the disk switches to"><Icon name="upload" size={16} />Import changes…</button>
            <input type="file" hidden bind:this={importInputs[a.id]} onchange={imported(a.id)} data-field="import-changes">
          {/if}
        </div>
      {:else if d?.kind === 'stored'}
        <div class="overlays">{@render exportMenu(a.id, d, undefined, false)}</div>
      {/if}
    </li>
  {:else}
    <li class="none">No disks yet.</li>
  {/each}
</ol>
{#if machine.attachments.length < MAX_DISKS}
  <button class="add" onclick={() => (adding = true)} data-action="add-disk-open"><Icon name="plus" size={16} />Add a disk…</button>
{:else}
  <p class="note">{MAX_DISKS} disks: a machine takes no more.</p>
{/if}
{#if adding}<AddDisk {store} {machine} {act} {offFirst} close={() => (adding = false)} />{/if}

<style>
  .disks { list-style: none; margin: 0 0 12px; padding: 0; display: flex; flex-direction: column; gap: 8px; }
  .disks > li { padding: 10px 12px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); }
  .disks > li.none { color: var(--dim); }
  .row, .overlays { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .overlays { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--line); }
  .grow { flex: 1; }
  .kind { color: var(--dim); }
  .meta, .note, .hint { color: var(--dim); font-size: 12px; }
  .note { margin: 4px 0 0; }
  .hint { margin: 4px 8px; max-width: 260px; }
  .overlays > label { display: inline-flex; align-items: center; gap: 6px; }
  .row > button, .overlays > button, .add { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line); border-radius: 6px; padding: 3px 10px; }
  .add { padding: 5px 12px; }
</style>
