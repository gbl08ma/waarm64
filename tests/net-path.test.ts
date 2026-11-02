// The card's other path (web/devices.ts `net`, web/gateway.ts `FramePath`): an IP port's card put on a frame port of its
// own (the local helper's client, web/local-net-worker.ts) and back, the link flapping under a driver.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FLAP_MS, net, type Ctx } from '../web/devices.ts';

test("net: a card on an IP port goes to a frame port and back (the local helper's path), flapping the link under a driver", { timeout: 3 * FLAP_MS + 5000 }, async () => {
  const ram = new Uint8Array(1 << 16);
  const config = new Uint8Array(8);
  config[6] = 1;
  const links: number[] = [];
  let features = 1n;
  const ctx = {
    ram: () => [ram], complete: () => {}, features: () => features, config: () => config, io: new Float64Array(2),
    changeConfig: (w: (c: Uint8Array) => void) => { w(config); links.push(config[6]); },
  } as unknown as Ctx;
  const ip = new MessageChannel();
  const n = net(ctx, { type: 'net', adapter: { ip: ip.port2 } });
  const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
  /** Waits (at most 2 s) for `ok`: a message between ports takes a turn or more. */
  const until = async (ok: () => boolean) => { for (let k = 0; k < 200 && !ok(); k++) await tick(10); };
  /** The guest sends a plain frame of `len` bytes (after virtio's header). */
  const send = (len: number) => {
    ram.fill(0, 0, 12);
    ram.fill(7, 12, 12 + len);
    n.request({ w0: 1, queue: 1, read: [{ off: 0, len: 12 + len, mem: 0 }], write: [] });
  };
  const frames = new MessageChannel();
  const got: number[] = [];
  frames.port1.onmessage = (e) => got.push((e.data as ArrayBuffer).byteLength);
  try {
    ip.port1.postMessage({ type: 'frames', port: frames.port2 }, [frames.port2]);
    await until(() => links.length > 0);
    assert.deepEqual(links, [0], 'down at once');
    send(9000); // past a 1500-byte MTU's frame: a frame port takes it
    await until(() => got.length > 0);
    assert.deepEqual(got, [9000]);
    await tick(FLAP_MS + 100);
    assert.deepEqual(links, [0, 1], 'up again FLAP_MS later');
    ip.port1.postMessage({ type: 'frames', port: null }); // the client went: still on frames, no flap
    await tick(100);
    send(100);
    await tick(100);
    assert.deepEqual(got, [9000], 'dropped: frames to no port');
    assert.deepEqual(links, [0, 1]);
    ip.port1.postMessage({ type: 'gateway' });
    await until(() => links.length > 2);
    assert.deepEqual(links, [0, 1, 0], 'back on the gateway: down');
    await tick(FLAP_MS + 100);
    features = 0n; // no driver: nothing to tell
    const again = new MessageChannel();
    again.port1.close(); // nothing listens: only the switch counts
    ip.port1.postMessage({ type: 'frames', port: again.port2 }, [again.port2]);
    await tick(100);
    assert.deepEqual(links, [0, 1, 0, 1]);
  } finally {
    n.close?.();
    for (const p of [ip.port1, frames.port1]) p.close();
  }
});
