// The Go Tailscale client, which the page's Network menu loads only for `?tsbackend=go` (the default
// is the Rust one below; docs/frontend.md "Network"): the Go program in net/tailscale built to target/net/tailscale.wasm (with Go's wasm_exec.js beside it) by
// net/tailscale/build.sh. `npm run serve` and `npm start` call `prepareTailscale`: it builds when the
// files are missing or their inputs changed (a hash of net/tailscale's sources, in a stamp beside the
// module, like the core's), and never stops the server: without Go, or if the build fails, the page
// works (with the Rust client) and says on Connect with `?tsbackend=go` that the Go one isn't built. `node tools/tailscale.ts` runs it alone
// (scripts/ci.sh). WEBPC_TAILSCALE=0 skips it. `prepareTailnetClient` does the same for the Rust
// tailnet client (net/ts → target/net/ts.wasm, docs/plans/tailnet-client.md: tailcat and Tailscale,
// the page's default), which needs only cargo, as the core does.
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
  if (env.WEBPC_TAILSCALE === '0' || !existsSync(join(root, 'net/tailscale/build.sh'))) return 'skipped';
  if (tailscaleCurrent(root)) return 'current';
  if (spawnSync('go', ['version'], { env, stdio: 'ignore' }).status !== 0) {
    return 'skipped'; // only `?tsbackend=go` needs it
  }
  log(`${existsSync(join(root, 'target/net/tailscale.wasm')) ? "The Go Tailscale client's sources changed: rebuilding it" : 'Building the Go Tailscale client (for `?tsbackend=go`: Go to WebAssembly; the first time Go downloads its toolchain and modules, ~1 min)'}…`);
  const r = spawnSync('sh', [join(root, 'net/tailscale/build.sh'), join(root, 'target/net/tailscale.wasm')], { cwd: root, env, stdio: 'inherit' });
  if (r.status !== 0) {
    log(`The Go Tailscale client didn't build (the errors are above): the page runs without it (the Rust client is the default). ${relative(root, join(root, 'net/tailscale/build.sh'))} builds it again.`);
    return 'failed';
  }
  writeFileSync(STAMP(root), `${tailscaleInputs(root)}\n`);
  return 'built';
}


const TS_STAMP = (root: string) => join(root, 'target/net/ts.wasm.inputs');
const tsInputs = (root: string) => inputs(root, ['net/ts', 'Cargo.lock']);

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
