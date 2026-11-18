// Changes in (docs/frontend.md "Your own disk"): a changes file (Export's "Changes only") goes onto a disk, once the
// disk is checked to be the one it was made over (its hash). A stored machine's disk takes it as a new overlay, which
// it switches to (the one it has is kept); a transient machine's has what it wrote replaced. The machine on the page
// stops while it's loaded, and starts again after.
import { msg, MsgError, t, type Msg } from '../../i18n.ts';
import { overlayBytes } from '../../overlay.ts';
import { changesHeader as readChangesHeader } from '../../qcow2.ts';
import { ask } from '../ask.svelte.ts';
import { loadChangesInto, switchOverlay } from '../disks.ts';
import { runImport } from '../import.ts';
import { isRunning } from '../machines.ts';
import { sizeSeen } from '../disk-size.ts';
import { keepSize, sizeOrphans } from '../resize.ts';
import type { DiskRecord, MachineRecord } from '../shape.ts';
import type { Core } from '../run/core.ts';
import { inUse, progressText } from '../run/messages.ts';
import { baseName, bootAttachment, diskName, overlayName, pageDisk, sourceOf } from '../run/page-disks.ts';
import { isLive, power } from './power.svelte.ts';

export const changesHeader = async (file: File) =>
  readChangesHeader(new Uint8Array(await file.slice(0, 1 << 16).arrayBuffer()));

/** Where a changes file goes: a stored machine's attachment (`here`: the page's machine), or the page's own disk. */
type Into =
  | { m: MachineRecord; attachment: string; disk: DiskRecord; here: boolean; overlay?: undefined }
  | { m?: undefined; overlay: string; here: true };

export class DiskChanges {
  readonly #c: Core;
  constructor(c: Core) {
    this.#c = c;
  }

