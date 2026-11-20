// The test and benchmark guests (core/tests/common's): their devices, command lines and console input, and
// `runToPowerOff`, which boots one and runs it to its power-off. Tests, benchmarks and tools only.
import type { DeviceSpec } from './devices.ts';
import type { GpuState } from './gpu.ts';
import type { SndState } from './snd.ts';
import { bootVm, type BootOptions, type Vm } from './vm.ts';
import { Exit } from './core.ts';

/**
 * The devices the test and benchmark guests expect: the root filesystem at
 * `disk` (a URL) is /dev/vda, read-only, or writable through the OPFS overlay
 * directory `overlay`.
 */
export const guestDevices = (disk: string, overlay?: string): DeviceSpec[] => [
  { type: 'console' },
  { type: 'rng' },
  { type: 'blk', url: disk, overlay },
];
/**
 * The Buildroot guest's device tests (`/test-devices.sh`, `/test-input.sh`):
 * its devices plus net on the loopback adapter, 9p (tag `host`, with
 * /hello.txt), a keyboard and a tablet (core/tests/common `test_devices`).
 */
export const testDevices = (disk: string, keyboard?: MessagePort, tablet?: MessagePort): DeviceSpec[] => [
  ...guestDevices(disk),
  { type: 'net', adapter: 'loopback' },
  { type: '9p', tag: 'host', files: { 'hello.txt': 'hello from the host\n' } },
  { type: 'input', kind: 'keyboard', port: keyboard },
  { type: 'input', kind: 'tablet', port: tablet },
];
/** What the test agents inject when the guest sets a keyboard LED (core/tests/common `KEY_EVENTS`, `TABLET_EVENTS`). */
export const KEY_EVENTS = [
  [1, 30, 1],
  [0, 0, 0],
  [1, 30, 0],
  [0, 0, 0],
];
export const TABLET_EVENTS = [
  [3, 0, 16384],
  [3, 1, 8192],
  [1, 272, 1],
  [0, 0, 0],
  [1, 272, 0],
  [0, 0, 0],
];
/**
 * The console input test (core/tests/common `CONSOLE_INPUT`): the Buildroot
 * guest with `-- /bin/sh` gets this on its serial console at step
 * `CONSOLE_INPUT_STEP` (its prompt is up by 27.3M): a command, a line for its
 * `read`, then 100 lines (5.5 KB with the rest: more than the 4 KiB RX ring)
 * whose md5sum it prints before it exits.
 */
export const CONSOLE_INPUT =
  'stty -echo; read l; echo "waarm64: got [$l]"; head -n 100 | md5sum; exit\nhello from the host\n' +
  Array.from(
    { length: 100 },
    (_, i) => `line ${String(i).padStart(3, '0')}: the quick brown fox jumps over the lazy dog\n`,
  ).join('');
export const CONSOLE_INPUT_STEP = 30_000_000;
export const CONSOLE_INPUT_WANT = 'waarm64: got [hello from the host]\ncccad7da1df76c0ac16983284a789f3e  -\n';

/** The test guests' kernel command line. */
export const GUEST_CMDLINE = 'console=ttyAMA0 earlycon panic=-1 root=/dev/vda ro init=/init';
/**
 * Distro images from images/build.sh (paths under target/images) with a command
 * line that runs a test and powers off (core/tests/common `ALPINE`).
 * Alpine: OpenRC's local service runs images/alpine/waarm64.start.
 */
export const DISTROS = {
  alpine: {
    kernel: 'alpine/Image',
    initrd: 'alpine/initramfs-virt',
    disk: 'alpine/rootfs.ext4',
    cmdline: 'console=ttyAMA0 root=/dev/vda rootfstype=ext4 modules=ext4 ro',
  },
} as const;

/**
 * What to type on a guest's serial console, and when: once `step` steps have
 * run (exactly then in deterministic mode), once the console shows `after`, or
 * when a deterministic guest goes idle waiting for it, whichever comes first.
 */
export type ConsoleInput = { step?: number; after?: string; data: string };

