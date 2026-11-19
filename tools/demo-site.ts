// The demos' site (docs/remote-disks.md "Publishing the demos"; DEMO-KICKOFF.md decisions 13, 15, 17): what
// tools/publish-demos.ts writes into target/disks/ for vmdisks.tny.im, planned before anything is written.
//
// The input is a source file (deploy/disks/demos.json): per demo, its card (`demo`: id, summary, view, network,
// replaces, download, template: whether New machine offers it as a template too), a name, a thumbnail, its recipe (how
// tools/build-demos.ts makes it: `Recipe`; not checked here) and its build: a directory as bench/demo/make-template.ts
// (which tools/build-demos.ts runs) writes it, `manifest.json` (the image, chunked), `snapshot.json` (the template snapshot, chunked) and
// `definition.json` (the machine that made the template, its disk's `url` relative to it), their pieces where their
// manifests say. The site it makes:
//   store.json                      the store (web/app/demo-store.ts): every live demo's definition inline, URLs relative to it
//   <id>/manifest.json, snapshot.json, definition.json (the same definition alone, URLs relative to it), thumb.<ext>
//   pieces/<sha256>.bin             one directory of pieces for every image, snapshot and version
//   .publish.json                   the publisher's ledger (when each id was published and retired), not deployed (.assetsignore)
// and whatever else is there (another image's directory: the desktop's) as it is.
//
// Checks, each refusing the whole publish: the source strictly (an unknown field is a typo), ids unique; each build's
// definition is a version-2 definition with its one URL disk the build's image (its identity the manifest's content);
// the snapshot a template whose core format is this checkout's (`SNAPSHOT_VERSION`: the page `npm run dist` builds
// from it) and whose shape hash is the one this checkout gives the definition's machine (so a page update that changes
// the shape, the CPU features or the format refuses until the template is made again: tools/build-demos.ts); the
// pieces there, their sizes and, for those new to the site, their hashes; the card's `download` between what a visit
// fetches (the snapshot, the thumbnail and the image's pieces its boot trace names) and that plus the whole image (left
// out, it's that floor); an id's image never changes (a new image is a new id: decision 13; only the snapshot is made
// again under an id); no file over 25 MiB; the site's distinct files under the budget (~15,000: a version's old and new
// pieces side by side), never past 20,000 (deploy/disks/deploy.sh's limit).
//
// Retention: a demo left out of the source is retired: its id leaves store.json, its directory and pieces stay (machines
// made from it keep working). Only when the site would pass its budget do retired demos go, the oldest retired first,
// until it fits; the plan says which, and nothing is written without `apply`. Pieces no manifest on the site names go.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, linkSync, mkdirSync, openAsBlob, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { checkManifest, CHUNKED_FORMAT, type Manifest } from '../web/chunked.ts';
import { checkDefinition, DEFINITION_TYPE, DEFINITION_VERSION, importDefinition, isDemoId, type Definition, type Demo } from '../web/app/definitions.ts';
import { parseStore, STORE_TYPE, STORE_VERSION, type StoreFile } from '../web/app/demo-store.ts';
import { currentShape } from '../web/app/snapshots.ts';
import { Store } from '../web/app/store.ts';
import { memoryFiles, memoryRecords } from '../web/app/store-backends.ts';
import { readHeader, SNAPSHOT_VERSION } from '../web/snapshot-file.ts';

export const SOURCE_TYPE = 'waarm64-demos-source';
/** The site's distinct files the plan keeps under (docs/plans/first-demo.md §4), and the host's own limit. */
export const BUDGET = 15_000;
export const HARD_LIMIT = 20_000;
/** The host's largest file. */
const MAX_FILE = 25 * 2 ** 20;
export const LEDGER = '.publish.json';
const IGNORE = '.assetsignore';
/** The suffix of a file `applyPlan` writes beside its place before renaming it over it (one left by a crash goes at the next publish). */
const STAGED = '.publishing';
/** Files deploy.sh adds or the host doesn't serve: not the site's own. */
const NOT_SITE = new Set([LEDGER, IGNORE]);

/** The card's fields the source gives (the snapshot's and the thumbnail's are the tool's). */
const CARD_FIELDS = ['id', 'summary', 'download', 'view', 'network', 'replaces', 'template'];
const ENTRY_FIELDS = ['build', 'name', 'thumbnail', 'demo', 'recipe'];
const THUMBS = ['.webp', '.png', '.jpg', '.avif'];

