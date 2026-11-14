// The stop for a change that keeps the disk (web/app/run/clean-stop.ts): the guest asked first where its agent can,
// the dialog until its power-off ends the run or the user cuts it short; a request already pending counts as asked;
// an agent that comes back meanwhile is asked once more, one whose connection the shutdown ended is not; refused or
// unanswered, the user chooses (a No keeps it running; the guest powering off meanwhile takes the question down); no
// agent that can: the hard stop at once (the change's question said so).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stopCleanly, type CleanStopDeps } from '../web/app/run/clean-stop.ts';

/** Fakes: each request is settled by `answer` (taken or not, `takes`); `powerOff` ends the run. */
function fakes(o: { canSoft?: boolean; takes?: boolean; hardOk?: boolean; pending?: boolean }) {
  const log: string[] = [];
  const state = { up: true, pending: o.pending ?? false, canSoft: o.canSoft ?? true, question: false };
  let answer = (_: boolean) => undefined as void;
  let skip = () => undefined as void;
  const d: CleanStopDeps = {
    soft: () => {
      log.push('asked');
      return new Promise((r) => {
        answer = (taken) => {
          state.pending = taken;
          r(taken);
        };
      });
    },
    pending: () => state.pending,
    canSoft: () => state.canSoft,
    up: () => state.up,
    dialog: () => {
      log.push('dialog');
      return { skipped: new Promise<void>((r) => (skip = r)), close: () => log.push('closed') };
    },
    hard: () => {
      log.push('question');
      if (o.hardOk !== undefined) return { answer: Promise.resolve(o.hardOk), close: () => undefined };
      // Unanswered (hardOk undefined): open until taken down.
      state.question = true;
      let no = (_: boolean) => undefined as void;
      const answer = new Promise<boolean>((r) => (no = r));
      return {
        answer,
        close: () => {
          log.push('question closed');
          state.question = false;
          no(false);
        },
      };
    },
    stop: async () => {
      log.push(state.up ? 'cut' : 'stopped');
    },
    poll: 5,
  };
  return { d, log, state, answer: (taken = o.takes ?? true) => answer(taken), powerOff: () => (state.up = false), skip: () => skip() };
}
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

test('no agent that can: the hard stop at once, no dialog (the change asked about a power cut)', async () => {
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

test('Power off now: while the guest shuts down, or before it answered: the hard stop at once', async () => {
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

test("refused (or unanswered): the user chooses; No keeps it running, nothing cut", async () => {
  for (const [hardOk, want, last] of [[true, 'hard', 'cut'], [false, 'kept', 'question']] as const) {
    const f = fakes({ takes: false, hardOk });
    const done = stopCleanly(f.d);
    await tick();
    f.answer();
    assert.equal(await done, want);
    assert.deepEqual(f.log.slice(0, 4), ['dialog', 'asked', 'closed', 'question']);
    assert.equal(f.log.at(-1), last);
  }
});

test("a request already pending (the toolbar's): waited for, not asked again nor cut", async () => {
  const f = fakes({ pending: true });
  const done = stopCleanly(f.d);
  await tick();
  f.powerOff();
  assert.equal(await done, 'clean');
  assert.deepEqual(f.log, ['dialog', 'closed', 'stopped']);
});

test('the agent came back meanwhile (the pending sign cleared, the guest runs on): asked once more, then the user chooses', async () => {
  const f = fakes({ hardOk: true });
  const done = stopCleanly(f.d);
  await tick();
  f.answer();
  await tick();
  f.state.pending = false; // its HELLO
  await tick();
  assert.deepEqual(f.log, ['dialog', 'asked', 'asked'], 'asked again');
  f.answer(true);
  await tick();
  f.state.pending = false; // and again: no third ask
  await tick();
  assert.equal(await done, 'hard');
  assert.deepEqual(f.log, ['dialog', 'asked', 'asked', 'closed', 'question', 'cut']);
});

test("the agent's connection ended under the shutdown (the pending sign cleared, no agent): waited for, not asked again nor questioned", async () => {
  const f = fakes({});
  const done = stopCleanly(f.d);
  await tick();
  f.answer();
  await tick();
  // The shutdown stopped the agent before the guest powered off (web/app/areas/agent-shown.ts clears the sign).
  f.state.pending = false;
  f.state.canSoft = false;
  await tick(50);
  assert.deepEqual(f.log, ['dialog', 'asked'], 'still waiting');
  f.powerOff();
  assert.equal(await done, 'clean');
  assert.deepEqual(f.log, ['dialog', 'asked', 'closed', 'stopped']);
});

test('the guest powers off while the question is open: taken down, the stop a clean one', async () => {
  const f = fakes({ takes: false });
  const done = stopCleanly(f.d);
  await tick();
  f.answer();
  await tick();
  assert.ok(f.state.question, 'asked');
  f.powerOff();
  assert.equal(await done, 'clean');
  assert.deepEqual(f.log, ['dialog', 'asked', 'closed', 'question', 'question closed', 'stopped']);
});
