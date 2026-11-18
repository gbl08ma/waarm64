// The page's disk (docs/frontend.md "Your own disk", docs/machines.md §2): a disk file opened or dropped (a machine of
// its own, kept in this browser), a stored machine opened on the page, a transient machine's disk chosen or reset,
// and file disks picked again or allowed. Changes in and the disk out are web/app/areas/disk-changes.ts and
// disk-export.ts.
import { msg, MsgError, t } from '../../i18n.ts';
import { removeOverlay, overlayBytes } from '../../overlay.ts';
import { ask } from '../ask.svelte.ts';
import { hashFile } from '../definitions.ts';
import { deleteOverlay } from '../disks.ts';
import { fetchManifest, isManifestUrl } from '../../chunked.ts';
import { openPicker } from '../file-pickers.ts';
import { diskOverlay, type DiskChoice } from '../machine.ts';
import { attach, createDisk, createMachine, knownDisk } from '../machines.ts';
import type { DiskRecord } from '../shape.ts';
import type { Core } from '../run/core.ts';
import { params } from '../run/knobs.ts';
import { MACHINE_PARAMS } from '../run/config.ts';
import { bootAttachment, diskName, overlayName } from '../run/page-disks.ts';
import { loadStored, rememberMachine } from '../run/page-machine.svelte.ts';
import type { Action } from './message-bar.svelte.ts';
import { isLive, power } from './power.svelte.ts';

/** One file from the user (the hidden input), or undefined if they cancel. */
function pickFile(title: string) {
  return new Promise<File | undefined>((resolve) => {
    const input = Object.assign(document.createElement('input'), { type: 'file', title });
    input.onchange = () => resolve(input.files?.[0]);
    input.oncancel = () => resolve(undefined);
    input.click();
  });
}

/** Whether a disk file's head says qcow2, and its virtual size then. */
async function qcow2Size(file: File) {
  const head = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  const view = new DataView(head.buffer);
  return head.length >= 32 && view.getUint32(0) === 0x514649fb ? Number(view.getBigUint64(24)) : undefined;
}

export type DiskDeps = Core & {
  /** A snapshot or a changes file chosen as a disk goes there instead. */
  isSnapshot(file: File): Promise<boolean>;
  loadSnapshot(file: File): Promise<void>;
  changesHeader(file: File): Promise<unknown>;
  loadChanges(file: File): Promise<void>;
  openMachines(tab?: 'disks', id?: string): void;
};

export class DiskActions {
  readonly #d: DiskDeps;
  /** A disk that isn't the one its changes were made over: a stored machine's disks are on the Home page (a new empty overlay); a transient machine's is reset. */
  readonly resetAction: Action;

  constructor(d: DiskDeps) {
    this.#d = d;
    const m = d.machine;
    this.resetAction = {
      get label() {
        return m.stored ? t('disks:disk-actions.disks') : t('disks:disk-actions.resetDisk');
      },
      run: () => {
        if (m.stored) d.openMachines('disks', m.stored.record.id);
        else void this.reset();
      },
    };
  }

