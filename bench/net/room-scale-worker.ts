// One process of bench/net/room-scale.ts's synthetic members (bench/net/room-member.ts), driven over IPC: `start`
// starts members one by one, `ping` schedules echoes between them at given times, `report` says how each is doing.
import { readFileSync } from 'node:fs';
import { startMember, type Member } from './room-member.ts';

export type ToWorker =
  | { type: 'start'; members: { id: number; link: string; unixOffset: number }[]; spacingMs: number }
  | { type: 'ping'; jobs: { from: number; to: number[]; at: number; ms: number; tag: string }[] }
  | { type: 'report' }
  | { type: 'stop' };

export type FromWorker =
  | { type: 'started'; id: number; at: number; address6: number[]; key: string }
  | { type: 'pinged'; from: number; tag: string; at: number; ms: number }
  | { type: 'report'; members: { id: number; runningMs?: number; failed?: string; peers: number; memory: number }[]; rss: number; cpuMs: number };

const ROOT = new URL('../..', import.meta.url).pathname;
const wasm = await WebAssembly.compile(readFileSync(`${ROOT}target/net/ts.wasm`));
const members = new Map<number, Member>();
const send = (m: FromWorker) => process.send!(m);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

process.on('message', async (m: ToWorker) => {
  switch (m.type) {
    case 'start':
      for (const s of m.members) {
        const at = Date.now();
        const member = await startMember(wasm, { link: s.link, unixTime: Math.floor(at / 1000) + s.unixOffset });
        members.set(s.id, member);
        send({ type: 'started', id: s.id, at, address6: member.address6, key: member.key });
        await sleep(m.spacingMs - (Date.now() - at));
      }
      return;
    case 'ping':
      for (const j of m.jobs) {
        void sleep(j.at - Date.now()).then(async () => {
          const ms = await members.get(j.from)?.ping(j.to, j.ms) ?? -1;
          send({ type: 'pinged', from: j.from, tag: j.tag, at: j.at, ms });
        });
      }
      return;
    case 'report': {
      const cpu = process.cpuUsage();
      send({
        type: 'report',
        members: [...members].map(([id, x]) => ({ id, runningMs: x.runningMs, failed: x.failed, peers: x.peers.size, memory: x.memory() })),
        rss: process.memoryUsage().rss, cpuMs: (cpu.user + cpu.system) / 1000,
      });
      return;
    }
    case 'stop':
      for (const x of members.values()) x.close();
      process.exit(0);
  }
});
