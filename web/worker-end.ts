// How a worker's own workers end (docs/host-code.md §2.1). A module of its own, naming no worker's file: those that
// import it run in workers that web/warm-workers.ts names, and a worker whose bundle names its own file breaks the
// page's build (Vite emitted no vCPU, compile or device worker).
/**
 * Ends `w`, a worker this thread started. `ending`: the caller says this thread ends next (its owner's `terminate`
 * follows: the machine worker's stop, a disk job's end); in a browser worker `w` is then left to that end, which ends
 * it with this one. Otherwise (the thread goes on: a failed resume that boots again, the snapshot round trips of the
 * tests; or the page and Node, where nothing ends it for us) it is terminated here. Chromium (158 measured) strands a
 * worker that terminates a worker of its own just before it is terminated itself: neither thread exits, and their
 * memories (a machine's guest RAM) stay until the page goes (bench/boot/REPORT.md "Workers stranded at a machine's
 * end"). A terminate in the middle of the thread's life strands nothing.
 */
export function endWithOwner(w: { terminate(): void }, ending: boolean) {
  if (ending && typeof WorkerGlobalScope !== 'undefined') return;
  w.terminate();
}

/** How a close ends what it started (`endWithOwner`): `ending`, this thread ends right after it. */
export type CloseOptions = { ending?: boolean };
