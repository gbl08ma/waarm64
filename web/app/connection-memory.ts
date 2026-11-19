// Connections' state kept in memory (web/app/connections.ts `ConnectionState`), `waarm64-room`'s keys included: what a
// `Connections` without the page's IndexedDB stores keeps (Node's tests). DOM-free.
import { newRoomIdentity, type RoomIdentity } from '../room.ts';
import type { ConnectionState } from './connections.ts';

/** State kept in memory, `waarm64-room`'s keys included (Node's tests). */
export function memoryState(): ConnectionState {
  const rooms = new Map<string, RoomIdentity>();
  const names = new Map<string, string>();
  const none = () => Promise.resolve();
  return {
    forgetTailnet: none,
    forgetTailcat: none,
    forgetRoom: (k) => {
      rooms.delete(k);
      return Promise.resolve();
    },
    readRoom: (k) => Promise.resolve(rooms.get(k)),
    roomIdentity: (k) => {
      const made = rooms.get(k) ?? newRoomIdentity();
      rooms.set(k, made);
      return Promise.resolve(made);
    },
    keepRoom: (k, i) => {
      rooms.set(k, i);
      return Promise.resolve();
    },
    exportNames: (k) => Promise.resolve(names.get(k)),
    keepNames: (k, n) => Promise.resolve(void names.set(k, n)),
    forgetNames: (k) => Promise.resolve(void names.delete(k)),
  };
}
