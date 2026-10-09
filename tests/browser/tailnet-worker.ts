// Boots the page's Debian (through UEFI, unattended: tests/debian-unattended.ts) with virtio-net on
// the Ethernet gateway and posts its serial output. Two configurations: `ip` (a MessagePort: the
// Tailscale backend's IP port) boots it as tests/net-tailnet.test.ts wants it, without the card's
// credential (the test sets up systemd-networkd and systemd-resolved itself); `page` boots it
// exactly as the page does with a network card (web/app/machine.ts `network`) on the synchronous
// echo backend, for tests/net-guest.test.ts.
import { bootVm, Exit } from '../../web/vm.ts';
import { credentialFiles, MACHINES } from '../../web/app/machine.ts';
import { UNATTENDED } from '../debian-unattended.ts';

const get = async (url: string) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
};

self.onmessage = async (e: MessageEvent<{ ip?: MessagePort; page?: boolean; serial: MessagePort; overlay?: string }>) => {
  try {
    const m = MACHINES.debian;
    const [wasm, kernel] = await Promise.all([
      get(new URL('../../target/wasm32-unknown-unknown/release/webpc_core.wasm', import.meta.url).href), get(m.kernel),
    ]);
    const vm = await bootVm(wasm, {
      ramSize: m.ramMiB * 2 ** 20, kernel, cmdline: '', jit: 1, ncpus: 2, parallel: true, realtime: true, serialIn: e.data.serial,
      firmware: { fwCfg: credentialFiles([...UNATTENDED, ...(e.data.page ? m.network.credentials : [])]) },
      devices: [{ type: 'rng' }, { type: 'blk', url: m.disk, overlay: e.data.overlay }, { type: 'net', adapter: e.data.ip ? { ip: e.data.ip } : 'echo' }],
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
