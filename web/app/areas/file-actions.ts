// A file disk's file from the user's click (docs/machines.md §3.2): allowed again (the browser's prompt), or chosen
// again (the browser's file picker: the disk's record keeps its id, name, identity, overlays and attachments and takes
// the new handle, once the file is checked to be the disk's), and a job that reads the file (an export, an import of
// changes) checked first, with both offered when the file can't be read. What the browser answers is
// web/app/file-access.ts; the start's message bar is web/app/run/problems.ts.
import { msg, MsgError, t } from '../../i18n.ts';
import { msgOf } from '../../msg.ts';
import { ask } from '../ask.svelte.ts';
import { hashFile } from '../definitions.ts';
import { replaceFileHandle } from '../disks.ts';
import { allow, allowHelps, reach, samePick, type Reach } from '../file-access.ts';
import { GRANT_WAIT_MS } from '../grants.ts';
import type { Page } from '../page.ts';
import type { DiskRecord } from '../shape.ts';
import type { Messages } from '../run/messages.ts';
import type { PageMachine } from '../run/page-machine.svelte.ts';
import type { Action } from './message-bar.svelte.ts';

/** A file chosen again: taken (the file), not the disk's (the words that say so), or nothing (cancelled, or not used). */
export type Chosen = Reach | Other | undefined;
type Other = { ok: false; why: 'other'; error: MsgError };

/** A job's failure, of the reason its disk's file can't be read (its headline: the key a literal at the call). */
export type Failed = (cause: MsgError) => MsgError;

/** One file from the user (the hidden input), or undefined if they cancel. */
function pickFile(title: string) {
  return new Promise<File | undefined>((resolve) => {
    const input = Object.assign(document.createElement('input'), { type: 'file', title });
    input.onchange = () => resolve(input.files?.[0]);
    input.oncancel = () => resolve(undefined);
    input.click();
  });
}

export class FileActions {
  readonly #m: PageMachine;
  readonly #messages: Messages;
  constructor(m: PageMachine, messages: Messages) {
    this.#m = m;
    this.#messages = messages;
  }

  /** Disk `d`'s record as the store has it now (its file chosen again here or in another tab), else `d`. */
  async #fresh(d: DiskRecord) {
    return (await this.#m.store.get('disks', d.id)) ?? d;
  }

