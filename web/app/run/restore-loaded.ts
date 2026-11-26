// A run that loaded its snapshot (the worker's `loaded`, posted before its vCPUs run: docs/machines.md §5.2): what its
// restore wrote is the stored machine's from now on.
import { restoreLoaded } from '../snapshot-undo.ts';
import type { PageMachine } from './page-machine.svelte.ts';
import type { Run } from './run.ts';

/**
 * Run `r` of machine `m` loaded its snapshot: a restore's disks are the machine's now, and a template's first start is
 * done (web/app/snapshot-undo.ts `restoreLoaded`); the record read again. Its Retry is no restore's now (`again`).
 */
export async function restoreLoadedOn(m: PageMachine, runner: { again: unknown }, r: Run) {
  runner.again = undefined;
  const s = m.stored;
  if (!s || (!r.plan && !s.record.restoreFirst)) return;
  await restoreLoaded(m.store, s.record.id, r.plan ?? []).catch((e: unknown) =>
    console.warn('waarm64: a restore not marked loaded:', e),
  );
  await m.rereadRecord(s.record.id);
}
