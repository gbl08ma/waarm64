// Requests no Linux driver sends, through the whole path (docs/testing.md "Bare-metal device tests"): a bare-metal
// guest with a virtio driver of its own (tests/baremetal/virtio/blk.c) posts hand-built chains to three virtio-blk
// disks over the TS backends (web/devices.ts `blk`) and prints what came back; this file has what each should get.
// Linux's drivers stay the tests of the well-formed path (the Buildroot device test, the Debian page tests): a driver
// of ours shares the backends' assumptions there. What's checked here is the rest: a buggy or hostile driver's request
// ends in an error status or a dropped request, never a host exception, a failed device or a changed disk.
// The interpreter's run, then the JIT's (the same steps and console) and a parallel one (the backends served from the
// doorbell: the same console). Needs the wasm build.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { Exit, PSCI_SYSTEM_OFF, runToPowerOff, type BootOptions } from '../web/vm.ts';

const WASM = readFileSync(new URL('../target/wasm32-unknown-unknown/release/webpc_core.wasm', import.meta.url));
const BLK = readFileSync(new URL('baremetal/virtio/blk.bin', import.meta.url));

/** The images' bytes, as the guest's `pattern(0, offset)` has them. */
const image = (n: number) => Uint8Array.from({ length: n }, (_, o) => ((o >> 9) * 31 + o * 7 + 3) & 0xff);

/** What a case prints: its status byte (`-`: not written), the used length (`-`: no completion), then its checks. */
type Want = [name: string, s: number | '-', n: number | '-', ...checks: string[]];

/** What every disk answers: the ID, reads and their failures. `flush`: FLUSH's status (UNSUPP without the feature). */
const reads = (flush: number): Want[] => [
  ['id', 0, 21, 'webpc-blk'],
  ['id-short', 0, 9], // the serial cut to the room there is
  ['read', 0, 1025, 'data'],
  ['read-split', 0, 513, 'data'], // the header in two buffers, the data in 64
  ['read-indirect', 0, 513, 'data'],
  ['read-status-in-data', 0, 513, 'data'], // the status byte the last of the data's buffer
  ['read-long-header', 0, 513], // a 32-byte header: its first 16 bytes count
  ['read-short-header', 2, 1], // an 8-byte header: UNSUPP (QEMU fails the device instead)
  ['no-header', 2, 1], // everything writable
  ['no-status', '-', 0], // nothing writable: nothing to answer with, the chain given back
  ['status-empty', '-', 0], // a writable buffer of 0 bytes, likewise
  ['read-into-readable', 0, 1], // the data's buffer readable: no room, a read of nothing
  ['read-100', 0, 101, 'data'], // not whole sectors: read as asked (QEMU: IOERR)
  // Past the end: across it, at it, byte offsets past 2^53 and 2^64, the last u64. IOERR.
  ['read-across-end', 1, 1],
  ['read-at-end', 1, 1],
  ['read-2^53', 1, 1],
  ['read-2^64', 1, 1],
  ['read-max', 1, 1],
  ['type-99', 2, 1],
  ['flush', flush, 1],
];

/** A writable disk: writes and their failures, each failure checked to have left the disk as it was. */
const writes: Want[] = [
  ['write', 0, 1, 'read back'],
  ['write-from-writable', 0, 1], // the data's buffer writable: a write of nothing
  ['write-data-in-header', 0, 1, 'read back'], // the data in the header's buffer
  ['write-100', 0, 1, 'first 100 bytes', 'rest zeros'], // not whole sectors: written as asked (QEMU: IOERR)
  ['write-across-end', 1, 1, 'last sector kept'],
  ['write-at-end', 1, 1],
  ['write-2^53', 1, 1],
  ['write-2^64', 1, 1],
  ['write-max', 1, 1, 'sectors 0-1 kept'],
];

