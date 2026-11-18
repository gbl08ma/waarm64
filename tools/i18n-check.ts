// The catalog's checks (docs/i18n.md "Checks"; scripts/ci.sh runs them): what TypeScript can't see about messages.
//
//   node tools/i18n-check.ts             every check; a problem per line (`file:line: what`), exit 1 if any
//   node tools/i18n-check.ts --fix-docs  also rewrites the docs' UI quotes (`[words](ui:key)`) to the catalog's words
//
// - the catalog: every entry has its words and a note; keys are `<Source>.<name>`;
// - every key the code names exists, is a literal, and sits in its source: a key `ns:Source.name` is named in a file
//   `Source.*` (it mirrors where it's used), and every entry is named somewhere;
// - an error written as one message: words that are a headline and a line after `\n` are a `MsgError` headline and
//   a cause of its own;
// - a message's parameters: a call that names a key (`t`, `msg`, `new MsgError`, a subclass, `<T k params>`) gives
//   exactly the `{{names}}` its words use: a key as a literal, a conditional's, or through a map or a constant of the
//   file (`STATE_WORDS[s]`, `const [key] = PHASE_WORD[p]`); parameters as an object, a conditional's objects, a
//   constant of the file or `undefined`;
// - no `.message` of a caught error is shown to the user (a `MsgError`'s is its developer text): `describe`,
//   `errorText` or `msgOf` say it;
// - copy outside the catalog: words in a component's markup or a copy attribute (`title`, `aria-label`, …), string
//   results of a markup expression, copy properties (`label: 'Disks…'`) and sentence-like strings in the page's code,
//   lower-case ones and ones with `;` or after a `Field=` too (a line with `i18n-ignore`, or after a line with
//   `i18n-ignore-next`, is skipped);
// - no worker reaches web/i18n.ts or i18next: the page alone renders words;
// - the docs' UI quotes, `[words](ui:ns:Source.name)`, say the catalog's words, and words quoted in bold, italics or
//   double quotes that are a message's (two words or more, or ending in "…") are written as such a quote, a quote
//   broken across two lines included;
// - the tests take the page's words from the catalog: no literal says a message's words (`checkTests`), but in a test
//   named `wording: …`, which pins words on purpose.
import { parse as parseSvelte } from 'svelte/compiler';
import { parseSync } from 'vite';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expand, REF } from '../web/messages/en/index.ts';

export type Entry = { message: string; note: string };
export type Catalogs = Record<string, Record<string, Entry>>;
export type Source = { path: string; text: string };
export type Problem = { path: string; line: number; text: string };

const KEY_RE = /^([a-z][a-z0-9-]*):([A-Za-z0-9-]+(?:\.[A-Za-z0-9_-]+)+)$/;
const PLURAL = /_(zero|one|two|few|many|other)$/;
/** Attributes whose words the user reads. */
const COPY_ATTRS = new Set(['title', 'aria-label', 'aria-description', 'aria-placeholder', 'aria-roledescription', 'aria-valuetext', 'placeholder', 'alt', 'label']);
/** Object properties that hold words the user reads, in the page's code (an action's label, a dialog's title, …). */
const COPY_PROPS = new Set(['label', 'title', 'text', 'message', 'hint', 'note', 'ok', 'cancel', 'description', 'placeholder', 'headline', 'detail', 'details', 'what']);
/** Calls whose arguments are a developer's words (a log, an Error's message: shown, if ever, as an error's details). */
const DEV_CALLS = /^(console\.\w+|Error|TypeError|RangeError|DOMException|log|warn|debug|trace|assert(\.\w+)?)$/;

/** The `{{names}}` message words use (a plural's `count` among them). */
export function varsOf(message: string): Set<string> {
  const out = new Set<string>();
  for (const m of message.matchAll(/\{\{\s*([\w.]+)\s*(?:,[^}]*)?\}\}/g)) out.add(m[1].split('.')[0]);
  return out;
}

/** The base key of a plural form (`Source.files_one` → `Source.files`). */
const baseKey = (k: string) => k.replace(PLURAL, '');

/** The catalogs with every message's references (`$t(ns:Source.name)`) resolved: the words the page renders. */
export function expanded(catalogs: Catalogs): Catalogs {
  return Object.fromEntries(Object.entries(catalogs).map(([ns, c]) => [ns, Object.fromEntries(Object.entries(c).map(([k, e]) => [k, typeof e?.message === 'string' ? { ...e, message: expand(e.message, catalogs) } : e]))]));
}

/** A file's stem as keys name it: `Disks.svelte` → `Disks`, `ask.svelte.ts` → `ask`, `qcow2-write.ts` → `qcow2-write`. */
export const stemOf = (path: string) => basename(path).replace(/(\.svelte)?\.(ts|js|mjs|svelte)$/, '');

/** Message words without their markers and parameters' braces, as the docs quote them. */
export const plainWords = (s: string) => s.replace(/<\/?[a-z][a-z0-9-]*>/g, '').replace(/\s+/g, ' ').trim();

const lineAt = (text: string, offset: number) => {
  let n = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
};

type Node = { type: string; start: number; end: number; [k: string]: unknown };

/** Every node under `n` (ESTree or Svelte's), with its parent chain's last link. */
function walk(n: unknown, visit: (node: Node, parent: Node | undefined, key: string) => boolean | void, parent?: Node, key = '') {
  if (!n || typeof n !== 'object') return;
  if (Array.isArray(n)) {
    for (const c of n) walk(c, visit, parent, key);
    return;
  }
  const node = n as Node;
  if (typeof node.type === 'string') {
    if (visit(node, parent, key) === false) return;
    parent = node;
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === 'metadata' || k === 'parent' || k === 'loc' || k === 'name_loc') continue;
    if (v && typeof v === 'object') walk(v, visit, typeof node.type === 'string' ? node : parent, k);
  }
}

/** A string literal's value (a literal or a template without expressions), or undefined. */
function stringOf(n: unknown): string | undefined {
  const node = n as Node | undefined;
  if (!node) return undefined;
  if ((node.type === 'Literal' || node.type === 'StringLiteral') && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && (node.expressions as unknown[]).length === 0) return ((node.quasis as Node[])[0].value as { cooked: string }).cooked;
  return undefined;
}

/** The dotted name of a callee (`ask.confirm`, `t`, `console.log`). */
function calleeName(n: Node | undefined): string {
  if (!n) return '';
  if (n.type === 'Identifier') return n.name as string;
  if (n.type === 'MemberExpression' && !n.computed) return `${calleeName(n.object as Node)}.${(n.property as Node).name as string}`;
  if (n.type === 'ThisExpression') return 'this';
  return '';
}

/**
 * Whether message words are a headline with a line under it (`Couldn't start {{name}}\nIt's running elsewhere.`): a
 * first line with words of its own that ends as a headline does (no period, question mark, colon or ellipsis), and a
 * line after it. A first line that is only a parameter (a tooltip's `{{name}}\n{{about}}`) or a sentence isn't one.
 */
export const loneLine = (message: string) => {
  const nl = message.indexOf('\n');
  if (nl < 0) return false;
  const first = message.slice(0, nl).trim();
  return /\p{L}/u.test(first.replace(/\{\{[^}]*\}\}|<\/?[a-z][a-z0-9-]*>/g, '')) && !/[.?!:…]$/.test(first) && message.slice(nl + 1).trim() !== '';
};

