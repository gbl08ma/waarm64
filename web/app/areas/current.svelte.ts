// The machine on this page as the toolbar and the Machines page show it: which it is, what it has, and a transient
// machine's size (the toolbar's Machine menu), following web/app/run/page-machine.svelte.ts's `PageMachine`.
/** A transient machine's size as the Machine menu shows it: what it runs with and what it offers. */
export type MachineSize = {
  ncpus: number;
  ramMiB: number;
  /** The RAM's split, MiB, memory 0 first (docs/spill-memories.md), if set. */
  split: number[] | undefined;
  gpu: '3d' | '2d';
  /** It has Vulkan (Venus's window and arena move its split). */
  vulkan: boolean;
  cpuChoices: number[];
  ramChoices: number[];
  /** Why the graphics can't be chosen (no WebGL2, the address says), if they can't. */
  gpuLock: string;
};

/** Where the machine's facts come from (web/app/run/page-machine.svelte.ts's `PageMachine`), read as it changes. */
export type CurrentSource = {
  id(): string | undefined;
  title(): string;
  transient(): { label: string; disk: string } | undefined;
  hasOverlay(): boolean;
  size(): MachineSize;
};

const NO_SIZE: MachineSize = {
  ncpus: 1,
  ramMiB: 1024,
  split: undefined,
  gpu: '3d',
  vulkan: false,
  cpuChoices: [],
  ramChoices: [],
  gpuLock: '',
};

class Current {
  #source = $state.raw<CurrentSource>();
  // The facts that follow the page's machine (`follow`). Written only by tools/screens.ts, which fakes them.
  /** The stored machine on this page (its id), or undefined for a transient one (a test's `?machine=`). */
  id = $derived(this.#source?.id());
  /** What the toolbar calls it. */
  title = $derived(this.#source?.title() ?? '');
  /** A transient machine with a disk of its own: shown on the Machines page as "this page's machine". */
  transient = $derived(this.#source?.transient());
  /** Its boot disk keeps its changes in this browser: Suspend, the disk's actions. */
  hasOverlay = $derived(this.#source?.hasOverlay() ?? false);
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
  /** The graphics it runs with (`data-graphics` on the body, for tests); undefined without a virtio-gpu. */
  graphics = $state<'3d' | '2d'>();

  /** Follows the page's machine. */
  follow(source: CurrentSource) {
    this.#source = source;
  }
}
export const current = new Current();
