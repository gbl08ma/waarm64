// The boot's download total (web/app/download-size.ts): a file's decoded size, never an encoded Content-Length; no
// total while any file's size is unknown (a compressed core once read "Downloading 11.0 MiB of 3.0 MiB").
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bodySize, totalOf } from '../web/app/download-size.ts';

const h = (o: Record<string, string>) => new Headers(o);

test("a file's size: its Content-Length unencoded, the size known when encoded, else none", () => {
  assert.equal(bodySize(h({ 'content-length': '3000' })), 3000);
  assert.equal(bodySize(h({ 'content-length': '3000', 'content-encoding': 'identity' })), 3000);
  assert.equal(bodySize(h({ 'content-length': '3000' }), 9000), 3000, 'unencoded: the header holds');
  assert.equal(bodySize(h({ 'content-encoding': 'zstd' }), 9000), 9000, 'encoded, no length: the size known');
  assert.equal(bodySize(h({ 'content-encoding': 'gzip', 'content-length': '2000' }), 9000), 9000, 'encoded: not its length');
  assert.equal(bodySize(h({ 'content-encoding': 'gzip', 'content-length': '2000' })), undefined, 'encoded, nothing known');
  assert.equal(bodySize(h({})), undefined, 'no length');
  assert.equal(bodySize(h({}), 0), undefined, 'a size of 0 recorded: not known');
});

test('the total: the sizes added, or none while one is unknown', () => {
  assert.equal(totalOf([9000, 3000]), 12000);
  assert.equal(totalOf([undefined, 3000]), 0);
  assert.equal(totalOf([]), 0);
});
