// The machine worker (docs/frontend.md): boots one of web/app/machine.ts's
// machines under the JIT, realtime with a worker per vCPU (web/vm.ts), and runs
// it until it stops, talking to the page through web/app/protocol.ts. It
// drains the serial console after every `runAsync` (which returns as soon as
// there's new output) and posts the text, and draws the screen on the page's
// canvas (transferred) on its own animation frames; serial input comes in on a
// port straight to the VM, and the keyboard and tablet ports go to the device
// worker. What stops a machine from starting or running is sorted into a
// `Problem` with a message a user can act on (docs/frontend.md "Errors").
import { bootVm, Exit, PSCI_SYSTEM_OFF, type Vm } from '../vm.ts';
import { showFramebuffer } from '../display.ts';
import { MACHINES, readyWatcher, withParams, type Machine } from './machine.ts';
import type { FromWorker, PowerState, Problem, Status, ToWorker } from './protocol.ts';

const post = (m: FromWorker) => self.postMessage(m);
const state = (s: PowerState, message?: string, problem?: Problem) => post({ type: 'state', state: s, message, problem });
const PANIC = 'Kernel panic - not syncing';

let vm: Vm | undefined;
/** The VM being booted: it may hold the overlay before `bootVm` returns it. */
let booting: Promise<Vm> | undefined;
let stopping = false;

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  if (m.type === 'start') {
    start(m).catch((err) => {
      if (stopping) return;
      const [problem, message] = explain(err, MACHINES[m.machine]);
      state(vm ? 'crashed' : 'failed', message, problem);
    });
  } else if (m.type === 'stop') {
    stopping = true;
    void (async () => {
      // A machine still booting is closed once it's there (its device worker may have the overlay open).
      await (vm ?? (await booting?.catch(() => undefined)))?.close();
      post({ type: 'stopped' });
    })();
  }
};

/** An error with the problem it means for the user. */
const failure = (problem: Problem, message: string) => Object.assign(new Error(message), { problem });

const CORE = new URL('../../target/wasm32-unknown-unknown/release/webpc_core.wasm', import.meta.url).href;
/** A URL as the user knows it: a path in the repository. */
const repoPath = (url: string) => new URL(url).pathname.replace(/^\//, '');

/** Why the file at `url` couldn't be fetched, as a failure a user can act on. */
function missing(url: string, machine: Machine, why: string) {
  if (url === CORE) {
    return failure('missing-core', `The emulator core isn't built: ${repoPath(url)} ${why}.\nRun \`npm start\` in the repository: it builds the core, then serves this page.`);
  }
  return failure('missing-image', `${machine.label}'s image isn't there: ${repoPath(url)} ${why}.\nRun ${machine.prepare}, then Retry.`);
}

/** Fetches `urls` whole, posting the progress over all of them (Content-Length; the server sends it). */
async function download(urls: string[], machine: Machine) {
  const responses = await Promise.all(urls.map(async (url) => {
    const r = await fetch(url).catch(() => { throw failure(url === CORE ? 'missing-core' : 'missing-image', `The server didn't answer for ${repoPath(url)}: is it still running (\`npm start\`)?`); });
    if (!r.ok) throw missing(url, machine, `answered HTTP ${r.status}${r.status === 404 ? ' (not found)' : ''}`);
    return r;
  }));
  const sizes = responses.map((r) => Number(r.headers.get('content-length')) || 0);
  const total = sizes.reduce((a, b) => a + b, 0);
  let loaded = 0;
  let posted = 0;
  const progress = (force = false) => {
    const now = performance.now();
    if (force || now - posted >= 100) {
      posted = now;
      post({ type: 'progress', loaded, total });
    }
  };
  progress(true);
  const files = await Promise.all(responses.map(async (r, i) => {
    const out = new Uint8Array(sizes[i]);
    const parts: Uint8Array[] = []; // past the announced length (none expected)
    let at = 0;
    const reader = r.body!.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done || stopping) break;
      if (at + value.length <= out.length) out.set(value, at);
      else parts.push(value);
      at += value.length;
      loaded += value.length;
      progress();
    }
    if (!parts.length && at === out.length) return out;
    const all = new Uint8Array(at);
    all.set(out.subarray(0, Math.min(at, out.length)));
    for (let k = out.length, j = 0; j < parts.length; k += parts[j++].length) all.set(parts[j], k);
    return all;
  }));
  progress(true);
  return files;
}

