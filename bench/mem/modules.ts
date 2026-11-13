// What V8 spends per JIT module and per function (docs/jit.md "Memory", bench/boot/REPORT.md "M8: fewer,
// larger modules"): renderer RSS by mapping class in headless Chromium, the modules installed in a worker as
// web/vm.ts's jitHost does.
//   node bench/mem/modules.ts synth 1,4,16,64,512 [functions=30720] [t-imports=5]
//       synthetic modules of K functions each (~600 wasm bytes, called once so Liftoff compiles them)
//   [WASM=core.wasm] node bench/mem/modules.ts capture <dir>
//       Alpine's userspace benchmark in Node; every JIT module's bytes and table slots into <dir>
//   node bench/mem/modules.ts replay <dir>...
//       a capture's modules installed in Chromium, not run (V8 compiles lazily: everything but the code)
import { chromium } from 'playwright-core';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { startServer } from '../../tools/serve.ts';

const [cmd, ...args] = process.argv.slice(2);

/** RSS (KiB) of a process by class; shared mappings (the guest's RAM) apart. */
function classes(pid: number) {
  const c: Record<string, number> = {};
  let cur = '';
  for (const l of readFileSync(`/proc/${pid}/smaps`, 'utf8').split('\n')) {
    const h = /^[0-9a-f]+-[0-9a-f]+ (\S{4}) \S+ \S+ \S+\s*(.*)$/.exec(l);
    if (h) {
      cur = h[1][3] === 's' ? 'shared' : /partition_alloc/.test(h[2]) ? 'PA' : !h[2] || h[2].startsWith('[anon') ? h[2] || 'anon' : 'file';
      continue;
    }
    if (l.startsWith('Rss:')) c[cur] = (c[cur] ?? 0) + Number(l.split(/\s+/)[1]);
  }
  return c;
}
const total = (c: Record<string, number>) => Object.entries(c).filter(([k]) => k !== 'shared').reduce((s, [, v]) => s + v, 0);
const renderers = () => readdirSync('/proc').filter((p) => /^\d+$/.test(p)).filter((p) => {
  try { return /--type=renderer/.test(readFileSync(`/proc/${p}/cmdline`, 'utf8')); } catch { return false; }
}).map(Number);

/** Runs `work` in a fresh headless Chromium page at `url`; the growth of the renderer that grew most. */
async function measure(url: string, work: (page: import('playwright-core').Page) => Promise<unknown>) {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
  try {
    const page = await browser.newPage();
    await page.goto(url);
    await page.waitForTimeout(500);
    const pids = renderers();
    const before = new Map(pids.map((p) => [p, classes(p)]));
    const result = await work(page);
    await page.waitForTimeout(2000);
    const after = new Map(pids.map((p) => [p, classes(p)]));
    const grew = (p: number) => total(after.get(p)!) - total(before.get(p)!);
    const pid = pids.reduce((m, p) => (grew(p) > grew(m) ? p : m));
    const [a, b] = [before.get(pid)!, after.get(pid)!];
    const d: Record<string, number> = {};
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (k !== 'shared') d[k] = (b[k] ?? 0) - (a[k] ?? 0);
    return { version: browser.version(), result, kib: grew(pid), byClass: d };
  } finally {
    await browser.close();
  }
}

