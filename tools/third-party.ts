// THIRD_PARTY.json, the authoritative list of waarm64's third-party code, dependencies and references
// (docs/third-party.md): its checks, the rows the page's About pane shows, and its rendering as Markdown.
//   node tools/third-party.ts               checks it (scripts/ci.sh)
//   node tools/third-party.ts --markdown    prints it as Markdown (the layout of THIRD_PARTY.md, which it replaced)
//   node tools/third-party.ts --links       also fetches every link the About pane shows (needs the network)
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { buildInfo, type BuildInfo } from './stamp.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const FILE = `${ROOT}THIRD_PARTY.json`;

/** The About pane's groups, in its order: where in waarm64 a project's code ends up (the catalog has their words). */
export const GROUPS = ['page', 'core', 'graphics', 'vulkan', 'network', 'firmware', 'agent', 'intro'] as const;
export type Group = (typeof GROUPS)[number];

/**
 * The license files `npm run dist` puts beside the page (tools/dist.ts), by their name there, with where they are
 * built in the repository (which the dev server serves as they are).
 */
export const BUNDLED: Record<string, string> = {
  'EDK2-LICENSES.txt': 'target/images/edk2/LICENSES.txt',
  'INTRO-LICENSES.txt': 'target/images/intro/LICENSES.txt',
  'VENUS-LICENSES.txt': 'target/vk/LICENSES.txt',
};

export type LicenseText = { name: string; url: string };
/** A project as the About pane shows it. */
export type Project = { name: string; url: string; version: string; license: string; licenseTexts: LicenseText[] };
export type Entry = {
  id: string;
  /** The project's name (or a short name for the row), always set. */
  name: string;
  /** Shown on the About pane, in this group. Unset: in this file only (tools, tests, references). */
  about?: Group;
  /** The cells of the section's table, by column key: Markdown. */
  md: Record<string, string>;
  /** A license file `npm run dist` puts beside the page that covers this row (`BUNDLED`). */
  bundled?: string;
  /** Several projects in one row (a module built from several): each shown. */
  parts?: Project[];
} & Partial<Project>;
export type Section = {
  id: string;
  /** The section's heading; null continues the previous section under its heading. */
  title: string | null;
  intro: string[];
  columns: { key: string; title: string }[];
  entries: Entry[];
  outro?: string[];
};
export type ThirdParty = { $comment?: string[]; sections: Section[] };

export const load = (file = FILE): ThirdParty => JSON.parse(readFileSync(file, 'utf8'));

