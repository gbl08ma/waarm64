// The machine on this page as the toolbar and the Home page show it: which it is, what it has, and a transient
// machine's size (the toolbar's Machine menu), following web/app/run/page-machine.svelte.ts's `PageMachine`.
import type { FromWorker } from '../protocol.ts';
import type { Replies } from '../run/replies.ts';
import type { Attachment } from '../shape.ts';

/** How to ask the run's worker about its disks (`inspect`): its worker, the page's replies by id, a stored machine's attachments. */
export type RunInspect = { worker: Worker; replies: Replies<FromWorker>; attachments?: readonly Attachment[] };
/** A transient machine's size as the Machine menu shows it: what it runs with and what it offers. */
export type MachineSize = {
  ncpus: number;
  ramMiB: number;
  /** The RAM's split, MiB, memory 0 first (docs/spill-memories.md), if set. */
  split: number[] | undefined;
  gpu: '3d' | '2d';
  /** It has Vulkan (Venus's window and arena move its split). */
  vulkan: boolean;
  /** Why the graphics can't be chosen (no WebGL2, the address says), if they can't. */
  gpuLock: string;
};

/** Where the machine's facts come from (web/app/run/page-machine.svelte.ts's `PageMachine`), read as it changes. */
export type CurrentSource = {
  id(): string | undefined;
  title(): string;
  transient(): { label: string; disk: string } | undefined;
  hasOverlay(): boolean;
  canSuspend(): boolean;
  size(): MachineSize;
};

const NO_SIZE: MachineSize = {
  ncpus: 1,
  ramMiB: 1024,
  split: undefined,
  gpu: '3d',
  vulkan: false,
  gpuLock: '',
};

class Current {
  #source = $state.raw<CurrentSource>();
  // The facts that follow the page's machine (`follow`). Written only by tools/screens.ts, which fakes them.
  /** The stored machine on this page (its id), or undefined for a transient one (a test's `?machine=`). */
  id = $derived(this.#source?.id());
  /** What the toolbar calls it. */
  title = $derived(this.#source?.title() ?? '');
  /** A transient machine with a disk of its own: shown on the Home page as "this page's machine". */
  transient = $derived(this.#source?.transient());
  /** A machine is on the page (a stored one, or a transient one with its disk), not a page waiting for a disk. */
  loaded = $derived(this.id !== undefined || this.transient !== undefined);
  /** Its boot disk keeps its changes in an overlay in this browser: the disk's actions. */
  hasOverlay = $derived(this.#source?.hasOverlay() ?? false);
  /** It has a place in this browser for a suspended copy (web/app/run/page-disks.ts `homeOf`): Suspend. */
  canSuspend = $derived(this.#source?.canSuspend() ?? false);
  /** A transient machine's size, chosen in the Machine menu (a stored machine's is in its Settings). */
  size = $derived(this.#source?.size() ?? NO_SIZE);
  /** It boots through UEFI and can take a disk file (Open disk…, a dropped file). */
  firmware = $state(false);
  /** It has a virtio-gpu (the Screen menu, the Graphics choice). */
  hasGpu = $state(false);
  /** It has a network card (the Network menu). */
  hasNetwork = $state(false);
  /** It has a relative mouse (the lock's `raw` mode). */
  hasMouse = $state(false);
  /** Its guest's agent trims the guest's filesystems (the Home page's Free unused disk space: web/app/areas/trim-actions.ts). */
  canTrim = $state(false);
  /** Its last run's worker, for the disk surface window's live map (web/app/areas/surface.svelte.ts; the run writes it). */
  inspect = $state.raw<RunInspect>();
  /** The graphics it runs with (`data-graphics` on the body, for tests); undefined without a virtio-gpu. */
  graphics = $state<'3d' | '2d'>();

  /** Follows the page's machine. */
  follow(source: CurrentSource) {
    this.#source = source;
  }
}
export const current = new Current();
