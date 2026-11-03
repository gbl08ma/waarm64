// THIRD_PARTY.json (docs/third-party.md) and what the About pane takes of it (tools/third-party.ts): the file checks
// out; only rows marked `about` reach the pane, merged by project; the checks catch a row the pane can't show (no
// license text, a link to a branch); the pane's data links the license files where the dev server and the static
// copy serve them; the build's commit is the checkout's.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { aboutData, aboutGroups, BUNDLED, load, markdown, problems, type ThirdParty } from '../tools/third-party.ts';

const doc = load();

test('THIRD_PARTY.json checks out', () => {
  assert.deepEqual(problems(doc), []);
});

test('the About pane shows the rows marked for it and nothing else', () => {
  const marked = new Set(doc.sections.flatMap((s) => s.entries.filter((e) => e.about).flatMap((e) => (e.parts ?? [e]).map((p) => p.name))));
  const shown = aboutGroups(doc).flatMap((g) => g.projects.map((p) => p.name));
  assert.deepEqual(new Set(shown), marked);
  // Tools, tests, oracles and references stay out: none of these rows has `about`.
  for (const name of ['playwright-core', 'QEMU', 'CoreMark', 'Linux kernel', 'Sintel trailer', 'v86']) assert.ok(!shown.includes(name), name);
  for (const s of doc.sections.filter((s) => ['dev', 'workloads', 'media', 'references-permissive', 'references-copyleft', 'techniques', 'go-net-tailscale'].includes(s.id))) {
    for (const e of s.entries) if (s.id !== 'workloads' || e.id !== 'venus-module') assert.equal(e.about, undefined, `${s.id}: ${e.id}`);
  }
});

test('rows of one project merge: derived from the derived-code table, their license texts and licenses joined', () => {
  const tiny: ThirdParty = { sections: [
    { id: 'derived', title: 'D', intro: [], columns: [{ key: 'a', title: 'A' }], entries: [
      { id: 'x1', name: 'X', about: 'core', url: 'https://x', version: '1', license: 'MIT', licenseTexts: [{ name: 'L', url: 'https://x/blob/v1/L' }], md: { a: '' } },
    ] },
    { id: 'npm', title: 'N', intro: [], columns: [{ key: 'a', title: 'A' }], entries: [
      { id: 'x2', name: 'X', about: 'core', bundled: 'EDK2-LICENSES.txt', parts: [{ name: 'X', url: 'https://x', version: '1', license: 'MIT AND BSL-1.0', licenseTexts: [{ name: 'B', url: 'https://x/blob/v1/B' }] }], md: { a: '' } },
      { id: 'y', name: 'Y', md: { a: '' } },
    ] },
  ] };
  assert.deepEqual(problems(tiny), []);
  assert.deepEqual(aboutGroups(tiny), [{ group: 'core', bundled: ['EDK2-LICENSES.txt'], projects: [
    { name: 'X', url: 'https://x', version: '1', license: 'MIT AND BSL-1.0', derived: true, licenseTexts: [{ name: 'L', url: 'https://x/blob/v1/L' }, { name: 'B', url: 'https://x/blob/v1/B' }] },
  ] }]);
});

test('the checks: a row the pane shows needs a pinned license text, a version and an SPDX license', () => {
  const row = { id: 'z', name: 'Z', about: 'page' as const, url: 'https://z', version: '1', license: 'MIT', licenseTexts: [{ name: 'L', url: 'https://github.com/z/z/blob/main/LICENSE' }], md: { a: '' } };
  const one = (e: object): ThirdParty => ({ sections: [{ id: 's', title: 'S', intro: [], columns: [{ key: 'a', title: 'A' }], entries: [e as never] }] });
  assert.match(problems(one(row)).join('\n'), /isn't pinned/);
  assert.match(problems(one({ ...row, licenseTexts: [] })).join('\n'), /no licenseTexts/);
  assert.match(problems(one({ ...row, version: undefined })).join('\n'), /no version/);
  assert.match(problems(one({ ...row, license: 'MIT, mostly' })).join('\n'), /SPDX/);
  assert.match(problems(one({ ...row, about: 'elsewhere' })).join('\n'), /about must be/);
  assert.match(problems(one({ ...row, md: {} })).join('\n'), /no md\.a/);
  assert.match(problems(one({ ...row, bundled: 'X.txt' })).join('\n'), /BUNDLED/);
  // A row the pane doesn't show needs only its id, name and cells.
  assert.deepEqual(problems(one({ id: 'w', name: 'W', md: { a: 'text' } })), []);
});

test('the Markdown rendering has every row', () => {
  const md = markdown(doc);
  const rows = md.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| ---'));
  const headers = doc.sections.length;
  assert.equal(rows.length - headers, doc.sections.reduce((n, s) => n + s.entries.length, 0));
});

test('the pane\'s data: the build\'s commit, the license files where the dev server or the copy has them', () => {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const dev = aboutData({ build: false });
  const copy = aboutData({ build: true });
  assert.equal(dev.build?.commit, head);
  assert.equal(dev.repository, 'https://github.com/gbl08ma/webpc');
  assert.equal(dev.licenseHref, '/LICENSE');
  assert.equal(copy.licenseHref, './LICENSE');
  const files = (a: typeof dev) => a.groups.flatMap((g) => g.bundled);
  for (const f of files(dev)) assert.equal(f.href, `/${BUNDLED[f.name]}`);
  for (const f of files(copy)) assert.equal(f.href, `./${f.name}`);
  // Vite writes the bundled packages' licenses into the copy only.
  assert.ok(files(copy).some((f) => f.name === 'THIRD-PARTY-LICENSES.md'));
  assert.ok(!files(dev).some((f) => f.name === 'THIRD-PARTY-LICENSES.md'));
  // Nothing but the pane's rows goes to the page: no row's Markdown, no row the pane doesn't show.
  assert.doesNotMatch(JSON.stringify(dev), /"md"|playwright|QEMU/);
});
