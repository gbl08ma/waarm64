// The vCPUs' features as one list (web/cpu-features.ts): the page's query, the start message's `cpu` and the core's
// `VmConfig.features` mask give the bits the page's 17 booleans gave before the list (pinned here as they were), for the
// defaults and for every `?<feature>=0|1`. A bit that moved would change what every guest sees.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CPU_BITS, CPU_DEFAULT, CPU_FEATURES, cpuFromQuery, cpuMask, isCpuFeature, type CpuFeature } from '../web/cpu-features.ts';

/** The mask as web/vm.ts computed it from `BootOptions`' booleans before the table. */
type Flags = { [F in CpuFeature]?: boolean } & { crypto?: boolean };
const oldMask = (o: Flags) => (o.crypto === false ? 0n : 1n) | (o.rng === false ? 0n : 2n) | (o.e0pd === false ? 0n : 4n) | (o.sha3 === false ? 0n : 8n) | (o.jscvt === false ? 0n : 16n)
  | (o.rcpc === false ? 0n : 32n) | (o.sb === false ? 0n : 64n) | (o.flagm === false ? 0n : 128n) | (o.dit === false ? 0n : 256n) | (o.frintts === false ? 0n : 512n) | (o.dotprod === false ? 0n : 1024n) | (o.i8mm === true ? 2048n : 0n)
  | (o.rdm === false ? 0n : 4096n) | (o.rcpc2 === false ? 0n : 8192n) | (o.fcma === true ? 16384n : 0n)
  | (o.fp16 === true ? 32768n : 0n) | (o.fhm === true ? 65536n : 0n) | (o.bf16 === true ? 131072n : 0n);
/** The page's start message's flags as they were (web/app/run/knobs.ts `cpuFlags`). */
const oldFlags = (q: URLSearchParams) => {
  const off = (k: string) => q.get(k) !== '0';
  const on = (k: string) => q.get(k) === '1';
  return { rng: off('rng'), e0pd: off('e0pd'), sha3: off('sha3'), jscvt: off('jscvt'), rcpc: off('rcpc'), sb: off('sb'), flagm: off('flagm'), dit: off('dit'), frintts: off('frintts'), dotprod: off('dotprod'), i8mm: on('i8mm'), rdm: off('rdm'), rcpc2: off('rcpc2'), fcma: on('fcma'), fp16: on('fp16'), fhm: on('fhm'), bf16: on('bf16') };
};
const OLD_FEATURES = ['rng', 'e0pd', 'sha3', 'jscvt', 'rcpc', 'sb', 'flagm', 'dit', 'frintts', 'dotprod', 'i8mm', 'rdm', 'rcpc2', 'fcma', 'fp16', 'fhm', 'bf16'];
/** The worker's list from the flags, then its booleans to `bootVm` (web/app/worker.ts before the list went through). */
const oldPath = (q: URLSearchParams) => {
  const flags: Flags = oldFlags(q);
  const cpu = OLD_FEATURES.filter((f) => flags[f as CpuFeature] ?? ['rng', 'e0pd', 'sha3', 'jscvt', 'rcpc', 'sb', 'flagm', 'dit', 'frintts', 'dotprod', 'rdm', 'rcpc2'].includes(f));
  return { cpu, mask: oldMask(Object.fromEntries(OLD_FEATURES.map((f) => [f, cpu.includes(f)]))) };
};

test('cpu features: the list and the mask are the booleans\' for the defaults and every ?<feature>=0|1', () => {
  assert.deepEqual(CPU_FEATURES, OLD_FEATURES, 'the order (a shape lists them in it, so its hash)');
  assert.deepEqual(CPU_DEFAULT, ['rng', 'e0pd', 'sha3', 'jscvt', 'rcpc', 'sb', 'flagm', 'dit', 'frintts', 'dotprod', 'rdm', 'rcpc2']);
  const queries = ['', ...CPU_FEATURES.flatMap((f) => [`${f}=0`, `${f}=1`]), 'rng=0&i8mm=1&fp16=1&fhm=1', 'sha3=0&bf16=1&fcma=1&dotprod=0'];
  for (const s of queries) {
    const q = new URLSearchParams(s);
    const old = oldPath(q);
    const cpu = cpuFromQuery(q);
    assert.deepEqual(cpu, old.cpu, `?${s}: the list (a snapshot's header, a shape)`);
    assert.equal(cpuMask({ cpu }), old.mask, `?${s}: the mask`);
  }
  // Without a list, the booleans as before (bench/boot's `crypto`, `sha3`, `rng`; Node's callers).
  for (const o of [{}, { crypto: false }, { sha3: false, rng: false }, { i8mm: true, bf16: true, dit: false }] as Flags[]) assert.equal(cpuMask(o), oldMask(o), JSON.stringify(o));
  // A snapshot's header from before the header said (`cpu` none: []): every feature off, as `cpu.includes` gave.
  assert.equal(cpuMask({ cpu: [] }), oldMask(Object.fromEntries(OLD_FEATURES.map((f) => [f, false]))));
  assert.equal(Object.values(CPU_BITS).map((b) => b.bit).join(), Array.from({ length: 17 }, (_, i) => i + 1).join());
  assert.ok(isCpuFeature('bf16') && !isCpuFeature('crypto') && !isCpuFeature('toString') && !isCpuFeature(3));
});
