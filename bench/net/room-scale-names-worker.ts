// One process of bench/net/room-scale-names.ts's room nodes (bench/net/room-member.ts on the tests' module,
// target/net/ts-test.wasm: the pretend Bitcoin's cheap proof of work and easy headers), driven over IPC: servers (their
// titles, stored records loaded back, their fetches outside the room sent to the pretend calendars and explorer) and
// members (whose guests ask names as a guest's resolver does).
import { readFileSync } from 'node:fs';
import { startMember, type Member } from './room-member.ts';
import { dnsQuery, udp } from '../../tests/net/packets.ts';
import type { NamesTitle } from '../../web/ts-client.ts';

export type NodeSpec = {
  id: number;
  link: string;
  /** A server's titles (hex), or none: a member. */
  titles?: NamesTitle[];
  maxNames?: number;
  /** Files of stored records to load before the first tick (`len u32le, id 32, record` each). */
  records?: string[];
  /** A name to ask as soon as the node runs (a guest that asks a name at its start). */
  ask?: string;
};

export type ToWorker =
  | { type: 'start'; nodes: NodeSpec[]; spacingMs: number; services: string; explorer: string }
  | { type: 'ask'; id: number; name: string; ms: number }
  | { type: 'report' }
  | { type: 'save'; id: number; file: string }
  | { type: 'stop' };

export type Answer = { id: number; name: string; at: number; ms: number; rcode: number; answers: number; tries: number };
export type NodeReport = {
  id: number; runningMs?: number; failed?: string; memory: number;
  names?: { serving: boolean; names: number; servers: number; at: number };
  /** A server's records: written, deleted (the bound's drops among them), and the ids deleted. */
  stored: number; deleted: number; deletedIds: string[];
  fetches: Record<string, number>;
  /** Log lines matching the registry's (`names: …`), counted by their text up to a colon or digit. */
  logs: Record<string, number>;
};
export type FromWorker =
  | { type: 'started'; id: number; at: number; address6: number[]; key: string; tag: string }
  | { type: 'running'; id: number; at: number }
  | { type: 'answer'; a: Answer }
  | { type: 'names'; id: number; at: number; serving: boolean; names: number; servers: number }
  | { type: 'saved'; id: number; records: number }
  | { type: 'report'; nodes: NodeReport[]; rss: number; cpuMs: number };

const ROOT = new URL('../..', import.meta.url).pathname;
const wasm = await WebAssembly.compile(readFileSync(`${ROOT}target/net/ts-test.wasm`));
const send = (m: FromWorker) => process.send!(m);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

type Node = {
  m: Member; tag: string; records: Map<string, Uint8Array>; dns: Map<number, (d: Uint8Array) => void>;
  r: Omit<NodeReport, 'memory' | 'id'> & { id: number };
};
const nodes = new Map<number, Node>();
let qid = 1;
const v6s = (b: number[]) => Array.from({ length: 8 }, (_, k) => ((b[2 * k] << 8) | b[2 * k + 1]).toString(16)).join(':');

/** The compiled services' URLs (anchor.rs `Calendar::url`, `EXPLORERS`) → the pretend ones at `base`. */
function route(url: string, base: string, explorer: string): { to: string; kind: string } | undefined {
  const cal: Record<string, string> = {
    'https://alice.btc.calendar.opentimestamps.org': 'alice', 'https://bob.btc.calendar.opentimestamps.org': 'bob',
    'https://finney.calendar.eternitywall.com': 'finney',
  };
  for (const [u, c] of Object.entries(cal)) if (url.startsWith(u)) return { to: `${base}/${c}${url.slice(u.length)}`, kind: c };
  for (const [u, e] of [['https://blockstream.info/api', 'blockstream'], ['https://mempool.space/api', 'mempool']]) {
    if (url.startsWith(u)) return { to: `${explorer}${url.slice(u.length)}`, kind: e };
  }
  return undefined;
}

function readRecords(file: string): Uint8Array[] {
  const b = readFileSync(file);
  const out: Uint8Array[] = [];
  for (let at = 0; at + 4 <= b.length;) {
    const n = b.readUInt32LE(at);
    out.push(b.subarray(at + 4 + 32, at + 4 + n));
    at += 4 + n;
  }
  return out;
}

async function ask(n: Node, id: number, name: string, ms: number) {
  // As a guest's resolver asks: again after a SERVFAIL or no answer in 5 s, until an answer or `ms`.
  const me = v6s(n.m.address6);
  const resolver = v6s([...n.m.address6.slice(0, 6), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x53]);
  const at = Date.now();
  const t = performance.now();
  let tries = 0;
  let last = { rcode: -1, answers: 0 };
  while (performance.now() - t < ms) {
    const q = qid++ & 0xffff;
    tries++;
    const d = await new Promise<Uint8Array | undefined>((res) => {
      const timer = setTimeout(() => { n.dns.delete(q); res(undefined); }, 5000);
      n.dns.set(q, (d) => { clearTimeout(timer); n.dns.delete(q); res(d); });
      n.m.client.guest(udp(me, 40000 + (q % 20000), resolver, 53, dnsQuery(q, `${name}.${n.tag}.p2p.internal`, 28)));
    });
    if (d) {
      last = { rcode: d[3] & 15, answers: (d[6] << 8) | d[7] };
      if (last.rcode === 3 || (last.rcode === 0 && last.answers > 0)) break;
      if (last.rcode !== 2) await sleep(200);
    }
  }
  send({ type: 'answer', a: { id, name, at, ms: performance.now() - t, ...last, tries } });
}

