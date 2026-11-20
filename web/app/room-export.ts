// A room connection's export (docs/networking/adapters.md §2.1): its node key and, after a dot, its names: the names
// agent's owners' secret and titles kept under the connection's `identityKey` (web/names-export.ts `exportNames`), so a name
// travels with the key. A connection made from a pasted export takes the names as its own (`importNames`).
import type { Connection, ConnectionState, NewConnection } from './connections.ts';

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
