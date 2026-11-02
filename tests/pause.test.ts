// `pause()` and `resume()` on a VM (docs/platform.md "Pausing", docs/platform.md "Snapshots"),
// in Node: the Buildroot guest on parallel vCPUs paused while it boots, idles and powers off, and
// round-robin, where a pause between runs must not move the deterministic step count. They are races
// by nature: WEBPC_PARALLEL_RUNS repeats the parallel ones (default 1; the pass counts were taken at 10).
// Chromium has one of its own (tests/browser.test.ts).
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { STEPS } from './steps.ts';
import { Devices } from '../web/devices.ts';
import { Exit, GUEST_CMDLINE, PSCI_SYSTEM_OFF, bootVm, guestDevices, type BootOptions, type Vm } from '../web/vm.ts';

const WASM = readFileSync(new URL('../target/wasm32-unknown-unknown/release/webpc_core.wasm', import.meta.url));
const IMAGES = new URL('../target/images/', import.meta.url);
const has = (rel: string) => existsSync(new URL(rel, IMAGES));
const skip = (!has('linux/Image') || !has('buildroot/rootfs.ext4')) && 'SKIPPED: run images/build.sh linux buildroot';
const RUNS = Number(process.env.WEBPC_PARALLEL_RUNS ?? 1);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const buildroot = (extra: Partial<BootOptions> = {}, shell = false): BootOptions => ({
  ramSize: 256 << 20,
  kernel: readFileSync(new URL('linux/Image', IMAGES)),
  cmdline: GUEST_CMDLINE + (shell ? ' -- /bin/sh' : ''),
  devices: guestDevices(new URL('buildroot/rootfs.ext4', IMAGES).href),
  jit: 1,
  ...extra,
});
const parallel = (n = 4, shell = false) => buildroot({ ncpus: n, parallel: true, idleLimitMs: 30_000 }, shell);

type Ctx = { vm: Vm; console: () => string; ended: () => boolean };
type Run = { kind: number; x0: bigint; steps: number; console: string; ms: number };

/**
 * Runs `o` to its end like `runToPowerOff`, and `side` alongside it (a pauser, on this thread's event
 * loop: the run awaits between its steps). `between` runs after each `runAsync`. The end waits for `side`.
 */
async function drive(o: BootOptions, side?: (c: Ctx) => Promise<void>, between?: (vm: Vm) => Promise<void>, limitMs = 90_000): Promise<Run> {
  const vm = await bootVm(WASM, o);
  let console = '';
  let steps = 0;
  let ended = false;
  const t0 = performance.now();
  let failure: unknown;
  const sideDone = side?.({ vm, console: () => console, ended: () => ended }).catch((e) => { failure = e; ended = true; vm.resume(); return e; });
  try {
    for (;;) {
      if (failure) throw failure; // the side's assertion (the VM may be paused for good otherwise)
      assert.ok(performance.now() - t0 < limitMs, `no end in ${limitMs} ms: ${console}`);
      const r = await vm.runAsync(100_000_000);
      steps += r.steps;
      console += vm.drain();
      if (r.kind === Exit.DEVICE) await vm.settle();
      if (between) await between(vm);
      if (r.kind === Exit.BUDGET || r.kind === Exit.TX_FULL || r.kind === Exit.DEVICE) continue;
      ended = true;
      const err = await sideDone;
      if (err) throw err;
      await vm.flush();
      console += vm.drain();
      return { kind: r.kind, x0: r.x[0], steps, console: console.replaceAll('\r\n', '\n'), ms: performance.now() - t0 };
    }
  } finally {
    ended = true;
    await vm.close();
  }
}

/** The pause's contract, checked while paused: nothing runs, the backends are done, STOP is clear. Returns false if the machine ended. */
async function checkedPause(vm: Vm, latencies: number[] = []) {
  const t = performance.now();
  if (!(await vm.pause())) return false;
  latencies.push(performance.now() - t);
  const before = vm.stats().steps;
  const p = vm.paused();
  assert.ok(p.held);
  assert.equal(p.bell[0], p.bell[1], 'the doorbell was rung and not served');
  assert.equal(p.signal & 1, 0, 'STOP is set');
  await sleep(20);
  assert.equal(vm.stats().steps, before, 'a vCPU ran while paused');
  assert.equal(vm.paused().signal & 1, 0, 'STOP is set');
  vm.resume();
  return true;
}

