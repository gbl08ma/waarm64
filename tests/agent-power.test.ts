// The guest agent's OS and POWER (docs/devices.md "The guest's OS", "Power off and restart from the guest"): their
// frames (the bytes agent/src/frame.rs and agent/src/os.rs pin), the page's end (web/app/agent-link.ts `os`, `power`),
// the toolbar's soft power-off and restart (web/app/run/soft-power.ts) on a faked link, and the status bar's Guest OS.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { CAP, decodeOs, encodeFrame, encodeHello, FRAME, FrameReader, POWER, POWERED } from '../web/agent-frame.ts';
import { AgentLink, pageCaps } from '../web/app/agent-link.ts';
import { SOFT_WAIT_MS, SoftPower } from '../web/app/run/soft-power.ts';
import { render } from '../web/app/statusbar-render.ts';
import type { Live } from '../web/app/statusbar-piece.ts';
import type { Msg } from '../web/msg.ts';
import { t } from '../web/i18n.ts';

const open: MessagePort[] = [];
after(() => open.forEach((p) => p.close()));
const settle = () => new Promise((r) => setTimeout(r, 30));

/**
 * A link and the agent's end: it says HELLO with `caps` (`hello`), answers POWER with `answer` (none: silence), and
 * records the POWER payloads it got.
 */
function agent(caps = CAP.TIME | CAP.POWER) {
  const c = new MessageChannel();
  open.push(c.port1, c.port2);
  const link = new AgentLink(c.port1, pageCaps(false));
  const asked: number[][] = [];
  const reader = new FrameReader();
  const a = { answer: undefined as number | undefined, conn: 1 };
  c.port2.onmessage = (e) => {
    if (e.data.type !== 'data') return;
    c.port2.postMessage({ type: 'taken', n: e.data.bytes.length, conn: e.data.conn });
    for (const f of reader.push(e.data.bytes))
      if (f.type === FRAME.POWER) {
        asked.push([...f.payload]);
        if (a.answer !== undefined)
          c.port2.postMessage({ type: 'data', conn: a.conn, bytes: encodeFrame(FRAME.POWERED, new Uint8Array([a.answer])) });
      }
  };
  const say = (type: number, p: Uint8Array) => c.port2.postMessage({ type: 'data', conn: a.conn, bytes: encodeFrame(type, p) });
  return {
    link,
    asked,
    a,
    connect() {
      c.port2.postMessage({ type: 'open', open: true, conn: a.conn });
      say(FRAME.HELLO, encodeHello({ version: 1, caps }));
    },
    say,
    end: () => c.port2.postMessage({ type: 'open', open: false, conn: a.conn }),
  };
}

test('frames: OS, POWER and POWERED (the bytes agent/src/frame.rs and os.rs pin)', () => {
  assert.deepEqual([FRAME.OS, FRAME.POWER, FRAME.POWERED, CAP.OS, CAP.POWER], [25, 26, 27, 1 << 14, 1 << 15]);
  assert.deepEqual([POWER.OFF, POWER.REBOOT, POWERED.TAKEN, POWERED.REFUSED, POWERED.NO_TOOL], [0, 1, 0, 1, 2]);
  const debian = new Uint8Array([0x1c, ...new TextEncoder().encode('Debian GNU/Linux 13 (trixie)'), 6, ...new TextEncoder().encode('debian'), 2, 0x31, 0x33]);
  assert.deepEqual(decodeOs(debian), { name: 'Debian GNU/Linux 13 (trixie)', id: 'debian', version: '13' });
  assert.equal(decodeOs(debian.subarray(0, debian.length - 1)), undefined, 'short');
  assert.ok(pageCaps(false) & CAP.OS && !(pageCaps(true) & CAP.POWER), 'the page takes OS always; POWER is the agent\'s');
});

test("the link: the guest's OS as the agent names it, kept over its connections; POWER's answer, gone when the connection ends, none without CAP.POWER", async () => {
  const g = agent(CAP.TIME);
  const named: string[] = [];
  g.link.onOs = (os) => named.push(os.name);
  assert.equal(await g.link.power(false, 100), undefined, 'not connected');
  g.connect();
  g.say(FRAME.OS, new Uint8Array([3, 0x41, 0x72, 0x63, 4, 0x61, 0x72, 0x63, 0x68, 0]));
  await settle();
  assert.deepEqual(g.link.os, { name: 'Arc', id: 'arch', version: '' });
  assert.equal(g.link.canPower, false);
  assert.equal(await g.link.power(false, 100), undefined, "an agent that doesn't power off");
  assert.deepEqual(g.asked, [], 'not asked');
  g.end();
  await settle();
  assert.equal(g.link.os?.name, 'Arc', 'kept over the connection');
  g.link.close();

  const p = agent();
  p.connect();
  await settle();
  assert.equal(p.link.canPower, true);
  p.a.answer = POWERED.TAKEN;
  assert.equal(await p.link.power(false, 1000), POWERED.TAKEN);
  p.a.answer = POWERED.REFUSED;
  assert.equal(await p.link.power(true, 1000), POWERED.REFUSED);
  assert.deepEqual(p.asked, [[POWER.OFF], [POWER.REBOOT]]);
  p.a.answer = undefined;
  assert.equal(await p.link.power(false, 50), undefined, 'no answer in time');
  const pending = p.link.power(false, 10_000);
  p.end();
  assert.equal(await pending, 'gone', 'the shutdown stopped the agent');
  p.link.close();
});

