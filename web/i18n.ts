// The page's words (docs/i18n.md): every message the user reads is rendered here, by i18next, from the catalog in
// web/messages/. Only the page imports this module (tools/i18n-check.ts checks that no worker reaches it): workers and
// libraries describe what to say as data (web/msg.ts `Msg`, `MsgError`), and the page says it.
import i18next from 'i18next';
import { bytesText } from './app/bytes.ts';
import { CATALOGS } from './messages/en/index.ts';
import { isMsg, isWire, fromWire, msg, msgOf, type Msg, type Param, type Params, type WireError } from './msg.ts';

export { msg, MsgError, type Msg, type Params } from './msg.ts';

/** The page's language. One per load: a change takes a reload (nothing on the page renders its words again). */
export const LANGUAGE = 'en';

const i18n = i18next.createInstance();
void i18n.init({
  lng: LANGUAGE,
  fallbackLng: false,
  resources: { [LANGUAGE]: Object.fromEntries(Object.entries(CATALOGS).map(([ns, c]) => [ns, Object.fromEntries(Object.entries(c).map(([k, e]) => [k, e.message]))])) },
  ns: Object.keys(CATALOGS),
  defaultNS: 'common',
  // Keys are `<Source>.<name>` as they are, not paths into nested objects.
  keySeparator: false,
  initAsync: false,
  returnNull: false,
  // Svelte escapes what it shows, and a message's markers (`<b>…</b>`) are the page's to draw (T.svelte).
  interpolation: { escapeValue: false },
});

// The copy editor (docs/i18n.md "Editing the copy on the page", web/app/copy-edit.ts): while it's on (for this tab,
// from the console), every message rendered carries an invisible mark of what it is, which the editor finds in the
// page and takes out, and the words changed in it so far (kept in this browser) stand in for the catalog's.
const EDIT_FLAG = 'copy-edit';
const EDITS = 'copy-edit.changes';
const storage = (kind: 'sessionStorage' | 'localStorage'): Storage | undefined => {
  try { return (globalThis as Record<string, unknown>)[kind] as Storage | undefined; } catch { return undefined; }
};
/** Whether the copy editor is on in this tab (for the whole load: turning it on or off takes a reload). */
export const COPY_EDITING = storage('sessionStorage')?.getItem(EDIT_FLAG) === 'on';

/** A message as rendered while the copy editor is on: its key, its parameters as rendered, its words (unmarked). */
export type Shown = { key: string; params: Record<string, unknown>; words: string; rich: boolean };
const shown: Shown[] = [];
const shownAt = new Map<string, number>();
// A mark: U+2063, the message's number in `shown` in binary as U+200B (0) and U+200C (1), U+2064.
const MARK = /\u2063([\u200b\u200c]+)\u2064/g;

/** `s` without the copy editor's marks (for words that leave the page: the guest's). */
export const unmarked = (s: string) => s.replace(MARK, '');

/** The mark of message `key` with `params` (as rendered) whose words are `words`. */
function mark(key: string, params: Record<string, unknown>, words: string, rich = false): string {
  const plainWords = unmarked(words);
  const at = `${key}\0${plainWords}`;
  let id = shownAt.get(at);
  if (id === undefined) {
    id = shown.push({ key, params, words: plainWords, rich }) - 1;
    shownAt.set(at, id);
  }
  return `\u2063${id.toString(2).replace(/0/g, '\u200b').replace(/1/g, '\u200c')}\u2064`;
}

/** The changed words kept in this browser, by full key (plural forms by their own: `ns:Source.name_one`). */
export function copyEdits(): Record<string, string> {
  try { return JSON.parse(storage('localStorage')?.getItem(EDITS) ?? '{}') as Record<string, string>; } catch { return {}; }
}

/** The copy editor's view of the messages (web/app/copy-edit-ui.ts). */
export const copyEditor = {
  /** The marks in `s`: the numbers of the messages, in order. */
  marks: (s: string) => [...s.matchAll(MARK)].map((m) => parseInt(m[1].replace(/\u200b/g, '0').replace(/\u200c/g, '1'), 2)),
  shown: (id: number): Shown | undefined => shown[id],
  /** Every message shown so far with key `key`. */
  shownOf: (key: string) => shown.flatMap((s, id) => (s.key === key ? [id] : [])),
  /** The catalog's entries for `key` (its plural forms, if it has them), by full key. */
  entries(key: string): { key: string; message: string; note: string }[] {
    const [ns, k] = key.split(/:(.*)/s);
    const c = CATALOGS[ns] ?? {};
    if (c[k]) return [{ key, ...c[k] }];
    return Object.entries(c).filter(([f]) => f.replace(/_(zero|one|two|few|many|other)$/, '') === k).map(([f, e]) => ({ key: `${ns}:${f}`, ...e }));
  },
  /** Changes entry `full`'s words to `words` (the catalog's again when `undefined`), here and in this browser. */
  change(full: string, words: string | undefined) {
    const [ns, k] = full.split(/:(.*)/s);
    const edits = copyEdits();
    if (words === undefined || words === CATALOGS[ns]?.[k]?.message) delete edits[full];
    else edits[full] = words;
    storage('localStorage')?.setItem(EDITS, JSON.stringify(edits));
    i18n.addResource(LANGUAGE, ns, k, words ?? CATALOGS[ns]?.[k]?.message ?? '');
  },
  /** Message `id`'s words now (after a change): its old words and its new. */
  again(id: number): { was: string; now: string } {
    const s = shown[id];
    const was = s.words;
    // A message with markers is cut into pieces in the page (T.svelte): its new words show when it's drawn again.
    if (!s.rich) s.words = unmarked(i18n.t(s.key, s.params) as string);
    return { was, now: s.words };
  },
};

