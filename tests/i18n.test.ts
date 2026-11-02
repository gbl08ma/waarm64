// The page's words (docs/i18n.md): messages as data, their rendering, errors across a worker's boundary, and the
// catalog's checks (tools/i18n-check.ts) on small sources.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describe, errorText, marked, parts, plain, said, t, text } from '../web/i18n.ts';
import { devText, fromWire, msg, msgOf, MsgError, toWire } from '../web/msg.ts';
import { checkDoc, checkSources, checkTests, loneLine, stemOf, varsOf, type Catalogs } from '../tools/i18n-check.ts';
import { words } from './words.ts';
import { CATALOGS } from '../web/messages/en/index.ts';

test('rendering: a key, its parameters, markers', () => {
  assert.equal(t('common:ask.ok'), 'OK');
  assert.equal(text(msg('common:ask.cancel')), 'Cancel');
  assert.deepEqual(parts('Open <b>a disk</b> now'), [{ text: 'Open ' }, { tag: 'b', text: 'a disk' }, { text: ' now' }]);
  assert.deepEqual(parts('no markers'), [{ text: 'no markers' }]);
  assert.equal(plain('Open <b>a disk</b> now'), 'Open a disk now');
  // A parameter's own <…> stays text: only the message's markers cut it.
  const where = marked('folders:FoldersMenu.where', { path: '/mnt/<x>' });
  assert.ok(where.some((p) => p.text.includes('/mnt/<x>')), JSON.stringify(where));
  assert.ok(!where.some((p) => p.tag === 'x' || p.tag === 'dev'), JSON.stringify(where));
});

test('errors: a headline and its causes as details, across postMessage', () => {
  const inner = new Error('the file ends early');
  const e = new MsgError('common:ask.cancel', undefined, { cause: inner });
  assert.equal(e.message, 'common:ask.cancel');
  assert.deepEqual(describe(e), { headline: 'Cancel', details: ['the file ends early'] });
  const wire = structuredClone(toWire(Object.assign(e, { problem: 'snapshot' })));
  const back = fromWire(wire);
  assert.equal(msgOf(back)?.key, 'common:ask.cancel');
  assert.equal((back as Error & { problem?: string }).problem, 'snapshot');
  assert.deepEqual(describe(wire), { headline: 'Cancel', details: ['the file ends early'] });
  assert.equal(errorText(back), 'Cancel\nthe file ends early');
  assert.deepEqual(said('words'), { headline: 'words', details: [] });
  assert.deepEqual(said(msg('common:ask.ok')), { headline: 'OK', details: [] });
  assert.equal(devText(msg('a:b.c', { n: 2, m: msg('a:b.d') })), 'a:b.c {n=2, m=(a:b.d)}');
});

test('the catalog: every entry has its words and a note', () => {
  for (const [ns, c] of Object.entries(CATALOGS)) for (const [k, e] of Object.entries(c)) assert.ok(typeof e.message === 'string' && e.note.length >= 10, `${ns}:${k}`);
});

const CAT: Catalogs = {
  x: {
    'Thing.save': { message: 'Save {{name}}…', note: 'A button that saves the thing named name.' },
    'Thing.files_one': { message: '{{count}} file', note: 'How many files, one.' },
    'Thing.files_other': { message: '{{count}} files', note: 'How many files, more.' },
    'Thing.open': { message: 'Open <b>it</b>', note: 'A sentence with a marker.' },
    'Thing.unused': { message: 'Never named', note: 'An entry no source names.' },
    'Other.elsewhere': { message: 'Where?', note: 'An entry named by the wrong file.' },
  },
};

