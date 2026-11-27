// The backlog's issues on GitHub (docs/issues.md): filing, editing, commenting, closing, listing and searching, through
// GitHub's REST API only (`gh api`): cloud sessions' proxy refuses GraphQL, so `gh issue …` fails there. The label set
// is .github/labels.json: this tool refuses a label missing from it, gives an issue exactly one kind, adds a sub-area's
// parent, and sets a priority only with --triage.
//   node tools/issue.ts file --title T --label jit,perf [--body-file F | < body]   prints "#n <url>"
//   node tools/issue.ts edit N [--title T] [--body-file F] [--add-label a,b] [--remove-label c] [--triage]
//   node tools/issue.ts comment N [--body-file F | < body]
//   node tools/issue.ts close N [--reason completed|not_planned|duplicate] [--comment-file F]
//   node tools/issue.ts reopen N
//   node tools/issue.ts show N [--comments]
//   node tools/issue.ts list [--label a,b] [--state open|closed|all] [--untriaged] [--limit K] [--json]
//   node tools/issue.ts search "words" [--state open|closed|all] [--limit K] [--json]
//   node tools/issue.ts labels [--lint | --diff | --sync [--apply]]   the set; its checks; the repo against it
// `labels --sync --apply` changes the repo's labels: the user runs it, agents never (docs/issues.md "Labels").
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const LABELS_FILE = `${ROOT}.github/labels.json`;

export const GROUPS = ['area', 'kind', 'modifier', 'priority'] as const;
export type Group = (typeof GROUPS)[number];
export type Label = { name: string; group: Group; color: string; description: string; parent?: string };
export type LabelSet = { labels: Label[] };

/** A REST call: the method, the path under api.github.com, a JSON body. Resolves to the parsed response (or null). */
export type Api = (method: string, path: string, body?: unknown) => unknown;

export function loadLabels(file = LABELS_FILE): LabelSet {
  return JSON.parse(readFileSync(file, 'utf8')) as LabelSet;
}

/** What's wrong with a label set: duplicate names, unknown groups, bad colors, parents missing or not areas. */
export function lintLabels(set: LabelSet): string[] {
  const out: string[] = [];
  const byName = new Map<string, Label>();
  for (const l of set.labels) {
    if (byName.has(l.name)) out.push(`${l.name}: listed twice`);
    byName.set(l.name, l);
    if (!GROUPS.includes(l.group)) out.push(`${l.name}: unknown group "${l.group}"`);
    if (!/^[0-9a-f]{6}$/.test(l.color)) out.push(`${l.name}: color "${l.color}" is not six lowercase hex digits`);
    if (!l.description || l.description.length > 100) out.push(`${l.name}: needs a description of at most 100 characters (GitHub's limit)`);
    if (l.name.length > 50 || l.name !== l.name.trim()) out.push(`${l.name}: a name has at most 50 characters and no outer spaces`);
    if (l.group === 'priority' && !l.name.startsWith('priority:')) out.push(`${l.name}: a priority's name starts with "priority:"`);
    if (l.group !== 'priority' && l.name.includes(':')) out.push(`${l.name}: only priorities have a prefix`);
  }
  for (const l of set.labels) {
    if (l.parent === undefined) continue;
    const p = byName.get(l.parent);
    if (l.group !== 'area') out.push(`${l.name}: only areas have a parent`);
    else if (!p) out.push(`${l.name}: parent "${l.parent}" is not in the set`);
    else if (p.group !== 'area') out.push(`${l.name}: parent "${l.parent}" is not an area`);
    else if (!l.name.startsWith(`${l.parent}-`)) out.push(`${l.name}: a sub-area's name starts with its parent's and a dash`);
  }
  return out;
}

/**
 * The labels an issue ends up with: `current` plus `add` minus `remove`, every sub-area's parents added. Throws on a
 * label outside the set, a kind count other than one, a priority without `triage`, or removing a parent its sub-area keeps.
 */
