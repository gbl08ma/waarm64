// The demos' build (DEMO-KICKOFF.md decision 13; docs/remote-disks.md "Building the demos"): every demo of the source
// file (deploy/disks/demos.json) that has a `recipe` made again from a core build, under its existing id, then published
// (tools/publish-demos.ts's plan, a dry run unless --apply). Per demo, into its `build` directory (target/demos/<id>/):
//   1. its image, `images/build.sh <image>` when `--check` says it's missing or stale (Podman; --no-images refuses instead);
//   2. its template: bench/demo/make-template.ts with the recipe's definition (the machine imported on the page, its MAC
//      and the disk's serial fixed, so the shape hash is the same at every rebuild), the image chunked into the shared
//      `pieces/`, booted under the page with that core until the agent is up, the guest's caches dropped, the console
//      cleared to the motd, kept, flagged as a template and deflated, chunked; `definition.json`; `thumb.webp` (the
//      console at the prompt).
// What isn't reproducible: the snapshot's bytes (the guest's RAM: its timers, entropy, what the boot's timing left), so
// each build is a new snapshot id and new snapshot pieces (~16 MB; the old ones leave the site at the next publish).
// The image is bit for bit (images/build.sh's SHA256SUMS), so its content id, and the demo's id with it, stays.
//   node tools/build-demos.ts [source] [--only <id>[,<id>…]] [--core <wasm | a copy's directory>] [--out <dir>]
//     [--no-images] [--no-publish] [--site target/disks] [--apply]
// --core: the core build the template is made with: a wasm file, or a copy of the page (`npm run dist`'s target/dist,
// its assets/waarm64_core-*.wasm); default the checkout's target/wasm32-unknown-unknown/release/waarm64_core.wasm.
// The page around it is the checkout's (the dev server), so make a copy's demos from the checkout it was built from.
// --out: the builds go to <out>/<id> instead of their `build` (CI: scripts/ci-machines.sh; with --only, only those built), and the publish's plan reads
// them there. Each template ~30 s (the boot to the agent ~18 s, the snapshot, its deflate); the image ~40 s when rebuilt.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { applyPlan, describe, planSite, readSource, siteCount, type Recipe, type Session, type Source, type SourceDemo } from './demo-site.ts';
import { DEFINITION_TYPE, DEFINITION_VERSION } from '../web/app/definitions.ts';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
export const CHECKOUT_CORE = join(ROOT, 'target/wasm32-unknown-unknown/release/waarm64_core.wasm');

/**
 * The definition a recipe makes its machine from: the recipe's machine and one URL disk with its serial (its `url`,
 * `identity` and `size` placeholders that make-template.ts fills from the chunked image).
 */
export function recipeDefinition(r: Recipe) {
  return {
    type: DEFINITION_TYPE,
    version: DEFINITION_VERSION,
    machine: r.machine,
    disks: [{ kind: 'url', name: r.image, size: 0, identity: { kind: 'url', chunked: '', bytes: 0 }, url: 'manifest.json', readOnly: false, serial: r.serial }],
  };
}

/** Checks a recipe's form (what make-template.ts and the page check past it: the definition). */
export function checkRecipe(r: unknown, at: string): Recipe {
  const x = r as Recipe;
  if (typeof x !== 'object' || x === null || Array.isArray(x)) throw new Error(`${at}: recipe is { image, machine, serial }`);
  const extra = Object.keys(x).filter((k) => !['image', 'machine', 'serial', 'session'].includes(k));
  if (extra.length) throw new Error(`${at}: recipe: unknown fields ${extra.join(', ')}`);
  if (typeof x.image !== 'string' || !(/^[a-z0-9][a-z0-9-]*$/.test(x.image) || imagePath(x.image)))
    throw new Error(`${at}: recipe.image is an images/build.sh name or a .qcow2 under target/`);
  if (typeof x.machine !== 'object' || x.machine === null) throw new Error(`${at}: recipe.machine is a definition's machine`);
  if (typeof x.serial !== 'string' || !x.serial) throw new Error(`${at}: recipe.serial is the disk's serial (fixed: it's in the shape)`);
  if (x.session !== undefined) checkSession(x.session, `${at}: recipe.session`);
  return x;
}

/** A recipe's image given as a file (`target/….qcow2`, made by hand: images/arch/desktop.sh's), or undefined for a name. */
export const imagePath = (image: string) => (/^target\/[\w./-]+\.qcow2$/.test(image) && !image.includes('..') ? image : undefined);

