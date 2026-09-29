// `npm start` (M8 loop 5; docs/frontend.md "npm start"), after tools/start.js
// checked Node's version: rustup, the npm packages, the wasm core, Debian, then
// the server on 127.0.0.1 and the URL. Each step is skipped when its output is
// current, so a second start takes about a second (SHA512-free: Debian's stamp).
//   npm start [-- --host <addr>] [-- --port <n>] [-- --prepare-only]
// PORT sets the port too (default 8080); WEBPC_DL the download cache.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { prepareDebian } from './debian.ts';
import { prepareTailscale } from './tailscale.ts';
import { APP, ROOT, startServer } from './serve.ts';

export const WASM = join(ROOT, 'target/wasm32-unknown-unknown/release/webpc_core.wasm');
const WASM_STAMP = WASM + '.inputs';

/** Why node_modules doesn't match package-lock.json (npm's own record of what it installed, node_modules/.package-lock.json), or undefined if it does. */
export function npmStale(root = ROOT): string | undefined {
  if (!existsSync(join(root, 'node_modules'))) return 'node_modules is missing';
  const read = (p: string) => { try { return JSON.parse(readFileSync(join(root, p), 'utf8')) as { packages?: Record<string, { version?: string; integrity?: string; optional?: boolean }> }; } catch { return undefined; } };
  const lock = read('package-lock.json')?.packages;
  const installed = read('node_modules/.package-lock.json')?.packages;
  if (!lock || !installed) return 'node_modules has no record of what npm installed';
  // Optional packages for other platforms (TypeScript's native binaries) are in the lock but not installed.
  for (const [k, v] of Object.entries(lock)) {
    const i = installed[k];
    if (k === '' || (!i && v.optional)) continue;
    if (!i || i.version !== v.version || (v.integrity && i.integrity && v.integrity !== i.integrity)) return `${k.replace(/^.*node_modules\//, '')} ${v.version} isn't installed`;
  }
  const extra = Object.keys(installed).find((k) => !(k in lock));
  if (extra) return `${extra.replace(/^.*node_modules\//, '')} is installed but not in package-lock.json`;
  return undefined;
}

/** What the wasm core is built from: a hash of the files that decide it (contents, not mtimes: a checkout that changes nothing rebuilds nothing). */
export function wasmInputs(root = ROOT) {
  const files = ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', '.cargo/config.toml', 'scripts/build-wasm.sh', 'core/Cargo.toml', 'core/build.rs'];
  const walk = (dir: string): string[] => readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
  const h = createHash('sha256');
  for (const f of [...files, ...walk('core/src').sort()]) {
    h.update(`${f.split('\\').join('/')}\0`);
    h.update(existsSync(join(root, f)) ? readFileSync(join(root, f)) : '(none)');
    h.update('\0');
  }
  return h.digest('hex');
}

/** The stamp's value if the core is built from the current sources. */
export const wasmCurrent = (root = ROOT) => {
  const wasm = join(root, relative(ROOT, WASM));
  try { return existsSync(wasm) && readFileSync(wasm + '.inputs', 'utf8').trim() === wasmInputs(root); } catch { return false; }
};

const run = (cmd: string, args: string[], env = process.env) => spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', env }).status === 0;
const has = (cmd: string, args: string[], env = process.env) => spawnSync(cmd, args, { cwd: ROOT, stdio: 'ignore', env }).status === 0;

const isExecutable = (p: string) => { try { accessSync(p, constants.X_OK); return statSync(p).isFile(); } catch { return false; } };

class Stop extends Error {}
const stop = (msg: string): never => { throw new Stop(msg); };

/** rustup on PATH, or in ~/.cargo/bin (installed, but this shell hasn't read ~/.cargo/env yet): the environment to run cargo with. */
export function rustEnv(env: NodeJS.ProcessEnv = process.env) {
  // Looked up, not run: `rustup --version` asks the active toolchain for its version (and may install it).
  if ((env.PATH ?? '').split(delimiter).some((d) => d && isExecutable(join(d, 'rustup')))) return env;
  const bin = join(env.CARGO_HOME || join(env.HOME || homedir(), '.cargo'), 'bin');
  if (isExecutable(join(bin, 'rustup'))) return { ...env, PATH: `${bin}${delimiter}${env.PATH ?? ''}` };
  return stop("rustup isn't installed. It installs the Rust toolchain that builds the emulator core (the nightly pinned in rust-toolchain.toml).\n" +
    "Install it from https://rustup.rs:\n  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh\nthen run `npm start` again.");
}

