// The introduction's address and where leaving it leads (web/app/intro-route.ts; docs/frontend.md "The introduction").
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { afterIntro, INTRO_HASH, isIntroAddress } from '../web/app/intro-route.ts';

test("the introduction's address is its fragment; leaving it leads to the store, or Home with machines", () => {
  assert.equal(INTRO_HASH, '#intro');
  assert.equal(isIntroAddress({ hash: '#intro' }), true);
  assert.equal(isIntroAddress({ hash: '' }), false);
  assert.equal(isIntroAddress({ hash: '#demos' }), false);
  assert.equal(isIntroAddress({ hash: '#intro?x' }), false, 'it takes no parameters');
  assert.equal(afterIntro(0), 'demos');
  assert.equal(afterIntro(1), 'home');
  assert.equal(afterIntro(7), 'home');
});
