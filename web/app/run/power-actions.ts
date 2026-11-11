// The toolbar's power (docs/frontend.md "The page's code"): Start, Restart, Power off, and the stop-then-start the
// other areas run (`exclusively`): one at a time, the stored machine read again before a start.
import { msg, MsgError, t } from '../../i18n.ts';
import { ask } from '../ask.svelte.ts';
import { isLive, power } from '../areas/power.svelte.ts';
import type { SerialTerminal } from '../areas/serial-terminal.ts';
import type { Messages } from './messages.ts';
import { needsDisk } from './page-disks.ts';
import { loadStored, type PageMachine } from './page-machine.svelte.ts';
import type { Runner } from './runner.ts';
import { jitParam } from './knobs.ts';

export type PowerDeps = {
  machine: PageMachine;
  runner: Runner;
  messages: Messages;
  terminal: SerialTerminal;
  /** The Machines page (its Disks tab) and Open disk…. */
  later: { openMachines(tab?: 'disks', id?: string): void; openDisk(): Promise<void> };
};

export class PowerActions {
  readonly #d: PowerDeps;
  constructor(d: PowerDeps) {
    this.#d = d;
  }

  /**
   * Runs `f` (a stop, then maybe a start) unless another is running: a second Restart click, or one
   * during a disk reset, would start a machine beside the one being started, with nothing to stop it.
   */
  async exclusively(f: () => Promise<void>) {
    if (power.busy) return;
    power.switching = true;
    try {
      await f();
    } finally {
      power.switching = false;
    }
  }
  /** True while a snapshot is being written (after saying so) or the machine is being switched: a disk's Export, Open disk and the like wait for it. */
  busy() {
    if (power.saving) void ask.alert(t('snapshots:power-actions.busy'));
    return power.busy;
  }

  /**
   * A stored machine's record and disks as the store has them now (the Machines page edits them while the machine is
   * off), and what follows from them: its size, its display, the toolbar's name. False, with the page saying why, when
   * the machine can't be opened any more (deleted, or a disk gone).
   */
  async reloadStored() {
    const m = this.#d.machine;
    const s = m.stored;
    if (!s) return true;
    try {
      m.stored = await loadStored(m.store, s.record.id);
    } catch (e) {
      this.#d.messages.setState('failed', new MsgError('machine:power-actions.cantOpen', {}, { cause: e }), [
        { label: t('machine:power-actions.machines'), run: () => this.#d.later.openMachines() },
      ]);
      return false;
    }
    const record = m.stored.record;
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- 0 means unset
    m.takeSize(record, jitParam() || record.jitMiB || 0);
    m.choose3d();
    m.onRecord();
    return true;
  }

  /** Stops the machine and starts a new one (which resumes a suspended machine, unless `resume` is false): a stored machine as its record is now. */
  restart(resume = true) {
    return this.exclusively(async () => {
      const { runner, terminal } = this.#d;
      await runner.stop();
      if (!(await this.reloadStored())) return;
      if (needsDisk(this.#d.machine)) return this.waitForDisk();
      terminal.term.reset();
      runner.start(undefined, resume);
    });
  }

  /** The toolbar's Start, Restart or Retry: a restart of a running machine is a power cut, so it asks first. */
  async restartAsked() {
    if (
      isLive(power.state) &&
      !(await ask.confirm(t('machine:power-actions.restart.confirm'), {
        title: t('machine:power-actions.restart.title'),
        ok: t('machine:power-actions.restart.ok'),
        danger: true,
      }))
    )
      return;
    await this.restart();
  }

  /** Stops the machine like pulling the plug. */
  powerOff() {
    return this.exclusively(async () => {
      await this.#d.runner.stop();
      this.#d.messages.setState('off');
    });
  }
  /** The toolbar's Power off: the machine stops at once, after asking. */
  async powerOffAsked() {
    if (!isLive(power.state)) return;
    if (
      !(await ask.confirm(t('machine:power-actions.powerOff.confirm'), {
        title: t('machine:power-actions.powerOff.title'),
        ok: t('machine:power-actions.powerOff.ok'),
        danger: true,
      }))
    )
      return;
    await this.powerOff();
  }

  /** No disk yet: say how to bring one, and start nothing. */
  waitForDisk() {
    const { machine: m, messages, later } = this.#d;
    const s = m.stored;
    if (s)
      return messages.setState(
        'idle',
        msg('disks:power-actions.noDisks', { name: s.record.name }),
        [{ label: t('disks:disk-actions.disks'), run: () => later.openMachines('disks', s.record.id) }],
        'warn',
      );
    messages.setState(
      'idle',
      msg('machine:power-actions.openDisk.prompt'),
      [{ label: t('machine:power-actions.openDisk'), run: () => void later.openDisk() }],
      'warn',
    );
  }

  /** The first start: unless what the page can tell won't work (no isolation, the stored machine, no disk, a crash before, too little memory). */
  boot(signal: { crashedBefore(): boolean; fits(): boolean }) {
    const { machine: m, messages, runner } = this.#d;
    // SharedArrayBuffer (the guest's memory, shared by the vCPU workers) needs cross-origin isolation.
    if (!crossOriginIsolated) {
      messages.setState(
        'failed',
        new MsgError('machine:power-actions.notIsolated', undefined, {
          cause: new MsgError('machine:power-actions.notIsolated.cause', undefined, {
            cause: new MsgError('machine:power-actions.notIsolated.fix'),
          }),
        }),
      );
      power.cantRun = true;
      return;
    }
    if (m.storedError !== undefined)
      return messages.setState('failed', new MsgError('machine:power-actions.cantOpen', {}, { cause: m.storedError }));
    if (needsDisk(m)) return this.waitForDisk();
    if (signal.crashedBefore() || !signal.fits()) return;
    runner.start();
  }
}
