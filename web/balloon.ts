// virtio-balloon (virtio 1.2 §5.5; Linux's virtio_balloon; docs/devices.md "balloon"): never inflated (num_pages 0), for
// what the guest says of its free memory, so that snapshots leave it out (a snapshot skips zero pages: docs/platform.md
// "The snapshot file"). Two features:
// - **Free page reporting** (REPORTING): the guest hands over free blocks (2 MiB and up, a few at a time, from ~2 s after
//   they were freed) and keeps them aside until the request completes, so the device may change them: each page of
//   them that isn't zero already is zeroed. One that is is only read: writing zeros to memory the guest never touched
//   would make the browser commit it (a wasm memory can't give pages back:
//   https://github.com/gbl08ma/waarm64/issues/314).
// - **Free page hinting** (FREE_PAGE_HINT), right before a snapshot or a suspend (`hint`): the device writes a new
//   command id into its config space; the guest's driver allocates every free 4 MiB block it can get, sends their
//   addresses after the id, and ends with STOP. It holds them until the device's DONE (`release`, after the save; a
//   restored machine's backend says DONE at its start), or until its shrinker gives some back under memory pressure.
//   The device never writes them: a block the shrinker gave back may be the guest's again by the time a request is
//   seen. They are zero because the guest's allocator zeroes what it allocates (`init_on_alloc`, Debian's and Arch's
//   default; the core's DC ZVA doesn't store over a zero block, so free memory the guest never touched stays
//   uncommitted). A guest without it hands over blocks with their old bytes, and gains nothing.
// The queues are compacted (virtio-mmio's Linux numbers only the queues it uses): inflateq 0, deflateq 1, then
// free_page_vq and reporting_vq where their features were taken.
import type { Backend, Ctx, Request } from './virtio.ts';
import { bytes } from './ram.ts';

/** The device ID (`VIRTIO_ID_BALLOON`). */
export const BALLOON_ID = 5;
/** VIRTIO_BALLOON_F_FREE_PAGE_HINT, VIRTIO_BALLOON_F_REPORTING. */
export const F_FREE_PAGE_HINT = 1n << 3n;
export const F_REPORTING = 1n << 5n;
/** num_pages, actual, free_page_hint_cmd_id (no poison_val: PAGE_POISON isn't offered, see `balloonEntry`). */
export const BALLOON_CONFIG = 12;
const CMD_ID = 8;
/** The command ids the device writes that aren't a hint's: STOP (no hint asked), DONE (the hinted blocks given back). */
export const CMD_STOP = 0;
export const CMD_DONE = 1;
/** A hint's first id (ids below are STOP and DONE). */
const FIRST_ID = 2;
const PAGE = 4096;

/**
 * The transport's entry: id, features, queues, queue size, config length. Not PAGE_POISON: without it Linux turns
 * reporting off only in a guest that poisons or zeroes what it frees (`init_on_free`), whose free pages are what they
 * are already; hinting is unaffected (the hinted blocks are allocated, and freed through the allocator after DONE).
 * Reporting needs a queue of at least 32 (PAGE_REPORTING_CAPACITY).
 */
export const balloonEntry = () => ({
  entry: [BigInt(BALLOON_ID), F_FREE_PAGE_HINT | F_REPORTING, 4n, 128n, BigInt(BALLOON_CONFIG)],
  config: new Uint8Array(BALLOON_CONFIG),
});

/** Zeroes each 4 KiB page of `b` (page-aligned, a whole number of pages) that isn't zero; the pages written. */
export function zeroPages(b: Uint8Array): number {
  const words = new Int32Array(b.buffer, b.byteOffset, b.length >>> 2);
  let written = 0;
  for (let p = 0; p < words.length; p += PAGE / 4) {
    const end = Math.min(p + PAGE / 4, words.length);
    for (let w = p; w < end; w++) {
      if (words[w] !== 0) {
        words.fill(0, p, end);
        written++;
        break;
      }
    }
  }
  return written;
}

/** What a hint did: the blocks the guest handed over (4 MiB each), and whether its STOP came. */
export type Hinted = { blocks: number; bytes: number; stopped: boolean };

