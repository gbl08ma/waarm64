// The demo store's page's address (web/app/demos-route.ts; docs/frontend.md "The demo store") and what a demo needs of
// the browser (web/app/demo-check.ts), in Node: `/demos` and `#demos` with `?id=` and `?store=` (percent-encoded, the
// fragment's own query winning), the page's own query kept apart, the address after the page closes; the first visit
// (no machines, nothing asked, not under automation unless `?firstvisit=1`: it opens the introduction); and the checks: a stop for what a demo
// can't run without, a warning for what it may run without, 3D and Vulkan asked only of demos that have them.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allMet, canStart, checkDemo, listedChecks, room, type BrowserEnv, type Needs } from '../web/app/demo-check.ts';
import { OUR_STORE } from '../web/app/demo-store.ts';
import { demosAddress, demosRoute, firstVisit, leftDemos, pageQuery } from '../web/app/demos-route.ts';

const SITE = 'https://vm.tny.im'; // i18n-ignore: an address
const at = (path: string) => new URL(path, SITE);

test("the store's page by its path or its fragment, with its id and store", () => {
  assert.equal(demosRoute(at('/')), undefined);
  assert.equal(demosRoute(at('/#home')), undefined);
  assert.deepEqual(demosRoute(at('/demos')), { store: OUR_STORE, ours: true });
  assert.deepEqual(demosRoute(at('/x/demos.html?id=alpine-term')), { store: OUR_STORE, id: 'alpine-term', ours: true });
  assert.deepEqual(demosRoute(at('/#demos?id=alpine-term')), { store: OUR_STORE, id: 'alpine-term', ours: true });
  const other = 'https://example.org/my store.json';
  const r = demosRoute(at(`/demos?store=${encodeURIComponent(other)}&id=a`));
  assert.deepEqual(r, { store: 'https://example.org/my%20store.json', id: 'a', ours: false });
  assert.deepEqual(demosRoute(at('/?id=x#demos?id=y'))?.id, 'y', "the fragment's query wins");
  assert.deepEqual(demosRoute(at('/demos?store=javascript:alert(1)')), { store: OUR_STORE, ours: true }, 'not http(s): ours');
  assert.deepEqual(demosRoute(at('/demos?store=other.json'))?.store, `${SITE}/other.json`, 'relative to the page');
  assert.deepEqual(demosRoute(at(`/demos?store=${encodeURIComponent(OUR_STORE)}`))?.ours, true);
});

test("the page's own query apart from the store's; the address once the page closes, and while it shows", () => {
  assert.equal(pageQuery('?id=a&store=b'), '');
  assert.equal(pageQuery('?m=x&id=a'), '?m=x');
  assert.equal(leftDemos(at('/demos?id=a&m=x')), '/?m=x');
  assert.equal(leftDemos(at('/sub/demos.html?id=a')), '/sub/');
  assert.equal(leftDemos(at('/?id=a#demos')), '/');
  assert.equal(demosAddress(at('/demos?id=a'), { id: 'b' }), '/demos?id=b');
  assert.equal(demosAddress(at('/demos?id=a'), {}), '/demos');
  assert.equal(demosAddress(at('/?m=x'), { store: OUR_STORE, id: 'b' }), '/?m=x#demos?id=b');
  assert.equal(demosAddress(at('/'), { store: 'https://e.org/s.json' }), `/#demos?store=${encodeURIComponent('https://e.org/s.json')}`);
});

test('a first visit: no machines and nothing asked; under automation only when asked', () => {
  const w = (search: string, hash = '') => ({ search, hash });
  assert.equal(firstVisit(w(''), 0, false), true);
  assert.equal(firstVisit(w(''), 1, false), false, 'a machine kept: not a first visit');
  assert.equal(firstVisit(w('?disk=x'), 0, false), false, 'a disk asked for');
  assert.equal(firstVisit(w('', '#home'), 0, false), false);
  assert.equal(firstVisit(w(''), 0, true), false, 'the tests open the page bare');
  assert.equal(firstVisit(w('?firstvisit=1'), 0, true), true);
});

const ENV: BrowserEnv = { chromium: true, mobile: false, isolated: true, opfs: true, memoryGiB: 8, free: 10 * 2 ** 30 };
const NEEDS: Needs = { gl: false, vulkan: false, ramMiB: 512, download: 30_000_000 };
const level = (env: Partial<BrowserEnv>, needs: Partial<Needs> = {}) =>
  Object.fromEntries(checkDemo({ ...ENV, ...env }, { ...NEEDS, ...needs }).map((c) => [c.what, c.level]));

test("a demo's checks: stops, warnings, and what's asked only of 3D and Vulkan", () => {
  assert.deepEqual(level({}), { browser: 'ok', isolation: 'ok', opfs: 'ok', memory: 'ok', storage: 'ok' });
  assert.equal(canStart(checkDemo(ENV, NEEDS)), true);
  const bad = checkDemo({ ...ENV, isolated: false }, NEEDS);
  assert.equal(canStart(bad), false, 'no shared memory: a stop');
  assert.equal(level({ opfs: false }).opfs, 'fail');
  assert.equal(level({ chromium: false }).browser, 'warn', 'another browser: a warning');
  assert.equal(canStart(checkDemo({ ...ENV, chromium: false, mobile: true, memoryGiB: 1 }, NEEDS)), true, 'warnings only');
  assert.equal(level({ mobile: true }).mobile, 'warn');
  assert.equal(level({ memoryGiB: 1 }).memory, 'warn');
  assert.equal(level({ memoryGiB: undefined }).memory, undefined, "memory unknown: not said");
  assert.equal(level({ free: room(NEEDS.download) - 1 }).storage, 'fail', 'no room for the download: a stop');
  assert.equal(level({ webgl2: false }, { gl: true }).webgl2, 'fail');
  assert.deepEqual([level({ webgl2: true, webgpu: false }, { vulkan: true }).webgl2, level({ webgl2: true, webgpu: false }, { vulkan: true }).webgpu], ['ok', 'fail']);
  assert.equal(level({}).webgl2, undefined, 'no 3D: not asked');
  // What the page lists: the shared memory's check only when it fails; all met is one line.
  assert.equal(allMet(checkDemo(ENV, NEEDS)), true);
  assert.equal(allMet(checkDemo({ ...ENV, memoryGiB: 1 }, NEEDS)), false, 'a warning: not all met');
  assert.deepEqual(listedChecks(checkDemo(ENV, NEEDS)).map((c) => c.what), ['browser', 'opfs', 'memory', 'storage']);
  assert.equal(listedChecks(bad).some((c) => c.what === 'isolation' && c.level === 'fail'), true, 'its failure is said');
});
