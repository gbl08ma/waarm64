// Parallel SMP's polled code (PERF loop 31; docs/jit.md "Preemption", docs/testing.md "Spin tests"): a vCPU looping in
// compiled code with no exits takes its timer's IRQ, another vCPU's IPI and TLBI IS, and stops for the host's pause,
// each in bounded time. tests/baremetal/spin.c spins CPU 1 in twelve shapes (one block, a 20-block chain, BR, the transfer
// cache's miss function, a by-VA link, VA aliases, nested calls, the debug interpreter, a loop with no memory access,
// one page at successive VAs whose region edge goes down in PA, three times) at EL1 with the MMU off and on and at EL0, and prints the medians it timed; this
// file pauses the machine while CPU 1 spins and holds the numbers to bounds. Each JIT mode (JIT; JIT-stress and JIT-check in scripts/ci-jit.sh) runs twice: with the default
// chunk (the timer's bound is the chunk's steps, as before the stop word), and with chunks of 2^30 steps
// (`vm_set_chunk`), where only the stop word's setters end one early, so a missing setter shows as milliseconds (a
// `vm_run_cpu` call's 100M steps) instead of microseconds. A missing poll hangs the shape: the run fails at `MAX_MS`.
// Each of those runs twice more (PERF loop 55): counted (`count`: polled code with `acc`, the status bar's MIPS on)
// and without `acc` (the default), where the ticker (web/ticker-worker.ts) ends the chunks: at the spinner's timer
// deadline and every period (1 ms; with `vm_set_chunk`'s 2^30, 2^30 ns), so with long chunks the timer's bound is the
// ticker's deadline alone.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { jitVariantSkip } from './jit-variants.ts';
import type { BootOptions } from '../web/vm.ts';
import { runToPowerOff } from '../web/test-guests.ts';

// `WAARM64_CORE` (a path from the repo's root): another core (an A/B's base, say).
const WASM = readFileSync(new URL(`../${process.env.WAARM64_CORE ?? 'target/wasm32-unknown-unknown/release/waarm64_core.wasm'}`, import.meta.url));
const KERNEL = readFileSync(new URL('baremetal/spin.bin', import.meta.url));
/** spin.c's host words (guest PA 0x40a0_0000: the phase, the host's hello, the release) and its phase's value. */
const HOST = 0xa0_0000, PHASE_STOP = 0x5709n;
const PAUSES = 8;
/** spin.c's pings a shape. */
const ROUNDS = 8;
/** The medians' bounds (µs): the median over the shapes' runs (`LINES`), and the worst one's. Typical: tens of µs. */
const MEDIAN_US = 1000, WORST_US = 50_000;
/** The pauses' (ms): the median of `PAUSES`. */
const PAUSE_MS = 5;
/** spin.c's shapes: 12 forms at 3 ELs and MMU settings, but the aliases (shapes 5 and 9-11) with the MMU off. */
const LINES = 12 * 3 - 4;
const MAX_MS = Number(process.env.WAARM64_SPIN_MAX_MS ?? 60_000);

type Line = { env: string; form: string; rtt: number; tlbi: number; timer: number; inside: number };

const opts = (jit: 1 | 2 | 3 | 4, count: boolean): BootOptions => ({ ramSize: 16 << 20, kernel: KERNEL, kernelOffset: 0, cmdline: '', ncpus: 2, parallel: true, idleLimitMs: 30_000, jit, count });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function run(jit: 1 | 2 | 3 | 4, long: boolean, count: boolean) {
  let host!: Promise<number[]>;
  const r = await runToPowerOff(WASM, opts(jit, count), 1e12, (vm) => {
    if (long) vm.setChunk(2 ** 30);
    const words = () => new BigUint64Array(vm.memory.buffer, vm.ram + HOST, 3);
    // The host's side of the stop phase: say hello, time the pauses while CPU 1 spins, release it.
    host = (async () => {
      const t0 = performance.now();
      while (Atomics.load(words(), 0) !== PHASE_STOP) {
        if (performance.now() - t0 > MAX_MS) throw new Error('no stop phase');
        await sleep(1);
      }
      Atomics.store(words(), 1, 1n);
      const ms: number[] = [];
      for (let i = 0; i < PAUSES; i++) {
        await sleep(2);
        const t = performance.now();
        assert.equal(await vm.pause(), true);
        ms.push(performance.now() - t);
        vm.resume();
      }
      Atomics.store(words(), 2, 1n);
      return ms;
    })();
    host.catch(() => {}); // a run that failed first reports that

  }, undefined, MAX_MS);
  assert.equal(r.x[1], 0n, r.console);
  const pauses = await host;
  const lines: Line[] = [...r.console.matchAll(/^spin (\S+) (\S+) rtt (\d+) tlbi (\d+) timer (\d+) inside (\d+)$/gm)].map((m) => ({ env: m[1], form: m[2], rtt: +m[3], tlbi: +m[4], timer: +m[5], inside: +m[6] }));
  assert.equal(lines.length, LINES, r.console);
  return { lines, pauses };
}

