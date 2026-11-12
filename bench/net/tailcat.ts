// T1 (docs/networking/tailnet.md): the tailnet client module in Node,
// against a tailcat exit node: connect, then UDP echoes from a "guest" through
// the exit node to an echo server on the exit node's machine (IPv4, translated
// to the tunnel's IPv6, and IPv6 to this machine's non-link-local IPv6 address: the exit node's
// netstack drops packets to [::1], a loopback address arriving from outside), ICMP echo, RTT and
// echo throughput.
// Usage: node bench/net/tailcat.ts <tc… address> [seconds] (the echo servers
// run here, so this must be the exit node's machine; WEBPC_TS_JSON=<file>
// writes the numbers; NODE_EXTRA_CA_CERTS for a test relay's CA.)
import { createSocket } from 'node:dgram';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { failureOf, TsClient, TsModule, type TsEvent } from '../../web/ts-client.ts';
import { checksum } from '../../web/net.ts';

const [addr, secs = '5'] = process.argv.slice(2);
const wasm = process.env.WEBPC_TS_WASM ?? 'target/net/ts.wasm';
const PORT = 7777;
const GUEST4 = [192, 0, 0, 2];

// Echo servers on the exit node's machine: IPv4 on its localhost (127.0.0.1 is reached as NAT64
// 64:ff9b::7f00:1), IPv6 on an address of its own that isn't loopback or link-local, if it has one.
const host6 = Object.values(networkInterfaces()).flat()
  .find((a) => a && a.family === 'IPv6' && !a.internal && !a.address.startsWith('fe80'))?.address;
let has6 = !!host6;
const servers: ['udp4' | 'udp6', string][] = [['udp4', '127.0.0.1'], ...(host6 ? [['udp6', host6] as ['udp6', string]] : [])];
for (const [type, host] of servers) {
  const s = createSocket(type);
  s.on('message', (m, r) => s.send(m, r.port, r.address));
  const bound = await new Promise<boolean>((resolve) => { s.once('error', () => resolve(false)); s.bind(PORT, host, () => resolve(true)); });
  if (!bound) has6 = false;
  s.unref();
}
/** An IPv6 address's 16 bytes. */
function v6bytes(a: string) {
  const [l, r = ''] = a.split('::');
  const g = (s: string) => (s ? s.split(':').map((x) => parseInt(x, 16)) : []);
  const words = a.includes('::') ? [...g(l), ...Array(8 - g(l).length - g(r).length).fill(0), ...g(r)] : g(l);
  return words.flatMap((w) => [w >> 8, w & 255]);
}

function sum(b: Uint8Array) {
  return checksum(b);
}

/** An IPv4 UDP packet from the guest to `dst`:PORT. */
function udp4(dst: number[], sport: number, payload: Uint8Array) {
  const p = new Uint8Array(28 + payload.length);
  p.set([0x45, 0, p.length >> 8, p.length & 255, 0, 0, 0x40, 0, 64, 17, 0, 0, ...GUEST4, ...dst]);
  const c = sum(p.subarray(0, 20));
  p.set([c >> 8, c & 255], 10);
  p.set([sport >> 8, sport & 255, PORT >> 8, PORT & 255, (8 + payload.length) >> 8, (8 + payload.length) & 255], 20);
  p.set(payload, 28);
  const pseudo = new Uint8Array(12 + 8 + payload.length);
  pseudo.set([...GUEST4, ...dst, 0, 17, (8 + payload.length) >> 8, (8 + payload.length) & 255]);
  pseudo.set(p.subarray(20), 12);
  const u = sum(pseudo) || 0xffff;
  p.set([u >> 8, u & 255], 26);
  return p;
}

/** An IPv6 UDP packet from `src` to `dst`:PORT. */
function udp6(src: number[], dst: number[], sport: number, payload: Uint8Array) {
  const len = 8 + payload.length;
  const p = new Uint8Array(40 + len);
  p.set([0x60, 0, 0, 0, len >> 8, len & 255, 17, 64, ...src, ...dst]);
  p.set([sport >> 8, sport & 255, PORT >> 8, PORT & 255, len >> 8, len & 255], 40);
  p.set(payload, 48);
  const pseudo = new Uint8Array(40 + len);
  pseudo.set([...src, ...dst, 0, 0, len >> 8, len & 255, 0, 0, 0, 17]);
  pseudo.set(p.subarray(40), 40);
  const u = sum(pseudo) || 0xffff;
  p.set([u >> 8, u & 255], 46);
  return p;
}

/** An ICMP echo request from the guest. */
function ping4(dst: number[], seq: number) {
  const p = new Uint8Array(28 + 8);
  p.set([0x45, 0, 0, p.length, 0, 0, 0x40, 0, 64, 1, 0, 0, ...GUEST4, ...dst]);
  const c = sum(p.subarray(0, 20));
  p.set([c >> 8, c & 255], 10);
  p.set([8, 0, 0, 0, 0x12, 0x34, seq >> 8, seq & 255], 20);
  const i = sum(p.subarray(20));
  p.set([i >> 8, i & 255], 22);
  return p;
}

