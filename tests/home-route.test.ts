// The Home page's levels in Node (web/app/home-route.ts; docs/frontend.md "The Home page"): the address read and
// written (`#home`, the older `#machines`, a connection's Details, Settings and Domains, its id percent-encoded; a
// malformed one or an unknown section is the root), the level as the page shows it (none once the connection is gone,
// Domains only for a room), and where Back leads from each origin (a machine gone, or none on the page, is Connections).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { backOf, homeHash, homeRoute, shownContext, type HomeContext } from '../web/app/home-route.ts';

test("Home's address: the root, a connection's sections, and what isn't Home's", () => {
  assert.deepEqual(homeRoute('#home'), {});
  assert.deepEqual(homeRoute('#machines'), {}, 'the older address');
  assert.deepEqual(homeRoute('#home/connections/abc'), { connection: { id: 'abc', section: 'details' } });
  assert.deepEqual(homeRoute('#home/connections/abc/settings'), { connection: { id: 'abc', section: 'settings' } });
  assert.deepEqual(homeRoute('#home/connections/abc/domains'), { connection: { id: 'abc', section: 'domains' } });
  assert.deepEqual(homeRoute('#home/connections/a%2Fb%20c'), { connection: { id: 'a/b c', section: 'details' } });
  assert.deepEqual(homeRoute('#home/connections/abc/nope'), {}, 'an unknown section: the root');
  assert.deepEqual(homeRoute('#home/connections/%zz'), {}, 'a malformed escape: the root');
  for (const h of ['', '#intro', '#demos', '#home/connections', '#home/connections/', '#home/disks/x', '#home/connections/a/settings/x', '#homeward'])
    assert.equal(homeRoute(h), undefined, h);
});

test('the address written for each level reads back as that level', () => {
  assert.equal(homeHash(), '#home');
  assert.equal(homeHash({ id: 'abc', section: 'details' }), '#home/connections/abc');
  assert.equal(homeHash({ id: 'abc', section: 'settings' }), '#home/connections/abc/settings');
  assert.equal(homeHash({ id: 'a/b c', section: 'domains' }), '#home/connections/a%2Fb%20c/domains');
  for (const section of ['details', 'settings', 'domains'] as const)
    assert.deepEqual(homeRoute(homeHash({ id: 'x?y#z', section })), { connection: { id: 'x?y#z', section } });
});

test('the level shown: none once its connection is gone; Domains is a room connection\'s alone', () => {
  const ctx = (section: HomeContext['section']): HomeContext => ({ kind: 'connection', id: 'c1', section, from: { to: 'connections' } });
  const room = (id: string) => (id === 'c1' ? { id, kind: 'room' } : undefined);
  const tailnet = (id: string) => (id === 'c1' ? { id, kind: 'tailnet' } : undefined);
  assert.equal(shownContext(undefined, room), undefined);
  assert.equal(shownContext(ctx('details'), () => undefined), undefined, 'gone: the root (Connections)');
  assert.deepEqual(shownContext(ctx('domains'), room), ctx('domains'));
  assert.deepEqual(shownContext(ctx('domains'), tailnet), ctx('details'), 'not a room: its Details');
  assert.deepEqual(shownContext(ctx('settings'), tailnet), ctx('settings'));
});

test('Back leads where the level was entered from, or to Connections once that is gone', () => {
  const names: Record<string, string> = { m1: 'Alpha' };
  const o = (loaded: boolean) => ({ loaded, machineName: (id: string) => names[id] as string | undefined });
  assert.deepEqual(backOf({ to: 'connections' }, o(true)), { to: 'connections' });
  assert.deepEqual(backOf({ to: 'tab', machine: 'm1' }, o(false)), { to: 'tab', machine: 'm1', name: 'Alpha' });
  assert.deepEqual(backOf({ to: 'tab', machine: 'gone' }, o(true)), { to: 'connections' }, 'a machine deleted since');
  assert.deepEqual(backOf({ to: 'screen' }, o(true)), { to: 'screen' });
  assert.deepEqual(backOf({ to: 'screen' }, o(false)), { to: 'connections' }, 'no machine on the page');
});
