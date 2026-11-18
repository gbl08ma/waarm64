// Boots the page's Debian (through UEFI, unattended: tests/debian-unattended.ts) with virtio-net on
// the Ethernet gateway and posts its serial output. Two configurations: `ip` (a MessagePort: the
// Tailscale backend's IP port) boots it as tests/net-tailnet.test.ts wants it, without the card's
// credential (the test sets up systemd-networkd and systemd-resolved itself); `page` boots it
// exactly as the page does with a network card (web/app/machine.ts `network`) on the synchronous
// echo backend, for tests/net-guest.test.ts; with `adapters` (and `page`), that many cards, each on its own gateway and
// echo lease (docs/networking/adapters.md §4); with `ports`, a card per port on the page's end (its leases are the
// page's to send: the primary's with the default route, the others' with their network's routes only), as the page's
// machine with several adapters has them (a two-minute lease). `debugNet`: systemd-networkd logs at debug from the boot
// (a drop-in over SMBIOS; the journal then says what it does with a carrier change or a lease). `disk`: another Debian
// disk's URL than the page's (images/debian-tools/build.sh's, with an SSH server).
// `restore`: a booted-Debian fixture's URL (tests/debian-fixture.ts) to start from instead of a boot, the shape the
// same as the one it was made on; the guest, at its login prompt, gets a newline to show the prompt again. A later
// `{ save: true }` message pauses the machine, posts its snapshot (`{ snapshot: Blob }`) and ends it.
import { bootVm, compileCore, Exit } from '../../web/vm.ts';
import { lzCodec } from '../../web/lz.ts';
import { readSnapshot, writeSnapshot } from '../../web/snapshot.ts';
import { SEVERAL_ADAPTERS } from '../../web/devices.ts';
import { credentialFiles, MACHINES } from '../../web/app/machine.ts';
import { OEM_STRINGS_FILE, oemStrings } from '../../web/app/guest-unit.ts';
import { UNATTENDED } from '../debian-unattended.ts';

const get = async (url: string) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
};

type Start = { ip?: MessagePort; ports?: MessagePort[]; page?: boolean; debugNet?: boolean; adapters?: number; serial: MessagePort; overlay?: string; disk?: string; restore?: string };
let save: (() => void) | undefined;
self.onmessage = async (e: MessageEvent<Start | { save: true }>) => {
  if ('save' in e.data) return save?.();
  try {
    const m = MACHINES.debian;
    const [wasm, kernel] = await Promise.all([
      get(new URL('../../target/wasm32-unknown-unknown/release/waarm64_core.wasm', import.meta.url).href), get(m.kernel),
    ]);
    const module = await compileCore(wasm);
    const codec = await lzCodec(module);
    const overlay = e.data.overlay ?? (e.data.restore ? 'waarm64-fixture' : undefined); // a restore writes the disk's blocks into an overlay
    const devices = [
      { type: 'rng' as const }, { type: 'blk' as const, url: e.data.disk ?? m.disk, overlay },
      ...(e.data.ports
        ? e.data.ports.map((ip, n) => ({ type: 'net' as const, mac: `52:54:00:12:34:${(0x56 + n).toString(16)}`, gateway: n, ...SEVERAL_ADAPTERS, adapter: { ip } }))
        : e.data.adapters
        ? Array.from({ length: e.data.adapters }, (_, n) => ({ type: 'net' as const, mac: `52:54:00:12:34:${(0x56 + n).toString(16)}`, gateway: n, adapter: 'echo' as const }))
        : [{ type: 'net' as const, adapter: e.data.ip ? { ip: e.data.ip } : 'echo' as const }]),
    ];
    const restore = e.data.restore ? (await readSnapshot(await (await fetch(e.data.restore)).blob(), codec, codec.snapshotVersion, { devices })).restore : undefined;
    const vm = await bootVm(module, {
      ramSize: m.ramMiB * 2 ** 20, kernel, cmdline: '', jit: 1, ncpus: 2, parallel: true, realtime: true, serialIn: e.data.serial,
      firmware: { fwCfg: [...credentialFiles([...UNATTENDED, ...(e.data.page ? m.network.credentials : [])]), ...(e.data.debugNet ? [{ name: OEM_STRINGS_FILE, data: oemStrings([{ name: 'systemd.unit-dropin.systemd-networkd.service~debug', data: '[Service]\nEnvironment=SYSTEMD_LOG_LEVEL=debug\n' }]).join('\0') }] : [])] },
      devices, restore,
    });
    if (restore) {
      vm.send('\n');
      self.postMessage({ restored: true });
    }
    let saving: Promise<void> | undefined;
    save = () => {
      saving ??= (async () => {
        if (!(await vm.pause())) throw new Error('the machine ended as it was paused');
        const parts: Uint8Array[] = [];
        await writeSnapshot(vm, (b) => { parts.push(b.slice()); }, { machine: 'debian', fixture: true }, codec);
        self.postMessage({ snapshot: new Blob(parts as BlobPart[]) });
        await vm.close();
      })().catch((err) => { self.postMessage({ error: String((err as Error)?.stack ?? err) }); });
    };
    for (;;) {
      const r = await vm.runAsync(1e9);
      const text = vm.drain();
      if (text) self.postMessage({ serial: text });
      if (saving || (r.kind !== Exit.BUDGET && r.kind !== Exit.TX_FULL)) break;
    }
    if (saving) await saving;
    else await vm.close();
  } catch (err) {
    self.postMessage({ error: String((err as Error)?.stack ?? err) });
  }
};
