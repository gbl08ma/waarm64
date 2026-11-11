// A snapshot back (docs/frontend.md "Snapshots", docs/machines.md §5.2): a kept one restored onto the stored machine,
// or a file loaded (a stored machine's restore, or a transient machine replaced by the one the file holds).
import { errorText, msg, MsgError, t, text } from '../../i18n.ts';
import { msgOf } from '../../msg.ts';
import { opfsDir, overlayBytes } from '../../overlay.ts';
import { openSnapshot, SnapshotError, type SnapshotHeader } from '../../snapshot-file.ts';
import type { DiskPlan, SnapshotDisk } from '../../snapshot.ts';
import { ask } from '../ask.svelte.ts';
import { shapeDiff, type Shape } from '../shape.ts';
import { planRestore } from '../snapshots.ts';
import { snapshotPath } from '../store.ts';
import type { Core } from '../run/core.ts';
import { diskName, overlayName } from '../run/page-disks.ts';
import type { Stored } from '../run/page-machine.svelte.ts';
import { isLive, power } from './power.svelte.ts';

type Plan = Awaited<ReturnType<typeof planRestore>>;

/** Whether `file` starts with the snapshot signature (`WEBPCSNP`): how a chosen or dropped file is told from a disk image. */
export const isSnapshot = async (file: File) =>
  new TextDecoder().decode(await file.slice(0, 8).arrayBuffer()) === 'WEBPCSNP';

/** The OPFS file at `path`. */
async function opfsFile(path: string) {
  const parts = path.split('/');
  const name = parts.pop() ?? '';
  return (await opfsDir(parts.join('/'))).getFileHandle(name);
}

/** The restore's question: then a line on the disks the snapshot left as they are, and one per disk that forks. */
function restoreQuestion(name: string, header: SnapshotHeader, plan: Plan, running: boolean) {
  const when = new Date(header.created);
  const taken = !Number.isNaN(when.getTime());
  const asked = running
    ? taken
      ? t('snapshots:snapshot-restore.restore.confirm.takenRunning', { name, when })
      : t('snapshots:snapshot-restore.restore.confirm.running', { name })
    : taken
      ? t('snapshots:snapshot-restore.restore.confirm.taken', { name, when })
      : t('snapshots:snapshot-restore.restore.confirm', { name });
  return [
    asked,
    ...(plan.kept.length ? [t('snapshots:snapshot-restore.restore.kept', { disks: plan.kept })] : []),
    ...plan.forks.map((f) =>
      f.reused
        ? t('snapshots:snapshot-restore.restore.fork.reused', { disk: f.disk })
        : t('snapshots:snapshot-restore.restore.fork.new', { disk: f.disk }),
    ),
  ].join('\n');
}

/** Whether the disks the restore forks replace their overlays (the user says no to keeping them). */
async function replaceForks(plan: Plan) {
  const replaceable = plan.forks.flatMap((f) => (!f.reused && f.replaceable ? [f.replaceable] : []));
  const count = replaceable.length;
  const list = replaceable.map((r) =>
    t('snapshots:snapshot-restore.restore.keep.item', { name: r.name, size: r.bytes }),
  );
  return (
    count > 0 &&
    !(await ask.confirm(t('snapshots:snapshot-restore.restore.keep', { count, list }), {
      title: t('snapshots:snapshot-restore.restore.keep.title'),
      ok: t('snapshots:snapshot-restore.restore.keep.ok'),
      cancel: t('snapshots:snapshot-restore.restore.replace', { count }),
    }))
  );
}

/** What a snapshot file holds, in the load's question. */
function holdsWords(file: File, header: SnapshotHeader, label: string) {
  const when = new Date(header.created);
  const dated = !Number.isNaN(when.getTime());
  const count = typeof header.ncpus === 'number' ? header.ncpus : undefined;
  const size = file.size;
  if (count === undefined)
    return dated
      ? msg('snapshots:snapshot-restore.load.holds.when', { label, when, size })
      : msg('snapshots:snapshot-restore.load.holds', { label, size });
  return dated
    ? msg('snapshots:snapshot-restore.load.holds.when.cpus', { label, when, size, count })
    : msg('snapshots:snapshot-restore.load.holds.cpus', { label, size, count });
}

export class SnapshotRestore {
  readonly #c: Core;
  constructor(c: Core) {
    this.#c = c;
  }

  /** What a snapshot's disk is called, for messages. */
  #disk(name: string | null | undefined) {
    return name
      ? msg('disks:disk-actions.theDisk', { name })
      : msg('snapshots:snapshot-restore.ownDisk', { machine: this.#c.machine.spec.title });
  }

  /** The restore's plan for the stored machine, or none (said why: another shape, or it can't be planned). */
  async #plan(s: Stored, header: SnapshotHeader, key: string, name: string) {
    const now = await this.#c.machine.about();
    if (!now) return undefined;
    if (header.shapeHash !== now.shapeHash) {
      const why = header.shape
        ? shapeDiff(header.shape as Shape, now.shape)
            .map((m) => text(m))
            .join('; ')
        : msg('snapshots:snapshot-restore.restore.otherVersion');
      void ask.alert(t('snapshots:snapshot-restore.restore.otherShape', { name, machine: s.record.name, why }), {
        title: t('snapshots:snapshot-restore.restore.cant'),
      });
      return undefined;
    }
    try {
      const pins = (header.disks ?? []) as SnapshotDisk[];
      const plan = await planRestore(
        this.#c.machine.store,
        s.record,
        s.disks,
        { name: name.replace(/\.webpcsnap$/, ''), key, pins },
        now.shape,
      );
      if (!plan.refused) return plan;
      void ask.alert(
        errorText(new MsgError('snapshots:snapshot-restore.restore.refused', { name }, { cause: plan.refused })),
      );
    } catch (e) {
      void ask.alert(errorText(new MsgError('snapshots:snapshot-restore.restore.failed', { name }, { cause: e })));
    }
    return undefined;
  }

