// The demo network's client (web/demo-net.ts; docs/networking/demo-network.md) against a fake server in Node: its
// socket, timers and randomness are the test's (`DemoEnv`), so each close code's rule is checked by the clock. The
// frames held until `hello` and sent then; the control messages kept as the status and passed on as the message bar's
// notices; 4012 reconnecting only at the guest's next frame; 4008/4011/4013 after `reconnect_after` and the random
// delay; 4009 and an unreachable server backing off; a dropped socket said once; 4010 waiting for the budget's reset;
// the closes for good (4001, 4003, 1002, a malformed message); `budget?` asked while traffic moves the budget; and
// the page's words for all of it (web/app/demo-view.ts, from the catalog).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEMO_SUBPROTOCOL, DEMO_URL, demoNetmap, HEALTHY_MS, parseDemoURL, startDemoNet, type DemoEnv, type DemoNotice, type FramePort, type SocketLike } from '../web/demo-net.ts';
import { frameMessage, framesOf } from '../web/local-net.ts';
import { demoNotice, refusalText } from '../web/app/demo-view.ts';
import { viewOf } from '../web/app/network-view.ts';
import { t } from '../web/i18n.ts';
import { msgOf } from '../web/msg.ts';

const T0 = Date.parse('2026-11-19T12:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');

/** A socket the test plays the server for. */
class FakeSocket implements SocketLike {
  binaryType = '';
  readyState = 0;
  protocol = '';
  sent: (string | Uint8Array)[] = [];
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  readonly url: string;
  readonly offered: string;
  constructor(url: string, offered: string) { [this.url, this.offered] = [url, offered]; }
  send(d: string | Uint8Array) { this.sent.push(typeof d === 'string' ? d : d.slice()); }
  close(code = 1000) { if (this.readyState < 2) this.end(code === 1000 ? 1005 : code); }
  // The server's side.
  accept(protocol = DEMO_SUBPROTOCOL) { this.protocol = protocol; this.readyState = 1; this.onopen?.({}); }
  text(m: object) { this.onmessage?.({ data: JSON.stringify(m) }); }
  hello(over: object = {}) { this.text({ type: 'hello', version: 1, gateway: '192.168.127.1', status: 'http://192.168.127.1/status', lane: 'fast', slow_lane: false, limits: {}, ...over }); }
  frames(fs: Uint8Array[]) { this.onmessage?.({ data: frameMessage(fs).buffer }); }
  end(code: number, reason = '') { this.readyState = 3; this.onclose?.({ code, reason }); }
  /** The control messages the page sent, and the frames in its binary ones. */
  texts() { return this.sent.filter((s): s is string => typeof s === 'string').map((s) => JSON.parse(s) as { type: string }); }
  framesSent() { return this.sent.filter((s): s is Uint8Array => typeof s !== 'string').flatMap((m) => framesOf(m) ?? []); }
}

/** The client on a fake clock: `advance` runs the timers due. */
function harness(random = () => 0.5) {
  let now = T0;
  let seq = 0;
  const timers = new Map<number, { at: number; f: () => void }>();
  const sockets: FakeSocket[] = [];
  const notices: DemoNotice[] = [];
  const toGuest: Uint8Array[] = [];
  let changes = 0;
  const env: DemoEnv = {
    socket: (url, p) => { const s = new FakeSocket(url, p); sockets.push(s); return s; },
    setTimeout: (f, ms) => { timers.set(++seq, { at: now + ms, f }); return seq; },
    clearTimeout: (id) => { timers.delete(id as number); },
    now: () => now,
    random,
  };
  const port: FramePort = { onmessage: null, postMessage: (d) => { toGuest.push(new Uint8Array(d)); } };
  const net = startDemoNet('wss://demo.test/', port, { change: () => { changes++; }, notice: (n) => notices.push(n) }, env);
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = [...timers].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      timers.delete(due[0]);
      now = Math.max(now, due[1].at);
      due[1].f();
    }
    now = end;
  };
  /** The guest sends frame `f` (one Ethernet frame per message, as the card's port has it). */
  const guest = (f: Uint8Array) => port.onmessage?.({ data: f.slice().buffer } as MessageEvent);
  const last = () => sockets.at(-1)!;
  const nextAt = () => Math.min(...[...timers.values()].map((x) => x.at));
  return { net, env, sockets, notices, toGuest, guest, advance, last, nextAt, port, now: () => now, changes: () => changes, timers };
}

