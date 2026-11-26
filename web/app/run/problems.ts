// What a user can do about each problem the machine worker reports (web/app/protocol.ts `Problem`; the worker's message
// says what happened and why), and about a suspended machine and file disks that need a click: the message bar's
// buttons.
import { msg, t } from '../../i18n.ts';
import { ask } from '../ask.svelte.ts';
import { openPicker } from '../file-pickers.ts';
import { messageBar, type Action } from '../areas/message-bar.svelte.ts';
import type { FileActions } from '../areas/file-actions.ts';
import { allowHelps } from '../file-access.ts';
import type { MsgError } from '../../msg.ts';
import type { Problem } from '../protocol.ts';
import type { Messages } from './messages.ts';
import type { Need } from './page-disks.ts';

export type ProblemDeps = {
  messages: Messages;
  /** A restart (`resume` false: a suspended machine is dropped). */
  restart(resume?: boolean): Promise<void>;
  /**
   * What failed, again: the last start's own retry where it has one (a snapshot's restore: the restore again,
   * web/app/areas/snapshot-restore.ts), else a restart.
   */
  again(): Promise<void>;
  /** The serial log's actions (web/app/areas/serial-terminal.ts). */
  log: Record<'show' | 'copy' | 'save', Action>;
  /** A disk that isn't the one its changes were made over. */
  resetDisk: Action;
  /** A file disk's file allowed again or chosen again, from a click (web/app/areas/file-actions.ts). */
  files: Pick<FileActions, 'allow' | 'repick'>;
};

export class Problems {
  readonly retry: Action;
  readonly table: Record<Problem, Action[]>;
  /** A suspended machine's: resume it, or boot instead (after asking: what it held is lost). */
  readonly suspended: Action[];
  readonly #d: ProblemDeps;

  constructor(d: ProblemDeps) {
    this.#d = d;
    const restart = () => void d.restart();
    this.retry = { label: t('machine:problems.retry'), run: () => void d.again() };
    const startNormally: Action = { label: t('snapshots:problems.startNormally'), run: restart };
    const loadAgain: Action = { label: t('snapshots:problems.loadAgain'), run: () => openPicker('snapshot') };
    const { show, copy, save } = d.log;
    this.table = {
      'missing-core': [this.retry],
      'missing-image': [this.retry],
      'disk-in-use': [this.retry],
      'disk-mismatch': [d.resetDisk],
      memory: [this.retry],
      panic: [show, copy, save],
      snapshot: [startNormally, loadAgain],
      emulator: [show, copy, save],
    };
    const bootInstead: Action = {
      label: t('machine:problems.bootInstead'),
      run: () =>
        void ask
          .confirm(t('machine:problems.bootInstead.confirm'), {
            ok: t('machine:problems.bootInstead.ok'),
            danger: true,
          })
          .then((yes) => {
            if (yes) void d.restart(false);
          }),
    };
    this.suspended = [{ label: t('machine:problems.resume'), run: restart }, bootInstead];
  }

  /**
   * File disks the page can't read without the user: the machine waits for the click that allows or chooses them
   * (docs/machines.md §3.2). The bar says why (`said`: what the last click came to, else the first reason past a grant
   * not given yet) and offers Allow and start where the browser's grant may help, and Choose <disk> again and start (Select
   * and start for a disk without a handle), one disk a click: each opens a prompt or a picker, which takes the click's
   * activation. Returns the bar's actions.
   */
  needsUser(needs: Need[], said?: MsgError) {
    const d = this.#d;
    const routine = (n: Need) => n.reach.why === 'prompt' || n.reach.why === 'nohandle';
    const words =
      said ??
      needs.find((n) => !routine(n))?.reach.error ??
      msg('disks:problems.needsUser', { count: needs.length, names: needs.map((x) => x.disk.name) });
    const actions: Action[] = [];
    if (needs.some((n) => n.disk.handle && allowHelps(n.reach.why)))
      actions.push({ label: t('disks:problems.allowAndStart'), run: () => void this.#allow(needs) });
    const first = needs[0];
    actions.push({
      label: first.disk.handle
        ? t('disks:problems.repickAndStart', { name: first.disk.name })
        : t('disks:problems.pickAndStart'),
      run: () => void this.#repick(needs, first),
    });
    d.messages.setState('idle', words, actions, 'warn');
    return actions;
  }

  /**
   * Allow and start: the browser asked for each disk's grant in turn, and the start goes on once all are given. A
   * refusal, an error and no answer are said, with the buttons again; an answer that comes late starts the machine if
   * the bar still offers this (the user did nothing else meanwhile).
   */
  async #allow(needs: Need[]) {
    for (const n of needs) {
      if (!n.disk.handle || !allowHelps(n.reach.why)) continue;
      let shown: Action[] | undefined;
      const r = await this.#d.files.allow(n.disk, (late) => {
        // The bar's actions are its own proxies of these: an action is told by its function.
        if (!shown || !messageBar.actions.some((a) => a.run === shown?.[0].run)) return;
        if (late.ok) void this.#d.again();
        else this.needsUser(needs, late.error);
      });
      if (!r.ok) {
        shown = this.needsUser(needs, r.error);
        return;
      }
    }
    void this.#d.again();
  }

  /** Choose again and start: disk `n`'s file chosen again; the start goes on (the rest, if any, are asked for by it). */
  async #repick(needs: Need[], n: Need) {
    const r = await this.#d.files.repick(n.disk);
    if (!r) return; // cancelled, or not taken: the bar stays as it is
    if (!r.ok) this.needsUser(needs, r.error);
    else void this.#d.again();
  }
}
