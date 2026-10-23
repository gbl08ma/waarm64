// Boots a guest on the wasm core in a worker, its root filesystem on virtio-blk
// over HTTP ranges: target/images/linux (images/build.sh), or with `?distro=`
// alpine that image (web/vm.ts `DISTROS`) on 1 GiB. `?realtime` in the
// page URL selects realtime mode, `?overlay=<name>` makes the root disk
// writable through that OPFS overlay, and `?script=<path>` runs that script
// instead of the Buildroot guest's /test.sh; with `?devices` the guest gets the
// device tests' devices (web/vm.ts `testDevices`, the input ones on the ports
// the page sends first) and a 640×480 framebuffer, which goes to the page.
// `?jit=1|2|3` runs it under the JIT, JIT-stress or JIT-check (`VmConfig.jit`), `?ncpus=N` on N vCPUs,
// `?parallel` with a worker per vCPU (realtime; M7). `?litmus=<options>&stress=<options>`
// boots the litmus image (images/build.sh litmus) instead, with no devices.
// `?gpu=<flushes>` boots the gpu test kernel (images/build.sh linux-gpu) on a virtio-gpu of 640×480 whose display
// changes to 800×600 after that many flushes; the display's state (hashes) is `gpu` in the result.
// `?snd` boots the snd test kernel (images/build.sh linux-snd) on a virtio-snd; the device's state (what its
// sink played, the control requests) is `snd` in the result.
// `?usb=hubs` boots the USB test kernel (images/build.sh linux-usb) on the xHCI with nothing plugged in;
// `?usb=test` with two Gadget Zeros, one unplugged and plugged in again at fixed steps (tests/usb/guest.ts).
// `?usbhost=<json>` boots the USB test kernel for real devices (images/build.sh linux-usbhost) with `cmdline`
// added to its command line and `device` (a WebUSB or WebHID identity) attached to connector 0 once it has
// booted; its `usb-state` is `usb` in the result (tests/usb-guest.test.ts; realtime: add `&realtime`).
// `?input` runs the console input test (web/vm.ts `CONSOLE_INPUT`): a shell
// instead of /test.sh, given the input at its step.
// `?disk=<path under target/images/>`: the root disk from there instead (a chunked image's manifest: tests/chunked.test.ts).
// `?snapshots=<steps>,…`: the VM is saved to a snapshot file, closed, and a new one started from the
// file at each of those steps (web/snapshot.ts `runThroughSnapshots`); `files` in the result has them.
import { runThroughSnapshots } from '../../web/snapshot.ts';
import { CONSOLE_INPUT, CONSOLE_INPUT_STEP, DISTROS, GUEST_CMDLINE, guestDevices, runToPowerOff, testDevices } from '../../web/vm.ts';
import type { UsbIdentity } from '../../web/usb-device.ts';
import { USB_CMDLINE, USB_HUBS_CMDLINE, USB_INITRD, USB_KERNEL, usbGuest } from '../usb/options.ts';

const get = async (path: string) => {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
};

