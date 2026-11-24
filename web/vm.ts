// Host side of the whole-VM ABI (docs/abi.md): instantiates the core on
// shared memory, places guest RAM after the core's heap (layout A), boots an
// arm64 Image and runs it, draining the console. virtio backends run in a
// device worker (web/device-worker.ts) when this runs in a worker, and inline
// otherwise (Node, a page's main thread). Runs in a worker or in Node.
// Time is deterministic unless `realtime` is set (the host clock, and idle
// WFIs sleep on the signal word). With `parallel` (M7), every vCPU runs in
// its own worker (web/vcpu-worker.ts) and this thread coordinates them.
// The core instance's plumbing is web/core.ts, the device backends' owner web/device-host.ts, parallel mode's
// coordinator web/coordinator.ts.
import { chunkedHead, isManifestUrl } from './chunked.ts';
import { fusedFma } from './fma.ts';
import type { UsbIdentity, UsbVirtual } from './usb-device.ts';
import type { UsbAttach } from './usb.ts';
import { WindowWatch } from './window.ts';
import {
  Devices,
  ENTRY_WORDS,
  VENUS_ARENA,
  VENUS_WINDOW,
  deviceEntry,
  deviceShm,
  diskIdentity,
  type DeviceSpec,
} from './devices.ts';
import { fileSource } from './disk-sources.ts';
import { EV_CONFIG } from './virtio.ts';
import { isQcow2, qcow2Size } from './qcow2.ts';
import type { VcpuLiveness } from './liveness.ts';
import { corrupt, SnapshotError } from './snapshot-file.ts';
import { fromWire, msg, MsgError, type Msg, type WireError } from './msg.ts';
import type { InspectAnswer, InspectQuery } from './surface.ts';
import { cpuMask, type CpuFeature } from './cpu-features.ts';
import { HEAP_FLOOR, MAX_SPILL, MAX_SPILL_BYTES, ramLayout } from './ram.ts';
import {
  compileCore,
  coreImports,
  exactCore,
  Exit,
  instantiateThread,
  SIGNAL_RX,
  STOP,
  threadAlloc,
  unsigned,
  VM_CONFIG_WORDS,
  vmConfig,
  withPanic,
  type Stall,
} from './core.ts';
import { Counter, helperReport, stats } from './counters.ts';
import { coordinator } from './coordinator.ts';
import { deviceHost, usbHost } from './device-host.ts';
import type { WarmWorkers } from './warm-workers.ts';
export { HEAP_FLOOR, MAX_MEMORY0_RAM, MAX_SPILL, MAX_SPILL_BYTES, splitError, splitRam } from './ram.ts';

export const ABI = 74;
const RAM_BASE = 0x4000_0000;

const RING = 4096;
/** How long a snapshot waits for the paused VM's devices to be quiet (`snapshot`) before it gives up (`vm.cantSave.notQuiet`). */
const QUIET_MS = 10_000;

type Exports = {
  abi_version(): number;
  vm_new(ram: number, size: bigint, cfg: number): number;
  vm_boot(vm: number, kernel: bigint, initrd: bigint, initrdLen: bigint, cmdline: number, cmdlineLen: number): number;
  vm_run(vm: number, budget: bigint): number;
  vm_exit(vm: number): number;
  vm_console(vm: number): number;
  vm_cpu(vm: number, i: number): number;
  vm_counters(vm: number, i: number): number;
  vm_cpu_signal(vm: number, i: number): number;
  jit_helper_report(v: number): number;
  vm_signal(vm: number): number;
  vm_cpu_stop(vm: number, i: number): number;
  vm_set_chunk(vm: number, steps: bigint): void;
  vm_window_watch(vm: number): number;
  vm_device(vm: number, i: number): number;
  vm_xhci(vm: number): number;
  vm_framebuffer(vm: number): bigint;
  vm_flash(vm: number): number;
  panic_message(): number;
  thread_alloc(size: number, align: number): number;
  heap_reserve(pages: number): number;
  heap_stats(out: number): void;
  heap_probe(size: number): void;
  vm_jit_gauge(vm: number): number;
  vm_snapshot_size(vm: number): bigint;
  vm_snapshot_save(vm: number, ptr: number, len: number): bigint;
  vm_snapshot_restore(vm: number, ptr: number, len: number): number;
  snapshot_version(): number;
  vm_suspended(vm: number): number;
  vm_wake(vm: number): number;
};

/**
 * What a VM is besides its RAM, for a snapshot (docs/platform.md "Snapshots"): the core's state
 * (`vm_snapshot_save`, format `version`) and the host's, as JSON: each backend's state (null: none)
 * and the serial input the guest hasn't been given yet.
 */
export type VmState = { version: number; core: Uint8Array; host: { devices: unknown[]; input: number[] } };

/**
 * A snapshot to start a VM from instead of booting it (`BootOptions.restore`): its {@link VmState}
 * and `fill`, which writes the snapshot's RAM into the new VM's (zeroed) RAM, memory 0's and each spill memory's, before the core
 * restores its state.
 */
export type Restore = {
  core: Uint8Array;
  host: VmState['host'];
  fill(ram: Uint8Array, spill?: Uint8Array[]): void | Promise<void>;
};

/**
 * How often a vCPU worker returns to its event loop (web/vcpu-worker.ts `yieldMs`): Firefox's pages session went from
 * 3-6 stalls of 100-808 ms a session to none over 54 ms (bench/boot/REPORT.md "M8: V8's GC on the vCPU threads").
 */
export const VCPU_YIELD_MS = 100;

/**
 * `framebuffer`: a simple-framebuffer of that many pixels (x8r8g8b8) at the top
 * of RAM, which `bootVm`'s `framebuffer` locates for web/display.ts.
 */
