// Boot time of the Buildroot guest (target/images/linux, images/build.sh) on the
// wasm core in a worker, deterministic mode, root filesystem on virtio-blk over
// HTTP ranges: time to /init ("webpc: init" on the console) and to power-off
// after /test.sh.
// Cold: a freshly compiled module per boot (V8 starts on Liftoff code).
// Warm: one module, reused after warm-up boots.
// `--only boot_defconfig`: the same with the arm64 defconfig kernel (Image-defconfig).
// `--only dd`: realtime mode, /bench-dd.sh reads all of /dev/vda; throughput
// timed by the host between its markers, one sample per boot.
import type { Options, Sample } from '../spike/benchmarks.ts';
import { bootVm, Exit, GUEST_CMDLINE as CMDLINE, guestDevices, PSCI_SYSTEM_OFF } from '../../web/vm.ts';

const CHUNK = 1_000_000; // steps per vm_run, so the /init marker is timed to ~a chunk

async function get(rel: string): Promise<Uint8Array<ArrayBuffer>> {
  const r = await fetch(new URL(rel, import.meta.url));
  if (!r.ok) throw new Error(`${rel}: ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

export async function images(image = 'Image') {
  const [wasm, kernel] = await Promise.all([
    get('../../target/wasm32-unknown-unknown/release/webpc_core.wasm'),
    get(`../../target/images/linux/${image}`),
  ]);
  return { wasm, kernel, disk: new URL('../../target/images/linux/rootfs.ext4', import.meta.url).href };
}

/** One boot to power-off: ms to "webpc: init" and to the end, and the counters. */
export async function boot(module: WebAssembly.Module, img: { kernel: Uint8Array; disk: string }, onVm?: (vm: Awaited<ReturnType<typeof bootVm>>) => void | Promise<void>, o: { cmdline?: string; realtime?: boolean } = {}) {
  const vm = await bootVm(module, { ramSize: 256 << 20, kernel: img.kernel, cmdline: o.cmdline ?? CMDLINE, devices: guestDevices(img.disk), realtime: o.realtime });
  await onVm?.(vm);
  let console = '';
  const marks: Record<string, number> = {};
  const t0 = performance.now();
  for (;;) {
    const r = vm.run(CHUNK);
    console += vm.drain();
    for (const m of ['webpc: init', 'webpc: dd start', 'webpc: dd end']) if (!(m in marks) && console.includes(m)) marks[m] = performance.now() - t0;
    if (r.kind === Exit.BUDGET || r.kind === Exit.TX_FULL) continue;
    const total = performance.now() - t0;
    vm.close();
    if (r.kind !== Exit.PSCI || r.x[0] !== PSCI_SYSTEM_OFF || !console.includes('webpc: test exit 0')) {
      throw new Error(`boot failed: exit ${r.kind} at pc 0x${vm.pc().toString(16)}\n${console}`);
    }
    return { init: marks['webpc: init'], total, marks, console, stats: vm.stats() };
  }
}

export async function runAll(o: Options, image = 'Image'): Promise<Sample[]> {
  const img = await images(image);
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
  const params = { kernel: image, cmdline: CMDLINE, ramMiB: 256, steps: stats!.steps, counters: stats };
  return [
    { name: 'boot_init_cold', unit: 'ms', params, samples: cold.init },
    { name: 'boot_total_cold', unit: 'ms', params, samples: cold.total },
    { name: 'boot_init', unit: 'ms', params, samples: warm.init },
    { name: 'boot_total', unit: 'ms', params, samples: warm.total },
  ];
}

/** Realtime sequential read of /dev/vda (the 32 MiB root image) over the synchronous-XHR block backend. */
async function dd(o: Options): Promise<Sample[]> {
  const img = await images();
  const module = await WebAssembly.compile(img.wasm);
  const size = Number((await fetch(img.disk, { method: 'HEAD' })).headers.get('content-length'));
  const cmdline = `${CMDLINE} -- /bench-dd.sh`;
  const mibs: number[] = [];
  for (let i = 0; i < (o.quick ? 3 : 10); i++) {
    const r = await boot(module, img, undefined, { cmdline, realtime: true });
    const ms = r.marks['webpc: dd end'] - r.marks['webpc: dd start'];
    if (!(ms > 0)) throw new Error(`no dd markers:\n${r.console}`);
    mibs.push(size / 2 ** 20 / (ms / 1000));
    o.log?.(`dd: ${ms.toFixed(0)} ms; guest: ${JSON.stringify(r.console.split('webpc: dd start')[1]?.split('webpc: dd end')[0].trim())}`);
  }
  return [{ name: 'blk_dd_read', unit: 'MiB/s', params: { cmdline, bytes: size, bs: '1M', realtime: true, backend: 'sync XHR, one request at a time' }, samples: mibs }];
}

export const suite = { boot: runAll, boot_defconfig: (o: Options) => runAll(o, 'Image-defconfig'), dd };
