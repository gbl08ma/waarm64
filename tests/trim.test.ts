// DISCARD from a real driver (web/devices.ts `blk`, web/overlay.ts): Linux on a disk that offers it
// takes the limits from the config space, and what `fstrim` trims leaves the overlay: the blocks
// of a deleted file read as zeros without slots, and the data file shrinks. Without the offer
// (the tests' other guests, whose step counts are without it) the filesystem can't trim.
// Buildroot on 2 vCPUs under the JIT, a few seconds; not step-counted (realtime). The second test checks the I/O and
// per-vCPU counters the page's status carries, too.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { test } from 'node:test';
import { diskIdentity } from '../web/devices.ts';
import { openOverlay, overlay } from '../web/overlay.ts';
import { openDisk } from '../web/qcow2.ts';
import { Exit, GUEST_CMDLINE, bootVm, type BootOptions } from '../web/vm.ts';

const WASM = new URL('../target/wasm32-unknown-unknown/release/waarm64_core.wasm', import.meta.url);
const IMAGES = new URL('../target/images/', import.meta.url);
const DISK = new URL('buildroot/rootfs.ext4', IMAGES);
const skip = (!existsSync(WASM) || !existsSync(new URL('linux/Image', IMAGES)) || !existsSync(DISK)) && 'SKIPPED: run scripts/build-wasm.sh and images/build.sh linux buildroot';

/** The last `shell`'s disk counters (`Vm.deviceIo`: the blk is device 2) and its vCPUs' steps, against all of them. */
let last: { read: number; written: number; cpuSteps: number[]; steps: number } | undefined;

/** Boots a shell on the disk with overlay `name`, runs `script` line by line at its prompts; the console's text. */
async function shell(name: string, discard: boolean, script: string[], atEnd?: (vm: Awaited<ReturnType<typeof bootVm>>) => Promise<unknown>) {
  const devices: BootOptions['devices'] = [{ type: 'console' }, { type: 'rng' }, { type: 'blk', url: DISK.href, overlay: name, discard }];
  const { port1, port2 } = new MessageChannel();
  const vm = await bootVm(readFileSync(WASM), { ramSize: 256 << 20, kernel: readFileSync(new URL('linux/Image', IMAGES)), cmdline: `${GUEST_CMDLINE} -- /bin/sh`, devices, ncpus: 2, parallel: true, jit: 1, idleLimitMs: 30_000, serialIn: port2 });
  let out = '';
  let sent = 0;
  const t0 = performance.now();
  try {
    for (;;) {
      assert.ok(performance.now() - t0 < 60_000, `no power-off in 60 s: ${out}`);
      const r = await vm.runAsync(50_000_000);
      out += vm.drain();
      // A line per prompt: a kernel message may follow one on its line (the remount's did, and the
      // console then never ended with the prompt).
      if (sent < script.length && (out.match(/(?:^|\n)\S* # /g) ?? []).length > sent) port1.postMessage(`${script[sent++]}\n`);
      if (r.kind !== Exit.BUDGET && r.kind !== Exit.TX_FULL) {
        assert.equal(r.kind, Exit.PSCI, out);
        return out.replaceAll('\r\n', '\n');
      }
    }
  } finally {
    await atEnd?.(vm);
    const io = vm.deviceIo();
    last = { read: io[4], written: io[5], cpuSteps: vm.cpuStats().map((c) => c.steps), steps: vm.stats().steps };
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

test("a compaction asked for (the page's, after the guest agent's trim: vm.compact) gives back what a change's doesn't", { skip, timeout: 120_000 }, async () => {
  // 12 MiB kept and 4 MiB trimmed: a third of the data file free, which a change leaves (it compacts past half).
  const script = [
    'mount -o remount,rw /',
    'dd if=/dev/urandom of=/keep bs=1M count=12 2>/dev/null; dd if=/dev/urandom of=/big bs=1M count=4 2>/dev/null; sync; rm /big; sync',
    'fstrim /; echo fstrim=$?; md5sum /keep; sync',
    'mount -o remount,ro /; poweroff -f',
  ];
  let sizes: { before: number; after: number } | undefined;
  const out = await shell('trim-compact', true, script, async (vm) => (sizes = await vm.compact()));
  assert.match(out, /fstrim=0\n/);
  assert.ok(sizes && sizes.before >= 16 << 20, `before: ${sizes?.before} bytes (the trimmed slots kept)`);
  assert.ok(sizes.after < 14 << 20 && sizes.after >= 12 << 20, `after: ${sizes.after} bytes`);
  const h = await held('trim-compact');
  assert.ok(h.data < 14 << 20 && h.data <= sizes.after, `the data file is ${h.data} bytes`);
  // What was kept reads the same from the moved blocks, at the next boot.
  const sum = /\n([0-9a-f]{32})  \/keep\n/;
  assert.equal(sum.exec(await shell('trim-compact', true, ['md5sum /keep', 'poweroff -f']))?.[1], sum.exec(out)?.[1]);
});

test('without the offer the guest can\'t trim, and the deleted file stays in the overlay', { skip, timeout: 120_000 }, async () => {
  const out = await shell('trim-off', false, SCRIPT);
  assert.match(out, /limits 0 0 0\n/);
  assert.match(out, /fstrim=1\n/);
  const h = await held('trim-off');
  assert.equal(h.zeroed, 0);
  assert.ok(h.data >= 8 << 20, `the data file is ${h.data} bytes`);
  // The status bar's counters (web/app/protocol.ts `Status.disks`, `cpus`): the 8 MiB written, the boot's reads, and
  // both vCPUs' own steps, which make up the total.
  assert.ok(last!.written >= 8 << 20 && last!.written < 64 << 20, `${last!.written} bytes written`);
  assert.ok(last!.read > 1 << 20 && last!.read < statSync(DISK).size * 4, `${last!.read} bytes read`);
  assert.equal(last!.cpuSteps.length, 2);
  assert.ok(last!.cpuSteps.every((n) => n > 0), `steps by vCPU: ${last!.cpuSteps.join(', ')}`);
  assert.equal(last!.cpuSteps[0] + last!.cpuSteps[1], last!.steps);
});
