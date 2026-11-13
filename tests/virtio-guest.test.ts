// Requests no Linux driver sends, through the whole path (docs/testing.md "Bare-metal device tests"): bare-metal
// guests with a virtio driver of their own (tests/baremetal/virtio/: blk.c, 9p.c, net.c) post hand-built chains to the
// TS backends (web/devices.ts `blk`, `net`; web/9p.ts) and print what came back; this file has what each should get.
// Linux's drivers stay the tests of the well-formed path (the Buildroot device test, the Debian page tests): a driver
// of ours shares the backends' assumptions there. What's checked here is the rest: a buggy or hostile driver's request
// ends in an error, a dropped request or frame, never a host exception, a failed device or a changed disk.
// Each guest under the interpreter, then the JIT (the same steps and console) and in parallel mode (the backends
// served from the doorbell: the same console). Needs the wasm build.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import type { DeviceSpec } from '../web/devices.ts';
import { Exit, PSCI_SYSTEM_OFF, runToPowerOff, type BootOptions } from '../web/vm.ts';

const WASM = readFileSync(new URL('../target/wasm32-unknown-unknown/release/waarm64_core.wasm', import.meta.url));

/** The images' bytes, as the guest's `pattern(0, offset)` has them. */
const image = (n: number) => Uint8Array.from({ length: n }, (_, o) => ((o >> 9) * 31 + o * 7 + 3) & 0xff);

/** What a case prints: its status byte (`-`: not written), the used length (`-`: no completion), then its checks. */
type Want = [name: string, s: number | '-', n: number | '-', ...checks: string[]];

