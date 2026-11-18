// The disk out (docs/frontend.md "Your own disk"): the changes over the image (a qcow2 that names it as its backing
// file), or the whole disk. The machine stops while it's written (the overlay's files are the writer's); the file goes
// to where the user picks, or is downloaded. A running guest whose agent can trims its filesystems first (web/app/areas/
// trim-actions.ts `beforeExport`): what it freed isn't written to the file.
import { msg, MsgError, t } from '../../i18n.ts';
import { ask } from '../ask.svelte.ts';
import { runExport, type ExportMode } from '../export.ts';
import { isRunning } from '../machines.ts';
import type { DiskRecord } from '../shape.ts';
import { overlayDir } from '../store.ts';
import type { Core } from '../run/core.ts';
import { inUse, progressText } from '../run/messages.ts';
import { baseName, NO_OVERLAY_YET, overlayName, pageDisk, sourceOf } from '../run/page-disks.ts';
import { isLive, power } from './power.svelte.ts';

const SAVES: Record<ExportMode, { suffix: string; description: string; type: string }> = {
  changes: {
    suffix: '-changes.qcow2',
    description: t('disks:disk-export.save.type.changes'),
    type: 'application/x-qcow2',
  },
  qcow2: { suffix: '.qcow2', description: t('disks:disk-export.save.type.qcow2'), type: 'application/x-qcow2' },
  raw: { suffix: '.img', description: t('disks:disk-export.save.type.raw'), type: 'application/octet-stream' },
};

/** A stored disk with one of its overlays (none: the stored disk itself). */
type Target = { disk: DiskRecord; overlay?: string };

/** How long a download's address is kept after its click (a staged snapshot's file behind it is kept longer: web/snapshot-stage.ts `keepForDownload`). */
export const DOWNLOAD_KEPT_MS = 60_000;

/** Downloads `blob` as `name`. */
export function download(blob: Blob, name: string) {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), DOWNLOAD_KEPT_MS);
}

/** The save picker's file (it needs the click's user activation); none: a download; undefined `false`: cancelled. */
export async function savePicker(suggestedName: string, type: FilePickerAcceptType) {
  if (!window.showSaveFilePicker) return undefined;
  try {
    return await window.showSaveFilePicker({ suggestedName, types: [type] });
  } catch (e) {
    if ((e as DOMException).name === 'AbortError') return false; // cancelled
    return undefined; // the download
  }
}

/**
 * The file's suggested name: the disk's with the save's suffix, never the disk's own name (a save dialog empties the
 * file it's given at once: Chromium creates or truncates it before the page writes a byte, and accepting the
 * suggestion beside the disk would destroy it).
 */
function suggested(fileName: string, suffix: string) {
  const stem = fileName.replace(/\.(qcow2|img|raw|iso)$/i, '');
  const named = `${stem}${suffix}`;
  return named.toLowerCase() === fileName.toLowerCase() ? `${stem}-saved${suffix}` : named;
}

/** Whether `file` still reads: a save dialog given a disk's own file empties it at once (its File no longer reads). */
const stillReads = (file: File) =>
  file
    .slice(0, 1)
    .arrayBuffer()
    .then(
      () => true,
      () => false,
    );

export class DiskExport {
  readonly #c: Core;
  /** The running guest's trim, before the machine stops. */
  readonly #trim: () => Promise<void>;
  constructor(c: Core, trim: () => Promise<void>) {
    this.#c = c;
    this.#trim = trim;
  }