export type BootOptions = {
  /** Guest RAM in memory 0 (at most `MAX_MEMORY0_RAM` (web/ram.ts) for a fixed memory). */
  ramSize: number;
  /**
   * `VmConfig.window` (ABI 53): the host-visible window's bytes, at the guest PA after RAM (a multiple of 2 MiB; 0, the
   * default, none); a transport whose entry has `shm` reports it as its shared memory region 1 (docs/devices.md
   * "virtio-gpu"). Its bytes are in memory 1 at `windowAt` (`VmConfig.window_at`, ABI 55: a Venus machine's
   * `VENUS_ARENA`, past the renderer's arena; else 0), node 1's RAM after them.
   */
  window?: number;
  windowAt?: number;
  /**
   * The spill memories' sizes (`VmConfig.spill`, ABI 39; docs/spill-memories.md): RAM past memory 0, each a
   * shared memory of its own and a CPU-less NUMA node for the guest; `splitRam` (web/ram.ts) makes the usual split.
   */
  spill?: number[];
  kernel: Uint8Array;
  initrd?: Uint8Array;
  cmdline: string;
  devices?: DeviceSpec[];
  /** What the devices tell the user while the machine runs on (a ramdisk out of memory): the page's message bar. */
  onNotice?: (m: Msg) => void;
  realtime?: boolean;
  framebuffer?: { width: number; height: number };
  /** Where in RAM the kernel goes (default 2 MiB); 0 for the bare-metal tests, linked at the start of RAM. */
  kernelOffset?: number;
  /** `VmConfig.jit`: 0 interpreter only (the default), 1 JIT, 2 JIT-stress, 3 JIT-check (ABI 24), 4 the block interpreter (the dispatcher without compiling, ABI 33). */
  jit?: 0 | 1 | 2 | 3 | 4;
  /**
   * `VmConfig.jit_bytes` (ABI 44): the JIT's code cache budget in wasm bytes, the most its live modules hold before a
   * flush (V8 spends several times that on their code and metadata: docs/jit.md "Memory"). Default (0): the core's,
   * `jit::MAX_BYTES`.
   */
  jitBytes?: number;
  /**
   * `VmConfig.fma` (ABI 58): the JIT's FMA forms use relaxed-SIMD's `madd` where the host fuses it ({@link fusedFma});
   * on unless false, which forces their emulation (`?fma=emul`; the guest sees no difference).
   */
  fma?: boolean;
  /** `VmConfig.features` bit 0 (ABI 19): the crypto extensions (AES, PMULL, SHA1, SHA256), advertised and implemented; on unless false (M6.5 loop 7). */
  crypto?: boolean;
  /**
   * `VmConfig.features` bit 1 (ABI 35): FEAT_RNG (`RNDR`, `RNDRRS`), advertised and implemented; on unless false.
   * Realtime mode keys its streams from `crypto.getRandomValues` (`VmConfig.rng_seed`), deterministic mode with zeros.
   */
  rng?: boolean;
  /** `VmConfig.features` bit 2 (ABI 35): FEAT_E0PD, which spares a KASLR kernel KPTI; on unless false. */
  e0pd?: boolean;
  /** `VmConfig.features` bit 3 (ABI 51): FEAT_SHA512 and FEAT_SHA3, advertised and implemented (with `crypto`); on unless false. */
  sha3?: boolean;
  /** `VmConfig.features` bit 4 (ABI 59): FEAT_JSCVT (`FJCVTZS`), advertised and implemented; on unless false. */
  jscvt?: boolean;
  /** `VmConfig.features` bits 5 to 9 (ABI 59): FEAT_LRCPC, FEAT_SB, FEAT_FlagM with FlagM2, FEAT_DIT, FEAT_FRINTTS; each on unless false. */
  rcpc?: boolean;
  sb?: boolean;
  flagm?: boolean;
  dit?: boolean;
  frintts?: boolean;
  /** `VmConfig.features` bit 10 (ABI 60): FEAT_DotProd; on unless false. */
  dotprod?: boolean;
  /** `VmConfig.features` bit 11 (ABI 61): FEAT_I8MM; off unless true (measured slower: docs/cpu.md). */
  i8mm?: boolean;
  /** `VmConfig.features` bit 12 (ABI 62): FEAT_RDM; on unless false. */
  rdm?: boolean;
  /** `VmConfig.features` bit 13 (ABI 62): FEAT_LRCPC2 (with `rcpc` only); on unless false. */
  rcpc2?: boolean;
  /** `VmConfig.features` bit 14 (ABI 63): FEAT_FCMA; off unless true (measured slower: docs/cpu.md). */
  fcma?: boolean;
  /** `VmConfig.features` bit 15 (ABI 65): FEAT_FP16; off unless true (docs/cpu.md). */
  fp16?: boolean;
  /** `VmConfig.features` bit 16 (ABI 65): FEAT_FHM (with `fp16` only); off unless true (docs/cpu.md). */
  fhm?: boolean;
  /** `VmConfig.features` bit 17 (ABI 66): FEAT_BF16; off unless true (docs/cpu.md). */
  bf16?: boolean;
  /**
   * The vCPUs' features as one list (web/cpu-features.ts; the page's machines pass it): each listed one on, the others
   * off, over the booleans above (`crypto` stays its own).
   */
  cpu?: readonly CpuFeature[];
  /** Test only: stalls one vCPU's host worker (parallel mode), see {@link Stall}; `addr` here is a guest PA. */
  stall?: Stall | Stall[];
  /** `VmConfig.ncpus` (ABI 21): vCPUs (default 1), round-robin on this thread unless `parallel`. */
  ncpus?: number;
  /**
   * `VmConfig.smp` 1 (ABI 25): a worker per vCPU (web/vcpu-worker.ts),
   * realtime only (it implies `realtime`). Drive it with `runAsync`.
   */
  parallel?: boolean;
  /**
   * Parallel mode: compile the JIT's modules in a worker of their own (web/jit-compile-worker.ts), the vCPUs
   * interpreting their blocks until then, instead of on the vCPU that emitted them (docs/jit.md "Sharing").
   * On unless false.
   */
  compileWorker?: boolean;
  /**
   * The browser's workers started ahead of `bootVm` ({@link warmWorkers}): taken where it would start its own, the
   * rest ended once the machine's are all started (or `bootVm` fails).
   */
  warm?: WarmWorkers;
  /**
   * Parallel mode: each vCPU worker returns to its event loop this often, in ms (web/vcpu-worker.ts `yieldMs`;
   * default {@link VCPU_YIELD_MS}, 0: never).
   */
  vcpuYieldMs?: number;
  /**
   * Realtime mode: throw if the vCPU sleeps this long with no timer deadline
   * and nothing signaled (a lost wake-up would otherwise hang the run).
   * Benchmarks set it; unset, an idle guest may sleep forever.
   */
  idleLimitMs?: number;
  /**
   * Input for the PL011 (the serial console): each message, a string or bytes,
   * goes to `send`. It's handled on this thread between runs: at once while
   * `runAsync` awaits (parallel mode), at the next `run` otherwise.
   */
  serialIn?: MessagePort;
  /**
   * The firmware configuration (`VmConfig.firmware`, ABI 29, docs/abi.md "M8
   * phase B"): `kernel` is EDK2's `QEMU_EFI.fd` (loaded at RAM + 512 KiB, its
   * `text_offset`), with no initrd or command line. `flash` is the saved
   * variable store (erased if absent; `flashSize` bytes, 1 MiB by default),
   * `fwCfg` fw_cfg's named files. Deterministic runs get a PL031 counting
   * from {@link FIRMWARE_EPOCH_MS}.
   */
  firmware?: Firmware;
  /**
   * A fixed-size memory (`VmConfig.mem_pages`, ABI 32; docs/abi.md "A fixed-size memory"), on
   * unless false: the memory is made at its final size, {@link HEAP_RESERVE} of it for the core's
   * heap, and JIT code imports it with exact limits, which spares Linux arm64 hosts a reload of its
   * size after every call (docs/v8.md "Bounds checks"). Off, or when RAM leaves no room for the
   * reserve, the memory grows as the core needs it.
   */
  fixedMemory?: boolean;
  /**
   * Tests only: the core's heap reserve in bytes (with the scratch page and fw_cfg's files, as {@link fixedPages}'s)
   * instead of {@link HEAP_RESERVE}, so a test runs the heap out in a minute (tests/heap.test.ts).
   */
  heapReserve?: number;
  /**
   * With a fixed memory, the core itself runs a copy that imports the memory with exact limits (docs/abi.md "A
   * fixed-size memory"), unless false, or `wasm` is a module not from {@link compileCore}.
   */
  exactCore?: boolean;
  /**
   * Start from a snapshot (ABI 30): `kernel`, `initrd`, `cmdline` and the firmware's flash and
   * files aren't used (RAM and the core's state have what the machine made of them); the rest
   * must describe the machine the snapshot was taken on, or `bootVm` throws a `SnapshotError`.
   */
  restore?: Restore;
  /**
   * An xHCI with 4 root connectors (`VmConfig.xhci`, ABI 38; docs/usb.md): `port` carries the
   * contract's messages (web/usb-device.ts `UsbToWorker`/`UsbFromWorker`: `usb-attach`, `usb-detach`,
   * one `usb-state` back for each) to the device worker, which takes them whenever they come, before
   * the guest's driver runs too (the port just shows a device). Without `port`, the VM's `usb` has
   * `attach`/`detach` that do the same. `attach`: devices plugged in before the guest runs. `events`:
   * plugs and unplugs at step counts, for `runToPowerOff` (exactly there in deterministic mode): `device`
   * to attach, none to detach. A machine without `usb` has no controller (its guests' steps are as they were).
   */
  usb?: { port?: MessagePort; attach?: UsbAttach[]; events?: UsbEvent[] };
};