if (COPY_EDITING) {
  for (const [full, words] of Object.entries(copyEdits())) {
    const [ns, k] = full.split(/:(.*)/s);
    if (CATALOGS[ns]?.[k]) i18n.addResource(LANGUAGE, ns, k, words);
  }
}

// Formats a message's words can ask for: `{{size, bytes}}`, `{{list, lines}}`.
i18n.services.formatter?.add('bytes', (v: unknown) => bytesText(Number(v)));
i18n.services.formatter?.add('lines', (v: unknown) => (Array.isArray(v) ? v.join('\n') : String(v)));
i18n.services.formatter?.add('time', (v: unknown) => (v instanceof Date ? v.toLocaleTimeString() : String(v)));
i18n.services.formatter?.add('date', (v: unknown) => (v instanceof Date ? v.toLocaleDateString() : String(v)));

/** A list's words: its items rendered and, where the message doesn't format it, joined with commas. */
class Items extends Array<string> {
  override toString() { return this.join(', '); }
}

function param(v: Param): unknown {
  if (v === undefined) return '';
  if (v instanceof Date) return Object.assign(new Date(v), { toString: () => v.toLocaleString() });
  if (isMsg(v)) return text(v);
  if (Array.isArray(v)) return Items.from(v as Param[], (x) => String(param(x)));
  return v;
}

/** Message `m`'s words, with its parameters in place (and its markers, `<b>…</b>`, as they are: `plain` drops them). */
export function text(m: Msg): string {
  const p: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(m.params ?? {})) p[k] = param(v);
  const words = i18n.t(m.key, p) as string;
  return COPY_EDITING ? mark(m.key, p, words) + words : words;
}

/** Message `key`'s words with `params`. */
export const t = (key: string, params?: Params) => text(msg(key, params));

const MARKER = /<(\/?)([a-z][a-z0-9-]*)>/g;

/** Words without their markers (for a title, an aria-label, a confirm's text). */
export const plain = (s: string) => s.replace(MARKER, '');

/**
 * Message `key`'s words with `params`, cut at its markers (T.svelte): the markers are the message's own, never a
 * parameter's (a path or a command with `<…>` in it stays text).
 */
export function marked(key: string, params?: Params): { tag?: string; text: string }[] {
  const p: Record<string, unknown> = {};
  const held: string[] = [];
  for (const [k, v] of Object.entries(params ?? {})) {
    const r = param(v);
    const s = typeof r === 'number' || typeof r === 'boolean' || typeof r === 'bigint' ? undefined : String(r);
    if (s !== undefined && s.includes('<')) {
      p[k] = `\u0001${held.length}\u0002`;
      held.push(s);
    } else p[k] = r;
  }
  const back = (s: string) => s.replace(/\u0001(\d+)\u0002/g, (_, i: string) => held[Number(i)]);
  const pieces = parts(i18n.t(key, p) as string).map((x) => ({ ...x, text: back(x.text) }));
  if (COPY_EDITING && pieces.length) pieces[0] = { ...pieces[0], text: mark(key, p, pieces.map((x) => x.text).join(''), true) + pieces[0].text };
  return pieces;
}

/** A message's words cut at its markers: plain text (`tag` undefined) and the text each `<tag>…</tag>` wraps. */
export function parts(s: string): { tag?: string; text: string }[] {
  const out: { tag?: string; text: string }[] = [];
  let at = 0, open: string | undefined;
  for (const m of s.matchAll(MARKER)) {
    const [whole, close, tag] = m;
    if (!close && open) continue;
    if (close && tag !== open) continue;
    if (m.index > at) out.push(open ? { tag: open, text: s.slice(at, m.index) } : { text: s.slice(at, m.index) });
    open = close ? undefined : tag;
    at = m.index + whole.length;
  }
  if (at < s.length) out.push(open ? { tag: open, text: s.slice(at) } : { text: s.slice(at) });
  return out;
}

/** An error's words: its headline (its own message), and its details (its causes', outermost first). */
export type Described = { headline: string; details: string[] };

/**
 * What error `e` (an Error, a `MsgError`, a worker's `WireError`, a `Msg`, a string) says to the user: a message
 * renders as its words; an error without one says its own `message`, which is a developer's words.
 */
export function describe(e: unknown): Described {
  const err = isWire(e) ? fromWire(e) : e;
  const lines: string[] = [];
  let cur: unknown = err;
  for (let i = 0; cur !== undefined && cur !== null && i < 8; i++) {
    const m = isMsg(cur) ? cur : msgOf(cur);
    const said = m ? text(m) : cur instanceof Error ? cur.message : String(cur);
    if (said && lines.at(-1) !== said) lines.push(said);
    cur = cur instanceof Error ? cur.cause : undefined;
  }
  return { headline: lines[0] ?? '', details: lines.slice(1) };
}

/** What the page says somewhere (the message bar, a dialog): words already rendered, a message, an error. */
export type Said = string | Msg | Error | Described | WireError;

const isDescribed = (v: unknown): v is Described => typeof v === 'object' && v !== null && typeof (v as Described).headline === 'string' && Array.isArray((v as Described).details);

/** `s` as a headline and its details (rendered words are a headline alone). */
export function said(s: Said | undefined): Described {
  if (s === undefined || s === '') return { headline: '', details: [] };
  if (typeof s === 'string') return { headline: s, details: [] };
  if (isDescribed(s)) return s;
  return describe(s);
}

/** An error's words on one line each: its headline, then its details (for a dialog's text, a log). */
export const errorText = (e: unknown) => {
  const d = describe(e);
  return [d.headline, ...d.details].join('\n');
};
