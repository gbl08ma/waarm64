// The Tailscale backend's worker (web/tailscale.ts): loads the Go wasm client
// (net/tailscale), logs it in and passes IP packets between it and the port the
// device's gateway holds. Go's WireGuard runs on one thread, so this worker
// does nothing else. The gateway's port can change while the client runs (the page
// restarts the machine: `attach`) and is handed back on `detach`.
//
// With `persist` the node's state (its keys: a secret, kept in this origin's
// IndexedDB) survives a reload, so the same node comes back with the same address
// and no new login. Go reads its state store synchronously: the whole store is
// loaded first and written through as it changes.
import { leaseFrom, type FromTailscale, type NetMap, type ToTailscale } from './tailscale.ts';
import type { Lease } from './gateway.ts';

const post = (m: FromTailscale, transfer: Transferable[] = []) => self.postMessage(m, transfer);

const DB = 'webpc-tailscale';
const STORE = 'state';

const idb = <T>(req: IDBRequest<T>) => new Promise<T>((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });

/** The node's state store: `profile`'s entries from IndexedDB, in memory, and written back as they change. */
async function openState(profile: string) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const key = (k: string) => `${profile}/${k}`;
  const mem = new Map<string, string>();
  const range = IDBKeyRange.bound(key(''), key('￿'));
  const store = (mode: IDBTransactionMode) => db.transaction(STORE, mode).objectStore(STORE);
  const keys = await idb(store('readonly').getAllKeys(range));
  const values = await idb(store('readonly').getAll(range));
  keys.forEach((k, i) => mem.set(String(k).slice(profile.length + 1), values[i] as string));
  return {
    getState: (k: string) => mem.get(k) ?? '',
    setState: (k: string, v: string) => {
      mem.set(k, v);
      store('readwrite').put(v, key(k));
    },
    /** Forget the node (after a logout). */
    clear: async () => { await idb(store('readwrite').delete(range)); mem.clear(); },
  };
}

type Node = {
  run(cb: object): void;
  login(): void;
  logout(): void;
  setExitNode(id: string, done: (error: string) => void): void;
  sendPacket(p: Uint8Array): void;
  setPacketHandler(f: (p: Uint8Array) => void): void;
};

let ip: MessagePort | undefined;
let lease: Lease | null = null;
let node: Node | undefined;
let state: Awaited<ReturnType<typeof openState>> | undefined;

/** Connects `port` (the gateway's) to the client: packets both ways, and the lease now. */
function attach(port: MessagePort) {
  if (ip) { ip.onmessage = null; ip.close(); }
  ip = port;
  port.onmessage = (ev: MessageEvent) => { if (ev.data instanceof ArrayBuffer) node?.sendPacket(new Uint8Array(ev.data)); };
  port.postMessage({ type: 'lease', lease });
}

self.onmessage = async (e: MessageEvent<ToTailscale>) => {
  const m = e.data;
  if (m.type === 'attach') return attach(m.ip);
  if (m.type === 'detach') {
    // The guest keeps its lease until it expires; the gateway stops offering one, and the port goes back to the page.
    lease = null;
    ip?.postMessage({ type: 'lease', lease: null });
    if (ip) ip.onmessage = null;
    post({ type: 'detached', ip }, ip ? [ip] : []);
    ip = undefined;
    return;
  }
  if (m.type === 'exitnode') return node ? node.setExitNode(m.id, (error) => post({ type: 'exitnode', error })) : post({ type: 'exitnode', error: 'the client isn\'t running' });
  if (m.type === 'logout') {
    node?.logout();
    // The client's own logout call gives the control server 5 s; the saved node goes after it.
    setTimeout(() => void (state?.clear() ?? Promise.resolve()).then(() => post({ type: 'loggedout' })), 5500);
    return;
  }
  try {
    const t0 = performance.now();
    // Go's glue is a classic script that defines globalThis.Go; a module worker imports it for its effect.
    await import(/* @vite-ignore */ m.wasmExec);
    const go = new (globalThis as never as { Go: new () => { importObject: WebAssembly.Imports; run(i: WebAssembly.Instance): Promise<void> } }).Go();
    const { instance } = await WebAssembly.instantiateStreaming(fetch(m.wasm), go.importObject);
    post({ type: 'loaded', ms: performance.now() - t0 });
    go.run(instance).catch((err) => post({ type: 'error', error: `the Tailscale client exited: ${err}` }));
    if (m.persist) state = await openState(m.persist);
    node = (globalThis as never as { newNode(c: object): Node }).newNode({
      controlURL: m.controlURL, authKey: m.authKey, hostname: m.hostname ?? 'webpc', exitNode: m.exitNode ?? '',
      ...(state ? { stateStorage: { getState: state.getState, setState: state.setState }, ephemeral: false } : {}),
    });
    node.setPacketHandler((p) => {
      if (!ip) return;
      const b = p.slice().buffer;
      ip.postMessage(b, [b]);
    });
    attach(m.ip);
    let loggingIn = false;
    node.run({
      notifyState: (s: string) => {
        post({ type: 'state', state: s });
        // As tsconnect's page does: NeedsLogin starts the login (with an auth key, no URL is needed).
        if (s === 'NeedsLogin' && !loggingIn) { loggingIn = true; node!.login(); }
        if (s !== 'NeedsLogin') loggingIn = false;
      },
      notifyNetMap: (json: string) => {
        const netmap: NetMap = JSON.parse(json);
        lease = leaseFrom(netmap);
        ip?.postMessage({ type: 'lease', lease });
        post({ type: 'netmap', netmap });
      },
      notifyBrowseToURL: (url: string) => post({ type: 'login', url }),
    });
  } catch (err) {
    post({ type: 'error', error: errorText(err) });
  }
};

/** An error's message and stack: V8's stack starts with the message, Firefox's is only the frames. */
function errorText(err: unknown) {
  const e = err as Error | undefined;
  const text = String(e?.message ?? err);
  return e?.stack ? (e.stack.includes(text) ? e.stack : `${text}\n${e.stack}`) : text;
}
