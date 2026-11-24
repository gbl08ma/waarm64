// The surface windows' asks (web/app/surface-poll.svelte.ts, a runes module Node's tests don't compile) over made-up
// sources whose answers the test gives: what tests/surface-poll.test.ts drives. `window.__poll` holds the asks waiting
// for an answer and what the poll took.
import type { InspectAnswer } from '../../web/surface.ts';
import { SurfacePoll } from '../../web/app/surface-poll.svelte.ts';
import type { SurfaceSource } from '../../web/app/surface-source.ts';

/** An ask the source got: of the source `key`, at `cells`, answered by `answer`. */
type Ask = { key: string; cells: number; answer: (a: InspectAnswer) => void };
/** A made-up live surface: `size` bytes in cells of `cellBytes`, these cells read and these written. */
type Made = { size: number; cellBytes: number; read?: number[]; write?: number[] };

export type PollHooks = {
  asks: Ask[];
  /** Uses source `key` (a live one, asked only when the test says: its delay is long). */
  use(key: string): void;
  room(cells: number): void;
  refresh(): void;
  /** Answers ask `i` with surface `m` (its activity as made). */
  answer(i: number, m: Made): void;
  /** What the poll holds. */
  state(): { answers: number; stale: boolean; cellBytes?: number; activity?: number[] };
};
declare global {
  interface Window { __poll: PollHooks }
}

const poll = new SurfacePoll();
const asks: Ask[] = [];

function source(key: string): SurfaceSource {
  const none = () => Promise.resolve<InspectAnswer>({ kind: 'none' });
  return {
    live: true,
    surface: (cells) => new Promise((answer) => asks.push({ key, cells, answer })),
    range: none,
    delay: () => 3_600_000,
    close: () => undefined,
  };
}

window.__poll = {
  asks,
  use: (key) => poll.use(key, () => source(key)),
  room: (cells) => poll.room(cells),
  refresh: () => poll.refresh(),
  answer(i, m) {
    const cells = Math.ceil(m.size / m.cellBytes);
    const activity = m.read || m.write ? new Uint8Array(cells) : undefined;
    for (const c of m.read ?? []) activity![c] |= 1;
    for (const c of m.write ?? []) activity![c] |= 2;
    const layer = { id: 'disk', size: m.size, known: 'counted' as const, held: new Uint32Array(cells), zero: new Uint32Array(cells) };
    asks[i].answer({ kind: 'disk-surface', surface: { size: m.size, cellBytes: m.cellBytes, unitBytes: 4096, layers: [layer], activity } });
  },
  state: () => ({
    answers: poll.answers,
    stale: poll.stale,
    cellBytes: poll.surface?.cellBytes,
    activity: poll.surface?.activity && [...poll.surface.activity],
  }),
};