/** A plug (with `device`) or an unplug of `connector` at `step` (`BootOptions.usb.events`). */
export type UsbEvent = { step: number; connector: number; device?: UsbIdentity | UsbVirtual };

export type Firmware = {
  flash?: Uint8Array;
  flashSize?: number;
  fwCfg?: { name: string; data: string | Uint8Array }[];
};

/** The PL031's start in deterministic firmware runs: 2026-09-01 00:00 UTC (as core/tests/common's). */
export const FIRMWARE_EPOCH_MS = 1_788_220_800_000;
/** Where the firmware goes in RAM: its `Image` header's text_offset, as QEMU puts it. */
const FIRMWARE_OFFSET = 512 << 10;
export const FLASH_SIZE = 1 << 20;
/** A fw_cfg file's name field, NUL included (core/src/fw_cfg.rs). */
const FW_CFG_NAME = 56;

/** fw_cfg's files in the core's buffer format: a NUL-padded name, a u32 LE size, the bytes. */
export function fwCfgBuffer(files: { name: string; data: string | Uint8Array }[]) {
  const parts = files.flatMap(({ name, data }) => {
    const n = new TextEncoder().encode(name);
    if (!n.length || n.length >= FW_CFG_NAME) throw new Error(`fw_cfg name ${name}: 1 to ${FW_CFG_NAME - 1} bytes`);
    const d = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const head = new Uint8Array(FW_CFG_NAME + 4);
    head.set(n);
    new DataView(head.buffer).setUint32(FW_CFG_NAME, d.length, true);
    return [head, d];
  });
  const out = new Uint8Array(parts.reduce((k, p) => k + p.length, 0));
  parts.reduce((k, p) => (out.set(p, k), k + p.length), 0);
  return out;
}

// The scratch page before RAM: VmConfig, device entries, the doorbell, the command line.
const S_CFG = 0;
const S_DEVICES = 512;
/** `heap_stats`'s two words (ABI 45). */
const S_HEAP = 384;
const S_BELL = 2048;
/** Parallel mode: the coordinator's word (vCPU workers bump it on TX_FULL). */
const S_CTL = 2056;
/** Parallel mode's pause word (a generation: odd while a pause is requested or held) and, from `S_PARKED`, each vCPU worker's word (the generation it is parked in). */
const S_PAUSE = 2060;
/** Parallel mode's start word: the vCPU workers wait there until all are instantiated (web/vcpu-worker.ts). */
const S_START = 2064;
const S_PARKED = 3072;
const S_CMDLINE = 4096;

export type Vm = Awaited<ReturnType<typeof bootVm>>;

/** The JIT cache's gauge words (`jit::GAUGE_WORDS`, `vm_jit_gauge`). */
const GAUGE_WORDS = 8;

/**
 * The core's heap in a fixed-size memory, its static data and stack included: the JIT's maps and
 * buffers, the devices', a vCPU worker's stack and TLS (~540–600 MiB under a heavy 4-vCPU load, docs/spill-memories.md
 * "The heap floor"). Running out traps the machine, so it is generous: untouched pages cost nothing.
 */
export const HEAP_RESERVE = 1 << 30;

/**
 * A fixed memory's size in pages (docs/abi.md "A fixed-size memory"): `ramSize` bytes of RAM and the heap reserve, which
 * holds everything else in memory 0 (the core's static data and stack, the scratch page, fw_cfg's files and the heap):
 * what 4 GiB leaves after RAM, capped at {@link HEAP_RESERVE}, never under `HEAP_FLOOR` (or the tests' `heapReserve`).
 * So memory 0's largest RAM (`MAX_MEMORY0_RAM`, 3 GiB) makes exactly 4 GiB, whatever fw_cfg's files; undefined past
 * 4 GiB, where the memory grows instead.
 */
export function fixedPages(ramSize: number, heapReserve?: number): number | undefined {
  const pages = ((heapReserve ?? Math.max(HEAP_FLOOR, Math.min(HEAP_RESERVE, 2 ** 32 - ramSize))) + ramSize) / 65536;
  return pages <= 65536 ? pages : undefined;
}

export async function bootVm(wasm: BufferSource | WebAssembly.Module, o: BootOptions) {
  try {
    return await boot(wasm, o);
  } catch (err) {
    o.warm?.end();
    throw err;
  }
}