/** An error from starting or running a machine as `[problem, message]` for the page. */
function explain(err: unknown, machine: Machine): [Problem, string] {
  const e = err as Error & { problem?: Problem };
  if (e.problem) return [e.problem, e.message];
  const text = String(e.message ?? e);
  if (/NoModificationAllowedError|overlay \S+ is in use/.test(text)) {
    return ['disk-in-use', `${machine.label}'s disk is in use: another tab or window of this page runs the machine on it (the browser lets one open it at a time).\nClose that tab, then Retry.\n\n${text}`];
  }
  if (/overlay .* belongs to/.test(text)) {
    return ['disk-mismatch', `${machine.label}'s saved disk was written over a different image than the one served now.\nReset the disk to start over from this image (what the machine wrote is deleted).\n\n${text}`];
  }
  if (e instanceof RangeError && /memory/i.test(text)) {
    return ['memory', `The browser couldn't reserve ${machine.ramMiB} MiB for the machine's RAM.\nClose other tabs, then Retry.\n\n${text}`];
  }
  return ['emulator', `The emulator stopped with an error:\n${e.stack ?? text}`];
}

async function start(m: Extract<ToWorker, { type: 'start' }>) {
  const machine: Machine = MACHINES[m.machine];
  state('loading');
  // The disk is read by ranges as the guest needs it (not downloaded): check it's there.
  const disk = fetch(machine.disk, { method: 'HEAD' }).then((r) => { if (!r.ok) throw missing(machine.disk, machine, `answered HTTP ${r.status}${r.status === 404 ? ' (not found)' : ''}`); });
  const [wasm, kernel, initrd] = await download([CORE, machine.kernel, ...(machine.initrd ? [machine.initrd] : [])], machine);
  await disk;
  if (stopping) return;
  booting = bootVm(wasm, {
    ramSize: machine.ramMiB << 20, kernel, initrd, cmdline: withParams(m.ip && machine.network ? machine.network.cmdline : machine.cmdline, m.params ?? ''), jit: 1, ncpus: m.ncpus, parallel: true, realtime: true,
    framebuffer: machine.framebuffer, serialIn: m.serial,
    devices: [
      { type: 'rng' },
      { type: 'blk', url: machine.disk, overlay: machine.overlay },
      { type: 'input', kind: 'keyboard', port: m.keyboard },
      { type: 'input', kind: 'tablet', port: m.tablet },
      ...(m.ip && machine.network ? [{ type: 'net' as const, adapter: { ip: m.ip } }] : []),
    ],
    // No idleLimitMs: an idle guest may sleep as long as it likes.
  });
  vm = await booting;
  if (stopping) return; // `stop` closes it
  if (vm.framebuffer) showFramebuffer(m.screen, vm.memory, vm.framebuffer, () => post({ type: 'screen' })); // on this worker's animation frames
  state('booting');
  const t0 = performance.now();
  const ready = readyWatcher(machine.ready);
  let running = false;
  let panicked = ''; // the message
  let tail = ''; // the last output, for markers split across drains
  let loopAt = performance.now(); // the run loop's last iteration
  let loopMax = 0;
  const output = (text: string) => {
    if (!text) return;
    post({ type: 'serial', data: text });
    tail = (tail + text).slice(-256);
    if (!running && ready(text)) {
      running = true;
      state('running');
    }
    const at = tail.indexOf(PANIC);
    // The guest hangs (or resets, with panic=N: the page keeps the crash on show rather than restarting).
    if (!panicked && at >= 0 && tail.indexOf('\n', at) >= 0) {
      panicked = `The guest's kernel panicked: ${tail.slice(at).split('\n')[0].trim()}\nThe serial log shows what led to it; Restart boots the machine again.`;
      state('crashed', panicked, 'panic');
    }
  };
  // Once a second on a timer, not from the loop: a stuck loop then shows in `loopAgeMs` rather than as silence.
  const timer = setInterval(() => {
    const now = performance.now();
    post({ type: 'status', status: status(vm!, m.ncpus, machine.ramMiB, now - t0, loopMax, now - loopAt) });
    loopMax = 0;
  }, 1000);
  try {
    for (;;) {
      const r = await vm.runAsync(1e9);
      if (stopping) return;
      output(vm.drain());
      const now = performance.now();
      loopMax = Math.max(loopMax, now - loopAt);
      loopAt = now;
      if (r.kind === Exit.BUDGET || r.kind === Exit.TX_FULL) continue;
      // Every vCPU has stopped.
      output(vm.drain());
      await vm.close();
      if (panicked) return; // said
      else if (r.kind === Exit.PSCI) state(r.x[0] === PSCI_SYSTEM_OFF ? 'off' : 'rebooting');
      else state('crashed', `The emulator stopped: ${r.kind === Exit.UNIMPLEMENTED ? `an unimplemented instruction or register at pc 0x${vm.pc().toString(16)}` : `exit ${r.kind}`}.`, 'emulator');
      return;
    }
  } finally {
    clearInterval(timer);
  }
}

function status(vm: Vm, ncpus: number, ramMiB: number, uptime: number, loopMaxMs: number, loopAgeMs: number): Status {
  const s = vm.stats();
  return { ncpus, ramMiB, uptime, steps: s.steps, jitBlocks: s.jit.blocks, jitCompileMs: s.jit.compileNs / 1e6, irqs: s.irqs, loopMaxMs, loopAgeMs, vcpus: vm.liveness() };
}