/**
 * How tools/build-demos.ts makes a demo's build (left out: a build made by hand): the image (`images/build.sh <image>`,
 * `target/images/<image>/<image>.qcow2`), and the machine that boots it as a definition's `machine` with its disk's
 * serial, fixed here so every rebuild has the same shape hash (its MAC, CPUs, RAM, display, devices).
 */
export type Recipe = { image: string; machine: Record<string, unknown>; serial: string };
export type SourceDemo = { build: string; name?: string; thumbnail?: string; recipe?: Recipe; demo: Omit<Demo, 'snapshot' | 'thumbnail' | 'download'> & { download?: number } };
export type Source = { type: typeof SOURCE_TYPE; name?: string; demos: SourceDemo[] };
export type Ledger = { version: 1; demos: Record<string, { published: string; updated: string; retired?: string; image: string; snapshot?: string }> };

/** A file the site will have: kept as it is, written, or copied (a piece, checked against its hash when new). */
type Entry = { keep: true } | { text: string } | { from: string; hash?: string; bytes: number };

/** One demo as it will be published. */
export type Built = {
  id: string;
  def: Definition & { demo: Demo };
  image: Manifest;
  snapshot?: Manifest;
  /** The files under `<id>/` (manifest, snapshot, definition, thumbnail), by their path in the site. */
  files: Map<string, Entry>;
  /** Where each of its pieces is, by hash. */
  pieces: Map<string, { from: string; bytes: number }>;
  /** What a visit fetches at least, and at most (the whole image besides). */
  floor: number;
  ceiling: number;
};

export type Plan = {
  live: Built[];
  /** Ids published before and left out now: retired (kept), and dropped for the budget, the oldest retired first. */
  retired: string[];
  dropped: { id: string; retired: string }[];
  files: Map<string, Entry>;
  added: string[];
  removed: string[];
  /** The site's distinct files after it (deploy.sh's count). */
  count: number;
  budget: number;
  ledger: Ledger;
  store: StoreFile;
};

const fail = (what: string): never => {
  throw new Error(what);
};
const readJson = (file: string): unknown => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    return fail(`${file}: ${(e as Error).message}`);
  }
};
/** An error's message and its causes', for the publisher (a damaged definition's names the field in its cause). */
const why = (e: unknown): string => {
  const c = (e as Error).cause;
  return `${(e as Error).message}${c instanceof Error ? `: ${why(c)}` : ''}`;
};
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const unknownFields = (o: Record<string, unknown>, known: string[]) => Object.keys(o).filter((k) => !known.includes(k));
/** A path inside the site, as a URL path (its separators `/`). */
const urlPath = (p: string) => p.split(sep).join('/');

/** Reads and checks the source file strictly: an unknown field, a bad id or one seen twice refuses it. */
export function readSource(file: string): Source {
  const x = readJson(file);
  if (!isRecord(x) || x.type !== SOURCE_TYPE) return fail(`${file}: not a ${SOURCE_TYPE} file`);
  const extra = unknownFields(x, ['type', 'name', 'demos']);
  if (extra.length) fail(`${file}: unknown fields ${extra.join(', ')}`);
  if (!Array.isArray(x.demos)) return fail(`${file}: no demos`);
  const seen = new Set<string>();
  for (const [i, d] of (x.demos as unknown[]).entries()) {
    const at = `${file}: demos[${i}]`;
    if (!isRecord(d) || typeof d.build !== 'string' || !isRecord(d.demo)) return fail(`${at}: a demo is { build, demo, name?, thumbnail? }`);
    const bad = [...unknownFields(d, ENTRY_FIELDS), ...unknownFields(d.demo, CARD_FIELDS).map((k) => `demo.${k}`)];
    if (bad.length) fail(`${at}: unknown fields ${bad.join(', ')} (the snapshot and the thumbnail's URL are the tool's)`);
    if (!isDemoId(d.demo.id) || d.demo.id === 'pieces') fail(`${at}: demo.id must be lowercase letters, digits and dashes (not "pieces")`);
    if (seen.has(d.demo.id as string)) fail(`${at}: the id ${String(d.demo.id)} is taken by another demo`);
    seen.add(d.demo.id as string);
  }
  return x as Source;
}

