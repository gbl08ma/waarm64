// What a user can do about each problem the machine worker reports (web/app/protocol.ts `Problem`; the worker's message
// says what happened and why), and about a suspended machine and file disks that need a click: the message bar's
// buttons.
import { msg, t } from '../../i18n.ts';
import { ask } from '../ask.svelte.ts';
import { openPicker } from '../file-pickers.ts';
import type { Action } from '../areas/message-bar.svelte.ts';
import type { Problem } from '../protocol.ts';
import type { DiskRecord } from '../shape.ts';
import type { Messages } from './messages.ts';

export type ProblemDeps = {
  messages: Messages;
  /** A restart (`resume` false: a suspended machine is dropped). */
  restart(resume?: boolean): Promise<void>;
  /** The serial log's actions (web/app/areas/serial-terminal.ts). */
  log: Record<'show' | 'copy' | 'save', Action>;
  /** A disk that isn't the one its changes were made over. */
  resetDisk: Action;
  /** Asks for the file disks' permission or picks them again (false: not all). */
  grantFiles(disks: DiskRecord[]): Promise<boolean>;
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
    this.retry = { label: t('machine:problems.retry'), run: restart };
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

  /** File disks the page can't read without the user: the machine waits for the click that allows or picks them. */
  needsUser(needs: DiskRecord[]) {
    const d = this.#d;
    d.messages.setState(
      'idle',
      msg('disks:problems.needsUser', { count: needs.length, names: needs.map((x) => x.name) }),
      [
        {
          label: needs.some((x) => x.handle) ? t('disks:problems.allowAndStart') : t('disks:problems.pickAndStart'),
          run: () =>
            void d.grantFiles(needs).then((ok) => {
              if (ok) void d.restart();
            }),
        },
      ],
      'warn',
    );
  }
}
