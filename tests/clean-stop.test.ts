// The stop for a change that keeps the disk (web/app/run/clean-stop.ts): the guest asked first where its agent can,
// the dialog until its power-off ends the run or the user cuts it short; refused or no agent: the hard stop at once.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stopCleanly, type CleanStopDeps } from '../web/app/run/clean-stop.ts';

/** Fakes: the guest takes the request (`takes`, settled when `answer` is called), powers off when `powerOff` is. */
function fakes(o: { canSoft?: boolean; takes?: boolean }) {
  const log: string[] = [];
  let up = true;
  let answer = (_: boolean) => undefined as void;
  let skip = () => undefined as void;
  const d: CleanStopDeps = {
    soft: () => {
      log.push('asked');
      return new Promise((r) => (answer = r));
    },
    canSoft: () => o.canSoft ?? true,
    up: () => up,
    dialog: () => {
      log.push('dialog');
      return { skipped: new Promise<void>((r) => (skip = r)), close: () => log.push('closed') };
    },
    stop: async () => {
      log.push(up ? 'cut' : 'stopped');
    },
    poll: 5,
  };
  return { d, log, answer: () => answer(o.takes ?? true), powerOff: () => (up = false), skip: () => skip() };
}
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

test('no agent that can: the hard stop at once, no dialog', async () => {
  const f = fakes({ canSoft: false });
  assert.equal(await stopCleanly(f.d), 'hard');
  assert.deepEqual(f.log, ['cut']);
});

test('taken: the dialog until the guest powers off, then the stop of a machine already off', async () => {
  const f = fakes({});
  const done = stopCleanly(f.d);
  await tick();
  f.answer();
  await tick();
  assert.deepEqual(f.log, ['dialog', 'asked'], 'waiting');
  f.powerOff();
  assert.equal(await done, 'clean');
  assert.deepEqual(f.log, ['dialog', 'asked', 'closed', 'stopped']);
});

test("Power off now: while the guest shuts down, or before it answered: the hard stop at once", async () => {
  for (const before of [false, true]) {
    const f = fakes({});
    const done = stopCleanly(f.d);
    await tick();
    if (!before) f.answer();
    await tick();
    f.skip();
    assert.equal(await done, 'skipped');
    assert.deepEqual(f.log, ['dialog', 'asked', 'closed', 'cut']);
  }
});

test('refused (or no answer): the dialog goes, the hard stop at once', async () => {
  const f = fakes({ takes: false });
  const done = stopCleanly(f.d);
  await tick();
  f.answer();
  assert.equal(await done, 'hard');
  assert.deepEqual(f.log, ['dialog', 'asked', 'closed', 'cut']);
});
