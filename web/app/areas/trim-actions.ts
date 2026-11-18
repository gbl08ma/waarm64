// The disk space the guest's filesystems no longer use, handed back (docs/devices.md "Disk space handed back"): the
// guest's agent trims them (TRIM, web/app/agent-link.ts `trim`: a `sync`, then FITRIM on each filesystem on a disk), so
// that their disks discard what was freed, and the overlays are then compacted in full (the device worker's `compact`:
// a change compacts only once half an overlay is free). Asked by the Home page's storage bar (`asked`, which says
// how the disks' changes shrank), when a disk's write found the browser's storage full (`full`, once per notice), and
// before a disk's export stops the running machine (`beforeExport`: the file gets only what the guest still uses). A
// guest without the agent, or one whose agent can't (no `CAP.TRIM`), is left as it is. The user's choice, 2026-11-13.
import { CAP, TRIMMED } from '../../agent-frame.ts';
import { msg, type Msg } from '../../msg.ts';
import type { AgentLink } from '../agent-link.ts';
import type { FromWorker, ToWorker } from '../protocol.ts';
import type { Replies } from '../run/replies.ts';

/** How long the guest's trim may take (every filesystem's free space, through the emulated disk). */
export const TRIM_WAIT_MS = 120_000;
/** How long the overlays' compaction may take (it copies the blocks above the free slots). */
export const COMPACT_WAIT_MS = 120_000;

/** The disks' overlays compacted by the run's worker (`compact`), for `TrimActions`. */
export const compactor =
  (machine: { readonly run?: { worker: Worker } }, replies: Replies<FromWorker>): Compact =>
  (ms, measure) =>
    askCompact(machine.run?.worker, replies, ms, measure);

/** The disks' overlays compacted by the machine's worker (`compact`): their files' bytes before and after (none: no machine). */
export async function askCompact(
  worker: Worker | undefined,
  replies: Replies<FromWorker>,
  ms: number,
  measure = false,
) {
  if (!worker) return undefined;
  const post = (id: number) => worker.postMessage({ type: 'compact', id, measure } satisfies ToWorker);
  const m = await replies.ask(post, { ms, fallback: { type: 'compacted', id: 0 } });
  return m.type === 'compacted' && m.before !== undefined && m.after !== undefined
    ? { before: m.before, after: m.after }
    : undefined;
}

type Agent = { readonly link: AgentLink | undefined };
/** Where the page shows that the run's agent trims (web/app/areas/current.svelte.ts `canTrim`: the storage bar's button). */
type Shown = { canTrim: boolean };
type Notify = { notify(m: Msg): void };
/** The overlays compacted (`measure`: only their sizes, as `before`). */
type Compact = (ms: number, measure?: boolean) => Promise<{ before: number; after: number } | undefined>;

/** What a trim did: TRIMMED's status (none: no agent, or no answer), and the overlays' bytes before and after. */
export type Trimmed = { status?: number; before?: number; after?: number };

/** The notice for the storage bar's trim. */
function said(r: Trimmed): Msg {
  const sizes = { before: r.before ?? 0, after: r.after ?? 0 };
  if (r.status === TRIMMED.TRIMMED) return msg('machine:trim-actions.trimmed', sizes);
  if (r.status === TRIMMED.FAILED) return msg('machine:trim-actions.failed', sizes);
  if (r.status === TRIMMED.NONE) return msg('machine:trim-actions.none');
  return msg('machine:trim-actions.noAnswer');
}

export class TrimActions {
  readonly #agent: Agent;
  readonly #messages: Notify;
  readonly #compact: Compact;
  readonly #shown: Shown;
  /** The trim running, which another ask joins. */
  #running: Promise<Trimmed> | undefined;

  /** The run's agent (web/app/areas/agent-actions.ts), the message bar, the overlays' compaction (`compactor`), where `canTrim` is shown. */
  constructor(agent: Agent, messages: Notify, compact: Compact, shown: Shown) {
    [this.#agent, this.#messages, this.#compact, this.#shown] = [agent, messages, compact, shown];
  }

  /** A run's link (none: no agent): `canTrim` follows its agent's HELLOs. */
  follow(link: AgentLink | undefined): AgentLink | undefined {
    this.#shown.canTrim = false;
    link?.onHello.push((h) => {
      this.#shown.canTrim = (h.caps & CAP.TRIM) !== 0;
    });
    link?.onClose.push(() => (this.#shown.canTrim = false));
    return link;
  }

  /** The run ended: its trim (cut short by its link's close) isn't the next run's to join. */
  end() {
    this.#shown.canTrim = false;
    this.#running = undefined;
  }

  /** The guest's filesystems trimmed, then the overlays compacted (where anything was trimmed). */
  trim(): Promise<Trimmed> {
    return (this.#running ??= this.#trim().finally(() => (this.#running = undefined)));
  }

  async #trim(): Promise<Trimmed> {
    const link = this.#agent.link;
    // The overlays' size before the trim: its discards may compact them already (past half free).
    const was = link?.agent && link.agent.caps & CAP.TRIM ? await this.#compact(COMPACT_WAIT_MS, true) : undefined;
    const status = await link?.trim(TRIM_WAIT_MS);
    // The run's own overlays only (one that ended meanwhile has a new run's worker in its place).
    const ours = this.#agent.link === link;
    const now =
      ours && (status === TRIMMED.TRIMMED || status === TRIMMED.FAILED)
        ? await this.#compact(COMPACT_WAIT_MS)
        : undefined;
    const r: Trimmed = now ? { status, before: was?.before ?? now.before, after: now.after } : { status };
    if (typeof window !== 'undefined') window.__trimmed = r; // the tests' hook
    return r;
  }

  /** The storage bar's Free unused disk space: the trim, and what it did said. */
  async asked() {
    this.#messages.notify(said(await this.trim()));
  }

  /** A disk's write found the browser's storage full (said at most once a minute): what the guest freed goes back. */
  async full() {
    if (!this.#shown.canTrim) return;
    const r = await this.trim();
    if (r.before !== undefined && r.after !== undefined && r.after < r.before)
      this.#messages.notify(msg('machine:trim-actions.full', { before: r.before, after: r.after }));
  }

  /** Before a disk's export stops the running machine: its trim, if its agent can (whatever came of it, the export goes on). */
  async beforeExport() {
    if (this.#shown.canTrim) await this.trim();
  }
}
