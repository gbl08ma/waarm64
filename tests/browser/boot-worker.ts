// Boots target/images/linux (images/build.sh) on the wasm core in a worker,
// its root filesystem on virtio-blk over HTTP ranges; `?realtime` in the
// page URL selects realtime mode.
import { GUEST_CMDLINE, guestDevices, runToPowerOff } from '../../web/vm.ts';

const get = async (path: string) => {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
};

try {
  const [wasm, kernel] = await Promise.all([get('/target/wasm32-unknown-unknown/release/webpc_core.wasm'), get('/target/images/linux/Image')]);
  const realtime = new URLSearchParams(location.search).has('realtime');
  const devices = guestDevices(new URL('/target/images/linux/rootfs.ext4', location.href).href);
  const r = await runToPowerOff(wasm, { ramSize: 256 << 20, kernel, cmdline: GUEST_CMDLINE, devices, realtime });
  self.postMessage({ kind: r.kind, x0: `0x${r.x[0].toString(16)}`, steps: r.steps, ms: r.ms, console: r.console, hvc: r.hvc });
} catch (e) {
  self.postMessage({ error: String(e) });
}