/** An Ethernet frame from the guest's MAC, `n` bytes long, tagged by `tag`. */
const frame = (tag: number, n = 60) => {
  const f = new Uint8Array(n);
  f.set([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x52, 0x54, 0, 0x12, 0x34, 0x56, 8, 0]);
  f[20] = tag;
  return f;
};

test('the server URL: wss:// anywhere, ws:// on this computer only, empty for the default', () => {
  assert.deepEqual(parseDemoURL(''), { url: DEMO_URL });
  assert.deepEqual(parseDemoURL('demonet.example.org'), { url: 'wss://demonet.example.org/' }); // i18n-ignore
  assert.deepEqual(parseDemoURL('wss://demonet.example.org/x'), { url: 'wss://demonet.example.org/x' });
  assert.deepEqual(parseDemoURL('ws://127.0.0.1:8741'), { url: 'ws://127.0.0.1:8741/' });
  assert.equal((parseDemoURL('ws://demonet.example.org/') as { error: { key: string } }).error.key, 'network:demo-net.notWss');
  assert.equal((parseDemoURL('https://demonet.example.org/') as { error: { key: string } }).error.key, 'network:demo-net.notWss');
  assert.equal((parseDemoURL('wss://exa mple') as { error: { key: string } }).error.key, 'network:demo-net.notURL');
});

test('connecting: the subprotocol offered, frames held until the hello and sent then, the server\'s frames to the guest', () => {
  const h = harness();
  const s = h.last();
  assert.equal(s.offered, DEMO_SUBPROTOCOL);
  assert.equal(s.url, 'wss://demo.test/');
  assert.equal(h.net.state(), 'connecting');
  h.guest(frame(1));
  s.accept();
  h.guest(frame(2));
  assert.equal(s.sent.length, 0, 'nothing before the hello');
  s.hello();
  assert.equal(h.net.state(), 'connected');
  const st = h.net.status();
  assert.deepEqual([st.lane, st.gateway, st.status, st.again], ['fast', '192.168.127.1', 'http://192.168.127.1/status', false]);
  h.guest(frame(3));
  h.advance(0);
  assert.deepEqual(s.framesSent().map((f) => f[20]), [1, 2, 3], 'the held frames first, in order, then the new');
  assert.equal(s.sent.filter((m) => typeof m !== 'string').length, 1, 'in one message (one timer turn)');
  s.frames([frame(9), frame(10)]);
  assert.deepEqual(h.toGuest.map((f) => f[20]), [9, 10]);
  assert.equal(h.net.stats().rxFrames, 2);
  // The holding is bounded: past it a link drops frames, as a link would.
  const h2 = harness();
  for (let k = 0; k < 400; k++) h2.guest(frame(k & 255, 1000));
  h2.last().accept();
  h2.last().hello();
  h2.advance(0);
  assert.equal(h2.last().framesSent().length, 262, 'at most 256 KiB held');
});

