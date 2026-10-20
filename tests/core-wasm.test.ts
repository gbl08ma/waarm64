// Needs the wasm core built first (scripts/ci.sh does this).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { coreImports, MAX_MEMORY0_RAM, panicMessage, POINTERS, splitError, splitRam, withPanic } from '../web/vm.ts';

const WASM = new URL('../target/wasm32-unknown-unknown/release/webpc_core.wasm', import.meta.url);

test('core instantiates on shared imported memory and uses atomics', () => {
  const mod = new WebAssembly.Module(readFileSync(WASM));
  const mem = new WebAssembly.Memory({ initial: 32, maximum: 65536, shared: true });
  assert.ok(mem.buffer instanceof SharedArrayBuffer);
  const ex = new WebAssembly.Instance(mod, coreImports(mem)).exports as Record<string, (...a: number[]) => number | bigint>;
  assert.equal(ex.abi_version(), 45);
  // Scratch space past the core's own data and stack.
  const scratch = mem.grow(1) * 65536;
  const words = new BigUint64Array(mem.buffer, scratch, 3);
  words.set([1n, 2n, 3n]);
  assert.equal(ex.sum_u64(scratch, 3), 6n);
  const counter = scratch + 64;
  assert.equal(ex.atomic_inc(counter), 0);
  assert.equal(Atomics.load(new Uint32Array(mem.buffer), counter / 4), 1);
});

// A fixed-size memory (ABI 32, web/vm.ts `bootVm`): the host grows its part, the core's heap takes
// the rest, and allocations after it never grow the memory (at its maximum, they'd fail).
test('every export that returns an address is read unsigned', () => {
  // A heap past 2 GiB (a big guest's RAM grows memory 0 first) gives addresses a signed i32 makes negative: an
  // export left out of POINTERS once failed the page with a 2.5 GiB guest.
  const src = ['lib.rs', 'diag.rs'].map((f) => readFileSync(new URL(`../core/src/${f}`, import.meta.url), 'utf8')).join('\n');
  const pointers = [...src.matchAll(/extern "C" fn (\w+)\([^)]*\)\s*->\s*\*/g)].map((m) => m[1]);
  assert.ok(pointers.length > 10, 'the exports were found');
  const missing = pointers.filter((p) => !POINTERS.includes(p));
  assert.equal(missing.join(' '), '', 'not in web/vm.ts POINTERS');
});

