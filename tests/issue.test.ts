// tools/issue.ts against a fake GitHub (no network, nothing touches the real repo): the label set checks out; labels
// outside it are refused, an issue takes exactly one kind, a sub-area brings its parent, priorities need --triage;
// list pages, leaves pull requests out and finds the untriaged; search scopes to the repo; the label sync's plan.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type Api, closeIssue, editIssue, fileIssue, type Issue, type LabelSet, labelPlan, line, lintLabels, listIssues, loadLabels, repoOf, resolveLabels, searchIssues,
} from '../tools/issue.ts';

const set: LabelSet = {
  labels: [
    { name: 'bug', group: 'kind', color: 'd73a4a', description: 'b' },
    { name: 'perf', group: 'kind', color: 'fbca04', description: 'p' },
    { name: 'network', group: 'area', color: '1d76db', description: 'n' },
    { name: 'network-p2p', group: 'area', color: '1d76db', description: 'n', parent: 'network' },
    { name: 'network-p2p-domains', group: 'area', color: '1d76db', description: 'n', parent: 'network-p2p' },
    { name: 'page', group: 'area', color: '1d76db', description: 'p' },
    { name: 'upstream', group: 'modifier', color: '5319e7', description: 'u' },
    { name: 'priority:high', group: 'priority', color: 'b60205', description: 'h' },
    { name: 'priority:low', group: 'priority', color: 'ededed', description: 'l' },
  ],
};