/** Words that read as prose: three words or more, of letters, with an article, a verb or the like among them. */
const PROSE_WORD = /^(the|a|an|is|are|was|were|be|been|it|its|this|that|these|those|to|of|in|on|for|with|from|and|or|but|not|no|can|can't|couldn't|isn't|doesn't|didn't|won't|will|has|have|had|your|you)$/;

/** Whether string `s` reads as a sentence for a user: a capital, then words, at least three. */
const sentence = (s: string): boolean => {
  // A field's value is read as its own words (`Description=The emulator's …`, a unit's line).
  const field = /^[A-Z][\w.-]*=(.+)$/s.exec(s.trim());
  if (field) return sentence(field[1]) || lowerSentence(field[1]);
  const t = s.trim();
  if (!/^[A-Z][a-z’']*(?:[ ,;:()\-–—][^\s]*){2,}/.test(t) || !/\p{Ll}{2}/u.test(s) || /[{}<>=]|^\w+\(|\$\{|https?:|\/\//.test(s)) return false;
  // A `;` joins two clauses of prose ("…; roses are red."), not declarations (`a: b; c: d`).
  return !s.includes(';') || s.split(';').every((part, i) => i === 0 || /^ [a-z’']+(?: [^\s;:]+){1,}/.test(part));
};

/**
 * Whether lower-case string `s` reads as a sentence for a user: four words or more, only letters and a little
 * punctuation, a sentence's end (a period, a question or an ellipsis), and at least two of `PROSE_WORD`. A developer's
 * phrase (a log line, an invariant) lives in a `console`/`Error` call, which the checks skip; this catches copy that
 * starts in lower case.
 */
const lowerSentence = (s: string) => {
  const t = s.trim();
  if (!/^[a-z][a-z’']*(?: [a-z’',()-]+){3,}[.?!…]$/.test(t)) return false;
  return t.split(/[ ,()]+/).filter((w) => PROSE_WORD.test(w.replace(/[.?!…]$/, ''))).length >= 2;
};

/** Words in `s`: a letter anywhere. */
const letters = (s: string) => /\p{L}/u.test(s);

type Parsed = { program: unknown; svelte?: { fragment: unknown; instance?: unknown; module?: unknown }; text: string; path: string };

function parseSource(src: Source): Parsed | Problem {
  try {
    if (src.path.endsWith('.svelte')) {
      const ast = parseSvelte(src.text, { modern: true }) as unknown as { fragment: unknown; instance?: { content: unknown }; module?: { content: unknown } };
      return { program: [ast.instance?.content, ast.module?.content].filter(Boolean), svelte: { fragment: ast.fragment, instance: ast.instance, module: ast.module }, text: src.text, path: src.path };
    }
    const r = parseSync(src.path, src.text, { lang: 'ts', sourceType: 'module' } as never) as unknown as { program: unknown; errors: { message: string }[] };
    if (r.errors.length) return { path: src.path, line: 1, text: `can't parse: ${r.errors[0].message}` };
    return { program: r.program, text: src.text, path: src.path };
  } catch (e) {
    return { path: src.path, line: 1, text: `can't parse: ${(e as Error).message}` };
  }
}

/** A key's message, or its plural forms', with every name they use. */
function lookup(catalogs: Catalogs, key: string): { words: string[]; vars: Set<string> } | undefined {
  const m = KEY_RE.exec(key);
  if (!m) return undefined;
  const c = catalogs[m[1]];
  if (!c) return undefined;
  if (c[m[2]]) return { words: [c[m[2]].message], vars: varsOf(c[m[2]].message) };
  const forms = Object.keys(c).filter((k) => PLURAL.test(k) && baseKey(k) === m[2]);
  if (!forms.length) return undefined;
  const vars = new Set<string>(['count']);
  for (const f of forms) for (const v of varsOf(c[f].message)) vars.add(v);
  return { words: forms.map((f) => c[f].message), vars };
}

/** Whether a source line (or the one before it) waives the copy checks. */
function waived(text: string, line: number) {
  const lines = text.split('\n');
  return /i18n-ignore(?!-next)/.test(lines[line - 1] ?? '') || /i18n-ignore-next/.test(lines[line - 2] ?? '');
}

/** The checks on the catalog and the sources (everything but the docs and the workers' imports). */
/** Parameters that always carry a name someone gave: a machine's, machines', an overlay's, a shared folder's, a holder's. */
const NAME_PARAMS = new Set(['machine', 'machines', 'overlay', 'folder', 'holder', 'connection']);
/** A note that says a parameter is a name someone gave (`{{name}} is the machine's name`, `{{disk}}: the disk's name`). */
const NAMED_IN_NOTE = /\{\{(\w+)\}\}(?: is| are|:|,)? (?:the |its |their |that )?(?:(?:machine|disk|overlay|folder|snapshot|connection|room|device|file|stored disk)(?:'s|s') )?(?:current )?names?\b/g;
const REFERENCE_MARKER = /<(name|ui|ui-[a-z0-9-]+)>([^<]*)<\/\1>/g;

/**
 * What's wrong with a message's references (web/i18n.ts `REFERENCE`, docs/i18n.md "Markers"): a `<name>` holds one
 * parameter and nothing else; a `<ui-…>` names an icon of web/app/icons.ts (`icons`, when known); a parameter that is a
 * name someone gave (by its own name, or as the note describes it) is marked.
 */
export function referenceProblems(message: string, note: string, icons?: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const marked = new Set<string>();
  for (const m of message.matchAll(REFERENCE_MARKER)) {
    const [, tag, inner] = m;
    if (tag === 'name' && !/^\{\{\s*\w+\s*\}\}$/.test(inner)) out.push(`<name>${inner}</name>: a <name> holds one parameter, the name, and nothing else`);
    if (tag.startsWith('ui-') && icons && !icons.has(tag.slice(3))) out.push(`<${tag}>: no icon ${tag.slice(3)} in web/app/icons.ts`);
  }
  // Every parameter inside a marker (a name in <code> is marked too).
  for (const m of message.matchAll(/<([a-z][a-z0-9-]*)>([^<]*)<\/\1>/g)) for (const v of m[2].matchAll(/\{\{\s*(\w+)/g)) marked.add(v[1]);
  const names = new Set([...varsOf(message)].filter((v) => NAME_PARAMS.has(v)));
  for (const m of note.matchAll(NAMED_IN_NOTE)) if (varsOf(message).has(m[1])) names.add(m[1]);
  for (const v of names) if (!marked.has(v)) out.push(`{{${v}}} is a name someone gave: <name>{{${v}}}</name> (docs/i18n.md "Markers"; a parameter that is a message, "the disk <name>…</name>", isn't one: say so in the note)`);
  return out;
}

export function checkSources(raw: Catalogs, sources: Source[], o: { copyChecks?: (path: string) => boolean; icons?: ReadonlySet<string> } = {}): Problem[] {
  const problems: Problem[] = [];
  const catalogs = expanded(raw);
  const referenced = new Set<string>(); // keys a message says in its words (`$t(key)`)
  const say = (path: string, line: number, text: string) => problems.push({ path, line, text });
  const copyChecks = o.copyChecks ?? ((p: string) => /(^|\/)web\//.test(p));

  // The catalog itself.
  for (const [ns, c] of Object.entries(raw)) {
    const file = `web/messages/en/${ns}.json`;
    for (const [k, e] of Object.entries(c)) {
      if (!/^[A-Za-z0-9-]+(\.[A-Za-z0-9_-]+)+$/.test(k)) say(file, 1, `${ns}:${k}: a key is <Source>.<name> (letters, digits, - and _)`);
      if (typeof e !== 'object' || e === null || typeof e.message !== 'string') { say(file, 1, `${ns}:${k}: no "message"`); continue; }
      if (typeof e.note !== 'string' || e.note.trim().length < 10) say(file, 1, `${ns}:${k}: its "note" (where and how the words are shown) is missing or too short`);
      const extra = Object.keys(e).filter((x) => x !== 'message' && x !== 'note');
      if (extra.length) say(file, 1, `${ns}:${k}: unknown fields ${extra.join(', ')}`);
      if (/\{\{[^}]*$|^[^{]*\}\}/.test(e.message)) say(file, 1, `${ns}:${k}: unbalanced {{ }} in its words`);
      for (const m of e.message.matchAll(REF)) {
        const ref = m[1], r = KEY_RE.exec(ref), to = r ? raw[r[1]]?.[r[2]] : undefined;
        if (!to) { say(file, 1, `${ns}:${k}: ${m[0]} names no message (a reference is $t(ns:Source.name), a whole entry without options)`); continue; }
        referenced.add(ref);
        if (/\{\{/.test(to.message) || PLURAL.test(r![2])) say(file, 1, `${ns}:${k}: ${m[0]} names a message with parameters or plural forms: a reference says fixed words`);
        if (expand(to.message, raw).includes('$t(')) say(file, 1, `${ns}:${k}: ${m[0]} doesn't resolve (a reference to itself, or deeper than 8)`);
      }
      for (const why of referenceProblems(e.message, e.note, o.icons)) say(file, 1, `${ns}:${k}: ${why}`);
      if (loneLine(expand(e.message, raw))) say(file, 1, `${ns}:${k}: a headline and a line under it in one message: the headline is a message, the line its cause (new MsgError(headline, …, { cause: new MsgError(…) }); docs/copy.md "The elements")`);
    }
  }

  const named = new Map<string, Set<string>>(); // key → stems of the files that name it
  const stems = new Set(sources.map((s) => stemOf(s.path)));

  for (const src of sources) {
    const p = parseSource(src);
    if ('line' in p) { problems.push(p); continue; }
    const stem = stemOf(src.path);
    const copy = copyChecks(src.path);
    const at = (n: { start: number }) => lineAt(src.text, n.start);
    const keyNode = (n: Node | undefined) => {
      const s = stringOf(n);
      return s !== undefined && KEY_RE.test(s) && catalogs[KEY_RE.exec(s)![1]] ? s : undefined;
    };

    // The file's bindings, by name, for what a call's key or parameters are when they aren't written in it: `const x =
    // …` or `const [a, b] = …` (a value), or a function's or a catch's parameter, a loop's or a pattern's (unknown);
    // a use takes its innermost scope's, one bound twice there being unknown.
    type Binding = { v: { init: Node; index?: number } | null; scope: Node };
    const bindings = new Map<string, Binding[]>();
    const bind = (name: string, v: Binding['v'], scope: Node) => bindings.set(name, [...(bindings.get(name) ?? []), { v, scope }]);
    const bindPattern = (pat: Node | null | undefined, scope: Node) => {
      if (!pat) return;
      if (pat.type === 'Identifier') bind(pat.name as string, null, scope);
      else if (pat.type === 'ArrayPattern') for (const el of pat.elements as (Node | null)[]) bindPattern(el, scope);
      else if (pat.type === 'ObjectPattern') for (const pr of pat.properties as Node[]) bindPattern((pr.type === 'RestElement' ? pr.argument : pr.value) as Node, scope);
      else if (pat.type === 'AssignmentPattern') bindPattern(pat.left as Node, scope);
      else if (pat.type === 'RestElement') bindPattern(pat.argument as Node, scope);
      else if (pat.type === 'TSParameterProperty') bindPattern(pat.parameter as Node, scope);
    };
    const SCOPE = /^(Program|BlockStatement|StaticBlock|SwitchStatement|ForStatement|ForInStatement|ForOfStatement|CatchClause)$|Function/;
    const scan = (n: unknown, scope: Node) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) { for (const c of n) scan(c, scope); return; }
      const node = n as Node;
      if (typeof node.type !== 'string') return;
      const here = SCOPE.test(node.type) ? node : scope;
      if (node.type === 'VariableDeclarator') {
        const id = node.id as Node, init = node.init as Node | null;
        if (init && id.type === 'Identifier') bind(id.name as string, { init }, scope);
        else if (init && id.type === 'ArrayPattern') (id.elements as (Node | null)[]).forEach((el, index) => (el?.type === 'Identifier' ? bind(el.name as string, { init, index }, scope) : bindPattern(el, scope)));
        else bindPattern(id, scope);
      } else if (/Function/.test(node.type)) for (const prm of (node.params as Node[] | undefined) ?? []) bindPattern(prm, here);
      else if (node.type === 'CatchClause') bindPattern(node.param as Node | null, here);
      for (const [k, v] of Object.entries(node)) if (k !== 'metadata' && k !== 'parent' && k !== 'loc' && v && typeof v === 'object') scan(v, here);
    };
    const top = { type: 'Program', start: 0, end: src.text.length } as Node;
    scan(p.program, top);
    /** The value name `name` has where it's used, at `at`: its innermost scope's binding (undefined if unknown). */
    const bound = (name: string, at: number) => {
      const around = (bindings.get(name) ?? []).filter((b) => b.scope.start <= at && at < b.scope.end);
      if (!around.length) return undefined;
      const inner = Math.min(...around.map((b) => b.scope.end - b.scope.start));
      const mine = around.filter((b) => b.scope.end - b.scope.start === inner);
      return mine.length === 1 ? mine[0].v ?? undefined : undefined;
    };
    const strip = (n: Node | undefined): Node | undefined => {
      while (n && /^(TSAsExpression|TSSatisfiesExpression|TSNonNullExpression|TSTypeAssertion|ParenthesizedExpression)$/.test(n.type)) n = n.expression as Node;
      return n;
    };
    /** What expression `n` may be (its element `index`, if given), through conditionals, `??`/`||`, the file's constants and maps; undefined if it can't be told. */
    const values = (n: Node | undefined, index?: number, depth = 0): Node[] | undefined => {
      n = strip(n);
      if (!n || depth > 8) return undefined;
      if (index !== undefined) {
        const whole = values(n, undefined, depth + 1);
        if (!whole) return undefined;
        const out: Node[] = [];
        for (const w of whole) {
          if (w.type !== 'ArrayExpression') return undefined;
          const el = (w.elements as (Node | null)[])[index];
          const v = el ? values(el, undefined, depth + 1) : [];
          if (!v) return undefined;
          out.push(...v);
        }
        return out;
      }
      const both = (a: Node, b: Node) => {
        const x = values(a, undefined, depth + 1), y = values(b, undefined, depth + 1);
        return x && y ? [...x, ...y] : undefined;
      };
      if (n.type === 'ConditionalExpression') return both(n.consequent as Node, n.alternate as Node);
      if (n.type === 'LogicalExpression' && n.operator !== '&&') return both(n.left as Node, n.right as Node);
      if (n.type === 'Identifier' && n.name !== 'undefined') {
        const c = bound(n.name as string, n.start);
        return c ? values(c.init, c.index, depth + 1) : undefined;
      }
      if (n.type === 'MemberExpression') {
        const objs = values(n.object as Node, undefined, depth + 1);
        if (!objs || !objs.every((o) => o.type === 'ObjectExpression')) return undefined;
        const prop = n.computed ? stringOf(n.property) : ((n.property as Node).name as string);
        const out: Node[] = [];
        for (const o of objs) {
          for (const pr of o.properties as Node[]) {
            if (pr.type !== 'Property') return undefined;
            const k = pr.computed ? undefined : (((pr.key as Node).name as string | undefined) ?? String((pr.key as Node).value));
            if (prop !== undefined && k !== prop) continue;
            const v = values(pr.value as Node, undefined, depth + 1);
            if (!v) return undefined;
            out.push(...v);
          }
        }
        return out;
      }
      return [n];
    };
    /** The keys expression `n` may be (a `''` or other words that aren't a key: none), or undefined if it can't be told. */
    const keysOf = (n: Node | undefined): string[] | undefined => {
      const vs = values(n);
      if (!vs) return undefined;
      const out: string[] = [];
      for (const v of vs) {
        const s = stringOf(v);
        if (s === undefined) return undefined;
        if (keyNode(v)) out.push(s);
      }
      return out;
    };
    /** The names each object that expression `n` may be gives (none for `undefined`), or undefined if one can't be told. */
    const givenOf = (n: Node | undefined, depth = 0): Set<string>[] | undefined => {
      if (!n) return [new Set()];
      const vs = values(n);
      if (!vs || depth > 4) return undefined;
      const out: Set<string>[] = [];
      for (const v of vs) {
        if (v.type === 'Identifier' && v.name === 'undefined') { out.push(new Set()); continue; }
        if (v.type !== 'ObjectExpression') return undefined;
        let sets = [new Set<string>()];
        for (const pr of v.properties as Node[]) {
          if (pr.type === 'SpreadElement') {
            const inner = givenOf(pr.argument as Node, depth + 1);
            if (!inner) return undefined;
            sets = sets.flatMap((s) => inner.map((i) => new Set([...s, ...i])));
          } else if (pr.type !== 'Property' || pr.computed) return undefined;
          else for (const s of sets) s.add(((pr.key as Node).name as string | undefined) ?? String((pr.key as Node).value));
        }
        out.push(...sets);
      }
      return out;
    };
    /** Checks the parameters a call gives (`params`) against the words of every key it may name (`keyExpr`). */
    const checkCall = (keyExpr: Node, params: Node | undefined, line: number) => {
      const k = strip(keyExpr), pr = strip(params);
      // A key and its parameters chosen by the same condition go in pairs.
      if (k?.type === 'ConditionalExpression' && pr?.type === 'ConditionalExpression' && src.text.slice((k.test as Node).start, (k.test as Node).end) === src.text.slice((pr.test as Node).start, (pr.test as Node).end)) {
        checkCall(k.consequent as Node, pr.consequent as Node, line);
        checkCall(k.alternate as Node, pr.alternate as Node, line);
        return;
      }
      const keys = keysOf(keyExpr);
      const given = givenOf(params);
      if (!keys || !given) return; // built at run time: not checked here
      const via = stringOf(k) === undefined ? ` (the key through ${src.text.slice(keyExpr.start, keyExpr.end).replace(/\s+/g, ' ').slice(0, 40)})` : '';
      const said = new Set<string>();
      for (const key of keys) {
        const found = lookup(catalogs, key);
        if (!found) continue;
        for (const g of given) {
          const missing = [...found.vars].filter((v) => !g.has(v));
          const extra = [...g].filter((v) => !found.vars.has(v));
          if (missing.length) said.add(`${key}: its words use ${missing.map((v) => `{{${v}}}`).join(', ')}, not given${via}`);
          if (extra.length) said.add(`${key}: ${extra.join(', ')} given, but its words don't use ${extra.length > 1 ? 'them' : 'it'}${via}`);
        }
      }
      for (const s of said) say(src.path, line, s);
    };
    /** The checks on `<T k params>`, whose key is a literal. */
    const checkParams = (key: string, obj: Node | undefined, line: number) => checkCall({ type: 'Literal', value: key, start: 0, end: 0 } as Node, obj, line);

    // Keys named in the code (and a component's markup), and their parameters.
    walk([p.program, p.svelte?.fragment], (n, parent, field) => {
      const s = stringOf(n);
      if (s !== undefined) {
        const m = KEY_RE.exec(s);
        if (m && !catalogs[m[1]] && stems.has(m[2].split('.')[0])) say(src.path, at(n), `${s}: no catalog named ${m[1]} (${Object.keys(catalogs).join(', ')})`);
        if (m && catalogs[m[1]]) {
          const line = at(n);
          if (!lookup(catalogs, s)) say(src.path, line, `${s}: no such message in web/messages/en/${m[1]}.json`);
          const set = named.get(s) ?? new Set();
          set.add(stem);
          named.set(s, set);
        }
      } else if (n.type === 'TemplateLiteral') {
        const first = ((n.quasis as Node[])[0].value as { cooked: string }).cooked;
        const m = /^([a-z][a-z0-9-]*):/.exec(first);
        if (m && catalogs[m[1]] && (n.expressions as unknown[]).length) say(src.path, at(n), `a key built at run time (\`${first}…\`): name every key as a literal (a map from a code to its key, if need be)`);
      }
      // A call that names a key: its parameters are the second argument.
      if ((n.type === 'CallExpression' || n.type === 'NewExpression') && (n.arguments as Node[]).length) {
        const callee = calleeName(n.callee as Node);
        const first = (n.arguments as Node[])[0];
        if (/(^|\.)(t|msg|text|plain)$|Error$|^ask\./.test(callee) || (n.type === 'NewExpression' && keyNode(first))) checkCall(first, (n.arguments as Node[])[1], at(n));
      }
    });

    /** The keys a markup expression renders as text: `t(key…)`, in a conditional's branches or after `??`/`||`. */
    const textKeys = (e: Node | undefined): string[] => {
      if (!e) return [];
      if (e.type === 'ConditionalExpression') return [...textKeys(e.consequent as Node), ...textKeys(e.alternate as Node)];
      if (e.type === 'LogicalExpression') return [...textKeys(e.left as Node), ...textKeys(e.right as Node)];
      if (e.type === 'CallExpression' && /^(t|text)$/.test(calleeName(e.callee as Node))) {
        const k = keyNode((e.arguments as Node[])[0]);
        return k ? [k] : [];
      }
      return [];
    };
    const hasReferences = (key: string) => (lookup(catalogs, key)?.words ?? []).some((w) => /<(name|ui|ui-[a-z0-9-]+)>/.test(w));

    // Svelte's markup: <T k="…" params={…}>, keys in its expressions, and its words.
    if (p.svelte) {
      walk(p.svelte.fragment, (n, parent) => {
        if (n.type === 'Component' && n.name === 'T') {
          const attrs = n.attributes as Node[];
          const kAttr = attrs.find((a) => a.type === 'Attribute' && a.name === 'k');
          const v = kAttr && Array.isArray(kAttr.value) && (kAttr.value as Node[]).length === 1 && (kAttr.value as Node[])[0].type === 'Text' ? ((kAttr.value as Node[])[0].data as string) : undefined;
          // `m={…}`: a message made elsewhere (its key and parameters checked where it's made).
          if (!v && !attrs.some((a) => a.type === 'Attribute' && a.name === 'm')) say(src.path, at(n), '<T>: its k is a literal key');
          else if (v) {
            const set = named.get(v) ?? new Set();
            set.add(stem);
            named.set(v, set);
            if (!lookup(catalogs, v)) say(src.path, at(n), `${v}: no such message`);
            const pAttr = attrs.find((a) => a.type === 'Attribute' && a.name === 'params');
            const expr = pAttr && !Array.isArray(pAttr.value) && pAttr.value !== true ? ((pAttr.value as Node).expression as Node) : undefined;
            checkParams(v, expr, at(n));
          }
        }
        if (!copy) return;
        if (n.type === 'Text' && parent?.type !== 'Attribute' && letters(n.data as string) && !waived(src.text, at(n))) {
          // Skip a <style> or <script> (parsed apart) and words inside <code> or <kbd> (a command, a key).
          say(src.path, at(n), `words in the markup: "${(n.data as string).trim().slice(0, 60)}" (a message: {t('…')} or <T k="…">)`);
        }
        if ((n.type === 'Attribute') && COPY_ATTRS.has(n.name as string)) {
          const vals = Array.isArray(n.value) ? (n.value as Node[]) : n.value === true ? [] : [n.value as Node];
          for (const v of vals) {
            if (v.type === 'Text' && letters(v.data as string) && !waived(src.text, at(v))) say(src.path, at(v), `${n.name as string}="${(v.data as string).slice(0, 60)}": words in an attribute (a message: ${n.name as string}={t('…')})`);
            if (v.type === 'ExpressionTag') resultStrings(v.expression as Node, (lit) => { if (letters(stringOf(lit)!) && !waived(src.text, at(lit))) say(src.path, at(lit), `${n.name as string}: the words "${stringOf(lit)!.slice(0, 60)}" (a message)`); });
          }
          return false;
        }
        if (n.type === 'ExpressionTag' && parent?.type !== 'Attribute') {
          for (const key of textKeys(n.expression as Node)) if (hasReferences(key)) say(src.path, at(n), `{t('${key}')}: its words mark names or the page's elements: draw it with <T k="${key}" params={…}> (docs/i18n.md "Markers")`);
        }
        if (n.type === 'Component' && n.name === 'Modal') {
          const title = (n.attributes as Node[]).find((a) => a.type === 'Attribute' && a.name === 'title');
          const expr = title && !Array.isArray(title.value) && title.value !== true ? ((title.value as Node).expression as Node) : undefined;
          for (const key of expr ? textKeys(expr) : []) if (hasReferences(key)) say(src.path, at(title!), `title={t('${key}')}: its words mark names or the page's elements: title={msg('${key}', …)} (docs/i18n.md "Markers")`);
        }
        if (n.type === 'ExpressionTag' && parent?.type !== 'Attribute') {
          resultStrings(n.expression as Node, (lit) => { if (letters(stringOf(lit)!) && !waived(src.text, at(lit))) say(src.path, at(lit), `{…}: the words "${stringOf(lit)!.slice(0, 60)}" (a message)`); });
        }
        if (n.type === 'RegularElement' && (n.name === 'code' || n.name === 'kbd' || n.name === 'style' || n.name === 'script')) return false;
      });
    }

    // A caught error's developer text shown to the user.
    if (copy) shownMessages(p, (n, what) => { if (!waived(src.text, at(n))) say(src.path, at(n), what); });

    // Copy in the code: copy properties, sentence-like strings, DOM words.
    if (copy) {
      walk(p.program, (n, parent, field) => {
        if ((n.type === 'CallExpression' || n.type === 'NewExpression') && DEV_CALLS.test(calleeName(n.callee as Node))) return false;
        if (n.type === 'TSLiteralType' || n.type === 'TSTypeAnnotation' || n.type === 'TSTypeAliasDeclaration' || n.type === 'TSInterfaceDeclaration' || n.type === 'ImportDeclaration' || n.type === 'ExportAllDeclaration' || n.type === 'ExportNamedDeclaration' && n.source) return n.type === 'ExportNamedDeclaration' ? undefined : false;
        const s = stringOf(n);
        const quasi = n.type === 'TemplateLiteral' ? (n.quasis as Node[]).map((q) => (q.value as { cooked: string }).cooked).join(' … ') : undefined;
        const words = s ?? quasi;
        if (words === undefined || KEY_RE.test(words) || waived(src.text, at(n))) return;
        if (parent?.type === 'Property' && field === 'value' && !parent.computed && COPY_PROPS.has(((parent.key as Node).name as string) ?? String((parent.key as Node).value)) && /\p{L}{2}/u.test(words) && /[A-Z\s…]/.test(words)) {
          say(src.path, at(n), `${((parent.key as Node).name as string) ?? ''}: "${words.slice(0, 60)}" (a message)`);
          return;
        }
        if (parent?.type === 'AssignmentExpression' && field === 'right' && /\.(textContent|innerText|title|placeholder|ariaLabel|alt)$/.test(calleeName(parent.left as Node)) && letters(words)) {
          say(src.path, at(n), `${calleeName(parent.left as Node)} = "${words.slice(0, 60)}" (a message)`);
          return;
        }
        if ((sentence(words) || lowerSentence(words)) && !(parent?.type === 'Property' && field === 'key')) say(src.path, at(n), `"${words.slice(0, 60)}" reads as words for the user (a message, or i18n-ignore if it isn't)`);
      });
    }
  }

  // Every entry is named, by a file of its source's stem.
  for (const [ns, c] of Object.entries(catalogs)) {
    for (const k of new Set(Object.keys(c).map(baseKey))) {
      const key = `${ns}:${k}`;
      const by = named.get(key);
      const want = k.split('.')[0];
      // An entry other messages say (the product's name) needs no source of its own.
      if (referenced.has(key) && (!by || by.has(want) || !stems.has(want))) continue;
      if (!by) say(`web/messages/en/${ns}.json`, 1, `${key}: named by no source`);
      else if (!by.has(want)) say(`web/messages/en/${ns}.json`, 1, `${key}: named in ${[...by].join(', ')}, not in ${want}${stems.has(want) ? '' : ` (no source named ${want})`}: a key starts with the stem of the file that uses it`);
    }
  }
  return problems;
}

/** Calls that show what they're given to the user (the message bar, a dialog, the state's words). */
const SHOW_CALLS = /^(notify|setState|showMessage|stateText|said|fail|ask\.\w+|alert|confirm|prompt)$/;
/** Calls whose parameters are a message's (`t('…', { why: … })`). */
const MESSAGE_CALLS = /(^|\.)(t|msg|text)$|Error$/;

/**
 * Code that shows a caught error's `.message` to the user: a `MsgError`'s is its developer text (its key and
 * parameters), so the page says an error with `describe`, `errorText` or `msgOf`. A caught error is a `catch`'s, or a
 * rejection handler's (`.catch(fn)`, `.then(_, fn)`); its `.message` (through `String`, a template, `??`, a
 * conditional) is flagged where it reaches a call that shows words, a message's parameter, the DOM's or the page's UI
 * state, a component's state shown in its markup, or the markup itself. `msgOf(e) ?? e.message` and the like (a
 * message first) are fine.
 */
function shownMessages(p: Parsed, say: (n: Node, what: string) => void) {
  // A component's state shown in its markup: assigning to it shows it.
  const shownNames = new Set<string>();
  if (p.svelte) walk(p.svelte.fragment, (n) => { if (n.type === 'Identifier') shownNames.add(n.name as string); });
  const paramNames = (ps: Node[] | undefined) => (ps ?? []).flatMap((x) => (x?.type === 'Identifier' ? [x.name as string] : x?.type === 'AssignmentPattern' && (x.left as Node).type === 'Identifier' ? [(x.left as Node).name as string] : []));
  const visit = (n: unknown, caught: Set<string>, anc: { node: Node; key: string }[], key: string) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { for (const c of n) visit(c, caught, anc, key); return; }
    const node = n as Node;
    if (typeof node.type !== 'string') return;
    let inner = caught;
    if (node.type === 'CatchClause' && (node.param as Node | null)?.type === 'Identifier') inner = new Set([...caught, (node.param as Node).name as string]);
    else if (/Function/.test(node.type)) {
      const names = paramNames(node.params as Node[]);
      const parent = anc.at(-1)?.node;
      const callee = parent?.type === 'CallExpression' ? calleeName(parent.callee as Node) : '';
      const args = parent?.type === 'CallExpression' ? (parent.arguments as Node[]) : [];
      const handler = (/\.catch$/.test(callee) && args[0] === node) || (/\.then$/.test(callee) && args[1] === node);
      inner = new Set([...caught].filter((x) => !names.includes(x)));
      if (handler && names[0]) inner.add(names[0]);
    }
    if (node.type === 'MemberExpression' && !node.computed && ((node.property as Node).name === 'message')) {
      let obj = node.object as Node;
      while (/^(TSAsExpression|TSNonNullExpression|ParenthesizedExpression|TSTypeAssertion)$/.test(obj.type)) obj = obj.expression as Node;
      if (obj.type === 'Identifier' && inner.has(obj.name as string)) {
        const sink = sinkOf(anc, node, shownNames);
        if (sink) say(node, `${obj.name as string}.message ${sink}: a MsgError's is its developer text (say the error with describe(), errorText() or msgOf(); i18n-ignore if it can't be one)`);
      }
    }
    const next = [...anc, { node, key }];
    for (const [k, v] of Object.entries(node)) {
      if (k === 'metadata' || k === 'parent' || k === 'loc' || k === 'name_loc') continue;
      if (v && typeof v === 'object') visit(v, inner, next, k);
    }
  };
  visit(p.program, new Set(), [], '');
}

/** Where the value of `n` goes when it's shown to the user (words for the problem), or undefined. */
function sinkOf(anc: { node: Node; key: string }[], n: Node, shownNames: Set<string>): string | undefined {
  let child = n;
  for (let i = anc.length - 1; i >= 0; i--) {
    const { node } = anc[i];
    const text = (x: unknown) => JSON.stringify(x ?? null);
    // A message first: the developer's text only for an error without one.
    if ((node.type === 'LogicalExpression' && node.right === child && /"msgOf"|"isMsg"|"describe"|"errorText"/.test(text(node.left)))
      || (node.type === 'ConditionalExpression' && /"msgOf"|"isMsg"|"MsgError"/.test(text(node.test)))) return undefined;
    // What keeps the value (or its words) as it is.
    if (/^(TemplateLiteral|ConditionalExpression|LogicalExpression|TSAsExpression|TSNonNullExpression|ParenthesizedExpression|ChainExpression|SpreadElement|ArrayExpression)$/.test(node.type)
      || (node.type === 'BinaryExpression' && node.operator === '+')
      || (node.type === 'CallExpression' && /^(String|\w+\.(slice|trim|replace|split|join|toString|substring))$/.test(calleeName(node.callee as Node)) && node.callee !== child)
      || (node.type === 'MemberExpression' && node.object === child)) { child = node; continue; }
    if ((node.type === 'CallExpression' || node.type === 'NewExpression') && (node.arguments as Node[]).includes(child)) {
      const name = calleeName(node.callee as Node);
      if (DEV_CALLS.test(name)) return undefined;
      return SHOW_CALLS.test(name) ? `is shown (${name}(…))` : undefined;
    }
    if (node.type === 'Property' && node.value === child) {
      const obj = anc[i - 1]?.node, call = anc[i - 2]?.node;
      if (obj?.type === 'ObjectExpression' && call && (call.type === 'CallExpression' || call.type === 'NewExpression') && (call.arguments as Node[]).indexOf(obj) >= 1 && MESSAGE_CALLS.test(calleeName(call.callee as Node))) return `is a message's parameter (${calleeName(call.callee as Node)}(…, { ${((node.key as Node).name as string) ?? ''}: … }))`;
      return undefined;
    }
    if (node.type === 'AssignmentExpression' && node.right === child) {
      const left = node.left as Node;
      const name = calleeName(left);
      if (/\.(textContent|innerText|innerHTML|title|placeholder|ariaLabel|alt)$|^ui\./.test(name)) return `is shown (${name} = …)`;
      if (left.type === 'Identifier' && shownNames.has(left.name as string)) return `is shown (${left.name as string}, in the markup)`;
      return undefined;
    }
    if (node.type === 'ExpressionTag') return 'is shown in the markup';
    return undefined;
  }
  return undefined;
}

/** The string results of an expression shown as words: itself, a conditional's branches, a `||`/`??`'s sides, a template's. */
function resultStrings(e: Node | undefined, found: (lit: Node) => void) {
  if (!e) return;
  if (stringOf(e) !== undefined) { if (!KEY_RE.test(stringOf(e)!)) found(e); return; }
  if (e.type === 'ConditionalExpression') { resultStrings(e.consequent as Node, found); resultStrings(e.alternate as Node, found); }
  else if (e.type === 'LogicalExpression') { resultStrings(e.left as Node, found); resultStrings(e.right as Node, found); }
  else if (e.type === 'TemplateLiteral' && (e.quasis as Node[]).some((q) => letters((q.value as { cooked: string }).cooked))) found({ ...e, type: 'Literal', value: (e.quasis as Node[]).map((q) => (q.value as { cooked: string }).cooked).join('…') } as Node);
  else if (e.type === 'BinaryExpression' && e.operator === '+') { resultStrings(e.left as Node, found); resultStrings(e.right as Node, found); }
}

/** Modules reached from each worker's entry that render words (web/i18n.ts, i18next): a worker posts data, the page says it. */
export function checkWorkers(root: string, sources: Source[]): Problem[] {
  const problems: Problem[] = [];
  const byPath = new Map(sources.map((s) => [resolve(root, s.path), s]));
  const importsOf = new Map<string, string[]>();
  const entries: { file: string; from: string; line: number }[] = [];
  for (const s of sources) {
    const abs = resolve(root, s.path);
    const p = parseSource(s);
    if ('line' in p) continue;
    const out: string[] = [];
    walk(p.program, (n) => {
      if ((n.type === 'ImportDeclaration' && n.importKind !== 'type') || ((n.type === 'ExportNamedDeclaration' || n.type === 'ExportAllDeclaration') && n.source && n.exportKind !== 'type')) out.push(stringOf(n.source) ?? '');
      if (n.type === 'ImportExpression') { const v = stringOf(n.source); if (v) out.push(v); }
      if (n.type === 'NewExpression' && /^(Worker|SharedWorker)$/.test(calleeName(n.callee as Node)) || n.type === 'CallExpression' && /\.addModule$/.test(calleeName(n.callee as Node))) {
        const u = (n.arguments as Node[])[0];
        if (u?.type === 'NewExpression' && calleeName(u.callee as Node) === 'URL') {
          const rel = stringOf((u.arguments as Node[])[0]);
          if (rel?.startsWith('.')) entries.push({ file: resolve(dirname(abs), rel), from: s.path, line: lineAt(s.text, n.start) });
        }
      }
    });
    // A module imported as a worker's URL (Vite's `?worker&url`, the audio worklet) is an entry too.
    for (const spec of out) if (/^\..*\?worker\b/.test(spec)) entries.push({ file: resolve(dirname(abs), spec.replace(/\?.*$/, '')), from: s.path, line: 1 });
    importsOf.set(abs, out.map((spec) => (spec.startsWith('.') ? resolve(dirname(abs), spec.replace(/\?.*$/, '')) : spec)));
  }
  const renderer = resolve(root, 'web/i18n.ts');
  for (const e of entries) {
    const seen = new Map<string, string | undefined>([[e.file, undefined]]);
    const queue = [e.file];
    while (queue.length) {
      const f = queue.shift()!;
      for (const d of importsOf.get(f) ?? []) {
        if (seen.has(d)) continue;
        seen.set(d, f);
        if (d === renderer || d === 'i18next') {
          const chain = [d];
          for (let c = f; c; c = seen.get(c)!) chain.unshift(c);
          problems.push({ path: e.from, line: e.line, text: `the worker ${relative(root, e.file)} reaches ${d === 'i18next' ? 'i18next' : 'web/i18n.ts'} (${chain.map((c) => (c.startsWith('/') ? relative(root, c) : c)).join(' → ')}): a worker posts a Msg, the page renders it` });
          queue.length = 0;
          break;
        }
        if (byPath.has(d)) queue.push(d);
      }
    }
  }
  return problems;
}

const expandedCache = new WeakMap<Catalogs, Catalogs>();
/** `expanded(catalogs)`, once per catalogs (the docs are checked one by one). */
function expandedOnce(catalogs: Catalogs): Catalogs {
  let e = expandedCache.get(catalogs);
  if (!e) expandedCache.set(catalogs, (e = expanded(catalogs)));
  return e;
}

/** A UI quote in the docs, `[words](ui:key)`: its words may be broken across two lines (a paragraph's wrap). */
const UI_QUOTE = () => /\[([^\]\n]+(?:\n[^\]\n]+)?)\]\(ui:([^)\s]+)\)/g;

/** The docs' UI quotes against the catalog; with `fix`, the quotes' words rewritten (the new text, if any changed). */
export function checkDoc(raw: Catalogs, path: string, text: string, fix = false): { problems: Problem[]; fixed?: string } {
  const problems: Problem[] = [];
  const catalogs = expandedOnce(raw);
  // Every message's plain words, for quotes that aren't marked yet.
  const byWords = new Map<string, string>();
  for (const [ns, c] of Object.entries(catalogs)) for (const [k, e] of Object.entries(c)) if (!e.message.includes('{{')) byWords.set(plainWords(e.message), `${ns}:${k}`);
  let changed = false;
  // Code (fenced or inline) says commands, not the page's words.
  const masked = text.replace(/```[\s\S]*?```/g, (m) => m.replace(/[^\n]/g, ' ')).replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length));
  const out = masked.replace(UI_QUOTE(), (whole, words: string, key: string, offset: number) => {
    const line = lineAt(text, offset);
    const found = lookup(catalogs, key);
    if (!found) { problems.push({ path, line, text: `[${words}](ui:${key}): no such message` }); return text.slice(offset, offset + whole.length); }
    const said = words.replace(/\*+|_+/g, '');
    const one = said.replace(/\s+/g, ' ').trim();
    const ok = found.words.some((w) => new RegExp(`^${plainWords(w).replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\\?\{\\?\{[^}]*\}\}/g, '.+')}$`, 'u').test(one) || plainWords(w) === one);
    if (ok) return text.slice(offset, offset + whole.length);
    if (fix && found.words.length === 1 && !found.words[0].includes('{{')) {
      changed = true;
      return `[${words.replace(said.trim(), plainWords(found.words[0]))}](ui:${key})`;
    }
    problems.push({ path, line, text: `[${words.replace(/\s+/g, ' ')}](ui:${key}): the page says "${plainWords(found.words[0])}"${fix ? ' (has parameters: fix it by hand)' : ' (node tools/i18n-check.ts --fix-docs)'}` });
    return text.slice(offset, offset + whole.length);
  });
  // Quotes of a message's words that aren't marked as UI quotes.
  const unlinked = masked.replace(UI_QUOTE(), (m) => ' '.repeat(m.length));
  // A quote may be broken across two lines too.
  for (const m of unlinked.matchAll(/\*\*([^*\n]+(?:\n[^*\n]+)?)\*\*|(?<![*\w])\*([^*\s][^*\n]*(?:\n[^*\n]+)?)\*(?![*\w])|"([^"\n]+(?:\n[^"\n]+)?)"|“([^”\n]+(?:\n[^”\n]+)?)”/g)) {
    const w = (m[1] ?? m[2] ?? m[3] ?? m[4]).replace(/\s+/g, ' ').trim();
    const key = byWords.get(w);
    if (key && (/…$/.test(w) || /\s/.test(w))) problems.push({ path, line: lineAt(text, m.index), text: `"${w}" quotes the page: write it as [${w}](ui:${key})` });
  }
  if (!changed) return { problems };
  // Put the rewritten quotes into the original text (the masked copy only located them).
  let result = '', at = 0;
  const re = UI_QUOTE();
  const fixedQuotes = [...out.matchAll(re)];
  const origQuotes = [...masked.matchAll(re)];
  origQuotes.forEach((o, i) => { result += text.slice(at, o.index) + fixedQuotes[i][0]; at = o.index + o[0].length; });
  return { problems, fixed: result + text.slice(at) };
}

/** Tests whose literals may say the page's words: the renderer's own. */
const WORDING_FILES = new Set(['tests/i18n.test.ts']);

/**
 * The tests' words: a test reads the page's words through `t(key)` (or checks a key or an element), so a change of
 * words changes no test. A string, template or regex literal is flagged when it says a message's words: two words or
 * more of one (or a message ending in "…"), or a capitalized one-word message whole (`'Retry'`, `/^Sound$/`; a
 * lower-case word is most often a state's value in the code, not copy; a keyboard key's label is a key's name). A test named `wording: …` pins words on
 * purpose and is skipped, as is a line with `i18n-ignore` (data that reads like a message: a peer's state).
 */
export function checkTests(raw: Catalogs, sources: Source[]): Problem[] {
  const problems: Problem[] = [];
  const catalogs = expanded(raw);
  // Each message's words, a parameter as NUL (a quote never spans one).
  const messages: { key: string; words: string }[] = [];
  for (const [ns, c] of Object.entries(catalogs)) for (const [k, e] of Object.entries(c)) messages.push({ key: `${ns}:${baseKey(k)}`, words: plainWords(e.message).replace(/\{\{[^}]*\}\}/g, '\0') });
  const wordCount = (s: string) => (s.match(/\p{L}[\p{L}’'-]*/gu) ?? []).length;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  /** The message a piece of text quotes, if any: all of it or its start (two words or more, or ending in "…"), four
   * words or more from its middle, a title-case word that is a message by itself. */
  const quoted = (raw: string): string | undefined => {
    // The words may follow a field's name or a tag (`Description=Keyboard layout from…`, `title: …`, `<b>…`).
    for (const m of raw.matchAll(/[=:>]\s*/g)) {
      const key = quotedWhole(raw.slice(m.index + m[0].length));
      if (key) return key;
    }
    return quotedWhole(raw);
  };
  const quotedWhole = (raw: string): string | undefined => {
    const s = raw.replace(/\s+/g, ' ').trim();
    if (!/\p{L}/u.test(s)) return undefined;
    const n = wordCount(s);
    if (n >= 2 || s.endsWith('…')) {
      const start = new RegExp(`^${esc(s)}($|[^\\p{L}])`, 'u');
      const within = new RegExp(`(^|[^\\p{L}])${esc(s)}($|[^\\p{L}])`, 'u');
      return messages.find((m) => start.test(m.words) || (n >= 4 && within.test(m.words)))?.key;
    }
    // A keyboard key's label (the on-screen keyboard's `Enter`, `Alt`) is also its name in code (Playwright's `press('Enter')`).
    if (/^\p{Lu}\p{Ll}+$/u.test(s)) return messages.find((m) => m.words === s && !m.key.startsWith('osk:Osk.key.'))?.key;
    return undefined;
  };
  /** A template's words, each expression as NUL: a message whole (`Saved the snapshot ${name} (…)`). */
  const quotedTemplate = (quasis: string[]): string | undefined => {
    const first = quasis[0].replace(/\s+/g, ' ').trimStart();
    if (first && quoted(first.trimEnd())) return quoted(first.trimEnd());
    const whole = quasis.map((q) => q.replace(/\s+/g, ' ')).join('\0').trim();
    return wordCount(whole) >= 2 ? messages.find((m) => m.words === whole)?.key : undefined;
  };
  /** A regex's literal runs (between its metacharacters), its escapes resolved. */
  const runs = (pattern: string) => pattern.replace(/\\([^\w])/g, '$1').replace(/\\[a-zA-Z]|\[[^\]]*\]|[(){}*+?|^$]|\.(?![\p{L} ])/gu, '\n').split('\n').map((r) => r.trim()).filter((r) => /\p{L}/u.test(r));
  for (const src of sources) {
    if (WORDING_FILES.has(src.path)) continue;
    const p = parseSource({ path: src.path, text: src.text });
    if ('line' in p) { problems.push(p); continue; }
    const say = (n: Node, what: string, key: string) => {
      const line = lineAt(src.text, n.start);
      if (!waived(src.text, line)) problems.push({ path: src.path, line, text: `${what} says the page's words (${key}): take them from the catalog, t('${key}…')` });
    };
    const skip = new Set<Node>();
    walk(p.program, (n) => {
      // A test pinning words on purpose.
      if (n.type === 'CallExpression' || n.type === 'NewExpression') {
        const name = calleeName(n.callee as Node), args = n.arguments as Node[];
        if (/^(test|it|describe|t\.test)$/.test(name) && /^wording:/.test(stringOf(args[0]) ?? '')) return false;
        // A test's name, an assertion's message, a log or an Error's words are the developer's.
        if (/^(test|it|describe|t\.test)$/.test(name)) skip.add(args[0]);
        const msgAt = /^assert\.(ok|fail)$|^assert$/.test(name) ? 1 : /^assert\.(rejects|throws|doesNotThrow|doesNotReject)$/.test(name) ? 2 : /^assert\.\w+$/.test(name) ? 2 : -1;
        if (msgAt >= 0 && args[msgAt]) skip.add(args[msgAt]);
        if (DEV_CALLS.test(name) && !name.startsWith('assert')) for (const a of args) skip.add(a);
      }
      if (skip.has(n)) return false;
      if (n.type === 'Literal' && typeof n.value === 'string') {
        const key = quoted(n.value);
        if (key) say(n, `'${n.value.slice(0, 50)}'`, key);
      } else if (n.type === 'Literal' && n.regex) {
        const { pattern } = n.regex as { pattern: string };
        for (const r of runs(pattern)) {
          const key = wordCount(r) >= 2 || r.endsWith('…') || new RegExp(`\\^${esc(r)}\\$`).test(pattern) ? quoted(r) : undefined;
          if (key) { say(n, `/${pattern.slice(0, 50)}/`, key); break; }
        }
      } else if (n.type === 'TemplateLiteral') {
        const key = quotedTemplate((n.quasis as Node[]).map((q) => (q.value as { cooked: string }).cooked ?? ''));
        if (key) say(n, `\`${src.text.slice(n.start + 1, Math.min(n.end - 1, n.start + 51))}\``, key);
      }
    });
  }
  return problems;
}

function files(dir: string, test: (p: string) => boolean, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) files(p, test, out);
    else if (test(p)) out.push(p);
  }
  return out;
}

