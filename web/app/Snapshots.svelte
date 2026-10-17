<!--
  A machine's snapshots on the Machines page (docs/plans/machines.md §5): the ones kept in this browser, orphaned ones
  marked with what differs (their shape isn't the machine's now); restore (on this page's machine), rename, download,
  delete, delete all orphaned, make a machine like an orphaned one; a file restored at once or kept; one saved to a
  file. The restore itself is the page's (web/app/main.ts: it confirms the forks). Without `machine`, the page's
  transient machine: files only.
-->
<script lang="ts">
  import Icon from './Icon.svelte';
  import { ask } from './ask.svelte.ts';
  import type { Store, SnapshotRecord } from './store.ts';
  import type { MachineRecord, Shape } from './shape.ts';
  import { shapeDiff } from './shape.ts';
  import { snapshotPath } from './store.ts';
  import { bytesText } from './machines.ts';
  import { importSnapshot, machineLike } from './snapshots.ts';
  import { opfsDir } from '../overlay.ts';
  import { page, ui } from './ui.svelte.ts';

  type Props = {
    store: Store;
    machine?: MachineRecord;
    running?: boolean;
    act(what: string, f: () => Promise<unknown>): Promise<void>;
  };
  let { store, machine, running = false, act }: Props = $props();

  let kept = $state<SnapshotRecord[]>([]);
  let now = $state<{ shape: Shape; hash: string } | undefined>();
  $effect(() => {
    void ui.records;
    const m = machine;
    if (!m) return;
    void (async () => {
      kept = (await store.snapshotsOf(m.id)).sort((a, b) => b.created - a.created);
      now = await page.shapeNow(m).catch(() => undefined);
    })();
  });
  const orphaned = (s: SnapshotRecord) => !!now && s.shapeHash !== now.hash;
  const why = (s: SnapshotRecord) => (now ? shapeDiff(s.shape, now.shape).join('; ') : '');
  const inPlace = $derived(!!machine?.attachments.some((a) => a.inPlace && !a.readOnly));
  /** The machine runs on this page: snapshots restore onto it, and it can save one. */
  const here = $derived(machine ? machine.id === ui.current : true);
  const live = $derived(here && (machine ? running : ui.state === 'running' || ui.state === 'booting'));

  async function download(s: SnapshotRecord) {
    const parts = snapshotPath(s.machine, s.id).split('/');
    const name = parts.pop()!;
    const file = await (await (await opfsDir(parts.join('/'))).getFileHandle(name)).getFile();
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(file), download: `${s.name.replace(/[^\w.-]+/g, '-')}.webpcsnap` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
  }
  async function rename(s: SnapshotRecord) {
    const name = (await ask.prompt('New name:', s.name, { title: `Rename ${s.name}`, ok: 'Rename' }))?.trim();
    if (name && name !== s.name) await act('Renaming', () => store.put('snapshots', { ...$state.snapshot(s) as SnapshotRecord, name }));
  }
  async function remove(s: SnapshotRecord) {
    if (await ask.confirm(`Delete the snapshot ${s.name} (${bytesText(s.bytes)})?`, { ok: 'Delete', danger: true })) await act('Deleting', () => store.deleteSnapshot(s.id));
  }
  async function removeOrphaned() {
    const gone = kept.filter(orphaned);
    if (await ask.confirm(`Delete the ${gone.length} orphaned snapshot${gone.length > 1 ? 's' : ''} (${bytesText(gone.reduce((n, s) => n + s.bytes, 0))})? They were taken of this machine with other settings or disks.`, { ok: 'Delete them', danger: true })) {
      await act('Deleting', async () => { for (const s of gone) await store.deleteSnapshot(s.id); });
    }
  }
  function like(s: SnapshotRecord) {
    void act('Making the machine', async () => { ui.machinesSelected = (await machineLike(store, s)).id; ui.machinesTab = 'settings'; });
  }
  function restore(s: SnapshotRecord) {
    page.closeMachines();
    page.restoreKept(s.id);
  }
  let importInput = $state<HTMLInputElement>();
  const imported = () => { const f = importInput!.files?.[0]; importInput!.value = ''; if (f && machine) void act('Importing', () => importSnapshot(store, machine.id, f)); };
  const restoreFile = () => document.getElementById('load-snapshot-input')!.click();
  async function toFile() {
    const whole = inPlace && (await ask.confirm('A disk of this machine is written in place: put the whole disk in the file? Without it, the file restores only onto that disk as it is now.', { title: 'Save to a file', ok: 'The whole disk', cancel: 'Without it' }));
    page.saveSnapshotFile(whole);
  }
</script>

<div class="snapshots">
  {#if machine}
    {#if !kept.length}<p class="note">None kept in this browser. The toolbar's Snapshot keeps one while the machine runs.</p>{/if}
    <ul>
      {#each kept as s (s.id)}
        <li data-snapshot={s.id} class:orphaned={orphaned(s)}>
          <Icon name="camera" size={18} />
          <div class="what">
            <strong>{s.name}</strong>
            <span class="meta">{new Date(s.created).toLocaleString()} · {bytesText(s.bytes)}</span>
            {#if orphaned(s)}<span class="orphan" title={why(s)}>orphaned: {why(s)}</span>{/if}
          </div>
          {#if orphaned(s)}
            <button onclick={() => like(s)} title="A new machine with the settings and disks the snapshot was taken with">Make a machine like it</button>
          {:else}
            <button onclick={() => restore(s)} disabled={!here} title={here ? 'The machine as it was when the snapshot was taken' : 'Open the machine on this page first'} data-action="restore"><Icon name="history" size={16} />Restore</button>
          {/if}
          <button class="icon" onclick={() => rename(s)} aria-label="Rename" title="Rename"><Icon name="pencil" size={16} /></button>
          <button class="icon" onclick={() => download(s)} aria-label="Download" title="Download it as a file"><Icon name="download" size={16} /></button>
          <button class="icon" onclick={() => remove(s)} aria-label="Delete" title="Delete"><Icon name="trash" size={16} /></button>
        </li>
      {/each}
    </ul>
  {/if}
  <div class="row">
    {#if machine && kept.some(orphaned)}<button onclick={removeOrphaned} data-action="delete-orphaned"><Icon name="trash" size={16} />Delete orphaned snapshots</button>{/if}
    {#if here}<button onclick={restoreFile} title="A snapshot file (.webpcsnap) restored on this machine at once, without keeping it"><Icon name="history" size={16} />Restore from a file…</button>{/if}
    {#if machine}
      <button onclick={() => importInput?.click()} title="A snapshot file (.webpcsnap) kept with this machine, to restore later"><Icon name="file-import" size={16} />Import a file…</button>
      <input type="file" accept=".webpcsnap" hidden bind:this={importInput} onchange={imported} data-field="import-snapshot">
    {/if}
    {#if live}<button onclick={toFile} title="The running machine as it is, to a file (it pauses for a moment, then runs on)"><Icon name="file-export" size={16} />Save a snapshot to a file</button>{/if}
  </div>
</div>

<style>
  .snapshots ul { list-style: none; padding: 0; margin: 0 0 12px; display: flex; flex-direction: column; gap: 6px; }
  .snapshots li { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 8px 12px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); }
  .what { flex: 1; min-width: 200px; display: flex; flex-direction: column; }
  .orphaned strong { text-decoration: line-through; opacity: 0.7; }
  .orphan { color: #ffb36b; font-size: 12px; }
  .meta, .note { color: var(--dim); font-size: 12px; }
  .note { margin: 0 0 8px; }
  .row { display: flex; flex-wrap: wrap; gap: 6px; }
  button { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line); border-radius: 6px; padding: 3px 10px; }
  button.icon { padding: 3px 5px; }
</style>
