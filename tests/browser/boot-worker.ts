// Boots target/images/linux (images/build.sh) on the wasm core in a worker.
import { runToPowerOff } from '../../web/vm.ts';

const get = async (path: string) => {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
};

try {
  const [wasm, kernel, initrd] = await Promise.all([
    get('/target/wasm32-unknown-unknown/release/webpc_core.wasm'),
    get('/target/images/linux/Image'),
    get('/target/images/linux/rootfs.cpio'),
  ]);
  const r = await runToPowerOff(wasm, { ramSize: 256 << 20, kernel, initrd, cmdline: 'console=ttyAMA0 earlycon panic=-1' });
  self.postMessage({ kind: r.kind, x0: `0x${r.x[0].toString(16)}`, steps: r.steps, ms: r.ms, console: r.console });
} catch (e) {
  self.postMessage({ error: String(e) });
}
