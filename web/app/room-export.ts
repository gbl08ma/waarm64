// A room connection's export (docs/networking/adapters.md §2.1): its node key and, after a dot, its names: the names
// agent's owners' secret and titles kept under the connection's `identityKey` (web/names.ts `exportNames`), so a name
// travels with the key. A connection made from a pasted export takes the names as its own (`importNames`).
import type { Connection, ConnectionState, NewConnection } from './connections.ts';

/** The page's names (web/names.ts, `waarm64-room`'s `owner` and `titles`), loaded when an export needs them. */
const pageNames = {
  export: (k: string) => import('../names.ts').then((n) => n.exportNames(n.idbNamesStore(), k)),
  keep: (k: string, b: string) => import('../names.ts').then((n) => n.importNames(n.idbNamesStore(), k, b)),
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
