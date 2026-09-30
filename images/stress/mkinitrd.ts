// Appends the stress binaries to Debian's initramfs (docs/images.md "stress"): the kernel unpacks
// concatenated cpio segments in order, so `initrd.img` = Debian's initrd + one more `newc`
// archive holding /stress.cpio (the binaries), an init-bottom hook and scripts/init-bottom/ORDER
// (the original's two lines plus the hook; the later file wins). The hook unpacks the binaries
// (an inner cpio: the initramfs has no cp, chmod or find, and klibc's mount can't remount) into a
// new tmpfs on /run/stress, exec-capable although /run is noexec; /run survives the switch to
// the real root, with the tmpfs moved along. Guest side: /run/stress/gostress <seconds>.
//
// usage: node mkinitrd.ts <debian initrd.img> <out initrd.img> <file>...   (files go to /run/stress/<basename> in the guest)
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

const [, , src, out, ...files] = process.argv;
const HOOK = `#!/bin/sh
# webpc stress hook: /stress.cpio -> a tmpfs on /run/stress (executable), see images/stress/mkinitrd.ts
[ "$1" = prereqs ] && exit 0
exec > /run/stress.log 2>&1
mkdir -p /run/stress
mount -t tmpfs -o mode=755 tmpfs /run/stress
cd /run/stress
cpio -i < /stress.cpio
`;
// Debian's scripts/init-bottom/ORDER as of the pinned image (check it when the image changes).
const ORDER = `/scripts/init-bottom/udev "$@"\n/scripts/init-bottom/webpc-stress "$@"\n[ -e /conf/param.conf ] && . /conf/param.conf\n`;

const pad = (n: number) => (4 - (n % 4)) % 4;
/** A `newc` archive of [name, mode, data] (the kernel's and klibc's cpio both read it). */
function cpio(items: [string, number, Buffer][]) {
  const chunks: Buffer[] = [];
  let ino = 0x7e57;
  const hex = (v: number) => v.toString(16).padStart(8, '0');
  for (const [name, mode, data] of [...items, ['TRAILER!!!', 0, Buffer.alloc(0)] as [string, number, Buffer]]) {
    const nm = Buffer.from(name + '\0');
    const head = '070701' + [ino++, mode, 0, 0, 1, 0, data.length, 0, 0, 0, 0, nm.length, 0].map(hex).join('');
    chunks.push(Buffer.from(head), nm, Buffer.alloc(pad(110 + nm.length)), data, Buffer.alloc(pad(data.length)));
  }
  return Buffer.concat(chunks);
}
const DIR = 0o040755;
const inner = cpio(files.map((f) => [basename(f), 0o100755, readFileSync(f)]));
const extra = cpio([
  ['stress.cpio', 0o100644, inner],
  ['scripts', DIR, Buffer.alloc(0)],
  ['scripts/init-bottom', DIR, Buffer.alloc(0)],
  ['scripts/init-bottom/webpc-stress', 0o100755, Buffer.from(HOOK)],
  ['scripts/init-bottom/ORDER', 0o100644, Buffer.from(ORDER)],
]);

const base = readFileSync(src);
writeFileSync(out, Buffer.concat([base, Buffer.alloc((512 - (base.length % 512)) % 512), extra])); // zero padding between segments is skipped
console.log(`${out}: ${base.length} + ${extra.length} bytes, ${files.length} files`);
