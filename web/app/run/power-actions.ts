// The toolbar's power (docs/frontend.md "The page's code"): Start, Restart, Power off, and the stop-then-start the
// other areas run (`exclusively`): one at a time, the stored machine read again before a start.
import { msg, MsgError, t } from '../../i18n.ts';
import { ask } from '../ask.svelte.ts';
import { isLive, power } from '../areas/power.svelte.ts';
import type { SerialTerminal } from '../areas/serial-terminal.ts';
import type { Messages } from './messages.ts';
import { needsDisk } from './page-disks.ts';
import { takeStartAsked } from './knobs.ts';
import { autoStart } from '../settings.ts';
import { machineDir } from '../store.ts';
import { suspended } from '../../overlay.ts';
import type { Action } from '../areas/message-bar.svelte.ts';
import { loadStored, type PageMachine } from './page-machine.svelte.ts';
import type { Runner } from './runner.ts';
import { SoftPower } from './soft-power.ts';
import { stopCleanly } from './clean-stop.ts';
import type { AgentLink } from '../agent-link.ts';

export type PowerDeps = {
  machine: PageMachine;
  runner: Runner;
  messages: Messages;
  terminal: SerialTerminal;
  /** The Home page (its Disks tab) and Open disk…. */
  later: {
    openMachines(tab?: 'disks', id?: string): void;
    openDisk(): Promise<void>;
    /** A suspended machine's buttons in the message bar (web/app/run/problems.ts `suspended`). */
    suspended(): Action[];
  };
  /** The memory signal's checks (web/app/run/memory-signal.ts): a crash before, too little memory (true: said, not started). */
  signal: { crashedBefore(): boolean; fits(): boolean };
  /** The run's agent (web/app/areas/agent-actions.ts): Power off and Restart ask the guest first where it can. */
  agent: { readonly link: AgentLink | undefined };
};

export class PowerActions {
  readonly #d: PowerDeps;
  readonly #soft: SoftPower;
  /**
   * The first start of a machine from a template: its kept snapshot `id` restored instead of a boot (set by
   * web/app/areas/snapshot-restore.ts, `first`, which is made after this).
   */
  restoreFirst: (id: string) => Promise<void> = () => Promise.reject(new Error('no restore yet'));
  constructor(d: PowerDeps) {
    this.#d = d;
    this.#soft = new SoftPower(d.agent, power, d.messages);
  }

  /**
   * Runs `f` (a stop, then maybe a start) unless another is running: a second Restart click, or one
   * during a disk reset, would start a machine beside the one being started, with nothing to stop it. False: another
   * was running (`f` didn't run).
   */
  async exclusively(f: () => Promise<void>): Promise<boolean> {
    if (power.busy) return false;
    power.switching = true;
    try {
      await f();
      return true;
    } finally {
      power.switching = false;
    }
  }
  /** True while a snapshot is being written (after saying so) or the machine is being switched: a disk's Export, Open disk and the like wait for it. */
  busy() {
    if (power.saving) this.#d.messages.notify(msg('snapshots:power-actions.busy'), 'warn');
    return power.busy;
  }