// Synthetic modules: the wasm encoder runs in the worker (its source is this function's text).
function synthWorker() {
  const leb = (n: number) => { const o: number[] = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; o.push(b); } while (n); return o; };
  const sleb = (n: number) => { const o: number[] = []; for (;;) { const b = n & 0x7f; n >>= 7; if ((n === 0 && !(b & 0x40)) || (n === -1 && b & 0x40)) { o.push(b); return o; } o.push(b | 0x80); } };
  const str = (s: string) => [...leb(s.length), ...new TextEncoder().encode(s)];
  const sec = (id: number, c: number[]) => [id, ...leb(c.length), ...c];
  const vec = (xs: number[][]) => [...leb(xs.length), ...xs.flat()];
  // (vcpu i32, acc i64, left i32) -> i64, a block's type; 40 loads, adds and stores, and a constant unique to it.
  const body = (seed: number) => {
    const c: number[] = [];
    for (let i = 0; i < 40; i++) c.push(0x20, 0, 0x20, 0, 0x29, 3, ...leb(8 * ((i + seed) & 63)), 0x20, 1, 0x7c, 0x37, 3, ...leb(8 * ((i * 7 + seed) & 63)));
    c.push(0x20, 1, 0x42, ...sleb(seed), 0x7c, 0x0b);
    const f = [1, 1, 0x7e, ...c];
    return [...leb(f.length), ...f];
  };
  const module = (m: number, k: number, t: number[]) => {
    const imps = [[...str('env'), ...str('memory'), 2, 1, 1, 1], [...str('env'), ...str('table'), 1, 0x70, 0, 0]];
    for (let i = 0; i < 3; i++) imps.push([...str('env'), ...str('h' + i), 0, 0]);
    for (const i of t) imps.push([...str('t'), ...str(String(i)), 0, 0]);
    const n = 3 + t.length;
    return new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, ...sec(1, vec([[0x60, 3, 0x7f, 0x7e, 0x7f, 1, 0x7e]])), ...sec(2, vec(imps)),
      ...sec(3, vec(Array.from({ length: k }, () => [0]))), ...sec(7, vec(Array.from({ length: k }, (_, j) => [...str('f' + j), 0, ...leb(n + j)]))),
      ...sec(10, vec(Array.from({ length: k }, (_, j) => body(m * k + j))))]);
  };
  onmessage = (e: MessageEvent<{ k: number; fns: number; t: number }>) => {
    const { k, fns, t: T } = e.data;
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 1 });
    const table = new WebAssembly.Table({ initial: fns, element: 'anyfunc' });
    const env = { memory, table, h0: () => 0n, h1: () => 0n, h2: () => 0n };
    (self as unknown as { keep: unknown }).keep = table;
    let slot = 0;
    for (let m = 0; m < fns / k; m++) {
      const ts = slot ? Array.from({ length: T }, (_, i) => (m * 7919 + i * 104729) % slot) : [];
      const t: Record<string, unknown> = {};
      for (const i of ts) t[i] = table.get(i);
      const f = new WebAssembly.Instance(new WebAssembly.Module(module(m, k, ts)), { env, t } as WebAssembly.Imports).exports;
      for (let j = 0; j < k; j++) table.set(slot + j, f['f' + j] as never);
      slot += k;
    }
    for (let i = 0; i < slot; i++) (table.get(i) as (v: number, a: bigint, l: number) => bigint)(0, 1n, 100);
    postMessage(0);
  };
}

