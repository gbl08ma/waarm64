// A snapshot back (docs/frontend.md "Snapshots", docs/machines.md §5.2): a kept one restored onto the stored machine,
// or a file loaded (a stored machine's restore, or a transient machine replaced by the one the file holds).
import { msg, MsgError, t, text } from '../../i18n.ts';
import { msgOf } from '../../msg.ts';
import { opfsFile, overlayBytes } from '../../overlay.ts';
import { readHeader, SnapshotError, type SnapshotHeader } from '../../snapshot-file.ts';
export { isSnapshot } from '../../snapshot-file.ts'; // what main.ts tells a dropped file by
import type { DiskPlan, SnapshotDisk } from '../../snapshot.ts';
import { ask } from '../ask.svelte.ts';
import { shapeDiff } from '../shape-diff.ts';
import type { MachineRecord, Shape } from '../shape.ts';
import { planRestore } from '../snapshots.ts';
import { basesIn } from '../snapshot-lost.ts';
import { snapshotPath } from '../store.ts';
import type { Core } from '../run/core.ts';
import { restoreLoadedOn } from '../run/restore-loaded.ts';
import { diskName, overlayName } from '../run/page-disks.ts';
import type { Stored } from '../run/page-machine.svelte.ts';
import { isLive, power } from './power.svelte.ts';

type Plan = Awaited<ReturnType<typeof planRestore>>;

/** The restore's question: then a line on the disks the snapshot left as they are, and one per disk that forks. */
function restoreQuestion(name: string, header: SnapshotHeader, plan: Plan, running: boolean) {
  const when = new Date(header.created);
  const taken = !Number.isNaN(when.getTime());
  const asked = running
    ? taken
      ? msg('snapshots:snapshot-restore.restore.confirm.takenRunning', { name, when })
      : msg('snapshots:snapshot-restore.restore.confirm.running', { name })
    : taken
      ? msg('snapshots:snapshot-restore.restore.confirm.taken', { name, when })
      : msg('snapshots:snapshot-restore.restore.confirm', { name });
  const lines = [
    asked,
    ...(plan.kept.length ? [msg('snapshots:snapshot-restore.restore.kept', { disks: plan.kept })] : []),
    ...plan.forks.map((f) =>
      f.reused
        ? msg('snapshots:snapshot-restore.restore.fork.reused', { disk: f.disk })
        : msg('snapshots:snapshot-restore.restore.fork.new', { disk: f.disk }),
    ),
  ];
  return msg('snapshots:snapshot-restore.restore.question', { lines });
}

/**
 * Whether the disks the restore forks replace their overlays (the user says no to keeping them). Without room for the
 * snapshot's blocks beside them (`replaceKeeps`), the question says that a replace cut off part way leaves the disks on
 * their images.
 */
