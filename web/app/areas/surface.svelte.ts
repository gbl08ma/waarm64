// The disk surface visualizer's window (docs/frontend.md "A disk's surface"): which disk's map is open, one at a time,
// and the overlay it starts on; App.svelte mounts web/app/SurfaceWindow.svelte while one is, so it stays as the user
// goes between the Machines page and the machine. `runningHere` is the machine that runs on this page, for a live map
// (its run says how to reach it: web/app/run/runner.ts writes `current.inspect`).
import { current } from './current.svelte.ts';
import { isLive, power } from './power.svelte.ts';
import type { LiveHost, RunningMachine, SurfaceTarget } from '../surface-source.ts';

/** The stored machine on this page while it runs (a transient machine's disks have no records), and how to ask it. */
export const runningHere = (): (RunningMachine & LiveHost) | undefined => {
  const r = current.inspect;
  return r?.attachments && isLive(power.state) ? { ...r, attachments: r.attachments } : undefined;
};

/** An open window: its view at the start (`overlay`: the attachment's chosen one, from a machine's Disks tab). */
export type SurfaceOpen = SurfaceTarget & { from: 'disks' | 'machine' };

class SurfaceWindowArea {
  /** The window open, if one is (a new object for each opening: the window starts afresh). */
  open = $state.raw<SurfaceOpen>();
  /** Opens the map of `disk`, through `overlay` (none: the disk alone); another disk's window closes. */
  show(disk: string, overlay: string | undefined, from: SurfaceOpen['from']) {
    this.open = { disk, ...(overlay ? { overlay } : {}), from };
  }
  close() {
    this.open = undefined;
  }
}
export const surfaceWindow = new SurfaceWindowArea();