  /** Asks for read permission on every file disk that needs it, from a click; files without a handle are picked again (by identity: name, size, date). */
  async grantFiles(disks: DiskRecord[]) {
    for (const d of disks) {
      const h = d.handle;
      if (h?.requestPermission && (await h.requestPermission({ mode: 'read' })) === 'granted') continue;
      const file = await pickFile(t('disks:disk-actions.pickAgain', { name: d.name }));
      if (!file || !(await this.#sameFile(d, file))) return false;
      this.#d.machine.pickedFiles.set(d.id, file);
    }
    return true;
  }
  /** Whether `file` is disk `d`'s: the same name, size and date, the same bytes by the hash, or the user says so. */
  async #sameFile(d: DiskRecord, file: File) {
    const want = d.identity as { name?: string; bytes?: number; modified?: number };
    const differs = file.name !== want.name || file.size !== want.bytes || file.lastModified !== want.modified;
    if (!differs) return true;
    // Another name, size or date: the same bytes by the hash, where the disk has one (a definition's: machines.md §6).
    if (d.sha256 && file.size === want.bytes && (await hashFile(file)) === d.sha256) return true;
    return ask.confirm(
      msg('disks:disk-actions.otherFile', {
        file: file.name,
        name: want.name,
        bytes: want.bytes,
        when: new Date(want.modified ?? 0),
      }),
      { title: t('disks:disk-actions.otherFile.title'), ok: t('disks:disk-actions.otherFile.ok'), danger: true },
    );
  }

  /**
   * Open disk… (the first-run message's, the Home page's From a disk image…): the browser's file picker where it
   * has one, so the machine keeps the file's handle (a reload's resume asks only to allow it, not to pick the file
   * again), as a drop and the Add disk wizard do; else the plain input.
   */
  async open() {
    if (!window.showOpenFilePicker) return openPicker('disk');
    let handle: FileSystemFileHandle;
    try {
      [handle] = await window.showOpenFilePicker();
    } catch (e) {
      if ((e as DOMException).name !== 'AbortError')
        this.#d.messages.notify(new MsgError('disks:disk-actions.openFailed', {}, { cause: e }), 'error');
      return;
    }
    await this.choose({ file: await handle.getFile(), handle });
  }

  /**
   * The machine for a disk file opened or dropped on the page (machines.md §2: "opening a disk the old way stays"):
   * the one that already attaches it (the same name, size and date), or a new one named after it. Its handle, when
   * the browser gave one, is kept; the file itself is used for this session either way.
   */
  async #machineForFile(file: File, handle?: FileSystemFileHandle) {
    const m = this.#d.machine;
    const known = await knownDisk(m.store, { kind: 'file', file, handle, size: 0 });
    let id = known && (await m.store.machinesWith(known.id))[0]?.id;
    if (known && id) m.pickedFiles.set(known.id, file);
    else {
      const d =
        known ??
        (await createDisk(m.store, { kind: 'file', file, handle, size: (await qcow2Size(file)) ?? file.size }));
      const name = file.name.replace(/\.(qcow2|img|raw|iso)$/i, '');
      const made = await createMachine(m.store, { name, ncpus: m.ncpus, ramMiB: m.ramMiB });
      await attach(m.store, made, d, { readOnly: /\.iso$/i.test(file.name) });
      id = made.id;
      m.pickedFiles.set(d.id, file);
    }
    await this.switchMachine(id);
  }

  /**
   * Opens stored machine `id` on this page: the one running stops (after asking), and it starts. From a transient
   * machine's page (a test's `?machine=`) the page is reloaded as the machine's.
   */
  async switchMachine(id: string) {
    const { machine: m, runner, power: pw } = this.#d;
    if (m.name !== 'uefi' || params.has('machine')) {
      location.search = `?m=${id}`;
      return;
    }
    if (
      isLive(power.state) &&
      m.stored?.record.id !== id &&
      !(await ask.confirm(
        t(power.canSoft ? 'machine:disk-actions.switch.confirm.soft' : 'machine:disk-actions.switch.confirm'),
        {
          title: t('machine:disk-actions.switch.title'),
          ok: t('machine:disk-actions.switch.ok'),
          danger: true,
        },
      ))
    )
      return;
    await pw.exclusively(async () => {
      if (!(await pw.stopCleanly())) return; // kept running: this machine stays
      runner.d.net.machineOff();
      const next = await loadStored(m.store, id);
      [m.stored, m.storedError, m.chosen] = [next, undefined, undefined];
      // The address's size and switches were for the machine it opened: this one runs as its record says.
      const q = new URLSearchParams(location.search);
      for (const k of ['m', 'disk', ...MACHINE_PARAMS]) q.delete(k);
      q.set('m', id);
      history.replaceState(null, '', `?${q}`);
      m.takeSize();
      m.choose3d();
      rememberMachine(id);
      m.onRecord();
      this.#d.terminal.term.reset();
      pw.startOpened();
    });
  }