test('control messages: the budget, its thresholds, the lane, refusals, a restart announced and withdrawn; unknown ones ignored', () => {
  const h = harness();
  const s = h.last();
  s.accept();
  s.hello();
  const resets = '2026-11-20T00:00:00Z';
  s.text({ type: 'budget', reason: 'start', fast: { used: 1000, limit: 500_000_000, resets }, slow: null });
  assert.deepEqual(h.net.status().budget, { used: 1000, limit: 500_000_000, resets });
  assert.equal(h.notices.length, 0, 'the start is no notice');
  s.text({ type: 'budget', reason: 'threshold', threshold: 80, fast: { used: 400_000_001, limit: 500_000_000, resets }, slow: null });
  assert.deepEqual(h.notices.at(-1), { kind: 'budget', threshold: 80, used: 400_000_001, limit: 500_000_000, resets });
  s.text({ type: 'refused', count: 1, total: 6, last: [{ reason: 'not-listed', name: 'a.example' }, { reason: 'not-listed', name: 'pypi.org' }, { reason: 'address', address: '1.1.1.1', port: 443 }, { reason: 'port', name: 'dl-cdn.alpinelinux.org', port: 80 }, { reason: 'quic', address: '8.8.8.8', port: 443 }] });
  const r = h.net.status().refused!;
  assert.equal(r.total, 6);
  assert.deepEqual(r.last.map((x) => x.name ?? x.address), ['pypi.org', '1.1.1.1', 'dl-cdn.alpinelinux.org', '8.8.8.8'], 'the last four');
  s.text({ type: 'lane', lane: 'none', reason: 'bytes', resets });
  assert.deepEqual([h.net.status().lane, h.net.status().laneResets], ['none', resets]);
  assert.deepEqual(h.notices.at(-1), { kind: 'lane', lane: 'none', resets });
  s.text({ type: 'lane', lane: 'none', reason: 'bytes', resets });
  assert.equal(h.notices.length, 2, 'the same lane again: no notice');
  s.text({ type: 'lane', lane: 'fast' });
  assert.deepEqual([h.net.status().lane, h.net.status().laneResets, h.notices.at(-1)], ['fast', undefined, { kind: 'lane', lane: 'fast' }]);
  s.text({ type: 'notice', notice: 'restart-at', at: '2026-11-20T03:00:00Z', back_at: '2026-11-20T03:05:00Z' });
  assert.deepEqual(h.net.status().notice, { at: '2026-11-20T03:00:00Z', backAt: '2026-11-20T03:05:00Z' });
  assert.deepEqual(h.notices.at(-1), { kind: 'restart', at: '2026-11-20T03:00:00Z', backAt: '2026-11-20T03:05:00Z' });
  const n = h.notices.length;
  s.text({ type: 'notice', notice: 'restart-at', at: '2026-11-20T03:00:00Z', back_at: '2026-11-20T03:05:00Z' });
  assert.equal(h.notices.length, n, 'the same notice again (after a reconnect\'s hello): said once');
  s.text({ type: 'notice', notice: 'none' });
  assert.equal(h.net.status().notice, undefined);
  // Unknown types, fields and notices; text that isn't JSON: ignored, the socket kept.
  s.text({ type: 'later', x: 1 });
  s.text({ type: 'notice', notice: 'something-new', at: '2026-11-20T03:00:00Z' });
  s.onmessage?.({ data: 'not json' });
  assert.equal(h.net.state(), 'connected');
  assert.equal(h.sockets.length, 1);
});

test('4012 idle: no reconnect until the guest sends; then a new socket, its frame held for the hello', () => {
  const h = harness();
  h.last().accept();
  h.last().hello();
  h.last().text({ type: 'closing', code: 4012, reason: 'idle', limit: 600 });
  h.last().end(4012, 'idle');
  assert.equal(h.net.state(), 'idle');
  h.advance(3_600_000);
  assert.equal(h.sockets.length, 1, 'an idle guest holds no network');
  h.guest(frame(7));
  assert.equal(h.sockets.length, 2);
  assert.equal(h.net.state(), 'connecting');
  h.last().accept();
  h.last().hello();
  h.advance(0);
  assert.deepEqual(h.last().framesSent().map((f) => f[20]), [7], 'the waking frame went on the new network');
  assert.equal(h.net.status().again, true);
});

test('4011, 4013, 4008 with reconnect_after: after it and a random delay of up to 30 s', () => {
  for (const [code, reason, why] of [[4011, 'maintenance', 'maintenance'], [4013, 'session', 'session'], [4008, 'connections', 'connections']] as const) {
    for (const r of [0, 1]) {
      const h = harness(() => r);
      h.last().accept();
      h.last().hello();
      const after = T0 + 120_000;
      h.last().text({ type: 'closing', code, reason, reconnect_after: iso(after) });
      h.last().end(code, reason);
      assert.equal(h.net.state(), 'waiting');
      assert.equal(h.net.status().wait?.why, why);
      assert.equal(h.net.status().wait?.at, after + 30_000 * r, `${code}: at reconnect_after + ${r * 30} s`);
      assert.equal(h.notices.length, 0, `${code} isn't a lost connection`);
      h.advance(after + 30_000 * r - T0 - 1);
      assert.equal(h.sockets.length, 1, 'not before');
      h.advance(1);
      assert.equal(h.sockets.length, 2, `${code}: then a new socket`);
    }
  }
});

