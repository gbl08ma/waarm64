// The tailnet clients' builds. `prepareTailnetClient`: the page's client (net/ts → target/net/ts.wasm,
// docs/networking/tailnet.md: tailcat and Tailscale), which needs only cargo, as the core does;
// `npm run serve` and `npm start` call it. `prepareTailscale`: Tailscale's Go client (net/tailscale →
// target/net/tailscale.wasm and Go's wasm_exec.js, by net/tailscale/build.sh), no longer the page's,
// kept as a test fixture: tests/ts-tailnet.test.ts hands a kept node between it and the Rust client
// (the store format users' nodes are in). Each builds when its files are missing or their inputs
// changed (a hash of the sources, in a stamp beside the module) and never throws. `node
// tools/tailscale.ts` runs both (scripts/ci-net.sh); WAARM64_TAILSCALE=0 skips the Go one.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const WASM = join(ROOT, 'target/net/tailscale.wasm');
const STAMP = (root: string) => join(root, 'target/net/tailscale.wasm.inputs');

/** What the module is built from: a hash of net/tailscale's files (contents, not mtimes). */
export function tailscaleInputs(root = ROOT) {
  return inputs(root, ['net/tailscale']);
}

/** A hash of the files under `paths` (directories walked; contents, not mtimes). */
function inputs(root: string, paths: string[]) {
  const walk = (dir: string): string[] => readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
  const h = createHash('sha256');
  for (const f of paths.flatMap((p) => statSync(join(root, p)).isDirectory() ? walk(p) : [p]).sort()) {
    h.update(`${f.split('\\').join('/')}\0`);
    h.update(readFileSync(join(root, f)));
    h.update('\0');
  }
  return h.digest('hex');
}

/** Whether target/net has the module and its glue, built from the current sources. */
export function tailscaleCurrent(root = ROOT) {
  try {
    return existsSync(join(root, 'target/net/tailscale.wasm')) && existsSync(join(root, 'target/net/wasm_exec.js'))
      && readFileSync(STAMP(root), 'utf8').trim() === tailscaleInputs(root);
  } catch {
    return false;
  }
}

export type Prepared = 'current' | 'built' | 'skipped' | 'failed';

/** Builds the client if it's missing or stale; says what it does; returns what happened (never throws for a missing Go or a failed build). */
export function prepareTailscale(root = ROOT, env: NodeJS.ProcessEnv = process.env, log: (s: string) => void = console.log): Prepared {
  if (env.WAARM64_TAILSCALE === '0' || !existsSync(join(root, 'net/tailscale/build.sh'))) return 'skipped';
  if (tailscaleCurrent(root)) return 'current';
  if (spawnSync('go', ['version'], { env, stdio: 'ignore' }).status !== 0) {
    return 'skipped'; // only the hand-over test needs it, and skips without it
  }
  log(`${existsSync(join(root, 'target/net/tailscale.wasm')) ? "The Go Tailscale client's sources changed: rebuilding it" : 'Building the Go Tailscale client (for the hand-over test: Go to WebAssembly; the first time Go downloads its toolchain and modules, ~1 min)'}…`);
  const r = spawnSync('sh', [join(root, 'net/tailscale/build.sh'), join(root, 'target/net/tailscale.wasm')], { cwd: root, env, stdio: 'inherit' });
  if (r.status !== 0) {
    log(`The Go Tailscale client didn't build (the errors are above): the hand-over test will skip. ${relative(root, join(root, 'net/tailscale/build.sh'))} builds it again.`);
    return 'failed';
  }
  writeFileSync(STAMP(root), `${tailscaleInputs(root)}\n`);
  return 'built';
}


const TS_STAMP = (root: string) => join(root, 'target/net/ts.wasm.inputs');
/** What the Rust client is built from (its stamp, target/net/ts.wasm.inputs). */
export const tsInputs = (root = ROOT) => inputs(root, ['net/ts', 'Cargo.lock']);

/** Builds the Rust tailnet client (target/net/ts.wasm) if it's missing or stale; never throws. */
export function prepareTailnetClient(root = ROOT, env: NodeJS.ProcessEnv = process.env, log: (s: string) => void = console.log): Prepared {
  if (!existsSync(join(root, 'net/ts/build.sh'))) return 'skipped';
  try {
    if (existsSync(join(root, 'target/net/ts.wasm')) && readFileSync(TS_STAMP(root), 'utf8').trim() === tsInputs(root)) return 'current';
  } catch {
    // no stamp: build
  }
  log('Building the tailnet client (Rust to WebAssembly)…');
  const r = spawnSync('sh', [join(root, 'net/ts/build.sh')], { cwd: root, env, stdio: 'inherit' });
  if (r.status !== 0) {
    log("The tailnet client didn't build (the errors are above): the page runs without it, its Network menu will say so. net/ts/build.sh builds it again.");
    return 'failed';
  }
  writeFileSync(TS_STAMP(root), `${tsInputs(root)}\n`);
  return 'built';
}

if (import.meta.main) {
  prepareTailscale();
  prepareTailnetClient();
}
