// Reads a capture of the Venus oracle (build.sh --capture; run.sh with VENUS_DUMP=<file>): capture.patch's JSON
// lines, one per queue submit ("submit": what vkr decoded since the previous one) and one at the context's end, plus
// "blob" lines for each mappable resource. Groups the submits into frames and prints the steady frames' averages:
// commands by name (count, bytes), stream bytes by source (vtest submits, the ring, indirect streams), replies
// (the guest's synchronous round trips), ring and fence events, host-visible memory mapped and changed (4 KiB pages
// that differ from the previous submit's copy; device memory and shm separately).
//   node tools/venus-oracle/dump.ts <file> [--frame fence|submit] [--group K] [--skip N] [--last N] [--top N]
//        [--frames] [--resources] [--json out.json]
// --frame submit: every queue submit ends a frame (the default: the scene submits once a frame); fence: only a submit
// whose host-side vkQueueSubmit carries a fence (Venus replaces the guest's fence with a feedback command buffer and
// no host fence, so this is rarely what a frame is).
// --group K: K such submits make a frame (a presenting client's own submit plus WSI's). --skip N: drop the first N
// frames (setup and warm-up; default 3); --last N: keep the last N frames only (default: all after --skip, without
// the last partial frame). --frames: one line per frame. --resources: the resources that changed, per frame.
import { readFileSync, writeFileSync } from 'node:fs';

type Pair = [number, number];
interface Rec {
  k: string; seq: number; ctx: number; fence: number; cbs: number;
  changed: [number, number, number, number, number][]; // res, kind (0 devmem, 1 shm), size, changed bytes, mem flags
  mem: { devmem: [number, number, number]; shm: [number, number, number] }; // count, bytes mapped, bytes changed
  src: { vtest: Pair; ring: Pair; indirect: Pair };
  ev: Record<string, number>;
  cmds: Record<string, Pair>;
  replies: Record<string, Pair>;
}