export function resolveLabels(set: LabelSet, current: string[], add: string[], remove: string[], triage: boolean): string[] {
  const byName = new Map(set.labels.map((l) => [l.name, l]));
  for (const n of [...add, ...remove]) {
    if (!byName.has(n)) throw new Error(`"${n}" is not in .github/labels.json (\`node tools/issue.ts labels\` lists them; new labels need the user's OK)`);
    if (byName.get(n)!.group === 'priority' && !triage) throw new Error(`"${n}": priorities are set in triage only (--triage)`);
  }
  const out = new Set(current.filter((n) => !remove.includes(n)));
  for (const n of add) for (let l = byName.get(n); l; l = l.parent ? byName.get(l.parent) : undefined) out.add(l.name);
  for (const n of remove) {
    const child = [...out].find((c) => byName.get(c)?.parent === n);
    if (child) throw new Error(`"${n}" is the parent of "${child}", which stays: remove that too`);
  }
  const kinds = [...out].filter((n) => byName.get(n)?.group === 'kind');
  if (kinds.length !== 1) throw new Error(`an issue takes exactly one kind (${set.labels.filter((l) => l.group === 'kind').map((l) => l.name).join(', ')}); it would have ${kinds.length ? kinds.join(', ') : 'none'}`);
  if ([...out].filter((n) => byName.get(n)?.group === 'priority').length > 1) throw new Error('an issue takes at most one priority');
  return sortLabels(set, [...out]);
}

/** Labels in the set's order (kind, areas, modifiers, priority as listed), unknown ones (set by hand on GitHub) last. */
export function sortLabels(set: LabelSet, names: string[]): string[] {
  const order = new Map(set.labels.map((l, i) => [l.name, i]));
  return [...names].sort((a, b) => (order.get(a) ?? 1e9) - (order.get(b) ?? 1e9) || a.localeCompare(b));
}

/** `owner/name` from origin's URL (ssh, https, or a cloud session's proxy URL), or WAARM64_REPO. */
export function repoOf(url: string): string {
  const m = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim());
  if (!m) throw new Error(`can't tell the repository from origin's URL "${url}" (set WAARM64_REPO=owner/name)`);
  return `${m[1]}/${m[2]}`;
}

function repo(): string {
  return process.env.WAARM64_REPO ?? repoOf(execFileSync('git', ['-C', ROOT, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }));
}

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** `gh api`, retrying GitHub's secondary rate limit (a minute's wait, three times). */
export const ghApi: Api = (method, path, body) => {
  const args = ['api', '-X', method, '-H', 'Accept: application/vnd.github+json', path];
  if (body !== undefined) args.push('--input', '-');
  for (let attempt = 0; ; attempt++) {
    try {
      const out = execFileSync('gh', args, { input: body === undefined ? undefined : JSON.stringify(body), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 << 20 });
      return out.trim() ? JSON.parse(out) : null;
    } catch (e) {
      const err = e as { stderr?: string; stdout?: string; message: string };
      const text = `${err.stderr ?? ''}${err.stdout ?? ''}`.trim() || err.message;
      if (attempt < 3 && /secondary rate limit|HTTP 429|abuse/i.test(text)) {
        process.stderr.write('GitHub rate limit: waiting 60 s\n');
        sleep(60_000);
        continue;
      }
      throw new Error(`gh api ${method} ${path}: ${text}`);
    }
  }
};

export type Issue = { number: number; title: string; state: string; state_reason?: string | null; body: string | null; html_url: string; labels: { name: string }[]; pull_request?: unknown; updated_at?: string };
const names = (i: Issue) => i.labels.map((l) => l.name);

