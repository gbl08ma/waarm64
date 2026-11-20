// The VmConfig the host writes for `vm_new` (web/vm.ts `vmConfig`, `VM_CONFIG`): each field at the word the core's
// struct has it (core/src/vm.rs `VmConfig`, read here), and the words those fields made before they had names.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { MAX_SPILL } from '../web/ram.ts';
import { VM_CONFIG, VM_CONFIG_WORDS, vmConfig } from '../web/vm.ts';

test("VM_CONFIG's words are the core's VmConfig fields, in its order and sizes", () => {
  const src = readFileSync(new URL('../core/src/vm.rs', import.meta.url), 'utf8');
  const body = /pub struct VmConfig \{([\s\S]*?)\n\}/.exec(src)![1];
  const spill = Number(/pub const MAX_SPILL: usize = (\d+);/.exec(readFileSync(new URL('../core/src/mem.rs', import.meta.url), 'utf8'))![1]);
  assert.equal(spill, MAX_SPILL);
  const words: Record<string, number> = {};
  let at = 0;
  for (const [, name, ty] of body.matchAll(/^\s*pub (\w+): ([^,]+),/gm)) {
    words[name.replace(/_(\w)/g, (_, c: string) => c.toUpperCase())] = at;
    const n = /^\[u64; (\d+|crate::mem::MAX_SPILL)\]$/.exec(ty);
    assert.ok(ty === 'u64' || n, `${name}: ${ty}`);
    at += n ? (n[1] === 'crate::mem::MAX_SPILL' ? spill : Number(n[1])) : 1;
  }
  assert.deepEqual(words, { ...VM_CONFIG });
  assert.equal(at, VM_CONFIG_WORDS);
});

test('vmConfig writes the words the positional list wrote', () => {
  const seed = [11n, 12n, 13n, 14n];
  const spill = Array.from({ length: MAX_SPILL }, (_, k) => BigInt(k + 100));
  const words = vmConfig({
    ramSize: 1n, deterministic: 2n, devices: 5n, ndevices: 6n, fbWidth: 7n, fbHeight: 8n, jit: 9n, features: 10n, ncpus: 11n,
    smp: 13n, rtc: 14n, firmware: 15n, flashSize: 16n, fwCfg: 17n, fwCfgLen: 18n, memPages: 19n, rngSeed: seed, xhci: 0x404n,
    spill, jitBytes: 33n, window: 34n, windowAt: 35n, fma: 36n,
  });
  // As web/vm.ts listed them before (ABI 71): cntfrq, ticks_per_insn and gic 0.
  const before = [1n, 2n, 0n, 0n, 5n, 6n, 7n, 8n, 9n, 10n, 11n, 0n, 13n, 14n, 15n, 16n, 17n, 18n, 19n, ...seed, 0x404n, ...spill, 33n, 34n, 35n, 36n];
  assert.deepEqual([...words], before);
});