  /** Whether the page's machine uses it (then it stops): its boot disk's overlay, or any attachment of the stored machine. */
  #uses(target?: Target) {
    const s = this.#c.machine.stored;
    if (!target) return true;
    return !!s?.record.attachments.some(
      (a) => a.disk === target.disk.id && (target.overlay ? a.overlay === target.overlay : a.inPlace),
    );
  }
  /** Another machine using it that runs in another tab (said): nothing is written. */
  async #runsElsewhere(target: Target) {
    const store = this.#c.machine.store;
    const others = (await store.machinesWith(target.disk.id)).filter((m) =>
      m.attachments.some(
        (a) => a.disk === target.disk.id && (target.overlay ? a.overlay === target.overlay : a.inPlace),
      ),
    );
    for (const m of others)
      if (await isRunning(m.id)) {
        this.#c.messages.notify(msg('disks:disk-export.save.runsElsewhere', { name: m.name }), 'warn');
        return true;
      }
    return false;
  }
  /** Whether the disk's own file, if it is one, still reads after the save dialog (said if not). */
  async #stillReads(handle: FileSystemFileHandle, target?: Target) {
    const own = (await this.#source(target)).file;
    if (!own || (await stillReads(own))) return true;
    this.#c.messages.notify(msg('disks:disk-export.save.emptied', { name: handle.name }), 'error');
    return false;
  }
  #source(target?: Target) {
    const pm = this.#c.machine;
    return target ? sourceOf(pm, target.disk) : pageDisk(pm);
  }

  /**
   * Saves a disk to a file: the page's disk (a transient machine's, or a stored machine's boot disk), or `target`, a
   * stored disk with one of its overlays (or none: the stored disk itself). A machine on this page that runs from it
   * stops while it's written and starts again after; one running in another tab is said to be.
   */
  async save(mode: ExportMode, compress: boolean, target?: Target) {
    const { power: pw, messages } = this.#c;
    if (pw.busy()) return;
    const uses = this.#uses(target);
    const overlay = !target ? overlayName(this.#c.machine) : target.overlay ? overlayDir(target.overlay) : undefined;
    if (!target && !overlay) return;
    if (target && !uses && (await this.#runsElsewhere(target))) return;
    const how = SAVES[mode];
    const fileName = target ? target.disk.name : baseName(this.#c.machine);
    const suggestedName = suggested(fileName, how.suffix);
    // The picker first: it needs the click's user activation, which the stop below would let expire.
    const accept = { [how.type]: [how.suffix.slice(how.suffix.lastIndexOf('.'))] };
    const handle = await savePicker(suggestedName, { description: how.description, accept });
    if (handle === false) return;
    // A file chosen as the disk is read in place: if the dialog's file was that one, it's gone already; say so and
    // write nothing, before the machine is stopped.
    if (handle && uses && !(await this.#stillReads(handle, target))) return;
    const write = async () => {
      if (overlay === NO_OVERLAY_YET) throw new MsgError('disks:disk-export.save.nothing');
      const { source, identity } = await this.#source(target);
      const r = await runExport(
        { mode, compress, disk: { source, overlay, identity }, baseName: fileName, handle },
        (phase, f) => messages.stateText(progressText(phase, f)),
      );
      if (r.blob) download(r.blob, suggestedName);
      const name = handle?.name ?? suggestedName;
      return mode === 'changes'
        ? msg('disks:disk-export.saved.changes', { name, size: r.bytes, blocks: r.blocks, base: fileName })
        : msg('disks:disk-export.saved', { name, size: r.bytes });
    };
    if (uses) await this.#stopAndWrite(write);
    else await this.#write(write);
  }

  /** Not this page's machine's disk: nothing stops (the state shows the progress, then says what it was). */
  async #write(write: () => Promise<ReturnType<typeof msg>>) {
    const messages = this.#c.messages;
    const was = power.stateText;
    try {
      messages.notify(await write());
    } catch (e) {
      messages.notify(new MsgError('disks:disk-export.save.failed', {}, { cause: e }), 'error');
    } finally {
      power.stateText = was;
    }
  }

  /** The page's machine's disk: it stops (after asking, when it runs), and starts again after. */
  async #stopAndWrite(write: () => Promise<ReturnType<typeof msg>>) {
    const { power: pw, runner, messages } = this.#c;
    const running = isLive(power.state);
    if (
      running &&
      !(await ask.confirm(t(power.canSoft ? 'disks:disk-export.save.confirm.soft' : 'disks:disk-export.save.confirm'), {
        title: t('disks:disk-export.save.title'),
        ok: t(power.canSoft ? 'disks:disk-export.save.ok.soft' : 'disks:disk-export.save.ok'),
        danger: true,
      }))
    )
      return;
    await pw.exclusively(async () => {
      const was = power.stateText;
      if (running) {
        messages.stateText(msg('disks:disk-export.trimming'));
        await this.#trim();
      }
      // The guest shut down before its disk is saved (where its agent can): the file gets a clean disk. Kept running
      // (the guest refused, the user said no): no file.
      if (running && !(await pw.stopCleanly())) {
        power.stateText = was;
        return;
      }
      if (!running) await runner.stop();
      messages.setState('off');
      messages.stateText(msg('disks:disk-export.saving'));
      try {
        const saved = await write();
        messages.setState('off');
        messages.notify(saved);
      } catch (e) {
        messages.setState(
          'failed',
          new MsgError('disks:disk-export.save.failed', undefined, {
            cause: inUse(e) ? new MsgError('disks:disk-actions.inUse', undefined, { cause: e }) : e,
          }),
          [runner.d.later.problems().retry],
        );
        return;
      }
      if (running) runner.start();
    });
  }
}
