// Boots a guest on the wasm core in a worker, its root filesystem on virtio-blk
// over HTTP ranges: target/images/linux (images/build.sh), or with `?distro=`
// alpine|debian that image (web/vm.ts `DISTROS`) on 1 GiB. `?realtime` in the
// page URL selects realtime mode.
import { DISTROS, GUEST_CMDLINE, guestDevices, runToPowerOff } from '../../web/vm.ts';

const get = async (path: string) => {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
};

try {
  const params = new URLSearchParams(location.search);
  const distro = params.get('distro') as keyof typeof DISTROS | null;
  const img = distro ? DISTROS[distro] : { kernel: 'linux/Image', initrd: undefined, disk: 'linux/rootfs.ext4', cmdline: GUEST_CMDLINE };
  const [wasm, kernel, initrd] = await Promise.all([
    get('/target/wasm32-unknown-unknown/release/webpc_core.wasm'),
    get(`/target/images/${img.kernel}`),
    img.initrd && get(`/target/images/${img.initrd}`),
  ]);
  const devices = guestDevices(new URL(`/target/images/${img.disk}`, location.href).href);
  const r = await runToPowerOff(wasm, { ramSize: distro ? 1 << 30 : 256 << 20, kernel, initrd, cmdline: img.cmdline, devices, realtime: params.has('realtime') }, 1e12);
  self.postMessage({ kind: r.kind, x0: `0x${r.x[0].toString(16)}`, steps: r.steps, ms: r.ms, console: r.console, hvc: r.hvc });
} catch (e) {
  self.postMessage({ error: String(e) });
}