test('heap_reserve makes the core\'s heap the rest of a fixed-size memory', () => {
  const PAGES = 1024;
  const mem = new WebAssembly.Memory({ initial: 32, maximum: PAGES, shared: true } as WebAssembly.MemoryDescriptor);
  const ex = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(WASM)), coreImports(mem)).exports as Record<string, (...a: number[]) => number>;
  mem.grow(100); // the host's part (RAM)
  assert.equal(ex.heap_reserve(mem.grow(0) + 2), 0, 'no room for a reserve');
  const pages = ex.heap_reserve(PAGES);
  assert.ok(pages > PAGES - 3 && pages <= PAGES, `${pages} pages`);
  mem.grow(PAGES - pages);
  const end = PAGES * 65536;
  for (let i = 0; i < 6; i++) {
    const at = ex.thread_alloc(8 << 20, 16) >>> 0;
    assert.ok(at && at + (8 << 20) <= end, `allocation ${i} at ${at}`);
  }
  assert.equal(mem.buffer.byteLength, end);
  assert.equal(ex.thread_alloc(64 << 20, 16), 0, 'past the reserve');
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
  new BigUint64Array(mem.buffer, cfg, 10).set([BigInt(RAM), 1n, 0n, 0n, 0n, 0n, 640n, 480n, 0n, 8n]); // bits 0–2 are features (ABI 35)
  assert.equal(ex.vm_new(ram, BigInt(RAM), cfg), 0, 'a reserved feature bit is rejected');
  new BigUint64Array(mem.buffer, cfg, 12).set([BigInt(RAM), 1n, 0n, 0n, 0n, 0n, 640n, 480n, 0n, 0n, 1n, 2n]);
  assert.equal(ex.vm_new(ram, BigInt(RAM), cfg), 0, 'no GICv2 (ABI 23)');
  new BigUint64Array(mem.buffer, cfg, 13).set([BigInt(RAM), 1n, 0n, 0n, 0n, 0n, 640n, 480n, 0n, 0n, 2n, 0n, 1n]);
  assert.equal(ex.vm_new(ram, BigInt(RAM), cfg), 0, 'parallel SMP needs realtime (ABI 25)');
  // The firmware configuration (ABI 29): a valid flash bank and the RTC, or neither of them; a well-formed fw_cfg buffer.
  const fw = (firmware: bigint, flash: bigint, rtc: bigint, fwCfgLen = 0n) =>
    new BigUint64Array(mem.buffer, cfg, 18).set([BigInt(RAM), 1n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 1n, 0n, 0n, rtc, firmware, flash, BigInt(cfg + 1024), fwCfgLen]);
  fw(1n, 0n, 1n);
  assert.equal(ex.vm_new(ram, BigInt(RAM), cfg), 0, 'firmware without a flash bank');
  fw(1n, 1n << 20n, 0n);
  assert.equal(ex.vm_new(ram, BigInt(RAM), cfg), 0, 'firmware without the RTC');
  fw(1n, (1n << 20n) + 4096n, 1n);
  assert.equal(ex.vm_new(ram, BigInt(RAM), cfg), 0, 'a flash bank of part of a block');
  fw(0n, 1n << 20n, 0n);
  assert.equal(ex.vm_new(ram, BigInt(RAM), cfg), 0, 'a flash bank without the firmware');
  fw(1n, 1n << 20n, 1n, 10n);
  assert.equal(ex.vm_new(ram, BigInt(RAM), cfg), 0, 'a truncated fw_cfg buffer');
  fw(1n, 1n << 20n, 1n);
  const fwVm = ex.vm_new(ram, BigInt(RAM), cfg);
  assert.notEqual(fwVm, 0);
  const flash = ex.vm_flash(fwVm) >>> 0;
  assert.notEqual(flash, 0);
  assert.ok(new Uint8Array(mem.buffer, flash, 1 << 20).every((b) => b === 0xff), 'the bank starts erased');
  ex.vm_free(fwVm);
  new BigUint64Array(mem.buffer, cfg, 18).fill(0n);
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
  // A panic in the core arrives with its message (ABI 27): vm_run_cpu on a round-robin VM asserts.
  assert.equal(panicMessage(ex as unknown as WebAssembly.Exports, mem), undefined);
  let trap: unknown;
  try {
    (ex as unknown as Record<string, (...a: (number | bigint)[]) => number>).vm_run_cpu(vm, 0, 1n);
  } catch (e) {
    trap = e;
  }
  assert.ok(trap instanceof WebAssembly.RuntimeError, String(trap));
  void (trap as Error).stack; // as a debugger or console may have: V8 fixes the stack then
  const e = withPanic(trap, ex as unknown as WebAssembly.Exports, mem);
  assert.match(e.message, /core panic: .*vm_run_cpu in round-robin mode/s);
  // The vCPU worker reports the stack.
  assert.match(String(e.stack), /core panic: .*vm_run_cpu in round-robin mode/s);
});