function buildCore(env: NodeJS.ProcessEnv) {
  const inputs = wasmInputs();
  if (wasmCurrent()) return;
  // Rust links its build scripts (std's, the core's decoder generator) with the host's C linker.
  if (!has('cc', ['--version'], env)) {
    stop('Building the emulator core needs a C compiler and linker (`cc`) for Rust\'s build scripts.\n' +
      (process.platform === 'darwin' ? 'Install Apple\'s command line tools: xcode-select --install' : 'Install your distribution\'s gcc or clang (e.g. `sudo apt install gcc`, `sudo dnf install gcc`, `sudo zypper in gcc`).') +
      '\nThen run `npm start` again.');
  }
  console.log(existsSync(WASM) ? 'The emulator core\'s sources changed: rebuilding it…' : 'Building the emulator core (Rust to WebAssembly; the first time, rustup installs the pinned nightly, ~700 MB; the build takes from ~10 s to a few minutes)…');
  // rust-toolchain.toml's nightly, with rust-src (-Zbuild-std) and the wasm target: a no-op when installed.
  if (!run('rustup', ['toolchain', 'install'], env)) stop('rustup couldn\'t install the toolchain in rust-toolchain.toml (this needs rustup 1.28 or newer: `rustup self update`, or your package manager\'s update).');
  if (!run('bash', ['scripts/build-wasm.sh'], env)) stop('The emulator core didn\'t build (the errors are above).');
  if (!existsSync(WASM)) stop(`The build finished but ${relative(ROOT, WASM)} isn't there: is CARGO_TARGET_DIR or build.target-dir set? The page loads the core from the repository's target/.`);
  writeFileSync(WASM_STAMP, inputs + '\n');
}

function installPackages() {
  const why = npmStale();
  if (!why) return;
  console.log(`Installing the npm packages (${why}): npm ci…`);
  // Under `npm start`, npm_execpath is npm's own script: run the same npm.
  const npm = process.env.npm_execpath;
  const ok = npm && /\.[cm]?js$/.test(npm) ? run(process.execPath, [npm, 'ci', '--no-fund', '--no-audit']) : run('npm', ['ci', '--no-fund', '--no-audit']);
  if (!ok) stop('`npm ci` failed (the errors are above).');
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: { host: { type: 'string', default: '127.0.0.1' }, port: { type: 'string', default: process.env.PORT ?? '8080' }, 'prepare-only': { type: 'boolean', default: false } } });
  const t0 = performance.now();
  const env = rustEnv();
  installPackages();
  buildCore(env);
  prepareTailscale(); // the Network menu's client: built when Go is there, never fatal (tools/tailscale.ts)
  await prepareDebian().catch((e: Error) => stop(e.message));
  if (values['prepare-only']) {
    console.log(`Ready in ${((performance.now() - t0) / 1000).toFixed(1)} s (not serving: --prepare-only).`);
    return;
  }
  const port = Number(values.port);
  const server = await startServer(port, values.host).catch((e: NodeJS.ErrnoException) => stop(e.code === 'EADDRINUSE'
    ? `Port ${port} is in use (another \`npm start\` or \`npm run serve\`?). Stop that one, or pick another port: PORT=${port + 1} npm start\n(The page's disk is saved per address: on another port, Debian starts from a fresh disk.)`
    : `Couldn't listen on ${values.host}:${port}: ${e.message}`));
  const addr = server.address() as { port: number };
  const shown = values.host === '0.0.0.0' || values.host === '::' ? '127.0.0.1' : values.host.includes(':') ? `[${values.host}]` : values.host;
  const url = `http://${shown}:${addr.port}${APP}`;
  console.log(`\nwebpc is ready (in ${((performance.now() - t0) / 1000).toFixed(1)} s): open ${url} in Chromium or Chrome.`);
  if (values.host !== '127.0.0.1' && values.host !== 'localhost' && values.host !== '::1') {
    console.log(`Listening on ${values.host}: a browser elsewhere gets no cross-origin isolation over plain HTTP (only localhost counts as secure), so the page won't run there; forward the port instead.`);
  }
  console.log(`From another machine, forward the port and open the same URL there: ssh -L ${addr.port}:127.0.0.1:${addr.port} <this machine>\nCtrl+C stops the server.`);
  return server;
}

/** tools/start.js's entry: main, with what stops it said plainly. */
export async function start() {
  try {
    return await main();
  } catch (e) {
    if (!(e instanceof Stop)) throw e;
    console.error(`\n${e.message}`);
    process.exit(1);
  }
}
