// XF finding 4: the worker stack that guest calls as host calls take (64 frames deep, plus a tier-up's install there).
import { coreImports } from '../../../../../web/core.ts';

const GUEST0 = [0xd2800c80, 0x94000004, 0xf10004a5, 0x54ffffa1, 0xd4200000, 0xa9bf7bfd, 0xf1000400, 0x540008c0, 0x4ea08400, 0x4ea18421, 0x4ea28442, 0x4ea38463, 0x4ea48484, 0x4ea584a5, 0x4ea684c6, 0x4ea784e7, 0x4ea88508, 0x4ea98529, 0x4eaa854a, 0x4eab856b, 0x4eac858c, 0x4ead85ad, 0x4eae85ce, 0x4eaf85ef, 0x4eb08610, 0x4eb18631, 0x4eb28652, 0x4eb38673, 0x4eb48694, 0x4eb586b5, 0x4eb686d6, 0x4eb786f7, 0x4eb88718, 0x4eb98739, 0x4eba875a, 0x4ebb877b, 0x4ebc879c, 0x4ebd87bd, 0x4ebe87de, 0x4ebf87ff, 0x1f431041, 0x1e6728c5, 0x97ffffdb, 0x4ea08400, 0x4ea18421, 0x4ea28442, 0x4ea38463, 0x4ea48484, 0x4ea584a5, 0x4ea684c6, 0x4ea784e7, 0x4ea88508, 0x4ea98529, 0x4eaa854a, 0x4eab856b, 0x4eac858c, 0x4ead85ad, 0x4eae85ce, 0x4eaf85ef, 0x4eb08610, 0x4eb18631, 0x4eb28652, 0x4eb38673, 0x4eb48694, 0x4eb586b5, 0x4eb686d6, 0x4eb786f7, 0x4eb88718, 0x4eb98739, 0x4eba875a, 0x4ebb877b, 0x4ebc879c, 0x4ebd87bd, 0x4ebe87de, 0x4ebf87ff, 0xa8c17bfd, 0xd65f03c0, 0xd2800641, 0x91000442, 0xf1000421, 0x54ffffc1, 0xa8c17bfd, 0xd65f03c0];
const GUEST = GUEST0.map((w) => w === (0xd2800000 | 50 << 5 | 1) ? 0xd2800000 | 3 << 5 | 1 : w);
const BRK = 0x1010; // B
type Fn = (...a: (number | bigint)[]) => number | bigint;
const mod = await WebAssembly.compileStreaming(fetch('/target/wasm32-unknown-unknown/release/webpc_core.wasm'));

function machine(batch: number, regionAfter: number, depth = 100, stats?: Record<string, unknown>) {
  const memory = new WebAssembly.Memory({ initial: 32, maximum: 65536, shared: true });
  const imports = coreImports(memory);
  const instance = new WebAssembly.Instance(mod, imports);
  imports.jit.bind(instance);
  const e = instance.exports as unknown as Record<string, Fn>;
  const base = memory.grow(1) * 65536;
  new Uint32Array(memory.buffer, base + 0x1000, GUEST.length).set(GUEST);
  new Uint32Array(memory.buffer, base + 0x1000, 1)[0] = 0xd2800000 | depth << 5;
  const v = e.jit_new(2, batch, 4096, 0, regionAfter) as number;
  const x = new BigUint64Array(memory.buffer, v, 33);
  const exit = e.vcpu_new() as number;
  const m = e.mem_new(base, 65536n);
  return (pc: number, iters: bigint) => {
    [x[5], x[31], x[32]] = [iters, 0xf000n, BigInt(pc)];
    e.jit_run_exit(v, m, 100_000_000n, exit);
    if (stats) { const st = new BigUint64Array(memory.buffer, e.jit_stats(v) as number, 19); Object.assign(stats, { blocks: Number(st[0]), modules: Number(st[1]), steps: Number(st[4]), dispatches: Number(st[5]), tierUps: Number(st[18]), x2: Number(x[2]) }); }
    return new BigUint64Array(memory.buffer, exit, 1)[0];
  };
}

function pad(d: number, f: () => unknown): unknown {
  if (d === 0) return f();
  const r = pad(d - 1, f);
  return r;
}

// The deepest padding under which f still runs (f gets a fresh machine each probe, warmed by `warm` runs first).
function headroom(mk: () => () => unknown) {
  let lo = 0, hi = 1 << 17;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    const f = mk();
    let ok = true;
    try { pad(mid, f); } catch (e) { if (!(e instanceof RangeError)) throw e; ok = false; }
    if (ok) lo = mid; else hi = mid;
  }
  return lo;
}

const out: Record<string, unknown> = {};
try {
  for (let i = 0; i < 3; i++) headroom(() => () => 0); // warm pad
  out.empty = headroom(() => () => 0);
  out.dispatcher = headroom(() => { const r = machine(1, 1000); r(0x1000, 3n); return () => r(BRK, 1n); });
  for (const batch of [1, 4]) {
    for (const [name, ra] of [['calls', 0x7fff_ffff], ['callsTierUp', 10]] as const) {
      // Warm: the path compiled (3 outer iterations); the probed run does 1 more (with tier-up: fresh machine,
      // so the inner loop's tier-up fires within the probed run, 64 host calls deep).
      out[name + batch] = headroom(() => {
        const r = machine(batch, ra);
        r(0x1000, ra > 1000 ? 2n : 1n);
        return () => { if (r(0x1000, ra > 1000 ? 1n : 4n) !== 6n) throw new Error('no brk'); };
      });
    }
  }
  for (const depth of [1, 16, 32, 64, 100]) {
    out['depth' + depth] = headroom(() => { const r = machine(1, 0x7fff_ffff, depth); r(0x1000, 3n); return () => r(0x1000, 1n); });
  }
  for (const [n, ra] of [['statsCalls', 0x7fff_ffff], ['statsTier', 10]] as const) {
    const st: Record<string, unknown> = {};
    const r = machine(4, ra, 100, st);
    r(0x1000, 1n); const a = { ...st }; r(0x1000, 4n);
    out[n] = [a, st];
  }
  postMessage(out);
} catch (e) {
  postMessage({ ...out, error: String(e) });
}
