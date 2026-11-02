// The catalog's checks (docs/i18n.md "Checks"; scripts/ci.sh runs them): what TypeScript can't see about messages.
//
//   node tools/i18n-check.ts             every check; a problem per line (`file:line: what`), exit 1 if any
//   node tools/i18n-check.ts --fix-docs  also rewrites the docs' UI quotes (`[words](ui:key)`) to the catalog's words
//
// - the catalog: every entry has its words and a note; keys are `<Source>.<name>`;
// - every key the code names exists, is a literal, and sits in its source: a key `ns:Source.name` is named in a file
//   `Source.*` (it mirrors where it's used), and every entry is named somewhere;
// - a message's parameters: a call that names a key with an object of parameters (`t`, `msg`, `new MsgError`, a
//   subclass, `<T k params>`) gives exactly the `{{names}}` its words use;
// - copy outside the catalog: words in a component's markup or a copy attribute (`title`, `aria-label`, …), string
//   results of a markup expression, copy properties (`label: 'Disks…'`) and sentence-like strings in the page's code
//   (a line with `i18n-ignore`, or after a line with `i18n-ignore-next`, is skipped);
// - no worker reaches web/i18n.ts or i18next: the page alone renders words;
// - the docs' UI quotes, `[words](ui:ns:Source.name)`, say the catalog's words, and words quoted in bold, italics or
//   double quotes that are a message's (two words or more, or ending in "…") are written as such a quote.
import { parse as parseSvelte } from 'svelte/compiler';
import { parseSync } from 'vite';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

