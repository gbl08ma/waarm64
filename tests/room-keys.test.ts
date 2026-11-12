// tests/net/room-keys.ts: a key's address and name in a room as the module derives them (net/ts/src/room.rs).
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { test } from 'node:test';
import { addressOf, keyPair, nameOf, roomPrefix } from './net/room-keys.ts';

/** A key's public key, as the module computes it from the private one (X25519). */
const publicOf = (key: string) => Buffer.from(createPublicKey(createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), Buffer.from(key, 'hex')]), format: 'der', type: 'pkcs8' })).export({ format: 'jwk' }).x!, 'base64url');

test('a key\'s address and name in a room are the module\'s', () => {
  // What the module said for this key in this room (a member's `self` event, joined from the dev VM, 2026-11-11).
  const prefix = roomPrefix('gbltest-3osfmkgjp2ipy24462wsg6vase');
  const pub = publicOf('d63de5f704da4c84c7d36d7d8f9e37656639f759ae0b8c075000b4bd8d9203d6');
  assert.equal(addressOf(prefix, pub), 'fd1f:9d04:b403:a7eb:711b:9fde:d80e:a798');
  assert.equal(nameOf(prefix, pub), 'u7vxcg4733ma5j4y4bdn6opo5ncyk6nl7dof3ec42hkjdb42qzna.d6oqjnad.p2p.internal');
  assert.equal(addressOf(prefix, new Uint8Array(32)), 'fd1f:9d04:b403::');
  const k = keyPair();
  assert.equal(Buffer.compare(k.pub, publicOf(k.key)), 0, 'a new pair\'s public key is its private one\'s');
});