  /** A disk image, snapshot or changes file chosen or dropped on the page, or a disk's URL. */
  async choose(choice: { file: File; handle?: FileSystemFileHandle } | { url: string }) {
    const d = this.#d;
    const m = d.machine;
    if ('file' in choice && (await d.isSnapshot(choice.file))) return d.loadSnapshot(choice.file); // a snapshot isn't a disk to boot: it replaces the machine
    if (d.power.busy()) return;
    if ('file' in choice && (await d.changesHeader(choice.file))) {
      // a changes file isn't a disk to boot: it goes onto the disk on the page
      if (overlayName(m)) return d.loadChanges(choice.file);
      d.messages.notify(msg('disks:disk-actions.changes.noDisk', { name: choice.file.name }), 'warn');
      return;
    }
    if (!m.spec.firmware) return; // only a machine that boots through UEFI takes a disk of its own (the test guests' kernels are their own)
    // The page's own machine: a file opened or dropped is a machine of its own, kept in this browser (machines.md §2).
    if ('file' in choice && m.name === 'uefi' && !params.has('machine'))
      return this.#machineForFile(choice.file, choice.handle);
    const next: DiskChoice = { ...choice, overlay: await diskOverlay(choice) };
    if (
      isLive(power.state) &&
      !(await ask.confirm(msg('disks:disk-actions.boot.confirm', { name: next.file?.name ?? next.url }), {
        ok: t('disks:disk-actions.boot.ok'),
        danger: true,
      }))
    )
      return;
    m.chosen = next;
    await d.power.restart();
  }

  // The disk reset (M8 decision 4): stop the machine (its overlay's files are locked while it runs), delete the overlay, start again.
  async reset() {
    const { machine: m, power: pw } = this.#d;
    const name = overlayName(m);
    if (!name || pw.busy()) return;
    const written = await overlayBytes(name).catch(() => 0);
    const disk =
      m.chosen || m.stored
        ? msg('disks:disk-actions.theDisk', { name: diskName(m) })
        : msg('disks:disk-actions.machineDisk', { machine: m.spec.title });
    const question = written
      ? msg('disks:disk-actions.reset.confirm.size', { disk, size: written })
      : msg('disks:disk-actions.reset.confirm', { disk });
    if (
      !(await ask.confirm(question, {
        title: t('disks:disk-actions.reset.title'),
        ok: t('disks:disk-actions.reset.ok'),
        danger: true,
      }))
    )
      return;
    await pw.exclusively(() => this.#resetNow(name));
  }
  async #resetNow(name: string) {
    const { machine: m, runner, messages } = this.#d;
    await runner.stop();
    this.#d.terminal.term.reset();
    messages.setState('loading');
    messages.stateText(msg('disks:disk-actions.resetting'));
    try {
      const a = bootAttachment(m);
      if (m.stored && a?.overlay) {
        await deleteOverlay(m.store, a.overlay); // its record, then its files: the next start makes an empty one
        await m.rereadRecord();
      } else if (!m.stored) await removeOverlay(name); // once the machine's device worker has closed it
    } catch (e) {
      messages.setState(
        'failed',
        new MsgError('disks:disk-actions.reset.failed', undefined, {
          cause: new MsgError('disks:disk-actions.inUse', undefined, { cause: e }),
        }),
        [this.resetAction, runner.d.later.problems().retry],
      );
      return;
    }
    runner.start();
  }

  /** `?disk=<url>`: a root disk of a firmware machine's own; a chunked image's manifest names it (the machine is called that, not `prefetch.json`; the boot reads it again). */
  async fromAddress() {
    const m = this.#d.machine;
    const disk = params.get('disk');
    if (!disk || !m.spec.firmware) return;
    const url = new URL(disk, location.href).href;
    const name = isManifestUrl(url)
      ? await fetchManifest(url).then(
          (f) => f.name,
          () => undefined, // unnamed: the URL names it
        )
      : undefined;
    m.chosen = { url, overlay: await diskOverlay({ url }), name };
  }
}
