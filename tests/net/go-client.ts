// The Go client in Node (tests/net/go-client-worker.ts), for the tailnet client's hand-over test
// (docs/networking/tailnet.md "Tailscale"): it runs on a store given as a map of the page's IndexedDB
// values (`<StateKey>` → hex) and writes back into that map. `stop()` terminates its worker, so
// nothing of it stays connected.
import { readFileSync } from 'node:fs';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { Worker } from 'node:worker_threads';
import type { NetMap } from '../../web/tailscale.ts';

const ROOT = new URL('../..', import.meta.url).pathname;

/** Trusts the CA in this PEM file too (a test rig's, made after Node started) in this thread's fetches and WebSockets. */
export function trust(ca: string) {
  setDefaultCACertificates([...getCACertificates('default'), readFileSync(ca, 'utf8')]);
}

export type GoClient = { running: Promise<NetMap>; netmap(): NetMap | undefined; stop(): Promise<void> };

export function startGo(o: { controlURL: string; authKey?: string; hostname: string; state: Map<string, string>; ca?: string }): GoClient {
  const w = new Worker(new URL('./go-client-worker.ts', import.meta.url), {
    workerData: { wasm: `${ROOT}target/net/tailscale.wasm`, wasmExec: `${ROOT}target/net/wasm_exec.js`, controlURL: o.controlURL, authKey: o.authKey, hostname: o.hostname, state: Object.fromEntries(o.state), ca: o.ca },
    // Its log (verbose) only with WAARM64_GO_LOG=1.
    stdout: !process.env.WAARM64_GO_LOG, stderr: !process.env.WAARM64_GO_LOG,
  });
  let state = '';
  let netmap: NetMap | undefined;
  const running = new Promise<NetMap>((resolve, reject) => {
    w.on('error', reject);
    w.on('message', (m: { type: string; key: string; value: string; state: string; netmap: NetMap; url: string }) => {
      if (m.type === 'store') o.state.set(m.key, m.value);
      else if (m.type === 'state') state = m.state;
      else if (m.type === 'netmap') netmap = m.netmap;
      else if (m.type === 'login') reject(new Error(`the Go client wants an interactive login: ${m.url}`));
      if (state === 'Running' && netmap?.addresses?.length) resolve(netmap); // i18n-ignore
    });
  });
  running.catch(() => {});
  return { running, netmap: () => netmap, stop: async () => { await w.terminate(); } };
}
