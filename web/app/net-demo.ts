// The networks a definition attaches by itself (docs/networking/adapters.md §1 rule 2's exceptions), DOM-free:
// - The demo network (docs/networking/demo-network.md "A demo's network"): a demo whose definition asks for it
//   (`demo.network: "demo"`, web/app/definitions.ts) has its first adapter attached to the browser's demo connection,
//   made the first time one is asked for: no secret in it and no lock on it, so every demo machine shares the one
//   record and each running one opens a socket of its own.
// - The global public room (docs/networking/rooms.md "A demo's room"): a demo whose definition asks for it
//   (`demo.room: "global"`) has its second adapter attached to a room connection of its own on `waarm64-room:global`,
//   made with the machine (`forMachine`) and deleted with it. Its node key is made in this browser at the machine's
//   first start (a stored room connection's key, web/app/connections.ts), so every visitor's machine has an address of
//   its own and none is in the definition or the snapshot; one running machine holds it (rule 4).
import { DEMO_URL } from '../demo-net.ts';
import { GLOBAL_ROOM, roomLink } from '../room.ts';
import { Connections, memoryState, type Connection, type ConnectionState } from './connections.ts';
import { setAdapterConnection } from './machines.ts';
import { adaptersOf, type MachineRecord } from './shape.ts';
import type { Store } from './store.ts';

/**
 * The browser's demo connection to `url` (default: the project's server): the oldest stored one with that URL, else a
 * new one, kept, connecting at each start.
 */
export async function demoConnection(conns: Connections, url = DEMO_URL): Promise<Connection> {
  const have = (await conns.list()).find((c) => c.kind === 'demo' && !c.ephemeral && c.demo?.url === url);
  return have ?? conns.create({ kind: 'demo', demo: { url } });
}

/**
 * Machine record `m` (not stored yet: a demo's, web/app/template.ts) with its adapter `adapter` (default: its first) on
 * the demo connection (`url`: its server, by default the project's), which is made if this browser has none.
 */
export async function withDemoNetwork(
  store: Store,
  m: MachineRecord,
  adapter = 0,
  url = DEMO_URL,
): Promise<MachineRecord> {
  const adapters = adaptersOf(m).map((a) => ({ ...a }));
  if (!adapters[adapter]) throw new Error(`${m.name} has no adapter ${adapter + 1}`);
  adapters[adapter].connection = (await demoConnection(new Connections(store), url)).id;
  return { ...m, network: undefined, adapters };
}

/**
 * Attaches stored machine `machine`'s adapter `adapter` (default: its first) to the demo connection (`url`: its server,
 * by default the project's), and returns the connection. The machine connects it at its next start (or at once in a
 * tab that runs it: web/app/areas/network-actions.ts `follow`).
 */
export async function attachDemoNetwork(
  store: Store,
  machine: string,
  adapter = 0,
  url = DEMO_URL,
): Promise<Connection> {
  const c = await demoConnection(new Connections(store), url);
  await setAdapterConnection(store, machine, adapter, c.id);
  return c;
}

/** The global public room's link (`waarm64-room:global`: the default relays, as they change). */
function globalLink(): string {
  const l = roomLink({ id: GLOBAL_ROOM, nostr: [], derp: [] });
  if ('error' in l) throw new Error('the global room has no link');
  return l.link;
}

/**
 * Machine record `m` (not stored yet: a demo's) with its adapter `adapter` (default: its second) on a new room
 * connection of its own on the global public room (named as the machine, `forMachine` its id): incoming connections
 * on and WebRTC where it can (the rooms' defaults; the user, 2026-11-19), its key made at its first start.
 */
export async function withDemoRoom(store: Store, m: MachineRecord, adapter = 1): Promise<MachineRecord> {
  const adapters = adaptersOf(m).map((a) => ({ ...a }));
  if (!adapters[adapter]) throw new Error(`${m.name} has no adapter ${adapter + 1}`);
  const c = await new Connections(store).create({
    kind: 'room',
    name: m.name,
    forMachine: m.id,
    room: { link: globalLink(), incoming: true, relayOnly: false },
  });
  adapters[adapter].connection = c.id;
  return { ...m, network: undefined, adapters };
}

/**
 * Deletes the connections the page made for machine `machine` (`forMachine`: a demo's room), with their state (`state`:
 * the page's, web/app/net-state.ts), after the machine itself is deleted. A connection another machine was attached to
 * since stays: it is the user's now, as a duplicate's adapters come without one.
 */
export async function deleteOwnConnections(store: Store, machine: string, state: ConnectionState = memoryState()) {
  const conns = new Connections(store, state);
  const used = new Set(
    (await store.all('machines')).flatMap((r) => adaptersOf(r).flatMap((a) => (a.connection ? [a.connection] : []))),
  );
  for (const c of await conns.list()) {
    if (c.forMachine === machine && !used.has(c.id)) await conns.delete(c.id);
  }
}
