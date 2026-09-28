// The machine worker (docs/frontend.md): boots one of web/app/machine.ts's
// machines under the JIT, realtime with a worker per vCPU (web/vm.ts), and runs
// it until it stops, talking to the page through web/app/protocol.ts. It
// drains the serial console after every `runAsync` (which returns within 10 ms
// of new output) and posts the text; serial input comes in on a port straight
// to the VM, and the keyboard and tablet ports go to the device worker.
import { bootVm, Exit, PSCI_SYSTEM_OFF, type Vm } from '../vm.ts';
import { MACHINES, type Machine } from './machine.ts';
import type { FromWorker, PowerState, Status, ToWorker } from './protocol.ts';

const post = (m: FromWorker) => self.postMessage(m);
const state = (s: PowerState, message?: string) => post({ type: 'state', state: s, message });
const PANIC = 'Kernel panic - not syncing';

let vm: Vm | undefined;
let stopping = false;

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  if (m.type === 'start') {
    start(m).catch((err) => {
      if (!stopping) state('crashed', String((err as Error).stack ?? err));
    });
  } else if (m.type === 'stop') {
    stopping = true;
    void (vm?.close() ?? Promise.resolve()).then(() => post({ type: 'stopped' }));
  }
};

const fetchBytes = async (url: string) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
};

async function start(m: Extract<ToWorker, { type: 'start' }>) {
  const machine: Machine = MACHINES[m.machine];
  state('loading');
  const [wasm, kernel, initrd] = await Promise.all([
    fetchBytes(new URL('../../target/wasm32-unknown-unknown/release/webpc_core.wasm', import.meta.url).href),
    fetchBytes(machine.kernel),
    machine.initrd ? fetchBytes(machine.initrd) : undefined,
  ]);
  if (stopping) return;
  vm = await bootVm(wasm, {
    ramSize: machine.ramMiB << 20, kernel, initrd, cmdline: machine.cmdline, jit: 1, ncpus: m.ncpus, parallel: true, realtime: true,
    framebuffer: machine.framebuffer, serialIn: m.serial,
    devices: [
      { type: 'rng' },
      { type: 'blk', url: machine.disk, overlay: machine.overlay },
      { type: 'input', kind: 'keyboard', port: m.keyboard },
      { type: 'input', kind: 'tablet', port: m.tablet },
    ],
    // No idleLimitMs: an idle guest may sleep as long as it likes.
  });
  if (stopping) return;
  if (vm.framebuffer) post({ type: 'screen', memory: vm.memory, framebuffer: vm.framebuffer });
  state('booting');
  const t0 = performance.now();
  let ready = false;
  let panicked = false;
  let tail = ''; // the last output, for markers split across drains
  let lastStatus = 0;
  for (;;) {
    const r = await vm.runAsync(1e9);
    if (stopping) return;
    const text = vm.drain();
    if (text) {
      post({ type: 'serial', data: text });
      tail = (tail + text).slice(-256);
      if (!ready && machine.ready.test(tail)) {
        ready = true;
        state('running');
      }
      if (!panicked && tail.includes(PANIC)) {
        panicked = true; // the guest hangs (or reboots, with panic=): the page says why
        state('crashed', tail.slice(tail.indexOf(PANIC)).split('\n')[0].trim());
      }
    }
    const now = performance.now();
    if (now - lastStatus >= 1000) {
      lastStatus = now;
      post({ type: 'status', status: status(vm, m.ncpus, machine.ramMiB, now - t0) });
    }
    if (r.kind === Exit.BUDGET || r.kind === Exit.TX_FULL) continue;
    // Every vCPU has stopped.
    post({ type: 'serial', data: vm.drain() });
    await vm.close();
    if (r.kind === Exit.PSCI) state(r.x[0] === PSCI_SYSTEM_OFF ? 'off' : 'rebooting');
    else state('crashed', r.kind === Exit.UNIMPLEMENTED ? `unimplemented at pc 0x${vm.pc().toString(16)}` : `exit ${r.kind}`);
    return;
  }
}

function status(vm: Vm, ncpus: number, ramMiB: number, uptime: number): Status {
  const s = vm.stats();
  return { ncpus, ramMiB, uptime, steps: s.steps, jitBlocks: s.jit.blocks, jitCompileMs: s.jit.compileNs / 1e6, irqs: s.irqs };
}
