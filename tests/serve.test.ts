// tools/serve.ts: HTTP range requests (the virtio-blk HTTP backend reads disks with them).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { parseRange, startServer } from '../tools/serve.ts';

let base: string;
let close: () => void;
before(async () => {
  const server = await startServer();
  close = () => server.close();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(() => close?.());

test('parseRange', () => {
  assert.deepEqual(parseRange('bytes=0-9', 100), [0, 9]);
  assert.deepEqual(parseRange('bytes=90-', 100), [90, 99]);
  assert.deepEqual(parseRange('bytes=90-200', 100), [90, 99]);
  assert.deepEqual(parseRange('bytes=-10', 100), [90, 99]);
  assert.deepEqual(parseRange('bytes=-200', 100), [0, 99]);
  assert.equal(parseRange('bytes=100-', 100), 'bad');
  assert.equal(parseRange('bytes=5-4', 100), 'bad');
  assert.equal(parseRange(undefined, 100), undefined);
  assert.equal(parseRange('bytes=0-1,4-5', 100), undefined);
});

test('ranges over HTTP', async () => {
  const path = '/tests/dtb/webpc.dts';
  const whole = readFileSync(new URL('.' + path, new URL('..', import.meta.url)));
  const r = await fetch(base + path, { headers: { Range: 'bytes=10-19' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), `bytes 10-19/${whole.length}`);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), whole.subarray(10, 20));
  const head = await fetch(base + path, { method: 'HEAD' });
  assert.equal(head.headers.get('content-length'), String(whole.length));
  assert.equal((await fetch(base + path, { headers: { Range: `bytes=${whole.length}-` } })).status, 416);
  assert.deepEqual(Buffer.from(await (await fetch(base + path)).arrayBuffer()), whole);
});
