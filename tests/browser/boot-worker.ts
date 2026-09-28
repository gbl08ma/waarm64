// Boots a guest on the wasm core in a worker, its root filesystem on virtio-blk
// over HTTP ranges: target/images/linux (images/build.sh), or with `?distro=`
// alpine|debian that image (web/vm.ts `DISTROS`) on 1 GiB. `?realtime` in the
// page URL selects realtime mode, `?overlay=<name>` makes the root disk
// writable through that OPFS overlay, and `?script=<path>` runs that script
// instead of the Buildroot guest's /test.sh; with `?devices` the guest gets the
// device tests' devices (web/vm.ts `testDevices`, the input ones on the ports
// the page sends first) and a 640×480 framebuffer, which goes to the page.
// `?jit=1|2|3` runs it under the JIT, JIT-stress or JIT-check (`VmConfig.jit`), `?ncpus=N` on N vCPUs,
// `?parallel` with a worker per vCPU (realtime; M7). `?litmus=<options>&stress=<options>`
// boots the litmus image (images/build.sh litmus) instead, with no devices.
import { DISTROS, GUEST_CMDLINE, guestDevices, runToPowerOff, testDevices } from '../../web/vm.ts';

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
  const img = distro ? DISTROS[distro]
    : litmus !== null ? { kernel: 'linux/Image', initrd: 'litmus/initramfs.cpio', disk: '', cmdline: `console=ttyAMA0 panic=-1 webpc.litmus=${litmus} webpc.stress=${params.get('stress') ?? ''}` }
    : { kernel: 'linux/Image', initrd: undefined, disk: 'buildroot/rootfs.ext4', cmdline: GUEST_CMDLINE + (script ? ` -- ${script}` : '') };
  const [wasm, kernel, initrd] = await Promise.all([
    get('/target/wasm32-unknown-unknown/release/webpc_core.wasm'),
    get(`/target/images/${img.kernel}`),
    img.initrd ? get(`/target/images/${img.initrd}`) : undefined,
  ]);
  const disk = new URL(`/target/images/${img.disk}`, location.href).href;
  const test = params.has('devices') || distro === 'alpine'; // Alpine checks linux-virt's modules for them
  const devices = litmus !== null ? [] : test ? testDevices(disk, ports.keyboard, ports.tablet) : guestDevices(disk, params.get('overlay') ?? undefined);
  const framebuffer = test ? { width: 640, height: 480 } : undefined;
  const opts = { ramSize: distro ? 1 << 30 : 256 << 20, kernel, initrd, cmdline: img.cmdline, devices, realtime: params.has('realtime'), framebuffer, jit: Number(params.get('jit') ?? 0) as 0 | 1 | 2 | 3, ncpus: Number(params.get('ncpus') ?? 1), parallel: params.has('parallel'), idleLimitMs: params.has('parallel') ? 60_000 : undefined };
  const r = await runToPowerOff(wasm, opts, 1e12, (vm) => vm.framebuffer && self.postMessage({ memory: vm.memory, framebuffer: vm.framebuffer }));
  self.postMessage({ kind: r.kind, x0: `0x${r.x[0].toString(16)}`, steps: r.steps, ms: r.ms, console: r.console, hvc: r.hvc });
} catch (e) {
  self.postMessage({ error: String(e) });
}
