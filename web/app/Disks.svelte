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
  import { msg, t, text } from '../i18n.ts';
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
    url: { text: t('disks:Disks.kind.url'), icon: 'world-www' },
    file: { text: t('disks:Disks.kind.file'), icon: 'file' },
    stored: { text: t('disks:Disks.kind.stored'), icon: 'database' },
    blank: { text: t('disks:Disks.kind.blank'), icon: 'square-dashed' },
    ramdisk: { text: t('disks:Disks.kind.ramdisk'), icon: 'bolt' },
  };
  const overlaysOf = (disk: string) => overlays.filter((o) => o.disk === disk).sort((a, b) => a.created - b.created);
  async function newOverlay(attachment: string, disk: DiskRecord) {
    const name = await ask.prompt(t('disks:Disks.newOverlay.text'), t('disks:Disks.newOverlay.name'), { title: t('disks:Disks.newOverlay.title'), ok: t('disks:Disks.newOverlay.ok') });
    if (!name) return;
    await act(t('disks:Disks.busy.newOverlay'), async () => {
      if (!(await offFirst(machine))) return;
      const o = await createOverlay(store, disk, name);
      await switchOverlay(store, plain(machine), attachment, o.id);
    });
  }
  async function switchTo(attachment: string, overlay: string) {
    await act(t('disks:Disks.busy.switch'), async () => {
      if (!(await offFirst(machine))) return;
      await switchOverlay(store, plain(machine), attachment, overlay);
    });
  }
  async function rename(o: OverlayRecord) {
    const name = await ask.prompt(t('disks:Disks.rename.text'), o.name, { title: t('disks:Disks.rename.title', { name: o.name }), ok: t('disks:Disks.rename.ok') });
    if (name) await act(t('disks:Disks.busy.rename'), () => renameOverlay(store, o.id, name));
  }
  async function remove(o: OverlayRecord) {
    if (!(await ask.confirm(t('disks:Disks.delete.confirm', { name: o.name, size: bytesText(o.bytes) }), { ok: t('disks:Disks.delete.ok'), danger: true }))) return;
    await act(t('disks:Disks.busy.delete'), () => deleteOverlay(store, o.id));
  }
  async function merge(o: OverlayRecord, disk: DiskRecord) {
    const others = await mergeCosts(store, o.id);
    const pinned = new Set([`disks/${disk.id}`, `overlays/${o.id}`, ...others.map((x) => `overlays/${x.id}`)]);
    const snaps = (await store.all('snapshots')).filter((s) => s.pins.some((p) => p.overlay && pinned.has(p.overlay)));
    const deleted = others.length ? msg('disks:Disks.merge.others', { list: others.map((x) => msg('disks:Disks.merge.other', { name: x.name, size: bytesText(x.bytes) })) }) : undefined;
    const orphaned = snaps.length ? msg('disks:Disks.merge.snapshots', { count: snaps.length }) : undefined;
    if (!(await ask.confirm(t('disks:Disks.merge.confirm', { overlay: o.name, disk: disk.name, others: deleted, snapshots: orphaned }), { ok: t('disks:Disks.merge.ok'), danger: others.length > 0 }))) return;
    await act(t('disks:Disks.busy.merge'), () => mergeIntoDisk(store, o.id));
  }
  /**
   * An attachment's read-only, in-place or swap box. Its value is taken from the event at once: Svelte's delegated events lose
   * `currentTarget` once dispatched, so read after an await (the power-off question) it was null and nothing was saved.
   */
  function setFlag(id: string, flag: { readOnly?: boolean; inPlace?: boolean; swap?: boolean }) {
    void act(t('disks:Disks.busy.change'), async () => { if (await offFirst(machine)) await editAttachment(store, plain(machine), id, flag); });
  }
  async function detach(id: string, d: DiskRecord | undefined) {
    const mine = d ? overlaysOf(d.id) : [];
    const bytes = mine.reduce((n, o) => n + o.bytes, 0);
    const kept = d?.kind === 'ramdisk' ? msg('disks:Disks.detach.keptRamdisk') : mine.length ? msg('disks:Disks.detach.keptOverlays', { count: mine.length, size: bytesText(bytes) }) : msg('disks:Disks.detach.kept');
    if (!(await ask.confirm(t('disks:Disks.detach.confirm', { disk: d?.name ?? msg('disks:Disks.detach.theDisk'), machine: machine.name, kept }), { title: t('disks:Disks.detach.title'), ok: t('disks:Disks.detach.ok') }))) return;
    await act(t('disks:Disks.busy.detach'), async () => { if (await offFirst(machine)) await editAttachment(store, plain(machine), id, { detach: true }); });
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
  <Menu id={`export-${id}`} icon="download" title={t('disks:Disks.export.title')} label={t('disks:Disks.export')} bind:open={() => exportOpen[id] ?? false, (v) => (exportOpen[id] = v)} align="left">
    {#if changes}<button data-save="changes" title={t('disks:Disks.export.changes.title')} onclick={() => save(id, disk, overlay, 'changes')}>{t('disks:Disks.export.changes')}</button>{/if}
    <button data-save="qcow2" title={t('disks:Disks.export.qcow2.title')} onclick={() => save(id, disk, overlay, 'qcow2')}>{t('disks:Disks.export.qcow2')}</button>
    <button data-save="raw" title={t('disks:Disks.export.raw.title')} onclick={() => save(id, disk, overlay, 'raw')}>{t('disks:Disks.export.raw')}</button>
    <Check bind:checked={compress} onchange={() => remember({ compress })} title={t('disks:Disks.export.compress.title')}>{t('disks:Disks.export.compress')}</Check>
    <p class="hint">{t('disks:Disks.export.hint')}</p>
  </Menu>
{/snippet}

<ol class="disks">
  {#each machine.attachments as a, i (a.id)}
    {@const d = disks.get(a.disk)}
    <li data-attachment={a.id}>
      <div class="row">
        <span class="kind" title={d ? KIND[d.kind].text : ''}><Icon name={d ? KIND[d.kind].icon : 'x'} size={18} /></span>
        <strong>{d?.name ?? t('disks:Disks.missing')}</strong>
        <span class="meta">{d ? t('disks:Disks.meta', { kind: KIND[d.kind].text, size: bytesText(d.size), letter: String.fromCharCode(97 + i) }) : t('disks:Disks.meta.missing', { letter: String.fromCharCode(97 + i) })}</span>
        <span class="grow"></span>
        <Check compact checked={a.readOnly} disabled={d?.kind === 'blank' || d?.kind === 'ramdisk'} onchange={(on) => setFlag(a.id, { readOnly: on })}>{t('disks:Disks.readOnly')}</Check>
        {#if d?.kind === 'ramdisk'}
          <Check compact checked={!!a.swap} onchange={(on) => setFlag(a.id, { swap: on })} title={t('disks:Disks.swap.title')}>{t('disks:Disks.swap')}</Check>
        {/if}
        {#if d?.kind === 'stored' && !a.readOnly}
          <Check compact checked={!!a.inPlace} onchange={(on) => setFlag(a.id, { inPlace: on })} title={t('disks:Disks.inPlace.title')}>{t('disks:Disks.inPlace')}</Check>
        {/if}
        <MoveButtons index={i} count={machine.attachments.length} onmove={(by) => act(t('disks:Disks.busy.move'), () => editAttachment(store, plain(machine), a.id, { move: by }))} upTitle={t('disks:Disks.moveUp.title')} downTitle={t('disks:Disks.moveDown.title')} />
        <button onclick={() => detach(a.id, d)} title={t('disks:Disks.detach.button.title')}>{t('disks:Disks.detach.button')}</button>
      </div>
      {#if d?.kind === 'url'}<p class="note">{text(URL_SLOW)}</p>{/if}
      {#if d && !a.readOnly && d.kind !== 'ramdisk' && !a.inPlace}
        <div class="overlays">
          <label>{t('disks:Disks.overlays.label')}
            <select value={a.overlay ?? ''} onchange={(e) => switchTo(a.id, e.currentTarget.value)} data-field="overlay">
              {#if !a.overlay}<option value="">{t('disks:Disks.overlays.none')}</option>{/if}
              {#each overlaysOf(d.id) as o (o.id)}<option value={o.id}>{o.fork ? t('disks:Disks.overlays.forked', { name: o.name, size: bytesText(o.bytes) }) : t('disks:Disks.overlays.option', { name: o.name, size: bytesText(o.bytes) })}</option>{/each}
            </select>
          </label>
          <button onclick={() => newOverlay(a.id, d)} title={t('disks:Disks.newEmpty.title')}><Icon name="plus" size={16} />{t('disks:Disks.newEmpty')}</button>
          {#if a.overlay}
            {@const o = overlays.find((x) => x.id === a.overlay)}
            {#if o}
              <button onclick={() => rename(o)} title={t('disks:Disks.renameButton.title')}><Icon name="pencil" size={16} />{t('disks:Disks.renameButton')}</button>
              <button onclick={() => remove(o)} title={t('disks:Disks.deleteButton.title')}><Icon name="trash" size={16} />{t('disks:Disks.deleteButton')}</button>
              {#if d.kind === 'stored'}<button onclick={() => merge(o, d)} title={t('disks:Disks.mergeButton.title')}><Icon name="git-merge" size={16} />{t('disks:Disks.mergeButton')}</button>{/if}
              {@render exportMenu(a.id, d, o.id, d.kind !== 'blank')}
            {/if}
          {/if}
          {#if d.kind !== 'blank'}
            <button onclick={() => importInputs[a.id]?.click()} title={t('disks:Disks.importChanges.title')}><Icon name="upload" size={16} />{t('disks:Disks.importChanges')}</button>
            <input type="file" hidden bind:this={importInputs[a.id]} onchange={imported(a.id)} data-field="import-changes">
          {/if}
        </div>
      {:else if d?.kind === 'stored'}
        <div class="overlays">{@render exportMenu(a.id, d, undefined, false)}</div>
      {/if}
    </li>
  {:else}
    <li class="none">{t('disks:Disks.none')}</li>
  {/each}
</ol>
{#if machine.attachments.length < MAX_DISKS}
  <button class="add" onclick={() => (adding = true)} data-action="add-disk-open"><Icon name="plus" size={16} />{t('disks:Disks.add')}</button>
{:else}
  <p class="note">{t('disks:Disks.full', { max: MAX_DISKS })}</p>
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
