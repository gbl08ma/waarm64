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
// `?input` runs the console input test (web/vm.ts `CONSOLE_INPUT`): a shell
// instead of /test.sh, given the input at its step.
// `?snapshots=<steps>,…`: the VM is saved to a snapshot file, closed, and a new one started from the
// file at each of those steps (web/snapshot.ts `runThroughSnapshots`); `files` in the result has them.
import { runThroughSnapshots } from '../../web/snapshot.ts';
import { CONSOLE_INPUT, CONSOLE_INPUT_STEP, DISTROS, GUEST_CMDLINE, guestDevices, runToPowerOff, testDevices } from '../../web/vm.ts';

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
    : { kernel: 'linux/Image', initrd: undefined, disk: 'buildroot/rootfs.ext4', cmdline: GUEST_CMDLINE + (params.has('input') ? ' -- /bin/sh' : script ? ` -- ${script}` : '') };
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
  const input = params.has('input') ? { step: CONSOLE_INPUT_STEP, data: CONSOLE_INPUT } : undefined;
  // `?pauses=<n>`: pause and resume the VM every ~30 ms while it boots (web/vm.ts `pause`), checking what
  // a pause promises; `pause` in the result counts them and their latency.
  const pauser = { n: 0, ms: [] as number[], bad: '', done: false };
  const pauses = Number(params.get('pauses') ?? 0);
  const at = params.get('snapshots')?.split(',').map(Number);
  if (at) {
    const r = await runThroughSnapshots(wasm, opts, at, input ? 200e6 : 1e12, input);
    self.postMessage({ kind: r.kind, x0: `0x${r.x[0].toString(16)}`, steps: r.steps, ms: r.ms, console: r.console, hvc: r.hvc, files: r.files });
  } else {
  const r = await runToPowerOff(wasm, opts, input ? 200e6 : 1e12, (vm) => {
    if (vm.framebuffer) self.postMessage({ memory: vm.memory, framebuffer: vm.framebuffer });
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
  self.postMessage({ pause: pauser, kind: r.kind, x0: `0x${r.x[0].toString(16)}`, steps: r.steps, ms: r.ms, console: r.console, hvc: r.hvc });
  }
} catch (e) {
  self.postMessage({ error: String(e) });
}
