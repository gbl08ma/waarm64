// The machine the Machines page edits (MachinePane.svelte and its tabs): the record as stored, the draft the tabs
// edit, whether it changed, and its Save (docs/machines.md §7). The page reads the records and hands this machine's
// over (`follow`); the draft follows the record unless the user is editing it.
import { ask } from './ask.svelte.ts';
import { said, t, MsgError, type Msg } from '../i18n.ts';
import type { Actions } from './actions.svelte.ts';
import { updateMachine } from './machines.ts';
import { adaptersOf, type MachineRecord } from './shape.ts';
import { sharesPathError } from './shares-mount.ts';
import type { Store } from './store.ts';
import { current } from './areas/current.svelte.ts';
import { page } from './page.ts';

/** The record's switches: a device the guest sees, on or off. */
/** The switches in the shape (not the guest agent's and the clipboard's: they ride the vsock every firmware machine has). */
export type Switch = 'usb' | 'vulkan' | 'mouse' | 'touch' | 'clock' | 'shares';
const SWITCHES: Switch[] = ['usb', 'vulkan', 'mouse', 'touch', 'clock', 'shares'];

const macs = (m: MachineRecord) =>
  adaptersOf(m)
    .map((x) => x.mac)
    .join();
/** The guest's shape differs: a snapshot of one doesn't restore on the other. */
const shapeChanged = (a: MachineRecord, b: MachineRecord) =>
  a.ramMiB !== b.ramMiB ||
  (a.ramSplit ?? []).join() !== (b.ramSplit ?? []).join() ||
  a.ncpus !== b.ncpus ||
  a.display !== b.display ||
  macs(a) !== macs(b) ||
  SWITCHES.some((k) => !!a[k] !== !!b[k]);
/** What takes a restart: the shape, and the JIT's budget (the guest doesn't see it: no snapshot is orphaned). */
const restartChanged = (a: MachineRecord, b: MachineRecord) =>
  shapeChanged(a, b) || (a.jitMiB ?? 0) !== (b.jitMiB ?? 0);

/** A machine as a plain object (a draft is reactive state, which IndexedDB can't clone). */
const plain = (m: MachineRecord) => structuredClone<MachineRecord>($state.snapshot(m));

/** A `MachineEdit` with a machine to edit: what its pane and its tabs take. */
export type Editing = MachineEdit & { draft: MachineRecord };

export class MachineEdit {
  /** The machine as stored (the page's last read). */
  record = $state.raw<MachineRecord>();
  /** What the tabs edit. */
  draft = $state<MachineRecord>();
  /** The draft differs from the record (Save and Revert show). */
  dirty = $state(false);
  /** The RAM's split as typed doesn't hold: what's wrong (Save waits). */
  splitProblem = $state<Msg>();
  /** The machine has kept snapshots: only then do the controls warn that a change of shape orphans them. */
  hasSnapshots = $state(false);
  /** The machine runs (on this page or in another tab). */
  running = $state(false);
  /** Save restarts the machine: it runs on this page and the change takes a restart. */
  readonly restartsToSave = $derived(
    !!this.draft &&
      !!this.record &&
      this.draft.id === current.id &&
      this.running &&
      restartChanged(this.record, this.draft),
  );
  readonly #store: Store;
  readonly #actions: Actions;

  constructor(store: Store, actions: Actions) {
    this.#store = store;
    this.#actions = actions;
  }

  /** A machine is being edited (its pane shows). */
  editing(): this is Editing {
    return this.draft !== undefined;
  }

  /** Takes the page's read of the machine (undefined: none is chosen). */
  follow(record: MachineRecord | undefined, hasSnapshots: boolean, running: boolean) {
    this.record = record;
    this.hasSnapshots = hasSnapshots;
    this.running = running;
    if (!record || this.draft?.id !== record.id || !this.dirty) {
      this.draft = record ? plain(record) : undefined;
      this.splitProblem = undefined;
    }
  }

  /** The draft has changed (a field's input). */
  touch = () => {
    this.dirty = true;
  };

  /** Replaces the draft with `next` (an adapter added, moved, removed). */
  set(next: MachineRecord) {
    this.draft = next;
    this.dirty = true;
  }

  /** Drops the draft's changes. */
  revert = () => {
    this.dirty = false;
    this.follow(this.record, this.hasSnapshots, this.running);
  };

  /** The draft's switch `k` isn't the record's. */
  flipped(k: Switch) {
    return !!this.draft?.[k] !== !!this.record?.[k];
  }

  /** The draft's switch `k` isn't the record's, and that orphans the machine's snapshots (a note warns). */
  orphans(k: Switch) {
    return this.hasSnapshots && this.flipped(k);
  }

  /** Saves the draft: asks first if that orphans snapshots; the machine on this page, running, restarts with it. */
  save = async () => {
    if (!this.draft || !this.record) return;
    const m = plain(this.draft);
    const was = this.record;
    if (!m.jitMiB) delete m.jitMiB;
    if (!m.keyboard) delete m.keyboard;
    if (m.netConfig !== false) delete m.netConfig;
    if (m.agent !== false) delete m.agent;
    if (!m.shares) delete m.shares;
    if (!m.clipboard) delete m.clipboard;
    if (m.sharesMount !== false) delete m.sharesMount;
    if (!m.sharesPath) delete m.sharesPath;
    const pathError = m.sharesPath ? sharesPathError(m.sharesPath) : undefined;
    if (pathError) {
      this.#actions.fail(said(pathError).headline);
      return;
    }
    await this.#actions.run(t('machines:machine-edit.saving'), async () => {
      if (
        shapeChanged(was, m) &&
        (await this.#store.snapshotsOf(m.id)).length &&
        !(await ask.confirm(t('machines:machine-edit.orphans.confirm'), { ok: t('machines:SaveRow.save') }))
      )
        return;
      // The machine on this page, running: it restarts with them (the page asks).
      if (restartChanged(was, m) && m.id === current.id && this.running) return page.saveSettings(m);
      if (restartChanged(was, m) && this.running) throw new MsgError('machines:MachinesPage.otherTab');
      await updateMachine(this.#store, m);
      if (m.id === current.id) await page.netFollow();
      if (m.id === current.id && m.keyboard !== was.keyboard) await page.keyboardFollow();
    });
    this.dirty = false;
  };
}