test('4008 guests and site, 4009 full: at least 30 s; unreachable: backing off from 1 s, doubling, to 2 min; reset by a socket healthy a while', () => {
  for (const [code, reason, why] of [[4008, 'guests', 'guests'], [4008, 'site', 'site'], [4009, 'full', 'full']] as const) {
    const h = harness(() => 0);
    h.last().accept();
    h.last().text({ type: 'closing', code, reason, used: 2, limit: 2 });
    h.last().end(code, reason);
    assert.equal(h.net.status().wait?.why, why);
    assert.ok(h.nextAt() - T0 >= 30_000, `${code} ${reason}: ${h.nextAt() - T0} ms`);
  }
  const h = harness(() => 1);
  const delays: number[] = [];
  for (let k = 0; k < 10; k++) {
    const t = h.now();
    h.last().end(1006);
    assert.equal(h.net.status().wait?.why, 'unreachable');
    delays.push(h.nextAt() - t);
    h.advance(h.nextAt() - t);
  }
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 32000, 64000, 120000, 120000, 120000]);
  assert.equal(h.notices.length, 0, 'never connected: nothing lost');
  h.last().accept();
  h.last().hello();
  h.advance(HEALTHY_MS);
  h.last().end(1006);
  assert.deepEqual(h.notices, [{ kind: 'lost' }], 'a connected socket dropped: said once');
  assert.equal(h.net.status().wait?.why, 'lost');
  assert.equal(h.nextAt() - h.now(), 1000, 'the backoff starts over: the socket was healthy a while');
  const r = harness(() => 0);
  r.last().end(1006);
  assert.equal(r.nextAt() - T0, 500, 'the delay\'s second half is random');
});

// REVIEW.md (review/demo-page) #7.
test('a server that drops each socket right after its hello: the backoff grows, "lost" said once per outage, the status follows each try', () => {
  const h = harness(() => 1);
  const delays: number[] = [];
  for (let k = 0; k < 9; k++) {
    h.last().accept();
    h.last().hello();
    h.advance(100);
    const t = h.now();
    h.last().end(1006);
    const at = h.net.status().wait!.at; // not nextAt: the budget's asker runs beside it
    delays.push(at - t);
    const before = h.changes();
    h.advance(at - t);
    assert.equal(h.net.status().phase, 'connecting', 'the status says it tries again');
    assert.ok(h.changes() > before, 'told when it tries again');
  }
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 32000, 64000, 120000, 120000]);
  assert.deepEqual(h.notices, [{ kind: 'lost' }], 'one outage: one "lost"');
  // Healthy again for a while, then lost: a new outage, said again, and the backoff from the start.
  h.last().accept();
  h.last().hello();
  h.advance(HEALTHY_MS);
  h.last().end(1006);
  assert.deepEqual(h.notices, [{ kind: 'lost' }, { kind: 'lost' }]);
  assert.equal(h.net.status().wait!.at - h.now(), 1000);
});

test('4010: the budget spent, said, waited out until it resets', () => {
  const h = harness(() => 0);
  const resets = T0 + 3_600_000;
  h.last().accept();
  h.last().text({ type: 'closing', code: 4010, reason: 'bytes', used: 500_000_001, limit: 500_000_000, resets: iso(resets) });
  h.last().end(4010, 'bytes');
  assert.deepEqual(h.notices, [{ kind: 'spent', resets: iso(resets) }]);
  assert.deepEqual(h.net.status().wait, { why: 'bytes', at: resets, resets: iso(resets) });
  h.advance(3_600_000);
  assert.equal(h.sockets.length, 2);
  // Mid-run, after the lane's message: no second notice.
  const m = harness(() => 0);
  m.last().accept();
  m.last().hello();
  m.last().text({ type: 'lane', lane: 'none', reason: 'bytes', resets: iso(resets) });
  m.last().text({ type: 'closing', code: 4010, reason: 'bytes', resets: iso(resets) });
  m.last().end(4010, 'bytes');
  assert.deepEqual(m.notices.map((n) => n.kind), ['lane']);
  // The socket lost past the grace (the server's close never reached the page): its reconnect meets 4010, said again.
  const l = harness(() => 0);
  l.last().accept();
  l.last().hello();
  l.last().text({ type: 'lane', lane: 'none', reason: 'bytes', resets: iso(resets) });
  l.last().end(1006);
  l.advance(l.nextAt() - l.now());
  l.last().accept();
  l.last().text({ type: 'closing', code: 4010, reason: 'bytes', resets: iso(resets) });
  l.last().end(4010, 'bytes');
  assert.deepEqual(l.notices.map((n) => n.kind), ['lane', 'lost', 'spent'], 'not "trying again" until the reset');
  assert.equal(l.net.status().wait?.why, 'bytes');
});

