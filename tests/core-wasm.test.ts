// Needs the wasm core built first (scripts/ci.sh does this).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { coreImports } from '../web/vm.ts';

const WASM = new URL('../target/wasm32-unknown-unknown/release/webpc_core.wasm', import.meta.url);

test('core instantiates on shared imported memory and uses atomics', () => {
  const mod = new WebAssembly.Module(readFileSync(WASM));
  const mem = new WebAssembly.Memory({ initial: 32, maximum: 65536, shared: true });
  assert.ok(mem.buffer instanceof SharedArrayBuffer);
  const ex = new WebAssembly.Instance(mod, coreImports(mem)).exports as Record<string, (...a: number[]) => number | bigint>;
  assert.equal(ex.abi_version(), 25);
  // Scratch space past the core's own data and stack.
  const scratch = mem.grow(1) * 65536;
  const words = new BigUint64Array(mem.buffer, scratch, 3);
  words.set([1n, 2n, 3n]);
  assert.equal(ex.sum_u64(scratch, 3), 6n);
  const counter = scratch + 64;
  assert.equal(ex.atomic_inc(counter), 0);
  assert.equal(Atomics.load(new Uint32Array(mem.buffer), counter / 4), 1);
});

test('interpreter runs the integer benchmark guest through the vCPU exports', async () => {
  const { setup } = await import('../bench/interp/suite.ts');
  const g = await setup();
  assert.equal(g.run(3_000_000), 3_000_000, `stopped at pc 0x${g.pc().toString(16)}`);
  assert.ok(g.rounds() > 0n);
});

test('interpreter runs the FP/NEON benchmark guest', async () => {
  const { setup } = await import('../bench/interp/suite.ts');
  const g = await setup('guest-fp.bin');
  assert.equal(g.run(5_000_000), 5_000_000, `stopped at pc 0x${g.pc().toString(16)}`);
  assert.ok(g.rounds() > 0n);
});

for (const mmu of [false, true]) {
  test(`whole VM runs the integer benchmark guest at EL1, MMU ${mmu ? 'on' : 'off'}`, async () => {
    const { setupVm } = await import('../bench/interp/suite.ts');
    const g = await setupVm(mmu);
    assert.equal(g.run(3_000_000), 3_000_000, `stopped at pc 0x${g.pc().toString(16)}`);
    assert.ok(g.rounds() > 0n);
  });
}

test('whole VM boots a bare-metal test through the vm_* exports (ABI 8)', () => {
  const mem = new WebAssembly.Memory({ initial: 32, maximum: 65536, shared: true });
  const ex = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(WASM)), coreImports(mem)).exports as Record<
    string,
    (...a: (number | bigint)[]) => number
  >;
  const RAM = 16 << 20;
  const ram = mem.grow(RAM / 65536) * 65536;
  const img = readFileSync(new URL('./baremetal/uart.bin', import.meta.url));
  new Uint8Array(mem.buffer, ram, img.length).set(img);
  const cfg = mem.grow(1) * 65536; // VmConfig: ram_size, deterministic, cntfrq, ticks_per_insn, devices, ndevices, fb_width, fb_height, jit, features (0)
  new BigUint64Array(mem.buffer, cfg, 8).set([BigInt(RAM), 1n, 0n, 0n, 0n, 33n, 0n, 0n]);
  assert.equal(ex.vm_new(ram, BigInt(RAM), cfg), 0, 'more than 32 devices is rejected');
  new BigUint64Array(mem.buffer, cfg, 8).set([BigInt(RAM), 1n, 0n, 0n, 0n, 0n, 2048n, 2048n]);
  assert.equal(ex.vm_new(ram, BigInt(RAM), cfg), 0, 'a framebuffer over half of RAM is rejected');
  new BigUint64Array(mem.buffer, cfg, 10).set([BigInt(RAM), 1n, 0n, 0n, 0n, 0n, 640n, 480n, 0n, 2n]);
  assert.equal(ex.vm_new(ram, BigInt(RAM), cfg), 0, 'a reserved feature bit is rejected');
  new BigUint64Array(mem.buffer, cfg, 12).set([BigInt(RAM), 1n, 0n, 0n, 0n, 0n, 640n, 480n, 0n, 0n, 1n, 2n]);
  assert.equal(ex.vm_new(ram, BigInt(RAM), cfg), 0, 'no GICv2 (ABI 23)');
  new BigUint64Array(mem.buffer, cfg, 13).set([BigInt(RAM), 1n, 0n, 0n, 0n, 0n, 640n, 480n, 0n, 0n, 2n, 0n, 1n]);
  assert.equal(ex.vm_new(ram, BigInt(RAM), cfg), 0, 'parallel SMP needs realtime (ABI 25)');
  // …, ncpus 1, the GICv3, round-robin.
  new BigUint64Array(mem.buffer, cfg, 13).set([BigInt(RAM), 1n, 0n, 0n, 0n, 0n, 640n, 480n, 0n, 0n, 1n, 0n, 0n]);
  const vm = ex.vm_new(ram, BigInt(RAM), cfg);
  assert.notEqual(vm, 0);
  assert.equal(BigInt(ex.vm_framebuffer(vm)), 0x4000_0000n + BigInt(RAM) - (4n << 20n), 'the framebuffer sits below the DTB space');

  // Drain the console TX ring (head at 0, tail at 4, bytes at 8).
  const tx = ex.vm_console(vm);
  let out = '';
  const drain = () => {
    const u32 = new Uint32Array(mem.buffer);
    const head = Atomics.load(u32, tx / 4);
    const buf = new Uint8Array(mem.buffer, tx + 8, 4096);
    for (let tail = Atomics.load(u32, tx / 4 + 1); tail !== head; tail = (tail + 1) >>> 0) out += String.fromCharCode(buf[tail % 4096]);
    Atomics.store(u32, tx / 4 + 1, head);
  };
  let kind = 0;
  for (let i = 0; i < 20 && (kind === 0 || kind === 3); i++) {
    kind = ex.vm_run(vm, 10_000_000n);
    drain();
  }
  const exit = new BigUint64Array(mem.buffer, ex.vm_exit(vm), 7); // kind, steps, value, x0-x3
  assert.equal(kind, 1, `exit ${kind}, console ${JSON.stringify(out)}`);
  assert.deepEqual([exit[0], exit[3], exit[4]], [1n, 0x84000008n, 0n]); // PSCI SYSTEM_OFF, code 0
  assert.match(out, /^hello from the PL011\n\.\nexit 0\n$/);
  const counters = new BigUint64Array(mem.buffer, ex.vm_counters(vm, 0), 71);
  assert.ok(Atomics.load(counters, 0) >= exit[1] && exit[1] > 100n, 'steps counted');
  assert.equal(Atomics.load(counters, 65), 1n, 'one IRQ');
  ex.vm_free(vm);
});
