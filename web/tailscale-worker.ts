// The Tailscale backend's worker (web/tailscale.ts): loads the Go wasm client
// (net/tailscale), logs it in and passes IP packets between it and the port the
// device's gateway holds. Go's WireGuard runs on one thread, so this worker
// does nothing else.
import { leaseFrom, type FromTailscale, type NetMap } from './tailscale.ts';

const post = (m: FromTailscale) => self.postMessage(m);

self.onmessage = async (e: MessageEvent) => {
  const m = e.data;
  if (m.type !== 'start') return;
  const ip: MessagePort = m.ip;
  try {
    const t0 = performance.now();
    // Go's glue is a classic script that defines globalThis.Go; a module worker imports it for its effect.
    await import(/* @vite-ignore */ m.wasmExec);
    const go = new (globalThis as never as { Go: new () => { importObject: WebAssembly.Imports; run(i: WebAssembly.Instance): Promise<void> } }).Go();
    const { instance } = await WebAssembly.instantiateStreaming(fetch(m.wasm), go.importObject);
    post({ type: 'loaded', ms: performance.now() - t0 });
    go.run(instance).catch((err) => post({ type: 'error', error: `the Tailscale client exited: ${err}` }));
    const node = (globalThis as never as { newNode(c: object): { run(cb: object): void; login(): void; sendPacket(p: Uint8Array): void; setPacketHandler(f: (p: Uint8Array) => void): void } }).newNode({
      controlURL: m.controlURL, authKey: m.authKey, hostname: m.hostname ?? 'webpc',
    });
    node.setPacketHandler((p) => {
      const b = p.slice().buffer;
      ip.postMessage(b, [b]);
    });
    ip.onmessage = (ev: MessageEvent) => { if (ev.data instanceof ArrayBuffer) node.sendPacket(new Uint8Array(ev.data)); };
    let loggingIn = false;
    node.run({
      notifyState: (state: string) => {
        post({ type: 'state', state });
        // As tsconnect's page does: NeedsLogin starts the login (with an auth key, no URL is needed).
        if (state === 'NeedsLogin' && !loggingIn) { loggingIn = true; node.login(); }
      },
      notifyNetMap: (json: string) => {
        const netmap: NetMap = JSON.parse(json);
        ip.postMessage({ type: 'lease', lease: leaseFrom(netmap) });
        post({ type: 'netmap', netmap });
      },
      notifyBrowseToURL: (url: string) => post({ type: 'login', url }),
    });
  } catch (err) {
    post({ type: 'error', error: String((err as Error)?.stack ?? err) });
  }
};
