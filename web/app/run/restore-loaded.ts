// A run that loaded its snapshot (the worker's `loaded`, posted before its vCPUs run, which wait for the page's answer:
// docs/machines.md §5.2): what its restore wrote is the stored machine's from now on.
import { MsgError } from '../../msg.ts';
import { restoreLoaded } from '../snapshot-undo.ts';
import type { Core } from './core.ts';
import type { Run } from './run.ts';

/**
 * Run `r` loaded its snapshot: a restore's disks are the machine's now, and a template's first start is done
 * (web/app/snapshot-undo.ts `restoreLoaded`); the record read again, and its Retry is no restore's now (`again`). Where
 * that write is refused (the storage full) the run stops and says so, before its vCPUs ran (the page answers `loaded`
 * only once this settles: web/app/run/worker-messages.ts): the restore is still one that never loaded, undone whole at
 * the machine's next load, and its Retry restores the snapshot again.
 */
export async function restoreLoadedOn(c: Pick<Core, 'machine' | 'runner' | 'messages'>, r: Run) {
  const { machine: m, runner } = c;
  const s = m.stored;
  if (!s || (!r.plan && !s.record.restoreFirst)) {
    runner.again = undefined;
    return;
  }
  try {
    await restoreLoaded(m.store, s.record.id);
  } catch (e) {
    if (m.run && m.run !== r) return; // another start since: its own
    const again = runner.again; // a stop clears it
    await runner.stop();
    runner.again = again;
    const cause = new MsgError('snapshots:restore-loaded.notRecorded.cause', undefined, { cause: e });
    c.messages.setState('failed', new MsgError('snapshots:restore-loaded.notRecorded', undefined, { cause }), [
      runner.d.later.problems().retry,
    ]);
    return;
  }
  runner.again = undefined;
  await m.rereadRecord(s.record.id);
}