/** Checks a desktop's session (bench/demo/make-template.ts `--session`). */
function checkSession(s: Session, at: string) {
  const plain = (v: unknown) => typeof v === 'string' && /^[\w ./:=,+-]+$/.test(v); // typed into a shell's double quotes
  if (typeof s !== 'object' || s === null || Array.isArray(s)) throw new Error(`${at} is { user, apps, settle?, screen?, cmdline?, countdown? }`);
  const extra = Object.keys(s).filter((k) => !['user', 'apps', 'settle', 'screen', 'cmdline', 'countdown'].includes(k));
  if (extra.length) throw new Error(`${at}: unknown fields ${extra.join(', ')}`);
  if (typeof s.user !== 'string' || !/^[a-z_][a-z0-9_-]*$/.test(s.user)) throw new Error(`${at}.user is a login name`);
  if (!Array.isArray(s.apps) || s.apps.some((x) => !plain(x?.run) || !plain(x?.window) || Object.keys(x).length !== 2))
    throw new Error(`${at}.apps is a list of { run, window } (no quotes or $ in them)`);
  if (s.settle !== undefined && !(Number.isInteger(s.settle) && s.settle >= 0 && s.settle <= 120)) throw new Error(`${at}.settle is 0 to 120 s`);
  if (s.screen !== undefined && !/^\d{3,4}x\d{3,4}$/.test(s.screen)) throw new Error(`${at}.screen is <w>x<h>`);
  const c = s.countdown;
  if (
    c !== undefined &&
    !(typeof c === 'object' && c !== null && Object.keys(c).length === 5 && typeof c.script === 'string' && /^[a-z0-9-]+\.sh$/.test(c.script) &&
      plain(c.run) && plain(c.window) && typeof c.name === 'string' && /^[\w .+-]+$/.test(c.name) && Number.isInteger(c.seconds) && c.seconds >= 3 && c.seconds <= 60)
  )
    throw new Error(`${at}.countdown is { script: <name>.sh, run, window, name, seconds: 3 to 60 } (no quotes or $)`);
  if (s.cmdline !== undefined && !(typeof s.cmdline === 'string' && /^[\w.=,-]+( [\w.=,-]+)*$/.test(s.cmdline))) throw new Error(`${at}.cmdline is kernel parameters (no quotes, / or $)`);
}

/** The core's wasm in `given` (a file, or a copy of the page's directory), and the commit a copy was built from. */
export function coreOf(given: string | undefined): { wasm: string; stamp?: string } {
  if (!given) return { wasm: CHECKOUT_CORE };
  const p = resolve(given);
  if (!existsSync(p)) throw new Error(`no core at ${p}`);
  if (!existsSync(join(p, 'index.html'))) return { wasm: p };
  const found = existsSync(join(p, 'assets')) ? readdirSync(join(p, 'assets')).filter((f) => /^waarm64_core[-.].*\.wasm$/.test(f)) : [];
  if (found.length !== 1) throw new Error(`${p}: not a copy of the page with one assets/waarm64_core-*.wasm (found ${found.length})`);
  const stamp = /name="waarm64-build" content="([^"]*)"/.exec(readFileSync(join(p, 'index.html'), 'utf8'))?.[1];
  return { wasm: join(p, 'assets', found[0]), stamp };
}

/** Where a demo's build goes: its `build`, or `<out>/<id>` (and its thumbnail there when it was in its build). */
export function placed(d: SourceDemo, out?: string): SourceDemo {
  if (!out) return d;
  const build = join(out, d.demo.id);
  const inBuild = d.thumbnail && !relative(d.build, d.thumbnail).startsWith('..');
  return { ...d, build, ...(inBuild ? { thumbnail: join(build, relative(d.build, d.thumbnail!)) } : {}) };
}

/**
 * Every demo where the publish reads it: those built here (`only`, or all) under `out`; the others at their `build`
 * (what a publish after a partial rebuild must read: the site's other demos as they are).
 */
export const placedAll = (demos: SourceDemo[], only?: string[], out?: string) => demos.map((d) => (!only || only.includes(d.demo.id) ? placed(d, out) : d));

/**
 * Removes the pieces in `<site>/pieces/` that no `<site>/<name>/manifest.json` or `snapshot.json` names (a rebuilt
 * template's old snapshot pieces, ~16 MB a build); returns how many went.
 */
export function prunePieces(site: string): number {
  const dir = join(site, 'pieces');
  if (!existsSync(dir)) return 0;
  const named = new Set<string>();
  for (const e of readdirSync(site, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name === 'pieces') continue;
    for (const f of ['manifest.json', 'snapshot.json']) {
      const file = join(site, e.name, f);
      if (!existsSync(file)) continue;
      const m = JSON.parse(readFileSync(file, 'utf8')) as { pieces?: string; hashes?: string[] };
      if (m.pieces === '../pieces/{hash}.bin') for (const h of m.hashes ?? []) named.add(`${h}.bin`);
    }
  }
  let gone = 0;
  for (const f of readdirSync(dir)) if (f.endsWith('.bin') && !named.has(f)) (rmSync(join(dir, f)), gone++);
  return gone;
}

const log = (...x: unknown[]) => console.log(`[build-demos ${new Date().toISOString().slice(11, 19)}]`, ...x);