/** The pieces' files a chunked file's manifest (at `file`) names, by hash. */
function piecesOf(m: Manifest, file: string): Map<string, { from: string; bytes: number }> {
  const out = new Map<string, { from: string; bytes: number }>();
  m.hashes.forEach((h, i) => out.set(h, { from: resolve(dirname(file), m.pieces.replace('{hash}', h)), bytes: Math.min(m.piece, m.size - i * m.piece) }));
  return out;
}

/** The bytes of the image's pieces its boot trace names (fetched whole where the host has no ranges, as ours hasn't). */
function prefetchBytes(m: Manifest): number {
  if (!m.prefetch) return 0;
  const pieces = new Set(m.prefetch.blocks.map((b) => Math.floor((b * m.prefetch!.block) / m.piece)));
  return [...pieces].reduce((n, i) => n + Math.min(m.piece, m.size - i * m.piece), 0);
}

/** The shape hash this checkout gives the machine `def` makes (what its template must carry to restore on it). */
export async function shapeHashOf(def: Definition): Promise<string> {
  const s = new Store(memoryRecords(), memoryFiles(), { channel: false });
  const { machine } = await importDefinition(s, def);
  const disks = new Map((await s.all('disks')).map((d) => [d.id, d]));
  return (await currentShape(machine, (i) => disks.get(i), { display: machine.display })).hash;
}

/** A template snapshot's header, from its first pieces (the header is at most 1 MiB and some bytes). */
async function snapshotHeader(m: Manifest, file: string) {
  const pieces = [...piecesOf(m, file).values()].slice(0, 2);
  const blobs = await Promise.all(pieces.map((p) => openAsBlob(p.from)));
  return readHeader(new Blob(blobs));
}

