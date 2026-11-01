// Boots the page's Debian (through UEFI, unattended: tests/debian-unattended.ts) with virtio-net on
// the Ethernet gateway and posts its serial output. Two configurations: `ip` (a MessagePort: the
// Tailscale backend's IP port) boots it as tests/net-tailnet.test.ts wants it, without the card's
// credential (the test sets up systemd-networkd and systemd-resolved itself); `page` boots it
// exactly as the page does with a network card (web/app/machine.ts `network`) on the synchronous
// echo backend, for tests/net-guest.test.ts; with `adapters` (and `page`), that many cards, each on its own gateway and
// echo lease (docs/network-adapters.md §4); with `ports`, a card per port on the page's end (its leases are the
// page's to send: the primary's with the default route, the others' with their network's routes only), as the page's
// machine with several adapters has them (a two-minute lease); with `frames` (and `page`), one card on a frame port
// with no gateway in the page, for the local helper (tests/net-local.test.ts).
import { bootVm, Exit } from '../../web/vm.ts';
import { SEVERAL_ADAPTERS } from '../../web/devices.ts';
import { credentialFiles, MACHINES } from '../../web/app/machine.ts';
import { UNATTENDED } from '../debian-unattended.ts';

const get = async (url: string) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
};

self.onmessage = async (e: MessageEvent<{ ip?: MessagePort; frames?: MessagePort; ports?: MessagePort[]; page?: boolean; adapters?: number; serial: MessagePort; overlay?: string }>) => {
  try {
    const m = MACHINES.debian;
    const [wasm, kernel] = await Promise.all([
      get(new URL('../../target/wasm32-unknown-unknown/release/webpc_core.wasm', import.meta.url).href), get(m.kernel),
    ]);
    const vm = await bootVm(wasm, {
      ramSize: m.ramMiB * 2 ** 20, kernel, cmdline: '', jit: 1, ncpus: 2, parallel: true, realtime: true, serialIn: e.data.serial,
      firmware: { fwCfg: credentialFiles([...UNATTENDED, ...(e.data.page ? m.network.credentials : [])]) },
      devices: [
        { type: 'rng' }, { type: 'blk', url: m.disk, overlay: e.data.overlay },
        ...(e.data.frames
          ? [{ type: 'net' as const, adapter: e.data.frames }]
          : e.data.ports
          ? e.data.ports.map((ip, n) => ({ type: 'net' as const, mac: `52:54:00:12:34:${(0x56 + n).toString(16)}`, gateway: n, ...SEVERAL_ADAPTERS, adapter: { ip } }))
          : e.data.adapters
          ? Array.from({ length: e.data.adapters }, (_, n) => ({ type: 'net' as const, mac: `52:54:00:12:34:${(0x56 + n).toString(16)}`, gateway: n, adapter: 'echo' as const }))
          : [{ type: 'net' as const, adapter: e.data.ip ? { ip: e.data.ip } : 'echo' as const }]),
      ],
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
