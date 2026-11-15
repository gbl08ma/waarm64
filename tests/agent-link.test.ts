// The page's end of the agent's connection (web/app/agent-link.ts) and the actions on it, across the ends of runs and
// connections (the track's review, review/betteragent-page and review/betteragent-loop11): a run's end settles what
// waits on the link, every HELLO listener hears it, a late answer to an ask that gave up isn't taken for the next
// one's, the close listeners; the trim of a run that ended isn't the next run's; LEASE names the connected cards;
// SoftPower's pending sign, its BUSY, its notices.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { CAP, COPIED, encodeFrame, encodeHello, FRAME, FrameReader, LEASED, POWERED, TRIMMED } from '../web/agent-frame.ts';
import { AgentLink, pageCaps } from '../web/app/agent-link.ts';
import { LeaseActions } from '../web/app/areas/lease-actions.ts';
import { TrimActions } from '../web/app/areas/trim-actions.ts';
import { SoftPower } from '../web/app/run/soft-power.ts';
import type { Msg } from '../web/msg.ts';
import { until } from './until.ts';

const ports: MessagePort[] = [];
after(() => ports.forEach((p) => p.close()));
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

/** A link and its agent: HELLO with `caps` at `connect`; `answer(type, payload)` says what it sends back (none: silence). */
function agent(caps: number, answer: (type: number, payload: Uint8Array) => { type: number; payload: Uint8Array; delay?: number } | undefined = () => undefined) {
  const c = new MessageChannel();
  ports.push(c.port1, c.port2);
  const link = new AgentLink(c.port1, pageCaps(false));
  const got: { type: number; payload: number[] }[] = [];
  const reader = new FrameReader();
  let conn = 1;
  c.port2.onmessage = (e) => {
    if (e.data.type !== 'data') return;
    c.port2.postMessage({ type: 'taken', n: e.data.bytes.length, conn: e.data.conn });
    for (const f of reader.push(e.data.bytes)) {
      got.push({ type: f.type, payload: [...f.payload] });
      const a = answer(f.type, f.payload);
      const at = conn;
      if (a) setTimeout(() => c.port2.postMessage({ type: 'data', conn: at, bytes: encodeFrame(a.type, a.payload) }), a.delay ?? 0);
    }
  };
  const hello = () => c.port2.postMessage({ type: 'data', conn, bytes: encodeFrame(FRAME.HELLO, encodeHello({ version: 1, caps })) });
  return {
    link,
    got,
    /** Connects and says HELLO: resolves once the link heard it. */
    async connect() {
      c.port2.postMessage({ type: 'open', open: true, conn });
      hello();
      assert.ok(await link.hello(10_000), 'the HELLO heard');
    },
    hello,
    drop() {
      c.port2.postMessage({ type: 'open', open: false, conn });
      conn++;
    },
  };
}

test("a run's end (`close`) settles what waits on its link at once: an ask, a HELLO's wait", async () => {
  const a = agent(CAP.TIME | CAP.TRIM);
  await a.connect();
  const t0 = performance.now();
  const trim = a.link.trim(10_000);
  const c = new MessageChannel();
  ports.push(c.port1, c.port2);
  const silent = new AgentLink(c.port1, pageCaps(false));
  const hello = silent.hello(10_000);
  a.link.close();
  silent.close();
  assert.equal(await trim, undefined);
  assert.equal(await hello, undefined);
  assert.ok(performance.now() - t0 < 1000, `settled after ${performance.now() - t0} ms`);
});

test('every HELLO listener hears it, waiters that leave meanwhile or not', async () => {
  const a = agent(CAP.TIME);
  const heard: string[] = [];
  const first = a.link.hello(1000);
  const second = a.link.hello(1000);
  a.link.onHello.push(() => heard.push('last'));
  a.connect();
  assert.ok(await first);
  assert.ok(await second, 'the second waiter too');
  assert.deepEqual(heard, ['last']);
  a.link.close();
});

test("a late answer to an ask that gave up isn't the next ask's", async () => {
  let n = 0;
  const text = (s: string) => new Uint8Array([COPIED.OK, ...new TextEncoder().encode(s)]);
  // The first COPY's answer comes after its ask gave up; the second's at once.
  const a = agent(CAP.TIME | CAP.COPY, (type) => (type === FRAME.COPY ? (n++ === 0 ? { type: FRAME.COPIED, payload: text('old'), delay: 150 } : { type: FRAME.COPIED, payload: text('new'), delay: 250 }) : undefined));
  await a.connect();
  assert.equal(await a.link.copy(50), undefined, 'gave up');
  assert.deepEqual(await a.link.copy(2000), { status: COPIED.OK, text: 'new' }, "not the first one's late answer");
  a.link.close();
});

