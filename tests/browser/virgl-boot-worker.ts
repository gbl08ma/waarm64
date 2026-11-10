// Boots alpine-virgl (images/build.sh alpine-gl alpine-virgl) under the JIT with a virtio-gpu whose 3D work goes to
// the page's GPU worker (virgl-boot.html), and runs glcomp: `?gl=frames,quads,width,height` (default 3,3,128,96),
// `&dump` for glcomp's last frame read back through the renderer (its `px` lines, in the console); `?glq=frames,queries,width,height`
// runs glquery instead (occlusion queries waited on: bench/gpu/query-wait.ts), in realtime (its waits are the host's ms).
import { DISTROS, guestDevices, runToPowerOff } from '../../web/vm.ts';

const get = async (path: string) => {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
};

try {
  const { renderer, caps } = await new Promise<{ renderer: MessagePort; caps: Uint8Array }>((resolve) => { self.onmessage = (e) => resolve(e.data); });
  const params = new URLSearchParams(self.name); // the page's query (virgl-boot.html)
  const a = DISTROS.alpine;
  const [wasm, kernel, initrd] = await Promise.all([get('/target/wasm32-unknown-unknown/release/webpc_core.wasm'), get(`/target/images/${a.kernel}`), get(`/target/images/${a.initrd}`)]);
  const disk = new URL('/target/images/alpine-virgl/rootfs-virgl.ext4', location.href).href;
  const gpu = { type: 'gpu' as const, width: 640, height: 480, virgl: true, caps, renderer };
  const cmdline = `${a.cmdline} webpc.gl=${params.get('gl') ?? '3,3,128,96'} webpc.lp=0 webpc.gpu=1${params.has('dump') ? ' webpc.gldump=1' : ''}${params.has('glq') ? ` webpc.glq=${params.get('glq')}` : ''}`;
  const r = await runToPowerOff(wasm, { ramSize: 1 << 30, kernel, initrd, cmdline, devices: [...guestDevices(disk), gpu], jit: 1, realtime: params.has('glq') }, 1e12);
  self.postMessage({ kind: r.kind, steps: r.steps, ms: r.ms, console: r.console });
} catch (e) {
  self.postMessage({ error: String(e) });
}