/** The balloon's backend, with `hint` and `release` for the snapshots (web/devices.ts `Devices.hint`). */
export type Balloon = Backend & {
  hint(ms: number): Promise<Hinted | undefined>;
  release(): void;
  /** What reporting zeroed and saw (pages written, bytes reported), for the tests and tools. */
  reported: { pages: number; bytes: number };
};

export function balloon(ctx: Ctx): Balloon {
  const u32 = () => new DataView(ctx.config().buffer, ctx.config().byteOffset, BALLOON_CONFIG);
  let nextId = FIRST_ID;
  /** The hint asked (its id), what came of it, and its waiter. */
  let active: { id: number; started: boolean; got: Hinted; done: (h: Hinted) => void } | undefined;
  const reported = { pages: 0, bytes: 0 };
  /** The queue a request is on, by role: the hint's and reporting's indices depend on the features taken. */
  const role = (q: number) => {
    if (q < 2) return 'inflate';
    const hint = (ctx.features() & F_FREE_PAGE_HINT) !== 0n;
    if (hint && q === 2) return 'hint';
    return (ctx.features() & F_REPORTING) !== 0n && q === (hint ? 3 : 2) ? 'report' : 'other';
  };
  const setCmd = (id: number) =>
    ctx.changeConfig((c) => new DataView(c.buffer, c.byteOffset, BALLOON_CONFIG).setUint32(CMD_ID, id, true));
  const finish = () => {
    const a = active;
    if (!a) return;
    a.got.stopped = true;
    a.done(a.got);
  };
  return {
    reported,
    request(r: Request) {
      const ram = ctx.ram();
      switch (role(r.queue)) {
        case 'report':
          for (const s of r.write) {
            reported.pages += zeroPages(bytes(ram, s));
            reported.bytes += s.len;
          }
          return 0;
        case 'hint': {
          // A command id (the driver's start, or STOP: 4 bytes the device reads), or a block it hands over (written by no one).
          const id =
            r.read.length && r.read[0].len >= 4
              ? new DataView(bytes(ram, r.read[0]).slice(0, 4).buffer).getUint32(0, true)
              : undefined;
          if (id !== undefined && active) {
            if (id === active.id) active.started = true;
            else if (id === CMD_STOP && active.started) finish();
          } else if (active?.started) {
            for (const s of r.write) {
              active.got.blocks++;
              active.got.bytes += s.len;
            }
          }
          return 0;
        }
        default:
          return 0; // inflate/deflate: never asked for (num_pages 0)
      }
    },
    reset() {
      active?.done(active.got); // a driver gone: no STOP comes
      active = undefined;
      u32().setUint32(CMD_ID, CMD_STOP, true); // a new driver starts with no hint asked
    },
    async hint(ms) {
      // Only a driver that took the feature hears the command (FEATURES_OK, DRIVER_OK); one at a time.
      if ((ctx.features() & F_FREE_PAGE_HINT) === 0n || active) return undefined;
      const id = nextId;
      nextId = nextId >= 0xffff_fff0 ? FIRST_ID : nextId + 1;
      const got: Hinted = { blocks: 0, bytes: 0, stopped: false };
      const result = new Promise<Hinted>((resolve) => {
        active = { id, started: false, got, done: resolve };
      });
      setCmd(id);
      const timer = setTimeout(() => active?.done(got), ms);
      try {
        return await result;
      } finally {
        clearTimeout(timer);
        active = undefined;
      }
    },
    release() {
      if (u32().getUint32(CMD_ID, true) >= FIRST_ID) setCmd(CMD_DONE);
    },
    // The command id in the config space is the core's (saved with it): a restored guest that holds a hint's blocks is
    // told DONE when its backend starts (`restore`), as the saved machine's was after its save.
    save: () => ({ nextId }),
    restore(state) {
      const s = state as { nextId?: unknown } | null;
      if (typeof s?.nextId === 'number' && s.nextId >= FIRST_ID) nextId = s.nextId;
      if (u32().getUint32(CMD_ID, true) >= FIRST_ID) setCmd(CMD_DONE);
    },
  };
}