function bounded(what: string, xs: number[], all: string) {
  assert.ok(median(xs) <= MEDIAN_US && Math.max(...xs) <= WORST_US, `${what}: median ${median(xs)} µs, worst ${Math.max(...xs)} µs (bounds ${MEDIAN_US}, ${WORST_US})\n${all}`);
}

/** The bounds on one run's numbers. */
function check({ lines, pauses }: { lines: Line[]; pauses: number[] }, jit: 1 | 2 | 3 | 4, long: boolean, count: boolean) {
  const all = lines.map((l) => `${l.env} ${l.form}: rtt ${l.rtt} tlbi ${l.tlbi} timer ${l.timer} inside ${l.inside}`).join('\n') + `\npauses (ms): ${pauses.map((p) => p.toFixed(2)).join(' ')}`;
  if (process.env.WAARM64_SPIN_PRINT) console.log(all);
  bounded('IPI round trip', lines.map((l) => l.rtt), all);
  bounded('TLBI IS + DSB', lines.map((l) => l.tlbi), all);
  // Where the pings were taken in the aliases and the nested calls: at polls along the way, not only at their laps'
  // checks (a forward by-VA link, a callee's return, a region's edge to a lower PA in the next VA page, that didn't
  // poll).
  for (const l of lines.filter((l) => l.form === 'alias' || l.form === 'calls' || l.form === 'xpage')) assert.ok(l.inside >= ROUNDS / 2, `${l.env} ${l.form}: ${l.inside} of ${ROUNDS} pings taken inside the shape\n${all}`);
  // Counted, the timer has no setter: its bound is the chunk's steps (with long chunks, spin.c's ping after 50 ms), whose
  // time JIT-check's checker (a hash at every transfer) stretches to milliseconds. Without `acc` its setter is the
  // ticker's store at the deadline, whatever the chunk.
  if ((!long && jit === 1) || (!count && jit !== 3)) bounded("the spinner's own timer, late", lines.map((l) => l.timer), all);
  assert.ok(median(pauses) <= PAUSE_MS, `pause: median ${median(pauses).toFixed(2)} ms (bound ${PAUSE_MS})\n${all}`);
}

// The block interpreter alone (`VmConfig.jit` 4: the dispatcher never compiles) in scripts/ci-jit.sh too: interpreted
// code reads no stop word, so the dispatcher interprets at most a default chunk's steps between its looks at it.
for (const [mode, jit] of [['JIT', 1], ['JIT-stress', 2], ['JIT-check', 3], ['the block interpreter', 4]] as const) {
  for (const count of [true, false]) {
    for (const long of [false, true]) {
      test(`spin: a looping vCPU takes its IRQs, answers TLBI IS and pauses (${mode}${count ? ', counted' : ''}${long ? ', 2^30-step chunks' : ''})`, { skip: jit !== 1 && jitVariantSkip }, async (t) => {
        // Once more when it misses a bound: a loaded host (scripts/ci.sh's files side by side) once put the IPI round trips'
        // median at 2 ms, every shape alike; a missing poll misses them in every run.
        try {
          check(await run(jit, long, count), jit, long, count);
        } catch (e) {
          if (!(e instanceof assert.AssertionError)) throw e;
          t.diagnostic(`missed a bound, run again: ${e.message.split('\n')[0]}`);
          check(await run(jit, long, count), jit, long, count);
        }
      });
    }
  }
}
