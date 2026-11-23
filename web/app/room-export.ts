// A room connection's export (docs/networking/adapters.md §2.1): its node key and, after a dot, its names: the names
// agent's owners' secret and titles kept under the connection's `identityKey` (web/names-export.ts `exportNames`), so a name
// travels with the key. A connection made from a pasted export takes the names as its own (`importNames`). And what a
// deleted room connection's names leave: its titles, and its registry records in its room (`sweepRoomRecords`).
import { parseRoomLink } from '../room.ts';
import type { Connection, ConnectionState, NewConnection, RoomConnection } from './connections.ts';

/** The page's names (web/names-store.ts, `waarm64-room`'s `owner` and `titles`), loaded when an export needs them. */
const pageNames = {
  export: (k: string) =>
    Promise.all([import('../names-export.ts'), import('../names-store.ts')]).then(([e, s]) =>
      e.exportNames(s.idbNamesStore(), k),
    ),
  keep: (k: string, b: string) =>
    Promise.all([import('../names-export.ts'), import('../names-store.ts')]).then(([e, s]) =>
      e.importNames(s.idbNamesStore(), k, b),
    ),
  // Without titles no worker is started: the agent (and its module) only when there is something to judge.
  held: (k: string) =>
    import('../names-store.ts').then(async (s) =>
      (await s.idbNamesStore().titles(k)).length ? (await import('../names.ts')).namesAgent().held(k) : [],
    ),
  forget: (k: string) => import('../names-store.ts').then((s) => s.idbNamesStore().forget(k)),
};

/** Room connection `c`'s export: its key, then its names after a dot; '' before its first start made a key. */
export async function roomExportOf(state: ConnectionState, c: Connection): Promise<string> {
  if (!c.room) return '';
  const key = c.room.identity?.key ?? (await state.readRoom(c.room.identityKey))?.key;
  if (!key) return '';
  const names = await (state.exportNames ?? pageNames.export)(c.room.identityKey);
  return names ? `${key}.${names}` : key;
}

/** The names a pasted export carried (`o.room.names`), kept as new connection `c`'s (its key's entry's). */
export async function keepExported(state: ConnectionState, c: Connection, o: NewConnection) {
  const names = o.room?.names;
  if (names && c.room) await (state.keepNames ?? pageNames.keep)(c.room.identityKey, names);
}

/** The names this browser holds under connection key `identityKey` now (not let go, lost or lapsed). */
export const heldRoomNames = (identityKey: string): Promise<string[]> => pageNames.held(identityKey);

/** Forgets the owners' secret and titles kept under `identityKey` (its connection deleted). */
export function forgetRoomNames(state: ConnectionState, identityKey: string): Promise<void> {
  return (state.forgetNames ?? pageNames.forget)(identityKey);
}

/** A room connection's room ID, from its link (undefined if it isn't one). */
function roomIdOf(link: string): string | undefined {
  const p = parseRoomLink(link);
  return 'room' in p ? p.room.id : undefined;
}

/**
 * Deleted room connection `id`'s (settings `r`) registry records in its room, forgotten unless another connection in
 * `all` in that room has its `identityKey`, or another tab's uses the entry (`elsewhere`). An ephemeral connection's own
 * key (`identity`) keeps none (web/room-worker.ts).
 */
export async function sweepRoomRecords(
  state: ConnectionState,
  id: string,
  r: RoomConnection,
  all: Connection[],
  elsewhere: (identityKey: string) => Promise<boolean>,
) {
  const [k, room] = [r.identityKey, roomIdOf(r.link)];
  if (room === undefined || r.identity) return;
  const kept = all.some((x) => x.id !== id && x.room?.identityKey === k && roomIdOf(x.room.link) === room);
  if (!kept && !(await elsewhere(k))) await state.forgetRoomRecords(room, k);
}
