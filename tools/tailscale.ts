// The Tailscale client the page's Network menu loads (docs/frontend.md "Network"): the Go program
// in net/tailscale built to target/net/tailscale.wasm (with Go's wasm_exec.js beside it) by
// net/tailscale/build.sh. `npm run serve` and `npm start` call `prepareTailscale`: it builds when the
// files are missing or their inputs changed (a hash of net/tailscale's sources, in a stamp beside the
// module, like the core's), and never stops the server: without Go, or if the build fails, the page
// works and says on Connect that the client isn't built. `node tools/tailscale.ts` runs it alone
// (scripts/ci.sh). WEBPC_TAILSCALE=0 skips it.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const WASM = join(ROOT, 'target/net/tailscale.wasm');
const STAMP = (root: string) => join(root, 'target/net/tailscale.wasm.inputs');

/** What the module is built from: a hash of net/tailscale's files (contents, not mtimes). */
export function tailscaleInputs(root = ROOT) {
  const walk = (dir: string): string[] => readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
  const h = createHash('sha256');
  for (const f of walk('net/tailscale').sort()) {
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
    log(`The Tailscale client isn't built (the page's Network menu needs it) and Go isn't installed: install Go (https://go.dev/dl/; go.mod pins the version and Go fetches it), or ignore this if you won't use the network. Then run \`net/tailscale/build.sh\` or restart.`);
    return 'skipped';
  }
  log(`${existsSync(join(root, 'target/net/tailscale.wasm')) ? "The Tailscale client's sources changed: rebuilding it" : 'Building the Tailscale client (Go to WebAssembly; the first time Go downloads its toolchain and modules, ~1 min)'}…`);
  const r = spawnSync('sh', [join(root, 'net/tailscale/build.sh'), join(root, 'target/net/tailscale.wasm')], { cwd: root, env, stdio: 'inherit' });
  if (r.status !== 0) {
    log(`The Tailscale client didn't build (the errors are above): the page runs without it, its Network menu will say so. ${relative(root, join(root, 'net/tailscale/build.sh'))} builds it again.`);
    return 'failed';
  }
  writeFileSync(STAMP(root), `${tailscaleInputs(root)}\n`);
  return 'built';
}

if (import.meta.main) prepareTailscale();
