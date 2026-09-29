// Boots the page's Debian (web/app/machine.ts, without the units the page masks: the
// networking test wants systemd-networkd and systemd-resolved) with virtio-net on the
// Ethernet gateway behind the Tailscale backend's IP port, and posts its serial output.
import { bootVm, Exit } from '../../web/vm.ts';
import { MACHINES } from '../../web/app/machine.ts';

const get = async (url: string) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
};

self.onmessage = async (e: MessageEvent<{ ip: MessagePort; serial: MessagePort; overlay?: string }>) => {
  try {
    const m = MACHINES.debian;
    const [wasm, kernel, initrd] = await Promise.all([
      get(new URL('../../target/wasm32-unknown-unknown/release/webpc_core.wasm', import.meta.url).href), get(m.kernel), get(m.initrd!),
    ]);
    const vm = await bootVm(wasm, {
      ramSize: m.ramMiB << 20, kernel, initrd, jit: 1, ncpus: 2, parallel: true, realtime: true, serialIn: e.data.serial,
      cmdline: m.cmdline.split(' ').filter((p) => !p.startsWith('systemd.mask=') && p !== 'console=tty0').join(' '),
      devices: [{ type: 'rng' }, { type: 'blk', url: m.disk, overlay: e.data.overlay }, { type: 'net', adapter: { ip: e.data.ip } }],
    });
    for (;;) {
      const r = await vm.runAsync(1e9);
      const text = vm.drain();
      if (text) self.postMessage({ serial: text });
      if (r.kind !== Exit.BUDGET && r.kind !== Exit.TX_FULL) break;
    }
    await vm.close();
  } catch (err) {
    self.postMessage({ error: String((err as Error)?.stack ?? err) });
  }
};
