// tools/issue.ts against a fake GitHub (no network, nothing touches the real repo): the label set checks out; labels,
// types and priorities outside it are refused, an issue takes exactly one type, a sub-area brings its parent, the
// Priority field is set only in triage; list pages and leaves pull requests out, and goes through advanced search for
// priorities and the untriaged; search is scoped to the repo; the label sync's plan.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type Api, closeIssue, editIssue, fileIssue, type Issue, type LabelSet, labelPlan, line, lintLabels, listIssues, loadLabels, priorityOf, repoOf, resolveLabels, resolvePriority,
  resolveType, searchIssues, searchQuery,
} from '../tools/issue.ts';

const FIELD = 77;
const set: LabelSet = {
  types: [{ name: 'Bug', description: 'b' }, { name: 'Performance', description: 'p' }],
  priority: { field_id: FIELD, options: ['High', 'Low'] },
  labels: [
    { name: 'network', group: 'area', color: '1d76db', description: 'n' },
    { name: 'network-p2p', group: 'area', color: '1d76db', description: 'n', parent: 'network' },
    { name: 'network-p2p-domains', group: 'area', color: '1d76db', description: 'n', parent: 'network-p2p' },
    { name: 'page', group: 'area', color: '1d76db', description: 'p' },
    { name: 'upstream', group: 'modifier', color: '5319e7', description: 'u' },
  ],
};

