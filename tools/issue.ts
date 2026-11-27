// The backlog's issues on GitHub (docs/issues.md): filing, editing, commenting, closing, listing and searching, through
// GitHub's REST API only (`gh api`): cloud sessions' proxy refuses GraphQL, so `gh issue …` fails there. The label set
// and the issue types are .github/labels.json: this tool refuses a label or type missing from it, gives an issue
// exactly one type (its kind: Bug, Feature, Flake…), adds a sub-area's parent, and sets the Priority field (one of
// its options, or `none`) only with --triage.
//   node tools/issue.ts file --title T --type Bug --label jit,upstream [--body-file F | < body]   prints "#n <url>"
//   node tools/issue.ts edit N [--title T] [--type T] [--body-file F] [--add-label a,b] [--remove-label c]
//                              [--triage --priority High|none]
//   node tools/issue.ts comment N [--body-file F | < body]
//   node tools/issue.ts close N [--reason completed|not_planned|duplicate] [--comment-file F]
//   node tools/issue.ts reopen N
//   node tools/issue.ts show N [--comments]
//   node tools/issue.ts list [--type T] [--label a,b] [--priority P,Q | --untriaged] [--state open|closed|all] [--limit K] [--json]
//   node tools/issue.ts search "words" [--type T] [--priority P] [--state open|closed|all] [--limit K] [--json]
//   node tools/issue.ts labels [--lint | --diff | --sync [--apply]]   the set and types; checks; the repo against them
// `labels --sync --apply` changes the repo's labels: the user runs it, agents never (docs/issues.md "Labels"). The
// types and the Priority field are the account's (GitHub's settings): `labels --diff` reports a type the repo lacks;
// nothing here makes them. Priority filters go through advanced search (`field.priority:High`, `no:field.priority`).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const LABELS_FILE = `${ROOT}.github/labels.json`;

export const GROUPS = ['area', 'modifier'] as const;
export type Group = (typeof GROUPS)[number];
export type Label = { name: string; group: Group; color: string; description: string; parent?: string };
/** The issue types (an issue's kind) by name, as GitHub has them; the Priority field (its id, its options from the most
 * urgent); the labels. */
export type LabelSet = { types: { name: string; description: string }[]; priority: { field_id: number; options: string[] }; labels: Label[] };

/** A REST call: the method, the path under api.github.com, a JSON body. Resolves to the parsed response (or null). */
export type Api = (method: string, path: string, body?: unknown) => unknown;

export function loadLabels(file = LABELS_FILE): LabelSet {
  return JSON.parse(readFileSync(file, 'utf8')) as LabelSet;
}