const SPDX = /^[A-Za-z0-9.+()\- ]+$/;
/** What's wrong with the document, one line per problem. */
export function problems(doc: ThirdParty): string[] {
  const out: string[] = [];
  const ids = new Set<string>();
  const sids = new Set<string>();
  const project = (p: Partial<Project>, where: string) => {
    if (!p.name) out.push(`${where}: no name`);
    if (!p.url?.startsWith('https://')) out.push(`${where}: url must be an https:// link`);
    if (!p.version) out.push(`${where}: no version`);
    if (!p.license || !SPDX.test(p.license)) out.push(`${where}: license must be an SPDX expression`);
    if (!p.licenseTexts?.length) out.push(`${where}: no licenseTexts`);
    for (const t of p.licenseTexts ?? []) {
      if (!t.name || !t.url?.startsWith('https://')) out.push(`${where}: a licenseTexts item needs a name and an https:// url`);
      // A link to a file in a repository must be pinned: a commit or a tag, never a branch.
      if (/\/(blob|tree|raw)\/(main|master|HEAD|trunk|next)\//.test(t.url ?? '')) out.push(`${where}: ${t.url} isn't pinned to a commit`);
    }
  };
  if (!Array.isArray(doc.sections) || !doc.sections.length) return ['no sections'];
  doc.sections.forEach((s, si) => {
    const where = `section ${s.id ?? si}`;
    if (!s.id || sids.has(s.id)) out.push(`${where}: missing or repeated id`);
    sids.add(s.id);
    if (si === 0 && !s.title) out.push(`${where}: the first section needs a title`);
    if (!Array.isArray(s.intro)) out.push(`${where}: intro must be a list of paragraphs`);
    if (!s.columns?.length) out.push(`${where}: no columns`);
    for (const e of s.entries ?? []) {
      const at = `${where}, entry ${e.id}`;
      if (!e.id || !/^[a-z0-9][a-z0-9_-]*$/.test(e.id) || ids.has(e.id)) out.push(`${at}: missing, malformed or repeated id`);
      ids.add(e.id);
      if (!e.name) out.push(`${at}: no name`);
      for (const c of s.columns ?? []) if (typeof e.md?.[c.key] !== 'string') out.push(`${at}: no md.${c.key}`);
      for (const k of Object.keys(e.md ?? {})) if (!s.columns.some((c) => c.key === k)) out.push(`${at}: md.${k} isn't a column`);
      if (e.bundled && !(e.bundled in BUNDLED)) out.push(`${at}: bundled ${e.bundled} isn't one of tools/third-party.ts's BUNDLED`);
      if (e.about === undefined) continue;
      if (!GROUPS.includes(e.about)) out.push(`${at}: about must be one of ${GROUPS.join(', ')}`);
      if (e.parts) e.parts.forEach((p, i) => project(p, `${at}, part ${i}`));
      else project(e, at);
    }
  });
  return out;
}

/** A project on the About pane: those of several rows with the same name and version are one. */
export type AboutProject = Project & { derived: boolean };
export type AboutGroup = { group: Group; projects: AboutProject[]; bundled: string[] };

/**
 * The About pane's groups: the rows with `about`, each part a project, merged by name and version; `derived` when our
 * code is derived from it (the section `derived`), rather than built in as it is.
 */
export function aboutGroups(doc: ThirdParty): AboutGroup[] {
  const groups = new Map<Group, AboutGroup>(GROUPS.map((g) => [g, { group: g, projects: [], bundled: [] }]));
  for (const s of doc.sections) {
    for (const e of s.entries) {
      if (!e.about) continue;
      const g = groups.get(e.about)!;
      if (e.bundled && !g.bundled.includes(e.bundled)) g.bundled.push(e.bundled);
      for (const p of e.parts ?? [e as Project]) {
        const derived = s.id === 'derived';
        const same = g.projects.find((x) => x.name === p.name && x.version === p.version);
        const project = { name: p.name, url: p.url, version: p.version, license: p.license, licenseTexts: p.licenseTexts };
        if (!same) { g.projects.push({ ...project, derived }); continue; }
        same.derived ||= derived;
        same.license = joinLicenses(same.license, p.license);
        for (const t of p.licenseTexts) if (!same.licenseTexts.some((x) => x.url === t.url)) same.licenseTexts.push(t);
      }
    }
  }
  return [...groups.values()].filter((g) => g.projects.length);
}

/** Two rows' licenses of one project as one expression: the one that already names the other, or both. */
function joinLicenses(a: string, b: string) {
  const names = (x: string) => new Set(x.split(/[\s()]+/).filter((w) => w && !['AND', 'OR', 'WITH'].includes(w)));
  if ([...names(b)].every((n) => names(a).has(n))) return a;
  if ([...names(a)].every((n) => names(b).has(n))) return b;
  return `(${a}) AND (${b})`;
}

/** A license file beside the page, and its address from the page. */
export type BundledText = { name: string; href: string };
/** What the page's About pane shows (`virtual:waarm64-about`, vite.config.ts). */
export type About = {
  /** waarm64's repository, from package.json. */
  repository: string;
  /** waarm64's own license (SPDX) and its text beside the page. */
  license: string;
  licenseHref: string;
  build: BuildInfo | undefined;
  groups: (Omit<AboutGroup, 'bundled'> & { bundled: BundledText[] })[];
};

/**
 * The About pane's data. `build`: for `npm run dist`'s copy, whose license files sit beside the page (tools/dist.ts;
 * a file left out of the copy, as Vulkan's renderer's may be, is left out here too, and Vite writes the bundled
 * packages' licenses to THIRD-PARTY-LICENSES.md); otherwise for the dev server, which serves them where they're built.
 */
export function aboutData({ build }: { build: boolean }, root = ROOT): About {
  const pkg = JSON.parse(readFileSync(`${root}package.json`, 'utf8')) as { license: string; repository: { url: string } };
  const beside = (name: string) => (build ? `./${name}` : `/${BUNDLED[name]}`);
  return {
    repository: pkg.repository.url,
    license: pkg.license,
    licenseHref: build ? './LICENSE' : '/LICENSE',
    build: buildInfo(root),
    groups: aboutGroups(load(`${root}THIRD_PARTY.json`)).map((g) => ({
      ...g,
      bundled: [
        ...(build && g.group === 'page' ? [{ name: 'THIRD-PARTY-LICENSES.md', href: './THIRD-PARTY-LICENSES.md' }] : []),
        ...g.bundled.filter((name) => existsSync(`${root}${BUNDLED[name]}`)).map((name) => ({ name, href: beside(name) })),
      ],
    })),
  };
}

/** The document as Markdown, in the layout of THIRD_PARTY.md, which it replaced (a `## title` per section, a table per section). */
export function markdown(doc: ThirdParty): string {
  const cell = (s: string) => s.replace(/\n/g, ' ');
  const out = ['# Third-party code and references', ''];
  for (const s of doc.sections) {
    if (s.title) out.push(`## ${s.title}`, '');
    for (const p of s.intro) out.push(p, '');
    out.push(`| ${s.columns.map((c) => c.title).join(' | ')} |`, `|${s.columns.map(() => '---').join('|')}|`);
    for (const e of s.entries) out.push(`| ${s.columns.map((c) => cell(e.md[c.key])).join(' | ')} |`);
    out.push('');
    for (const p of s.outro ?? []) out.push(p, '');
  }
  return out.join('\n');
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { markdown: { type: 'boolean', default: false }, links: { type: 'boolean', default: false } } });
  const doc = load();
  const bad = problems(doc);
  if (bad.length) {
    console.error(`THIRD_PARTY.json:\n  ${bad.join('\n  ')}`);
    process.exit(1);
  }
  if (values.markdown) process.stdout.write(markdown(doc));
  if (values.links) {
    const projects = aboutGroups(doc).flatMap((g) => g.projects);
    const urls = new Set(projects.flatMap((p) => [p.url, ...p.licenseTexts.map((t) => t.url)]));
    let failed = 0;
    let skipped = 0;
    for (const url of urls) {
      const at = probe(url);
      // A GitHub tree has no copy outside github.com: it is the commit a license file beside it is checked at.
      if (!at) {
        const pin = url.replace('/tree/', '/blob/').split('/').slice(0, 7).join('/') + '/';
        if (projects.some((p) => p.url === url && p.licenseTexts.some((t) => t.url.startsWith(pin)))) { skipped++; continue; }
      }
      const r = await fetch(at ?? url, { redirect: 'follow', headers: { 'User-Agent': 'waarm64 third-party link check' }, signal: AbortSignal.timeout(30_000) })
        .catch((e: Error) => ({ ok: false, status: e.message }));
      if (!r.ok) { failed++; console.error(`${r.status} ${url}`); }
    }
    console.log(`${urls.size - failed - skipped} of ${urls.size} links answered; ${skipped} checked through their license file's commit`);
    if (failed) process.exit(1);
  }
}

/**
 * Where a link is checked: the same content from a host that answers scripts (npm's and crates.io's pages turn them
 * away, and a cloud session's proxy refuses github.com): a GitHub file's raw copy, a package's registry entry.
 * Undefined for a GitHub tree, which has no such copy.
 */
function probe(url: string): string | undefined {
  const u = new URL(url);
  const [, owner, repo, kind, ref, ...path] = u.pathname.split('/');
  if (u.host === 'github.com' && kind === 'blob') return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path.join('/')}`;
  if (u.host === 'github.com' && kind === 'tree') return undefined;
  if (u.host === 'www.npmjs.com') return `https://registry.npmjs.org/${u.pathname.replace(/^\/package\//, '').replace('/v/', '/')}`;
  if (u.host === 'crates.io') return `https://crates.io/api/v1${u.pathname}`;
  return url;
}