/** Demo `d` of the source (relative to `root`) checked and laid out under `<id>/`. */
export async function buildDemo(d: SourceDemo, root: string): Promise<Built> {
  const id = d.demo.id;
  const at = `demo ${id}`;
  const dir = resolve(root, d.build);
  const need = (f: string) => (existsSync(join(dir, f)) ? join(dir, f) : fail(`${at}: no ${f} in ${dir} (bench/demo/make-template.ts writes it)`));
  let made: Definition;
  try {
    made = checkDefinition(readJson(need('definition.json')));
  } catch (e) {
    return fail(`${at}: definition.json: ${why(e)}`);
  }
  const imageFile = need('manifest.json');
  const image = checkManifest(readJson(imageFile));
  const urlDisks = made.disks.filter((x) => x.kind === 'url');
  if (urlDisks.length !== 1 || made.disks.some((x) => x.kind === 'file' || x.kind === 'stored'))
    fail(`${at}: a demo has one URL disk (its image) and no file or stored disks (a visitor has none)`);
  const disk = urlDisks[0];
  if (disk.identity.kind !== 'url' || !('chunked' in disk.identity) || disk.identity.chunked !== image.id || disk.identity.bytes !== image.size)
    fail(`${at}: the definition's disk isn't the build's image (its identity ${JSON.stringify(disk.identity)}, the image ${image.id})`);

  let snapshot: Manifest | undefined;
  const snapFile = join(dir, 'snapshot.json');
  if (existsSync(snapFile)) {
    snapshot = checkManifest(readJson(snapFile));
    const h = await snapshotHeader(snapshot, snapFile);
    if (h.template !== true) fail(`${at}: the snapshot isn't a template (tools/snapshot-template.ts makes one)`);
    if (h.coreVersion !== SNAPSHOT_VERSION)
      fail(`${at}: the snapshot is the core's format ${h.coreVersion}, and this build's is ${SNAPSHOT_VERSION}: make the template again (tools/build-demos.ts)`);
    const want = await shapeHashOf(made);
    if (h.shapeHash !== want)
      fail(`${at}: the snapshot's shape hash ${String(h.shapeHash).slice(0, 16)}… isn't the one this build gives its machine (${want.slice(0, 16)}…): make the template again`);
  }

  const files = new Map<string, Entry>();
  const pieces = piecesOf(image, imageFile);
  if (snapshot) for (const [h, p] of piecesOf(snapshot, snapFile)) pieces.set(h, p);
  for (const [h, p] of pieces) {
    if (!existsSync(p.from)) fail(`${at}: piece ${h} isn't at ${p.from}`);
    if (statSync(p.from).size !== p.bytes) fail(`${at}: piece ${h} isn't ${p.bytes} bytes`);
  }
  const relocated = (m: Manifest) => JSON.stringify({ ...m, pieces: '../pieces/{hash}.bin' });
  files.set(`${id}/manifest.json`, { text: relocated(image) });
  if (snapshot) files.set(`${id}/snapshot.json`, { text: relocated(snapshot) });
  let thumb: string | undefined;
  let thumbBytes = 0;
  if (d.thumbnail) {
    const from = resolve(root, d.thumbnail);
    const ext = extname(from).toLowerCase();
    if (!THUMBS.includes(ext)) fail(`${at}: a thumbnail is ${THUMBS.join(', ')}`);
    if (!existsSync(from)) fail(`${at}: no thumbnail at ${from}`);
    thumbBytes = statSync(from).size;
    if (thumbBytes > MAX_FILE) fail(`${at}: the thumbnail is over 25 MiB`);
    thumb = `thumb${ext}`;
    files.set(`${id}/${thumb}`, { from, bytes: thumbBytes });
  }

  const floor = (snapshot?.size ?? 0) + thumbBytes + prefetchBytes(image);
  const ceiling = floor + image.size;
  const download = d.demo.download ?? floor;
  if (download < floor || download > ceiling)
    fail(`${at}: its card says ${download} bytes to download, and a visit fetches ${floor} to ${ceiling} (leave download out for ${floor})`);

  // The definition as the store holds it (URLs relative to store.json) and alone (relative to <id>/definition.json).
  const card = (prefix: string): Demo => ({
    id,
    summary: d.demo.summary,
    ...(thumb ? { thumbnail: `${prefix}${thumb}` } : {}),
    download,
    view: d.demo.view,
    ...(snapshot ? { snapshot: { manifest: `${prefix}snapshot.json`, id: snapshot.id } } : {}),
    ...(d.demo.network ? { network: d.demo.network } : {}),
    ...(d.demo.replaces?.length ? { replaces: d.demo.replaces } : {}),
    ...(d.demo.template === undefined ? {} : { template: d.demo.template }),
  });
  const defAt = (prefix: string) => {
    const def = {
      ...made,
      type: DEFINITION_TYPE,
      version: DEFINITION_VERSION,
      machine: { ...made.machine, ...(d.name ? { name: d.name } : {}) },
      disks: made.disks.map((x) => (x === disk ? { ...x, url: `${prefix}manifest.json` } : x)),
      demo: card(prefix),
    };
    try {
      return checkDefinition(def) as Definition & { demo: Demo };
    } catch (e) {
      return fail(`${at}: its card: ${why(e)}`);
    }
  };
  files.set(`${id}/definition.json`, { text: `${JSON.stringify(defAt(''), null, 1)}\n` });
  return { id, def: defAt(`${id}/`), image, snapshot, files, pieces, floor, ceiling };
}

/** Every file under `dir`, as paths relative to it. */
function walk(dir: string, at = ''): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(join(dir, at), { withFileTypes: true }).flatMap((e) => {
    const p = at ? join(at, e.name) : e.name;
    return e.isDirectory() ? walk(dir, p) : [p];
  });
}

/** The pieces in the site's `pieces/` that a JSON file at `path` (in the site) names, if it's a chunked file's manifest. */
function namedPieces(path: string, text: string): string[] {
  let m: unknown;
  try {
    m = JSON.parse(text);
  } catch {
    return [];
  }
  if (!isRecord(m) || m.format !== CHUNKED_FORMAT || typeof m.pieces !== 'string' || !Array.isArray(m.hashes)) return [];
  const pieces = m.pieces;
  return (m.hashes as string[])
    .map((h) => urlPath(join(dirname(path), pieces.replace('{hash}', h))))
    .filter((p) => p.startsWith('pieces/'));
}

/** Reads the site's ledger (none: an empty one). */
export function readLedger(site: string): Ledger {
  const f = join(site, LEDGER);
  return existsSync(f) ? (readJson(f) as Ledger) : { version: 1, demos: {} };
}