async function start(s: NodeSpec, base: string, explorer: string) {
  const at = Date.now();
  const r: Node['r'] = { id: s.id, stored: 0, deleted: 0, deletedIds: [], fetches: {}, logs: {} };
  const records = new Map<string, Uint8Array>();
  const dns = new Map<number, (d: Uint8Array) => void>();
  let tag = '';
  let ran = false;
  const m = await startMember(wasm, {
    link: s.link,
    ...(s.titles ? { names: { titles: s.titles, ...(s.maxNames ? { maxNames: s.maxNames } : {}) } } : {}),
    records: (s.records ?? []).flatMap(readRecords),
    packet(p) {
      if (p[0] >> 4 === 6 && p[6] === 17 && p.length > 60 && ((p[40] << 8) | p[41]) === 53) dns.get((p[48] << 8) | p[49])?.(p.subarray(48));
    },
    namesStore(id, record) {
      if (record) { r.stored++; records.set(hex(id), record.slice()); } else { r.deleted++; r.deletedIds.push(hex(id)); records.delete(hex(id)); }
    },
    namesFetch(client, id, url) {
      const to = route(url, base, explorer);
      if (!to) return client.namesFetched(id, 0, new Uint8Array());
      r.fetches[to.kind] = (r.fetches[to.kind] ?? 0) + 1;
      fetch(to.to).then(async (res) => client.namesFetched(id, res.status, new Uint8Array(await res.arrayBuffer())))
        .catch(() => client.namesFetched(id, 0, new Uint8Array()));
    },
    event(e) {
      const ev = e as { type: string; tag?: string; msg?: string; state?: string; serving?: boolean; names?: number; servers?: number };
      if (ev.type === 'self') tag = ev.tag ?? '';
      else if (ev.type === 'state' && ev.state === 'Running' && !ran) { ran = true; send({ type: 'running', id: s.id, at: Date.now() }); }
      else if (ev.type === 'names') {
        r.names = { serving: !!ev.serving, names: ev.names ?? 0, servers: ev.servers ?? 0, at: Date.now() };
        send({ type: 'names', id: s.id, ...r.names });
      } else if (ev.type === 'log' && ev.msg?.startsWith('names: ')) {
        const k = ev.msg.slice(7).replace(/[0-9a-f]{16,}/g, 'H').replace(/\d+(\.\d+)?/g, 'N').slice(0, 70);
        r.logs[k] = (r.logs[k] ?? 0) + 1;
      }
    },
  });
  const n: Node = { m, tag, records, dns, r };
  nodes.set(s.id, n);
  send({ type: 'started', id: s.id, at, address6: m.address6, key: m.key, tag });
  if (s.ask) {
    const name = s.ask;
    void (async () => {
      const t = Date.now();
      while (!ran && Date.now() - t < 30_000) await sleep(20);
      await ask(n, s.id, name, 30_000);
    })();
  }
}

process.on('message', async (msg: ToWorker) => {
  switch (msg.type) {
    case 'start':
      for (const s of msg.nodes) {
        const at = Date.now();
        await start(s, msg.services, msg.explorer).catch((e) => console.log(`# node ${s.id}: ${e}`));
        await sleep(msg.spacingMs - (Date.now() - at));
      }
      return;
    case 'ask': {
      const n = nodes.get(msg.id);
      if (n) void ask(n, msg.id, msg.name, msg.ms);
      return;
    }
    case 'save': {
      const n = nodes.get(msg.id);
      const parts: Buffer[] = [];
      for (const [id, rec] of n?.records ?? []) {
        const h = Buffer.alloc(4);
        h.writeUInt32LE(32 + rec.length);
        parts.push(h, Buffer.from(id, 'hex'), Buffer.from(rec));
      }
      const { writeFileSync } = await import('node:fs');
      writeFileSync(msg.file, Buffer.concat(parts));
      send({ type: 'saved', id: msg.id, records: n?.records.size ?? 0 });
      return;
    }
    case 'report': {
      const cpu = process.cpuUsage();
      send({
        type: 'report',
        nodes: [...nodes.values()].map((n) => ({ ...n.r, runningMs: n.m.runningMs, failed: n.m.failed, memory: n.m.memory() })),
        rss: process.memoryUsage().rss, cpuMs: (cpu.user + cpu.system) / 1000,
      });
      return;
    }
    case 'stop':
      for (const n of nodes.values()) n.m.close();
      process.exit(0);
  }
});
