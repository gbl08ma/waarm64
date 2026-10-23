// The IPv6 reach prober (web/reach6.ts, docs/network-adapters.md §4 "IPv6 out"): its probes, the answers it takes from
// the guest's packets, when it counts IPv6 as out and back, and the lease it makes then. On mocked timers.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { parse6, PROBE_TARGETS, reach6, unreached6, type Reach6Options } from '../web/reach6.ts';
import { sum6, udp6 } from '../web/ip6.ts';
import { ECHO_LEASE, TAILCAT_ROUTES } from '../web/gateway.ts';

const SRC = parse6('fd7a:115c:a1e0::1234')!;
const CF = parse6('2606:4700:4700::1111')!;

test('parse6', () => {
  assert.deepEqual(parse6('2606:4700:4700::1111'), [0x26, 6, 0x47, 0, 0x47, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x11, 0x11]);
  assert.deepEqual(parse6('::1'), [...Array(15).fill(0), 1]);
  assert.deepEqual(parse6('::'), Array(16).fill(0));
  assert.deepEqual(parse6('64:ff9b::7f00:1'), [0, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0, 0x7f, 0, 0, 1]);
  assert.deepEqual(parse6('1:2:3:4:5:6:7:8'), [0, 1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 0, 7, 0, 8]);
  for (const bad of ['1:2:3', '1::2::3', '1:2:3:4:5:6:7:8::', '1:2:3:4:5:6:7:8:9', 'g::1', '12345::1', '1.2.3.4']) assert.equal(parse6(bad), undefined, bad);
});

test('unreached6: the address stays, routed through the network only, with no IPv6 resolvers', () => {
  const l = unreached6(ECHO_LEASE, TAILCAT_ROUTES.v6)!;
  assert.deepEqual(l.address6, ECHO_LEASE.address6);
  assert.deepEqual(l.dns6, []);
  assert.deepEqual(l.routes, { v6: TAILCAT_ROUTES.v6 }, 'IPv4 keeps its default (no v4 routes)');
  const routed = unreached6({ ...ECHO_LEASE, routes: TAILCAT_ROUTES }, [])!;
  assert.deepEqual(routed.routes, TAILCAT_ROUTES, "a non-primary's routes stay");
  assert.equal(unreached6(null, []), null);
  const v4only = { ...ECHO_LEASE, address6: undefined };
  assert.equal(unreached6(v4only, []), v4only);
});

/** A prober on mocked timers (one resolver, unless `o` says otherwise), the probes it sent, the changes it reported, and an answer to its last probe. */
function rig(o: Reach6Options = { to: ['2606:4700:4700::1111'] }) {
  const sent: Uint8Array[] = [];
  const changes: boolean[] = [];
  const r = reach6((p) => sent.push(p), (ok) => changes.push(ok), o);
  const answer = (p = sent.at(-1)!, flags = 0x81) => {
    const u = p.subarray(40);
    const dns = new Uint8Array(u.subarray(8));
    dns[2] = flags;
    return udp6(p.subarray(24, 40), p.subarray(8, 24), (u[2] << 8) | u[3], (u[0] << 8) | u[1], dns);
  };
  return { r, sent, changes, answer };
}

test('a probe: a DNS query from the guest\'s address to each resolver, sent after start returns; any answer counts', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { r, sent, changes, answer } = rig({});
  r.start(SRC);
  assert.equal(sent.length, 0, 'not inside start (it may run in the backend\'s own event)');
  t.mock.timers.tick(0);
  assert.deepEqual(sent.map((p) => [...p.subarray(24, 40)]), PROBE_TARGETS.map(parse6), 'three operators\' resolvers at once');
  assert.ok(sent.every((p) => p[48] === sent[0][48] && p[49] === sent[0][49] && p[40] === sent[0][40] && p[41] === sent[0][41]), 'one query ID, one source port');
  const stranger = answer(sent[1]);
  stranger.set(parse6('2001:db8::1')!, 8);
  assert.equal(r.take(stranger), false, 'not from a resolver asked: the guest\'s');
  assert.equal(r.take(answer(sent[1])), true, 'Google answers, Cloudflare doesn\'t (blocked)');
  assert.equal(r.reached(), true);
  assert.deepEqual(changes, [true]);
  r.stop();
});

