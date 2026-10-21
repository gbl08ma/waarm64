// The core's heap stays bounded however much new code a guest runs (docs/jit.md "Memory"): the desktop guest's
// crash of 2026-10-21, `rust_oom` in the JIT's block map after 15 minutes of Firefox and Chromium, in a minute. The
// guest is nothing but `b .+4`, so every word is a block that runs once (millions of keys, as a session's worth of
// JavaScript engines' code), in a heap reserve of 320 MiB instead of 1 GiB. Before the bound the block map's doubling
// to 2^23 buckets (328 MiB) ran it out at ~3.7M keys; the decoded blocks' map, with a key per micro-op, did too.
// WEBPC_WASM runs another core (the repro: a build from before the fix).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Exit, PSCI_SYSTEM_OFF, runToPowerOff, type Vm } from '../web/vm.ts';

const WASM = readFileSync(process.env.WEBPC_WASM ?? new URL('../target/wasm32-unknown-unknown/release/webpc_core.wasm', import.meta.url));
const MiB = 1 << 20;

/** `n` words of `b .+4`, then PSCI SYSTEM_OFF (movz x0, #8; movk x0, #0x8400, lsl #16; hvc #0). */
function branches(n: number) {
  const w = new Uint32Array(n + 3);
  w.fill(0x1400_0001, 0, n);
  w.set([0xd280_0100, 0xf2b0_8000, 0xd400_0002], n);
  return new Uint8Array(w.buffer);
}

test('8M blocks run once fit a 320 MiB heap', { timeout: 240_000 }, async () => {
  let vm: Vm | undefined;
  const blocks = 8 << 20;
  const r = await runToPowerOff(WASM, { ramSize: 64 * MiB, kernel: branches(blocks), cmdline: '', jit: 1, heapReserve: 320 * MiB }, 1e9, (v) => (vm = v));
  assert.equal(r.kind, Exit.PSCI, r.console);
  assert.equal(r.x[0], PSCI_SYSTEM_OFF);
  assert.equal(r.steps, blocks + 3);
  const use = vm!.hostUse();
  const j = r.stats.jit;
  console.log(`heap ${(use.heapLive / MiB).toFixed(0)} MiB live, ${(use.heapPeak / MiB).toFixed(0)} at most; ${use.jitKeys} keys (${(use.jitKeyBytes / MiB).toFixed(0)} MiB); ${j.prunes} prunes, ${j.decClears} decoded starts over, ${j.rescues} rescues, ${j.flushes} flushes`);
  assert.ok(j.prunes >= 4, `${j.prunes} prunes`);
  assert.ok(use.jitKeyBytes <= 50 * MiB);
  assert.equal(j.rescues, 0);
  assert.ok(use.heapPeak < 300 * MiB, `${use.heapPeak} bytes at most`);
});

// The safety net: in a heap too small for the bounded maps, a map that can't grow flushes the cache (or starts a
// table's decoded blocks over) and frees its table whole, instead of trapping.
test('in a 64 MiB heap the maps give their memory back', { timeout: 240_000 }, async () => {
  const blocks = 4 << 20;
  const r = await runToPowerOff(WASM, { ramSize: 64 * MiB, kernel: branches(blocks), cmdline: '', jit: 1, heapReserve: 64 * MiB }, 1e9);
  assert.equal(r.kind, Exit.PSCI, r.console);
  assert.equal(r.steps, blocks + 3);
  assert.ok(r.stats.jit.rescues > 0 && r.stats.jit.flushes > 0, `${r.stats.jit.rescues} rescues`);
});