/** Whether string `s` reads as a sentence for a user: a capital, then words, at least three. */
const sentence = (s: string) => /^[A-Z][a-z’']*(?:[ ,;:()\-–—][^\s]*){2,}/.test(s.trim()) && /\p{Ll}{2}/u.test(s) && !/[{}<>=;]|^\w+\(|\$\{|https?:|\/\//.test(s);

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
export function checkSources(catalogs: Catalogs, sources: Source[], o: { copyChecks?: (path: string) => boolean } = {}): Problem[] {
  const problems: Problem[] = [];
  const say = (path: string, line: number, text: string) => problems.push({ path, line, text });
  const copyChecks = o.copyChecks ?? ((p: string) => /(^|\/)web\//.test(p));

  // The catalog itself.
  for (const [ns, c] of Object.entries(catalogs)) {
    const file = `web/messages/en/${ns}.json`;
    for (const [k, e] of Object.entries(c)) {
      if (!/^[A-Za-z0-9-]+(\.[A-Za-z0-9_-]+)+$/.test(k)) say(file, 1, `${ns}:${k}: a key is <Source>.<name> (letters, digits, - and _)`);
      if (typeof e !== 'object' || e === null || typeof e.message !== 'string') { say(file, 1, `${ns}:${k}: no "message"`); continue; }
      if (typeof e.note !== 'string' || e.note.trim().length < 10) say(file, 1, `${ns}:${k}: its "note" (where and how the words are shown) is missing or too short`);
      const extra = Object.keys(e).filter((x) => x !== 'message' && x !== 'note');
      if (extra.length) say(file, 1, `${ns}:${k}: unknown fields ${extra.join(', ')}`);
      if (/\{\{[^}]*$|^[^{]*\}\}/.test(e.message)) say(file, 1, `${ns}:${k}: unbalanced {{ }} in its words`);
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

    /** Checks the parameters given with `key` (an ObjectExpression, or nothing) against its words. */
    const checkParams = (key: string, obj: Node | undefined, line: number) => {
      const found = lookup(catalogs, key);
      if (!found) return;
      if (obj && obj.type !== 'ObjectExpression') return; // parameters built elsewhere: not checked here
      const given = new Set<string>();
      if (obj) {
        for (const prop of obj.properties as Node[]) {
          if (prop.type !== 'Property' || prop.computed) return; // a spread: not checked here
          const k = prop.key as Node;
          given.add((k.name as string | undefined) ?? String(k.value));
        }
      }
      const missing = [...found.vars].filter((v) => !given.has(v));
      const extra = [...given].filter((v) => !found.vars.has(v));
      if (missing.length) say(src.path, line, `${key}: its words use ${missing.map((v) => `{{${v}}}`).join(', ')}, not given`);
      if (extra.length) say(src.path, line, `${key}: ${extra.join(', ')} given, but its words don't use ${extra.length > 1 ? 'them' : 'it'}`);
    };

    // Keys named in the code (and a component's markup), and their parameters.
    walk([p.program, p.svelte?.fragment], (n, parent, field) => {
      const s = stringOf(n);
      if (s !== undefined) {
        const m = KEY_RE.exec(s);
        if (m && catalogs[m[1]]) {
          const line = at(n);
          if (!lookup(catalogs, s)) say(src.path, line, `${s}: no such message in web/messages/en/${m[1]}.json`);
          const set = named.get(s) ?? new Set();
          set.add(stem);
          named.set(s, set);
          // As a call's first argument: its parameters are the second.
          if (parent && (parent.type === 'CallExpression' || parent.type === 'NewExpression') && field === 'arguments' && (parent.arguments as Node[])[0] === n) {
            const callee = calleeName(parent.callee as Node);
            if (/(^|\.)(t|msg|text|plain)$|Error$|^ask\./.test(callee) || parent.type === 'NewExpression') checkParams(s, (parent.arguments as Node[])[1], line);
          }
        }
      } else if (n.type === 'TemplateLiteral') {
        const first = ((n.quasis as Node[])[0].value as { cooked: string }).cooked;
        const m = /^([a-z][a-z0-9-]*):/.exec(first);
        if (m && catalogs[m[1]] && (n.expressions as unknown[]).length) say(src.path, at(n), `a key built at run time (\`${first}…\`): name every key as a literal (a map from a code to its key, if need be)`);
      }
    });

    // Svelte's markup: <T k="…" params={…}>, keys in its expressions, and its words.
    if (p.svelte) {
      walk(p.svelte.fragment, (n, parent) => {
        if (n.type === 'Component' && n.name === 'T') {
          const attrs = n.attributes as Node[];
          const kAttr = attrs.find((a) => a.type === 'Attribute' && a.name === 'k');
          const v = kAttr && Array.isArray(kAttr.value) && (kAttr.value as Node[]).length === 1 && (kAttr.value as Node[])[0].type === 'Text' ? ((kAttr.value as Node[])[0].data as string) : undefined;
          if (!v) say(src.path, at(n), '<T>: its k is a literal key');
          else {
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
          resultStrings(n.expression as Node, (lit) => { if (letters(stringOf(lit)!) && !waived(src.text, at(lit))) say(src.path, at(lit), `{…}: the words "${stringOf(lit)!.slice(0, 60)}" (a message)`); });
        }
        if (n.type === 'RegularElement' && (n.name === 'code' || n.name === 'kbd' || n.name === 'style' || n.name === 'script')) return false;
      });
    }

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
        if (sentence(words) && !(parent?.type === 'Property' && field === 'key')) say(src.path, at(n), `"${words.slice(0, 60)}" reads as words for the user (a message, or i18n-ignore if it isn't)`);
      });
    }
  }

  // Every entry is named, by a file of its source's stem.
  for (const [ns, c] of Object.entries(catalogs)) {
    for (const k of new Set(Object.keys(c).map(baseKey))) {
      const key = `${ns}:${k}`;
      const by = named.get(key);
      const want = k.split('.')[0];
      if (!by) say(`web/messages/en/${ns}.json`, 1, `${key}: named by no source`);
      else if (!by.has(want)) say(`web/messages/en/${ns}.json`, 1, `${key}: named in ${[...by].join(', ')}, not in ${want}${stems.has(want) ? '' : ` (no source named ${want})`}: a key starts with the stem of the file that uses it`);
    }
  }
  return problems;
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
    importsOf.set(abs, out.map((spec) => (spec.startsWith('.') ? resolve(dirname(abs), spec) : spec)));
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

/** The docs' UI quotes against the catalog; with `fix`, the quotes' words rewritten (the new text, if any changed). */
export function checkDoc(catalogs: Catalogs, path: string, text: string, fix = false): { problems: Problem[]; fixed?: string } {
  const problems: Problem[] = [];
  // Every message's plain words, for quotes that aren't marked yet.
  const byWords = new Map<string, string>();
  for (const [ns, c] of Object.entries(catalogs)) for (const [k, e] of Object.entries(c)) if (!e.message.includes('{{')) byWords.set(plainWords(e.message), `${ns}:${k}`);
  let changed = false;
  // Code (fenced or inline) says commands, not the page's words.
  const masked = text.replace(/```[\s\S]*?```/g, (m) => m.replace(/[^\n]/g, ' ')).replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length));
  const out = masked.replace(/\[([^\]\n]+)\]\(ui:([^)\s]+)\)/g, (whole, words: string, key: string, offset: number) => {
    const line = lineAt(text, offset);
    const found = lookup(catalogs, key);
    if (!found) { problems.push({ path, line, text: `[${words}](ui:${key}): no such message` }); return text.slice(offset, offset + whole.length); }
    const said = words.replace(/\*+|_+/g, '');
    const ok = found.words.some((w) => new RegExp(`^${plainWords(w).replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\\?\{\\?\{[^}]*\}\}/g, '.+')}$`, 'u').test(said.trim()) || plainWords(w) === said.trim());
    if (ok) return text.slice(offset, offset + whole.length);
    if (fix && found.words.length === 1 && !found.words[0].includes('{{')) {
      changed = true;
      return `[${words.replace(said.trim(), plainWords(found.words[0]))}](ui:${key})`;
    }
    problems.push({ path, line, text: `[${words}](ui:${key}): the page says "${plainWords(found.words[0])}"${fix ? ' (has parameters: fix it by hand)' : ' (node tools/i18n-check.ts --fix-docs)'}` });
    return text.slice(offset, offset + whole.length);
  });
  // Quotes of a message's words that aren't marked as UI quotes.
  const unlinked = masked.replace(/\[([^\]\n]+)\]\(ui:[^)\s]+\)/g, (m) => ' '.repeat(m.length));
  for (const m of unlinked.matchAll(/\*\*([^*\n]+)\*\*|(?<![*\w])\*([^*\n]+)\*(?![*\w])|"([^"\n]+)"|“([^”\n]+)”/g)) {
    const w = (m[1] ?? m[2] ?? m[3] ?? m[4]).trim();
    const key = byWords.get(w);
    if (key && (/…$/.test(w) || /\s/.test(w))) problems.push({ path, line: lineAt(text, m.index), text: `"${w}" quotes the page: write it as [${w}](ui:${key})` });
  }
  if (!changed) return { problems };
  // Put the rewritten quotes into the original text (the masked copy only located them).
  let result = '', at = 0;
  const re = /\[([^\]\n]+)\]\(ui:([^)\s]+)\)/g;
  const fixedQuotes = [...out.matchAll(re)];
  const origQuotes = [...masked.matchAll(re)];
  origQuotes.forEach((o, i) => { result += text.slice(at, o.index) + fixedQuotes[i][0]; at = o.index + o[0].length; });
  return { problems, fixed: result + text.slice(at) };
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
  problems.push(...checkSources(catalogs, web));
  problems.push(...checkWorkers(root, web));
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
