// tests/net/room-keys.ts: a key's address and name in a room as the module derives them (net/ts/src/room.rs).
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { test } from 'node:test';
import { addressOf, base32, keyPair, nameOf, roomDomain, roomLabel, roomPrefix } from './net/room-keys.ts';

/** A key's public key, as the module computes it from the private one (X25519). */
const publicOf = (key: string) => Buffer.from(createPublicKey(createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), Buffer.from(key, 'hex')]), format: 'der', type: 'pkcs8' })).export({ format: 'jwk' }).x!, 'base64url');

test('a key\'s address and name in a room are the module\'s', () => {
  // What the module said for this key in this room (a member's `self` event, joined from the dev VM, 2026-11-11).
  const id = 'gbltest-3osfmkgjp2ipy24462wsg6vase';
  const prefix = roomPrefix(id);
  const pub = publicOf('d63de5f704da4c84c7d36d7d8f9e37656639f759ae0b8c075000b4bd8d9203d6');
  assert.equal(addressOf(prefix, pub), 'fdd1:dba0:3f3d:a7eb:711b:9fde:d80e:a798');
  assert.equal(nameOf(id, pub), 'u7vxcg4733ma5j4y4bdn6opo5ncyk6nl7dof3ec42hkjdb42qzna.2hn2apz5.p2p.internal', 'a private room: under its tag');
  assert.equal(addressOf(prefix, new Uint8Array(32)), 'fdd1:dba0:3f3d::');
  const k = keyPair();
  assert.equal(Buffer.compare(k.pub, publicOf(k.key)), 0, 'a new pair\'s public key is its private one\'s');
});

test('a room whose ID is a DNS label is under its name, unless the ID looks derived (room.rs `room_label`)', () => {
  assert.equal(roomDomain('gabriel-lan'), 'gabriel-lan.p2p.internal');
  for (const ok of ['global', 'a', '7', 'lan-2', 'abcdefg1', 'abcdefg', 'abcdefghi', 'a'.repeat(63)]) assert.equal(roomLabel(ok), ok, ok);
  const tag = base32(roomPrefix('test room').subarray(1));
  const priv = `lan-${base32(new Uint8Array(16).fill(7))}`;
  for (const no of ['Gabriel-LAN', 'Global', 'test room', 'café', 'a.b', 'a_b', '-lan', 'lan-', 'xn--caf-dma', 'ab--cd', '', 'a'.repeat(64), tag, tag.toUpperCase(), 'abcdefgh', '22222222', priv, priv.toUpperCase()]) {
    assert.equal(roomLabel(no), undefined, no);
    assert.equal(roomDomain(no), `${base32(roomPrefix(no).subarray(1))}.p2p.internal`, no);
  }
});
