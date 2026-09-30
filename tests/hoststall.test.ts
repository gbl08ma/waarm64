// BUG1's host-stall test (BUG1-HANDOVER.md): while vCPU 0 waits in a DSB for its
// TLBI IS, vCPU 1's host worker stalls (a test-only hook, web/vm.ts `Stall`; the
// guests are tests/hoststall/stall.c). Parallel SMP, the JIT, real workers in
// Node. Needs the wasm build.
// - Stalled while RUN (inside `vm_run_cpu`: at the core's clock import between
//   chunks, or at `jit_install` in the middle of one): vCPU 0's DSB can't finish, and
//   at the DSB limit (10 s, `parallel.rs` DSB_LIMIT_NS) the core panics with the
//   report of what it waited for; the host gets it as the error's message.
// - Stalled while OUT (after `vm_run_cpu` returned IDLE): the DSB doesn't wait.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Exit, PSCI_SYSTEM_OFF, runToPowerOff, type Stall } from '../web/vm.ts';

const WASM = readFileSync(new URL('../target/wasm32-unknown-unknown/release/webpc_core.wasm', import.meta.url));
const FLAG = 0x40800000; // stall.c's FLAG (a guest PA)

const boot = (name: string, stall: Stall | Stall[]) =>
  runToPowerOff(WASM, {
    ramSize: 16 << 20, kernel: readFileSync(new URL(`hoststall/stall-${name}.bin`, import.meta.url)), kernelOffset: 0, cmdline: '',
    ncpus: 2, parallel: true, jit: 1, idleLimitMs: 30_000, stall,
  }, 1e12);

for (const on of ['clock', 'install'] as const) {
  test(`host stall: vCPU 1 blocked in its ${on === 'clock' ? 'clock' : 'jit_install'} import (RUN) while vCPU 0 waits in a DSB: the wait ends with the report`, { timeout: 90_000 }, async () => {
    const t0 = performance.now();
    const err = await boot(on === 'clock' ? 'run' : 'install', { cpu: 1, on, addr: FLAG, ms: 20_000 }).then(() => undefined, (e: Error) => e);
    const s = (performance.now() - t0) / 1000;
    assert.ok(err, 'the run ended without an error');
    const m = String(err.stack ?? err);
    assert.match(m, /^Error: vCPU 0: /, m); // the waiting vCPU panicked, not the stalled one
    assert.match(m, /core panic: .*vCPU 0: DSB waited 10 s for TLBI IS/s, m);
    // The waited vCPU: RUN (1), nothing applied, the retired count and PC as it froze, the lock's state.
    assert.match(m, /vCPU 1: state 1 applied 0 waited-for 1 queued 1 \(queue: 1 tlb, 0 ic, all false\/false\) pending true waiting false retired (\d+) -> \1 pc (0x[0-9a-f]+) -> \2\n/, m);
    assert.match(m, /waiter: 1\d{4} ms waiting of 1\d{4} ms wall; passes over 100 ms \(its own thread stalled\): 0 ms/, m);
    assert.match(m, /platform lock free/, m);
    // After the DSB limit, not before or long after (the stall lasts 20 s).
    assert.ok(s > 9 && s < 19, `${s.toFixed(1)} s`);
  });
}

test('host stall: vCPU 1 blocked in the host while OUT (idle): vCPU 0\'s DSB does not wait', { timeout: 60_000 }, async () => {
  const r = await boot('idle', { cpu: 1, on: 'idle', addr: FLAG, ms: 3_000 });
  assert.equal(r.kind, Exit.PSCI, r.console);
  assert.equal(r.x[0], PSCI_SYSTEM_OFF, r.console);
  assert.equal(r.x[1], 0n, r.console); // stall.c checks the DSB took under half a second
});

// The waiting vCPU's own worker stalls for longer than the DSB limit in the middle of the wait, while the
// vCPU it waits for is healthy (frozen for 13 s, then draining): not a deadlock. The wait counts the
// time it spent waiting (parallel.rs DsbBudget), so it ends when vCPU 1 does, without the panic.
test('host stall: the waiting vCPU\'s own worker stalls past the DSB limit: no panic, the DSB returns once vCPU 1 does', { timeout: 90_000 }, async () => {
  const t0 = performance.now();
  const r = await boot('waiter', [
    { cpu: 1, on: 'clock', addr: FLAG, ms: 13_000 },
    { cpu: 0, on: 'clock', addr: FLAG, arm: 2, after: 100, ms: 11_000 },
  ]);
  const s = (performance.now() - t0) / 1000;
  assert.equal(r.kind, Exit.PSCI, r.console);
  assert.equal(r.x[1], 0n, r.console); // 22: the DSB didn't wait 10 s; 21 and 11: the hooks didn't run as planned
  assert.ok(s > 12.5 && s < 30, `${s.toFixed(1)} s`);
});
