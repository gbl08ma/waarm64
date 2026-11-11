// tools/serve.ts: Vite's dev server over the repository, as the tests and benchmarks use it: cross-origin isolation,
// HTTP range requests on files (the virtio-blk HTTP backend reads disks with them), web/'s TypeScript and Svelte
// compiled, and `/` the page.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { startServer } from '../tools/serve.ts';

let base: string;
let close: () => void;
before(async () => {
  const server = await startServer();
  close = () => server.close();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(() => close?.());

test('ranges over HTTP', async () => {
  const path = '/tests/dtb/webpc.dts';
  const whole = readFileSync(new URL('.' + path, new URL('..', import.meta.url)));
  const r = await fetch(base + path, { headers: { Range: 'bytes=10-19' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), `bytes 10-19/${whole.length}`);
  assert.equal(r.headers.get('cross-origin-embedder-policy'), 'require-corp');
  assert.equal(Buffer.compare(Buffer.from(await r.arrayBuffer()), whole.subarray(10, 20)), 0);
  const head = await fetch(base + path, { method: 'HEAD' });
  assert.equal(head.headers.get('content-length'), String(whole.length));
  assert.equal((await fetch(base + path, { headers: { Range: `bytes=${whole.length}-` } })).status, 416);
  assert.equal(Buffer.compare(Buffer.from(await (await fetch(base + path)).arrayBuffer()), whole), 0);
});

test('the page, its modules compiled, `/` sending the browser to it', async () => {
  const root = await fetch(base + '/?disk=https://h/d.json', { redirect: 'manual' });
  assert.equal(root.status, 302);
  assert.equal(root.headers.get('location'), '/web/app/?disk=https://h/d.json');
  const page = await fetch(base + '/web/app/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type') ?? '', /^text\/html/);
  assert.equal(page.headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.equal(page.headers.get('cross-origin-embedder-policy'), 'require-corp');
  assert.match(await page.text(), /<meta name="webpc-build" content="[0-9a-f]{12} \(/);
  const ts = await fetch(base + '/web/app/protocol.ts');
  assert.match(ts.headers.get('content-type') ?? '', /javascript/);
  assert.doesNotMatch(await ts.text(), /export type ToWorker/);
  const component = await (await fetch(base + '/web/app/ui/Icon.svelte')).text();
  assert.match(component, /from "\/node_modules\/[^"]*svelte\/src\/internal\/client\/index\.js/);
  assert.doesNotMatch(component, /<script/);
});