/** An in-memory GitHub: issues by number, the calls made. */
function fake() {
  const issues = new Map<number, Issue>();
  const calls: string[] = [];
  const api: Api = (method, path, body) => {
    calls.push(`${method} ${path}`);
    const b = body as Record<string, unknown> | undefined;
    const url = new URL(path, 'https://api.example/');
    const m = /^\/repos\/o\/r\/issues(?:\/(\d+))?(\/comments)?$/.exec(url.pathname);
    if (method === 'POST' && m && !m[1]) {
      const n = issues.size + 1;
      const i: Issue = { number: n, title: String(b!.title), body: String(b!.body), state: 'open', html_url: `https://github.com/o/r/issues/${n}`, labels: (b!.labels as string[]).map((name) => ({ name })) };
      issues.set(n, i);
      return i;
    }
    if (m?.[2]) return { html_url: 'c' };
    if (m?.[1]) {
      const i = issues.get(Number(m[1]))!;
      if (method === 'PATCH') {
        if (b!.labels) i.labels = (b!.labels as string[]).map((name) => ({ name }));
        Object.assign(i, Object.fromEntries(Object.entries(b!).filter(([k]) => k !== 'labels')));
      }
      return i;
    }
    if (m && method === 'GET') {
      const want = url.searchParams.get('labels')?.split(',') ?? [];
      const page = Number(url.searchParams.get('page'));
      const all = [...issues.values()].filter((i) => want.every((w) => i.labels.some((l) => l.name === w)));
      return all.slice((page - 1) * 100, page * 100);
    }
    if (url.pathname === '/search/issues') return { items: [...issues.values()].slice(0, 1) };
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { issues, calls, ops: { api, repo: 'o/r', set } };
}

test("the repo's label set checks out", () => {
  assert.deepEqual(lintLabels(loadLabels()), []);
});

test('the label checks catch bad sets', () => {
  const bad: LabelSet = { labels: [
    { name: 'bug', group: 'kind', color: 'D73A4A', description: 'x' },
    { name: 'bug', group: 'kind', color: 'd73a4a', description: 'x' },
    { name: 'net-p2p', group: 'area', color: '1d76db', description: 'x', parent: 'network' },
    { name: 'kind:flake', group: 'kind', color: '1d76db', description: 'x' },
    { name: 'high', group: 'priority', color: '1d76db', description: 'x' },
    { name: 'upstream', group: 'modifier', color: '1d76db', description: 'x', parent: 'bug' },
  ] };
  assert.deepEqual(lintLabels(bad), [
    'bug: color "D73A4A" is not six lowercase hex digits',
    'bug: listed twice',
    'kind:flake: only priorities have a prefix',
    'high: a priority\'s name starts with "priority:"',
    'net-p2p: parent "network" is not in the set',
    'upstream: only areas have a parent',
  ]);
});

test('a sub-area brings its parents; labels come out in the set order', () => {
  assert.deepEqual(resolveLabels(set, [], ['page', 'network-p2p-domains', 'bug'], [], false), ['bug', 'network', 'network-p2p', 'network-p2p-domains', 'page']);
});

test('labels outside the set, no kind or two kinds, and an untriaged priority are refused', () => {
  assert.throws(() => resolveLabels(set, [], ['bug', 'tailnet'], [], false), /"tailnet" is not in \.github\/labels\.json/);
  assert.throws(() => resolveLabels(set, [], ['network'], [], false), /exactly one kind.*none/);
  assert.throws(() => resolveLabels(set, [], ['bug', 'perf'], [], false), /exactly one kind.*bug, perf/);
  assert.throws(() => resolveLabels(set, [], ['bug', 'priority:high'], [], false), /triage only/);
  assert.deepEqual(resolveLabels(set, [], ['bug', 'priority:high'], [], true), ['bug', 'priority:high']);
  assert.throws(() => resolveLabels(set, ['bug', 'priority:low'], ['priority:high'], [], true), /at most one priority/);
});

test("removing a parent its sub-area keeps is refused; labels set by hand on GitHub are kept", () => {
  assert.throws(() => resolveLabels(set, ['bug', 'network', 'network-p2p'], [], ['network'], false), /parent of "network-p2p"/);
  assert.deepEqual(resolveLabels(set, ['bug', 'network', 'network-p2p', 'wip'], [], ['network-p2p', 'network'], false), ['bug', 'wip']);
});

test('filing and editing go through REST with the resolved labels', () => {
  const g = fake();
  const i = fileIssue(g.ops, 'p2p rooms on the page', 'what\n', ['page', 'network-p2p', 'bug']);
  assert.equal(i.number, 1);
  assert.deepEqual(i.labels.map((l) => l.name), ['bug', 'network', 'network-p2p', 'page']);
  assert.throws(() => fileIssue(g.ops, 't', '  \n', ['bug']), /needs a body/);
  editIssue(g.ops, 1, { add: ['perf', 'upstream'], remove: ['bug', 'page'] });
  assert.deepEqual(g.issues.get(1)!.labels.map((l) => l.name), ['perf', 'network', 'network-p2p', 'upstream']);
  closeIssue(g.ops, 1, 'not_planned', 'stale\n');
  assert.equal(g.issues.get(1)!.state, 'closed');
  assert.match(line(set, g.issues.get(1)!), /^#1 \(closed: not_planned\) {2}\[perf network network-p2p upstream\] {2}p2p rooms on the page$/);
  assert.deepEqual(g.calls.filter((c) => !c.startsWith('GET')), ['POST repos/o/r/issues', 'PATCH repos/o/r/issues/1', 'POST repos/o/r/issues/1/comments', 'PATCH repos/o/r/issues/1']);
  assert.throws(() => closeIssue(g.ops, 1, 'fixed'), /completed, not_planned or duplicate/);
});

test('list pages through every issue, leaves pull requests out and finds the untriaged', () => {
  const g = fake();
  for (let k = 0; k < 230; k++) fileIssue(g.ops, `t${k}`, 'b', k % 2 ? ['bug', 'page'] : ['perf'], true);
  g.issues.get(7)!.pull_request = {};
  editIssue(g.ops, 3, { add: ['priority:high'], triage: true });
  assert.equal(listIssues(g.ops, {}).length, 229);
  assert.equal(listIssues(g.ops, { labels: ['page'] }).length, 115);
  assert.equal(listIssues(g.ops, { labels: ['perf'], limit: 5 }).length, 5);
  const untriaged = listIssues(g.ops, { untriaged: true });
  assert.equal(untriaged.length, 228);
  assert.ok(!untriaged.some((i) => i.number === 3));
  assert.ok(g.calls.some((c) => c.includes('page=3')));
});

test('search is scoped to the repo and to issues', () => {
  const g = fake();
  fileIssue(g.ops, 't', 'b', ['bug']);
  searchIssues(g.ops, 'tailnet relay', 'open', 10);
  const q = new URL(g.calls.at(-1)!.slice(4), 'https://x/').searchParams.get('q');
  assert.equal(q, 'repo:o/r is:issue is:open tailnet relay');
});

test("the repo comes from origin's URL in any of its forms", () => {
  assert.equal(repoOf('git@github.com:gbl08ma/waarm64.git\n'), 'gbl08ma/waarm64');
  assert.equal(repoOf('https://github.com/gbl08ma/waarm64'), 'gbl08ma/waarm64');
  assert.equal(repoOf('http://local_proxy@127.0.0.1:41234/git/gbl08ma/waarm64'), 'gbl08ma/waarm64');
});

test("the label sync's plan creates, updates and deletes against the set", () => {
  const plan = labelPlan(set, [
    { name: 'bug', color: 'd73a4a', description: 'b' },
    { name: 'perf', color: '000000', description: 'p' },
    { name: 'good first issue', color: '7057ff', description: 'Good for newcomers' },
  ]);
  assert.deepEqual(plan.create.map((l) => l.name), ['network', 'network-p2p', 'network-p2p-domains', 'page', 'upstream', 'priority:high', 'priority:low']);
  assert.deepEqual(plan.update.map((l) => l.name), ['perf']);
  assert.deepEqual(plan.remove, ['good first issue']);
});
