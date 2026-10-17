<!--
  A machine's snapshots in the Machines modal (docs/plans/machines.md §5): the ones kept in this browser, orphaned ones
  marked with what differs (their shape isn't the machine's now), restore (on this page's machine), download, delete,
  delete all orphaned, make a machine like an orphaned one; import a file or apply one at once; save one to a file.
  The restore itself is the page's (web/app/main.ts: it confirms the forks).
-->
<script lang="ts">
  import type { Store, OverlayRecord, SnapshotRecord } from './store.ts';
  import type { DiskRecord, MachineRecord, Shape } from './shape.ts';
  import { shapeDiff } from './shape.ts';
  import { snapshotPath } from './store.ts';
  import { bytesText } from './machines.ts';
  import { importSnapshot, machineLike } from './snapshots.ts';
  import { opfsDir } from '../overlay.ts';

  type Props = {
    store: Store;
    machine: MachineRecord;
    disks: Map<string, DiskRecord>;
    overlays: OverlayRecord[];
    current?: string;
    running: boolean;
    act(what: string, f: () => Promise<unknown>): Promise<void>;
    /** The machine's shape as it would run now, and its hash. */
    shapeNow(m: MachineRecord): Promise<{ shape: Shape; hash: string }>;
    /** The page restores kept snapshot `id` onto its machine. */
    restore(id: string): void;
    /** The page restores a snapshot file onto its machine at once (not kept). */
    apply(file: File): void;
    /** The page saves a snapshot of its running machine to a file (`whole`: disks written in place go in whole). */
    saveToFile(whole: boolean): void;
    choose(id: string): void;
  };
  let { store, machine, disks, current, running, act, shapeNow, restore, apply, saveToFile, choose }: Props = $props();

  let kept = $state<SnapshotRecord[]>([]);
  let now = $state<{ shape: Shape; hash: string } | undefined>();
  $effect(() => {
    const id = machine.id;
    void (async () => {
      kept = (await store.snapshotsOf(id)).sort((a, b) => b.created - a.created);
      now = await shapeNow(machine).catch(() => undefined);
    })();
  });
  const orphaned = (s: SnapshotRecord) => !!now && s.shapeHash !== now.hash;
  const why = (s: SnapshotRecord) => (now ? shapeDiff(s.shape, now.shape).join('; ') : '');
  const inPlace = $derived(machine.attachments.some((a) => a.inPlace && !a.readOnly));
  const here = $derived(machine.id === current);

  async function download(s: SnapshotRecord) {
    const parts = snapshotPath(s.machine, s.id).split('/');
    const name = parts.pop()!;
    const file = await (await (await opfsDir(parts.join('/'))).getFileHandle(name)).getFile();
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(file), download: `${s.name.replace(/[^\w.-]+/g, '-')}.webpcsnap` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
  }
  function remove(s: SnapshotRecord) {
    if (confirm(`Delete the snapshot ${s.name} (${bytesText(s.bytes)})?`)) void act('Deleting', () => store.deleteSnapshot(s.id));
  }
  function removeOrphaned() {
    const gone = kept.filter(orphaned);
    if (confirm(`Delete the ${gone.length} orphaned snapshot${gone.length > 1 ? 's' : ''} (${bytesText(gone.reduce((n, s) => n + s.bytes, 0))})? They were taken of this machine with other settings or disks.`)) {
      void act('Deleting', async () => { for (const s of gone) await store.deleteSnapshot(s.id); });
    }
  }
  function like(s: SnapshotRecord) {
    void act('Making the machine', async () => { choose((await machineLike(store, s)).id); });
  }
  let importInput: HTMLInputElement;
  let applyInput: HTMLInputElement;
  const imported = () => { const f = importInput.files?.[0]; importInput.value = ''; if (f) void act('Importing', () => importSnapshot(store, machine.id, f)); };
  const applied = () => { const f = applyInput.files?.[0]; applyInput.value = ''; if (f) apply(f); };
  function toFile() {
    const whole = inPlace && confirm('A disk of this machine is written in place: put the whole disk in the file (OK)? Without it (Cancel), the file restores only onto that disk as it is now.');
    saveToFile(whole);
  }
</script>

<fieldset class="snapshots">
  <legend>Snapshots</legend>
  {#if !kept.length}<p class="note">None kept in this browser. Save snapshot › Keep in this browser (in the header, while the machine runs) keeps one.</p>{/if}
  <ul>
    {#each kept as s (s.id)}
      <li data-snapshot={s.id} class:orphaned={orphaned(s)}>
        <strong>{s.name}</strong>
        <span class="meta">{new Date(s.created).toLocaleString()} · {bytesText(s.bytes)}</span>
        {#if orphaned(s)}
          <span class="orphan" title={why(s)}>orphaned: {why(s)}</span>
          <button onclick={() => like(s)}>Make a machine like it</button>
        {:else}
          <button onclick={() => restore(s.id)} disabled={!here} title={here ? '' : 'Open the machine on this page first'} data-action="restore">Restore</button>
        {/if}
        <button onclick={() => download(s)}>Download</button>
        <button onclick={() => remove(s)}>Delete</button>
      </li>
    {/each}
  </ul>
  <div class="row">
    {#if kept.some(orphaned)}<button onclick={removeOrphaned} data-action="delete-orphaned">Delete orphaned snapshots</button>{/if}
    <button onclick={() => importInput.click()}>Import a file…</button>
    <input type="file" accept=".webpcsnap" hidden bind:this={importInput} onchange={imported} data-field="import-snapshot">
    {#if here}
      <button onclick={() => applyInput.click()}>Apply a file…</button>
      <input type="file" accept=".webpcsnap" hidden bind:this={applyInput} onchange={applied} data-field="apply-snapshot">
      {#if running}<button onclick={toFile}>Save a snapshot to a file</button>{/if}
    {/if}
  </div>
</fieldset>

<style>
  .snapshots ul { list-style: none; padding: 0; margin: 0 0 6px; }
  .snapshots li { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-bottom: 4px; }
  .orphaned strong { text-decoration: line-through; opacity: 0.7; }
  .orphan { color: #ffb36b; font-size: 12px; }
  .meta, .note { color: #9aa4ae; font-size: 12px; }
  .row { display: flex; flex-wrap: wrap; gap: 6px; }
</style>
