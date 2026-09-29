// The Tailscale wasm module (net/tailscale) running in a Node worker: what a
// backend worker in the page does, minus the page. Exports `startNode`, which
// resolves once the node is Running, with the node's netmap and a packet API.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export type NetMap = { name: string; addresses: string[]; peers: { name: string; addresses: string[]; online?: boolean; exitNodeOption: boolean }[]; mtu: number; dns: string[]; domains: string[] };
export type Config = { wasm: string; wasmExec: string; controlURL: string; authKey?: string; hostname?: string };

if (!isMainThread && workerData?.tsnode) {
  const c: Config = workerData.config;
  const t0 = performance.now();
  await import(pathToFileURL(c.wasmExec).href);
  const go = new (globalThis as any).Go();
  const bytes = readFileSync(c.wasm);
  const { instance } = await WebAssembly.instantiate(bytes, go.importObject);
  parentPort!.postMessage({ type: 'loaded', ms: performance.now() - t0 });
  // Go's net/http turns fetch off when `process.argv0` says it runs in Node; a page has no `process`.
  const fake = Object.create(process, { argv0: { value: 'webpc' } });
  Object.defineProperty(globalThis, 'process', { value: fake, configurable: true });
  go.run(instance).catch((e: unknown) => parentPort!.postMessage({ type: 'error', error: String(e) }));
  const node = (globalThis as any).newNode({ controlURL: c.controlURL, authKey: c.authKey, hostname: c.hostname ?? 'webpc' });
  let loggingIn = false;
  node.setPacketHandler((u8: Uint8Array) => {
    const b = u8.slice().buffer;
    parentPort!.postMessage({ type: 'packet', b }, [b]);
  });
  node.run({
    notifyState: (state: string) => {
      parentPort!.postMessage({ type: 'state', state });
      // Like tsconnect's page: NeedsLogin starts the login (the auth key's, if one was given).
      if (state === 'NeedsLogin' && !loggingIn) { loggingIn = true; node.login(); }
    },
    notifyNetMap: (json: string) => parentPort!.postMessage({ type: 'netmap', netmap: JSON.parse(json) }),
    notifyBrowseToURL: (url: string) => parentPort!.postMessage({ type: 'login', url }),
  });
  parentPort!.on('message', (m: any) => {
    if (m.type === 'send') node.sendPacket(new Uint8Array(m.b));
  });
}

export function startNode(config: Config, onPacket: (p: Uint8Array) => void, log: (s: string) => void = () => {}) {
  const worker = new Worker(new URL(import.meta.url), { workerData: { tsnode: true, config }, stdout: false });
  let netmap: NetMap | undefined;
  const t0 = performance.now();
  const times: Record<string, number> = {};
  const running = new Promise<void>((resolve, reject) => {
    worker.on('error', reject);
    worker.on('message', (m: any) => {
      if (m.type === 'loaded') times.load = m.ms;
      else if (m.type === 'state') {
        log(`state ${m.state}`);
        if (m.state === 'Running') { times.running = performance.now() - t0; resolve(); }
      } else if (m.type === 'netmap') netmap = m.netmap;
      else if (m.type === 'packet') onPacket(new Uint8Array(m.b));
      else if (m.type === 'login') log(`login ${m.url}`);
      else if (m.type === 'error') log(`go: ${m.error}`);
    });
  });
  return {
    running: running.then(() => ({ netmap: netmap!, times })),
    netmap: () => netmap,
    send(p: Uint8Array) {
      const b = p.slice().buffer;
      worker.postMessage({ type: 'send', b }, [b]);
    },
    close: () => worker.terminate(),
  };
}
