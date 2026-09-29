#!/usr/bin/env bash
# Regenerates the ext4 reader's fixtures (web/ext4.ts, web/bootfs.ts; M8 loop 5)
# with e2fsprogs, sfdisk and qemu-img on the host, like tests/qcow2/make.sh.
# One tree (made below, deterministic) in two images, each a compressed qcow2:
# - ext4.qcow2: GPT, partition 1 a small FAT-less placeholder, partition 2 ext4
#   with 1 KiB blocks, 64bit, metadata_csum, flex_bg, and meta_bg (so group
#   descriptors live in each meta group); sparse.bin has 400 extents (a depth-2
#   extent tree), dir/ 300 entries (an htree after e2fsck -D).
# - ext2.qcow2: MBR, partition 1 ext2 with 1 KiB blocks (block maps: big.bin
#   reaches the double-indirect blocks, sparse.bin has holes in them).
# manifest.json lists what the tree holds (sha256 of files, symlink targets,
# directory sizes); tests/ext4.test.ts reads both images against it.
set -euo pipefail
cd "$(dirname "$0")"
t=$(mktemp -d)
trap 'rm -rf "$t"' EXIT
python3 - "$t/tree" <<'PY'
import hashlib, json, os, random, sys
root = sys.argv[1]
random.seed(5)
m = {}
def f(path, data):
    p = os.path.join(root, path); os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, 'wb').write(data); m['/' + path] = {'sha256': hashlib.sha256(data).hexdigest(), 'size': len(data)}
def l(path, target):
    p = os.path.join(root, path); os.makedirs(os.path.dirname(p), exist_ok=True)
    os.symlink(target, p); m['/' + path] = {'link': target}
f('hello.txt', b'hello from ext4\n')
f('empty', b'')
# Text that names its own 1 KiB block (compresses well; a block read from the wrong place shows).
text = lambda name, k: (f'{name} block {k:06d}. ' * 64)[:1024].encode()
f('big.bin', b''.join(text('big', k) for k in range(301))[:300 * 1024 + 123])
# 400 one-block chunks of data with 3-block holes between them.
p = os.path.join(root, 'sparse.bin'); data = bytearray(400 * 4 * 1024)
with open(p, 'wb') as fh:
    for k in range(400):
        chunk = text('sparse', k); fh.seek(k * 4 * 1024); fh.write(chunk); data[k * 4096:k * 4096 + 1024] = chunk
    fh.truncate(len(data))
m['/sparse.bin'] = {'sha256': hashlib.sha256(data).hexdigest(), 'size': len(data)}
for k in range(300): f(f'dir/file-{k:03d}', f'entry {k}\n'.encode())
m['/dir'] = {'entries': 300}
f('a/b/c/deep.txt', b'deep\n')
f('boot/vmlinuz-6.1.0-9', b'old kernel')
f('boot/vmlinuz-6.1.0-10', b'ARM kernel ' + random.randbytes(5000))
f('boot/initrd.img-6.1.0-10', random.randbytes(7000))
f('boot/initrd.img-6.1.0-9', b'old initrd')
l('boot/vmlinuz', 'vmlinuz-6.1.0-10')
l('link-fast', 'hello.txt')
l('link-abs', '/a/b')
l('link-slow', 'a/b/c/../../b/c/../../b/c/../../b/c/./../../b/c/../../b/c/deep.txt')  # > 60 bytes: in a block
l('a/up', '../hello.txt')
l('loop1', 'loop2'); l('loop2', 'loop1')
json.dump(m, open(os.path.join(os.path.dirname(root), 'manifest.json'), 'w'), indent=1, sort_keys=True)
PY
cp "$t/manifest.json" manifest.json
export E2FSPROGS_FAKE_TIME=1788220800
# ext4 in partition 2 of a GPT disk.
mke2fs -q -t ext4 -b 1024 -g 256 -O meta_bg,^resize_inode -U 77656270-6300-4000-8000-000000000021 -E hash_seed=77656270-6300-4000-8000-000000000022 -L webpc-ext4 -d "$t/tree" "$t/fs4" 8M
e2fsck -fyD "$t/fs4" > /dev/null 2>&1 || [ $? -eq 1 ]
truncate -s 12M "$t/gpt"
printf 'label: gpt\nunit: sectors\n2048,1024\n4096,16384\n' | sfdisk -q "$t/gpt"
dd if="$t/fs4" of="$t/gpt" bs=512 seek=4096 conv=notrunc,sparse status=none
# ext2 in partition 1 of an MBR disk.
mke2fs -q -t ext2 -b 1024 -g 512 -U 77656270-6300-4000-8000-000000000023 -L webpc-ext2 -d "$t/tree" "$t/fs2" 4M
truncate -s 5M "$t/mbr"
printf 'label: dos\nunit: sectors\n2048,8192,83\n' | sfdisk -q "$t/mbr"
dd if="$t/fs2" of="$t/mbr" bs=512 seek=2048 conv=notrunc,sparse status=none
debugfs -R 'stat /sparse.bin' "$t/fs4" 2>/dev/null | grep -m1 -o 'Extent tree depth: *[0-9]*\|(ETB[0-9]*)' || true
dumpe2fs -h "$t/fs4" 2>/dev/null | grep -E "features|Block count|Blocks per group|Inodes per group|First meta"
dumpe2fs -h "$t/fs2" 2>/dev/null | grep -E "features|Blocks per group|Inodes per group"
debugfs -R "stat /dir/file-299" "$t/fs4" 2>/dev/null | head -1
debugfs -R 'htree /dir' "$t/fs4" 2>/dev/null | grep -m1 'Root node' || true
qemu-img convert -c -f raw -O qcow2 "$t/gpt" ext4.qcow2
qemu-img convert -c -f raw -O qcow2 "$t/mbr" ext2.qcow2
ls -l ext4.qcow2 ext2.qcow2