async function replaceForks(plan: Plan) {
  const replaceable = plan.forks.flatMap((f) => (!f.reused && f.replaceable ? [f.replaceable] : []));
  const count = replaceable.length;
  const list = replaceable.map((r) =>
    msg('snapshots:snapshot-restore.restore.keep.item', { name: r.name, size: r.bytes }),
  );
  const key = plan.replaceKeeps
    ? 'snapshots:snapshot-restore.restore.keep'
    : 'snapshots:snapshot-restore.restore.keep.tight';
  return (
    count > 0 &&
    !(await ask.confirm(msg(key, { count, list }), {
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
    c.power.restoreFirst = (id) => this.first(id); // a machine from a template's first start
    c.runner.firstFailed = (restart) => this.#bootInstead(restart);
    c.runner.loaded = (r) => restoreLoadedOn(c, r);
  }

  /** What a snapshot's disk is called, for messages. */
  #disk(name: string | null | undefined) {
    return name
      ? msg('disks:disk-actions.theDisk', { name })
      : msg('snapshots:snapshot-restore.ownDisk', { machine: this.#c.machine.spec.title });
  }

  /** Why snapshot `name` (its `header`) can't be restored onto the stored machine as the page has it now: another shape (what differs). */
  async #otherShape(s: Stored, header: SnapshotHeader, name: string) {
    const now = await this.#c.machine.about();
    if (!now) return msg('snapshots:snapshot-restore.restore.otherVersion');
    if (header.shapeHash === now.shapeHash) return undefined;
    const why = header.shape
      ? shapeDiff(header.shape as Shape, now.shape)
          .map((m) => text(m))
          .join('; ')
      : msg('snapshots:snapshot-restore.restore.otherVersion');
    return msg('snapshots:snapshot-restore.restore.otherShape', { name, machine: s.record.name, why });
  }

  /**
   * The restore's plan for the stored machine, or none (said why: another shape, or it can't be planned); `fresh`: its
   * first restore (`first`), whose never-written overlays take the forks' blocks.
   */
  async #plan(s: Stored, header: SnapshotHeader, key: string, name: string, fresh = false) {
    const now = await this.#c.machine.about();
    if (!now) return undefined;
    const other = await this.#otherShape(s, header, name);
    if (other) {
      this.#c.messages.notify(
        new MsgError('snapshots:snapshot-restore.restore.cant', undefined, {
          cause: new MsgError(other.key, other.params),
        }),
      );
      return undefined;
    }
    try {
      const pins = (header.disks ?? []) as SnapshotDisk[];
      const plan = await planRestore(
        this.#c.machine.store,
        s.record,
        s.disks,
        {
          name: name.replace(/\.waarm64snap$/, ''),
          key,
          pins,
          bases: basesIn(header),
          coreVersion: header.coreVersion,
        },
        now.shape,
        { fresh },
      );
      if (!plan.refused) return plan;
      this.#c.messages.notify(
        new MsgError('snapshots:snapshot-restore.restore.refused', { name }, { cause: plan.refused }),
      );
    } catch (e) {
      this.#c.messages.notify(
        new MsgError('snapshots:snapshot-restore.restore.failed', { name }, { cause: e }),
        'error',
      );
    }
    return undefined;
  }

  /**
   * Restores a snapshot onto the stored machine (docs/machines.md §5.2): refused when its shape isn't the machine's
   * (it says what differs); else each writable disk keeps its overlay where it is as the snapshot pinned it, and forks
   * (or, if the user says, is replaced) where it moved on. `key` identifies the snapshot for reusing an earlier fork.
   * The machine's records are read again first while it's off (the Home page, or another tab, may have changed
   * them since the page read them) and once it has stopped: the shape is checked and the plan made again on those, and
   * the start runs on the record the restore wrote.
   */
  async #restore(file: File, header: SnapshotHeader, key: string, name: string) {
    const { power: pw } = this.#c;
    if (!isLive(power.state) && !(await pw.reloadStored())) return;
    const s = this.#c.machine.stored;
    if (!s) return;
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
    if (pw.busy()) return; // a save began while the questions were open: said, nothing restored
    await this.#restoreNow(file, header, name, plan, replace);
  }

  /**
   * The restore as the user answered it (`replace`), carried out: the machine stopped, the records read again and the
   * shape checked on them, the plan committed under the machine's lock, the start on the record it wrote. Retry after
   * its failure (its own, or its start's) runs this again, not a boot: a restore that never loaded is undone at the
   * records' reading (web/app/snapshot-undo.ts), and planned again on them.
   */
  async #restoreNow(file: File, header: SnapshotHeader, name: string, plan: Plan, replace: boolean) {
    const { power: pw, runner, messages, terminal } = this.#c;
    const again = () => this.#restoreNow(file, header, name, plan, replace);
    await pw.exclusively(async () => {
      await runner.stop();
      runner.again = again; // Retry after a failure from here to the snapshot's load (`Runner.loaded` clears it)
      const failed = (cause: unknown) =>
        messages.setState('failed', new MsgError('snapshots:snapshot-restore.restore.failed', { name }, { cause }), [
          { label: t('machine:problems.retry'), run: () => void again() },
        ]);
      // The records as they are now (what changed while the questions were open), the shape checked on them.
      if (!(await pw.reloadStored())) return;
      const now = this.#c.machine.stored;
      const other = now ? await this.#otherShape(now, header, name) : undefined;
      if (!now || other) return failed(other && new MsgError(other.key, other.params));
      // The machine's lock from before the commit to the run's end: its forks are this start's (none is undone as cut
      // off meanwhile, here or in another tab: web/app/snapshot-undo.ts). Held elsewhere (it runs there): said.
      if (!(await runner.own())) return;
      let disks: DiskPlan[];
      try {
        disks = await plan.commit(replace);
      } catch (e) {
        runner.lock.drop();
        return failed(e);
      }
      // The record the commit wrote (its forks attached) is the one the start opens.
      if (!(await pw.reloadStored())) return runner.lock.drop();
      terminal.term.reset();
      runner.start(file, true, disks);
      runner.again = again;
    });
  }

  /** Restores the kept snapshot `id` of the stored machine. */
  async restoreKept(id: string) {
    if (this.#c.power.busy()) return; // a save or a switch runs: said (as a load is)
    const s = this.#c.machine.stored;
    const rec = await this.#c.machine.store.get('snapshots', id);
    if (!s || rec?.machine !== s.record.id) return;
    const file = await (await opfsFile(snapshotPath(rec.machine, id))).getFile();
    const header = await readHeader(file);
    await this.#restore(new File([file], `${rec.name}.waarm64snap`), header, id, rec.name);
  }

  /**
   * A stored machine's first start that restores kept snapshot `id` (its record's `restoreFirst`: a machine from a
   * template, web/app/template.ts) with no question: the fresh overlays take its blocks (a fork). The mark stays until
   * the snapshot loaded (web/app/snapshot-undo.ts `restoreLoaded`, at the worker's `loaded`): a first start cut off or
   * refused before that (the tab closed, a disk that didn't open) restores it again at the next start. Called from a
   * start, within its `exclusively`. One that can't be restored (another shape, refused: said) boots the machine
   * instead, the mark cleared.
   */
  async first(id: string) {
    const { machine: m, runner, terminal } = this.#c;
    const s = m.stored;
    const rec = await m.store.get('snapshots', id);
    if (!s || rec?.machine !== s.record.id) {
      if ((await this.#clearFirst()) && (await this.#c.power.reloadStored())) runner.start();
      return;
    }
    const file = new File([await (await opfsFile(snapshotPath(rec.machine, id))).getFile()], `${rec.name}.waarm64snap`);
    const header = await readHeader(file);
    const plan = await this.#plan(s, header, id, rec.name, true);
    // The machine's lock from before the commit, as a user's restore takes it (`#restore`); held elsewhere: said.
    if (plan && !(await runner.own())) return;
    let disks: DiskPlan[] | undefined;
    try {
      disks = plan && (await plan.commit(false));
    } catch (e) {
      // Not a boot: the mark stays, and Retry restores it again (what the commit wrote is undone at that reading).
      runner.lock.drop();
      runner.again = () => this.#c.power.exclusively(() => this.first(id)).then(() => undefined);
      const error = new MsgError('snapshots:snapshot-restore.restore.failed', { name: rec.name }, { cause: e });
      return this.#c.messages.setState('failed', error, [runner.d.later.problems().retry]);
    }
    // A boot instead (another shape, refused: said by `#plan`).
    if (!disks) await this.#clearFirst();
    if (!(await this.#c.power.reloadStored())) return runner.lock.drop();
    terminal.term.reset();
    if (disks) runner.start(file, true, disks, true);
    else runner.start();
  }

  /** The stored machine's `restoreFirst` cleared in its record (it boots instead); true (a failure is said in the console). */
  async #clearFirst() {
    const { machine: m } = this.#c;
    const clear = (r?: MachineRecord) => (r?.restoreFirst ? { ...r, restoreFirst: undefined } : undefined);
    if (m.stored) await m.store.update('machines', m.stored.record.id, clear).catch((e: unknown) => console.warn(e));
    return true;
  }

  /**
   * A first start whose snapshot can't load once under way (3D failed in this browser: another shape; or the worker
   * refused it): a boot instead, said once it runs, the mark cleared. What its restore wrote is no fork of the snapshot:
   * undone at the boot's start, as a restore that never loaded (web/app/snapshot-undo.ts). `restart`: the run has
   * ended (the worker's refusal); else its workers are gone (3D's failure).
   */
  async #bootInstead(restart: boolean) {
    const { machine: m, runner, messages } = this.#c;
    await this.#clearFirst();
    await m.rereadRecord();
    const name = m.stored?.record.name ?? m.spec.title;
    messages.notifyLater(msg('snapshots:snapshot-restore.firstBooted', { machine: name }));
    if (restart) await this.#c.power.restart();
    else runner.start();
  }

  /** Whether a transient machine can load `header`'s snapshot: its machine, and its disk by name (said if not). */
  #fits(file: File, header: SnapshotHeader, label: string) {
    const m = this.#c.machine;
    if (header.machine !== m.name) {
      const other = { other: label, otherId: String(header.machine), machine: m.spec.title, id: m.name };
      this.#c.messages.notify(
        msg('snapshots:snapshot-restore.load.otherMachine', { name: file.name, ...other }),
        'warn',
      );
      return false;
    }
    const taken = typeof header.disk === 'string' ? header.disk : null;
    const open = m.chosen ? (diskName(m) ?? null) : null;
    if (taken === open) return true;
    const words = { name: file.name, taken: this.#disk(taken), open: this.#disk(open) };
    this.#c.messages.notify(
      taken
        ? msg('snapshots:snapshot-restore.load.otherDisk', words)
        : msg('snapshots:snapshot-restore.load.otherDisk.reload', words),
      'warn',
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
      header = await readHeader(file);
    } catch (e) {
      if (!(e instanceof SnapshotError)) throw e;
      this.#c.messages.notify(
        new MsgError('snapshots:snapshot-restore.notSnapshot.title', undefined, {
          cause: new MsgError('snapshots:snapshot-restore.notSnapshot', { name: file.name, why: msgOf(e) }),
        }),
      );
      return;
    }
    if (m.stored) return this.#restore(file, header, `file:${header.created}`, file.name);
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
      !(await ask.confirm(msg('snapshots:snapshot-restore.load.confirm', { name: file.name, holds, replaces, lost }), {
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