/** The catalogs as the page has them. */
export function readCatalogs(root: string): Catalogs {
  const dir = join(root, 'web/messages/en');
  const out: Catalogs = {};
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) out[f.replace(/\.json$/, '')] = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  return out;
}

/** Every check over the repository at `root`. */
export function checkAll(root: string, o: { fixDocs?: boolean } = {}): Problem[] {
  const catalogs = readCatalogs(root);
  const problems: Problem[] = [];
  const index = readFileSync(join(root, 'web/messages/en/index.ts'), 'utf8');
  for (const ns of Object.keys(catalogs)) if (!new RegExp(`\\b${ns}\\b`).test(index.split('CATALOGS')[1] ?? '')) problems.push({ path: 'web/messages/en/index.ts', line: 1, text: `${ns}.json isn't in CATALOGS` });
  const rel = (p: string) => relative(root, p);
  const web = files(join(root, 'web'), (p) => /\.(ts|svelte)$/.test(p) && !/\.d\.ts$/.test(p) && !p.includes('/messages/')).map((p) => ({ path: rel(p), text: readFileSync(p, 'utf8') }));
  const icons = new Set([...readFileSync(join(root, 'web/app/icons.ts'), 'utf8').matchAll(/^\s+'?([a-z0-9-]+)'?: Icon[A-Z]/gm)].map((m) => m[1]));
  problems.push(...checkSources(catalogs, web, { icons }));
  problems.push(...checkWorkers(root, web));
  const tests = files(join(root, 'tests'), (p) => /\.ts$/.test(p) && !/\.d\.ts$/.test(p)).map((p) => ({ path: rel(p), text: readFileSync(p, 'utf8') }));
  problems.push(...checkTests(catalogs, tests));
  const docs = [...files(join(root, 'docs'), (p) => p.endsWith('.md')), join(root, 'README.md')].filter(existsSync);
  for (const d of docs) {
    const r = checkDoc(catalogs, rel(d), readFileSync(d, 'utf8'), o.fixDocs);
    if (r.fixed !== undefined) writeFileSync(d, r.fixed);
    problems.push(...r.problems);
  }
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const problems = checkAll(root, { fixDocs: process.argv.includes('--fix-docs') });
  for (const p of problems) console.log(`${p.path}:${p.line}: ${p.text.replace(/\n/g, "⏎")}`);
  if (problems.length) {
    console.log(`\n${problems.length} problem${problems.length === 1 ? '' : 's'} (docs/i18n.md "Checks")`);
    process.exit(1);
  }
  console.log('i18n: the catalog, its keys and parameters, the page\'s words, the workers and the docs check out');
}