test('the soft power-off (web/app/run/soft-power.ts): asked of an agent that can; taken or gone, pending until the run ends; refused said, then the hard one; a second request is the hard one', async () => {
  const said: string[] = [];
  const messages = { notify: (m: Msg) => said.push(m.key) };
  const shown = { soft: undefined as 'off' | 'reboot' | undefined };
  const run = { link: undefined as AgentLink | undefined };
  const soft = new SoftPower(run, shown, messages);
  assert.equal(await soft.request('off'), false, 'no agent: the hard one');

  const g = agent(CAP.TIME);
  run.link = g.link;
  g.connect();
  await settle();
  assert.equal(await soft.request('off'), false, "an agent that can't: the hard one");
  assert.equal(shown.soft, undefined);

  const p = agent();
  run.link = p.link;
  p.connect();
  await settle();
  p.a.answer = POWERED.REFUSED;
  assert.equal(await soft.request('reboot'), false, 'refused: the hard one');
  assert.deepEqual([shown.soft, said], [undefined, ['machine:soft-power.refused.reboot']]);

  p.a.answer = POWERED.TAKEN;
  assert.equal(await soft.request('off'), true, 'taken');
  assert.equal(shown.soft, 'off', 'pending: the sign stays');
  assert.equal(await soft.request('off'), false, 'a second request: the hard one');
  assert.deepEqual(p.asked, [[POWER.REBOOT], [POWER.OFF]], 'not asked again');

  // The agent's connection ends under the shutdown before its answer: taken all the same.
  shown.soft = undefined;
  p.a.answer = undefined;
  const gone = soft.request('reboot');
  await settle();
  assert.equal(shown.soft, 'reboot', 'shown while asked');
  p.end();
  assert.equal(await gone, true);
  assert.equal(shown.soft, 'reboot');

  // The run ends while the request waits: nothing more to do.
  shown.soft = undefined;
  const q = agent();
  run.link = q.link;
  q.connect();
  await settle();
  const ended = soft.request('off');
  await settle();
  run.link = undefined;
  q.end();
  assert.equal(await ended, true);
  assert.ok(SOFT_WAIT_MS >= 5000, 'time for busctl under the JIT');
  for (const l of [g.link, p.link, q.link]) l.close();
});

test("the status bar's Guest OS: the agent's name for it, nothing before", () => {
  const live = { state: 'running', stateText: '', now: 0, mouseLock: false, mouseLocked: false, keyboardLocked: false, keysFocused: false, mic: 'idle', disks: [], nets: [] } satisfies Live;
  assert.deepEqual(render({ kind: 'os' }, undefined, live), []);
  const [p] = render({ kind: 'os' }, undefined, { ...live, os: 'Debian GNU/Linux 13 (trixie)' });
  assert.equal(p.text, 'Debian GNU/Linux 13 (trixie)');
  assert.equal(p.title, t('statusbar:statusbar-render.os.title', { os: 'Debian GNU/Linux 13 (trixie)' }));
});

test("the status bar's power state: a running guest's pending power-off or reboot in its place, busy; not once it stopped", () => {
  const [running, off] = [t('machine:messages.state.running'), t('machine:messages.state.off')];
  const live = { state: 'running', stateText: running, now: 0, mouseLock: false, mouseLocked: false, keyboardLocked: false, keysFocused: false, mic: 'idle', disks: [], nets: [] } satisfies Live;
  assert.deepEqual(render({ kind: 'state' }, undefined, live).map((p) => [p.text, p.tone]), [[running, 'ok']]);
  assert.deepEqual(render({ kind: 'state' }, undefined, { ...live, soft: 'off' }).map((p) => [p.text, p.tone]), [[t('statusbar:statusbar-render.state.shuttingDown'), 'busy']]);
  assert.deepEqual(render({ kind: 'state' }, undefined, { ...live, soft: 'reboot' }).map((p) => p.text), [t('statusbar:statusbar-render.state.restarting')]);
  assert.deepEqual(render({ kind: 'state' }, undefined, { ...live, state: 'off', stateText: off, soft: 'off' }).map((p) => p.text), [off]);
});
