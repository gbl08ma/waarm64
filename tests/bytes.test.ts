// The network code's shared byte helpers (web/bytes.ts) and IPv6 text both ways (web/ip6.ts `parse6`, `v6text`).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eq, hex } from '../web/bytes.ts';
import { parse6, v6text } from '../web/ip6.ts';

test('eq compares in place; hex is two lowercase digits a byte', () => {
  const a = Uint8Array.from([9, 1, 2, 3, 9]);
  assert.equal(eq(a, 1, [1, 2, 3]), true);
  assert.equal(eq(a, 1, [1, 2, 4]), false);
  assert.equal(eq(a, 3, [3, 9, 0]), false, 'past the end');
  assert.equal(eq(a, 0, []), true);
  assert.equal(hex(Uint8Array.from([0, 0xab, 0x0f])), '00ab0f');
});

test('IPv6 text: the longest zero run as ::, and back', () => {
  for (const [text, again] of [
    ['2606:4700:4700::1111', '2606:4700:4700::1111'],
    ['::1', '::1'],
    ['::', '::'],
    ['1:0:0:2:0:0:0:3', '1:0:0:2::3'],
    ['fd7a:115c:a1e0:0:0:0:0:1', 'fd7a:115c:a1e0::1'],
    ['1:0:2:3:4:5:6:7', '1:0:2:3:4:5:6:7'],
  ])
    assert.equal(v6text(parse6(text)!), again, text);
});
