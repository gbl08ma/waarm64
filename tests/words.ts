// The page's words for tests (docs/i18n.md "Tests"): a test takes them from the catalog, never writes them out, so a
// change of words changes no test. `t(key, params)` (web/i18n.ts) gives a message's words whole; `words` a pattern of
// them where only some parameters are known, to match the page's text, a dialog's or the message bar's.
import { plain, t, type Params } from '../web/i18n.ts';
import { CATALOGS, expand } from '../web/messages/en/index.ts';

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A message's words as a pattern: the parameters given in their place, any other matching anything (as does a given
 * one with a format, `{{size, bytes}}`, unless every parameter is given). `whole` anchors it at both ends, `start` at
 * the start. Markers are dropped (the page's text has none).
 */
export function words(key: string, params: Params = {}, o: { whole?: boolean; start?: boolean } = {}): RegExp {
  const [ns, k] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
  const catalog = CATALOGS[ns];
  if (!catalog) throw new Error(`words: no catalog ${ns}`);
  const count = typeof params.count === 'number' ? params.count : undefined;
  const entry = catalog[k] ?? catalog[`${k}_${count === undefined ? 'other' : new Intl.PluralRules('en').select(count)}`] ?? catalog[`${k}_other`];
  if (!entry) throw new Error(`words: no message ${key}`);
  const message = expand(entry.message);
  const names = [...message.matchAll(/\{\{\s*([\w.]+)/g)].map((m) => m[1]);
  let body: string;
  if (names.every((n) => n in params)) body = esc(plain(t(key, params)));
  else {
    body = plain(message).split(/(\{\{[^}]*\}\})/).map((part, i) => {
      if (i % 2 === 0) return esc(part);
      const [, name, format] = /^\{\{\s*([\w.]+)\s*(,[^}]*)?\}\}$/.exec(part)!;
      return name in params && !format ? esc(String(params[name])) : '[^]*?';
    }).join('');
  }
  return new RegExp(o.whole ? `^${body}$` : o.start ? `^${body}` : body);
}