test("the close listeners: called when the agent's connection ends", async () => {
  const a = agent(CAP.TIME);
  let closed = 0;
  a.link.onClose.push(() => closed++);
  await a.connect();
  assert.equal(closed, 0);
  a.drop();
  await until(() => closed > 0, 'the close listener');
  await settle();
  assert.equal(closed, 1, 'once');
  a.link.close();
});

test("a trim the run's end cut short isn't joined by the next run's; Free unused disk space goes once the agent's connection ends", async () => {
  const shown = { canTrim: false };
  const run = { link: undefined as AgentLink | undefined };
  const compactions: boolean[] = [];
  const trims = new TrimActions(run, { notify: () => undefined }, async (_ms, measure) => {
    compactions.push(!!measure);
    return { before: 10, after: 5 };
  }, shown);
  const old = agent(CAP.TIME | CAP.TRIM); // never answers
  run.link = trims.follow(old.link);
  await old.connect();
  assert.equal(shown.canTrim, true);
  const cut = trims.trim();
  await until(() => old.got.some((f) => f.type === FRAME.TRIM), 'the TRIM asked');
  trims.end();
  old.link.close();
  run.link = undefined;
  await cut;
  const fresh = agent(CAP.TIME | CAP.TRIM, (type) => (type === FRAME.TRIM ? { type: FRAME.TRIMMED, payload: new Uint8Array([TRIMMED.TRIMMED]) } : undefined));
  run.link = trims.follow(fresh.link);
  await fresh.connect();
  const r = await trims.trim();
  assert.equal(r.status, TRIMMED.TRIMMED, "the new run's own trim");
  assert.ok(fresh.got.some((f) => f.type === FRAME.TRIM));
  fresh.drop();
  await until(() => !shown.canTrim, 'no agent connected: no button');
  fresh.link.close();
});

test('LEASE names the connected cards by their MACs; none connected after the grace: no LEASE, no flap', async () => {
  const a = agent(CAP.TIME | CAP.LEASE, (type) => (type === FRAME.LEASE ? { type: FRAME.LEASED, payload: new Uint8Array([LEASED.RENEWED]) } : undefined));
  await a.connect();
  const flaps: number[] = [];
  const deps = (connected: { index: number; mac: string }[]) => ({ whenConnected: () => Promise.resolve(connected), link: () => a.link, flap: (i: number) => flaps.push(i), waits: { grace: 50, agent: 500, leased: 500 } });
  assert.equal(await new LeaseActions(deps([{ index: 1, mac: '52:54:00:12:34:57' }])).restored(), 'agent');
  const lease = a.got.filter((f) => f.type === FRAME.LEASE);
  assert.deepEqual(lease.at(-1)?.payload, [1, 0x52, 0x54, 0, 0x12, 0x34, 0x57]);
  assert.equal(await new LeaseActions(deps([])).restored(), 'none');
  assert.equal(a.got.filter((f) => f.type === FRAME.LEASE).length, 1, 'no LEASE');
  assert.deepEqual(flaps, []);
  a.link.close();
});

test("SoftPower: a HELLO while one is pending clears it (the agent came back: the guest isn't shutting down); BUSY and silence fall to the hard one, said", async () => {
  const said: string[] = [];
  const messages = { notify: (m: Msg) => said.push(m.key) };
  const shown = { soft: undefined as 'off' | 'reboot' | undefined };
  let answer: number | undefined;
  const a = agent(CAP.TIME | CAP.POWER, (type) => (type === FRAME.POWER && answer !== undefined ? { type: FRAME.POWERED, payload: new Uint8Array([answer]) } : undefined));
  const run = { link: a.link as AgentLink | undefined };
  const soft = new SoftPower(run, shown, messages, 200);
  await a.connect();
  // The connection ends under the request: taken, pending; the agent connects again: not shutting down after all.
  const r = soft.request('off');
  await until(() => a.got.some((f) => f.type === FRAME.POWER), 'the POWER asked');
  a.drop();
  assert.equal(await r, true);
  assert.equal(shown.soft, 'off');
  await a.connect();
  await until(() => shown.soft === undefined, 'cleared by the HELLO');
  // BUSY (a request of an earlier one still running in the guest): the hard one, said.
  answer = POWERED.BUSY;
  assert.equal(await soft.request('reboot'), false);
  // No tool, no answer within the wait (last: the link would drop the late answer this fake never sends): the hard
  // one, said.
  answer = POWERED.NO_TOOL;
  assert.equal(await soft.request('off'), false);
  answer = undefined;
  assert.equal(await soft.request('off'), false);
  assert.deepEqual(said, ['machine:soft-power.busy', 'machine:soft-power.noTool', 'machine:soft-power.noAnswer']);
  a.link.close();
});
