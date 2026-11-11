// The harness pages' imports, checked (scripts/ci.sh). The repository's HTML pages (tests/browser/, tests/usb/, bench/)
// import the page's and the core's modules by path from inline module scripts, which `tsc` doesn't read: an export
// moved by a refactor broke only the lane that loads the page (docs/testing.md, its table: "The harness pages' imports"). This writes each
// page's imports into a module of its own (target/harness-imports/, paths made absolute: static imports as written,
// `(await import('x')).name` as a named import, `src=` scripts as a side-effect import) and has `tsc` check those
// modules alone with the repository's options. An unknown module or a missing export fails, named by the page.
// Run: node tools/harness-imports.ts
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const out = join(root, 'target', 'harness-imports');

/** Where specifier `spec` of a page at `page` (repo-relative) points: the server's root is the repository's. */
function target(page: string, spec: string): string | undefined {
  if (spec.startsWith('/')) return join(root, spec);
  if (spec.startsWith('.')) return resolve(root, dirname(page), spec);
  return undefined; // a package: resolved by tsc from the repository's node_modules
}

/** One page's imports as a module's lines (each line commented with the page it came from), or none. */
function importsOf(page: string): string[] {
  const html = readFileSync(join(root, page), 'utf8');
  const lines: string[] = [];
  const fix = (spec: string) => target(page, spec) ?? spec;
  for (const tag of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    const [, attrs = '', body = ''] = tag;
    if (!/type\s*=\s*["']module["']/.test(attrs)) continue;
    const src = /\bsrc\s*=\s*["']([^"']+)["']/.exec(attrs)?.[1];
    if (src) {
      // A script of the page's own (a URL: relative without `./` too): it exists, and tsc checks a TypeScript one's imports.
      const path = src.startsWith('/') ? join(root, src) : resolve(root, dirname(page), src);
      if (!existsSync(path)) lines.push(`import '${path}'; // missing: <script src="${src}">`);
      else if (src.endsWith('.ts')) lines.push(`import '${path}';`);
      continue;
    }
    for (const m of body.matchAll(/^\s*import\s+([\s\S]*?)\s+from\s*(['"])([^'"]+)\2/gm)) {
      const [, clause = '', , spec = ''] = m;
      lines.push(`import ${clause.replace(/\s+/g, ' ')} from '${fix(spec)}';`);
    }
    for (const m of body.matchAll(/^\s*import\s*(['"])([^'"]+)\1/gm)) lines.push(`import '${fix(m[2] ?? '')}';`);
    for (const m of body.matchAll(/import\(\s*(['"])([^'"]+)\1\s*\)\s*\)\s*\.\s*(\w+)/g)) {
      lines.push(`import { ${m[3] ?? ''} } from '${fix(m[2] ?? '')}';`);
    }
    for (const m of body.matchAll(/(?:const|let)\s*\{([^}]*)\}\s*=\s*await\s+import\(\s*(['"])([^'"]+)\2\s*\)/g)) {
      const names = (m[1] ?? '').split(',').map((n) => n.trim().replace(/\s*:\s*/, ' as ')).filter(Boolean);
      lines.push(`import { ${names.join(', ')} } from '${fix(m[3] ?? '')}';`);
    }
  }
  return lines;
}

const pages = execFileSync('git', ['ls-files', '*.html'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const files: string[] = [];
const pageOf = new Map<string, string>();
for (const page of pages) {
  const lines = importsOf(page);
  if (!lines.length) continue;
  const file = join(out, page.replace(/[/.]/g, '_') + '.mts');
  writeFileSync(file, `// The imports of ${page} (tools/harness-imports.ts).\n${lines.join('\n')}\nexport {};\n`);
  files.push(file);
  pageOf.set(file, page);
}
// The repository's ambient declarations (web/app/browser.d.ts: the browser APIs lib.dom lacks) come along.
const ambient = execFileSync('git', ['ls-files', '*.d.ts'], { cwd: root, encoding: 'utf8' })
  .split('\n')
  .filter((f) => f && !f.startsWith('bench/results/'))
  .map((f) => join(root, f));
writeFileSync(
  join(out, 'tsconfig.json'),
  JSON.stringify({
    extends: join(root, 'tsconfig.json'),
    compilerOptions: { noUnusedLocals: false },
    include: [],
    files: [...ambient, ...files],
  }),
);
const tsc = spawnSync(join(root, 'node_modules', '.bin', 'tsc'), ['--noEmit', '-p', join(out, 'tsconfig.json')], {
  cwd: root,
  encoding: 'utf8',
});
if (tsc.status !== 0) {
  // tsc names the generated module: say which page it is.
  let report = tsc.stdout + tsc.stderr;
  for (const [file, page] of pageOf) report = report.replaceAll(file.slice(root.length + 1), `${page} (imports)`);
  process.stderr.write(report);
  console.error(`harness-imports: a page's imports don't resolve (${pages.length} pages; the lines above)`);
  process.exit(1);
}
console.log(`harness-imports: ${files.length} pages' imports resolve (${pages.length} pages)`);
