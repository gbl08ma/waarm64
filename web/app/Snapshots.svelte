<!--
  A machine's snapshots in the Machines modal (docs/plans/machines.md §5): kept ones, orphaned ones marked (their
  shape isn't the machine's now), restore, download, delete, delete the orphaned, import a file. Filled in by L4.
-->
<script lang="ts">
  import type { Store, OverlayRecord } from './store.ts';
  import type { DiskRecord, MachineRecord } from './shape.ts';

  type Props = { store: Store; machine: MachineRecord; disks: Map<string, DiskRecord>; overlays: OverlayRecord[]; current?: string; running: boolean; act(what: string, f: () => Promise<unknown>): Promise<void> };
  let { store, machine }: Props = $props();
  let kept = $state<{ id: string; name: string }[]>([]);
  $effect(() => { void store.snapshotsOf(machine.id).then((s) => { kept = s; }); });
</script>

<fieldset>
  <legend>Snapshots</legend>
  {#if !kept.length}<p class="note">None kept.</p>{/if}
  <ul>{#each kept as s (s.id)}<li>{s.name}</li>{/each}</ul>
</fieldset>