/** An in-memory GitHub: issues by number, the calls made; search answers with every issue (its query is checked apart). */
function fake() {
  const issues = new Map<number, Issue>();
  const calls: string[] = [];
  const api: Api = (method, path, body) => {
    calls.push(`${method} ${path}`);
    const b = body as Record<string, unknown> | undefined;
    const url = new URL(path, 'https://api.example/');
    const m = /^\/repos\/o\/r\/issues(?:\/(\d+))?(\/comments|\/issue-field-values(?:\/(\d+))?)?$/.exec(url.pathname);
    if (method === 'POST' && m && !m[1]) {
      const n = issues.size + 1;
      const i: Issue = { number: n, title: String(b!.title), type: { name: String(b!.type) }, issue_field_values: [], body: String(b!.body), state: 'open', html_url: `https://github.com/o/r/issues/${n}`, labels: (b!.labels as string[]).map((name) => ({ name })) };
      issues.set(n, i);
      return i;
    }
    if (m?.[2] === '/comments') return { html_url: 'c' };
    if (m?.[2]?.startsWith('/issue-field-values')) {
      const i = issues.get(Number(m[1]))!;
      if (method === 'POST') {
        const v = (b!.issue_field_values as { field_id: number; value: string }[])[0];
        i.issue_field_values = [{ issue_field_id: v.field_id, single_select_option: { name: v.value } }];
      }
      if (method === 'DELETE') i.issue_field_values = i.issue_field_values!.filter((f) => f.issue_field_id !== Number(m[3]));
      return i.issue_field_values;
    }
    if (m?.[1]) {
      const i = issues.get(Number(m[1]))!;
      if (method === 'PATCH') {
        if (b!.labels) i.labels = (b!.labels as string[]).map((name) => ({ name }));
        if (b!.type) i.type = { name: String(b!.type) };
        Object.assign(i, Object.fromEntries(Object.entries(b!).filter(([k]) => k !== 'labels' && k !== 'type')));
      }
      return i;
    }
    const page = Number(url.searchParams.get('page'));
    if (m && method === 'GET') {
      const want = url.searchParams.get('labels')?.split(',') ?? [];
      const type = url.searchParams.get('type');
      const all = [...issues.values()].filter((i) => want.every((w) => i.labels.some((l) => l.name === w)) && (!type || i.type?.name === type));
      return all.slice((page - 1) * 100, page * 100);
    }
    if (url.pathname === '/search/issues') return { items: [...issues.values()].slice((page - 1) * 100, page * 100) };
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { issues, calls, ops: { api, repo: 'o/r', set } };
}

const lastQuery = (calls: string[]) => new URL(calls.at(-1)!.slice(4), 'https://x/').searchParams;

test("the repo's label set checks out", () => {
  assert.deepEqual(lintLabels(loadLabels()), []);
});

test('the label checks catch bad sets', () => {
  const bad: LabelSet = { types: [{ name: 'Bug', description: 'x' }, { name: 'bug', description: '' }], priority: { field_id: 1, options: ['High', 'NONE'] }, labels: [
    { name: 'jit', group: 'area', color: 'D73A4A', description: 'x' },
    { name: 'jit', group: 'area', color: 'd73a4a', description: 'x' },
    { name: 'net-p2p', group: 'area', color: '1d76db', description: 'x', parent: 'network' },
    { name: 'priority:high', group: 'modifier', color: '1d76db', description: 'x' },
    { name: 'upstream', group: 'modifier', color: '1d76db', description: 'x', parent: 'jit' },
    { name: 'bug', group: 'modifier', color: '1d76db', description: 'x' },
  ] };
  assert.deepEqual(lintLabels(bad), [
    'type bug: listed twice',
    'type bug: needs a description',
    '"none" clears a priority: not an option',
    'jit: color "D73A4A" is not six lowercase hex digits',
    'jit: listed twice',
    'priority:high: no prefixes (priorities are a field)',
    'bug: a type\'s name, not a label',
    'net-p2p: parent "network" is not in the set',
    'upstream: only areas have a parent',
  ]);
  assert.deepEqual(lintLabels({ ...set, priority: { field_id: 0.5, options: [] } }), ['the Priority field needs its field_id and options']);
});

test('a sub-area brings its parents; labels come out in the set order', () => {
  assert.deepEqual(resolveLabels(set, [], ['page', 'network-p2p-domains'], []), ['network', 'network-p2p', 'network-p2p-domains', 'page']);
});

test('labels, types and priorities outside the set, no type, and a priority outside triage are refused', () => {
  assert.throws(() => resolveLabels(set, [], ['page', 'tailnet'], []), /"tailnet" is not in \.github\/labels\.json/);
  assert.throws(() => resolveType(set, undefined), /exactly one type \(--type Bug\|Performance\)/);
  assert.throws(() => resolveType(set, 'Flake'), /not "Flake"/);
  assert.equal(resolveType(set, 'performance'), 'Performance');
  assert.throws(() => resolvePriority(set, 'High', false), /triage only/);
  assert.throws(() => resolvePriority(set, 'Urgent', true), /High, Low or none, not "Urgent"/);
  assert.equal(resolvePriority(set, 'high', true), 'High');
  assert.equal(resolvePriority(set, 'NONE', true), null);
});

test("removing a parent its sub-area keeps is refused; labels set by hand on GitHub are kept", () => {
  assert.throws(() => resolveLabels(set, ['network', 'network-p2p'], [], ['network']), /parent of "network-p2p"/);
  assert.deepEqual(resolveLabels(set, ['page', 'network', 'network-p2p', 'wip'], [], ['network-p2p', 'network']), ['page', 'wip']);
});

test('filing and editing go through REST with the resolved type, labels and priority', () => {
  const g = fake();
  const i = fileIssue(g.ops, { title: 'p2p rooms on the page', body: 'what\n', type: 'bug', labels: ['page', 'network-p2p'] });
  assert.equal(i.number, 1);
  assert.equal(i.type?.name, 'Bug');
  assert.equal(priorityOf(set, i), null);
  assert.deepEqual(i.labels.map((l) => l.name), ['network', 'network-p2p', 'page']);
  assert.throws(() => fileIssue(g.ops, { title: 't', body: '  \n', type: 'Bug', labels: [] }), /needs a body/);
  assert.throws(() => fileIssue(g.ops, { title: 't', body: 'b', type: '', labels: ['page'] }), /exactly one type/);
  assert.throws(() => fileIssue(g.ops, { title: 't', body: 'b', type: 'Bug', labels: [], priority: 'High' }), /triage only/);
  assert.equal(g.issues.size, 1, 'a refused issue is never filed');
  editIssue(g.ops, 1, { type: 'Performance', add: ['upstream'], remove: ['page'], priority: 'low', triage: true });
  assert.equal(g.issues.get(1)!.type?.name, 'Performance');
  assert.equal(priorityOf(set, g.issues.get(1)!), 'Low');
  assert.deepEqual(g.issues.get(1)!.labels.map((l) => l.name), ['network', 'network-p2p', 'upstream']);
  closeIssue(g.ops, 1, 'not_planned', 'stale\n');
  assert.equal(g.issues.get(1)!.state, 'closed');
  assert.match(line(set, g.issues.get(1)!), /^#1 \(closed: not_planned\) {2}Performance {2}Low {2}\[network network-p2p upstream\] {2}p2p rooms on the page$/);
  assert.deepEqual(g.calls.filter((c) => !c.startsWith('GET')), [
    'POST repos/o/r/issues', 'POST repos/o/r/issues/1/issue-field-values', 'PATCH repos/o/r/issues/1', 'POST repos/o/r/issues/1/comments', 'PATCH repos/o/r/issues/1',
  ]);
  assert.throws(() => closeIssue(g.ops, 1, 'fixed'), /completed, not_planned or duplicate/);
});

test('a priority alone is an edit; none clears it', () => {
  const g = fake();
  fileIssue(g.ops, { title: 't', body: 'b', type: 'Bug', labels: [], priority: 'High', triage: true });
  assert.equal(priorityOf(set, g.issues.get(1)!), 'High');
  editIssue(g.ops, 1, { priority: 'none', triage: true });
  assert.equal(priorityOf(set, g.issues.get(1)!), null);
  assert.ok(g.calls.includes(`DELETE repos/o/r/issues/1/issue-field-values/${FIELD}`));
  assert.throws(() => editIssue(g.ops, 1, {}), /nothing to change/);
});

test('list pages through every issue and leaves pull requests out; priorities and the untriaged go through advanced search', () => {
  const g = fake();
  for (let k = 0; k < 230; k++) fileIssue(g.ops, { title: `t${k}`, body: 'b', type: k % 2 ? 'Bug' : 'Performance', labels: k % 2 ? ['page'] : [] });
  g.issues.get(7)!.pull_request = {};
  assert.equal(listIssues(g.ops, {}).length, 229);
  assert.equal(listIssues(g.ops, { labels: ['page'] }).length, 115);
  assert.equal(listIssues(g.ops, { type: 'performance', limit: 5 }).length, 5);
  assert.ok(g.calls.some((c) => c.includes('page=3')));
  listIssues(g.ops, { untriaged: true, labels: ['page'] });
  let q = lastQuery(g.calls);
  assert.equal(q.get('q'), 'repo:o/r is:issue is:open label:"page" no:field.priority');
  assert.equal(q.get('advanced_search'), 'true');
  listIssues(g.ops, { priority: ['high', 'Low'], type: 'bug', state: 'all' });
  q = lastQuery(g.calls);
  assert.equal(q.get('q'), 'repo:o/r is:issue type:"Bug" field.priority:"High","Low"');
  assert.throws(() => searchQuery(g.ops, { priority: ['none'] }), /--untriaged/);
});

test('search is scoped to the repo and to issues', () => {
  const g = fake();
  fileIssue(g.ops, { title: 't', body: 'b', type: 'Bug', labels: [] });
  searchIssues(g.ops, { words: 'tailnet relay', type: 'bug', priority: ['low'], limit: 10 });
  assert.equal(lastQuery(g.calls).get('q'), 'repo:o/r is:issue is:open type:"Bug" field.priority:"Low" tailnet relay');
});

test("the repo comes from origin's URL in any of its forms", () => {
  assert.equal(repoOf('git@github.com:gbl08ma/waarm64.git\n'), 'gbl08ma/waarm64');
  assert.equal(repoOf('https://github.com/gbl08ma/waarm64'), 'gbl08ma/waarm64');
  assert.equal(repoOf('http://local_proxy@127.0.0.1:41234/git/gbl08ma/waarm64'), 'gbl08ma/waarm64');
});

test("the label sync's plan creates, updates and deletes against the set", () => {
  const plan = labelPlan(set, [
    { name: 'network', color: '1d76db', description: 'n' },
    { name: 'page', color: '000000', description: 'p' },
    { name: 'priority:high', color: 'b60205', description: 'h' },
  ]);
  assert.deepEqual(plan.create.map((l) => l.name), ['network-p2p', 'network-p2p-domains', 'upstream']);
  assert.deepEqual(plan.update.map((l) => l.name), ['page']);
  assert.deepEqual(plan.remove, ['priority:high']);
});
