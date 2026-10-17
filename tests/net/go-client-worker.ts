// The Go client (target/net/tailscale.wasm) in a Node worker thread, for tests/net/go-client.ts:
// what the page's Go worker did before T6 (git history: web/tailscale-worker.ts), with the store handed in whole and its writes
// posted back.
import { parentPort, workerData } from 'node:worker_threads';

const port = parentPort!;
const { wasm, wasmExec, controlURL, authKey, hostname, state, ca } = workerData as { wasm: string; wasmExec: string; controlURL: string; authKey?: string; hostname: string; state: Record<string, string>; ca?: string };
if (ca) (await import('./go-client.ts')).trust(ca);
// Go's net/http uses fetch except under Node (it checks process.argv0), where it dials sockets it can't have.
const realProcess = process;
globalThis.process = Object.create(realProcess, { argv0: { value: 'webpc-go-client' } });
const mem = new Map(Object.entries(state));
await import(wasmExec);
const go = new (globalThis as never as { Go: new () => { importObject: WebAssembly.Imports; run(i: WebAssembly.Instance): Promise<void> } }).Go();
const { readFileSync } = await import('node:fs');
const { instance } = await WebAssembly.instantiate(readFileSync(wasm), go.importObject);
go.run(instance).catch((e) => console.error('the Go client exited:', e));
await new Promise((r) => setTimeout(r, 0));
type Node = { run(cb: object): void; login(): void };
const node = (globalThis as never as { newNode(c: object): Node }).newNode({
  controlURL, authKey, hostname, ephemeral: false,
  stateStorage: {
    getState: (k: string) => mem.get(k) ?? '',
    setState: (k: string, v: string) => { mem.set(k, v); port.postMessage({ type: 'store', key: k, value: v }); },
  },
});
let loggingIn = false;
node.run({
  notifyState: (s: string) => {
    port.postMessage({ type: 'state', state: s });
    if (s === 'NeedsLogin' && !loggingIn) { loggingIn = true; node.login(); }
  },
  notifyNetMap: (json: string) => port.postMessage({ type: 'netmap', netmap: JSON.parse(json) }),
  notifyBrowseToURL: (url: string) => port.postMessage({ type: 'login', url }),
});
