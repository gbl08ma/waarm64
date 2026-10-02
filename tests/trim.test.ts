// DISCARD from a real driver (web/devices.ts `blk`, web/overlay.ts): Linux on a disk that offers it
// takes the limits from the config space, and what `fstrim` trims leaves the overlay: the blocks
// of a deleted file read as zeros without slots, and the data file shrinks. Without the offer
// (the tests' other guests, whose step counts are without it) the filesystem can't trim.
// Buildroot on 2 vCPUs under the JIT, a few seconds; not step-counted (realtime).
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { test } from 'node:test';
import { diskIdentity } from '../web/devices.ts';
import { openOverlay, overlay } from '../web/overlay.ts';
import { openDisk } from '../web/qcow2.ts';
import { Exit, GUEST_CMDLINE, bootVm, type BootOptions } from '../web/vm.ts';

const WASM = new URL('../target/wasm32-unknown-unknown/release/webpc_core.wasm', import.meta.url);
const IMAGES = new URL('../target/images/', import.meta.url);
const DISK = new URL('buildroot/rootfs.ext4', IMAGES);
const skip = (!existsSync(WASM) || !existsSync(new URL('linux/Image', IMAGES)) || !existsSync(DISK)) && 'SKIPPED: run scripts/build-wasm.sh and images/build.sh linux buildroot';

/** Boots a shell on the disk with overlay `name`, runs `script` line by line at its prompts; the console's text. */
async function shell(name: string, discard: boolean, script: string[]) {
  const devices: BootOptions['devices'] = [{ type: 'console' }, { type: 'rng' }, { type: 'blk', url: DISK.href, overlay: name, discard }];
  const { port1, port2 } = new MessageChannel();
  const vm = await bootVm(readFileSync(WASM), { ramSize: 256 << 20, kernel: readFileSync(new URL('linux/Image', IMAGES)), cmdline: `${GUEST_CMDLINE} -- /bin/sh`, devices, ncpus: 2, parallel: true, jit: 1, idleLimitMs: 30_000, serialIn: port2 });
  let out = '';
  let [sent, seen] = [0, 0];
  const t0 = performance.now();
  try {
    for (;;) {
      assert.ok(performance.now() - t0 < 60_000, `no power-off in 60 s: ${out}`);
      const r = await vm.runAsync(50_000_000);
      out += vm.drain();
      if (sent < script.length && out.slice(seen).endsWith('# ')) {
        seen = out.length;
        port1.postMessage(`${script[sent++]}\n`);
      }
      if (r.kind !== Exit.BUDGET && r.kind !== Exit.TX_FULL) {
        assert.equal(r.kind, Exit.PSCI, out);
        return out.replaceAll('\r\n', '\n');
      }
    }
  } finally {
    await vm.close();
    port1.close();
  }
}

/** What overlay `name` holds: its blocks, how many of them as zeros, and its data file's size. */
async function held(name: string) {
  const size = statSync(DISK).size;
  const files = await openOverlay(name, diskIdentity({ url: DISK.href }, size));
  try {
    const d = overlay(openDisk(() => undefined, size), files.data, files.map);
    const w = d.written();
    return { blocks: w.length, zeroed: w.filter((b) => d.zeroed(b)).length, data: files.data.getSize() };
  } finally {
    files.close();
  }
}

const SCRIPT = [
  'mount -o remount,rw /',
  'echo limits $(cat /sys/block/vda/queue/discard_granularity /sys/block/vda/queue/discard_max_bytes /sys/block/vda/queue/write_zeroes_max_bytes)',
  'dd if=/dev/urandom of=/big bs=1M count=8 2>/dev/null; sync; rm /big; sync',
  'fstrim -v /; echo fstrim=$?; echo kept > /kept; sync',
  'mount -o remount,ro /; poweroff -f',
];

test('Linux trims a disk that offers DISCARD: a deleted file\'s blocks leave the overlay', { skip, timeout: 120_000 }, async () => {
  const out = await shell('trim-on', true, SCRIPT);
  assert.match(out, /limits 4096 2147483648 2147483648\n/);
  assert.match(out, /\/: \d{7,} bytes trimmed\nfstrim=0\n/);
  const h = await held('trim-on');
  assert.ok(h.zeroed >= 2000, `${h.zeroed} blocks as zeros: the 8 MiB file's (a block or two taken again since)`);
  assert.ok(h.data < 1 << 20, `the data file is ${h.data} bytes for ${h.blocks - h.zeroed} blocks`);
  assert.ok(h.data >= (h.blocks - h.zeroed) * 4096);
  // The filesystem is whole on the trimmed overlay: a second boot reads what was written after the trim.
  assert.match(await shell('trim-on', true, ['cat /kept; ls /big', 'poweroff -f']), /\nkept\nls: \/big: No such file or directory\n/);
});

test('without the offer the guest can\'t trim, and the deleted file stays in the overlay', { skip, timeout: 120_000 }, async () => {
  const out = await shell('trim-off', false, SCRIPT);
  assert.match(out, /limits 0 0 0\n/);
  assert.match(out, /fstrim=1\n/);
  const h = await held('trim-off');
  assert.equal(h.zeroed, 0);
  assert.ok(h.data >= 8 << 20, `the data file is ${h.data} bytes`);
});
