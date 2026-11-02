// Writes the copy editor's changes (docs/i18n.md "Editing the copy on the page") into the catalog: the JSON
// `copyEdit.dump()` gave, `{ "ns:Source.name": "new words" }`, into web/messages/en/<ns>.json, notes untouched.
//
//   node tools/copy-apply.ts changes.json     (or the JSON on stdin)
//
// Then `node tools/i18n-check.ts --fix-docs` brings the docs' quotes of the page up to the new words.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type Catalog = Record<string, { message: string; note: string }>;

/** Applies `changes` to the catalog in `dir`: the files changed, and the keys it doesn't have (not applied). */
export function applyCopy(dir: string, changes: Record<string, string>): { files: string[]; unknown: string[] } {
  const byNs = new Map<string, [string, string][]>();
  const unknown: string[] = [];
  for (const [full, words] of Object.entries(changes)) {
    const m = /^([a-z][a-z0-9-]*):(.+)$/.exec(full);
    if (!m || typeof words !== 'string') { unknown.push(full); continue; }
    byNs.set(m[1], [...(byNs.get(m[1]) ?? []), [m[2], words]]);
  }
  const files: string[] = [];
  for (const [ns, list] of byNs) {
    const path = join(dir, `${ns}.json`);
    let catalog: Catalog;
    try { catalog = JSON.parse(readFileSync(path, 'utf8')) as Catalog; } catch { unknown.push(...list.map(([k]) => `${ns}:${k}`)); continue; }
    let changed = false;
    for (const [k, words] of list) {
      if (!catalog[k]) { unknown.push(`${ns}:${k}`); continue; }
      if (catalog[k].message !== words) { catalog[k].message = words; changed = true; }
    }
    if (changed) {
      writeFileSync(path, `${JSON.stringify(catalog, null, 2)}\n`);
      files.push(path);
    }
  }
  return { files, unknown };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const src = process.argv[2] ? readFileSync(process.argv[2], 'utf8') : readFileSync(0, 'utf8');
  const { files, unknown } = applyCopy(fileURLToPath(new URL('../web/messages/en/', import.meta.url)), JSON.parse(src) as Record<string, string>);
  for (const f of files) console.log(`changed ${f}`);
  for (const k of unknown) console.error(`not in the catalog: ${k}`);
  if (files.length) console.log('now: node tools/i18n-check.ts --fix-docs');
  process.exitCode = unknown.length ? 1 : 0;
}