const poweredOff = (r: Run) => {
  assert.equal(r.kind, Exit.PSCI, r.console);
  assert.equal(r.x0, PSCI_SYSTEM_OFF, r.console);
  assert.match(r.console, /webpc: test ok\n/);
};
const booted = /smp: Brought up 1 node, 4 CPUs[^]*webpc: test ok/;

// Each test well under a minute alone: a deadline names the one that hangs (this file's hangs under
// scripts/ci.sh were its process kept up after the tests: docs/testing.md "A test file that never ends").
const TIMEOUT = 120_000;

test('parallel: Buildroot on 4 vCPUs (JIT) boots through 20+ pauses (every 10 ms of running, and at console markers)', { skip, timeout: TIMEOUT }, async () => {
  for (let i = 0; i < RUNS; i++) {
    const latencies: number[] = [];
    let pauses = 0;
    const markers = new Set<string>();
    const r = await drive(parallel(), async ({ vm, console, ended }) => {
      let next = performance.now() + 10;
      while (!ended()) {
        await sleep(5);
        // At a marker (the guest is running: its disk and console traffic), or every 10 ms: the boot takes ~0.7 s
        // on an idle dev VM since the block interpreter's speed-up (every 30 ms left it 12 or 13 pauses).
        const marker = ['Freeing unused kernel', 'Run /init', 'webpc: test'].find((m) => !markers.has(m) && console().includes(m));
        if (!marker && performance.now() < next) continue;
        if (marker) markers.add(marker);
        if (!(await checkedPause(vm, latencies))) break;
        pauses++;
        next = performance.now() + 10;
      }
    });
    assert.ok(pauses >= 20, `${pauses} pauses in ${r.ms} ms`);
    poweredOff(r);
    assert.match(r.console, booted);
    latencies.sort((a, b) => a - b);
    console.log(`# pause: ${pauses} in a ${(r.ms / 1000).toFixed(1)} s boot, latency median ${latencies[latencies.length >> 1]?.toFixed(1)} ms, worst ${latencies.at(-1)?.toFixed(1)} ms; markers ${[...markers].join(', ')}`);
  }
});

test('parallel: a pause returns only once the backends are done with every request (slowed backends, 4 vCPUs, JIT)', { skip, timeout: TIMEOUT }, async () => {
  // The backends run on this thread in Node: slow every doorbell service down by 10 ms, so a ring made
  // just before a vCPU parks is still being served when the vCPUs are all out.
  const poll = Devices.prototype.poll;
  let active = 0;
  Devices.prototype.poll = async function (this: Devices) {
    active++;
    try {
      await poll.call(this);
      await sleep(10);
    } finally {
      active--;
    }
  };
  try {
    let pauses = 0;
    const r = await drive(parallel(), async ({ vm, ended }) => {
      while (!ended()) {
        await sleep(7);
        if (!(await vm.pause())) break;
        assert.equal(active, 0, 'pause() resolved with a backend still serving a request');
        assert.equal(vm.paused().bell[0], vm.paused().bell[1], 'the doorbell was rung and not served');
        pauses++;
        vm.resume();
      }
    });
    assert.ok(pauses >= 10, `${pauses} pauses`);
    poweredOff(r);
  } finally {
    Devices.prototype.poll = poll;
  }
});

