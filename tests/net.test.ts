// The frame and IP-packet ports of web/net.ts (docs/devices.md "net").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { batchSender, ipPort, packetsOf, portAdapter } from '../web/net.ts';

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

for (const [name, make] of [['frame', portAdapter], ['IP packet', ipPort]] as const) {
  test(`the ${name} port takes a batch: an array of ArrayBuffers is its frames, in order, beside bare ones`, async () => {
    const { port1, port2 } = new MessageChannel();
    const got: number[][] = [];
    let done!: () => void;
    const all = new Promise<void>((r) => (done = r));
    const a = make(port1, (f) => { got.push([...f]); if (got.length === 4) done(); });
    const batch = [new Uint8Array([1]).buffer, new Uint8Array([2, 3]).buffer, new Uint8Array([4]).buffer];
    port2.postMessage(batch, batch);
    port2.postMessage(new Uint8Array([5]).buffer);
    port2.postMessage({ type: 'other' }); // not frames: ignored
    await all;
    assert.deepEqual(got, [[1], [2, 3], [4], [5]]);
    a.close!();
    port2.close();
  });
}

test('an IP port batch: what one task sends is one message, a single packet stays a bare ArrayBuffer, and both read back', async () => {
  const { port1, port2 } = new MessageChannel();
  const messages: unknown[] = [];
  let wake!: () => void;
  port2.onmessage = (e) => { messages.push(e.data); if (messages.length === 2) wake(); };
  const two = new Promise<void>((r) => (wake = r));
  const send = batchSender(port1);
  send(new Uint8Array([1]));
  send(new Uint8Array([9, 2, 3]).subarray(1)); // a view: only its bytes cross
  send(new Uint8Array([4]));
  await new Promise((r) => setTimeout(r, 0)); // the next task: a message of its own
  send(new Uint8Array([5]));
  await two;
  assert.ok(Array.isArray(messages[0]) && messages[0].length === 3, 'the first task\'s three packets in one message');
  assert.ok(messages[1] instanceof ArrayBuffer, 'one packet alone is a bare ArrayBuffer');
  assert.deepEqual(messages.map((m) => packetsOf(m)?.map((p) => [...p])), [[[1], [2, 3], [4]], [[5]]]);
  assert.equal(packetsOf({ type: 'lease', lease: null }), undefined);
  assert.equal(packetsOf([]), undefined);
  port1.close();
  port2.close();
});

test('the lease comes from what the client reports: its first IPv4 and IPv6 address, IP resolvers only, no range assumed', async () => {
  const { leaseFrom } = await import('../web/tailscale.ts');
  const nm = { name: 'guest.tail.test.', addresses: ['fd7a:115c:a1e0::3/128', '172.16.9.4/32'], peers: [], mtu: 1280, dns: ['100.100.100.100', 'fd7a:115c:a1e0::53', 'https://dns.example/dns-query', '9.9.9.9', '2620:fe::fe'], domains: ['tail.test'], exitNode: '' };
  const b = (...groups: number[]) => groups.flatMap((g) => [g >> 8, g & 255]);
  assert.deepEqual(leaseFrom(nm), {
    address: [172, 16, 9, 4],
    address6: b(0xfd7a, 0x115c, 0xa1e0, 0, 0, 0, 0, 3),
    dns6: [b(0xfd7a, 0x115c, 0xa1e0, 0, 0, 0, 0, 0x53), b(0x2620, 0xfe, 0, 0, 0, 0, 0, 0xfe)],
    mtu: 1280,
    dns: [[100, 100, 100, 100], [9, 9, 9, 9]],
    domains: ['tail.test'],
  });
  assert.deepEqual(leaseFrom({ ...nm, dns: null, domains: null })?.dns, []);
  assert.equal(leaseFrom({ ...nm, addresses: ['172.16.9.4/32'] })?.address6, undefined, 'no IPv6 address, none leased');
  assert.deepEqual(leaseFrom({ ...nm, addresses: ['1:2:3:4:5:6:7:8/128', '10.0.0.1/32'] })?.address6, b(1, 2, 3, 4, 5, 6, 7, 8));
  assert.deepEqual(leaseFrom({ ...nm, addresses: ['::1/128', '10.0.0.1/32'] })?.address6, b(0, 0, 0, 0, 0, 0, 0, 1));
  assert.equal(leaseFrom({ ...nm, addresses: ['fd7a:::3/128', '10.0.0.1/32'] })?.address6, undefined, 'malformed');
  assert.equal(leaseFrom({ ...nm, addresses: ['fd7a:115c:a1e0::3/128'] }), null, 'no IPv4 address, no lease');
});

test('the subnets peers route, when installed: what a lease that isn\'t the default way out routes besides the tailnet', async () => {
  const { subnetsOf } = await import('../web/tailscale.ts');
  const peers = [
    { id: 'a', name: 'a.', addresses: [], exitNodeOption: false, routes: ['192.168.1.0/24', 'fd00:1::/64'] },
    { id: 'b', name: 'b.', addresses: [], exitNodeOption: true },
  ];
  const nm = { name: 'g.', addresses: ['100.90.0.2/32'], peers, mtu: 1280, dns: [], domains: [], exitNode: '', acceptRoutes: true };
  assert.deepEqual(subnetsOf(nm), { v4: [[[192, 168, 1, 0], 24]], v6: [[[0xfd, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 64]] });
  assert.deepEqual(subnetsOf({ ...nm, acceptRoutes: false }), { v4: [], v6: [] }, 'not installed');
  assert.deepEqual(subnetsOf(undefined), { v4: [], v6: [] });
});