async function main() {
  const { values: a, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      only: { type: 'string' },
      core: { type: 'string' },
      out: { type: 'string' },
      'no-images': { type: 'boolean', default: false },
      'no-publish': { type: 'boolean', default: false },
      site: { type: 'string', default: 'target/disks' },
      apply: { type: 'boolean', default: false },
    },
  });
  const t0 = Date.now();
  const sourceFile = resolve(ROOT, positionals[0] ?? 'deploy/disks/demos.json');
  const source = readSource(sourceFile);
  const only = a.only?.split(',');
  const unknown = only?.filter((id) => !source.demos.some((d) => d.demo.id === id));
  if (unknown?.length) throw new Error(`no demo ${unknown.join(', ')} in ${sourceFile}`);
  const out = a.out && resolve(ROOT, a.out);
  const demos = placedAll(source.demos, only, out);
  const core = coreOf(a.core);
  if (!existsSync(core.wasm)) throw new Error(`no core at ${core.wasm} (scripts/build-wasm.sh, or --core)`);
  if (core.stamp) {
    const head = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    log(`the core: ${relative(ROOT, core.wasm)}, a copy of ${core.stamp}${core.stamp.startsWith(head.slice(0, 12)) ? '' : ` — NOT this checkout's commit ${head.slice(0, 12)}: the page around the core is this checkout's`}`);
  } else log(`the core: ${relative(ROOT, core.wasm) || core.wasm}`);

  for (const d of demos) {
    const id = d.demo.id;
    if (only && !only.includes(id)) continue;
    if (!d.recipe) {
      log(`${id}: no recipe, its build (${d.build}) is made by hand: kept as it is`);
      continue;
    }
    const r = checkRecipe(d.recipe, `${sourceFile}: ${id}`);
    const dir = resolve(ROOT, d.build);
    const tImage = Date.now();
    const file = imagePath(r.image);
    // An image made by hand (the Arch desktop's, images/arch/desktop.sh: Arch's packages of the day, so never the same
    // twice) is taken as it is: a new one is a new demo id (docs/decisions.md "Demos"), never rebuilt here.
    if (file) {
      if (!existsSync(join(ROOT, file))) throw new Error(`${id}: no ${file} (made by hand: docs/images.md; a new one is a new demo id)`);
    } else {
      try {
        execFileSync(join(ROOT, 'images/build.sh'), ['--check', r.image], { stdio: 'pipe' });
      } catch (e) {
        const why = String((e as { stdout?: Buffer }).stdout ?? '').trim();
        if (a['no-images']) throw new Error(`${id}: ${why} (and --no-images)`);
        log(`${id}: ${why}`);
        execFileSync(join(ROOT, 'images/build.sh'), [r.image], { stdio: 'inherit' });
        log(`${id}: the image built in ${((Date.now() - tImage) / 1000).toFixed(0)} s`);
      }
    }
    const image = file ? join(ROOT, file) : join(ROOT, 'target/images', r.image, `${r.image}.qcow2`);
    if (!existsSync(image)) throw new Error(`${id}: no ${image} after images/build.sh ${r.image}`);
    // The definition beside the build while it's made (removed after: definition.json is what the page exported).
    mkdirSync(dirname(dir), { recursive: true });
    const defFile = join(dirname(dir), `.${basename(dir)}.recipe.json`);
    writeFileSync(defFile, JSON.stringify(recipeDefinition(r)));
    const tTemplate = Date.now();
    try {
      execFileSync(
        'node',
        [join(ROOT, 'bench/demo/make-template.ts'), '--site', dirname(dir), '--name', basename(dir), '--image', image, '--definition', defFile, '--core', core.wasm, '--thumbnail',
          ...(r.session ? ['--session', JSON.stringify(r.session), '--compact', '--label', d.name ?? id] : [])],
        // A desktop: its boot, the session and a snapshot of ~1 GiB of RAM.
        { stdio: 'inherit', timeout: r.session ? 900_000 : 540_000 },
      );
    } finally {
      rmSync(defFile, { force: true });
    }
    log(`${id}: its template made in ${((Date.now() - tTemplate) / 1000).toFixed(0)} s, at ${relative(ROOT, dir)}`);
    const gone = prunePieces(dirname(dir));
    if (gone) log(`${id}: ${gone} pieces no build names removed from ${relative(ROOT, dirname(dir))}/pieces`);
  }

  if (a['no-publish']) {
    log(`done in ${((Date.now() - t0) / 1000).toFixed(0)} s (not published: --no-publish)`);
    return;
  }
  const site = resolve(ROOT, a.site!);
  const plan = await planSite({ ...source, demos } satisfies Source, { root: ROOT, site });
  for (const l of describe(plan)) console.log(l);
  if (!a.apply) log(`a dry run of the publish into ${relative(ROOT, site) || site}: nothing written (--apply writes it)`);
  else {
    applyPlan(plan, site);
    log(`published: ${site}, ${siteCount(site)} files`);
  }
  log(`done in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

if (import.meta.main) {
  try {
    await main();
  } catch (e) {
    console.error(`build-demos: ${(e as Error).message}`);
    process.exit(1);
  }
}