  /**
   * Restores a snapshot onto the stored machine (docs/machines.md §5.2): refused when its shape isn't the machine's
   * (it says what differs); else each writable disk keeps its overlay where it is as the snapshot pinned it, and forks
   * (or, if the user says, is replaced) where it moved on. `key` identifies the snapshot for reusing an earlier fork.
   */
  async #restore(s: Stored, file: File, header: SnapshotHeader, key: string, name: string) {
    const plan = await this.#plan(s, header, key, name);
    if (!plan) return;
    const running = isLive(power.state);
    if (
      !(await ask.confirm(restoreQuestion(name, header, plan, running), {
        title: t('snapshots:snapshot-restore.restore.title'),
        ok: t('snapshots:snapshot-restore.restore.ok'),
        danger: running,
      }))
    )
      return;
    const replace = await replaceForks(plan);
    const { power: pw, runner, messages, terminal } = this.#c;
    await pw.exclusively(async () => {
      await runner.stop();
      let disks: DiskPlan[];
      try {
        disks = await plan.commit(replace);
      } catch (e) {
        messages.setState('failed', new MsgError('snapshots:snapshot-restore.restore.failed', { name }, { cause: e }), [
          runner.d.later.problems().retry,
        ]);
        return;
      }
      terminal.term.reset();
      runner.start(file, true, disks);
    });
  }

  /** Restores the kept snapshot `id` of the stored machine. */
  async restoreKept(id: string) {
    const s = this.#c.machine.stored;
    const rec = await this.#c.machine.store.get('snapshots', id);
    if (!s || rec?.machine !== s.record.id) return;
    const file = await (await opfsFile(snapshotPath(rec.machine, id))).getFile();
    const { header } = await openSnapshot(file);
    await this.#restore(s, new File([file], `${rec.name}.webpcsnap`), header, id, rec.name);
  }

  /** Whether a transient machine can load `header`'s snapshot: its machine, and its disk by name (said if not). */
  #fits(file: File, header: SnapshotHeader, label: string) {
    const m = this.#c.machine;
    if (header.machine !== m.name) {
      const other = { other: label, otherId: String(header.machine), machine: m.spec.title, id: m.name };
      void ask.alert(t('snapshots:snapshot-restore.load.otherMachine', { name: file.name, ...other }));
      return false;
    }
    const taken = typeof header.disk === 'string' ? header.disk : null;
    const open = m.chosen ? (diskName(m) ?? null) : null;
    if (taken === open) return true;
    const words = { name: file.name, taken: this.#disk(taken), open: this.#disk(open) };
    void ask.alert(
      taken
        ? t('snapshots:snapshot-restore.load.otherDisk', words)
        : t('snapshots:snapshot-restore.load.otherDisk.reload', words),
    );
    return false;
  }

  /**
   * Loads a snapshot: the header is read here (no codec needed) to say what the file is and to refuse
   * at once what can't work (not a snapshot, another machine, another disk by name); then, after the
   * user confirms, the machine stops and a new one starts from the file. The worker checks the rest
   * before it touches anything (web/snapshot.ts `readSnapshot`).
   */
  async load(file: File) {
    const { machine: m, power: pw } = this.#c;
    if (pw.busy()) return;
    let header: SnapshotHeader;
    try {
      header = (await openSnapshot(file)).header;
    } catch (e) {
      if (!(e instanceof SnapshotError)) throw e;
      return void ask.alert(t('snapshots:snapshot-restore.notSnapshot', { name: file.name, why: msgOf(e) }), {
        title: t('snapshots:snapshot-restore.notSnapshot.title'),
      });
    }
    if (m.stored) return this.#restore(m.stored, file, header, `file:${header.created}`, file.name);
    const label = typeof header.label === 'string' ? header.label : String(header.machine);
    if (!this.#fits(file, header, label)) return;
    const overlay = overlayName(m);
    const written = overlay ? await overlayBytes(overlay).catch(() => 0) : 0;
    const replaces = isLive(power.state)
      ? msg('snapshots:snapshot-restore.load.replaces.running')
      : msg('snapshots:snapshot-restore.load.replaces');
    const disk = m.chosen
      ? msg('disks:disk-actions.theDisk', { name: diskName(m) })
      : msg('disks:disk-actions.machineDisk', { machine: m.spec.title });
    const lost = written
      ? msg('snapshots:snapshot-restore.load.written.size', { disk, size: written })
      : msg('snapshots:snapshot-restore.load.written', { disk });
    const holds = holdsWords(file, header, label);
    if (
      !(await ask.confirm(t('snapshots:snapshot-restore.load.confirm', { name: file.name, holds, replaces, lost }), {
        title: t('snapshots:snapshot-restore.load.title'),
        ok: t('snapshots:snapshot-restore.load.ok'),
        danger: true,
      }))
    )
      return;
    await pw.exclusively(async () => {
      await this.#c.runner.stop();
      this.#c.terminal.term.reset();
      this.#c.runner.start(file);
    });
  }
}