/** Plans the site at `site` for `source` (its paths relative to `root`), `now` the time of the publish. */
export async function planSite(source: Source, o: { root: string; site: string; budget?: number; now?: Date }): Promise<Plan> {
  const budget = Math.min(o.budget ?? BUDGET, HARD_LIMIT);
  const now = (o.now ?? new Date()).toISOString();
  const site = resolve(o.site);
  const live: Built[] = [];
  for (const d of source.demos) live.push(await buildDemo(d, o.root));
  const old = readLedger(site);
  const ledger: Ledger = { version: 1, demos: {} };
  const existing = walk(site).map(urlPath);
  for (const b of live) {
    const was = old.demos[b.id];
    if (!was && existing.some((p) => p.startsWith(`${b.id}/`)))
      fail(`demo ${b.id}: the site has a directory ${b.id}/ that isn't a demo's (another image's): choose another id`);
    if (was && was.image !== b.image.id)
      fail(`demo ${b.id}: its image changed (${was.image.slice(0, 16)}… → ${b.image.id.slice(0, 16)}…): a new image is a new id (replaces: ["${b.id}"]); only its snapshot is made again under an id`);
    const changed = !was || was.snapshot !== b.snapshot?.id || was.retired !== undefined;
    ledger.demos[b.id] = { published: was?.published ?? now, updated: changed ? now : was.updated, image: b.image.id, ...(b.snapshot ? { snapshot: b.snapshot.id } : {}) };
  }
  // Retired: published before, not live now; the oldest retired first.
  const retired = Object.entries(old.demos)
    .filter(([id]) => !ledger.demos[id])
    .map(([id, r]) => ({ id, ...r, retired: r.retired ?? now }))
    .sort((a, b) => a.retired.localeCompare(b.retired) || a.id.localeCompare(b.id));
  const managed = new Set([...live.map((b) => b.id), ...retired.map((r) => r.id)]);
  const store: StoreFile = {
    type: STORE_TYPE,
    version: STORE_VERSION,
    ...(source.name ? { name: source.name } : {}),
    demos: live.map((b) => b.def),
  };
  // The store as the page reads it: every demo there, none left out.
  const read = parseStore(JSON.stringify(store), 'https://site.invalid/store.json');
  if (read.skipped.length) fail(`the store: ${read.skipped.map((s) => `${s.id}: ${why(s.error)}`).join('; ')}`);

  const allPieces = new Map<string, { from: string; bytes: number }>();
  for (const b of live) for (const [h, p] of b.pieces) allPieces.set(`pieces/${h}.bin`, p);
  const have = new Set(existing);
  const layout = (keepRetired: Set<string>) => {
    const files = new Map<string, Entry>();
    for (const p of existing) {
      const top = p.split('/')[0];
      if (top === 'pieces' || NOT_SITE.has(p) || p === 'store.json' || managed.has(top) || p.endsWith(STAGED)) continue;
      files.set(p, { keep: true }); // another image's (the desktop's), _headers
    }
    for (const p of existing) if (keepRetired.has(p.split('/')[0])) files.set(p, { keep: true });
    for (const b of live) for (const [p, e] of b.files) files.set(p, e);
    files.set('store.json', { text: `${JSON.stringify(store, null, 1)}\n` });
    if (!files.has('_headers')) files.set('_headers', { keep: true }); // deploy.sh copies it in
    const named = new Set<string>();
    for (const [p, e] of files)
      if (p.endsWith('.json')) for (const q of namedPieces(p, 'text' in e ? e.text : readFileSync(join(site, p), 'utf8'))) named.add(q);
    for (const p of named) {
      if (have.has(p)) files.set(p, { keep: true });
      else {
        const src = allPieces.get(p) ?? fail(`${p} is named by a manifest on the site and isn't there or in any build`);
        files.set(p, { from: src.from, bytes: src.bytes, hash: p.slice('pieces/'.length, -'.bin'.length) });
      }
    }
    return files;
  };
  const keep = new Set(retired.map((r) => r.id));
  const dropped: { id: string; retired: string }[] = [];
  let files = layout(keep);
  for (const r of retired) {
    if (files.size <= budget) break;
    keep.delete(r.id);
    dropped.push({ id: r.id, retired: r.retired });
    files = layout(keep);
  }
  if (files.size > budget)
    fail(`the site would hold ${files.size} files, past its budget of ${budget}${dropped.length ? ` with every retired demo dropped` : ''}: fewer demos, or a larger budget (at most ${HARD_LIMIT})`);
  for (const r of retired) if (keep.has(r.id)) ledger.demos[r.id] = { published: r.published, updated: r.updated, retired: r.retired, image: r.image, ...(r.snapshot ? { snapshot: r.snapshot } : {}) };
  const added = [...files.keys()].filter((p) => !have.has(p) && p !== '_headers').sort();
  const removed = existing.filter((p) => !files.has(p) && !NOT_SITE.has(p)).sort();
  return { live, retired: [...keep], dropped, files, added, removed, count: files.size, budget, ledger, store };
}