test('closed for good: another version, another origin, a protocol error, a malformed message; and close()', () => {
  const cases: [string, (s: FakeSocket) => void][] = [
    ['network:demo-net.versions', (s) => { s.accept(); s.text({ type: 'closing', code: 4001, reason: 'version' }); s.end(4001, 'version'); }],
    ['network:demo-net.versions', (s) => s.accept('waarm64-net.v1')],
    ['network:demo-net.origin', (s) => { s.accept(); s.end(4003, 'origin'); }],
    ['network:demo-net.protocol', (s) => { s.accept(); s.hello(); s.end(1002); }],
    ['network:demo-net.protocol', (s) => { s.accept(); s.hello(); s.end(1009); }],
    ['network:demo-net.notFrames', (s) => { s.accept(); s.hello(); s.onmessage?.({ data: new Uint8Array([0, 0, 0, 99, 1]).buffer }); }],
  ];
  for (const [key, play] of cases) {
    const h = harness();
    play(h.last());
    assert.equal(h.net.state(), 'closed', key);
    assert.equal(msgOf(h.net.error())?.key, key);
    h.advance(3_600_000);
    assert.equal(h.sockets.length, 1, `${key}: no reconnect`);
    assert.equal(h.port.onmessage, null, 'the card let go');
  }
  const h = harness();
  h.last().accept();
  h.last().hello();
  h.net.close();
  assert.equal(h.last().readyState, 3);
  h.advance(3_600_000);
  assert.equal(h.sockets.length, 1);
  assert.equal(h.timers.size, 0, 'no timer left');
});

test('budget? while the guest\'s traffic moves the budget, not while it doesn\'t; a restarted machine keeps the socket', () => {
  const h = harness();
  const s = h.last();
  s.accept();
  s.hello();
  h.guest(frame(1));
  h.advance(60_000);
  assert.deepEqual(s.texts(), [{ type: 'budget?' }]);
  h.advance(60_000);
  assert.equal(s.texts().length, 1, 'no traffic since: not asked');
  s.frames([frame(2)]);
  h.advance(60_000);
  assert.equal(s.texts().length, 2);
  // A restart's new card port: the same socket.
  const got: number[] = [];
  h.net.setFrames({ onmessage: null, postMessage: (d) => { got.push(new Uint8Array(d)[20]); } });
  s.frames([frame(3)]);
  assert.deepEqual(got, [3]);
  assert.equal(h.sockets.length, 1);
});