/** What's wrong with a label set: duplicate names, unknown groups, bad colors, parents missing or not areas. */
export function lintLabels(set: LabelSet): string[] {
  const out: string[] = [];
  if (!set.types?.length) out.push('no issue types');
  const types = new Set<string>();
  for (const t of set.types ?? []) {
    if (types.has(t.name.toLowerCase())) out.push(`type ${t.name}: listed twice`);
    types.add(t.name.toLowerCase());
    if (!t.description) out.push(`type ${t.name}: needs a description`);
  }
  if (!Number.isInteger(set.priority?.field_id) || !set.priority.options?.length) out.push('the Priority field needs its field_id and options');
  else if (set.priority.options.some((x) => x.toLowerCase() === 'none')) out.push('"none" clears a priority: not an option');
  const byName = new Map<string, Label>();
  const lower = new Set<string>();
  for (const l of set.labels) {
    if (lower.has(l.name.toLowerCase())) out.push(`${l.name}: listed twice`);
    lower.add(l.name.toLowerCase());
    byName.set(l.name, l);
    if (!GROUPS.includes(l.group)) out.push(`${l.name}: unknown group "${l.group}"`);
    if (!/^[0-9a-f]{6}$/.test(l.color)) out.push(`${l.name}: color "${l.color}" is not six lowercase hex digits`);
    if (!l.description || l.description.length > 100) out.push(`${l.name}: needs a description of at most 100 characters (GitHub's limit)`);
    if (l.name.length > 50 || l.name !== l.name.trim()) out.push(`${l.name}: a name has at most 50 characters and no outer spaces`);
    if (types.has(l.name.toLowerCase())) out.push(`${l.name}: a type's name, not a label`);
    if (l.name.includes(':')) out.push(`${l.name}: no prefixes (priorities are a field)`);
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
 * label outside the set or removing a parent its sub-area keeps.
 */
export function resolveLabels(set: LabelSet, current: string[], add: string[], remove: string[]): string[] {
  const byName = new Map(set.labels.map((l) => [l.name, l]));
  for (const n of add) checkLabel(set, n);
  // A label outside the set (set by hand on GitHub) may be removed, as long as the issue has it.
  for (const n of remove) if (!byName.has(n) && !current.includes(n)) checkLabel(set, n);
  const out = new Set(current.filter((n) => !remove.includes(n)));
  for (const n of add) for (let l = byName.get(n); l; l = l.parent ? byName.get(l.parent) : undefined) out.add(l.name);
  for (const n of remove) {
    const below = [...out].find((c) => {
      for (let l = byName.get(c)?.parent; l; l = byName.get(l)?.parent) if (l === n) return true;
      return false;
    });
    if (below) throw new Error(`"${n}" is above "${below}" (its parent or further up), which stays: remove that too`);
  }
  return sortLabels(set, [...out]);
}

/** Throws on a label outside the set. */
export function checkLabel(set: LabelSet, n: string): void {
  if (!set.labels.some((l) => l.name === n)) throw new Error(`"${n}" is not in .github/labels.json (\`node tools/issue.ts labels\` lists them; new labels need the user's OK)`);
}

/** The type's name as GitHub has it, matched without regard to case; throws on one outside the set. */
export function resolveType(set: LabelSet, type: string | undefined): string {
  const t = set.types.find((x) => x.name.toLowerCase() === (type ?? '').trim().toLowerCase());
  if (!t) throw new Error(`an issue takes exactly one type (--type ${set.types.map((x) => x.name).join('|')})${type ? `, not "${type}"` : ''}`);
  return t.name;
}

/**
 * A Priority option's name as the field has it (matched without regard to case), or null for `none`. Throws on an
 * unknown one, and on any without `triage`: priorities are set by the user or a triage session.
 */
export function resolvePriority(set: LabelSet, p: string, triage: boolean): string | null {
  if (!triage) throw new Error('priorities are set in triage only (--triage), by the user or a session weighing many issues');
  if (p.trim().toLowerCase() === 'none') return null;
  const o = set.priority.options.find((x) => x.toLowerCase() === p.trim().toLowerCase());
  if (!o) throw new Error(`a priority is one of ${set.priority.options.join(', ')} or none, not "${p}"`);
  return o;
}

/** Labels in the set's order (areas, then modifiers, as listed), unknown ones (set by hand on GitHub) last. */
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

export type FieldValue = { issue_field_id: number; single_select_option?: { name: string } | null };
export type Issue = { number: number; title: string; type?: { name: string } | null; issue_field_values?: FieldValue[]; state: string; state_reason?: string | null; body: string | null; html_url: string; labels: { name: string }[]; pull_request?: unknown; updated_at?: string };
const names = (i: Issue) => i.labels.map((l) => l.name);

/** The issue's Priority option, or null. */
export function priorityOf(set: LabelSet, i: Issue): string | null {
  return i.issue_field_values?.find((f) => f.issue_field_id === set.priority.field_id)?.single_select_option?.name ?? null;
}

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

/** Sets the issue's Priority field to an option, or clears it (null). */
export function setPriority(o: Ops, n: number, p: string | null): void {
  const id = o.set.priority.field_id;
  if (p === null) {
    const has = (o.api('GET', `repos/${o.repo}/issues/${n}/issue-field-values`) as FieldValue[]).some((f) => f.issue_field_id === id);
    if (has) o.api('DELETE', `repos/${o.repo}/issues/${n}/issue-field-values/${id}`);
  } else {
    o.api('POST', `repos/${o.repo}/issues/${n}/issue-field-values`, { issue_field_values: [{ field_id: id, value: p }] });
  }
}

export type NewIssue = { title: string; body: string; type: string; labels: string[]; priority?: string; triage?: boolean };

export function fileIssue(o: Ops, f: NewIssue): Issue {
  const t = resolveType(o.set, f.type);
  if (!f.title.trim()) throw new Error('an issue needs a title');
  if (!f.body.trim()) throw new Error('an issue needs a body (--body-file or stdin): what, the evidence, where in the code');
  const labels = resolveLabels(o.set, [], f.labels, []);
  const p = f.priority === undefined ? undefined : resolvePriority(o.set, f.priority, f.triage ?? false);
  const i = o.api('POST', `repos/${o.repo}/issues`, { title: f.title, body: f.body, type: t, labels }) as Issue;
  try {
    if (p) setPriority(o, i.number, p);
  } catch (e) {
    throw new Error(`#${i.number} ${i.html_url} was filed, but its priority wasn't set (edit ${i.number} --triage --priority ${p}): ${(e as Error).message}`);
  }
  return i;
}

export function editIssue(o: Ops, n: number, e: { title?: string; body?: string; type?: string; add?: string[]; remove?: string[]; priority?: string; triage?: boolean }): Issue {
  const p = e.priority === undefined ? undefined : resolvePriority(o.set, e.priority, e.triage ?? false);
  const patch: Record<string, unknown> = {};
  if (e.title !== undefined) patch.title = e.title;
  if (e.type !== undefined) patch.type = resolveType(o.set, e.type);
  if (e.body !== undefined) patch.body = e.body;
  if (e.add?.length || e.remove?.length) {
    const cur = names(o.api('GET', `repos/${o.repo}/issues/${n}`) as Issue);
    // Labels outside the set (set by hand on GitHub) are kept as they are.
    patch.labels = resolveLabels(o.set, cur, e.add ?? [], e.remove ?? []);
  }
  if (!Object.keys(patch).length && p === undefined) throw new Error('nothing to change');
  // The PATCH first: a priority set after a refused PATCH would be half an edit.
  const i = Object.keys(patch).length ? (o.api('PATCH', `repos/${o.repo}/issues/${n}`, patch) as Issue) : undefined;
  if (p !== undefined) setPriority(o, n, p);
  return i ?? (o.api('GET', `repos/${o.repo}/issues/${n}`) as Issue);
}

export function commentIssue(o: Ops, n: number, body: string): { html_url: string } {
  if (!body.trim()) throw new Error('an empty comment');
  return o.api('POST', `repos/${o.repo}/issues/${n}/comments`, { body }) as { html_url: string };
}

export function closeIssue(o: Ops, n: number, reason: string, comment?: string): Issue {
  if (!['completed', 'not_planned', 'duplicate'].includes(reason)) throw new Error(`--reason is completed, not_planned or duplicate, not "${reason}"`);
  // Closed first: a rerun after a failed comment then doesn't post it twice.
  const i = o.api('PATCH', `repos/${o.repo}/issues/${n}`, { state: 'closed', state_reason: reason }) as Issue;
  if (comment?.trim()) commentIssue(o, n, comment);
  return i;
}

export type Filter = { words?: string; type?: string; labels?: string[]; priority?: string[]; untriaged?: boolean; state?: string; limit?: number };

/** The advanced-search query for a filter: the field's qualifiers work only there (`field.priority:`, `no:field.priority`). */
function checkFilter(o: Ops, f: Filter): void {
  for (const l of f.labels ?? []) checkLabel(o.set, l);
  if (f.priority?.length && f.untriaged) throw new Error('--priority or --untriaged: an issue has a priority or none');
  if (f.state !== undefined && !['open', 'closed', 'all'].includes(f.state)) throw new Error(`--state is open, closed or all, not "${f.state}"`);
}

export function searchQuery(o: Ops, f: Filter): string {
  checkFilter(o, f);
  const state = f.state ?? 'open';
  const parts = [`repo:${o.repo}`, 'is:issue'];
  if (state !== 'all') parts.push(`is:${state}`);
  if (f.type) parts.push(`type:"${resolveType(o.set, f.type)}"`);
  for (const l of f.labels ?? []) parts.push(`label:"${l}"`);
  if (f.priority?.length) {
    const ps = f.priority.map((p) => resolvePriority(o.set, p, true));
    if (ps.includes(null)) throw new Error('--untriaged lists the issues without a priority');
    parts.push(`field.priority:${ps.map((p) => `"${p}"`).join(',')}`);
  }
  if (f.untriaged) parts.push('no:field.priority');
  if (f.words?.trim()) parts.push(f.words.trim());
  return parts.join(' ');
}

function search(o: Ops, q: string, limit: number, sort: string): Issue[] {
  let warned = false;
  return pages(o.api, `search/issues?q=${encodeURIComponent(q)}&advanced_search=true${sort}`, limit, (r) => {
    const res = r as { items: Issue[]; total_count?: number; incomplete_results?: boolean };
    if (!warned && (res.incomplete_results || (res.total_count ?? 0) > 1000)) {
      process.stderr.write(`issue: search results may be partial (${res.total_count ?? '?'} matched; GitHub returns up to 1000, and timed out: ${res.incomplete_results ? 'yes' : 'no'}): narrow the filter\n`);
      warned = true;
    }
    return res.items;
  });
}

export function listIssues(o: Ops, f: Filter): Issue[] {
  checkFilter(o, f);
  if (f.priority?.length || f.untriaged) return search(o, searchQuery(o, f), f.limit ?? 1000, '&sort=created&order=asc');
  const q = new URLSearchParams({ state: f.state ?? 'open', sort: 'created', direction: 'asc' });
  if (f.type) q.set('type', resolveType(o.set, f.type));
  if (f.labels?.length) q.set('labels', f.labels.join(','));
  return pages(o.api, `repos/${o.repo}/issues?${q}`, f.limit ?? 1000);
}

export function searchIssues(o: Ops, f: Filter): Issue[] {
  return search(o, searchQuery(o, f), f.limit ?? 50, '');
}

/** One line an agent or a person scans: number, state when closed, type, priority, labels, title. */
export function line(set: LabelSet, i: Issue): string {
  const st = i.state === 'closed' ? ` (closed${i.state_reason ? `: ${i.state_reason}` : ''})` : '';
  return `#${i.number}${st}  ${i.type?.name ?? '(no type)'}  ${priorityOf(set, i) ?? '(untriaged)'}  [${sortLabels(set, names(i)).join(' ')}]  ${i.title}`;
}

export type RepoLabel = { name: string; color: string; description: string | null };

/** What `labels --sync` would do: create the set's new labels, update changed ones (`from` names the repo's label, which
 * GitHub matches without regard to case, so a rename of case is an update), delete the rest. */
export function labelPlan(set: LabelSet, have: RepoLabel[]): { create: Label[]; update: (Label & { from: string })[]; remove: string[] } {
  const want = new Set(set.labels.map((l) => l.name.toLowerCase()));
  const got = new Map(have.map((l) => [l.name.toLowerCase(), l]));
  const update: (Label & { from: string })[] = [];
  for (const l of set.labels) {
    const g = got.get(l.name.toLowerCase());
    if (g && (g.name !== l.name || g.color !== l.color || (g.description ?? '') !== l.description)) update.push({ ...l, from: g.name });
  }
  return {
    create: set.labels.filter((l) => !got.has(l.name.toLowerCase())),
    update,
    remove: have.filter((l) => !want.has(l.name.toLowerCase())).map((l) => l.name),
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

/** The options each command takes, and how many positionals (an issue number, the search's words). */
const TAKES: Record<string, { options: string[]; positionals: 'none' | 'number' | 'words' }> = {
  file: { options: ['title', 'type', 'label', 'body-file', 'priority', 'triage'], positionals: 'none' },
  edit: { options: ['title', 'type', 'body-file', 'add-label', 'remove-label', 'priority', 'triage'], positionals: 'number' },
  comment: { options: ['body-file'], positionals: 'number' },
  close: { options: ['reason', 'comment-file'], positionals: 'number' },
  reopen: { options: [], positionals: 'number' },
  show: { options: ['comments', 'json'], positionals: 'number' },
  list: { options: ['type', 'label', 'priority', 'untriaged', 'state', 'limit', 'json'], positionals: 'none' },
  search: { options: ['type', 'label', 'priority', 'untriaged', 'state', 'limit', 'json'], positionals: 'words' },
  labels: { options: ['lint', 'diff', 'sync', 'apply'], positionals: 'none' },
};

/** Throws on an option the command doesn't take (it would be dropped without a word), or a wrong count of positionals. */
export function checkOptions(cmd: string, v: Record<string, unknown>, positionals: string[] = []): void {
  const t = TAKES[cmd];
  if (!t) throw new Error(`unknown command "${cmd}": ${Object.keys(TAKES).join(', ')} (the header of tools/issue.ts)`);
  for (const k of Object.keys(v)) if (v[k] !== undefined && !t.options.includes(k)) throw new Error(`${cmd} doesn't take --${k}`);
  if (t.positionals === 'none' && positionals.length) throw new Error(`${cmd} takes no arguments, not "${positionals.join(' ')}"`);
  if (t.positionals === 'number' && positionals.length !== 1) throw new Error(`${cmd} takes one issue number`);
}

function main(argv: string[]): void {
  const [cmd, ...rest] = argv;
  const { values: v, positionals: pos } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      title: { type: 'string' }, type: { type: 'string' }, priority: { type: 'string' }, label: { type: 'string' }, 'body-file': { type: 'string' }, 'add-label': { type: 'string' },
      'remove-label': { type: 'string' }, triage: { type: 'boolean' }, reason: { type: 'string' }, 'comment-file': { type: 'string' },
      comments: { type: 'boolean' }, state: { type: 'string' }, untriaged: { type: 'boolean' }, limit: { type: 'string' },
      json: { type: 'boolean' }, lint: { type: 'boolean' }, diff: { type: 'boolean' }, sync: { type: 'boolean' }, apply: { type: 'boolean' },
    },
  });
  checkOptions(cmd ?? '', v, pos);
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
      const types = ghApi('GET', `repos/${r}/issue-types`) as { name: string }[];
      for (const t of set.types) if (!types.some((x) => x.name === t.name)) console.log(`type ${t.name}: missing (the user adds it in GitHub's settings)`);
      if (!plan.create.length && !plan.update.length && !plan.remove.length) console.log('the repo has the set');
      if (!v.sync) return;
      if (!v.apply) return void console.log('(nothing changed: --sync --apply changes the repo, and only the user runs it)');
      for (const l of plan.create) ghApi('POST', `repos/${r}/labels`, { name: l.name, color: l.color, description: l.description });
      for (const l of plan.update) ghApi('PATCH', `repos/${r}/labels/${encodeURIComponent(l.from)}`, { new_name: l.name, color: l.color, description: l.description });
      for (const n of plan.remove) ghApi('DELETE', `repos/${r}/labels/${encodeURIComponent(n)}`);
      return;
    }
    console.log(`types (exactly one): ${set.types.map((t) => t.name).join(', ')}`);
    console.log(`priority (the field, set in triage): ${set.priority.options.join(', ')}`);
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
      show(fileIssue(o, { title: v.title ?? '', body: readBody(v['body-file']), type: v.type ?? '', labels: list(v.label), priority: v.priority, triage: v.triage }));
      break;
    case 'edit':
      show(editIssue(o, num(pos[0]), { title: v.title, type: v.type, body: v['body-file'] === undefined ? undefined : readBody(v['body-file']), add: list(v['add-label']), remove: list(v['remove-label']), priority: v.priority, triage: v.triage }));
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
        for (let page = 1; ; page++) {
          const cs = o.api('GET', `repos/${o.repo}/issues/${n}/comments?per_page=100&page=${page}`) as { user: { login: string }; created_at: string; body: string }[];
          for (const c of cs) console.log(`\n--- ${c.user.login}, ${c.created_at}\n${c.body}`);
          if (cs.length < 100) break;
        }
      }
      break;
    }
    case 'list':
    case 'search': {
      const f: Filter = { type: v.type, labels: list(v.label), priority: list(v.priority), untriaged: v.untriaged, state: v.state, limit };
      const got = cmd === 'list' ? listIssues(o, f) : searchIssues(o, { ...f, words: pos.join(' ') });
      if (v.json) return void console.log(JSON.stringify(got.map((i) => ({ number: i.number, title: i.title, type: i.type?.name ?? null, priority: priorityOf(set, i), state: i.state, labels: names(i), url: i.html_url }))));
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
