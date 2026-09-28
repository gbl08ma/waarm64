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

test('the page, and only the files it imports from node_modules', async () => {
  const root = await fetch(base + '/', { redirect: 'manual' });
  assert.deepEqual([root.status, root.headers.get('location')], [302, '/web/app/']);
  const page = await fetch(base + '/web/app/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type') ?? '', /^text\/html/);
  assert.equal(page.headers.get('cross-origin-embedder-policy'), 'require-corp');
  for (const ok of ['/node_modules/@xterm/xterm/lib/xterm.mjs', '/node_modules/@xterm/xterm/css/xterm.css']) assert.equal((await fetch(base + ok)).status, 200, ok);
  for (const no of ['/node_modules/@xterm/xterm/lib/xterm.mjs.map', '/node_modules/@xterm/xterm/package.json', '/node_modules/typescript/package.json', '/node_modules/@xterm/xterm/lib/%2e%2e/package.json', '/web/%2e%2e/node_modules/@xterm/xterm/LICENSE']) {
    assert.equal((await fetch(base + no)).status, 403, no);
  }
});