  /** Disk `d`'s file now, without asking the user. */
  reach(d: DiskRecord) {
    return reach(d, { granted: this.#m.allowedFiles.has(d.id) });
  }

  /**
   * The user's click on Allow: the browser's permission asked for (before any await: the click's activation), and the
   * file read. `late`: the answer, when the browser gives it past `GRANT_WAIT_MS` (this one says `unanswered`).
   */
  async allow(d: DiskRecord, late?: (r: Reach) => void) {
    const took = (r: Reach) => {
      if (r.ok) this.#m.allowedFiles.add(d.id);
      return r;
    };
    return took(await allow(d, GRANT_WAIT_MS, late && ((r) => late(took(r)))));
  }

  /**
   * The user's click on Choose again: the browser's file picker (before any await: the click's activation; the plain
   * input where the browser has no picker, for this session only), the file checked to be the disk's, and its handle
   * kept in the disk's record in place of the old one.
   */
  async repick(d: DiskRecord): Promise<Chosen> {
    const picked = await this.#pick(d);
    if (!picked || 'error' in picked) return picked;
    const { file, handle } = picked;
    const same = await samePick(d, file, (f) => hashFile(f));
    if (same instanceof MsgError) return { ok: false, why: 'other', error: same };
    if (same === 'ask' && !(await this.#useAnyway(d, file))) return undefined;
    const m = this.#m;
    if (!handle) {
      m.pickedFiles.set(d.id, file);
      return { ok: true, file };
    }
    const now = await replaceFileHandle(m.store, d.id, handle);
    if (!now) return { ok: false, why: 'other', error: new MsgError('disks:file-actions.gone', { name: d.name }) };
    m.pickedFiles.delete(d.id);
    m.allowedFiles.add(d.id);
    const s = m.stored;
    if (s?.disks.has(d.id)) s.disks = new Map(s.disks).set(d.id, now);
    return { ok: true, file };
  }

  async #pick(d: DiskRecord): Promise<{ file: File; handle?: FileSystemFileHandle } | Other | undefined> {
    if (!window.showOpenFilePicker) {
      const file = await pickFile(t('disks:file-actions.pickAgain', { name: d.name }));
      return file && { file };
    }
    try {
      const [handle] = await window.showOpenFilePicker();
      return { file: await handle.getFile(), handle };
    } catch (e) {
      if ((e as DOMException | null)?.name === 'AbortError') return undefined; // cancelled
      return { ok: false, why: 'other', error: new MsgError('disks:file-actions.pickFailed', {}, { cause: e }) };
    }
  }

  /** Whether the user takes `file` for disk `d` though its name or date differ and nothing else tells. */
  #useAnyway(d: DiskRecord, file: File) {
    const want = d.identity as { name?: string; modified?: number };
    return ask.confirm(
      msg('disks:file-actions.otherFile', { file: file.name, name: want.name, when: new Date(want.modified ?? 0) }),
      { title: t('disks:file-actions.otherFile.title'), ok: t('disks:file-actions.otherFile.ok'), danger: true },
    );
  }

  /**
   * Disk `d` as a job reads it (an export, an import of changes; its record as the store has it now), or undefined
   * when its file can't be read now: said in the message bar as `failed` makes the job's failure of the reason, with
   * Allow access and Choose again offered, after which the job is the user's to run again. Any disk but a file disk is
   * ready.
   */
  async ready(d: DiskRecord, failed: Failed): Promise<DiskRecord | undefined> {
    if (d.kind !== 'file' || this.#m.pickedFiles.has(d.id)) return d;
    const now = await this.#fresh(d);
    const r = await this.reach(now);
    if (r.ok) return now;
    this.#says(now, r, failed);
    return undefined;
  }

  /** Says in the message bar that disk `d`'s file can't be read (`r`), as the job's failure, with what can be done. */
  #says(d: DiskRecord, r: Reach & { ok: false }, failed: Failed) {
    const done = () => this.#messages.notify(msg('disks:file-actions.readable', { name: d.name }), 'info');
    const again = (e: MsgError) => this.#says(d, { ok: false, why: r.why, error: e }, failed);
    const actions: Action[] = [];
    if (allowHelps(r.why))
      actions.push({
        label: t('disks:file-actions.allow'),
        run: () =>
          void this.allow(d, (late) => {
            if (late.ok) done();
          }).then((x) => (x.ok ? done() : again(x.error))),
      });
    actions.push({
      label: t('disks:file-actions.repick', { name: d.name }),
      run: () =>
        void this.repick(d).then((x) => {
          if (x?.ok) done();
          else if (x) again(x.error);
        }),
    });
    this.#messages.notify(failed(r.error), 'error', actions);
  }

  /** The Home page's (web/app/FileAccess.svelte). */
  page(): Pick<Page, 'diskFile' | 'diskAllow' | 'diskRepick'> {
    const m = this.#m;
    return {
      diskFile: async (id) => {
        const d = await m.store.get('disks', id);
        if (d?.kind !== 'file' || m.pickedFiles.has(id)) return undefined;
        const r = await this.reach(d);
        return r.ok || r.why === 'prompt' ? undefined : { why: r.why, reason: msgOf(r.error.cause) ?? r.error.msg };
      },
      diskAllow: (d) =>
        this.allow(d).then((r) => {
          if (!r.ok) throw r.error;
        }),
      diskRepick: (d) =>
        this.repick(d).then((r) => {
          if (r && !r.ok) throw r.error;
        }),
    };
  }
}