const t0 = performance.now();
const m = await TsModule.load(readFileSync(wasm), (l) => console.error('[ts]', l));
const loadMs = performance.now() - t0;
let self6: number[] = [];
let pinged: (() => void) | undefined;
const running = Promise.withResolvers<number>();
const client = new TsClient(m, { addr }, {
  packet(p) {
    if (p[0] >> 4 === 4 && p[9] === 1 && p[20] === 0) return pinged?.();
    const data = p.subarray(p[0] >> 4 === 4 ? 28 : 48);
    if (data.length >= 4) seqWaiters.get(new DataView(data.buffer, data.byteOffset).getUint32(0))?.();
  },
  event(e: TsEvent) {
    if (e.type === 'log') return console.log('log', e.msg);
    console.log(`[${(performance.now() - t0).toFixed(0)} ms]`, JSON.stringify(e));
    if (e.type === 'self') self6 = e.address6;
    if (e.type === 'state' && e.state === 'Running') running.resolve(performance.now() - t0);
    if (e.type === 'state' && e.state === 'Failed') running.reject(failureOf(e));
  },
});
const runningMs = await running.promise;

// Each echo carries its sequence number first; one source port per in-flight slot, so the exit
// node proxies a few UDP flows, as real traffic makes (a port per echo made thousands of flows
// and slowed the server down to nothing).
let seq = 0;
const seqWaiters = new Map<number, () => void>();
function echo(make: (port: number, seq: number) => Uint8Array, port = 20000, timeout = 5000) {
  const s = ++seq;
  const t = performance.now();
  return new Promise<number>((resolve, reject) => {
    const to = setTimeout(() => { seqWaiters.delete(s); reject(new Error(`echo ${s} timed out`)); }, timeout);
    seqWaiters.set(s, () => { clearTimeout(to); seqWaiters.delete(s); resolve(performance.now() - t); });
    client.guest(make(port, s));
  });
}
const payload = (size: number, s: number) => { const b = new Uint8Array(size); new DataView(b.buffer).setUint32(0, s); return b; };
const v4 = (size: number) => (port: number, s: number) => udp4([127, 0, 0, 1], port, payload(size, s));
const first = await echo(v4(32), 20000, 30000);
console.log('first echo (IPv4 through the translator)', first.toFixed(1), 'ms');
const v6 = has6 ? await echo((port, s) => udp6(self6, v6bytes(host6!), port, payload(32, s))) : null;
console.log(`IPv6 echo to [${host6 ?? ''}]`, v6 === null ? 'skipped: no non-link-local IPv6 address here' : `${v6.toFixed(1)} ms`);
const icmp = await new Promise<string>((resolve) => {
  const to = setTimeout(() => resolve('no reply (the exit node forwards TCP and UDP only)'), 3000);
  pinged = () => { clearTimeout(to); resolve('replied'); };
  client.guest(ping4([127, 0, 0, 1], 1));
});
console.log('ICMP echo to 127.0.0.1:', icmp);
const rtts = [];
for (let k = 0; k < 20; k++) rtts.push(await echo(v4(32)));
rtts.sort((a, b) => a - b);
console.log('rtt median', rtts[10].toFixed(2), 'min', rtts[0].toFixed(2), 'max', rtts[19].toFixed(2), 'ms');

// Throughput: a window of the largest echoes that fit in flight (each byte crosses DERP twice).
const size = 1260 - 28, window = 32;
let done = 0, bytes = 0, lost = 0;
const cpu0 = process.cpuUsage();
const end = performance.now() + Number(secs) * 1000;
await Promise.all(Array.from({ length: window }, async (_, slot) => {
  while (performance.now() < end) {
    try { await echo(v4(size), 30000 + slot, 2000); done++; bytes += size + 28; } catch { lost++; }
  }
}));
const cpu = process.cpuUsage(cpu0);
const mbit = (bytes * 8) / Number(secs) / 1e6;
console.log(`echo throughput: ${done} of ${done + lost} echoes of ${size + 28} B in ${secs} s = ${mbit.toFixed(2)} Mbit/s each way; this process's CPU ${((cpu.user + cpu.system) / 1e4 / Number(secs)).toFixed(0)}%`);
const result = {
  wasm, node: process.version, wasmBytes: statSync(wasm).size, loadMs, runningMs, firstEchoMs: first, v6EchoMs: v6, icmp,
  rttMedianMs: rtts[10], rttMinMs: rtts[0], rttMaxMs: rtts[19],
  echoes: done, lost, echoBytes: size + 28, seconds: Number(secs), mbitPerSecEachWay: mbit,
  cpuPercent: (cpu.user + cpu.system) / 1e4 / Number(secs),
};
if (process.env.WEBPC_TS_JSON) writeFileSync(process.env.WEBPC_TS_JSON, JSON.stringify(result, null, 2) + '\n');
client.close();
process.exit(0);