  /** The stored machine's attachment it goes into (the one named, or the page's boot disk), or the page's own disk. */
  async #into(target?: { machine: MachineRecord; attachment: string }): Promise<Into | undefined> {
    const pm = this.#c.machine;
    const m = target?.machine ?? pm.stored?.record;
    if (!m) {
      const overlay = overlayName(pm);
      return overlay ? { overlay, here: true } : undefined;
    }
    const a = target ? m.attachments.find((x) => x.id === target.attachment) : bootAttachment(pm);
    const here = m.id === pm.stored?.record.id;
    const id = a?.disk ?? '';
    const disk = here ? pm.stored?.disks.get(id) : await pm.store.get('disks', id);
    return a && disk ? { m, attachment: a.id, disk, here } : undefined;
  }

  /**
   * The question: what the file goes into, and what it replaces; and, where its disk is larger than the one the
   * machine sees now (a grown overlay's changes, §4.5), the snapshots that orphans.
   */
  async #question(file: File, into: Into, running: boolean) {
    const pm = this.#c.machine;
    const size = (await changesHeader(file))?.size ?? 0;
    const orphans = into.m ? await sizeOrphans(pm.store, into.m.id, into.attachment, { size }) : [];
    const written = into.m ? 0 : await overlayBytes(into.overlay).catch(() => 0);
    const onto = pm.chosen
      ? msg('disks:disk-actions.theDisk', { name: diskName(pm) })
      : msg('disks:disk-actions.machineDisk', { machine: pm.spec.title });
    const what = into.m
      ? msg('disks:disk-changes.changes.intoOverlay', { disk: into.disk.name })
      : written
        ? msg('disks:disk-changes.changes.replace.size', { disk: onto, size: written })
        : msg('disks:disk-changes.changes.replace', { disk: onto });
    const m = into.m;
    const a = m?.attachments.find((x) => x.id === into.attachment);
    const now = m && a ? sizeSeen(into.disk, a, a.overlay ? await pm.store.get('overlays', a.overlay) : undefined) : 0;
    const list = orphans.map((x) => msg('disks:ResizeDisk.snapshot', { name: x.name, machine: m?.name ?? '' }));
    const lost = orphans.length
      ? msg('disks:disk-changes.changes.orphans', { size, now, count: orphans.length, list })
      : undefined;
    const question = running
      ? msg('disks:disk-changes.changes.confirm.running', { name: file.name, into: what, orphans: lost })
      : msg('disks:disk-changes.changes.confirm', { name: file.name, into: what, orphans: lost });
    return ask.confirm(question, {
      title: t('disks:disk-changes.changes.title'),
      ok: t('disks:disk-changes.changes.ok'),
      danger: running || !into.m,
    });
  }

  /** Whether `file` can go into `into` (a changes file with its disk's hash, the machine not running elsewhere), said if not. */
  async #checked(file: File, into: Into) {
    if (into.m && !into.here && (await isRunning(into.m.id))) {
      this.#c.messages.notify(msg('disks:disk-changes.changes.runsElsewhere', { name: into.m.name }), 'warn');
      return false;
    }
    const info = await changesHeader(file);
    const says = (m: Msg) => this.#c.messages.notify(m, 'warn');
    if (!info) says(msg('disks:disk-changes.changes.notChanges', { name: file.name }));
    else if (!info.hash) says(msg('disks:disk-changes.changes.noHash', { name: file.name, backing: info.backingName }));
    return !!info?.hash;
  }

  /** Loads a changes file: onto the page's disk, or into a new overlay of a stored machine's attachment. */
  async load(file: File, target?: { machine: MachineRecord; attachment: string }) {
    const { power: pw, messages } = this.#c;
    if (pw.busy()) return;
    const into = await this.#into(target);
    if (!into || !(await this.#checked(file, into))) return;
    const running = into.here && isLive(power.state);
    if (!(await this.#question(file, into, running))) return;
    if (into.m && !into.here) {
      // Another machine, off: nothing on this page stops.
      const disk = into.disk.name;
      try {
        await this.#load(file, into);
        messages.notify(msg('disks:disk-changes.changes.loaded', { name: file.name, disk }));
      } catch (e) {
        messages.notify(
          new MsgError('disks:disk-changes.changes.failed', undefined, {
            cause: new MsgError('disks:disk-changes.changes.failed.unchanged', undefined, { cause: e }),
          }),
          'error',
        );
      }
      return;
    }
    await pw.exclusively(() => this.#loadHere(file, into, !target));
  }

  async #load(file: File, into: Into) {
    const pm = this.#c.machine;
    const progress = (phase: string, f: number) => this.#c.messages.stateText(progressText(phase, f));
    if (into.m) {
      const a = into.m.attachments.find((x) => x.id === into.attachment);
      const had = a?.overlay ? await pm.store.get('overlays', a.overlay) : undefined;
      const loaded = await loadChangesInto(pm.store, into.disk, file, progress, (await sourceOf(pm, into.disk)).source);
      // At least the size its guest saw (§4.5): taking changes doesn't shrink the disk, nor orphan its snapshots.
      const o = a ? await keepSize(pm.store, loaded, sizeSeen(into.disk, a, had)) : loaded;
      await switchOverlay(pm.store, into.m, into.attachment, o.id);
      if (into.here) await pm.rereadRecord(into.m.id);
    } else
      await runImport(
        { changes: file, disk: { source: (await pageDisk(pm)).source, overlay: into.overlay }, label: baseName(pm) },
        progress,
      );
  }

  /** The page's machine stops while its disk takes the file, and starts again (`start`: also when it was off). */
  async #loadHere(file: File, into: Into, start: boolean) {
    const { runner, messages } = this.#c;
    const wasOn = isLive(power.state);
    await runner.stop();
    this.#c.terminal.term.reset();
    messages.setState('off');
    messages.stateText(msg('disks:disk-changes.changes.loading'));
    try {
      await this.#load(file, into);
    } catch (e) {
      messages.setState(
        'failed',
        new MsgError('disks:disk-changes.changes.failed', undefined, {
          cause: inUse(e)
            ? new MsgError('disks:disk-actions.inUse', undefined, { cause: e })
            : new MsgError('disks:disk-changes.changes.failed.unchanged', undefined, { cause: e }),
        }),
        [runner.d.later.problems().retry],
      );
      return;
    }
    if (wasOn || start) runner.start();
    else if (into.m)
      messages.notify(msg('disks:disk-changes.changes.loaded', { name: file.name, disk: into.disk.name }));
  }
}