/** DISCARD and WRITE_ZEROES (offered with one segment each). */
const unmaps: Want[] = [
  ['write-zeroes', 0, 1, 'zeros', 'the rest kept'],
  ['write-zeroes-unmap', 0, 1, 'zeros'],
  ['discard', 0, 1],
  ['discard-in-header', 0, 1], // the header and the segment in one buffer
  ['discard-unmap', 2, 1], // the unmap flag on a DISCARD: UNSUPP (virtio 1.2 §5.2.6.2)
  ['write-zeroes-flags', 2, 1], // an unknown flag: UNSUPP
  ['write-zeroes-short', 1, 1], // a segment of 8 bytes
  ['write-zeroes-two', 1, 1], // two segments, past max_write_zeroes_seg
  ['write-zeroes-none', 1, 1], // no segment
  ['write-zeroes-across-end', 1, 1],
  ['write-zeroes-2^53', 1, 1],
  ['discard-max', 1, 1], // the last u64 as the sector
  ['write-zeroes-too-many', 1, 1], // past max_write_zeroes_sectors
  ['discard-2^32-sectors', 1, 1, 'sectors 0-1 kept'],
];

const line = (prefix: string, [name, s, n, ...checks]: Want) => [`${prefix}.${name} s=${s} n=${n}`, ...checks].join(' ');
const WANT = [
  'ram features=0x30006204 sectors=2048', // VERSION_1 and INDIRECT_DESC (the transport), WRITE_ZEROES, DISCARD, FLUSH, SEG_MAX
  'ro features=0x30000024 sectors=128', // RO, SEG_MAX
  'overlay features=0x30006204 sectors=128',
  ...[...reads(0), ...writes, ...unmaps].map((w) => line('ram', w)),
  ...reads(2).map((w) => line('ro', w)),
  'ro.write s=1 n=1 kept', // a write with RO offered: IOERR (virtio 1.2 §5.2.6.2)
  'ro.discard s=2 n=1', // not offered: UNSUPP
  'ro.write-zeroes s=2 n=1 kept',
  ...[...reads(0), ...writes, ...unmaps].map((w) => line('overlay', w)),
  'ram.readable-after-writable s=- n=- reset', // the transport refuses the chain: DEVICE_NEEDS_RESET, nothing posted
  'ram.after-reset s=0 n=1025 data', // and after a reset the device reads again
  'exit 0',
  '',
].join('\n');

let run = 0;
/** The guest on its three disks: a 1 MiB ramdisk, a read-only image, an image under an overlay (each run a new one). */
async function boot(o: Partial<BootOptions>) {
  const dir = mkdtempSync(join(tmpdir(), 'virtio-guest-'));
  try {
    const [ro, ov] = [join(dir, 'ro.img'), join(dir, 'overlay.img')];
    writeFileSync(ro, image(64 << 10));
    writeFileSync(ov, image(64 << 10));
    const r = await runToPowerOff(WASM, {
      ramSize: 16 << 20, kernel: BLK, kernelOffset: 0, cmdline: '', ...o,
      devices: [{ type: 'blk', source: 'ram', size: 1 << 20 }, { type: 'blk', url: pathToFileURL(ro).href }, { type: 'blk', url: pathToFileURL(ov).href, overlay: `virtio-guest-${run++}`, discard: true }],
    }, 50e6, undefined, undefined, 120_000);
    assert.equal(r.kind, Exit.PSCI, r.console);
    assert.equal(r.x[0], PSCI_SYSTEM_OFF, r.console);
    // Line by line, so a mismatch names its case.
    const got = r.console.split('\n');
    WANT.split('\n').forEach((w, i) => assert.equal(got[i], w, `line ${i + 1}`));
    assert.equal(got.length, WANT.split('\n').length, r.console);
    assert.equal(r.x[1], 0n, r.console);
    return r;
  } finally {
    rmSync(dir, { recursive: true });
  }
}

let interp: Awaited<ReturnType<typeof boot>> | undefined;
test('virtio-blk through a bare-metal driver: interpreter', async () => {
  interp = await boot({ jit: 0 });
});
test('virtio-blk through a bare-metal driver: JIT (the interpreter\'s steps)', async () => {
  const r = await boot({ jit: 1 });
  if (interp) assert.equal(r.steps, interp.steps);
});
test('virtio-blk through a bare-metal driver: parallel (JIT)', async () => {
  await boot({ jit: 1, parallel: true, idleLimitMs: 30_000 });
});