  /**
   * A stored machine's record and disks as the store has them now (the Home page edits them while the machine is
   * off), and what follows from them: its size, its display, the toolbar's name. False, with the page saying why, when
   * the machine can't be opened any more (deleted, or a disk gone).
   */
  async reloadStored() {
    const m = this.#d.machine;
    const s = m.stored;
    if (!s) return true;
    // A run that just ended has let go of the machine's lock (else its cut-off restore's forks look owned: `loadStored`).
    await this.#d.runner.lock.settled();
    try {
      m.stored = await loadStored(m.store, s.record.id);
    } catch (e) {
      this.#d.messages.setState('failed', new MsgError('machine:power-actions.cantOpen', {}, { cause: e }), [
        { label: t('machine:power-actions.machines'), run: () => this.#d.later.openMachines() },
      ]);
      return false;
    }
    m.takeSize();
    m.choose3d();
    m.onRecord();
    return true;
  }

  /** Stops the machine and starts a new one (which resumes a suspended machine, unless `resume` is false): a stored machine as its record is now. */
  async restart(resume = true): Promise<void> {
    await this.exclusively(async () => {
      const { runner, terminal } = this.#d;
      await runner.stop();
      if (!(await this.reloadStored())) return;
      if (needsDisk(this.#d.machine)) return this.waitForDisk();
      // A machine from a template not started yet (its first start offered, not taken): its snapshot, not a boot.
      const first = this.#d.machine.stored?.record.restoreFirst;
      if (first) return this.restoreFirst(first);
      terminal.term.reset();
      runner.start(undefined, resume);
    });
  }

  /**
   * The guest reset itself (PSCI SYSTEM_RESET): a new machine starts in its place. A save or a switch under way
   * (`busy`, which a restart would be dropped for) ends first; the restart then runs unless the run was replaced
   * meanwhile (`live` false).
   */
  async rebooted(live: () => boolean) {
    while (power.busy) await new Promise((r) => setTimeout(r, 100));
    if (live()) await this.restart();
  }

  /**
   * The toolbar's Start, Restart or Retry. A running machine's restart is asked of the guest first (a reboot,
   * web/app/run/soft-power.ts); else (or a second Restart meanwhile) it is a power cut, so it asks first: for the run it
   * asked about (the guest's own reboot may have started another while the question was open).
   */
  async restartAsked() {
    if (isLive(power.state) && (await this.#soft.request('reboot'))) return;
    const run = this.#d.machine.run;
    if (
      isLive(power.state) &&
      !(await ask.confirm(
        t(power.soft ? 'machine:power-actions.restart.now' : 'machine:power-actions.restart.confirm'),
        {
          title: t('machine:power-actions.restart.title'),
          ok: t('machine:power-actions.restart.ok'),
          danger: true,
        },
      ))
    )
      return;
    if (run && this.#d.machine.run !== run) return;
    await this.restart();
  }

  /**
   * Stops the machine like pulling the plug, or (`cleanly`, the Home page's) asking the guest first. True: it is
   * off now; false: it runs on (another stop or start was under way, or the user kept it running).
   */
  async powerOff(o: { cleanly?: boolean } = {}): Promise<boolean> {
    let off = false;
    const ran = await this.exclusively(async () => {
      off = o.cleanly ? await this.stopCleanly() : (await this.#d.runner.stop(), true);
      if (off) this.#d.messages.setState('off');
    });
    return ran && off;
  }

  /**
   * Stops the running machine for a change that keeps its disk (web/app/run/clean-stop.ts): the guest asked to shut
   * down first where its agent can, a dialog meanwhile whose button powers off at once; the guest not taking it, the
   * user asked whether to power off at once. Called within `exclusively`. False: the user kept it running (the
   * change is to be dropped).
   */
  async stopCleanly(): Promise<boolean> {
    const run = this.#d.machine.run;
    const r = await stopCleanly({
      soft: () => this.#soft.request('off'),
      pending: () => !!power.soft,
      canSoft: () => !!this.#d.agent.link?.canPower,
      up: () => !!run?.live() && isLive(power.state),
      dialog: () =>
        ask.wait(t('machine:power-actions.shuttingDown'), {
          title: t('machine:power-actions.shuttingDown.title'),
          ok: t('machine:power-actions.shuttingDown.now'),
        }),
      hard: () =>
        ask.closableConfirm(msg('machine:power-actions.shuttingDown.refused'), {
          title: t('machine:power-actions.powerOff.title'),
          ok: t('machine:power-actions.powerOff.ok'),
          danger: true,
        }),
      stop: () => this.#d.runner.stop(),
    });
    return r !== 'kept';
  }
  /**
   * The toolbar's Power off: asked of the guest first (web/app/run/soft-power.ts); else (or a second Power off
   * meanwhile) the machine stops at once, after asking: the run it asked about (the guest's own shutdown or reboot may
   * have ended it while the question was open).
   */
  async powerOffAsked() {
    if (!isLive(power.state) || (await this.#soft.request('off'))) return;
    const run = this.#d.machine.run;
    if (!isLive(power.state)) return;
    if (
      !(await ask.confirm(
        t(power.soft ? 'machine:power-actions.powerOff.now' : 'machine:power-actions.powerOff.confirm'),
        {
          title: t('machine:power-actions.powerOff.title'),
          ok: t('machine:power-actions.powerOff.ok'),
          danger: true,
        },
      ))
    )
      return;
    if (this.#d.machine.run !== run || !isLive(power.state)) return;
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

  /**
   * A machine opened on the page starts: unless it has no disk yet, its tab went away with it running (a crash before),
   * or this device hasn't the memory for it (each said, with what to do). The first start and a switch to another
   * machine alike; a restart doesn't ask again (it was asked for, or offered by these).
   */
  startOpened() {
    const { machine: m, runner, signal } = this.#d;
    if (needsDisk(m)) return this.waitForDisk();
    if (signal.crashedBefore() || !signal.fits()) return;
    const first = m.stored?.record.restoreFirst;
    if (first) return void this.restoreFirst(first);
    runner.start();
  }

  /**
   * A machine that waits stopped for its Start: off, or suspended where it has a suspended copy (read after: its Start
   * says Resume, and the message bar offers to boot instead, as after a Suspend in this tab).
   */
  #waitStopped() {
    const { machine: m, messages, later } = this.#d;
    messages.setState('off');
    const s = m.stored;
    if (!s) return;
    void suspended(machineDir(s.record.id)).then(
      (copy) => {
        if (copy && power.state === 'off' && !power.busy && m.stored === s)
          messages.setState('suspended', undefined, later.suspended(), 'warn');
      },
      () => undefined, // unreadable: it stays off, and its Start says what a start finds
    );
  }

  /**
   * The first start: unless what the page can tell won't work (no isolation, the stored machine, and `startOpened`'s),
   * or the visit opened another page first (`elsewhere`: the introduction, Home, the demo store): the machine opened
   * last then waits stopped, for its Start, behind a page the visitor came for. A stored machine waits the same way
   * unless the Preferences say it starts with its tab (web/app/settings.ts `autoStart`) or a Start opened the tab
   * (`takeStartAsked`): its settings can be changed before it runs. A machine the address or a file gives starts.
   */
  boot(elsewhere = false) {
    const { machine: m, messages, signal } = this.#d;
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
    const asked = takeStartAsked();
    if (!elsewhere && (!m.stored || asked || autoStart())) return this.startOpened();
    if (needsDisk(m)) return this.waitForDisk();
    // The machine's own view says what a start would (its tab went away with it running), as a start does.
    if (!elsewhere && signal.crashedBefore()) return;
    this.#waitStopped();
  }
}
