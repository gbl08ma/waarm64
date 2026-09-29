// The frame and IP-packet ports of web/net.ts (docs/devices.md "net").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ipPort, portAdapter } from '../web/net.ts';

for (const [name, make] of [['frame', portAdapter], ['IP packet', ipPort]] as const) {
  test(`the ${name} port carries one ArrayBuffer per message both ways`, async () => {
    const { port1, port2 } = new MessageChannel();
    const got: (string | number)[][] = [];
    let done!: () => void;
    const both = new Promise<void>((r) => (done = r));
    const a = make(port1, (f) => { got.push(['a', ...f]); if (got.length === 2) done(); });
    const b = make(port2, (f) => { got.push(['b', ...f]); if (got.length === 2) done(); });
    a.send(new Uint8Array([1, 2, 3]));
    b.send(new Uint8Array([9, 8]).subarray(1)); // a view: only its bytes cross
    await both;
    got.sort();
    assert.deepEqual(got, [['a', 8], ['b', 1, 2, 3]]);
    a.close!();
    b.close!();
  });
}
