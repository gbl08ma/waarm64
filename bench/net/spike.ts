// N2 spike (docs/plans/networking.md): log in to a headscale with an auth key,
// ping a peer with raw IP packets through the Tun hook, then measure echo
// throughput. Usage: WEBPC_TS_AUTHKEY=... node bench/net/spike.ts <control URL> <peer ip> [seconds]
// (NODE_EXTRA_CA_CERTS for a test CA; WEBPC_TS_JSON=<file> writes the numbers.)
import { statSync, writeFileSync } from 'node:fs';
import { startNode } from './node.ts';
import { echoReply, echoRequest } from './icmp.ts';

const [controlURL, peer, secs = '5'] = process.argv.slice(2);
const wasm = process.env.WEBPC_TS_WASM ?? 'target/net/tailscale.wasm';
const replies = new Map<number, (len: number) => void>();
const node = startNode(
  { wasm, wasmExec: wasm.replace(/[^/]*$/, 'wasm_exec.js'), controlURL, authKey: process.env.WEBPC_TS_AUTHKEY, hostname: 'spike' },
  (p) => { const r = echoReply(p); if (r) replies.get(r.seq)?.(r.len); },
  (s) => console.log(`[${((performance.now()) / 1000).toFixed(1)}s] ${s}`),
);
const { netmap, times } = await node.running;
const self = netmap.addresses.find((a) => !a.includes(':'))!.replace(/\/.*/, '');
console.log('self', self, 'peers', netmap.peers.map((p) => `${p.name} ${p.addresses.join(',')}`).join('; '), 'mtu', netmap.mtu, 'dns', netmap.dns, netmap.domains);
console.log('load', times.load.toFixed(0), 'ms; running after', times.running.toFixed(0), 'ms');

let seq = 0;
function ping(size: number, timeout = 10000) {
  const s = ++seq;
  const t = performance.now();
  return new Promise<number>((resolve, reject) => {
    const to = setTimeout(() => { replies.delete(s); reject(new Error(`ping ${s} timed out`)); }, timeout);
    replies.set(s, () => { clearTimeout(to); replies.delete(s); resolve(performance.now() - t); });
    node.send(echoRequest(self, peer, 0x7770, s, new Uint8Array(size)));
  });
}
const first = await ping(32, 30000);
console.log('first ping', first.toFixed(1), 'ms');
const rtts = [];
for (let k = 0; k < 20; k++) rtts.push(await ping(32));
rtts.sort((a, b) => a - b);
console.log('rtt median', rtts[10].toFixed(1), 'min', rtts[0].toFixed(1), 'max', rtts[19].toFixed(1), 'ms');

// Throughput: a window of large echoes in flight for `secs` seconds (each byte crosses DERP twice).
const size = netmap.mtu - 28, window = 32;
let done = 0, bytes = 0, lost = 0;
const end = performance.now() + Number(secs) * 1000;
await Promise.all(Array.from({ length: window }, async () => {
  while (performance.now() < end) {
    try { await ping(size, 2000); done++; bytes += size + 28; } catch { lost++; }
  }
}));
console.log(`echo throughput: ${done} of ${done + lost} echoes of ${size + 28} B in ${secs} s = ${(bytes * 8 / Number(secs) / 1e6).toFixed(2)} Mbit/s each way`);
const result = {
  wasm, controlURL, node: process.version, wasmBytes: statSync(wasm).size,
  loadMs: times.load, runningMs: times.running, firstPingMs: first,
  rttMedianMs: rtts[10], rttMinMs: rtts[0], rttMaxMs: rtts[19],
  echoes: done, lost, echoBytes: size + 28, seconds: Number(secs), mbitPerSecEachWay: (bytes * 8) / Number(secs) / 1e6,
};
if (process.env.WEBPC_TS_JSON) writeFileSync(process.env.WEBPC_TS_JSON, JSON.stringify(result, null, 2) + '\n');
node.close();
process.exit(0);
