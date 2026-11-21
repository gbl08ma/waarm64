// The worker of the introduction's guest (intro/guest.ts starts it; docs/frontend.md "The introduction"): the small
// machine in the first screen's frame. It fetches the core and the guest's one file (images/build.sh intro: a kernel
// with its initramfs inside, gzipped), boots it under the JIT on one vCPU, draws its framebuffer on the frame's canvas
// and passes its serial port's output on. Nothing of the page's machine is here: no devices, no disk, no network,
// nothing kept in the browser. Paused, no guest code runs and nothing is drawn; stopped, its workers and memory go.
import { compileCore, Exit } from '../../core.ts';
import { CORE } from '../../deflate.ts';
import { showFramebuffer } from '../../display.ts';
import { bootVm, type Vm } from '../../vm.ts';
import { warmWorkers } from '../../warm-workers.ts';
import type { FromGuest, GuestStart, ToGuest } from './guest-protocol.ts';

/** The guest's file (images/build.sh intro). */
const IMAGE = new URL('../../../target/images/intro/intro.img.gz', import.meta.url).href;
/** Its RAM: the kernel and BusyBox take ~6 MiB of it. */
const RAM = 64 << 20;

const post = (m: FromGuest) => self.postMessage(m);

/** A file whole, or an error that names it. */
async function file(url: string) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${new URL(url).pathname}: HTTP ${r.status}`);
  return r;
}

/** The guest's image: gunzipped here, unless a server that knew better already did (the gzip's two magic bytes). */
async function image() {
  const bytes = new Uint8Array(await (await file(IMAGE)).arrayBuffer());
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  const plain = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(plain).arrayBuffer());
}

let vm: Vm | undefined;
let stopping = false;
/** Whether a stop came (a function: the checker doesn't follow a variable another handler sets). */
const stopped = () => stopping;
/** Held while paused: the loop waits on it. */
let paused: Promise<void> | undefined;
let unpause: (() => void) | undefined;
let screen: { start(): void; stop(): void } | undefined;

async function run(m: GuestStart) {
  // The machine's own workers load while the files come.
  const warm = warmWorkers(1, true);
  let v: Vm;
  try {
    const [core, kernel] = await Promise.all([
      file(CORE)
        .then((r) => r.arrayBuffer())
        .then(compileCore),
      image(),
    ]);
    if (stopped()) return warm?.end();
    v = vm = await bootVm(core, {
      ramSize: RAM,
      kernel,
      cmdline: `console=ttyAMA0 quiet waarm64.cols=${m.cols} waarm64.rows=${m.rows}`,
      framebuffer: { width: m.width, height: m.height },
      jit: 1,
      parallel: true,
      realtime: true,
      serialIn: m.serial,
      warm,
    });
  } catch (err) {
    warm?.end();
    throw err;
  }
  const fb = v.framebuffer;
  if (!fb) throw new Error('the machine has no framebuffer');
  let shown: ReturnType<typeof showFramebuffer> | undefined;
  screen = {
    // One context for the canvas's life: a pause stops the drawing, a resume starts it again.
    start: () => {
      if (shown) shown.start();
      else shown = showFramebuffer(m.screen, v.memory, fb, () => post({ type: 'screen' }));
    },
    stop: () => shown?.stop(),
  };
  if (!paused) screen.start();
  // Paused too: the counters then stand still because the vCPU does, not because nobody reads them.
  const timer = setInterval(() => {
    const s = v.stats();
    post({ type: 'stats', stats: { steps: s.steps, blocks: s.jit.blocks } });
  }, 1000);
  try {
    for (;;) {
      if (paused) await paused;
      const r = await v.runAsync(1e9);
      if (stopped()) return;
      const text = v.drain();
      if (text) post({ type: 'output', text });
      if (r.kind === Exit.BUDGET || r.kind === Exit.TX_FULL) continue;
      post({
        type: 'end',
        state: r.kind === Exit.PSCI ? 'off' : 'failed',
        detail: r.kind === Exit.PSCI ? undefined : `exit ${r.kind}`,
      });
      return;
    }
  } finally {
    clearInterval(timer);
    screen.stop();
  }
}

/** Frees what the start took: the vCPU's and the devices' workers, then (the page ends this worker) the memory. */
async function stop() {
  stopping = true;
  unpause?.();
  screen?.stop();
  await vm?.close();
  vm = undefined;
  post({ type: 'stopped' });
}

self.onmessage = (e: MessageEvent<ToGuest>) => {
  const m = e.data;
  if (m.type === 'start') {
    run(m).catch((err: unknown) => {
      if (!stopping)
        post({ type: 'end', state: 'failed', detail: err instanceof Error ? (err.stack ?? err.message) : String(err) });
    });
  } else if (m.type === 'pause' && !paused && !stopping) {
    paused = new Promise((resolve) => (unpause = resolve));
    screen?.stop();
    // A machine that ended meanwhile has nothing to pause: its end is said where the run loop sees it.
    vm?.pause().catch(() => undefined);
  } else if (m.type === 'resume' && paused) {
    paused = undefined;
    vm?.resume();
    screen?.start();
    unpause?.();
  } else if (m.type === 'stop') {
    void stop();
  }
};
