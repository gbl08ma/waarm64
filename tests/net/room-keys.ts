// A room member's address and name from its key, as net/ts/src/room.rs derives them (`Room::derive`, `addr`, `name`),
// for tests that need to know them in advance (tests/page-room.test.ts pastes a key and checks the name it gets). The
// miner is net/ts/examples/room-key-mine.rs; tests/room-keys.test.ts checks this against what the module said.
import { createHash, generateKeyPairSync } from 'node:crypto';

/** tailcat's /48, which no room's may be (room.rs `TAILCAT_PREFIX`). */
const TAILCAT_PREFIX = Buffer.from('fd7a115ca1e0', 'hex');

function blake2s(label: string, id: string): Buffer {
  return createHash('blake2s256').update(label).update(Buffer.of(0)).update(id).digest();
}

/** The room's /48, its first 6 bytes (room.rs `Room::derive`). */
export function roomPrefix(id: string): Buffer {
  for (let n = 0; ; n++) {
    const p = Buffer.concat([Buffer.of(0xfd), blake2s(n ? `waarm64 room prefix v1 ${n}` : 'waarm64 room prefix v1', id).subarray(0, 5)]);
    if (!p.equals(TAILCAT_PREFIX)) return p;
  }
}

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
/** RFC 4648's base32, lower case, no padding (room.rs `base32`). */
export function base32(b: Uint8Array): string {
  let [out, acc, bits] = ['', 0, 0];
  for (const x of b) {
    acc = ((acc << 8) | x) & 0xffff;
    bits += 8;
    while (bits >= 5) { bits -= 5; out += B32[(acc >> bits) & 31]; }
  }
  return bits > 0 ? out + B32[(acc << (5 - bits)) & 31] : out;
}

/** An address written out whole: 8 groups of 4 hex digits. */
const expanded = (a: Uint8Array) => Buffer.from(a).toString('hex').replace(/(.{4})(?!$)/g, '$1:');
/** As the page writes it (web/room.ts `v6text`): the URL parser's IPv6 serialization is RFC 5952's. */
const compressed = (a: Uint8Array) => new URL(`http://[${expanded(a)}]`).hostname.slice(1, -1);

/** A member's address in the room with /48 `prefix`: the prefix and the first 80 bits of its public key. */
export function addressOf(prefix: Uint8Array, pub: Uint8Array, whole = false): string {
  const a = new Uint8Array(16);
  a.set(prefix);
  a.set(pub.subarray(0, 10), 6);
  return whole ? expanded(a) : compressed(a);
}

/** A member's name: its public key in base32, then the room's domain (`<tag>.p2p.internal`). */
export const nameOf = (prefix: Uint8Array, pub: Uint8Array) => `${base32(pub)}.${base32(prefix.subarray(1))}.p2p.internal`;

/** A new key pair: the private key (what the wizard takes, 64 hex digits) and the public key, raw. */
export function keyPair(): { key: string; pub: Buffer } {
  const k = generateKeyPairSync('x25519', { publicKeyEncoding: { format: 'der', type: 'spki' }, privateKeyEncoding: { format: 'der', type: 'pkcs8' } });
  return { key: k.privateKey.subarray(-32).toString('hex'), pub: k.publicKey.subarray(-32) };
}
