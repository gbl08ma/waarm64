# The disk surface visualizer (SURFACE): design

The user's brief (2026-11-15): a built-in view of a disk's "surface", in the manner of a defragmenter's map: a grid of
squares, each a section of the disk, coloured by what it holds, with one of the disk's overlays literally laid over
it. Reached from a small [visualize] link at the end of a disk's line, in the Machines page's Disks pane and in a
machine's Disks tab. Live for the disks of the machine that runs on this page, in a floating window like the on-screen
keyboard's, so the user sees the guest's reads and writes. A novelty: it must cost the disk's hot path **nothing**
while its window is closed. Its grid and its route to the workers are made to be reused (a RAM view may follow).

This page is the design the loops implement. When the track ends, what exists moves to docs/frontend.md,
docs/devices.md and docs/machines.md, and this page keeps only what was decided and why.

## 1. What is shown

- **A cell** is 4 MiB of the disk (one leaf of the block map, web/overlay.ts `LEAF` blocks: a *range*) times a power
  of two, the smallest for which the whole disk fits in the cells the window has room for (so a larger window shows a
  finer map; the window says "1 square = 16 MiB"). Cells are counted in 4 KiB blocks.
- **Layers.** The *disk* (the base) and, when one is chosen, one *overlay* of it. A cell draws the disk as its **rim**
  (the whole square) and the overlay as its **core** (a smaller square inset in it), so the overlay visibly sits on
  the disk and the disk shows around it. The picker lists "the disk alone" and each of the disk's overlays; opened from
  a machine's Disks tab it starts on that attachment's overlay.
- **Sizes differ** (docs/machines.md §4.5): the grid spans the larger of the disk's size and the overlay's own. Cells
  past the disk's end have no rim (an outline only); the disk's end is marked.
- **A layer's states** per cell, from counts of its blocks:
  - rim (disk): nothing held (reads as zeros); data held, in four steps of how full (any block at all shows as the
    first step); *not examined* for an image whose contents can't be known cheaply (a raw file, a URL): one flat look;
    for a ramdisk, its chunks in memory.
  - core (overlay): no changes (no core drawn); changed blocks in four steps; only zeroed or discarded blocks (a
    hollow core: the overlay hides the disk's data there).
- **Activity** (live only): a cell the guest read flashes one colour, one it wrote another, fading in well under a
  second. With `prefers-reduced-motion` the flash is a mark that goes away at the next poll.
- **Hover** shows the cell's numbers from what the view already has (cheap): its offsets, how many blocks the disk
  holds, how many the overlay changed and zeroed. **A click pins** the cell and asks for a *range detail* (not cheap,
  so only on a click): the 4 KiB blocks of one 4 MiB range as a 32×32 map (unwritten, the disk's, the overlay's,
  zeroed, past the end), the number of runs of consecutive slots its blocks take in the store's `data` file (how
  fragmented the store is there), and, behind a button, a content check: how many of the held blocks are all zeros
  (it reads up to 4 MiB). A cell of several ranges steps through them.

## 2. Where the numbers come from

| The disk | Not running here | Running on this page |
|---|---|---|
| stored | its `map` file, read by a job worker with read-only handles under the shared lock | the device worker's map in memory |
| an overlay (of any disk) | its `map` and `meta`, the same way; refused in words when another tab's machine holds its lock | the device worker's map in memory |
| stored, written in place | as a stored disk; in use elsewhere: refused in words | the device worker |
| blank | nothing held, by definition | the same |
| file, URL | *not examined* (loop 4: a qcow2's allocated clusters from its tables, where the image is open or can be opened without asking; a URL disk's blocks kept in this browser) | the same; loop 4 |
| ramdisk | nothing to show: it exists only while its machine runs (said in words) | its chunks |

- **No hot-path cost when closed.** The state is read from the maps the device worker has in memory anyway, at the
  moment the page asks. Activity is the one thing that needs a hook: the device worker **replaces the disk backend's
  `request` with a wrapper** when a query asks for activity and **puts the original back** when no query has asked for
  ~3 s (so a page that goes away leaves nothing behind). Nothing is added to `blk`'s request path itself, not even a
  test of a flag. The wrapper parses the request's 16-byte header (as the concurrent wrapper already does) and marks
  the ranges read and written in a byte per range, which the next answer carries and clears.
- **A poll, not a stream:** the window asks every 500 ms while it is open, the page visible and the machine running.
  An answer's cost is a walk of the leaves (1,024 entries each); the device worker times it and the window stretches
  its interval so that the walks stay under ~2% of the worker's time. The base under an overlay doesn't change while
  it is one: its summary is made once per resolution. If the measured walk of a large overlay is too slow, the
  wrapper's marks say which leaves changed since the last answer, and only those are counted again.
- **Offline** reads are whole and short: open, read the map (and `meta` for the size), close. A Refresh button reads
  again; the records' change (the store's `BroadcastChannel`) does too.

## 3. The pieces