const args = process.argv.slice(2);
const file = args[0];
const opt = (name: string, def: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const mode = opt('--frame', 'submit');
const group = Number(opt('--group', '1'));
const skip = Number(opt('--skip', '3'));
const last = Number(opt('--last', '0'));
const top = Number(opt('--top', '12'));
const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
const recs: Rec[] = [];
const blobs: { res: number; kind: number; size: number; flags: number }[] = [];
for (const l of lines) {
  let r: Rec & { res?: number; kind?: number; size?: number; flags?: number };
  try { r = JSON.parse(l); } catch { continue; } // a line cut by a killed process
  if (r.k === 'submit' || r.k === 'end') recs.push(r);
  else if (r.k === 'blob') blobs.push({ res: r.res!, kind: r.kind!, size: r.size!, flags: r.flags! });
}

// Frames: consecutive records up to and including a frame-ending submit; the "end" record's tail is dropped.
const frames: Rec[][] = [];
let cur: Rec[] = [];
let ends = 0;
for (const r of recs) {
  if (r.k === 'end') break;
  cur.push(r);
  if (mode === 'submit' || r.fence) {
    if (++ends % group === 0) { frames.push(cur); cur = []; }
  }
}
let steady = frames.slice(skip);
if (last > 0) steady = steady.slice(-last);
if (!steady.length) { console.log(`no steady frames (${frames.length} frames, ${recs.length} records)`); process.exit(1); }

function sum(fr: Rec[]) {
  const s = {
    submits: fr.length, fenced: 0, cbs: 0, cmds: {} as Record<string, Pair>, replies: {} as Record<string, Pair>,
    src: { vtest: [0, 0] as Pair, ring: [0, 0] as Pair, indirect: [0, 0] as Pair }, ev: {} as Record<string, number>,
    devChanged: 0, shmChanged: 0, devMapped: 0, devCount: 0, shmMapped: 0, changedRes: new Map<string, number>(),
  };
  for (const r of fr) {
    s.fenced += r.fence; s.cbs += r.cbs;
    for (const [n, [c, b]] of Object.entries(r.cmds)) { const p = (s.cmds[n] ??= [0, 0]); p[0] += c; p[1] += b; }
    for (const [n, [c, b]] of Object.entries(r.replies)) { const p = (s.replies[n] ??= [0, 0]); p[0] += c; p[1] += b; }
    for (const k of ['vtest', 'ring', 'indirect'] as const) { s.src[k][0] += r.src[k][0]; s.src[k][1] += r.src[k][1]; }
    for (const [n, v] of Object.entries(r.ev)) s.ev[n] = (s.ev[n] ?? 0) + v;
    s.devChanged += r.mem.devmem[2]; s.shmChanged += r.mem.shm[2];
    s.devMapped = r.mem.devmem[1]; s.devCount = r.mem.devmem[0]; s.shmMapped = r.mem.shm[1];
    // keyed by id and size: ids are reused after a resource is destroyed
    for (const [res, kind, size, ch, flags] of r.changed) {
      const key = `${kind ? 'shm' : 'mem'} ${res} ${size} ${flags}`;
      s.changedRes.set(key, (s.changedRes.get(key) ?? 0) + ch);
    }
  }
  return s;
}

const n = steady.length;
const tot = sum(steady.flat());
const per = (v: number) => +(v / n).toFixed(2);
const streamBytes = tot.src.vtest[1] + tot.src.ring[1] + tot.src.indirect[1];
const cmdCount = tot.src.vtest[0] + tot.src.ring[0] + tot.src.indirect[0];
const replyCount = Object.values(tot.replies).reduce((a, p) => a + p[0], 0);
const replyBytes = Object.values(tot.replies).reduce((a, p) => a + p[1], 0);
const sorted = Object.entries(tot.cmds).sort((a, b) => b[1][0] - a[1][0]);
const out = {
  file, frameMode: mode, group, framesTotal: frames.length, framesSteady: n,
  perFrame: {
    submits: per(tot.submits), fencedSubmits: per(tot.fenced), commandBuffers: per(tot.cbs),
    commands: per(cmdCount), streamBytes: per(streamBytes),
    bySource: Object.fromEntries(Object.entries(tot.src).map(([k, [c, b]]) => [k, { commands: per(c), bytes: per(b) }])),
    replies: per(replyCount), replyBytes: per(replyBytes),
    replyCommands: Object.fromEntries(Object.entries(tot.replies).map(([k, [c, b]]) => [k, { count: per(c), bytes: per(b) }])),
    events: Object.fromEntries(Object.entries(tot.ev).map(([k, v]) => [k, per(v)])),
    hostVisible: {
      devmemMapped: tot.devMapped, devmemAllocations: tot.devCount, devmemChanged: per(tot.devChanged),
      shmMapped: tot.shmMapped, shmChanged: per(tot.shmChanged),
      // "mem|shm id size memory-property-flags" -> bytes of changed 4 KiB pages a frame
      changedByResource: Object.fromEntries([...tot.changedRes].sort((a, b) => b[1] - a[1]).map(([k, c]) => [k, per(c)])),
    },
    commandsByName: Object.fromEntries(sorted.map(([k, [c, b]]) => [k, { count: per(c), bytes: per(b) }])),
  },
  blobs: { devmem: blobs.filter((b) => b.kind === 0).length, shm: blobs.filter((b) => b.kind === 1).length },
};

const kb = (v: number) => (v / 1024).toFixed(1) + ' KiB';
console.log(`${file}: ${frames.length} frames (${mode}${group > 1 ? ` x${group}` : ''}), ${n} steady; per frame:`);
const p = out.perFrame;
console.log(`  submits ${p.submits} (fenced ${p.fencedSubmits}), command buffers ${p.commandBuffers}`);
console.log(`  commands ${p.commands}, stream ${kb(p.streamBytes)} (vtest ${p.bySource.vtest.commands}/${kb(p.bySource.vtest.bytes)}, ring ${p.bySource.ring.commands}/${kb(p.bySource.ring.bytes)}, indirect ${p.bySource.indirect.commands}/${kb(p.bySource.indirect.bytes)})`);
console.log(`  replies ${p.replies} (${p.replyBytes} B): ${Object.entries(p.replyCommands).map(([k, v]) => `${k} ${v.count}`).join(', ') || 'none'}`);
console.log(`  events: ${Object.entries(p.events).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(', ')}`);
console.log(`  host-visible device memory: ${p.hostVisible.devmemAllocations} mapped, ${kb(p.hostVisible.devmemMapped)}; changed ${kb(p.hostVisible.devmemChanged)}`);
console.log(`  shm (ring, replies, streams): ${kb(p.hostVisible.shmMapped)}; changed ${kb(p.hostVisible.shmChanged)}`);
console.log(`  changed by resource (kind id size flags: bytes): ${Object.entries(p.hostVisible.changedByResource).slice(0, 10).map(([k, v]) => `${k}: ${kb(v)}`).join('; ')}`);
console.log(`  commands by count:`);
for (const [k, v] of Object.entries(p.commandsByName).slice(0, top)) console.log(`    ${k.padEnd(36)} ${String(v.count).padStart(9)}  ${kb(v.bytes).padStart(12)}`);
if (args.includes('--frames') || args.includes('--resources')) {
  frames.forEach((fr, i) => {
    const s = sum(fr);
    const sb = s.src.vtest[1] + s.src.ring[1] + s.src.indirect[1];
    const rc = Object.values(s.replies).reduce((a, q) => a + q[0], 0);
    const draws = (s.cmds.vkCmdDrawIndexed?.[0] ?? 0) + (s.cmds.vkCmdDraw?.[0] ?? 0);
    console.log(`  frame ${i}: submits ${s.submits} cmds ${Object.values(s.cmds).reduce((a, q) => a + q[0], 0)} draws ${draws} stream ${sb} B replies ${rc} devmem changed ${s.devChanged} shm changed ${s.shmChanged}` +
      (args.includes('--resources') ? ` res ${[...s.changedRes].map(([r, c]) => `${r}:${c}`).join(',')}` : ''));
  });
}
const j = args.indexOf('--json');
if (j >= 0) writeFileSync(args[j + 1], JSON.stringify(out, null, 1) + '\n');
