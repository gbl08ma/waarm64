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

test('the lease comes from what the client reports: its first IPv4 address, IPv4 resolvers only, no range assumed', async () => {
  const { leaseFrom } = await import('../web/tailscale.ts');
  const nm = { name: 'guest.tail.test.', addresses: ['fd7a:115c:a1e0::3/128', '172.16.9.4/32'], peers: [], mtu: 1280, dns: ['100.100.100.100', 'https://dns.example/dns-query', '9.9.9.9', '2620:fe::fe'], domains: ['tail.test'], exitNode: '' };
  assert.deepEqual(leaseFrom(nm), { address: [172, 16, 9, 4], mtu: 1280, dns: [[100, 100, 100, 100], [9, 9, 9, 9]], domains: ['tail.test'] });
  assert.deepEqual(leaseFrom({ ...nm, dns: null, domains: null })?.dns, []);
  assert.equal(leaseFrom({ ...nm, addresses: ['fd7a:115c:a1e0::3/128'] }), null, 'no IPv4 address, no lease');
});
