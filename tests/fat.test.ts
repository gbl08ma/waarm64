// The FAT12 writer (web/fat.ts) for the NoCloud seed disk: its layout, and
// fsck.fat and mtools (the reference tools, where installed) reading it back.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fatImage } from '../web/fat.ts';

const big = Uint8Array.from({ length: 5000 }, (_, i) => i & 0xff);
const files = [{ name: 'meta-data', data: 'instance-id: waarm64\n' }, { name: 'user-data', data: '#!/bin/sh\npasswd -d root\n' }, { name: 'BIG.BIN', data: big }];

test('fatImage lays out a FAT12 volume', () => {
  const img = fatImage('CIDATA', files);
  const v = new DataView(img.buffer);
  assert.equal(img.length, 1 << 20);
  assert.deepEqual([img[510], img[511]], [0x55, 0xaa]);
  assert.equal(v.getUint16(11, true), 512);
  assert.equal(new TextDecoder().decode(img.subarray(43, 54)), 'CIDATA     ');
  const fatSectors = v.getUint16(22, true);
  const root = 512 * (1 + 2 * fatSectors);
  // The label, then meta-data's long entry (one part: 9 characters and a NUL) and its alias.
  assert.equal(img[root + 11], 0x08);
  assert.equal(img[root + 32], 0x41);
  assert.equal(img[root + 32 + 11], 0x0f);
  assert.equal(new TextDecoder().decode(img.subarray(root + 64, root + 75)), 'METADA~1   ');
  // BIG.BIN spans three 2 KiB clusters: 4 → 5 → 6 → end (after one each for the two small files).
  const fat = (n: number) => { const o = Math.floor((n * 3) / 2); const w = v.getUint16(512 + o, true); return n & 1 ? w >> 4 : w & 0xfff; };
  assert.deepEqual([fat(2), fat(3), fat(4), fat(5), fat(6), fat(7)], [0xfff, 0xfff, 5, 6, 0xfff, 0]);
  assert.deepEqual(img.subarray(512, 512 + 512 * fatSectors), img.subarray(512 * (1 + fatSectors), 512 * (1 + 2 * fatSectors)), 'two copies of the FAT');
  assert.deepEqual(fatImage('CIDATA', files), img, 'the same bytes every time');
});

const tools = (() => {
  try {
    execFileSync('fsck.fat', ['--help'], { stdio: 'ignore' });
    execFileSync('mtype', ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
test('fsck.fat and mtools read it back', { skip: !tools && 'SKIPPED: no fsck.fat or mtools' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'waarm64-fat-'));
  try {
    const path = join(dir, 'seed.img');
    writeFileSync(path, fatImage('CIDATA', files));
    execFileSync('fsck.fat', ['-n', path], { stdio: 'pipe' });
    assert.equal(execFileSync('mtype', ['-i', path, '::/user-data'], { encoding: 'utf8' }), files[1].data);
    const out = execFileSync('mtype', ['-i', path, '::/BIG.BIN']);
    assert.deepEqual(new Uint8Array(out), big);
    assert.match(execFileSync('mdir', ['-i', path, '::/'], { encoding: 'utf8' }), /CIDATA[^]*meta-data[^]*user-data/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