test('parallel: a pause while every vCPU is idle, then input wakes the guest (4 vCPUs, JIT)', { skip, timeout: TIMEOUT }, async () => {
  for (let i = 0; i < RUNS; i++) {
    const vm = await bootVm(WASM, parallel(4, true));
    let out = '';
    const t0 = performance.now();
    const until = async (what: RegExp, ms = 30_000) => {
      // By the clock: `runAsync` returns at once while the console has output.
      const end = Math.min(performance.now() + ms, t0 + 90_000);
      while (!what.test(out)) {
        assert.ok(performance.now() < end, `waiting for ${what}: ${out}`);
        const r = await vm.runAsync(100_000_000);
        out += vm.drain();
        assert.ok(r.kind === Exit.BUDGET || r.kind === Exit.TX_FULL, `the guest ended: ${out}`);
      }
    };
    try {
      await until(/# $/);
      // Let every vCPU reach its idle wait (a shell at its prompt has nothing to run), then pause.
      await sleep(300);
      for (let k = 0; k < 3; k++) {
        assert.ok(await checkedPause(vm), 'the pause');
        await sleep(30);
      }
      // Twice is the same pause, and a resume without a pause does nothing.
      assert.ok(await vm.pause());
      assert.ok(await vm.pause());
      assert.ok(vm.paused().held);
      vm.resume();
      vm.resume();
      assert.ok(!vm.paused().held);
      vm.send('echo ping$((20+22))\n');
      await until(/ping42/);
      // Idle again, paused with input already queued: it must run on after the resume.
      await sleep(200);
      assert.ok(await vm.pause());
      vm.send('echo pong$((20+23))\n');
      await sleep(30);
      vm.resume();
      await until(/pong43/);
      vm.send('exit\n');
      for (;;) {
        const r = await vm.runAsync(100_000_000);
        out += vm.drain();
        assert.ok(performance.now() - t0 < 90_000, out);
        if (r.kind === Exit.PSCI) break;
      }
    } finally {
      await vm.close();
    }
  }
});

test('parallel: a pause requested as the guest powers off never hangs and the end is reported (2 vCPUs, JIT)', { skip, timeout: TIMEOUT }, async () => {
  const outcomes: string[] = [];
  for (let i = 0; i < Math.max(RUNS, 4); i++) {
    const delay = [0, 0, 2, 5, 10][i % 5];
    let result: string | Error = 'no pause';
    const r = await drive(parallel(2), async ({ vm, console, ended }) => {
      while (!console().includes('webpc: test exit')) {
        if (ended()) return;
        await sleep(1);
      }
      if (delay) await sleep(delay);
      const p = vm.pause();
      const t = await Promise.race([p.then((v) => `pause ${v}`, (e: Error) => e), sleep(15_000).then(() => 'hung')]);
      result = t;
      if (t === 'pause true') vm.resume();
    });
    outcomes.push(String(result));
    assert.notEqual(result, 'hung');
    assert.ok(result === 'pause true' || result === 'pause false' || result === 'no pause', String(result));
    assert.equal(r.kind, Exit.PSCI, r.console);
    assert.equal(r.x0, PSCI_SYSTEM_OFF, r.console);
    assert.match(r.console, /webpc: test ok\n/);
  }
  console.log(`# pause at the power-off: ${outcomes.join(', ')}`);
});

test('parallel: close() while paused, and while a pause is pending, ends the workers and frees the VM (4 vCPUs, JIT)', { skip, timeout: TIMEOUT }, async () => {
  setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc') as () => void;
  // Each case in a function of its own: a closure that outlived it would keep the VM reachable.
  const closeIt = async (pending: boolean) => {
    const vm = await bootVm(WASM, parallel(4));
    const ref = new WeakRef(vm.memory);
    const t0 = performance.now();
    while (vm.stats().steps < 5_000_000) {
      assert.ok(performance.now() - t0 < 30_000, 'no progress');
      await vm.runAsync(100_000_000);
      vm.drain();
    }
    if (pending) {
      const p = vm.pause();
      const closed = vm.close();
      assert.equal(await p, false);
      await closed;
    } else {
      assert.ok(await vm.pause());
      await vm.close();
      assert.equal(await vm.pause(), false, 'a closed VM');
    }
    return ref;
  };
  const refs = [await closeIt(false), await closeIt(true)];
  // The workers end asynchronously, and the VM's memory is freed once they have.
  for (let i = 0; i < 50 && refs.some((r) => r.deref()); i++) {
    await sleep(100);
    gc();
  }
  assert.equal(refs.filter((r) => r.deref() === undefined).length, 2, 'a paused VM stays reachable (a worker left alive)');
});

for (const [name, n] of [['buildroot', 1], ['buildroot-4cpu', 4]] as const) {
  test(`round-robin: pausing between runs leaves ${name}'s step count exact (JIT, ${n} vCPU${n > 1 ? 's' : ''})`, { skip, timeout: TIMEOUT }, async () => {
    let pauses = 0;
    const r = await drive(buildroot({ ncpus: n }), undefined, async (vm) => {
      assert.ok(await vm.pause());
      assert.ok(await vm.pause());
      vm.resume();
      pauses++;
    }, 180_000);
    assert.equal(r.kind, Exit.PSCI, r.console);
    assert.ok(pauses > 5, `${pauses} pauses`);
    assert.equal(r.steps, STEPS[name]);
    assert.match(r.console, /webpc: test ok\n/);
  });
}