async function inWorker(page: import('playwright-core').Page, src: string, msg: unknown) {
  return page.evaluate(async ({ src, msg }) => {
    const w = new Worker(src.startsWith('/') ? src : URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    (globalThis as unknown as { w: Worker }).w = w;
    return new Promise((res, rej) => { w.onmessage = (e) => res(e.data); w.onerror = (e) => rej(new Error(e.message)); w.postMessage(msg); });
  }, { src, msg });
}

if (cmd === 'synth') {
  const fns = Number(args[1] ?? 30720), t = Number(args[2] ?? 5);
  const { stripTypeScriptTypes } = await import('node:module');
  const src = `(${stripTypeScriptTypes(`const f = ${synthWorker.toString()}`).slice('const f = '.length)})()`;
  for (const k of args[0].split(',').map(Number)) {
    const r = await measure('data:text/html,x', (page) => inWorker(page, src, { k, fns, t }));
    const per = (kib: number) => Math.round((kib * 1024) / fns);
    console.log(`chromium ${r.version} ${k} functions/module, ${fns / k} modules, ${t} t-imports: ${per(r.kib)} B per function`,
      JSON.stringify(Object.fromEntries(Object.entries(r.byClass).map(([c, v]) => [c, per(v)]).filter(([, v]) => Math.abs(v as number) > 20))));
  }
} else if (cmd === 'capture') {
  const dir = args[0];
  // Record the JIT modules (the core is compiled with WebAssembly.compile, not this constructor) and where their functions go.
  const W = WebAssembly as unknown as { Module: new (b: Uint8Array) => object; Instance: new (m: object, i: object) => { exports: object }; Table: { prototype: { set: (i: number, f: unknown) => void } } };
  const mods: Uint8Array[] = [], slots: number[][] = [], index = new WeakMap<object, number>(), owner = new WeakMap<object, number>();
  const M = W.Module, I = W.Instance, set = W.Table.prototype.set;
  W.Module = class extends M { constructor(b: Uint8Array) { super(b); index.set(this, mods.length); mods.push(new Uint8Array(b)); slots.push([]); } };
  W.Instance = class extends I { constructor(m: object, i: object) { super(m, i); const n = index.get(m); if (n !== undefined) for (const f of Object.values(this.exports)) owner.set(f, n); } };
  W.Table.prototype.set = function (i: number, f: unknown) { if (f && owner.has(f as object)) slots[owner.get(f as object)!].push(i); return set.call(this, i, f); };
  const { bootVm, DISTROS, Exit, guestDevices } = await import('../../web/vm.ts');
  const IMAGES = new URL('../../target/images/', import.meta.url);
  const a = DISTROS.alpine;
  const vm = await bootVm(readFileSync(process.env.WASM ?? new URL('../../target/wasm32-unknown-unknown/release/waarm64_core.wasm', import.meta.url)),
    { ramSize: 1 << 30, kernel: readFileSync(new URL(a.kernel, IMAGES)), initrd: readFileSync(new URL(a.initrd, IMAGES)), cmdline: a.cmdline, devices: guestDevices(new URL('alpine-user/rootfs-user.ext4', IMAGES).href), jit: 1 });
  for (;;) {
    const r = vm.run(1_000_000);
    vm.drain();
    if (r.kind === Exit.DEVICE) { await vm.settle(); continue; }
    if (r.kind !== Exit.BUDGET && r.kind !== Exit.TX_FULL) break;
  }
  vm.close();
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/modules.bin`, Buffer.concat(mods.flatMap((m) => { const n = Buffer.alloc(4); n.writeUInt32LE(m.length); return [n, m]; })));
  writeFileSync(`${dir}/slots.json`, JSON.stringify(slots));
  console.log(`${mods.length} modules, ${mods.reduce((s, m) => s + m.length, 0)} bytes, ${slots.reduce((s, x) => s + x.length, 0)} functions -> ${dir}`);
} else if (cmd === 'replay') {
  const leb = (b: Uint8Array, o: number) => { let r = 0, s = 0, x; do { x = b[o++]; r += (x & 0x7f) * 2 ** s; s += 7; } while (x & 0x80); return [r, o]; };
  // The memory's size: the first module's memory import (exact limits).
  const pages = (b: Uint8Array) => {
    for (let o = 8; o < b.length;) {
      const id = b[o];
      let size, p;
      [size, o] = leb(b, o + 1);
      if (id === 2) {
        let n;
        [n, p] = leb(b, o);
        for (let i = 0; i < n; i++) {
          let l;
          [l, p] = leb(b, p); p += l; [l, p] = leb(b, p); p += l;
          const kind = b[p++];
          if (kind === 0) [, p] = leb(b, p);
          else if (kind === 1) { p++; const f = b[p++]; [, p] = leb(b, p); if (f & 1) [, p] = leb(b, p); }
          else if (kind === 2) { p++; return leb(b, p)[0]; }
          else p += 2;
        }
      }
      o += size;
    }
    throw new Error('no memory import');
  };
  const server = await startServer();
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  for (const dir of args) {
    const bin = readFileSync(`${dir}/modules.bin`);
    const r = await measure(`${base}/bench/mem/modules.html`, (page) =>
      inWorker(page, '/bench/mem/modules-worker.js', { dir: '/' + dir, pages: pages(bin.subarray(4, 4 + bin.readUInt32LE(0))) }));
    console.log(`chromium ${r.version} ${dir}: ${r.result} modules, ${(bin.length / 1e6).toFixed(1)} MB of wasm: renderer +${(r.kib / 1024).toFixed(0)} MB`,
      JSON.stringify(Object.fromEntries(Object.entries(r.byClass).map(([c, v]) => [c, Math.round(v / 1024)]).filter(([, v]) => v))));
  }
  server.close();
} else {
  console.log('usage: node bench/mem/modules.ts synth <K,...> [functions] [t-imports] | capture <dir> | replay <dir>...');
  process.exit(2);
}