test('checks: keys, parameters, placement, words outside the catalog', () => {
  const src = (path: string, text: string) => ({ path, text });
  const problems = checkSources(CAT, [
    src('web/app/Thing.svelte', `<script lang="ts">import { t } from '../i18n.ts'; const n = 2;</script>
<p>{t('x:Thing.save', { name: 'a' })} {t('x:Thing.files', { count: n })} {t('x:Thing.save')}</p>
<T k="x:Thing.open" />
<button title="Close it">Plain words</button>
<span>{n ? 'Yes indeed' : t('x:Thing.save', { name: 'b', extra: 1 })}</span>
<span>{t('x:Thing.nope')}</span>
<code>ls -l</code>`),
    src('web/app/thing.ts', `import { t } from '../i18n.ts';
export const k = (code: string) => t(\`x:Thing.\${code}\`);
const a = { label: 'Disks…' };
const b = 'The machine is off: start it first.';
const c = 'The disk is gone'; // i18n-ignore
const w = 'x:Other.elsewhere';
const typo = 'y:thing.save';
throw new Error('The developer said so, at length');`),
  ]);
  const said = problems.map((p) => `${p.path}:${p.line}: ${p.text}`).join('\n');
  const has = (re: RegExp) => assert.match(said, re);
  has(/Thing\.svelte:2: x:Thing\.save: its words use \{\{name\}\}, not given/);
  has(/Thing\.svelte:4: title="Close it"/);
  has(/Thing\.svelte:4: words in the markup: "Plain words"/);
  has(/Thing\.svelte:5: \{…\}: the words "Yes indeed"/);
  has(/Thing\.svelte:5: x:Thing\.save: extra given/);
  has(/Thing\.svelte:6: x:Thing\.nope: no such message/);
  has(/thing\.ts:2: a key built at run time/);
  has(/thing\.ts:3: label: "Disks…"/);
  has(/thing\.ts:4: "The machine is off/);
  has(/x:Thing\.unused: named by no source/);
  has(/x:Other\.elsewhere: named in thing, not in Other/);
  has(/thing\.ts:7: y:thing\.save: no catalog named y/);
  assert.doesNotMatch(said, /files|ls -l|The disk is gone|The developer said so|Thing\.open/);
  assert.equal(stemOf('web/app/ask.svelte.ts'), 'ask');
  assert.deepEqual([...varsOf('{{a}} and {{ b, bytes }}')], ['a', 'b']);
});

test('checks: workers reach no renderer', async () => {
  const { checkWorkers } = await import('../tools/i18n-check.ts');
  const root = '/r';
  const problems = checkWorkers(root, [
    { path: 'web/app/main.ts', text: `import { t } from '../i18n.ts'; new Worker(new URL('./w.ts', import.meta.url), { type: 'module' });` },
    { path: 'web/app/w.ts', text: `import { helper } from './h.ts'; import type { X } from '../i18n.ts';` },
    { path: 'web/app/h.ts', text: `export { t } from '../i18n.ts';` },
    { path: 'web/i18n.ts', text: `import i18next from 'i18next';` },
    { path: 'web/audio.ts', text: `import W from './worklet.ts?worker&url';` },
    { path: 'web/worklet.ts', text: `import { t } from './i18n.ts';` },
  ]);
  assert.equal(problems.length, 2);
  assert.match(problems[1].text, /web\/worklet\.ts → web\/i18n\.ts/);
  assert.match(problems[0].text, /web\/app\/w\.ts → web\/app\/h\.ts → web\/i18n\.ts/);
});

test('checks: the docs quote the page in its words', () => {
  const doc = 'Click [Save a…](ui:x:Thing.save), then [Where](ui:x:Other.elsewhere). **Where?** is quoted; `Where?` is code.\n\nThe **Never named** entry, and [nothing](ui:x:Thing.none).';
  const r = checkDoc(CAT, 'docs/a.md', doc);
  const said = r.problems.map((p) => p.text).join('\n');
  assert.match(said, /\[Where\]\(ui:x:Other\.elsewhere\): the page says "Where\?"/);
  assert.match(said, /"Never named" quotes the page: write it as \[Never named\]\(ui:x:Thing\.unused\)/);
  assert.match(said, /\[nothing\]\(ui:x:Thing\.none\): no such message/);
  assert.doesNotMatch(said, /Save a/);
  const fixed = checkDoc(CAT, 'docs/a.md', doc, true).fixed!;
  assert.match(fixed, /\[Where\?\]\(ui:x:Other\.elsewhere\)/);
  assert.match(fixed, /`Where\?` is code/);
});

test('checks: tests take the page\'s words from the catalog', () => {
  const cat: Catalogs = { x: {
    'Thing.retry': { message: 'Retry', note: 'A button.' },
    'Thing.saved': { message: 'Saved the snapshot {{name}} ({{size, bytes}})', note: 'A message bar line.' },
    'Thing.long': { message: 'The machine stops while the file is written', note: 'A note.' },
    'Thing.state': { message: 'running', note: 'A state.' },
  } };
  const problems = checkTests(cat, [{ path: 'tests/a.test.ts', text: `test('Retry after a failure', async () => {
  await page.getByRole('button', { name: 'Retry' }).click();
  assert.match(bar, /^Saved the snapshot /);
  assert.equal(bar, \`Saved the snapshot \${name} (1 MiB)\`);
  assert.match(note, /stops while the file is written/);
  assert.equal(state, 'running');
  assert.ok(x, 'Retry later: Saved the snapshot');
  assert.equal(peer, 'Retry'); // i18n-ignore
  assert.match(note, /the file/);
  assert.match(unit, /^Description=The machine stops while the file is written$/m);
});
test('wording: the button says Retry', () => { assert.equal(label, 'Retry'); });` }]);
  assert.deepEqual(problems.map((p) => p.line), [2, 3, 4, 5, 10]);
  assert.match(problems[0].text, /'Retry' says the page's words \(x:Thing\.retry\)/);
  // The helper: a message's words with the parameters given, the others any text.
  assert.equal(words('common:ask.ok', {}, { whole: true }).source, '^OK$');
  assert.match(t('snapshots:main.saved', { name: 'a', size: 2 ** 20, seconds: 1 }), words('snapshots:main.saved', { name: 'a' }, { start: true }));
  assert.doesNotMatch(t('snapshots:main.saved', { name: 'a', size: 2 ** 20, seconds: 1 }), words('snapshots:main.saved', { name: 'b' }));
});

const CAT2: Catalogs = {
  x: {
    'Thing.save': { message: 'Save {{name}}', note: 'A button that saves the thing named name.' },
    'Thing.plain': { message: 'Plain words here', note: 'A message with no parameters.' },
    'Thing.failed': { message: "Couldn't save {{name}}\nThe disk is full.", note: 'An error headline and its cause in one message.' },
    'Thing.tip': { message: '{{name}}\n{{about}}', note: 'A tooltip: a name, then what it is.' },
    'Thing.notice': { message: 'Saved {{name}}.\nThe guest slept.', note: 'A notice of two sentences.' },
  },
};
const said2 = (problems: { path: string; line: number; text: string }[]) => problems.map((p) => `${p.path}:${p.line}: ${p.text}`).join('\n');

test('checks: an error written as one message (a headline and a line under it)', () => {
  const said = said2(checkSources(CAT2, [{ path: 'web/app/Thing.ts', text: `t('x:Thing.save', { name }); t('x:Thing.plain'); t('x:Thing.failed', { name }); t('x:Thing.tip', { name, about }); t('x:Thing.notice', { name });` }]));
  assert.match(said, /x:Thing\.failed: a headline and a line under it in one message/);
  assert.doesNotMatch(said, /Thing\.(tip|notice|save|plain): a headline/);
  assert.equal(loneLine("Couldn't start {{name}}\nIt's running in another tab."), true);
  assert.equal(loneLine('{{name}}\n{{about}}\nDrag it.'), false);
  assert.equal(loneLine('This machine needs about {{need}} GiB.\n{{advice}}'), false);
  assert.equal(loneLine('\nThe file itself remains on your computer.'), false);
});

test('checks: parameters through a map, a constant, a conditional, undefined', () => {
  const said = said2(checkSources(CAT2, [{ path: 'web/app/Thing.ts', text: `const WORDS = { a: 'x:Thing.save', b: 'x:Thing.plain' };
const PAIRS: Record<string, [string, number]> = { a: ['x:Thing.save', 1] };
export const f1 = (k: 'a' | 'b') => t(WORDS[k]);
export function f2(k: string) { const [key, tone] = PAIRS[k] ?? ['', 0]; return key ? t(key, { nam: tone }) : ''; }
export const f3 = (c: boolean) => t('x:Thing.save', c ? { name: 1 } : {});
const p = { name: 1, more: 2 };
export const f4 = () => t('x:Thing.save', p);
export const f5 = (c: boolean) => t(c ? 'x:Thing.save' : 'x:Thing.plain', c ? { name: 1 } : undefined);
export const f6 = () => new MsgError('x:Thing.save', undefined, { cause: 1 });
export const f7 = (params: object) => t('x:Thing.save', params);
export const f8 = (c: boolean) => t(WORDS.b, c ? { ...p } : { name: 2 });
export const f9 = () => t('x:Thing.tip', { name: 1, about: 2 }) + t('x:Thing.failed', { name: 1 }) + t('x:Thing.notice', { name: 1 });` }]));
  const has = (re: RegExp) => assert.match(said, re);
  has(/Thing\.ts:3: x:Thing\.save: its words use \{\{name\}\}, not given \(the key through WORDS\[k\]\)/);
  has(/Thing\.ts:4: x:Thing\.save: its words use \{\{name\}\}, not given \(the key through key\)/);
  has(/Thing\.ts:4: x:Thing\.save: nam given/);
  has(/Thing\.ts:5: x:Thing\.save: its words use \{\{name\}\}, not given/);
  has(/Thing\.ts:7: x:Thing\.save: more given/);
  has(/Thing\.ts:9: x:Thing\.save: its words use \{\{name\}\}, not given/);
  has(/Thing\.ts:11: x:Thing\.plain: name, more given/);
  assert.doesNotMatch(said, /Thing\.ts:(8|10|12):|Thing\.ts:3: x:Thing\.plain/);
});

test('checks: copy in lower case, with a semicolon or after a field', () => {
  const said = said2(checkSources(CAT2, [{ path: 'web/app/thing.ts', text: `export const a = 'the machine stops while the file is written.';
export const b = 'The sky is blue; roses are red.';
export const c = 'Description=The emulator keeps the layout here';
export const d = 'color: red; margin: 0';
export const e = 'a compressed cluster does not unpack';
export const f = 'KEY=value';
export const g = 'one two three four.';
export const h = 'Set it; then: x';` }]));
  assert.match(said, /thing\.ts:1: "the machine stops while the file is written\." reads as words/);
  assert.match(said, /thing\.ts:2: "The sky is blue; roses are red\." reads as words/);
  assert.match(said, /thing\.ts:3: "Description=The emulator/);
  assert.doesNotMatch(said, /thing\.ts:[4-8]:/);
});

test("checks: a doc's quote broken across two lines", () => {
  const doc = 'A **Plain\n  words here** quote, and [Wrong\n  words](ui:x:Thing.plain), and [Plain words\nhere](ui:x:Thing.plain).';
  const said = checkDoc(CAT2, 'docs/a.md', doc).problems.map((p) => `${p.line}: ${p.text}`).join('\n');
  assert.match(said, /1: "Plain words here" quotes the page: write it as \[Plain words here\]\(ui:x:Thing\.plain\)/);
  assert.match(said, /2: \[Wrong words\]\(ui:x:Thing\.plain\): the page says "Plain words here"/);
  assert.doesNotMatch(said, /3:/);
  assert.match(checkDoc(CAT2, 'docs/a.md', doc, true).fixed!, /\[Plain words here\]\(ui:x:Thing\.plain\), and/);
});

test("checks: a caught error's .message shown to the user", () => {
  const said = said2(checkSources(CAT2, [{ path: 'web/app/thing.ts', text: `export async function f(p: Promise<void>, c: boolean) {
  try { await p; } catch (e) { notify((e as Error).message); }
  await p.catch((err) => setState('failed', \`it failed: \${String(err.message)}\`));
  try { await p; } catch (e) { t('x:Thing.save', { name: (e as Error).message }); }
  try { await p; } catch (e) { ui.message = c ? e.message : ''; }
  try { await p; } catch (e) { notify(msgOf(e) ?? (e as Error).message); }
  try { await p; } catch (e) { console.error(e.message); throw new Error(e.message); }
  document.body.onclick = (e) => notify(e.message);
  try { await p; } catch (e) { const keep = (e as Error).message; return keep; }
  try { await p; } catch (e) { notify(e.message); } // i18n-ignore
}` }, { path: 'web/app/Thing.svelte', text: `<script lang="ts">let error = $state(''); let other = ''; async function g(p: Promise<void>) { try { await p; } catch (e) { error = (e as Error).message; other = (e as Error).message; } }</script>
<p>{error}{t('x:Thing.plain')}{t('x:Thing.save', { name: 1 })}{t('x:Thing.failed', { name: 1 })}{t('x:Thing.tip', { name: 1, about: 2 })}{t('x:Thing.notice', { name: 1 })}</p>` }]));
  const has = (re: RegExp) => assert.match(said, re);
  has(/thing\.ts:2: e\.message is shown \(notify\(…\)\)/);
  has(/thing\.ts:3: err\.message is shown \(setState\(…\)\)/);
  has(/thing\.ts:4: e\.message is a message's parameter \(t\(…, \{ name: … \}\)\)/);
  has(/thing\.ts:5: e\.message is shown \(ui\.message = …\)/);
  has(/Thing\.svelte:1: e\.message is shown \(error, in the markup\)/);
  assert.doesNotMatch(said, /thing\.ts:([6-9]|10):|other/);
});