test("the page's words: the status line, its details and the message bar's notices, from the catalog", () => {
  const view = (demo: Parameters<typeof demoNetmap>[1], state = 'Running', address?: string) => // i18n-ignore
    viewOf({ state, netmap: demoNetmap(address ? { address } : undefined, demo), demo: true });
  const c = view({ phase: 'connected', again: false, lane: 'fast', status: 'http://192.168.127.1/status' }, 'Running', '192.168.127.2'); // i18n-ignore
  assert.deepEqual([c.phase, c.text, c.address, c.internet, c.demo], ['connected', t('network:demo-view.connected.address', { address: '192.168.127.2' }), '192.168.127.2', true, { status: 'http://192.168.127.1/status', lane: 'fast' }]);
  assert.equal(view({ phase: 'connecting', again: false }, 'Connecting').text, t('network:demo-view.connecting')); // i18n-ignore
  assert.equal(view({ phase: 'connecting', again: true }, 'Connecting').phase, 'connecting'); // i18n-ignore
  assert.equal(view({ phase: 'idle', again: true }).phase, 'connected', 'idle stays connected: the guest keeps its address');
  const at = T0 + 90_000;
  const w = view({ phase: 'waiting', again: false, wait: { why: 'full', at } }, 'Connecting'); // i18n-ignore
  assert.deepEqual([w.phase, w.text, w.internet], ['connecting', t('network:demo-view.wait.full', { when: new Date(at) }), false]);
  const resets = '2026-11-20T00:00:00Z';
  assert.equal(view({ phase: 'waiting', again: false, wait: { why: 'bytes', at: at + 5, resets } }, 'Connecting').text, t('network:demo-view.wait.bytes', { when: new Date(resets) })); // i18n-ignore
  const spent = view({ phase: 'connected', again: false, lane: 'none', laneResets: resets, budget: { used: 600, limit: 500, resets }, refused: { total: 3, last: [{ reason: 'not-listed', name: 'pypi.org' }, { reason: 'address', address: '1.1.1.1', port: 443 }] }, notice: { at: resets } });
  assert.equal(spent.text, t('network:demo-view.spent', { when: new Date(resets) }));
  assert.deepEqual(spent.details, [
    t('network:demo-view.budget.resets', { used: 600, limit: 500, when: new Date(resets) }),
    t('network:demo-view.refused', { count: 3, names: [t('network:demo-view.refusal', { what: '1.1.1.1:443', why: t('network:demo-view.reason.address') }), t('network:demo-view.refusal', { what: 'pypi.org', why: t('network:demo-view.reason.notListed') })] }),
    t('network:demo-view.restart', { at: new Date(resets) }),
  ]);
  assert.match(spent.details![1], /^3 destinations refused.*1\.1\.1\.1:443 \(.*\), pypi\.org \(.*\)$/, 'newest first');
  assert.equal(demoNotice({ kind: 'budget', threshold: 80, used: 4, limit: 5, resets }).kind, 'info');
  assert.deepEqual(demoNotice({ kind: 'budget', threshold: 100, used: 5, limit: 5, resets }), { message: { key: 'network:demo-view.notice.spent', params: { when: new Date(resets) } }, kind: 'warn' });
  assert.equal(demoNotice({ kind: 'lane', lane: 'fast' }).message.key, 'network:demo-view.notice.back');
  assert.equal(demoNotice({ kind: 'restart', at: resets }).message.key, 'network:demo-view.notice.restart');
  assert.deepEqual(demoNotice({ kind: 'lost' }), { message: { key: 'network:demo-view.notice.lost' }, kind: 'warn' });
  for (const n of [demoNotice({ kind: 'spent' }), demoNotice({ kind: 'budget', threshold: 80, used: 1, limit: 2 })]) assert.doesNotMatch(t(n.message.key, n.message.params), /\{\{/);
  // An error closes it: "Couldn't connect", with the cause.
  const e = viewOf({ state: 'Connecting', error: new Error('x'), demo: true }); // i18n-ignore
  assert.equal(e.phase, 'error');
});

// The slow lane (PROTOCOL.md: off on the server by default; additive within v1): the lane `slow`, the slow lane's
// budget and its thresholds, `hello.limits.slow`, its refusals, and 4010's `lane: slow`.
test('the slow lane: hello.limits.slow kept, the lane `slow`, the slow budget and its thresholds, closing 4010 lane slow', () => {
  const h = harness(() => 0);
  const s = h.last();
  s.accept();
  const resets = '2026-11-20T00:00:00Z';
  s.hello({ slow_lane: true, limits: { guests: 2, slow: { rate: 40_000, connections: 2, bytes_per_day: 50_000_000, total_rate: 2_000_000, ports: [80, 443] } } });
  assert.deepEqual(h.net.status().slow, { rate: 40_000, connections: 2, bytesPerDay: 50_000_000, totalRate: 2_000_000, ports: [80, 443] });
  s.text({ type: 'budget', reason: 'start', fast: { used: 1, limit: 500, resets }, slow: { used: 2, limit: 50, resets } });
  assert.deepEqual([h.net.status().budget, h.net.status().slowBudget], [{ used: 1, limit: 500, resets }, { used: 2, limit: 50, resets }]);
  // The slow lane's 80 %: said as its own; its 100 % while the fast lane goes on: said (only hosts off the list are lost).
  s.text({ type: 'budget', reason: 'slow-threshold', threshold: 80, fast: { used: 1, limit: 500, resets }, slow: { used: 41, limit: 50, resets } });
  assert.deepEqual(h.notices.at(-1), { kind: 'budget', threshold: 80, used: 41, limit: 50, resets, lane: 'slow' });
  s.text({ type: 'budget', reason: 'slow-threshold', threshold: 100, fast: { used: 1, limit: 500, resets }, slow: { used: 50, limit: 50, resets } });
  assert.deepEqual(h.notices.at(-1), { kind: 'budget', threshold: 100, used: 50, limit: 50, resets, lane: 'slow' });
  // The fast budget spent with the slow lane on: the lane `slow`, slowed rather than stopped.
  s.text({ type: 'budget', reason: 'threshold', threshold: 100, fast: { used: 500, limit: 500, resets }, slow: { used: 10, limit: 50, resets } });
  assert.deepEqual(h.notices.at(-1), { kind: 'budget', threshold: 100, used: 500, limit: 500, resets, slowLane: true });
  s.text({ type: 'lane', lane: 'slow', reason: 'bytes', resets });
  assert.deepEqual([h.net.status().lane, h.net.status().laneResets], ['slow', resets]);
  assert.deepEqual(h.notices.at(-1), { kind: 'lane', lane: 'slow', resets });
  // In the lane `slow`, the slow budget's 100 % isn't said: the lane `none` that follows says it.
  const n = h.notices.length;
  s.text({ type: 'budget', reason: 'slow-threshold', threshold: 100, fast: { used: 500, limit: 500, resets }, slow: { used: 50, limit: 50, resets } });
  assert.equal(h.notices.length, n);
  s.text({ type: 'lane', lane: 'none', reason: 'bytes', resets });
  assert.deepEqual(h.notices.at(-1), { kind: 'lane', lane: 'none', resets });
  // Past the grace: 4010 with the slow lane's numbers.
  s.text({ type: 'closing', code: 4010, reason: 'bytes', lane: 'slow', used: 51, limit: 50, resets });
  s.end(4010, 'bytes');
  assert.deepEqual(h.net.status().slowBudget, { used: 51, limit: 50, resets });
  assert.deepEqual(h.net.status().wait, { why: 'bytes', at: Date.parse(resets), resets, lane: 'slow' });
  assert.equal(h.notices.at(-1)?.kind, 'lane', 'the lane `none` said it already');
  // A new socket refused at once for both budgets: said, with the lane.
  const r = harness(() => 0);
  r.last().accept();
  r.last().text({ type: 'closing', code: 4010, reason: 'bytes', lane: 'slow', used: 51, limit: 50, resets });
  r.last().end(4010, 'bytes');
  assert.deepEqual(r.notices, [{ kind: 'spent', resets, lane: 'slow' }]);
  // The slow lane off again (the owner's reload): its numbers go with the next hello and budget.
  const o = harness();
  o.last().accept();
  o.last().hello({ slow_lane: true, limits: { slow: { rate: 1, connections: 1, bytes_per_day: 1, ports: [443] } } });
  o.last().text({ type: 'budget', reason: 'start', fast: { used: 1, limit: 5 }, slow: { used: 0, limit: 1 } });
  o.last().text({ type: 'budget', reason: 'request', fast: { used: 1, limit: 5 }, slow: null });
  assert.equal(o.net.status().slowBudget, undefined);
  o.last().text({ type: 'closing', code: 4013, reason: 'session' });
  o.last().end(4013, 'session');
  o.advance(o.nextAt() - o.now());
  o.last().accept();
  o.last().hello();
  assert.deepEqual([o.net.status().slow, o.net.status().lane], [undefined, 'fast']);
});

test("the slow lane's words: the status line, the slow budget and the lane's terms, the refusals' reasons, the notices", () => {
  const view = (demo: Parameters<typeof demoNetmap>[1], state = 'Running') => viewOf({ state, netmap: demoNetmap({ address: '192.168.127.2' }, demo), demo: true }); // i18n-ignore
  const resets = '2026-11-20T00:00:00Z';
  const when = new Date(resets);
  const v = view({ phase: 'connected', again: false, lane: 'slow', laneResets: resets, budget: { used: 600, limit: 500, resets }, slowBudget: { used: 10, limit: 50, resets }, slow: { rate: 40_000, connections: 2, bytesPerDay: 50, ports: [80, 443] }, refused: { total: 3, last: [{ reason: 'slow-connections', name: 'github.com', port: 443 }, { reason: 'slow-spent', name: 'pypi.org' }, { reason: 'from-a-later-v1', address: '1.1.1.1', port: 53 }] } });
  assert.deepEqual([v.text, v.phase, v.internet, v.demo?.lane], [t('network:demo-view.slow', { when }), 'connected', true, 'slow']);
  assert.deepEqual(v.details, [
    t('network:demo-view.budget.resets', { used: 600, limit: 500, when }),
    t('network:demo-view.budget.slow', { used: 10, limit: 50 }),
    t('network:demo-view.slowLane', { rate: 40_000, count: 2, ports: ['80', '443'] }),
    t('network:demo-view.refused', { count: 3, names: ['1.1.1.1:53', t('network:demo-view.refusal', { what: 'pypi.org', why: t('network:demo-view.reason.slowSpent') }), t('network:demo-view.refusal', { what: 'github.com:443', why: t('network:demo-view.reason.slowConnections') })] }),
  ]);
  assert.match(v.details![2], /80, 443/);
  assert.match(v.details![3], /^3 destinations refused: 1\.1\.1\.1:53, pypi\.org \(.+\), github\.com:443 \(.+\)$/, 'an unknown reason: the destination alone');
  assert.equal(view({ phase: 'connected', again: false, slow: { rate: 1, connections: 1, bytesPerDay: 1, ports: [] } }).details?.[0], t('network:demo-view.slowLane.anyPort', { rate: 1, count: 1 }));
  assert.equal(view({ phase: 'waiting', again: false, wait: { why: 'bytes', at: 0, resets, lane: 'slow' } }, 'Connecting').text, t('network:demo-view.wait.bytes.slow', { when })); // i18n-ignore
  assert.equal(view({ phase: 'connected', again: false, lane: 'slow' }).text, t('network:demo-view.slow.noTime'));
  const key = (n: DemoNotice) => [demoNotice(n).message.key, demoNotice(n).kind];
  assert.deepEqual(key({ kind: 'lane', lane: 'slow', resets }), ['network:demo-view.notice.slowed', 'warn']);
  assert.deepEqual(key({ kind: 'budget', threshold: 100, used: 5, limit: 5, resets, slowLane: true }), ['network:demo-view.notice.slowed', 'warn']);
  assert.deepEqual(key({ kind: 'budget', threshold: 100, used: 5, limit: 5, resets }), ['network:demo-view.notice.spent', 'warn']);
  assert.deepEqual(key({ kind: 'budget', threshold: 80, used: 4, limit: 5, resets, lane: 'slow' }), ['network:demo-view.notice.slowBudget.resets', 'info']);
  assert.deepEqual(key({ kind: 'budget', threshold: 80, used: 4, limit: 5, lane: 'slow' }), ['network:demo-view.notice.slowBudget', 'info']);
  assert.deepEqual(key({ kind: 'budget', threshold: 100, used: 5, limit: 5, resets, lane: 'slow' }), ['network:demo-view.notice.slowSpent', 'warn']);
  assert.deepEqual(key({ kind: 'spent', resets, lane: 'slow' }), ['network:demo-view.notice.spent', 'warn']);
  for (const n of [{ kind: 'lane', lane: 'slow' }, { kind: 'budget', threshold: 100, used: 1, limit: 1, lane: 'slow' }, { kind: 'budget', threshold: 80, used: 1, limit: 2, lane: 'slow', resets }] as DemoNotice[]) {
    const m = demoNotice(n).message;
    assert.doesNotMatch(t(m.key, m.params), /\{\{/);
  }
});

test("#14: a reconnect or budget reset weeks away waits in steps setTimeout can hold, not at once in a loop", () => {
  const MAX = 2 ** 31 - 1; // setTimeout's longest delay: a longer one fires at once
  for (const [code, reason, field] of [[4011, 'maintenance', 'reconnect_after'], [4010, 'bytes', 'resets']] as const) {
    const h = harness(() => 0);
    const armed: number[] = [];
    const set = h.env.setTimeout;
    h.env.setTimeout = (f, ms) => { armed.push(ms); return set(f, ms); };
    h.last().accept();
    h.last().hello();
    const at = T0 + 40 * 86_400_000; // 40 days on
    h.last().text({ type: 'closing', code, reason, [field]: iso(at) });
    h.last().end(code, reason);
    assert.equal(h.net.status().wait?.at, at, `${code}: said for when the server named`);
    assert.ok(armed.every((ms) => ms <= MAX), `${code}: a timer of ${Math.max(...armed)} ms`);
    h.advance(39 * 86_400_000);
    assert.equal(h.sockets.length, 1, `${code}: not before`);
    assert.ok(armed.every((ms) => ms <= MAX), `${code}: re-armed past setTimeout's range`);
    h.advance(86_400_000);
    assert.equal(h.sockets.length, 2, `${code}: then a new socket`);
  }
});

test("the fork's `unresolved` refusal (an allowed name without an IPv4 address) has words of its own", () => {
  assert.equal(refusalText({ reason: 'unresolved', name: 'gone.example', port: 443 }), t('network:demo-view.refusal', { what: 'gone.example:443', why: t('network:demo-view.reason.unresolved') }));
});