/** What `plan` does, in lines for the publisher. */
export function describe(plan: Plan): string[] {
  const lines = plan.live.map(
    (b) => `live ${b.id}: "${b.def.machine.name}", ${b.image.hashes.length} image pieces${b.snapshot ? `, a snapshot of ${b.snapshot.size} bytes` : ', no snapshot'}, download ${b.def.demo.download} (a visit fetches ${b.floor} to ${b.ceiling})`,
  );
  for (const id of plan.retired) lines.push(`retired ${id}: out of the store, its files kept (retired ${plan.ledger.demos[id].retired})`);
  for (const d of plan.dropped) lines.push(`DROPPED ${d.id} (retired ${d.retired}): its files leave the site; machines made from it will find them gone`);
  const pieces = (l: string[]) => l.filter((p) => p.startsWith('pieces/')).length;
  lines.push(`files: ${plan.added.length} added (${pieces(plan.added)} pieces), ${plan.removed.length} removed (${pieces(plan.removed)} pieces), ${plan.count} on the site of a budget of ${plan.budget} (the host's limit ${HARD_LIMIT})`);
  return lines;
}

/**
 * Writes `plan` into `site` so that a failure partway leaves the site as it was (but for new pieces nothing names yet,
 * which the next publish removes): first the new pieces (hard links where it can, each checked against its hash), then
 * every other file written beside its place (`<path>.publishing`) and, once all are written, renamed over it: the demos'
 * files, then the store, then the ledger (so it never names a state the site isn't in). Then removes what it drops.
 */
export function applyPlan(plan: Plan, site: string): void {
  site = resolve(site);
  const place = (to: string, e: { from: string }) => {
    rmSync(to, { force: true });
    try {
      linkSync(e.from, to);
    } catch {
      copyFileSync(e.from, to);
    }
  };
  // The pieces: content-addressed, so a new one can't stand for an old one; each checked before it goes in.
  for (const [p, e] of plan.files) {
    if ('keep' in e || 'text' in e || !e.hash) continue;
    if (createHash('sha256').update(readFileSync(e.from)).digest('hex') !== e.hash) fail(`${e.from} isn't the piece ${e.hash}`);
    const to = join(site, p);
    if (existsSync(to)) continue;
    mkdirSync(dirname(to), { recursive: true });
    place(`${to}${STAGED}`, e);
    renameSync(`${to}${STAGED}`, to);
  }
  // The rest staged, the store after the demos' files, the ledger last.
  const staged: string[] = [];
  const order = [...plan.files.entries()].filter(([, e]) => !('keep' in e) && !('hash' in e && e.hash));
  order.sort(([a], [b]) => Number(a === 'store.json') - Number(b === 'store.json'));
  try {
    for (const [p, e] of order) {
      const to = join(site, p);
      mkdirSync(dirname(to), { recursive: true });
      if ('text' in e) writeFileSync(`${to}${STAGED}`, e.text);
      else if ('from' in e) place(`${to}${STAGED}`, e);
      staged.push(to);
    }
    writeFileSync(join(site, `${LEDGER}${STAGED}`), `${JSON.stringify(plan.ledger, null, 1)}\n`);
    staged.push(join(site, LEDGER));
  } catch (e) {
    for (const to of staged) rmSync(`${to}${STAGED}`, { force: true });
    rmSync(join(site, `${LEDGER}${STAGED}`), { force: true });
    throw e;
  }
  for (const to of staged) renameSync(`${to}${STAGED}`, to);
  writeFileSync(join(site, IGNORE), `${LEDGER}\n`);
  for (const p of plan.removed) rmSync(join(site, p), { force: true });
  // Directories left empty by what went.
  for (const p of new Set(plan.removed.map((r) => dirname(join(site, r)))))
    if (p !== site && existsSync(p) && readdirSync(p).length === 0) rmSync(p, { recursive: true });
}

/** The site's files as deploy.sh counts them (its own files left out). */
export const siteCount = (site: string) => walk(resolve(site)).filter((p) => !NOT_SITE.has(urlPath(p))).length;
