// The Network wizard's way through its steps in Node (web/app/net-wizard.ts; docs/networking/adapters.md §3.2): where
// it opens (the local helper's step on its pairing link, the change step on an adapter that has a connection, else the
// pick step or the kind), and where Back leads from each step (to the change step from the pick step, or from the kind
// where there's nothing to pick; none on the step it opened on).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { firstStep, stepBack, type Start } from '../web/app/net-wizard.ts';

const changing: Start = { pickable: true, changing: true };
const picking: Start = { pickable: true, changing: false };
const none: Start = { pickable: false, changing: false };

test('the wizard opens on the change step only on an adapter that has a connection', () => {
  assert.equal(firstStep({ mode: 'attach', attached: 'c1' }, changing), 'change');
  assert.equal(firstStep({ mode: 'attach' }, picking), 'pick');
  assert.equal(firstStep({ mode: 'attach' }, none), 'kind');
  assert.equal(firstStep({ mode: 'new' }, none), 'kind');
  assert.equal(firstStep({ mode: 'attach', localURL: 'ws://127.0.0.1:1/x' }, changing), 'local', 'the pairing link first');
});

test("Back: to the change step from the pick step (or the kind with nothing to pick), none where it opened", () => {
  assert.equal(stepBack('change', changing), undefined);
  assert.equal(stepBack('pick', changing), 'change');
  assert.equal(stepBack('pick', picking), undefined);
  assert.equal(stepBack('kind', changing), 'pick');
  assert.equal(stepBack('kind', { pickable: false, changing: true }), 'change');
  assert.equal(stepBack('kind', none), undefined);
  assert.equal(stepBack('roomJoin', changing), 'roomPick');
  assert.equal(stepBack('roomPick', picking), 'kind');
  assert.equal(stepBack('tailscale', picking), 'kind');
});
