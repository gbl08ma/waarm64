// Whole-VM guests on the wasm core in Node, deterministic, under the
// interpreter and the JIT: each JIT run must take exactly the interpreter's
// steps (tests/steps.txt for the guest images) and print exactly its console.
// Buildroot's root filesystem is a `file:` virtio-blk (web/devices.ts
// `fileSource`). docs/testing.md has where each guest runs and why.
// - Short guests (the bare-metal tests, kvm-unit-tests, Buildroot and its
//   device test): the interpreter, then the JIT against it. JIT-stress only for
//   the bare-metal tests and kvm-unit-tests `cache` (its IC maintenance), since
//   a 4-block cache compiles on most dispatches; WEBPC_JIT_STRESS=1 runs the rest.
// - Long guests (LTP and kselftests, the crypto test kernel, Alpine, Alpine's
//   userspace benchmark): the JIT only, against tests/steps.txt. Their
//   interpreter runs are native (core/tests: ltp.rs, distros.rs), or here with
//   WEBPC_INTERP=1 (the crypto kernel has no native runner: ~100 s in Node).
// - Alpine and its userspace benchmark only with WEBPC_DISTROS=alpine,alpine-user
//   (scripts/ci.sh sets it when their images are current).
// - Parallel SMP (a worker per vCPU, realtime: not reproducible): the
//   bare-metal tests, Buildroot and (with WEBPC_DISTROS=alpine) Alpine, each
//   WEBPC_PARALLEL_RUNS times (default 3), every run must pass.
// Needs the wasm build; the guests that need target/images skip without them.
// Four files define these tests, each a part picked by name, so that they run side by side
// (node --test runs files in parallel, a file's tests in sequence): boot-node.test.ts (bare metal,
// kvm-unit-tests), boot-node-linux.test.ts, boot-node-parallel.test.ts, boot-node-litmus.test.ts.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { test as nodeTest } from 'node:test';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { checkSndGuest } from './snd/guest.ts';
import { USB_CMDLINE, USB_HUBS_CMDLINE, USB_INITRD, USB_KERNEL, checkUsbGuest, checkUsbHubs, usbGuest } from './usb/guest.ts';
import { STEPS } from './steps.ts';
import { CONSOLE_INPUT, CONSOLE_INPUT_STEP, CONSOLE_INPUT_WANT, DISTROS, Exit, GUEST_CMDLINE, PSCI_SYSTEM_OFF, bootVm, guestDevices, runToPowerOff, testDevices, type BootOptions, type ConsoleInput } from '../web/vm.ts';

const part = (globalThis as { bootNodePart?: (name: string) => boolean }).bootNodePart ?? (() => true);
const test = ((name: string, ...rest: unknown[]) => {
  if (part(name)) (nodeTest as (...a: unknown[]) => unknown)(name, ...rest);
}) as typeof nodeTest;

const WASM = readFileSync(new URL('../target/wasm32-unknown-unknown/release/webpc_core.wasm', import.meta.url));
const IMAGES = new URL('../target/images/', import.meta.url);
const image = (rel: string) => readFileSync(new URL(rel, IMAGES));
const has = (rel: string) => existsSync(new URL(rel, IMAGES));
const STRESS = process.env.WEBPC_JIT_STRESS === '1';
const INTERP = process.env.WEBPC_INTERP === '1';
// The heaviest multi-vCPU runs need WEBPC_LONG_TESTS=1, which scripts/ci.sh sets (a plain npm test leaves them out).
const longSkip = process.env.WEBPC_LONG_TESTS !== '1' && 'SKIPPED: scripts/ci.sh runs it (WEBPC_LONG_TESTS=1)';
const DISTRO_TESTS = (process.env.WEBPC_DISTROS ?? '').split(',').filter(Boolean);

type Run = Awaited<ReturnType<typeof runToPowerOff>>;
const boot = (o: BootOptions, jit: 0 | 1 | 2 | 3, max = 20e9, input?: ConsoleInput) => runToPowerOff(WASM, { ...o, jit }, max, undefined, input);
const summary = (r: Run) => ({ kind: r.kind, x0: r.x[0], x1: r.x[1], steps: r.steps, console: r.console, hvc: r.hvc, gpu: r.gpu, snd: r.snd });

/**
 * Boots `o` on the interpreter, checks it with `check`, then under the JIT and
 * JIT-stress (unless `stress` is false) and requires the same run. A long guest
 * (`interp: false`) skips the interpreter unless WEBPC_INTERP=1: its JIT runs
 * are checked with `check` and against `steps` alone.
 */
