// Boot time of the Buildroot guest (target/images/linux, images/build.sh) on the
// wasm core in a worker, deterministic mode: time to the initramfs's /init
// ("webpc: init" on the console) and to power-off after /test.sh.
// Cold: a freshly compiled module per boot (V8 starts on Liftoff code).
// Warm: one module, reused after warm-up boots.
import type { Options, Sample } from '../spike/benchmarks.ts';
import { bootVm, Exit, PSCI_SYSTEM_OFF } from '../../web/vm.ts';

export const CMDLINE = 'console=ttyAMA0 earlycon panic=-1';
const CHUNK = 1_000_000; // steps per vm_run, so the /init marker is timed to ~a chunk

async function get(rel: string): Promise<Uint8Array<ArrayBuffer>> {
  const r = await fetch(new URL(rel, import.meta.url));
  if (!r.ok) throw new Error(`${rel}: ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

export async function images() {
  const [wasm, kernel, initrd] = await Promise.all([
    get('../../target/wasm32-unknown-unknown/release/webpc_core.wasm'),
    get('../../target/images/linux/Image'),
    get('../../target/images/linux/rootfs.cpio'),
  ]);
  return { wasm, kernel, initrd };
}

/** One boot to power-off: ms to "webpc: init" and to the end, and the counters. */
export async function boot(module: WebAssembly.Module, img: { kernel: Uint8Array; initrd: Uint8Array }, onVm?: (vm: Awaited<ReturnType<typeof bootVm>>) => void | Promise<void>) {
  const vm = await bootVm(module, { ramSize: 256 << 20, kernel: img.kernel, initrd: img.initrd, cmdline: CMDLINE });
  await onVm?.(vm);
  let console = '';
  let init = NaN;
  const t0 = performance.now();
  for (;;) {
    const r = vm.run(CHUNK);
    console += vm.drain();
    if (Number.isNaN(init) && console.includes('webpc: init')) init = performance.now() - t0;
    if (r.kind === Exit.BUDGET || r.kind === Exit.TX_FULL) continue;
    const total = performance.now() - t0;
    if (r.kind !== Exit.PSCI || r.x[0] !== PSCI_SYSTEM_OFF || !console.includes('webpc: test exit 0')) {
      throw new Error(`boot failed: exit ${r.kind} at pc 0x${vm.pc().toString(16)}\n${console}`);
    }
    return { init, total, stats: vm.stats() };
  }
}

export async function runAll(o: Options): Promise<Sample[]> {
  const img = await images();
  const cold = { init: [] as number[], total: [] as number[] };
  const warm = { init: [] as number[], total: [] as number[] };
  let stats;
  for (let i = 0; i < (o.quick ? 2 : 5); i++) {
    const t = performance.now();
    const module = await WebAssembly.compile(img.wasm);
    const r = await boot(module, img);
    // Cold includes compiling the core: it's part of a first boot.
    cold.init.push(r.init + (performance.now() - t - r.total));
    cold.total.push(performance.now() - t);
  }
  const module = await WebAssembly.compile(img.wasm);
  for (let i = 0; i < 3; i++) await boot(module, img);
  for (let i = 0; i < (o.quick ? 3 : 10); i++) {
    const r = await boot(module, img);
    warm.init.push(r.init);
    warm.total.push(r.total);
    stats = r.stats;
  }
  o.log?.(`warm total: ${warm.total.map((x) => x.toFixed(0)).join(' ')} ms; counters ${JSON.stringify(stats)}`);
  const params = { cmdline: CMDLINE, ramMiB: 256, steps: stats!.steps, counters: stats };
  return [
    { name: 'boot_init_cold', unit: 'ms', params, samples: cold.init },
    { name: 'boot_total_cold', unit: 'ms', params, samples: cold.total },
    { name: 'boot_init', unit: 'ms', params, samples: warm.init },
    { name: 'boot_total', unit: 'ms', params, samples: warm.total },
  ];
}

export const suite = { boot: runAll };
