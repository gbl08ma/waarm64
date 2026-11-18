// The memory signal (web/app/memory.ts, docs/frontend.md "Memory"): while the machine runs, a mark in localStorage with
// what it costs, renewed every 10 s and cleared at a clean stop; a mark left over means its tab went away with it
// running (most likely killed for memory), and the next start offers a smaller JIT cache or less RAM first. And the
// warnings for a size this device may not have the memory for.
import { msg, t, type Msg } from '../../i18n.ts';
import { ask } from '../ask.svelte.ts';
import type { Action } from '../areas/message-bar.svelte.ts';
import { hostMemoryGiB, RAM_CHOICES } from '../machine.ts';
import { updateMachine } from '../machines.ts';
import { ALIVE_EVERY_MS, clearAlive, lastCrash, markAlive } from '../memory.ts';
import type { Status } from '../protocol.ts';
import { remember } from '../settings.ts';
import type { Messages } from './messages.ts';
import { machineTitle } from './page-disks.ts';
import type { PageMachine } from './page-machine.svelte.ts';

type Crash = NonNullable<ReturnType<typeof lastCrash>>;

/** A question's words with the warning for a size this device may not have the memory for, a paragraph after them. */
export function memoryWarning(question: Msg, r: number, n: number, j: number): Msg {
  const need = hostMemoryGiB(r, n, j);
  const has = navigator.deviceMemory;
  if (has === undefined || has >= need) return question;
  const warning =
    has >= 8
      ? msg('machine:memory-signal.memoryWarning.max', { need: need.toFixed(1), has })
      : msg('machine:memory-signal.memoryWarning', { need: need.toFixed(1), has });
  return msg('machine:memory-signal.memoryWarning.after', { question, warning });
}

export class MemorySignal {
  readonly #machine: PageMachine;
  readonly #messages: Messages;
  readonly #restart: () => Promise<void>;
  #at = 0;

  constructor(machine: PageMachine, messages: Messages, restart: () => Promise<void>) {
    this.#machine = machine;
    this.#messages = messages;
    this.#restart = restart;
    addEventListener('pagehide', () => {
      if (machine.run) this.clear();
    });
  }

  #key() {
    const m = this.#machine;
    return m.stored ? m.stored.record.id : `transient-${m.name}`;
  }
  clear() {
    clearAlive(this.#key());
  }

  /** The mark renewed with a status (every `ALIVE_EVERY_MS`); returns the estimate (bytes, the worker's), for the status bar's Tab memory. */
  mark(st: Status) {
    const m = this.#machine;
    const now = Date.now();
    const est = st.estimateBytes;
    if (now - this.#at < ALIVE_EVERY_MS) return est;
    this.#at = now;
    markAlive(this.#key(), {
      name: machineTitle(m),
      ramMiB: m.ramMiB,
      ncpus: m.ncpus,
      jitMiB: Math.round(st.memory.jitBudget / 2 ** 20),
      gib: +(est / 2 ** 30).toFixed(2),
      peakGiB: +(st.peakBytes / 2 ** 30).toFixed(2),
      t: now,
    });
    return est;
  }

  /**
   * Starts again with a smaller JIT cache or less RAM (a stored machine's record keeps it, a transient one's settings).
   * The address's own size for it goes (`?ram=`, `?split=`, `?jitmb=`): it would win over the choice (config.ts
   * `resolveSize`) and start the machine at the size that killed it. The mark stays until the choice is made.
   */
  async #use(o: { jitMiB?: number; ramMiB?: number }) {
    const m = this.#machine;
    const s = m.stored;
    if (s) {
      const next = {
        ...s.record,
        ...(o.jitMiB ? { jitMiB: o.jitMiB } : {}),
        ...(o.ramMiB ? { ramMiB: o.ramMiB, ramSplit: undefined } : {}),
      };
      if (
        o.ramMiB &&
        (await m.store.snapshotsOf(next.id)).length &&
        !(await ask.confirm(t('machine:memory-signal.lessRam.confirm'), { ok: t('machine:memory-signal.lessRam.ok') }))
      ) {
        this.crashedBefore();
        return;
      }
      s.record = await updateMachine(m.store, next);
    } else remember(o);
    this.clear();
    const q = new URLSearchParams(location.search);
    const over = o.ramMiB ? ['ram', 'split'] : ['jitmb'];
    if (over.some((k) => q.has(k))) {
      for (const k of over) q.delete(k);
      history.replaceState(history.state, '', `?${q}`);
    }
    if (o.jitMiB) m.jitMiB = o.jitMiB;
    if (o.ramMiB) [m.ramMiB, m.ramSplit] = [o.ramMiB, undefined];
    await this.#restart();
  }

  #actions(a: Crash): Action[] {
    const jitNow = a.jitMiB || this.#machine.jitBudget();
    const ramLess = [...RAM_CHOICES].reverse().find((r) => r <= a.ramMiB / 2) ?? RAM_CHOICES[0];
    const jit = jitNow > 160 ? 160 : jitNow > 64 ? 64 : undefined;
    return [
      ...(jit
        ? [{ label: t('machine:memory-signal.crashed.jit', { mib: jit }), run: () => void this.#use({ jitMiB: jit }) }]
        : []),
      ...(ramLess < a.ramMiB
        ? [
            {
              label: t('machine:memory-signal.crashed.ram', { mib: ramLess }),
              run: () => void this.#use({ ramMiB: ramLess }),
            },
          ]
        : []),
      {
        label: t('machine:memory-signal.crashed.asIs'),
        run: () => {
          this.clear();
          void this.#restart();
        },
      },
    ];
  }

  /** A mark left by a tab that went away with this machine running: says so and offers what may fit (true: not started). */
  crashedBefore() {
    const a = lastCrash(this.#key());
    if (!a) return false;
    const words = { name: a.name, when: new Date(a.t), gib: a.gib, peak: a.peakGiB, ram: a.ramMiB, jit: a.jitMiB };
    this.#messages.setState('idle', msg('machine:memory-signal.crashed', words), this.#actions(a), 'warn');
    return true;
  }

  /** Chromium kills a renderer that runs out of memory without an error to catch (docs/architecture.md "Risks"): judged up front (true: it fits, or the device doesn't say). */
  fits() {
    const m = this.#machine;
    const need = hostMemoryGiB(m.ramMiB + m.ramdiskMiB(), m.ncpus, m.jitBudget());
    const has = navigator.deviceMemory;
    if (has === undefined || has >= need) return true;
    const fewer = Math.floor(
      (has - hostMemoryGiB(m.ramMiB, 0, m.jitBudget())) / (hostMemoryGiB(0, 1) - hostMemoryGiB(0, 0)) + 1e-9,
    );
    const advice =
      fewer > 0 && fewer < m.ncpus
        ? msg('machine:memory-signal.memory.advice.fewer', { fewer })
        : msg('machine:memory-signal.memory.advice');
    const words = { need: need.toFixed(1), ram: m.ramMiB, count: m.ncpus, has, advice };
    this.#messages.setState(
      'idle',
      has >= 8 ? msg('machine:memory-signal.memory.max', words) : msg('machine:memory-signal.memory', words),
      [{ label: t('machine:memory-signal.memory.start'), run: () => void this.#restart() }],
      'warn',
    );
    return false;
  }
}