function guest(name: string, o: () => BootOptions, check: (r: Run) => void, { skip = false as string | false, stress = true, max = 20e9, steps = 0, interp = true, input = undefined as ConsoleInput | undefined } = {}) {
  let want: Run | undefined;
  test(`${name}: interpreter`, { skip: skip || (!interp && !INTERP && 'SKIPPED: set WEBPC_INTERP=1') }, async () => {
    want = await boot(o(), 0, max, input);
    check(want);
    if (steps) assert.equal(want.steps, steps);
  });
  for (const [mode, jit] of [['JIT', 1], ['JIT-stress', 2]] as const) {
    const off = skip || (jit === 2 && !stress && 'SKIPPED: set WEBPC_JIT_STRESS=1');
    test(`${name}: ${mode}`, { skip: off }, async () => {
      const r = await boot(o(), jit, max, input);
      const ref = want ? ` (interpreter ${(want.ms / 1000).toFixed(1)} s)` : '';
      console.log(`# ${name} ${mode}: ${r.steps} steps in ${(r.ms / 1000).toFixed(1)} s${ref}`);
      if (want) assert.deepEqual(summary(r), summary(want));
      else {
        assert.ok(!interp && !INTERP, 'the interpreter run failed');
        check(r);
        if (steps) assert.equal(r.steps, steps);
      }
    });
  }
}

const poweredOff = (r: Run) => {
  assert.equal(r.kind, Exit.PSCI, r.console);
  assert.equal(r.x[0], PSCI_SYSTEM_OFF, r.console);
};

// Bare-metal EL1 tests (core/tests/baremetal.rs): linked at the start of 16 MiB of RAM; SYSTEM_OFF with x1 = 0 passes.
const BAREMETAL = new URL('baremetal/', import.meta.url);
// A `// window` test needs a host that drives its phases: tests/window-watch.test.ts runs it (core/tests/baremetal.rs `window_of`).
const windowed = (f: string) => /^\/\/ window/m.test(readFileSync(new URL(f.replace(/\.bin$/, '.c'), BAREMETAL), 'utf8'));
// The vCPUs from its `// smp: N` marker (core/tests/baremetal.rs `smp_of`).
const smpOf = (f: string) => Number(readFileSync(new URL(f.replace(/\.bin$/, '.c'), BAREMETAL), 'utf8').match(/^\/\/ smp: (\d+)$/m)?.[1] ?? 1);
// Its `// flash` line: the firmware configuration (M8 phase B), for its flash bank.
const flashOf = (f: string) => /^\/\/ flash$/m.test(readFileSync(new URL(f.replace(/\.bin$/, '.c'), BAREMETAL), 'utf8'));
const bareMetal = (f: string): BootOptions => ({ ramSize: 16 << 20, kernel: readFileSync(new URL(f, BAREMETAL)), kernelOffset: 0, cmdline: '', ncpus: smpOf(f), firmware: flashOf(f) ? {} : undefined, rng: false, e0pd: false, sha3: false }); // the ID registers as core/tests/baremetal.rs has them
// Its `// input: <text>` line, typed once it waits: at its idle, or once it printed "ready" (parallel).
const inputOf = (f: string): ConsoleInput | undefined => {
  const text = readFileSync(new URL(f.replace(/\.bin$/, '.c'), BAREMETAL), 'utf8').match(/^\/\/ input: (.*)$/m)?.[1];
  return text === undefined ? undefined : { after: 'ready\n', data: `${text}\n` };
};
for (const f of readdirSync(BAREMETAL).filter((f) => f.endsWith('.bin') && !windowed(f)).sort()) {
  const input = inputOf(f);
  guest(`bare-metal ${f}`, () => bareMetal(f), (r) => {
    poweredOff(r);
    assert.equal(r.x[1], 0n, r.console);
    assert.match(r.console, /exit 0\n$/);
  }, { max: 50e6, input: input && { data: input.data } }); // at its idle, as core/tests/baremetal.rs
}

// Parallel SMP (M7 loop 5): each bare-metal test under the JIT and JIT-check
// (whose checker tolerates the legal cross-modification window here: a stale
// block is dropped and counted, not a trap).
// A run that doesn't power off within `maxMs` fails (a realtime guest stuck with its timers running
// would otherwise hold the test file until CI's outer timeout).
const RUNS = Number(process.env.WEBPC_PARALLEL_RUNS ?? 3);
const parallel = async (o: BootOptions, jit: 0 | 1 | 2 | 3, check: (r: Run) => void, input?: ConsoleInput, maxMs = 300_000) => {
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    try {
      const r = await runToPowerOff(WASM, { ...o, parallel: true, idleLimitMs: 30_000, jit }, 1e12, undefined, input, maxMs);
      check(r);
    } catch (e) {
      throw new Error(`run ${i + 1} of ${RUNS} (${((performance.now() - t0) / 1000).toFixed(1)} s): ${(e as Error).message}`);
    }
  }
};
for (const f of readdirSync(BAREMETAL).filter((f) => f.endsWith('.bin') && !windowed(f)).sort()) {
  for (const [mode, jit] of [['JIT', 1], ['JIT-check', 3]] as const) {
    test(`parallel: bare-metal ${f} (${mode})`, () => parallel(bareMetal(f), jit, (r) => {
      poweredOff(r);
      assert.equal(r.x[1], 0n, r.console);
    }, inputOf(f)));
  }
}

