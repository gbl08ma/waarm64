// The machine's size: a transient machine's from the toolbar's Machine menu (vCPUs, RAM and graphics, applied by a
// restart: a power cut, like the other restarts), a stored machine's from its Settings on the Machines page, and the
// shape a machine would run with here.
import { msg, t } from '../../i18n.ts';
import { ask } from '../ask.svelte.ts';
import type { MachineSize } from '../areas/current.svelte.ts';
import { isLive, power } from '../areas/power.svelte.ts';
import type { SerialTerminal } from '../areas/serial-terminal.ts';
import { JIT_DEFAULT_MIB } from '../machine.ts';
import { updateMachine } from '../machines.ts';
import { remember, settings } from '../settings.ts';
import { currentShape } from '../snapshots.ts';
import type { DiskRecord, MachineRecord } from '../shape.ts';
import type { OverlayRecord } from '../store.ts';
import { cpuFeatures, gpuAsked, jitParam, params, query, simpleDisplay } from './knobs.ts';
import { memoryWarning } from './memory-signal.ts';
import type { Messages } from './messages.ts';
import type { PageMachine } from './page-machine.svelte.ts';
import type { PowerActions } from './power-actions.ts';
import type { Runner } from './runner.ts';
import { addressFor, asRun, effectiveDisplay, resolveMachine } from './config.ts';

/** The Machine menu's size: what runs (a stored machine's own settings after a switch) and what it offers. */
export function sizeOf(m: PageMachine): MachineSize {
  return {
    ncpus: m.ncpus,
    ramMiB: m.ramMiB,
    split: m.ramSplit,
    gpu: m.want3d ? '3d' : '2d',
    // A machine with Vulkan keeps Venus's window and arena in memory 0: its split (the toolbar's note) moves.
    vulkan: m.want3d && m.wantsVulkan(),
    gpuLock: !m.webgl2
      ? t('toolbar:size-actions.gpuLock.noWebgl2')
      : gpuAsked
        ? t('toolbar:size-actions.gpuLock.address', { gpu: params.get('gpu') ?? '' })
        : '',
  };
}

export class SizeActions {
  readonly #m: PageMachine;
  readonly #power: PowerActions;
  readonly #runner: Runner;
  readonly #messages: Messages;
  readonly #terminal: SerialTerminal;

  constructor(d: {
    machine: PageMachine;
    power: PowerActions;
    runner: Runner;
    messages: Messages;
    terminal: SerialTerminal;
  }) {
    [this.#m, this.#power, this.#runner, this.#messages, this.#terminal] = [
      d.machine,
      d.power,
      d.runner,
      d.messages,
      d.terminal,
    ];
  }

  /** A transient machine's size from the Machine menu: after asking, it restarts with it. */
  async apply(n: number, r: number, g: '3d' | '2d') {
    const m = this.#m;
    if (n === m.ncpus && r === m.ramMiB && g === (m.want3d ? '3d' : '2d')) return;
    const running = isLive(power.state);
    const size = !m.hasGpu
      ? msg('machine:size-actions.size', { count: n, ram: r })
      : g === '3d'
        ? msg('machine:size-actions.size.3d', { count: n, ram: r })
        : msg('machine:size-actions.size.2d', { count: n, ram: r });
    const question = running
      ? t('machine:size-actions.size.confirm.running', { size })
      : t('machine:size-actions.size.confirm', { size });
    if (
      !(await ask.confirm(memoryWarning(question, r, n, m.jitBudget()), {
        title: t('machine:size-actions.size.title'),
        ok: t('machine:size-actions.size.ok'),
        danger: running,
      }))
    )
      return;
    if (r !== m.ramMiB) m.ramSplit = undefined;
    [m.ncpus, m.ramMiB] = [n, r];
    remember({ ncpus: n, ramMiB: r, ...(m.hasGpu && !gpuAsked ? { gpu: g } : {}) });
    m.choose3d();
    await this.#power.restart();
  }

  /** A stored machine's settings, from its Settings tab while it runs on this page: it restarts with them (its snapshots of the old shape are orphaned: they stay, marked). */
  async saveSettings(next: MachineRecord) {
    const m = this.#m;
    const s = m.stored;
    if (s?.record.id !== next.id) return;
    const running = isLive(power.state);
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- 0 means unset
    const jit = jitParam() || next.jitMiB || JIT_DEFAULT_MIB;
    if (
      running &&
      !(await ask.confirm(
        memoryWarning(
          t(power.canSoft ? 'machine:size-actions.settings.confirm.soft' : 'machine:size-actions.settings.confirm', {
            name: next.name,
          }),
          next.ramMiB,
          next.ncpus,
          jit,
        ),
        {
          title: t('machine:size-actions.settings.title'),
          ok: t('machine:size-actions.settings.ok'),
          danger: true,
        },
      ))
    )
      return;
    await this.#power.exclusively(async () => {
      if (!(await this.#power.stopCleanly())) return; // kept running: the settings unsaved
      s.record = await updateMachine(m.store, next);
      m.onRecord();
      m.takeSize();
      m.choose3d();
      this.#terminal.term.reset();
      if (running) this.#runner.start();
      else this.#messages.setState('off');
    });
  }

  /**
   * A machine's shape as it would run on this page now, over the browser's `disks`: its size and devices as the
   * address resolves them over its record (`resolveMachine`; for another machine than the page's, without the
   * address's size and switches: `addressFor`), its display by `effectiveDisplay` (the GPU worker's failure, `no3d`,
   * counts for the page's machine only: a switch chooses 3D again). For the page's machine, the shape its next
   * start's snapshots carry (`PageMachine.about`).
   */
  shapeNow(r: MachineRecord, disks: Map<string, DiskRecord>, overlays: readonly OverlayRecord[]) {
    const m = this.#m;
    const own = m.stored?.record.id === r.id;
    const resolved = resolveMachine(addressFor(query(), own), r, settings(), {
      gpu: true,
      ramMiB: r.ramMiB,
      cores: navigator.hardwareConcurrency || 4,
    });
    const { display, vulkan } = effectiveDisplay({
      gpu: true,
      simple: simpleDisplay,
      asked: resolved.three ? '3d' : '2d',
      webgl2: m.webgl2,
      refused: own && !!m.no3d,
      vulkan: resolved.vulkan,
    });
    const byId = new Map(overlays.map((o) => [o.id, o]));
    return currentShape(asRun(r, resolved), (id) => disks.get(id), {
      display,
      cpu: cpuFeatures(),
      vulkan,
      overlays: (id) => byId.get(id),
    });
  }
}