/** Every page of a list (100 a page) up to `limit` items, pull requests left out. */
function pages(api: Api, path: string, limit: number, pick: (r: unknown) => Issue[] = (r) => r as Issue[]): Issue[] {
  const out: Issue[] = [];
  for (let page = 1; out.length < limit; page++) {
    const got = pick(api('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`));
    out.push(...got.filter((i) => !i.pull_request));
    if (got.length < 100) break;
  }
  return out.slice(0, limit);
}

export type Ops = { api: Api; repo: string; set: LabelSet };

export function fileIssue(o: Ops, title: string, body: string, labels: string[], triage = false): Issue {
  if (!title.trim()) throw new Error('an issue needs a title');
  if (!body.trim()) throw new Error('an issue needs a body (--body-file or stdin): what, the evidence, where in the code');
  return o.api('POST', `repos/${o.repo}/issues`, { title, body, labels: resolveLabels(o.set, [], labels, [], triage) }) as Issue;
}

export function editIssue(o: Ops, n: number, e: { title?: string; body?: string; add?: string[]; remove?: string[]; triage?: boolean }): Issue {
  const patch: Record<string, unknown> = {};
  if (e.title !== undefined) patch.title = e.title;
  if (e.body !== undefined) patch.body = e.body;
  if (e.add?.length || e.remove?.length) {
    const cur = names(o.api('GET', `repos/${o.repo}/issues/${n}`) as Issue);
    // Labels outside the set (set by hand on GitHub) are kept as they are.
    patch.labels = resolveLabels(o.set, cur, e.add ?? [], e.remove ?? [], e.triage ?? false);
  }
  if (!Object.keys(patch).length) throw new Error('nothing to change');
  return o.api('PATCH', `repos/${o.repo}/issues/${n}`, patch) as Issue;
}

export function commentIssue(o: Ops, n: number, body: string): { html_url: string } {
  if (!body.trim()) throw new Error('an empty comment');
  return o.api('POST', `repos/${o.repo}/issues/${n}/comments`, { body }) as { html_url: string };
}

export function closeIssue(o: Ops, n: number, reason: string, comment?: string): Issue {
  if (!['completed', 'not_planned', 'duplicate'].includes(reason)) throw new Error(`--reason is completed, not_planned or duplicate, not "${reason}"`);
  if (comment?.trim()) commentIssue(o, n, comment);
  return o.api('PATCH', `repos/${o.repo}/issues/${n}`, { state: 'closed', state_reason: reason }) as Issue;
}

export function listIssues(o: Ops, f: { labels?: string[]; state?: string; untriaged?: boolean; limit?: number }): Issue[] {
  const q = new URLSearchParams({ state: f.state ?? 'open', sort: 'created', direction: 'asc' });
  if (f.labels?.length) q.set('labels', f.labels.join(','));
  const prio = new Set(o.set.labels.filter((l) => l.group === 'priority').map((l) => l.name));
  const all = pages(o.api, `repos/${o.repo}/issues?${q}`, f.untriaged ? Infinity : (f.limit ?? 1000));
  const out = f.untriaged ? all.filter((i) => !names(i).some((n) => prio.has(n))) : all;
  return out.slice(0, f.limit ?? 1000);
}

export function searchIssues(o: Ops, words: string, state = 'open', limit = 50): Issue[] {
  const q = `repo:${o.repo} is:issue ${state === 'all' ? '' : `is:${state} `}${words}`;
  return pages(o.api, `search/issues?q=${encodeURIComponent(q)}`, limit, (r) => (r as { items: Issue[] }).items);
}

/** One line an agent or a person scans: number, state when closed, labels, title. */
export function line(set: LabelSet, i: Issue): string {
  const st = i.state === 'closed' ? ` (closed${i.state_reason ? `: ${i.state_reason}` : ''})` : '';
  return `#${i.number}${st}  [${sortLabels(set, names(i)).join(' ')}]  ${i.title}`;
}

export type RepoLabel = { name: string; color: string; description: string | null };

/** What `labels --sync` would do: create the set's new labels, update changed ones, delete the rest. */
export function labelPlan(set: LabelSet, have: RepoLabel[]): { create: Label[]; update: Label[]; remove: string[] } {
  const want = new Map(set.labels.map((l) => [l.name, l]));
  const got = new Map(have.map((l) => [l.name, l]));
  return {
    create: set.labels.filter((l) => !got.has(l.name)),
    update: set.labels.filter((l) => got.has(l.name) && (got.get(l.name)!.color !== l.color || (got.get(l.name)!.description ?? '') !== l.description)),
    remove: have.filter((l) => !want.has(l.name)).map((l) => l.name),
  };
}

function readBody(file: string | undefined): string {
  return readFileSync(file ?? 0, 'utf8');
}
const list = (s: string | undefined) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : []);
function num(s: string | undefined): number {
  const n = Number(String(s ?? '').replace(/^#/, ''));
  if (!Number.isInteger(n) || n <= 0) throw new Error(`an issue number, not "${s ?? ''}"`);
  return n;
}

function main(argv: string[]): void {
  const [cmd, ...rest] = argv;
  const { values: v, positionals: pos } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      title: { type: 'string' }, label: { type: 'string' }, 'body-file': { type: 'string' }, 'add-label': { type: 'string' },
      'remove-label': { type: 'string' }, triage: { type: 'boolean' }, reason: { type: 'string' }, 'comment-file': { type: 'string' },
      comments: { type: 'boolean' }, state: { type: 'string' }, untriaged: { type: 'boolean' }, limit: { type: 'string' },
      json: { type: 'boolean' }, lint: { type: 'boolean' }, diff: { type: 'boolean' }, sync: { type: 'boolean' }, apply: { type: 'boolean' },
    },
  });
  const set = loadLabels();
  if (cmd === 'labels') {
    const bad = lintLabels(set);
    if (v.lint) {
      for (const b of bad) console.error(`.github/labels.json: ${b}`);
      process.exitCode = bad.length ? 1 : 0;
      return;
    }
    if (bad.length) throw new Error(`.github/labels.json: ${bad.join('; ')}`);
    if (v.diff || v.sync) {
      const r = repo();
      const plan = labelPlan(set, pages(ghApi, `repos/${r}/labels`, Infinity, (x) => x as unknown as Issue[]) as unknown as RepoLabel[]);
      for (const l of plan.create) console.log(`create ${l.name}`);
      for (const l of plan.update) console.log(`update ${l.name}`);
      for (const n of plan.remove) console.log(`delete ${n}`);
      if (!plan.create.length && !plan.update.length && !plan.remove.length) console.log('the repo has the set');
      if (!v.sync) return;
      if (!v.apply) return void console.log('(nothing changed: --sync --apply changes the repo, and only the user runs it)');
      for (const l of plan.create) ghApi('POST', `repos/${r}/labels`, { name: l.name, color: l.color, description: l.description });
      for (const l of plan.update) ghApi('PATCH', `repos/${r}/labels/${encodeURIComponent(l.name)}`, { color: l.color, description: l.description });
      for (const n of plan.remove) ghApi('DELETE', `repos/${r}/labels/${encodeURIComponent(n)}`);
      return;
    }
    for (const g of GROUPS) {
      console.log(`${g}:`);
      for (const l of set.labels.filter((x) => x.group === g)) console.log(`  ${l.name}${l.parent ? ` (in ${l.parent})` : ''}: ${l.description}`);
    }
    return;
  }
  const o: Ops = { api: ghApi, repo: repo(), set };
  const show = (i: Issue) => console.log(`#${i.number} ${i.html_url}`);
  const limit = v.limit === undefined ? undefined : num(v.limit);
  switch (cmd) {
    case 'file':
      show(fileIssue(o, v.title ?? '', readBody(v['body-file']), list(v.label), v.triage));
      break;
    case 'edit':
      show(editIssue(o, num(pos[0]), { title: v.title, body: v['body-file'] === undefined ? undefined : readBody(v['body-file']), add: list(v['add-label']), remove: list(v['remove-label']), triage: v.triage }));
      break;
    case 'comment':
      console.log(commentIssue(o, num(pos[0]), readBody(v['body-file'])).html_url);
      break;
    case 'close':
      show(closeIssue(o, num(pos[0]), v.reason ?? 'completed', v['comment-file'] === undefined ? undefined : readBody(v['comment-file'])));
      break;
    case 'reopen':
      show(o.api('PATCH', `repos/${o.repo}/issues/${num(pos[0])}`, { state: 'open' }) as Issue);
      break;
    case 'show': {
      const n = num(pos[0]);
      const i = o.api('GET', `repos/${o.repo}/issues/${n}`) as Issue;
      if (v.json) return void console.log(JSON.stringify(i, null, 2));
      console.log(`${line(set, i)}\n${i.html_url}\n\n${i.body ?? ''}`);
      if (v.comments) {
        for (const c of o.api('GET', `repos/${o.repo}/issues/${n}/comments?per_page=100`) as { user: { login: string }; created_at: string; body: string }[]) {
          console.log(`\n--- ${c.user.login}, ${c.created_at}\n${c.body}`);
        }
      }
      break;
    }
    case 'list':
    case 'search': {
      const got = cmd === 'list' ? listIssues(o, { labels: list(v.label), state: v.state, untriaged: v.untriaged, limit }) : searchIssues(o, pos.join(' '), v.state, limit);
      if (v.json) return void console.log(JSON.stringify(got.map((i) => ({ number: i.number, title: i.title, state: i.state, labels: names(i), url: i.html_url }))));
      for (const i of got) console.log(line(set, i));
      break;
    }
    default:
      throw new Error(`unknown command "${cmd ?? ''}": file, edit, comment, close, reopen, show, list, search, labels (the header of tools/issue.ts)`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`issue: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}
