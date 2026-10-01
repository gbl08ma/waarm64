// A VM to a snapshot file and back (docs/plans/snapshots.md): web/vm.ts has the machine's state
// (`snapshot()`, `BootOptions.restore`), web/snapshot-file.ts the container, web/lz.ts its codec.
// The file: the header (what the machine is), CORE (the core's state), DEVS (the host's: backend
// state and pending input, JSON), then RAM. Round-robin VMs are saved between runs; a parallel one
// is paused first (`pause()`), and runs on afterwards.
import { applyRam, corrupt, openSnapshot, SnapshotError, SnapshotWriter, truncated, type Codec, type Sink, type SnapshotHeader } from './snapshot-file.ts';
import { lzCodec } from './lz.ts';
import { ABI, bootVm, Exit, type BootOptions, type ConsoleInput, type Restore, type Vm, type VmState } from './vm.ts';

/** What the caller says the machine is (the header's free fields): a restore checks what it needs of it. */
export type SnapshotMeta = Record<string, unknown>;

/**
 * Writes `vm`'s snapshot to `sink`. No vCPU may be in the core: between `run` calls after
 * `settle()`, or with `pause()` resolved true; the VM is unchanged and may run on once this
 * resolves (RAM must not move while it is written).
 */
export async function writeSnapshot(vm: Vm, sink: Sink, meta: SnapshotMeta, codec: Codec, progress?: (done: number, total: number) => void) {
  const state = await vm.snapshot();
  const header: SnapshotHeader = { ...meta, format: 1, coreVersion: state.version, abi: ABI, created: new Date().toISOString(), ramSize: vm.ramSize };
  const w = new SnapshotWriter(sink, header, { codec, concurrency: 1 });
  await w.bytes('CORE', state.core);
  await w.bytes('DEVS', new TextEncoder().encode(JSON.stringify(state.host)));
  const ram = await w.ram(new Uint8Array(vm.memory.buffer, vm.ram, vm.ramSize), progress);
  const end = await w.end();
  return { ...end, pages: ram.pages, state: state.core.length };
}

/**
 * Opens a snapshot for a restore: its header, and what `bootVm` takes as `restore`. `coreVersion`
 * is the running core's `snapshot_version` (a file of another is refused here, before anything is
 * touched). The file is read as `bootVm` fills the new VM's RAM, so a damaged or truncated one
 * throws its `SnapshotError` from there.
 */
export async function readSnapshot(source: ReadableStream<Uint8Array> | Blob, codec: Codec, coreVersion: number): Promise<{ header: SnapshotHeader; restore: Restore }> {
  const s = await openSnapshot(source, { codecs: [codec] });
  const { header } = s;
  if (header.coreVersion !== coreVersion) {
    throw new SnapshotError('other-version', `This snapshot was made by another version of this page (its machine state is format ${header.coreVersion}; this version reads ${coreVersion}). Open it in the version that made it.`);
  }
  const frames = s.frames();
  // CORE and DEVS come first, each in index order.
  const parts: Record<string, Uint8Array[]> = { CORE: [], DEVS: [] };
  let next = await frames.next();
  for (; !next.done && next.value.tag in parts; next = await frames.next()) {
    const { tag, index, data } = next.value;
    if (index !== parts[tag].length) throw corrupt("the machine's state is out of order");
    parts[tag].push(data);
  }
  const join = (p: Uint8Array[]) => {
    const out = new Uint8Array(p.reduce((n, b) => n + b.length, 0));
    p.reduce((at, b) => (out.set(b, at), at + b.length), 0);
    return out;
  };
  if (!parts.CORE.length || !parts.DEVS.length) throw next.done ? truncated() : corrupt("the machine's state is missing");
  let host: VmState['host'];
  try {
    host = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(join(parts.DEVS)));
  } catch {
    throw corrupt("the devices' state is not readable");
  }
  if (!Array.isArray(host?.devices) || !Array.isArray(host.input) || host.input.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) throw corrupt("the devices' state is not readable");
  const restore: Restore = {
    core: join(parts.CORE),
    host,
    async fill(ram) {
      if (ram.length !== header.ramSize) throw new SnapshotError('other-machine', `This snapshot is of a machine with ${Number(header.ramSize) / 2 ** 20} MiB of memory; this one has ${ram.length / 2 ** 20} MiB.`);
      for (; !next.done; next = await frames.next()) {
        const { tag, index, data } = next.value;
        if (tag !== 'RAM ') throw corrupt('it has parts this page doesn\'t expect');
        applyRam(ram, index, data);
      }
    },
  };
  return { header, restore };
}

/**
 * `runToPowerOff` with the VM saved to a snapshot file, closed, and a new one started from the
 * file each time the steps reach one of `at` (ascending): what the tests and benchmarks run a
 * guest through. `options(k)` changes the options of the VM started from snapshot `k` (the tier,
 * say). A deterministic guest takes the steps and prints what an unbroken run does. `files` has
 * each snapshot's size and the ms it took to write and to start from.
 */
export async function runThroughSnapshots(wasm: BufferSource | WebAssembly.Module, o: BootOptions, at: number[], maxSteps = 20e9, input?: ConsoleInput, options?: (k: number) => Partial<BootOptions>) {
  const module = wasm instanceof WebAssembly.Module ? wasm : await WebAssembly.compile(wasm);
  const codec = await lzCodec(module);
  let vm = await bootVm(module, o);
  const points = [...at];
  const files: { bytes: number; pages: number; saveMs: number; restoreMs: number }[] = [];
  let [console, hvc, steps] = ['', '', 0];
  const t0 = performance.now();
  for (;;) {
    const stop = Math.min(points[0] ?? Infinity, input?.step !== undefined && steps < input.step ? input.step : Infinity);
    const r = await vm.runAsync(Math.max(1, Math.min(100_000_000, stop - steps)));
    steps += r.steps;
    console += vm.drain();
    const idle = r.kind === Exit.IDLE;
    if (input && (idle || steps >= (input.step ?? Infinity) || (input.after !== undefined && console.includes(input.after)))) {
      vm.send(input.data);
      input = undefined;
      if (idle) continue;
    }
    if (r.kind === Exit.DEVICE) await vm.settle();
    const going = (r.kind === Exit.BUDGET || r.kind === Exit.TX_FULL || r.kind === Exit.DEVICE) && steps < maxSteps;
    if (going && points.length && steps >= points[0]) {
      points.shift();
      const parts: Uint8Array[] = [];
      const t = performance.now();
      if (!(await vm.pause())) throw new Error('the machine ended as it was paused');
      const w = await writeSnapshot(vm, (b) => { parts.push(b); }, { machine: 'test' }, codec);
      const saveMs = performance.now() - t;
      await vm.flush();
      hvc += vm.hvc();
      await vm.close();
      const t1 = performance.now();
      const { restore } = await readSnapshot(new Blob(parts as BlobPart[]), codec, codec.snapshotVersion);
      vm = await bootVm(module, { ...o, ...options?.(files.length), restore });
      files.push({ bytes: w.bytes, pages: w.pages, saveMs, restoreMs: performance.now() - t1 });
    }
    if (going) continue;
    const ms = performance.now() - t0;
    await vm.flush();
    await vm.close();
    return { ...r, kind: r.kind === Exit.DEVICE ? Exit.BUDGET : r.kind, steps, console, hvc: hvc + vm.hvc(), ms, pc: vm.pc(), files };
  }
}
