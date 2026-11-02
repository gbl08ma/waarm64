// Messages as data (docs/i18n.md): what the user is told, as a catalog key and its parameters, never as built words.
// Any code makes them (the page, its workers, the libraries, the tools); only the page renders them (web/i18n.ts),
// from the catalog in web/messages/. A worker or a library that has something to tell the user throws a `MsgError`
// or posts a `Msg`, with everything the words need as parameters, and the page turns it into words.
//
// This module imports nothing, so a worker that imports it doesn't take the catalog along.

/**
 * A parameter: a value the message's words place (`{{name}}`), formatted by the page (a number as it is, a `Date` as
 * the browser's locale writes it, a `Msg` rendered in its place, an array of messages or strings joined).
 */
export type Param = string | number | boolean | bigint | Date | Msg | undefined | readonly Param[];
export type Params = Readonly<Record<string, Param>>;

/** A message: `key` is `<catalog>:<Source>.<name>` (web/messages/<catalog>.json), `params` what its words place. */
export type Msg = { readonly key: string; readonly params?: Params };

/** Message `key` with `params`. Every key is a literal at the call (tools/i18n-check.ts checks it against the catalog). */
export const msg = (key: string, params?: Params): Msg => (params ? { key, params } : { key });

export const isMsg = (v: unknown): v is Msg => typeof v === 'object' && v !== null && !(v instanceof Date) && !Array.isArray(v) && typeof (v as Msg).key === 'string' && /^[a-z][a-z0-9-]*:/.test((v as Msg).key);

/** A message as text for a developer (a log, an `Error.message`): its key and its parameters, not its words. */
export function devText(m: Msg): string {
  if (!m.params) return m.key;
  const p = Object.entries(m.params).map(([k, v]) => `${k}=${isMsg(v) ? `(${devText(v)})` : Array.isArray(v) ? `[${v.map((x) => (isMsg(x) ? devText(x) : String(x))).join(', ')}]` : v instanceof Date ? v.toISOString() : String(v)}`);
  return `${m.key} {${p.join(', ')}}`;
}

/**
 * An error the user is told about in words of the catalog: `msg` is its headline, `cause` (if any) its details. Its
 * `message` is the developer's (`devText`): the page shows `msg` (web/i18n.ts `describe`).
 */
export class MsgError extends Error {
  readonly msg: Msg;
  constructor(key: string, params?: Params, options?: { cause?: unknown }) {
    const m = msg(key, params);
    super(devText(m), options);
    this.name = 'MsgError';
    this.msg = m;
  }
}

/** The message an error carries, if it carries one. */
export const msgOf = (e: unknown): Msg | undefined => (e instanceof MsgError ? e.msg : isMsg((e as { msg?: unknown } | null)?.msg) ? (e as { msg: Msg }).msg : undefined);

/**
 * An error as it crosses `postMessage` (a structured clone keeps an Error's name and message, not its fields): its
 * message (if it has one), its text, its cause, and its own plain fields (a `problem`, a code) as they are.
 */
export type WireError = { name: string; text: string; msg?: Msg; stack?: string; cause?: WireError; fields?: Record<string, unknown> };

const PLAIN = new Set(['string', 'number', 'boolean', 'bigint']);

/** `e` for `postMessage` (its name, words or message, stack, causes and plain fields). */
export function toWire(e: unknown, depth = 0): WireError {
  if (!(e instanceof Error)) {
    const m = isMsg(e) ? e : undefined;
    return { name: 'Error', text: m ? devText(m) : String(e), ...(m ? { msg: m } : {}) };
  }
  const w: WireError = { name: e.name, text: e.message };
  if (e.stack) w.stack = e.stack;
  const m = msgOf(e);
  if (m) w.msg = m;
  if (e.cause !== undefined && depth < 8) w.cause = toWire(e.cause, depth + 1);
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(e)) if (k !== 'msg' && k !== 'cause' && (PLAIN.has(typeof v) || isMsg(v))) fields[k] = v;
  if (Object.keys(fields).length) w.fields = fields;
  return w;
}

/** The error `toWire` gave, again (a `MsgError` if it had a message), with its fields and causes. */
export function fromWire(w: WireError): Error {
  const cause = w.cause ? fromWire(w.cause) : undefined;
  const e: Error = w.msg ? new MsgError(w.msg.key, w.msg.params, { cause }) : new Error(w.text, cause ? { cause } : undefined);
  e.name = w.name;
  // The stack is where it was thrown, in the worker (a developer's, for the console).
  if (w.stack) e.stack = w.stack;
  if (w.fields) Object.assign(e, w.fields);
  return e;
}

/** Whether `v` is a `WireError` (a message posted by a worker's older or newer copy may carry a plain string). */
export const isWire = (v: unknown): v is WireError => typeof v === 'object' && v !== null && typeof (v as WireError).text === 'string' && typeof (v as WireError).name === 'string';