try {
  const ports = await new Promise<{ keyboard: MessagePort; tablet: MessagePort }>((resolve) => { self.onmessage = (e) => resolve(e.data); });
  const params = new URLSearchParams(location.search);
  const distro = params.get('distro') as keyof typeof DISTROS | null;
  const script = params.get('script');
  const litmus = params.get('litmus');
  const gpu = params.get('gpu');
  const snd = params.has('snd');
  const usb = params.get('usb');
  const usbhost = params.has('usbhost') ? JSON.parse(params.get('usbhost')!) as { device: UsbIdentity; cmdline: string } : undefined;
  const img = usbhost ? { kernel: 'linux-usbhost/Image', initrd: 'linux-usbhost/initramfs.cpio', disk: '', cmdline: `console=ttyAMA0 panic=-1 ${usbhost.cmdline}` }
    : usb !== null ? { kernel: USB_KERNEL, initrd: USB_INITRD, disk: '', cmdline: usb === 'hubs' ? USB_HUBS_CMDLINE : USB_CMDLINE }
    : gpu !== null ? { kernel: 'linux-gpu/Image', initrd: 'linux-gpu/initramfs.cpio', disk: '', cmdline: 'console=ttyAMA0 panic=-1' }
    : snd ? { kernel: 'linux-snd/Image', initrd: 'linux-snd/initramfs.cpio', disk: '', cmdline: 'console=ttyAMA0 panic=-1' }
    : distro ? DISTROS[distro]
    : litmus !== null ? { kernel: 'linux/Image', initrd: 'litmus/initramfs.cpio', disk: '', cmdline: `console=ttyAMA0 panic=-1 webpc.litmus=${litmus} webpc.stress=${params.get('stress') ?? ''}` }
    : { kernel: 'linux/Image', initrd: undefined, disk: 'buildroot/rootfs.ext4', cmdline: GUEST_CMDLINE + (params.has('input') ? ' -- /bin/sh' : script ? ` -- ${script}` : '') };
  const [wasm, kernel, initrd] = await Promise.all([
    get('/target/wasm32-unknown-unknown/release/webpc_core.wasm'),
    get(`/target/images/${img.kernel}`),
    img.initrd ? get(`/target/images/${img.initrd}`) : undefined,
  ]);
  const disk = new URL(`/target/images/${params.get('disk') ?? img.disk}`, location.href).href;
  const test = params.has('devices') || distro === 'alpine'; // Alpine checks linux-virt's modules for them
  const devices = usb !== null || usbhost ? [] : gpu !== null ? [{ type: 'gpu' as const, width: 640, height: 480, trace: true, resize: { after: Number(gpu), width: 800, height: 600 } }] : snd ? [{ type: 'snd' as const }] : litmus !== null ? [] : test ? testDevices(disk, ports.keyboard, ports.tablet) : guestDevices(disk, params.get('overlay') ?? undefined);
  const framebuffer = test ? { width: 640, height: 480 } : undefined;
  const opts = { ramSize: distro ? 1 << 30 : 256 << 20, kernel, initrd, cmdline: img.cmdline, devices, realtime: params.has('realtime'), framebuffer, jit: Number(params.get('jit') ?? 0) as 0 | 1 | 2 | 3, ncpus: Number(params.get('ncpus') ?? 1), parallel: params.has('parallel'), idleLimitMs: params.has('parallel') ? 60_000 : undefined, usb: usbhost ? {} : usb === null ? undefined : usb === 'hubs' ? {} : usbGuest() };
  // Parallel: once the shell's prompt is up. The vCPUs' summed steps say nothing about how far the
  // boot is (a vCPU spinning while the other is descheduled counts too): sent at step 30M, the
  // input once reached the tty before init, and the shell lost the start of its first line.
  const input = !params.has('input') ? undefined : params.has('parallel') ? { after: '~ # ', data: CONSOLE_INPUT } : { step: CONSOLE_INPUT_STEP, data: CONSOLE_INPUT };
  // `?pauses=<n>`: pause and resume the VM every ~30 ms while it boots (web/vm.ts `pause`), checking what
  // a pause promises; `pause` in the result counts them and their latency.
  const pauser = { n: 0, ms: [] as number[], bad: '', done: false };
  const pauses = Number(params.get('pauses') ?? 0);
  const at = params.get('snapshots')?.split(',').map(Number);
  if (at) {
    const r = await runThroughSnapshots(wasm, opts, at, input ? 200e6 : 1e12, input);
    self.postMessage({ kind: r.kind, x0: r.x[0] === undefined ? undefined : `0x${r.x[0].toString(16)}`, steps: r.steps, ms: r.ms, console: r.console, hvc: r.hvc, files: r.files });
  } else {
  let usbState: unknown;
  const r = await runToPowerOff(wasm, opts, input ? 200e6 : 1e12, (vm) => {
    if (vm.framebuffer) self.postMessage({ memory: vm.memory, framebuffer: vm.framebuffer });
    if (usbhost) void vm.usb!.attach(0, usbhost.device).then((m) => { usbState = m; }, (e) => { usbState = { error: String(e) }; });
    if (!pauses) return;
    void (async () => {
      while (!pauser.done) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        const t = performance.now();
        if (!(await vm.pause())) break;
        pauser.ms.push(performance.now() - t);
        const before = vm.stats().steps;
        const p = vm.paused();
        if (!p.held || p.bell[0] !== p.bell[1] || (p.signal & 1)) pauser.bad ||= `bad state ${JSON.stringify(p)}`;
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (vm.stats().steps !== before) pauser.bad ||= 'a vCPU ran while paused';
        vm.resume();
        pauser.n++;
      }
    })().catch((e) => { pauser.bad ||= String(e); });
  }, input);
  pauser.done = true;
  self.postMessage({ pause: pauser, pc: r.pc, kind: r.kind, x0: r.x[0] === undefined ? undefined : `0x${r.x[0].toString(16)}`, steps: r.steps, ms: r.ms, console: r.console, hvc: r.hvc, gpu: r.gpu, snd: r.snd, usb: usbState });
  }
} catch (e) {
  self.postMessage({ error: String(e) });
}