async function boot(wasm: BufferSource | WebAssembly.Module, o: BootOptions) {
  // The same placement as core/tests/boot.rs: Image at +2 MiB, initrd at +128 MiB (the firmware at +512 KiB). Past
  // RAM's end in memory 0 lie fw_cfg's buffer and the core's heap: images that don't fit are refused.
  const kernelOff = o.kernelOffset ?? (o.firmware ? FIRMWARE_OFFSET : 2 << 20);
  const initrdOff = 128 << 20;
  if (!o.restore) {
    const need = Math.max(kernelOff + o.kernel.length, o.initrd ? initrdOff + o.initrd.length : 0);
    if (need > o.ramSize)
      throw new MsgError(
        'machine:vm.ramTooSmall',
        {},
        { cause: msg('machine:vm.ramTooSmall.need', { need, ram: o.ramSize }) },
      );
  }
  const fwCfg = o.firmware?.fwCfg?.length ? fwCfgBuffer(o.firmware.fwCfg) : undefined;
  // The memory's final size when it is fixed: RAM and the heap reserve, which holds the scratch page and fw_cfg's files.
  // The host-visible window: a Venus GPU's (web/devices.ts VENUS_WINDOW) unless the caller says. It is in memory 1,
  // after a Venus machine's renderer arena there (web/venus-host.ts, vk/README.md), before node 1's RAM.
  const venus = (o.devices ?? []).some((d) => d.type === 'gpu' && d.virgl && d.venus);
  const windowBytes = o.window ?? (venus ? VENUS_WINDOW : 0);
  const windowAt = windowBytes ? (o.windowAt ?? (venus ? VENUS_ARENA : 0)) : 0;
  const spillAt = windowBytes ? windowAt + windowBytes : 0;
  const fixedAt = o.fixedMemory !== false ? fixedPages(o.ramSize, o.heapReserve) : undefined;
  const fixed = fixedAt !== undefined;
  const pages = fixedAt ?? 65536;
  const memory = new WebAssembly.Memory({ initial: 32, maximum: pages, shared: true });
  // Memories 1 and up (docs/spill-memories.md), each at its final size: the spill memories' RAM, memory 1's after
  // what it holds before it (`VmConfig::memory_sizes`).
  const spillSizes = o.spill ?? [];
  if (spillSizes.length > MAX_SPILL || spillSizes.some((s) => !s || s % 65536 || s > MAX_SPILL_BYTES))
    throw new RangeError(
      `spill memories ${spillSizes.join(', ')}: at most ${MAX_SPILL}, each 64 KiB to 4 GiB in 64 KiB steps`,
    );
  const memSizes = spillAt ? [spillAt + (spillSizes[0] ?? 0), ...spillSizes.slice(1)] : spillSizes;
  if (memSizes[0] > MAX_SPILL_BYTES)
    throw new RangeError(`memory 1 holds the window at ${windowAt} and node 1's ${spillSizes[0]} bytes: past 4 GiB`);
  const spill = memSizes.map((s) => new WebAssembly.Memory({ initial: s / 65536, maximum: s / 65536, shared: true }));
  /** Each spill memory's RAM, memory 1 first (node 1's after the window there). */
  const spillRam = () =>
    spill.slice(0, spillSizes.length).map((m, k) => new Uint8Array(m.buffer, k ? 0 : spillAt, spillSizes[k]));
  const first = wasm instanceof WebAssembly.Module ? wasm : await compileCore(wasm);
  // The core that runs a fixed memory declares its exact size: compiled while the first instance lays the memory out.
  const exact = fixed && o.exactCore !== false ? exactCore(first, pages) : undefined;
  exact?.catch(() => {});
  const imports = coreImports(memory, undefined, undefined, undefined, spill);
  let module = first;
  let instance = await WebAssembly.instantiate(first, imports);
  imports.jit.bind(instance);
  let ex = unsigned(instance.exports) as unknown as Exports;
  if (ex.abi_version() !== ABI) throw new Error(`core ABI ${ex.abi_version()}, expected ${ABI}`);

  // Scratch page for VmConfig and the command line, then RAM.
  const scratch = memory.grow(1) * 65536;
  const ram = memory.grow(o.ramSize / 65536) * 65536;
  const bytes = () => new Uint8Array(memory.buffer);
  const specs = await Promise.all(
    (o.devices ?? []).map(async (d) => {
      if (d.type === 'gpu' && d.venus) return { ...d, window: windowBytes };
      if (d.type !== 'blk' || d.size !== undefined) return d;
      if (d.source || d.stored)
        throw new Error(`a ${d.source === 'ram' ? 'ramdisk' : d.stored ? 'stored disk' : 'blank disk'} needs a size`);
      if (!d.url && !d.file) throw new Error('a disk with no image (url, file or source)');
      // The capacity: a qcow2 header's virtual size, or the file size.
      if (d.file) {
        const head = new Uint8Array(await d.file.slice(0, 32).arrayBuffer());
        return { ...d, size: isQcow2(head) ? qcow2Size(head) : d.file.size };
      }
      if (d.url!.startsWith('file:')) {
        const f = await fileSource(d.url!);
        const head = f.read(0, 32)!;
        f.close?.();
        return { ...d, size: isQcow2(head) ? qcow2Size(head) : f.size };
      }
      if (isManifestUrl(d.url!)) {
        const { manifest, head } = await chunkedHead(d.url!);
        return { ...d, size: isQcow2(head) ? qcow2Size(head) : manifest.size };
      }
      const r = await fetch(d.url!, { headers: { Range: 'bytes=0-31' } });
      if (r.status !== 206) throw new Error(`${d.url}: ${r.status}`);
      const head = new Uint8Array(await r.arrayBuffer());
      return { ...d, size: isQcow2(head) ? qcow2Size(head) : Number(r.headers.get('content-range')?.split('/')[1]) };
    }),
  );
  const parallel = o.parallel ?? false;
  const deterministic = !o.realtime && !parallel;
  const ncpus = o.ncpus ?? 1;
  // VmConfig: RAM size, deterministic, CNTFRQ and ticks per step (defaults), device entries, framebuffer, JIT.
  const fb = o.framebuffer ?? { width: 0, height: 0 };
  // …, features, CPUs, GIC (ABI 21), parallel (ABI 25).
  // A PL031 RTC from the host's wall clock (ABI 28), realtime only, or in the firmware configuration from a fixed epoch.
  // The firmware configuration (ABI 29): the flash bank's size, fw_cfg's files (copied by vm_new).
  // A fixed memory's pages (ABI 32), else 0.
  // FEAT_RNG's key (ABI 35): the host's CSPRNG in realtime mode (the core ignores it in deterministic mode).
  const fw = o.firmware;
  const rtc = !deterministic ? BigInt(Date.now()) : fw ? BigInt(FIRMWARE_EPOCH_MS) : 0n;
  const fwCfgAt = fwCfg ? memory.grow(Math.ceil(fwCfg.length / 65536)) * 65536 : 0;
  if (fwCfg) bytes().set(fwCfg, fwCfgAt);
  // The rest of a fixed memory goes to the core's heap; the last page or two, which the
  // allocator's rounding leaves, the host grows itself.
  if (fixed) {
    // A RangeError, as a failed grow is (the page's "couldn't reserve" message).
    if (!ex.heap_reserve(pages)) throw new RangeError(`the core's heap reserve: no memory to grow ${pages} pages into`);
    memory.grow(pages - memory.buffer.byteLength / 65536);
    // The memory is at its size: the rest runs on the exact core, here and in every worker. The first instance only
    // laid the memory out (it can grow it; the exact one can't) and isn't called again.
    if (exact) {
      module = await exact;
      instance = instantiateThread(
        module,
        memory,
        threadAlloc(instance.exports),
        undefined,
        undefined,
        undefined,
        spill,
      );
      ex = unsigned(instance.exports) as unknown as Exports;
    }
  }
  // getRandomValues doesn't take a view of shared memory: a seed of its own, copied in.
  const seed = deterministic ? new BigUint64Array(4) : crypto.getRandomValues(new BigUint64Array(4));
  const features = cpuMask(o);
  new BigUint64Array(memory.buffer, scratch + S_CFG, VM_CONFIG_WORDS).set(
    vmConfig({
      ramSize: BigInt(o.ramSize),
      deterministic: deterministic ? 1n : 0n,
      devices: BigInt(scratch + S_DEVICES),
      ndevices: BigInt(specs.length),
      fbWidth: BigInt(fb.width),
      fbHeight: BigInt(fb.height),
      jit: BigInt(o.jit ?? 0),
      features,
      ncpus: BigInt(ncpus),
      smp: parallel ? 1n : 0n,
      rtc,
      firmware: fw ? 1n : 0n,
      flashSize: fw ? BigInt(fw.flashSize ?? FLASH_SIZE) : 0n,
      fwCfg: BigInt(fwCfgAt),
      fwCfgLen: BigInt(fwCfg?.length ?? 0),
      memPages: fixed ? BigInt(pages) : 0n,
      rngSeed: [...seed],
      xhci: o.usb ? 0x404n : 0n, // the xHCI's 4 + 4 ports (ABI 38)
      spill: Array.from({ length: MAX_SPILL }, (_, k) => BigInt(spillSizes[k] ?? 0)), // the spill memories' sizes (ABI 39)
      jitBytes: BigInt(o.jitBytes ?? 0), // the JIT's code cache budget (ABI 44)
      window: BigInt(windowBytes), // the host-visible window (ABI 53)
      windowAt: BigInt(windowAt), // where it is in memory 1 (ABI 55)
      fma: o.fma !== false && fusedFma() ? 1n : 0n, // the JIT's FMA forms on the host's fused madd (ABI 58)
    }),
  );
  new BigUint64Array(memory.buffer, scratch + S_DEVICES, ENTRY_WORDS * specs.length).set(
    specs.flatMap((d) => [...deviceEntry(d).entry, deviceShm(d)]),
  );
  const cmd = new TextEncoder().encode(o.cmdline);
  bytes().set(cmd, scratch + S_CMDLINE);
  if (!o.restore) {
    bytes().set(o.kernel, ram + kernelOff);
    if (o.initrd) bytes().set(o.initrd, ram + initrdOff);
  }

  const vm = ex.vm_new(ram, BigInt(o.ramSize), scratch + S_CFG);
  if (!vm) throw new Error('vm_new failed');
  const flashAt = fw ? ex.vm_flash(vm) : 0;
  const flashSize = fw?.flashSize ?? FLASH_SIZE;
  const shared = specs.map((_, i) => ex.vm_device(vm, i));
  if (o.restore) {
    // RAM first (the transports read the chains their backends held from it), then the core's
    // state: the registers, the devices, their config spaces, the flash bank.
    await o.restore.fill(new Uint8Array(memory.buffer, ram, o.ramSize), spillRam());
    const { core } = o.restore;
    const at = ex.thread_alloc(core.length, 16);
    if (!at) throw new Error("no memory for the snapshot's state");
    bytes().set(core, at);
    let r: number;
    try {
      r = ex.vm_snapshot_restore(vm, at, core.length);
    } catch (err) {
      throw withPanic(err, ex, memory);
    }
    if (r === 1)
      throw new SnapshotError('snapshots:vm.otherVersion', { format: ex.snapshot_version() }, 'other-version');
    if (r === 2) throw new SnapshotError('snapshots:vm.otherHardware', {}, 'other-machine');
    if (r) throw corrupt(msg('snapshots:vm.damage.inconsistent'));
  } else {
    if (fw?.flash) {
      if (fw.flash.length !== flashSize)
        throw new Error(`firmware.flash: ${fw.flash.length} bytes, the bank has ${flashSize}`);
      bytes().set(fw.flash, flashAt);
    }
    const initrdLen = BigInt(o.initrd?.length ?? 0);
    if (
      ex.vm_boot(
        vm,
        BigInt(RAM_BASE + kernelOff),
        BigInt(RAM_BASE + initrdOff),
        initrdLen,
        scratch + S_CMDLINE,
        cmd.length,
      )
    ) {
      throw new Error('vm_boot rejected the Image or layout');
    }
    Devices.writeConfig(memory, shared, specs);
  }
  const signal = ex.vm_signal(vm);
  const wakes = Array.from({ length: ncpus }, (_, i) => ex.vm_cpu_signal(vm, i));
  // Parallel SMP's stop words (ABI 71): 0 after a signal bit, so compiled code stops at its next poll.
  const stops = parallel ? Array.from({ length: ncpus }, (_, i) => ex.vm_cpu_stop(vm, i)) : [];
  // The xHCI's messages: the caller's port, or a channel of our own behind `usb.attach`/`usb.detach`.
  const usbChannel = o.usb && !o.usb.port ? new MessageChannel() : undefined;
  const xhci = o.usb
    ? { shared: ex.vm_xhci(vm), port: o.usb.port ?? usbChannel!.port1, attach: o.usb.attach }
    : undefined;
  // Each device's two I/O byte counters (`DevicesInit.io`), shared with the device worker that adds to them, then the xHCI's.
  const ioBytes = 16 * (specs.length + 1);
  const io = new Float64Array(
    typeof SharedArrayBuffer === 'function' ? new SharedArrayBuffer(ioBytes) : new ArrayBuffer(ioBytes),
  );
  // The window is memory 1's bytes at `windowAt`; its write-watch's words are memory 0's.
  const venusWindow = windowBytes ? { at: windowAt, bytes: windowBytes, watch: ex.vm_window_watch(vm) } : undefined;
  const layout = ramLayout(o.ramSize, spillSizes, windowBytes, spillAt);
  const devices = await deviceHost(
    {
      memory,
      core: first,
      shared,
      ram,
      ramSize: o.ramSize,
      layout,
      window: venusWindow,
      spill,
      signal,
      specs,
      deterministic,
      wakes,
      stops,
      state: o.restore?.host.devices,
      xhci,
      io,
    },
    scratch + S_BELL,
    parallel,
    o.onNotice,
    o.warm,
  );
  const usb = usbChannel && usbHost(usbChannel.port2);
  // The restore posted the chains the old backends held to the request rings: the new ones take them. A backend that
  // throws on one fails the start: its files are released (a start after it opens them again: web/app/worker.ts).
  if (o.restore)
    await devices.quiesce().catch(async (e: unknown) => {
      await devices.close();
      throw e;
    });
  /** Sets signal-word bits, then bumps and notifies every vCPU's wake word (docs/abi.md). */
  const raise = (bits: number) => {
    const i32 = new Int32Array(memory.buffer);
    Atomics.or(i32, signal / 4, bits);
    Atomics.notify(i32, signal / 4);
    for (const p of stops) Atomics.store(i32, p / 4, 0);
    for (const w of wakes) {
      Atomics.add(i32, w / 4, 1);
      Atomics.notify(i32, w / 4);
    }
  };
  // Realtime idling blocks on the signal word, which a page's main thread can't.
  const canBlock = typeof window === 'undefined';

  const tx = ex.vm_console(vm);
  const decoder = new TextDecoder();
  /** Takes what the guest wrote since the last call. */
  const drain = () => {
    const u32 = new Uint32Array(memory.buffer);
    const head = Atomics.load(u32, tx / 4);
    const tail = Atomics.load(u32, tx / 4 + 1);
    // The ring's one or two spans (it wraps), copied out before the tail moves on.
    const n = (head - tail) >>> 0;
    const at = tail % RING;
    const first = Math.min(n, RING - at);
    const buf = bytes();
    const out = new Uint8Array(n);
    out.set(buf.subarray(tx + 8 + at, tx + 8 + at + first));
    if (n > first) out.set(buf.subarray(tx + 8, tx + 8 + n - first), first);
    Atomics.store(u32, tx / 4 + 1, head);
    return decoder.decode(out, { stream: true });
  };
  // Console input: the host is the RX ring's one producer (it follows TX: core/src/pl011.rs `Rings`).
  const rx = tx + 8 + RING;
  const queued: Uint8Array[] = [];
  const encoder = new TextEncoder();
  /** Moves queued input into the RX ring as far as it has room, and wakes the vCPUs if it moved any. */
  const pump = () => {
    if (!queued.length) return;
    const u32 = new Uint32Array(memory.buffer);
    const buf = bytes();
    const tail = Atomics.load(u32, rx / 4 + 1);
    const start = Atomics.load(u32, rx / 4);
    let head = start;
    while (queued.length && (head - tail) >>> 0 < RING) {
      const chunk = queued[0];
      const n = Math.min(chunk.length, RING - ((head - tail) >>> 0));
      for (let k = 0; k < n; k++) buf[rx + 8 + (((head + k) >>> 0) % RING)] = chunk[k];
      head = (head + n) >>> 0;
      if (n === chunk.length) queued.shift();
      else queued[0] = chunk.subarray(n);
    }
    if (head !== start) {
      Atomics.store(u32, rx / 4, head); // after the bytes (sequentially consistent)
      raise(SIGNAL_RX);
    }
  };
  /** Queues bytes (a string as UTF-8) for the guest's PL011; what the RX ring can't take yet waits for the next run. */
  const send = (data: string | Uint8Array | ArrayBuffer) => {
    const b = typeof data === 'string' ? encoder.encode(data) : new Uint8Array(data).slice(); // a copy: the caller may reuse its buffer
    if (b.length) queued.push(b);
    pump();
  };
  if (o.serialIn) o.serialIn.onmessage = (e: MessageEvent) => send(e.data);
  // Input the saved machine's host hadn't given the guest yet: at the first run's pump, as there.
  if (o.restore?.host.input.length) queued.push(Uint8Array.from(o.restore.host.input));
  /** The buffer `snapshot` has the core write its state to (never freed: kept for the next one). */
  let stateBuf = { at: 0, len: 0 };
  const blocks = Array.from({ length: ncpus }, (_, i) => ex.vm_counters(vm, i));
  // The JIT cache's gauge (ABI 45), asked for before any vCPU runs.
  const gauge = ex.vm_jit_gauge(vm);
  const counters = blocks[0];
  /** Counter `i` summed over the vCPUs' blocks (round-robin counts everything in block 0). */
  const counter = (i: number) =>
    blocks.reduce((sum, b) => sum + Number(Atomics.load(new BigUint64Array(memory.buffer, b, Counter.LEN), i)), 0);
  const fbPa = Number(ex.vm_framebuffer(vm));
  /** The round-robin exit's record (`run`), a view made again once the memory grew (its buffer is a new one). */
  let exitAt: number | undefined;
  let exitView: BigUint64Array | undefined;
  const exitInfo = () => {
    if (exitView?.buffer !== memory.buffer) exitView = new BigUint64Array(memory.buffer, exitAt, 7);
    return exitView;
  };
  const par = parallel
    ? coordinator({
        module,
        memory,
        spill,
        instance,
        vm,
        ncpus,
        bell: scratch + S_BELL,
        ctl: scratch + S_CTL,
        pause: scratch + S_PAUSE,
        parked: scratch + S_PARKED,
        start: scratch + S_START,
        raise,
        clearStop: () => void Atomics.and(new Int32Array(memory.buffer), signal / 4, ~STOP),
        quiesce: () => devices.quiesce(),
        stall: [o.stall ?? []].flat().map((x) => ({ ...x, addr: ram + x.addr - RAM_BASE })),
        compileWorker: (o.jit ?? 0) !== 0 && o.compileWorker !== false,
        yieldMs: o.vcpuYieldMs ?? VCPU_YIELD_MS,
        warm: o.warm,
      })
    : undefined;
  if (!par) o.warm?.end();
  const RING_HALF = RING / 2;
  const txUsed = () => {
    const u32 = new Uint32Array(memory.buffer);
    return (Atomics.load(u32, tx / 4) - Atomics.load(u32, tx / 4 + 1)) >>> 0;
  };
  const txHead = () => Atomics.load(new Uint32Array(memory.buffer), tx / 4);
  /** The TX ring's head when `runAsync` last returned: it also wakes on output after that. */
  let seenHead = 0;
  return {
    memory,
    /** The core runs the copy that imports the memory with exact limits (`BootOptions.exactCore`). */
    exactCore: module !== first,
    /**
     * Tests only: an infallible allocation of `size` bytes on this thread's core (ABI 50); one the heap can't hold
     * traps, with the allocation error hook's message.
     */
    heapProbe: (size: number) => {
      try {
        ex.heap_probe(size);
      } catch (err) {
        throw withPanic(err, ex, memory);
      }
    },
    /** The xHCI's connectors when `BootOptions.usb` has no port of the caller's: attach or detach, resolving with the device worker's `usb-state`. */
    usb,
    /** Bytes of guest RAM (at `ram`). */
    ramSize: o.ramSize,
    /** The host-visible window's write-watch (`BootOptions.window`; its bytes are memory 1's at `window.at`). */
    watch: windowBytes ? new WindowWatch(memory, ex.vm_window_watch(vm)) : undefined,
    /** The window's bytes (`BootOptions.window`), if there is one: `bytes` at `at` in `spill[0]`. */
    window: venusWindow,
    /** Memories 1 and up, memory 1 first: the guest RAM past memory 0 (`spillRam`), and memory 1's renderer arena and window before node 1. */
    spill,
    /** Each spill memory's RAM (`BootOptions.spill`), memory 1's node 1 first: what a snapshot keeps. */
    spillRam,
    /** Whether the guest is in PSCI SYSTEM_SUSPEND: every vCPU off until `wake` (docs/platform.md "System suspend"). */
    suspended: () => ex.vm_suspended(vm) !== 0,
    /** Wakes a guest in SYSTEM_SUSPEND: its vCPU resumes where the guest asked. False if it wasn't suspended. */
    wake() {
      if (!ex.vm_wake(vm)) return false;
      raise(0); // round-robin's host may sleep on the signal word with no deadline
      return true;
    },
    /**
     * The VM's state for a snapshot, with every vCPU out of the core: between `run` calls after
     * `settle()`, or once `pause()` resolved true. Guest RAM (`memory` at `ram`, `ramSize` bytes) is
     * the snapshot's other half: copy it before the VM runs on. The VM is unchanged but for its realtime clock, held at the saved reading until a vCPU runs again.
     */
    async snapshot(): Promise<VmState> {
      // Bounded by time, not tries: a paused guest's backlog (chains that didn't fit a request ring, a few posted each
      // round trip: a desktop's queue of 3D commands) always ends, but may take more than 1000 round trips.
      for (let tries = 0, until = performance.now() + QUIET_MS; tries < 1000 || performance.now() < until; tries++) {
        // Takes the completions the backends left, as the run loop would at its next boundary.
        const n = ex.vm_snapshot_size(vm);
        if (n === 0xffff_ffff_ffff_ffffn)
          throw new MsgError(
            'snapshots:vm.cantSaveNow',
            {},
            { cause: o.usb ? msg('snapshots:vm.cantSaveNow.usb') : msg('snapshots:vm.cantSaveNow.buffers') },
          );
        if (n === 0n) {
          // A device has something for its backend (chains that hadn't fit, an event): serve it.
          await devices.quiesce();
          continue;
        }
        if (stateBuf.len < Number(n)) {
          const len = Number(n) + 65536;
          const at = ex.thread_alloc(len, 16);
          if (!at) throw new Error("no memory for the machine's state");
          stateBuf = { at, len };
        }
        const got = Number(ex.vm_snapshot_save(vm, stateBuf.at, stateBuf.len));
        if (!got) continue; // a backend completed something in between
        const saved = await devices.save();
        // A device that can't be saved now says why (web/gpu.ts `save`), as an error posted across workers.
        const why = saved.map((d) => (d as { unsaveable?: WireError } | null)?.unsaveable).find((x) => x);
        if (why) throw new MsgError('snapshots:vm.cantSave', {}, { cause: fromWire(why) });
        return {
          version: ex.snapshot_version(),
          core: bytes().slice(stateBuf.at, stateBuf.at + got),
          host: { devices: saved, input: queued.flatMap((b) => [...b]) },
        };
      }
      throw new MsgError('snapshots:vm.cantSave', {}, { cause: msg('snapshots:vm.cantSave.notQuiet') });
    },
    /**
     * The writable disks' changes, for a snapshot (the VM as for `snapshot()`): for each disk with
     * an overlay, and each ramdisk, its slot, what its overlay belongs to (`diskIdentity`), its size, the blocks
     * (4 KiB, ascending) the overlay (or the ramdisk) holds, and the overlay's path and generation
     * (docs/machines.md §5.1: what the snapshot pins; asking moves the next change's generation on);
     * `diskBlocks` reads some of them.
     */
    async disks(): Promise<
      {
        slot: number;
        identity: string;
        size: number;
        blocks: Uint32Array;
        overlay?: string;
        generation?: number;
        ram?: boolean;
      }[]
    > {
      const out = [];
      for (const [slot, d] of specs.entries()) {
        if (d.type !== 'blk' || !(d.overlay || d.source === 'ram')) continue;
        const w = await devices.written(slot);
        if (w)
          out.push({
            slot,
            identity: diskIdentity(d, d.size ?? 0),
            size: d.size ?? 0,
            blocks: w.blocks,
            overlay: d.overlay,
            generation: w.generation,
            ...(d.source === 'ram' ? { ram: true } : {}),
          });
      }
      return out;
    },
    diskBlocks: (slot: number, blocks: Uint32Array) => devices.blocks(slot, blocks),
    /** The disks' overlays compacted (after the guest's trim: web/app/areas/trim-actions.ts; `measure`: only their sizes): their files' bytes before and after. */
    compact: (measure = false) => devices.compact(measure),
    /**
     * A disk's surface or one of its ranges (web/surface.ts), answered from the device's maps in memory: `query.disk`
     * is the disk's place among the machine's disks (its blk devices, in slot order); `none` past them.
     */
    inspect(query: InspectQuery): Promise<InspectAnswer> {
      if (!('disk' in query)) return Promise.resolve({ kind: 'none' }); // RAM's are the machine worker's (web/app/worker-ram.ts)
      const slot = specs.map((d, i) => (d.type === 'blk' ? i : -1)).filter((i) => i >= 0)[query.disk];
      return slot === undefined ? Promise.resolve({ kind: 'none' }) : devices.inspect(slot, query);
    },
    /**
     * The balloon's free page hint (web/balloon.ts), with the machine running, right before a snapshot or a suspend:
     * the guest holds its free memory, zeroed, once it resolves (after `ms` at most); undefined without a balloon whose
     * driver hints. `release` gives it back after the save.
     */
    hint: (ms: number) => devices.hint(ms),
    release: () => devices.release(),
    /**
     * Why a snapshot would be refused now, or undefined, asked of the devices while the machine runs: a snapshot checks
     * it before it touches the machine (its input, the pause). `snapshot()` decides again.
     */
    async refusal(): Promise<MsgError | undefined> {
      const why = await devices.refusal();
      return why ? new MsgError('snapshots:vm.cantSave', {}, { cause: fromWire(why) }) : undefined;
    },
    /** Device `i`'s virtio status register (bit 2 is DRIVER_OK: a guest driver is using it). */
    deviceStatus: (i: number) => Atomics.load(new Uint32Array(memory.buffer), (shared[i] + 4) / 4),
    /** The backends' state (`Devices.save`: for a snapshot; a test reads the display's hashes from it), with the devices quiet. */
    deviceState: async () => {
      await devices.quiesce();
      return devices.save();
    },
    /** The framebuffer (web/display.ts): byte address in `memory`, width, height; x8r8g8b8, packed rows. */
    framebuffer: fbPa ? { addr: ram + fbPa - RAM_BASE, ...fb } : undefined,
    /** A copy of the firmware configuration's flash bank (the variable store), to save once the vCPUs stopped; undefined without one. */
    flash: () => (flashAt ? bytes().slice(flashAt, flashAt + flashSize) : undefined),
    /** Byte addresses of guest RAM (PA 0x4000_0000) and of the vCPU registers (`cpu::Cpu`) in `memory`. */
    ram,
    /** Where each memory's RAM is in the guest's physical address space, memory 0 first (web/ram.ts `RamLayout`). */
    layout,
    /**
     * What the machine holds that its host pays for, cheaply (docs/jit.md "The page's memory signal"): the guest's RAM
     * (memory 0's and the spill memories'), the core's heap (`heap_stats`: live bytes and their high-water mark), and
     * the JIT's cache (`vm_jit_gauge`: the wasm bytes and modules since the last flush, the budget, the epochs; ABI 47:
     * the block map's keys and the heap bytes its table takes, the module bytes held for vCPUs that haven't taken them).
     */
    hostUse: () => {
      const h = new BigUint64Array(memory.buffer, scratch + S_HEAP, 2);
      ex.heap_stats(scratch + S_HEAP);
      const g = (i: number) =>
        gauge ? Number(Atomics.load(new BigUint64Array(memory.buffer, gauge, GAUGE_WORDS), i)) : 0;
      return {
        ramBytes: o.ramSize + spillSizes.reduce((a, b) => a + b, 0),
        heapLive: Number(h[0]),
        heapPeak: Number(h[1]),
        jitLiveBytes: g(0),
        jitModules: g(1),
        jitBudget: g(2),
        jitEpochs: g(3),
        jitLimit: g(4),
        jitKeys: g(5),
        jitKeyBytes: g(6),
        jitHeld: g(7),
      };
    },
    /** Caps the JIT's budget at `bytes` (the gauge's limit word, ABI 45; at least 16 MiB; 0: the machine's budget): the page's memory signal. */
    setJitLimit: (bytes: number) => {
      if (gauge)
        Atomics.store(new BigUint64Array(memory.buffer, gauge, GAUGE_WORDS), 4, BigInt(Math.max(0, Math.round(bytes))));
    },
    /**
     * What the core's heap has touched, for benchmarks (docs/spill-memories.md "The heap floor"): the non-zero 4 KiB
     * pages below the scratch page (the core's data, stacks and first heap), and in the reserve past RAM and fw_cfg's
     * files, and how far into the reserve the last one is (the allocator carves it from its start, and freed memory
     * keeps its bytes, so that is the heap's high-water mark). Scans the memory: tenths of a second for a 1 GiB reserve.
     */
    heapUse: () => {
      const w = new Uint32Array(memory.buffer);
      const nonzero = (page: number) => {
        for (let i = page * 1024, e = i + 1024; i < e; i++) if (w[i]) return true;
        return false;
      };
      const reserve = (fwCfg ? fwCfgAt + Math.ceil(fwCfg.length / 65536) * 65536 : ram + o.ramSize) / 4096;
      let below = 0,
        touched = 0,
        high = 0;
      const buckets: number[] = []; // MiB touched in each 32 MiB of the reserve
      for (let p = 0; p < scratch / 4096; p++) if (nonzero(p)) below++;
      // A Venus machine's renderer arena, memory 1's first bytes, is counted apart (its data and stack at its base, its
      // heap upward from them: the highest touched page is its high-water mark).
      const arena = venus ? VENUS_ARENA : 0;
      const w1 = arena ? new Uint32Array(spill[0].buffer, 0, arena / 4) : undefined;
      let arenaTouched = 0,
        arenaHigh = 0;
      for (let p = 0; p < arena / 4096; p++) {
        let any = false;
        for (let i = p * 1024, e = i + 1024; i < e; i++)
          if (w1![i]) {
            any = true;
            break;
          }
        if (any) {
          arenaTouched++;
          arenaHigh = p + 1;
        }
      }
      // The allocator's segment record sits at the reserve's end: the high-water mark leaves out the last 64 KiB.
      const top = memory.buffer.byteLength / 4096;
      for (let p = reserve, end = top; p < end; p++) {
        if (!nonzero(p)) continue;
        touched++;
        if (p < end - 16) high = p - reserve + 1;
        const b = Math.floor((p - reserve) / 8192);
        buckets[b] = (buckets[b] ?? 0) + 1 / 256;
      }
      return {
        memoryBytes: top * 4096,
        belowBytes: below * 4096,
        reserveBytes: top * 4096 - reserve * 4096,
        touchedBytes: touched * 4096,
        highBytes: high * 4096,
        buckets: Array.from(buckets, (x) => Math.round(x ?? 0)),
        arenaBytes: arena,
        arenaTouchedBytes: arenaTouched * 4096,
        arenaHighBytes: arenaHigh * 4096,
      };
    },
    cpu: ex.vm_cpu(vm, 0),
    /** Byte address of vCPU 0's `vm::Counters` in `memory` (u64s, read with Atomics.load; its PC word is vCPU 0's). */
    counters,
    /** Every vCPU's counters block (parallel mode: each publishes its own PC there; round-robin: only block 0 is live). */
    counterBlocks: blocks,
    /** Sets bits in the signal word and wakes every vCPU (docs/abi.md). */
    signal: raise,
    /** Parallel mode's steps between two publications of a vCPU's PC (0: the default); the PC sampler shortens it. */
    setChunk: (steps: number) => ex.vm_set_chunk(vm, BigInt(steps)),
    /** A snapshot of the counters, summed over the vCPUs; exceptions by EC only where non-zero. */
    stats: () => stats(counter),
    /** The vCPUs run each on its own worker (`VmConfig.parallel`): `cpuStats` is then per vCPU. */
    parallel,
    /**
     * Each device's I/O bytes since the VM started (`DevicesInit.io`), by device index (`VmConfig.devices`): [2i] and
     * [2i + 1] are a blk's bytes read and written, a net's bytes received (to the guest) and sent; 0 for other kinds.
     * The pair after the last device's is the xHCI's (`Usb`): the bytes its devices gave the guest (IN) and took (OUT).
     * The live view (the device worker adds to it): read it, don't keep a copy expecting it to move.
     */
    deviceIo: () => io,
    /** The same for each vCPU's own block (parallel mode; round-robin counts everything in vCPU 0's). */
    cpuStats: () =>
      blocks.map((b) => stats((i) => Number(Atomics.load(new BigUint64Array(memory.buffer, b, Counter.LEN), i)))),
    /** The JIT's helper calls by instruction class, most frequent first (ABI 18; empty without a JIT). */
    helperReport: () => helperReport(ex, memory, ex.vm_cpu(vm, 0)),
    /**
     * Runs up to `budget` steps; returns the exit kind and steps taken. DEVICE
     * exits are handled here (the backends take the requests, and in
     * deterministic mode this waits for them), as core/tests/common does,
     * except where the backends run inline (Node, a page's main thread) and
     * have work in flight: then it returns `DEVICE`, and the caller awaits
     * `settle()` before running on. In realtime mode an idle WFI sleeps here
     * until its deadline or a signal.
     */
    run(budget: number) {
      if (par) throw new Error('a parallel VM runs through runAsync');
      exitAt ??= ex.vm_exit(vm);
      let steps = 0;
      for (;;) {
        pump();
        let kind: number;
        try {
          kind = ex.vm_run(vm, BigInt(budget - steps));
        } catch (err) {
          throw withPanic(err, ex, memory);
        }
        const info = exitInfo(); // kind, steps, value, x0-x3
        steps += Number(info[1]);
        if (kind === Exit.DEVICE) {
          // A config-space write waits even in realtime mode: the driver reads
          // the answer next (virtio-input's select/subsel).
          devices.kick(deterministic || (Number(info[2] >> 8n) & EV_CONFIG) !== 0);
          if (devices.inFlight()) return { kind, steps, value: info[2], x: [...info.subarray(3)] };
          if (steps < budget) continue;
        }
        // Idle with input queued (deterministic time: nothing else would wake it): the next pump fills the ring.
        if (kind === Exit.IDLE && deterministic && queued.length) continue;
        if (kind === Exit.IDLE && !deterministic && canBlock) {
          const sig = new Int32Array(memory.buffer, signal, 1);
          const ns = info[2];
          const none = ns === 0xffff_ffff_ffff_ffffn;
          const ms = none ? (o.idleLimitMs ?? Infinity) : Number(ns) / 1e6;
          if (Atomics.load(sig, 0) === 0 && Atomics.wait(sig, 0, 0, ms) === 'timed-out' && none) {
            throw new Error(
              `idle ${ms} ms with no timer deadline and no signal at pc 0x${new BigUint64Array(memory.buffer, ex.vm_cpu(vm, 0) + 256, 1)[0].toString(16)}; device requests in flight: ${devices.inFlight()}`,
            );
          }
          continue;
        }
        return { kind: kind === Exit.DEVICE ? Exit.BUDGET : kind, steps, value: info[2], x: [...info.subarray(3)] };
      }
    },
    /**
     * `run` for either mode. In parallel mode the vCPU workers run on their
     * own (started by the first call); this returns once they retired
     * `budget` steps together, the console's TX ring is half full (`TX_FULL`:
     * drain it), the console has any output (`BUDGET`, so a terminal's echo
     * isn't held back: at once when the caller drained the ring, since the
     * core notifies its head on a byte into an empty ring; within the 10 ms
     * this waits at a time otherwise), 50 ms passed (`BUDGET`), or an exit
     * ended the run on some vCPU (then every worker has stopped). With
     * `idleLimitMs`, it throws if no vCPU retired a step for that long.
     */
    async runAsync(budget: number): Promise<{ kind: number; steps: number; value: bigint; x: bigint[] }> {
      try {
        if (!par) return this.run(budget);
        const s0 = counter(Counter.STEPS);
        const t0 = performance.now();
        const done = (kind: number, steps: number, value = 0n, x: bigint[] = []) => {
          seenHead = txHead();
          return { kind, steps, value, x };
        };
        for (;;) {
          pump();
          const end = await par.wait(10, { at: tx, value: seenHead });
          const steps = counter(Counter.STEPS) - s0;
          if (end) return done(end.kind, steps, end.value, end.x);
          if (steps >= budget || performance.now() - t0 > 50) return done(Exit.BUDGET, steps);
          if (txUsed() >= RING_HALF) return done(Exit.TX_FULL, steps);
          if (txUsed() > 0) return done(Exit.BUDGET, steps);
          if (o.idleLimitMs !== undefined && performance.now() - par.progress(counter(Counter.STEPS)) > o.idleLimitMs) {
            raise(STOP);
            // Where each one is: in the core (`runningMs`) or out of it, its worker waiting (`sinceReturnMs`).
            const where = par
              .liveness()
              .map((l) => `${l.chunks} chunks, in ${l.runningMs.toFixed(0)} ms, out ${l.sinceReturnMs.toFixed(0)} ms`)
              .join('; ');
            throw new Error(`no vCPU retired a step in ${o.idleLimitMs} ms (pcs ${par.pcs().join(' ')}; ${where})`);
          }
        }
      } catch (e) {
        throw await devices.failure(e); // a vCPU's "device backends failed": the backends' own error
      }
    },
    drain,
    /** Byte address in `memory` of the console's rings (core/src/pl011.rs `Rings`: TX head, tail and bytes, then RX). */
    console: tx,
    send,
    /** Bytes `send` queued that the RX ring hasn't taken yet. */
    queued: () => queued.reduce((n, b) => n + b.length, 0),
    /** Resolves once inline backends finished what a `DEVICE` exit from `run` handed them. */
    settle: () => devices.settle(),
    /** What the guest wrote to its virtio consoles so far (all of it once `flush` resolves). */
    hvc: () => devices.output(),
    flush: () => devices.flush(),
    /**
     * Stops every vCPU at its next chunk boundary and waits until the backends are done with every
     * request they don't hold (the ones they hold, a receive buffer, wait for the guest to run).
     * Resolves true once nothing runs guest code and nothing writes guest RAM (until `resume`);
     * false if the machine ended meanwhile (an exit that ends the run, a closed VM). The workers keep
     * their core instances and code caches. Twice is the same pause. Round-robin: between `run` calls
     * the vCPUs are out already, so this only settles the devices.
     */
    pause: async (): Promise<boolean> => {
      if (par) return par.pause();
      await devices.quiesce();
      return true;
    },
    /** Lets a paused VM run on (nothing without a pause). */
    resume: () => par?.resume(),
    /** What a pause leaves: the doorbell's rung and served words, the signal word and whether the vCPUs are held. */
    paused: () => {
      const i32 = new Int32Array(memory.buffer);
      return {
        bell: [i32[(scratch + S_BELL) / 4], i32[(scratch + S_BELL) / 4 + 1]],
        signal: i32[signal / 4],
        held: par?.held() ?? false,
      };
    },
    /** Stops the vCPUs and releases the backends; resolves once their files are closed. */
    close: () => {
      par?.close();
      o.warm?.end(); // a machine closed before its vCPUs ran
      usbChannel?.port2.close();
      return devices.close();
    },
    /** Per-vCPU liveness (parallel mode; empty otherwise): time inside the current chunk, the longest chunk and host-side handling so far. */
    liveness: (): VcpuLiveness[] => par?.liveness() ?? [],
    /** The liveness block (parallel mode), for web/profiler.ts `startTimeline`. */
    liveBlock: par?.liveBlock,
    /** The JIT's compile worker's counters (parallel mode with one: web/jit-compile-worker.ts `compileStats`). */
    compileStats: () => par?.compileStats(),
    /** vCPU `i`'s PC (published once per chunk while it runs). */
    pc: (i = 0) => new BigUint64Array(memory.buffer, ex.vm_cpu(vm, i) + 256, 1)[0],
  };
}