**`web/surface.ts`** (no DOM, no OPFS: workers, the page and Node's tests import it):

```ts
/** A surface: something made of equal units (a disk's 4 KiB blocks, later RAM's pages), seen as `cells` cells. */
export type Surface = {
  /** Bytes spanned (the largest layer's), a cell's bytes (the last may be short) and a unit's. */
  size: number;
  cellBytes: number;
  unitBytes: number;
  layers: SurfaceLayer[];
  /** Live: per cell, bit 0 read, bit 1 written since the last answer. */
  activity?: Uint8Array;
  /** Live: the ms the answer took to make (the poll's pacing). */
  cost?: number;
};
export type SurfaceLayer = {
  /** 'disk' | 'overlay' | 'ram' … (the caller's). */
  id: string;
  /** The layer's own size: cells past it have no such layer. */
  size: number;
  /** 'counted': `held` and `zero` are block counts; 'opaque': contents not examined (held = the cell's units). */
  known: 'counted' | 'opaque';
  /** Per cell: units held with data; units held as zeros without data (an overlay's zeroed and discarded blocks). */
  held: Uint32Array;
  zero: Uint32Array;
};
/** One 4 MiB range, block by block. */
export type RangeDetail = {
  range: number;
  /** Per 4 KiB block: 0 nothing, 1 the disk's, 2 the overlay's, 3 zeroed by the overlay, 4 past the end. */
  blocks: Uint8Array;
  /** Runs of consecutive slots the layer's held blocks take in its `data` file, per layer id. */
  runs: Record<string, number>;
  /** With `content`: held blocks read, and how many were all zeros. */
  content?: { read: number; zeros: number };
};
export type InspectQuery =
  | { kind: 'disk-surface'; disk: number; cells: number; activity?: boolean }
  | { kind: 'disk-range'; disk: number; range: number; content?: boolean };
export type InspectAnswer =
  | { kind: 'disk-surface'; surface: Surface }
  | { kind: 'disk-range'; detail: RangeDetail }
  | { kind: 'none'; why?: Msg };
```

plus the pure functions over `MapLeaves` (`summarize`, `rangeDetail`, the cell size for a size and a number of
cells), which the device worker and the job worker both call. `disk` is the disk's place among the machine's disks
(slot order); the machine's worker maps it to the device.

**The route (generic: `inspect`).** Page → machine worker `{ type: 'inspect', id, query }`, answered
`{ type: 'inspected', id, answer }`; `Vm.inspect(query)`; owner → device worker `{ type: 'inspect', id, query }`,
answered with its id. The machine worker sends a query to whoever answers its `kind` (`disk-*`: the device worker; a
`ram-*` kind later: the machine worker itself or the core). Every in-thread variant of the devices in web/vm.ts gets
it too. No core change, no ABI change.

**Offline:** `web/app/surface-worker.ts`, a job worker as `disk-worker.ts` is, answering the same two questions from
paths (`{ stored?, overlay?, size, … }`) instead of a device.

**The page:**
- `web/app/ui/BlockGrid.svelte`: the reusable grid, a `<canvas>`. Props: the number of cells, per cell a rim look, a
  core look and a flash (bytes, indices into a small palette of looks whose colours are tokens), the pinned cell;
  events for hover and pick; it reports how many cells it has room for. It knows nothing of disks. Keyboard: the
  arrows move a cursor cell, Enter pins.
- `web/app/ui/FloatingWindow.svelte` (+ `floating-frame.svelte.ts`): a movable, resizable window over the page that
  never takes the focus from the screen, kept in the window, its place remembered under a settings key. The on-screen
  keyboard keeps its own frame (its sizes follow its layout); moving it onto this one is a backlog line.
- `web/app/SurfaceWindow.svelte` and small parts (the legend, the details): the disk's name, the overlay picker, the
  grid, "1 square = …", live or not (Refresh), the hover line, the pinned range.
- `web/app/surface-look.ts` (counts → looks), `web/app/surface-source.ts` (`SurfaceSource`: `surface(cells)`,
  `range(range, content)`, `live`; one over the machine's worker, one over the job worker; `sourceFor` picks by what
  runs on this page), `web/app/areas/surface.svelte.ts` (which disk's window is open: one at a time, mounted by
  `App.svelte`, so it stays while the user goes from the Machines page to the machine).
- The link: `Button variant="link"` after the line in `DiskInfo.svelte`'s users and `Disks.svelte`'s rows:
  "… · vda · visualize".
- Words in the catalog (`web/messages/en/`, a `surface` namespace or `disks`, as docs/i18n.md says); colours as new
  tokens in `theme/tokens.css` (a role each: `--surface-map-…`), both themes if there are two.

## 4. Loops

1. **The data** (web/surface.ts, the device worker's `inspect` with the activity wrapper, `Vm.inspect`, the machine
   worker's route, the job worker; Node tests: counts, sizes that differ, aggregation, the range's blocks and runs,
   the ramdisk, the wrapper's coming and going, a walk's time on a large map).
2. **The grid and the window** (`BlockGrid`, `FloatingWindow`, tokens; a test page or story the Chromium tests drive
   with made-up data), in parallel with loop 1: they share only §3's types.
3. **Together:** the source, the area, `SurfaceWindow`, the links, the words, the polls; Chromium tests without a guest
   (a stored disk and overlays of other sizes made in the store) and one with Debian (the overlay's cells appear and
   flash as the guest writes); docs.
4. **Images:** a qcow2's allocated clusters; a URL disk's kept blocks. Each only if it's cheap and needs no prompt;
   otherwise a backlog line.
5. An out-of-context review, its fixes, the CI layers, PLAN.md.

## 5. Validation

`scripts/ci.sh`, and `scripts/ci-debian.sh` and `scripts/ci-machines.sh` (the page, the Machines page, disks). A
cloud session runs what it can of them (docs/cloud.md); the full runs with every image are the dev VM's. The hot
path's claim is by construction (the wrapper is absent when the window is closed); `bench/io` in the dev VM can
confirm it, window closed against the commit before.