// A closed VM's memory is freed (M8 loop 8): in parallel mode in Node the backends serve the
// vCPUs' doorbell on this thread, and their Atomics.waitAsync, never ended, kept every VM's
// memory alive (~10 MB a bare-metal boot, GBs over a test file: a Node process of npm test
// reached 6 GB and the VM ran out of memory).
test('parallel: a closed VM is garbage-collected', async () => {
  setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc') as () => void;
  let memory: WeakRef<WebAssembly.Memory> | undefined;
  const r = await runToPowerOff(WASM, { ramSize: 16 << 20, kernel: readFileSync(new URL('timer.bin', BAREMETAL)), kernelOffset: 0, cmdline: '', parallel: true, realtime: true, idleLimitMs: 30_000, jit: 1 }, 1e12, (vm) => { memory = new WeakRef(vm.memory); });
  assert.equal(r.x[1], 0n);
  // The vCPU workers end asynchronously: give them a few seconds.
  for (let i = 0; i < 50 && memory!.deref(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    gc();
  }
  assert.equal(memory!.deref(), undefined, "the VM's memory is still reachable");
});

// Over 2 GiB of memory (M8 loop 0): with 2.5 GiB of RAM the core's later
// allocations (the VM, the vCPUs, JIT code) sit above 2^31, where the i32 an
// export returns is negative in JS (web/vm.ts `unsigned`), as is the address
// `jit_install` gets. smp.bin on 4 vCPUs, round-robin under JIT-check (which
// compiles on sight) and parallel under the JIT.
test('bare-metal smp.bin with 2.5 GiB of RAM, round-robin (JIT-check) and parallel (JIT)', async () => {
  const o = { ramSize: 2560 * 2 ** 20, kernel: readFileSync(new URL('smp.bin', BAREMETAL)), kernelOffset: 0, cmdline: '', ncpus: 4 };
  const r = await boot(o, 3, 50e6);
  poweredOff(r);
  assert.equal(r.x[1], 0n, r.console);
  await parallel(o, 1, (r) => {
    poweredOff(r);
    assert.equal(r.x[1], 0n, r.console);
  });
});

// A fixed-size memory (ABI 32): `bootVm` makes the memory its final size with the core's heap
// reserved in it, and JIT modules and the core import it with exact limits; `fixedMemory: false`
// keeps the growable one, `exactCore: false` the core's growable import. smp.bin on 4 vCPUs under
// JIT-check (every block compiled, each in a module of its own) runs the same each way.
test('bare-metal smp.bin in a fixed and a growable memory (JIT-check): the same run', async () => {
  const o = { ramSize: 16 << 20, kernel: readFileSync(new URL('smp.bin', BAREMETAL)), kernelOffset: 0, cmdline: '', ncpus: 4, jit: 3 as const };
  const runs = await Promise.all([[true, true], [true, false], [false, true]].map(async ([fixedMemory, exactCore]) => {
    let grows = false;
    let exact = false;
    const r = await runToPowerOff(WASM, { ...o, fixedMemory, exactCore }, 50e6, (vm) => {
      exact = vm.exactCore;
      try {
        vm.memory.grow(1);
        grows = true;
      } catch (e) {
        assert.ok(e instanceof RangeError, String(e));
      }
    });
    poweredOff(r);
    assert.equal(r.x[1], 0n, r.console);
    return { grows, exact, steps: r.steps, console: r.console };
  }));
  assert.deepEqual(runs.map((r) => [r.grows, r.exact]), [[false, true], [false, false], [true, false]]);
  assert.equal(runs[0].steps, runs[2].steps);
  assert.equal(runs[0].console, runs[2].console);
  assert.equal(runs[0].steps, runs[1].steps);
  assert.equal(runs[0].console, runs[1].console);
});

// The stale-code checker across vCPUs (M7 loop 4): maint.bin with its one
// `IC IVAU` planted out (a NOP), so CPU 0 rewrites code the secondaries have
// compiled without invalidating it. The interpreter has no code cache and
// passes. Under the JIT either is allowed without the IC, and which one runs
// depends on where the old code was compiled: it failed check 401 (the old
// code, on CPU 1) while the rewritten function had a wasm function of its own;
// since calls are followed into forward regions (M8) the old code is inside
// the region of the loop that called it, and the checking call, from another
// block, finds the function not compiled and interprets the new code.
// JIT-check's checker traps (JIT-stress's 4-region cache has evicted the
// block by then). With the IC, JIT-check passes.
test('bare-metal maint.bin without its IC IVAU: the JIT may keep the old code, the checker traps', async () => {
  const img = new Uint8Array(readFileSync(new URL('maint.bin', BAREMETAL)));
  const words = new Uint32Array(img.buffer);
  const ic = words.findIndex((w) => (w & ~31) >>> 0 === 0xd50b7520);
  assert.ok(ic >= 0 && words.findLastIndex((w) => (w & ~31) >>> 0 === 0xd50b7520) === ic, 'one IC IVAU');
  const o = { ramSize: 16 << 20, kernel: img, kernelOffset: 0, cmdline: '', ncpus: 4 };
  assert.equal((await boot({ ...o, kernel: readFileSync(new URL('maint.bin', BAREMETAL)) }, 3, 50e6)).x[1], 0n);
  words[ic] = 0xd503201f;
  assert.equal((await boot(o, 0, 50e6)).x[1], 0n);
  assert.ok([0n, 401n].includes((await boot(o, 1, 50e6)).x[1]));
  await assert.rejects(boot(o, 3, 50e6), WebAssembly.RuntimeError);
});

// kvm-unit-tests: (file, arguments, the checks expected to FAIL, vCPUs), from core/tests/kvm_unit_tests.rs `RUN`.
const KUT: [string, string, string[], number?][] = [
  ['selftest', 'setup smp=1 mem=256', []],
  ['selftest', 'smp', [], 4],
  ['selftest', 'vectors-kernel', []],
  ['selftest', 'vectors-user', []],
  ['psci', '', [], 4],
  ['gic', 'ipi', [], 4],
  ['gic', 'active', [], 4],
  ['timer', '', []],
  ['cache', '', []],
  ['debug', 'bp', []],
  ['debug', 'wp', []],
  ['debug', 'ss', []],
];
// psci's environment (an initrd) enables its concurrent cpu-on check.
const PSCI_ENV = new TextEncoder().encode('ERRATA_6c7a5dce22b3=y\n');
for (const [file, args, fails, ncpus] of KUT) {
  guest(`kvm-unit-tests ${file} ${args}${ncpus ? ` (${ncpus} vCPUs)` : ''}`.replace('  ', ' '), () => ({ ramSize: 256 << 20, kernel: image(`kvm-unit-tests/${file}.flat`), cmdline: args, ncpus, initrd: file === 'psci' ? PSCI_ENV : undefined }), (r) => {
    poweredOff(r);
    const lines = r.console.replaceAll('\r\n', '\n').split('\n');
    assert.deepEqual(lines.filter((l) => l.startsWith('FAIL: ')).map((l) => l.slice(6)), fails, r.console);
    assert.ok(lines.includes(`EXIT: STATUS=${fails.length ? 3 : 1}`), r.console);
    assert.ok(!lines.some((l) => l.startsWith('SKIP: ')), r.console);
  }, { skip: !has(`kvm-unit-tests/${file}.flat`) && 'SKIPPED: run images/build.sh kvm-unit-tests', max: 5e9, stress: STRESS || file === 'cache' || file === 'debug' });
}

// kvm-unit-tests' SMP set in parallel (M7 loop 5).
for (const [file, args, fails, ncpus] of KUT.filter((k) => k[3])) {
  test(`parallel: kvm-unit-tests ${file} ${args} (${ncpus} vCPUs, JIT)`.replace('  ', ' '), { skip: !has(`kvm-unit-tests/${file}.flat`) && 'SKIPPED: run images/build.sh kvm-unit-tests' }, () => parallel({ ramSize: 256 << 20, kernel: image(`kvm-unit-tests/${file}.flat`), cmdline: args, ncpus, initrd: file === 'psci' ? PSCI_ENV : undefined }, 1, (r) => {
    poweredOff(r);
    const lines = r.console.replaceAll('\r\n', '\n').split('\n');
    assert.deepEqual(lines.filter((l) => l.startsWith('FAIL: ')).map((l) => l.slice(6)), fails, r.console);
    assert.ok(lines.includes(`EXIT: STATUS=${fails.length ? 3 : 1}`), r.console);
  }));
}

const linux = (!has('linux/Image') || !has('buildroot/rootfs.ext4')) && 'SKIPPED: run images/build.sh linux buildroot';
const disk = () => new URL('buildroot/rootfs.ext4', IMAGES).href;
guest('Buildroot', () => ({ ramSize: 256 << 20, kernel: image('linux/Image'), cmdline: GUEST_CMDLINE, devices: guestDevices(disk()) }), (r) => {
  poweredOff(r);
  assert.match(r.console, /webpc: test ok/);
}, { skip: linux, stress: STRESS, steps: STEPS.buildroot });

// On 2 and 4 vCPUs, deterministic round-robin (M7): the same steps interpreted and under the JIT.
for (const n of [2, 4]) {
  guest(`Buildroot on ${n} vCPUs`, () => ({ ramSize: 256 << 20, kernel: image('linux/Image'), cmdline: GUEST_CMDLINE, devices: guestDevices(disk()), ncpus: n }), (r) => {
    poweredOff(r);
    assert.match(r.console, new RegExp(`smp: Brought up 1 node, ${n} CPUs[^]*webpc: test ok`));
  }, { skip: linux, stress: STRESS, steps: STEPS[`buildroot-${n}cpu`] });
}

// Console input (M8 loop 1): a shell on the console reads what the host sends
// through the PL011's RX ring, more than the ring holds (core/tests/boot.rs
// `console_input_reaches_a_shell`), at a fixed step.
guest('Buildroot console input', () => ({ ramSize: 256 << 20, kernel: image('linux/Image'), cmdline: `${GUEST_CMDLINE} -- /bin/sh`, devices: guestDevices(disk()) }), (r) => {
  poweredOff(r);
  assert.ok(r.console.replaceAll('\r\n', '\n').includes(CONSOLE_INPUT_WANT), r.console);
}, { skip: linux, stress: STRESS, steps: STEPS['console-input'], max: 200e6, input: { step: CONSOLE_INPUT_STEP, data: CONSOLE_INPUT } }); // 200M: lost input leaves the shell waiting

// The same in parallel on 2 vCPUs, sent through `serialIn` (a MessagePort)
// once the prompt shows: SIGNAL_RX must wake an idle vCPU.
test('parallel: Buildroot console input through a port (2 vCPUs, JIT)', { skip: linux }, async () => {
  for (let i = 0; i < RUNS; i++) {
    const { port1, port2 } = new MessageChannel();
    const vm = await bootVm(WASM, { ramSize: 256 << 20, kernel: image('linux/Image'), cmdline: `${GUEST_CMDLINE} -- /bin/sh`, devices: guestDevices(disk()), ncpus: 2, parallel: true, jit: 1, idleLimitMs: 30_000, serialIn: port2 });
    let out = '';
    let sent = false;
    const t0 = performance.now();
    try {
      for (;;) {
        assert.ok(performance.now() - t0 < 60_000, `run ${i + 1}: no power-off in 60 s: ${out}`);
        const r = await vm.runAsync(100_000_000);
        out += vm.drain();
        if (!sent && out.endsWith('# ')) {
          // The core notifies the TX ring's head on a byte into an empty ring (drained just now), so a
          // host sleeping on it wakes at the echo (runAsync does, M8 loop 3), not at its next 10 ms poll.
          const head = new Int32Array(vm.memory.buffer, vm.console, 1);
          const echo = Atomics.waitAsync(head, 0, Atomics.load(head, 0), 10_000);
          port1.postMessage(CONSOLE_INPUT);
          sent = true;
          if (echo.async) assert.equal(await echo.value, 'ok', `run ${i + 1}: no notify on the echo`); // else output came first
        }
        if (r.kind !== Exit.BUDGET && r.kind !== Exit.TX_FULL) {
          assert.equal(r.kind, Exit.PSCI, out);
          assert.ok(out.replaceAll('\r\n', '\n').includes(CONSOLE_INPUT_WANT), `run ${i + 1}: ${out}`);
          break;
        }
      }
    } finally {
      vm.close();
      port1.close();
    }
  }
});

// In parallel, a worker per vCPU (M7 loop 5).
for (const n of [2, 4]) {
  test(`parallel: Buildroot on ${n} vCPUs (JIT)`, { skip: linux }, () => parallel({ ramSize: 256 << 20, kernel: image('linux/Image'), cmdline: GUEST_CMDLINE, devices: guestDevices(disk()), ncpus: n }, 1, (r) => {
    poweredOff(r);
    assert.match(r.console, new RegExp(`smp: Brought up 1 node, ${n} CPUs[^]*webpc: test ok`));
    // The modules went through the compile worker (docs/jit.md "Sharing"), every table installing them from
    // there (a table may not have caught up with the last ones at power-off), none after waiting the backstop's second.
    const { workerInstalls, overdue, modules } = r.stats.jit;
    assert.ok(workerInstalls >= modules && overdue === 0, `${workerInstalls} installs from the worker, ${overdue} overdue, ${modules} modules`);
  }));
}
// The vCPU workers returning to their event loop at every exit 1 ms apart (web/vcpu-worker.ts `yieldMs`; 100 by
// default): idle sleeps through Atomics.waitAsync, busy chunks through a wait that times out, thousands a boot.
test('parallel: Buildroot on 4 vCPUs, the workers yielding every 1 ms (JIT)', { skip: linux }, () => parallel({ ramSize: 256 << 20, kernel: image('linux/Image'), cmdline: GUEST_CMDLINE, devices: guestDevices(disk()), ncpus: 4, vcpuYieldMs: 1 }, 1, (r) => {
  poweredOff(r);
  assert.match(r.console, /smp: Brought up 1 node, 4 CPUs[^]*webpc: test ok/);
}));

// The litmus image (images/build.sh litmus, M7): herdtools7's litmus tests,
// none of which may observe a final state herd7's aarch64.cat forbids, then
// the atomics stress (LSE and LL/SC counters, a 128-bit CAS stack, a mutex
// ping-pong), whose totals must be exact. On 4 vCPUs round-robin under the JIT
// with tests/steps.txt's steps (core/tests/litmus.rs runs the interpreter),
// and in parallel under the JIT and JIT-check (whose boot alone takes 30 s).
// A DMB emitted as nothing fails MP+dmb.sys and SB+dmb.sys in parallel (M7 loop 6).
// Parallel JIT at -r 50 (100K outcomes a test): `eor x, x, x` folded by TurboFan (its address dependency
// lost) failed MP+dmb.sy+addr in 5 of 5 such runs, in 1 of 3 at -r 10 (M8 loop 7; docs/jit.md "Atomics").
const litmusSkip = !has('litmus/initramfs.cpio') && 'SKIPPED: run images/build.sh linux litmus';
const litmus = (l: string, s: string): BootOptions => ({ ramSize: 256 << 20, kernel: image('linux/Image'), initrd: image('litmus/initramfs.cpio'), cmdline: `console=ttyAMA0 panic=-1 webpc.litmus=${l} webpc.stress=${s}`, ncpus: 4 });
const litmusOk = (r: Run) => {
  poweredOff(r);
  assert.match(r.console, /webpc: litmus on 4 CPUs[^]*litmus: all ok, 0 skipped\r?\nwebpc: stress on 4 CPUs[^]*\nwebpc: test ok\r?\n/, r.console);
};
guest('litmus and stress on 4 vCPUs', () => litmus('-s,100,-r,1', '-n,20000'), litmusOk, { skip: litmusSkip, stress: STRESS, steps: STEPS['litmus-4cpu'], interp: false, max: 5e9 });
// The JIT's litmus at -r 50 caught V8 folding an address dependency (docs/jit.md "Atomics"; -r 10
// caught it 1 run in 3); scripts/ci.sh runs -r 50, a plain npm test -r 10.
for (const [mode, jit, l, s] of [['JIT', 1, longSkip ? '-s,1000,-r,10' : '-s,1000,-r,50', '-n,100000'], ['JIT-check', 3, '-s,100,-r,2', '-n,10000']] as const) {
  test(`parallel: litmus and stress on 4 vCPUs (${mode})`, { skip: litmusSkip || (mode === 'JIT-check' && longSkip) }, async () => {
    const r = await boot({ ...litmus(l, s), parallel: true, idleLimitMs: 30_000 }, jit, 1e12);
    console.log(`# litmus and stress ${mode}: ${(r.ms / 1000).toFixed(1)} s; ${r.console.match(/stress: spin ok .*/g)?.join('; ')}`);
    litmusOk(r);
  });
}

guest('Buildroot device test', () => ({
  ramSize: 256 << 20, kernel: image('linux/Image'), cmdline: `${GUEST_CMDLINE} -- /test-devices.sh`, devices: testDevices(disk()), framebuffer: { width: 640, height: 480 },
}), (r) => {
  poweredOff(r);
  for (const want of ['3 packets transmitted, 3 packets received, 0% packet loss', '9p: big 200000 ok', 'fb: 0 simple 640,480', 'webpc: test ok']) assert.ok(r.console.includes(want), `missing ${want}`);
}, { skip: linux, stress: STRESS, steps: STEPS.devices });

// The LTP subset and the arm64 kselftests (images/build.sh ltp linux):
// core/tests/ltp.rs checks each result against its table natively.
const ltp = (!has('ltp/rootfs.ext4') || !has('linux/Image-defconfig')) && 'SKIPPED: run images/build.sh ltp linux';
guest('LTP and kselftests', () => ({
  ramSize: 512 << 20, kernel: image('linux/Image-defconfig'), cmdline: `${GUEST_CMDLINE} -- /ltp.sh`, devices: guestDevices(new URL('ltp/rootfs.ext4', IMAGES).href),
}), (r) => {
  poweredOff(r);
  assert.match(r.console, /webpc: test ok\r?\n/);
  // Every test passes or skips (ltp.rs has which, and why).
  const failed = [...r.console.matchAll(/^(ltp|kselftest|webpc): (\S+) (\d+)\r?$/gm)]
    .filter(([, suite, , code]) => !(code === '0' || code === (suite === 'ltp' ? '32' : '4')));
  assert.deepEqual(failed.map((m) => m[0].trim()), []);
  assert.ok(r.console.split('\n').filter((l) => /^(ltp|kselftest): /.test(l)).length > 100, 'too few results');
  assert.match(r.console, /^webpc: debug 0\r?$/m);
}, { skip: ltp, stress: STRESS, max: 200e9, steps: STEPS.ltp, interp: false });

// The crypto extensions' test kernel (images/build.sh linux-crypto)
// with them on (SHA512 and SHA3 too): the arm64 CE drivers pass the full crypto
// self-tests, and lib/crypto's SHA KUnit suites (on the CE code) pass.
const CE_DRIVERS = ['aes-ce', 'ecb-aes-ce', 'cbc-aes-ce', 'ctr-aes-ce', 'xctr-aes-ce', 'xts-aes-ce', 'cts-cbc-aes-ce', 'essiv-cbc-aes-sha256-ce', 'cmac-aes-ce', 'xcbc-aes-ce', 'cbcmac-aes-ce', 'ccm-aes-ce', 'gcm-aes-ce', 'rfc4106-gcm-aes-ce', 'polyval-ce', 'sha3-224-ce', 'sha3-256-ce', 'sha3-384-ce', 'sha3-512-ce'];
guest('crypto test kernel', () => ({
  ramSize: 256 << 20, kernel: image('linux-crypto/Image'), initrd: image('linux-crypto/initramfs.cpio'), cmdline: 'console=ttyAMA0 panic=-1', crypto: true,
}), (r) => {
  poweredOff(r);
  assert.match(r.console, /webpc: test ok \(0 failed, 0 pending\)/);
  assert.match(r.console, /cpuinfo: Features\t: fp asimd aes pmull sha1 sha2 .* sha3 .*sha512/);
  for (const d of CE_DRIVERS) assert.match(r.console, new RegExp(`^crypto: ${d} \\S+ passed\r?$`, 'm'), d);
  const totals = [...r.console.matchAll(/# Totals: pass:(\d+) fail:(\d+)/g)];
  assert.deepEqual(totals.map((m) => m[2]), ['0', '0', '0', '0', '0'], 'the sha1, sha224, sha256, sha384 and sha512 KUnit suites');
  assert.doesNotMatch(r.console, /alg: .*(failed|error)/i);
}, { skip: !has('linux-crypto/Image') && 'SKIPPED: run images/build.sh linux-crypto', stress: STRESS, max: 60e9, steps: STEPS.crypto, interp: false });

// The gpu test kernel (images/build.sh linux-gpu, images/gpu/init.c; M8 graphics G1): KMS on a
// virtio-gpu of 640×480 (a mode set, damage, a cursor), then the display event the host raises after
// the guest's last flush (tests/gpu/guest.json) and a buffer of the new size. The scanout and cursor
// hashes are the native twin's (core/tests/gpu_guest.rs).
const GPU_GUEST: { resizeAfter: string; screen: string; cursor: string; trace1: string; trace2: string; trace3: string } = JSON.parse(readFileSync(new URL('gpu/guest.json', import.meta.url), 'utf8'));
guest('gpu test kernel', () => ({
  ramSize: 256 << 20, kernel: image('linux-gpu/Image'), initrd: image('linux-gpu/initramfs.cpio'), cmdline: 'console=ttyAMA0 panic=-1',
  devices: [{ type: 'gpu', width: 640, height: 480, trace: true, resize: { after: Number(GPU_GUEST.resizeAfter), width: 800, height: 600 } }],
}), (r) => {
  poweredOff(r);
  for (const want of ['gpu: 1 crtc 1 connector 1 encoder', 'gpu: connector connected, 1 mode, preferred 640x480@', 'gpu: mode set 640x480 pitch 2560\n', 'gpu: damage sent\n', 'gpu: cursor set and moved\n', 'gpu: preferred now 800x600,', 'gpu: mode set 800x600\n', 'webpc: gpu test ok\n']) {
    assert.ok(r.console.replaceAll('\r\n', '\n').includes(want), `missing ${JSON.stringify(want)}`);
  }
  assert.equal(r.gpu?.width, 800);
  assert.equal(r.gpu?.screen, GPU_GUEST.screen);
  assert.deepEqual(r.gpu?.trace, [GPU_GUEST.trace1, GPU_GUEST.trace2, GPU_GUEST.trace3]);
  assert.equal(r.gpu?.cursor?.hash, GPU_GUEST.cursor);
}, { skip: !has('linux-gpu/Image') && 'SKIPPED: run images/build.sh linux-gpu', stress: STRESS, steps: STEPS.gpu, max: 5e9 });

// The snd test kernel (images/build.sh linux-snd, images/snd/init.c; audio S1): ALSA on a virtio-snd
// plays a known waveform through the deterministic sink, which hashes what it was given: the hash the
// guest printed for what it wrote, after the control requests of tests/snd/log.txt, in the native
// twin's steps (core/tests/snd_guest.rs).
guest('snd test kernel', () => ({
  ramSize: 256 << 20, kernel: image('linux-snd/Image'), initrd: image('linux-snd/initramfs.cpio'), cmdline: 'console=ttyAMA0 panic=-1', devices: [{ type: 'snd' }],
}), (r) => {
  poweredOff(r);
  checkSndGuest(r.console, r.snd);
}, { skip: !has('linux-snd/Image') && 'SKIPPED: run images/build.sh linux-snd', stress: STRESS, steps: STEPS.snd, max: 5e9 });

// The USB test kernel (images/build.sh linux-usb, images/usb/init.c; docs/usb.md) on the xHCI: the two empty root
// hubs; then the kernel's testusb against two Gadget Zeros (web/usb-gadget-zero.ts), one of them unplugged mid-pass
// and plugged in again at fixed steps, in the native twin's steps (core/tests/usb_guest.rs). In parallel SMP without the
// hot-plug (its steps aren't exact): one clean pass, each run.
const usbSkip = !has(USB_KERNEL) && 'SKIPPED: run images/build.sh linux-usb';
guest('usb test kernel: root hubs', () => ({ ramSize: 256 << 20, kernel: image(USB_KERNEL), initrd: image(USB_INITRD), cmdline: USB_HUBS_CMDLINE, usb: {} }), (r) => {
  poweredOff(r);
  checkUsbHubs(r.console.replaceAll('\r\n', '\n'));
}, { skip: usbSkip, stress: STRESS, steps: STEPS['usb-hubs'], max: 5e9 });
guest('usb test kernel: testusb against Gadget Zero, hot-plugged', () => ({ ramSize: 256 << 20, kernel: image(USB_KERNEL), initrd: image(USB_INITRD), cmdline: USB_CMDLINE, usb: usbGuest() }), (r) => {
  poweredOff(r);
  checkUsbGuest(r.console);
}, { skip: usbSkip, stress: STRESS, steps: STEPS.usb, max: 5e9 });
test('parallel: usb test kernel, testusb against Gadget Zero on 2 vCPUs (JIT)', { skip: usbSkip }, () => parallel({ ramSize: 256 << 20, kernel: image(USB_KERNEL), initrd: image(USB_INITRD), cmdline: USB_CMDLINE.replace('usb_unplug=1', 'usb_unplug=0'), usb: usbGuest(false), ncpus: 2 }, 1, (r) => {
  poweredOff(r);
  checkUsbGuest(r.console, false);
}, undefined, 60_000)); // a run takes 1-4 s

// The firmware configuration (M8 phase B): EDK2 boots the UEFI Shell from the test disk
// (images/build.sh edk2: shell.img), whose startup.nsh prints a variable, sets it in the
// flash bank and powers off; a second boot with the same flash bytes prints it.
const edk2Skip = (!has('edk2/QEMU_EFI.fd') || !has('edk2/shell.img')) && 'SKIPPED: run images/build.sh edk2';
const edk2 = (flash?: Uint8Array): BootOptions => ({
  ramSize: 512 << 20, kernel: image('edk2/QEMU_EFI.fd'), cmdline: '', devices: [{ type: 'blk', url: new URL('edk2/shell.img', IMAGES).href }], firmware: { flash },
});
guest('EDK2 shell', () => edk2(), (r) => {
  poweredOff(r);
  // Without the Shell's colours.
  assert.match(r.console.replace(/\x1b\[[0-9;=]*[A-Za-z]/g, ''), /UEFI Interactive Shell[^]*webpc: before\r?\nsetvar: Unable to get[^]*webpc: done/);
}, { skip: edk2Skip, stress: STRESS, steps: STEPS['edk2-shell'] });
test('EDK2 shell: a variable set by one boot is there on the next (JIT)', { skip: edk2Skip }, async () => {
  const first = await boot(edk2(), 1);
  poweredOff(first);
  const r = await boot(edk2(first.flash), 1);
  poweredOff(r);
  // "persisted" in UTF-16LE, as setvar dumps it.
  assert.match(r.console, /webpc: before\r?\n5B5E1F2A-8C3D-4E6F-9A1B-2C3D4E5F6A7B - WebpcTest - 0012 Bytes\r?\n70 00 65 00 72 00 73 00 69 00 73 00 74 00 65 00 64 00/, r.console);
  assert.equal(r.steps, STEPS['edk2-shell-again']);
});

const a = DISTROS.alpine;
const alpineSkip = !DISTRO_TESTS.includes('alpine') ? 'SKIPPED: set WEBPC_DISTROS=alpine' : !has(a.kernel) && 'SKIPPED: run images/build.sh alpine';
guest('Alpine', () => ({
  ramSize: 1 << 30, kernel: image(a.kernel), initrd: image(a.initrd), cmdline: a.cmdline, devices: testDevices(new URL(a.disk, IMAGES).href), framebuffer: { width: 640, height: 480 },
}), (r) => {
  poweredOff(r);
  assert.match(r.console, /webpc: alpine [^]*webpc: test ok\r?\n/);
}, { skip: alpineSkip, stress: STRESS, steps: STEPS.alpine, interp: false });

test('parallel: Alpine on 4 vCPUs (JIT)', { skip: alpineSkip || longSkip }, () => parallel({
  ramSize: 1 << 30, kernel: image(a.kernel), initrd: image(a.initrd), cmdline: a.cmdline, devices: testDevices(new URL(a.disk, IMAGES).href), framebuffer: { width: 640, height: 480 }, ncpus: 4,
}, 1, (r) => {
  poweredOff(r);
  assert.match(r.console, /smp: Brought up 1 node, 4 CPUs[^]*webpc: alpine [^]*webpc: test ok\r?\n/);
}));

// Alpine's userspace benchmark (images/alpine/user): its image under the JIT
// only (10.7G steps: minutes interpreted), with its phases' check lines.
const userSkip = !DISTRO_TESTS.includes('alpine-user') ? 'SKIPPED: set WEBPC_DISTROS=alpine-user' : !has('alpine-user/rootfs-user.ext4') && 'SKIPPED: run images/build.sh alpine-user';
guest('Alpine userspace', () => ({
  ramSize: 1 << 30, kernel: image(a.kernel), initrd: image(a.initrd), cmdline: a.cmdline, devices: guestDevices(new URL('alpine-user/rootfs-user.ext4', IMAGES).href),
}), (r) => {
  poweredOff(r);
  for (const l of ['compress: ok 3', 'binarytrees: 649904 8191', 'fannkuch: 1616 22', 'nbody: -0.169075164 -0.169078071', 'spectralnorm: 1.274222587', 'churn: 1048 files', 'sqlite: 85715 2470168', 'webpc: test ok']) {
    assert.ok(r.console.includes(l), `no "${l}"`);
  }
}, { skip: userSkip, stress: false, steps: STEPS['alpine-user'], interp: false, max: 50e9 });
