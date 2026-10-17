// Svelte for the page's modal (docs/plans/machines.md §7; PLAN.md M8's frontend decision): `.svelte` components are
// compiled to JavaScript when served (tools/serve.ts) and when the static copy is written (tools/dist.ts), as
// TypeScript is stripped: no build step. Their runtime is Svelte's own `src/` (plain ES modules) and two small
// packages it imports, served from node_modules (or copied to `vendor/` in the static copy) behind the page's import
// map (`importMap`).
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from 'svelte/compiler';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const SVELTE = 'node_modules/svelte';

/** The specifiers the compiled components and Svelte's runtime import, and the files they are, relative to the repository. */
export const RUNTIME_ENTRIES: Record<string, string> = {
  svelte: `${SVELTE}/src/index-client.js`,
  'svelte/internal/client': `${SVELTE}/src/internal/client/index.js`,
  'svelte/internal/disclose-version': `${SVELTE}/src/internal/disclose-version.js`,
  '#client/constants': `${SVELTE}/src/internal/client/constants.js`,
  // esm-env as a browser bundler resolves it: in a browser, not in development, not Node.
  'esm-env': 'node_modules/esm-env/index.js',
  'esm-env/browser': 'node_modules/esm-env/true.js',
  'esm-env/development': 'node_modules/esm-env/false.js',
  'esm-env/node': 'node_modules/esm-env/false.js',
  clsx: 'node_modules/clsx/dist/clsx.mjs',
};

/** The licenses of the runtime's packages (the static copy carries them). */
export const RUNTIME_LICENSES = [`${SVELTE}/LICENSE.md`, 'node_modules/esm-env/LICENSE', 'node_modules/clsx/license'];

/** Code without its comments (JSDoc `@import`s name type files that aren't modules). */
const uncommented = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const IMPORT = /(?:^|[\s;}])(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|(?:^|[\s;])import\s*['"]([^'"]+)['"]/g;

/** Every file of the runtime the entries reach (relative to the repository, `/`-separated). */
export function runtimeFiles(): string[] {
  const seen = new Set<string>();
  const queue = Object.values(RUNTIME_ENTRIES);
  while (queue.length) {
    const f = queue.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const m of uncommented(readFileSync(join(ROOT, f), 'utf8')).matchAll(IMPORT)) {
      const s = m[1] ?? m[2];
      if (s.startsWith('.')) queue.push(relative(ROOT, resolve(ROOT, dirname(f), s)).split(sep).join('/'));
      else if (!(s in RUNTIME_ENTRIES)) throw new Error(`${f} imports ${s}, which the page's import map doesn't have (tools/svelte.ts)`);
    }
  }
  return [...seen].sort();
}

/** The import map's entries for the runtime, its files under `prefix` (a URL ending in `/` standing for the repository's node_modules). */
export const importMap = (prefix: string) => Object.fromEntries(Object.entries(RUNTIME_ENTRIES).map(([k, v]) => [k, prefix + v.slice('node_modules/'.length)]));

/** A component compiled for the browser (Svelte 5, runes, CSS injected by the component). */
export function compileSvelte(source: string, filename: string): string {
  const out = compile(source, { filename, generate: 'client', runes: true, dev: false, css: 'injected', discloseVersion: false });
  return out.js.code;
}