/**
 * Boots and runs until the guest powers off (or `maxSteps`), collecting the
 * console. `booted` sees the VM before it runs; `input` goes to its serial
 * console when {@link ConsoleInput} says. Past `maxMs` of wall-clock time it
 * closes the VM and throws with the console's end: a realtime guest stuck
 * waiting with its timers running retires too few steps for `maxSteps`, and
 * too many for `idleLimitMs`, to end the run.
 */
export async function runToPowerOff(
  wasm: BufferSource | WebAssembly.Module,
  o: BootOptions,
  maxSteps = 20e9,
  booted?: (vm: Vm) => void,
  input?: ConsoleInput,
  maxMs = Infinity,
) {
  const vm = await bootVm(wasm, o);
  booted?.(vm);
  let console = '';
  let steps = 0;
  const t0 = performance.now();
  const usbEvents = [...(o.usb?.events ?? [])].sort((a, b) => a.step - b.step);
  let late: Error | undefined;
  const run = async () => {
    for (;;) {
      if (late) throw late; // past `maxMs`: the caller has its error already
      // USB plugs at their steps: the run stops there, and the device worker has the plug before it runs on.
      while (usbEvents.length && steps >= usbEvents[0].step) {
        const e = usbEvents.shift()!;
        if (!vm.usb) throw new Error("usb.events with a port of the caller's");
        const m = await (e.device ? vm.usb.attach(e.connector, e.device) : vm.usb.detach(e.connector));
        if (m.state === 'error') throw new Error(`USB connector ${e.connector}: ${m.message}`);
      }
      const until = Math.min(
        input?.step !== undefined && steps < input.step ? input.step : Infinity,
        usbEvents[0]?.step ?? Infinity,
      );
      const r = await vm.runAsync(Math.min(100_000_000, until - steps));
      steps += r.steps;
      console += vm.drain();
      const idle = r.kind === Exit.IDLE; // deterministic, with no deadline: waiting for input or for nothing
      if (
        input &&
        (idle || steps >= (input.step ?? Infinity) || (input.after !== undefined && console.includes(input.after)))
      ) {
        vm.send(input.data);
        input = undefined;
        if (idle) continue;
      }
      if (r.kind === Exit.DEVICE) await vm.settle();
      // `maxSteps` bounds DEVICE exits too (an idle guest may make one every few million steps).
      if ((r.kind === Exit.BUDGET || r.kind === Exit.TX_FULL || r.kind === Exit.DEVICE) && steps < maxSteps) continue;
      const ms = performance.now() - t0;
      await vm.flush();
      // The display's state (hashes of the scanout and the cursor), for a machine with a virtio-gpu; what a
      // virtio-snd played (its sink's checksum) and the control requests it took.
      const slot = (type: string) => (o.devices ?? []).findIndex((d) => d.type === type);
      const states = slot('gpu') >= 0 || slot('snd') >= 0 ? await vm.deviceState() : [];
      const gpu = slot('gpu') >= 0 ? (states[slot('gpu')] as GpuState) : undefined;
      const snd = slot('snd') >= 0 ? (states[slot('snd')] as SndState) : undefined;
      vm.close();
      return {
        ...r,
        kind: r.kind === Exit.DEVICE ? Exit.BUDGET : r.kind,
        steps,
        console,
        hvc: vm.hvc(),
        ms,
        pc: vm.pc(),
        flash: vm.flash(),
        gpu,
        snd,
        stats: vm.stats(),
      };
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    if (maxMs === Infinity) return;
    timer = setTimeout(() => {
      const pcs = Array.from({ length: o.ncpus ?? 1 }, (_, i) => `0x${vm.pc(i).toString(16)}`).join(' ');
      console += vm.drain();
      // The whole console goes with it (`console`), for a caller that keeps it.
      reject(
        (late = Object.assign(
          new Error(
            `no power-off in ${maxMs / 1000} s (${steps} steps, pcs ${pcs}); the console's end:\n${console.slice(-3000)}`,
          ),
          { console },
        )),
      );
    }, maxMs);
  });
  const running = run();
  running.catch(() => {}); // after the deadline it ends unseen (on `late`, or a promise the closed VM never settles)
  try {
    return await Promise.race([running, deadline]);
  } catch (e) {
    void Promise.resolve(vm.close()).catch(() => {}); // the vCPU workers too: alive, they would keep the process from exiting
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