// Spill memories (ABI 39, docs/spill-memories.md): RAM past memory 0 in another memory, which
// the core reaches through web/spill.ts. The program in memory 0 stores, loads, takes an exclusive
// pair, an LSE add and a DC ZVA in the spill memory, then branches to code there; under the
// interpreter, the block interpreter and JIT-stress (whose inline accesses miss on spill pages).
for (const jit of [0, 4, 2]) {
  test(`a spill memory's RAM end to end (jit ${jit})`, () => {
    const mem = new WebAssembly.Memory({ initial: 32, maximum: 65536, shared: true });
    const spill = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
    const imports = coreImports(mem, undefined, undefined, undefined, [spill]);
    const instance = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(WASM)), imports);
    imports.jit.bind(instance);
    const ex = instance.exports as Record<string, (...a: (number | bigint)[]) => number>;
    const RAM = 1 << 20;
    const SPILL = 0x8000_0000n; // the GiB boundary past memory 0's RAM
    const ram = mem.grow(RAM / 65536) * 65536;
    const prog = [0xf9000001, 0xf9400002, 0xc85f7c03, 0xc8047c01, 0xf8210008, 0xd50b7427, 0xd61f00a0];
    new Uint32Array(mem.buffer, ram, prog.length).set(prog);
    const s32 = new Uint32Array(spill.buffer);
    s32.set([0x910004c6, 0x14000000], 0x100 / 4); // add x6, x6, #1; b .
    new BigUint64Array(spill.buffer, 0x40, 8).fill(~0n);
    const cfg = mem.grow(1) * 65536;
    const words = new BigUint64Array(mem.buffer, cfg, 32);
    words.set([BigInt(RAM), 1n, 0n, 0n, 0n, 0n, 0n, 0n, BigInt(jit)]);
    words[24] = 65537n;
    assert.equal(ex.vm_new(ram, BigInt(RAM), cfg), 0, 'a spill size of part of a page is rejected');
    words[24] = 0n;
    words[25] = 65536n;
    assert.equal(ex.vm_new(ram, BigInt(RAM), cfg), 0, 'a spill size after a 0 is rejected');
    words[24] = 65536n;
    words[25] = 0n;
    const vm = ex.vm_new(ram, BigInt(RAM), cfg);
    assert.notEqual(vm, 0);
    const x = new BigUint64Array(mem.buffer, ex.vm_cpu(vm, 0), 32);
    [x[0], x[1], x[5], x[7]] = [SPILL + 8n, 0x1234n, SPILL + 0x100n, SPILL + 0x40n];
    assert.equal(ex.vm_run(vm, 20n), 0);
    const pc = new BigUint64Array(mem.buffer, ex.vm_cpu(vm, 0) + 256, 1)[0];
    assert.equal(pc, SPILL + 0x104n);
    assert.deepEqual([x[2], x[3], x[4], x[6], x[8]], [0x1234n, 0x1234n, 0n, 1n, 0x1234n]);
    assert.equal(new BigUint64Array(spill.buffer, 8, 1)[0], 0x2468n);
    assert.ok(new BigUint64Array(spill.buffer, 0x40, 8).every((v) => v === 0n), 'DC ZVA zeroed the block');
    ex.vm_free(vm);
  });
}

// The page's split of a machine's RAM: memory 0 as large as the heap's floor leaves (1 MiB kept for the scratch page and
// fw_cfg's files), then spill memories of up to 4 GiB; and the checks on a split a user sets.
test('guest RAM splits into memory 0 and spill memories', () => {
  const [M, G] = [2 ** 20, 2 ** 30];
  assert.equal(MAX_MEMORY0_RAM, 3 * G - M);
  assert.deepEqual(splitRam(2 * G), { ramSize: 2 * G, spill: [] });
  assert.deepEqual(splitRam(3 * G - M), { ramSize: 3 * G - M, spill: [] });
  assert.deepEqual(splitRam(4 * G), { ramSize: 3 * G - M, spill: [G + M] });
  assert.deepEqual(splitRam(12 * G), { ramSize: 3 * G - M, spill: [4 * G, 4 * G, G + M] });
  assert.throws(() => splitRam(40 * G), RangeError);
  assert.equal(splitError(2 * G, [G, 4 * G]), undefined);
  assert.match(splitError(3 * G, [])!, /at most 3071 MiB/);
  assert.match(splitError(32 * M, [])!, /at least 64 MiB/);
  assert.match(splitError(G, [5 * G])!, /1 to 4096 MiB/);
  assert.match(splitError(G, Array(9).fill(G))!, /at most 8/);
});
