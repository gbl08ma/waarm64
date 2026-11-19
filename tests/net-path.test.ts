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

/** A card's context for these tests: a driver, the link's changes and the frames the guest was given counted. */
function card() {
  const ram = new Uint8Array(1 << 16);
  const config = new Uint8Array(8);
  config[6] = 1;
  const given = { n: 0 };
  const ctx = {
    ram: () => [ram], complete: () => { given.n++; }, features: () => 1n, config: () => config, io: new Float64Array(2),
    changeConfig: (w: (c: Uint8Array) => void) => w(config),
  } as unknown as Ctx;
  return { ram, ctx, given };
}
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

test('net: a card on a frame port of its own (a MessagePort adapter) sends the guest\'s frames to it', async () => {
  const { ram, ctx } = card();
  const port = new MessageChannel();
  const got: number[] = [];
  port.port1.onmessage = (e) => got.push((e.data as ArrayBuffer).byteLength);
  const n = net(ctx, { type: 'net', adapter: port.port2 });
  try {
    ram.fill(0, 0, 12);
    ram.fill(7, 12, 12 + 100);
    n.request({ w0: 1, queue: 1, read: [{ off: 0, len: 12 + 100, mem: 0 }], write: [] });
    for (let k = 0; k < 100 && !got.length; k++) await tick(10);
    assert.deepEqual(got, [100]);
  } finally {
    n.close?.();
    port.port1.close();
  }
});

test("net: on the helper's frames, the page's gateway says nothing to the guest (a lease it still had, its advertisements)", async () => {
  const { ctx, given } = card();
  const ip = new MessageChannel();
  const n = net(ctx, { type: 'net', adapter: { ip: ip.port2 } });
  const frames = new MessageChannel();
  try {
    for (let k = 0; k < 4; k++) n.request({ w0: 100 + k, queue: 0, read: [], write: [{ off: 4096 * (k + 1), len: 2048, mem: 0 }] });
    ip.port1.postMessage({ type: 'frames', port: frames.port2 }, [frames.port2]);
    await tick(50);
    // A lease after the switch (a previous client's, late): the gateway would advertise itself as the IPv6 router.
    ip.port1.postMessage({ type: 'lease', lease: { address: [100, 64, 0, 2], address6: [0xfd, 0x7a, 0x11, 0x5c, 0xa1, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2], mtu: 1280, dns: [], domains: [] } });
    await tick(100);
    assert.equal(given.n, 0, "the gateway's frames reached the guest");
  } finally {
    n.close?.();
    for (const p of [ip.port1, frames.port1]) p.close();
  }
});

test("net: the page's link flaps the card on asking (a restored guest whose agent couldn't renew its lease: web/app/areas/lease-actions.ts), under a driver only", { timeout: FLAP_MS + 5000 }, async () => {
  const config = new Uint8Array(8);
  config[6] = 1;
  const links: number[] = [];
  let features = 0n;
  const ctx = {
    ram: () => [new Uint8Array(4096)], complete: () => {}, features: () => features, config: () => config, io: new Float64Array(2),
    changeConfig: (w: (c: Uint8Array) => void) => { w(config); links.push(config[6]); },
  } as unknown as Ctx;
  const ip = new MessageChannel();
  const link = new MessageChannel();
  const n = net(ctx, { type: 'net', adapter: { ip: ip.port2, link: link.port2 } });
  try {
    link.port1.postMessage({ type: 'flap' });
    await tick(100);
    assert.deepEqual(links, [], 'no driver: nothing');
    features = 1n;
    link.port1.postMessage({ type: 'flap' });
    link.port1.postMessage({ type: 'flap' }); // one flap at a time
    await tick(100);
    assert.deepEqual(links, [0], 'down');
    await tick(FLAP_MS + 100);
    assert.deepEqual(links, [0, 1], 'up FLAP_MS later');
  } finally {
    n.close?.();
    ip.port1.close();
    link.port1.close();
  }
});

test("net: a restored card holds its switch's flap until the page settled the leases: dropped when renewed, done when not", { timeout: 2 * FLAP_MS + 10_000 }, async () => {
  const make = () => {
    const config = new Uint8Array(8);
    config[6] = 1;
    const links: number[] = [];
    const ctx = {
      ram: () => [new Uint8Array(4096)], complete: () => {}, features: () => 1n, config: () => config, io: new Float64Array(2),
      changeConfig: (w: (c: Uint8Array) => void) => { w(config); links.push(config[6]); },
    } as unknown as Ctx;
    const ip = new MessageChannel();
    const link = new MessageChannel();
    const n = net(ctx, { type: 'net', adapter: { ip: ip.port2, link: link.port2 } });
    n.restored?.();
    /** The client takes the card onto its frames (a template made offline, restored onto the local helper or the demo network). */
    const toFrames = () => {
      const f = new MessageChannel();
      f.port1.close();
      ip.port1.postMessage({ type: 'frames', port: f.port2 }, [f.port2]);
    };
    return { n, links, link: link.port1, toFrames, toGateway: () => ip.port1.postMessage({ type: 'gateway' }), close: () => { n.close?.(); ip.port1.close(); link.port1.close(); } };
  };
  const renewed = make();
  const flapped = make();
  const asked = make();
  try {
    for (const x of [renewed, flapped, asked]) x.toFrames();
    await tick(100);
    for (const x of [renewed, flapped, asked]) assert.deepEqual(x.links, [], 'held: the link stays up under the agent\'s LEASE');
    renewed.link.postMessage({ type: 'settled', renewed: true });
    flapped.link.postMessage({ type: 'settled', renewed: false });
    asked.link.postMessage({ type: 'flap' });
    await tick(100);
    assert.deepEqual(renewed.links, [], 'renewed by the agent: what was held dropped');
    assert.deepEqual(flapped.links, [0], 'not renewed: the held flap now');
    assert.deepEqual(asked.links, [0], 'a flap asked for: one');
    await tick(FLAP_MS + 100);
    assert.deepEqual([flapped.links, asked.links], [[0, 1], [0, 1]]);
    renewed.toGateway(); // settled: a later switch flaps as ever
    await tick(100);
    assert.deepEqual(renewed.links, [0]);
  } finally {
    for (const x of [renewed, flapped, asked]) x.close();
  }
});