test('a probe\'s bytes', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { r, sent } = rig();
  r.start(SRC);
  t.mock.timers.tick(0);
  assert.equal(sent.length, 1);
  const p = sent[0];
  assert.equal(p[0] >> 4, 6);
  assert.equal(p[6], 17, 'UDP');
  assert.deepEqual([...p.subarray(8, 24)], SRC);
  assert.deepEqual([...p.subarray(24, 40)], CF);
  const sport = (p[40] << 8) | p[41];
  assert.ok(sport >= 61000 && sport <= 65535, `above Linux's ephemeral range: ${sport}`);
  assert.equal((p[42] << 8) | p[43], 53);
  assert.equal(sum6(p.subarray(8, 24), p.subarray(24, 40), 17, p.subarray(40)), 0, 'the UDP checksum');
  assert.deepEqual([...p.subarray(50)], [1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 1], 'RD, one question: the root, NS, IN');
  r.stop();
});

test('an answer: reached, taken from the guest\'s packets; the next probe a minute later', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { r, sent, changes, answer } = rig();
  r.start(SRC);
  t.mock.timers.tick(0);
  assert.equal(r.reached(), false, 'not before the first answer');
  const other = udp6(CF, SRC, 53, 40000, new Uint8Array(12));
  assert.equal(r.take(other), false, "the guest's own DNS goes to the guest");
  assert.equal(r.take(answer(sent[0], 0x01)), true, 'a query (QR clear) on our port is ours, but no answer');
  assert.equal(r.reached(), false);
  assert.equal(r.take(answer()), true);
  assert.equal(r.reached(), true);
  assert.deepEqual(changes, [true]);
  assert.equal(r.take(answer()), true, 'a repeated answer is still taken');
  assert.deepEqual(changes, [true], 'and changes nothing');
  t.mock.timers.tick(59_999);
  assert.equal(sent.length, 1);
  t.mock.timers.tick(1);
  assert.equal(sent.length, 2);
  r.stop();
});

test('IPv6 counts as out after three lost probes in a row, and comes back with one answer', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { r, sent, changes, answer } = rig();
  r.start(SRC);
  t.mock.timers.tick(0);
  r.take(answer());
  t.mock.timers.tick(60_000); // the next probe, lost
  assert.equal(sent.length, 2);
  t.mock.timers.tick(3000); // lost: sent again at once
  t.mock.timers.tick(0);
  assert.equal(sent.length, 3);
  assert.equal(r.reached(), true, 'one lost probe is no change');
  t.mock.timers.tick(3000);
  t.mock.timers.tick(0);
  assert.equal(sent.length, 4);
  t.mock.timers.tick(3000);
  assert.equal(r.reached(), false, 'the third');
  assert.deepEqual(changes, [true, false]);
  t.mock.timers.tick(59_999);
  assert.equal(sent.length, 4, 'then every minute');
  t.mock.timers.tick(1);
  assert.equal(sent.length, 5);
  r.take(answer());
  assert.deepEqual(changes, [true, false, true]);
  r.stop();
});

test('probe(): at once (the browser\'s network changed); start() with the same source changes nothing; stop() ends the probes', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { r, sent, answer } = rig({ to: ['64:ff9b::7f00:1'], port: 5353, everyMs: 10_000 });
  r.probe();
  t.mock.timers.tick(0);
  assert.equal(sent.length, 0, 'nothing before start');
  r.start(SRC);
  t.mock.timers.tick(0);
  assert.deepEqual([...sent[0].subarray(24, 40)], parse6('64:ff9b::7f00:1'));
  assert.equal((sent[0][42] << 8) | sent[0][43], 5353);
  r.take(answer());
  r.start([...SRC]);
  t.mock.timers.tick(0);
  assert.equal(sent.length, 1, 'the same source again: nothing (a tailnet sends its netmap often)');
  r.probe();
  t.mock.timers.tick(0);
  assert.equal(sent.length, 2, 'at once, not after everyMs');
  r.stop();
  t.mock.timers.tick(100_000);
  assert.equal(sent.length, 2);
  assert.equal(r.reached(), true, 'kept for the next start');
  assert.equal(r.take(answer()), false, 'stopped: nothing is the prober\'s');
});
