// The tailnet workers' IP port (web/ts-port.ts): the lease told once per change (each one the gateway hears makes a
// router advertisement), again to a new port, withdrawn at a detach; the guest's packets to the client.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Lease } from '../web/gateway.ts';
import { ipPortHost, type Placement } from '../web/ts-port.ts';

const lease: Lease = { address: [100, 64, 0, 1], mtu: 1280, dns: [], domains: [] };

/** A port's far end: the messages it got (the leases), and the end to post the guest's packets from. */
function channel() {
  const mc = new MessageChannel();
  const got: unknown[] = [];
  mc.port2.onmessage = (e: MessageEvent) => got.push(e.data);
  return { port: mc.port1, far: mc.port2, got };
}
const settle = () => new Promise((r) => setTimeout(r, 20));

test('the lease is posted when it changes, to a new port at once, and withdrawn at a detach', async () => {
  let current: Lease | null = null;
  const places: Placement[] = [];
  const host = ipPortHost(
    (p) => {
      places.push({ ...p });
      return current && { ...current, ...(p.primary ? {} : { routes: { v4: [], v6: [] } }) };
    },
    () => {},
  );
  const a = channel();
  host.attach(a.port);
  current = lease;
  host.postLease();
  host.postLease(); // the same lease: none
  host.place({ primary: true }); // the same place: none
  host.place({ primary: false, rank: 2 });
  await settle();
  assert.deepEqual(
    a.got,
    [null, lease, { ...lease, routes: { v4: [], v6: [] } }].map((l) => ({ type: 'lease', lease: l })),
    'none at the attach, the lease, the lease as not primary: each once',
  );
  assert.deepEqual(places.at(-1), { primary: false, primary6: false, rank: 2 });

  const b = channel();
  host.attach(b.port);
  await settle();
  assert.equal(b.got.length, 1, 'a new port hears the lease, unchanged as it is');
  const back = host.detach();
  assert.equal(back, b.port);
  assert.equal(host.attached(), false);
  await settle();
  assert.deepEqual(b.got.at(-1), { type: 'lease', lease: null });
  for (const c of [a, b]) {
    c.port.close();
    c.far.close();
  }
});

test("the guest's packets reach the client; the client's reach the port", async () => {
  const heard: number[][] = [];
  const host = ipPortHost(
    () => null,
    (packets) => heard.push(...packets.map((p) => [...p])),
  );
  const c = channel();
  host.attach(c.port);
  c.far.postMessage([new Uint8Array([1, 2]).buffer, new Uint8Array([3]).buffer]);
  host.send(new Uint8Array([9]));
  await settle();
  assert.deepEqual(heard, [[1, 2], [3]]);
  assert.ok(c.got.some((m) => m instanceof ArrayBuffer && m.byteLength === 15 && new Uint8Array(m)[14] === 9), "the client's packet after the gateway's headroom");
  host.detach();
  c.port.close();
  c.far.close();
});
