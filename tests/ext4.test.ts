// The ext2/3/4 reader and the partition tables (web/ext4.ts, web/bootfs.ts), over
// the qcow2 reader, against tests/ext4/make.sh's fixtures and their manifest.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { compareVersions, findBootFiles, partitions } from '../web/bootfs.ts';
import { isDir, openExt4 } from '../web/ext4.ts';
import { openDisk } from '../web/qcow2.ts';

const disk = (name: string) => {
  const b = readFileSync(new URL(`./ext4/${name}`, import.meta.url));
  return openDisk((off, len) => (off + len <= b.length ? new Uint8Array(b.buffer, b.byteOffset + off, len) : undefined), b.length);
};
type Entry = { sha256?: string; size?: number; link?: string; entries?: number };
const manifest = JSON.parse(readFileSync(new URL('./ext4/manifest.json', import.meta.url), 'utf8')) as Record<string, Entry>;
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

for (const [name, table, number, label] of [['ext4.qcow2', 'gpt', 2, 'webpc-ext4'], ['ext2.qcow2', 'mbr', 1, 'webpc-ext2']] as const) {
  test(`${name}: every file, link and directory reads as the manifest says`, async () => {
    const d = disk(name);
    const parts = await partitions(d.read);
    if (table === 'gpt') {
      assert.deepEqual(parts.map((p) => [p.number, p.start, p.size, p.type]), [
        [1, 2048 * 512, 1024 * 512, '0FC63DAF-8483-4772-8E79-3D69D8477DE4'],
        [2, 4096 * 512, 16384 * 512, '0FC63DAF-8483-4772-8E79-3D69D8477DE4'],
      ]);
    } else {
      assert.deepEqual(parts, [{ number: 1, start: 2048 * 512, size: 8192 * 512, type: '83' }]);
    }
    const fs = await openExt4(d.read, parts.find((p) => p.number === number)!.start);
    assert.deepEqual([fs.blockSize, fs.label], [1024, label]);
    for (const [path, e] of Object.entries(manifest)) {
      if (e.sha256 !== undefined) {
        const b = await fs.readFile(path);
        assert.deepEqual([b.length, sha256(b)], [e.size, e.sha256], path);
      } else if (e.link !== undefined) {
        assert.equal(await fs.readlink(path), e.link, path);
      } else {
        assert.equal((await fs.readdir(path)).length, e.entries, path);
      }
    }
    assert.deepEqual((await fs.readdir('/dir')).map((x) => x.name).sort(), Array.from({ length: 300 }, (_, k) => `file-${String(k).padStart(3, '0')}`));
    // Symlinks followed: relative, absolute, in a block, '..', and loops refused.
    const text = async (p: string) => new TextDecoder().decode(await fs.readFile(p));
    assert.equal(await text('/link-fast'), 'hello from ext4\n');
    assert.equal(await text('/link-abs/c/deep.txt'), 'deep\n');
    assert.equal(await text('/link-slow'), 'deep\n');
    assert.equal(await text('/a/up'), 'hello from ext4\n');
    assert.equal(await text('/a/b/../b/c/../../up'), 'hello from ext4\n');
    assert.equal((await fs.readFile('/boot/vmlinuz')).length, manifest['/boot/vmlinuz-6.1.0-10'].size);
    assert.ok(isDir((await fs.lookup('/link-abs'))!));
    await assert.rejects(fs.readFile('/loop1'), /too many symlinks/);
    assert.equal(await fs.lookup('/nothing/here'), undefined);
    await assert.rejects(fs.readFile('/dir'), /not a regular file/);
    // The kernel and initrd: the highest version in /boot, from the first partition that has one.
    const boot = (await findBootFiles(d.read))!;
    assert.deepEqual([boot.partition?.number, boot.version, boot.kernel, boot.initrd], [number, '6.1.0-10', '/boot/vmlinuz-6.1.0-10', '/boot/initrd.img-6.1.0-10']);
  });
}

test('a bare filesystem (no partition table), and what is not one', async () => {
  const d = disk('ext2.qcow2');
  const fs = (await d.read(2048 * 512, 8192 * 512))!;
  const bare = async (off: number, len: number) => (off + len <= fs.length ? fs.subarray(off, off + len) : undefined);
  assert.deepEqual(await partitions(bare), []);
  assert.equal((await findBootFiles(bare))?.version, '6.1.0-10');
  await assert.rejects(openExt4(d.read), /no ext2\/3\/4 superblock/);
});

test('compareVersions', () => {
  assert.deepEqual(['6.12.107+deb13-arm64', '6.1.0-10', '6.1.0-9', '6.12.9+deb13-arm64', '5.10.0-30'].sort(compareVersions),
    ['5.10.0-30', '6.1.0-9', '6.1.0-10', '6.12.9+deb13-arm64', '6.12.107+deb13-arm64']);
});
