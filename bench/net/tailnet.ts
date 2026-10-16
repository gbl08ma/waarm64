// T4 (docs/plans/tailnet-client.md): the Rust Tailscale client in Node, against a control server:
// it registers (or comes back as the kept node) and prints its netmap (tests/ts-handover.test.ts
// compares it with the rig's peer's `tailscale status --json`). The node's store is a JSON file (`<StateKey>` → hex, as the page's IndexedDB keeps it).
// Usage: node bench/net/tailnet.ts <control URL> <auth key> [store.json] [hostname]
// (NODE_EXTRA_CA_CERTS for a test CA; WEBPC_TS_WASM for another module.)
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { TsClient, TsModule, type TsEvent } from '../../web/ts-client.ts';
import type { NetMap } from '../../web/tailscale.ts';

const [control, authKey, storeFile, hostname = 'rust'] = process.argv.slice(2);
if (!control) throw new Error('usage: node bench/net/tailnet.ts <control URL> <auth key> [store.json] [hostname]');
const state: Record<string, string> = storeFile && existsSync(storeFile) ? JSON.parse(readFileSync(storeFile, 'utf8')) : {};
const t0 = performance.now();
const m = await TsModule.load(readFileSync(process.env.WEBPC_TS_WASM ?? 'target/net/ts.wasm'));
const loaded = performance.now() - t0;
const netmap = await new Promise<NetMap>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('no netmap in 30 s')), 30_000);
  const c = new TsClient(m, { control: { url: control, authKey, hostname }, state }, {
    packet() {},
    event(e: TsEvent) {
      if (e.type === 'log') console.log(`# ${e.msg}`);
      else if (e.type === 'store') { state[e.key] = e.value; if (storeFile) writeFileSync(storeFile, JSON.stringify(state, null, 1)); }
      else if (e.type === 'state' && e.state === 'Failed') { clearTimeout(timer); reject(new Error(e.error)); }
      else if (e.type === 'login') { clearTimeout(timer); reject(new Error(`needs an interactive login: ${e.url}`)); }
      else if (e.type === 'netmap') { clearTimeout(timer); setTimeout(() => { c.close(); resolve(e.netmap); }, 200); }
    },
  });
});
console.log(`# module loaded in ${loaded.toFixed(0)} ms, netmap after ${(performance.now() - t0).toFixed(0)} ms`);
console.log(JSON.stringify(netmap, null, 1));
