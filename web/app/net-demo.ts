// The demo network as a definition attaches it (docs/networking/demo-network.md "A demo's network"): a demo whose
// definition asks for it (`demo.network: "demo"`, web/app/definitions.ts) has its first adapter attached to the
// browser's demo connection, made the first time one is asked for. It is the one connection the page makes by itself
// (docs/networking/adapters.md §1 rule 2): no secret in it and no lock on it, so every demo machine shares the one
// record and each running one opens a socket of its own. DOM-free.
import { DEMO_URL } from '../demo-net.ts';
import { Connections, type Connection } from './connections.ts';
import { setAdapterConnection } from './machines.ts';
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
