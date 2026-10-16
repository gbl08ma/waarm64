// The Rust client (target/net/ts.wasm, net/ts) as a Tailscale node in Node, on a store given as a
// map of the page's IndexedDB values (`<StateKey>` → hex), written back into that map: the
// counterpart of tests/net/go-client.ts for the tailnet client's tests.
import { readFileSync } from 'node:fs';
import { TsClient, TsModule, type TsEvent } from '../../web/ts-client.ts';
import type { NetMap } from '../../web/tailscale.ts';

const ROOT = new URL('../..', import.meta.url).pathname;
let mod: Promise<TsModule> | undefined;

export type RustClient = { client: TsClient; running: Promise<NetMap>; netmap(): NetMap | undefined; events: TsEvent[]; stop(): void };

export function startRust(o: { controlURL: string; authKey?: string; hostname: string; state: Map<string, string>; exitNode?: string; packet?: (p: Uint8Array) => void }): Promise<RustClient> {
  mod ??= TsModule.load(readFileSync(`${ROOT}target/net/ts.wasm`));
  return mod.then((m) => {
    let netmap: NetMap | undefined;
    const events: TsEvent[] = [];
    let resolve!: (n: NetMap) => void;
    let reject!: (e: Error) => void;
    const running = new Promise<NetMap>((res, rej) => { resolve = res; reject = rej; });
    running.catch(() => {});
    let state = '';
    const client = new TsClient(m, { control: { url: o.controlURL, authKey: o.authKey, hostname: o.hostname }, state: Object.fromEntries(o.state), exitNode: o.exitNode }, {
      packet: (p) => o.packet?.(p),
      event(e) {
        events.push(e);
        if (e.type === 'store') o.state.set(e.key, e.value);
        else if (e.type === 'netmap') netmap = e.netmap;
        else if (e.type === 'login') reject(new Error(`the Rust client wants an interactive login: ${e.url}`));
        else if (e.type === 'state') {
          state = e.state;
          if (e.state === 'Failed') reject(new Error(e.error ?? 'failed'));
        }
        if (state === 'Running' && netmap) resolve(netmap);
      },
    });
    return { client, running, netmap: () => netmap, events, stop: () => client.close() };
  });
}