/** What every disk answers: the ID, reads and their failures. `flush`: FLUSH's status (UNSUPP without the feature). */
const reads = (flush: number): Want[] => [
  ['id', 0, 21, 'waarm64-blk'],
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

/** The 9p guest (tests/baremetal/virtio/9p.c) on the in-memory tree with /hello.txt: a reply's used length and what it was. */
const P9_WANT = [
  '9p features=0x30000001 tag=host', // VERSION_1, INDIRECT_DESC, MOUNT_TAG
  // A session, well-formed.
  'version n=21 R101 msize=8192',
  'attach n=20 R105',
  'walk n=22 R111 nwqid=1',
  'lopen n=24 R13',
  'read n=31 R117 count=20 hello from the host/',
  // The chain's shape: no answer (a used length of 0) for a size past the readable bytes or under 7, 4 readable bytes
  // in all, room for 10 (under Rlerror's 11) or a reply past the room (Rgetattr's 160 bytes into 20).
  'size-past-readable n=0',
  'size-6 n=0',
  'readable-4 n=0',
  'room-10 n=0',
  'bytes-past-size n=31 R117 count=20 hello from the host/', // the bytes past `size` left out
  'one-byte-buffers n=31 R117 count=20 hello from the host/',
  'read-count-past-room n=16 R117 count=5 hello', // the count cut to the room
  'read-count-max n=31 R117 count=20 hello from the host/',
  'read-offset-max n=11 R117 count=0 ',
  'reply-past-room n=0',
  // The message's fields: EINVAL for what's cut short (a name announced and missing, a string past the end, a Tread
  // with no fields), EOPNOTSUPP for an unknown type, EBADF for an unknown fid.
  'walk-truncated n=11 R7 errno=22',
  'walk-65535 n=11 R7 errno=22',
  'string-past-end n=11 R7 errno=22',
  'read-no-fields n=11 R7 errno=22',
  'type-250 n=11 R7 errno=95',
  'unknown-fid n=11 R7 errno=9',
  'lcreate n=24 R15',
  'write-count-past-data n=11 R7 errno=22',
  // Offsets past 2^40 and 2^63: the in-memory tree can't grow the file that far (a RangeError: EINVAL). Below that it
  // allocates the whole size: the tree is the tests' only (the page's shares are web/9p-folders.ts).
  'write-2^40 n=11 R7 errno=22',
  'write-2^63 n=11 R7 errno=22',
  'write n=11 R119 count=3',
  'read-back n=14 R117 count=3 abc',
  'flush-idle-tag n=7 R109',
  'version-again n=21 R101 msize=8192',
  'read-after-version n=11 R7 errno=9', // a Tversion ends every fid
  'exit 0',
  '',
].join('\n');

/**
 * The net guest (tests/baremetal/virtio/net.c) on the loopback adapter: per case, the frames received before the reply
 * to the probe ping sent after it (`dead` if it never came).
 */
const NET_WANT = [
  // CSUM, GUEST_CSUM, MAC, GUEST_TSO4/6, HOST_TSO4/6, HOST_ECN, MRG_RXBUF, STATUS, INDIRECT_DESC, EVENT_IDX; VERSION_1, HOST_USO.
  'net features=0x3001b9a3 0x1000001 link=1',
  'arp rx=1 arp-reply',
  'ping rx=1 echo seq=2 len=98',
  'csum rx=1 echo seq=3 len=98 finished', // NEEDS_CSUM: the checksum the guest left to the device, in the echo
  // Dropped, as a NIC drops what its driver got wrong: a checksum's place past the frame or its start past it, a
  // header alone or cut short, nothing readable.
  'csum-past-frame rx=0',
  'csum-start-max rx=0',
  'header-only rx=0',
  'header-5 rx=0',
  'all-writable rx=0',
  'split rx=1 echo seq=9 len=98', // the header in 3 buffers, the frame in 98 of a byte
  'writable-after-frame rx=1 echo seq=10 len=98',
  'frame-1518 rx=1 echo seq=11 len=1518',
  'frame-1519 rx=0', // past the largest frame without GSO
  // GSO: dropped on a ping (it isn't TCP), with an unknown type, an MSS of 0, past the largest packet; an MSS of 1
  // makes 60,000 segments (which the adapter ignores) and the device answers on.
  'gso-on-icmp rx=0',
  'gso-type-2 rx=0',
  'gso-mss-0 rx=0',
  'gso-mss-1 rx=0',
  'gso-past-largest rx=0',
  // Receive: across 32-byte mergeable buffers; a readable buffer first takes none of it (and counts in num_buffers);
  // without MRG_RXBUF a buffer no frame fits holds the queue until a reset (each frame dropped, as a NIC drops).
  'rx-merged bytes=110 buffers=4 num_buffers=4 data',
  'rx-readable-first bytes=110 buffers=2 lens=0,110',
  'rx-too-small bytes=0 then=0',
  'after-reset rx=0',
  'exit 0',
  '',
].join('\n');

let run = 0;
/** Each guest's devices, made in `dir` (the disks' images; each run a new overlay). */
const GUESTS: Record<string, { want: string; devices: (dir: string) => DeviceSpec[] }> = {
  // A 1 MiB ramdisk, a read-only image, an image under an overlay.
  blk: {
    want: WANT,
    devices: (dir) => {
      const [ro, ov] = [join(dir, 'ro.img'), join(dir, 'overlay.img')];
      writeFileSync(ro, image(64 << 10));
      writeFileSync(ov, image(64 << 10));
      return [{ type: 'blk', source: 'ram', size: 1 << 20 }, { type: 'blk', url: pathToFileURL(ro).href }, { type: 'blk', url: pathToFileURL(ov).href, overlay: `virtio-guest-${run++}`, discard: true }];
    },
  },
  '9p': { want: P9_WANT, devices: () => [{ type: '9p', tag: 'host', files: { 'hello.txt': 'hello from the host\n' } }] },
  net: { want: NET_WANT, devices: () => [{ type: 'net', adapter: 'loopback' }] },
};

async function boot(name: string, o: Partial<BootOptions>) {
  const g = GUESTS[name];
  const dir = mkdtempSync(join(tmpdir(), 'virtio-guest-'));
  try {
    const r = await runToPowerOff(WASM, {
      ramSize: 16 << 20, kernel: readFileSync(new URL(`baremetal/virtio/${name}.bin`, import.meta.url)), kernelOffset: 0, cmdline: '', ...o,
      devices: g.devices(dir),
    }, 100e6, undefined, undefined, 120_000);
    assert.equal(r.kind, Exit.PSCI, r.console);
    assert.equal(r.x[0], PSCI_SYSTEM_OFF, r.console);
    // Line by line, so a mismatch names its case.
    const got = r.console.split('\n');
    const want = g.want.split('\n');
    want.forEach((w, i) => assert.equal(got[i], w, `line ${i + 1}`));
    assert.equal(got.length, want.length, r.console);
    assert.equal(r.x[1], 0n, r.console);
    return r;
  } finally {
    rmSync(dir, { recursive: true });
  }
}

for (const name of Object.keys(GUESTS)) {
  let interp: Awaited<ReturnType<typeof boot>> | undefined;
  test(`virtio-${name} through a bare-metal driver: interpreter`, async () => {
    interp = await boot(name, { jit: 0 });
  });
  test(`virtio-${name} through a bare-metal driver: JIT (the interpreter's steps)`, async () => {
    const r = await boot(name, { jit: 1 });
    if (interp) assert.equal(r.steps, interp.steps);
  });
  test(`virtio-${name} through a bare-metal driver: parallel (JIT)`, async () => {
    await boot(name, { jit: 1, parallel: true, idleLimitMs: 30_000 });
  });
}
